/** Resolves where the action library and the run journals live for the current
 *  project. One place holds the config read so the override (config.json's
 *  optional `actionsRoot`, used by tests and non-standard homes) lives in a
 *  single spot rather than being re-cast in every verb. */

import { join } from "node:path";
import { requireConfig } from "../core/config.ts";
import { openStore, type Store } from "./store.ts";

export type MacroContext = {
  store: Store;
  /** The daemon's action journal — what `from-journal` lifts and `fs journal` shows. */
  runsDir: string;
  /** Per-macro-run journals, kept apart so a replay never pollutes the source journal. */
  macroRunsDir: string;
};

export async function macroContext(): Promise<MacroContext> {
  const cfg = await requireConfig();
  const base = join(cfg.logsDir, "..");
  return {
    store: openStore(cfg.actionsRoot),
    runsDir: join(base, "runs"),
    macroRunsDir: join(base, "macro-runs"),
  };
}
