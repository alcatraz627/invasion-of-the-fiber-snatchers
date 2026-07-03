/** ndjson framing over the unix socket, with request-id correlation so one
 *  connection can carry many requests plus server-push events (V1 was one
 *  request per connection, which made streaming impossible). */

import net from "node:net";
import type { Frame, PushEvent, Request, Response } from "./types.ts";

export function writeFrame(sock: net.Socket, frame: Frame): void {
  sock.write(JSON.stringify(frame) + "\n");
}

/** Feed raw chunks, get parsed frames. Tolerates partial lines across chunks. */
export function frameReader(onFrame: (f: Frame) => void, onBad?: (line: string) => void) {
  let buf = "";
  return (chunk: Buffer | string) => {
    buf += chunk.toString();
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      try {
        onFrame(JSON.parse(line) as Frame);
      } catch {
        onBad?.(line);
      }
    }
  };
}

export type ClientOptions = {
  timeoutMs?: number;
  onPush?: (e: PushEvent) => void;
};

/** A connection that can hold multiple in-flight requests and receive pushes.
 *  CLI one-shots call request() then close(); `watch` keeps it open. */
export class FrameClient {
  private sock: net.Socket;
  private pending = new Map<string, { resolve: (r: Response) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private seq = 0;
  private opts: ClientOptions;

  private constructor(sock: net.Socket, opts: ClientOptions) {
    this.sock = sock;
    this.opts = opts;
    const read = frameReader((f) => this.onFrame(f));
    sock.on("data", read);
    sock.on("error", (e) => this.failAll(e));
    sock.on("close", () => this.failAll(new Error("daemon connection closed")));
  }

  static connect(socketPath: string, opts: ClientOptions = {}): Promise<FrameClient> {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection(socketPath);
      sock.once("connect", () => resolve(new FrameClient(sock, opts)));
      sock.once("error", reject);
    });
  }

  private onFrame(f: Frame) {
    if (f.kind === "res") {
      const p = this.pending.get(f.body.id);
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete(f.body.id);
        p.resolve(f.body);
      }
    } else if (f.kind === "push") {
      this.opts.onPush?.(f.body);
    }
  }

  private failAll(e: Error) {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(e);
    }
    this.pending.clear();
  }

  request(cmd: string, args: Record<string, unknown> = {}, timeoutMs?: number): Promise<Response> {
    const id = `${Date.now().toString(36)}-${++this.seq}`;
    const req: Request = { id, cmd, args };
    return new Promise((resolve, reject) => {
      const budget = timeoutMs ?? this.opts.timeoutMs ?? 30_000;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`request timed out after ${budget}ms: ${cmd}`));
      }, budget);
      this.pending.set(id, { resolve, reject, timer });
      writeFrame(this.sock, { kind: "req", body: req });
    });
  }

  close(): void {
    this.sock.end();
  }
}

export type ServerHandler = (req: Request, push: (e: PushEvent) => void) => Promise<Response>;

/** Socket server: many concurrent requests per connection, push fan-out to
 *  every connected client that opted into pushes (all of them, for now). */
export function startFrameServer(socketPath: string, handler: ServerHandler): net.Server {
  const clients = new Set<net.Socket>();
  const pushAll = (e: PushEvent) => {
    for (const c of clients) writeFrame(c, { kind: "push", body: e });
  };

  const server = net.createServer((sock) => {
    clients.add(sock);
    const read = frameReader(async (f) => {
      if (f.kind !== "req") return;
      let res: Response;
      try {
        res = await handler(f.body, pushAll);
      } catch (e) {
        res = {
          id: f.body.id,
          ok: false,
          error: { code: "E_INTERNAL", message: String((e as Error).message ?? e) },
        };
      }
      if (!sock.destroyed) writeFrame(sock, { kind: "res", body: res });
    });
    sock.on("data", read);
    sock.on("close", () => clients.delete(sock));
    sock.on("error", () => clients.delete(sock));
  });
  return server;
}
