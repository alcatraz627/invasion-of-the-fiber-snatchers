/** Sessions group a run of actions under a stated goal, hold `expect` assertions
 *  taken along the way, and on `session end` emit a summary that doubles as a
 *  regression record. A failed session dumps the journal slice + frame refs so
 *  the failure is self-contained. The active session is module state: the daemon
 *  is one long-lived process, so it persists across separate CLI calls without
 *  the daemon needing to know sessions exist. */

import { FsErrorShaped, type ActionDef, type PipelineCtx } from "../pipeline/contracts.ts";
import { readJournal } from "../pipeline/journal.ts";
import type { ExpectSpec } from "../macros/format.ts";
import { runAssertion, type ExpectResult } from "../macros/run.ts";
import { macroContext } from "../macros/context.ts";

type RecordedAssertion = ExpectResult & { at: string };
type ActiveSession = { goal: string; startedAt: string; assertions: RecordedAssertion[] };

let active: ActiveSession | null = null;

/** Probes treat an open session as consent (see probes.ts) — the user has
 *  declared they are driving. */
export function isSessionActive(): boolean {
  return active !== null;
}

const badArgs = (message: string, hint: string) => new FsErrorShaped({ code: "E_BAD_ARGS", message, hint });

export type SessionArgs = { sub?: string; goal?: string; name?: string };
export type ExpectArgs = { spec?: ExpectSpec };

export const sessionActions: (ActionDef<SessionArgs> | ActionDef<ExpectArgs>)[] = [
  {
    name: "session",
    summary: "Group a run under a goal with assertions: session start <goal> | session end [--name n] | session status",
    target: "none",
    observation: true,
    settle: false,
    async run(_ctx, args: SessionArgs) {
      switch (args.sub) {
        case "start": {
          if (!args.goal) throw badArgs("session start needs a goal", 'fs session start "export a filtered view"');
          active = { goal: args.goal, startedAt: new Date().toISOString(), assertions: [] };
          return {
            session: args.goal,
            started: true,
            note: "actions + assertions until `session end` belong to this session; probes may run without --allow",
          };
        }
        case "end":
          return await endSession(args.name);
        case "status":
          return active
            ? { active: true, goal: active.goal, since: active.startedAt, assertions: active.assertions.length }
            : { active: false };
        default:
          throw badArgs(`unknown session subcommand "${args.sub ?? ""}"`, "use: start <goal> | end | status");
      }
    },
  } as ActionDef<SessionArgs>,
  {
    name: "expect",
    summary: 'Assert page state: expect text "…" | count <css> <n> | state <expr> --equals <v>|--truthy | settled',
    target: "none",
    observation: true,
    settle: false,
    async run(ctx: PipelineCtx, args: ExpectArgs) {
      if (!args.spec) throw badArgs("expect needs a kind", 'fs expect text "Saved"  |  fs expect settled');
      const result = await runAssertion(ctx, args.spec);
      // Record into the session (pass or fail) BEFORE surfacing, so the summary
      // reflects every checkpoint even when a failed one raises.
      if (active) active.assertions.push({ ...result, at: new Date().toISOString() });
      if (!result.ok) {
        throw new FsErrorShaped({
          code: "E_WAIT_TIMEOUT",
          message: `assertion failed: ${result.kind} — ${result.detail ?? "no detail"}`,
          hint: active ? "recorded on the session; `fs session end` for the full dump" : "run `fs page` to see current state",
        });
      }
      return { ...result, recorded: !!active };
    },
  } as ActionDef<ExpectArgs>,
];

async function endSession(name?: string): Promise<unknown> {
  if (!active) throw badArgs("no active session", "start one with `fs session start <goal>`");
  const s = active;
  active = null;

  const { store, runsDir } = await macroContext();
  const entries = (await readJournal(runsDir).catch(() => [])).filter((e) => e.ts >= s.startedAt);
  // The session's own control verbs aren't part of the flow it groups.
  const stepEntries = entries.filter((e) => e.cmd !== "log" && e.cmd !== "session" && e.cmd !== "expect");
  const failures = stepEntries.filter((e) => e.ok === false).map((e) => ({ seq: e.seq, cmd: e.cmd, error: e.error }));
  const assertionFailures = s.assertions.filter((a) => !a.ok);
  const frames = stepEntries.filter((e) => e.frame).map((e) => ({ seq: e.seq, frame: e.frame! }));
  const ok = failures.length === 0 && assertionFailures.length === 0;

  const record = {
    goal: s.goal,
    startedAt: s.startedAt,
    endedAt: new Date().toISOString(),
    ok,
    steps: stepEntries.length,
    assertions: s.assertions,
    failures,
    assertionFailures,
    frames,
    // Only dump the journal slice on failure — a passing session's summary stays
    // small; a failing one is self-contained for re-planning.
    journalSlice: ok ? undefined : stepEntries.map((e) => ({ seq: e.seq, cmd: e.cmd, ok: e.ok, error: e.error, digest: e.digest })),
  };

  const recName = uniqueSessionName(s.goal, name, store);
  const path = store.write("sessions", recName, JSON.stringify(record, null, 2));
  return { ...record, saved: path, name: recName };
}

function uniqueSessionName(goal: string, name: string | undefined, store: { entryExists: (k: "sessions", n: string) => boolean }): string {
  const base = (name ?? goal)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "session";
  let candidate = base;
  let i = 2;
  while (store.entryExists("sessions", candidate)) candidate = `${base}-${i++}`;
  return candidate;
}
