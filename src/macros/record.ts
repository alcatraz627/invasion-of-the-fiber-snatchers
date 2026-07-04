/** Provenance: lift a slice of the journal into a draft macro. Each journaled
 *  action becomes a step whose target is the resolved element's most portable
 *  descriptor (its accessible text as an intent), with the original resolved
 *  descriptor preserved in `from` for the agent that edits the draft — it swaps
 *  literals for %params% and picks a by: strategy where a set is involved. */

import type { JournalEntry } from "../pipeline/contracts.ts";
import type { Macro, MacroStep } from "./format.ts";

/** Journaled commands that read rather than drive — never lifted into a flow. */
const NOT_ACTIONS = new Set([
  "log", "page", "state", "shoot", "info", "ping", "actions", "profile", "journal",
  "count", "queries", "atoms", "remount", "routes", "doctor", "macro", "session",
  "expect", "probe", "sleep", // sleep is a smell; a draft prefers `wait`
]);

export type DraftOpts = {
  name: string;
  lastN?: number; // keep only the last N recordable steps
  fromSeq?: number; // inclusive seq lower bound
  toSeq?: number; // inclusive seq upper bound
};

/** Build a draft macro from journal entries. Returns the Macro object; the
 *  caller stringifies/saves. The draft has no params — the agent adds them. */
export function draftFromJournal(entries: JournalEntry[], opts: DraftOpts): Macro {
  let slice = entries.filter((e) => e.ok !== false && !NOT_ACTIONS.has(e.cmd));
  if (opts.fromSeq !== undefined) slice = slice.filter((e) => e.seq >= opts.fromSeq!);
  if (opts.toSeq !== undefined) slice = slice.filter((e) => e.seq <= opts.toSeq!);
  if (opts.lastN !== undefined) slice = slice.slice(-opts.lastN);

  const steps: MacroStep[] = slice.map((e) => stepFromEntry(e)).filter((s): s is MacroStep => s !== null);

  return {
    name: opts.name,
    description: `drafted from journal (${steps.length} step${steps.length === 1 ? "" : "s"}) — add params, swap literals for %vars%`,
    tags: ["feature"],
    params: [],
    steps,
  };
}

function stepFromEntry(e: JournalEntry): MacroStep | null {
  // navigate carries a url, no target.
  if (e.cmd === "navigate" || e.cmd === "goto" || e.cmd === "nav") {
    const url = (e.args as { url?: string } | undefined)?.url;
    return { verb: "navigate", args: url ? { url } : {}, from: `navigate ${url ?? ""}`.trim() };
  }

  const step: MacroStep = { verb: e.cmd };
  if (e.target) {
    step.target = portableTarget(e.target);
    step.from = provenance(e.cmd, e.target);
  }

  // fill/press carry a value/key in args; surface them so the draft is runnable.
  const args = e.args as { value?: unknown; key?: unknown } | undefined;
  if (typeof args?.value === "string") step.value = args.value; // may be "[redacted]"; agent swaps for %param%
  if (typeof args?.key === "string") step.key = args.key;

  return step;
}

/** The replayable form: prefer the resolved accessible text (an intent string,
 *  portable across runs and documents). A ref is never emitted as the target —
 *  refs are generation-scoped and would be stale on the next run. */
function portableTarget(t: NonNullable<JournalEntry["target"]>): string {
  if (t.text && t.text.trim()) return t.text.trim();
  if (t.component) return t.component; // agent turns this into a Component[expr]
  return t.role || "button"; // last resort; the `from` line explains the gap
}

function provenance(cmd: string, t: NonNullable<JournalEntry["target"]>): string {
  const bits = [`resolved [${t.role || "?"}]`, t.text ? `"${t.text}"` : "", t.component ? `<${t.component}>` : "", t.ref ? `ref ${t.ref}` : ""];
  return `${cmd} ${bits.filter(Boolean).join(" ")}`;
}
