import { join } from "node:path";
import type { ActionDef } from "../pipeline/contracts.ts";

type ShootArgs = { path?: string; selector?: string; shotsDir: string };
type PageArgs = { budget?: "concise" | "detailed"; scope?: string };
type StateArgs = { selector?: string; full?: boolean; shallow?: boolean };

export const observeActions: (ActionDef<ShootArgs> | ActionDef<PageArgs> | ActionDef<StateArgs>)[] = [
  {
    name: "page",
    aliases: ["snapshot"],
    summary: "Semantic page snapshot: route, interactables with refs (T1)",
    target: "none",
    observation: true,
    settle: false,
    async run(ctx, args: PageArgs) {
      return await ctx.runtime("snapshot", { budget: args.budget ?? "concise", scope: args.scope });
    },
  } as ActionDef<PageArgs>,
  {
    name: "shoot",
    aliases: ["screenshot"],
    summary: "Screenshot the page (or a CSS-selected element) to shots dir",
    target: "none",
    observation: true,
    settle: false,
    async run(ctx, args: ShootArgs) {
      const path = args.path ?? join(args.shotsDir, `shot-${Date.now()}.png`);
      if (args.selector) await ctx.page.locator(args.selector).first().screenshot({ path });
      else await ctx.page.screenshot({ path, fullPage: true });
      return { path };
    },
  } as ActionDef<ShootArgs>,
  {
    name: "state",
    summary: "Fiber state/props/hooks of the nearest stateful ancestors (T2)",
    target: "none",
    observation: true,
    settle: false,
    async run(ctx, args: StateArgs) {
      return await ctx.runtime("state", args.selector, { full: args.full, shallow: args.shallow });
    },
  } as ActionDef<StateArgs>,
];
