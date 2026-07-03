/** The in-page half of fiber-snatcher: injected into every document by the
 *  daemon (addInitScript), no target-repo footprint. Exposes window.__fs for
 *  the daemon bridge: fiber reads, adapter discovery, ref minting, and the
 *  observation buffer that feeds digests. V1's window.__snatcher__ (bundle-
 *  copied) is replaced by this; register() remains for optional app opt-in. */

import { RUNTIME_VERSION } from "./version.ts";

type Fiber = {
  type?: unknown;
  tag?: number;
  memoizedState?: unknown;
  memoizedProps?: Record<string, unknown> | null;
  return?: Fiber | null;
  stateNode?: unknown;
};

type Adapter = { getState: () => unknown; dispatch: (action: unknown) => unknown };

type Observation =
  | { kind: "error"; body: string; ts: number }
  | { kind: "console"; level: string; body: string; ts: number }
  | { kind: "mutation"; weight: number; ts: number }
  | { kind: "route"; url: string; ts: number };

declare global {
  interface Window {
    __fs?: FsRuntime;
    __snatcher__?: { register?: (name: string, a: Adapter) => void }; // V1 compat shim target
  }
}

export type FsRuntime = ReturnType<typeof buildRuntime>;

function fiberOf(node: Element | null): Fiber | null {
  if (!node) return null;
  const k = Object.keys(node).find((k) => k.startsWith("__reactFiber$"));
  return k ? ((node as unknown as Record<string, unknown>)[k] as Fiber) : null;
}

function displayName(t: unknown): string {
  if (!t) return "?";
  if (typeof t === "string") return t;
  const o = t as { displayName?: string; name?: string };
  return o.displayName ?? o.name ?? "Anonymous";
}

const REACT_INTERNAL_KEYS = new Set([
  "_owner", "_store", "$$typeof", "_source", "debugTask", "debugStack",
  "debugLocation", "debugInfo", "_debugSource", "_debugOwner", "_debugStack",
  "_debugHookTypes", "ref", "key",
]);

function safeSnapshot(v: unknown, depth = 0, opts?: { maxDepth?: number; includeInternals?: boolean }): unknown {
  const maxDepth = opts?.maxDepth ?? 4;
  if (depth > maxDepth) return "[depth-limited]";
  if (v === null || v === undefined) return v;
  const t = typeof v;
  if (t === "function") return `[Function ${(v as { name?: string }).name || "anonymous"}]`;
  if (t === "symbol") return String(v);
  if (t !== "object") return v;
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => safeSnapshot(x, depth + 1, opts));
  try {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (k.startsWith("__")) continue;
      if (!opts?.includeInternals && REACT_INTERNAL_KEYS.has(k)) continue;
      out[k] = safeSnapshot(val, depth + 1, opts);
    }
    return out;
  } catch {
    return "[unserializable]";
  }
}

function* walkAllFibers(limit = 300000): Generator<Fiber> {
  const seen = new WeakSet<Fiber>();
  let n = 0;
  for (const el of Array.from(document.querySelectorAll("*"))) {
    let f = fiberOf(el);
    while (f && n < limit) {
      if (seen.has(f)) break;
      seen.add(f);
      n++;
      yield f;
      f = f.return ?? null;
    }
  }
}

const INTERACTABLE_SELECTOR = [
  "a[href]", "button", "input", "select", "textarea",
  "[role=button]", "[role=tab]", "[role=menuitem]", "[role=option]",
  "[role=checkbox]", "[role=radio]", "[role=combobox]", "[role=link]",
  "[onclick]", "[tabindex]:not([tabindex='-1'])",
].join(",");

function roleOf(el: Element): string {
  const explicit = el.getAttribute("role");
  if (explicit) return explicit;
  const tag = el.tagName.toLowerCase();
  if (tag === "a") return "link";
  if (tag === "button") return "button";
  if (tag === "select") return "combobox";
  if (tag === "textarea") return "textbox";
  if (tag === "input") {
    const type = (el as HTMLInputElement).type;
    if (type === "checkbox" || type === "radio") return type;
    if (type === "button" || type === "submit") return "button";
    return "textbox";
  }
  return tag;
}

function labelOf(el: Element): string {
  const he = el as HTMLElement;
  const aria = el.getAttribute("aria-label");
  if (aria) return aria.slice(0, 80);
  const text = he.innerText?.replace(/\s+/g, " ").trim();
  if (text) return text.slice(0, 80);
  const ph = el.getAttribute("placeholder") ?? el.getAttribute("name") ?? el.getAttribute("title");
  if (ph) return `[${ph.slice(0, 60)}]`;
  return el.id ? `#${el.id}` : el.tagName.toLowerCase();
}

function nearestComponent(el: Element): string | undefined {
  let f = fiberOf(el);
  let guard = 0;
  while (f && guard++ < 25) {
    if (typeof f.type === "function" || (f.type && typeof f.type === "object")) {
      const n = displayName(f.type);
      if (n && n !== "?" && n !== "Anonymous") return n;
    }
    f = f.return ?? null;
  }
  return undefined;
}

function isVisible(el: Element): boolean {
  const he = el as HTMLElement;
  if (!he.offsetParent && getComputedStyle(he).position !== "fixed") return false;
  const r = he.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

/** Parse `Name[prop~="value"]` / `Name[prop="value"]` / `Name` component exprs. */
function parseComponentExpr(expr: string): { name: string; prop?: string; op?: "~=" | "="; value?: string } | null {
  const m = expr.match(/^([A-Za-z0-9_$.]+)(?:\[([A-Za-z0-9_$.]+)(~?=)"([^"]*)"\])?$/);
  if (!m || m[1] === undefined) return null;
  return { name: m[1], prop: m[2], op: m[3] as "~=" | "=" | undefined, value: m[4] };
}

function buildRuntime() {
  const adapters = new Map<string, Adapter>();
  const observations: Observation[] = [];
  const MAX_OBS = 1000;
  let refSeq = 0;
  let mutationWeight = 0;

  function pushObs(o: Observation) {
    observations.push(o);
    if (observations.length > MAX_OBS) observations.shift();
  }

  // Observation wiring: errors, console, mutations, soft routes.
  window.addEventListener("error", (e) =>
    pushObs({ kind: "error", body: String(e.message ?? "window error"), ts: Date.now() })
  );
  window.addEventListener("unhandledrejection", (e) =>
    pushObs({ kind: "error", body: `unhandled rejection: ${String((e.reason as Error)?.message ?? e.reason)}`, ts: Date.now() })
  );
  for (const level of ["error", "warn"] as const) {
    const orig = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      pushObs({
        kind: "console",
        level,
        body: args.map((a) => (a instanceof Error ? a.message : String(a))).join(" ").slice(0, 500),
        ts: Date.now(),
      });
      orig(...args);
    };
  }
  const mo = new MutationObserver((muts) => {
    mutationWeight += muts.length;
  });
  const startMo = () => {
    try {
      mo.observe(document.body ?? document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
    } catch {
      setTimeout(startMo, 100);
    }
  };
  startMo();
  const origPush = history.pushState.bind(history);
  history.pushState = (...args) => {
    origPush(...(args as Parameters<History["pushState"]>));
    pushObs({ kind: "route", url: location.pathname + location.search, ts: Date.now() });
  };

  // Adapter discovery — zero app cooperation (validated by the WP0 spike).
  function discoverAdapters(): string[] {
    if (!adapters.has("queries")) {
      for (const f of walkAllFibers()) {
        const c = (f.memoizedProps as { client?: { getQueryCache?: () => unknown } } | null)?.client;
        if (c && typeof c.getQueryCache === "function") {
          adapters.set("queries", makeTanstackAdapter(c as never));
          break;
        }
      }
    }
    if (!adapters.has("jotai")) {
      for (const f of walkAllFibers()) {
        const p = f.memoizedProps as { store?: unknown; value?: unknown } | null;
        const s = (p?.store ?? p?.value) as { get?: unknown; set?: unknown; sub?: unknown } | undefined;
        if (s && typeof s.get === "function" && typeof s.set === "function" && typeof s.sub === "function") {
          adapters.set("jotai", makeJotaiAdapter(s as never));
          break;
        }
      }
    }
    return [...adapters.keys()];
  }

  const api = {
    version: RUNTIME_VERSION,

    snapshot(opts?: { budget?: "concise" | "detailed"; scope?: string }) {
      const scopeEl = opts?.scope ? document.querySelector(opts.scope) : document.body;
      if (!scopeEl) return { error: `scope matched nothing: ${opts?.scope}` };
      const detailed = opts?.budget === "detailed";
      const els = Array.from(scopeEl.querySelectorAll(INTERACTABLE_SELECTOR)).filter(isVisible);
      const cap = detailed ? 250 : 80;
      const interactables = els.slice(0, cap).map((el) => {
        let ref = el.getAttribute("data-fs-ref");
        if (!ref) {
          ref = `e${++refSeq}`;
          el.setAttribute("data-fs-ref", ref);
        }
        const entry: Record<string, unknown> = { ref, role: roleOf(el), text: labelOf(el) };
        if (detailed) {
          const comp = nearestComponent(el);
          if (comp) entry.component = comp;
        }
        return entry;
      });
      return {
        url: location.pathname + location.search,
        title: document.title,
        interactables,
        truncated: els.length > cap ? els.length : undefined,
      };
    },

    resolveIntent(text: string, role?: string) {
      const needle = text.toLowerCase();
      const els = Array.from(document.querySelectorAll(INTERACTABLE_SELECTOR)).filter(isVisible);
      const scored = els
        .map((el) => {
          const label = labelOf(el).toLowerCase();
          const r = roleOf(el);
          let score = 0;
          if (label === needle) score = 1;
          else if (label.includes(needle)) score = 0.7 + Math.min(0.2, needle.length / label.length / 5);
          else return null;
          if (role && r !== role) score -= 0.4;
          return { el, score, role: r, text: labelOf(el) };
        })
        .filter((x): x is NonNullable<typeof x> => !!x && x.score > 0.3)
        .sort((a, b) => b.score - a.score)
        .slice(0, 8);
      return scored.map((s) => {
        let ref = s.el.getAttribute("data-fs-ref");
        if (!ref) {
          ref = `e${++refSeq}`;
          s.el.setAttribute("data-fs-ref", ref);
        }
        return { ref, role: s.role, text: s.text, component: nearestComponent(s.el), confidence: Number(s.score.toFixed(2)) };
      });
    },

    resolveComponent(expr: string) {
      const parsed = parseComponentExpr(expr);
      if (!parsed) return { error: `bad component expr: ${expr}` };
      const hits: Array<{ ref: string; role: string; text: string; component: string; confidence: number }> = [];
      const seenEls = new Set<Element>();
      for (const el of Array.from(document.querySelectorAll("*"))) {
        if (hits.length >= 8) break;
        let f = fiberOf(el);
        let guard = 0;
        while (f && guard++ < 25) {
          if (displayName(f.type) === parsed.name) {
            const props = (f.memoizedProps ?? {}) as Record<string, unknown>;
            let ok = true;
            if (parsed.prop) {
              const v = String(props[parsed.prop] ?? "");
              ok = parsed.op === "~=" ? v.toLowerCase().includes(parsed.value!.toLowerCase()) : v === parsed.value;
            }
            if (ok && !seenEls.has(el) && isVisible(el)) {
              seenEls.add(el);
              let ref = el.getAttribute("data-fs-ref");
              if (!ref) {
                ref = `e${++refSeq}`;
                el.setAttribute("data-fs-ref", ref);
              }
              hits.push({ ref, role: roleOf(el), text: labelOf(el), component: parsed.name, confidence: 1 });
            }
            break;
          }
          f = f.return ?? null;
        }
      }
      return hits;
    },

    state(selector?: string, opts?: { full?: boolean; shallow?: boolean }) {
      const snapOpts = { includeInternals: opts?.full === true, maxDepth: opts?.shallow ? 2 : 4 };
      const nodes = selector ? document.querySelectorAll(selector) : [document.body];
      if (selector && nodes.length === 0) throw new Error(`selector matched 0 elements: ${selector}`);
      if (selector && nodes.length > 1) {
        const labels = Array.from(nodes).slice(0, 3).map((e) => labelOf(e as Element));
        throw new Error(`selector matched ${nodes.length} elements (first: ${labels.join(" | ")}); narrow it`);
      }
      const el = nodes[0] as Element;
      let fiber = fiberOf(el);
      const walked: Array<Record<string, unknown>> = [];
      let guard = 0;
      while (fiber && guard++ < 30) {
        const hasState = fiber.memoizedState !== null && fiber.memoizedState !== undefined;
        const isComponent = typeof fiber.type === "function" || (fiber.type && typeof fiber.type === "object");
        if (isComponent && hasState) {
          const hooks: unknown[] = [];
          let h = fiber.memoizedState as { memoizedState?: unknown; next?: unknown } | null;
          let hg = 0;
          while (h && hg++ < 100) {
            hooks.push(safeSnapshot(h.memoizedState, 0, snapOpts));
            h = h.next as typeof h;
          }
          walked.push({
            component: displayName(fiber.type),
            props: safeSnapshot(fiber.memoizedProps, 0, snapOpts),
            hooks,
          });
        }
        fiber = fiber.return ?? null;
      }
      return { selector: selector ?? "<body>", ancestors: walked, page: location.pathname };
    },

    adapters: () => discoverAdapters(),

    async dispatch(action: unknown, opts?: { adapter?: string }) {
      discoverAdapters();
      const name = opts?.adapter ?? adapters.keys().next().value;
      if (!name) throw new Error("no adapters found (discovery found neither tanstack nor jotai) and none registered");
      const adapter = adapters.get(String(name));
      if (!adapter) throw new Error(`adapter not found: ${name}. available: ${[...adapters.keys()].join(", ")}`);
      return safeSnapshot(await Promise.resolve(adapter.dispatch(action)));
    },

    register(name: string, adapter: Adapter) {
      adapters.set(name, adapter);
    },

    queriesPending(): number {
      discoverAdapters();
      const a = adapters.get("queries");
      if (!a) return 0;
      try {
        const list = a.getState() as Array<{ fetchStatus: string }>;
        return list.filter((q) => q.fetchStatus === "fetching").length;
      } catch {
        return 0;
      }
    },

    /** Digest source: drain observation counters since the last call. */
    drain() {
      const errors = observations.filter((o) => o.kind === "error" || (o.kind === "console" && o.level === "error"));
      const routes = observations.filter((o) => o.kind === "route") as Array<{ url: string }>;
      const out = {
        mutationWeight,
        errors: errors.slice(-5).map((e) => (e as { body: string }).body),
        route: routes.at(-1)?.url,
        queriesPending: api.queriesPending(),
      };
      mutationWeight = 0;
      observations.length = 0;
      return out;
    },

    count: (selector: string) => document.querySelectorAll(selector).length,
    route: () => ({ pathname: location.pathname, search: location.search }),
  };

  return api;
}

function makeTanstackAdapter(client: {
  getQueryCache: () => { getAll: () => Array<{ queryKey: readonly unknown[]; state: { data: unknown; status: string; fetchStatus: string; error: unknown; dataUpdatedAt: number } }> };
  getQueryData: (k: readonly unknown[]) => unknown;
  setQueryData: (k: readonly unknown[], d: unknown) => unknown;
  invalidateQueries: (f: { queryKey: readonly unknown[] }) => Promise<void>;
  refetchQueries: (f: { queryKey: readonly unknown[] }) => Promise<unknown>;
  resetQueries: (f: { queryKey: readonly unknown[] }) => Promise<void>;
}): Adapter {
  const snapshot = (filter?: string) =>
    client.getQueryCache().getAll()
      .filter((q) => !filter || JSON.stringify(q.queryKey).toLowerCase().includes(filter.toLowerCase()))
      .map((q) => ({
        key: q.queryKey,
        status: q.state.status,
        fetchStatus: q.state.fetchStatus,
        hasData: q.state.data !== undefined,
        error: q.state.error ? String((q.state.error as Error)?.message ?? q.state.error) : null,
      }));
  return {
    getState: () => snapshot(),
    dispatch(action: unknown) {
      const a = action as { op?: string; key?: readonly unknown[]; data?: unknown; filter?: string };
      const op = a?.op ?? "list";
      if (op === "list") return snapshot(a.filter);
      if (!a.key) throw new Error(`queries dispatch: key required for op=${op}`);
      switch (op) {
        case "get": return { key: a.key, data: client.getQueryData(a.key) };
        case "invalidate": return client.invalidateQueries({ queryKey: a.key }).then(() => ({ ok: true, op }));
        case "refetch": return client.refetchQueries({ queryKey: a.key }).then(() => ({ ok: true, op }));
        case "reset": return client.resetQueries({ queryKey: a.key }).then(() => ({ ok: true, op }));
        case "setData": return { ok: true, previous: client.getQueryData(a.key), next: client.setQueryData(a.key, a.data) };
        default: throw new Error(`queries dispatch: unknown op ${op}`);
      }
    },
  };
}

function makeJotaiAdapter(store: {
  get: (a: unknown) => unknown;
  set: (a: unknown, v: unknown) => unknown;
  dev4_get_mounted_atoms?: () => Iterable<{ debugLabel?: string; toString?: () => string }>;
}): Adapter {
  const enumerate = () => {
    const out: Array<{ name: string; atom: unknown; value?: unknown; error?: string }> = [];
    try {
      for (const atom of store.dev4_get_mounted_atoms?.() ?? []) {
        const name = atom.debugLabel ?? atom.toString?.() ?? "atom?";
        try {
          out.push({ name, atom, value: store.get(atom) });
        } catch (e) {
          out.push({ name, atom, error: String(e) });
        }
      }
    } catch { /* dev api absent */ }
    return out;
  };
  return {
    getState: () => enumerate().map(({ name, value, error }) => (error ? { name, error } : { name, value })),
    dispatch(action: unknown) {
      const a = action as { op?: string; atom?: string; value?: unknown };
      const op = a?.op ?? "list";
      if (op === "list") return this.getState();
      if (!a.atom) throw new Error("jotai dispatch: atom name required");
      const hit = enumerate().find((e) => e.name === a.atom);
      if (!hit) throw new Error(`atom not found: ${a.atom}. known: ${enumerate().map((e) => e.name).join(", ") || "(none)"}`);
      if (op === "get") return store.get(hit.atom);
      if (op === "set") return store.set(hit.atom, a.value);
      throw new Error(`jotai dispatch: unknown op ${op}`);
    },
  };
}

// Injected entry: idempotent per document.
if (typeof window !== "undefined" && !window.__fs) {
  window.__fs = buildRuntime();
  // V1 compat: apps still importing the old expose can register through us.
  window.__snatcher__ = window.__snatcher__ ?? { register: (n, a) => window.__fs!.register(n, a) };
}
