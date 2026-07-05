# Live-app integration test

`versable.test.ts` drives the real running Versable dev app (default
`http://localhost:3006`) instead of the synthetic fixture, to catch regressions
that only show up against a real React app. It is the codified version of the
manual dogfood driving done during the V2 build.

## Two tiers

- **Always-run** — exercises the tool against whatever real page loads, including
  the login page (itself a real React page): health, navigate + settle, snapshot
  and ref shape, targeting errors, staleness rejection, `why` on a real control,
  runtime injection, adapt-config plumbing, `state`, `routes`.
- **Authenticated** — needs a logged-in session and skips on the `/login`
  redirect: search + open the preview modal, closed-dropdown signal recovery,
  cross-page snapshot.

## Running it

```sh
bun test tests/integration/versable.test.ts
```

It self-skips (passes, logs the reason) when the dev server is unreachable or the
browser profile is busy, so it never false-fails in an environment it can't reach.

## Enabling the authenticated tier

This app's login session lives in the running browser context and does NOT survive
a daemon restart (stopping the daemon logs you out; the bypass header alone just
redirects to `/login`). So the test drives the **already-running** daemon in place
rather than spawning its own:

1. Start the interactive daemon in the Versable frontend and let it open the
   browser: `cd <versable>/frontend && fs navigate /jobs`.
2. Log in through that browser window.
3. **Leave it running** — do not `fs stop`.
4. Run the test — it connects to that live, authenticated daemon and the authed
   tier runs (you'll see it drive the visible browser).

The test never stops the daemon (that would end the session). Point it at a
different app with `FS_INT_PROJECT=/path/to/project` (the project must have a
`.fiber-snatcher/config.json` and a running, logged-in daemon).
