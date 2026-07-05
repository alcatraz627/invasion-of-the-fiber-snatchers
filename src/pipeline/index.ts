/** The one path every verb runs through: resolve → wait → act → settle →
 *  digest → journal. Verbs only implement the act; uniformity of feedback is
 *  the pipeline's job, which is what makes the tool agent-legible. */

import type { Page } from "playwright";
import type { DigestDelta, FsError, TargetCandidate } from "../protocol/types.ts";
import { FsErrorShaped, type ActionDef, type PipelineCtx, type ResolvedTarget, type SettlePolicy, type TargetSpec, type TelemetryProfile } from "./contracts.ts";
import type { Journal } from "./journal.ts";
import { pageStatePayload, waitQueriesIdle, waitSettled } from "./waits.ts";

type DrainResult = {
  mutationWeight: number;
  errors: string[];
  route?: string;
  queriesPending: number;
  /** Absolute current-state reads the digest diffs against a baseline drain. */
  surfaces: string[];
  focus: string | null;
  counts: Record<string, number>;
  /** Cumulative remount count and how many are not yet folded into a digest. */
  remounts: number;
  remountsNew: number;
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
        if (typeof fn !== "function") return fn; // plain properties (docTag, version) read directly
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
      // Refs are e<seq>.<docTag>; a tag mismatch means the ref belongs to a
      // dead document even if a same-named attribute exists after re-minting.
      const currentTag = await runtime<string>("docTag").catch(() => null);
      const refTag = spec.ref.split(".")[1];
      const stale = currentTag !== null && refTag !== undefined && refTag !== currentTag;
      const found = stale ? 0 : await deps.page.locator(`[data-fs-ref="${spec.ref}"]`).count();
      if (found === 0) {
        throw new FsErrorShaped({
          code: "E_TARGET_STALE",
          message: stale
            ? `ref ${spec.ref} belongs to a previous document (current tag ${currentTag})`
            : `ref ${spec.ref} is not in the current document (generation ${gen})`,
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
        const w = node.ownerDocument.defaultView as (Window & { __fs?: { docTag: string } }) | null;
        const tag = w?.__fs?.docTag ?? "untagged";
        let r = node.getAttribute("data-fs-ref");
        if (!r || !r.endsWith(`.${tag}`)) {
          r = `ec${Math.random().toString(36).slice(2, 7)}.${tag}`;
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
      // One weak match is a mismatch, not ambiguity — name why it fell short (a
      // role filter, a partial text match) instead of "1 plausible matches".
      if (candidates.length === 1) {
        const wantRole = spec.kind === "intent" ? spec.role : undefined;
        const why =
          wantRole && top.role !== wantRole
            ? `the closest match is a ${top.role}, not a ${wantRole}`
            : `the only match is low-confidence (${Math.round(top.confidence * 100)}%)`;
        throw new FsErrorShaped({
          code: "E_TARGET_NOT_FOUND",
          message: `no confident target for ${spec.kind === "intent" ? `"${spec.text}"` : spec.expr}: ${why}`,
          candidates,
          hint: `if "${top.text}" is the one you meant, target it directly: --ref ${top.ref}`,
        });
      }
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
        const w = node.ownerDocument.defaultView as (Window & { __fs?: { docTag: string } }) | null;
        const tag = w?.__fs?.docTag ?? "untagged";
        let r = node.getAttribute("data-fs-ref");
        if (!r || !r.endsWith(`.${tag}`)) {
          r = `ec${Math.random().toString(36).slice(2, 7)}.${tag}`;
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

  // Clear the observation buffer so the digest reflects THIS action only. The
  // pre-action drain is also the baseline the settle diff compares surfaces/
  // focus/counts against (it is non-destructive for those absolute reads).
  const preDrain = () => ctx.runtime<DrainResult>("drain").catch(() => null);

  // Optional post-condition + settle overrides ride in on the wire args; they
  // apply to any verb without each ActionDef having to declare them.
  const opts = args as {
    settled?: boolean;
    graceMs?: number;
    timeoutMs?: number;
    settleQuietMs?: number;
    settleTimeoutMs?: number;
  };
  const mutating = !def.observation && def.settle !== false;

  let target: ResolvedTarget | undefined;
  let data: unknown;
  let error: FsError | undefined;
  let baseline: DrainResult | null = null;

  try {
    if (!def.observation) baseline = await preDrain();

    if (def.target && def.target !== "none" && args.target) {
      target = await ctx.resolve(args.target);
    } else if (def.target === "required" && !args.target) {
      throw new FsErrorShaped({ code: "E_BAD_ARGS", message: `${def.name} requires a target` });
    }

    if (def.wait?.settled) await waitQueriesIdle(ctx, def.wait.timeoutMs ?? 5000);

    data = await def.run(ctx, args, target);

    // `--settled` post-condition (mutating verbs only): hold until the app's
    // queries have truly gone quiet, closing the debounce hole where the settle
    // pass below could otherwise read "settled" before a debounced query fires.
    if (opts.settled && mutating) {
      await waitSettled(ctx, { timeoutMs: opts.timeoutMs, graceMs: opts.graceMs });
    }
  } catch (e) {
    error = e instanceof FsErrorShaped ? e.err : mapUnshapedError(e as Error);
  }

  // Settle + digest for mutating verbs; observations skip it (cheap reads) —
  // except under `profile debug`, where a read still emits a single-drain digest
  // so the agent can see what was on screen at read time (WP0-review #21). The
  // verb's declared SettlePolicy is the default; --quiet/--settle-timeout tune it
  // per call without a contract change (both fields are already in SettlePolicy).
  let digest: DigestDelta | undefined;
  if (mutating) {
    const settle = mergeSettle(def.settle || {}, opts);
    digest = await settleAndDigest(ctx, deps, urlBefore, settle, baseline);
  } else if (def.observation && ctx.profile === "debug") {
    digest = await observationDigest(ctx);
  }

  // A wait that timed out reports what WAS on screen (a concise snapshot + a
  // state digest) so the agent re-plans instead of retrying blind. Only when the
  // verb produced no digest of its own — mutating verbs already carry one.
  if (error?.code === "E_WAIT_TIMEOUT" && digest === undefined) {
    const payload = await pageStatePayload(ctx).catch(() => ({} as { data?: unknown; digest?: DigestDelta }));
    if (payload.digest) digest = payload.digest;
    if (data === undefined && payload.data !== undefined) data = payload.data;
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

/** Playwright and DOM errors arrive unshaped; agents branch on codes, so the
 *  common failures must map to their contract codes, first line only. */
function mapUnshapedError(e: Error): FsError {
  const firstLine = String(e.message ?? e).split("\n")[0] ?? "unknown error";
  if (e.name === "TimeoutError" || firstLine.includes("Timeout") && firstLine.includes("exceeded")) {
    return {
      code: "E_NOT_ACTIONABLE",
      message: firstLine,
      hint: "element not visible/enabled/stable within the wait budget; run `fs page` to see current state",
    };
  }
  if (firstLine.includes("not a valid selector") || firstLine.includes("Unexpected token") || firstLine.includes("querySelector")) {
    return { code: "E_BAD_ARGS", message: firstLine, hint: "the CSS selector failed to parse" };
  }
  return { code: "E_INTERNAL", message: firstLine };
}

/** Overlay per-call settle tunables onto the verb's declared SettlePolicy, so an
 *  agent can widen the quiet window / timeout for a slow verb without the tool
 *  hardcoding a budget (`--quiet`, `--settle-timeout`). */
function mergeSettle(base: SettlePolicy, opts: { settleQuietMs?: number; settleTimeoutMs?: number }): SettlePolicy {
  const out: SettlePolicy = { ...base };
  if (typeof opts.settleQuietMs === "number") out.quietMs = opts.settleQuietMs;
  if (typeof opts.settleTimeoutMs === "number") out.timeoutMs = opts.settleTimeoutMs;
  return out;
}

async function settleAndDigest(
  ctx: PipelineCtx,
  deps: PipelineDeps,
  urlBefore: string,
  settle: { quietMs?: number; timeoutMs?: number; queries?: boolean },
  baseline: DrainResult | null
): Promise<DigestDelta> {
  // Drain-first: poll at a short cadence and return as soon as the page has been
  // quiet twice in a row, instead of a fixed pre-sleep. A no-op click settles in
  // ~2 polls (~50ms) instead of the old 150ms+ floor; an active one still loops
  // until genuinely quiet. Two consecutive quiet reads guard against draining
  // before React has committed the re-render (a single early 0 would lie "none").
  const pollMs = settle.quietMs ?? 25;
  const timeoutMs = settle.timeoutMs ?? 3000;
  const deadline = Date.now() + timeoutMs;

  let totalMutations = 0;
  const errors: string[] = [];
  let queriesPending = 0;
  let lastDrain: DrainResult | null = null;
  let consecutiveQuiet = 0;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollMs));
    const d = await ctx.runtime<DrainResult>("drain").catch(() => null);
    if (!d) break; // navigation killed the document mid-settle; do not fabricate below
    lastDrain = d;
    totalMutations += d.mutationWeight;
    errors.push(...d.errors);
    queriesPending = d.queriesPending;
    const quiet = d.mutationWeight === 0 && (settle.queries === false || d.queriesPending === 0);
    consecutiveQuiet = quiet ? consecutiveQuiet + 1 : 0;
    if (consecutiveQuiet >= 2) break;
  }

  const urlAfter = deps.page.url();
  const urlChanged = urlAfter !== urlBefore;
  // A digest with no successful drain is a guess, and must say so: "major" when
  // the url proves a navigation happened, "unknown" otherwise — never "none".
  const digest: DigestDelta = lastDrain
    ? {
        mutations: totalMutations === 0 ? "none" : totalMutations < 20 ? "minor" : "major",
        queries: queriesPending > 0 ? "pending" : "settled",
      }
    : { mutations: urlChanged ? "major" : "unknown" };
  if (urlChanged) digest.url = { from: urlBefore, to: urlAfter };

  // A remount that landed before this action (survives preDrain) shows up as
  // remountsNew on the final drain; fold it in and ack so it isn't re-reported.
  if (lastDrain && lastDrain.remountsNew > 0) {
    errors.push(`hot-reload remount detected (#${lastDrain.remounts})`);
    await ctx.runtime("markRemountsReported").catch(() => null);
  }
  if (errors.length) digest.errors = [...new Set(errors)].slice(0, 5);

  // Surface/focus/count deltas: diff the settled state against the baseline.
  if (baseline && lastDrain) {
    const opened = lastDrain.surfaces.filter((s) => !baseline.surfaces.includes(s));
    const closed = baseline.surfaces.filter((s) => !lastDrain!.surfaces.includes(s));
    if (opened.length || closed.length) {
      digest.surfaces = {};
      if (opened.length) digest.surfaces.opened = opened;
      if (closed.length) digest.surfaces.closed = closed;
    }
    if (lastDrain.focus && lastDrain.focus !== baseline.focus) digest.focus = lastDrain.focus;
    const counts = countDeltas(baseline.counts, lastDrain.counts);
    if (Object.keys(counts).length) digest.counts = counts;
  }
  return digest;
}

/** Collection size changes between two drains: appeared (0→n), vanished (n→0),
 *  and resized (a→b). Keys are shared with the page snapshot's collections. */
function countDeltas(before: Record<string, number>, after: Record<string, number>): Record<string, [number, number]> {
  const out: Record<string, [number, number]> = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const a = before[key] ?? 0;
    const b = after[key] ?? 0;
    if (a !== b) out[key] = [a, b];
  }
  return out;
}

/** #21: observation verbs emit no digest normally; under `profile debug` a single
 *  drain reports what was on screen at read time (mutations may reflect activity
 *  since the last mutating verb — a debug convenience, not a per-action delta). */
async function observationDigest(ctx: PipelineCtx): Promise<DigestDelta | undefined> {
  const d = await ctx.runtime<DrainResult>("drain").catch(() => null);
  if (!d) return undefined;
  const digest: DigestDelta = {
    mutations: d.mutationWeight === 0 ? "none" : d.mutationWeight < 20 ? "minor" : "major",
    queries: d.queriesPending > 0 ? "pending" : "settled",
  };
  if (d.errors.length) digest.errors = [...new Set(d.errors)].slice(0, 5);
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
