/**
 * `fiber-snatcher portal <portalId>`
 *
 * Inspect what's mounted at `document.getElementById(portalId)`. Default
 * includes a fiber-aware `sources` array listing component paths that
 * created portals into the element; pass `--dom-only` for the DOM snapshot
 * alone (faster, safer on weird React-internals state).
 *
 * The Preview File Modal stacking footprint: multiple `Portal(portalId="X")`
 * each append children to `#X` → `childCount > 1` is the canary.
 */

import { ok, err, type Result } from "../core/result.ts";
import { requireConfig } from "../core/config.ts";
import { controlSocketPath } from "../core/browser.ts";
import { sendRequest } from "../core/ipc.ts";

export async function run(args: string[]): Promise<Result> {
  const domOnly = args.includes("--dom-only");
  const count = args.includes("--count");
  const positional = args.filter((a) => !a.startsWith("--"));
  const portalId = positional[0];
  if (!portalId) return err("E_NO_PORTAL_ID", "portal <portalId> [--dom-only] [--count]");

  const cfg = await requireConfig();
  const opts = { domOnly, count };
  const res = await sendRequest(controlSocketPath(cfg), { id: "portal", op: "portal", portalId, opts }, 15000)
    .catch((e) => ({ id: "portal", ok: false as const, error: String(e.message ?? e) }));
  if (!res.ok) return err("E_PORTAL_FAILED", res.error);
  if (count && res.data && typeof (res.data as any).count === "number") {
    return ok((res.data as any).count);
  }
  return ok(res.data);
}
