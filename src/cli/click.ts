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
  const selector = args.find((a) => !a.startsWith("--"));
  if (!selector) return err("E_NO_SELECTOR", "click <selector>");
  const cfg = await requireConfig();
  const res = await sendRequest(controlSocketPath(cfg), { id: "click", op: "click", selector }, 10000)
    .catch((e) => ({ id: "click", ok: false as const, error: String(e.message ?? e) }));
  if (!res.ok) return err("E_CLICK_FAILED", res.error, { context: { selector } });
  return ok(res.data);
}
