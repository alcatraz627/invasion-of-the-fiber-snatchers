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

import { chromium, type BrowserContext, type Page } from "playwright";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { FsConfig } from "./config.ts";

export async function openPersistent(cfg: FsConfig): Promise<{ context: BrowserContext; page: Page }> {
  const context = await chromium.launchPersistentContext(cfg.profileDir, {
    headless: false,
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
