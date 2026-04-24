# Changelog

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
