/**
 * Fiber Snatcher — runtime debug surface (copied into target project at
 * `.fiber-snatcher/runtime/expose.ts`).
 *
 * Gated on NODE_ENV === "development". Import from `app/layout.tsx` (Next.js
 * App Router) or your root component.
 *
 * Exposes `window.__snatcher__` with:
 *   - version: semver string of the runtime
 *   - state(selector?): inspects nearest stateful fiber at selector
 *   - dispatch(action, opts?): sends action to a registered store adapter
 *   - route(): current pathname + query
 *   - logs(n=50): last N log events captured by the sink
 *   - log(entry): explicit log from app code (appears in fiber-snatcher logs)
 *   - register(name, adapter): attach a store adapter (zustand, redux, etc.)
 *
 * Also:
 *   - intercepts window.onerror and unhandled rejections → POSTs to /_fs/log
 *   - intercepts console.error / console.warn → same sink
 */

declare global {
  interface Window {
    __snatcher__?: SnatcherApi;
  }
}

export type Adapter = {
  getState: () => unknown;
  dispatch: (action: unknown) => unknown;
};

export type LogEntry = {
  ts: string;
  source: "browser" | "react";
  level: "debug" | "info" | "warn" | "error";
  body: string;
  stack?: string;
  page?: string;
  corr?: string;
};

export type StateOpts = { full?: boolean; shallow?: boolean };

export type SnatcherApi = {
  version: string;
  state(selector?: string, opts?: StateOpts): unknown;
  /**
   * Routes an action through a registered adapter. Awaits the adapter's return
   * value (TanStack Query / async adapters return promises) and passes it
   * back to the caller verbatim.
   *
   * Pick an adapter by name via `opts.adapter`; defaults to the first
   * registered.
   */
  dispatch(action: unknown, opts?: { adapter?: string }): Promise<unknown>;
  route(): { pathname: string; search: string };
  logs(n?: number): LogEntry[];
  log(entry: Partial<LogEntry> & { body: string; level?: LogEntry["level"] }): void;
  register(name: string, adapter: Adapter): void;
  adapters(): string[];
};

const RUNTIME_VERSION = "0.3.1";
const MAX_LOGS = 500;

type Fiber = { type?: any; memoizedState?: any; memoizedProps?: any; return?: Fiber | null; stateNode?: any };

function getFiberFromNode(node: Element | null): Fiber | null {
  if (!node) return null;
  const key = Object.keys(node).find((k) => k.startsWith("__reactFiber$"));
  return key ? ((node as any)[key] as Fiber) : null;
}

function getPropsFromNode(node: Element | null): unknown {
  if (!node) return null;
  const key = Object.keys(node).find((k) => k.startsWith("__reactProps$"));
  return key ? (node as any)[key] : null;
}

function displayName(type: any): string {
  if (!type) return "?";
  if (typeof type === "string") return type;
  return type.displayName ?? type.name ?? "Anonymous";
}

function extractHooks(fiber: Fiber | null): unknown[] {
  // A hook chain lives on fiber.memoizedState as a linked list where each node
  // has { memoizedState, next }. We walk it and return the values.
  const out: unknown[] = [];
  let h: any = fiber?.memoizedState;
  let guard = 0;
  while (h && guard++ < 100) {
    out.push(safeSnapshot(h.memoizedState));
    h = h.next;
  }
  return out;
}

/** React-internal keys that dominate state snapshots but carry no app signal. */
const REACT_INTERNAL_KEYS = new Set([
  "_owner", "_store", "$$typeof", "_source",
  "debugTask", "debugStack", "debugLocation", "debugInfo",
  "_debugSource", "_debugOwner", "_debugStack", "_debugHookTypes",
  "ref", "key",                // ref and key rarely useful in fiber snapshots
]);

function safeSnapshot(v: unknown, depth = 0, opts?: { maxDepth?: number; includeInternals?: boolean }): unknown {
  const maxDepth = opts?.maxDepth ?? 4;
  const includeInternals = opts?.includeInternals ?? false;
  if (depth > maxDepth) return "[depth-limited]";
  if (v === null || v === undefined) return v;
  const t = typeof v;
  if (t === "function") return `[Function ${(v as Function).name || "anonymous"}]`;
  if (t === "symbol") return v.toString();
  if (t !== "object") return v;
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => safeSnapshot(x, depth + 1, opts));
  try {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (k.startsWith("__")) continue;
      if (!includeInternals && REACT_INTERNAL_KEYS.has(k)) continue;
      out[k] = safeSnapshot(val, depth + 1, opts);
    }
    return out;
  } catch {
    return "[unserializable]";
  }
}

function install() {
  if (typeof window === "undefined") return;
  if (window.__snatcher__) return; // idempotent

  const adapters = new Map<string, Adapter>();
  const logs: LogEntry[] = [];

  // Sink state: UNKNOWN → probed once on first log → AVAILABLE or DISABLED.
  // Once DISABLED we never fetch again; eliminates the 404 spam when the
  // optional log sink route isn't scaffolded in the host project.
  let sinkState: "unknown" | "available" | "disabled" = "unknown";

  function pushLog(entry: LogEntry) {
    logs.push(entry);
    if (logs.length > MAX_LOGS) logs.shift();
    if (sinkState === "disabled") return;
    if (sinkState === "unknown") {
      sinkState = "probing" as any;
      fetch("/_fs/log", { method: "HEAD" })
        .then((r) => {
          sinkState = r.status === 404 ? "disabled" : "available";
        })
        .catch(() => { sinkState = "disabled"; });
      return; // first call: skip the POST so we don't double-404
    }
    if (sinkState !== "available") return;
    try {
      fetch("/_fs/log", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(entry),
        keepalive: true,
      }).catch(() => {});
    } catch {}
  }

  // Wire window error + rejection handlers
  window.addEventListener("error", (e) => {
    pushLog({
      ts: new Date().toISOString(),
      source: "browser",
      level: "error",
      body: String(e.message ?? e.error ?? "window error"),
      stack: e.error?.stack,
      page: location.pathname,
    });
  });
  window.addEventListener("unhandledrejection", (e) => {
    pushLog({
      ts: new Date().toISOString(),
      source: "browser",
      level: "error",
      body: `unhandled rejection: ${String(e.reason?.message ?? e.reason)}`,
      stack: e.reason?.stack,
      page: location.pathname,
    });
  });

  // Wrap console.{error,warn} — keep originals callable
  const origErr = console.error.bind(console);
  const origWarn = console.warn.bind(console);
  console.error = (...args: unknown[]) => {
    pushLog({
      ts: new Date().toISOString(),
      source: "browser",
      level: "error",
      body: args.map((a) => (a instanceof Error ? a.message : String(a))).join(" "),
      stack: args.find((a): a is Error => a instanceof Error)?.stack,
      page: location.pathname,
    });
    origErr(...args);
  };
  console.warn = (...args: unknown[]) => {
    pushLog({
      ts: new Date().toISOString(),
      source: "browser",
      level: "warn",
      body: args.map(String).join(" "),
      page: location.pathname,
    });
    origWarn(...args);
  };

  const api: SnatcherApi = {
    version: RUNTIME_VERSION,
    state(selector?: string, opts?: StateOpts) {
      const snapOpts = {
        includeInternals: opts?.full === true,
        maxDepth: opts?.shallow ? 2 : 4,
      };
      const root = selector ? document.querySelectorAll(selector) : [document.body];
      if (selector) {
        if (root.length === 0) throw new Error(`selector matched 0 elements: ${selector}`);
        if (root.length > 1) {
          const labels = Array.from(root).slice(0, 3).map((e) => (e as HTMLElement).innerText?.slice(0, 40) ?? e.tagName);
          throw new Error(`selector matched ${root.length} elements (first three: ${labels.join(" | ")}); narrow it`);
        }
      }
      const el = root[0] as Element;
      let fiber = getFiberFromNode(el);
      const walked: Array<{ component: string; state: unknown; props: unknown; hooks: unknown[] }> = [];
      let guard = 0;
      while (fiber && guard++ < 30) {
        const hooks = extractHooks(fiber);
        const hasState = fiber.memoizedState !== null && fiber.memoizedState !== undefined;
        const isComponent = typeof fiber.type === "function" || (fiber.type && typeof fiber.type === "object");
        if (isComponent && hasState) {
          walked.push({
            component: displayName(fiber.type),
            state: safeSnapshot(fiber.memoizedState, 0, snapOpts),
            props: safeSnapshot(fiber.memoizedProps, 0, snapOpts),
            hooks: hooks.map((h) => safeSnapshot(h, 0, snapOpts)),
          });
        }
        fiber = fiber.return ?? null;
      }
      return {
        selector: selector ?? "<body>",
        domProps: safeSnapshot(getPropsFromNode(el), 0, snapOpts),
        ancestors: walked,
        page: location.pathname,
      };
    },
    async dispatch(action, opts) {
      const name = opts?.adapter ?? adapters.keys().next().value;
      if (!name) throw new Error("no adapters registered; call __snatcher__.register(name, adapter) in app init");
      const adapter = adapters.get(String(name));
      if (!adapter) throw new Error(`adapter not found: ${name}. registered: ${[...adapters.keys()].join(", ") || "(none)"}`);
      // Await so async adapters (TanStack Query invalidate/refetch) resolve
      const result = await Promise.resolve(adapter.dispatch(action));
      return safeSnapshot(result);
    },
    route() {
      return { pathname: location.pathname, search: location.search };
    },
    logs(n = 50) {
      return logs.slice(-n);
    },
    log(entry) {
      pushLog({
        ts: new Date().toISOString(),
        source: "react",
        level: entry.level ?? "info",
        body: entry.body,
        stack: entry.stack,
        page: entry.page ?? location.pathname,
        corr: entry.corr,
      });
    },
    register(name, adapter) {
      adapters.set(name, adapter);
    },
    adapters() {
      return Array.from(adapters.keys());
    },
  };

  window.__snatcher__ = api;
  console.info(`[fiber-snatcher] runtime v${RUNTIME_VERSION} attached. try: window.__snatcher__.state()`);
}

// Auto-install on import in dev
if (typeof process === "undefined" || process.env.NODE_ENV === "development") {
  install();
}

export { install };
