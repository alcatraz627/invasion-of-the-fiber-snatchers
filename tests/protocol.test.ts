// Behavioral tests for the frame protocol over a REAL unix socket: request
// correlation under concurrency, partial-frame chunking, push fan-out, timeouts.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import { FrameClient, frameReader, startFrameServer } from "../src/protocol/frames.ts";
import type { PushEvent, Request } from "../src/protocol/types.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function sockPath(): string {
  return join(mkdtempSync(join(tmpdir(), "fs-proto-")), "t.sock");
}

function serve(path: string, handler: Parameters<typeof startFrameServer>[1]) {
  const server = startFrameServer(path, handler);
  server.listen(path);
  cleanups.push(() => server.close());
  return server;
}

describe("frame protocol", () => {
  test("correlates concurrent requests by id, out of order", async () => {
    const path = sockPath();
    serve(path, async (req: Request) => {
      // Reply slow to the first, fast to the second — answers cross.
      const delay = req.args.delay as number;
      await new Promise((r) => setTimeout(r, delay));
      return { id: req.id, ok: true, data: { echo: req.args.tag } };
    });
    const client = await FrameClient.connect(path);
    cleanups.push(() => client.close());

    const [slow, fast] = await Promise.all([
      client.request("t", { delay: 120, tag: "slow" }),
      client.request("t", { delay: 5, tag: "fast" }),
    ]);
    expect((slow.data as any).echo).toBe("slow");
    expect((fast.data as any).echo).toBe("fast");
  });

  test("frameReader survives frames split across chunks", () => {
    const seen: unknown[] = [];
    const read = frameReader((f) => seen.push(f));
    const whole = JSON.stringify({ kind: "res", body: { id: "1", ok: true } }) + "\n";
    read(whole.slice(0, 7));
    read(whole.slice(7, 20));
    read(whole.slice(20));
    expect(seen).toHaveLength(1);
    expect((seen[0] as any).body.id).toBe("1");
  });

  test("frameReader handles two frames in one chunk + bad line", () => {
    const seen: unknown[] = [];
    const bad: string[] = [];
    const read = frameReader((f) => seen.push(f), (l) => bad.push(l));
    const a = JSON.stringify({ kind: "res", body: { id: "a", ok: true } });
    const b = JSON.stringify({ kind: "res", body: { id: "b", ok: true } });
    read(`${a}\n{not json}\n${b}\n`);
    expect(seen).toHaveLength(2);
    expect(bad).toHaveLength(1);
  });

  test("push events reach the client while a request is in flight", async () => {
    const path = sockPath();
    serve(path, async (req: Request, push) => {
      push({ event: "progress", body: "halfway", ts: "t" } as PushEvent);
      return { id: req.id, ok: true };
    });
    const pushes: PushEvent[] = [];
    const client = await FrameClient.connect(path, { onPush: (e) => pushes.push(e) });
    cleanups.push(() => client.close());

    const res = await client.request("t");
    expect(res.ok).toBe(true);
    // push arrives on the same connection; give the loop one tick
    await new Promise((r) => setTimeout(r, 20));
    expect(pushes.some((p) => p.event === "progress")).toBe(true);
  });

  test("request times out with the command name in the error", async () => {
    const path = sockPath();
    serve(path, async (req: Request) => {
      await new Promise((r) => setTimeout(r, 500));
      return { id: req.id, ok: true };
    });
    const client = await FrameClient.connect(path);
    cleanups.push(() => client.close());

    expect(client.request("slowcmd", {}, 60)).rejects.toThrow(/slowcmd/);
  });

  test("server keeps serving a connection after a handler throw", async () => {
    const path = sockPath();
    let n = 0;
    serve(path, async (req: Request) => {
      if (++n === 1) throw new Error("boom");
      return { id: req.id, ok: true, data: { n } };
    });
    const client = await FrameClient.connect(path);
    cleanups.push(() => client.close());

    const first = await client.request("t");
    expect(first.ok).toBe(false);
    expect(first.error?.code).toBe("E_INTERNAL");
    const second = await client.request("t");
    expect(second.ok).toBe(true);
  });

  test("client rejects in-flight requests when the daemon dies", async () => {
    const path = sockPath();
    const server = startFrameServer(path, async (req: Request) => {
      setTimeout(() => server.close(), 10);
      // never respond; kill all sockets
      setTimeout(() => {
        for (const s of sockets) s.destroy();
      }, 20);
      return new Promise(() => {});
    });
    const sockets: net.Socket[] = [];
    server.on("connection", (s) => sockets.push(s));
    server.listen(path);
    cleanups.push(() => server.close());

    const client = await FrameClient.connect(path);
    cleanups.push(() => client.close());
    expect(client.request("t", {}, 5000)).rejects.toThrow(/closed/);
  });
});
