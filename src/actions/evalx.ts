import type { ActionDef } from "../pipeline/contracts.ts";
import { FsErrorShaped } from "../pipeline/contracts.ts";

export const evalActions: ActionDef<{ code: string }>[] = [
  {
    name: "eval",
    summary: "Evaluate a JS expression in the page; result is the expression value",
    target: "none",
    observation: true,
    settle: false,
    async run(ctx, args) {
      try {
        return await ctx.page.evaluate((code) => {
          // eslint-disable-next-line no-new-func
          return new Function(`return (${code})`)();
        }, args.code);
      } catch (e) {
        throw new FsErrorShaped({
          code: "E_EVAL",
          message: String((e as Error).message ?? e),
          hint: "expression form only; wrap statements in an IIFE",
        });
      }
    },
  },
];
