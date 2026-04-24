/**
 * `fiber-snatcher count <selector>` — shortcut for querySelectorAll(sel).length.
 *
 * Without --json, prints only the integer to stdout. With --json, returns a
 * normal Result with data=N. E_BAD_SELECTOR on invalid CSS.
 */

import { ok, err, type Result } from "../core/result.ts";
import { requireConfig } from "../core/config.ts";
import { controlSocketPath } from "../core/browser.ts";
import { sendRequest } from "../core/ipc.ts";

export async function run(args: string[]): Promise<Result> {
  const selector = args.find((a) => !a.startsWith("--"));
  if (!selector) return err("E_NO_SELECTOR", "count <selector>");
  const cfg = await requireConfig();
  const res = await sendRequest(controlSocketPath(cfg), { id: "count", op: "count", selector }, 10000)
    .catch((e) => ({ id: "count", ok: false as const, error: String(e.message ?? e) }));
  if (!res.ok) return err((res as any).code ?? "E_COUNT_FAILED", res.error, { context: { selector } });
  return ok(res.data);
}
