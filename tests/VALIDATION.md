# V2 validation ladder

Every change is validated at the lowest level that gives real confidence in
BEHAVIOR, not just compilation. Levels stack; higher levels run less often.

## L1 — per module (runs with every commit touching src/)

`bun test` behavioral units. Rules: test through the real mechanism (real unix
sockets in tmp dirs, real file writes, real browser only where the module IS
browser glue), no mocking the thing under test, assert observable behavior not
internals. tsc/lint is a floor, never the validation.

## L2 — per verb/feature (before the module's work is called done)

e2e against `tests/fixture-app` in a real Chromium: drive the actual command
path (CLI → socket → daemon → page) and assert on page effects + digest
content. Each verb ships with at least: happy path, ambiguity path, timeout
or failure path.

## L3 — checkpoint review (each WP merge; coordinator)

- Full `bun test` suite green.
- Live fixture drive of the WP's acceptance list, journaled.
- Diff review against the WP spec: contract drift, output-budget discipline,
  error-shape compliance (every failure returns an ErrorCode + hint or
  candidates), comment register.

## L4 — phase sweep (after each wave; summary posted to user)

- Everything in L3 across ALL merged WPs (regression sweep).
- The canonical dogfood: drive the Versable PR-217 modal flow (open modal →
  filter → popover → filtered-export dry-run) live; journal is the evidence.
- Perf floor: warm command round-trip < 100ms for non-browser ops; `page`
  snapshot < 3KB concise on the fixture's 10k-row table.
- Summary to user: what shipped, checks run + results, deviations, next wave.
