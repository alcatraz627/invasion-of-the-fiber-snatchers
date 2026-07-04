/** The verb table. Adding a verb = one ActionDef entry here (V1 needed edits
 *  in 4-5 files). The daemon dispatches by name or alias. */

import type { ActionDef } from "../pipeline/contracts.ts";
import { navActions } from "./nav.ts";
import { pointerActions } from "./pointer.ts";
import { keyboardActions } from "./keyboard.ts";
import { formsActions } from "./forms.ts";
import { waitActions } from "./wait.ts";
import { observeActions } from "./observe.ts";
import { evalActions } from "./evalx.ts";
import { stateActions } from "./statev.ts";
import { doctorActions } from "./doctor.ts";
import { routeActions } from "./routes.ts";
import { remountActions } from "./remount.ts";

const all: ActionDef<never>[] = [
  ...navActions,
  ...pointerActions,
  ...keyboardActions,
  ...formsActions,
  ...waitActions,
  ...observeActions,
  ...evalActions,
  ...stateActions,
  ...doctorActions,
  ...routeActions,
  ...remountActions,
] as ActionDef<never>[];

const byName = new Map<string, ActionDef<never>>();
for (const def of all) {
  byName.set(def.name, def);
  for (const a of def.aliases ?? []) byName.set(a, def);
}

export function lookupAction(name: string): ActionDef<never> | undefined {
  return byName.get(name);
}

export function listActions(): Array<{ name: string; summary: string; aliases?: string[] }> {
  return all.map((d) => ({ name: d.name, summary: d.summary, aliases: d.aliases }));
}
