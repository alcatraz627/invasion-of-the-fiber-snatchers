# PERF-AUDIT: fiber-snatcher V2

Performance audit of the V2 branch. Every number below is measured on the real
path (fixture app + a real headless-Chromium daemon), not estimated. Throwaway
harnesses lived in `/tmp/fs-perf/` (`perf-main.ts`, `perf-followup.ts`,
`perf-bundle.ts`, `sample-run.sh`); the repo tree was not modified.

## How this was measured

- **Machine/load caveat (matters for the flake section).** During the audit the
  box carried background load from other sessions: ~7 `@playwright/mcp` node
  processes plus this session's own work, load average ~1.6–2.4. Browser-boot
  numbers and the full-fan flake are load-sensitive; where that changes a verdict
  it is called out.
- **Two clocks, kept separate.** "Warm socket" numbers time the daemon's own
  request handling through a persistent `FrameClient` (no process spawn). "Warm
  CLI" numbers time the full `fs <verb>` an agent actually runs (bun spawn +
  module load + connect + request). Conflating them hides the real story, so they
  are reported apart.
- Medians over 7–12 runs for fast ops; honest single/triple runs for slow ones
  (cold start, flake). `bun 1.3.14`, `playwright 1.55.1`.

## Measurements vs floor

| # | Measurement | Result (median) | Floor / expectation | Verdict |
|---|---|---|---|---|
| 1 | Cold start, daemon-down `fs info`, browser boot included | **432 ms** (428–439) | none stated | Good, but load-sensitive; see note |
| 2 | Warm round-trip, **raw socket**: ping / info / eval / page-concise | **0.0 / 0.5 / 0.3 / 0.9 ms** | non-browser < 100 ms warm | Pass by 100x+ |
| 2b | Warm round-trip, **full CLI**: `fs info` / `fs page` | **120 / 128 ms** | < 100 ms warm (if read as CLI) | **Miss**, all of it is bun spawn+load |
| 3 | Snapshot, `page` concise / detailed on the fixture table | **1.42 KB / 5.44 KB** | concise < 3 KB | Pass (see fixture caveat) |
| 3b | Snapshot at a **real 10k-row DOM** (injected) | concise **1.46 KB / 24 ms**, detailed 14.5 KB / 16 ms | concise < 3 KB | Bytes pass; **time 30x'd** |
| 4 | Settle overhead, inert click vs raw DOM click | **166 ms** vs **3.3 ms** | flag if ~150 ms floor dominates | **Confirmed dominates** |
| 4b | Settle overhead, re-rendering click (Failed-only toggle) | **330 ms** | n/a | Two settle cycles |
| 5 | Runtime bundle injected per document | **24.2 KB** (14.5 KB minified, 7 KB gzip) | none | Fine; build ~1.4 ms cold |
| 6 | Journal write amplification | **~170 B/entry** (median 137 B, max 321 B) | none | Negligible |
| 7 | Screencast ring @ 4fps, ~9s on fixture | 16 frames, **689 KB**, ~44 KB/frame → **~10 MB / 60s** | 25 MB cap | Pass; paint-gated |
| 7b | Shoot from ring vs live | **1 ms** vs **63 ms** | ring < 50 ms warm | Pass (63x faster) |
| 8 | **Full-fan `bun test`** (all 15 files, 3 runs) | **2/3 green at 158/158 in ~169 s; 1/3 hung** | suite green | **Fix-now**, intermittent, see deep-dive |
| 9 | Drain, fixture steady-state / adapter-less | **~0 ms / 0.2–0.5 ms** | negative cache holds | Pass |

## The two headline findings

### A. The entire warm CLI cost is bun process startup, not fiber-snatcher

The daemon answers `info`/`page`/`eval` in **under 1 ms** over the socket. The
same commands through the CLI cost **~120 ms**. The gap is not the daemon and not
the browser: `fs --help` (which never touches the daemon) also costs **120 ms**,
and a bare `bun -e 0` is ~9 ms. So **~110 ms of every `fs` call is bun loading the
`fs.ts` module graph** (`bin/fs.ts` pulls in the whole `src/` tree, playwright
types, yaml, the registry).

Why it matters: the L4 floor "warm command round-trip < 100 ms for non-browser
ops" is met at the socket layer and **missed at the layer the agent actually
uses**. An agent driving a flow pays ~120 ms per verb no matter how trivial. Ten
verbs is ~1.2 s of pure interpreter startup.

Note the floor's phrasing also assumes `info` is a "non-browser op", it is not:
`server.ts:241` does a `page.evaluate` + `page.title()` on every `info`. It just
happens to be sub-millisecond warm, so the mislabel does not change the number.

### B. The full-fan `bun test` flake is boot-timeout-under-load, not concurrency

**Three-run distribution.** Run 1 hung (killed at 5 min, `smoke` stuck, empty
CLI output). Runs 2 and 3 both finished clean: **158 pass / 0 fail across 15
files in ~169 s each.** So the suite is healthy and the flake is intermittent
(1 of 3 here), triggered by machine load, not a broken test. Note ~169 s is the
new full-suite wall (WP5's 87 s predates WP6's files); the growth is the
sequential per-file cold browser boots adding up, not parallel work.

WP6 flagged that a full `bun test` "spins up ~15 headless Chromium daemons
concurrently" and flakes 1–2 tests. Both halves of that turned out wrong on
inspection:

- **bun runs test files sequentially.** A two-file synthetic probe shares one pid
  and file B fully finishes before file A starts. There is no file-level
  parallelism to bound.
- **There is no Chromium leak.** Sampling `pgrep` every second across an e2e run
  showed a steady **1 daemon + 1 Chromium** the entire time, never a pile-up.
  Each e2e file boots its own daemon+browser in `beforeAll` and tears it down in
  `afterAll`; sequential files mean one at a time.
- **Each file passes in isolation** (`smoke.test.ts` alone: 11/11 in 18.6 s).

So the real contention is **repeated cold browser boots** (one per file, ~10
files) on a loaded machine, and the failure is a specific fragile seam:

1. A test spawns `fs <verb> --json`; that CLI must reach a live daemon.
2. Under load the cold boot occasionally exceeds `BOOT_TIMEOUT_MS = 12_000`
   (`daemon/lifecycle.ts:15`), so `connectDaemon` throws.
3. `bin/fs.ts:573-577` sends that error to **stderr** and `process.exit(1)`,
   leaving **stdout empty**.
4. The test harness reads only `proc.stdout` (`harness.ts:60-64`; `smoke.test.ts`
   has its own copy at `:30-43`) and does `JSON.parse("")`, which throws
   `non-JSON CLI output:` (empty). That is verbatim what `flake1.log` recorded.

The harness also `await proc.exited` with **no per-call timeout** and drains only
stdout, so a slow or wedged CLI spawn can stall a `beforeEach`, and because files
are sequential, one stuck file blocks the whole suite. One observed run sat on a
single `smoke` hook for 269 s before I killed it, consistent with a `beforeEach`
looping through repeated ~12 s boot-timeouts rather than a single call. (The exact
269 s is one pathological run; I did not reproduce that precise figure a second
time, so I am not over-claiming its mechanism. The empty-stdout root cause is
code-grounded and reproducible.)

## Ranked issues + ideas

### fix-now

1. **Harden the e2e `fs()` helper, the cheapest flake fix.** Give
   `harness.ts` (and the duplicated helper in `smoke.test.ts`) a per-call timeout,
   drain **stderr** as well as stdout, and on empty stdout retry once after a
   short backoff. This converts a transient boot-timeout from "whole-suite hang"
   into "one retried call," without touching the daemon model. Rationale: the
   suite is already sequential, so the brief's "bounded concurrency" lever does
   not apply; the fragility is the helper swallowing the failure shape.
2. **Surface the CLI/daemon-boot failure on stdout in `--json` mode.** When
   `connectDaemon` throws, `bin/fs.ts` should still print a shaped
   `{ok:false,error:{code:"E_DAEMON_BOOT",...}}` envelope to **stdout** (not just
   stderr) so any `--json` consumer branches on a code instead of choking on
   empty output. This is the same "never make the caller parse emptiness" contract
   the rest of V2 already follows.

### followup

3. **Settle floor dominates simple interactions (brief item 4 confirmed).** A
   no-op click costs **166 ms**, a re-rendering click **330 ms**, because
   `settleAndDigest` (`pipeline/index.ts:337-347`) does `await sleep(quietMs=150)`
   **before** its first drain, and any mutation forces a second 150 ms cycle. Idea:
   drain **first**, and only sleep-and-recheck if that first drain shows activity
   (mutations or pending queries). A genuinely quiet click would then return in a
   few ms instead of 150+. The 150 ms exists to let React flush; a rAF/microtask
   probe or a much smaller first-probe window (16–30 ms) would keep that guarantee
   at a fraction of the cost. Highest-leverage latency win for interactive driving.
4. **Share one daemon across the e2e suite (boot-cost + flake together).** Ten
   files = ten cold browser boots. A `bunfig.toml` `preload` that boots a single
   daemon+fixture once and points every file at it would cut ~9 cold boots and
   remove the per-file boot-timeout window that item B rides on. Tradeoff: less
   per-file isolation (the current unique-tempdir design is deliberate), so this
   is a followup, not a fix-now, worth it only if item 1's hardening doesn't
   settle the flake on CI hardware.
5. **CLI startup tax (finding A).** ~110 ms per `fs` call is bun loading the
   module graph. Options, cheapest first: lazy-import the heavy branches
   (`bin/fs.ts` imports the whole registry + playwright types eagerly), or ship a
   thin client that connects to the daemon without loading `src/`, or a
   persistent-connection mode for agents issuing many verbs. Not a floor breach at
   the socket layer, but it is the real per-verb latency an agent feels.
6. **Snapshot time scales with DOM size, and concise is slower than detailed at
   scale.** At a real 10k-row DOM, `page concise` is **24 ms** vs detailed's
   16 ms, because concise runs `els.filter(!inCollection)`, a parent-walk per
   interactable across all 10k+ controls (`page-runtime/index.ts:462`), plus
   `isVisible` (a `getComputedStyle`, forced layout) on every interactable, which
   both budgets pay. Still well under 100 ms, so followup not fix-now, but worth a
   short-circuit: once a control is known to be inside a counted collection, skip
   the per-element visibility/label work.

### wont-fix (documented, working as intended)

7. **Runtime bundle (24 KB), journal (170 B/entry), screencast ring (~10 MB/60s
   under the 25 MB cap), drain steady-state (~0 ms), negative cache (0.2–0.5 ms
   adapter-less).** All comfortably within budget. The ring is paint-gated, not a
   fixed 4 fps, so a static page costs almost nothing. Leave as-is.

## Surprises worth flagging

- **The fixture's "10k-row table" is 50 DOM rows.** `app.tsx:51` does
  `rows.slice(0, 50)`; the 10k only ever lives in the TanStack query result, never
  the DOM (`domTableRows: 50`, `domAllElements: 306`). So the L4 floor "concise
  < 3 KB on the fixture's 10k-row table" has been validated against a 306-element
  DOM, not a 10k one. When I injected 10k real `<tr>`, concise bytes still held
  (1.46 KB) but time jumped 30x. Recommend the fixture grow a genuinely large,
  non-virtualized collection so the floor exercises what its wording claims.
- **WP6's flake diagnosis was directionally wrong** ("15 concurrent Chromiums").
  The observed truth is 1-at-a-time sequential boots; the flake is a stdout/stderr
  contract seam, not parallelism. Good that WP6 flagged it for investigation; the
  fix is different from what it guessed.
- **`info` claims to be a non-browser op but does a `page.evaluate`.** Immaterial
  to timing (sub-ms warm) but worth knowing if the floor's wording is ever taken
  literally.

## Processes

All measurement daemons/Chromiums were killed (`pgrep -f src/daemon/server.ts`
and `user-data-dir=.*fs-e2e|fs-perf` both clean at exit). One daemon leaked when a
5-minute full-fan run was force-killed mid-flake; it was reaped
(`kill 20062` → cascade close verified). The ~7 `@playwright/mcp` processes are
other sessions' and were left alone.
