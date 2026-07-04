# WP6 report — network intercept + watches

Branch: `v2-wp6` (worktree `fs-worktrees/wp6`, from `v2`).
Commits: `08936f2` (network verbs + watches + verify network dimension + fixture +
e2e) -> `b323d0e` (relabel NetParts to fix a sibling-suite intent collision) ->
route-watch test (pending its own commit — see Test evidence).

Status: built, behaviorally validated, live-driven. `bunx tsc --noEmit` clean.
Every suite passes when run individually: **157 tests / 0 fail across 15 files**
(baseline 147 + the 11-test WP6 suite). No frozen file touched; **no
CONTRACT-CHANGE requests** — network events ride the `PushEvent` variants already
in the frozen contract (`console`/`route` directly; the generic `watch` variant
carries network payloads, which have no dedicated shape).

Files: `src/actions/network.ts` (new), `src/daemon/server.ts` (WatchHub +
network-error routing + watch/unwatch — surgical), `bin/fs.ts` (arg-mapping for
my verbs + `wait --call` sugar + the `runWatch` streaming loop), `src/cli/parse.ts`
(two boolean flags), `src/actions/registry.ts` (one import + one spread),
`tests/fixture-app/serve.ts` + `app.tsx` (a real `/api/parts` endpoint + the
NetParts fetch widget, both append-only), `tests/e2e/wp6.test.ts` (new).

## Built

### 1. Intercept / mock — `mock`, `unmock`
`mock <pattern> [--status N] [--body <json|->] [--delay ms] [--times n]` installs
a Playwright route via a page-keyed `MockRegistry` (a `WeakMap<Page>`, the same
pattern `screencast.ts` uses for its ring, so mock state survives across verb
calls without threading through the frozen `PipelineCtx`). `--body -` reads the
JSON body from stdin. `--times n` uses Playwright's own `{ times }` to retire the
route after n hits (the "auto-unroute" the brief asks for) while the handler
counts hits for `mock list`. Re-mocking a pattern replaces the prior mock.
`mock list` reports each active mock's `{pattern, status, hits, times, exhausted,
delayMs}`; `unmock <pattern>` / `unmock --all` remove routes (real `page.unroute`).

### 2. Throttle — `throttle <3g|slow-3g|offline|off>`
CDP `Network.emulateNetworkConditions` over a page-cached CDP session
(`Network.enable` once). Presets match Puppeteer's PredefinedNetworkConditions
(fast-3g / slow-3g throughput+latency; `offline`; `off` disables with -1
throughput). An unknown preset is a shaped `E_BAD_ARGS`.

### 3. `wait --call <pattern> [--done]`
Resolves when a matching request fires — and critically, also when one *already
fired* during the previous action (an agent clicks Export, then asks "did it
POST?"; a bare `waitForRequest` is future-only and would hang). It checks the
daemon's `NetworkObserver` recent-request buffer first (default 3s lookback,
`--since` tunable), then falls back to `page.waitForRequest` / `waitForResponse`
(`--done`) for an upcoming one. On timeout it throws the shaped `E_WAIT_TIMEOUT`;
the pipeline attaches the page-state payload, same as WP2's waits. Returns
`{fired, method, url, status, when: "already"|"waited"}`.

Reachable as `fs wait --call <pattern>` (a CLI sugar that routes to the verb) or
`fs wait-call <pattern>` directly (see Deviation 1 for why it is a distinct verb).

### 4. Watches — `watch console|route|network [--level error] [--for <ms>]`
The first real consumer of server-push. The CLI (`runWatch`) opens a connection
with an `onPush` handler, sends a `watch` request, holds the socket open printing
matching events to stdout (the status banner goes to stderr so it never pollutes
the stream), and unsubscribes on `--for` expiry or SIGINT. The daemon's `WatchHub`
does the subscription bookkeeping: it attaches a page/observer listener on the
FIRST subscription of a kind and detaches on the LAST, so an idle daemon does no
watch work. `console` streams `console` PushEvents (level-filterable), `route`
streams `route` PushEvents on main-frame `framenavigated`, `network` subscribes to
the shared `NetworkObserver` and streams `watch` PushEvents tagged with the
subscription's watchId.

### 5. Fail-on-error network dimension (`profile verify`)
The `NetworkObserver` (attached at daemon boot, always listening) records every
request/response/failure and keeps an error log of `>=400` responses and hard
`requestfailed`s. In the daemon's action path, `server.ts` marks the error log
before running a verb and folds any errors seen during it into the verb's
`digest.errors`. WP5's existing verify check then fails the action; other profiles
just surface it (a 500 during a click is worth showing regardless). Deliberate
Playwright route aborts are filtered out so they aren't misread as app errors.

### 6. Fixture additions (append-only, sanctioned by the brief)
`serve.ts` gains a real `/api/parts?q=` JSON endpoint; `app.tsx` gains a `NetParts`
widget that fetches it through TanStack (`retry:false` so a mocked 500 surfaces at
once), plus a Deferred button that fires a fetch on a timer (the upcoming-request
case for `wait --call`). The rest of the fixture fakes async with an in-page timer;
this widget is the only real HTTP for the network verbs to shape and observe.

## Acceptance criteria (brief + IMPLEMENTATION.md §3-WP6)

| Criterion | Result |
|---|---|
| mock an API and drive UI against it | PASS — wp6 "mock swaps the API response…" (net-count renders 2 mock rows) |
| `mock list` shows active mocks with hit counts; `unmock` clears | PASS — wp6 "mock list reports active mocks with hit counts; unmock clears" |
| throttle preset applies; off restores; bad preset shaped | PASS — wp6 "throttle applies a preset and off restores" |
| `wait --call` resolves on fetch (already-fired) | PASS — wp6 "…request that already fired" (`when:"already"`) |
| `wait --call` resolves on fetch (upcoming) | PASS — wp6 "…an upcoming (deferred) request" |
| `wait --call` timeout → shaped error + page state | PASS — wp6 "…times out with a shaped error and page state" |
| console error stream reaches CLI live | PASS — wp6 "watch console streams a console error live" |
| route-change stream reaches CLI live | PASS — wp6 "watch route streams a navigation as it happens" |
| network stream reaches CLI live | PASS — wp6 "watch network streams a request as it fires" |
| verify fails an action whose request 500s | PASS — wp6 "profile verify fails an action whose request 500s" |
| `tsc --noEmit` clean + suites green | PASS — tsc exit 0; 157/157 across 15 files (per-suite) |

## Deviations from spec

1. **`wait --call` is a `wait-call` verb + a CLI sugar, not a mode of `wait`.**
   WP2 owns `actions/wait.ts` (an "other action file" on my must-not-touch list),
   so I could not add a `--call` mode to its verb. Instead `wait-call` is its own
   registry verb, and `bin/fs.ts` rewrites `fs wait --call <pattern>` to it before
   the switch (WP2's `case "wait"` is byte-for-byte untouched). The brief's
   `wait --call` surface is preserved; `fs wait-call` also works.
2. **Two touches to shared CLI plumbing, for my verbs.** `src/cli/parse.ts` gained
   `done` and `all` in `BOOLEAN_FLAGS` (so `--done`/`--all` don't swallow a
   following positional; grep confirmed no other verb uses them as value flags),
   and `bin/fs.ts`'s request-timeout branch gained `|| cmd === "wait-call"`. Both
   are outside the must-not-touch list and scoped to my verbs; flagging for review.
3. **Network errors fold into `digest.errors` under all profiles, not only verify.**
   The brief frames this as a verify feature; I surface the error in every profile
   and let verify escalate it to a failure. This is honest (a 500 during a click is
   real) and matches `minimal`'s `terseDigest`, which keeps `errors`.
4. **Self-introduced regression, caught and fixed.** The NetParts widget's first
   labels ("api parts search", "Load parts") collided with the fixture's existing
   "parts search" intent and flipped wp1's single-low-confidence test to
   `E_TARGET_AMBIGUOUS`. Relabeled to API-endpoint wording (`b323d0e`); the widget
   is targeted by `#id` in the tests, so labels are free.

## CONTRACT-CHANGE requests

None. `watch` uses only the frozen `PushEvent` variants: `console` and `route`
directly, and the generic `watch` variant (`watchId` + `payload`) for network,
which has no dedicated variant. `E_WAIT_TIMEOUT` / `E_BAD_ARGS` already exist.

## Handoffs / plumbing gaps (documented, not reworked)

The task asked me to document server-push plumbing gaps rather than rework the
protocol. Three, all in `protocol/frames.ts` (frozen, not mine):

1. **Push fan-out is broadcast-to-all-clients, not per-socket.** `startFrameServer`
   hands the handler one `pushAll` that writes to every connected socket. It works
   because one-shot CLIs set no `onPush` and drop pushes, and network events carry
   a `watchId` the watching CLI filters on. A future need to push to exactly one
   client would want `frames.ts` to expose a per-socket push (or a socket id).
2. **No server-side watch cleanup on disconnect.** The 2-arg handler never learns
   which socket a request came from or when one closes (frames.ts owns the socket
   lifecycle), so the WatchHub can only detach on an explicit `unwatch`. The CLI
   sends `unwatch` on `--for`/SIGINT, but a hard SIGKILL leaks a subscription
   (a detached-only-on-unwatch listener that keeps broadcasting). Fix would be a
   per-connection disconnect signal or socket id from `frames.ts` so the hub can
   GC a dead client's subs.
3. **`wait --call` runs serialized (it is a normal ActionDef).** So "wait for a
   request that a *concurrent* command will trigger" isn't expressible through one
   serialized chain — the request must come from app activity (a timer/poll) or the
   recent buffer. The buffer check covers the common click-then-confirm case; a
   non-serialized observer variant is a possible follow-up if a use case needs it.

## Test evidence

```
bunx tsc --noEmit -> exit 0
Per-suite (each its own daemon+browser), all green:
  tests/e2e/wp6.test.ts              11 pass  (registry verbs, mock-drives-UI,
                                              mock list/hits/unmock, throttle,
                                              wait --call already/upcoming/timeout,
                                              watch route/network/console, verify 500)
  tests/e2e/smoke.test.ts            11 pass   tests/e2e/wp1.test.ts   14 pass
  tests/e2e/wp2.test.ts               7 pass   tests/e2e/wp3a.test.ts  15 pass
  tests/e2e/wp3b.test.ts             16 pass   tests/e2e/wp4.test.ts   12 pass
  tests/e2e/wp5.test.ts              11 pass   tests/e2e/wp7.test.ts   10 pass
  tests/e2e/review-regressions.ts     9 pass   tests/protocol.test.ts   7 pass
  tests/unit/*.test.ts               35 pass  (4 files)
  ---------------------------------------------------------------------------
  157 tests total, 0 fail
```

**Full-fan `bun test` note.** Running all 15 files at once spins up ~15 headless
Chromium daemons concurrently and this machine intermittently times out 1-2 e2e
tests under that load (a beforeEach hook exceeds its budget, empty daemon reply).
This is pre-existing and environmental, not a WP6 regression: the same full-fan
run on the untouched `v2` baseline flaked 2 wp3a tests the same way, and every
suite (including wp3a) passes cleanly in isolation. Recommend the L3 review run
suites individually or with bounded file concurrency.

## Suggested follow-ups (out of scope; not built)

- **Per-client push / watch GC on disconnect** — needs the `frames.ts` changes in
  Handoff 1-2; would let `watch` clean up after a hard kill and enable targeted
  (non-broadcast) pushes.
- **`mock` from a fixtures directory / recorded HAR** — `mock --body` is inline or
  stdin today; replaying a captured response set would be the natural extension.
- **`throttle` custom profile** — presets cover the common cases; a
  `--download/--upload/--latency` escape hatch would round it out.
- **A non-serialized `wait --call`** — see Handoff 3, if a concurrent-trigger use
  case appears.
