# Fiber Snatcher V2 — plan

<!-- sessions: pr217-job-status@2026-07-03 -->

Status: PROPOSAL for user review. Inputs: `architecture-map.md`,
`usage-mining.md`, `agent-first-research.md` (same folder), the user's briefs
(2026-07-02/03), and one heavy live session (205 invocations) as ground truth.

## 1. What V1's real usage proved

- In practice it is a browser driver + JS-eval REPL: click 70 / eval 36 /
  shoot 28 / navigate 26; dispatch, atoms, queries, components, errors: 0 uses.
  `state` was abandoned after 4 calls. The fiber layer is the differentiator on
  paper and dead weight in practice because its output shape and addressing
  never fit the task flow.
- Top failure: multi-match (18% of calls). The error never lists the matches,
  so `--nth` was a blind guess every time (worst case 67 matches).
- No waits: 106 manual sleeps (244s) + double-shoots. No effect feedback:
  dead clicks report success; one stale modal burned 5 calls + 3 screenshots.
- Screenshots ARE the observation channel for visual QA (28/28 read back);
  the debugging phase used zero shots (eval JSON sufficed). A text digest can
  replace roughly a third to half of shots; the rest are genuine visual checks.
- Sequences repeat: "open job modal" prefix ran 10+ times, fully replayed 6
  times after state loss. The composite-action library is empirically the
  highest-leverage feature (matches AWM research: +51% relative on WebArena).

## 2. Design philosophy — the agent is the user

The five tradeoffs (user's framing) become tool obligations:

| Agent property | Tool obligation |
|---|---|
| Blind but fast | Every action returns a digest-delta; observation never costs a second call |
| Mechanical but diligent | Waits, retries, verification live inside actions, not in agent judgment |
| Attention opportunity-cost | Budgeted output: ranked, delta-based, `concise\|detailed` knob; heavy payloads go to files |
| Needs next-step discovery | Every response carries affordances + `next_steps`; errors propose the fix (match lists, candidate refs) |
| Must express ambiguity while blind | Targeting accepts intent (role+text+component), returns ranked candidates in ONE round trip |

Efficacy definition: fiber-snatcher is not always-on; when invoked it must be
the go-to kit whenever static code reading isn't fast or reliable enough —
writing, debugging, exploring, verifying. Single-user tool (this machine,
local models available, Bun); zero portability tax. V1 remains the public
artifact; V2 is the personal kit.

## 3. Core architecture

**One action pipeline, used by every verb:**

```
resolve target → wait actionable → act → settle → emit digest-delta → journal
```

- **Single dispatch**: commands are data (one registry: name, args schema,
  pipeline hooks). Kills the 4-5-file boilerplate and the twin selector
  resolvers. Flag parsing becomes one shared parser.
- **Protocol**: keep the per-project unix socket; upgrade framing to ndjson
  with request ids (multiplexing + server-push), enabling real `watch`
  streams, screencast frames, and progress events. Daemon stays thin.
- **Page runtime via CDP injection** (replaces the bundle-copied `expose.ts`):
  injected on navigation by the daemon, versioned with the daemon, zero
  target-repo footprint, no `init --force` skew class. `init` shrinks to
  config + auth profile.
- **Run journal**: every action appended to `.fiber-snatcher/runs/<ts>.jsonl`
  (command, resolved target, result, digest-delta, frame ref). The journal is
  the seed for macros, sessions, replay, and post-hoc debugging. (V1 has
  no history at all; 0.2.0 even removed dispatch's before/after diff — V2
  makes the delta the contract.)
- **Keep from V1**: `Result<T>` + `next_steps` envelope, unix-socket-per-
  project, persistent profile + Pattern A/D auth, safeSnapshot stripping,
  minimal adapter contract `{getState, dispatch}`, doctor's skip-downstream
  probes, real-input-pipeline principle.

## 4. Targeting — refs first, intent always

- **Snapshot-ref model** (industry-convergent): `page` observations mint
  stable refs (`e12`); action verbs take refs. Staleness is explicit: acting
  on a stale ref returns the fresh candidate list, not a silent miss.
- **Intent resolution**: `click "Attributes tab"` resolves via role + text +
  fiber context; acts when confident, otherwise returns the ranked shortlist
  (with refs) — never "narrow the selector" without the matches. Multi-match
  ALWAYS prints the match list with context.
- **Component addressing** (the fiber edge no generic tool has):
  `click 'JobRow[title~="JEGS"]'`, `state 'PreviewJobOutputModal'` — resolve
  through the fiber tree, not CSS.
- CSS selectors remain as the escape hatch.

## 5. Telemetry ladder (agent-toggleable)

- **T0 digest-delta** — free with every action: what changed (url, modal
  open/closed, focused element, row-count deltas, new console errors, settled
  queries). Dead clicks become visible ("no observable change").
- **T1 page snapshot** — semantic text: route, surfaces, interactables with
  refs, list/table shapes, active filters, pending queries. Budgeted
  (scoped/paginated; `--concise|--detailed`). Built from a11y tree + fiber.
- **T2 targeted inspect** — component state/props, query cache entries, rows.
- **T3 look** — screenshot (full/element) from the **CDP screencast ring
  buffer**: daemon keeps rolling frames, `shoot` returns the latest instantly,
  `shoot --at -3s` answers "did it flicker", session video for scrubbing.
  No extension needed; capture stays in the tool's browser.
- **T4 delegated look** — screenshot piped through the local vision stack
  (`see`/gemma): the main agent gets a structural TEXT read of the pixels;
  near-zero context cost, near-zero dollars. T1-vs-T4 disagreement is itself
  a diagnostic (render bug or stale inject).
- **Profiles**: `telemetry explore|debug|verify|minimal` set per session —
  the throughput/quality/type knob.

## 6. Waiting

- Auto-wait inside every action (Playwright actionability checks).
- Vocabulary: `wait ref|text|gone|url|network-idle|settled` — `settled` =
  TanStack queries idle via the adapter, the framework signal no generic tool
  has. Bounded, with digest on timeout (what WAS on screen).
- `sleep` remains but is journal-flagged as a smell.

## 7. Event vocabulary (beyond V1's click/fill/press)

hover (popover-persistent), double-click, right-click, drag-and-drop, scroll
(window + element, virtualized-list aware), select-option, file upload,
clipboard paste, keyboard chords, viewport resize, typing with per-key delay
(debounce-real). Non-input: network intercept/mock/throttle + wait-for-call,
route-change watch, console/error stream with fail-on-error mode, element
screenshot diff (ties into visual-regression skill).

## 8. Composite actions, sessions, library

- **Authoring**: natural-language steps resolved once by the agent, cached as
  deterministic refs/selectors (Stagehand pattern); **artifact**: declarative
  YAML steps (Maestro pattern) — retries/waits live in the runtime, not the
  flow. Parameterized targets: `by: name|index|random|id` (fills the gap the
  research found in every surveyed tool).
- **Provenance**: `macro from-journal <range>` — lift the last N journaled
  actions into a draft macro. The "open job modal" prefix becomes
  `run open-job-modal --job "JEGS"` on day one.
- **Sessions**: goal + steps + assertions (`expect text|count|state|settled`).
  A finished session doubles as a regression test; failures dump journal +
  frames.
- **Library**: `~/.claude/fiber-actions/<project-key>/` — keyed by repo
  identity so worktrees share it; frontmatter tags (domain / feature /
  utility / data-read); discoverable via `actions list` (progressive
  disclosure: names+descriptions first, bodies on demand).

## 9. Eval, promoted (usage says it IS the tool)

- stdin/heredoc eval as first-class; session-level consent replaces 35×
  `--yes-i-know` boilerplate; `probe save/run <name>` folds the 17 `/tmp`
  probe scripts into the library; eval results auto-journal.

## 10. Ergonomics debt from V1 (all confirmed by mining)

- Auto-start daemon on first command (kills the status/start/doctor ritual;
  daemon was down at 2 of 3 phase starts). Boot handshake instead of 700ms
  blind sleep.
- Compact default output (73% of calls piped to `tail` today) — budget it so
  piping is unnecessary.
- Verified `close`/`escape` (assert the surface actually left the DOM — the
  export-saga fix).
- Route map: `routes` command reading the target app's route manifest
  (Next.js app dir) so navigation stops being guesswork.
- Hot-reload detection: remount events surface in T0; sessions declare a
  re-establish macro.

## 11. Build phases (each independently shippable)

- **P0 Core**: pipeline + registry, ndjson protocol, CDP-injected runtime,
  journal, auto-start. (The rework that everything else rides on.)
- **P1 See + wait**: T0 digest-delta, T1 snapshot+refs, wait vocabulary incl.
  `settled`, match-list errors, intent targeting v1 (role+text).
- **P2 Events**: hover + the input batch; verified close; effect reporting.
- **P3 Macros/sessions**: journal→macro, YAML runtime, params, library dir,
  assertions.
- **P4 Telemetry extras**: screencast ring buffer, `shoot --at`, T4 vision
  sidecar, telemetry profiles, network intercept.
- **P5 Polish + doctrine**: docs rewrite for agent readers, gcc note
  ("tools Claude writes for Claude" — the 15 research principles + this
  project's lived evidence), fiber component addressing v2, adapters cleanup.

Order rationale: P0 first because macros, journal, waits, and digest all need
the pipeline seam; P1 delivers the single biggest day-to-day efficacy jump
(waits + digest kill the sleep/shoot tax); P3 before P4 because macros
compound every later session.

## 12. Open questions for the user

1. V1 compatibility: freeze V1 CLI names/flags where they survive, or free
   rein to rename for coherence? (Lean: rename freely; you said V2 is
   personal.)
2. Screencast ring buffer duration/fps defaults (lean: 4 fps, 60s ring,
   tunable) — fine?
3. `probe`/macro library location confirmed as `~/.claude/fiber-actions/`
   keyed by repo identity? (From the earlier decision; re-confirming since
   probes now join macros there.)
