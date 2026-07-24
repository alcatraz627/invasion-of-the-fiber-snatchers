# Bloop 2 validation report — React Router adapter (commits b668a09, 06fe44d)

<!-- sessions: fiber-snatcher-adapter@2026-07-25 · validator: bloop2-gate (sonnet, worktree @06fe44d) -->

Verdict: **ISSUES-FOUND** (3 blocker, 2 major, 1 minor + one mutation-exposed coverage gap).
All repros against isolated tmp daemons; zero Versable/live-daemon/port contact; worktree left clean.
Full validator text in the session transcript; condensed faithfully here.

## Findings → dispositions

| # | Sev | Finding | Disposition (fix commit 5270553) |
|---|-----|---------|----------------------------------|
| 1 | blocker | A throwing `router.state` getter aborted ALL discovery (TanStack/jotai too), silently — doctor then misdiagnosed ("none discovered", "likely a syntax error") | **Fixed**: discovery branch wrapped in try/catch; hostile-router e2e guard asserts TanStack still discovered |
| 2 | blocker | HMR swap of the router global left the adapter bound to a dead router: false navigate success, live loader activity invisible to settle | **Fixed**: identity re-check every discovery call re-binds; hot-swap e2e guard |
| 3 | blocker | Unguarded subscribe callback could throw inside the router's own notify loop (non-Map fetchers) and abort the router's sibling work mid-transition | **Fixed**: callback body wrapped; fetcher iteration tolerates plain-object shapes. The validator's RR7-side caveat (whether real RR7 wraps its notify) stays UNCONFIRMED — our side no longer throws regardless |
| 4 | major | 30s orphan exclusion silently un-counts a genuinely slow (>30s) action from settle | **Fixed by remount-gating**: exclusion now also requires a hot-reload remount since the fetcher was first seen — a slow upload with no remount keeps blocking settle honestly. No knob added |
| 5 | major | Next-vs-RR7 discriminator accepted a lone `page.tsx` (false positive: RR7 tree + coincidental page.tsx swallowed all routes) | **Fixed**: root `layout.*` only (mandatory in Next); wp7's fake tree gained its layout |
| 6 | minor | Cyclic route table → stack overflow swallowed into a misleading `router:"none"` | **Fixed**: visited-set + depth cap 16 → truncated list instead |
| E2 | gap | Deleting the `started++` edge counter left every test green | **Fixed**: deterministic sub-poll blip guard driving the fake's `_notify` — a full loading→idle cycle inside one poll gap must bump `started` |

Validated clean by the gate: reserved-name completeness (guard exactly matches what discovery can set),
06fe44d doesn't over-filter custom names, `matches` guard, flapping fetchers never orphan-excluded
(correct-by-design), E1 mutation (routerRoutes zeroed → routes test red → restored green).
Noted, pre-existing: router discovery is uncapped while fiber-walk discovery caps at 8 tries.

Post-fix regression: router 6/6, adapters 9/9, wp2/wp7/smoke/wp3a all green, tsc clean.

## Honest residuals
- Real-RR7 notify-wrap behavior UNCONFIRMED (our guard makes it moot for our side).
- Orphan exclusion still has no hermetic test (30s window; now also needs a real remount) — logic
  gate-audited, remount-gating makes the false-exclusion case strictly narrower.
- jobs→detail on speedway unexercised on real data (empty test workspace) — vb-fable's battery covers it.
