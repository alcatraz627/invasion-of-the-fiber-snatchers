import type { ActionDef } from "../pipeline/contracts.ts";

export const formsActions: ActionDef<{ value: string }>[] = [
  {
    name: "fill",
    summary: "Fill an input/textarea target with a value",
    target: "required",
    async run(ctx, args, target) {
      await ctx.page.locator(`[data-fs-ref="${target!.ref}"]`).fill(args.value, { timeout: 5000 });
      return { filled: target!.text || target!.ref, value: args.value };
    },
  },
];
