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

type Adapter = {
  getState: () => unknown;
  dispatch: (action: unknown) => unknown;
  /** Optional live-work signal — {pending, started(monotonic)}. Sources with
   *  one feed the settle loop, so `--settled` stays honest on apps whose async
   *  work is not TanStack (a project adapter's fetchers, a router's loaders). */
  activity?: () => { pending: number; started: number };
};

type Observation =
  | { kind: "error"; body: string; ts: number }
  | { kind: "console"; level: string; body: string; ts: number }
  | { kind: "mutation"; weight: number; ts: number }
  | { kind: "route"; url: string; ts: number };

/** Root-remount sentinel state, owned by this runtime and read by the `remount`
 *  verb. Auto-armed at injection so between-action HMR remounts are counted even
 *  when no command is running (see drain()'s remount fields). */
type RemountState = { count: number; lastAt: number; firstChild: Element | null; container: Element };

declare global {
  interface Window {
    __fs?: FsRuntime;
    __snatcher__?: { register?: (name: string, a: Adapter) => void }; // V1 compat shim target
    __fsRemount?: RemountState;
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

function svgTitleOf(el: Element): string | undefined {
  const t = el.querySelector(":scope > svg > title, :scope svg title, :scope > title");
  const s = t?.textContent?.replace(/\s+/g, " ").trim();
  return s || undefined;
}

function labelledByText(el: Element): string | undefined {
  const ids = (el.getAttribute("aria-labelledby") ?? "").split(/\s+/).filter(Boolean);
  if (!ids.length) return undefined;
  const parts = ids
    .map((id) => document.getElementById(id)?.textContent?.replace(/\s+/g, " ").trim())
    .filter((s): s is string => !!s);
  return parts.length ? parts.join(" ") : undefined;
}

/** The label a control shows to an agent. Icon-only controls have no text, so a
 *  fallback ladder keeps them addressable: aria-label → visible text →
 *  data-testid → svg <title> → title/alt → aria-labelledby → placeholder/name →
 *  #id → nearest component → tag. `weak` marks the last rungs (id/component/tag)
 *  so a snapshot can attach the component name for a control that has no real
 *  label — "never bare button". */
function controlLabel(el: Element): { text: string; weak: boolean } {
  const he = el as HTMLElement;
  const clip = (s: string) => s.slice(0, 80);
  const aria = el.getAttribute("aria-label");
  if (aria?.trim()) return { text: clip(aria.trim()), weak: false };
  const text = he.innerText?.replace(/\s+/g, " ").trim();
  if (text) return { text: clip(text), weak: false };
  const testid = el.getAttribute("data-testid") ?? el.getAttribute("data-test-id") ?? el.getAttribute("data-test");
  if (testid?.trim()) return { text: clip(testid.trim()), weak: false };
  const svgTitle = svgTitleOf(el);
  if (svgTitle) return { text: clip(svgTitle), weak: false };
  const titleAttr = el.getAttribute("title");
  if (titleAttr?.trim()) return { text: clip(titleAttr.trim()), weak: false };
  const img = el.querySelector("img[alt]")?.getAttribute("alt");
  if (img?.trim()) return { text: clip(img.trim()), weak: false };
  const lb = labelledByText(el);
  if (lb) return { text: clip(lb), weak: false };
  const ph = el.getAttribute("placeholder") ?? el.getAttribute("name");
  if (ph?.trim()) return { text: `[${clip(ph.trim())}]`, weak: false };
  if (el.id) return { text: `#${el.id}`, weak: true };
  const comp = nearestComponent(el);
  if (comp) return { text: `<${comp}>`, weak: true };
  return { text: el.tagName.toLowerCase(), weak: true };
}

function labelOf(el: Element): string {
  return controlLabel(el).text;
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

type ReactElementish = { $$typeof?: symbol; type?: unknown; props?: Record<string, unknown> };
function isReactElement(v: unknown): v is ReactElementish {
  return (
    !!v &&
    typeof v === "object" &&
    typeof (v as ReactElementish).$$typeof === "symbol" &&
    "type" in (v as object) &&
    "props" in (v as object)
  );
}

// Per-project adaptation (set on window before this runs; see server.ts +
// core/config.ts). A codebase teaches the tool its conventions here; the built-in
// defaults handle the common cases. Read once, tolerant of absence.
type AdaptCfg = { surfaceSelectors?: string[]; overlayComponents?: string[]; contentPropKeys?: string[] };
const ADAPT: AdaptCfg = (() => {
  try {
    const a = (window as unknown as { __fsAdapt?: AdaptCfg }).__fsAdapt;
    return a && typeof a === "object" ? a : {};
  } catch {
    return {};
  }
})();

// Props that carry the content a control opens (a menu's items, a tooltip's body)
// or a human label, read straight off an ancestor fiber. `children` is read only
// from overlay wrappers (below) because elsewhere it is just the rendered subtree.
const CONTENT_PROP_KEYS = ["tooltip", "content", "dropdown", "menu", "items", "options", "groups", ...(ADAPT.contentPropKeys ?? [])];
const LABEL_STRING_KEYS = ["title", "label", "aria-label", "text", "alt", "placeholder"];
// Substring tokens (not a regex — avoids a config-supplied ReDoS) marking a fiber
// as an overlay wrapper whose `children` are un-mounted content.
const OVERLAY_TOKENS = ["dropdown", "menu", "tooltip", "popover", "popper", "float", "overlay", "select", ...(ADAPT.overlayComponents ?? []).map((s) => s.toLowerCase())];
function isOverlayName(name: string): boolean {
  const n = name.toLowerCase();
  return OVERLAY_TOKENS.some((t) => n.includes(t));
}

/** Read a prop by key without trusting it: a getter or Proxy trap that throws
 *  (a MobX computed before load, a lazy store) must yield undefined, not crash
 *  the caller. This is the single most important guard in the signal path — one
 *  such prop would otherwise blind `page`/`why`/every intent-resolve page-wide. */
function safeGet(obj: Record<string, unknown>, k: string): unknown {
  try {
    return obj[k];
  } catch {
    return undefined;
  }
}

/** Pull human-readable strings out of an un-rendered React element / items array /
 *  config object. Bounded (shared node budget + depth cap + ≤8 strings) so a deep
 *  prop tree can't stall a snapshot. This is how a closed dropdown's item labels
 *  are recovered: React builds the menu element at the parent's render and hands
 *  it to the mounted trigger as a prop VALUE, whether or not it is ever mounted. */
function extractText(v: unknown, out: string[], depth: number, budget: { nodes: number }): void {
  if (budget.nodes <= 0 || depth < 0 || out.length >= 8) return;
  budget.nodes--;
  if (v == null) return;
  if (typeof v === "string") {
    // Slice BEFORE the whitespace collapse: the node budget caps string COUNT,
    // not bytes, so a 1 MB prop would otherwise stall the regex.
    const s = v.slice(0, 120).replace(/\s+/g, " ").trim();
    if (s && s.length <= 60 && !out.includes(s)) out.push(s);
    return;
  }
  if (typeof v === "number") {
    const s = String(v);
    if (!out.includes(s)) out.push(s);
    return;
  }
  if (Array.isArray(v)) {
    for (const x of v) extractText(x, out, depth - 1, budget);
    return;
  }
  if (isReactElement(v)) {
    let props: Record<string, unknown>;
    try {
      props = (v.props ?? {}) as Record<string, unknown>;
    } catch {
      return;
    }
    for (const k of ["children", "items", "options", "groups", "label", "title", "content"]) {
      extractText(safeGet(props, k), out, depth - 1, budget);
    }
    for (const k of LABEL_STRING_KEYS) {
      const pv = safeGet(props, k);
      if (typeof pv === "string") extractText(pv, out, depth, budget);
    }
    return;
  }
  if (typeof v === "object") {
    const obj = v as Record<string, unknown>;
    // A menu item config like { label, tooltip, group } — read its text-ish keys.
    for (const k of [...LABEL_STRING_KEYS, "tooltip"]) {
      const pv = safeGet(obj, k);
      if (typeof pv === "string") extractText(pv, out, depth, budget);
      else if (isReactElement(pv) || Array.isArray(pv)) extractText(pv, out, depth - 1, budget);
    }
    for (const k of ["items", "options", "children"]) {
      const pv = safeGet(obj, k);
      if (Array.isArray(pv) || isReactElement(pv)) extractText(pv, out, depth - 1, budget);
    }
  }
}

/** Text a control opens or is described by, recovered from its ancestor fibers'
 *  props without any interaction — closed-menu item labels, an un-DOM'd tooltip.
 *  Only called for weak-labelled controls; bounded up-walk + node budget. */
function unrenderedSignals(el: Element): string[] {
  const out: string[] = [];
  try {
    const budget = { nodes: 400 };
    let f = fiberOf(el);
    let hops = 0;
    while (f && hops++ < 8 && out.length < 8 && budget.nodes > 0) {
      let props: Record<string, unknown> | null = null;
      try {
        const p = f.memoizedProps;
        if (p && typeof p === "object") props = p as Record<string, unknown>;
      } catch {
        props = null;
      }
      if (props) {
        let overlay = false;
        try {
          overlay = isOverlayName(displayName(f.type));
        } catch {
          overlay = false;
        }
        const before = out.length;
        // Content props (a menu's items, a tooltip body) may sit on any ancestor
        // — real apps pass them to non-overlay wrappers (a `dropdown` prop on a
        // button). `children` is the rendered subtree everywhere except overlay
        // wrappers, where it is the un-mounted popover content — read it only there.
        for (const k of CONTENT_PROP_KEYS) extractText(safeGet(props, k), out, 6, budget);
        if (overlay) extractText(safeGet(props, "children"), out, 6, budget);
        for (const k of LABEL_STRING_KEYS) {
          const pv = safeGet(props, k);
          if (typeof pv === "string") extractText(pv, out, 6, budget);
        }
        // Stop at the nearest ancestor that yields content: a weak icon should be
        // described by its own wrapper's menu/tooltip, not inherit an unrelated
        // list's labels from a distant shared ancestor (cross-contamination).
        if (out.length > before) break;
      }
      f = f.return ?? null;
    }
  } catch {
    // One hostile fiber must never blind the page — return whatever we gathered.
  }
  return out;
}

/** The onClick/handler source and authoring site of a control (dev builds only) —
 *  the "what does this do" evidence when even props don't name it. Both are absent
 *  in production React, so this returns undefined there. */
function controlProvenance(el: Element): { handler?: string; source?: string } {
  const out: { handler?: string; source?: string } = {};
  try {
    let g = fiberOf(el);
    let hops = 0;
    while (g && hops++ < 6) {
      const props = (g.memoizedProps ?? {}) as Record<string, unknown>;
      const onClick = safeGet(props, "onClick") ?? safeGet(props, "onSelect") ?? safeGet(props, "onChange");
      if (typeof onClick === "function" && !out.handler) {
        // A hostile toString() must not escape — the whole point of provenance is
        // to survive weird handlers, not crash on them.
        try {
          const src = String(onClick).slice(0, 400).replace(/\s+/g, " ").trim();
          if (src && src.length < 200) out.handler = src;
        } catch {
          /* unreadable handler — skip */
        }
      }
      const dbg = (g as { _debugSource?: { fileName?: string; lineNumber?: number } })._debugSource;
      if (dbg?.fileName && !out.source) {
        const file = dbg.fileName.split("/").slice(-2).join("/");
        out.source = `${file}:${dbg.lineNumber ?? "?"}`;
      }
      if (out.handler && out.source) break;
      g = g.return ?? null;
    }
  } catch {
    /* one hostile fiber must not blind `why` */
  }
  return out;
}

/** How likely a control is a dropdown/menu trigger, from DOM markers only —
 *  used to spend the resolveIntent signal budget on real overlay triggers first
 *  on a large page, before arbitrary weak icons. */
function triggerRank(el: Element): number {
  let r = 0;
  if (el.hasAttribute("aria-haspopup")) r += 2;
  if (el.hasAttribute("aria-expanded") || el.hasAttribute("aria-controls")) r += 1;
  const cls = typeof el.className === "string" ? el.className : "";
  if (/dropdown|menu|caret|combobox|popover|select/i.test(`${el.id} ${cls}`)) r += 1;
  return r;
}

function isVisible(el: Element): boolean {
  const he = el as HTMLElement;
  const cs = getComputedStyle(he);
  if (cs.visibility === "hidden" || cs.display === "none") return false;
  if (!he.offsetParent && cs.position !== "fixed") return false;
  const r = he.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

/** Parse `Name[prop~="value"]` / `Name[prop="value"]` / `Name` component exprs. */
function parseComponentExpr(expr: string): { name: string; prop?: string; op?: "~=" | "="; value?: string } | null {
  const m = expr.match(/^([A-Za-z0-9_$.]+)(?:\[([A-Za-z0-9_$.]+)(~?=)"([^"]*)"\])?$/);
  if (!m || m[1] === undefined) return null;
  return { name: m[1], prop: m[2], op: m[3] as "~=" | "=" | undefined, value: m[4] };
}

/** A table or sizable list the agent reasons about by size, not by enumerating
 *  every row control. The page snapshot and the digest's `counts` key these the
 *  same way (`table:PartsTable`), so a row-count change in a digest lines up with
 *  the collection in the last snapshot. */
type Collection = { el: Element; kind: string; label: string; rows: number };

function collectionRows(el: Element): number {
  const role = el.getAttribute("role");
  if (el.tagName === "TABLE" || role === "grid" || role === "table") {
    const roleRows = el.querySelectorAll("[role=row]").length;
    if (roleRows) return roleRows;
    const bodyRows = el.querySelectorAll("tbody tr").length;
    return bodyRows || el.querySelectorAll("tr").length;
  }
  const items = el.querySelectorAll(":scope > li, :scope > [role=listitem], :scope > [role=option]").length;
  return items || el.querySelectorAll("li, [role=listitem], [role=option]").length;
}

function collectionLabel(el: Element): string {
  const aria = el.getAttribute("aria-label");
  if (aria?.trim()) return aria.trim().slice(0, 60);
  const cap = el.querySelector(":scope > caption, :scope > legend")?.textContent?.replace(/\s+/g, " ").trim();
  if (cap) return cap.slice(0, 60);
  const lb = labelledByText(el);
  if (lb) return lb.slice(0, 60);
  const comp = nearestComponent(el);
  if (comp) return comp;
  return el.id ? `#${el.id}` : (el.getAttribute("role") ?? el.tagName.toLowerCase());
}

function namedCollections(root: Element): Collection[] {
  const out: Collection[] = [];
  for (const t of Array.from(root.querySelectorAll("table, [role=grid], [role=table]"))) {
    if (!isVisible(t)) continue;
    const rows = collectionRows(t);
    if (rows < 3) continue; // a 2-row "table" is layout, not a collection
    out.push({ el: t, kind: "table", label: collectionLabel(t), rows });
  }
  for (const l of Array.from(root.querySelectorAll("ul, ol, [role=list]"))) {
    if (!isVisible(l)) continue;
    const rows = collectionRows(l);
    if (rows < 8) continue; // small lists (navs, tab strips) aren't collections
    out.push({ el: l, kind: "list", label: collectionLabel(l), rows });
  }
  return out;
}

function inCollection(el: Element, collectionEls: Set<Element>): boolean {
  let p: Element | null = el;
  while (p) {
    if (collectionEls.has(p)) return true;
    p = p.parentElement;
  }
  return false;
}

// Dialogs/popovers whose appearance/disappearance is a T0 digest signal. Beyond
// the ARIA roles, a project can name non-ARIA overlays (a URL-state modal, a
// class-based popover) via adapt.surfaceSelectors.
// `dialog[open]` (not bare `dialog`): native dialogs carry an implicit ARIA role
// that attribute selectors can't see, and closed <dialog> shells are mounted but
// not a surface until shown.
const SURFACE_SELECTOR = "[role=dialog],[role=alertdialog],[role=listbox],[role=menu],dialog[open]";
const ADAPT_SURFACE_SELECTORS = (ADAPT.surfaceSelectors ?? []).slice(0, 20);

function surfaceLabel(el: Element): string {
  const aria = el.getAttribute("aria-label");
  if (aria?.trim()) return aria.trim().slice(0, 60);
  const lb = labelledByText(el);
  if (lb) return lb.slice(0, 60);
  const h = el.querySelector("h1,h2,h3,h4,h5,h6,[role=heading]")?.textContent?.replace(/\s+/g, " ").trim();
  if (h) return h.slice(0, 60);
  return el.id ? `#${el.id}` : (el.getAttribute("role") ?? el.tagName.toLowerCase());
}

const STRUCTURAL_TAGS = new Set(["html", "body", "main", "section", "nav", "header", "footer", "aside"]);
/** A config surface selector can still name a page-layout element via a class
 *  (`.app-main`); reject those by shape — a structural tag, or an element that
 *  fills most of the viewport — so routine navigation isn't reported as a dialog
 *  opening/closing (red-team atk6). A real overlay is a bounded, non-layout box. */
function isPlausibleOverlay(el: Element): boolean {
  if (STRUCTURAL_TAGS.has(el.tagName.toLowerCase())) return false;
  const r = (el as HTMLElement).getBoundingClientRect();
  const area = r.width * r.height;
  const viewport = window.innerWidth * window.innerHeight;
  return viewport === 0 || area <= viewport * 0.85;
}

/** Visible dialogs/popovers, keyed `role:label` — diffed across an action to
 *  report what opened/closed. */
function currentSurfaces(): string[] {
  const out = new Set<string>();
  for (const el of Array.from(document.querySelectorAll(SURFACE_SELECTOR))) {
    // A native <dialog> has an implicit role no attribute read can see.
    if (isVisible(el)) out.add(`${el.getAttribute("role") ?? el.tagName.toLowerCase()}:${surfaceLabel(el)}`);
    if (out.size >= 40) break;
  }
  // Config-named non-ARIA overlays, keyed `overlay:`. Each selector is queried in
  // isolation (a bad selector can't wipe the read) AND rejected if it matches
  // many visible elements — a discrete overlay matches a few, so a broad or
  // hostile selector (`*`, `div`) that floods the digest is a misconfiguration,
  // not a surface. Skip it rather than drown real open/close signals in noise.
  const MAX_PER_SELECTOR = 6;
  for (const sel of ADAPT_SURFACE_SELECTORS) {
    if (out.size >= 40) break;
    try {
      const vis = Array.from(document.querySelectorAll(sel)).filter(isVisible).filter(isPlausibleOverlay);
      if (vis.length === 0 || vis.length > MAX_PER_SELECTOR) continue;
      for (const el of vis) out.add(`overlay:${surfaceLabel(el)}`);
    } catch {
      // invalid selector in a project's config — skip it, don't crash the digest
    }
  }
  return [...out];
}

/** The focused control's label, or null when focus rests on the body / an
 *  unlabeled node — reported only when it names something an agent can act on. */
function currentFocus(): string | null {
  const a = document.activeElement;
  if (!a || a === document.body || a === document.documentElement) return null;
  const d = controlLabel(a);
  return d.weak ? null : d.text;
}

function currentCounts(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of namedCollections(document.body)) out[`${c.kind}:${c.label}`] = c.rows;
  return out;
}

function findReactContainer(): Element | null {
  for (const el of [document.documentElement, ...Array.from(document.querySelectorAll("*"))]) {
    for (const k in el) if (k.startsWith("__reactContainer$")) return el;
  }
  return document.getElementById("root") ?? document.getElementById("__next") ?? null;
}

let remountArmTries = 0;
/** Watch the React container's first child identity: a full Fast Refresh / HMR
 *  remount swaps it, ordinary re-renders don't. Retries until the container has
 *  mounted (addInitScript runs before React does), then owns window.__fsRemount
 *  so the `remount` verb reads this count instead of arming a second sentinel. */
function armRemountSentinel(): void {
  if (typeof window === "undefined" || window.__fsRemount) return;
  const root = findReactContainer();
  if ((!root || !root.firstElementChild) && remountArmTries++ < 50) {
    setTimeout(armRemountSentinel, 100);
    return;
  }
  const container = root ?? document.body;
  if (!container) return;
  const state: RemountState = { count: 0, lastAt: 0, firstChild: container.firstElementChild, container };
  const obs = new MutationObserver(() => {
    const fc = container.firstElementChild;
    if (state.firstChild && fc && fc !== state.firstChild) {
      state.count++;
      state.lastAt = Date.now();
      state.firstChild = fc;
    } else if (fc) {
      state.firstChild = fc;
    }
  });
  try {
    obs.observe(container, { childList: true });
    window.__fsRemount = state;
  } catch {
    if (remountArmTries++ < 50) setTimeout(armRemountSentinel, 100);
  }
}

function buildRuntime() {
  const adapters = new Map<string, Adapter>();
  // Live-work sources feeding the settle signal, keyed by adapter name. Each
  // reads {pending, started}: the monotonic counter lets work that starts AND
  // finishes between two settle polls still be detected — an idle-only read
  // would miss it (the debounce hole WP2 closes). TanStack joins on discovery;
  // project adapters join via register() when they carry an `activity` field.
  const activitySources = new Map<string, () => { pending: number; started: number }>();
  // Sources whose most recent activity() read threw. Settle math treats them as
  // idle — one broken adapter must not jam every wait on the page — but silent
  // idleness is a vacuous settle nobody can see, so doctor names these.
  const activityBroken = new Set<string>();
  // Project adapters return arbitrary shapes; summed raw, a NaN pending jams
  // every settle wait forever (NaN === 0 is never true), a string "0" turns the
  // sum into string concat, and a negative sum never reaches zero. Count only
  // finite positives; everything else reads as idle.
  const normCount = (v: unknown): number => {
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  const observations: Observation[] = [];
  const MAX_OBS = 1000;
  let refSeq = 0;
  let mutationWeight = 0;
  // How many remounts have already been folded into a digest. Non-destructive
  // in drain() so a remount between actions survives preDrain and reaches the
  // next action's digest; markRemountsReported() acks after folding.
  let remountReported = 0;
  let discoveryTries = 0;
  // Every ref is stamped with this document's tag; a ref from a dead document
  // fails the tag check instead of silently matching a re-minted element.
  const docTag = Math.random().toString(36).slice(2, 6);
  const mintRef = (el: Element): string => {
    let ref = el.getAttribute("data-fs-ref");
    if (!ref || !ref.endsWith(`.${docTag}`)) {
      ref = `e${++refSeq}.${docTag}`;
      el.setAttribute("data-fs-ref", ref);
    }
    return ref;
  };

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
    for (const m of muts) {
      // Our own ref mints must not count as page activity (false dead-click signal).
      if (m.type === "attributes" && m.attributeName === "data-fs-ref") continue;
      mutationWeight++;
    }
  });
  const startMo = () => {
    try {
      mo.observe(document.body ?? document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
    } catch {
      setTimeout(startMo, 100);
    }
  };
  startMo();
  armRemountSentinel();
  const noteRoute = () => pushObs({ kind: "route", url: location.pathname + location.search, ts: Date.now() });
  const origPush = history.pushState.bind(history);
  history.pushState = (...args) => {
    origPush(...(args as Parameters<History["pushState"]>));
    noteRoute();
  };
  const origReplace = history.replaceState.bind(history);
  history.replaceState = (...args) => {
    origReplace(...(args as Parameters<History["replaceState"]>));
    noteRoute();
  };
  window.addEventListener("popstate", noteRoute);

  // Zero app cooperation (validated by the WP0 spike). One fiber walk finds both
  // adapters; on apps that use neither, retries are capped so settle-loop polls
  // stop re-walking the whole tree every 150ms (WP0-review #11). The cap is high
  // enough that a slow-hydrating app still gets found (adapters mount at the
  // root during hydration, not per-route); a reload resets it via a fresh runtime.
  const MAX_DISCOVERY_TRIES = 8;
  function discoverAdapters(): string[] {
    // React Router's data router is a plain window global in dev builds — an
    // O(1) read, so it sits outside the fiber-walk try cap.
    if (!adapters.has("router")) {
      const r = (window as unknown as { __reactRouterDataRouter?: RR7Router }).__reactRouterDataRouter;
      if (r && typeof r.subscribe === "function" && r.state?.navigation) {
        const t = makeRouterAdapter(r);
        adapters.set("router", t.adapter);
        activitySources.set("router", t.activity);
      }
    }
    let needQueries = !adapters.has("queries");
    let needJotai = !adapters.has("jotai");
    if ((!needQueries && !needJotai) || discoveryTries >= MAX_DISCOVERY_TRIES) return [...adapters.keys()];
    discoveryTries++;
    for (const f of walkAllFibers()) {
      if (needQueries) {
        const c = (f.memoizedProps as { client?: { getQueryCache?: () => unknown } } | null)?.client;
        if (c && typeof c.getQueryCache === "function") {
          const t = makeTanstackAdapter(c as never);
          adapters.set("queries", t.adapter);
          activitySources.set("queries", t.activity);
          needQueries = false;
        }
      }
      if (needJotai) {
        const p = f.memoizedProps as { store?: unknown; value?: unknown } | null;
        const s = (p?.store ?? p?.value) as { get?: unknown; set?: unknown; sub?: unknown } | undefined;
        if (s && typeof s.get === "function" && typeof s.set === "function" && typeof s.sub === "function") {
          adapters.set("jotai", makeJotaiAdapter(s as never));
          needJotai = false;
        }
      }
      if (!needQueries && !needJotai) break;
    }
    return [...adapters.keys()];
  }

  const api = {
    version: RUNTIME_VERSION,
    docTag,

    snapshot(opts?: { budget?: "concise" | "detailed"; scope?: string }) {
      const scopeEl = opts?.scope ? document.querySelector(opts.scope) : document.body;
      if (!scopeEl) return { error: `scope matched nothing: ${opts?.scope}` };
      const detailed = opts?.budget === "detailed";
      const collections = namedCollections(scopeEl);
      const collectionEls = new Set(collections.map((c) => c.el));
      const els = Array.from(scopeEl.querySelectorAll(INTERACTABLE_SELECTOR)).filter(isVisible);
      // Concise mode collapses controls inside a collection into its summary — a
      // 10k-row table must not enumerate 10k refs. --scope <selector> paginates
      // into one collection when the agent needs its individual controls.
      const flat = detailed ? els : els.filter((el) => !inCollection(el, collectionEls));
      const cap = detailed ? 250 : 60;
      const interactables = flat.slice(0, cap).map((el) => {
        try {
          const d = controlLabel(el);
          const entry: Record<string, unknown> = { ref: mintRef(el), role: roleOf(el), text: d.text };
          // A weak label (id/component/tag fallback) carries the component name so
          // an icon-only control is still identifiable — "never bare button".
          if (d.weak || detailed) {
            const comp = nearestComponent(el);
            if (comp) entry.component = comp;
          }
          // Weak DOM label → recover text from ancestor fiber props (closed-menu
          // item labels, un-DOM'd tooltips) so an unlabeled icon control is still
          // addressable by what it opens/says.
          if (d.weak) {
            const sig = unrenderedSignals(el);
            if (sig.length) entry.signals = sig.slice(0, 6);
          }
          return entry;
          // One control with a hostile fiber must not sink the whole snapshot.
        } catch {
          return { ref: mintRef(el), role: roleOf(el), text: el.id ? `#${el.id}` : el.tagName.toLowerCase() };
        }
      });
      const collectionOut = collections.map((c) => {
        const entry: Record<string, unknown> = { kind: c.kind, label: c.label, ref: mintRef(c.el), rows: c.rows };
        if (!detailed) {
          const sample = Array.from(c.el.querySelectorAll(INTERACTABLE_SELECTOR))
            .filter(isVisible)
            .slice(0, 2)
            .map((el) => ({ ref: mintRef(el), role: roleOf(el), text: controlLabel(el).text }));
          if (sample.length) entry.sample = sample;
        }
        return entry;
      });
      const surfaces = currentSurfaces();
      return {
        url: location.pathname + location.search,
        title: document.title,
        interactables,
        collections: collectionOut.length ? collectionOut : undefined,
        surfaces: surfaces.length ? surfaces : undefined,
        truncated: flat.length > cap ? flat.length : undefined,
      };
    },

    resolveIntent(text: string, role?: string) {
      // Normalize case + whitespace so "  Open   Preview " matches "Open Preview".
      // Matching is substring/equality (never a regex), so a label with regex
      // metacharacters ("Add (+)", "Next >") is matched literally.
      const needle = String(text ?? "").toLowerCase().replace(/\s+/g, " ").trim();
      if (!needle) return [];
      // Include hidden matches but penalize them, so the sole match being hidden
      // surfaces as a low-confidence candidate ("it exists but you can't see it")
      // rather than a bare E_TARGET_NOT_FOUND.
      // Order likely dropdown/menu triggers first (a cheap DOM-only rank, no
      // fiber walk) so the bounded signal budget below reaches the real overlay
      // controls before arbitrary weak icons on a 247-button modal.
      const els = Array.from(document.querySelectorAll(INTERACTABLE_SELECTOR)).sort(
        (a, b) => triggerRank(b) - triggerRank(a)
      );
      // Signal extraction (ancestor fiber props) is bounded per resolve so a
      // label-hostile page with many weak controls can't blow the budget.
      let signalBudget = 60;
      const scored = els
        .map((el) => {
          try {
            const d = controlLabel(el);
            const label = d.text.toLowerCase().replace(/\s+/g, " ").trim();
            const r = roleOf(el);
            let score = 0;
            let via = "";
            if (label === needle) score = 1;
            else if (label.includes(needle)) score = 0.7 + Math.min(0.2, needle.length / Math.max(label.length, 1) / 5);
            // No DOM-label match on a weak control: try the text it opens/says.
            // A signal hit resolves lower than a direct label — "this control opens
            // something called X" is weaker evidence than "this control is X".
            else if (d.weak && signalBudget > 0) {
              signalBudget--;
              const sig = unrenderedSignals(el).map((s) => s.toLowerCase());
              if (sig.some((s) => s === needle)) { score = 0.7; via = "opens"; }
              else if (sig.some((s) => s.includes(needle))) { score = 0.55; via = "opens"; }
              else return null;
            } else return null;
            if (role && r !== role) score -= 0.4; // prefer role matches
            if (!isVisible(el)) score -= 0.5; // penalize hidden-but-matching
            return { el, score, role: r, text: d.text, via };
          } catch {
            return null; // a hostile fiber on one control must not fail the resolve
          }
        })
        .filter((x): x is NonNullable<typeof x> => !!x && x.score > 0.15)
        .sort((a, b) => b.score - a.score)
        .slice(0, 8);
      return scored.map((s) => ({
        ref: mintRef(s.el),
        role: s.role,
        text: s.via ? `${s.text} (opens “${needle}”)` : s.text,
        component: nearestComponent(s.el),
        confidence: Number(Math.max(0, s.score).toFixed(2)),
      }));
    },

    resolveComponent(expr: string) {
      const parsed = parseComponentExpr(expr);
      if (!parsed) return { error: `bad component expr: ${expr}` };
      const hits: Array<{ ref: string; role: string; text: string; component: string; confidence: number }> = [];
      // One hit per component INSTANCE: dedupe by the matched fiber (and its
      // work-in-progress alternate), anchored at its first host element in
      // document order. Element-keyed dedupe returned N phantom candidates
      // for a single mounted component.
      const seenFibers = new WeakSet<Fiber>();
      for (const el of Array.from(document.querySelectorAll("*"))) {
        if (hits.length >= 8) break;
        let f = fiberOf(el);
        let guard = 0;
        while (f && guard++ < 25) {
          if (displayName(f.type) === parsed.name) {
            const alt = (f as { alternate?: Fiber | null }).alternate;
            if (seenFibers.has(f) || (alt && seenFibers.has(alt))) break;
            const props = (f.memoizedProps ?? {}) as Record<string, unknown>;
            let ok = true;
            if (parsed.prop) {
              const v = String(props[parsed.prop] ?? "");
              ok = parsed.op === "~=" ? v.toLowerCase().includes(parsed.value!.toLowerCase()) : v === parsed.value;
            }
            if (ok && isVisible(el)) {
              seenFibers.add(f);
              if (alt) seenFibers.add(alt);
              hits.push({ ref: mintRef(el), role: roleOf(el), text: labelOf(el), component: parsed.name, confidence: 1 });
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
      // Adapter results are query/atom data, not fiber nodes, so keep `key`/`ref`
      // (the TanStack query key names each entry). The React-internal-key strip
      // is for fiber snapshots (state()), not adapter dispatch (WP7 handoff 1).
      return safeSnapshot(await Promise.resolve(adapter.dispatch(action)), 0, { includeInternals: true });
    },

    register(name: string, adapter: Adapter) {
      // Built-in discovery owns these names. A project adapter grabbing one
      // registers before React hydrates, so discovery would see the name taken
      // and silently never wire the real integration — dispatch AND settle.
      if (name === "queries" || name === "jotai" || name === "router") {
        throw new Error(`adapter name "${name}" is reserved for built-in discovery — pick another name`);
      }
      adapters.set(name, adapter);
      if (typeof adapter.activity === "function") activitySources.set(name, adapter.activity);
    },

    queriesPending(): number {
      discoverAdapters();
      let pending = 0;
      for (const [name, read] of activitySources) {
        try {
          pending += normCount(read().pending);
          activityBroken.delete(name);
        } catch {
          activityBroken.add(name);
        }
      }
      return pending;
    },

    /** Live pending count plus a monotonic count of work-starts since injection,
     *  summed across every activity source. `started` is the "did work fire?"
     *  read the debounce-aware settle needs: comparing it against a baseline
     *  catches work that ran entirely inside a poll gap, which `queriesPending`
     *  (a point-in-time read) cannot see. */
    queriesActivity(): { pending: number; started: number } {
      discoverAdapters();
      let pending = 0;
      let started = 0;
      for (const [name, read] of activitySources) {
        try {
          const a = read();
          pending += normCount(a.pending);
          started += normCount(a.started);
          activityBroken.delete(name);
        } catch {
          activityBroken.add(name);
        }
      }
      return { pending, started };
    },

    /** Names of adapters whose activity() threw on its latest read — surfaced
     *  by doctor so a broken settle feed is loud instead of vacuously idle. */
    activityBroken: () => [...activityBroken],

    /** The live router's route tree as URL paths, for the `routes` verb on
     *  non-Next apps — the runtime truth, no source parsing. */
    routerRoutes(): string[] {
      discoverAdapters();
      const r = (window as unknown as { __reactRouterDataRouter?: RR7Router }).__reactRouterDataRouter;
      if (!r?.routes) return [];
      const out: string[] = [];
      const walk = (routes: Array<{ path?: string; index?: boolean; children?: unknown[] }>, base: string): void => {
        for (const rt of routes) {
          const full = rt.path ? `${base}/${rt.path}`.replace(/\/+/g, "/") : base || "/";
          if (rt.index || rt.path) out.push(rt.index ? (base || "/") : full);
          if (Array.isArray(rt.children)) walk(rt.children as never, rt.path ? full : base);
        }
      };
      walk(r.routes, "");
      return [...new Set(out)];
    },

    /** Digest source. mutations/errors/route reset each call (deltas); surfaces/
     *  focus/counts are absolute current-state reads the pipeline diffs against a
     *  baseline drain; remounts are cumulative and non-destructive so one between
     *  actions still reaches the next digest. */
    drain() {
      const errors = observations.filter((o) => o.kind === "error" || (o.kind === "console" && o.level === "error"));
      const routes = observations.filter((o) => o.kind === "route") as Array<{ url: string }>;
      const remounts = window.__fsRemount?.count ?? 0;
      if (remounts < remountReported) remountReported = remounts; // `remount --reset` resync
      const out = {
        mutationWeight,
        errors: errors.slice(-5).map((e) => (e as { body: string }).body),
        route: routes.at(-1)?.url,
        queriesPending: api.queriesPending(),
        surfaces: currentSurfaces(),
        focus: currentFocus(),
        counts: currentCounts(),
        remounts,
        remountsNew: remounts - remountReported,
      };
      mutationWeight = 0;
      observations.length = 0;
      return out;
    },

    /** Ack remounts already folded into a digest so they aren't re-reported. */
    markRemountsReported() {
      remountReported = window.__fsRemount?.count ?? remountReported;
    },

    count: (selector: string) => document.querySelectorAll(selector).length,
    route: () => ({ pathname: location.pathname, search: location.search }),

    /** Every identity signal for one control, so a blind agent can reason about
     *  what it does when no single clean label exists: DOM label, component, the
     *  text it opens/says (ancestor fiber props), and dev-only handler + source. */
    why(ref: string) {
      const el = document.querySelector(`[data-fs-ref="${ref}"]`);
      if (!el) return { error: `no element for ref ${ref}` };
      const d = controlLabel(el);
      const prov = controlProvenance(el);
      return {
        ref,
        role: roleOf(el),
        label: d.text,
        labelWeak: d.weak,
        component: nearestComponent(el),
        signals: unrenderedSignals(el),
        handler: prov.handler,
        source: prov.source,
        visible: isVisible(el),
      };
    },
  };

  return api;
}

type RR7Router = {
  state: {
    location: { pathname: string; search: string };
    navigation: { state: string };
    fetchers: Map<string, { state: string }>;
    matches?: Array<{ pathname?: string; route?: { id?: string; path?: string } }>;
    loaderData?: Record<string, unknown>;
  };
  routes?: Array<{ path?: string; index?: boolean; children?: unknown[] }>;
  subscribe: (fn: (s: RR7Router["state"]) => void) => () => void;
  navigate: (to: string) => unknown;
  revalidate?: () => unknown;
};

/** React Router data-router adapter (framework/dev builds expose the router at
 *  window.__reactRouterDataRouter). Navigation + fetcher activity feed settle
 *  the way TanStack fetches do, so `--settled` means "loaders and actions are
 *  actually done" — the framework signal a generic driver can't produce. */
function makeRouterAdapter(router: RR7Router): { adapter: Adapter; activity: () => { pending: number; started: number } } {
  let started = 0;
  let wasBusy = false;
  // A fetcher orphaned by a hot-reload remount can sit non-idle forever; one
  // whose state hasn't changed in ORPHAN_MS stops counting toward pending
  // (still visible via getState) so HMR debris can't jam settle.
  const ORPHAN_MS = 30_000;
  const fetcherSeen = new Map<string, { state: string; ts: number }>();

  const busyCount = (s: RR7Router["state"]): number => {
    let n = s.navigation.state !== "idle" ? 1 : 0;
    const now = Date.now();
    for (const [key, f] of s.fetchers) {
      if (f.state === "idle") {
        fetcherSeen.delete(key);
        continue;
      }
      const seen = fetcherSeen.get(key);
      if (!seen || seen.state !== f.state) {
        fetcherSeen.set(key, { state: f.state, ts: now });
        n++;
      } else if (now - seen.ts < ORPHAN_MS) {
        n++;
      }
    }
    return n;
  };

  // The subscription's only job is the monotonic started counter: an aggregate
  // idle→busy edge counts once, so work that begins AND ends inside a settle
  // poll gap is still seen. Overlapping bursts collapse into one edge, which
  // is fine — pending covers everything longer than a gap.
  try {
    router.subscribe((s) => {
      const busy = busyCount(s) > 0;
      if (busy && !wasBusy) started++;
      wasBusy = busy;
    });
  } catch { /* without subscribe, point-in-time pending still works */ }

  const snapshot = () => {
    const s = router.state;
    return {
      location: s.location.pathname + s.location.search,
      navigation: s.navigation.state,
      fetchers: [...s.fetchers].map(([key, f]) => ({ key, state: f.state })),
      matches: (s.matches ?? []).map((m) => m.route?.path ?? m.pathname ?? m.route?.id).filter(Boolean),
      loaderData: s.loaderData ?? {},
    };
  };

  return {
    adapter: {
      getState: snapshot,
      dispatch(action: unknown) {
        const a = action as { op?: string; to?: string };
        const op = a?.op ?? "list";
        switch (op) {
          case "list": return snapshot();
          case "navigate":
            if (!a.to) throw new Error("router dispatch: `to` required for op=navigate");
            return Promise.resolve(router.navigate(a.to)).then(() => ({ ok: true, to: a.to }));
          case "revalidate":
            if (typeof router.revalidate !== "function") throw new Error("router dispatch: this router has no revalidate()");
            return Promise.resolve(router.revalidate()).then(() => ({ ok: true, op }));
          default: throw new Error(`router dispatch: unknown op ${op} (ops: list, navigate, revalidate)`);
        }
      },
    },
    activity: () => ({ pending: busyCount(router.state), started }),
  };
}

function makeTanstackAdapter(client: {
  getQueryCache: () => {
    getAll: () => Array<{ queryKey: readonly unknown[]; state: { data: unknown; status: string; fetchStatus: string; error: unknown; dataUpdatedAt: number } }>;
    subscribe?: (listener: () => void) => () => void;
  };
  getQueryData: (k: readonly unknown[]) => unknown;
  setQueryData: (k: readonly unknown[], d: unknown) => unknown;
  invalidateQueries: (f: { queryKey: readonly unknown[] }) => Promise<void>;
  refetchQueries: (f: { queryKey: readonly unknown[] }) => Promise<unknown>;
  resetQueries: (f: { queryKey: readonly unknown[] }) => Promise<void>;
}): { adapter: Adapter; activity: () => { pending: number; started: number } } {
  const cache = client.getQueryCache();

  // Monotonic count of query fetch-starts. A subscription re-scans the cache on
  // every change and increments `started` for each query newly in `fetching`,
  // so a query that starts and finishes inside a settle poll gap is still
  // counted. Point-in-time `pending` alone can't see that, which is exactly the
  // debounce case: the query fires after the settle pass has already read idle.
  let started = 0;
  const fetching = new Set<string>();
  const keyId = (q: { queryKey: readonly unknown[] }): string => {
    try { return JSON.stringify(q.queryKey); } catch { return String(q.queryKey); }
  };
  const rescan = (): void => {
    const now = new Set<string>();
    for (const q of cache.getAll()) {
      if (q.state.fetchStatus === "fetching") {
        const id = keyId(q);
        now.add(id);
        if (!fetching.has(id)) started++;
      }
    }
    fetching.clear();
    for (const id of now) fetching.add(id);
  };
  try {
    rescan();    // seed the fetching set with anything already in flight
    started = 0; // ...but don't count pre-existing fetches as "started since baseline"
    cache.subscribe?.(() => rescan());
  } catch { /* a cache without subscribe: `pending` still works via live reads */ }

  const activity = (): { pending: number; started: number } => {
    let pending = 0;
    try {
      for (const q of cache.getAll()) if (q.state.fetchStatus === "fetching") pending++;
    } catch { /* transient cache access */ }
    return { pending, started };
  };

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
    adapter: {
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
    },
    activity,
  };
}

function makeJotaiAdapter(store: {
  get: (a: unknown) => unknown;
  set: (a: unknown, v: unknown) => unknown;
  dev4_get_mounted_atoms?: () => Iterable<{ debugLabel?: string; toString?: () => string }>;
}): Adapter {
  // Atom enumeration needs jotai's dev store API, absent on production bundles.
  // Without it discovery still "succeeds" (get/set/sub exist), so the adapter
  // must announce that atoms are unreadable rather than silently return []
  // (WP0-review #16).
  const hasDevApi = typeof store.dev4_get_mounted_atoms === "function";
  const DEGRADED =
    "jotai store detected but its dev enumeration API (dev4_get_mounted_atoms) is absent — likely a production build; atoms can't be listed or read by name. Rebuild with a development env to inspect atoms.";
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
    getState: () =>
      hasDevApi
        ? enumerate().map(({ name, value, error }) => (error ? { name, error } : { name, value }))
        : [{ degraded: DEGRADED }],
    dispatch(action: unknown) {
      const a = action as { op?: string; atom?: string; value?: unknown };
      const op = a?.op ?? "list";
      if (op === "list") return this.getState();
      if (!hasDevApi) throw new Error(DEGRADED);
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
