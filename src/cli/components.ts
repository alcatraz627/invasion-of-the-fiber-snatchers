/**
 * `fiber-snatcher components <displayName>`
 *
 * Enumerate all mounted fibers with matching displayName. Returns paths +
 * props by default, count only with --count. Matches React DevTools' mental
 * model: "how many <X> are mounted right now?"
 *
 * Options:
 *   --count              Just return an integer count
 *   --shallow            Cap prop snapshot depth at 2
 *   --full               Include React internals in prop snapshot (default: stripped)
 *   --limit <N>          Stop after N matches (default 200)
 */

import { ok, err, type Result } from "../core/result.ts";
import { requireConfig } from "../core/config.ts";
import { controlSocketPath } from "../core/browser.ts";
import { sendRequest } from "../core/ipc.ts";

export async function run(args: string[]): Promise<Result> {
  const count = args.includes("--count");
  const shallow = args.includes("--shallow");
  const full = args.includes("--full");
  const limitIdx = args.indexOf("--limit");
  const limit = limitIdx >= 0 ? Number(args[limitIdx + 1]) : undefined;
  const FLAG_VAL = new Set(["--limit"]);
  const positional = args.filter((a, i) => !a.startsWith("--") && !FLAG_VAL.has(args[i - 1] ?? ""));
  const name = positional[0];
  if (!name) return err("E_NO_COMPONENT", "components <displayName> [--count] [--shallow|--full] [--limit <N>]");

  const cfg = await requireConfig();
  const opts = { count, shallow, full, limit };
  const res = await sendRequest(controlSocketPath(cfg), { id: "components", op: "components", name, opts }, 15000)
    .catch((e) => ({ id: "components", ok: false as const, error: String(e.message ?? e) }));
  if (!res.ok) return err("E_COMPONENTS_FAILED", res.error, {
    next_steps: ["Is the daemon up? `fiber-snatcher status`.", "Verify the displayName matches exactly — React DevTools' Components panel lists the canonical names."],
  });
  // --count asked for an integer; unwrap to data: N if possible
  if (count && res.data && typeof (res.data as any).count === "number") {
    return ok((res.data as any).count);
  }
  return ok(res.data);
}
