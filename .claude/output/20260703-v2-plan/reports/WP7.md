# WP7 report — ergonomics, doctor, routes, thin verbs

Branch: `v2-wp7` (worktree `fs-worktrees/wp7`, from `v2`). Commits:
`c668ac6` (verbs) → `2b6d4a8` (suite decoupling) → `296533d` (doctor error-page test).

Status: built, behaviorally validated. `bunx tsc --noEmit` clean; `bun test`
37/37 green (27 pre-existing + 10 new WP7). No frozen file touched — **no
CONTRACT-CHANGE requests**.

## Built

- **`doctor` (src/actions/doctor.ts + bin/fs.ts)** — two halves. A daemon-side
  ActionDef returns in-page facts (daemon vs page runtime version, adapters,
  url, on-error-page). A CLI orchestrator (`runDoctorCli`) runs the environment
  probes and dispatches the ActionDef *only if the daemon is already up*. doctor
  is special-cased in `bin/fs.ts` **before** the auto-start path, so it never
  boots the daemon it is diagnosing (`connectDaemon(..., { spawnIfDown: false })`).
  Probes, one line each with ✓/✗/!/· + remedy hint: config, dirs
  (shots/logs/runs writable), dev-server (HEAD then GET fallback), v1-daemon
  conflict (socket-accepts + pidfile-alive → warn + `fiber-snatcher stop`
  remedy), v2-daemon reachability, page-url, runtime-match, adapters.
  Skip-downstream: daemon down → runtime/adapters `skip`; tab on a blank/error
  page → page-url `warn`, runtime/adapters `skip` (no false fails). This closes
  WP0-review **#17**: the dangling `fs doctor` hint now resolves to a real verb.

- **`routes` (src/actions/routes.ts)** — walks the target's Next.js App Router
  source (`<root>/src/app` or `<root>/app`, root resolved via
  `resolveTargetRoot()` from the daemon cwd) for `page.{tsx,jsx,ts,js}` dirs and
  renders each as a URL path. Route groups `(group)` and parallel slots `@slot`
  descend but add no segment; dynamic dirs `[id]`/`[...slug]` pass through
  verbatim. Non-Next / Pages-Router target → `{ router: "none", detail, routes: [] }`.

- **Thin state verbs (src/actions/statev.ts)** — `queries [filter]`,
  `atoms [name]`, `dispatch <json> [--adapter]`, `count <selector>`, each a small
  ActionDef (`observation: true, settle: false`) over the runtime's existing
  `dispatch`/`count` bridge. Adapter-missing errors are mapped to `E_ADAPTER`
  (a contract code) instead of leaking as `E_INTERNAL`. Closes WP0-review **#14**
  (the state verbs that were V1's core value existed in V2 only via
  `fs eval window.__fs…`).

- **Registry-generated help (bin/fs.ts)** — the commands section of `fs help` is
  built from `listActions()` so it can't drift from the verb table (WP0 shipped
  it hand-written and already stale). Header, targets, and daemon-level commands
  (info/journal/profile/actions/stop, which aren't registry verbs) stay
  hand-written. Aliases render in `(parens)` and normalize to the primary verb
  (the normalization itself was already in place from the WP0 review fix).
  Closes WP0-review **#26**.

- **Remount detection (src/actions/remount.ts)** — `fs remount` arms a sentinel
  on the React container (found by the `__reactContainer$` stamp; fallback
  `#root`/`#__next`/body) that watches the container's child-node identity. A
  full Fast Refresh / HMR remount swaps that child; ordinary re-renders patch in
  place and stay quiet. Reports `{ armed, container, remounts, lastAt }`;
  `--reset` zeroes the counter. Each detection also emits a distinct
  `console.error("[fs] hot-reload remount detected (#N)")` so an in-window
  remount surfaces in that action's `digest.errors` via the runtime's **existing**
  console interception — zero page-runtime/contract changes. (See handoffs for
  the between-action case.)

- **e2e suite decoupling (tests/e2e/smoke.test.ts)** — closes WP0-review **#30**.
  Each acceptance test now self-establishes its page baseline via
  `beforeEach(reset)` (eval-based: close modal, select Data tab, wait for the
  parts query — no reload, so it doesn't perturb the test's own mutation buffer)
  and opens the surfaces it needs. Cold-start moved to its own describe so the
  reset doesn't boot the daemon before it can observe a cold one. icon-only now
  asserts a counter *increment* (order-independent); the journal test drives its
  own actions incl. a deliberate failure rather than relying on the suite's
  accumulated history. Verified: the previously order-coupled tests (dead-click,
  icon-only, journal) pass in isolation via `bun test -t`.

## Acceptance criteria (IMPLEMENTATION.md §3-WP7 + task validation)

| Criterion | Result |
|---|---|
| `routes` lists fixture routes | PASS — wp7.test.ts, fake App Router tree: `/`, `/jobs`, `/jobs/[jobId]`, `/about` (group stripped), `/blog/[...slug]`; `/settings` (layout-only) excluded |
| induced HMR shows remount in next digest | PARTIAL — `fs remount` detects + counts a root remount (tested); in-window remounts reach `digest.errors` via console bridge. Between-action remounts surviving preDrain = WP1 handoff (below) |
| help fits one screen per command | PASS — registry-generated, ~20 verb lines + daemon section; one line per verb with aliases |
| doctor: broken config + healthy target | PASS — healthy (all ✓), uninitialized (config ✗, exit 1), dead dev-server (dev-server ✗, daemon-probes skip), blank-page (page-url warn, runtime/adapters skip) |
| state verbs on fixture | PASS — `queries`/`queries parts`/`queries <nomatch>` filter correctly; `count 'table tbody tr'` = 50; `dispatch` invalidate ok + bad-JSON → E_BAD_ARGS; `atoms` returns an array |
| `bunx tsc --noEmit` clean + `bun test` green | PASS — TSC exit 0; 37 pass / 0 fail / 121 expect across 4 files (29s) |

## Deviations from spec

1. **doctor is CLI-orchestrated, not a pure daemon verb.** The spec lists it under
   `src/actions/`, and the in-page probe *is* an ActionDef there — but the
   environment probes and skip-downstream logic must run without starting the
   daemon (a probe that force-starts the thing it checks is meaningless), so the
   orchestrator lives in the same file and is invoked from `bin/fs.ts` before the
   auto-start path. server.ts is untouched: the doctor ActionDef dispatches
   through the existing default→`lookupAction` path, so the only command-table
   change WP7 needed was **none**.
2. **A 4th action file, `remount.ts`,** beyond the named doctor/routes/statev. It
   is a new file under the owned `src/actions/` dir; kept separate because
   `actions/observe.ts` is WP1-owned and must not be touched.
3. **Fixture is the WP0 Bun-served React SPA, not Next.js** (WP0 deviation #1), so
   `routes` is validated against a synthetic App Router tree seeded in the e2e
   target dir rather than a real Next app. Real-Next coverage stays on the L4
   Versable dogfood.
4. **`atoms` returns `[]` on the fixture** — jotai enumeration needs
   `dev4_get_mounted_atoms`, absent on the production-built fixture bundle (this
   is WP0-review #16, a WP1 seed). The verb is correct; the fixture can't
   exercise the populated path. Test asserts shape (array), not contents.

## Test evidence

```
bunx tsc --noEmit → exit 0
bun test          → 37 pass, 0 fail, 121 expect(), 4 files, 29.0s
  tests/e2e/wp7.test.ts            10 pass  (doctor ×4, routes, state ×4, remount)
  tests/e2e/smoke.test.ts          11 pass  (decoupled; cold-start + 10 acceptance)
  tests/e2e/review-regressions.ts   9 pass  (unchanged; verified order-robust in isolation)
  tests/protocol.test.ts            7 pass
Isolation checks (bun test -t):
  "dead-click detection reports none"   1 pass  (was coupled to the ambiguity test)
  "icon-only button clicks by ref"      1 pass  (was coupled to the modal being closed)
  "journal recorded every action"       1 pass  (was coupled to suite-wide history)
```

## WP1 handoffs (page-runtime — not touchable from WP7)

1. **`safeSnapshot` strips `key`/`ref` from adapter dispatch results**
   (`src/page-runtime/index.ts:51` lists them in `REACT_INTERNAL_KEYS`, applied at
   `:68`). `dispatch()` wraps its return in `safeSnapshot`, so `fs queries` loses
   the TanStack query **key** — the one field that says *which* query each entry
   is. Repro: `fs queries` → entries have `status/fetchStatus/hasData/error` but no
   `key`. The React-internal-key filter is correct for fiber props/state (`state()`
   path) but wrong for adapter results (`dispatch()` path). Fix: don't apply the
   `key`/`ref` filter to dispatch results — either pass `includeInternals`-style
   opt-out from `dispatch()`, or snapshot adapter results with a filter that only
   drops `__`-prefixed keys. Mitigation shipped: `fs queries <filter>` filters by
   key-substring *before* the strip, so the agent still selects by key.

2. **Between-action remounts don't reach T0.** The console.error bridge surfaces a
   remount only if it lands inside an action's observation window; a remount that
   happens while no fs command runs is cleared by the next action's preDrain
   (`src/pipeline/index.ts:192`, `.catch(()=>null)` discards it) before it's
   reported. To surface it, `drain()` (`src/page-runtime/index.ts:400`) needs a
   remount counter that survives the buffer clear (like `mutationWeight` but not
   reset by preDrain, reported through the existing `errors[]` channel — no
   `DigestDelta` field, so frozen-contract-compatible). Second, smaller piece:
   auto-arming the sentinel needs a second `context.addInitScript` in
   `src/daemon/server.ts:main()` (outside WP7's command-table-only ownership of
   that file) — until then, `fs remount` must be called once to arm.

## Follow-ups (out of WP7 scope; suggestions only)

- `--reset` isn't in `parse.ts`'s `BOOLEAN_FLAGS`; harmless for `remount` (no
  positional, and `!!flags.reset` coerces either way), but if a future value-less
  flag on a verb-with-positionals is added, it should join that set (parse.ts is
  unowned by Wave 1).
- `routes` could add Pages Router (`pages/**`) support and per-route file paths;
  deliberately left minimal (App Router only) per acceptance scope.
- A telemetry-profile `debug` exception for observation-verb digests (WP0-review
  #21) would let `fs doctor`/`fs page` emit a digest under `profile debug`;
  belongs with the profile owner, noted here since doctor is a natural consumer.
