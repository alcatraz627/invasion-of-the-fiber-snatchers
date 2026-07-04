/** Report React root remounts (Fast Refresh / HMR replacement), which silently
 *  invalidate every ref an agent holds. The runtime arms the sentinel itself at
 *  injection and drain() folds new detections into the next digest; this verb
 *  is a plain reader for the current count, `--reset` zeroes it. */

import type { ActionDef } from "../pipeline/contracts.ts";

type RemountArgs = { reset?: boolean };

export const remountActions: ActionDef<never>[] = [
  {
    name: "remount",
    summary: "Read the React root-remount (Fast Refresh/HMR) counter; --reset zeroes it",
    target: "none",
    observation: true,
    settle: false,
    async run(ctx, args: RemountArgs) {
      return await ctx.page.evaluate((reset: boolean) => {
        const w = window as unknown as {
          __fsRemount?: { count: number; lastAt: number; container: Element };
        };
        const s = w.__fsRemount;
        if (!s) return { armed: false, remounts: 0, lastAt: null };
        const container = s.container.id ? `#${s.container.id}` : s.container.tagName.toLowerCase();
        const snap = { armed: true, container, remounts: s.count, lastAt: s.lastAt || null };
        if (reset) {
          s.count = 0;
          s.lastAt = 0;
        }
        return snap;
      }, !!args.reset);
    },
  } as ActionDef<RemountArgs>,
];
