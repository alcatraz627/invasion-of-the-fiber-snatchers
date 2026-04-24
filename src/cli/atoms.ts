/**
 * `fiber-snatcher atoms` — Jotai-aware wrapper around dispatch/state.
 *
 * Usage:
 *   fiber-snatcher atoms                     # list all enumerable atoms + values
 *   fiber-snatcher atoms <name>              # get a single atom's value
 *   fiber-snatcher atoms <name> <value-json> # set an atom
 *   fiber-snatcher atoms --filter <substr>   # narrow list
 *
 * Targets the adapter registered under the name "jotai". Override with
 * --adapter <name>.
 */

import { ok, err, type Result } from "../core/result.ts";
import { requireConfig } from "../core/config.ts";
import { controlSocketPath } from "../core/browser.ts";
import { sendRequest } from "../core/ipc.ts";

export async function run(args: string[]): Promise<Result> {
  const adapterIdx = args.indexOf("--adapter");
  const adapter = adapterIdx >= 0 ? args[adapterIdx + 1] : "jotai";
  const filterIdx = args.indexOf("--filter");
  const filter = filterIdx >= 0 ? args[filterIdx + 1] : undefined;
  const positional = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--adapter" && args[i - 1] !== "--filter");

  const cfg = await requireConfig();
  const sock = controlSocketPath(cfg);

  let action: Record<string, unknown>;
  if (positional.length === 0 || positional[0] === "list") {
    action = { op: "list", filter };
  } else if (positional.length === 1) {
    action = { op: "get", atom: positional[0] };
  } else {
    let value: unknown;
    const raw = positional.slice(1).join(" ");
    try { value = JSON.parse(raw); } catch {
      return err("E_INVALID_VALUE", "atom value must be valid JSON", {
        context: { raw },
        next_steps: [`Quote strings: '"hello"'`, `Wrap in fiber-snatcher atoms myAtom '{"count": 3}'`],
      });
    }
    action = { op: "set", atom: positional[0], value };
  }

  const res = await sendRequest(sock, { id: "atoms", op: "dispatch", action, adapter }, 10000)
    .catch((e) => ({ id: "atoms", ok: false as const, error: String(e.message ?? e) }));
  if (!res.ok) {
    return err("E_ATOMS_FAILED", res.error, {
      next_steps: [
        `Ensure the jotai adapter is registered. See USAGE.md §2b Jotai example.`,
        `Run 'fiber-snatcher status' to see registered adapters.`,
      ],
    });
  }
  return ok(res.data);
}
