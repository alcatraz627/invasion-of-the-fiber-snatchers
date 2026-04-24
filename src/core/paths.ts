/**
 * Target-project path resolution. Everything fiber-snatcher writes lives under
 * <target>/.fiber-snatcher/.
 *
 * A "target" is the project directory passed with --cwd or the current cwd if
 * not given. Resolution walks up from cwd looking for package.json; that's the
 * target root.
 */

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

function findPackageJsonUp(from: string): string | null {
  let dir = from;
  while (dir !== "/" && dir !== "") {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export async function resolveTargetRoot(): Promise<string> {
  // --cwd override
  const idx = process.argv.indexOf("--cwd");
  const cwdOverride = idx >= 0 ? process.argv[idx + 1] : undefined;
  const start = cwdOverride ? resolve(cwdOverride) : process.cwd();
  return findPackageJsonUp(start) ?? start;
}

export async function dataDir(): Promise<string> {
  const root = await resolveTargetRoot();
  return join(root, ".fiber-snatcher");
}

export async function subdir(name: string): Promise<string> {
  const { mkdir } = await import("node:fs/promises");
  const p = join(await dataDir(), name);
  await mkdir(p, { recursive: true });
  return p;
}
