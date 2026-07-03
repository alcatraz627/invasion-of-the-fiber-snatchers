/** Shared e2e harness: fixture server + throwaway target project + a runner
 *  that drives the real CLI (cwd'd into the target) and parses --json output. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFixture } from "../fixture-app/serve.ts";

const FS_BIN = new URL("../../bin/fs.ts", import.meta.url).pathname;

export type Envelope = {
  ok: boolean;
  data?: any;
  error?: { code: string; message: string; candidates?: any[]; hint?: string };
  digest?: { mutations: string; url?: { from: string; to: string }; queries?: string; errors?: string[] };
  gen?: number;
};

export type Target = {
  url: string;
  dir: string;
  fs: (...argv: string[]) => Promise<Envelope>;
  fsRaw: (...argv: string[]) => Promise<string>;
  stop: () => Promise<void>;
};

export async function startTarget(): Promise<Target> {
  const fixture = await startFixture();
  const dir = mkdtempSync(join(tmpdir(), "fs-e2e-"));
  const dd = join(dir, ".fiber-snatcher");
  mkdirSync(dd, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fs-e2e-target" }));
  writeFileSync(
    join(dd, "config.json"),
    JSON.stringify({
      version: "2.0.0",
      devUrl: fixture.url,
      authHeader: "X-Fiber-Snatcher-Key",
      authKeyPath: join(dd, "auth", "key"),
      profileDir: join(dd, "browser-profile"),
      shotsDir: join(dd, "shots"),
      logsDir: join(dd, "logs"),
      daemonPidFile: join(dd, "daemon.pid"),
      headless: true,
      cdpPortHint: 0,
      sources: { nextDevCommand: "", pm: "bun" },
      adapters: [],
    })
  );

  const fsRaw = async (...argv: string[]): Promise<string> => {
    const proc = Bun.spawn(["bun", FS_BIN, ...argv], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    return out;
  };

  const fs = async (...argv: string[]): Promise<Envelope> => {
    const out = await fsRaw(...argv, "--json");
    try {
      return JSON.parse(out) as Envelope;
    } catch {
      throw new Error(`non-JSON CLI output: ${out.slice(0, 400)}`);
    }
  };

  return {
    url: fixture.url,
    dir,
    fs,
    fsRaw,
    stop: async () => {
      await fs("stop").catch(() => {});
      fixture.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
