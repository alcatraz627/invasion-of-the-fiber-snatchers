/** The e2e playground: a single-page React app reproducing every targeting and
 *  timing trap the V1 usage mining surfaced, deterministically. Served by
 *  serve.ts; driven by the real CLI in tests/e2e/. Trap inventory:
 *  duplicate search inputs, icon-only buttons, ambiguous row labels, debounced
 *  search, delayed TanStack query, modal, tabs, 10k-row table, jotai atom. */

import { StrictMode, useEffect, useRef, useState } from "react";
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
          setPasteCount((c) => c + 1);
          const t = e.clipboardData.getData("text/plain");
          if (t) setValue(t);
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

function App() {
  const [tab, setTab] = useState("data");
  const [modalOpen, setModalOpen] = useState(false);
  const [escapeOpen, setEscapeOpen] = useState(false);
  const [stuckOpen, setStuckOpen] = useState(false);
  const [clicks, setClicks] = useState(0);
  const [theme] = useAtom(themeAtom, { store });
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
      {/* WP3b traps: forms, responsive layout, and the two dismiss modals. */}
      <section aria-label="forms">
        <SelectBox />
        <UploadBox />
        <PasteBox />
        <ResponsivePanel />
      </section>
      <button onClick={() => setEscapeOpen(true)}>Open Escape Modal</button>
      <button onClick={() => setStuckOpen(true)}>Open Stuck Modal</button>
      {escapeOpen && <EscapeModal onClose={() => setEscapeOpen(false)} />}
      {stuckOpen && <StuckModal onClose={() => setStuckOpen(false)} />}
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
