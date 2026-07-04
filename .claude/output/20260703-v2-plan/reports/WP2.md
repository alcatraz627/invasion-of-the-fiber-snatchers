# WP2 report — waits + settle

Branch: `v2-wp2` (worktree `fs-worktrees/wp2`, from `v2` with WP1 + WP7 merged).
Commits: `c12f281` (runtime read) -> `51312ee` (wait engine + verbs + pipeline + CLI)
-> `3f52b73` (e2e suite + poll-loop replacements).

Status: built, behaviorally validated, live-driven. `bunx tsc --noEmit` clean;
`bun test` **58 pass / 0 fail / 200 expect across 6 files** (baseline was 51/51;
+7 from the new WP2 suite, existing suites unchanged in count). **No frozen file
touched, no CONTRACT-CHANGE requests** — `--quiet`/`--settle-timeout` ride on the
`SettlePolicy.quietMs`/`timeoutMs` fields already declared in the frozen contract,
and the runtime addition is a new method (`queriesActivity`), not a shape change.

Files changed: `src/pipeline/waits.ts` (new), `src/actions/wait.ts` (new),
`src/pipeline/index.ts` (wait-stage + settle wiring only), `src/actions/registry.ts`
(one import + one spread), `src/cli/parse.ts` (two boolean flags), `bin/fs.ts`
(wait/sleep arg mapping + settle flags + request-timeout margin),
`src/page-runtime/index.ts` (the `queriesActivity` read), and the tests below.

## Built

### 1. The debounce hole — the load-bearing fix
The default settle pass polls `drain()` and breaks when the DOM is quiet AND no
query is fetching. Right after a `fill`, the app's debounce timer has not fired,
so pending is 0 and that pass can honestly read "settled" a beat before the query
starts. `--settled` (post-condition on mutating verbs) and `wait --settled` (verb)
both route through `waitSettled` in `waits.ts`, which treats settled as *no query
fetching AND none started for a quiet grace* (default 400ms, `--grace`-tunable).
A query that fires at any point resets the grace, so the wait only returns once the
page is genuinely query-quiet. Because "did a query fire?" must be true even for a
query that starts and finishes between two polls, the runtime tracks a **monotonic
`started` counter** via a TanStack `QueryCache` subscription (`queriesActivity()`);
a point-in-time pending read alone would miss it.

Live evidence (fixture, 250ms debounce + 400ms query, zero sleeps in the test):
```
fill --css "section input" "Part 12" --settled -> ok, #row-count already filtered, digest queries:settled
fill (no flag) then wait --settled          -> #row-count filtered after the verb returns
```

### 2. `wait` vocabulary (bounded, ~5s default, `--timeout` override)
- `wait <ref|intent|css>` — present, visible, actionable (Playwright polling for
  ref/CSS; the runtime resolver's confidence gate for intent/component).
- `wait --text "…"` — text present anywhere in the visible page text.
- `wait --gone <target>` — left the DOM or hidden (the verified inverse).
- `wait --url <substring | /regex/flags>` — reads `location.href` live, so soft
  navigations count.
- `wait --network-idle` — Playwright networkidle (HTTP-level, coarser than settled).
- `wait --settled` — the framework signal above.

On timeout every form returns `E_WAIT_TIMEOUT` whose response carries **what was on
screen**: a concise T1 snapshot as `data` plus a state digest (surfaces + query
state), built from non-destructive reads so the observation buffer is untouched.
The agent re-plans from that instead of retrying blind.

### 3. Per-verb settle budgets (tunable, no contract change)
navigate/reload keep their 8s settle. click/press keep the pipeline defaults
(quiet 150ms / timeout 3000ms), which are adequate for the fixture's async — the
debounce case is handled by `--settled`, not by widening the blind settle pass.
Per-call tunables plumb through `mergeSettle`: `--quiet <ms>` and
`--settle-timeout <ms>` overlay `SettlePolicy.quietMs`/`timeoutMs`; `--timeout`
(with `--settled`) and `--grace <ms>` tune the post-condition wait.

### 4. `sleep` — the escape hatch that says so
`sleep <ms>` exists for parity but self-marks its journal entry `smell: true`
(the journal records the args object by reference, so the verb owns the marker,
not the CLI) and its summary + returned note steer toward `wait`.

### 5. Review seed #24
The old `E_WAIT_TIMEOUT` hint pointed at a `--no-settled` flag that never shipped.
Hints now name the flags that actually exist (`--timeout`, `--grace`, `fs page`),
and the dead `no-settled` boolean-flag token was removed from `parse.ts` since the
design is opt-in `--settled`.

## Acceptance criteria (brief + IMPLEMENTATION.md §3-WP2)

| Criterion | Result |
|---|---|
| debounced search via `fill --settled`, ZERO sleeps/polls | PASS — wp2 "closes the debounce hole"; also the rewritten smoke fill test |
| `wait --gone` on modal close | PASS — wp2 "times out while open, resolves once closed" |
| `wait --settled` returns when TanStack idle | PASS — wp2 "returns once the query is idle" + boot-settle in every suite |
| `wait --text` on async row content | PASS — wp2 "appears when the async query renders the row" |
| timeout returns E_WAIT_TIMEOUT with page-state payload | PASS — wp2 "carries the page state" (data.interactables + digest) |
| sleep journals its smell marker | PASS — wp2 "journals a smell marker" (args.smell === true) |
| per-verb settle budgets tunable | PASS — wp2 "honors a custom (too-short) budget" (--timeout on --settled) |
| poll loops in smoke + review-regressions replaced | PASS — `rg setTimeout` across all three e2e files returns nothing |
| `tsc --noEmit` clean + `bun test` green | PASS — tsc exit 0; 58 pass / 0 fail / 200 expect / 6 files |

## Deviations from spec

1. **`--settled` is opt-in, not the default.** The brief specifies a `--settled`
   flag added to mutating verbs; WP0 had pre-registered a `--no-settled` boolean
   (implying settle-on-by-default). I shipped the brief's opt-in `--settled` and
   removed the dead `--no-settled` token so the surface matches what ships. The
   default settle pass is unchanged for verbs without the flag.
2. **One-line pipeline resolve guard added.** `runAction` now skips eager target
   resolution for `target:"none"` verbs (`def.target !== "none"`), so `wait` can
   receive an inferred `TargetSpec` in `args.target` and do its own polling
   resolution (the element may not exist yet — the whole point of a wait). No
   existing `none` verb sets `args.target`, so nothing else is affected.
3. **Runtime read added** (`queriesActivity`, `src/page-runtime/index.ts`). The
   brief anticipated this ("a 'query went pending since baseline' read may be
   needed — add minimally"). It is one method plus a cache subscription in the
   tanstack adapter; `queriesPending` is untouched.

## CONTRACT-CHANGE requests

None. Everything landed within the frozen `SettlePolicy` / `WaitPolicy` shapes and
the closed `ErrorCode` enum (`E_WAIT_TIMEOUT` already existed).

## Test evidence

```
bunx tsc --noEmit -> exit 0
bun test          -> 58 pass, 0 fail, 200 expect(), 6 files, ~73s
  tests/e2e/wp2.test.ts              7 pass  (fill --settled, wait --settled, --text,
                                             --gone open/closed, timeout payload,
                                             tunable budget, sleep smell)
  tests/e2e/smoke.test.ts           11 pass  (fill test now uses --settled, no poll)
  tests/e2e/review-regressions.ts    9 pass  (boot settle via wait --settled, no poll)
  tests/e2e/wp1.test.ts             14 pass  (unchanged)
  tests/e2e/wp7.test.ts             10 pass  (unchanged)
  tests/protocol.test.ts             7 pass  (unchanged)
rg "setTimeout|for \(let i" across the three e2e files -> no matches (zero sleeps/polls)
Live CLI: `fs help` lists wait + sleep (registry-generated); `fs wait --settled`,
`fs wait --gone`, `fs wait --text` all driven through the real CLI->daemon->browser
path in the suite.
```

## Suggested follow-ups (out of scope; not built)

- **Grace vs a long debounce.** `--settled`'s "no query ever started" branch bets
  on the grace (400ms default) exceeding the app's debounce. An app that debounces
  longer than the grace could read settled early; `--grace` is the escape hatch and
  the timeout hint says so, but a smarter default could read the app's debounce if
  a future adapter exposes it. Documented in `waitSettled`'s docstring.
- **`wait --text` matches visible text only** (`document.body.innerText`); text in
  an input value or an `aria-label`-only control won't match. Fine for the async-row
  acceptance; worth an `--attr`/`--value` mode if a real app needs it.
- **`wait --call <urlpattern>`** (network request matcher) is WP6's `network.ts`
  scope, not built here; `--network-idle` is the coarse stand-in until then.
- **`waitForTarget` "visible but never enabled"** resolves after the enabled poll
  window rather than erroring — the action's own actionability check is the
  authoritative gate. If a dedicated "wait until enabled" failure is wanted, it
  would be a distinct mode.
