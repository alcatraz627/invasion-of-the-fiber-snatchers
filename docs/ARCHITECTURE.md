# Architecture

How Fiber Snatcher is put together, and why each piece exists. Read this when you're about to change internals — not for day-to-day use.

## System diagram

```
┌───────────────────────────────────────────────────────────────────────┐
│                         Claude (agent loop)                            │
└───────────────────────────────────────────────────────────────────────┘
       │                      │                          │
   MCP calls            Bash: fiber-snatcher …      Read .fiber-snatcher/*
       │                      │                          │
  ┌────┴──────┐          ┌────┴──────┐             ┌────┴───────────┐
  │ playwright│          │  CLI      │             │ .fiber-snatcher│
  │ chrome-dt │          │  (Bun)    │────writes──▶│   last-run.json│
  │ next-dt   │───┐      └────┬──────┘             │   logs/*.jsonl │
  └───────────┘   │           │ IPC (unix sock)    │   shots/*.png  │
                  │           ▼                     │   config.json  │
                  │  ┌──────────────────┐          │   auth/dev-key │
                  │  │   daemon.ts      │          └────────────────┘
                  │  │ (long-running)   │
                  │  │ ┌──────────────┐ │
                  │  │ │ Playwright   │ │
                  │  │ │ persistent   │◀┼─────── CDP events
                  │  │ │ context      │ │        (console/pageerror/network)
                  │  │ └──────────────┘ │
                  │  │ ┌──────────────┐ │
                  │  │ │ IPC server   │ │ newline-JSON ops:
                  │  │ │ (net socket) │ │   state, dispatch, eval,
                  │  │ └──────────────┘ │   shoot, goto, info, close
                  │  │ ┌──────────────┐ │
                  │  │ │ log writer   │──writes──▶ daemon-YYYY-MM-DD.jsonl
                  │  │ └──────────────┘ │
                  │  └────────┬─────────┘
                  ▼           │
        ┌──────────────────────┴──────────┐
        │       Target Next.js app         │
        │                                  │
        │  ┌────────────────────────────┐  │
        │  │ window.__snatcher__        │  │   installed by
        │  │  • state()  • dispatch()   │◀─┼─ .fiber-snatcher/runtime/
        │  │  • route()  • logs()       │  │   expose.ts (dev-only import)
        │  │  • register(name, adapter) │  │
        │  └────────────────────────────┘  │
        │                                  │
        │  ┌────────────────────────────┐  │   POST entries to
        │  │ app/_fs/log/route.ts       │──┼─▶ .fiber-snatcher/logs/
        │  │ (dev-only route)           │  │   browser.jsonl
        │  └────────────────────────────┘  │
        │                                  │
        │  ┌────────────────────────────┐  │   reads .fiber-snatcher/
        │  │ auth bypass                │◀─┼─ auth/dev-key; compares
        │  │ (middleware / proxy.ts /   │  │   X-Fiber-Snatcher-Key
        │  │  NextAuth callback)        │  │   via timingSafeEqual
        │  └────────────────────────────┘  │
        └──────────────────────────────────┘
```

## The three surfaces, and why each is separate

### 1. MCP servers (`playwright`, `chrome-devtools`, `next-devtools`)

**Why:** Claude already knows how to call MCP tools. Reusing existing MCP servers for the breadth of browser-control tasks means we don't reinvent click / performance traces / build-error extraction.

**What's routed through MCP:** cross-browser testing, performance profiling, route enumeration, server-action discovery, anything CDP-heavy that's generic.

### 2. Fiber Snatcher CLI (`fiber-snatcher`)

**Why:** MCP tools express *mechanisms* (click, evaluate, screenshot) but not *idioms* (read state at selector, dispatch an action, get a grouped error digest). Every repeated idiom the agent reaches for becomes its own CLI subcommand. Correct technique encoded once, invoked many times.

**Cost of adding a subcommand:** low — each lives in `src/cli/<name>.ts`, dispatcher auto-discovers.

**Design constraint:** every subcommand returns a uniform `Result<T>` and persists it to `.fiber-snatcher/last-run.json`. Claude can read the structured outcome even if stdout was clipped or colorized.

### 3. Runtime inject (`window.__snatcher__`)

**Why:** The CLI needs a stable in-page API rather than walking `__reactFiber$…` every turn. `window.__snatcher__` provides:

- `state(selector?)` — fiber walk encapsulated, returns a clean JSON snapshot
- `dispatch(action, opts?)` — routes through a registered adapter (Zustand/Redux/…)
- `register(name, adapter)` — the extension point for V1.1 adapters
- `log(entry)` — explicit app-side logging that lands in the unified stream
- A `version` field so CLI + runtime skew can be detected

**Dev-only:** installed inside a `process.env.NODE_ENV === "development"` gate. Never ships to production.

## The daemon: one process, three jobs

`fiber-snatcher start` spawns `src/daemon.ts` detached. That single process holds:

- **One Playwright persistent context** (stored at `.fiber-snatcher/browser-profile/`), headful, with `X-Fiber-Snatcher-Key` auto-attached as an HTTP header for every request.
- **One IPC server** on a Unix-domain socket at `.fiber-snatcher/control.sock`. Accepts newline-delimited JSON. Each op (`state`, `dispatch`, `eval`, `shoot`, `goto`, `info`, `close`) is handled synchronously against the current page.
- **One log stream writer** appending to `daemon-YYYY-MM-DD.jsonl`. Subscribes to Playwright's `page.on("console" | "pageerror" | "response" | "requestfailed")` events.

### Why IPC instead of HTTP

An HTTP server on a port would collide with the dev server's port choice, conflict with other tools, and require port allocation. Unix sockets are collision-free (file-backed), permission-scoped to the user, and faster. Sub-50ms round-trip vs ~1.5s for cold-launching a fresh Playwright context per command.

### Why persistent, not isolated

Agent debug loops need login state, cookies, localStorage to survive between commands — otherwise every `state` call restarts at the login page. Persistent context mirrors how a human keeps Chrome open across tasks. Isolated mode is available as a future opt-in for fresh-slate scenarios.

## The auth-bypass contract

**Invariant:** a local dev-only header authenticates any request as a seeded dev user.

- Key: 32 random bytes, hex-encoded, stored at `.fiber-snatcher/auth/dev-key` mode 0600, generated at `init` time.
- Header: `X-Fiber-Snatcher-Key`.
- Verification: constant-time comparison (`crypto.timingSafeEqual`) inside the project's middleware/proxy/NextAuth callback — pattern examples in USAGE.md §3.
- Gate: `process.env.NODE_ENV === "development"` — the bypass module is a no-op in production.

**Why project-owned, not Fiber Snatcher-owned:** every auth stack is different (NextAuth, Clerk, custom proxy, edge middleware). Rather than shipping a patch that fits none, we define the contract and ship three template snippets. The project applies the one matching its auth layer.

## Unified logging

Four distinct signal sources feed the log stream:

| Source           | Level(s)        | Origin                                               |
| ---------------- | --------------- | ---------------------------------------------------- |
| `cdp-console`    | debug→error     | Playwright `page.on("console")` — everything from `console.*` in the page |
| `cdp-pageerror`  | error           | uncaught exceptions reaching `window` |
| `cdp-network`    | error           | `response` with status ≥ 400, `requestfailed` events |
| `react` / `browser` | debug→error  | app-side via `window.__snatcher__.log()` + wrapped console.error/warn |

All four merge into `.fiber-snatcher/logs/daemon-YYYY-MM-DD.jsonl`. Plus a separate `.fiber-snatcher/logs/browser.jsonl` written directly by the Next.js route handler — used when the daemon is down.

`fiber-snatcher errors` reads the full set, filters to warn+, groups by body signature, returns the top-30 by frequency with latest timestamp and source mix. Cuts "I see 40 error lines" to "I see 3 root causes."

## File layout

```
invasion-of-the-fiber-snatchers/
├── bin/
│   └── fiber-snatcher.ts       # dispatcher, subcommand routing, JSON output
├── src/
│   ├── cli/                     # one file per subcommand, each exports `run(args)`
│   │   ├── init.ts              # scaffolds target project
│   │   ├── start.ts             # spawns daemon detached
│   │   ├── stop.ts              # graceful → SIGTERM → SIGKILL escalation
│   │   ├── status.ts            # aliveness + IPC info probe
│   │   ├── doctor.ts            # probe battery
│   │   ├── state.ts             # IPC state op
│   │   ├── dispatch.ts          # IPC dispatch op, reads stdin JSON
│   │   ├── eval.ts              # IPC eval op (escape hatch)
│   │   ├── shoot.ts             # IPC shoot op
│   │   ├── errors.ts            # reads logs, groups, returns digest
│   │   ├── logs.ts              # tails JSONL
│   │   ├── auth.ts              # key / rotate / snapshot
│   │   └── clean.ts             # stale pidfile / socket / old logs
│   ├── core/
│   │   ├── result.ts            # Result<T>, ok/err, renderer, last-run.json writer
│   │   ├── config.ts            # FsConfig type, load/write, requireConfig
│   │   ├── paths.ts             # resolveTargetRoot (walks up for package.json)
│   │   ├── pm.ts                # npm/pnpm/bun/yarn detection
│   │   ├── ipc.ts               # sendRequest + startServer over Unix socket
│   │   └── browser.ts           # openPersistent, controlSocketPath
│   ├── inject/                   # copied into target at `.fiber-snatcher/runtime/`
│   │   ├── expose.ts             # window.__snatcher__
│   │   ├── log-sink-route.ts     # Next.js route handler
│   │   └── devtools-hook.ts      # react-devtools-core loader
│   └── daemon.ts                 # long-running browser owner
├── mcp-template.json             # merged into target .mcp.json at init
├── scripts/install.sh            # PATH symlink installer
├── docs/
│   ├── ARCHITECTURE.md           # this file
│   └── TROUBLESHOOTING.md        # extracted from USAGE.md
├── README.md                     # public entry point
├── USAGE.md                      # target-project setup
├── CLAUDE.md                     # agent operating rules
└── CHANGELOG.md                  # version history
```

## Error-handling philosophy

Every failure surface is a `Result<T>`:

```ts
{ ok: false, code: "E_*", message: "…", context?: {…}, next_steps?: ["…"], exitCode?: 1|2|3|4 }
```

- **Stable `code`** — Claude / other callers branch on these without parsing messages.
- **Curated `next_steps`** — each error's recovery is pre-written; no guesswork required per call.
- **Exit-code mapping** — `1` user error, `2` environment misconfig, `3` target-app error, `4` internal bug. Lets shell scripts do the right thing.
- **`context` for structured details** — selector counts, stack snippets, retry hints. Never stuff context into `message`.

## What's deliberately NOT in V1

- **Multi-tab coordination** — one page per daemon. V1.1+.
- **Visual diff** — `shoot` saves a PNG; comparison is the agent's job.
- **Adapter auto-detection** — apps register adapters explicitly; we don't guess.
- **Production-build support** — the fiber DOM keys go away, the bypass is disabled, the log sink returns 403. This tool is for `next dev` only.
- **Remote targets** — local filesystem paths, local sockets. No "debug a deployed staging."

Each exclusion is a scope choice, not an oversight.

## Design decisions worth revisiting later

1. **One daemon per target project.** If you want two projects open simultaneously, you run two daemons — each under its own `.fiber-snatcher/`. Fine in practice but would need work if we ever merge them.
2. **Injecting runtime files by copy, not by npm install.** Simpler bootstrap but makes runtime upgrades manual (user re-runs `init`). A future V1.1 could publish `@fiber-snatcher/runtime` on npm and replace the copy with an install.
3. **Auth-bypass shape (header).** Cookies would auto-attach better for server-rendered flows but add more surface area. Header is simpler and works for both fetch and Playwright's `extraHTTPHeaders`.
4. **Unix socket instead of named pipe / HTTP.** Zero-collision, zero-port-allocation, but Windows compatibility is zero. V1 is macOS+Linux explicitly.
