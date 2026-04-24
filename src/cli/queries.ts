/**
 * `fiber-snatcher queries` — TanStack Query-aware wrapper around dispatch/state.
 *
 * Usage:
 *   fiber-snatcher queries                         # list all queries (compact)
 *   fiber-snatcher queries --filter user           # substring match on keyStringified
 *   fiber-snatcher queries get '["user",1]'         # full data of one query
 *   fiber-snatcher queries invalidate '["user"]'    # invalidateQueries({queryKey})
 *   fiber-snatcher queries refetch '["user",1]'     # refetchQueries({queryKey})
 *   fiber-snatcher queries reset '["user"]'         # resetQueries({queryKey})
 *   fiber-snatcher queries setData '["user",1]' '{"name":"X"}'   # setQueryData
 *
 * Targets the adapter registered under "queries" by default. Override via
 * --adapter <name>.
 */

import { ok, err, type Result } from "../core/result.ts";
import { requireConfig } from "../core/config.ts";
import { controlSocketPath } from "../core/browser.ts";
import { sendRequest } from "../core/ipc.ts";

const OPS = new Set(["list", "get", "invalidate", "refetch", "reset", "setData"]);

export async function run(args: string[]): Promise<Result> {
  const adapterIdx = args.indexOf("--adapter");
  const adapter = adapterIdx >= 0 ? args[adapterIdx + 1] : "queries";
  const filterIdx = args.indexOf("--filter");
  const filter = filterIdx >= 0 ? args[filterIdx + 1] : undefined;

  const flagArgs = new Set(["--adapter", "--filter", "--json", "--cwd"]);
  const positional = args.filter((a, i) => !flagArgs.has(a) && !flagArgs.has(args[i - 1] ?? ""));

  const cfg = await requireConfig();
  const sock = controlSocketPath(cfg);

  let action: Record<string, unknown>;

  if (positional.length === 0) {
    action = { op: "list", filter };
  } else {
    const sub = positional[0]!;
    if (!OPS.has(sub)) {
      return err("E_BAD_SUBCOMMAND", `queries <${Array.from(OPS).join("|")}> <key-json> [value-json]`, {
        context: { got: sub },
      });
    }
    // "list" doesn't take a key — treat as a no-op sub that pipes to list.
    if (sub === "list") { action = { op: "list", filter }; }
    else {
    const keyRaw = positional[1];
    if (!keyRaw) return err("E_NO_KEY", `queries ${sub} requires a queryKey as a JSON array`);
    let key: unknown[];
    try {
      key = JSON.parse(keyRaw);
      if (!Array.isArray(key)) throw new Error("not an array");
    } catch (e) {
      return err("E_INVALID_KEY", "queryKey must be a JSON array", {
        context: { raw: keyRaw },
        next_steps: [`Quote properly: fiber-snatcher queries get '["user",1]'`],
      });
    }
    if (sub === "setData") {
      const dataRaw = positional[2];
      if (!dataRaw) return err("E_NO_DATA", "setData requires a data JSON value");
      let data: unknown;
      try { data = JSON.parse(dataRaw); } catch {
        return err("E_INVALID_DATA", "data must be valid JSON", { context: { raw: dataRaw } });
      }
      action = { op: "setData", key, data };
    } else {
      action = { op: sub, key };
    }
    }
  }

  const res = await sendRequest(sock, { id: "queries", op: "dispatch", action, adapter }, 15000)
    .catch((e) => ({ id: "queries", ok: false as const, error: String(e.message ?? e) }));
  if (!res.ok) {
    return err("E_QUERIES_FAILED", res.error, {
      next_steps: [
        `Ensure the TanStack Query adapter is registered under name "queries" (or pass --adapter <name>). See USAGE.md §2b.`,
        `Run 'fiber-snatcher status' to see registered adapters.`,
      ],
    });
  }
  return ok(res.data);
}
