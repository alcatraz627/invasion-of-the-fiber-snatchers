# Fiber Snatcher V2 — Agent Operating Instructions

These instructions are for you, the agent. When a target project has
`.fiber-snatcher/` initialized, prefer `fs` verbs over hand-rolled
`evaluate_script` calls, Playwright MCP, or screenshots-first debugging.

## When to use

- **Always** for driving or inspecting a local React/Next.js dev app: clicking
  through flows, filling forms, reading component state, verifying UI changes.
- **Always** when you need to know what an action DID — every mutating verb
  returns a digest (`Δ mutations:… url:… queries:… surfaces:…`) telling you.
- **Never** on production builds, staging, or any remote target.

## The core loop (blind-but-fast)

```sh
fs page                      # semantic snapshot: interactables with refs (e12.k3f2)
fs click e12.k3f2            # act on a ref you just saw
# └ Δ mutations:minor  surfaces:+dialog:Preview  queries:settled   ← the digest
fs state '#some-el'          # fiber state/props/hooks when you need internals
```

Trust the digest before reaching for a screenshot. `mutations:none` after a
click = a dead click (real signal, not a guess). `shoot` exists for genuine
visual judgment; `look` (local vision model) reads pixels back as text.

## Targeting — pass what you have

| You have | Use | Behavior |
|---|---|---|
| A ref from `fs page` | `fs click e7.k3f2` | exact element; stale refs error with E_TARGET_STALE |
| Visible text | `fs click "Export"` | intent match; ambiguity returns ranked candidates in ONE trip |
| A component | `fs click 'JobRow[title~="JEGS"]'` | fiber-resolved, one candidate per mounted instance |
| CSS | `fs click --css '.toolbar button' --nth 1` | escape hatch; multi-match lists all matches |

Never guess `--nth` blind: every ambiguity error carries the candidate list
with refs, roles, labels, and component names. Pick a ref from it.

## Waiting — never sleep

- Every verb auto-waits for actionability and settles before its digest.
- `fs wait --settled` — TanStack queries idle (the real signal, not a proxy).
- `fs fill --css "section input" "text" --settled` — post-condition flag that
  also outlasts debounce windows (fires-and-returns-idle or quiet-grace).
- `fs wait --text "Loaded"` · `--gone <target>` · `--url <sub>` ·
  `--network-idle` · `--call <urlpattern>` (a request fired).
- Timeouts return the current page state so you re-plan instead of retrying.

## Verbs (run `fs help` for the generated, always-current list)

- Drive: `click hover dblclick rclick drag scroll type chord press fill select
  upload paste resize dismiss` (alias `close` — verifies the surface LEFT).
- Observe: `page state shoot look queries atoms count journal routes remount`.
- State: `dispatch` (adapter actions; TanStack + jotai are auto-discovered).
- Network: `mock unmock throttle wait-call watch`.
- Flows: `macro` (save/list/run/from-journal), `session` (goal + expects),
  `probe` (saved eval snippets). Store: `~/.claude/fiber-actions/<repo-key>/`.
- Health: `doctor` (never boots the daemon), `info`, `profile`, `stop`.

## Telemetry profiles — match output to the task

`fs profile explore|debug|verify|minimal` — explore (default: nav emits
interactable counts), debug (screencast ring on, reads emit digests), verify
(console errors or 5xx during an action FAIL it), minimal (terse digests).

## Session pattern

```sh
fs doctor                    # only if something seems off — any verb auto-starts the daemon
fs navigate /jobs            # digest confirms route + settle
fs page                      # refs
…drive with refs/intent, trusting digests…
fs journal --last 20         # what actually happened (failures included)
fs macro from-journal --last 8   # lift a repeated flow into a replayable macro
```

## Rules

- The journal records everything including failures — cite `seq` numbers when
  reporting. Fill values on password-looking fields are auto-redacted; eval
  and dispatch payloads are NOT — keep secrets out of them.
- Auth bypass: the daemon attaches the `X-Fiber-Snatcher-Key` header itself.
  Never log or echo the key; treat it like a session token.
- One daemon per project; V2 uses `control-v2.sock`. If a V1 daemon holds the
  browser profile, `fs` refuses with the remedy — run `fiber-snatcher stop`.
- `--json` on any command returns the raw Response envelope (branch on
  `error.code`, never on message text).
- Big outputs are capped at 4KB with a note; use `--json > file` + jq, or
  narrow with `--scope`/`--shallow`, rather than fighting the cap.

## What NOT to use Fiber Snatcher for

- Cross-browser testing → Playwright MCP directly.
- Performance traces (LCP, INP, heap) → Chrome DevTools MCP `performance_*`.
- Real e2e suites → the project's own test runner.

The niche is the inner dev loop: drive, observe, assert, repeat — with the
React-state access no generic browser tool has.

## V1

`bin/fiber-snatcher.ts` (the bundle-copied `expose.ts` era) still exists for
projects that haven't migrated; it is frozen. New work targets V2 only.
Architecture, plans, and per-package reports: `.claude/output/20260703-v2-plan/`.
