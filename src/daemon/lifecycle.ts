/** Auto-start: any CLI command reaches a live daemon in one invocation. Kills
 *  V1's status/start/doctor preflight ritual and its 700ms blind boot sleep —
 *  we spawn detached, then ping-poll until the daemon answers. */

import { spawn } from "node:child_process";
import { controlSocketPath } from "../core/browser.ts";
import type { FsConfig } from "../core/config.ts";
import { FrameClient } from "../protocol/frames.ts";
import type { ClientOptions } from "../protocol/frames.ts";
import { daemonSpawnEnv } from "./env.ts";

const BOOT_TIMEOUT_MS = 12_000; // browser cold launch can take a few seconds
const PING_INTERVAL_MS = 150;

export async function connectDaemon(cfg: FsConfig, opts: ClientOptions = {}): Promise<FrameClient> {
  const sockPath = controlSocketPath(cfg);
  const existing = await tryPing(sockPath, opts);
  if (existing) return existing;

  spawnDaemon();

  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, PING_INTERVAL_MS));
    const client = await tryPing(sockPath, opts);
    if (client) return client;
  }
  throw new Error(`daemon did not come up within ${BOOT_TIMEOUT_MS}ms — check \`fs doctor\``);
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
