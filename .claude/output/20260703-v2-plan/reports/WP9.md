# WP9 — un-rendered element-prop signal reader (shipped)

Answers the user's question ("can we get the un-mounted dropdown/tooltip
content — via sourcemaps?") and revives the menu-preview the skeptical-review
correctly killed, via a corrected mechanism.

## The mechanism (why it's not sourcemaps)

React evaluates JSX at the PARENT's render, so `<Dropdown>{menu}</Dropdown>`
constructs the `menu` element and hands it to the mounted trigger as a prop
VALUE immediately. The `{(open||show) && children}` conditional
(`Versable dropdown.tsx:218`) gates whether that value is committed to the
fiber tree (mounted → DOM), not whether it exists. So a closed dropdown's menu
content is not gone — it sits on the trigger's ancestor fiber as an un-rendered
element tree, readable via an up-walk + recursive string-leaf extraction.

Sourcemaps map bundled→source positions (a debug pointer, what `_debugSource`
uses); they don't yield runtime values, would recover only static literals, and
miss anything computed (the `${sheetCount} sheets` subtitles). The element-prop
read gives the real thing with live values, for free.

## What shipped (src/page-runtime/index.ts)

- `extractText` — bounded recursive string extraction from React elements /
  items arrays / config objects (node budget + depth cap + ≤8 strings).
- `unrenderedSignals(el)` — bounded up-walk (≤10 hops) reading explicit content
  props (`tooltip/content/dropdown/menu/items/options/groups`) from every
  ancestor, `children` only from overlay-named components
  (`/dropdown|menu|tooltip|popover|popper|float|overlay|select/`), and string
  label props. Only invoked for weak-labelled controls.
- `controlProvenance(el)` — onClick source + `_debugSource` (dev only).
- `snapshot`: weak controls gain `signals?: string[]`. Strong controls unchanged
  (no fiber cost, no bytes).
- `resolveIntent`: scores the needle against signals when the DOM label misses;
  a signal hit resolves at 0.55-0.7 ("opens X"), below a direct label match;
  bounded to 60 signal extractions per call.
- New `why <target>` verb (observe.ts, bin/fs.ts) — dumps every identity signal
  for one control: label, component, what it opens/says, handler, source.

## Verification

- Fixture repro (`LabelHostileToolbar`): a floating-ui-style conditional-render
  dropdown (menu passed as `children`, closed) + an always-mounted `content`-prop
  tooltip. `tests/e2e/wp9.test.ts` (6 tests) asserts the closed menu's labels
  and the tooltip content are recovered without opening. Green.
- LIVE Versable modal: `why` on the closed toolbar dropdowns recovered real menu
  labels with nothing opened — "Re-run Incomplete / Re-run All", "Mark canceled
  / Mark failed / Mark completed / Force status", etc. The exact controls the
  dogfood found totally opaque are now identified pre-interaction.
- Regression: unit + smoke + review-regressions + wp1 + wp3a + wp7 + wp9 all
  green after the fixture change.

## Honest limits

- **Works when the content element is constructed-and-passed as a prop** (the
  Versable pattern, verified). If a component builds the element INSIDE a gated
  `{open && <Menu items={compute()}/>}` branch, it isn't constructed until open —
  unreachable pre-interaction; `hover` remains the escape hatch.
- **`resolveIntent` is best-effort on huge DOMs.** Bare `fs click "Export"` on
  the 247-button modal matched row-cell filenames ("…export.xlsx") by label
  before the export dropdown's signal, and the 60-extraction budget may not reach
  a specific control. The deterministic path is `page --scope <toolbar>` → read
  signals → click the ref, or `why <ref>`. Follow-up: prioritize the signal
  budget toward overlay-component controls over arbitrary weak ones.
- Requires React fiber internals (`memoizedProps`, element `$$typeof`) — fine for
  the tool's local-dev scope; version-sensitive by nature.

## Dropped from the original spec (refuted by review, correctly)

Rung 2 (icon CSS class) — Versable uses react-icons, which render classless
`<svg>`; no per-icon token to read. The subtree-walk framing — the label lives
up-and-over, not below. Both replaced by the element-prop up-walk above.
