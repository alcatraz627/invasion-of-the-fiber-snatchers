/** Keyboard verbs. `press` fires one key; `chord` fires a modifier combination
 *  (Playwright's "Meta+K" syntax); `type` enters text one key at a time through
 *  the real input pipeline, so debounced onChange handlers fire per keystroke —
 *  the realistic contrast to `fill`, which sets the value in a single shot. */

import { FsErrorShaped, type ActionDef } from "../pipeline/contracts.ts";

type PressArgs = { key: string };
type ChordArgs = { keys: string };
type TypeArgs = { text: string; delay?: number };

const refLocator = (ref: string) => `[data-fs-ref="${ref}"]`;
const TYPE_DELAY_CAP_MS = 1000;

export const keyboardActions: (ActionDef<PressArgs> | ActionDef<ChordArgs> | ActionDef<TypeArgs>)[] = [
  {
    name: "press",
    summary: "Press a key (on a target if given, else the page)",
    target: "optional",
    async run(ctx, args: PressArgs, target) {
      if (target) await ctx.page.locator(refLocator(target.ref)).press(args.key, { timeout: 5000 });
      else await ctx.page.keyboard.press(args.key);
      return { pressed: args.key };
    },
  } as ActionDef<PressArgs>,
  {
    name: "chord",
    summary: 'Press a key combination, e.g. "Meta+K" or "Control+Shift+P" (Playwright key syntax; on a target if given, else the page)',
    target: "optional",
    async run(ctx, args: ChordArgs, target) {
      if (!args.keys?.trim()) throw new FsErrorShaped({ code: "E_BAD_ARGS", message: "chord needs a key combination", hint: 'fs chord "Meta+K"' });
      // Playwright's press understands the modifier syntax directly, so a chord is
      // one press call — the verb exists to name the intent (a shortcut combo).
      if (target) await ctx.page.locator(refLocator(target.ref)).press(args.keys, { timeout: 5000 });
      else await ctx.page.keyboard.press(args.keys);
      return { chord: args.keys, scope: target ? (target.text || target.ref) : "page" };
    },
  } as ActionDef<ChordArgs>,
  {
    name: "type",
    summary: "Type text into a target one key at a time (--delay <ms> per key); fires per-keystroke handlers, unlike fill's single set",
    target: "required",
    async run(ctx, args: TypeArgs, target) {
      if (typeof args.text !== "string") throw new FsErrorShaped({ code: "E_BAD_ARGS", message: "type needs text", hint: 'fs type "<target>" "hello"' });
      const delay = Math.max(0, Math.min(Number(args.delay) || 0, TYPE_DELAY_CAP_MS));
      // pressSequentially is the per-key path (`.type()` is deprecated); each key
      // dispatches a real keydown/input, so an app's debounce sees every keystroke.
      await ctx.page.locator(refLocator(target!.ref)).pressSequentially(args.text, { delay, timeout: 5000 });
      return { typed: args.text, into: target!.text || target!.ref, delay: delay || undefined };
    },
  } as ActionDef<TypeArgs>,
];
