/**
 * `fiber-snatcher press <key> [--selector <sel>]`
 *
 * With no --selector, presses a key on the focused element via
 * page.keyboard.press. With --selector, focuses that element first.
 *
 * Keys accept Playwright's notation: "Enter", "Escape", "Tab", "Shift+Tab",
 * "Meta+A", etc.
 */

import { ok, err, type Result } from "../core/result.ts";
import { requireConfig } from "../core/config.ts";
import { controlSocketPath } from "../core/browser.ts";
import { sendRequest } from "../core/ipc.ts";

export async function run(args: string[]): Promise<Result> {
  const selectorIdx = args.indexOf("--selector");
  const selector = selectorIdx >= 0 ? args[selectorIdx + 1] : undefined;
  const positional = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--selector");
  const key = positional[0];
  if (!key) return err("E_NO_KEY", "press <key> [--selector <sel>]");

  const cfg = await requireConfig();
  const res = await sendRequest(controlSocketPath(cfg), { id: "press", op: "press", key, selector }, 10000)
    .catch((e) => ({ id: "press", ok: false as const, error: String(e.message ?? e) }));
  if (!res.ok) return err("E_PRESS_FAILED", res.error, { context: { key, selector } });
  return ok(res.data);
}
