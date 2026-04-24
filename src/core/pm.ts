import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveTargetRoot } from "./paths.ts";

export type Pm = "npm" | "pnpm" | "bun" | "yarn";

export async function detectPm(): Promise<Pm> {
  const root = await resolveTargetRoot();
  if (existsSync(join(root, "bun.lockb"))) return "bun";
  if (existsSync(join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(root, "yarn.lock"))) return "yarn";
  return "npm";
}
