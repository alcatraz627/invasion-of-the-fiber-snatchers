/** Miscellaneous driver verbs that don't fit the pointer/keyboard/forms families:
 *  `resize` changes the viewport (responsive layout checks), and `close` is the
 *  verified dismiss — it presses Escape (or clicks a close control) and then
 *  proves the surface actually left, instead of assuming it did. The V1 usage
 *  mining found an export flow that broke because the agent hit Escape, believed
 *  the modal was gone, and acted on the page behind a modal that was still open. */

import { FsErrorShaped, type ActionDef, type PipelineCtx } from "../pipeline/contracts.ts";

/** How long to wait for a surface to leave after one dismiss attempt, and the
 *  poll cadence. Two attempts (initial + one retry) stay well under the 30s
 *  socket budget. */
const CLOSE_ATTEMPT_MS = 1200;
const CLOSE_POLL_MS = 120;

/** Visible dialog/menu/listbox surfaces keyed `role:label`, read from the page
 *  runtime's snapshot so the keys match what a digest reports in surfaces.closed.
 *  Non-destructive: snapshot doesn't drain the observation buffer, so polling it
 *  during a close leaves the pipeline's own digest intact. */
async function readSurfaces(ctx: PipelineCtx): Promise<string[]> {
  const snap = await ctx.runtime<{ surfaces?: string[] }>("snapshot", { budget: "concise" }).catch(() => undefined);
  return snap?.surfaces ?? [];
}

/** Poll until `key` is no longer among the visible surfaces, bounded. */
async function waitSurfaceGone(ctx: PipelineCtx, key: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  do {
    if (!(await readSurfaces(ctx)).includes(key)) return true;
    await new Promise((r) => setTimeout(r, CLOSE_POLL_MS));
  } while (Date.now() < deadline);
  return false;
}

export const miscActions: ActionDef[] = [
  {
    name: "resize",
    summary: "Resize the viewport (W H); the digest shows layout-driven surface/count changes",
    target: "none",
    async run(ctx, args) {
      const { width, height } = args as { width?: number; height?: number };
      const w = Number(width);
      const h = Number(height);
      if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
        throw new FsErrorShaped({ code: "E_BAD_ARGS", message: "resize needs a positive width and height (`fs resize <width> <height>`)" });
      }
      await ctx.page.setViewportSize({ width: Math.round(w), height: Math.round(h) });
      return { viewport: { width: Math.round(w), height: Math.round(h) } };
    },
  },
  {
    name: "close",
    aliases: ["dismiss"],
    summary: "Dismiss the top surface (Escape, or click a close control) and verify it left",
    target: "optional",
    async run(ctx, args, target) {
      const before = await readSurfaces(ctx);

      // Nothing tracked to assert against. If a close control was named, click it
      // and say we couldn't verify (no ARIA surface was open); otherwise there is
      // simply nothing to close.
      if (before.length === 0) {
        if (target) {
          await ctx.page.locator(`[data-fs-ref="${target.ref}"]`).click({ timeout: 5000 });
          return { closed: null, clicked: target.text || target.ref, note: "no ARIA surface was open to verify; clicked the control" };
        }
        return { closed: null, note: "no open surface to close" };
      }

      // The topmost (most recently opened) surface is the one a bare `close`
      // targets; that's the key we prove has left.
      const topKey = before[before.length - 1]!;

      const act = async (useEscape: boolean) => {
        if (target && !useEscape) await ctx.page.locator(`[data-fs-ref="${target.ref}"]`).click({ timeout: 5000 });
        else await ctx.page.keyboard.press("Escape");
      };

      await act(false);
      let gone = await waitSurfaceGone(ctx, topKey, CLOSE_ATTEMPT_MS);
      if (!gone) {
        // The export-saga case: a modal that swallows the first Escape. Retry once
        // with Escape (the universal dismiss) before declaring it stuck.
        await act(true);
        gone = await waitSurfaceGone(ctx, topKey, CLOSE_ATTEMPT_MS);
      }
      if (!gone) {
        throw new FsErrorShaped({
          code: "E_INTERNAL",
          message: `close did not dismiss "${topKey}" — it is still on screen after Escape and one retry`,
          hint: "the surface may trap Escape; click its dismiss control directly (`fs close \"<close button>\"`) or `fs page` to inspect it",
        });
      }
      return { closed: topKey, surfacesBefore: before.length, surfacesAfter: (await readSurfaces(ctx)).length };
    },
  },
];
