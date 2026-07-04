# WP9 spec — signal-aggregator targeting (the low-a11y fix)

> **REVIEW OUTCOME (skeptical-review, 2026-07-04):** the two signals this spec
> leans on hardest are refuted for the Versable app. **Wrinkle B is FALSE** —
> Versable's `Dropdown` is `@floating-ui/react` with `{(open||show) && …}`
> conditional render (`dropdown.tsx:218`), so a collapsed menu's `items` fibers
> are UNMOUNTED, not CSS-hidden; `menuPreview` without interaction is impossible.
> **Rung 2 (icon class) is also empty here** — Versable uses react-icons, which
> render classless `<svg>` (no `bi-*`/`data-icon` token). The deeper error: the
> real label lives UP-AND-OVER (an always-mounted sibling `ReactTooltip`, or a
> portaled open-only menu), while every existing fiber primitive walks UP only —
> so P2 needs a different traversal than "subtree walk from fiberOf(el)". The
> reframe (label-resolver → signal-aggregator) is directionally sound and
> resolveIntent is the right seam, but P2 as written does not work on this app;
> the hover-tier the dogfood already proved is the likely real path.
> Full review: `.claude/output/20260704-wp9-skeptical-review/review.md`.
> **This spec is SUPERSEDED pending a re-scope; do not build from it as-is.**

Status: DRAFT — reviewed, premise refuted (see banner). Motivated by the dogfood (reports/DOGFOOD.md):
V2 assumed the page describes itself (aria/role/text) and degraded to useless
component-name labels when Versable didn't. The fix reframes targeting from
label-*resolver* to signal-*aggregator*, and leans on the one signal source the
tool uniquely has and currently ignores: the React fiber props.

## The problem, grounded

- The label ladder (`src/page-runtime/index.ts:143-166`, `controlLabel`) reads
  only DOM attributes: aria-label → innerText → data-testid → svg title → title
  → img alt → labelledby → placeholder/name → `#id` → `<Component>` → tag. On a
  low-a11y control it bottoms out at `<ButtonV1>` / `<Dropdown>`.
- The dogfood proved every rung failed on the Versable modal toolbar: ~11
  dropdown triggers and the icon buttons had no aria-label / title / text /
  data-tip in the DOM. Labels existed only in hover-tooltips (custom AppTooltip
  portal) and inside opened menus.
- Yet the labels ARE reachable without interaction: `DropdownMenu items={...}`
  (`preview-job-modal.title.tsx:316,605`) holds them as a prop; each item also
  has a string `tooltip` ("Download the whole file"). The tool read the DOM and
  gave up; it never looked at the fiber the trigger belongs to.

## Goal

For any interactable whose accessible name is weak (today's `weak:true` rungs),
attach every additional signal the tool can extract, cheapest and most
deterministic first, and let the agent reason when no single clean label exists.
`resolveIntent` scores against these signals too, not just the label.

## The signal ladder (implement rungs 2, 3, 5; 6 and 7 already exist as verbs)

1. Accessible name — the current `controlLabel` ladder. Unchanged.
2. **Icon identity** — an icon button is labeled, in a class name. Read the
   control's own or descendant svg/i class tokens (`bi-download`, `lucide-export`,
   `fa-*`, `<use href="#icon-...">`, `data-icon`). Strip the library prefix,
   keep the semantic token. Deterministic, DOM-only, zero fiber cost.
3. **Fiber props** — the differentiator. From the element's fiber
   (`fiberOf(el)`, already defined) and a bounded walk of its subtree fibers:
   - a `tooltip` / `label` / `aria-label` / `title` React prop that never reached
     the DOM (string props only — see wrinkle A);
   - a Dropdown/menu `items` prop: extract each item's `tooltip` string, or the
     text content of its `label` if the label is a plain string (wrinkle A).
     This yields a `menuPreview: string[]` — what the control opens, without
     opening it.
4. Structural DOM — associated `<label for>`, a wrapping `<label>`, the nearest
   preceding text sibling, a group/toolbar `aria-label` ancestor. DOM-only.
5. **Caller source (dev only)** — the fiber's `_debugSource` (`{fileName,
   lineNumber}`) names where the JSX was authored; `onClick`/handler prop
   `.toString()` names what it calls (`commands.export('allSheets')`). Gate on
   dev builds; both are absent in prod.
6. On-demand reveal — `hover` renders the tooltip, then read it. Verb exists
   (WP3a); this rung is "the agent's escape hatch", not automatic.
7. Vision — `look` the control. Verb exists (WP5); last resort.

## What changes

### Snapshot (`page`)
`controlLabel` gains signal extraction for weak controls. A weak interactable's
snapshot entry grows optional fields: `icon?`, `menuPreview?: string[]`,
`labelSource?: "aria"|"text"|"icon"|"prop"|"menu"|"struct"|"debug"|"none"`, and
in `--detailed`, `handlerHint?` + `debugSource?`. Strong controls are unchanged
(no extra work, no bytes).

### Intent resolution (`resolveIntent`)
Score the needle against label ∪ icon ∪ menuPreview ∪ prop-tooltip, not just the
label. A dropdown whose `menuPreview` contains "Export All Sheets" resolves to
`fs click "Export"`. When still below the confidence gate, the E_TARGET_AMBIGUOUS
candidates carry the signals (contract question below) so the agent picks by
evidence — the doctrine's principle 13, which V2 currently violates for weak
controls.

## Hard questions this spec must answer (for the review to attack)

- **Wrinkle A — labels are ReactNodes, not strings.** `exportOptions[].label` is
  `<ExportOptionLabel title="Export All Sheets" .../>`, a JSX element. Reading
  `.label` from props gives an element, not text. Extraction options: (a) prefer
  the sibling string `tooltip` prop (present on these items, cleanest); (b) walk
  the label element's props tree for string leaves (`title`, children strings),
  bounded depth. Spec picks (a) first, (b) as fallback, and accepts that a label
  that is purely a ReactNode with no string prop stays unreadable pre-interaction.
- **Wrinkle B — mounted-while-collapsed assumption.** Reading a Dropdown's items
  from the fiber only works if React mounts the menu subtree while the dropdown
  is visually closed (CSS-hidden), vs mounting on open. daisyUI dropdowns render
  content in the DOM and hide via CSS, so the fibers should be present — but this
  is UNVERIFIED on the real app and is a phase-0 gate: if the menu is not mounted
  until open, rung 3's menuPreview is impossible and only rungs 2/4/5 apply.
- **Wrinkle C — the frozen contract.** `TargetCandidate`
  (`src/protocol/types.ts:28-34`) is frozen at `{ref, role, text, component?,
  confidence}`. Attaching signals to candidates is a contract change. Options:
  (a) fold signals into the existing `text` (e.g. `text: "Export ▸ [Export All
  Sheets, Export Current Sheet]"`) — no contract change, lossy; (b) add optional
  `signals?` to TargetCandidate — a deliberate, additive contract thaw, backward
  compatible. Spec recommends (b) as a reviewed thaw, since the snapshot
  interactable shape (not frozen) already grows fields and candidates should
  match.
- **Wrinkle D — cost.** Rung 3 walks fiber subtrees. A 247-button modal
  (dogfood) must not pay a full-subtree walk per control. Bound it: only weak
  controls trigger fiber extraction; the subtree walk is depth- and
  breadth-capped (e.g. ≤50 fibers); `page` stays under its budget (perf audit:
  concise must hold < 3KB / < 30ms class). Measure before/after on the injected
  10k-DOM.
- **Wrinkle E — is this the tool's job or the agent's?** Rungs 2-4 are cheap and
  deterministic (do them in the tool). Rungs 5-7 are expensive/heuristic. The
  spec's stance: the tool extracts 2-4 automatically; 5 only under `--detailed`
  or a `--why <ref>` verb; 6-7 stay agent-invoked verbs. Do NOT auto-hover or
  auto-vision during a snapshot.

## Phased build

- **P0 (validation gate).** On the real Versable modal, confirm wrinkle B (are
  DropdownMenu `items` fibers mounted while collapsed?) and enumerate the icon
  library in use (wrinkle A/2). If B fails, drop rung 3's menuPreview to a
  hover-tier only and re-scope. Do not build P1+ until P0 is answered on the real
  app.
- **P1.** Rung 2 (icon identity) + rung 4 (structural DOM) in `controlLabel` —
  DOM-only, no contract change, no fiber cost. Ship + measure snapshot cost.
- **P2.** Rung 3 (fiber props / menuPreview) with wrinkle A/D handling; the
  `signals?` contract thaw (wrinkle C) reviewed and applied; `resolveIntent`
  scores the new signals.
- **P3.** Rung 5 behind `--detailed` / a `why` verb (dev-only source + handler).
- **Doctrine.** Fold the lesson into `~/.claude/conventions/agent-first-tools.md`:
  principle 1 ("observe as structured semantic text") assumes the app HAS
  semantics; add the caveat that a driver for arbitrary apps must fall through to
  structural inference (icon class, fiber props, handler source) and ultimately
  hand the agent raw evidence, never a dead component-name label.

## Non-goals

- Not fixing Versable's a11y (separate finding for the frontend team; flagged in
  DOGFOOD.md). WP9 makes the tool robust to low-a11y apps; it does not require
  apps to improve.
- Not the non-ARIA surface-detection finding (DOGFOOD finding 1) — that is a
  separate WP (per-project surface selectors + URL-modal detection).
