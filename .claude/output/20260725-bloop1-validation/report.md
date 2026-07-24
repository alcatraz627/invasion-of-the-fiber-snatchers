# Bloop 1 validation report — adapter enablement (commits da40090..59be343)

<!-- sessions: fiber-snatcher-adapter@2026-07-25 · validator: bloop1-gate (sonnet, worktree @59be343) -->

Verdict: **ISSUES-FOUND**. Validator ran ~74 tool uses / ~19.5 min post-resume; all repros
against isolated tmp-dir daemons via `startTarget()`; zero Versable / live-daemon /
port 5101-5104-5105 interaction. Repo left clean (`git diff --stat` empty, suites green).

## Findings (validator's, condensed faithfully; full text in session transcript)

### BLOCKER
1. **`register("queries", …)` permanently clobbers the real TanStack adapter — and doctor hides it.**
   `discoverAdapters()` computes `needQueries = !adapters.has("queries")`; a project adapter
   registering that literal name synchronously (init script, pre-hydration) makes discovery skip
   the real TanStack wiring for the daemon's life — dispatch AND settle feed. Repro: hijacked
   adapter returned `{hijacked:true}` from `fs dispatch --adapter queries`. Doctor's
   `project-adapter` probe filter (`n !== "queries" && n !== "jotai"`) then hides the collision
   entirely ("registered: dup" — silent about the clobber).
2. **One malformed `activity()` return (NaN / `"0"` string / negative) permanently jams
   `wait --settled` for the whole page, no diagnostic.** Raw `+=` aggregation; `NaN === 0` never
   true; `0 += "0"` → `"00"` string concat; negative sums never reach 0. Repro'd each: settle
   always times out page-wide, forever, including for healthy TanStack work.

### MAJOR
3. **A permanently-throwing `activity()` is silently treated as idle** — vacuous settle for that
   source's work (repro: settle returned ok at ~460ms while dispatched work confirmed still
   running). No diagnostic anywhere; the adapter still lists as registered.
4. **Doctor's probe filter can't distinguish "built-in" from "clobbered by custom"** — same
   evidence as #1, distinct defect (filter logic).

### MINOR
5. No bounds/type validation in the activity aggregation path (rollup of #2's input classes).
6. `RUNTIME_VERSION` smoke pin is correct but structurally tautological (both sides read the
   same constant at the same instant; still catches injection failure / null). Validator: "not a
   defect requiring action."

### Validated clean (repro or mutation)
- Mutation D1 (drop `dialog[open]`) → native-dialog test RED; restored → green.
- Mutation D2 (zero out `queriesActivity`) → beyond-budget test RED; restored → green.
- Bonus mutation (concatenate init scripts) → syntax-error test IS load-bearing (page.ok=false).
- 512KiB cap boundary exact (at-cap loads; cap+1 rejected with doctor warn).
- Sub-poll-gap started-counter honored; alternating two-source relay blocks settle correctly;
  live (non-snapshotted) reads of the sources Map confirmed; double-register benign;
  non-function `activity` correctly excluded.

### Validator residue
- Its hostile test file removed (trash) before delivery; repo clean.
- ~45 inert `fs-e2e-*` tmp dirs added under /var/folders (join ~46 pre-existing from the
  build's own runs); no live processes; OS-cleaned eventually.

## Dispositions

| # | Sev | Disposition |
|---|-----|-------------|
| 1 | blocker | **Fixed** — `register()` rejects reserved names ("queries", "jotai") with a clear error; collision now impossible. |
| 2 | blocker | **Fixed** — per-source reads coerced + clamped (`Number.isFinite`, `> 0`) at the aggregation point; NaN/string/negative read as 0; honest finite positives untouched. |
| 3 | major | **Fixed (visibility)** — runtime tracks sources whose last `activity()` read threw; doctor's project-adapter probe warns and names them. Settle math still treats a throwing source as idle (can't let one broken adapter jam the page — that's finding #2's failure mode); the fix makes it loud instead of silent. |
| 4 | major | **Fixed by #1's reservation** — custom adapters can no longer hold built-in names, so the filter is now sound. |
| 5 | minor | **Fixed with #2** (same hardening pass). |
| 6 | minor | **Accepted, no action** (validator's own recommendation); noted here honestly: the pin guards injection-failure/staleness-to-null, not version divergence, which has no reachable path today. |

Fix commits follow 404b069 on `v2-adapters`; regression suite re-run green after fixes.
