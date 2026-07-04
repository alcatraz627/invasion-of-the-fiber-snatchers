/** Running a macro: fill %vars%, resolve each step's target (including the
 *  by name|index|random|id selection the artifact format adds), then push the
 *  step through the SAME pipeline a hand-driven verb uses — so a replay is
 *  indistinguishable from live driving, digest and journal included. Stops on
 *  the first failure and hands back the failing step's digest plus its journal
 *  ref, which is the actionable dump the agent re-plans from. */

import type { DigestDelta, FsError } from "../protocol/types.ts";
import { FsErrorShaped, type ActionDef, type PipelineCtx, type TargetSpec } from "../pipeline/contracts.ts";
import { runAction, type PipelineDeps } from "../pipeline/index.ts";
import type { Journal } from "../pipeline/journal.ts";
import { waitForText, waitSettled } from "../pipeline/waits.ts";
import { inferTarget } from "../cli/parse.ts";
import type { ExpectSpec, Macro, MacroStep, StepTarget } from "./format.ts";

/** Injected so run.ts needn't import the registry (which imports the macro verb
 *  back — a cycle) and so tests can supply a fake verb table. */
export type MacroDeps = {
  journal: Journal;
  // The registry types verbs as ActionDef<never> and casts args at the call
  // boundary (as server.ts does); mirror that here.
  lookup: (name: string) => ActionDef<never> | undefined;
};

export type ExpectResult = { kind: string; ok: boolean; detail?: string };

export type StepResult = {
  i: number;
  verb: string;
  target?: string; // human descriptor of what was targeted
  ok: boolean;
  digest?: DigestDelta;
  error?: FsError;
  seq?: number; // journal ref for this step
  expect?: ExpectResult;
};

export type MacroRunResult = {
  macro: string;
  params: Record<string, string>;
  ok: boolean;
  steps: StepResult[];
  failedAt?: number; // index of the step that stopped the run
  journal?: string; // path to this run's journal file
};

export type VarsResult = { ok: true; vars: Record<string, string> } | { ok: false; errors: string[] };

/** Overlay provided --param values onto declared defaults; a missing required
 *  param is a run-time error (the artifact validated its %vars% at author time,
 *  but the caller still has to supply them). */
export function resolveVars(macro: Macro, provided: Record<string, string>): VarsResult {
  const errors: string[] = [];
  const vars: Record<string, string> = {};
  for (const p of macro.params ?? []) {
    const val = provided[p.name] ?? p.default;
    if (val === undefined) {
      if (p.required) errors.push(`missing required --param ${p.name}${p.description ? ` (${p.description})` : ""}`);
      continue;
    }
    vars[p.name] = val;
  }
  // Extra provided values are harmless (a step may %splice% an undeclared one on
  // purpose during authoring); keep them available.
  for (const [k, v] of Object.entries(provided)) if (!(k in vars)) vars[k] = v;
  if (errors.length) return { ok: false, errors };
  return { ok: true, vars };
}

/** Replace every %name% with its var value; an unresolved %name% is a bug the
 *  caller should have caught, so it fails loudly rather than shipping literally. */
export function substituteVars(str: string, vars: Record<string, string>): string {
  return str.replace(/%([a-zA-Z0-9_]+)%/g, (_, name: string) => {
    if (!(name in vars)) throw new FsErrorShaped({ code: "E_BAD_ARGS", message: `unresolved %${name}% (no such param)` });
    return vars[name]!;
  });
}

function describeSpec(spec: TargetSpec): string {
  switch (spec.kind) {
    case "ref": return spec.ref;
    case "css": return spec.selector + (spec.nth !== undefined ? `#${spec.nth}` : "");
    case "component": return spec.expr;
    case "intent": return spec.text;
  }
}

/** Turn a step's target (string or object form) into a concrete TargetSpec.
 *  Most forms stay lazy and let the pipeline resolve them, inheriting its
 *  ambiguity/staleness handling; by:index|random must enumerate here so a single
 *  element is chosen before the act. */
export async function resolveStepTarget(ctx: PipelineCtx, target: StepTarget | undefined, vars: Record<string, string>): Promise<TargetSpec | undefined> {
  if (target === undefined) return undefined;

  if (typeof target === "string") {
    const raw = substituteVars(target, vars);
    return inferTarget(raw, {}) ?? { kind: "intent", text: raw };
  }

  const value = target.value !== undefined ? substituteVars(target.value, vars) : undefined;
  const select = target.select !== undefined ? substituteVars(target.select, vars) : undefined;

  switch (target.by ?? "name") {
    case "name":
      return { kind: "intent", text: value ?? "", role: target.role };
    case "id":
      // A ref keeps its shape; anything else is a DOM id -> #id selector.
      if (value && /^ec?\w+(\.\w+)?$/.test(value)) return { kind: "ref", ref: value };
      return { kind: "css", selector: value?.startsWith("#") ? value : `#${value ?? ""}` };
    case "index":
      return pickFromSet(ctx, select!, target.index ?? 0);
    case "random":
      return pickFromSet(ctx, select!, "random");
  }
}

/** Pick the nth (or a random) element from a set described by `select`. A CSS
 *  select stays a css+nth spec; an intent/component select is enumerated through
 *  the pipeline's candidate resolver and the chosen candidate's ref is returned. */
async function pickFromSet(ctx: PipelineCtx, select: string, which: number | "random"): Promise<TargetSpec> {
  const base = inferTarget(select, {}) ?? { kind: "intent" as const, text: select };
  if (base.kind === "css") {
    const count = await ctx.page.locator(base.selector).count();
    if (count === 0) throw new FsErrorShaped({ code: "E_TARGET_NOT_FOUND", message: `by:${which === "random" ? "random" : "index"} set is empty: ${select}` });
    const nth = which === "random" ? Math.floor(Math.random() * count) : which;
    if (nth < 0 || nth >= count) throw new FsErrorShaped({ code: "E_BAD_ARGS", message: `index ${nth} out of range (set has ${count})` });
    return { kind: "css", selector: base.selector, nth };
  }
  const candidates = await ctx.candidatesFor(base);
  if (candidates.length === 0) throw new FsErrorShaped({ code: "E_TARGET_NOT_FOUND", message: `by:${which === "random" ? "random" : "index"} set is empty: ${select}` });
  const nth = which === "random" ? Math.floor(Math.random() * candidates.length) : which;
  const pick = candidates[nth];
  if (!pick) throw new FsErrorShaped({ code: "E_BAD_ARGS", message: `index ${nth} out of range (set has ${candidates.length})` });
  return { kind: "ref", ref: pick.ref };
}

/** Assemble the wire args for a step: its resolved target plus verb-specific
 *  conveniences (value/key) and any explicit args (e.g. { settled: true }). */
function buildStepArgs(step: MacroStep, target: TargetSpec | undefined, vars: Record<string, string>): Record<string, unknown> {
  const args: Record<string, unknown> = { ...(step.args ?? {}) };
  if (target) args.target = target;
  if (step.value !== undefined) args.value = substituteVars(step.value, vars);
  if (step.key !== undefined) args.key = substituteVars(step.key, vars);
  return args;
}

/** Run one inline/session assertion, mapping each kind onto an existing wait or
 *  read. Never throws: a miss is a recorded failure, which is the whole point of
 *  `expect` versus `wait` (wait errors; expect judges). */
export async function runAssertion(ctx: PipelineCtx, spec: ExpectSpec): Promise<ExpectResult> {
  const timeoutMs = spec.timeoutMs ?? 3000;
  try {
    if (spec.text !== undefined) {
      await waitForText(ctx, spec.text, { timeoutMs });
      return { kind: "text", ok: true, detail: `"${spec.text}" present` };
    }
    if (spec.settled) {
      await waitSettled(ctx, { timeoutMs });
      return { kind: "settled", ok: true, detail: "queries idle" };
    }
    if (spec.count) {
      const { select, equals } = spec.count;
      const deadline = Date.now() + timeoutMs;
      let n = -1;
      while (Date.now() < deadline) {
        n = await ctx.page.locator(select).count();
        if (n === equals) return { kind: "count", ok: true, detail: `${select} == ${equals}` };
        await new Promise((r) => setTimeout(r, 50));
      }
      return { kind: "count", ok: false, detail: `${select}: expected ${equals}, saw ${n}` };
    }
    if (spec.state) {
      const { expr, equals, truthy } = spec.state;
      const val = await ctx.page.evaluate((code: string) => {
        try {
          // eslint-disable-next-line no-eval
          return { v: (0, eval)(code) };
        } catch (e) {
          return { err: String((e as Error).message ?? e) };
        }
      }, expr);
      if ((val as { err?: string }).err) return { kind: "state", ok: false, detail: `expr threw: ${(val as { err: string }).err}` };
      const v = (val as { v: unknown }).v;
      if (truthy) return { kind: "state", ok: !!v, detail: `${expr} -> ${JSON.stringify(v)}` };
      const ok = JSON.stringify(v) === JSON.stringify(equals);
      return { kind: "state", ok, detail: `${expr} -> ${JSON.stringify(v)}${ok ? "" : ` (expected ${JSON.stringify(equals)})`}` };
    }
  } catch (e) {
    const err = e instanceof FsErrorShaped ? e.err.message : String((e as Error).message ?? e);
    return { kind: "assert", ok: false, detail: err };
  }
  return { kind: "none", ok: false, detail: "empty expect" };
}

/** Run a validated macro end to end. Each step runs through the real pipeline;
 *  the first failure (step error or failed inline expect) stops the run when
 *  stopOnError (default true) and sets failedAt. */
export async function runMacro(
  ctx: PipelineCtx,
  deps: MacroDeps,
  macro: Macro,
  vars: Record<string, string>,
  opts: { stopOnError?: boolean } = {}
): Promise<MacroRunResult> {
  const stopOnError = opts.stopOnError ?? true;
  const pdeps: PipelineDeps = {
    page: ctx.page,
    journal: deps.journal,
    gen: ctx.gen,
    profile: () => ctx.profile,
    log: (body) => deps.journal.append({ cmd: "log", args: { body }, ok: true, durMs: 0 }),
  };

  const steps: StepResult[] = [];
  let ok = true;
  let failedAt: number | undefined;

  for (const [i, step] of macro.steps.entries()) {
    const def = deps.lookup(step.verb);
    if (!def) {
      steps.push({ i, verb: step.verb, ok: false, error: { code: "E_BAD_ARGS", message: `unknown verb "${step.verb}"` } });
      ok = false;
      failedAt = i;
      break;
    }

    let target: TargetSpec | undefined;
    try {
      target = await resolveStepTarget(ctx, step.target, vars);
    } catch (e) {
      const err = e instanceof FsErrorShaped ? e.err : { code: "E_INTERNAL" as const, message: String((e as Error).message ?? e) };
      steps.push({ i, verb: step.verb, ok: false, error: err });
      ok = false;
      failedAt = i;
      break;
    }

    const r = await runAction(pdeps, def, buildStepArgs(step, target, vars) as never);
    const sr: StepResult = {
      i,
      verb: step.verb,
      target: target ? describeSpec(target) : undefined,
      ok: r.ok,
      digest: r.digest,
      error: r.error,
      seq: deps.journal.lastSeq,
    };
    steps.push(sr);

    if (!r.ok) {
      ok = false;
      failedAt = i;
      if (stopOnError) break;
      continue;
    }

    if (step.expect) {
      const a = await runAssertion(ctx, step.expect);
      sr.expect = a;
      if (!a.ok) {
        ok = false;
        failedAt = i;
        if (stopOnError) break;
      }
    }
  }

  return { macro: macro.name, params: vars, ok, steps, failedAt, journal: deps.journal.path };
}
