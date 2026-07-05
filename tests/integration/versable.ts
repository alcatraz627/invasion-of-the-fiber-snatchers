/** Harness for the live-app integration test. This app's login session lives in a
 *  running browser context and does NOT survive a daemon restart (a stop clears
 *  it), so the test drives the ALREADY-RUNNING interactive daemon in place rather
 *  than spawning its own — the same way the manual dogfood worked. It never stops
 *  the daemon (that would log the user out) and self-skips when no authenticated
 *  daemon is up. Point it at another app via FS_INT_PROJECT. */

import { existsSync } from "node:fs";
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
  available: boolean; // a daemon is up and reachable for this project
  authed: boolean; // the live page is a real session (not /login)
  reason?: string;
  fs: (...argv: string[]) => Promise<IntEnvelope>;
  stop: () => Promise<void>;
};

export async function startVersable(): Promise<IntTarget> {
  const project = process.env.FS_INT_PROJECT ?? DEFAULT_PROJECT;
  const noop = async () => {};
  const dead = (reason: string): IntTarget => ({ available: false, authed: false, reason, fs: async () => ({ ok: false }), stop: noop });

  if (!existsSync(join(project, ".fiber-snatcher", "config.json"))) {
    return dead(`no .fiber-snatcher/config.json at ${project} — run \`fs init\` there`);
  }

  // Drive whatever daemon is running for this project (the user's logged-in
  // interactive one). cwd = the project, so the CLI connects to that project's
  // socket. Never stop it — the session dies with it.
  const fs = async (...argv: string[]): Promise<IntEnvelope> => {
    const proc = Bun.spawn(["bun", FS_BIN, ...argv, "--json"], { cwd: project, stdout: "pipe", stderr: "pipe" });
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

  const info = await fs("info");
  if (!info.ok) {
    return { available: false, authed: false, reason: "no daemon running for this project — start it and log in (see README)", fs, stop: noop };
  }
  await fs("navigate", "/jobs");
  await fs("wait", "--settled");
  const url: string = (await fs("info")).data?.url ?? "";
  const authed = !!url && !url.includes("/login");
  return {
    available: true,
    authed,
    reason: authed ? undefined : "daemon is up but on /login — log in via its browser window, leave it running, then re-run",
    fs,
    stop: noop, // never stop the user's authenticated daemon
  };
}
