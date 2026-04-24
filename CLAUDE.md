# Fiber Snatcher — Agent Operating Instructions

These instructions are for you, the agent. When a target project uses Fiber Snatcher, prefer these commands over hand-rolling `evaluate_script` calls.

## When to use

- **Always** when debugging state/props/hooks of a component in a local React/Next.js dev app that has `.fiber-snatcher/` initialized.
- **Always** when you need to trigger a store action or programmatic state change deterministically.
- **Always** when you need a screenshot, console log excerpt, or failed network listing.
- **Never** on production builds, staging, or any remote target.

## Detection — is it set up?

Check: `test -f .fiber-snatcher/config.json && echo yes`. If yes, Fiber Snatcher is initialized. If no, decide:

- If the user's current task *needs* visual/state debugging → tell the user: *"This project doesn't have Fiber Snatcher set up. Running `fiber-snatcher init` will scaffold it (docs: ~/Code/Claude/invasion-of-the-fiber-snatchers/USAGE.md). Want me to run it?"* Wait for approval before running init.
- If the task doesn't need it → skip; don't nag.

## Start / stop / use pattern

Every debugging session follows this shape:

```sh
# 1. Verify health
fiber-snatcher status         # is the daemon up?
# or
fiber-snatcher start          # if not
fiber-snatcher doctor         # end-to-end verification

# 2. Inspect / act
fiber-snatcher state '[data-testid="…"]'
echo '{…}' | fiber-snatcher dispatch
fiber-snatcher shoot --name before-fix

# 3. Make code changes (normal editing)

# 4. Re-inspect to verify
fiber-snatcher state '[data-testid="…"]'
fiber-snatcher errors --since 2m
fiber-snatcher shoot --name after-fix

# 5. When done with the session
fiber-snatcher stop           # if you started it; not required if the user already had it running
```

**Do not restart the daemon between every command.** `fiber-snatcher start` costs ~1.5s of Playwright boot. Subsequent commands talk to it over a unix socket (<50ms). Start once, use many, stop at session end.

## Command rules

### `state [selector]`

- Pass a CSS selector that matches exactly one element. If you don't have a testid, use a specific one like `main h1` or `[aria-label="Cart"]`.
- Ambiguous selectors return `E_STATE_FAILED` with the match count — narrow and retry, don't guess.
- Returns `{ selector, domProps, ancestors: [{component, state, props, hooks}], page }`. `ancestors` is bottom-up — first entry is the closest stateful fiber.

### `dispatch`

- Stdin JSON is whatever the registered adapter accepts. Read `app/layout.tsx` or the dev-runtime file to confirm the adapter shape first.
- Response includes `{before, after, changed}`. If `changed === false`, the action was a no-op — investigate before retrying.

### `eval <file> --yes-i-know`

- Use only when `state` / `dispatch` can't express what you need.
- Write the snippet to a file first; this keeps it reviewable.
- It runs `new Function()` in the page — full DOM/window access. Don't use for anything you could do via the snatcher API.

### `shoot [selector] --name <tag>`

- Always pass `--name` for findable artifacts. Path is `.fiber-snatcher/shots/<tag>.png`.
- After `shoot`, use the `Read` tool on the returned path to see the image. The CLI output is JSON with the path, not the image.

### `errors --since <dur>`

- Durations: `30s`, `5m`, `1h`, `1d`. Default `10m`.
- Groups duplicates by error body. Use this before re-reading individual log lines.
- If `groups: []` but you still see a visible failure, the log sink or daemon may be down — run `fiber-snatcher doctor`.

### `logs -f --source … --level …`

- Sources: `cdp-console`, `cdp-pageerror`, `cdp-network`, `react`, `browser`. Comma-separated.
- Levels: `debug`, `info`, `warn`, `error` — filter is a floor, i.e. `--level warn` includes `error` too.

## Error conventions

Every failure returns JSON like:

```json
{ "ok": false, "code": "E_…", "message": "…", "context": {…}, "next_steps": ["…"] }
```

- Read `next_steps` first — they're curated for common-failure recovery.
- `code` values are stable across versions; use them for branching logic if you script Fiber Snatcher calls.

## Stale state awareness

- Every `state` response includes `page` (current URL). If it's not what you expected, the user / a prior tool navigated away.
- Component state can change between consecutive `state` calls during hot-reload. Re-read if more than ~10s elapsed since the last inspection.
- If the browser window was manually closed by the user, the daemon shuts down and all subsequent commands fail with `E_IPC_FAILED`. Run `fiber-snatcher start` to reopen.

## Auth bypass — what Claude needs to know

When the target project wired up the bypass header:

- The daemon automatically attaches `X-Fiber-Snatcher-Key: <key>` to every request.
- For one-off `curl` or `fetch` calls from the CLI, get the key via `fiber-snatcher auth key` (returns JSON `{header, key}`).
- Never log or echo the key in output the user will see — treat it like a session token.

## What NOT to use Fiber Snatcher for

- Cross-browser testing → use Playwright MCP directly
- Performance traces (LCP, INP, heap snapshots) → Chrome DevTools MCP's `performance_*` tools
- Route/server-action discovery → `next-devtools-mcp get_routes` / `get_server_action_by_id`
- End-to-end Playwright test runs → the project's own `npm test`

Fiber Snatcher's niche is **the inner dev loop**: inspect state, change state, look for errors, repeat. The broader MCPs cover what's outside that loop.

## V1 limitations to be honest about

- One page at a time. Multi-tab work is V1.1+.
- Production builds strip React internals — only works in `next dev`.
- Selector must be unique. Consider adding `data-testid` to key elements.
- No baseline visual diff; screenshots are read-and-compare by you.
- Only registered adapters are dispatchable. Reading state works without adapters.
