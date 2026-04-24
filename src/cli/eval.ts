import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { ok, err, type Result } from "../core/result.ts";
import { requireConfig } from "../core/config.ts";
import { controlSocketPath } from "../core/browser.ts";
import { sendRequest } from "../core/ipc.ts";

/**
 * Eval is a query primitive. Writes a TS/JS file; the last expression's value
 * is returned as `data`. TS syntax is transpiled via Bun before being sent to
 * the page.
 *
 * Requires --yes-i-know because it's unbounded power; use state/dispatch/
 * atoms/queries when they fit.
 *
 * Shape (Path A — V0.3.0):
 *   echo 'document.title' > /tmp/t.ts
 *   fiber-snatcher eval /tmp/t.ts --yes-i-know
 *   # → data: "My App"
 *
 * For async work, await at top level inside the script; the value of the
 * trailing expression is awaited automatically.
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

  // CRITICAL ORDERING: wrap FIRST, transpile SECOND.
  //
  // Bun's transpiler performs dead-code elimination — it strips "useless"
  // bare expressions like `({ foo: 42 })` completely. If we transpile first
  // then wrap, the final expression vanishes before we can return it.
  //
  // By converting the last expression into `return <expr>;` BEFORE transpile,
  // DCE leaves it alone (it's part of a return statement, which has value).
  // TS type annotations inside the returned expression still get stripped
  // correctly.
  //
  // Contract:
  //   - Trailing expression (with or without semicolon) → return value.
  //   - Explicit `return x;` at top level of the file also works.
  //   - Pure-side-effect scripts (no trailing expression) → undefined.
  const preWrapped = wrapForReturn(src);

  let transpiled: string;
  try {
    const t = new Bun.Transpiler({ loader: "ts", target: "browser" });
    transpiled = t.transformSync(preWrapped);
  } catch (e) {
    return err("E_TRANSPILE_FAILED", `Failed to transpile ${file}: ${(e as Error).message}`);
  }

  const code = `(async () => { ${transpiled} })()`;

  const cfg = await requireConfig();
  const res = await sendRequest(controlSocketPath(cfg), { id: "eval", op: "eval", code }, 30000)
    .catch((e) => ({ id: "eval", ok: false as const, error: String(e.message ?? e) }));
  if (!res.ok) return err("E_EVAL_FAILED", res.error);
  return ok(res.data);
}

/**
 * Split the source at the last `;` or `\n` at depth 0 (outside strings and
 * brackets). Everything after that split is the trailing expression; wrap it
 * into a `return <expr>;`. This correctly handles:
 *
 *   const x = 42; x                   → const x = 42;  → return x;
 *   document.title                    → return document.title;
 *   42 + 1                             → return 42 + 1;
 *   "hello"                            → return "hello";
 *   const x = "hi; {"; x              → (string contents ignored) → return x;
 *   (function(){return 1;})()         → return (function(){return 1;})();
 *
 * Bails (returns src unchanged — no implicit return) when:
 *   - The script has an explicit top-level `return`.
 *   - The tail token starts with a statement keyword (const/let/…).
 *   - There is no tail expression.
 *
 * DCE note: Bun's transpiler strips bare expression statements. We MUST wrap
 * before transpile so the payload rides inside a `return`, which DCE
 * preserves.
 */
function wrapForReturn(src: string): string {
  if (/^\s*return\b/m.test(src)) return src;

  // Strip trailing whitespace + semicolons + single-line comments so the
  // "last meaningful token" is what we target.
  const trimmed = src
    .replace(/\/\/[^\n]*\s*$/gm, "")
    .replace(/[\s;]+$/, "");
  if (!trimmed) return src;

  let depth = 0;
  let inStr: string | null = null;
  let prev = "";
  let lastSplit = -1;

  for (let i = 0; i < trimmed.length; i++) {
    const c = trimmed[i] ?? "";
    if (inStr) {
      if (c === inStr && prev !== "\\") inStr = null;
    } else if (c === '"' || c === "'" || c === "`") {
      inStr = c;
    } else if (c === "(" || c === "{" || c === "[") {
      depth++;
    } else if (c === ")" || c === "}" || c === "]") {
      depth--;
    } else if (depth === 0 && (c === ";" || c === "\n")) {
      lastSplit = i;
    }
    prev = c;
  }

  const tail = (lastSplit >= 0 ? trimmed.slice(lastSplit + 1) : trimmed).trim();
  const prefix = lastSplit >= 0 ? trimmed.slice(0, lastSplit + 1) : "";

  if (!tail) return src;
  if (tail.startsWith("//") || tail.startsWith("/*")) return src;
  if (/^(const|let|var|function|class|if|for|while|switch|try|throw|import|export)\b/.test(tail)) return src;

  return `${prefix}\nreturn ${tail};\n`;
}
