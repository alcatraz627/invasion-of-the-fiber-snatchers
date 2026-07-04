# WP3a report — pointer + keyboard event verbs

Branch: `v2-wp3a` (worktree `fs-worktrees/wp3a`, from `v2` with WP1 + WP2 + WP7 merged).
Commits: `655dbf2` (verbs + registry + CLI + fixture traps) → `5eefc44` (e2e suite).

Status: built, behaviorally validated, live-driven. `bunx tsc --noEmit` clean;
`bun test` **73 pass / 0 fail / 243 expect across 7 files** (baseline was 58/58;
+15 from the new WP3a suite, existing suites unchanged in count). **No frozen file
touched, no CONTRACT-CHANGE requests** — every verb rides the existing pipeline
stages, and its surface/count/focus digest fields were already declared in the
frozen `DigestDelta`; I only produce actions that populate them.

Files changed: `src/actions/pointer.ts` (owned), `src/actions/keyboard.ts` (owned),
`src/actions/scroll.ts` (new, owned), `src/actions/registry.ts` (one import + one
spread), `bin/fs.ts` (arg-mapping cases for my verbs + SETTLE_VERBS list),
`tests/fixture-app/app.tsx` (append-only traps), `tests/e2e/wp3a.test.ts` (new).

## Built

Every verb is `run`-only (the pointer/keyboard/scroll act); resolution, actionability
wait, settle, digest, and journaling are the pipeline's job. So a hover's opened
popover, an rclick's context menu, and a scroll's materialized rows all surface in
the digest with zero per-verb telemetry code.

### 1. `hover` — with popover persistence
Hovers a target; a well-built popover it opens must STAY open while the pointer
rests, and `--hold <ms>` (capped 10s) keeps it resting. The persistence signal is
twofold: (a) the pipeline's settle diff reports `digest.surfaces.opened` only for a
surface that opened AND survived the settle window — a flash-then-close nets to
nothing; (b) after the hold, the verb does a **non-destructive** `snapshot` read
(no drain, so the settle baseline is untouched) and returns `{persisted, popover,
surfaces}` so a caller can assert without waiting on the digest.

Live: `hover "Hover me" --hold 200` → `data.persisted:true popover:"dialog:Hover Card"`,
`digest.surfaces.opened:["dialog:Hover Card"]`.

### 2. `dblclick`, `rclick`, `chord`
- `dblclick <target>` (alias `doubleclick`) → `locator.dblclick()`. Live: icon-only
  counter `+2` per double-click.
- `rclick <target>` (alias `rightclick`) → right-button click; the context menu it
  opens is a `role=menu` surface. Live: `digest.surfaces.opened:["menu:Context Menu"]`.
- `chord <keys> [target]` → a modifier combination in Playwright's key syntax
  (`"Meta+K"`, `"Control+Shift+P"`), page-scoped or target-scoped. Live:
  `chord "Control+K"` opens the command palette → `surfaces.opened:["dialog:Command Palette"]`.

### 3. `drag <source> <dest>` — HTML5 DnD + mouse fallback
- **Default (`html5`)**: `source.dragTo(dest)` — Playwright's drag drives native
  HTML5 drag events (dragstart/dragover/drop) and auto-scrolls the source into view.
  Ships for `draggable` + onDrop handlers. Live: reorders the fixture's HTML5 list
  `Alpha,Bravo,Charlie,Delta` → `Bravo,Charlie,Delta,Alpha`.
- **`--via mouse`**: explicit `hover(source) → mouse.down → nudge move → move(dest) →
  mouse.up`. This drives the raw mousedown/mousemove/mouseup that pointer-sensor
  libraries (dnd-kit `PointerSensor`, react-dnd mouse backend) track — not native
  DnD. Live: reorders the fixture's pointer-sensor list `One,Two,Three,Four` →
  `Two,Three,One,Four` (verified `mousedown:pdnd-one … mouseup:pdnd-three`).
- **Which to use**: `dragTo` for native `draggable` elements; `--via mouse` for
  libraries that never set `draggable` and instead listen to mouse events. Each is
  tested against its matching handler style in the fixture.

### 4. `type <target> <text> --delay <ms>` — per-key input
`locator.pressSequentially(text, {delay})` (`.type()` is deprecated), so every key
dispatches a real keydown/input and an app's debounce sees each keystroke — the
behavioral contrast to `fill`'s single value set. `--delay` capped 1s/key. Rides
the `--settled` post-condition (added to SETTLE_VERBS), so `type … --settled` returns
only after the debounced query fires. Live: `type --css "section input" "Part 5"
--delay 5 --settled` → value `"Part 5"`, `#row-count` filtered, `digest.queries:settled`.

### 5. `scroll` (new `scroll.ts`) — window / element / into-view + virtualized awareness
- `--to top|bottom|<y>` — scroll a target container (or the window) to a position.
- `<target> --by <px>` — scroll a container (or window) by a pixel delta.
- `--into-view <target>` — `scrollIntoView` a target.
Virtualized-list awareness is free: the windowed fixture list is a named collection,
so the pipeline's settle diff reports the row-count growth in `digest.counts` after a
scroll materializes rows. Live: `scroll "#scroll-box" --to bottom` →
`digest.counts:{"list:Windowed Rows":[20,40]}`, DOM li count 20→40.

### 6. Fixture traps (append-only, all existing ids/hooks stable)
Hover popover (`role=dialog "Hover Card"`, opens on wrapper mouse-enter, card renders
below the trigger so resting doesn't close it); context-menu zone (`role=menu`);
4-item HTML5 DnD reorder list; 4-item pointer-sensor reorder list; windowed
append-on-scroll list (`<ul aria-label="Windowed Rows">`, +20 rows per bottom-scroll);
Cmd/Ctrl+K command palette (`role=dialog`, Escape closes). No second `<table>` (the
`--scope table` test stays unambiguous); the 4-item lists sit under the 8-item list
threshold so they don't clutter `counts`. Concise snapshot of the 10k-row fixture
measured **915 bytes** live (was 795; acceptance < 3KB).

## Acceptance criteria (brief + IMPLEMENTATION.md §3-WP3)

| Criterion | Result |
|---|---|
| hover opens + holds a popover, in the digest | PASS — wp3a "hover opens a popover that persists"; `surfaces.opened` + `persisted:true` |
| dblclick / rclick act; context menu in digest | PASS — wp3a dblclick (+2), rclick (`surfaces.opened:["menu:Context Menu"]`) |
| chord fires a key combination | PASS — wp3a "chord opens the command palette (Ctrl+K)" |
| drag reorders a list (HTML5 + mouse) | PASS — wp3a html5 path + `--via mouse` path, each on its matching list |
| scroll loads virtualized rows, surfaced | PASS — wp3a "scrolling a windowed list materializes rows" (`counts` delta) |
| type per-key drives the debounce | PASS — wp3a "type enters text per key … (--settled)" |
| every verb: happy + failure + digest | PASS — 15 tests; each verb has a shaped-error case (E_TARGET_NOT_FOUND / E_BAD_ARGS) |
| no sleeps/polls (use `wait --settled`) | PASS — the suite has no `setTimeout`; reset is `reload` + `wait --settled` |
| `tsc --noEmit` clean + `bun test` green | PASS — tsc exit 0; 73 pass / 0 fail / 243 expect / 7 files |

## Deviations from spec

1. **drag mouse fallback is `--via mouse` (value flag), not a boolean `--mouse`.**
   A boolean flag would need registering in `cli/parse.ts` `BOOLEAN_FLAGS` (else it
   swallows the next positional), and `parse.ts` is not in my ownership list. A value
   flag needs no parser change. Same reasoning kept every other new flag
   (`--hold`/`--delay`/`--to`/`--by`/`--into-view`) value-shaped.
2. **drag infers each target from its own positional, flags NOT applied to target
   inference.** One `--css`/`--ref` can't disambiguate two elements, so
   `fs drag "<source>" "<dest>"` reads positionals only (refs / CSS / intent per
   positional: `fs drag "#a" "#b"` or `fs drag e12 e15`). Documented in the summary.
3. **Two reorder lists in the fixture (HTML5 + pointer-sensor)**, so each drag mode is
   tested against the handler style it actually drives. During development, `--via
   mouse` on a native `draggable` list did NOT reorder (raw mouse events don't reliably
   initiate native HTML5 DnD in headless Chromium); pairing each mode with its matching
   list is the honest test. This is an additive fixture trap, not a scope expansion.
4. **Added a Cmd/Ctrl+K command palette trap** so `chord` has a clean, realistic page
   effect to assert (a surface open) rather than a no-op key press.
5. **hover reads surfaces inside `run` (non-destructively) to return `persisted`.** The
   pipeline's settle diff is the authoritative persistence signal; the in-verb read is a
   convenience so callers don't depend on digest timing. It uses `snapshot` (which never
   drains), so the settle baseline is untouched.

## CONTRACT-CHANGE requests

None. Everything landed within the frozen `ActionDef` / `DigestDelta` shapes and the
closed `ErrorCode` enum (E_TARGET_NOT_FOUND / E_TARGET_STALE / E_BAD_ARGS /
E_NOT_ACTIONABLE all pre-existed).

## Test evidence

```
bunx tsc --noEmit → exit 0
bun test          → 73 pass, 0 fail, 243 expect(), 7 files, ~104s
  tests/e2e/wp3a.test.ts            15 pass  (pointer ×7, keyboard ×4, scroll ×4)
  tests/e2e/wp1.test.ts             14 pass  (unchanged — fixture additions don't
                                              perturb its surfaces/counts baselines)
  tests/e2e/wp2.test.ts              7 pass  (unchanged)
  tests/e2e/wp7.test.ts             10 pass  (unchanged)
  tests/e2e/smoke.test.ts           11 pass  (unchanged)
  tests/e2e/review-regressions.ts    9 pass  (unchanged)
  tests/protocol.test.ts             7 pass  (unchanged)
Live journaled drive (real CLI → daemon → browser): hover persistence, rclick menu
surface, both drag paths reordering, chord palette, per-key type debounce, scroll
counts delta [20,40]; concise page 915 bytes; all 7 verbs in `fs help` + `fs actions`.
```

## Handoffs / notes for the coordinator

- **`chord` overlaps `press` by design.** `press` already accepts `"Meta+K"` (Playwright
  syntax), so `chord` is functionally a press that *names the intent* (a shortcut combo)
  and is target-optional. No conflict; kept both. If the registry should expose only one,
  `chord` can become an alias of `press` — but the distinct summary is more agent-legible.
- **No runtime capability needed.** Every verb used existing pipeline seams and Playwright
  locator methods; nothing added to `page-runtime/` (untouched).

## Suggested follow-ups (out of scope; not built)

- **drag `--via mouse` long-distance auto-scroll.** The mouse path hovers the source into
  view but does not incrementally scroll toward a dest that is off-screen after that; the
  fixture's dests are adjacent so it doesn't bite. `dragTo` (HTML5) auto-scrolls both. A
  long pointer-sensor drag across a scroll boundary would need step-scrolling — add if a
  real app needs it.
- **`type` request-timeout for very long text.** `--delay` × length is capped well under
  the 30s socket budget for normal use, and `type … --settled` extends the timeout via the
  SETTLE_VERBS path. A pathological `type "<huge>" --delay 1000` without `--settled` could
  exceed 30s; fold a `type` estimate into `bin/fs.ts`'s `blocks` calc if that ever matters.
- **`hover` focus-vs-target suppression** inherits WP1's open follow-up (a hover may report
  `digest.focus` onto the hovered control); no new work here.
- **scroll `--to` on the document vs a specific overflow container.** With no target it
  scrolls `document.scrollingElement`/window; a page whose scroll lives on an inner element
  needs that element passed as the target. Documented in the verb summary.
