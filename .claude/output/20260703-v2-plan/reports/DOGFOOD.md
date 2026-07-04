# Dogfood — V2 driving the live Versable app

The last L4 item: drive the real Versable enhancement-product dev app (jobs
list + the PR-217 preview modal) with V2, no fixture. Done against a live
daemon on `localhost:3006`, driving whole segments per call rather than one
verb at a time.

## What was validated on the real app (all worked)

- `doctor` → healthy; first verb auto-started the daemon (no preflight ritual).
- `navigate /jobs` + `wait --settled` + `fill --settled "JEGS"` — the
  debounced search settled cleanly, `focus:[Search]` in the digest.
- `click "JEGS eBay 4 3 26 (Enhancement)"` opened the preview modal by intent
  (url gained `jobs.modal=preview_job_data`).
- `page --scope '.modal' --detailed` minted refs (`e32.zr0q` …) with component
  names on every interactable; budget held on a 247-button modal.
- **surfaces digest, live**: `click` on the status dropdown →
  `Δ … surfaces:+dialog:#_r_4q_`; `dismiss` → `surfaces:-dialog:#_r_4q_`.
  This is the WP8 printer fix (surfaces/focus/counts on the text line)
  confirmed on a real app, not the fixture.
- `hover e307 --hold 800` revealed the custom AppTooltip text ("Re-run the
  processing job for all the incomplete rows in this table"); further hovers
  mapped e308="Refresh data". Hover mechanically drives real tooltips.
- **staleness contract held on a real SPA re-render**: a ref minted before the
  modal was reopened returned `E_TARGET_STALE` (same docTag, element gone)
  instead of mis-clicking a re-rendered element. Exactly right.
- `queries` / `count` / `eval` / `journal` reads all functional; the journal
  captured the full flow (macro-liftable).

## Findings (ranked, honest)

### 1. [HIGH] Surface detection is blind to non-ARIA overlays
`surfaces`/`popover`/`persisted` key on `role=dialog|menu|listbox`. The app's
two biggest overlays are invisible to it:
- **The preview modal is URL-state, not `role=dialog`** — never tracked. When
  `dismiss` (Escape) closed the whole modal, the digest reported only the
  dropdown leaving (`surfaces:-dialog:#_r_4q_`); an agent could believe it
  closed just a menu (finding 3).
- **AppTooltip has no `role=tooltip`** — `hover` returned `persisted:false,
  surfaces:[]` even though the tooltip rendered and its text was readable.

daisyUI dropdowns DID register (`+dialog:#_r_XX_`), so the mechanism works;
the gap is coverage. Fix directions: detect URL-modal state as a surface;
allow a per-project surface-selector config (`.fiber-snatcher/surfaces.json`)
so an app can name its non-ARIA modal/tooltip containers.

### 2. [HIGH] Intent targeting is defeated by unlabeled icon controls
The modal toolbar's ~11 dropdowns + icon buttons expose no `aria-label` /
`title` / text / `data-tip` in the DOM — labels live only in hover-tooltips
and inside opened dropdown menus. So `fs click "Export"` cannot resolve; the
label ladder bottoms out at the component name (`<ButtonV1>`, `<Dropdown>`).
Two-sided:
- **Versable a11y gap** (worth flagging to the frontend): toolbar controls
  should carry `aria-label`. Icon-only + hover-tooltip is inaccessible to
  screen readers too, not just to this tool.
- **Tool limitation**: the label ladder can't reach hover-only tooltips. Fix
  direction: an opt-in resolveIntent tier that hovers a candidate to read its
  tooltip, or returns component+position in candidates so the agent picks by
  those instead of a label it can't see.

### 3. [MED] URL-state modal + Escape breadth
`dismiss` verified only the ARIA dropdown leaving, but Escape also closed the
whole modal (url lost `jobs.modal`). Verified-close is honest about what it
can see (ARIA surfaces) but under-reports on this app's Escape semantics.
Ties to finding 1.

### 4. [POSITIVE] The ref/generation contract is solid
Stale-ref rejection on a real re-render is the single most important
correctness guarantee for blind driving, and it held.

### 5. [POSITIVE] Waits and hover mechanics are solid
`--settled` closed the debounce; `hover` drove the real tooltip. The gaps
above are in detection heuristics, not the driving mechanics.

## Verdict

V2 drives the real app end-to-end: navigation, settle, ref snapshots, digests,
staleness, hover, reads, journaling all work. The two HIGH findings are
detection-heuristic coverage gaps (non-ARIA surfaces, unlabeled controls), not
core-architecture problems, and each has a concrete opt-in fix. The canonical
"filtered export dry-run" click was not completed only because the export
control is unlabeled (finding 2) — the tool's own answer (hover-to-reveal)
worked, so the path is: hover-map the toolbar, then click the identified ref.

Recommended next (not done here, ranked): (a) per-project surface selectors +
URL-modal detection; (b) hover-tier intent resolution; (c) flag the Versable
toolbar a11y gap to the frontend team.
