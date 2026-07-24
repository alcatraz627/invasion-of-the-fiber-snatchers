/** The e2e playground: a single-page React app reproducing every targeting and
 *  timing trap the V1 usage mining surfaced, deterministically. Served by
 *  serve.ts; driven by the real CLI in tests/e2e/. Trap inventory:
 *  duplicate search inputs, icon-only buttons, ambiguous row labels, debounced
 *  search, delayed TanStack query, modal, tabs, 10k-row table, jotai atom. */

import { StrictMode, useEffect, useRef, useState, type ReactNode, type UIEvent } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { Provider as JotaiProvider, atom, createStore, useAtom } from "jotai";

const themeAtom = atom("light");
themeAtom.debugLabel = "themeAtom";
const store = createStore();

const ROWS = Array.from({ length: 10_000 }, (_, i) => ({
  id: i,
  name: `Part ${i}`,
  status: i % 7 === 0 ? "failed" : "completed",
}));

function useDelayedParts(filter: string) {
  return useQuery({
    queryKey: ["parts", filter],
    queryFn: async () => {
      await new Promise((r) => setTimeout(r, 400)); // deterministic settle window
      const f = filter.toLowerCase();
      return ROWS.filter((r) => r.name.toLowerCase().includes(f));
    },
  });
}

function SearchBox({ id, placeholder }: { id: string; placeholder: string }) {
  const [v, setV] = useState("");
  return <input id={id} placeholder={placeholder} value={v} onChange={(e) => setV(e.target.value)} />;
}

function PartsTable() {
  const [raw, setRaw] = useState("");
  const [debounced, setDebounced] = useState("");
  const [failedOnly, setFailedOnly] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(raw), 250);
    return () => clearTimeout(t);
  }, [raw]);
  const { data, isFetching } = useDelayedParts(debounced);
  const rows = data ?? [];
  // #row-count stays the query-result total (existing settle tests poll it); the
  // Failed-only toggle filters the RENDERED rows synchronously, giving the digest
  // a deterministic collection-count delta with no async query in the way.
  const shown = rows.slice(0, 50);
  const visible = failedOnly ? shown.filter((r) => r.status === "failed") : shown;
  return (
    <section>
      <input placeholder="Search" value={raw} onChange={(e) => setRaw(e.target.value)} aria-label="parts search" />
      <div id="fetch-state">{isFetching ? "fetching" : "idle"}</div>
      <div id="row-count">{rows.length} rows</div>
      <button id="failed-toggle" onClick={() => setFailedOnly((f) => !f)}>{failedOnly ? "Showing failed" : "Failed only"}</button>
      <table>
        <tbody>
          {visible.map((r) => (
            <tr key={r.id} data-status={r.status}>
              <td>
                <button onClick={() => store.set(themeAtom, r.name)}>{r.name}</button>
              </td>
              <td>{r.status}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function Modal({ onClose }: { onClose: () => void }) {
  return (
    <div role="dialog" id="the-modal" style={{ border: "2px solid black", padding: 16 }}>
      <h2>Preview Modal</h2>
      <button onClick={onClose}>Close</button>
      <button>Export</button>
      <button>Export</button> {/* deliberate duplicate for ambiguity tests */}
    </div>
  );
}

/** A hand-rolled stand-in for React Router's dev-exposed data router, matching
 *  the shape contract the built-in router adapter reads (subscribe, navigate,
 *  state.navigation/fetchers, routes). Fake navigations hold a 600ms busy
 *  window so e2e can exercise settle + dispatch without a router dependency. */
function installFakeRouter() {
  const w = window as unknown as { __reactRouterDataRouter?: unknown };
  if (w.__reactRouterDataRouter) return;
  const listeners: Array<(s: unknown) => void> = [];
  const state = {
    location: { pathname: "/", search: "" },
    navigation: { state: "idle" },
    fetchers: new Map<string, { state: string }>(),
    matches: [] as unknown[],
    loaderData: { root: { seeded: true } },
  };
  const notify = () => listeners.forEach((l) => l(state));
  w.__reactRouterDataRouter = {
    state,
    _notify: notify,
    routes: [{ path: "/", children: [{ path: "parts" }, { path: "parts/:id" }] }],
    subscribe(fn: (s: unknown) => void) {
      listeners.push(fn);
      return () => {};
    },
    navigate(to: string) {
      state.navigation = { state: "loading" };
      notify();
      setTimeout(() => {
        state.location = { pathname: String(to), search: "" };
        state.navigation = { state: "idle" };
        notify();
      }, 600);
    },
    revalidate() {
      state.navigation = { state: "loading" };
      notify();
      setTimeout(() => {
        state.navigation = { state: "idle" };
        notify();
      }, 400);
    },
  };
}
installFakeRouter();

/** Native <dialog> surface: opened via showModal(), no role attribute — the
 *  implicit-ARIA case the surface digest must still track (the versable kit's
 *  modal pattern). The shell stays mounted while closed. */
function NativeDialog() {
  const ref = useRef<HTMLDialogElement | null>(null);
  return (
    <div>
      <button onClick={() => ref.current?.showModal()}>Open native dialog</button>
      <dialog ref={ref} id="native-dialog">
        <h2>Native Dialog</h2>
        <button onClick={() => ref.current?.close()}>Dismiss native</button>
      </dialog>
    </div>
  );
}

/** WP3a hover trap: a card that opens on pointer-enter and must STAY open while
 *  the pointer rests. The wrapper owns enter/leave and the card renders BELOW the
 *  trigger (never over it), so resting on the button doesn't fire mouseleave —
 *  that persistence is what `fs hover` asserts. */
function HoverPopover() {
  const [open, setOpen] = useState(false);
  return (
    <div id="hover-zone" style={{ display: "inline-block" }} onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button aria-label="Hover me">Hover me</button>
      {open && (
        <div role="dialog" aria-label="Hover Card" style={{ border: "1px solid gray", padding: 8 }}>
          Hover card content
        </div>
      )}
    </div>
  );
}

/** WP3a right-click trap: a zone that opens a role=menu on contextmenu (a T0
 *  surface signal). preventDefault stops the native browser menu. */
function ContextZone() {
  const [open, setOpen] = useState(false);
  return (
    <div id="ctx-zone" style={{ padding: 12, border: "1px dashed gray" }} onContextMenu={(e) => { e.preventDefault(); setOpen(true); }}>
      Right-click here
      {open && (
        <div role="menu" aria-label="Context Menu" style={{ border: "1px solid black", padding: 8 }}>
          <button role="menuitem" onClick={() => setOpen(false)}>Rename</button>
          <button role="menuitem" onClick={() => setOpen(false)}>Delete</button>
        </div>
      )}
    </div>
  );
}

/** WP3a drag trap: a 4-item HTML5 drag-and-drop reorder list (kept under the
 *  8-item collection threshold so it doesn't clutter the digest counts). #dnd-order
 *  mirrors the live order for a cheap assertion. */
function DndList() {
  const [items, setItems] = useState(["Alpha", "Bravo", "Charlie", "Delta"]);
  const dragIdx = useRef<number | null>(null);
  const onDrop = (to: number) => {
    const from = dragIdx.current;
    dragIdx.current = null;
    if (from === null || from === to) return;
    setItems((prev) => {
      const next = prev.slice();
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved!);
      return next;
    });
  };
  return (
    <div>
      <ul id="dnd-list" aria-label="Reorder list" style={{ listStyle: "none", padding: 0 }}>
        {items.map((name, i) => (
          <li
            key={name}
            id={`dnd-${name.toLowerCase()}`}
            draggable
            onDragStart={() => { dragIdx.current = i; }}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => onDrop(i)}
            style={{ padding: 4, border: "1px solid #ccc" }}
          >
            {name}
          </li>
        ))}
      </ul>
      <div id="dnd-order">{items.join(",")}</div>
    </div>
  );
}

/** WP3a drag trap (pointer-sensor style): reorders on raw mouse events
 *  (mousedown to grab, mouseup to drop) rather than native HTML5 drag — the
 *  handler shape dnd-kit's PointerSensor / react-dnd's mouse backend use, which
 *  `drag --via mouse` drives. Item-named ids stay stable across reorders. */
function PointerDndList() {
  const [items, setItems] = useState(["One", "Two", "Three", "Four"]);
  const dragIdx = useRef<number | null>(null);
  const onDrop = (to: number) => {
    const from = dragIdx.current;
    dragIdx.current = null;
    if (from === null || from === to) return;
    setItems((prev) => {
      const next = prev.slice();
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved!);
      return next;
    });
  };
  return (
    <div>
      <ul id="pdnd-list" aria-label="Pointer reorder list" style={{ listStyle: "none", padding: 0 }}>
        {items.map((name, i) => (
          <li
            key={name}
            id={`pdnd-${name.toLowerCase()}`}
            onMouseDown={() => { dragIdx.current = i; }}
            onMouseUp={() => onDrop(i)}
            style={{ padding: 4, border: "1px solid #ccc" }}
          >
            {name}
          </li>
        ))}
      </ul>
      <div id="pdnd-order">{items.join(",")}</div>
    </div>
  );
}

/** WP3a scroll trap: a windowed list that materializes 20 more rows each time it
 *  is scrolled to the bottom. The <ul aria-label="Windowed Rows"> is a named
 *  collection, so the row-count growth shows up in the digest's `counts` delta —
 *  the "rows materialized" signal a scroll verb must surface. */
function WindowedList() {
  const [count, setCount] = useState(20);
  const onScroll = (e: UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 4) setCount((c) => Math.min(c + 20, 200));
  };
  return (
    <div id="scroll-box" onScroll={onScroll} style={{ height: 120, overflow: "auto", border: "1px solid #888" }}>
      <ul aria-label="Windowed Rows" style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {Array.from({ length: count }, (_, i) => (
          <li key={i} style={{ height: 20 }}>Row {i}</li>
        ))}
      </ul>
    </div>
  );
}

// WP3b traps (append-only). Each is a form/layout/close case the V1 usage mining
// surfaced: a native select, a file input, a paste target that only an onPaste
// (not a fill) triggers, a width-responsive collection, and two dismiss modals —
// one that closes on Escape and one whose first Escape is swallowed.

function SelectBox() {
  const [value, setValue] = useState("all");
  return (
    <div>
      <select id="fs-select" aria-label="parts filter" value={value} onChange={(e) => setValue(e.target.value)}>
        <option value="all">All parts</option>
        <option value="failed">Failed only</option>
        <option value="done">Completed only</option>
      </select>
      <span id="fs-select-value">{value}</span>
    </div>
  );
}

function UploadBox() {
  const [names, setNames] = useState<string[]>([]);
  return (
    <div>
      <input
        id="fs-file"
        type="file"
        aria-label="upload parts"
        multiple
        onChange={(e) => setNames(Array.from(e.target.files ?? []).map((f) => f.name))}
      />
      <span id="fs-file-names">{names.join(", ")}</span>
    </div>
  );
}

function PasteBox() {
  // paste-count only increments on a real paste event, so it distinguishes a
  // clipboard paste from a plain fill (which fires input/change but never paste).
  const [pasteCount, setPasteCount] = useState(0);
  const [value, setValue] = useState("");
  return (
    <div>
      <input
        id="fs-paste"
        aria-label="paste target"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onPaste={(e) => {
          // Own the insertion so the pasted text lands exactly once (the browser's
          // default paste would otherwise also insert it into this controlled input).
          e.preventDefault();
          setPasteCount((c) => c + 1);
          setValue(e.clipboardData.getData("text/plain"));
        }}
      />
      <span id="paste-count">{pasteCount}</span>
      <span id="pasted-value">{value}</span>
    </div>
  );
}

function ResponsivePanel() {
  // A layout-driven collection: the widget list (10 items = a namedCollection)
  // renders wide and collapses under 800px, so a `resize` produces a deterministic
  // count delta (list:Responsive Widgets 10 -> 0) in the digest.
  const [wide, setWide] = useState(() => (typeof window === "undefined" ? true : window.innerWidth >= 800));
  useEffect(() => {
    const onResize = () => setWide(window.innerWidth >= 800);
    window.addEventListener("resize", onResize);
    onResize();
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return wide ? (
    <ul aria-label="Responsive Widgets" id="responsive-list">
      {Array.from({ length: 10 }, (_, i) => (
        <li key={i}>Widget {i + 1}</li>
      ))}
    </ul>
  ) : (
    <div id="responsive-collapsed">Narrow layout</div>
  );
}

function EscapeModal({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div role="dialog" id="escape-modal" aria-label="Escape Modal" style={{ border: "2px solid green", padding: 16 }}>
      <h2>Escape Modal</h2>
      <p>Press Escape or click Dismiss.</p>
      <button onClick={onClose}>Dismiss</button>
    </div>
  );
}

function StuckModal({ onClose }: { onClose: () => void }) {
  // The export-saga trap: the first Escape is swallowed, the second closes it —
  // so a verified close must retry, not assume the first press worked.
  const escapes = useRef(0);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      escapes.current += 1;
      if (escapes.current >= 2) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div role="dialog" id="stuck-modal" aria-label="Stuck Modal" style={{ border: "2px solid orange", padding: 16 }}>
      <h2>Stuck Modal</h2>
      <p>The first Escape is swallowed; the second dismisses.</p>
    </div>
  );
}

/** WP6 network trap: a widget backed by a REAL fetch to /api/parts (the rest of
 *  the fixture fakes async with a timer). This is what the network verbs act on —
 *  `mock` swaps its response to drive the UI against fixed data, `throttle` slows
 *  it, `wait --call` confirms the request fired, `watch network` streams it, and
 *  under `profile verify` a mocked 500 fails the action that triggered it. The
 *  Deferred button fires a fetch on a timer so `wait --call` can catch an
 *  upcoming request (not just one that already fired). */
function NetParts() {
  const [q, setQ] = useState("");
  const { data, isFetching, isError, refetch } = useQuery({
    queryKey: ["api-parts", q],
    queryFn: async () => {
      const r = await fetch(`/api/parts?q=${encodeURIComponent(q)}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return (await r.json()) as Array<{ id: number; name: string; status: string }>;
    },
    retry: false, // a mocked 500 should surface at once, not after 3 silent retries
  });
  const rows = data ?? [];
  const status = isError ? "error" : isFetching ? "fetching" : "idle";
  return (
    <div id="net-parts">
      {/* Labels deliberately avoid "parts"/"search" so they don't collide with the
          fixture's existing intent vocabulary; the e2e tests target these by #id. */}
      <input id="net-search" aria-label="API endpoint" value={q} onChange={(e) => setQ(e.target.value)} placeholder="API endpoint" />
      <button id="net-refetch" onClick={() => void refetch()}>Reload API</button>
      <button id="net-deferred" onClick={() => setTimeout(() => { void fetch("/api/parts?deferred=1"); }, 600)}>Delayed API</button>
      <span id="net-count">{rows.length}</span>
      <span id="net-status">{status}</span>
    </div>
  );
}

// WP9 traps (label-hostile toolbar): reproduce the two patterns the Versable
// dogfood exposed, so the un-rendered-element-prop signal reader has a
// controlled repro. (1) A dropdown whose menu is passed as a CHILDREN prop and
// rendered only while open (floating-ui style) — its item labels must be
// recoverable from the closed trigger's ancestor fiber, never mounted. (2) An
// always-mounted tooltip whose text is a `content` prop, not in the DOM.

type MenuItem = { label: ReactNode; tooltip: string };

// Label is a ReactNode (a component with a string `title` prop), NOT a string —
// exactly Versable's ExportOptionLabel shape.
function MenuItemLabel({ title }: { title: string }) {
  return <span className="menu-item-label">{title}</span>;
}

// The menu content. Rendered ONLY when the parent chooses to (open), but the
// element itself — with `items` on its props — is constructed unconditionally
// and handed to FakeDropdown as `children`.
function FakeMenu({ items }: { items: MenuItem[] }) {
  return (
    <ul role="menu">
      {items.map((it, i) => (
        <li role="menuitem" key={i}>{it.label}</li>
      ))}
    </ul>
  );
}

// floating-ui-style: children (the menu) render only while open. The trigger is
// an icon-only button with no accessible name.
function FakeDropdown({ triggerId, children }: { triggerId: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="fs-dropdown">
      <button id={triggerId} onClick={() => setOpen((o) => !o)}>
        <svg width="16" height="16" aria-hidden="true"><rect width="12" height="2" y="7" /></svg>
      </button>
      {open && children}
    </span>
  );
}

// Always-mounted tooltip: the label lives in a `content` prop and is hidden via
// CSS, never text in the DOM until (in a real app) hover. The tool must read the
// content prop off the wrapper fiber.
function FakeTooltip({ content, children }: { content: string; children: ReactNode }) {
  return (
    <span className="fs-tooltip-wrap">
      {children}
      <span role="tooltip" style={{ display: "none" }}>{content}</span>
    </span>
  );
}

// WP60 trap: a modal with NO role=dialog (a plain div toggled by class), like
// Versable's URL-state preview modal — invisible to ARIA-only surface tracking.
// The adapt config's surfaceSelectors=[".fs-fake-modal"] makes the digest see it.
function NonAriaModal() {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button id="open-fake-modal" onClick={() => setOpen(true)}>Open Fake Modal</button>
      {open && (
        <div className="fs-fake-modal" style={{ border: "2px solid teal", padding: 16 }}>
          <h3>Fake Modal (no role)</h3>
          <button id="close-fake-modal" onClick={() => setOpen(false)}>Dismiss</button>
        </div>
      )}
    </div>
  );
}

// A custom overlay whose name matches NONE of the built-in tokens (dropdown/
// menu/tooltip/...), so its closed content is unreadable until a project adds
// "flyout" to adapt.overlayComponents. Proves the adapt config extends WP9.
function Flyout({ triggerId, children }: { triggerId: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="fs-flyout">
      <button id={triggerId} onClick={() => setOpen((o) => !o)}>
        <svg width="16" height="16" aria-hidden="true"><polygon points="0,0 12,6 0,12" /></svg>
      </button>
      {open && children}
    </span>
  );
}

function LabelHostileToolbar() {
  const exportItems: MenuItem[] = [
    { label: <MenuItemLabel title="Export All Sheets" />, tooltip: "Download the whole file" },
    { label: <MenuItemLabel title="Export Current Sheet" />, tooltip: "Download this sheet" },
  ];
  return (
    <div id="wp9-toolbar">
      <FakeDropdown triggerId="export-trigger">
        <FakeMenu items={exportItems} />
      </FakeDropdown>
      <FakeTooltip content="Refresh data">
        <button id="refresh-icon" onClick={() => void 0}>
          <svg width="16" height="16" aria-hidden="true"><circle cx="8" cy="8" r="6" /></svg>
        </button>
      </FakeTooltip>
      <Flyout triggerId="flyout-trigger">
        <FakeMenu items={[{ label: <MenuItemLabel title="Archive Job" />, tooltip: "Move to archive" }]} />
      </Flyout>
    </div>
  );
}

function App() {
  const [tab, setTab] = useState("data");
  const [modalOpen, setModalOpen] = useState(false);
  const [escapeOpen, setEscapeOpen] = useState(false);
  const [stuckOpen, setStuckOpen] = useState(false);
  const [clicks, setClicks] = useState(0);
  const [theme] = useAtom(themeAtom, { store });
  // WP3a chord trap: Cmd/Ctrl+K opens a command palette (a T0 surface), Escape
  // closes it — the canonical keyboard-combo behavior `fs chord` drives.
  const [paletteOpen, setPaletteOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setPaletteOpen(true); }
      if (e.key === "Escape") setPaletteOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <main>
      <nav>
        {/* navbar search: the duplicate-input trap (page search lives below) */}
        <SearchBox id="nav-search" placeholder="Search" />
        {/* icon-only button: the unlabeled-control trap (resolves to #id) */}
        <button id="icon-only" onClick={() => setClicks((c) => c + 1)}>
          <svg width="16" height="16" aria-hidden="true"><circle cx="8" cy="8" r="6" /></svg>
        </button>
        {/* icon-only, no id: label must fall back to data-testid */}
        <button data-testid="refresh-action" onClick={() => setClicks((c) => c + 1)}>
          <svg width="16" height="16" aria-hidden="true"><path d="M0 0h12v12H0z" /></svg>
        </button>
        {/* icon-only, no id/testid: label must fall back to the svg <title> */}
        <button onClick={() => setClicks((c) => c + 1)}>
          <svg width="16" height="16"><title>Notifications</title><circle cx="8" cy="8" r="6" /></svg>
        </button>
        <span id="click-count">{clicks}</span>
        <span id="theme">{String(theme)}</span>
      </nav>
      <div role="tablist">
        {["data", "settings", "history"].map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>
            {t[0]!.toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>
      {tab === "data" && <PartsTable />}
      {tab === "settings" && <div id="settings-pane">Settings pane</div>}
      {tab === "history" && <div id="history-pane">History pane</div>}
      <button onClick={() => setModalOpen(true)}>Open Preview</button>
      {modalOpen && <Modal onClose={() => setModalOpen(false)} />}
      {/* WP3b traps: forms, responsive layout, and the two dismiss modals. A
          plain <div>, not a <section>: existing tests target the parts search via
          the `section input` selector, which must stay unambiguous. */}
      <div>
        <SelectBox />
        <UploadBox />
        <PasteBox />
        <ResponsivePanel />
      </div>
      <button onClick={() => setEscapeOpen(true)}>Open Escape Modal</button>
      <button onClick={() => setStuckOpen(true)}>Open Stuck Modal</button>
      {escapeOpen && <EscapeModal onClose={() => setEscapeOpen(false)} />}
      {stuckOpen && <StuckModal onClose={() => setStuckOpen(false)} />}
      {paletteOpen && (
        <div role="dialog" id="cmd-palette" aria-label="Command Palette" style={{ border: "2px solid navy", padding: 12 }}>
          <input placeholder="Run a command" aria-label="palette input" />
          <button onClick={() => setPaletteOpen(false)}>Close palette</button>
        </div>
      )}
      {/* WP3a pointer/keyboard/scroll traps (always mounted, so always discoverable) */}
      <HoverPopover />
      <NativeDialog />
      <ContextZone />
      <DndList />
      <PointerDndList />
      <WindowedList />
      <NetParts />
      <LabelHostileToolbar />
      <NonAriaModal />
    </main>
  );
}

// Focus-triggered refetches would make every first click look like page
// activity; the fixture must attribute mutations to deliberate actions only.
const client = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false } } });
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={client}>
      <JotaiProvider store={store}>
        <App />
      </JotaiProvider>
    </QueryClientProvider>
  </StrictMode>
);
