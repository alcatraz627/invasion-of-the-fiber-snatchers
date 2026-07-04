/** `scroll` moves the window or a scroll container. The agent-relevant part is
 *  what scrolling *reveals*: a windowed / infinite list materializes rows as it
 *  scrolls, and because those rows are a named collection, the pipeline's settle
 *  diff reports the row-count growth in the digest's `counts` — so "I scrolled and
 *  N more rows loaded" is legible without a second `fs page`. */

import { FsErrorShaped, type ActionDef } from "../pipeline/contracts.ts";

type ScrollArgs = { to?: string | number; by?: number; intoView?: boolean };

export const scrollActions: ActionDef<ScrollArgs>[] = [
  {
    name: "scroll",
    summary: "Scroll the window or a target: --to top|bottom|<y> · <target> --by <px> · --into-view <target>",
    target: "optional",
    async run(ctx, args: ScrollArgs, target) {
      if (args.to === undefined && args.by === undefined && !args.intoView) {
        throw new FsErrorShaped({
          code: "E_BAD_ARGS",
          message: "scroll needs a direction: --to top|bottom|<y>, --by <px>, or --into-view <target>",
          hint: 'fs scroll --to bottom   or   fs scroll "#list" --by 300',
        });
      }
      const ref = target?.ref ?? null;
      const result = await ctx.page.evaluate(
        ({ ref, to, by, intoView }) => {
          const el = ref ? (document.querySelector(`[data-fs-ref="${ref}"]`) as HTMLElement | null) : null;
          if (ref && !el) return { error: "scroll target is not in the current document" };
          if (intoView) {
            if (!el) return { error: "scroll --into-view needs a target" };
            el.scrollIntoView({ block: "center", inline: "nearest" });
            return { intoView: true, top: Math.round(el.getBoundingClientRect().top) };
          }
          if (typeof by === "number") {
            if (el) { el.scrollTop += by; return { scrolledBy: by, scrollTop: Math.round(el.scrollTop) }; }
            window.scrollBy(0, by);
            return { scrolledBy: by, scrollTop: Math.round(window.scrollY) };
          }
          // --to top | bottom | <y>
          const container = el ?? (document.scrollingElement as HTMLElement | null) ?? document.documentElement;
          const y = to === "top" ? 0 : to === "bottom" ? container.scrollHeight : Number(to) || 0;
          if (el) { el.scrollTop = y; return { scrolledTo: to, scrollTop: Math.round(el.scrollTop) }; }
          window.scrollTo(0, y);
          return { scrolledTo: to, scrollTop: Math.round(window.scrollY) };
        },
        { ref, to: args.to ?? null, by: args.by ?? null, intoView: !!args.intoView }
      );
      if (result && typeof result === "object" && "error" in result) {
        throw new FsErrorShaped({ code: "E_BAD_ARGS", message: String(result.error), hint: "run `fs page` to see the scroll containers" });
      }
      return result;
    },
  } as ActionDef<ScrollArgs>,
];
