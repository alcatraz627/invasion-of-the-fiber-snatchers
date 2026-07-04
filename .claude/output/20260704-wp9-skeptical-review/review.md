# WP9-SPEC skeptical review — signal-aggregator targeting

Reviewer stance: assume the spec is wrong until the real code proves otherwise.
Every row cites a file:line I opened. Ranked by suspicion (confidence × severity).

## Verdict on the load-bearing question (wrinkle B)

**Wrinkle B is REFUTED by the real code, and it is worse than "unverified" — the
spec's own motivating section states it as fact.** The Versable dropdown is not a
"daisyUI dropdown that renders content in the DOM and hides via CSS." It is a
custom component built on `@floating-ui/react` (`dropdown.tsx:5-19`) whose menu
subtree is **conditionally rendered on open**: `{(open || show) && (<MaybePortal>…{children}</MaybePortal>)}`
at `dropdown.tsx:218`, with `open` initialised `false` (`dropdown.tsx:63-64`) and
`show` initialised `false` (`dropdown.tsx:169`). While the dropdown sits closed,
`(open || show)` is `false`, so the `DropdownMenu` (and its `items` prop) has **no
fiber at all** — it is not mounted, not CSS-hidden. `menuPreview` without
interaction is therefore impossible, which is exactly P2's headline. Second,
even when open, the menu is rendered through `FloatingPortal` (`dropdown.tsx:180,219`)
and — for the export/rerun toolbars — is passed as `children` of `Dropdown` by
`ButtonV1` (`button.tsx:373-402`), so the `items` prop lives on a fiber that is a
**portaled sibling** of the trigger button, not inside the trigger's fiber
subtree. The spec's described mechanism, "the element's fiber (`fiberOf(el)`) and
a bounded walk of its **subtree** fibers" (`WP9-SPEC.md:38-45`), cannot reach it
in either state. P0 does name B as a gate — good — but the spec's "The problem,
grounded" section asserts "the labels ARE reachable without interaction …
`DropdownMenu items={…}` holds them as a prop" (`WP9-SPEC.md:19-22`) as
established fact, and the dogfood it cites established the opposite (labels live
"inside **opened** dropdown menus"; the only working path was hover-to-reveal —
`DOGFOOD.md:47-51,82-83`). The premise the whole reframe leans on is false for
this app.

## Ranked findings

| confidence | severity | file:line | wrinkle/check | what's suspect | how to verify / what the real code shows |
|---|---|---|---|---|---|
| 95% | CRITICAL | `dropdown.tsx:218`, `:63-64`, `:169-178`, `:180`, `:219`; `button.tsx:373-402`, `:351-356` | B (P2 headline) | `menuPreview` from a collapsed dropdown's fiber `items` prop | Menu subtree is `{(open \|\| show) && …}` — **unmounted while closed**, so no fiber holds `items`. `open`/`show` both init `false`. On the export/rerun path `DropdownMenu` is `children` of `Dropdown` and opened only via `dropdownOnClick` (`button.tsx:351-356`). Collapsed → nothing to read. P2's premise fails. |
| 92% | HIGH | `WP9-SPEC.md:19-22,82-87`; `DOGFOOD.md:47-51,82-83`; `dropdown.tsx:5-19,180,219` | B — premise vs evidence | Motivation states reachability-while-closed as fact; calls it a "daisyUI dropdown [that] hides via CSS" | It is `@floating-ui/react` + `FloatingPortal` with a **conditional render**, not daisyUI CSS-hide. The dogfood only proved labels are reachable **on hover** and **inside opened menus** — it never read a closed menu's items. The spec extrapolates past its own evidence. |
| 90% | HIGH | `render.icon.tsx:73-75,92-98`; `icons.ts:6-53`; `WP9-SPEC.md:34-37,116-117` | E / rung 2 icon lib (P0 gate) | Rung 2 reads `bi-*`/`fa-*`/`lucide-*`/`data-icon` class tokens as "DOM-only, zero fiber cost" | Versable's icons are **react-icons** (`icons.ts` imports `Bi/Bs/Fa/Fi/Go/Hi/Io…`), which render **classless** `<svg>`. `RenderIcon` adds only a **non-identifying static** class `"icon-svg"` (same for every icon; comment: "icon-svg does nothing rn") on the string-key path, and **nothing** on the function-icon path (`Icon={VscDebugRerun}`). There is no per-icon class token, no `data-icon`, no `<use href>`. Icon identity exists only as the fiber's component name — i.e. rung 3, **not** rung 2 — so rung 2 as specified extracts nothing here. |
| 85% | HIGH | `WP9-SPEC.md:111-117`; `title.tsx:362,571,362-570` | E / phasing (check 5) | P1 (rung 2 + rung 4) billed "DOM-only, no contract change, **no fiber cost**"; claimed independent of P0 | Rung 2 secretly depends on the icon-library assumption that only P0 validates — if P0 finds react-icons, rung 2 must read the fiber, breaking "no fiber cost." Rung 4 (structural DOM) also yields ~nothing on the modal: the toolbar `<div id="job-output-row1-toolbar">` (`title.tsx:362`) and the action group `<div class="row … ml-auto">` (`title.tsx:571`) have **no `aria-label`, no `role`, no `<label for>`, no preceding text sibling**. So P1's cheap phases deliver little on the exact app that motivated WP9; the value is all in P2, which rests on refuted B. |
| 85% | MED-HIGH | `tooltip.tsx:155-177`; `button.tsx:289-404`; `page-runtime/index.ts:83-96,172-183,532-566,568-600` | A/3 fiber topology | Rung 3 assumes signals live in the trigger's fiber **subtree** | The real per-button label is `ShowTooltip`'s `content` prop, held on an **always-mounted** `ReactTooltip` that is a **sibling** of the trigger under the wrapper div (`tooltip.tsx:155-177`; button + Dropdown + tooltip are siblings in `button.tsx:289-404`). To read it you must walk **up** to the common ancestor then **down** a sibling branch. Every existing fiber primitive walks **up** via `.return` (`walkAllFibers`, `nearestComponent:172`, `state:568`, `resolveComponent:532`); none walk down/sideways. The spec's "subtree walk from `fiberOf(el)`" reaches neither the tooltip nor the menu items. |
| 88% | MED-HIGH | `title.tsx:144-150,78-83`; `WP9-SPEC.md:67-68,75-81` | A internal contradiction | "Prefer the string `tooltip`" (option a) as the clean path | For export items the `tooltip` string ("Download the whole file", `title.tsx:149`) is **different text** from the visible title ("Export All Sheets", `title.tsx:145`). The spec's own worked example, `menuPreview` contains "Export All Sheets" → resolves `click "Export"` (`WP9-SPEC.md:67-68`), needs the **title** prop, i.e. fallback (b), not the preferred (a). Preferring the tooltip yields a string the worked example can't match. The two options give divergent text and the spec picks the wrong one for its own example. |
| 92% | MED | `title.tsx:317-355` vs `:143-199` | A coverage (check 2) | "string `tooltip` … present on these items" | True only for export/rerun (all 4 items each carry `tooltip`). The **column** dropdown `colsToSearch` (`title.tsx:317-355`) items have **no `tooltip`** and a **JSX** `label` (`<input checkbox/><span>All columns</span>`). So "prefer string tooltip" degrades on the column/select dropdowns — roughly 2 of ~5 dropdown families in this one modal. Those fall to fallback (b) or "unreadable pre-interaction," which the spec admits but under-weights by generalising from export/rerun. |
| 80% | MED | `types.ts:1-2,28-34`; `WP9-SPEC.md:88-96`; `print.ts:29-34`; `harness.ts:14`; `smoke.test.ts:25,158,165` | C thaw authority | Adding `signals?` to a "FROZEN" `TargetCandidate` as a "reviewed thaw" | Additive is **consumer-safe**: `print.ts` reads only `ref/role/text/component/confidence` (`:31-34`); `harness.ts:14` and `smoke.test.ts:25` type candidates as `any[]`; tests only read `.length`/`[0].ref` (`:158,165`). No exhaustive-key iteration or JSON-equality. **But** `types.ts:1-2` says the freeze requires "a coordinator-approved contract-change note (IMPLEMENTATION.md §5)"; the spec calls (b) a "reviewed thaw" without producing/citing that note or establishing the author's authority to thaw. Named, not secured. |
| 85% | LOW-MED | `print.ts:29-37`; `WP9-SPEC.md:66-71,88-96` | C completeness | "candidates carry the signals … so the agent picks by evidence" | Option (b) adds the field but `printResponse`'s candidate loop (`print.ts:31-34`) doesn't render it — the agent sees `signals` **only via `--json`** (`print.ts:7-10`). The wrinkle-C discussion (text-fold vs new field) never mentions the required `print.ts` change, so (b) as written is functionally incomplete for the human-readable path the spec's own resolveIntent story assumes. |
| 70% | MED-LOW | `WP9-SPEC.md:97-102`; `DOGFOOD.md:47-51`; `PERF-AUDIT.md:31,146-151`; `page-runtime/index.ts:462-464` | D cost (check 4) | "only weak controls trigger fiber extraction" as the cost bound | On the motivating 247-button modal **most** controls are weak (~11 empty dropdowns + icon buttons — `DOGFOOD.md:47-51`), so "strong controls unchanged" buys little there. Worst case ~≤60 flat weak × ≤50-fiber walk ≈ 3000 node reads — plausibly a few ms, and concise is already **24 ms / 1.46 KB at a real 10k DOM vs a <30 ms / <3 KB budget** (`PERF-AUDIT.md:31`), i.e. ~6 ms headroom. Cost probably survives, and the injected-10k harness makes "measure before/after" a **real** gate, not vapor. Weakest of the wrinkles — but the bound is mis-argued (the walk that would fit the budget is the one that finds nothing, per the topology finding). |
| 75% | LOW-MED | `page-runtime/index.ts:568-600,60-81,532-566`; `WP9-SPEC.md:38-45` | reinvention | "fiberOf(el), already defined" implies cheap reuse | Partly fair, but `state()` (`:568-600`) already extracts `memoizedProps` via `safeSnapshot` (`:60-81`) — the spec builds fresh extraction rather than reusing it. More importantly, **no** existing primitive does the down/sibling walk P2 actually needs (all walk up), so P2 is more net-new than "already defined" suggests. The reuse claim understates the build. |
| 65% | LOW | `title.tsx:600`; `page-runtime/index.ts:162,507-529`; `pipeline/index.ts:145` | dogfood claim precision | "`fs click 'Export'` cannot resolve" / label bottoms out at `<ButtonV1>` | The **Export** main button carries `id="job-output-export-btn"` (`title.tsx:600`), so `controlLabel` returns `#job-output-export-btn` (weak — `page-runtime:162`), whose token "export" makes `resolveIntent` score it ~0.7 (`:507-529`) — a surfaced **candidate**, just under the 0.85 confident gate (`pipeline:145`). So "Export" isn't invisible; it's low-confidence. The genuinely id-less/label-less controls are Re-Run/Refresh/Close/Expand (`title.tsx:610-636`). Minor overstatement in the shared narrative, not load-bearing. |

## Cross-cutting notes

- **The recurring structural error** across A, B, and the tooltip signal: the spec
  models "the label lives in the trigger's fiber subtree." In this app the label
  lives **up and over** — in an always-mounted `ReactTooltip` sibling (tooltip),
  or in a portaled, open-only `DropdownMenu` sibling (menu items). Any P2 that
  survives P0 needs an **up-to-ancestor-then-down-into-portal** walk with a
  meaningful cap, plus portal-aware fiber traversal. The spec's "≤50-fiber subtree
  walk" is both the wrong direction and, if redirected, an unclear cap.

- **A cheaper signal the spec skips.** The toolbar buttons' labels are the
  `tooltip` prop. Some Versable tooltips are emitted as `data-tooltip-content`
  attributes on the anchor (e.g. `title.tsx:271-274,782-783`), which a DOM-only
  rung could read directly — but the `ButtonV1` toolbar path routes through
  `ShowTooltip`'s `content` prop (`tooltip.tsx:163,170`), which is **not** an
  anchor attribute, so those specific buttons still need the fiber. Worth
  enumerating which tooltip mechanism each control uses before committing rung
  ordering; the app mixes two.

- **What the spec gets right.** `resolveIntent` is the correct place to fold new
  signals (`page-runtime:497-530`). Wrinkle C's additive-compatibility claim holds
  at the consumer level. P0-as-gate is the right instinct — the failure is that
  the motivation and P1 both pre-spend B and the icon-class assumption before P0
  validates them.

## Bottom line

The reframe (label-resolver → signal-aggregator, score against more than the
label) is directionally sound, but the **two signals the spec leans on hardest —
menu `items` (rung 3/B) and icon-class identity (rung 2) — are the two the real
app defeats**, and the spec presents both as more settled than its cited evidence
supports. P0 must actually run on the live modal and is very likely to force a
re-scope of P2 to a hover-tier (which the dogfood already proved works) before any
of P1/P2 is built.
