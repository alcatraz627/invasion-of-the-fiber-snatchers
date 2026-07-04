# WP3b report — forms + misc verbs (select, upload, paste, resize, verified close)

Branch: `v2-wp3b` (worktree `fs-worktrees/wp3b`, from `v2` after WP2 merged).
Commits: `4dd7515` (verbs + registry + CLI) → `452dfae` (fixture traps) → `8629ada`
(e2e suite + test-driven fixes).

Status: built, behaviorally validated, live-driven. `bunx tsc --noEmit` clean;
`bun test` **74 pass / 0 fail / 251 expect across 7 files** (baseline 58/58; +16
from the new WP3b suite, existing suites unchanged in count). **No frozen file
touched** (`protocol/types.ts`, `pipeline/contracts.ts`), **no CONTRACT-CHANGE
requests** — every verb rode existing `ActionDef`/`DigestDelta`/`ErrorCode`
shapes.

Files changed: `src/actions/forms.ts` (extended), `src/actions/misc.ts` (new),
`src/actions/registry.ts` (one import + one spread), `bin/fs.ts` (five verb
cases, append-only), `tests/fixture-app/app.tsx` (append-only traps),
`tests/e2e/wp3b.test.ts` (new). Zero edits to `page-runtime/`, `pipeline/`,
`daemon/`, `parse.ts`, or WP3a's `pointer.ts`/`keyboard.ts`.

## Built

### 1. `select <target> <option>` (forms.ts)
Drives a native `<select>` via Playwright `selectOption`, inferring label vs value
vs index: `--by value|label|index`, the `[N]` shorthand for index, else match value
then exact label then a label substring (so `"Beta"` hits `"Beta (β)"`). Rather than
eat Playwright's 5s actionability wait on a miss, it reads the select's real options
first and returns a **fast shaped `E_BAD_ARGS` listing what IS selectable**, and a
distinct `E_BAD_ARGS` when the target isn't a `<select>` at all.

### 2. `upload <target> <file-path...>` (forms.ts)
`setInputFiles` on a file input — the target itself, or a hidden
`input[type=file]` inside a styled drop-zone (the common React pattern). File
paths are existence-checked before touching the page (clean `file not found`
error). A drop-zone with **no** file input returns a shaped handoff: real
DataTransfer drops need WP3a's `drop` (see Handoffs).

### 3. `paste <target> <text>` (forms.ts)
Clipboard-realistic: grant clipboard permissions on the context, `writeText` the
clipboard, then a real keyboard paste (`Meta+V`/`Control+V`). The browser fires a
genuine `paste` event and inserts the text — the difference from `fill`, which sets
`.value` directly and never triggers `onPaste`. **Verified live in headless: the
keyboard path works (`via:"keyboard"`), no fallback needed.** A synthetic
`ClipboardEvent` fallback exists for environments where the clipboard write is
rejected (no OS-level document focus); it still fires `onPaste`, preserving the
behavior that distinguishes paste from fill.

### 4. `resize <width> <height>` (misc.ts)
`setViewportSize`; because it is a mutating verb the pipeline's settle+digest runs
and the digest reports **layout-driven count/surface deltas**. Live: `resize 700
600` → `counts:{"list:Responsive Widgets":[10,0]}`, `resize 1280 800` → `[0,10]`.

### 5. Verified close — `close [target]` (misc.ts) — the export-saga fix
Presses Escape (or clicks a named close control), then **asserts the top surface
actually left** by polling the runtime snapshot's `surfaces` (same `role:label`
keys the digest reports in `surfaces.closed`) — non-destructively, so the
pipeline's own digest is untouched. If the surface persists it **retries once with
Escape** (the swallowed-first-Escape case), and if it still persists throws a
shaped `E_INTERNAL` naming the stuck surface. Live evidence:
```
close (Escape)          -> closed:"dialog:Escape Modal"  Δ surfaces.closed:["dialog:Escape Modal"]
close (1st Escape swallowed) -> closed:"dialog:Stuck Modal"  (retry closed it)
close (Preview never yields) -> ✗ E_INTERNAL: close did not dismiss "dialog:Preview Modal" ...
close (nothing open)    -> ok, closed:null, note:"no open surface to close"
```

### 6. Fixture traps (append-only)
Native `<select id="fs-select">`; multi `<input type="file" id="fs-file">`; a
paste target (`#fs-paste`) whose `#paste-count` ticks only on a real `paste`
event; a width-responsive widget list that collapses under 800px (the resize
count-delta source); an Escape-closes modal; and a stuck modal whose **first
Escape is swallowed, second closes** (the deterministic retry case). All existing
ids/hooks unchanged.

## Deviations from the brief

1. **The verb is registered as `dismiss` with `close` as an alias** (not `close` as
   primary). The daemon reserves the `close` **wire** command for its own shutdown
   (`stop` maps to `close` in `bin/fs.ts`, and `server.ts` has a `case "close"`
   that shuts the daemon down). A verb literally named `close` was swallowed by the
   shutdown path before reaching the pipeline. The CLI normalizes the `close` alias
   to `dismiss` **before** the wire dispatch, so **`fs close` works exactly as
   specified** and never triggers shutdown. This touches no frozen contract and no
   daemon file. See Handoffs for a cleaner option if the coordinator prefers `close`
   as primary.
2. **`--verify` on `press Escape` for parity was NOT built here.** `press` lives in
   WP3a's `keyboard.ts` (must-not-touch). The verified-close logic ships fully as
   the `dismiss`/`close` verb; wiring `press Escape --verify` to delegate to it is a
   one-line handoff to WP3a / the coordinator (see Handoffs).
3. **Fixture paste target `preventDefault()`s its `onPaste`** so the pasted text
   lands exactly once — a controlled React input would otherwise double-insert
   (handler + browser default). Fixture-only; the verb is unchanged.
4. **The WP3b fixture block is a `<div>`, not a `<section>`.** Existing WP0/WP1/WP2
   tests target the parts search via the `section input` CSS selector; a second
   `<section>` made that ambiguous. Caught by the full-suite regression sweep and
   fixed before merge.

## Acceptance criteria (IMPLEMENTATION.md §3-WP3 half b + brief)

| Criterion | Result |
|---|---|
| `select` label/value/index inference | PASS — wp3b select ×2 tests + live (label→failed, value→done, index 2→done) |
| `select` miss → fast shaped error listing options | PASS — wp3b "unknown option fails fast"; non-select → shaped error |
| `upload` sets files on a file input | PASS — wp3b single + multiple; live (`report.csv`) |
| `upload` drop-zone → WP3a drag handoff | PASS — wp3b "no file input hands off"; error hint names `drop` |
| `paste` clipboard-realistic, fires onPaste unlike fill | PASS — wp3b "real paste fires onPaste"; live `via:"keyboard"` |
| `resize` digest reflects layout-driven count change | PASS — wp3b resize; live `[10,0]`/`[0,10]` |
| verified close asserts surface left (digest surfaces.closed) | PASS — wp3b Escape + click-control; live |
| verified close fails loudly on a stuck modal | PASS — wp3b "never yields → E_INTERNAL" naming the surface |
| swallowed-first-Escape retried | PASS — wp3b stuck-modal test + live |
| `tsc --noEmit` clean + full `bun test` green | PASS — tsc exit 0; 74 pass / 0 fail / 251 expect / 7 files |

## CONTRACT-CHANGE requests

None. All five verbs use the existing frozen `ActionDef` shape, the existing
`DigestDelta` fields (`surfaces`, `counts`, `mutations`, `queries`), and the closed
`ErrorCode` enum (`E_BAD_ARGS`, `E_INTERNAL`).

## Coordination handoffs (for the coordinator / other builders)

1. **WP3a — `press Escape --verify` parity.** To give `press` the verified-close
   assertion, route it to the `dismiss` verb (or share a small `assertSurfaceGone`
   helper). One-line change in WP3a's press arg-mapping: when `flags.verify` and the
   key is Escape, dispatch `dismiss` instead. Kept out of this WP to avoid touching
   `keyboard.ts`.
2. **WP3a — `upload` drop-zone.** `upload` hands off styled drop-zones (no file
   input) to a real DataTransfer `drop`. If WP3a's `drop` lands a `drop <file>` form,
   `upload`'s error hint already points there; no code coupling required.
3. **Optional: free `close` as a primary verb name.** If the coordinator prefers
   `close` as the primary (not an alias), rename the daemon's shutdown wire command
   from `close` to `shutdown` in `daemon/server.ts` + `bin/fs.ts`'s `wireCmd` map
   (WP0/coordinator territory). Not required — the alias+normalize approach ships a
   fully working `fs close` today.

## Test evidence

```
bunx tsc --noEmit -> exit 0
bun test          -> 74 pass, 0 fail, 251 expect(), 7 files, ~91s
  tests/e2e/wp3b.test.ts            16 pass  (select ×4, upload ×4, paste ×1,
                                              resize ×2, verified close ×5)
  tests/e2e/wp2.test.ts             7 pass   (unchanged)
  tests/e2e/wp1.test.ts            14 pass   (unchanged)
  tests/e2e/wp7.test.ts           10 pass   (unchanged)
  tests/e2e/smoke.test.ts         11 pass   (unchanged)
  tests/e2e/review-regressions.test.ts 9 pass (unchanged)
  tests/protocol.test.ts           7 pass   (unchanged)
Live journaled drive (real CLI -> daemon -> browser): select by label/value/index,
upload, paste via:"keyboard", resize count deltas [10,0]/[0,10], verified close
(Escape / click-control / swallowed-retry / stuck→E_INTERNAL / nothing-open) — all
as above; journal records the verb under its primary name `dismiss`.
```

## Suggested follow-ups (out of scope; not built)

- **`select` for custom (non-native) dropdowns.** The verb is native-`<select>`
  only by design; a listbox/combobox built from divs is `click` (open) + `click`
  (option). A future `pick` verb could unify them, but that needs the WP1 surface
  model for the popover.
- **`paste` rich content.** Only `text/plain` is written to the clipboard; an app
  that reads `text/html` from a paste won't see it. Add a `--html`/mime mode if a
  real app needs it.
- **`upload` remote/data-URL sources.** `setInputFiles` takes local paths; a future
  mode could accept an in-memory buffer for generated fixtures.
- **Verified close of non-ARIA surfaces.** `close` tracks `[role=dialog|alertdialog|
  listbox|menu]`; a modal with no ARIA role isn't a tracked surface, so the
  assertion can't see it. On the Versable dogfood, confirm the real modals carry a
  dialog role (they should) before relying on `surfaces.closed`.
