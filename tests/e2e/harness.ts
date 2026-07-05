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
  digest?: {
    mutations: string;
    url?: { from: string; to: string };
    queries?: string;
    errors?: string[];
    surfaces?: { opened?: string[]; closed?: string[] };
    focus?: string;
    counts?: Record<string, [number, number]>;
  };
  gen?: number;
};

export type Target = {
  url: string;
  dir: string;
  fs: (...argv: string[]) => Promise<Envelope>;
  fsRaw: (...argv: string[]) => Promise<string>;
  stop: () => Promise<void>;
};

export async function startTarget(opts?: { adapt?: unknown }): Promise<Target> {
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
      ...(opts?.adapt ? { adapt: opts.adapt } : {}),
    })
  );

  // Per-call timeout + stderr capture + one retry on empty stdout: a cold boot
  // that exceeds the daemon's boot budget under machine load must cost one
  // retried call, not a whole-suite hang (perf-audit fix-now #1).
  const CALL_TIMEOUT_MS = 45_000;
  const spawnOnce = async (argv: string[]): Promise<{ out: string; err: string }> => {
    const proc = Bun.spawn(["bun", FS_BIN, ...argv], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    const killer = setTimeout(() => proc.kill(), CALL_TIMEOUT_MS);
    try {
      const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      await proc.exited;
      return { out, err };
    } finally {
      clearTimeout(killer);
    }
  };

  const fsRaw = async (...argv: string[]): Promise<string> => {
    const first = await spawnOnce(argv);
    if (first.out.trim() !== "") return first.out;
    await new Promise((r) => setTimeout(r, 1500));
    const second = await spawnOnce(argv);
    if (second.out.trim() !== "") return second.out;
    throw new Error(`fs produced no stdout after retry; stderr: ${(second.err || first.err).slice(0, 400)}`);
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
