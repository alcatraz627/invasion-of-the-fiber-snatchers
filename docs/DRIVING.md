# Driving Fiber Snatcher V2

How I drive V2 day to day, and how the agents working in my repos should drive it.
One page, example-first. Every command here is real; when in doubt, `fs help`
prints the current verb list (it is generated from the registry, so it cannot
drift).

The niche: the inner dev loop against a local React/Next dev app. Act by ref,
read a one-line digest of what changed, never sleep, and read React state no
generic browser tool can reach. Not for production, staging, cross-browser runs,
or perf traces.

## Set up on a new project

There is no `fs init`. The `fs` CLI reads `.fiber-snatcher/config.json`; the V1
`fiber-snatcher` CLI is what writes it.

```sh
cd ~/Code/Versable/enhancement-product/frontend
fiber-snatcher init          # writes .fiber-snatcher/config.json (dev port read from package.json)
fs doctor                    # config, dev server, daemon, runtime match, adapters
```

`init` copies runtime files and prints a step about wiring `expose.ts` into
`layout.tsx`. Ignore that step in V2. The page runtime is injected over CDP at
daemon boot, so there is no app-side import to add and no `init --force` reload
skew. `init` matters only for the config file and the auth key.

The daemon auto-starts on the first `fs` verb (cold start ~430 ms including the
browser boot; warm verbs ~120 ms). You do not run `start` or `status`.

## The core loop

```sh
fs page                      # semantic snapshot: interactables with refs
fs click e10.8rp0            # act on a ref you just saw
# └ Δ mutations:minor  queries:settled          ← the digest
fs state 'PreviewJobOutputModal'    # fiber state/props/hooks when you need internals
```

`fs page` mints a ref per interactable (`e10.8rp0` = `e<seq>.<docTag>`); action
verbs take that ref. A stale ref (after a remount or navigation) fails with
`E_TARGET_STALE` and the fresh candidate list, never a silent miss.

Trust the digest before reaching for a screenshot. `mutations:none` after a click
is a dead click, a real signal. Read the digest fields this way:

| Field | Means |
|---|---|
| `mutations:none` | nothing changed; the act did nothing observable |
| `mutations:minor` | a small DOM change (< 20 mutations) |
| `mutations:major` | a large change (>= 20 mutations, or a URL change) |
| `queries:settled` | TanStack queries went idle before the digest |
| `url:/jobs/abc` | the route changed to this |
| `errors:2!` | two console errors or 5xx fired during the act (listed below the line) |

The one-line text digest carries `mutations / url / queries / errors` only. The
`surfaces` opened/closed, the focused element, and collection-count deltas are in
the `--json` digest, not the text one. When you need to know *which* dialog opened
or that a table went 50 rows to 8, add `--json`:

```sh
fs click "Failed only" --json
#   "digest": { "mutations": "major", "focus": "Showing failed",
#               "counts": { "table:PartsTable": [50, 8] } }
```

## Ten verbs I use most

Examples use the enhancement-product shape: the jobs list at `/jobs`, the preview
modal, the parts search. Refs (`e10.8rp0`) come from your own `fs page`.

```sh
fs navigate /jobs                       # goto + wait for load + settle
fs page                                 # refs for everything interactable
fs click 'JobRow[title~="JEGS"]'        # component expression, fiber-resolved
fs click "Open Preview"                 # intent text; ambiguity returns candidates
fs fill "parts search" "brake" --settled  # fill + outlast the debounce, return idle
fs wait --settled                       # TanStack idle (the real signal, not a sleep)
fs state 'PreviewJobOutputModal'        # props/hooks/state of the nearest fiber
fs queries parts                        # TanStack cache entries whose key matches "parts"
fs dismiss                              # Escape the top surface AND verify it left
fs journal --last 20                    # what happened, failures included
```

Two that earn their place less often but save the session when they do:

```sh
fs shoot                                # screenshot for genuine visual judgment
fs look "is the export button disabled?"  # local vision model reads pixels back as TEXT
```

## Targeting: pass what you have

| You have | Use | Behavior |
|---|---|---|
| A ref from `fs page` | `fs click e7.k3f2` | exact element; stale refs error with the fresh list |
| Visible text | `fs click "Export"` | role+text intent; ambiguity returns ranked candidates in one trip |
| A component | `fs click 'JobRow[title~="JEGS"]'` | fiber-resolved, one candidate per mounted instance |
| CSS | `fs click --css '.toolbar button' --nth 1` | escape hatch; multi-match lists all matches |

Never guess `--nth` blind. Every ambiguity error prints the candidates with refs,
roles, labels, component names, and confidence:

```
✗ E_TARGET_AMBIGUOUS: ambiguous target (2 plausible matches)
candidates:
  e25.8rp0  [button] Export  <Modal>  100%
  e26.8rp0  [button] Export  <Modal>  100%
→ act on a specific one: fs click --ref e25.8rp0
```

## Waiting: never sleep

Every verb auto-waits for actionability and settles before its digest, so most of
the time you wait for nothing. When you do wait, name the condition:

```sh
fs wait --settled                 # TanStack queries idle
fs wait --text "Export ready"     # some visible text appears
fs wait --gone "#the-modal"       # a surface leaves the DOM
fs wait --url /jobs/              # the route matches (substring or /regex/)
fs wait --network-idle            # no in-flight requests
fs wait --call "**/api/jobs"      # a request matching the pattern fired (--done for its response)
```

`fs sleep 500` still exists but is journaled as a smell; a fixed delay races the
app. Reach for a `wait` condition instead. Timeouts return the current page state
so you re-plan instead of retrying blind.

## Telemetry profiles: match output to the task

`fs profile <name>` sets the session-wide output/capture behavior.

| Profile | Use it when | What changes |
|---|---|---|
| `explore` (default) | driving and reading, normal work | nav emits interactable counts; standard digests |
| `debug` | chasing a flicker or a timing bug | screencast ring turns on; reads also emit digests; `shoot --at -3s` works |
| `verify` | running a flow you want to trust | a console error or a 5xx during an act FAILS that act |
| `minimal` | scripted bulk driving, low noise | terse digests; screencast ring force-stopped |

Switch to `debug` before a visual investigation so the ring buffer has frames to
recover, then `shoot --at -3s` answers "did it flicker three seconds ago" from
memory (1 ms from the ring versus 63 ms for a live shot). Switch to `verify`
before replaying a macro you care about, so a silent 500 becomes a failed step.

## Macros: record a flow once, replay it parameterized

The journal records every action, so the cheapest way to author a flow is to drive
it once and lift it:

```sh
fs navigate /jobs
fs click 'JobRow[title~="JEGS"]'
fs wait --text "Preview"
fs macro from-journal --last 3 --name open-job    # drafts YAML from the last 3 actions
```

`from-journal` writes a draft with a `from:` provenance line per step and a note to
swap literals for `%vars%`. Edit it into a parameterized, asserting flow. The
store lives at `~/.claude/fiber-actions/<repo-key>/macros/`, keyed by repo identity
so worktrees share it.

```yaml
name: open-job
description: open a job's preview and confirm the modal
tags: [feature]                 # one of: domain | feature | utility | data-read
params:
  - name: job
    required: true
steps:
  - verb: click
    target: 'JobRow[title~="%job%"]'
  - verb: click
    target: Open Preview
    expect:                     # inline assertion, runs right after the step
      text: Preview Modal
```

```sh
fs macro list                          # names + descriptions + step counts
fs macro run open-job --param job=JEGS  # replay through the real pipeline, digest per step
```

Assertions attach as an `expect:` field on a step (`text` / `count` / `state` /
`settled`). A standalone `verb: expect` step with a bare `text:` will save but fail
at run time; use the inline `expect:` field.

## Sessions: a run that doubles as a regression check

```sh
fs session start "export a filtered jobs view"
fs navigate /jobs
fs fill "parts search" "brake" --settled
fs expect count 'table tbody tr' 8
fs click "Export"
fs expect text "Export ready"
fs session end                         # writes a pass/fail record; a failure dumps the journal slice + frames
```

A session groups the actions under a goal, holds the `expect` results, and on
`session end` writes a summary to `~/.claude/fiber-actions/<repo-key>/sessions/`.
A passing session's record stays small; a failing one is self-contained for
re-planning. An open session also grants probe consent, so `fs probe run <name>`
works without `--allow` while the session is up.

## Reading a digest and the journal when reporting

Cite `seq` numbers from the journal when you report what happened; it records
failures too.

```sh
fs journal --last 20            # recent actions with cmd, args, ok, durMs
fs journal --run <run-id>       # a specific run
```

Fill values on password-looking fields are auto-redacted in the journal. Eval and
dispatch payloads are not redacted, so keep secrets out of them.

## Troubleshooting

```sh
fs doctor        # never boots the daemon; safe to run when something seems off
```

`doctor` checks config, the dev server, the daemon, runtime-version match, and
discovered adapters, and skips page-dependent probes when the daemon is down or the
tab is on an error page (so you get one clear next step, not a cascade of red
herrings).

| Symptom | Cause | Fix |
|---|---|---|
| `E_NOT_INITIALIZED` | no `.fiber-snatcher/config.json` | `fiber-snatcher init` in the project |
| Reads return errors on `chrome-error://` | a dev-server restart parked the tab there | `fs reload` (navigates back to devUrl and re-injects the runtime) |
| `atoms` returns a `degraded` note | the store's dev enumeration API is absent (production build) | run against a dev build; `dev4_get_mounted_atoms` only exists in dev |
| Profile-lock / a V1 daemon holds the browser | a live V1 `fiber-snatcher` daemon shares the profile | `fiber-snatcher stop`, then re-run the `fs` verb |
| `dismiss` reports the surface is still up | the modal traps Escape (bare `dismiss` presses Escape) | name the close control: `fs dismiss "Close"` |
| Refs from an earlier `fs page` all fail | a Fast Refresh / HMR remount invalidated them | `fs page` again for fresh refs; `fs remount` shows the counter |

V2 uses its own `control-v2.sock` and `daemon-v2.pid`, so it coexists with a V1
daemon except for the shared browser profile. If both want the profile at once, V2
refuses with the remedy above rather than fighting for it.

## What not to use it for

Cross-browser testing goes to Playwright MCP; performance traces (LCP, INP, heap)
go to Chrome DevTools MCP `performance_*`; real end-to-end suites go to the
project's own runner. Fiber Snatcher is the inner loop: drive, observe, assert,
repeat, with the React-state access no generic browser tool has.
