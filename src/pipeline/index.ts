/** The one path every verb runs through: resolve → wait → act → settle →
 *  digest → journal. Verbs only implement the act; uniformity of feedback is
 *  the pipeline's job, which is what makes the tool agent-legible. */

import type { Page } from "playwright";
import type { DigestDelta, FsError, TargetCandidate } from "../protocol/types.ts";
import { FsErrorShaped, type ActionDef, type PipelineCtx, type ResolvedTarget, type TargetSpec, type TelemetryProfile } from "./contracts.ts";
import type { Journal } from "./journal.ts";

type DrainResult = {
  mutationWeight: number;
  errors: string[];
  route?: string;
  queriesPending: number;
};

export type PipelineDeps = {
  page: Page;
  journal: Journal;
  gen: () => number;
  profile: () => TelemetryProfile;
  log: (body: string) => void;
};

export type PipelineResult = {
  ok: boolean;
  data?: unknown;
  error?: FsError;
  digest?: DigestDelta;
  target?: ResolvedTarget;
  durMs: number;
};

export function makeCtx(deps: PipelineDeps): PipelineCtx {
  const runtime = async <T>(method: string, ...args: unknown[]): Promise<T> => {
    const result = await deps.page.evaluate(
      ({ method, args }) => {
        const fs = (window as unknown as { __fs?: Record<string, (...a: unknown[]) => unknown> }).__fs;
        if (!fs) return { __fsMissing: true };
        const fn = fs[method];
        if (typeof fn !== "function") throw new Error(`runtime has no method ${method}`);
        return fn.apply(fs, args);
      },
      { method, args }
    );
    if (result && typeof result === "object" && (result as { __fsMissing?: boolean }).__fsMissing) {
      throw new FsErrorShaped({
        code: "E_RUNTIME_MISSING",
        message: "page runtime not present (document predates injection?)",
        hint: "run `fs reload` to refresh the page with the runtime injected",
      });
    }
    return result as T;
  };

  const candidatesFor = async (spec: TargetSpec, limit = 8): Promise<TargetCandidate[]> => {
    if (spec.kind === "intent") {
      return await runtime<TargetCandidate[]>("resolveIntent", spec.text, spec.role);
    }
    if (spec.kind === "component") {
      const hits = await runtime<TargetCandidate[] | { error: string }>("resolveComponent", spec.expr);
      if (!Array.isArray(hits)) throw new FsErrorShaped({ code: "E_BAD_ARGS", message: hits.error });
      return hits.slice(0, limit);
    }
    return [];
  };

  const resolve = async (spec: TargetSpec): Promise<ResolvedTarget> => {
    const gen = deps.gen();
    if (spec.kind === "ref") {
      const found = await deps.page.locator(`[data-fs-ref="${spec.ref}"]`).count();
      if (found === 0) {
        const fresh = await runtime<TargetCandidate[]>("resolveIntent", spec.ref).catch(() => []);
        throw new FsErrorShaped({
          code: "E_TARGET_STALE",
          message: `ref ${spec.ref} is not in the current document (generation ${gen})`,
          candidates: fresh,
          hint: "re-run `fs page` and use a fresh ref",
        });
      }
      return { spec, ref: spec.ref, gen, role: "", text: "" };
    }
    if (spec.kind === "css") {
      const loc = deps.page.locator(spec.selector);
      const count = await loc.count();
      if (count === 0) {
        throw new FsErrorShaped({
          code: "E_TARGET_NOT_FOUND",
          message: `selector matched 0 elements: ${spec.selector}`,
          hint: "run `fs page` to see what is interactable right now",
        });
      }
      if (spec.nth === undefined && count > 1) {
        const candidates = await describeMatches(deps.page, spec.selector, count);
        throw new FsErrorShaped({
          code: "E_TARGET_AMBIGUOUS",
          message: `selector matched ${count} elements`,
          candidates,
          hint: "pick one: pass --nth <i>, or use its ref/text from the list",
        });
      }
      if (spec.nth !== undefined && (spec.nth < 0 || spec.nth >= count)) {
        throw new FsErrorShaped({
          code: "E_BAD_ARGS",
          message: `--nth ${spec.nth} out of range (matched ${count}, valid 0..${count - 1})`,
        });
      }
      const el = loc.nth(spec.nth ?? 0);
      const ref = await el.evaluate((node) => {
        let r = node.getAttribute("data-fs-ref");
        if (!r) {
          r = `e-css-${Math.random().toString(36).slice(2, 8)}`;
          node.setAttribute("data-fs-ref", r);
        }
        return r;
      });
      return { spec, ref, gen, role: "", text: "" };
    }
    // intent / component: resolve through candidates
    const candidates = await candidatesFor(spec);
    if (candidates.length === 0) {
      throw new FsErrorShaped({
        code: "E_TARGET_NOT_FOUND",
        message: spec.kind === "intent" ? `nothing on screen matches "${spec.text}"` : `no mounted ${spec.expr}`,
        hint: "run `fs page` to see what is interactable right now",
      });
    }
    const top = candidates[0]!;
    const runnerUp = candidates[1];
    const confident = top.confidence >= 0.85 && (!runnerUp || top.confidence - runnerUp.confidence >= 0.15);
    if (!confident) {
      throw new FsErrorShaped({
        code: "E_TARGET_AMBIGUOUS",
        message: `ambiguous target (${candidates.length} plausible matches)`,
        candidates,
        hint: `act on a specific one: fs click --ref ${top.ref}`,
      });
    }
    return { spec, ref: top.ref, gen: deps.gen(), role: top.role, text: top.text, component: top.component };
  };

  return {
    page: deps.page,
    gen: deps.gen,
    profile: deps.profile(),
    resolve,
    candidatesFor,
    runtime,
    log: deps.log,
  };
}

async function describeMatches(page: Page, selector: string, count: number): Promise<TargetCandidate[]> {
  const cap = Math.min(count, 8);
  const out: TargetCandidate[] = [];
  for (let i = 0; i < cap; i++) {
    const el = page.locator(selector).nth(i);
    const desc = await el
      .evaluate((node) => {
        let r = node.getAttribute("data-fs-ref");
        if (!r) {
          r = `e-css-${Math.random().toString(36).slice(2, 8)}`;
          node.setAttribute("data-fs-ref", r);
        }
        const he = node as HTMLElement;
        const text = (he.getAttribute("aria-label") ?? he.innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
        return { ref: r, role: he.tagName.toLowerCase(), text: text || `#${he.id}` || he.tagName.toLowerCase() };
      })
      .catch(() => null);
    if (desc) out.push({ ...desc, confidence: 0 });
  }
  return out;
}

/** Run one verb through the full pipeline. Never throws: failures become
 *  Result-shaped errors so the CLI always prints something agent-usable. */
export async function runAction<A>(deps: PipelineDeps, def: ActionDef<A>, args: A & { target?: TargetSpec }): Promise<PipelineResult> {
  const start = Date.now();
  const ctx = makeCtx(deps);
  const urlBefore = deps.page.url();

  // Clear the observation buffer so the digest reflects THIS action only.
  const preDrain = () => ctx.runtime<DrainResult>("drain").catch(() => null);

  let target: ResolvedTarget | undefined;
  let data: unknown;
  let error: FsError | undefined;

  try {
    if (!def.observation) await preDrain();

    if (def.target && args.target) {
      target = await ctx.resolve(args.target);
    } else if (def.target === "required" && !args.target) {
      throw new FsErrorShaped({ code: "E_BAD_ARGS", message: `${def.name} requires a target` });
    }

    if (def.wait?.settled) await waitSettled(ctx, def.wait.timeoutMs ?? 5000);

    data = await def.run(ctx, args, target);
  } catch (e) {
    error =
      e instanceof FsErrorShaped
        ? e.err
        : { code: "E_INTERNAL", message: String((e as Error).message ?? e) };
  }

  // Settle + digest for mutating verbs; observations skip it (cheap reads).
  let digest: DigestDelta | undefined;
  if (!def.observation && def.settle !== false) {
    digest = await settleAndDigest(ctx, deps, urlBefore, def.settle || {});
  }

  const durMs = Date.now() - start;
  deps.journal.append({
    cmd: def.name,
    args: sanitizeArgs(args),
    target: target ? { ref: target.ref, role: target.role, text: target.text, component: target.component } : undefined,
    ok: !error,
    error: error?.code,
    digest,
    durMs,
  });

  return { ok: !error, data, error, digest, target, durMs };
}

async function waitSettled(ctx: PipelineCtx, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pending = await ctx.runtime<number>("queriesPending").catch(() => 0);
    if (pending === 0) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new FsErrorShaped({
    code: "E_WAIT_TIMEOUT",
    message: `queries still fetching after ${timeoutMs}ms`,
    hint: "the app may be polling; use --no-settled to act anyway",
  });
}

async function settleAndDigest(
  ctx: PipelineCtx,
  deps: PipelineDeps,
  urlBefore: string,
  settle: { quietMs?: number; timeoutMs?: number; queries?: boolean }
): Promise<DigestDelta> {
  const quietMs = settle.quietMs ?? 150;
  const timeoutMs = settle.timeoutMs ?? 3000;
  const deadline = Date.now() + timeoutMs;

  let totalMutations = 0;
  const errors: string[] = [];
  let queriesPending = 0;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, quietMs));
    const d = await ctx.runtime<DrainResult>("drain").catch(() => null);
    if (!d) break; // navigation nuked the document mid-settle; digest what we have
    totalMutations += d.mutationWeight;
    errors.push(...d.errors);
    queriesPending = d.queriesPending;
    const quiet = d.mutationWeight === 0 && (settle.queries === false || d.queriesPending === 0);
    if (quiet) break;
  }

  const urlAfter = deps.page.url();
  const digest: DigestDelta = {
    mutations: totalMutations === 0 ? "none" : totalMutations < 20 ? "minor" : "major",
    queries: queriesPending > 0 ? "pending" : "settled",
  };
  if (urlAfter !== urlBefore) digest.url = { from: urlBefore, to: urlAfter };
  if (errors.length) digest.errors = [...new Set(errors)].slice(0, 5);
  return digest;
}

function sanitizeArgs(args: unknown): unknown {
  try {
    const s = JSON.stringify(args);
    return s.length > 2000 ? { truncated: s.slice(0, 2000) } : args;
  } catch {
    return "[unserializable]";
  }
}
