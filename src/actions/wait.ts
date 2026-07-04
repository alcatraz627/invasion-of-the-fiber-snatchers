/** `wait` and `sleep`. `wait` is the honest way to synchronize with the app: a
 *  small vocabulary of bounded conditions (an element, some text, a URL, the
 *  network, or the framework's query state) that returns the moment the
 *  condition holds and fails with the page state when it doesn't. `sleep` exists
 *  only as an escape hatch and says so — a fixed delay races the app, so it is
 *  journaled as a smell to steer the next author toward `wait`. */

import { FsErrorShaped, type ActionDef, type TargetSpec } from "../pipeline/contracts.ts";
import {
  DEFAULT_WAIT_TIMEOUT_MS,
  waitForGone,
  waitForNetworkIdle,
  waitForTarget,
  waitForText,
  waitForUrl,
  waitSettled,
} from "../pipeline/waits.ts";

type WaitMode = "target" | "text" | "gone" | "url" | "network-idle" | "settled";

type WaitArgs = {
  mode: WaitMode;
  target?: TargetSpec; // for the default (visible) mode and --gone
  text?: string;
  url?: string;
  timeoutMs?: number;
  graceMs?: number;
};

type SleepArgs = { ms: number; smell?: boolean };

function describeSpec(spec: TargetSpec): string {
  switch (spec.kind) {
    case "ref": return spec.ref;
    case "css": return spec.selector;
    case "component": return spec.expr;
    case "intent": return spec.text;
  }
}

const badArgs = (message: string, hint: string) => new FsErrorShaped({ code: "E_BAD_ARGS", message, hint });

export const waitActions: (ActionDef<WaitArgs> | ActionDef<SleepArgs>)[] = [
  {
    name: "wait",
    summary: 'Wait for a condition: <target> visible | --text "…" | --gone <target> | --url <sub|/re/> | --network-idle | --settled',
    // `wait` resolves/polls its own target (the element may not exist yet — that
    // is the point), so the pipeline must not eagerly resolve args.target.
    target: "none",
    observation: true,
    settle: false,
    async run(ctx, args: WaitArgs) {
      const timeoutMs = args.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
      switch (args.mode) {
        case "settled":
          await waitSettled(ctx, { timeoutMs, graceMs: args.graceMs });
          return { waited: "settled" };
        case "network-idle":
          await waitForNetworkIdle(ctx, { timeoutMs });
          return { waited: "network-idle" };
        case "text":
          if (!args.text) throw badArgs("wait --text needs a string", 'fs wait --text "Saved"');
          await waitForText(ctx, args.text, { timeoutMs });
          return { waited: "text", text: args.text };
        case "url":
          if (!args.url) throw badArgs("wait --url needs a substring or /regex/", "fs wait --url /parts/");
          await waitForUrl(ctx, args.url, { timeoutMs });
          return { waited: "url", url: args.url };
        case "gone":
          if (!args.target) throw badArgs("wait --gone needs a target", 'fs wait --gone "#the-modal"');
          await waitForGone(ctx, args.target, { timeoutMs });
          return { waited: "gone", target: describeSpec(args.target) };
        case "target":
        default:
          if (!args.target) {
            throw badArgs(
              "wait needs a target or a condition flag (--text/--gone/--url/--network-idle/--settled)",
              'fs wait "Save"   or   fs wait --settled'
            );
          }
          await waitForTarget(ctx, args.target, { timeoutMs });
          return { waited: "visible", target: describeSpec(args.target) };
      }
    },
  } as ActionDef<WaitArgs>,
  {
    name: "sleep",
    summary: "Sleep N ms — escape hatch only; prefer `wait` (a fixed sleep races the app and is journaled as a smell)",
    target: "none",
    observation: true,
    settle: false,
    async run(_ctx, args: SleepArgs) {
      // Mark this entry so a later `macro from-journal` / audit can see the smell.
      // The journal records the args object by reference, so setting it here is
      // enough — the marker belongs to the verb, not the CLI that called it.
      args.smell = true;
      const ms = Math.max(0, Math.min(Number(args.ms) || 0, 60_000));
      await new Promise((r) => setTimeout(r, ms));
      return { slept: ms, note: "prefer `wait <condition>` — a fixed sleep races the app; this call was journaled as a smell" };
    },
  } as ActionDef<SleepArgs>,
];
