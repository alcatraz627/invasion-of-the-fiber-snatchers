# Fiber Snatcher V2 — implementation plan (Opus fleet, coordinated)

<!-- sessions: pr217-job-status@2026-07-04 -->

Companion to `V2-PLAN.md` (the what/why). This is the how: module layout,
frozen interfaces, work packages with acceptance criteria, fleet schedule,
and the coordination/review protocol. Decisions locked from user review:
free rein on CLI renames, screencast defaults 4fps/60s ring (tunable),
library at `~/.claude/fiber-actions/<repo-key>/` (probes included).

## 0. Build strategy — hybrid, not pure fleet

- **WP0 (core substrate) is built by the coordinator** (single context).
  Rationale: its five modules mutually constrain each other; interface
  stability is the product of WP0, and interfaces designed by committee in
  parallel diverge. Everything downstream depends on WP0's seams.
- **After WP0 merges, six interface contracts freeze** (§2). Any change to a
  frozen contract requires a coordinator-approved contract-change note in the
  WP report — builders never edit frozen files silently.
- **WP1-WP7 are fleet work**: Opus builders, one worktree each, file-ownership
  matrix (§5), coordinator reviews every diff against acceptance criteria
  before merge. Max 4 concurrent builders (throttle discipline).
- **Ground rule for all builders**: Bun + TypeScript, no new runtime deps
  without coordinator sign-off (Playwright + yaml parser expected; nothing
  else anticipated). Single-user tool: no portability shims, no Windows.

## 1. Target module layout

```
bin/fs.ts                     # thin CLI: parse → connect → print (rename: `fs` alias kept as `fiber-snatcher`)
src/
  protocol/
    frames.ts                 # ndjson framing, request ids, server-push events
    types.ts                  # Request/Response/Event envelopes, ErrorCode enum
  daemon/
    server.ts                 # socket server, request mux, event fan-out
    lifecycle.ts              # auto-start, boot handshake, pidfile, health
    screencast.ts             # CDP Page.startScreencast ring buffer (WP5)
  pipeline/
    index.ts                  # resolve → wait → act → settle → digest → journal
    targets.ts                # TargetSpec resolution (ref | intent | component | css)
    waits.ts                  # actionability + wait vocabulary incl. `settled`
    digest.ts                 # T0 delta computation; T1 snapshot builder
    journal.ts                # runs/<ts>.jsonl writer, run ids, from-journal reads
  actions/
    registry.ts               # ActionDef table: name, args schema, pipeline opts
    nav.ts pointer.ts keyboard.ts forms.ts observe.ts evalx.ts
    network.ts                # WP6
    macros.ts sessions.ts     # WP4 runtime verbs
  page-runtime/               # CDP-injected (addInitScript), versioned with daemon
    bridge.ts                 # window.__fs entry, message plumbing
    fiber.ts                  # fiber tree read, component addressing, owner context
    observe.ts                # mutation/error/route observers feeding digests
    adapters/jotai.ts adapters/tanstack.ts
  macros/
    format.ts                 # YAML schema + validation
    store.ts                  # ~/.claude/fiber-actions/<repo-key>/ resolution
    record.ts                 # journal → draft macro
  cli/
    parse.ts print.ts         # ONE arg parser; budgeted Result envelope printer
  vision/
    sidecar.ts                # `see` integration (WP5)
tests/
  fixture-app/                # tiny Next.js app: table, modal, dropdown, tabs,
                              # debounced search, TanStack query, jotai atom,
                              # file upload, drag list — the e2e playground
  e2e/*.test.ts               # per-WP suites driving the fixture app
```

## 2. Frozen interface contracts (deliverable of WP0)

Sketches — WP0 finalizes exact shapes; after merge these are frozen.

```ts
// protocol/types.ts
type Request = { id: string; cmd: string; args: Record<string, unknown> };
type Response = { id: string; ok: boolean; data?: unknown; error?: FsError;
                 digest?: DigestDelta; next_steps?: string[] };
type PushEvent = { event: "console"|"route"|"frame"|"watch"|"progress"; ... };
type FsError = { code: ErrorCode; message: string;
                 candidates?: TargetCandidate[]; hint?: string };
// ErrorCode: closed enum — consumers branch on code, never message text.

// pipeline/targets.ts
type TargetSpec =
  | { kind: "ref"; ref: string }              // from a snapshot (e12)
  | { kind: "intent"; text: string; role?: string }
  | { kind: "component"; expr: string }       // JobRow[title~="x"]
  | { kind: "css"; selector: string; nth?: number };
type TargetCandidate = { ref: string; role: string; text: string;
                        component?: string; confidence: number };

// pipeline/digest.ts
type DigestDelta = { url?: string; surfaces?: {opened?: string[]; closed?: string[]};
                    focus?: string; counts?: Record<string, [number, number]>;
                    errors?: string[]; queries?: "settled"|"pending";
                    mutations: "none"|"minor"|"major" };  // dead-click signal
type PageSnapshot = { route: string; surfaces: Surface[]; interactables: Ref[];
                     collections: CollectionShape[]; filters: string[];
                     pendingQueries: number; budget: "concise"|"detailed" };

// actions/registry.ts
type ActionDef<A> = { name: string; aliases?: string[]; args: Schema<A>;
  target?: "required"|"optional"|"none";
  wait?: WaitPolicy; settle?: SettlePolicy;
  run(ctx: PipelineCtx, args: A): Promise<unknown> };

// pipeline/journal.ts
type JournalEntry = { ts: string; run: string; seq: number; cmd: string;
  args: unknown; target?: ResolvedTarget; ok: boolean;
  digest: DigestDelta; frame?: string; durMs: number };

// page-runtime/bridge.ts — window.__fs surface
interface FsRuntime { snapshot(opts): RuntimeSnapshot; resolve(spec): Candidate[];
  componentQuery(expr): FiberHit[]; adapterState(name, sel?): unknown;
  observeStart(kinds): void; drainObservations(): Observation[]; version: string }
```

## 3. Work packages

Every WP ships: code + e2e tests against `tests/fixture-app` + a report at
`.claude/output/20260703-v2-plan/reports/WP<N>.md` (what built, deviations,
contract-change requests, test evidence). No WP is done without its tests
running green via `bun test` AND a journaled live drive of the fixture app.

### WP0 — Core substrate (coordinator; ~1.5-2k lines)
Scope: protocol frames/types; daemon server + lifecycle (auto-start on first
CLI call, boot handshake replacing the 700ms blind sleep); pipeline skeleton
with all six stages; action registry; journal; CDP-injected page runtime
scaffold (bridge + version check + fiber/adapters PORTED from V1, `init`
shrunk to config+auth — bundle-copy path deleted); ONE arg parser + printer;
ports of navigate/click/fill/press/shoot/eval onto the pipeline (digest may
be stub-minimal: url + mutations only); fixture app + smoke e2e.
Acceptance: V1 task parity through the new path on the fixture app; cold
`fs click` (daemon down) works in one command; every action journaled;
`doctor` green incl. runtime version match; zero references to
`.fiber-snatcher/expose` remain.

### WP1 — Digest + refs + targeting (fleet; owns pipeline/digest.ts, targets.ts, actions/observe.ts)
T0 delta (full shape incl. surface open/close, counts, dead-click signal);
T1 `page` snapshot with minted refs, concise|detailed budget, pagination;
ref-taking actions with explicit staleness (stale ref → fresh candidates);
intent targeting (role+text v1) + component addressing (fiber) + ALWAYS
match-list-on-ambiguity with candidates in the error.
Acceptance (fixture): dead click detected; `click "Attributes tab"` resolves
by intent; ambiguous "Delete" returns ranked candidates with refs in ONE call;
snapshot of 10k-row table stays under 3KB concise.

### WP2 — Waits + settle (fleet; owns pipeline/waits.ts, page-runtime/observe.ts settle hooks)
Actionability auto-wait on every action; `wait ref|text|gone|url|network-idle|settled`;
settle stage after actions (mutations quiet + queries idle, bounded);
timeout digests (what WAS on screen); `sleep` journal-flagged.
Acceptance (fixture): debounced-search flow with ZERO sleeps; `wait settled`
returns when TanStack idle; timeout returns digest not bare error.

### WP3 — Event verbs (fleet, two builders; owns actions/pointer.ts, keyboard.ts, forms.ts)
3a pointer/keyboard: hover (incl. popover-persist check), dblclick, rclick,
drag, scroll (window/element/virtualized), chords, type-with-delay.
3b forms/misc: select-option, upload, paste, resize, verified close/escape
(asserts surface left the DOM).
Acceptance (fixture): hover opens+holds popover digest; drag reorders list;
scroll loads virtualized rows; verified-close fails loudly on a stuck modal.

### WP4 — Macros, sessions, probes (fleet; owns macros/*, actions/macros.ts sessions.ts)
YAML format+validation; store at `~/.claude/fiber-actions/<repo-key>/`
(repo-key = git remote hash fallback path-hash; worktrees share); frontmatter
tags; `actions list` progressive disclosure; `macro from-journal <range>`;
params `by: name|index|random|id` + `%var%`; NL-authored steps cached to
deterministic targets on first run; sessions = goal+steps+assertions
(`expect text|count|state|settled`), failure dumps journal+frames; `probe
save/run` (stdin eval library, session-level consent replacing --yes-i-know).
Acceptance: record open-modal flow from journal, replay with `--job` param
on fixture; failed assertion produces actionable dump; probes run from store.

### WP5 — Telemetry extras (fleet; owns daemon/screencast.ts, vision/sidecar.ts, profiles)
Screencast ring buffer (4fps/60s defaults, tunable), `shoot` from buffer,
`shoot --at -3s`, session video; T4 `look` → local `see` returns text read;
telemetry profiles explore|debug|verify|minimal wired into pipeline emit.
Acceptance: shoot latency < 50ms warm; --at returns distinct past frame;
`look` returns structural text with no image in the tool result; profiles
change T0 verbosity observably.

### WP6 — Network + watches (fleet; owns actions/network.ts, daemon event fan-out use)
Intercept/mock/throttle via Playwright routes; `wait call <urlpattern>`;
route-change + console/error streams over server-push; fail-on-error session
mode. Acceptance (fixture): mock an API and drive UI against it; wait-call
resolves on fetch; console error stream reaches CLI live.

### WP7 — Ergonomics + routes (fleet, small; owns cli/print polish, routes cmd)
`routes` from Next.js app-dir manifest; hot-reload/remount detection into T0;
output budget audit (nothing needs `| tail`); help text rewritten for agent
readers (every error self-describing).
Acceptance: `routes` lists fixture routes; induced HMR shows remount in next
digest; help fits one screen per command.

### WP8 — Docs + doctrine (coordinator, last)
CLAUDE.md/USAGE.md rewritten agent-first; CHANGELOG; V2 migration note; gcc
note `~/.claude/conventions/agent-first-tools.md` ("tools Claude writes for
Claude": the 15 research principles + lived evidence from usage-mining) +
CLAUDE.md Tier-2 pointer row. Version bump to 2.0.0.

## 4. Dependency graph and fleet schedule

```
WP0 (coordinator)
 ├─→ freeze contracts (§2)
 ├─→ Wave 1 (parallel): WP1, WP2, WP7          [3 builders]
 ├─→ Wave 2 (parallel): WP3a, WP3b, WP4, WP5   [4 builders; WP3 needs WP1 refs,
 │                       WP4 needs WP1 refs + WP0 journal — start after WP1 merge]
 ├─→ Wave 3: WP6                                [1 builder; anytime after WP0,
 │                       scheduled late to reuse Wave-1 digest conventions]
 └─→ WP8 (coordinator) after all merges
```

Wave rule: ≤4 concurrent builders. WP2 and WP1 both touch pipeline stage
seams — ownership split is per-file (§5) and both build against WP0's stage
interfaces, so they parallelize; integration order on merge: WP1 → WP2.

## 5. Coordination protocol (the coordinator's own runbook)

- **Dispatch**: each builder gets: its WP section verbatim, the frozen
  contracts file, its file-ownership list (owns / may-read / must-not-touch),
  the fixture-app tour, and the report path. Worktree isolation per builder;
  Opus model; write-report-before-return mandatory.
- **File ownership**: exclusive ownership per WP as annotated in §3. Shared
  files (registry table rows, fixture app additions) are append-only zones;
  conflicts resolved by coordinator at merge.
- **Contract changes**: builder writes a CONTRACT-CHANGE section in its
  report; coordinator approves + applies to the frozen file + notifies
  affected in-flight builders via SendMessage. Silent drift = rejected diff.
- **Review gate per WP**: coordinator reads the full diff (not the report
  alone), runs `bun test` + the WP's fixture drive live, checks acceptance
  criteria one by one, checks output-budget discipline (no unbudgeted dumps),
  then merges. Rejections go back with file:line notes.
- **Integration checkpoints**: after each wave, coordinator runs the full e2e
  suite + one real-world drive against the Versable dev app (the PR-217
  modal flow as the canonical dogfood: open modal → filter → popover →
  filtered export dry-run) and journals it as the wave's evidence.
- **Progress tracking**: Task-tool tasks per WP; wave status in
  `reports/STATUS.md`.

## 6. Risks and mitigations

- **CDP runtime injection vs Next/Turbopack quirks** (highest unknown):
  WP0 spikes this FIRST (inject into fixture + Versable dev, verify fiber
  access post-HMR). Fallback if addInitScript misses hydration windows:
  inject on `domcontentloaded` + re-inject on navigation events.
- **Ref staleness across HMR**: refs carry a document generation id; any ref
  from an older generation returns REFRESH_REQUIRED with fresh candidates.
- **Fleet scope creep**: acceptance criteria are closed lists; builders add
  nothing beyond their WP (report "suggested follow-ups" instead).
- **Screencast memory**: ring buffer capped (60s × 4fps × ~100KB ≈ 24MB) —
  fine on this machine; hard cap + `telemetry minimal` disables capture.

## 7. Definition of done (V2.0.0)

All WP reports merged and green; full e2e suite green; the canonical Versable
dogfood drive completes with zero sleeps, ≤2 screenshots, and a recorded
`open-job-modal` macro replayed by parameter; gcc doctrine note published;
V1 command parity table documented in the migration note.
