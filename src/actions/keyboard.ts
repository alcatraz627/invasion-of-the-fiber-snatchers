import type { ActionDef } from "../pipeline/contracts.ts";

export const keyboardActions: ActionDef<{ key: string }>[] = [
  {
    name: "press",
    summary: "Press a key (on a target if given, else the page)",
    target: "optional",
    async run(ctx, args, target) {
      if (target) await ctx.page.locator(`[data-fs-ref="${target.ref}"]`).press(args.key, { timeout: 5000 });
      else await ctx.page.keyboard.press(args.key);
      return { pressed: args.key };
    },
  },
];
