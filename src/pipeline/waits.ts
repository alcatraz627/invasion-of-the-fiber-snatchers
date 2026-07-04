/** The wait stage: bounded conditions an agent can wait on before it gives up
 *  and re-plans. A generic driver can `waitFor(css)`; only fiber-snatcher can
 *  wait for TanStack queries to actually settle — including through an app's
 *  debounce window, where a naive "is anything fetching right now?" read lies
 *  (the query hasn't fired yet). Every wait is time-boxed; a timeout is a shaped
 *  E_WAIT_TIMEOUT so the caller branches on the code and reads the page state the
 *  pipeline attaches, rather than parsing a message. */

import type { DigestDelta } from "../protocol/types.ts";
import { FsErrorShaped, type PipelineCtx, type TargetSpec } from "./contracts.ts";

export const DEFAULT_WAIT_TIMEOUT_MS = 5000;
/** How long the page must stay query-quiet before `--settled` concludes nothing
 *  more will fire. Must exceed the app's debounce window, or the wait can read
 *  "settled" in the gap before a debounced query starts — tune up per app. */
export const DEFAULT_SETTLE_GRACE_MS = 400;
const POLL_MS = 50;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type QueriesActivity = { pending: number; started: number };

export type WaitTimeoutOpts = { timeoutMs?: number };
export type SettledOpts = { timeoutMs?: number; graceMs?: number };

function describeSpec(spec: TargetSpec): string {
  switch (spec.kind) {
    case "ref": return spec.ref;
    case "css": return spec.selector;
    case "component": return spec.expr;
    case "intent": return `"${spec.text}"`;
  }
}

/** The shaped timeout every wait throws. Page state (a concise snapshot + a
 *  state digest) is attached by the pipeline, not here — this stays free of
 *  snapshot logic so the vocabulary reads cleanly. */
function waitTimeout(message: string, hint: string): FsErrorShaped {
  return new FsErrorShaped({ code: "E_WAIT_TIMEOUT", message, hint });
}

/** Simple pre-act idle wait: block until no query is fetching, bounded. This is
 *  the `WaitPolicy.settled` pre-condition (act only once queries are quiet); it
 *  does NOT close the debounce hole — use `waitSettled` for the post-act flag. */
export async function waitQueriesIdle(ctx: PipelineCtx, timeoutMs = DEFAULT_WAIT_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pending = await ctx.runtime<number>("queriesPending").catch(() => 0);
    if (pending === 0) return;
    await sleep(POLL_MS);
  }
  throw waitTimeout(
    `queries still fetching after ${timeoutMs}ms`,
    "the app may be polling; raise --timeout <ms> to wait longer, or run `fs page` to see current state"
  );
}

/** Debounce-aware settle: the framework signal a generic tool can't produce.
 *
 *  "Settled" = no query is fetching AND none has started for a quiet grace. The
 *  grace is why this beats a bare idle read: right after a `fill`, the app's
 *  debounce timer has not fired yet, so pending is 0 and a naive read reports
 *  "settled" — then the query starts a beat later. Here, a query that starts at
 *  any point (even one that begins and ends inside a single poll gap, caught via
 *  the monotonic `started` counter) resets the quiet timer, so the wait only
 *  returns once the page has been genuinely query-quiet for `graceMs`.
 *
 *  A polling app never goes quiet for the grace and correctly hits the timeout. */
export async function waitSettled(ctx: PipelineCtx, opts?: SettledOpts): Promise<void> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  const graceMs = opts?.graceMs ?? DEFAULT_SETTLE_GRACE_MS;
  const deadline = Date.now() + timeoutMs;

  const base = await ctx.runtime<QueriesActivity>("queriesActivity").catch(() => ({ pending: 0, started: 0 }));
  let seenStarted = base.started;
  // Grace is measured from entry, i.e. from the moment after the act. A debounce
  // shorter than graceMs fires inside this window and resets lastActivity below.
  let lastActivity = Date.now();

  while (Date.now() < deadline) {
    const a = await ctx.runtime<QueriesActivity>("queriesActivity").catch(() => null);
    if (a) {
      if (a.started > seenStarted || a.pending > 0) {
        lastActivity = Date.now();
        seenStarted = Math.max(seenStarted, a.started);
      }
      if (a.pending === 0 && Date.now() - lastActivity >= graceMs) return;
    }
    await sleep(POLL_MS);
  }
  throw waitTimeout(
    `queries did not settle within ${timeoutMs}ms`,
    "the app may be polling; raise --timeout <ms>, --grace <ms> if its debounce is long, or `fs page` to inspect"
  );
}

/** Wait until a target is present, visible, and actionable (enabled). Refs and
 *  CSS use Playwright's own visibility polling; intent/component poll the runtime
 *  resolver until a confident (hence visible) candidate appears. */
export async function waitForTarget(ctx: PipelineCtx, spec: TargetSpec, opts?: WaitTimeoutOpts): Promise<void> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;

  if (spec.kind === "css" || spec.kind === "ref") {
    const sel = spec.kind === "ref" ? `[data-fs-ref="${spec.ref}"]` : spec.selector;
    const loc = spec.kind === "css" && spec.nth !== undefined ? ctx.page.locator(sel).nth(spec.nth) : ctx.page.locator(sel).first();
    try {
      await loc.waitFor({ state: "visible", timeout: timeoutMs });
    } catch {
      throw waitTimeout(
        `no visible element for ${describeSpec(spec)} within ${timeoutMs}ms`,
        "run `fs page` to see what is interactable right now"
      );
    }
    while (Date.now() < deadline) {
      if (await loc.isEnabled().catch(() => true)) return;
      await sleep(POLL_MS);
    }
    return; // visible but never enabled — resolve anyway; an action's own actionability check is authoritative
  }

  // intent / component: a confident candidate means present + visible (the
  // resolver penalizes hidden matches below the confidence gate).
  while (Date.now() < deadline) {
    const cands = await ctx.candidatesFor(spec).catch(() => []);
    const top = cands[0];
    if (top && top.confidence >= 0.85) return;
    await sleep(POLL_MS);
  }
  throw waitTimeout(
    `nothing actionable matched ${describeSpec(spec)} within ${timeoutMs}ms`,
    "run `fs page` to see what is interactable right now"
  );
}

/** Wait until a target has left the DOM or become hidden — the verified inverse
 *  of waitForTarget (a modal that closed, a spinner that vanished). */
export async function waitForGone(ctx: PipelineCtx, spec: TargetSpec, opts?: WaitTimeoutOpts): Promise<void> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;

  if (spec.kind === "css" || spec.kind === "ref") {
    const sel = spec.kind === "ref" ? `[data-fs-ref="${spec.ref}"]` : spec.selector;
    try {
      // "hidden" resolves on detached OR not-visible, and immediately if already absent.
      await ctx.page.locator(sel).first().waitFor({ state: "hidden", timeout: timeoutMs });
    } catch {
      throw waitTimeout(
        `${describeSpec(spec)} was still present after ${timeoutMs}ms`,
        "the element did not close/hide; `fs page` shows what is still on screen"
      );
    }
    return;
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const cands = await ctx.candidatesFor(spec).catch(() => []);
    const top = cands[0];
    if (!top || top.confidence < 0.85) return; // no confident visible match left
    await sleep(POLL_MS);
  }
  throw waitTimeout(
    `${describeSpec(spec)} was still present after ${timeoutMs}ms`,
    "the element did not close/hide; `fs page` shows what is still on screen"
  );
}

/** Wait until the given text is present anywhere in the visible page text. */
export async function waitForText(ctx: PipelineCtx, text: string, opts?: WaitTimeoutOpts): Promise<void> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  try {
    await ctx.page.waitForFunction((t) => (document.body?.innerText ?? "").includes(t), text, { timeout: timeoutMs, polling: 100 });
  } catch {
    throw waitTimeout(
      `text "${text}" did not appear within ${timeoutMs}ms`,
      "run `fs page` to see the current page text"
    );
  }
}

/** Wait until the URL matches a substring, or a `/regex/flags` pattern. Reads
 *  `location.href` live so soft navigations (pushState/replaceState) count. */
export async function waitForUrl(ctx: PipelineCtx, pattern: string, opts?: WaitTimeoutOpts): Promise<void> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const re = toRegex(pattern);
  while (Date.now() < deadline) {
    const href = await ctx.page.evaluate(() => location.href).catch(() => ctx.page.url());
    if (re ? re.test(href) : href.includes(pattern)) return;
    await sleep(POLL_MS);
  }
  throw waitTimeout(
    `URL did not match ${pattern} within ${timeoutMs}ms`,
    "run `fs page` to see the current route"
  );
}

/** A `/pattern/flags` string becomes a RegExp; anything else stays a substring. */
function toRegex(pattern: string): RegExp | null {
  const m = pattern.match(/^\/(.*)\/([a-z]*)$/);
  if (!m || m[1] === undefined) return null;
  try {
    return new RegExp(m[1], m[2]);
  } catch {
    return null;
  }
}

/** Wait until the browser reports no in-flight network for 500ms (Playwright's
 *  networkidle). Coarser than `--settled`; use when the signal is HTTP, not the
 *  framework's query state. */
export async function waitForNetworkIdle(ctx: PipelineCtx, opts?: WaitTimeoutOpts): Promise<void> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  try {
    await ctx.page.waitForLoadState("networkidle", { timeout: timeoutMs });
  } catch {
    throw waitTimeout(
      `network did not go idle within ${timeoutMs}ms`,
      "the app may hold long-lived connections; try `--settled` (query state) or raise --timeout"
    );
  }
}

/** What WAS on screen when a wait timed out, so the agent re-plans instead of
 *  retrying blind: a concise snapshot as `data`, plus a one-line state digest.
 *  Uses non-destructive reads (snapshot + queriesActivity) so it never disturbs
 *  the observation buffer. */
export async function pageStatePayload(ctx: PipelineCtx): Promise<{ data?: unknown; digest?: DigestDelta }> {
  const snap = await ctx.runtime<{ surfaces?: string[] }>("snapshot", { budget: "concise" }).catch(() => undefined);
  const act = await ctx.runtime<QueriesActivity>("queriesActivity").catch(() => ({ pending: 0, started: 0 }));
  const digest: DigestDelta = { mutations: "none", queries: act.pending > 0 ? "pending" : "settled" };
  if (snap?.surfaces?.length) digest.surfaces = { opened: snap.surfaces };
  return { data: snap, digest };
}
