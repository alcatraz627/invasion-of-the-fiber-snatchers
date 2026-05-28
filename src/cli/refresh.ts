/**
 * `fiber-snatcher refresh` — navigate the daemon's tab back to devUrl.
 *
 * The daemon's Chromium tab can land on `chrome-error://chromewebdata/` when
 * the dev server is restarted out from under it (an in-flight request fails
 * and Chromium parks on the error screen). State / eval reads against an
 * error page return meaningless errors, and `doctor`'s probes below page-url
 * all falsely report failure. `refresh` is the one-line recovery: navigate
 * the daemon's tab to the configured devUrl root.
 *
 * For an explicit URL, use `navigate <path>` instead.
 */
import { ok, err, type Result } from "../core/result.ts";
import { requireConfig } from "../core/config.ts";
import { controlSocketPath } from "../core/browser.ts";
import { sendRequest } from "../core/ipc.ts";

export async function run(): Promise<Result> {
  const cfg = await requireConfig();
  const res = await sendRequest(
    controlSocketPath(cfg),
    { id: "refresh", op: "navigate", url: cfg.devUrl },
    30000,
  ).catch((e) => ({ id: "refresh", ok: false as const, error: String(e.message ?? e) }));
  if (!res.ok) return err("E_REFRESH_FAILED", res.error, { context: { url: cfg.devUrl } });
  return ok(res.data);
}
