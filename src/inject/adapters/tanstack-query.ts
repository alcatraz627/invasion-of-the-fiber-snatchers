/**
 * TanStack Query adapter for Fiber Snatcher (runtime inject).
 *
 * Targets @tanstack/react-query v5+. Use via:
 *
 *   import { createTanstackQueryAdapter } from ".fiber-snatcher/runtime/adapters/tanstack-query";
 *   import { queryClient } from "@/lib/query-client";
 *
 *   window.__snatcher__?.register("queries", createTanstackQueryAdapter({ client: queryClient }));
 *
 * Action shapes understood by `dispatch`:
 *   { op: "invalidate", key: [...] }       → client.invalidateQueries({ queryKey })
 *   { op: "refetch",    key: [...] }       → client.refetchQueries({ queryKey })
 *   { op: "reset",      key: [...] }       → client.resetQueries({ queryKey })
 *   { op: "setData",    key: [...], data } → client.setQueryData(queryKey, data)
 *   { op: "get",        key: [...] }       → client.getQueryData(queryKey) + status
 *   { op: "list",       filter?: string }  → snapshot of queries matching filter
 *
 * `getState()` returns [{ key, status, fetchStatus, hasData, dataUpdatedAt, error }, …]
 * — compact by default so large data objects don't blow up the payload. Use
 * `dispatch({ op: "get", key })` for the full data of a specific query.
 */

type Query = {
  queryKey: readonly unknown[];
  state: {
    data: unknown;
    status: "pending" | "error" | "success";
    fetchStatus: "fetching" | "paused" | "idle";
    error: unknown;
    dataUpdatedAt: number;
    errorUpdatedAt: number;
  };
};

type QueryCache = { getAll: () => Query[] };

type QueryClient = {
  getQueryCache: () => QueryCache;
  getQueryData: (key: readonly unknown[]) => unknown;
  setQueryData: (key: readonly unknown[], data: unknown) => unknown;
  invalidateQueries: (filter: { queryKey: readonly unknown[] }) => Promise<void>;
  refetchQueries: (filter: { queryKey: readonly unknown[] }) => Promise<unknown>;
  resetQueries: (filter: { queryKey: readonly unknown[] }) => Promise<void>;
};

type Adapter = {
  getState: () => unknown;
  dispatch: (action: unknown) => unknown;
};

export function createTanstackQueryAdapter(opts: { client: QueryClient }): Adapter {
  const { client } = opts;

  function keyToString(key: readonly unknown[]): string {
    return JSON.stringify(key);
  }

  function snapshot(filter?: string) {
    const all = client.getQueryCache().getAll();
    const filtered = filter
      ? all.filter((q) => keyToString(q.queryKey).toLowerCase().includes(filter.toLowerCase()))
      : all;
    return filtered.map((q) => ({
      key: q.queryKey,
      status: q.state.status,
      fetchStatus: q.state.fetchStatus,
      hasData: q.state.data !== undefined,
      dataUpdatedAt: q.state.dataUpdatedAt ? new Date(q.state.dataUpdatedAt).toISOString() : null,
      error: q.state.error ? String((q.state.error as Error)?.message ?? q.state.error) : null,
    }));
  }

  return {
    getState() {
      return snapshot();
    },
    dispatch(action: unknown) {
      const a = action as { op?: string; key?: readonly unknown[]; data?: unknown; filter?: string };
      const op = a?.op ?? "list";
      if (op === "list") return snapshot(a.filter);
      if (!a.key && op !== "list") throw new Error(`tanstack-query dispatch: action.key (queryKey array) is required for op=${op}`);
      switch (op) {
        case "get": {
          const data = client.getQueryData(a.key!);
          const entry = client.getQueryCache().getAll().find((q) => keyToString(q.queryKey) === keyToString(a.key!));
          return {
            key: a.key,
            status: entry?.state.status ?? "(not in cache)",
            data,
            error: entry?.state.error ? String((entry.state.error as Error)?.message ?? entry.state.error) : null,
          };
        }
        case "invalidate": return client.invalidateQueries({ queryKey: a.key! }).then(() => ({ ok: true, op, key: a.key }));
        case "refetch":    return client.refetchQueries({ queryKey: a.key! }).then(() => ({ ok: true, op, key: a.key }));
        case "reset":      return client.resetQueries({ queryKey: a.key! }).then(() => ({ ok: true, op, key: a.key }));
        case "setData":    return { ok: true, op, key: a.key, previous: client.getQueryData(a.key!), next: client.setQueryData(a.key!, a.data) };
        default: throw new Error(`tanstack-query dispatch: unknown op: ${op}`);
      }
    },
  };
}
