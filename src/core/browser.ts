/**
 * Browser lifecycle. Two modes:
 *   - long-running: `fiber-snatcher start` launches a persistent headful browser
 *     holding a single Page. A small control socket (unix domain) lets other
 *     fiber-snatcher invocations send commands to it without re-launching.
 *   - one-shot: `fiber-snatcher <cmd> --one-shot` opens, does the work, closes.
 *
 * V1 wire format for the socket: newline-delimited JSON.
 *   request:  {id, op: "eval"|"screenshot"|"goto"|"close", ...}
 *   response: {id, ok, data|error}
 */

import type { BrowserContext, Page } from "playwright";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { FsConfig } from "./config.ts";

// `chromium` (the runtime value) is imported lazily inside openPersistent — the
// only caller — so this module's path helpers (controlSocketPath, v2SocketPath)
// can be imported by the CLI without dragging Playwright's ~110ms load into
// every `fs` call. Only the daemon actually launches a browser.
export async function openPersistent(cfg: FsConfig): Promise<{ context: BrowserContext; page: Page }> {
  const { chromium } = await import("playwright");
  const context = await chromium.launchPersistentContext(cfg.profileDir, {
    // Config field, not env: test harnesses set headless per-project
    headless: cfg.headless === true,
    viewport: { width: 1400, height: 900 },
    // Inject auth bypass header for every request if target opted in
    extraHTTPHeaders: await maybeAuthHeader(cfg),
    args: ["--disable-blink-features=AutomationControlled"],
  });

  // Reuse existing page if present
  const existing = context.pages();
  const page = existing[0] ?? (await context.newPage());
  return { context, page };
}

async function maybeAuthHeader(cfg: FsConfig): Promise<Record<string, string>> {
  if (!existsSync(cfg.authKeyPath)) return {};
  const key = (await readFile(cfg.authKeyPath, "utf8")).trim();
  if (!key) return {};
  return { [cfg.authHeader]: key };
}

export function controlSocketPath(cfg: FsConfig): string {
  // Unix domain socket in the data dir — co-located with the pid file
  return join(cfg.profileDir, "..", "control.sock");
}

/** V2 speaks a different frame protocol; separate socket + pidfile so a V1
 *  daemon on the same project is detected, never fought for the profile. */
export function v2SocketPath(cfg: FsConfig): string {
  return join(cfg.profileDir, "..", "control-v2.sock");
}

export function v2PidFile(cfg: FsConfig): string {
  return join(cfg.profileDir, "..", "daemon-v2.pid");
}

/** The V2 daemon's liveness as its pidfile tells it: no pidfile, a stale one
 *  (dead pid), or the live pid. Lets the V1 lifecycle verbs see V2 daemons
 *  instead of reporting not-running while one holds the browser. */
export function v2DaemonPid(cfg: FsConfig): { state: "none" | "stale" | "live"; pid?: number } {
  const file = v2PidFile(cfg);
  if (!existsSync(file)) return { state: "none" };
  const pid = Number(readFileSync(file, "utf8").trim());
  if (!Number.isFinite(pid) || pid <= 0) return { state: "stale", pid };
  try {
    process.kill(pid, 0);
    return { state: "live", pid };
  } catch {
    return { state: "stale", pid };
  }
}
