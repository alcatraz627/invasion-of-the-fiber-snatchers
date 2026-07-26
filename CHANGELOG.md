# Changelog

## [2.2.0] — 2026-07-27

### Adapter round: project adapters, generalized settle, lifecycle fixes

Driven by enabling two non-TanStack Versable apps (playground, speedway). 190 tests.

**New capability:**
- Project-local adapters: `.fiber-snatcher/adapter.js` is injected on every
  document after the runtime; `window.__fs.register(name, adapter)` survives
  reloads for free. Size-capped; broken files fail in isolation; `doctor` gains
  `project-adapter` and `activity` probes.
- Generalized settle: any adapter carrying `activity(): {pending, started}` feeds
  `wait --settled` and the per-verb drain (TanStack is now just source #1).
- Native `<dialog>` is a first-class surface (`dialog[open]` in the selector,
  `dialog:<label>` keys) — implicit-ARIA modals digest like role=dialog ones.
- Built-in React Router adapter: discovered from the dev build's
  `window.__reactRouterDataRouter`, navigation + fetcher activity feeds
  `--settled` (hot-reload-orphaned fetchers are remount-gated out), dispatch
  `list`/`navigate`/`revalidate`, and `routes` answers from the live route
  table on non-Next apps (the Next tree is now discriminated by its mandatory
  root layout).
- Hidden file inputs (the dropzone pattern) are listed in `fs page` with
  `hidden: true`, so `upload` has a discoverable target.

**Hardening (two adversarial-gate rounds, all findings fixed + pinned):**
- `register()` rejects the reserved names `queries`/`jotai`/`router` (clobber
  displaced the real TanStack wiring and doctor's filter hid it).
- Activity reads coerced + clamped — a NaN/stringly/negative count from one
  adapter jammed every settle wait on the page forever.
- Throwing `activity()` sources read as idle but are named by a doctor warn.
- Router discovery is guarded and identity-rechecked: a throwing state getter
  can't blind the rest of discovery, and a hot-swapped router global re-binds
  instead of reporting false navigation success; the subscribe callback can't
  throw into the router's own notify loop; cyclic route tables truncate.

**Lifecycle:**
- The frozen V1 CLI's `stop`/`status`/`clean` now see V2 daemons (`RUNNING_V2`,
  clean SIGTERM stop, stale-file sweep) instead of reporting not-running while
  one holds the browser.

**Lifecycle fixes:**
- `fs stop` waits for actual daemon death (the ack-then-race lost the next verb's
  navigation); the pidfile is an exclusive-create boot lock taken before Chrome
  opens, with ownership-checked cleanup.
- `smoke` pins runtimeVersion to the source constant instead of a stale literal.

## [2.1.0] — 2026-07-05

### Follow-up round: adaptation, perf, hardening, live-app testing

Built on 2.0.0 after a live dogfood on the Versable app surfaced gaps. 186 tests
(173 fixture e2e/unit/protocol + 13 live-app integration).

**New capability:**
- Per-project adaptation (`adapt` config: `surfaceSelectors`, `overlayComponents`,
  `contentPropKeys`) so the tool tracks non-ARIA overlays and reads a codebase's
  own conventions instead of assuming ARIA.
- `why` verb + un-rendered signal reader: recovers a closed dropdown/tooltip's
  content from ancestor fiber props without opening it (React evaluates the menu
  element at the parent's render, so it's a readable prop value while closed).
- `fs init` wired on the V2 CLI; version stamp, `watch`/`init` in help, macro
  `expect`-footgun guard.
- Live-app integration test (`tests/integration/`): drives a real running dev app
  through its authenticated session, with optional hands-free auto-login.

**Performance:**
- Settle drain-first: ~166ms → ~65ms on a quiet action.
- CLI startup: ~130ms → ~31ms per `fs` call (Playwright loaded lazily, only in
  the daemon).

**Hardening (adversarial red-team):** per-fiber try/catch so one throwing prop
getter can't blind the whole page; adapt-config sanitization (min token length,
structural-key deny-list, surface plausibility); byte-bounded string extraction.

## [2.0.0] — 2026-07-04

### V2: the agent-first rebuild

Ground-up rework around one action pipeline (resolve → wait → act → settle →
digest → journal). Built from a 3-track research phase (architecture map,
205-invocation usage mining, external agent-tooling research) and an 8-package
fleet build, each package independently reviewed and merged. 158 tests
(unit + protocol + e2e through the real CLI→daemon→browser path).

**Breaking / superseding:**
- New CLI `fs` (old `fiber-snatcher` CLI remains, frozen, for V1 projects).
- Page runtime is CDP-injected at daemon boot — the bundle-copied
  `.fiber-snatcher/runtime/expose.ts` integration is obsolete in V2 (a compat
  shim still accepts `__snatcher__.register`).
- V2 daemon uses `control-v2.sock` + `daemon-v2.pid`; detects a live V1 daemon
  and refuses with a remedy instead of fighting for the browser profile.

**Core:**
- Refs: `fs page` mints `e<seq>.<docTag>` refs; stale refs fail explicitly.
- Digests: every mutating verb reports mutations/surfaces/focus/counts/url/
  queries — dead clicks are visible; unobservable settles say "unknown".
- Targeting: intent text, fiber component expressions, CSS, refs — ambiguity
  returns ranked candidates (role, label, component, confidence) in one trip.
- Waits: auto-wait + settle in every verb; `wait --settled|--text|--gone|
  --url|--network-idle|--call`; `--settled` post-condition closes the
  debounce hole via a monotonic query-start counter. Zero sleeps anywhere.
- Adapters: TanStack Query + jotai discovered from the fiber tree, zero
  app-side code.

**Verbs:** hover/dblclick/rclick/drag(dual-path)/scroll/type/chord ·
select/upload/paste/resize · verified `dismiss` (alias `close`) ·
queries/atoms/dispatch/count · mock/unmock/throttle/wait-call/watch ·
doctor/routes/remount · shoot (ring-buffered) / look (local vision) / record.

**Flows:** YAML macro library at `~/.claude/fiber-actions/<repo-key>/`,
`macro from-journal`, parameterized replay (`by name|index|random|id`, `%var%`),
sessions with expect assertions, probe store. Journal redacts password-field
fills (documented limits).

**Telemetry profiles:** explore | debug | verify | minimal — output shape,
screencast ring, and fail-on-error behavior follow the profile.

**Deliberately not done (decisions, not gaps):** wire cmd stays `close`
internally (verb is `dismiss`, alias covers `fs close`); `chord` and `press`
both exist; `press --verify` unbuilt (use `dismiss`). Push-plumbing
follow-ups (per-subscriber push, watch GC on disconnect) and type-accurate
journal redaction are logged in reports/WP6.md and WP4.md for a future
contract-review round.


## [0.4.1] — 2026-05-28

### Quality-of-life: dev-server-restart recovery

Additive release — no breaking changes.

**New — `fiber-snatcher refresh`:**
Navigate the daemon's tab back to the configured `devUrl`. The daemon's
Chromium is a long-lived process and doesn't track dev-server liveness; an
`npm run dev` restart routinely parks the open tab on
`chrome-error://chromewebdata/`, and every subsequent `state` / `eval` read
against that page returns meaningless errors. `refresh` is the one-line
recovery.

```sh
fiber-snatcher refresh    # → page.goto(cfg.devUrl)
```

For an explicit URL, `navigate <path>` still works.

**Improved — `fiber-snatcher doctor` chrome-error detection:**
When the daemon's `page-url` is `chrome-error://*`, doctor now marks the
probe `ok: false` with an actionable detail (`Run \`fiber-snatcher refresh\` …`)
and **skips the downstream `debug-surface` and `adapters` probes**. Those
probes can only false-negative on an error page — the install isn't really
broken, the tab just needs to navigate back. Skipping them surfaces one
clear next step instead of a three-line cascade of red herrings.

```
page-url    ok=false  chrome-error://chromewebdata/ — daemon's tab is on
                      an error page (typically a dev-server restart parked
                      it here). Run `fiber-snatcher refresh` to navigate
                      back to http://localhost:3006; probes below this
                      depend on the page and are skipped until you do.
```

## [0.4.0] — 2026-04-24

### New inspection primitives from the V0.3.2 feedback round

Additive release — no breaking changes, all V0.3.x commands continue to work.

**New — `fiber-snatcher components <displayName>`:**
Enumerate all mounted fibers whose component type has matching `displayName`. Replaces the ~30-line eval script every agent writes when diagnosing mount-count bugs.

```sh
fiber-snatcher components PreviewFileModal          # full info: paths + props
fiber-snatcher components PreviewFileModal --count  # integer only
fiber-snatcher components PreviewFileModal --shallow --limit 50
```

Flags: `--count`, `--shallow`, `--full`, `--limit <N>`. When the name resolves to >1 distinct component type reference (same name, different imports), output includes a `warning` field so agents can disambiguate by props.

**New — `fiber-snatcher portal <portalId>`:**
`document.getElementById(portalId)` + fiber-aware origin walk. For debugging "why does this portal container have N children" stacking bugs.

```sh
fiber-snatcher portal modal-toolbar              # DOM snapshot + React portal sources
fiber-snatcher portal modal-toolbar --dom-only   # faster, skip fiber walk
fiber-snatcher portal modal-toolbar --count
```

The fiber-aware path walks fibers whose `tag === HostPortal` (4) and whose `stateNode.containerInfo === el` and emits a `componentPath` for each. If fiber walk fails, falls back to DOM-only — never crashes.

**New — `fiber-snatcher count <selector>`:**
`document.querySelectorAll(selector).length`. Plain integer to stdout without `--json`. Returns `E_BAD_SELECTOR` on invalid CSS.

```sh
fiber-snatcher count 'input[placeholder="Search"]'
# → 3
```

**New — `fiber-snatcher atoms watch <name>`:**
Polls a Jotai atom at `--interval` ms (default 200) and emits JSONL on each change. Terminates on `--timeout <ms>`, Ctrl-C, or page navigation.

```sh
fiber-snatcher atoms watch selectedModalId
# {"ts":"…","name":"selectedModalId","value":null}
# {"ts":"…","name":"selectedModalId","value":"preview_file_output"}
# {"ts":"…","event":"closed","reason":"navigation","url":"/other/page"}
```

Implementation is polling-based (no IPC protocol change). Future: streaming when we add request/multi-response IPC.

**Changed — eval handles top-level await + return together:**
Surfaced by the V0.3.2 harness addendum. The V0.3.1 transpile pipeline rejected `const x = await ...; return x;` because Bun's `target: "browser"` treats top-level `await` as a module marker, which then forbids top-level `return`.

Fix: detect `\bawait\b` in the pre-wrapped source; if present, pre-wrap the entire payload in an async IIFE before transpile (so return/await become function-scoped), then skip the CLI's outer async wrap (output is already an IIFE expression). Also switched default target from `browser` to `bun` for the same reason.

No behavior change for sync code. Top-level await scripts that already worked still work; this patch just permits the combination.

**Changed — `scripts/check-versions.ts` runs the eval harness in `prerelease`:**
Release gate now runs `bun tests/eval-harness.ts` in addition to version-drift check + typecheck. 16-case suite covers V0.3.1 14 cases + V0.4.0 top-level-await regressions.

**Breaking: none.**

**Migration:** `git pull && bash scripts/install.sh && fiber-snatcher init --force` (auto-reloads the browser). Adapter files unchanged.

## [0.3.1] — 2026-04-24

### V0.3.0 retest fixes — eval regression, fill footgun, version drift

Shakedown of V0.3.0 against the real target app surfaced three issues. All fixed:

**P1 — eval-as-query broken for `assign-then-reference` (feedback v030 #5 regression):**
- `const x = 42; x` returned `{ok: true}` with no data in V0.3.0 — my line-by-line `wrapForReturn` heuristic bailed out on any line starting with `const`/`let`/etc., missing the trailing identifier.
- Rewrote to a **depth-aware splitter** that walks the source tracking bracket depth and string state, finding the last `;` or `\n` at depth 0 outside strings. Wraps everything after the split as the return value.
- Handles: literals, identifiers (`const x = 42; x`), TS decls, multi-line code, strings with embedded `;`, IIFEs, paren-wrapped expressions, trailing comments.
- Added 14-case unit test suite to `scripts/`-adjacent harness. All pass.

**P2 — `click`/`fill`/`press` silently first-match on ambiguous selectors (feedback v030 #2):**
- `fill 'input[placeholder="Search"]' "hello"` would silently hit the first match — usually the navbar global search, not the page-specific input the agent meant to target.
- Drive commands now count matches first; if >1 and no `--nth`, return `E_SELECTOR_AMBIGUOUS` with the first 5 candidate labels (innerText / `name` / `aria-label` / `placeholder` / tag+id).
- Added `--nth <N>` (0-indexed) to `click`, `fill`, `press` for explicit targeting. Matches Playwright's `locator` strictness defaults.

**P3 — `RUNTIME_VERSION` drift (feedback v030 #12):**
- CLI reported `0.3.0` but `expose.ts` still announced `v0.2.0`. Bumped the constant to `0.3.1`.
- Added `scripts/check-versions.ts` that fails loudly if `package.json.version !== RUNTIME_VERSION`. Wired into a `prerelease` npm script — run `bun run prerelease` before any push that publishes.

**P3 — `init --force` auto page-reload (feedback v030 #13):**
- Previously, re-running `init --force` on a running daemon copied the new `expose.ts` to disk but the browser kept executing the old bundle until the next navigation. Agents saw stale behavior without knowing why.
- `init --force` now sends a `page.reload()` over IPC if the daemon is up. If reload fails, emits a warning pointing the user at `fiber-snatcher navigate <path>` as the manual fix.

No API changes otherwise. Safe in-place upgrade: `git pull && bash scripts/install.sh && fiber-snatcher init --force` (which will auto-reload the browser). Existing adapters unchanged.

## [0.3.0] — 2026-04-24

### From the V1.1 integration shakedown — eval becomes a query, drive commands land, state trims noise

**Decision:** eval is now Path A — a query primitive. Agents write TS by reflex, so the `.ts` suggestion in help text now actually works.

**New — drive commands (feedback #6):**
- `click <selector>` — Playwright click through the real input pipeline (React synthetic events fire correctly).
- `fill <selector> <value>` — sets value and dispatches `input`/`change` with bubbling so React controlled inputs pick it up.
- `press <key> [--selector <sel>]` — keyboard press, Playwright notation (`Enter`, `Shift+Tab`, `Meta+A`). With `--selector` focuses the element first; without, acts on current focus.
- `navigate <url-or-path>` — `page.goto`; relative paths resolve against the daemon's devUrl. Replaces the `eval "location.href = …"` antipattern that nuked any window-installed trace.

**Changed — eval is now a query (feedback #4, #5):**
- `.ts` source is transpiled via `Bun.Transpiler` before evaluation — no more `Unexpected token ':'` on type annotations.
- The last expression is returned as the result `data` (or use explicit `return x;` at the top level). Previously the value was swallowed and agents had to exfiltrate via `console.log("PREFIX:…") + grep`.
- Scripts still run in an async IIFE so `await` at the top level works.
- Pure side-effect scripts (no trailing expression) return `undefined` cleanly.

**Changed — `state` output now trims React internals by default (feedback #7):**
- Keys like `_owner`, `_store`, `$$typeof`, `debugTask`, `debugStack`, `debugLocation`, `debugInfo`, `_debugSource` are stripped from snapshots. Typical output dropped from ~100KB → ~5KB on a real app.
- `--full` flag brings them back for cases where you *do* want React internals.
- `--shallow` caps snapshot depth at 2 for very nested trees.

**Changed — log sink 404 probe (feedback #9):**
- On the first `.log()` call the runtime does `HEAD /_fs/log` once. If it's 404, the sink is marked disabled and no further POSTs fire. Eliminates the network-panel noise when the optional sink route isn't wired.

**Fixed — `queries list` / `atoms list` accepted (feedback #2):**
- Both CLIs now accept `list` as a no-op subcommand, matching the help text. Agent muscle-memory `<cmd> list` no longer crashes.

**Fixed — help output column alignment (feedback #13):**
- Re-laid out as LIFECYCLE / INSPECT / DRIVE / CAPTURE / CARE sections. No more overflow.

**Obsolete — eval-via-console-log workaround:**
- Removed from the CLAUDE.md operating rules. Use the new return-value channel.

**Migration from 0.2.x:** `git pull && bash scripts/install.sh`. Runtime version is now `0.3.0` — re-run `fiber-snatcher init --force` in any initialized target project to copy the new `expose.ts` (with React-internal stripping + sink probe). Existing adapter files don't need re-copying.

## [0.2.1] — 2026-04-24

### Bug fixes from first real-app shakedown

- **`shoot --name <n>` IPC timeout.** `shoot.ts` was treating the value of `--name` as a positional CSS selector; Playwright then hung waiting for a matching element. Fixed by excluding known flag values from positional parsing. (Bug #2)
- **`init` silently overwrites `.mcp.json`.** Projects that follow a "MCP disabled at rest" pattern were losing their empty `mcpServers` policy on init. Fixed: existing `.mcp.json` is now left untouched; re-run with `--force-mcp` to merge the template, or `--no-mcp` to skip entirely. (Bug #3)
- **`jotai.ts` TS2698 spread of possibly-truthy unknown** at line 98. Replaced conditional-spread pattern with explicit ternary. (Bug #1)

No API changes. Safe to upgrade in place: `git pull && bash scripts/install.sh`. Projects initialized at 0.2.0 don't need to re-run `init` (the adapter file fix only affects tsc in consumer projects).

## [0.2.0] — 2026-04-24

### V1.1 — Jotai + TanStack Query adapters

**New.** First-class adapters for the two state libraries most common in Next.js apps today. Shipped as copied runtime files — no npm dep, no patch to app code beyond a one-time registration block.

**CLI additions:**
- `fiber-snatcher atoms [name] [value-json]` — list, get, set Jotai atoms by `debugLabel`. Delegates to the adapter registered as `jotai`.
- `fiber-snatcher queries [sub] [key-json] [data-json]` — `list`, `get`, `invalidate`, `refetch`, `reset`, `setData` for TanStack Query. Delegates to the adapter registered as `queries`.

**Runtime changes:**
- `window.__snatcher__.dispatch` is now **async-aware** — awaits adapter return values so TanStack Query's promise-returning ops (invalidate/refetch/reset) resolve cleanly.
- `dispatch` now returns the adapter's raw result rather than `{before, after, changed}`. Use `state`/`atoms`/`queries` for read-back. Simpler shape, works for both sync and async adapters.
- Runtime version bumped to `0.2.0`. `__snatcher__.version` is the source of truth.

**Inject files added:**
- `.fiber-snatcher/runtime/adapters/jotai.ts` — `createJotaiAdapter({ store, atoms? })`
- `.fiber-snatcher/runtime/adapters/tanstack-query.ts` — `createTanstackQueryAdapter({ client })`

**Breaking change (minor):** the generic `dispatch` CLI no longer returns `{before, after, changed}`. Callers that branched on `changed` should read state explicitly after dispatch.

**Migration from 0.1.0:** re-run `fiber-snatcher init --force` in any initialized target project to copy the new adapter files and refresh `expose.ts`. Or copy `src/inject/adapters/*.ts` manually into `.fiber-snatcher/runtime/adapters/`.

## [0.1.0] — 2026-04-24

### V1 — initial release

**Scope:** Local-only React / Next.js dev-app debugging toolkit for Claude Code and other coding agents.

**CLI commands shipped:**
- `init` — scaffold `.fiber-snatcher/` in a target project, merge `.mcp.json`, generate auth key
- `start` / `stop` / `status` — daemon lifecycle
- `doctor` — end-to-end probe battery
- `state [selector]` — read React state/props/hooks for nearest stateful fiber
- `dispatch` — stdin-JSON action routed through a registered store adapter
- `eval <file> --yes-i-know` — escape-hatch page-context eval
- `shoot [selector] --name` — deterministic-path screenshots
- `errors --since` — grouped error digest
- `logs -f --source --level` — unified JSONL tail
- `auth key / rotate / snapshot` — bypass-key management
- `clean --prune-logs` — stale state teardown

**Runtime inject:**
- `window.__snatcher__` — `state`, `dispatch`, `route`, `log`, `logs`, `register`, `adapters`, `version`
- In-page console wrap + window error capture forwarded to `.fiber-snatcher/logs/browser.jsonl`
- Next.js route handler `app/_fs/log/route.ts` for server-side log persistence
- Optional `react-devtools-core` loader for tier-1 hook access

**Architecture:**
- Single long-running daemon holds Playwright persistent context + Unix-socket IPC + log aggregator
- Sub-50ms IPC round-trip after one-time ~1.5s cold start
- Every command returns uniform `Result<T>` persisted to `.fiber-snatcher/last-run.json`
- Stable error codes (`E_NOT_INITIALIZED`, `E_DEV_SERVER_DOWN`, `E_STATE_FAILED`, …) with curated `next_steps`

**Integrations:**
- `~/.claude/CLAUDE.md` — new section describing detection, lifecycle, and appropriate-use rules
- `~/Code/Versable/enhancement-product/frontend/CLAUDE.md` — local pointer and Pattern-A (proxy.ts) bypass reference

### Known limits

- One page per daemon (no multi-tab coordination).
- `auth snapshot` is a stub; leans on Playwright MCP's `browser_storage_state`.
- MCP versions in `mcp-template.json` are initial guesses — verify with `npm view` before relying.
- First run on a machine needs `npx playwright install chromium`.

## V1.2 — planned

- Daemon poll of `next-devtools-mcp get_errors` — merges build/type/runtime errors into the unified log
- `shoot --wait-for <selector|networkidle>` — wait gate before capture
- Visual-diff helper (`shoot --baseline <name>`, `shoot --compare <name>`)
- Zustand + Redux first-class adapters (today they're in-line snippets in USAGE.md §2a)

## V2 — exploratory

- Bun-compiled single-file binary for `~/.local/bin/`
- Chat REPL (`fiber-snatcher chat`) wrapping all commands with history
- Multi-page coordination (spawn secondary page from main daemon)
- Linux and WSL compatibility pass (V1 is macOS-first)
- Windows support via named-pipe IPC transport (Unix socket → replace)
