/**
 * `fiber-snatcher start` — launches the long-running browser holder.
 *
 * Waits for the dev server to respond, opens Chromium with the persistent
 * profile, navigates to devUrl, starts the IPC server so subsequent short CLI
 * calls are fast, subscribes to CDP console/network events, and begins writing
 * to the unified log.
 *
 * This is the "daemon" — one process, holding browser + IPC + log aggregation.
 */

import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { ok, err, type Result } from "../core/result.ts";
import { requireConfig } from "../core/config.ts";

export async function run(args: string[]): Promise<Result> {
  const cfg = await requireConfig().catch((e) => {
    return null;
  });
  if (!cfg) return err("E_NOT_INITIALIZED", "Run `fiber-snatcher init` first.");

  // Already running?
  if (existsSync(cfg.daemonPidFile)) {
    const pid = Number((await fs.readFile(cfg.daemonPidFile, "utf8")).trim());
    if (pid && isAlive(pid)) {
      return ok({ pid, status: "already-running" }, {
        code: "ALREADY_RUNNING",
        next_steps: ["Run `fiber-snatcher stop` to stop it, then start again."],
      });
    }
    await fs.rm(cfg.daemonPidFile, { force: true });
  }

  // Probe dev server
  const alive = await fetchOk(cfg.devUrl);
  if (!alive) {
    return err("E_DEV_SERVER_DOWN", `Dev server not reachable at ${cfg.devUrl}`, {
      context: { devUrl: cfg.devUrl },
      next_steps: [
        `Start the dev server (likely: ${cfg.sources.nextDevCommand}) in another terminal, then rerun.`,
      ],
    });
  }

  // Spawn the daemon child, detached
  const here = fileURLToPath(import.meta.url);
  const daemonEntry = resolve(dirname(here), "..", "daemon.ts");
  const child = spawn(process.execPath, [daemonEntry], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
    env: { ...process.env, FS_CONFIG_CWD: process.cwd() },
  });
  child.unref();

  await fs.writeFile(cfg.daemonPidFile, String(child.pid));
  // Give it a moment to boot
  await new Promise((r) => setTimeout(r, 700));

  return ok(
    { pid: child.pid, devUrl: cfg.devUrl },
    {
      code: "STARTED",
      next_steps: [
        "Run `fiber-snatcher doctor` to verify the debug surface is reachable.",
        "Run `fiber-snatcher state` to read current component state.",
      ],
    },
  );
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function fetchOk(url: string, timeoutMs = 1500): Promise<boolean> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    return res.status < 500;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}
