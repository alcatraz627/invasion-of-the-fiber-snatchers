#!/usr/bin/env bun
/**
 * Eval transpile + wrap regression suite.
 *
 * Mirrors the logic from `src/cli/eval.ts` so we can iterate on wrapForReturn
 * without spinning up the daemon. Run via:
 *
 *   bun tests/eval-harness.ts
 *
 * Exits non-zero on any failure. Wire into `prerelease` so drift is caught
 * before shipping.
 *
 * When you touch `wrapForReturn` in src/cli/eval.ts, update this file's copy
 * at the same time (they're intentionally two copies — this file is a pure
 * test fixture, the src/ version runs in the CLI).
 */

// =============================================================================
//   wrapForReturn — copy from src/cli/eval.ts; keep in sync
// =============================================================================

function wrapForReturn(src: string): string {
  if (/^\s*return\b/m.test(src)) return src;
  const trimmed = src.replace(/\/\/[^\n]*\s*$/gm, "").replace(/[\s;]+$/, "");
  if (!trimmed) return src;
  let depth = 0;
  let inStr: string | null = null;
  let prev = "";
  let lastSplit = -1;
  for (let i = 0; i < trimmed.length; i++) {
    const c = trimmed[i] ?? "";
    if (inStr) {
      if (c === inStr && prev !== "\\") inStr = null;
    } else if (c === '"' || c === "'" || c === "`") inStr = c;
    else if (c === "(" || c === "{" || c === "[") depth++;
    else if (c === ")" || c === "}" || c === "]") depth--;
    else if (depth === 0 && (c === ";" || c === "\n")) lastSplit = i;
    prev = c;
  }
  const tail = (lastSplit >= 0 ? trimmed.slice(lastSplit + 1) : trimmed).trim();
  const prefix = lastSplit >= 0 ? trimmed.slice(0, lastSplit + 1) : "";
  if (!tail) return src;
  if (tail.startsWith("//") || tail.startsWith("/*")) return src;
  if (/^(const|let|var|function|class|if|for|while|switch|try|throw|import|export)\b/.test(tail)) return src;
  return `${prefix}\nreturn ${tail};\n`;
}

// =============================================================================
//   Test cases — V0.3.1 14 + V0.4.0 top-level-await case
// =============================================================================

type Case = [src: string, expected: unknown, label: string];

const cases: Case[] = [
  // V0.3.1 harness (14 cases)
  ["'hello world'", "hello world", "literal string"],
  ["42", 42, "literal number"],
  ["({a:1,b:2})", { a: 1, b: 2 }, "paren object"],
  ["const x = 42; x", 42, "P1: const + trailing identifier"],
  ["const x: number = 42; x", 42, "P1: TS + trailing identifier"],
  ["const x: number = 42; ({x})", { x: 42 }, "P1: TS + trailing wrap"],
  ["return 5;", 5, "explicit return"],
  ["const x = 5;", undefined, "decl only"],
  ["const a = 1;\nconst b = 2;\na + b", 3, "multi-line decl + trailing"],
  ['const x = "hi;{"; x', "hi;{", "string content ignored"],
  ["42 + 1", 43, "arith"],
  ["(function(){return 1;})()", 1, "IIFE"],
  ["const x = 42; x // comment", 42, "trailing comment stripped"],
  ["'ok'; // bye", "ok", "trailing comment after literal"],

  // V0.4.0 addendum from feedback #v032
  [
    "const result = await (async () => { return 42; })();\nreturn result;",
    42,
    "V0.4.0: top-level await + IIFE + explicit return",
  ],
  // Synchronous equivalent to catch any Function()-vs-AsyncFunction drift
  [
    "const r = await Promise.resolve({ status: 200 });\nr",
    { status: 200 },
    "V0.4.0: top-level await + trailing identifier",
  ],
];

let pass = 0;
let fail = 0;
const failures: string[] = [];

for (const [src, expected, label] of cases) {
  const preWrapped = wrapForReturn(src);
  const needsAsyncContext = /\bawait\b/.test(preWrapped);
  const beforeTranspile = needsAsyncContext ? `(async () => { ${preWrapped} })()` : preWrapped;
  const t = new Bun.Transpiler({ loader: "ts", target: "bun" });
  let transpiled: string;
  try {
    transpiled = t.transformSync(beforeTranspile);
  } catch (e) {
    failures.push(`FAIL [${label}]: transpile error: ${(e as Error).message}`);
    fail++;
    continue;
  }
  const code = needsAsyncContext ? transpiled.replace(/;\s*$/, "") : `(async () => { ${transpiled} })()`;
  const fn = new Function(`return (${code})`);
  try {
    const result = await fn();
    const eq = JSON.stringify(result) === JSON.stringify(expected);
    if (eq) {
      pass++;
      console.log(`  ok  [${label}]`);
    } else {
      failures.push(`FAIL [${label}]: expected ${JSON.stringify(expected)}, got ${JSON.stringify(result)}`);
      fail++;
    }
  } catch (e) {
    failures.push(`FAIL [${label}]: runtime error: ${(e as Error).message}`);
    fail++;
  }
}

console.log("");
console.log(`${pass}/${pass + fail} passed`);
if (fail > 0) {
  console.log("");
  for (const f of failures) console.log(f);
  process.exit(1);
}
process.exit(0);
