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
  const adapter = (adapterIdx >= 0 ? args[adapterIdx + 1] : "jotai") ?? "jotai";
  const filterIdx = args.indexOf("--filter");
  const filter = filterIdx >= 0 ? args[filterIdx + 1] : undefined;
  const FLAG_VAL = new Set(["--adapter", "--filter", "--timeout", "--interval"]);
  const positional = args.filter((a, i) => !a.startsWith("--") && !FLAG_VAL.has(args[i - 1] ?? ""));

  // `atoms watch <name>` is a long-running streaming mode. Branch off early.
  if (positional[0] === "watch") {
    return runWatch(args, positional.slice(1), adapter);
  }

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

/**
 * `atoms watch <name>` — poll the atom at an interval and emit JSONL to
 * stdout on change. V1 impl is polling (no IPC protocol change). Terminates
 * on Ctrl-C, --timeout, or page navigation. Default interval 200ms.
 */
async function runWatch(args: string[], positional: string[], adapter: string): Promise<Result> {
  const name = positional[0];
  if (!name) return err("E_NO_ATOM", "atoms watch <name> [--timeout <ms>] [--interval <ms>]");
  const timeoutIdx = args.indexOf("--timeout");
  const timeoutMs = timeoutIdx >= 0 ? Number(args[timeoutIdx + 1]) : 0;
  const intervalIdx = args.indexOf("--interval");
  const intervalMs = intervalIdx >= 0 ? Number(args[intervalIdx + 1]) : 200;

  const cfg = await requireConfig();
  const sock = controlSocketPath(cfg);
  const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : Infinity;

  let lastSerialized: string | undefined = undefined;
  let lastUrl: string | undefined = undefined;
  let iter = 0;

  while (Date.now() < deadline) {
    iter++;
    const res = await sendRequest(sock, { id: `watch-${iter}`, op: "atom-get", name, adapter }, 5000)
      .catch((e) => ({ id: `watch-${iter}`, ok: false as const, error: String(e.message ?? e) }));

    if (!res.ok) {
      process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), event: "error", error: res.error }) + "\n");
      return err("E_WATCH_FAILED", res.error, {
        next_steps: ["Daemon may have stopped or the jotai adapter is not registered."],
      });
    }
    const value = res.data;
    const serialized = JSON.stringify(value);
    if (serialized !== lastSerialized) {
      process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), name, value }) + "\n");
      lastSerialized = serialized;
    }

    // Auto-stop on navigation — check URL every 5 ticks to keep overhead low.
    if (iter % 5 === 0) {
      const info = await sendRequest(sock, { id: `watch-info-${iter}`, op: "info" }, 3000).catch(() => null);
      if (info && info.ok) {
        const url = (info.data as { url?: string }).url;
        if (lastUrl && url !== lastUrl) {
          process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), event: "closed", reason: "navigation", url }) + "\n");
          return ok({ reason: "navigation", from: lastUrl, to: url });
        }
        if (url) lastUrl = url;
      }
    }

    await new Promise((r) => setTimeout(r, intervalMs));
  }

  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), event: "closed", reason: "timeout" }) + "\n");
  return ok({ reason: "timeout", timeoutMs });
}
