# WP5 report — telemetry extras

Status: built, behaviorally validated, awaiting L3 checkpoint review.
Branch: `v2-wp5`. Commits: `3628a66` → `40c8f36` (3 commits) on top of `74d47c6` (v2 @ WP2 merge).
Full suite: 69/69 green (58 baseline + 11 WP5). `tsc --noEmit` clean.

## Built

- `src/daemon/screencast.ts` (new) — CDP `Page.startScreencast` ring buffer. Off
  by default. Keeps the very latest frame always (for instant `shoot`) plus an
  fps-sampled, byte- and time-capped history (for `--at` and recording). ACKs
  every frame (Chrome halts the stream otherwise), re-arms after navigation.
  Reached from verbs via a `WeakMap<Page, controller>` so it never has to thread
  through the frozen `PipelineCtx`.
- `src/vision/sidecar.ts` (new) — `runVision(image, prompt?)` shells the image
  through the user's local `see` CLI in `--json` mode and returns the TEXT. When
  `see` is not on PATH it throws a self-describing `E_INTERNAL` naming the
  dependency, not a bare "command not found".
- `src/daemon/server.ts` — attaches the screencast at boot; `profile debug`
  starts the ring, `profile minimal` stops it; injects `shotsDir` for
  shoot/look/record; shapes the T0 emit per profile (see matrix); finalizes any
  recording on shutdown.
- `src/actions/observe.ts` — `shoot` serves from the ring when on (reports
  `source` + `captureMs`), `shoot --at -Ns` returns the nearest past frame, live
  fallback when off. New `look` and `record` verbs.
- `bin/fs.ts` — arg mapping for `shoot --at`, `look --prompt/--selector` (prompt
  also as a bare positional), `record start|stop`; `look` gets a 120s socket
  budget so a cold vision-model load does not trip the 30s default.
- `src/core/config.ts` — additive optional `screencast{ fps, ringSeconds,
  maxBytes, quality }` (documented below).
- `tests/e2e/wp5.test.ts` (new) — 11 tests driving the real CLI → daemon →
  fixture path.

## Config fields (all optional, additive)

```jsonc
"screencast": {
  "fps": 4,                  // history sampling rate; the latest frame is always kept
  "ringSeconds": 60,         // how far back `shoot --at` can reach
  "maxBytes": 26214400,      // hard ring memory cap (25 MiB); oldest frames evicted past it
  "quality": 50              // JPEG quality 1-100
}
```

Omitted fields fall back to the defaults in `screencast.ts` (`SCREENCAST_DEFAULTS`).
No `config.json` migration needed — absent block behaves exactly as the defaults.

## Telemetry profile matrix (wired)

Implemented as a post-processing layer in `server.ts` on the pipeline result, so
`pipeline/index.ts` (not owned by WP5) and the frozen contracts are untouched.
`profile` plumbing already existed; the pipeline already emits observation
digests under `debug` (WP0-review #21). What WP5 adds per profile:

| Profile | Mutating-verb digest | Screencast ring | Extra behavior |
|---|---|---|---|
| `minimal` | terse: `mutations` + `errors` only (surfaces/counts/focus/queries stripped) | forced OFF | — |
| `explore` (default) | full | unchanged | after `navigate`/`reload`, `next_steps` carries the T1 interactable count |
| `debug` | full | forced ON | observation verbs also emit a digest (pipeline #21); ring enables `shoot --at` |
| `verify` | full | unchanged | any recorded `digest.errors` (console error or remount) fails the action: `ok:false`, `E_INTERNAL` with the error list; the digest is still returned |

Observation verbs (page/shoot/state/look) never trigger the verify gate — they
carry no digest — so `verify` only fails deliberate actions that introduced an
error, which is the intent.

## shoot / look / record behavior notes

- `shoot` (no `--at`): ring frame when the ring is on AND has a frame, else a
  live full-page screenshot. `--selector` always takes a live element shot (the
  ring holds full-page frames only). Returns `{ path, source: "ring"|"live",
  captureMs }`.
- `shoot --at -3s` / `--at -3` / `--at 3`: nearest sampled frame to that age;
  returns `at` = the frame's true age in seconds. Errors `E_BAD_ARGS` with a
  hint when the ring is off or has no history yet. `--selector` is ignored with
  `--at`.
- `look [--selector css] [--prompt "..."]`: screenshots (viewport, or the
  element) to the shots dir, pipes it through `see`, returns
  `{ description, shot, model, visionMs, ... }`. The pixels never enter the tool
  result — only text. `--prompt` also accepts a bare positional.
- `record start` → `record stop`: disk-backed frame capture (frames stream to
  disk as they arrive, so a long recording does not grow memory beyond the ring).
  `stop` writes `manifest.json` (per-frame `atMs`, not constant-rate) plus a
  `recording.webm` when `ffmpeg` is on PATH. Frames + manifest are always
  produced so the artifact is useful without ffmpeg. `record start` turns the
  ring on if it was off. Double-start / stop-without-start return `E_BAD_ARGS`.

## Memory cap + actuals

Ring is capped two ways, whichever bites first: `maxBytes` (25 MiB default) and
`ringSeconds` (60s). On the e2e fixture, 8 sampled frames spanned 3.4s at ~33 KB
each (~259 KB total). Extrapolated to a full 60s / 4fps ring that is ~240 frames;
the 25 MiB cap budgets ~104 KB/frame, comfortably above the fixture's frame size
and in line with the plan's ~24 MB estimate. A content-rich real page produces
larger frames, at which point the byte cap (not the time cap) evicts first.

## Perf note (acceptance: shoot-from-ring < 50ms warm)

Measured on the fixture, ring warm:

- ring `shoot` capture: **0–1 ms** (memory read + file write) across 5 samples
- live `shoot` capture: **70 ms** (full-page screenshot)
- `shoot --at -1` returned a frame **1.2s** old (nearest to the 1s target)

`captureMs` is the in-verb capture time; the CLI end-to-end also pays the fixed
`bun` process-spawn + socket cost (~200–400 ms) that is common to every command
and unrelated to WP5.

## Deviations from the WP5 brief

1. **explore "digest carries a compact snapshot ref count" → delivered via
   `next_steps`, not the digest.** `DigestDelta` is frozen and has no field for
   a ref count; abusing `counts` (semantically app-collection deltas) would
   mislead. `next_steps` is the agent-facing "what's next" channel and fits.
   Flagging in case the coordinator prefers a contract change to add a field.
2. **Profile behaviors live in `server.ts`, not `pipeline/index.ts`.** The brief
   said "pipeline emit paths"; `pipeline/index.ts` is on my MUST-NOT-TOUCH list,
   so the shaping is a surgical post-process on the pipeline result in the server
   (the actual emit point). No pipeline or contract edits.
3. **`verify` fails on remount markers too, not just console errors.** The
   drain folds a hot-reload remount into `digest.errors`; treating the whole
   `digest.errors` list as the failure set is the literal reading of "treat
   digest.errors as action failure" and a remount mid-verify is worth failing.
4. **`record` uses ring-frame capture, not Playwright video.** Ring-stitching is
   the cheaper option (reuses the screencast, on-demand start/stop); Playwright
   `recordVideo` is whole-context and cannot be toggled per `record start/stop`.
   webm is best-effort (PATH `ffmpeg`, absent on this machine); frames+manifest
   are the always-present artifact.
5. **`record stop` leaves the ring in whatever state it was** (it does not
   auto-stop a ring that `record start` turned on). Minor; `profile minimal`
   stops it. Documented rather than silently coupling record to ring lifecycle.

## CONTRACT-CHANGE requests

None. `protocol/types.ts` and `pipeline/contracts.ts` are untouched. `shoot`/
`look`/`record` return shapes ride in the un-typed `Response.data`.

## Acceptance criteria — evidence

| Criterion (IMPLEMENTATION.md §3 WP5) | Result |
|---|---|
| shoot latency < 50ms warm | PASS — 0–1ms ring capture vs 70ms live (e2e + measurement probe) |
| `--at` returns a distinct past frame | PASS — e2e: `at` 1.2s old, bytes differ from latest |
| `look` returns structural text, no image in the tool result | PASS — e2e T4 test (serialized result < 8KB, no data:image/png signature); `see` returns `{ok,text,model,ms}` |
| profiles change T0 verbosity observably | PASS — e2e: minimal strips surfaces/counts/focus/queries; verify flips ok:false on a console error; explore adds the nav interactable count |
| `look` self-describing error when `see` absent | PASS — unit test forces PATH to drop `see` → `E_INTERNAL` naming the dependency |
| session video (`record`) | PASS — e2e: frames + manifest under shots; double-stop → E_BAD_ARGS |
| screencast memory capped | PASS — byte + time cap; actuals reported above |
| ring off under `telemetry minimal` | PASS — e2e: `profile minimal` → `screencast.on === false` |

## Test evidence

`bun test tests/e2e/wp5.test.ts` → 11 pass / 61 expect() / 13.4s (includes the
live `see` model call at ~5s). `bun test` (full) → 69 pass / 0 fail / 87s.
The `look` present-path test skips itself (`test.skipIf`) when `see` is not on
PATH so the suite stays green on a machine without the local vision kit.

## Seeds / follow-ups for the coordinator

- If a `--profile`-independent ring toggle is wanted (turn the ring on without
  entering `debug`), a small `screencast on|off|status` daemon command would do
  it; not in the WP5 acceptance list, so not built.
- L4 dogfood on the live Versable app will produce real frame sizes; worth
  confirming the 25 MiB cap holds a useful window there (fixture frames are tiny).
- `look` T1-vs-T4 disagreement as a diagnostic (plan §5) is not automated here;
  it is an agent-workflow pattern, not a verb.
