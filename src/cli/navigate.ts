/**
 * `fiber-snatcher navigate <url-or-path>`
 *
 * Full page.goto. Path-relative URLs (e.g. "/dashboard") are resolved against
 * the daemon's configured devUrl; absolute URLs pass through.
 *
 * Use this instead of `eval "location.href = …"` — navigation is a first-class
 * op, doesn't spend a turn on eval ack, and properly awaits DOMContentLoaded.
 */

import { ok, err, type Result } from "../core/result.ts";
import { requireConfig } from "../core/config.ts";
import { controlSocketPath } from "../core/browser.ts";
import { sendRequest } from "../core/ipc.ts";

export async function run(args: string[]): Promise<Result> {
  const target = args.find((a) => !a.startsWith("--"));
  if (!target) return err("E_NO_URL", "navigate <url-or-path>");
  const cfg = await requireConfig();
  const url = target.startsWith("http") ? target : new URL(target, cfg.devUrl).toString();
  const res = await sendRequest(controlSocketPath(cfg), { id: "navigate", op: "navigate", url }, 30000)
    .catch((e) => ({ id: "navigate", ok: false as const, error: String(e.message ?? e) }));
  if (!res.ok) return err("E_NAVIGATE_FAILED", res.error, { context: { target, url } });
  return ok(res.data);
}
