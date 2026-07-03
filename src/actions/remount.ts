/** Detect a full React root remount (Fast Refresh / HMR replacement), which
 *  silently invalidates every ref an agent holds and resets component state.
 *  `fs remount` arms a sentinel on the React container and reports the remount
 *  count since arming. HMR events themselves aren't observable from the injected
 *  runtime, but their effect is: a full remount swaps the container's child node,
 *  so the sentinel watches that node's identity (quiet on ordinary re-renders).
 *  Each detection also emits a `console.error` marker so an in-window remount
 *  reaches digest.errors via the runtime's existing console capture. Design
 *  rationale + the drain()-level WP1 handoff are in reports/WP7.md. */

import type { ActionDef } from "../pipeline/contracts.ts";

type RemountArgs = { reset?: boolean };

export const remountActions: ActionDef<never>[] = [
  {
    name: "remount",
    summary: "Arm/read the React root-remount (Fast Refresh/HMR) sentinel; --reset zeroes it",
    target: "none",
    observation: true,
    settle: false,
    async run(ctx, args: RemountArgs) {
      return await ctx.page.evaluate((reset: boolean) => {
        const w = window as unknown as { __fsRemount?: RemountState };
        type RemountState = { count: number; lastAt: number; firstChild: Element | null; container: Element };

        function findRoot(): Element {
          // React 18 createRoot stamps the container with __reactContainer$<id>.
          const nodes: Element[] = [document.documentElement, ...Array.from(document.querySelectorAll("*"))];
          for (const el of nodes) {
            for (const k in el) {
              if (k.startsWith("__reactContainer$")) return el;
            }
          }
          return document.getElementById("root") ?? document.getElementById("__next") ?? document.body;
        }

        if (!w.__fsRemount) {
          const root = findRoot();
          const state: RemountState = { count: 0, lastAt: 0, firstChild: root.firstElementChild, container: root };
          const obs = new MutationObserver(() => {
            const fc = root.firstElementChild;
            if (state.firstChild && fc && fc !== state.firstChild) {
              state.count++;
              state.lastAt = Date.now();
              state.firstChild = fc;
              console.error(`[fs] hot-reload remount detected (#${state.count})`);
            } else if (fc) {
              state.firstChild = fc;
            }
          });
          obs.observe(root, { childList: true });
          w.__fsRemount = state;
        }

        const s = w.__fsRemount;
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
