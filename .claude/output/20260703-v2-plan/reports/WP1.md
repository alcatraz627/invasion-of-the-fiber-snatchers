# WP1 report — digest, snapshot quality, targeting

Branch: `v2-wp1` (worktree `fs-worktrees/wp1`, from `v2` with WP7 merged).
Commits: `a63f919` (runtime + pipeline) -> `0d85022` (fixture + e2e) -> `254b473`
(discovery-cap tune).

Status: built, behaviorally validated, live-driven. `bunx tsc --noEmit` clean;
`bun test` 51 pass / 0 fail / 174 expect across 5 files. **No frozen file
touched, no CONTRACT-CHANGE requests** (all new digest fields — surfaces, focus,
counts — were already declared in the frozen `DigestDelta`; I only started
populating them).

Files changed: `src/page-runtime/index.ts`, `src/pipeline/index.ts`,
`tests/fixture-app/app.tsx`, `tests/e2e/wp1.test.ts` (new), `tests/e2e/harness.ts`,
`tests/e2e/wp7.test.ts` (one handoff assertion). `src/actions/observe.ts` (owned)
needed no change: the `page` verb already forwards budget/scope, and the snapshot
quality work lives entirely in the runtime's `snapshot()`.

## Built

### 1. T0 digest full shape (`drain()` + `settleAndDigest`)
`drain()` now returns three absolute current-state reads alongside the existing
mutation/error/route/query counters:
- **surfaces** — visible `[role=dialog|alertdialog|listbox|menu]`, keyed
  `role:label` (label = aria-label -> aria-labelledby -> inner heading -> #id).
- **focus** — the focused control's label, or null when focus rests on the body
  or an unlabeled node (weak labels report null, so focus is signal not noise).
- **counts** — named collections (tables, sizable lists) keyed `table:PartsTable`
  with a row count.

These are *absolute* reads, not accumulating deltas. `runAction` captures the
pre-action `drain()` as a baseline; `settleAndDigest` diffs the settled state
against it, so a surface that opens and closes inside one settle window nets to
nothing. `mutations`/`errors`/`queries` semantics are unchanged.

Live evidence:
```
click "Open Preview" -> Δ mutations:minor  surfaces.opened:["dialog:Preview Modal"]  focus:"Open Preview"
click "Close"        -> Δ mutations:minor  surfaces.closed:["dialog:Preview Modal"]
click #failed-toggle -> Δ mutations:major  counts:{"table:PartsTable":[50,8]}  focus:"Showing failed"
```

### 2. T1 `page` snapshot quality (`snapshot()`, `controlLabel`, collections)
- **Label ladder** for icon-only controls: aria-label -> visible text ->
  data-testid -> svg `<title>` -> title/alt -> aria-labelledby -> placeholder/name
  -> `#id` -> `<Component>` -> tag. A "weak" label (the last rungs) makes the
  snapshot attach the component name, so an icon button is never bare "button".
  (`#id` sits above `<Component>` deliberately: an id is more instance-specific,
  and it keeps WP0's icon-only smoke assertion valid.)
- **Collections summarized**: tables/lists become one `{kind,label,ref,rows,sample}`
  entry; in concise mode their row controls are collapsed out of the flat list so
  a 10k-row table stays tiny. `--scope <selector>` paginates into a collection to
  get its individual controls.
- Concise snapshot of the fixture (a 10k-row source, 50 rendered) measured
  **795 bytes** live (acceptance: < 3KB).

### 3. Intent targeting v2 (`resolveIntent`, `resolve`)
- Normalizes case + whitespace on both the query and the label.
- Matching is substring/equality, never a regex, so labels with metacharacters
  (`Add (+)`, `Next >`) match literally.
- Includes hidden matches but penalizes them (-0.5), so a sole hidden match
  surfaces as a low-confidence candidate rather than a bare not-found.
- Penalizes role mismatch (-0.4) to prefer role matches.
- **Review #23**: a single below-threshold candidate now returns
  `E_TARGET_NOT_FOUND` naming the mismatch, not `E_TARGET_AMBIGUOUS (1 plausible
  matches)`. Live: `click "parts search" --role button` ->
  `no confident target for "parts search": the closest match is a textbox, not a
  button` (candidate + `--ref` hint attached).

### 4. Review seeds
- **#11** discovery cache: one fiber walk finds both adapters (was two full
  walks); on apps with neither, retries are capped (8/document) so settle polls
  stop re-walking the tree every 150ms. `queriesPending()` no longer walks once
  the cap is hit.
- **#16** jotai without the dev API (`dev4_get_mounted_atoms`) registers degraded
  with a self-describing payload/error instead of a silent `[]`. Live `atoms` ->
  `[{degraded:"jotai store detected but its dev enumeration API ... is absent ..."}]`.
- **#21** observation verbs emit a single-drain digest under `profile debug`
  (silent otherwise), so `fs page`/`fs state` can report on-screen state on demand.

### 5. WP7 handoffs
- **Handoff 1** (`dispatch` strips `key`/`ref`): adapter results now snapshot with
  `includeInternals`, so `fs queries` keeps the TanStack query **key**. Live:
  `queries -> [{key:["parts",""], status:"success", ...}]`. The React-internal-key
  strip still applies to `state()` fiber snapshots.
- **Handoff 2** (between-action remount): the injected runtime **owns
  `window.__fsRemount`** and auto-arms a root-remount sentinel at injection —
  which resolves the "auto-arming via init script" ask *and* means WP7's `remount`
  verb reads this counter (its `if(!__fsRemount)` guard becomes a no-op, so no
  double sentinel/double count). `drain()` surfaces a cumulative `remounts` plus a
  non-destructive `remountsNew` watermark, so a remount that lands while no command
  runs survives `preDrain` and folds into the next mutating action's `digest.errors`
  ("hot-reload remount detected (#N)"). Verified live via an eval-triggered remount
  between two commands.

## Acceptance criteria (IMPLEMENTATION.md §3-WP1 + brief)

| Criterion | Result |
|---|---|
| dead click on a fresh element -> `mutations:none` | PASS — wp1 "dead click on a fresh element"; also review-regressions #3 |
| `page` of 10k-row table < 3KB concise | PASS — 795 bytes live; wp1 "concise snapshot ... under 3KB" |
| icon-only button gets a non-generic label | PASS — `refresh-action` (testid), `Notifications` (svg title); wp1 label-ladder test |
| modal open/close in digest surfaces | PASS — wp1 surfaces test + live drive |
| row-count change in digest counts | PASS — `[50,8]` live; wp1 counts test |
| degenerate intent inputs don't crash | PASS — wp1 "degenerate intent inputs return shaped errors" |
| intent by role+text (#23 wording) | PASS — wp1 #23 test + live drive |
| `tsc --noEmit` clean + `bun test` green | PASS — tsc exit 0; 51 pass / 0 fail / 174 expect / 5 files |

## Deviations from spec

1. **Label ladder puts `#id` above `<Component>`** (the spec's ladder ends at
   component name and omits id). An id is more instance-specific than the enclosing
   component and it keeps WP0's icon-only smoke assertion (`text === "button" ||
   startsWith("#icon")`) valid. Component name is still attached as a separate field
   on weak labels, so no information is lost.
2. **Fixture extended (owned)**: two icon-only nav buttons (testid + svg-title
   rungs) and a synchronous "Failed only" toggle (deterministic count delta with no
   async query). Existing hooks (`#icon-only`, `#row-count`, `#the-modal`, roles,
   `#click-count`) are unchanged.
3. **Focus is reported on every mutating action when it changes** (including onto
   the just-clicked control). It is honest and low-noise (weak-labeled targets
   report null), but the coordinator may want a "suppress focus == the click target"
   rule later; noted as a follow-up, not built (scope).

## Test evidence

```
bunx tsc --noEmit -> exit 0
bun test          -> 51 pass, 0 fail, 174 expect(), 5 files, ~48s
  tests/e2e/wp1.test.ts             14 pass  (snapshot ×3, T0 digest ×5,
                                              targeting ×3, seeds/handoffs ×2, remount ×1)
  tests/e2e/wp7.test.ts             10 pass  (+ query-key assertion)
  tests/e2e/smoke.test.ts           11 pass  (unchanged)
  tests/e2e/review-regressions.ts    9 pass  (unchanged)
  tests/protocol.test.ts             7 pass
Live journaled drive (real CLI -> daemon -> browser): concise page 795 bytes,
surfaces open/close, counts [50,8], #23 role-mismatch message, queries key kept,
jotai degraded payload — all as above.
```

## Suggested follow-ups (out of scope; not built)

- **#11 direct perf test**: the discovery cap is exercised only indirectly (the
  fixture has both adapters, so discovery succeeds first try). A dedicated
  no-adapter fixture variant would let an e2e assert the cap stops re-walking.
  Left out to avoid a second fixture; the cap logic and single-pass walk are in
  place and the existing adapter tests confirm discovery still works.
- **`fs remount` -> thin reader**: now that the runtime owns `window.__fsRemount`,
  WP7's `remount.ts` sentinel-arming block is dead (its `if(!__fsRemount)` never
  fires) and its `console.error` marker is redundant with the drain-fold. Someone
  who owns `actions/remount.ts` should trim it to a pure read/`--reset` over the
  runtime counter. Harmless as-is (no double count in the common path since the
  runtime arms first); only an explicit `fs remount` before a remount could double
  a line, deduped when text matches.
- **Soft-nav adapter remount**: `discoveryTries` resets per document, not per
  route. An app that mounts a provider only after a soft navigation (rare — usually
  root-level) could miss it once the cap is hit. Reset on route observation if that
  ever bites.
- **Focus-vs-target suppression** (deviation 3 above).
- **Surfaces/counts labels** lean on `nearestComponent`; on heavily-wrapped
  component trees (memo/forwardRef chains) the label may resolve to a wrapper name.
  Fine on the fixture; worth a look on the Versable dogfood.
