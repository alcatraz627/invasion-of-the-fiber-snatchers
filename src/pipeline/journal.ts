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

  /** The seq of the most recently appended entry — a macro/session dump cites
   *  it as the journal ref for the step that just ran. */
  get lastSeq(): number {
    return this.seq;
  }

  append(entry: Omit<JournalEntry, "ts" | "run" | "seq">): JournalEntry {
    const full: JournalEntry = {
      ts: new Date().toISOString(),
      run: this.runId,
      seq: ++this.seq,
      ...entry,
      args: redactSecrets(entry.cmd, entry.args, entry.target),
    };
    this.stream.write(JSON.stringify(full) + "\n");
    return full;
  }

  /** Resolves after buffered entries are flushed — await before process.exit. */
  close(): Promise<void> {
    return new Promise((resolve) => this.stream.end(() => resolve()));
  }
}

// A fill's value is a secret when the field it targets reads like one. Password
// inputs can't be told apart by role (the runtime reports "textbox" for every
// text input) and the journal entry carries no element type, so redaction keys
// off the target descriptor — the resolved label or the CSS selector — rather
// than the element's `type`. This catches the common cases (a password targeted
// by intent/label or `input[type=password]`); it CANNOT catch a password field
// reached by an opaque ref with a bland label, and it does NOT touch eval or
// dispatch payloads, which can still carry secrets. Type-accurate redaction
// would need the resolved element's type plumbed into the journal entry — a
// change to the frozen pipeline contract, tracked as a follow-up.
const SECRET_RE = /pass(word|code|phrase)?|secret|token|otp|cvv|\bpin\b|credential|api[-_ ]?key/i;

function redactSecrets(cmd: string, args: unknown, target: JournalEntry["target"]): unknown {
  if (cmd !== "fill" || !args || typeof args !== "object" || !("value" in args)) return args;
  if (!looksSecret(args as { target?: unknown }, target)) return args;
  return { ...(args as object), value: "[redacted]" };
}

function looksSecret(args: { target?: unknown }, target: JournalEntry["target"]): boolean {
  const bits: string[] = [];
  if (target?.text) bits.push(target.text);
  const spec = args.target;
  if (spec && typeof spec === "object") {
    const s = spec as { selector?: string; text?: string };
    if (s.selector) bits.push(s.selector);
    if (s.text) bits.push(s.text);
  }
  const hay = bits.join(" ");
  if (/\[type=["']?password["']?\]/i.test(hay)) return true;
  return SECRET_RE.test(hay);
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
