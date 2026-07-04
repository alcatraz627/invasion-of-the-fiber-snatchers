/** Thin state verbs: first-class wrappers over the runtime's adapter dispatch
 *  and DOM count. V1 shipped `queries`/`atoms`/`dispatch`/`count` as core value;
 *  V2 exposed the same power only through `fs eval window.__fs…`, which is the
 *  hand-rolled-eval pattern the tool exists to kill. These give the agent a
 *  named, self-describing verb for each, delegating to window.__fs. */

import type { ActionDef, PipelineCtx } from "../pipeline/contracts.ts";
import { FsErrorShaped } from "../pipeline/contracts.ts";

type QueriesArgs = { filter?: string };
type AtomsArgs = { name?: string };
type DispatchArgs = { action: string; adapter?: string };
type CountArgs = { selector?: string };

/** Route adapter calls through here so a missing/undiscovered adapter reports
 *  as E_ADAPTER (a code agents branch on) instead of leaking as E_INTERNAL. */
async function adapterDispatch(ctx: PipelineCtx, action: unknown, adapter?: string): Promise<unknown> {
  try {
    return await ctx.runtime("dispatch", action, adapter ? { adapter } : undefined);
  } catch (e) {
    if (e instanceof FsErrorShaped) throw e; // E_RUNTIME_MISSING passes through
    const msg = String((e as Error).message ?? e).split("\n")[0] ?? "adapter error";
    if (/adapter|discovery found neither|not found/i.test(msg)) {
      throw new FsErrorShaped({
        code: "E_ADAPTER",
        message: msg,
        hint: "`fs doctor` lists discovered adapters; this app may not use TanStack Query / jotai",
      });
    }
    throw new FsErrorShaped({ code: "E_INTERNAL", message: msg });
  }
}

export const stateActions: ActionDef<never>[] = [
  {
    name: "queries",
    summary: "List TanStack Query cache entries (optional substring key filter)",
    target: "none",
    observation: true,
    settle: false,
    async run(ctx, args: QueriesArgs) {
      return await adapterDispatch(ctx, { op: "list", filter: args.filter }, "queries");
    },
  } as ActionDef<QueriesArgs>,
  {
    name: "atoms",
    summary: "List jotai atoms, or read one by name (needs a dev-mode store)",
    target: "none",
    observation: true,
    settle: false,
    async run(ctx, args: AtomsArgs) {
      const action = args.name ? { op: "get", atom: args.name } : { op: "list" };
      return await adapterDispatch(ctx, action, "jotai");
    },
  } as ActionDef<AtomsArgs>,
  {
    name: "dispatch",
    summary: "Send a JSON action to a state adapter (--adapter queries|jotai; - = stdin)",
    target: "none",
    // Mutating verb (invalidate/setData/atom-set change the app): full
    // settle + digest so the effect is reported; reads just pay ~150ms.
    async run(ctx, args: DispatchArgs) {
      let action: unknown;
      try {
        action = JSON.parse(args.action);
      } catch {
        throw new FsErrorShaped({
          code: "E_BAD_ARGS",
          message: `dispatch needs a JSON action; got: ${String(args.action).slice(0, 60)}`,
          hint: `e.g. fs dispatch '{"op":"invalidate","key":["parts"]}' --adapter queries`,
        });
      }
      return await adapterDispatch(ctx, action, args.adapter);
    },
  } as ActionDef<DispatchArgs>,
  {
    name: "count",
    summary: "Count DOM elements matching a CSS selector (cheap collection size)",
    target: "none",
    observation: true,
    settle: false,
    async run(ctx, args: CountArgs) {
      if (!args.selector) {
        throw new FsErrorShaped({ code: "E_BAD_ARGS", message: "count needs a CSS selector", hint: `fs count 'table tbody tr'` });
      }
      return await ctx.runtime<number>("count", args.selector);
    },
  } as ActionDef<CountArgs>,
];
