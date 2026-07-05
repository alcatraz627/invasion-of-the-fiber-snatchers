/**
 * Release gate: assert package.json version === RUNTIME_VERSION in
 * src/page-runtime/version.ts (the V2 injected runtime). Catches the drift bug
 * that hit V0.3.0 (CLI reported 0.3.0, runtime still said 0.2.0).
 *
 * Usage: bun scripts/check-versions.ts
 * Exits 1 if versions diverge.
 */

import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const RUNTIME_FILE = "src/page-runtime/version.ts";

const pkg = JSON.parse(await readFile(resolve(ROOT, "package.json"), "utf8")) as { version: string };
const runtimeSource = await readFile(resolve(ROOT, RUNTIME_FILE), "utf8");
const m = runtimeSource.match(/RUNTIME_VERSION\s*=\s*["']([^"']+)["']/);

if (!m) {
  console.error(`✖ could not find RUNTIME_VERSION in ${RUNTIME_FILE}`);
  process.exit(1);
}

const runtime = m[1];
if (runtime !== pkg.version) {
  console.error(`✖ version drift: package.json=${pkg.version}, RUNTIME_VERSION=${runtime}`);
  console.error(`  Update ${RUNTIME_FILE} RUNTIME_VERSION to match before release.`);
  process.exit(1);
}

console.log(`✓ versions aligned: ${pkg.version}`);
