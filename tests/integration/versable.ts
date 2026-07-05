/** Harness for the live-app integration test: drives a real running dev server
 *  (default the Versable enhancement-product on :3006) with an isolated headless
 *  daemon that reuses the project's real browser profile + auth key, so a login
 *  session established once in the interactive browser carries into the test.
 *
 *  This is opt-in and environment-dependent by nature (a real server + a live
 *  login), unlike the hermetic fixture e2e suite. It self-skips when the server
 *  is unreachable or the profile is busy, and reports auth state so the test can
 *  gate its authenticated cases. Point it at another app via FS_INT_PROJECT. */

import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DEFAULT_PROJECT = "/Users/alcatraz627/Code/Versable/two-enhancement-product/frontend";
const FS_BIN = new URL("../../bin/fs.ts", import.meta.url).pathname;

export type IntEnvelope = {
  ok: boolean;
  data?: any;
  error?: { code: string; message: string; candidates?: any[] };
  digest?: { mutations: string; surfaces?: { opened?: string[]; closed?: string[] }; queries?: string; url?: any };
  gen?: number;
};

export type IntTarget = {
  available: boolean; // dev server reachable + daemon booted
  authed: boolean; // a real session (not redirected to /login)
  reason?: string; // why unavailable / unauthed
  fs: (...argv: string[]) => Promise<IntEnvelope>;
  stop: () => Promise<void>;
};

async function reachable(url: string): Promise<boolean> {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 3000);
    const res = await fetch(url, { redirect: "manual", signal: c.signal });
    clearTimeout(t);
    return res.status > 0;
  } catch {
    return false;
  }
}

export async function startVersable(): Promise<IntTarget> {
  const project = process.env.FS_INT_PROJECT ?? DEFAULT_PROJECT;
  const realCfgPath = join(project, ".fiber-snatcher", "config.json");
  const noop = async () => {};
  const dead = (reason: string): IntTarget => ({ available: false, authed: false, reason, fs: async () => ({ ok: false }), stop: noop });

  if (!existsSync(realCfgPath)) return dead(`no .fiber-snatcher/config.json at ${project}`);
  const real = JSON.parse(readFileSync(realCfgPath, "utf8"));
  if (!(await reachable(real.devUrl))) return dead(`dev server unreachable at ${real.devUrl} — start it (npm run dev)`);

  // Isolated project dir, but reuse the real browser profile (to inherit a login
  // session) + real auth key. Headless. Adapt config teaches the tool Versable's
  // non-ARIA modal so the surface cases can assert on it.
  const dir = mkdtempSync(join(tmpdir(), "fs-int-"));
  const dd = join(dir, ".fiber-snatcher");
  mkdirSync(dd, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fs-integration" }));
  writeFileSync(
    join(dd, "config.json"),
    JSON.stringify({
      version: "2.0.0",
      devUrl: real.devUrl,
      authHeader: real.authHeader ?? "X-Fiber-Snatcher-Key",
      authKeyPath: real.authKeyPath,
      profileDir: real.profileDir, // inherit the real (possibly logged-in) session
      shotsDir: join(dd, "shots"),
      logsDir: join(dd, "logs"),
      daemonPidFile: join(dd, "daemon.pid"),
      headless: true,
      cdpPortHint: 0,
      sources: real.sources ?? { nextDevCommand: "", pm: "npm" },
      adapters: [],
      adapt: { surfaceSelectors: [".modal"] },
    })
  );

  const fs = async (...argv: string[]): Promise<IntEnvelope> => {
    const proc = Bun.spawn(["bun", FS_BIN, ...argv, "--json"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    const killer = setTimeout(() => proc.kill(), 45_000);
    try {
      const out = await new Response(proc.stdout).text();
      await proc.exited;
      try {
        return JSON.parse(out) as IntEnvelope;
      } catch {
        return { ok: false, error: { code: "E_CLI", message: out.slice(0, 300) } };
      }
    } finally {
      clearTimeout(killer);
    }
  };

  const stop = async () => {
    await fs("stop").catch(() => {});
  };

  // Boot + detect auth. If the profile is locked (interactive daemon running),
  // the boot fails — report unavailable rather than false-failing every case.
  const info = await fs("info");
  if (!info.ok || !info.data?.url) {
    await stop();
    return { available: false, authed: false, reason: "daemon did not boot (profile busy? stop the interactive daemon first)", fs, stop };
  }
  const nav = await fs("navigate", "/jobs");
  await fs("wait", "--settled");
  const url: string = (await fs("info")).data?.url ?? nav.data?.url ?? "";
  const authed = !!url && !url.includes("/login");
  return {
    available: true,
    authed,
    reason: authed ? undefined : "no login session (redirected to /login) — log in once via the interactive browser, then re-run",
    fs,
    stop,
  };
}
