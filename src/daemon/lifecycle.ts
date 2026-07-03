/** Auto-start: any CLI command reaches a live daemon in one invocation. Kills
 *  V1's status/start/doctor preflight ritual and its 700ms blind boot sleep —
 *  we spawn detached, then ping-poll until the daemon answers. */

import { spawn } from "node:child_process";
import { mkdirSync, rmdirSync, statSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { controlSocketPath, v2SocketPath } from "../core/browser.ts";
import type { FsConfig } from "../core/config.ts";
import { FrameClient } from "../protocol/frames.ts";
import type { ClientOptions } from "../protocol/frames.ts";
import { daemonSpawnEnv } from "./env.ts";

const BOOT_TIMEOUT_MS = 12_000; // browser cold launch can take a few seconds
const PING_INTERVAL_MS = 150;
const SPAWN_LOCK_STALE_MS = 20_000;

export async function connectDaemon(
  cfg: FsConfig,
  opts: ClientOptions = {},
  { spawnIfDown = true }: { spawnIfDown?: boolean } = {}
): Promise<FrameClient | null> {
  const sockPath = v2SocketPath(cfg);
  const existing = await tryPing(sockPath, opts);
  if (existing) return existing;
  if (!spawnIfDown) return null;

  // A live V1 daemon owns the shared browser profile; spawning V2 alongside it
  // would crash-loop on the profile lock. Refuse with the remedy instead.
  if (await socketAccepts(controlSocketPath(cfg))) {
    throw new Error(
      "a V1 fiber-snatcher daemon is running for this project and holds the browser profile — run `fiber-snatcher stop` first, then retry"
    );
  }

  const locked = takeSpawnLock(cfg);
  try {
    if (locked) spawnDaemon();
    // Lock loser: another CLI is already booting the daemon; just poll.
    const deadline = Date.now() + BOOT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, PING_INTERVAL_MS));
      const client = await tryPing(sockPath, opts);
      if (client) return client;
    }
    throw new Error(`daemon did not come up within ${BOOT_TIMEOUT_MS}ms — try \`fiber-snatcher doctor\` (V1) or rerun with a fresh profile`);
  } finally {
    if (locked) releaseSpawnLock(cfg);
  }
}

function spawnLockDir(cfg: FsConfig): string {
  return join(cfg.profileDir, "..", "spawn.lock");
}

/** mkdir is atomic: winner spawns, losers poll. Stale locks (crashed CLI) age out. */
function takeSpawnLock(cfg: FsConfig): boolean {
  const dir = spawnLockDir(cfg);
  try {
    mkdirSync(dir);
    return true;
  } catch {
    try {
      if (Date.now() - statSync(dir).mtimeMs > SPAWN_LOCK_STALE_MS) {
        rmdirSync(dir);
        mkdirSync(dir);
        return true;
      }
    } catch { /* raced; treat as loser */ }
    return false;
  }
}

function releaseSpawnLock(cfg: FsConfig): void {
  try {
    rmdirSync(spawnLockDir(cfg));
  } catch { /* already gone */ }
}

function socketAccepts(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createConnection(path);
    const timer = setTimeout(() => { probe.destroy(); resolve(false); }, 400);
    probe.once("connect", () => { clearTimeout(timer); probe.destroy(); resolve(true); });
    probe.once("error", () => { clearTimeout(timer); resolve(false); });
  });
}

async function tryPing(sockPath: string, opts: ClientOptions): Promise<FrameClient | null> {
  try {
    const client = await FrameClient.connect(sockPath, opts);
    const res = await client.request("ping", {}, 1500);
    if (res.ok) return client;
    client.close();
    return null;
  } catch {
    return null;
  }
}

function spawnDaemon(): void {
  const serverEntry = new URL("./server.ts", import.meta.url).pathname;
  const child = spawn("bun", [serverEntry], {
    detached: true,
    stdio: "ignore",
    env: daemonSpawnEnv(process.cwd()),
  });
  child.unref();
}
