/** Pipeline-facing contracts. FROZEN after WP0 alongside protocol/types.ts.
 *  Every verb runs: resolve → wait → act → settle → digest → journal. */

import type { Page } from "playwright";
import type { DigestDelta, FsError, TargetCandidate } from "../protocol/types.ts";

export type TargetSpec =
  | { kind: "ref"; ref: string }
  | { kind: "intent"; text: string; role?: string }
  | { kind: "component"; expr: string } // e.g. JobRow[title~="JEGS"]
  | { kind: "css"; selector: string; nth?: number };

export type ResolvedTarget = {
  spec: TargetSpec;
  ref: string;
  gen: number; // document generation the ref belongs to
  role: string;
  text: string;
  component?: string;
};

export type WaitPolicy = {
  /** Playwright actionability applies to element actions automatically. */
  timeoutMs?: number; // default 5000
  /** Extra pre-act condition, e.g. { settled: true } for query-idle first. */
  settled?: boolean;
};

export type SettlePolicy = {
  /** After acting: wait for DOM mutations to quiet + queries idle, bounded. */
  quietMs?: number; // default 150
  timeoutMs?: number; // default 3000
  queries?: boolean; // default true when a tanstack adapter is live
};

export type TelemetryProfile = "explore" | "debug" | "verify" | "minimal";

export type PipelineCtx = {
  page: Page;
  gen: () => number;
  profile: TelemetryProfile;
  resolve: (spec: TargetSpec) => Promise<ResolvedTarget>;
  /** Throws FsErrorShaped on ambiguity with candidates attached. */
  candidatesFor: (spec: TargetSpec, limit?: number) => Promise<TargetCandidate[]>;
  runtime: <T>(method: string, ...args: unknown[]) => Promise<T>; // window.__fs bridge
  log: (body: string) => void;
};

/** One verb. `run` does ONLY the act; resolution, waits, settle, digest, and
 *  journaling are the pipeline's job, so verbs stay tiny and uniform. */
export type ActionDef<A = Record<string, unknown>> = {
  name: string;
  aliases?: string[];
  summary: string; // one line, agent-facing help
  target?: "required" | "optional" | "none";
  wait?: WaitPolicy;
  settle?: SettlePolicy | false; // false = observation-only verb, no settle pass
  /** Digest suppressed for pure reads (state/page/shoot) unless profile=debug. */
  observation?: boolean;
  run: (ctx: PipelineCtx, args: A, target?: ResolvedTarget) => Promise<unknown>;
};

export type JournalEntry = {
  ts: string;
  run: string; // run id, one per daemon boot (or per session command)
  seq: number;
  cmd: string;
  args: unknown;
  target?: Pick<ResolvedTarget, "ref" | "role" | "text" | "component">;
  ok: boolean;
  error?: FsError["code"];
  digest?: DigestDelta;
  frame?: string; // screenshot/frame path when captured
  durMs: number;
};

export class FsErrorShaped extends Error {
  constructor(public err: FsError) {
    super(err.message);
  }
}
