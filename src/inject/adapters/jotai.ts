/**
 * Jotai adapter for Fiber Snatcher (runtime inject).
 *
 * Targets Jotai v2+. Use via:
 *
 *   import { createJotaiAdapter } from ".fiber-snatcher/runtime/adapters/jotai";
 *   import { getDefaultStore } from "jotai";
 *   import * as atomsModule from "@/state/atoms";           // optional registry
 *
 *   window.__snatcher__?.register("jotai", createJotaiAdapter({
 *     store: getDefaultStore(),
 *     atoms: atomsModule,                                    // optional
 *   }));
 *
 * Action shapes understood by `dispatch`:
 *   { op: "set", atom: "cartAtom", value: [...] }
 *   { op: "get", atom: "cartAtom" }
 *   { op: "list" }                                           // default for state()
 *
 * `getState()` returns a snapshot of every atom it can enumerate:
 *   - from the dev store (`store.dev4_get_mounted_atoms()`), or
 *   - from the provided `atoms` registry (module of exported atom bindings).
 */

type Atom = { debugLabel?: string; toString?: () => string };

type JotaiStore = {
  get: (atom: Atom) => unknown;
  set: (atom: Atom, value: unknown) => unknown;
  sub?: (atom: Atom, cb: () => void) => () => void;
  // dev-only (unstable across versions — call with caution)
  dev4_get_mounted_atoms?: () => Iterable<Atom>;
  dev4_get_atom_state?: (atom: Atom) => { v?: unknown; e?: unknown } | undefined;
};

type Adapter = {
  getState: () => unknown;
  dispatch: (action: unknown) => unknown;
};

export function createJotaiAdapter(opts: {
  store: JotaiStore;
  /** Optional module of exported atoms, e.g. `import * as atoms from "@/state/atoms"`. */
  atoms?: Record<string, unknown>;
}): Adapter {
  const { store, atoms = {} } = opts;

  function atomLabel(atom: Atom, fallback?: string): string {
    return atom.debugLabel ?? fallback ?? atom.toString?.() ?? "atom?";
  }

  function enumerate(): Array<{ name: string; atom: Atom; value: unknown; error?: unknown }> {
    const out: Array<{ name: string; atom: Atom; value: unknown; error?: unknown }> = [];
    const seen = new WeakSet<Atom>();

    // Dev-mode path — enumerate mounted atoms
    try {
      const it = store.dev4_get_mounted_atoms?.();
      if (it) {
        for (const atom of it as Iterable<Atom>) {
          if (seen.has(atom)) continue;
          seen.add(atom);
          let value: unknown;
          let error: unknown;
          try { value = store.get(atom); } catch (e) { error = String(e); }
          out.push({ name: atomLabel(atom), atom, value, error });
        }
      }
    } catch {
      /* dev API not present — fall through to registry */
    }

    // Registry path — iterate exports
    for (const [name, maybe] of Object.entries(atoms)) {
      if (!maybe || typeof maybe !== "object") continue;
      const atom = maybe as Atom;
      if (seen.has(atom)) continue;
      // heuristic: has toString that starts with "atom"
      const looksLikeAtom = typeof atom.toString === "function" && /^atom/i.test(atom.toString());
      if (!looksLikeAtom) continue;
      seen.add(atom);
      let value: unknown;
      let error: unknown;
      try { value = store.get(atom); } catch (e) { error = String(e); }
      out.push({ name: atom.debugLabel ?? name, atom, value, error });
    }

    return out;
  }

  function findByName(name: string): Atom | undefined {
    const entries = enumerate();
    return entries.find((e) => e.name === name)?.atom;
  }

  return {
    getState() {
      return enumerate().map(({ name, value, error }) => (error !== undefined ? { name, value, error } : { name, value }));
    },
    dispatch(action: unknown) {
      const a = action as { op?: string; atom?: string; value?: unknown };
      const op = a?.op ?? "list";
      if (op === "list") return this.getState();
      if (!a.atom) throw new Error("jotai dispatch: action.atom (name) is required for op=" + op);
      const atom = findByName(a.atom);
      if (!atom) throw new Error(`jotai dispatch: atom not found: ${a.atom}. Known: ${enumerate().map((e) => e.name).join(", ") || "(none enumerated — pass `atoms` module to adapter)"}`);
      if (op === "get") return store.get(atom);
      if (op === "set") return store.set(atom, a.value);
      throw new Error(`jotai dispatch: unknown op: ${op}`);
    },
  };
}
