import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { FsErrorShaped, type ActionDef } from "../pipeline/contracts.ts";
import { getScreencast } from "../daemon/screencast.ts";
import { runVision } from "../vision/sidecar.ts";

type ShootArgs = { path?: string; selector?: string; at?: number; shotsDir: string };
type PageArgs = { budget?: "concise" | "detailed"; scope?: string };
type StateArgs = { selector?: string; full?: boolean; shallow?: boolean };
type LookArgs = { selector?: string; prompt?: string; shotsDir: string };
type RecordArgs = { action?: string; shotsDir: string };

export const observeActions: (ActionDef<ShootArgs> | ActionDef<PageArgs> | ActionDef<StateArgs> | ActionDef<LookArgs> | ActionDef<RecordArgs> | ActionDef<Record<string, never>>)[] = [
  {
    name: "page",
    aliases: ["snapshot"],
    summary: "Semantic page snapshot: route, interactables with refs (T1)",
    target: "none",
    observation: true,
    settle: false,
    async run(ctx, args: PageArgs) {
      return await ctx.runtime("snapshot", { budget: args.budget ?? "concise", scope: args.scope });
    },
  } as ActionDef<PageArgs>,
  {
    name: "shoot",
    aliases: ["screenshot"],
    summary: "Screenshot to shots dir; from the screencast ring when on (T3), else live. --at -Ns recovers a past frame",
    target: "none",
    observation: true,
    settle: false,
    async run(ctx, args: ShootArgs) {
      const ring = getScreencast(ctx.page);
      const t0 = Date.now();
      let source: "ring" | "live";
      let outPath: string;
      let ageSec: number | undefined;

      if (args.at !== undefined) {
        // A past frame can only come from the ring, and it is full-page — a
        // --selector crop is meaningless against history, so it is ignored here.
        const age = Math.abs(args.at);
        const frame = ring?.isOn() ? ring.frameAt(age) : null;
        if (!frame) {
          throw new FsErrorShaped({
            code: "E_BAD_ARGS",
            message: ring?.isOn() ? `no buffered frame near ${age}s ago — the ring has no history yet` : "shoot --at needs the screencast ring running",
            hint: "turn the ring on with `fs profile debug` (or `fs record start`), let a few frames accumulate, then retry",
          });
        }
        outPath = args.path ?? join(args.shotsDir, `shot-at-${age}s-${Date.now()}.jpg`);
        await ensureDir(outPath);
        await writeFile(outPath, frame.buf);
        source = "ring";
        ageSec = Number(frame.ageSec.toFixed(2));
      } else if (args.selector) {
        // Element shots must be live; the ring only holds full-page frames.
        outPath = args.path ?? join(args.shotsDir, `shot-${Date.now()}.png`);
        await ctx.page.locator(args.selector).first().screenshot({ path: outPath });
        source = "live";
      } else if (ring?.isOn() && ring.hasFrame()) {
        outPath = args.path ?? join(args.shotsDir, `shot-${Date.now()}.jpg`);
        await ensureDir(outPath);
        await writeFile(outPath, ring.latestFrame()!);
        source = "ring";
      } else {
        outPath = args.path ?? join(args.shotsDir, `shot-${Date.now()}.png`);
        await ctx.page.screenshot({ path: outPath, fullPage: true });
        source = "live";
      }

      const out: Record<string, unknown> = { path: outPath, source, captureMs: Date.now() - t0 };
      if (ageSec !== undefined) out.at = ageSec;
      return out;
    },
  } as ActionDef<ShootArgs>,
  {
    name: "look",
    summary: "Read the screen with the local vision model; returns TEXT, no image (T4). --prompt to ask, --selector to scope",
    target: "none",
    observation: true,
    settle: false,
    async run(ctx, args: LookArgs) {
      const shot = join(args.shotsDir, `look-${Date.now()}.png`);
      if (args.selector) await ctx.page.locator(args.selector).first().screenshot({ path: shot });
      else await ctx.page.screenshot({ path: shot, fullPage: false });
      const vision = await runVision(shot, args.prompt);
      const out: Record<string, unknown> = { description: vision.description, shot };
      if (args.prompt) out.prompt = args.prompt;
      if (args.selector) out.selector = args.selector;
      if (vision.model) out.model = vision.model;
      if (vision.ms !== undefined) out.visionMs = vision.ms;
      return out;
    },
  } as ActionDef<LookArgs>,
  {
    name: "record",
    summary: "Session video via the screencast ring: `record start` then `record stop` writes frames + manifest (+ webm if ffmpeg) under shots",
    target: "none",
    observation: true,
    settle: false,
    async run(ctx, args: RecordArgs) {
      const ring = getScreencast(ctx.page);
      if (!ring) throw new FsErrorShaped({ code: "E_INTERNAL", message: "screencast controller is not attached to this page" });
      const action = args.action;
      if (action === "start") {
        const dir = join(args.shotsDir, `record-${Date.now()}`);
        try {
          const r = await ring.startRecording(dir);
          return { recording: true, dir: r.dir, startedAt: r.startedAt, note: "run `fs record stop` to finalize" };
        } catch (e) {
          throw new FsErrorShaped({ code: "E_BAD_ARGS", message: String((e as Error).message), hint: "`fs record stop` the current recording first" });
        }
      }
      if (action === "stop") {
        try {
          const r = await ring.stopRecording();
          return { recording: false, ...r };
        } catch (e) {
          throw new FsErrorShaped({ code: "E_BAD_ARGS", message: String((e as Error).message), hint: "nothing to stop — `fs record start` first" });
        }
      }
      throw new FsErrorShaped({ code: "E_BAD_ARGS", message: `record needs start|stop (got ${action ?? "nothing"})`, hint: "usage: `fs record start` … `fs record stop`" });
    },
  } as ActionDef<RecordArgs>,
  {
    name: "state",
    summary: "Fiber state/props/hooks of the nearest stateful ancestors (T2)",
    target: "none",
    observation: true,
    settle: false,
    async run(ctx, args: StateArgs) {
      return await ctx.runtime("state", args.selector, { full: args.full, shallow: args.shallow });
    },
  } as ActionDef<StateArgs>,
  {
    name: "why",
    summary: "Every identity signal for a control (label, what it opens, handler, source) — for unlabeled icons",
    target: "required",
    observation: true,
    settle: false,
    async run(ctx, _args, target) {
      return await ctx.runtime("why", target!.ref);
    },
  } as ActionDef<Record<string, never>>,
];

async function ensureDir(filePath: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true }).catch(() => {});
}
