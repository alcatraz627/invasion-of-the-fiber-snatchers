/** The macro artifact: a declarative YAML flow. Steps are verb + target + args,
 *  with retries and waits living in the runtime (Maestro's lesson), so the flow
 *  stays diffable and free of timing glue. This module is the schema and its
 *  validation only — it knows nothing about how a step runs, so it has no
 *  dependency on the pipeline or the registry (the verb set is injected). */

import { parse as yamlParse, stringify as yamlStringify } from "yaml";

/** A declared parameter, filled at run time by `--param name=value` and spliced
 *  into `%name%` occurrences in any step string. */
export type MacroParam = {
  name: string;
  description?: string;
  required?: boolean;
  default?: string;
};

/** How a step picks its element. The string form is the common case (an intent
 *  phrase, a CSS/ref/component per the CLI's shape inference). The object form
 *  exists for the selection the surveyed tools all lacked: pick the nth / a
 *  random / a named / an id'd element out of a set. */
export type StepTargetObj = {
  by?: "name" | "index" | "random" | "id";
  value?: string; // name text, element id, or a ref (for by:id); the picked text for by:name
  select?: string; // the set to pick from (a CSS/component/intent), for by:index|random
  role?: string; // optional role filter for by:name
  index?: number; // for by:index
};
export type StepTarget = string | StepTargetObj;

/** An inline assertion run right after a step (and the same shape sessions hold
 *  as `expect`). Each kind maps to an existing wait/observe capability. */
export type ExpectSpec = {
  text?: string; // some visible text is present within the budget
  count?: { select: string; equals: number }; // a selector matches exactly N
  state?: { expr: string; equals?: unknown; truthy?: boolean }; // a page expression's value
  settled?: boolean; // queries idle + mutations quiet
  timeoutMs?: number;
};

export type MacroStep = {
  verb: string;
  target?: StepTarget;
  value?: string; // fill value (convenience; also allowed inside args)
  key?: string; // press key (convenience)
  args?: Record<string, unknown>; // extra verb args (e.g. { settled: true })
  expect?: ExpectSpec; // optional assertion after the step
  from?: string; // provenance line (set by from-journal), ignored at run time
};

export type Macro = {
  name: string;
  description?: string;
  tags?: string[];
  params?: MacroParam[];
  steps: MacroStep[];
};

export const ALLOWED_TAGS = ["domain", "feature", "utility", "data-read"] as const;
export const BY_VALUES = ["name", "index", "random", "id"] as const;

export type ValidateResult = { ok: true; macro: Macro } | { ok: false; errors: string[] };

/** Parse YAML then validate. A parse error is reported like a schema error so
 *  the caller has one failure channel. */
export function parseMacro(yamlText: string, opts: { knownVerbs?: Set<string> } = {}): ValidateResult {
  let raw: unknown;
  try {
    raw = yamlParse(yamlText);
  } catch (e) {
    return { ok: false, errors: [`not valid YAML: ${(e as Error).message.split("\n")[0]}`] };
  }
  return validateMacro(raw, opts);
}

export function stringifyMacro(macro: Macro): string {
  return yamlStringify(macro);
}

/** Validate a parsed object against the macro schema. Every error names the
 *  location (step index, field) and how to fix it — the artifact is authored by
 *  an agent that needs the whole punch-list, so we collect, never throw. */
export function validateMacro(raw: unknown, opts: { knownVerbs?: Set<string> } = {}): ValidateResult {
  const errors: string[] = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, errors: ["macro must be a YAML mapping with `name` and `steps`"] };
  }
  const m = raw as Record<string, unknown>;

  if (typeof m.name !== "string" || !m.name.trim()) {
    errors.push("`name` is required and must be a non-empty string");
  } else if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(m.name)) {
    errors.push(`\`name\` "${m.name}" must be letters/digits/dashes/underscores (it becomes a filename)`);
  }

  if (m.description !== undefined && typeof m.description !== "string") {
    errors.push("`description` must be a string");
  }

  if (m.tags !== undefined) {
    if (!Array.isArray(m.tags)) errors.push("`tags` must be a list");
    else
      for (const t of m.tags) {
        if (typeof t !== "string" || !ALLOWED_TAGS.includes(t as (typeof ALLOWED_TAGS)[number])) {
          errors.push(`tag "${String(t)}" is not allowed — use one of: ${ALLOWED_TAGS.join(", ")}`);
        }
      }
  }

  const declaredParams = validateParams(m.params, errors);

  if (!Array.isArray(m.steps) || m.steps.length === 0) {
    errors.push("`steps` is required and must be a non-empty list");
  } else {
    m.steps.forEach((step, i) => validateStep(step, i, opts.knownVerbs, declaredParams, errors));
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, macro: raw as Macro };
}

function validateParams(rawParams: unknown, errors: string[]): Set<string> {
  const names = new Set<string>();
  if (rawParams === undefined) return names;
  if (!Array.isArray(rawParams)) {
    errors.push("`params` must be a list of { name, description?, required?, default? }");
    return names;
  }
  rawParams.forEach((p, i) => {
    if (!p || typeof p !== "object" || typeof (p as { name?: unknown }).name !== "string") {
      errors.push(`params[${i}]: needs a string \`name\``);
      return;
    }
    names.add((p as { name: string }).name);
  });
  return names;
}

function validateStep(step: unknown, i: number, knownVerbs: Set<string> | undefined, params: Set<string>, errors: string[]): void {
  const at = `steps[${i}]`;
  if (!step || typeof step !== "object" || Array.isArray(step)) {
    errors.push(`${at}: must be a mapping with a \`verb\``);
    return;
  }
  const s = step as Record<string, unknown>;

  if (typeof s.verb !== "string" || !s.verb.trim()) {
    errors.push(`${at}: \`verb\` is required (e.g. click, fill, press)`);
  } else if (knownVerbs && !knownVerbs.has(s.verb)) {
    const near = nearVerbs(s.verb, knownVerbs);
    errors.push(`${at}: unknown verb "${s.verb}"${near.length ? ` — did you mean ${near.join(" / ")}?` : ` — run \`fs actions\` for the verb list`}`);
  }

  if (s.target !== undefined) validateTarget(s.target, at, params, errors);

  // Unknown %var% references are the most common authoring slip — catch them in
  // every string field against the declared params so a typo fails validation,
  // not silently at run time.
  for (const field of ["target", "value", "key"] as const) {
    const v = s[field];
    if (typeof v === "string") checkVars(v, `${at}.${field}`, params, errors);
  }
  if (s.target && typeof s.target === "object") {
    const t = s.target as StepTargetObj;
    for (const field of ["value", "select"] as const) {
      if (typeof t[field] === "string") checkVars(t[field]!, `${at}.target.${field}`, params, errors);
    }
  }

  if (s.expect !== undefined) validateExpect(s.expect, `${at}.expect`, errors);
}

function validateTarget(target: unknown, at: string, params: Set<string>, errors: string[]): void {
  if (typeof target === "string") {
    if (!target.trim()) errors.push(`${at}.target: empty string`);
    return;
  }
  if (typeof target !== "object" || Array.isArray(target)) {
    errors.push(`${at}.target: must be a string or a { by, value/select } mapping`);
    return;
  }
  const t = target as StepTargetObj;
  if (t.by !== undefined && !BY_VALUES.includes(t.by)) {
    errors.push(`${at}.target.by: "${t.by}" is not valid — use one of: ${BY_VALUES.join(", ")}`);
  }
  if ((t.by === "index" || t.by === "random") && (typeof t.select !== "string" || !t.select.trim())) {
    errors.push(`${at}.target: by:${t.by} needs \`select\` — the set to pick from (a CSS selector, component expr, or intent phrase)`);
  }
  if (t.by === "index" && typeof t.index !== "number") {
    errors.push(`${at}.target: by:index needs a numeric \`index\``);
  }
  if ((t.by === "name" || t.by === "id" || t.by === undefined) && typeof t.value !== "string") {
    errors.push(`${at}.target: by:${t.by ?? "name"} needs a string \`value\``);
  }
}

function validateExpect(expect: unknown, at: string, errors: string[]): void {
  if (!expect || typeof expect !== "object" || Array.isArray(expect)) {
    errors.push(`${at}: must be a mapping with one of text | count | state | settled`);
    return;
  }
  const e = expect as ExpectSpec;
  const kinds = ["text", "count", "state", "settled"].filter((k) => (e as Record<string, unknown>)[k] !== undefined);
  if (kinds.length === 0) errors.push(`${at}: needs one of text | count | state | settled`);
  if (e.count !== undefined && (typeof e.count?.select !== "string" || typeof e.count?.equals !== "number")) {
    errors.push(`${at}.count: needs { select: "<css>", equals: <n> }`);
  }
  if (e.state !== undefined && typeof e.state?.expr !== "string") {
    errors.push(`${at}.state: needs { expr: "<js>", equals?: <v> | truthy?: true }`);
  }
}

/** Verbs within a small edit distance or sharing a prefix — a typo like "clik"
 *  should point at "click", not fall through to the whole verb list. */
function nearVerbs(verb: string, known: Set<string>): string[] {
  return [...known]
    .filter((v) => v.startsWith(verb) || verb.startsWith(v) || editDistance(v, verb) <= 2)
    .slice(0, 3);
}

function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) dp[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i]![j] = Math.min(dp[i - 1]![j]! + 1, dp[i]![j - 1]! + 1, dp[i - 1]![j - 1]! + cost);
    }
  }
  return dp[a.length]![b.length]!;
}

/** Flag any %var% in a string that isn't a declared param. */
function checkVars(str: string, at: string, params: Set<string>, errors: string[]): void {
  for (const match of str.matchAll(/%([a-zA-Z0-9_]+)%/g)) {
    const name = match[1]!;
    if (!params.has(name)) {
      errors.push(`${at}: uses %${name}% but no param "${name}" is declared${params.size ? ` (declared: ${[...params].join(", ")})` : ""}`);
    }
  }
}
