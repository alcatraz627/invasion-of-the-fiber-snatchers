/** Rolling screencast ring buffer (telemetry T3). The daemon keeps a short
 *  window of recent frames in memory so `shoot` can answer from RAM instantly
 *  instead of paying a fresh full-page screenshot, and so `shoot --at -3s` can
 *  recover a frame from a moment that has already passed ("did it flicker?").
 *
 *  It is off by default — capture has a memory and CPU cost — and turns on only
 *  under `profile debug` or an active `record`. `profile minimal` force-stops it.
 *
 *  Mechanism: CDP `Page.startScreencast` streams JPEG frames whenever the page
 *  paints. Chrome emits nothing while the page is static, so the freshest frame
 *  is always the current visual. We ACK every frame (Chrome halts the stream
 *  otherwise), keep the very latest for instant `shoot`, and sample the rest at
 *  a target fps into a byte- and time-capped ring for history/`--at`/recording. */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CDPSession, Page } from "playwright";

export type ScreencastOptions = {
  fps: number;         // history sampling rate (latest frame is always kept)
  ringSeconds: number; // how far back `--at` can reach
  maxBytes: number;    // hard memory cap; oldest frames evicted past it
  quality: number;     // JPEG quality 1-100
};

export const SCREENCAST_DEFAULTS: ScreencastOptions = {
  fps: 4,
  ringSeconds: 60,
  maxBytes: 25 * 1024 * 1024,
  quality: 50,
};

export function resolveScreencastOptions(cfg?: Partial<ScreencastOptions>): ScreencastOptions {
  return {
    fps: cfg?.fps && cfg.fps > 0 ? cfg.fps : SCREENCAST_DEFAULTS.fps,
    ringSeconds: cfg?.ringSeconds && cfg.ringSeconds > 0 ? cfg.ringSeconds : SCREENCAST_DEFAULTS.ringSeconds,
    maxBytes: cfg?.maxBytes && cfg.maxBytes > 0 ? cfg.maxBytes : SCREENCAST_DEFAULTS.maxBytes,
    quality: cfg?.quality && cfg.quality > 0 ? cfg.quality : SCREENCAST_DEFAULTS.quality,
  };
}

type RingFrame = { capturedAt: number; buf: Buffer };

type Recording = {
  dir: string;
  startedAt: number;
  seq: number;
  frames: Array<{ seq: number; atMs: number; file: string }>;
  writes: Promise<unknown>;
};

/** One page, one controller. Stored on a WeakMap so verbs (observe.ts) can reach
 *  the ring without threading it through the frozen PipelineCtx. */
const controllers = new WeakMap<Page, ScreencastController>();

export function attachScreencast(page: Page, opts: ScreencastOptions): ScreencastController {
  const c = new ScreencastController(page, opts);
  controllers.set(page, c);
  return c;
}

export function getScreencast(page: Page): ScreencastController | undefined {
  return controllers.get(page);
}

export class ScreencastController {
  private cdp: CDPSession | null = null;
  private on = false;
  private ring: RingFrame[] = [];
  private ringBytes = 0;
  private latest: RingFrame | null = null;
  private lastSampledAt = 0;
  private recording: Recording | null = null;

  constructor(private page: Page, private opts: ScreencastOptions) {}

  isOn(): boolean {
    return this.on;
  }

  hasFrame(): boolean {
    return this.latest !== null;
  }

  /** Begin (or re-issue) the frame stream. Idempotent: calling it again while
   *  live just re-arms the CDP screencast (needed after a full navigation). */
  async start(): Promise<void> {
    if (!this.cdp) {
      this.cdp = await this.page.context().newCDPSession(this.page);
      this.cdp.on("Page.screencastFrame", (f) => void this.onFrame(f));
    }
    await this.cdp
      .send("Page.startScreencast", { format: "jpeg", quality: this.opts.quality, everyNthFrame: 1 })
      .catch(() => {});
    this.on = true;
  }

  /** Re-arm after a navigation swapped the document; no-op when off. Chrome can
   *  pause the stream across a cross-document nav, so we nudge it back on. */
  async onNavigated(): Promise<void> {
    if (this.on && this.cdp) {
      await this.cdp.send("Page.startScreencast", { format: "jpeg", quality: this.opts.quality, everyNthFrame: 1 }).catch(() => {});
    }
  }

  /** Stop capture and free the ring. Any in-flight recording is finalized first
   *  so it is not lost. Falls back to live screenshots once off. */
  async stop(): Promise<void> {
    if (this.recording) await this.stopRecording().catch(() => {});
    if (this.cdp && this.on) await this.cdp.send("Page.stopScreencast").catch(() => {});
    this.on = false;
    this.ring = [];
    this.ringBytes = 0;
    this.latest = null;
    this.lastSampledAt = 0;
  }

  /** The freshest frame, PNG-or-JPEG bytes as captured. Null when the ring is
   *  off or no frame has arrived yet (caller falls back to a live screenshot). */
  latestFrame(): Buffer | null {
    return this.latest?.buf ?? null;
  }

  /** The sampled frame nearest `ageSeconds` in the past. Returns the buffer and
   *  the frame's true age so the caller can report how close it landed. */
  frameAt(ageSeconds: number): { buf: Buffer; ageSec: number } | null {
    const pool = this.ring.length ? this.ring : this.latest ? [this.latest] : [];
    if (!pool.length) return null;
    const target = Date.now() - ageSeconds * 1000;
    let best = pool[0]!;
    let bestDelta = Math.abs(best.capturedAt - target);
    for (const fr of pool) {
      const d = Math.abs(fr.capturedAt - target);
      if (d < bestDelta) {
        best = fr;
        bestDelta = d;
      }
    }
    return { buf: best.buf, ageSec: (Date.now() - best.capturedAt) / 1000 };
  }

  stats(): { on: boolean; frames: number; bytes: number; spanSec: number; recording: boolean } {
    const span = this.ring.length >= 2 ? (this.ring[this.ring.length - 1]!.capturedAt - this.ring[0]!.capturedAt) / 1000 : 0;
    return { on: this.on, frames: this.ring.length, bytes: this.ringBytes, spanSec: span, recording: this.recording !== null };
  }

  isRecording(): boolean {
    return this.recording !== null;
  }

  /** Begin streaming sampled frames to disk. Recording is disk-backed (frames
   *  are written as they arrive) so a long session does not grow memory beyond
   *  the ring. Turns the ring on if it was off. */
  async startRecording(dir: string): Promise<{ dir: string; startedAt: number }> {
    if (this.recording) throw new Error(`already recording since ${new Date(this.recording.startedAt).toISOString()} (${this.recording.dir})`);
    if (!this.on) await this.start();
    await mkdir(dir, { recursive: true });
    this.recording = { dir, startedAt: Date.now(), seq: 0, frames: [], writes: Promise.resolve() };
    return { dir, startedAt: this.recording.startedAt };
  }

  /** Finalize the recording: flush pending writes, write manifest.json, and — if
   *  ffmpeg is on PATH — stitch a webm. Frames + manifest are always produced so
   *  the artifact is useful without ffmpeg. */
  async stopRecording(): Promise<{ dir: string; frames: number; durationMs: number; manifest: string; webm?: string }> {
    const rec = this.recording;
    if (!rec) throw new Error("no active recording");
    this.recording = null;
    await rec.writes.catch(() => {});
    const stoppedAt = Date.now();
    const manifest = {
      startedAt: rec.startedAt,
      stoppedAt,
      durationMs: stoppedAt - rec.startedAt,
      fps: this.opts.fps,
      frameCount: rec.frames.length,
      note: "frames are captured on page-paint at up to fps; timing is per-frame atMs, not constant-rate",
      frames: rec.frames,
    };
    const manifestPath = join(rec.dir, "manifest.json");
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
    const webm = await this.maybeStitchWebm(rec).catch(() => undefined);
    return { dir: rec.dir, frames: rec.frames.length, durationMs: manifest.durationMs, manifest: manifestPath, webm };
  }

  private async maybeStitchWebm(rec: Recording): Promise<string | undefined> {
    if (!rec.frames.length) return undefined;
    const ffmpeg = Bun.which("ffmpeg");
    if (!ffmpeg) return undefined;
    const out = join(rec.dir, "recording.webm");
    // Constant-rate stitch at the sample fps — a scrub aid, not frame-accurate
    // timing (paints are irregular). manifest.json carries the true per-frame ms.
    const proc = Bun.spawn(
      [ffmpeg, "-y", "-framerate", String(this.opts.fps), "-pattern_type", "glob", "-i", join(rec.dir, "frame-*.jpg"), "-c:v", "libvpx-vp9", "-pix_fmt", "yuv420p", out],
      { stdout: "ignore", stderr: "ignore" }
    );
    const code = await proc.exited;
    return code === 0 ? out : undefined;
  }

  private async onFrame(f: { data: string; sessionId: number }): Promise<void> {
    // ACK first and unconditionally — Chrome stops the stream if a frame is
    // never acked, so this must never be gated behind the throttle below.
    if (this.cdp) await this.cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
    if (!this.on) return;
    const now = Date.now();
    const buf = Buffer.from(f.data, "base64");
    // The very latest frame is always kept so `shoot` reflects the true current
    // visual even between sample points.
    this.latest = { capturedAt: now, buf };
    // History is sampled at the target fps to bound the ring; skip if we sampled
    // too recently.
    const minGap = 1000 / this.opts.fps;
    if (now - this.lastSampledAt < minGap) return;
    this.lastSampledAt = now;
    this.pushRing({ capturedAt: now, buf });
    if (this.recording) this.captureForRecording(buf, now);
  }

  private pushRing(fr: RingFrame): void {
    this.ring.push(fr);
    this.ringBytes += fr.buf.byteLength;
    const cutoff = Date.now() - this.opts.ringSeconds * 1000;
    while (this.ring.length && (this.ringBytes > this.opts.maxBytes || this.ring[0]!.capturedAt < cutoff)) {
      const dropped = this.ring.shift()!;
      this.ringBytes -= dropped.buf.byteLength;
    }
  }

  private captureForRecording(buf: Buffer, atMs: number): void {
    const rec = this.recording!;
    const seq = rec.seq++;
    const file = `frame-${String(seq).padStart(5, "0")}.jpg`;
    rec.frames.push({ seq, atMs: atMs - rec.startedAt, file });
    // Chain writes so they cannot interleave/backpressure the frame handler.
    rec.writes = rec.writes.then(() => writeFile(join(rec.dir, file), buf)).catch(() => {});
  }
}
