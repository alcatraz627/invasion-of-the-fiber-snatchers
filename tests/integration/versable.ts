/** Harness for the live-app integration test. This app's login session lives in a
 *  running browser context and does NOT survive a daemon restart (a stop clears
 *  it), so the test drives the ALREADY-RUNNING interactive daemon in place rather
 *  than spawning its own — the same way the manual dogfood worked. It never stops
 *  the daemon (that would log the user out) and self-skips when no authenticated
 *  daemon is up. Point it at another app via FS_INT_PROJECT. */

import { existsSync, readFileSync } from "node:fs";
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

/** Local test credentials for auto-login, from env or the target project's
 *  gitignored `.fiber-snatcher/integration-auth.json`. Never hardcoded and never
 *  in this (public) repo — the file lives in the target project's gitignored dir.
 *  Returns null when unset, so the authed tier just skips instead of failing. */
function loadCreds(project: string): { email: string; password: string } | null {
  const email = process.env.FS_INT_EMAIL;
  const password = process.env.FS_INT_PASSWORD;
  if (email && password) return { email, password };
  const f = join(project, ".fiber-snatcher", "integration-auth.json");
  if (existsSync(f)) {
    try {
      const j = JSON.parse(readFileSync(f, "utf8"));
      if (j.email && j.password) return { email: String(j.email), password: String(j.password) };
    } catch {
      /* malformed creds file — treat as absent */
    }
  }
  return null;
}

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
  let url: string = (await fs("info")).data?.url ?? "";
  let authed = !!url && !url.includes("/login");

  // If it's on /login and local creds are configured, log in by filling the form
  // — so the authed tier runs hands-free. The password is entered into a field
  // the journal redacts (name="password"); it never touches this repo.
  if (!authed) {
    const creds = loadCreds(project);
    if (creds) {
      await fs("navigate", "/login");
      await fs("wait", "--settled");
      await fs("fill", "--css", "input[type=email]", creds.email);
      await fs("fill", "--css", "input[name=password]", creds.password);
      await fs("wait", "--settled");
      await fs("click", "Sign In");
      await fs("wait", "--settled");
      url = (await fs("info")).data?.url ?? "";
      authed = !!url && !url.includes("/login");
    }
  }

  return {
    available: true,
    authed,
    reason: authed
      ? undefined
      : "on /login and no creds configured — log in via the browser window (leave it running), or set FS_INT_EMAIL/FS_INT_PASSWORD (see README)",
    fs,
    stop: noop, // never stop the user's authenticated daemon
  };
}
