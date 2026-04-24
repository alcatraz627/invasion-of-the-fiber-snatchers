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
  const nthIdx = args.indexOf("--nth");
  const nth = nthIdx >= 0 ? Number(args[nthIdx + 1]) : undefined;
  const positional = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--nth");
  const [selector, ...rest] = positional;
  if (!selector) return err("E_NO_SELECTOR", "fill <selector> <value> [--nth <N>]");
  const value = rest.join(" ");
  const cfg = await requireConfig();
  const res = await sendRequest(controlSocketPath(cfg), { id: "fill", op: "fill", selector, value, nth }, 10000)
    .catch((e) => ({ id: "fill", ok: false as const, error: String(e.message ?? e) }));
  if (!res.ok) return err((res as any).code ?? "E_FILL_FAILED", res.error, {
    context: { selector, value, nth },
    next_steps: (res as any).code === "E_SELECTOR_AMBIGUOUS"
      ? ["Narrow the selector or pass --nth <N> (0-indexed)."]
      : undefined,
  });
  return ok(res.data);
}
