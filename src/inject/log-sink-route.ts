/**
 * Fiber Snatcher — Next.js route handler that receives browser-originated logs.
 * Copy to `app/_fs/log/route.ts` (App Router) or adapt for Pages Router.
 *
 * Writes newline-delimited JSON to `.fiber-snatcher/logs/browser.jsonl`.
 * Dev-only; returns 403 outside development.
 *
 * The daemon tails this file (or subscribes to SSE /_fs/log/stream in V1.1)
 * and merges into the unified log stream.
 */

import { NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import { join } from "node:path";

const LOG_FILE = join(process.cwd(), ".fiber-snatcher", "logs", "browser.jsonl");

export async function POST(req: Request) {
  if (process.env.NODE_ENV !== "development") {
    return NextResponse.json({ error: "disabled outside development" }, { status: 403 });
  }
  try {
    const entry = await req.json();
    await fs.mkdir(join(process.cwd(), ".fiber-snatcher", "logs"), { recursive: true });
    await fs.appendFile(LOG_FILE, JSON.stringify(entry) + "\n");
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }
}

// GET returns the last N entries — useful for Claude one-off probes without the daemon.
export async function GET(req: Request) {
  if (process.env.NODE_ENV !== "development") {
    return NextResponse.json({ error: "disabled outside development" }, { status: 403 });
  }
  const url = new URL(req.url);
  const n = Math.min(1000, Math.max(1, Number(url.searchParams.get("n") ?? 100)));
  try {
    const raw = await fs.readFile(LOG_FILE, "utf8").catch(() => "");
    const lines = raw.split("\n").filter(Boolean).slice(-n).map((l) => JSON.parse(l));
    return NextResponse.json({ ok: true, entries: lines });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }
}
