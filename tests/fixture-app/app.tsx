/** The e2e playground: a single-page React app reproducing every targeting and
 *  timing trap the V1 usage mining surfaced, deterministically. Served by
 *  serve.ts; driven by the real CLI in tests/e2e/. Trap inventory:
 *  duplicate search inputs, icon-only buttons, ambiguous row labels, debounced
 *  search, delayed TanStack query, modal, tabs, 10k-row table, jotai atom. */

import { StrictMode, useEffect, useRef, useState, type UIEvent } from "react";
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

function App() {
  const [tab, setTab] = useState("data");
  const [modalOpen, setModalOpen] = useState(false);
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
      {paletteOpen && (
        <div role="dialog" id="cmd-palette" aria-label="Command Palette" style={{ border: "2px solid navy", padding: 12 }}>
          <input placeholder="Run a command" aria-label="palette input" />
          <button onClick={() => setPaletteOpen(false)}>Close palette</button>
        </div>
      )}
      {/* WP3a pointer/keyboard/scroll traps (always mounted, so always discoverable) */}
      <HoverPopover />
      <ContextZone />
      <DndList />
      <PointerDndList />
      <WindowedList />
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
