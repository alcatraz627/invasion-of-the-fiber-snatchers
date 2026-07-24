# Adapter map — enabling versable-builder + speedway (task #2)

<!-- sessions: fiber-snatcher-adapter@2026-07-25 -->

Targets (recon + vb-fable's answers, msg-42a2974800d14f18):

| | versable-builder playground | speedway |
|---|---|---|
| Stack | Next.js App Router, port **5104**, workspace kit | React Router v7 framework mode + Vite, port **5101** (pm2 `speedway-fe`; **:5105 is another session's — never touch**) |
| State | plain React + `@versable-git/ui` (modal-store `useModal`, `pushAlert` toasts) | server truth in RR7 loaders/actions (Firestore server-side only), `useState` locally, same kit stores |
| Auth | none | session cookie; dev login `sw-flip-verify@versable.test` (password in vb-fable msg / speedway e2e fixtures) |
| Quirks | — | kit is a hard-link into `../versable-builder/packages/ui`; Vite doesn't watch node_modules (kit edit → pm2 restart); browser caches kit by lockfile `?v=` hash (hard-refresh / CDP clearBrowserCache); first load after `.vite` clear can crash dual-React — reload |

## Works as-is (framework-agnostic, no adapter needed)

- Fiber walk, `state` (props/hooks), component targeting — React is React for RR7 and Next both.
- Snapshot/refs/intent resolution (ARIA + `adapt` config), all drive verbs, actionability waits (`src/pipeline/waits.ts:100-166`).
- `wait --text/--url/--gone/--network-idle`; soft-route tracking wraps `history.pushState/replaceState/popstate` directly (`src/page-runtime/index.ts:636-647`).
- Digest observation wiring — mutations, errors, console, remounts, surfaces, focus (`index.ts:601-647`).
- journal/macro/shoot/look/probes/session; network mock/throttle.

## The gaps (why "full functionality" needs adapters)

1. **`--settled` is vacuously true on both apps.** `queriesPending()` → 0 and `queriesActivity()` → `{pending:0, started:0}` when no "queries" adapter is discovered (`index.ts:889-908`); every settle wait (`waits.ts:45-95`) then resolves instantly. On speedway that silently hides in-flight RR7 navigations/fetcher mutations — the worst kind of false "settled".
2. **`fs dispatch` throws** — "no adapters found" (`index.ts:876`). `queries`/`atoms` degrade with honest messages (fine — the apps genuinely have neither).
3. **`fs routes` is Next-App-Router-only** (`src/actions/routes.ts:44-70`); speedway returns `router:"none"`. Playground works today.
4. **Activity is a private side-channel, not a contract.** `tanstackActivity` is set only inside built-in discovery (`index.ts:574,665-666`); `register(name, adapter)` (`index.ts:885`) cannot feed settle. `Adapter = { getState, dispatch }` (`index.ts:18`) has no activity slot.
5. **No project-adapter load path.** `config.adapters` (`src/core/config.ts:37`) is V1 residue — zero V2 readers (full-tree grep). The injection precedent exists: daemon addInitScripts `__fsAdapt` then the runtime bundle (`src/daemon/server.ts:209-210`); init scripts re-run on every document, so registration survives reloads for free.

## Build items (recommended shape)

1. **Generalize activity** — replace the single `tanstackActivity` with a registry of activity sources (`Map<string, () => {pending, started}>`); `queriesActivity()` aggregates (sum pending, sum started). TanStack becomes source #1. The `{pending, started}` monotonic-counter shape is proven by the debounce-aware settle (`waits.ts:69-95`) — keep it. This touches the runtime API contract → per the July-5 caution, frozen-contract changes merit care; it's additive/backward-compatible.
2. **RR7 adapter, built-in** (like tanstack/jotai — benefits every RR7 app, not just speedway): discover the data router (fiber walk for `RouterProvider` props; verify whether the dev build exposes `window.__reactRouterDataRouter` at runtime — UNCONFIRMED, check on the live app), subscribe; activity = (navigation.state !== 'idle') + non-idle fetchers, with started++ on idle→busy transitions. `getState` = location + navigation + fetchers + per-route loaderData. `dispatch` = navigate/revalidate.
   - `usePollRevalidate` (3–10s) fires revalidations on live pages: poll gaps exceed the 400ms grace so settle still completes between ticks; consider an option to ignore revalidation-class activity if it flakes in practice.
   - HMR-orphaned fetchers (vb-fable: false negatives) — filter/cap stale non-idle fetchers in the activity read.
3. **RR7 routes** — prefer reading the live router's route tree via the adapter (runtime truth) over parsing `app/routes.ts` statically; fall back to the static walker for Next.
4. **Kit adapter, project-local** — `@versable-git/ui` modal-store + toasts are Versable-specific → this motivates the general **project adapter path**: `.fiber-snatcher/adapter.js`, injected by the daemon as a third addInitScript, calling `window.__fs.register()` (+ activity registry). Also feed `adapt.surfaceSelectors`/`overlayComponents` for kit modal/toast surfaces.
5. **Playground** — with kit adapter + adapt config it likely reaches full functionality; no TanStack to miss, Next routes verb already works, no auth. Settle falls back to mutation/network signals (validate on the live app whether that suffices for RSC navigations).

## vb-fable's wishlist → coverage

- Real settle (nav + fetchers idle): build items 1+2.
- State reads without screenshots: `fs state` today + loaderData via RR7 `getState`.
- Per-session isolated browser profiles: **out of adapter scope** — V2 is one daemon/profile per project (`config.profileDir`); flag as its own design question (the shared-profile mutation-bleed complaint).
- Kit-staleness detection (served `?v=` module vs disk): candidate `fs doctor` probe reusing `check-kit-link.mjs` logic — nice-to-have, separate item.

## Reusable assets

- speedway `e2e/support/fixtures.ts` + `global-setup.ts` — auth seeding.
- `tests/integration/versable.ts` — live-daemon integration harness pattern (auto-login, drive-in-place; never restart the daemon mid-session).
