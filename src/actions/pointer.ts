import type { ActionDef } from "../pipeline/contracts.ts";

export const pointerActions: ActionDef<Record<string, never>>[] = [
  {
    name: "click",
    summary: "Click a target (ref, intent text, component expr, or CSS)",
    target: "required",
    async run(ctx, _args, target) {
      await ctx.page.locator(`[data-fs-ref="${target!.ref}"]`).click({ timeout: 5000 });
      return { clicked: target!.text || target!.ref };
    },
  },
];
