/** The wire contract between CLI and daemon. FROZEN after WP0 — changes need a
 *  coordinator-approved contract-change note (IMPLEMENTATION.md §5). */

export type ErrorCode =
  | "E_NOT_INITIALIZED"
  | "E_DAEMON_DOWN"
  | "E_RUNTIME_MISSING" // page runtime not injected / wrong generation
  | "E_TARGET_NOT_FOUND"
  | "E_TARGET_AMBIGUOUS" // candidates[] carries the match list
  | "E_TARGET_STALE" // ref from an older document generation
  | "E_NOT_ACTIONABLE" // visible/enabled/stable checks failed within budget
  | "E_WAIT_TIMEOUT" // digest carries what WAS on screen
  | "E_BAD_ARGS"
  | "E_EVAL"
  | "E_NAVIGATION"
  | "E_ADAPTER"
  | "E_INTERNAL";

export type FsError = {
  code: ErrorCode;
  message: string;
  /** Ranked matches when a target was ambiguous or stale — the fix proposal. */
  candidates?: TargetCandidate[];
  /** One-line suggested next action, agent-facing. */
  hint?: string;
};

export type TargetCandidate = {
  ref: string;
  role: string;
  text: string;
  component?: string;
  confidence: number;
};

/** What changed because of the action just run. The T0 telemetry unit. */
export type DigestDelta = {
  url?: { from: string; to: string };
  surfaces?: { opened?: string[]; closed?: string[] };
  focus?: string;
  /** Named collection size changes, e.g. { "table:jobs": [606, 389] }. */
  counts?: Record<string, [number, number]>;
  errors?: string[];
  queries?: "settled" | "pending";
  /** Dead-click signal: an action that changed nothing says so. */
  mutations: "none" | "minor" | "major";
};

export type Request = {
  id: string;
  cmd: string;
  args: Record<string, unknown>;
};

export type Response = {
  id: string;
  ok: boolean;
  data?: unknown;
  error?: FsError;
  digest?: DigestDelta;
  next_steps?: string[];
  /** Document generation the response observed; refs are valid within it. */
  gen?: number;
};

/** Server-push frames (no request id correlation; subscribed via `watch`). */
export type PushEvent =
  | { event: "console"; level: string; body: string; ts: string }
  | { event: "route"; url: string; gen: number; ts: string }
  | { event: "frame"; seq: number; ts: string }
  | { event: "watch"; watchId: string; payload: unknown; ts: string }
  | { event: "progress"; body: string; ts: string };

export type Frame =
  | { kind: "req"; body: Request }
  | { kind: "res"; body: Response }
  | { kind: "push"; body: PushEvent };
