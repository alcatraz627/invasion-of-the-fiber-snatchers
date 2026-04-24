# Using Fiber Snatcher in a target project

Fiber Snatcher scaffolds a `.fiber-snatcher/` directory but **never modifies your source code**. You own the wiring — three small insertions described below.

All insertions are dev-only (gated on `process.env.NODE_ENV === "development"`). None ship to production.

## 0. One-time: install the CLI globally

```sh
cd ~/Code/Claude/invasion-of-the-fiber-snatchers
~/.bun/bin/bun install
bash scripts/install.sh            # symlinks fiber-snatcher → ~/.local/bin
which fiber-snatcher               # should print a path
```

## 1. `fiber-snatcher init` in your project

```sh
cd ~/path/to/your-nextjs-app
fiber-snatcher init
```

This does:

- Creates `.fiber-snatcher/{runtime,logs,shots,auth,browser-profile}`
- Copies the three inject templates into `.fiber-snatcher/runtime/`
- Generates a 32-byte dev auth key at `.fiber-snatcher/auth/dev-key` (mode 0600)
- Merges `playwright-mcp`, `chrome-devtools-mcp`, `next-devtools-mcp` into `.mcp.json`
- Appends `.fiber-snatcher/` to `.gitignore`
- Writes `.fiber-snatcher/config.json` — inspect it after; ports are detected from your `package.json` `dev` script

## 2. Wire the debug surface into `app/layout.tsx`

Create `src/dev/fiber-snatcher-runtime.ts`:

```ts
// src/dev/fiber-snatcher-runtime.ts
// Imports the scaffolded expose.ts so window.__snatcher__ is installed.
if (process.env.NODE_ENV === "development") {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("../../.fiber-snatcher/runtime/expose");
}
```

Then in `app/layout.tsx` (App Router):

```tsx
import "@/dev/fiber-snatcher-runtime";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html><body>{children}</body></html>;
}
```

### 2a. Register a store adapter (optional but recommended)

If your app uses Zustand / Redux / custom global store, register it so `fiber-snatcher dispatch` can push actions. This makes Claude able to reproduce app states deterministically.

**Zustand example:**

```ts
// src/dev/fiber-snatcher-runtime.ts
if (process.env.NODE_ENV === "development") {
  require("../../.fiber-snatcher/runtime/expose");
  if (typeof window !== "undefined" && window.__snatcher__) {
    import("@/state/store").then(({ useAppStore }) => {
      window.__snatcher__!.register("zustand", {
        getState: () => useAppStore.getState(),
        dispatch: (action) => useAppStore.setState(action as any),
      });
    });
  }
}
```

**Redux example:**

```ts
if (typeof window !== "undefined" && window.__snatcher__) {
  import("@/state/store").then(({ store }) => {
    window.__snatcher__!.register("redux", {
      getState: () => store.getState(),
      dispatch: (action) => store.dispatch(action as any),
    });
  });
}
```

Each project picks whichever adapters make sense. V1.1 will ship first-class TanStack Query and Jotai adapters.

## 3. Wire auth bypass

Each project decides how. The rule is: in dev, if the request has header `X-Fiber-Snatcher-Key: <your key>`, treat the request as authenticated. Read the key from `.fiber-snatcher/auth/dev-key` at runtime — **do not hardcode**.

### 3a. Pattern A — existing proxy/middleware file

If you already have a `proxy.ts` / `middleware.ts` / custom edge handler, add the bypass at the top:

```ts
// proxy.ts (or middleware.ts)
import { readFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";

const DEV_KEY =
  process.env.NODE_ENV === "development"
    ? readFileSync(".fiber-snatcher/auth/dev-key", "utf8").trim()
    : null;

function isFiberSnatcherRequest(req: Request): boolean {
  if (process.env.NODE_ENV !== "development" || !DEV_KEY) return false;
  const hdr = req.headers.get("x-fiber-snatcher-key");
  if (!hdr) return false;
  const a = Buffer.from(hdr);
  const b = Buffer.from(DEV_KEY);
  return a.length === b.length && timingSafeEqual(a, b);
}

// then in your handler:
if (isFiberSnatcherRequest(req)) {
  // short-circuit: treat as seeded dev user
  return seedDevSessionResponse();
}
```

### 3b. Pattern B — NextAuth callback

If you use NextAuth v4 and prefer not to add middleware, patch `auth-options.ts`:

```ts
import { readFileSync } from "node:fs";
import { headers } from "next/headers";

callbacks: {
  async session({ session }) {
    if (process.env.NODE_ENV === "development") {
      const key = (await headers()).get("x-fiber-snatcher-key");
      if (key) {
        try {
          const expected = readFileSync(".fiber-snatcher/auth/dev-key", "utf8").trim();
          if (key === expected) {
            return {
              ...session,
              user: { id: "fiber-snatcher-dev", email: "dev@local", name: "Fiber Snatcher" },
              expires: new Date(Date.now() + 3600_000).toISOString(),
            };
          }
        } catch {}
      }
    }
    return session;
  },
}
```

### 3c. Pattern C — no auth / open app

Skip this step. `fiber-snatcher` will still function; just no bypass header is sent.

### Safety rails

- The bypass file `.fiber-snatcher/auth/dev-key` is gitignored and mode 0600.
- Bypass code must be gated on `process.env.NODE_ENV === "development"`. In production builds, the `fs.readFileSync` call dies at build time or the gate short-circuits.
- Rotate with `fiber-snatcher auth rotate` any time the key leaks.

## 4. (Optional) install React DevTools hook

```sh
npm i -D react-devtools-core
```

Then in your dev runtime file:

```ts
if (process.env.NODE_ENV === "development") {
  require("../../.fiber-snatcher/runtime/devtools-hook");
  require("../../.fiber-snatcher/runtime/expose");
}
```

This makes `window.__REACT_DEVTOOLS_GLOBAL_HOOK__` always present, which helps some fallback inspection paths. Not strictly required — `window.__snatcher__` works without it.

## 5. (Optional) add the log sink route

Create `app/_fs/log/route.ts`:

```ts
export { POST, GET } from "../../../.fiber-snatcher/runtime/log-sink-route";
```

This receives browser-side console.error/warn + window errors and writes them to `.fiber-snatcher/logs/browser.jsonl` on the server. Without it, browser errors are only visible via CDP in the running daemon (fine for `fiber-snatcher logs` when the daemon is up, but the log sink persists them even if the daemon dies).

## 6. Start the loop

```sh
npm run dev &                       # or bun dev, pnpm dev, etc.
fiber-snatcher start                # headful browser attaches
fiber-snatcher doctor               # all probes should be ok
```

If anything fails, `doctor` tells you which step. Common issues:

- **`dev-server: no response`** — the dev server isn't running on the port Fiber Snatcher detected. Edit `.fiber-snatcher/config.json` `devUrl`, or rerun `init`.
- **`debug-surface: not attached`** — you didn't import the runtime file, or the import path is wrong. Check the browser console for `[fiber-snatcher] runtime vX attached`.
- **`ipc: timeout`** — daemon is running but hung. `fiber-snatcher stop && start`.

## 7. Common Claude loops

```sh
# "What's the state of the cart?"
fiber-snatcher state '[data-testid="cart"]'

# "Reproduce the 'cart has 3 items' state"
echo '{"type":"CART_SET","items":[{"id":"a"},{"id":"b"},{"id":"c"}]}' | fiber-snatcher dispatch

# "Why is the page broken right now?"
fiber-snatcher errors --since 5m

# "Show me the dashboard rendered"
fiber-snatcher shoot --name dashboard
# → reads path from stdout, then `Read` the PNG

# "Tail everything since my last change"
fiber-snatcher logs -f --level warn
```

## 8. Teardown

```sh
fiber-snatcher stop                 # closes browser, ends daemon
fiber-snatcher clean --prune-logs   # removes stale sockets + old logs
```

## Troubleshooting

Error codes, recovery steps, and common symptoms live in [`docs/TROUBLESHOOTING.md`](./docs/TROUBLESHOOTING.md). Start there for any failure.
