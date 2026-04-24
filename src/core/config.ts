/**
 * Loads .fiber-snatcher/config.json. Written by `init`, read by everything.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { dataDir } from "./paths.ts";

export type FsConfig = {
  version: string;           // fiber-snatcher version that wrote this
  devUrl: string;             // e.g. http://localhost:3006
  authHeader: string;         // X-Fiber-Snatcher-Key
  authKeyPath: string;        // path to file containing the key (gitignored)
  profileDir: string;         // Playwright persistent-context dir
  shotsDir: string;
  logsDir: string;
  daemonPidFile: string;
  cdpPortHint: number;        // port we ask Playwright to expose CDP on (best-effort)
  sources: {
    nextDevCommand: string;   // e.g. "npm run dev"
    pm: "npm" | "pnpm" | "bun" | "yarn";
  };
  // Adapters enabled on the expose.ts surface. V1 supports "redux", "zustand".
  // V1.1 will add "tanstack-query", "jotai".
  adapters: string[];
};

export const DEFAULT_AUTH_HEADER = "X-Fiber-Snatcher-Key";

export async function loadConfig(): Promise<FsConfig | null> {
  const file = join(await dataDir(), "config.json");
  try {
    const raw = await readFile(file, "utf8");
    return JSON.parse(raw) as FsConfig;
  } catch {
    return null;
  }
}

export async function writeConfig(cfg: FsConfig): Promise<void> {
  const dir = await dataDir();
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "config.json"), JSON.stringify(cfg, null, 2));
}

export async function requireConfig(): Promise<FsConfig> {
  const cfg = await loadConfig();
  if (!cfg) {
    throw new ConfigError(
      "E_NOT_INITIALIZED",
      "fiber-snatcher is not set up in this project. Run `fiber-snatcher init` first.",
    );
  }
  return cfg;
}

export class ConfigError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}
