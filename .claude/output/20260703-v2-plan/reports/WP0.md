# WP0 report — core substrate

Status: built, behaviorally validated, awaiting L3 checkpoint review.
Commits: 21cbaa1 → fad6f2d on `v2` (7 commits).

## Built

- `src/protocol/` — ndjson frames with request-id mux + server-push; closed
  ErrorCode enum; Response envelope with digest + next_steps + gen.
- `src/pipeline/` — contracts (frozen), six-stage runAction, journal
  (runs/<ts>.jsonl, failures included).
- `src/page-runtime/` — CDP-injected via Bun.build at daemon boot; fiber
  walker, ref minting, intent/component resolution, observation buffer
  (mutations/errors/routes/queriesPending), zero-config adapter discovery
  (tanstack via QueryClientProvider props, jotai via Provider store),
  V1 `__snatcher__.register` compat shim.
- `src/daemon/` — auto-start lifecycle (ping-poll handshake, no blind sleep),
  frame server, generation tracking, env handshake isolated in env.ts.
- `src/actions/` — registry + navigate/reload/click/fill/press/page/shoot/
  state/eval. New verb = one ActionDef.
- `bin/fs.ts`, `src/cli/` — one parser, shape-inferred targets, budgeted
  printer with candidates + digest line.
- `tests/` — VALIDATION.md ladder; 7 protocol behavioral tests (real
  sockets); fixture app (React+TanStack+jotai, V1 trap inventory); 11-test
  e2e acceptance suite driving the real CLI→daemon→browser path. 18/18.

## Acceptance criteria — evidence

| Criterion | Result |
|---|---|
| Cold start, one command | PASS — e2e test 1; live app 1.6s |
| V1 verb parity through new path | PASS — e2e + live Versable smoke |
| Every action journaled (incl. failures) | PASS — e2e test 11 |
| Ambiguity → ranked candidates, one round trip | PASS — e2e tests 5/8; live dup-search trap |
| Stale ref → explicit staleness | PASS — e2e test 10 |
| Adapter discovery zero-config | PASS — e2e test 3; live app (jotai+queries) |
| Runtime version match in doctor | PARTIAL — `info` exposes both versions; V2 `doctor` deferred to WP7 |
| No expose.ts bundle-copy in new path | PASS — V1 files untouched, unused by V2 |

## Deviations from IMPLEMENTATION.md

1. Fixture is a Bun-served single-page React app, not Next.js — determinism
   for e2e; Next-specific coverage (HMR, soft-nav) stays on the live-app L4
   dogfood. Revisit only if a Next-specific regression escapes.
2. V2 `doctor` deferred to WP7 (V1 doctor still works; `info` carries the
   version handshake).
3. `headless` added as a config field for test harnesses (not in the plan).

## Bugs found by the behavioral gates (would have shipped otherwise)

- Bare capitalized words inferred as component exprs → intent (live smoke).
- Fixture served as classic script → import.meta SyntaxError (e2e).
- Strict-mode index-access holes ×7 (tsc).
- Settle-vs-debounce semantics documented: digest can honestly read
  "settled" inside a debounce window → WP2 `wait settled` requirement.

## Seeds for Wave 1

- WP1: icon-only buttons label as "button" — fall back to data-testid,
  aria-describedby, svg title, or nearest component name; concise snapshot
  should carry component names when text is a tag fallback.
- WP2: explicit wait vocabulary (the debounce case above); settle budget
  tuning per verb.
- WP7: `doctor` port; `routes` command; help-text pass.
