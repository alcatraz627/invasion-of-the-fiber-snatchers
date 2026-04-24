import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { ok, err, type Result } from "../core/result.ts";
import { requireConfig } from "../core/config.ts";
import { controlSocketPath } from "../core/browser.ts";
import { sendRequest } from "../core/ipc.ts";

/**
 * Escape hatch: evaluate a TS/JS file in the page context. Requires
 * --yes-i-know because it's unbounded power; use state/dispatch when possible.
 */
export async function run(args: string[]): Promise<Result> {
  if (!args.includes("--yes-i-know")) {
    return err("E_NEEDS_ACK", "`eval` is an escape hatch. Pass --yes-i-know to confirm.", {
      next_steps: ["For typical reads use `fiber-snatcher state`.", "For store writes use `fiber-snatcher dispatch`."],
    });
  }
  const file = args.find((a) => !a.startsWith("--"));
  if (!file) return err("E_NO_FILE", "Pass the path to a .ts or .js file to evaluate.");
  if (!existsSync(file)) return err("E_FILE_NOT_FOUND", `File not found: ${file}`);

  const src = await readFile(file, "utf8");
  // Bun's built-in transpiler will handle TS when we feed it as an expression.
  // Simplest: wrap as an IIFE string.
  const code = `(async () => { ${src} })()`;

  const cfg = await requireConfig();
  const res = await sendRequest(controlSocketPath(cfg), { id: "eval", op: "eval", code }, 30000)
    .catch((e) => ({ id: "eval", ok: false as const, error: String(e.message ?? e) }));
  if (!res.ok) return err("E_EVAL_FAILED", res.error);
  return ok(res.data);
}
