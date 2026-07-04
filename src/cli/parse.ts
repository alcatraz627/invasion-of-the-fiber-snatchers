/** One argv parser for every verb. Targets are inferred from shape so the
 *  agent can pass what it has — a ref, component expr, CSS, or plain words —
 *  with explicit flags to override inference. */

import type { TargetSpec } from "../pipeline/contracts.ts";

export type Parsed = {
  cmd: string;
  positionals: string[];
  flags: Record<string, string | number | boolean>;
};

// Value-less flags must never swallow the following positional
// (`fs state --shallow "#x"` was silently losing its selector).
const BOOLEAN_FLAGS = new Set(["json", "detailed", "full", "shallow", "help", "settled", "network-idle"]);

export function parseArgv(argv: string[]): Parsed {
  const [cmd = "help", ...rest] = argv;
  const positionals: string[] = [];
  const flags: Record<string, string | number | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === undefined) continue;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 2) {
        const v = a.slice(eq + 1);
        flags[a.slice(2, eq)] = /^-?\d+$/.test(v) ? Number(v) : v;
        continue;
      }
      const key = a.slice(2);
      const next = rest[i + 1];
      if (!BOOLEAN_FLAGS.has(key) && next !== undefined && !next.startsWith("--")) {
        flags[key] = /^-?\d+$/.test(next) ? Number(next) : next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positionals.push(a);
    }
  }
  return { cmd, positionals, flags };
}

// Bare capitalized words ("Search", "JEGS") are UI text, not components —
// component inference requires the bracket form; --component forces it.
const COMPONENT_EXPR = /^[A-Z][A-Za-z0-9_$]*\[[A-Za-z0-9_$.]+~?="[^"]*"\]$/;
// Structural leads (".x", "#x", "[x]") always read as CSS; combinator chars
// only when the string has no spaces — "Save + Close" and "Next >" are text.
const CSS_LEAD = /^[.#\[]/;
const CSS_COMBINATOR = /[>~+*]|:(nth|first|last|not|has)\b/;

export function inferTarget(raw: string | undefined, flags: Parsed["flags"]): TargetSpec | undefined {
  if (typeof flags.ref === "string") return { kind: "ref", ref: flags.ref };
  if (typeof flags.css === "string") {
    return { kind: "css", selector: flags.css, nth: typeof flags.nth === "number" ? flags.nth : undefined };
  }
  if (typeof flags.component === "string") return { kind: "component", expr: flags.component };
  if (raw === undefined) return undefined;

  if (/^e\d+\.\w+$/.test(raw) || /^ec\w+\.\w+$/.test(raw) || /^e\d+$/.test(raw)) return { kind: "ref", ref: raw };
  if (COMPONENT_EXPR.test(raw) && !raw.includes(" ")) return { kind: "component", expr: raw };
  if (CSS_LEAD.test(raw) || (!raw.includes(" ") && CSS_COMBINATOR.test(raw))) {
    return { kind: "css", selector: raw, nth: typeof flags.nth === "number" ? flags.nth : undefined };
  }
  return { kind: "intent", text: raw, role: typeof flags.role === "string" ? flags.role : undefined };
}
