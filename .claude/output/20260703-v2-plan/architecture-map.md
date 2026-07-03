# Fiber Snatcher V1 (0.4.1) — Architecture Map for the V2 Redesign

<!-- sessions: fs-v2-map@2026-07-03 -->

Deep-read of the full codebase (~2850 lines: `bin/`, `src/daemon.ts`, `src/core/`,
`src/inject/`, `src/cli/`, docs, tests). Every claim carries file:line. Purpose:
ground the V2 redesign (composite actions, formal sessions, wait-for primitives,
semantic page digest, richer input events, network interception, assertions, run
transcripts).

```
┌──────────────┐  spawn detached   ┌─────────────────────────────────────────┐
│ CLI (Bun,    │──(start.ts:52)───▶│ daemon.ts (long-lived)                  │
│ per-command  │                   │  ├─ Playwright persistentContext        │
│ process)     │◀── NDJSON over ──▶│  │   headful Chromium, 1 page           │
│ bin/fiber-   │  unix socket      │  ├─ IPC server (net.Server, switch/case)│
│ snatcher.ts  │  control.sock     │  └─ log writer → logs/daemon-DATE.jsonl │
└──────┬───────┘                   └───────────────┬─────────────────────────┘
       │ writes last-run.json                      │ page.evaluate / locators
       ▼                                           ▼
 .fiber-snatcher/                    ┌─────────────────────────────────────┐
   config.json  auth/dev-key         │ Target Next.js app (dev only)       │
   shots/*.png  logs/*.jsonl         │  window.__snatcher__  ← expose.ts   │
   browser-profile/  runtime/ ───────┼─ COPIED into app, imported by       │
                                     │  layout.tsx (not Playwright-injected)│
                                     └─────────────────────────────────────┘
```

---

## A. Process model

### Three processes

1. **CLI** — `bin/fiber-snatcher.ts`, a Bun script re-launched per command. Static
   command list (`bin/fiber-snatcher.ts:14-40`), dynamic `import()` of
   `src/cli/<cmd>.ts` (`bin/fiber-snatcher.ts:122-134`), calls the module's
   `run(args)`, renders the `Result`, maps to exit code
   (`bin/fiber-snatcher.ts:151-152`).
2. **Daemon** — `src/daemon.ts`, spawned detached by `start`
   (`src/cli/start.ts:52-57`) with `FS_CONFIG_CWD` in env; the daemon `chdir`s to
   it (`src/daemon.ts:26-27`). Owns exactly one BrowserContext, one Page, one IPC
   server, one log stream (`src/daemon.ts:1-15`).
3. **Chromium** — headful Playwright *persistent* context at
   `.fiber-snatcher/browser-profile/` (`src/core/browser.ts:20-26`), viewport
   1400x900, auth header attached to every request via `extraHTTPHeaders`
   (`src/core/browser.ts:24, 34-39`).

### IPC: newline-delimited JSON over a Unix domain socket

- Socket path: `<target>/.fiber-snatcher/control.sock`
  (`src/core/browser.ts:41-44` — `join(cfg.profileDir, "..", "control.sock")`).
- Wire format: one JSON line request `{id, op, ...}`, one JSON line response
  `{id, ok, data|error, code?}` (`src/core/ipc.ts:13-14`).
- **Strictly one request per connection**: the client closes after the first
  newline arrives (`src/core/ipc.ts:28-41`, `client.end()` at line 34). Default
  timeout 15s (`src/core/ipc.ts:16`). There is no server-push, no streaming, no
  multi-response — CHANGELOG confirms `atoms watch` was built as CLI-side polling
  precisely because of this ("no IPC protocol change... Future: streaming when we
  add request/multi-response IPC", `CHANGELOG.md:85`).
- Rationale documented: unix socket over HTTP to avoid port allocation/collision;
  ~1.5s cold Playwright launch vs sub-50ms socket round-trip
  (`src/core/ipc.ts:5-9`, `docs/ARCHITECTURE.md:96-98`).

### Daemon lifecycle

- `start` (`src/cli/start.ts:20-73`): pidfile-liveness check via `kill(pid, 0)`
  (27-36), dev-server HTTP probe with 1.5s timeout (39-47, 84-95), spawn detached
  with stdio ignored (52-57), write pidfile (59), then **sleep 700ms blind and
  return** (61) — start never confirms the daemon actually booted or the socket
  exists. Verification is punted to `doctor`.
- `stop` (`src/cli/stop.ts:8-33`): graceful IPC `close` op → 400ms → `SIGTERM` →
  400ms → `SIGKILL`, then remove pidfile + socket.
- The daemon self-terminates when the browser window is closed manually
  (`src/daemon.ts:234` — `context.on("close", () => shutdown())`), and cleans
  socket + pidfile on SIGTERM/SIGINT (`src/daemon.ts:223-232`).
- On boot the daemon navigates to `cfg.devUrl` with errors swallowed
  (`src/daemon.ts:34`).

### Startup cost

~1.5s one-time Playwright persistent-context launch (`src/core/ipc.ts:5-8`),
plus the 700ms fixed sleep in `start`. After that, per-command cost is one Bun
process spawn + <50ms socket round-trip. `CLAUDE.md:46` instructs agents: start
once, use many.

### State the daemon holds between commands

Almost none, deliberately and (for V2) problematically:

- The live `page`/`context` objects and CDP event subscriptions
  (`src/daemon.ts:44-70`).
- A `WriteStream` appending JSONL log entries (`src/daemon.ts:39-42`).
- **No session object, no action history, no counters, no per-client state.**
  The IPC handler is a stateless `switch (req.op)` (`src/daemon.ts:72-216`).
- Page-side state lives in `window.__snatcher__`: adapters `Map` and a 500-entry
  log ring buffer (`src/inject/expose.ts:149-150, 78, 157-159`) — this dies on
  every navigation/reload since it's in-page.
- The only cross-command persistence is `.fiber-snatcher/last-run.json`, a single
  file **overwritten by every command** (`src/core/result.ts:39-48`).

---

## B. Command dispatch

### Path of a command (e.g. `click`)

1. `bin/fiber-snatcher.ts:98-137` — validate against `COMMANDS`, dynamic-import
   `src/cli/click.ts`, call `run(rest)`.
2. `src/cli/click.ts:12-27` — hand-parse `--nth` and the positional selector
   (13-16), `requireConfig()` (17), `sendRequest(controlSocketPath(cfg), {op:
   "click", selector, nth}, 10000)` (18), map failure to
   `err(code, ...next_steps)` (20-25), else `ok(res.data)` (26).
3. `src/daemon.ts:87-94` — `case "click"`: `resolveSelector` then
   `locator.click({timeout: 5000})`, return `{clicked, nth, matches}`.
4. `bin` renders the Result and persists `last-run.json`
   (`src/core/result.ts:39-68`).

### Where new commands are added — the touch-point count

Adding a drive-style command today touches **4-5 places**:

1. `COMMANDS` array (`bin/fiber-snatcher.ts:14-40`)
2. `HELP` text block (`bin/fiber-snatcher.ts:43-95`)
3. New `src/cli/<name>.ts` file (~25-40 lines)
4. New `case` in the daemon switch (`src/daemon.ts:74-212`) if a new op is needed
5. If it needs page-side logic: `SnatcherApi` type + implementation in
   `src/inject/expose.ts`, and then **every initialized project must re-run
   `init --force` + reload the browser** to pick it up (see §C).

### Boilerplate per command

Each CLI file repeats the identical skeleton: hand-rolled arg parsing with
`indexOf`/`filter` and per-file "known flag value" sets, `requireConfig`,
`controlSocketPath`, `sendRequest().catch(...)`, error mapping with curated
`next_steps`. Concretely:

- `click.ts` is 27 lines, ~15 of them skeleton (`src/cli/click.ts:12-27`);
  `fill.ts:13-30`, `press.ts:16-36`, `state.ts:6-23`, `count.ts:13-21`,
  `navigate.ts:16-25`, `portal.ts:18-34` are the same shape.
- The flag/positional parsing is duplicated **and divergent** per file:
  `press.ts:21` (`FLAG_VAL` set), `atoms.ts:24`, `queries.ts:30`,
  `components.ts:26`, `shoot.ts:11-18`. This exact duplication already shipped a
  bug: `shoot --name diagnosis` parsed "diagnosis" as a CSS selector and hung
  (Bug #2, fixed by the per-file patch at `src/cli/shoot.ts:8-18`,
  `CHANGELOG.md:169`).
- The daemon side mirrors this with a parallel per-op `case` block, each doing
  its own `(req as any).field` extraction (`src/daemon.ts:87-116` for the three
  drive ops alone).

There is **no shared arg-parser, no shared "send op + map error" helper, and no
middleware seam** between CLI and daemon op. `docs/ARCHITECTURE.md:72` calls the
per-subcommand cost "low", which is true for *isolated* commands and false for
anything cross-cutting (logging, waiting, transcripts — see §G).

---

## C. The inject layer

### How code gets into the page — copy-into-app-bundle, not injection

Critical fact: nothing is injected via Playwright (`addInitScript` is unused).
`init` **copies** `src/inject/*.ts` into the target at
`.fiber-snatcher/runtime/` (`src/cli/init.ts:63-78`), and the target app
imports `expose.ts` from its own `app/layout.tsx` behind a NODE_ENV gate
(`USAGE.md:32-53`). Consequences:

- The runtime is part of the app's dev bundle. Upgrading it means re-running
  `init --force` (re-copy) **and** reloading the page; `init --force` sends a
  `location.reload()` over IPC if the daemon is up (`src/cli/init.ts:145-155`)
  because agents previously saw stale runtime behavior (`CHANGELOG.md:122-124`).
- Version skew is a real, tracked failure mode: `RUNTIME_VERSION` constant
  (`src/inject/expose.ts:77`) vs package version, enforced by
  `scripts/check-versions.ts` in `prerelease` (`package.json:15`) after drift
  shipped in 0.3.0 (`CHANGELOG.md:118-120`).
- Install is idempotent per page load (`src/inject/expose.ts:146-147`), auto-runs
  on import in dev (`src/inject/expose.ts:425-427`).

### How the fiber tree is read

- Fiber handle: find the DOM node's `__reactFiber$*` expando key
  (`src/inject/expose.ts:82-86`); props via `__reactProps$*` (88-92).
- `state(selector?)`: resolve one element, then walk `fiber.return` ancestors up
  to 30 levels, collecting `{component, state, props, hooks}` for stateful
  component fibers (`src/inject/expose.ts:230-267`). Hooks are read by walking
  the `memoizedState` linked list, 100-node guard
  (`src/inject/expose.ts:100-111`).
- `components(displayName)`: scan `document.querySelectorAll("*")`, walk each
  node's fiber ancestry with a `WeakSet` dedupe, match on `displayName`, build
  the component path top-down (`src/inject/expose.ts:301-350`); warns when one
  name maps to multiple distinct type references (343-345).
- `portal(id)`: DOM children snapshot + a fiber walk for `tag === 4` (HostPortal)
  fibers whose `stateNode.containerInfo` is the element
  (`src/inject/expose.ts:352-409`), falling back to DOM-only on failure.
- All output goes through `safeSnapshot`: depth cap (4 default / 2 shallow),
  arrays truncated at 50, functions/symbols stringified, and a
  `REACT_INTERNAL_KEYS` strip list that took real payloads from ~100KB to ~5KB
  (`src/inject/expose.ts:113-143`, `CHANGELOG.md:146-149`).

### Adapter model

- Contract is minimal: `{ getState(): unknown; dispatch(action): unknown }`
  (`src/inject/expose.ts:28-31`).
- Registration: app code calls `window.__snatcher__.register(name, adapter)`
  into a `Map` (`src/inject/expose.ts:294-296`); `dispatch(action, {adapter})`
  routes by name, defaults to the **first registered** (268-275), and awaits the
  result so async adapters work (274).
- `jotai.ts` (`src/inject/adapters/jotai.ts:41-112`): enumerates atoms via the
  unstable dev API `dev4_get_mounted_atoms` with a user-supplied atoms-module
  registry as fallback (52-89); atom addressing is by `debugLabel` (48-50). Ops:
  `list | get | set`.
- `tanstack-query.ts` (`src/inject/adapters/tanstack-query.ts:52-102`): wraps a
  user-supplied `QueryClient`; compact snapshot by default (59-72), ops
  `list | get | invalidate | refetch | reset | setData` (83-98).

### Cost of adding a new adapter

Moderate and well-trodden: (1) a ~100-line factory in
`src/inject/adapters/<name>.ts`; (2) add the filename to `init`'s copy list
(`src/cli/init.ts:73`); (3) user wires a registration block in their dev runtime
file (`USAGE.md:97-135`); (4) optionally a typed CLI wrapper in the
`atoms`/`queries` style (`src/cli/atoms.ts` = 123 lines, `src/cli/queries.ts` =
87 lines — most of it JSON-arg validation). The daemon needs **no change** —
adapter traffic rides the generic `dispatch` op (`src/daemon.ts:177-187`).

### Cost of adding a new page-side capability (mutation observer, query-settled waiter)

This is the steep one. A `waitForQuerySettled()` or MutationObserver facility
would need: `SnatcherApi` type + implementation in `expose.ts`, a daemon op, a
CLI file, `COMMANDS`/`HELP` entries — and then the copy-upgrade dance
(`init --force` + reload) in **every target project**, with version-skew risk in
each. Worse, anything long-running collides with the one-shot IPC protocol
(§A): a page-side observer has no channel to push events out; it could only
buffer in-page (like the log ring buffer) and be polled, exactly as `atoms
watch` polls (`src/cli/atoms.ts:70-122`). There is also a second, parallel
execution context — daemon-side `page.evaluate` (used by `eval`, `shoot`,
drive) — so page capabilities today are split across two surfaces with
different lifecycles.

---

## D. Existing waiting / observation / feedback

### Wait primitives: effectively none

- Drive ops rely solely on Playwright's implicit actionability wait with a
  **hardcoded 5s timeout** (`src/daemon.ts:92, 101, 111`); no flag exposes it.
- `navigate`/`goto` waits for `domcontentloaded` only (`src/daemon.ts:84`); the
  boot navigation swallows errors entirely (`src/daemon.ts:34`).
- No `wait-for <selector>`, no networkidle gate, no query-settled wait.
  `shoot --wait-for <selector|networkidle>` is explicitly on the V1.2 planned
  list, unbuilt (`CHANGELOG.md:243-244`).
- The single observation primitive is `atoms watch` — a **CLI-side** poll loop,
  default 200ms, diffing serialized values, auto-stopping on navigation by
  polling `info` every 5th tick (`src/cli/atoms.ts:70-122`). It exists in this
  shape because the IPC protocol cannot stream (`CHANGELOG.md:85`).

### Action logging / run history: none

- The daemon **does not log incoming IPC ops** — the only daemon-source log line
  is "daemon listening" (`src/daemon.ts:219`). The JSONL logs capture browser
  signals only: `cdp-console`, `cdp-pageerror`, `cdp-network` ≥400s
  (`src/daemon.ts:44-70`) plus in-page wrapped `console.error/warn` and window
  errors (`src/inject/expose.ts:182-226`).
- `last-run.json` is the whole "history": one Result, overwritten per command
  (`src/core/result.ts:39-48`). There is no transcript of what the agent did, in
  what order, with what outcomes.

### Post-action feedback: minimal echo

- `click` → `{clicked, nth, matches}` (`src/daemon.ts:93`); `fill` →
  `{filled, value, nth, matches}` (102); `press` → `{pressed, ...}` (115). No
  post-action state, no settled signal, no URL, no console-delta.
- Notably regressed: generic `dispatch` returned `{before, after, changed}` in
  0.1.x and this was **removed** in 0.2.0 in favor of "read state explicitly
  after dispatch" (`CHANGELOG.md:187-194`) — i.e., V1 moved *away* from
  post-action feedback for simplicity.

### Screenshots

- Saved to `.fiber-snatcher/shots/<name>.png` (`src/cli/shoot.ts:24`,
  `shotsDir` from `src/cli/init.ts:92`); daemon takes full-page or
  first-match-element shots (`src/daemon.ts:195-204`). Return payload is
  `{path}` only — **no metadata** (no URL, timestamp, viewport, selector
  sidecar). Note `shoot`'s element path uses `.first()` — it does NOT go through
  `resolveSelector`, so screenshots silently first-match while drive ops refuse
  to (`src/daemon.ts:199` vs `:90`).
- Visual diff explicitly out of scope in V1 (`docs/ARCHITECTURE.md:189`);
  `--baseline/--compare` on the V1.2 wish list (`CHANGELOG.md:245`).

---

## E. Selector handling

### Drive path (click / fill / press)

`resolveSelector` in the daemon (`src/daemon.ts:251-280`), added in 0.3.1 after
agents got burned by silent first-match (`src/daemon.ts:247-250`,
`CHANGELOG.md:113-116`):

- 0 matches → error `selector matched 0 elements` (254-256).
- `--nth N` out of `0..count-1` → range error (257-260).
- >1 match without `--nth` → error listing the **first 5 candidate labels**
  (innerText → name/aria-label/placeholder → tag#id, 263-277), returned as IPC
  `code: "E_SELECTOR_AMBIGUOUS"` (`src/daemon.ts:91`), which the CLI passes
  through with a `next_steps` hint (`src/cli/click.ts:20-25`).

### Inspect path (state) — a second, divergent implementation

`state()` in the page has its **own** strictness logic: 0 matches throws; >1
matches throws with the first **3** innerText labels
(`src/inject/expose.ts:235-242`). No `--nth` support. The thrown message is
caught by the daemon's generic catch (`src/daemon.ts:213-215`) and surfaces as a
generic `E_STATE_FAILED` **string** (`src/cli/state.ts:14-21`) — not a stable
code the agent can branch on. So multi-match handling exists twice, with
different candidate counts, different error shapes, and different capabilities.
`count` similarly string-sniffs "invalid selector" to synthesize
`E_BAD_SELECTOR` (`src/daemon.ts:161-164`) — message-content branching that the
account's own error-classification rule forbids.

### Error shape returned to the agent

`{ok:false, code, message, context?, next_steps?, exitCode?}`
(`src/core/result.ts:20-27`); exit codes documented as 1=user, 2=env, 3=target
app, 4=internal (`docs/ARCHITECTURE.md:180-184`). Codes are stable-by-convention
but **ad-hoc strings scattered per file** — there is no central error-code
registry, and most daemon failures collapse into per-command `E_*_FAILED`
wrappers with the raw error string as message (e.g. `src/cli/state.ts:15`,
`src/cli/eval.ts:83`, `src/cli/portal.ts:29`).

---

## F. Config and project scoping

### `.fiber-snatcher/config.json` shape

`FsConfig` (`src/core/config.ts:9-26`): `version`, `devUrl`, `authHeader`,
`authKeyPath`, `profileDir`, `shotsDir`, `logsDir`, `daemonPidFile`,
`cdpPortHint`, `sources {nextDevCommand, pm}`, `adapters[]`. Written by `init`
(`src/cli/init.ts:86-102`); devUrl port sniffed from the `dev` script's
`-p/--port/PORT=` (`src/cli/init.ts:40-42`, default 3000).

Rot found (verified by grep):

- **Absolute paths baked in** — `authKeyPath`, `profileDir`, etc. are absolute
  (`init.ts:81-94` joins from an absolute root), so config breaks if the repo
  moves or is shared.
- **`version: "0.1.0"` hardcoded** at `init.ts:87` while the package is 0.4.1 —
  the version field is already lying.
- **`cdpPortHint` is dead**: written (`init.ts:95`), never read anywhere.
- **`adapters[]` is dead**: written empty (`init.ts:100`), never read — live
  adapters are queried from the page (`src/daemon.ts:78`). The comment at
  `config.ts:23-24` ("V1 supports redux, zustand; V1.1 will add
  tanstack-query, jotai") is stale — jotai/tanstack shipped in 0.2.0.
- `--one-shot` mode is documented in a comment (`src/core/browser.ts:6`) and was
  never implemented (no other occurrence in the tree).

### Auth bypass pattern

- 32-byte hex key at `.fiber-snatcher/auth/dev-key`, mode 0600, generated at
  init (`src/cli/init.ts:81-83`); rotate via `auth rotate`
  (`src/cli/auth.ts:18-25`).
- The daemon's browser attaches `X-Fiber-Snatcher-Key: <key>` to **every**
  request via `extraHTTPHeaders` at launch (`src/core/browser.ts:24, 34-39`) —
  fixed at launch time; changing the key requires daemon restart
  (`src/cli/auth.ts:23`).
- Verification is **project-owned by design**: copy-paste snippets for
  middleware/proxy (Pattern A, `USAGE.md:167-195`, `timingSafeEqual` +
  NODE_ENV gate) or NextAuth session callback (Pattern B, `USAGE.md:197-225`);
  rationale at `docs/ARCHITECTURE.md:104-113`.
- Pattern D — skip the bypass, log in once in the persistent profile and let
  cookies survive restarts (`USAGE.md:231-251`) — is the recommended path for
  enriched sessions and works with zero app changes.
- `auth snapshot` is a stub that returns a "use Playwright MCP
  browser_storage_state" note (`src/cli/auth.ts:26-33`).

### Multi-project coexistence

Clean, and one of V1's best structural calls: **everything is scoped to the
target root**, resolved by walking up from cwd (or `--cwd`) to the nearest
`package.json` (`src/core/paths.ts:24-30`). The socket lives inside the
target's own `.fiber-snatcher/` (`src/core/browser.ts:41-44`), so N projects =
N daemons, zero port/socket collision, no registry needed
(`docs/ARCHITECTURE.md:199`). The daemon binds to its project via
`FS_CONFIG_CWD` + `chdir` (`src/daemon.ts:26-27`).

One wart: `--cwd` is implemented by **reading `process.argv` inside library
code** (`src/core/paths.ts:26-28`), a hidden global consulted by
`resolveTargetRoot` on every call (including from `renderResult`'s last-run
write, `src/core/result.ts:42`) — invisible coupling that any V2 context object
should replace.

---

## G. V2 friction list — what will fight the planned features

Ranked roughly by how hard it fights.

1. **One-shot request/response IPC blocks every "wait" and "observe" feature.**
   The protocol closes the connection after one response line
   (`src/core/ipc.ts:28-41`), with a 15s client timeout (`ipc.ts:16`). Wait-for
   primitives, network-interception event feeds, mutation observers, and live
   transcripts all need either long-blocking calls (fights the timeout),
   server-push, or subscriptions. V1's own workaround proves the pain: `atoms
   watch` is a 200ms client-side poll loop (`src/cli/atoms.ts:70-122`) built
   "without IPC protocol change" (`CHANGELOG.md:85`). V2 needs a
   request/multi-response or event-stream protocol on the same socket.

2. **No shared action pipeline — per-command boilerplate multiplies every new
   event type.** hover/drag/scroll/upload each cost a `COMMANDS` entry, a HELP
   edit, a ~30-line CLI file with hand-rolled flag parsing, and a daemon `case`
   (§B). The parsing duplication has already produced one shipped bug (shoot
   Bug #2, `src/cli/shoot.ts:8-18`) and five divergent flag-set copies
   (`press.ts:21`, `atoms.ts:24`, `queries.ts:30`, `components.ts:26`,
   `shoot.ts:11`). Composite actions ("click, wait, read state, shoot") have no
   in-process seam at all — composition today means N CLI processes × N socket
   round-trips, or hand-writing a mega-op in the daemon switch.

3. **No run-log seam — but there is a natural choke point.** Nothing records
   agent actions (§D). The good news: **every** action already flows through
   exactly one function — the IPC handler closure (`src/daemon.ts:72-216`) — so
   a transcript middleware (log op + args + outcome + duration + page URL)
   has an obvious single home. Same for pre/post hooks (auto-wait before,
   auto-digest after). V1 just never built the wrapper; each `case` is bare.

4. **No session/state store for "formal sessions with goals+steps".** The daemon
   is stateless between ops (§A); the only persistence is the overwritten
   `last-run.json` (`src/core/result.ts:45`) and append-only browser logs.
   Sessions need an identity, a place to accumulate steps/assertions, and a
   lifecycle — none of which has a seam today. The `.fiber-snatcher/` data dir
   is the natural home (it already holds shots/logs/config), but the daemon
   never writes structured run data there.

5. **Page-runtime upgrades propagate by file copy into app bundles.** Any
   page-side capability for the semantic digest or query-settled waiting
   changes `expose.ts`, which must be re-copied into every project
   (`src/cli/init.ts:63-78`) and re-bundled/reloaded (`init.ts:145-155`), with
   documented version-skew failure modes (`CHANGELOG.md:118-124`). V2 features
   that iterate fast on page-side logic will suffer this on every release.
   Alternative: inject via Playwright (`addInitScript`) from the daemon so the
   runtime version is pinned to the daemon, not the app bundle — V1 doesn't use
   this at all. (Trade-off to respect: the copy approach survives full page
   reloads triggered by the app itself and needs no CSP/eval allowance.)

6. **Two divergent execution/selector layers.** Selector strictness exists twice
   with different behavior and error shapes (daemon `resolveSelector`
   `src/daemon.ts:251-280` vs page `state()` `src/inject/expose.ts:235-242`;
   `shoot` bypasses both via `.first()` at `src/daemon.ts:199`). A V2 "target
   resolution" layer (selector → element/fiber, with nth/label disambiguation,
   used uniformly by drive + inspect + digest + assertions) has to unify these
   or inherit the inconsistency.

7. **Network interception has no seam and a launch-time ceiling.** The daemon
   only *reads* CDP events (`src/daemon.ts:55-70`); there is no `page.route()`
   layer, and `extraHTTPHeaders` is frozen at context launch
   (`src/core/browser.ts:24`) — per-run header changes or route mocking require
   a browser relaunch. Interception, request mocking, and a query-settled
   waiter built on network idle all need a route/subscription layer in the
   daemon.

8. **Error codes are ad-hoc strings with message-sniffing.** No central
   registry; page-thrown errors collapse into generic `E_*_FAILED` with string
   messages (`src/cli/state.ts:15`); `count` branches on
   `msg.includes("invalid selector")` (`src/daemon.ts:163`). Assertions and
   composite actions need machine-checkable failure taxonomy; V2 should define
   the code enum centrally (the shape itself — `Result` with `code` +
   `next_steps` — is fine, see §H).

9. **Config schema is already rotten** (absolute paths, `version: "0.1.0"`
   drift, dead `cdpPortHint`/`adapters` fields, stale comments — §F). Any V2
   feature that reads config inherits this; the schema needs a versioned rewrite
   with relative paths and a migration in `init`.

10. **`eval`'s wrap/transpile pipeline is fragile and hand-duplicated.** The
    depth-aware `wrapForReturn` + async-IIFE + Bun DCE-ordering constraints
    (`src/cli/eval.ts:36-78, 108-147`) are mirror-copied into the test harness
    on purpose ("keep in sync", `tests/eval-harness.ts:13-15`) — a drift trap.
    If V2 keeps eval, the wrapper should be a shared module imported by both.

11. **`start` returns before the daemon is proven up** (fixed 700ms sleep,
    `src/cli/start.ts:61`) — composite flows that immediately act after `start`
    will race the boot; V2's session-open should block on a socket healthcheck.

---

## H. What's genuinely good and should survive V2 unchanged

1. **The `Result<T>` contract**: `ok/err`, stable-ish `code`, curated
   `next_steps`, `context`, exit-code mapping, and persistence to
   `last-run.json` (`src/core/result.ts`, `docs/ARCHITECTURE.md:174-185`).
   Four releases of agent feedback shaped it; agents demonstrably use
   `next_steps`. Keep the shape; centralize the codes.

2. **Per-project unix-socket daemon.** Zero port allocation, natural N-project
   coexistence, sub-50ms round-trips, socket + pidfile + profile all co-located
   under the target's `.fiber-snatcher/` (`src/core/browser.ts:41-44`,
   `src/core/ipc.ts:5-9`). Keep the transport and the per-project scoping;
   evolve only the protocol (§G1).

3. **Persistent headful context + Pattern D auth.** Login/cookies/localStorage
   surviving restarts (`src/core/browser.ts:20-31`) plus the "just log in once
   in the real window" pattern (`USAGE.md:231-251`) is the reason the tool works
   against real enriched-session apps with zero app changes. The header-bypass
   contract (project-owned verification, `timingSafeEqual`, NODE_ENV gate,
   0600-key, `docs/ARCHITECTURE.md:104-113`) is also sound where it's needed.

4. **Selector-ambiguity refusal with candidate labels + `--nth`**
   (`src/daemon.ts:251-280`). Refusing to silently first-match, and returning
   the first-5 labels so the agent can immediately pick `--nth`, is excellent
   agent UX born from a real footgun (`CHANGELOG.md:113-116`). V2 should
   *unify* it across inspect/drive/shoot (§G6), not redesign it.

5. **`safeSnapshot` with React-internal stripping** and depth caps
   (`src/inject/expose.ts:113-143`) — the ~100KB→5KB payload win
   (`CHANGELOG.md:146-149`) is exactly what keeps outputs inside an agent's
   context budget. The fiber-walk primitives themselves (`__reactFiber$` key
   discovery, hook-chain walk, HostPortal detection) are correct and hard-won.

6. **The minimal adapter contract** — `{getState, dispatch}` registered by name
   (`src/inject/expose.ts:28-31, 294-296`), with jotai/tanstack factories as
   the pattern (`src/inject/adapters/`). Small, proven, async-aware; new state
   libraries slot in without daemon changes.

7. **`doctor`'s dependency-aware probe battery** — probes isolated so one
   failure doesn't hide the rest, and the chrome-error detection that marks
   `page-url` failed and *skips* downstream probes to surface one true next
   step (`src/cli/doctor.ts:37-91`, `CHANGELOG.md:23-37`). This is codified
   operational learning; keep it and extend it with V2 probes.

8. **The `errors` digest** — group-by-body-signature, top-30 by frequency with
   source mix (`src/cli/errors.ts:35-54`): "40 error lines → 3 root causes" is
   the right altitude for agents. The 4-source unified JSONL log model
   (`docs/ARCHITECTURE.md:117-128`) beneath it is also worth keeping.

9. **Real-input-pipeline principle** — drive via Playwright locators so React
   synthetic events fire correctly, explicitly instead of eval-based
   clicks/fills (`src/cli/click.ts:1-5`, `src/cli/fill.ts:1-6`). This
   correctness stance must carry into hover/drag/scroll/upload.

10. **The release discipline around the tool**: feedback-driven CHANGELOG with
    named regressions, `prerelease` gate = version-drift check + typecheck +
    eval harness (`package.json:15`, `scripts/check-versions.ts`,
    `tests/eval-harness.ts`). Process, not code — but it's why V1's quality
    trended up across 0.2 → 0.4.1.

---

## Appendix: current command inventory (24 declared, 22 implemented)

`init start stop status doctor state components portal count dispatch atoms
queries click fill press navigate refresh eval shoot errors logs auth clean
version help` (`bin/fiber-snatcher.ts:14-40`; `version`/`help` handled inline
in bin). Daemon ops: `info goto/navigate click fill press state components
portal count atom-get dispatch eval shoot close` (`src/daemon.ts:74-212`).
