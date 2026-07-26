<p align="center">
  <img src="docs/assets/banner.svg" alt="Invasion of the Fiber Snatchers — a local React dev-app driver for coding agents" width="100%"/>
</p>

# Fiber Snatcher

> *An agent-first driver for your local React dev app.*

**Slug:** `invasion-of-the-fiber-snatchers` · **CLI:** `fs` (V2) · `fiber-snatcher` (V1, frozen) · **Runtime global:** `window.__snatcher__` · **Status:** V2

Fiber Snatcher lets a coding agent drive a running Next.js / React dev app the way
it wants to: act on an element by reference, get back a one-line digest of what
changed, wait on the framework's own signals instead of sleeping, and read React
component state that no generic browser tool can reach. It runs entirely against
your local dev server. It is a personal tool, made public.

The design assumption is that the user is an agent, not a person. An agent is fast
but blind, mechanical but diligent, and pays a real cost for every wasted round
trip. So every action returns what changed without a second call, waits and
retries live inside the action, and an ambiguous target comes back as a ranked
candidate list rather than a silent first-match.

## 30-second demo

```sh
$ fs page
{ "url": "/", "interactables": [
    { "ref": "e9.8rp0",  "role": "button", "text": "Failed only" },
    { "ref": "e10.8rp0", "role": "button", "text": "Open Preview" } ] }

$ fs click e10.8rp0
{ "clicked": "Open Preview" }
Δ mutations:minor  queries:settled          ← the digest: something changed, queries idle

$ fs click "Export"                          ← intent text, two matches → it lists them
✗ E_TARGET_AMBIGUOUS: ambiguous target (2 plausible matches)
candidates:
  e25.8rp0  [button] Export  <Modal>  100%
  e26.8rp0  [button] Export  <Modal>  100%
→ act on a specific one: fs click --ref e25.8rp0
```

`fs page` mints a stable ref per interactable; verbs take that ref. `mutations:none`
after a click is a dead click, a real signal. `queries:settled` means the app's
async work — TanStack queries, React Router navigations and fetchers, any project
adapter's activity — went idle before the digest was taken.

## Install

```sh
git clone https://github.com/alcatraz627/invasion-of-the-fiber-snatchers ~/Code/Claude/invasion-of-the-fiber-snatchers
cd ~/Code/Claude/invasion-of-the-fiber-snatchers
~/.bun/bin/bun install
bash scripts/install.sh                # links `fiber-snatcher` into ~/.local/bin
npx playwright install chromium        # one-time browser download
```

`install.sh` links the `fiber-snatcher` CLI (which owns `init` and the frozen V1
commands). The V2 CLI is `fs`; to put it on your PATH, add a launcher next to the
other one:

```sh
printf '#!/usr/bin/env bash\nexec "%s/.bun/bin/bun" run "%s/Code/Claude/invasion-of-the-fiber-snatchers/bin/fs.ts" "$@"\n' "$HOME" "$HOME" > ~/.local/bin/fs
chmod +x ~/.local/bin/fs
```

Then set it up in a target project:

```sh
cd ~/path/to/your-nextjs-app
fiber-snatcher init                    # writes .fiber-snatcher/config.json (dev port read from package.json)
fs doctor                              # verify config, dev server, daemon, runtime, adapters
```

There is no app-side wiring step in V2. `init` prints one about `expose.ts`; ignore
it. The page runtime is injected over CDP at daemon boot, so nothing goes into your
`layout.tsx`. The daemon auto-starts on the first `fs` verb.

## Verbs

`fs help` prints the current list; it is generated from the action registry, so it
cannot drift from what the tool does. The groups:

| Group | Verbs |
|---|---|
| Navigate | `navigate` (`goto`, `nav`), `reload` |
| Act | `click`, `hover`, `dblclick`, `rclick`, `drag`, `press`, `chord`, `type`, `scroll`, `fill`, `select`, `upload`, `paste`, `resize`, `dismiss` (`close`) |
| Wait | `wait` (`--settled` / `--text` / `--gone` / `--url` / `--network-idle` / `--call`), `sleep` |
| Observe | `page` (`snapshot`), `shoot` (`screenshot`), `look`, `record`, `state` |
| React state | `queries`, `atoms`, `dispatch`, `count`, `eval`, `remount` |
| Flows | `macro`, `session`, `expect`, `probe` |
| Network | `mock`, `unmock`, `throttle`, `wait-call`, `watch` |
| Health | `doctor`, `routes`, `info`, `journal`, `profile`, `stop` |

Targeting accepts a ref (`e7.k3f2`), intent text (`"Export"`), a fiber component
expression (`'JobRow[title~="JEGS"]'`), or CSS (`--css '.toolbar button' --nth 1`).
Ambiguity always returns the candidate list with refs, so `--nth` is never a blind
guess.

## How it differs from Playwright MCP and Chrome DevTools MCP

Those servers are good at what they do; Fiber Snatcher fills a different slot, the
inner React dev loop. What only this tool gives you:

- **Component targeting through the fiber tree.** `fs click 'JobRow[title~="JEGS"]'`
  and `fs state 'PreviewJobOutputModal'` address elements by React component, not
  CSS. A generic driver has no view of the component tree.
- **Waits on the framework's own signal.** `fs wait --settled` returns when the
  app's async work goes idle — TanStack Query, React Router navigations/fetchers —
  via adapters discovered with zero app-side code, plus anything a project's own
  `.fiber-snatcher/adapter.js` feeds in. `networkidle` is a proxy; activity-settled
  is the real thing.
- **A digest contract on every mutating verb.** You learn what an action did without a
  second call: mutation weight, surfaces opened/closed, focus, collection-count
  deltas, settled queries, new console errors. A dead click is visible instead of a
  false success.
- **React state as first-class verbs.** `queries`, `atoms`, `dispatch`, `state` read
  and drive the store directly, instead of hand-rolling `evaluate_script` that walks
  `__reactFiber$` keys every turn.
- **A macro and session library.** Drive a flow once, lift it from the journal, and
  replay it parameterized (`fs macro run open-job --param job=JEGS`). A session
  doubles as a regression check.

Use Playwright MCP for cross-browser work, Chrome DevTools MCP for performance traces
(LCP, INP, heap), and your own runner for real end-to-end suites.

## Requirements

- **Local dev only.** Never point it at production, staging, or any remote target. The
  daemon holds a persistent browser profile and injects a runtime; that belongs on
  your machine against `localhost`.
- **React**, ideally Next.js App Router. The `routes` verb reads the App Router source;
  other React apps work for driving and state, without route discovery.
- **Bun** ≥ 1.3 (the CLI and daemon run on Bun) and **Playwright** Chromium (installed
  once with `npx playwright install chromium`).
- **macOS-first.** The IPC transport is a Unix socket, so Linux is likely fine but
  untested and Windows is unsupported until the transport is portable.

## Performance

Measured on the real path (CLI to daemon to headless Chromium), not estimated:

| What | Number |
|---|---|
| Warm socket round-trip (`ping` / `page` concise) | under 1 ms |
| Cold start including browser boot (`fs info`, daemon down) | ~430 ms |
| `page` concise snapshot on the fixture | 1.42 KB |
| `shoot` from the screencast ring vs a live capture | 1 ms vs 63 ms (63x) |
| Journal write per action | ~170 bytes |

Full audit with the caveats: `.claude/output/20260703-v2-plan/reports/PERF-AUDIT.md`.

## Documentation

| Read | When |
|---|---|
| [`docs/DRIVING.md`](./docs/DRIVING.md) | Driving V2 day to day: the core loop, the ten most-used verbs, profiles, macros, troubleshooting |
| [`CLAUDE.md`](./CLAUDE.md) | Agent operating rules: when to use `fs`, when not to |
| [`CHANGELOG.md`](./CHANGELOG.md) | What changed in 2.0.0, and the V1 history |
| [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) | Internals, extending the daemon, writing adapters (V1-era; V2 rewrite pending) |
| [`docs/TROUBLESHOOTING.md`](./docs/TROUBLESHOOTING.md) | Error codes and recovery |
| [`CONTRIBUTING.md`](./CONTRIBUTING.md) | Setup, commit format, adding a verb or adapter |

## Migrating from V1

- **Use `fs`.** The V1 `fiber-snatcher` CLI stays for un-migrated projects and is
  frozen; new work targets `fs`. Both can be installed side by side.
- **Drop the app-side wiring.** The bundle-copied `.fiber-snatcher/runtime/expose.ts`
  import is obsolete. V2 injects the runtime over CDP at daemon boot, so there is
  nothing to add to your app. A compat shim still accepts `__snatcher__.register`.
- **The two daemons coexist.** V2 uses `control-v2.sock` and `daemon-v2.pid`. If a
  live V1 daemon is holding the browser profile, V2 refuses with the remedy instead
  of fighting for it; run `fiber-snatcher stop` first.

## License

MIT. See [`LICENSE`](./LICENSE).
