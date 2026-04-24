/**
 * `fiber-snatcher fill <selector> <value>` — Playwright page.fill, which sets
 * the value and dispatches the events React expects (input + change with
 * proper bubbling). Fixes the common footgun of "I tried el.value = '…' via
 * eval and React didn't pick it up."
 */

import { ok, err, type Result } from "../core/result.ts";
import { requireConfig } from "../core/config.ts";
import { controlSocketPath } from "../core/browser.ts";
import { sendRequest } from "../core/ipc.ts";

export async function run(args: string[]): Promise<Result> {
  const positional = args.filter((a) => !a.startsWith("--"));
  const [selector, ...rest] = positional;
  if (!selector) return err("E_NO_SELECTOR", "fill <selector> <value>");
  const value = rest.join(" ");
  const cfg = await requireConfig();
  const res = await sendRequest(controlSocketPath(cfg), { id: "fill", op: "fill", selector, value }, 10000)
    .catch((e) => ({ id: "fill", ok: false as const, error: String(e.message ?? e) }));
  if (!res.ok) return err("E_FILL_FAILED", res.error, { context: { selector, value } });
  return ok(res.data);
}
