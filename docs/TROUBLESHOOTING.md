# Troubleshooting

Common failure modes and recovery steps. For setup issues, see [USAGE.md](../USAGE.md). For internals, see [ARCHITECTURE.md](./ARCHITECTURE.md).

## Quick triage

Always start with `fiber-snatcher doctor`. Each probe is independent — a failure in one does not hide the others. Read the `next_steps` in the output before anything else.

```sh
fiber-snatcher doctor
```

If `doctor` itself crashes, skip to [Installer problems](#installer-problems).

## Startup failures

### `E_NOT_INITIALIZED` — "fiber-snatcher is not set up in this project"

**Meaning:** No `.fiber-snatcher/config.json` was found walking up from cwd.

**Fixes:**
- You're in the wrong directory. `cd` into the target project.
- The target isn't a project. `package.json` is the marker Fiber Snatcher uses to find a project root. Add one or pass `--cwd <dir>`.
- You never ran `init`. Run `fiber-snatcher init`.

### `E_DEV_SERVER_DOWN` — "Dev server not reachable at http://localhost:NNNN"

**Meaning:** No HTTP response (or `>=500`) at the `devUrl` in `.fiber-snatcher/config.json`.

**Fixes:**
- Start the dev server. The detected command is in `.fiber-snatcher/config.json → sources.nextDevCommand`.
- Port mismatch. Check `package.json` `dev` script vs `devUrl`. Edit `.fiber-snatcher/config.json` or re-run `fiber-snatcher init`.
- Server is binding `0.0.0.0` but firewall blocks `localhost`. Rare. Use `127.0.0.1` instead in config.

### `E_ALREADY_INIT` — "fiber-snatcher already initialized here"

**Meaning:** `config.json` exists and you ran `init` without `--force`.

**Fixes:**
- If you want to preserve the auth key and just refresh inject files: delete `.fiber-snatcher/runtime/`, then re-run `init`.
- If you want a full reset (rotates the auth key): `fiber-snatcher init --force`.

## Runtime failures

### `E_STATE_FAILED` — "`__snatcher__` not present; integrate expose.ts per USAGE.md"

**Meaning:** The debug surface isn't attached to `window`. The daemon reached the page but couldn't find the API.

**Fixes:**
1. Check the browser console in the headful Chromium window for `[fiber-snatcher] runtime vX attached`. Missing → the import didn't run.
2. Verify your `src/dev/fiber-snatcher-runtime.ts` (or equivalent) imports `.fiber-snatcher/runtime/expose.ts` behind a `process.env.NODE_ENV === "development"` gate.
3. Verify `app/layout.tsx` imports that file. The import must be evaluated — a dynamic `import()` behind a condition may not fire.
4. Hard reload the page: in the Chromium window, `Cmd+Shift+R`. Some HMR updates skip re-running the expose import.

### `E_STATE_FAILED` — "selector matched N elements"

**Meaning:** Your selector isn't unique.

**Fixes:**
- Narrow with an attribute: `[data-testid="cart-button"]` beats `.btn`.
- Use structural qualifiers: `main h1`, `[aria-label="Cart"] button`.
- Fiber Snatcher refuses ambiguous selectors on purpose. It will not guess.

### `E_DISPATCH_FAILED` — "no adapters registered"

**Meaning:** You called `dispatch` but no store adapter is registered on `window.__snatcher__`.

**Fixes:**
- Add the `register(name, adapter)` block to your dev runtime file per [USAGE.md §2a](../USAGE.md#2a-register-a-store-adapter-optional-but-recommended).
- Check which adapters are live: `fiber-snatcher status` includes them in the output.
- If your app uses a store not yet adapter-covered, write a 10-line adapter inline — the contract is just `{ getState, dispatch }`.

### Action dispatched but `changed === false`

**Meaning:** The action reached the store but state didn't move.

**Possible causes:**
- The reducer/handler didn't match. Wrong action type or shape.
- The state looks equal after `safeSnapshot()` comparison (same keys, same primitives) even though a reference changed. Fine — semantically unchanged.
- Middleware short-circuited (Redux saga, RTK Query). Walk the middleware chain.

Use `fiber-snatcher state` before and after to inspect, or bump `fiber-snatcher eval` for one-shot introspection.

## Daemon / IPC failures

### `E_IPC_FAILED` — "ipc timeout"

**Meaning:** Daemon pidfile exists, process is alive, but the Unix socket isn't responding within 15s.

**Fixes:**
1. `fiber-snatcher stop` — forces SIGTERM, then SIGKILL if needed.
2. Check the headful browser window — if it's a login spinner or dialog, an IPC op can block until the page settles. Close the dialog.
3. `fiber-snatcher clean` then `fiber-snatcher start`.

### Daemon starts but the browser never opens

**Meaning:** Spawn succeeded but Playwright can't launch Chromium.

**Fixes:**
- First time on a machine: `npx playwright install chromium`. The MCP/Playwright Chromium download is separate from your system Chrome.
- On macOS, check System Settings → Privacy & Security → allow Chromium if Gatekeeper flagged it.
- Check `.fiber-snatcher/logs/daemon-YYYY-MM-DD.jsonl` — the spawn failure is written there.

### "Stale pidfile" warning from `status`

**Meaning:** A `daemon.pid` file exists but no such PID is running. Usually means the daemon crashed.

**Fixes:**
- `fiber-snatcher clean` removes the stale pidfile.
- Check the last log file for the crash cause: `fiber-snatcher logs -n 50`.
- Report the crash pattern so we can harden the daemon's error handling.

## Auth bypass failures

### Login page still appears when Fiber Snatcher navigates

**Meaning:** The daemon is attaching `X-Fiber-Snatcher-Key` but your middleware isn't honoring it.

**Fixes:**
- `fiber-snatcher auth key --json` — confirm the key is what you expect.
- Run the comparison by hand:
  ```sh
  curl -s -H "X-Fiber-Snatcher-Key: $(fiber-snatcher auth key --json | jq -r .data.key)" \
    http://localhost:3006/api/me
  ```
  If the server still 401s, the bypass isn't installed correctly.
- Verify the bypass is gated on `process.env.NODE_ENV === "development"` and that you're actually running `next dev` (not `next start`).
- If you use NextAuth v4, confirm the callback is reading `headers()` in a server component context. Callbacks in middleware vs route handlers see different request surfaces.

### Auth bypass works for one request but not for the next

**Meaning:** The header is attached per-request by Playwright, but some flows (redirects, form POSTs) might strip custom headers.

**Fixes:**
- Set the cookie inside the bypass handler: after verifying the header, issue `Set-Cookie` for your normal session cookie. Subsequent requests ride the cookie.
- For NextAuth, the callback approach already writes a session — no extra work.

## Log / shot issues

### `errors` shows empty `groups: []`

**Meaning:** Either there really are no errors in the window, or the daemon isn't logging.

**Fixes:**
- `fiber-snatcher logs -n 20` — does anything show?
- If empty: daemon isn't writing logs. Restart it.
- If full but no errors: widen the time window, e.g. `--since 1h`.

### Screenshots are blank / wrong size

**Meaning:** The page didn't finish rendering before the capture.

**Fixes:**
- `fiber-snatcher shoot` uses `fullPage: true` by default. For a specific element pass a selector.
- Add a brief wait: run your action, then `sleep 0.5`, then `shoot`.
- For dynamic content (lazy images, SSR hydration), wait for a visible network idle — V1.1 will expose a `--wait-for` flag.

## Installer problems

### `bun: command not found`

**Meaning:** Bun isn't at `~/.bun/bin/bun`.

**Fixes:**
- Install: `curl -fsSL https://bun.sh/install | bash`
- Re-run `bash scripts/install.sh`.

### `fiber-snatcher: command not found` after install

**Meaning:** `~/.local/bin` isn't on `PATH`.

**Fixes:**
Add to `~/.zshrc` (or equivalent):
```sh
export PATH="$HOME/.local/bin:$PATH"
```
Then `source ~/.zshrc` or open a new terminal.

### Typescript errors after `bun install`

**Meaning:** You ran typecheck against `src/inject/` which imports Next.js types Fiber Snatcher doesn't ship.

**Fixes:**
- `tsconfig.json` already excludes `src/inject/`. If you removed that exclusion, re-add it.

## When all else fails

1. `fiber-snatcher doctor --json` — share the full output.
2. `fiber-snatcher logs -n 50` — recent activity.
3. `cat .fiber-snatcher/last-run.json` — the structured result of your last command.
4. `fiber-snatcher stop && clean` — clean slate.
5. `fiber-snatcher start` — restart the daemon.
6. File an issue with the four pieces above.
