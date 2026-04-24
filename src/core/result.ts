/**
 * Uniform result shape. Every CLI command returns this.
 * Also persisted to .fiber-snatcher/last-run.json so Claude can read the
 * structured outcome even if stdout was clipped/colorized.
 */

import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { resolveTargetRoot } from "./paths.ts";

export type OkResult<T = unknown> = {
  ok: true;
  code?: string;
  data: T;
  warnings?: string[];
  next_steps?: string[];
  exitCode?: 0;
};

export type ErrResult = {
  ok: false;
  code: string;          // stable uppercase identifier, e.g. E_SELECTOR_AMBIGUOUS
  message: string;        // human-readable one-liner
  context?: Record<string, unknown>;
  next_steps?: string[];
  exitCode?: 1 | 2 | 3 | 4;
};

export type Result<T = unknown> = OkResult<T> | ErrResult;

export function ok<T>(data: T, extras?: Partial<OkResult<T>>): OkResult<T> {
  return { ok: true, data, ...extras };
}

export function err(code: string, message: string, extras?: Partial<ErrResult>): ErrResult {
  return { ok: false, code, message, ...extras };
}

export async function renderResult(r: Result, opts: { json: boolean }) {
  // Persist a sanitized copy to last-run.json
  try {
    const root = await resolveTargetRoot();
    const dir = join(root, ".fiber-snatcher");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "last-run.json"), JSON.stringify(r, null, 2));
  } catch {
    // non-fatal — last-run is a convenience, not a requirement
  }

  if (opts.json) {
    console.log(JSON.stringify(r));
    return;
  }

  if (r.ok) {
    if (r.code) console.log(`✓ ${r.code}`);
    if (r.data !== undefined && r.data !== null) {
      const pretty = typeof r.data === "string" ? r.data : JSON.stringify(r.data, null, 2);
      console.log(pretty);
    }
    for (const w of r.warnings ?? []) console.log(`  ⚠ ${w}`);
    for (const s of r.next_steps ?? []) console.log(`  → ${s}`);
  } else {
    console.error(`✖ ${r.code}: ${r.message}`);
    if (r.context) console.error("  context:", JSON.stringify(r.context, null, 2));
    for (const s of r.next_steps ?? []) console.error(`  → ${s}`);
  }
}
