# WP9 + WP60 red-team report

Adversarial attack on the un-rendered element-prop signal reader (WP9:
`extractText` / `unrenderedSignals` / `controlProvenance` / `why`) and the
per-project adaptation layer (WP60: `sanitizeAdapt`, `isOverlayName` /
`OVERLAY_TOKENS`, `currentSurfaces` adapt path, `CONTENT_PROP_KEYS`).

Every row below was actually triggered against a live daemon + fixture via the
real CLI (`fs eval`, `fs page`, `fs why`, `fs click`), not read-and-reasoned.
Repro scripts live in `/tmp/fs-redteam/atk*.ts` (each boots a target through
`tests/e2e/harness.ts`, drives the attack, and stops the daemon). All daemons /
browsers were killed at exit — `pgrep -f daemon/server.ts` is clean.

Code under attack: `src/page-runtime/index.ts`, `src/daemon/server.ts`,
`src/core/config.ts`.

## Findings, ranked by severity

| severity | attack | broke? | repro | what the code did | fix needed |
|---|---|---|---|---|---|
| **HIGH** | **One poisoned fiber blinds the whole page.** A single weak-labelled control whose ancestor fiber has a throwing property access on any content-prop key crashes `page`, `why`, AND every intent-`resolve`. | **YES** | `atk1-crash.ts`, `atk9-realistic.ts`, `atk7-cycles.ts` (proxy-has-throw) | `unrenderedSignals`/`extractText`/`controlProvenance` have NO try/catch. A throwing getter on `memoizedProps` (`index.ts:281-282`), a throwing getter on a nested item model's `label` (`:251`), a Proxy `has`/`get` trap, or a throwing `toString` on `onClick` (`controlProvenance` `:311`) propagates out of `page.evaluate` → surfaces as `E_INTERNAL: evaluate: Error: <msg>`. Confirmed: after injecting one such control, `fs page`, `fs click "Open Preview"`, and `fs why` ALL returned `E_INTERNAL`. Daemon stays up but the three core recon/targeting verbs are dead page-wide. | Wrap `unrenderedSignals`, `extractText`, and `controlProvenance` in try/catch per-fiber (the sibling `safeSnapshot` at `:70-80` already does exactly this — the pattern exists in-file and wasn't applied). Per-element try/catch in `resolveIntent`'s `.map` and `snapshot`'s interactable map so one control can't poison the batch. |
| **HIGH** | **1-char `overlayComponents` token floods every signal.** `adapt.overlayComponents:["a"]` passes `sanitizeAdapt` (length 1 ≤ 120) and makes `isOverlayName` match nearly every component name via substring `.includes`. | **YES** | `atk4-tokenpollution.ts` | With `["a"]`, a weak control's `why` returned `["SECRET billing total 9000","Delete account","Admin panel","unrelated junk"]` — the entire ancestor subtree's text, read as "what this control opens", because the overlay branch (`:286-288`) reads `children` off every "overlay" fiber. Baseline (no adapt): `[]`. A blind agent is told an icon button opens arbitrary unrelated (even sensitive) page text. | `sanitizeAdapt` must reject overlay tokens below a minimum length (≥3) and prefer word-boundary / exact component-name match over raw substring `.includes` in `isOverlayName`. |
| **MED-HIGH** | **Cross-contamination via the 10-hop up-walk on generic keys.** Two sibling weak controls under a shared ancestor that holds a menu both report "opens \<menu>", including the one that opens nothing. | **YES** (misleading) / **partial** (auto-resolve) | `atk3-crosscontam.ts` | `unrenderedSignals` walks up to 10 ancestor fibers (`:278`) reading generic keys (`items`/`options`/`content`/`menu`). Both `btnReal` and `btnDecoy` returned signals `["Archive Job","Delete Forever"]`; `resolveIntent('Delete Forever')` returned BOTH as `opens "delete forever"` at 0.7 each. On real apps `items`/`options` are ubiquitous props, so any weak icon within 10 fiber-hops of any list/menu/select inherits its labels. `why`/`page` present the false "opens X" as fact; the 0.7 signal-confidence ceiling degrades auto-`resolve` to ambiguity/not-found (not a confident wrong click) — a real but partial mitigation. | Attribute a menu to the control that actually triggers it (stop the up-walk at the nearest overlay wrapper / the fiber that owns the toggle handler), not to every weak descendant. Narrow the default content keys or gate them to overlay ancestors. |
| **MED** | **`contentPropKeys` accepts structural / style keys.** `sanitizeAdapt` validates length + count but not key semantics. | **YES** (misleading) | `atk5-contentpropkeys.ts` | `contentPropKeys:["children"]` → signals `["row A","row B","row C"]` (whole subtree, and now ungated by the overlay check since the CONTENT_PROP_KEYS loop `:281` runs for every fiber). `contentPropKeys:["className"]` → signals `["btn btn-icon","sidebar collapsed danger-zone"]` — CSS classes surfaced as labels; `"danger-zone"` reads like an action. Docs say these keys "carry a control's opened content or label text" but nothing enforces it. | Deny-list structural keys (`children`, `className`, `style`, `key`, `ref`, `on*`) in `sanitizeAdapt`, or allow-list only known-safe shapes. Document that `children` is special-cased and can't be added here. |
| **MED** | **`currentSurfaces` plausibility gap — count-only guard.** The guard rejects selectors matching >6 visible elements but not selectors matching ≤6 non-overlay elements. | **YES** | `atk6-surfaces.ts` | `surfaceSelectors:["main","body","section"]` → snapshot `surfaces` = `["overlay:main","overlay:section"]` (page structure reported as open dialogs). Worse: switching tabs unmounts the fixture's `<section>`, so `fs click "Settings"` reported `surfaces:{closed:["overlay:section"]}` and `fs click "Data"` reported `{opened:["overlay:section"]}` — a routine navigation looks like a dialog dismiss/open in the T0 digest. The guard checks COUNT (`:431`), never whether the element is plausibly an overlay. | Add a plausibility check beyond count: reject `html`/`body`/`main`/`section`/`nav` and elements that are page-persistent or larger than a fraction of the viewport; or require the matched element to not be an ancestor of most interactables. |
| **MED** | **Byte-unbounded regex — node budget ≠ byte budget.** `extractText` runs `.replace(/\s+/g," ")` on the full string BEFORE the `length<=60` check; the budget (400) caps string COUNT, not bytes. | **partial** (perf) | `atk2-hugestring.ts`, `atk2b.ts` | A single weak control whose ancestor holds a 1 MB whitespace-dense `content`/`items` prop stalled one `fs why` ~**1.6 s** (`:231-234`). 60 such controls stalled one `fs page` ~**0.8 s**. The author's comment claims the node budget + depth cap bound this — bytes are unbounded. Not an OOM/hang, but it blows the perf budget with a realistic prop (a prettified JSON / SVG string). Non-whitespace blobs hit V8's fast path (~80 ms/400 MB), so the worst case needs whitespace. | Clip to a bounded slice (e.g. `v.slice(0, 200)`) BEFORE the `.replace`, and/or make the budget count bytes, not just nodes. |
| no | **`sanitizeAdapt` / init-string injection.** Can a config value break `window.__fsAdapt=${JSON.stringify(...)};`? | **NO** (attempted, held) | `atk6-surfaces.ts` | Payload `</script>  \`${globalThis.__PWNED=1}\`\\"end` (plus U+2028/U+2029 tried separately) round-tripped verbatim into `window.__fsAdapt.surfaceSelectors`, `__PWNED` was never evaluated, daemon booted fine. `JSON.stringify` escaping + the ES2019 relaxation of U+2028/2029 in string literals hold. `addInitScript` passing source to CDP (not embedding in HTML) makes `</script>` a non-issue. Solid. | none |
| no | **Cyclic / deep / Proxy-loop / forged props → infinite loop or stack overflow.** | **NO** (defended) | `atk7-cycles.ts` | Self-referential element (`props.children = self`), mutually-referential `items` arrays, a depth-500 element chain, and a Proxy whose `get` returns itself forever all completed in 0 ms with no throw. The depth cap (starts 6, `-1` on every object/array/element descent) + the shared 400-node budget + the `$$typeof` symbol check (`isReactElement` `:186-193`) bound every path. A forged non-symbol `$$typeof` is correctly ignored. | none |
| no | **`resolveIntent` / `snapshot` up-walk cost on a weak-control-heavy page.** | **NO** (defended) | `atk8-resolveperf.ts` | 8000 weak controls → `resolveIntent` 27 ms, `snapshot` 12 ms. `signalBudget=60` (`:678`) bounds the fiber work and the interactables cap of 60 holds. The "only weak controls bounds it" claim survives. (Minor: substring signal-matching inflates candidate count — `opt5` matched 8 controls via `opt50`/`opt500` — but that's noise, not a break.) | none (optional: anchor signal match at word boundaries to cut candidate noise) |

## Single worst finding

**One malformed component silently kills the tool for the entire page.** Inject
a single weak-labelled control whose ancestor fiber has a throwing property
access on any content-prop key — a `get()` that throws, a Proxy `has`/`get`
trap, a computed `label` getter on a menu-item model, a throwing `toString` on
`onClick` — and `fs page`, `fs why`, and every intent-based `fs click/fill
"<text>"` all return `E_INTERNAL: evaluate: Error: <msg>` with no hint that ONE
component caused it and no workaround (every text-target and every snapshot
fails). This needs no malice: a MobX computed that throws before data loads, a
proxy store spread into props, or a lazy getter that assumes loaded state is
enough. The exact defense — a per-item try/catch — already exists 200 lines up
in the same file (`safeSnapshot`), and was simply not carried into the WP9 read
path.

## Structural root cause shared by the top findings

The WP9 read functions (`extractText`, `unrenderedSignals`, `controlProvenance`)
do **zero exception handling** and the WP60 `sanitizeAdapt` does **zero semantic
validation** (length + count only). Both defensive patterns exist elsewhere in
the same codebase — `safeSnapshot`'s try/catch and `sanitizeAdapt`'s own caps —
but weren't extended to cover (a) property access that has side effects, or (b)
adapt tokens that are too short / name structural keys / name non-overlay
selectors. The value of the up-walk is real; its blast radius when an assumption
(props are inert plain data; a token is a meaningful component substring; a
selector names an overlay) fails is the whole page.

---

## Fix outcomes (writer pass, verified by re-running each attack)

| finding | fix | re-run result |
|---|---|---|
| HIGH poisoned-fiber crash | try/catch in `unrenderedSignals`/`controlProvenance` + `safeGet` in `extractText` + per-element try/catch in snapshot/resolveIntent maps | atk1: `page`/`why`/`click` all `ok`, daemon alive — FIXED |
| HIGH 1-char token flood | `sanitizeAdapt` rejects overlay tokens <3 chars | atk4: `["a"]` → signals `[]` — FIXED |
| MED structural contentPropKeys | `sanitizeAdapt` deny-lists children/className/style/etc. | atk5: `["className"]`/`["children"]` → `[]` — FIXED |
| MED surface count-only guard | `sanitizeAdapt` rejects structural-tag selectors + `isPlausibleOverlay` (tag + viewport-area) at runtime | atk6: `["main","body","section"]` → no surface pollution; navigation no longer reads as dialog open/close — FIXED |
| MED byte-unbounded regex | `slice(0,120)` before the whitespace collapse | atk2: 1MB/20MB props 1.6s → 1-36ms — FIXED |
| MED-HIGH cross-contamination | read content keys from all ancestors (real recovery needs it) but stop at the nearest ancestor yielding content | atk3: distant inheritance fixed; **shared-nearby-ancestor case remains** — two controls under one wrapper both read its menu. Bounded to 0.7 confidence (ambiguity, never a confident wrong click), as the report rated it. Full trigger-attribution is a hard problem; not attempted rather than risk a fragile heuristic that broke real Versable recovery in testing. |

Real Versable recovery re-verified post-fix: closed modal toolbar dropdowns
still yield "Re-run Incomplete / Re-run All". Regression: 89 tests green.
Crash-resilience regression test added (wp60.test.ts).
