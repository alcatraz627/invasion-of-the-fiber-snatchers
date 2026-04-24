/**
 * `fiber-snatcher click <selector>` — drives a single click through Playwright.
 * Unlike eval-based clicks, this goes through the real browser input pipeline
 * so React synthetic events fire correctly.
 */

import { ok, err, type Result } from "../core/result.ts";
import { requireConfig } from "../core/config.ts";
import { controlSocketPath } from "../core/browser.ts";
import { sendRequest } from "../core/ipc.ts";

export async function run(args: string[]): Promise<Result> {
  const nthIdx = args.indexOf("--nth");
  const nth = nthIdx >= 0 ? Number(args[nthIdx + 1]) : undefined;
  const selector = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--nth")[0];
  if (!selector) return err("E_NO_SELECTOR", "click <selector> [--nth <N>]");
  const cfg = await requireConfig();
  const res = await sendRequest(controlSocketPath(cfg), { id: "click", op: "click", selector, nth }, 10000)
    .catch((e) => ({ id: "click", ok: false as const, error: String(e.message ?? e) }));
  if (!res.ok) return err((res as any).code ?? "E_CLICK_FAILED", res.error, {
    context: { selector, nth },
    next_steps: (res as any).code === "E_SELECTOR_AMBIGUOUS"
      ? ["Narrow the selector or pass --nth <N> (0-indexed)."]
      : undefined,
  });
  return ok(res.data);
}
