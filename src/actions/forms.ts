import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import { FsErrorShaped, type ActionDef } from "../pipeline/contracts.ts";

/** Form-input verbs. Each `run` does only the act; resolution, settle, digest,
 *  and journaling are the pipeline's job. `fill` sets a value directly; `select`
 *  drives a native <select>; `upload` sets files on a file input; `paste` fires a
 *  real clipboard paste (an onPaste event the app can intercept — the thing
 *  `fill` deliberately doesn't do). */
export const formsActions: ActionDef[] = [
  {
    name: "fill",
    summary: "Fill an input/textarea target with a value",
    target: "required",
    async run(ctx, args, target) {
      const value = String((args as { value?: unknown }).value ?? "");
      await ctx.page.locator(`[data-fs-ref="${target!.ref}"]`).fill(value, { timeout: 5000 });
      return { filled: target!.text || target!.ref, value };
    },
  },
  {
    name: "select",
    summary: "Choose an option in a native <select> (by label or value; --by index)",
    target: "required",
    async run(ctx, args, target) {
      const { option, by } = args as { option?: string; by?: string };
      const raw = String(option ?? "");
      const loc = ctx.page.locator(`[data-fs-ref="${target!.ref}"]`);

      // Validate against the select's real options so a miss is a fast, shaped
      // error listing what IS available — not a 5s Playwright actionability wait.
      const opts = await loc.evaluate((el) =>
        el instanceof HTMLSelectElement
          ? Array.from(el.options).map((o, i) => ({ i, value: o.value, label: (o.textContent ?? "").replace(/\s+/g, " ").trim() }))
          : null
      );
      if (opts === null) {
        throw new FsErrorShaped({
          code: "E_BAD_ARGS",
          message: `select target is not a native <select>`,
          hint: "custom dropdowns are `click` (open) + `click` (option); select is for real <select> elements",
        });
      }

      // index form: `--by index` with a numeric option, or the `[N]` shorthand.
      const asIndex = by === "index" ? raw : /^\[(\d+)\]$/.test(raw) ? raw.slice(1, -1) : undefined;
      if (asIndex !== undefined) {
        const idx = Number(asIndex);
        if (!Number.isInteger(idx) || idx < 0 || idx >= opts.length) {
          throw new FsErrorShaped({
            code: "E_BAD_ARGS",
            message: `option index ${asIndex} out of range (select has ${opts.length}, valid 0..${opts.length - 1})`,
          });
        }
        await loc.selectOption({ index: idx });
        return { selected: opts[idx]!.label, value: opts[idx]!.value, on: target!.text || target!.ref };
      }

      // value/label: prefer an explicit --by; otherwise match value, then exact
      // label, then a label substring (so "Beta" hits "Beta (β)").
      const needle = raw.toLowerCase();
      const hit =
        by === "value"
          ? opts.find((o) => o.value === raw)
          : by === "label"
            ? opts.find((o) => o.label.toLowerCase() === needle) ?? opts.find((o) => o.label.toLowerCase().includes(needle))
            : opts.find((o) => o.value === raw) ??
              opts.find((o) => o.label.toLowerCase() === needle) ??
              opts.find((o) => o.label.toLowerCase().includes(needle));
      if (!hit) {
        throw new FsErrorShaped({
          code: "E_BAD_ARGS",
          message: `no option matches "${raw}"`,
          hint: `available options: ${opts.map((o) => o.label || o.value).join(", ")}`,
        });
      }
      await loc.selectOption(by === "value" ? { value: hit.value } : { label: hit.label });
      return { selected: hit.label, value: hit.value, on: target!.text || target!.ref };
    },
  },
  {
    name: "upload",
    summary: "Set files on a file input (drop-zones without one need WP3a `drop`)",
    target: "required",
    async run(ctx, args, target) {
      const files = ((args as { files?: unknown }).files as string[] | undefined) ?? [];
      if (!files.length) {
        throw new FsErrorShaped({ code: "E_BAD_ARGS", message: "upload needs at least one file path" });
      }
      const paths = files.map((f) => resolve(f));
      for (const p of paths) {
        if (!existsSync(p)) throw new FsErrorShaped({ code: "E_BAD_ARGS", message: `file not found: ${p}` });
      }

      const loc = ctx.page.locator(`[data-fs-ref="${target!.ref}"]`);
      // A file input can be the target itself or a hidden input inside a styled
      // drop-zone (the common React pattern). A drop-zone with no input at all
      // needs a real DataTransfer drop, which is WP3a's drag machinery.
      const kind = await loc.evaluate((el) => {
        if (el instanceof HTMLInputElement && el.type === "file") return "self";
        return el.querySelector("input[type=file]") ? "child" : "none";
      });
      if (kind === "none") {
        throw new FsErrorShaped({
          code: "E_BAD_ARGS",
          message: "target has no file input",
          hint: "styled drop-zones without a file input need a DataTransfer drop — use WP3a `drop <file>` once available",
        });
      }
      const fileLoc = kind === "self" ? loc : loc.locator("input[type=file]");
      await fileLoc.setInputFiles(paths, { timeout: 5000 });
      return { uploaded: paths.map((p) => basename(p)), to: target!.text || target!.ref };
    },
  },
  {
    name: "paste",
    summary: "Paste text into a target via a real clipboard paste (fires onPaste, unlike fill)",
    target: "required",
    async run(ctx, args, target) {
      const text = String((args as { text?: unknown }).text ?? "");
      const loc = ctx.page.locator(`[data-fs-ref="${target!.ref}"]`);
      await loc.focus({ timeout: 5000 });

      // Clipboard-realistic path: grant clipboard perms, write the clipboard, then
      // a keyboard paste — the browser fires a genuine paste event and inserts the
      // text, exactly as a user's Cmd/Ctrl+V would. This is the difference from
      // `fill`, which sets .value directly and never triggers onPaste.
      let via = "keyboard";
      try {
        const origin = new URL(ctx.page.url()).origin;
        await ctx.page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin }).catch(() => {});
        await ctx.page.evaluate((t) => navigator.clipboard.writeText(t), text);
        await ctx.page.keyboard.press(process.platform === "darwin" ? "Meta+V" : "Control+V");
      } catch {
        // Headless without OS-level document focus can reject the clipboard write.
        // Fall back to a synthetic paste event carrying the same DataTransfer — it
        // still fires onPaste (the behavior that distinguishes paste from fill),
        // and an app reading clipboardData sees the text.
        via = "synthetic";
        await loc.evaluate((el, t) => {
          const dt = new DataTransfer();
          dt.setData("text/plain", t);
          el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
        }, text);
      }
      return { pasted: text, into: target!.text || target!.ref, via };
    },
  },
];
