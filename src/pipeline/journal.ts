/** Append-only run journal: every action, its target, result, and digest.
 *  The seed for macros ("lift what I just did"), replay, and post-hoc debug. */

import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { JournalEntry } from "./contracts.ts";

export class Journal {
  private stream: WriteStream;
  private seq = 0;
  readonly runId: string;
  readonly path: string;

  constructor(private dir: string) {
    mkdirSync(dir, { recursive: true });
    this.runId = new Date().toISOString().replace(/[:.]/g, "-");
    this.path = join(dir, `${this.runId}.jsonl`);
    this.stream = createWriteStream(this.path, { flags: "a" });
  }

  append(entry: Omit<JournalEntry, "ts" | "run" | "seq">): JournalEntry {
    const full: JournalEntry = {
      ts: new Date().toISOString(),
      run: this.runId,
      seq: ++this.seq,
      ...entry,
    };
    this.stream.write(JSON.stringify(full) + "\n");
    return full;
  }

  /** Resolves after buffered entries are flushed — await before process.exit. */
  close(): Promise<void> {
    return new Promise((resolve) => this.stream.end(() => resolve()));
  }
}

/** Read entries back (macro recording, `journal` command). Latest run default. */
export async function readJournal(dir: string, runId?: string, lastN?: number): Promise<JournalEntry[]> {
  let file: string;
  if (runId) {
    file = join(dir, `${runId}.jsonl`);
  } else {
    const files = (await readdir(dir).catch(() => [] as string[])).filter((f) => f.endsWith(".jsonl")).sort();
    const latest = files.at(-1);
    if (!latest) return [];
    file = join(dir, latest);
  }
  const raw = await readFile(file, "utf8").catch(() => "");
  const entries = raw
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l) as JournalEntry;
      } catch {
        return null;
      }
    })
    .filter((e): e is JournalEntry => !!e);
  return lastN ? entries.slice(-lastN) : entries;
}
