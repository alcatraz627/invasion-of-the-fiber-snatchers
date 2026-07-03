/** The e2e playground: a single-page React app reproducing every targeting and
 *  timing trap the V1 usage mining surfaced, deterministically. Served by
 *  serve.ts; driven by the real CLI in tests/e2e/. Trap inventory:
 *  duplicate search inputs, icon-only buttons, ambiguous row labels, debounced
 *  search, delayed TanStack query, modal, tabs, 10k-row table, jotai atom. */

import { StrictMode, useEffect, useState } from "react";
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
  useEffect(() => {
    const t = setTimeout(() => setDebounced(raw), 250);
    return () => clearTimeout(t);
  }, [raw]);
  const { data, isFetching } = useDelayedParts(debounced);
  const rows = data ?? [];
  return (
    <section>
      <input placeholder="Search" value={raw} onChange={(e) => setRaw(e.target.value)} aria-label="parts search" />
      <div id="fetch-state">{isFetching ? "fetching" : "idle"}</div>
      <div id="row-count">{rows.length} rows</div>
      <table>
        <tbody>
          {rows.slice(0, 50).map((r) => (
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

function App() {
  const [tab, setTab] = useState("data");
  const [modalOpen, setModalOpen] = useState(false);
  const [clicks, setClicks] = useState(0);
  const [theme] = useAtom(themeAtom, { store });
  return (
    <main>
      <nav>
        {/* navbar search: the duplicate-input trap (page search lives below) */}
        <SearchBox id="nav-search" placeholder="Search" />
        {/* icon-only button: the unlabeled-control trap */}
        <button id="icon-only" onClick={() => setClicks((c) => c + 1)}>
          <svg width="16" height="16" aria-hidden="true"><circle cx="8" cy="8" r="6" /></svg>
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
