import type { ActionDef } from "../pipeline/contracts.ts";

export const navActions: ActionDef<{ url: string }>[] = [
  {
    name: "navigate",
    aliases: ["goto", "nav"],
    summary: "Open a URL or path; waits for load + settle, digest included",
    target: "none",
    settle: { timeoutMs: 8000 },
    async run(ctx, args) {
      const url = args.url.startsWith("http") ? args.url : new URL(args.url, ctx.page.url()).toString();
      await ctx.page.goto(url, { waitUntil: "domcontentloaded" });
      return { url: ctx.page.url() };
    },
  },
  {
    name: "reload",
    summary: "Hard-reload the page (re-injects the runtime)",
    target: "none",
    settle: { timeoutMs: 8000 },
    async run(ctx) {
      await ctx.page.reload({ waitUntil: "domcontentloaded" });
      return { url: ctx.page.url() };
    },
  },
];
