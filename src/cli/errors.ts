/**
 * Unified error digest. Reads:
 *   - the daemon log file (CDP console/pageerror/network)
 *   - the browser-sink log file (window.__snatcher__ errors + console.error)
 * Returns a grouped, deduplicated summary with latest occurrence timestamps.
 *
 * V1.1: also poll next-devtools-mcp get_errors for build/runtime/type errors.
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";
import { ok, type Result } from "../core/result.ts";
import { requireConfig } from "../core/config.ts";

export async function run(args: string[]): Promise<Result> {
  const cfg = await requireConfig();
  const sinceArg = argValue(args, "--since") ?? "10m";
  const sinceMs = parseDuration(sinceArg);
  const cutoff = Date.now() - sinceMs;

  const logsDir = cfg.logsDir;
  const entries: Record<string, unknown>[] = [];
  for (const f of (await fs.readdir(logsDir).catch(() => [])).filter((f) => f.endsWith(".jsonl"))) {
    const raw = await fs.readFile(join(logsDir, f), "utf8").catch(() => "");
    for (const line of raw.split("\n").filter(Boolean)) {
      try {
        const e = JSON.parse(line) as Record<string, unknown>;
        const ts = e.ts ? Date.parse(String(e.ts)) : 0;
        if (ts >= cutoff && (e.level === "error" || e.level === "warn")) entries.push(e);
      } catch {}
    }
  }

  // Group by body signature
  const groups = new Map<string, { count: number; sources: Set<string>; latest: string; sample: Record<string, unknown> }>();
  for (const e of entries) {
    const sig = String(e.body ?? "").slice(0, 200);
    const g = groups.get(sig) ?? { count: 0, sources: new Set(), latest: String(e.ts ?? ""), sample: e };
    g.count++;
    g.sources.add(String(e.source ?? "?"));
    if (String(e.ts ?? "") > g.latest) g.latest = String(e.ts);
    groups.set(sig, g);
  }

  const digest = Array.from(groups.entries())
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 30)
    .map(([sig, g]) => ({
      body: sig,
      count: g.count,
      sources: Array.from(g.sources),
      latest: g.latest,
      sample: { stack: g.sample.stack, page: g.sample.page, level: g.sample.level },
    }));

  return ok({
    since: sinceArg,
    total: entries.length,
    groups: digest,
  });
}

function argValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

function parseDuration(s: string): number {
  const m = s.match(/^(\d+)([smhd])$/);
  if (!m) return 10 * 60 * 1000;
  const n = Number(m[1]);
  switch (m[2]) {
    case "s": return n * 1000;
    case "m": return n * 60 * 1000;
    case "h": return n * 60 * 60 * 1000;
    case "d": return n * 24 * 60 * 60 * 1000;
    default: return 10 * 60 * 1000;
  }
}
