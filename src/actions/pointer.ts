/** Pointer verbs. Each does ONLY the pointer act; the pipeline handles
 *  resolution, settle, digest, and journaling, so a hover's opened popover and a
 *  drag's reorder show up in the digest (surfaces / counts) for free. */

import { FsErrorShaped, type ActionDef, type TargetSpec } from "../pipeline/contracts.ts";

type HoverArgs = { hold?: number };
type DragArgs = { dest?: TargetSpec; via?: string };

const refLocator = (ref: string) => `[data-fs-ref="${ref}"]`;
const HOLD_CAP_MS = 10_000;

export const pointerActions: (ActionDef<Record<string, never>> | ActionDef<HoverArgs> | ActionDef<DragArgs>)[] = [
  {
    name: "click",
    summary: "Click a target (ref, intent text, component expr, or CSS)",
    target: "required",
    async run(ctx, _args, target) {
      await ctx.page.locator(refLocator(target!.ref)).click({ timeout: 5000 });
      return { clicked: target!.text || target!.ref };
    },
  } as ActionDef<Record<string, never>>,
  {
    name: "hover",
    summary: "Hover a target; a popover it opens must stay open while the pointer rests (--hold <ms> to keep resting)",
    target: "required",
    async run(ctx, args: HoverArgs, target) {
      await ctx.page.locator(refLocator(target!.ref)).hover({ timeout: 5000 });
      // A held hover is a deliberate pointer rest, not a settle race: the mouse
      // stays where hover left it, so a well-built popover keeps itself open.
      const hold = Math.max(0, Math.min(Number(args.hold) || 0, HOLD_CAP_MS));
      if (hold) await new Promise((r) => setTimeout(r, hold));
      // Non-destructive surfaces read (snapshot doesn't reset the settle baseline):
      // proves the popover is STILL open after the rest, not just that it flashed.
      const snap = await ctx.runtime<{ surfaces?: string[] }>("snapshot", { budget: "concise" }).catch(() => ({} as { surfaces?: string[] }));
      const surfaces = snap.surfaces ?? [];
      return {
        hovered: target!.text || target!.ref,
        held: hold || undefined,
        popover: surfaces[0] ?? null,
        persisted: surfaces.length > 0,
        surfaces,
      };
    },
  } as ActionDef<HoverArgs>,
  {
    name: "dblclick",
    aliases: ["doubleclick"],
    summary: "Double-click a target",
    target: "required",
    async run(ctx, _args, target) {
      await ctx.page.locator(refLocator(target!.ref)).dblclick({ timeout: 5000 });
      return { doubleClicked: target!.text || target!.ref };
    },
  } as ActionDef<Record<string, never>>,
  {
    name: "rclick",
    aliases: ["rightclick"],
    summary: "Right-click a target (opens a context menu; the menu surface shows in the digest)",
    target: "required",
    async run(ctx, _args, target) {
      await ctx.page.locator(refLocator(target!.ref)).click({ button: "right", timeout: 5000 });
      return { rightClicked: target!.text || target!.ref };
    },
  } as ActionDef<Record<string, never>>,
  {
    name: "drag",
    summary: 'Drag a source target onto a dest target (HTML5 DnD by default; --via mouse for pointer-sensor handlers)',
    target: "required", // source is the primary target: auto-resolved and journaled
    async run(ctx, args: DragArgs, target) {
      if (!args.dest) {
        throw new FsErrorShaped({ code: "E_BAD_ARGS", message: "drag needs a destination target", hint: 'fs drag "<source>" "<dest>"' });
      }
      const dest = await ctx.resolve(args.dest);
      const src = ctx.page.locator(refLocator(target!.ref));
      const dst = ctx.page.locator(refLocator(dest.ref));
      const via = args.via === "mouse" ? "mouse" : "html5";
      if (via === "mouse") {
        // Pointer-sensor libraries (dnd-kit / react-dnd mouse backend) react to
        // real mousemove, which the HTML5 dragTo path doesn't drive. hover() first
        // so the source is scrolled into view AND the mouse is on it — a raw
        // mouse.move to a below-the-fold boundingBox would miss the element
        // entirely (dragTo auto-scrolls, manual mouse doesn't). A small move after
        // mousedown then trips the sensor's activation threshold.
        await src.hover({ timeout: 5000 });
        const sb = await src.boundingBox();
        const db = await dst.boundingBox();
        if (!sb || !db) {
          throw new FsErrorShaped({ code: "E_NOT_ACTIONABLE", message: "drag source or dest has no layout box", hint: "run `fs page` to see what is on screen" });
        }
        await ctx.page.mouse.down();
        await ctx.page.mouse.move(sb.x + sb.width / 2 + 6, sb.y + sb.height / 2 + 6);
        await ctx.page.mouse.move(db.x + db.width / 2, db.y + db.height / 2, { steps: 8 });
        await ctx.page.mouse.up();
      } else {
        await src.dragTo(dst, { timeout: 5000 });
      }
      return { dragged: target!.text || target!.ref, onto: dest.text || dest.ref, via };
    },
  } as ActionDef<DragArgs>,
];
