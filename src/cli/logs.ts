import { promises as fs } from "node:fs";
import { join } from "node:path";
import { ok, err, type Result } from "../core/result.ts";
import { requireConfig } from "../core/config.ts";

export async function run(args: string[]): Promise<Result> {
  const cfg = await requireConfig();
  const follow = args.includes("--follow") || args.includes("-f");
  const nIdx = args.indexOf("-n");
  const n = nIdx >= 0 ? Number(args[nIdx + 1]) : 100;
  const sourceIdx = args.indexOf("--source");
  const sources = sourceIdx >= 0 ? String(args[sourceIdx + 1] ?? "").split(",") : null;
  const levelIdx = args.indexOf("--level");
  const levelFloor = levelIdx >= 0 ? String(args[levelIdx + 1]) : null;

  const files = (await fs.readdir(cfg.logsDir).catch(() => []))
    .filter((f) => f.endsWith(".jsonl"))
    .sort();
  const lines: string[] = [];
  for (const f of files) {
    const raw = await fs.readFile(join(cfg.logsDir, f), "utf8").catch(() => "");
    lines.push(...raw.split("\n").filter(Boolean));
  }

  const LEVEL_ORDER = ["debug", "info", "warn", "error"] as const;
  const floorIdx = levelFloor ? LEVEL_ORDER.indexOf(levelFloor as any) : -1;

  const parsed = lines
    .map((l) => { try { return JSON.parse(l) as Record<string, unknown>; } catch { return null; } })
    .filter((x): x is Record<string, unknown> => !!x)
    .filter((e) => (sources ? sources.includes(String(e.source)) : true))
    .filter((e) => (floorIdx >= 0 ? LEVEL_ORDER.indexOf(String(e.level) as any) >= floorIdx : true));

  const slice = parsed.slice(-n);
  if (follow) {
    // Simple naive follow — print, then tail last file
    for (const e of slice) console.log(format(e));
    const lastFile = files[files.length - 1];
    if (!lastFile) return ok({ shown: slice.length });
    const path = join(cfg.logsDir, lastFile);
    let stat = await fs.stat(path);
    // poll every 500ms
    const interval = setInterval(async () => {
      const s = await fs.stat(path).catch(() => null);
      if (!s) return;
      if (s.size > stat.size) {
        const fh = await fs.open(path, "r");
        try {
          const buf = Buffer.alloc(s.size - stat.size);
          await fh.read(buf, 0, buf.length, stat.size);
          for (const l of buf.toString().split("\n").filter(Boolean)) {
            try { console.log(format(JSON.parse(l))); } catch {}
          }
        } finally { await fh.close(); }
        stat = s;
      }
    }, 500);
    // never resolve; user ctrl-C
    await new Promise(() => {});
    clearInterval(interval);
  }
  return ok({ entries: slice });
}

function format(e: Record<string, unknown>): string {
  return `${e.ts} [${e.source}/${e.level}] ${e.body}`;
}
