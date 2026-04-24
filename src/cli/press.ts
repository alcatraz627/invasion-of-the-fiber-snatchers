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
  const nthIdx = args.indexOf("--nth");
  const nth = nthIdx >= 0 ? Number(args[nthIdx + 1]) : undefined;
  const FLAG_VAL = new Set(["--selector", "--nth"]);
  const positional = args.filter((a, i) => !a.startsWith("--") && !FLAG_VAL.has(args[i - 1] ?? ""));
  const key = positional[0];
  if (!key) return err("E_NO_KEY", "press <key> [--selector <sel>] [--nth <N>]");

  const cfg = await requireConfig();
  const res = await sendRequest(controlSocketPath(cfg), { id: "press", op: "press", key, selector, nth }, 10000)
    .catch((e) => ({ id: "press", ok: false as const, error: String(e.message ?? e) }));
  if (!res.ok) return err((res as any).code ?? "E_PRESS_FAILED", res.error, {
    context: { key, selector, nth },
    next_steps: (res as any).code === "E_SELECTOR_AMBIGUOUS"
      ? ["Narrow the selector or pass --nth <N> (0-indexed)."]
      : undefined,
  });
  return ok(res.data);
}
