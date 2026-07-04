/** WP5 acceptance: telemetry extras. Drives the real CLI -> daemon -> fixture.
 *  The load-bearing claims:
 *   - `shoot` answers from the screencast ring when it is on (warm, <50ms) and
 *     falls back to a live screenshot when off;
 *   - `shoot --at -Ns` recovers a DISTINCT earlier frame;
 *   - telemetry profiles change the T0 emit observably (minimal trims, verify
 *     fails on console errors, explore annotates a navigation);
 *   - `look` returns TEXT with no image in the tool result, and fails with a
 *     self-describing error when the `see` CLI is absent;
 *   - `record start/stop` writes frames + a manifest.
 *  `see`-dependent assertions are skipped when the CLI is not installed so the
 *  suite stays green on a machine without the local vision kit. */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { startTarget, type Target } from "./harness.ts";
import { runVision } from "../../src/vision/sidecar.ts";

let t: Target;
const hasSee = !!Bun.which("see");

/** next_steps is on the Response envelope but not the harness's Envelope type. */
function nextSteps(res: unknown): string[] | undefined {
  return (res as { next_steps?: string[] }).next_steps;
}

beforeAll(async () => {
  t = await startTarget();
  const info = await t.fs("info");
  expect(info.ok).toBe(true);
  await t.fs("wait", "--settled");
}, 45_000);

afterAll(async () => {
  await t.stop();
});

describe("WP5 telemetry extras", () => {
  test("shoot falls back to a live screenshot when the ring is off", async () => {
    const res = await t.fs("shoot");
    expect(res.ok).toBe(true);
    expect(res.data.source).toBe("live");
    expect(typeof res.data.path).toBe("string");
    expect(existsSync(res.data.path)).toBe(true);
    expect(statSync(res.data.path).size).toBeGreaterThan(0);
    expect(typeof res.data.captureMs).toBe("number");
  }, 30_000);

  test("profile debug turns the ring on; info and profile report it", async () => {
    const p = await t.fs("profile", "debug");
    expect(p.ok).toBe(true);
    expect(p.data.profile).toBe("debug");
    expect(p.data.screencast.on).toBe(true);
    const info = await t.fs("info");
    expect(info.data.screencast.on).toBe(true);
  }, 20_000);

  test("shoot serves from the ring when on, warm capture < 50ms", async () => {
    // Two paints so the ring holds a fresh frame (Chrome only emits on change).
    await t.fs("click", "--css", "#failed-toggle");
    await t.fs("click", "--css", "#failed-toggle");
    const res = await t.fs("shoot");
    expect(res.ok).toBe(true);
    expect(res.data.source).toBe("ring");
    expect(existsSync(res.data.path)).toBe(true);
    expect(res.data.captureMs).toBeLessThan(50);
  }, 30_000);

  test("shoot --at recovers a distinct earlier frame", async () => {
    // Build ~1.5s+ of visual history; the toggle flips its label each click so
    // consecutive frames differ byte-for-byte.
    await t.fs("click", "--css", "#failed-toggle");
    await t.fs("click", "--css", "#failed-toggle");
    await t.fs("click", "--css", "#failed-toggle");
    const latest = await t.fs("shoot");
    const past = await t.fs("shoot", "--at", "-1");
    expect(past.ok).toBe(true);
    expect(past.data.source).toBe("ring");
    expect(typeof past.data.at).toBe("number");
    expect(past.data.at).toBeGreaterThan(0.3); // genuinely in the past
    const a = readFileSync(latest.data.path);
    const b = readFileSync(past.data.path);
    expect(Buffer.compare(a, b)).not.toBe(0); // a different moment
  }, 30_000);

  test("shoot --at errors self-describingly when there is no ring history", async () => {
    await t.fs("profile", "minimal"); // stops the ring, clears history
    const res = await t.fs("shoot", "--at", "-2");
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe("E_BAD_ARGS");
    expect(res.error.hint).toMatch(/profile debug|record/);
  }, 20_000);

  test("profile minimal emits a terse digest (mutations + errors only) and stops the ring", async () => {
    const p = await t.fs("profile", "minimal");
    expect(p.data.profile).toBe("minimal");
    expect(p.data.screencast.on).toBe(false);
    const open = await t.fs("click", "Open Preview");
    expect(open.ok).toBe(true);
    expect(open.digest).toBeDefined();
    expect(open.digest!.mutations).toBeDefined();
    // Everything past the dead-click signal is stripped under minimal.
    expect(open.digest!.surfaces).toBeUndefined();
    expect(open.digest!.counts).toBeUndefined();
    expect(open.digest!.focus).toBeUndefined();
    expect(open.digest!.queries).toBeUndefined();
    await t.fs("click", "Close"); // cleanup: unique label in the modal
  }, 30_000);

  test("profile explore annotates a navigation with the interactable count", async () => {
    await t.fs("profile", "explore");
    const res = await t.fs("navigate", t.url);
    expect(res.ok).toBe(true);
    const steps = nextSteps(res);
    expect(Array.isArray(steps)).toBe(true);
    expect(steps!.join(" ")).toMatch(/interactables/);
  }, 30_000);

  test("profile verify fails an action that logs a console error", async () => {
    await t.fs("profile", "verify");
    // Make the next click emit a console error, captured by its settle drain.
    // eval wraps `return (<code>)`, so this must be one expression, not statements.
    const added = await t.fs("eval", "document.addEventListener('click', window.__vt = () => console.error('verify-test-boom'), true)");
    expect(added.ok).toBe(true);
    const res = await t.fs("click", "--css", "#failed-toggle");
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe("E_INTERNAL");
    expect(res.error.message).toMatch(/verify/i);
    expect((res.digest!.errors ?? []).join(" ")).toMatch(/verify-test-boom/);
    await t.fs("eval", "document.removeEventListener('click', window.__vt, true)");
    await t.fs("profile", "explore");
  }, 30_000);

  test("look reports a self-describing error when the `see` CLI is absent", async () => {
    // Unit-level: force `see` unresolvable via PATH, independent of the daemon.
    const savedPath = process.env.PATH;
    process.env.PATH = "/nonexistent-dir-for-fs-wp5-test";
    let threw = false;
    try {
      await runVision("/tmp/irrelevant.png");
    } catch (e) {
      threw = true;
      const err = (e as { err?: { code?: string; message?: string; hint?: string } }).err;
      expect(err?.code).toBe("E_INTERNAL");
      expect(String(err?.message)).toMatch(/see/);
      expect(String(err?.hint)).toMatch(/see|install/i);
    } finally {
      process.env.PATH = savedPath;
    }
    expect(threw).toBe(true);
  });

  test.skipIf(!hasSee)("look returns a text description with no image in the tool result (T4)", async () => {
    await t.fs("profile", "explore");
    const res = await t.fs("look", "--prompt", "reply with the single word READY");
    expect(res.ok).toBe(true);
    expect(typeof res.data.description).toBe("string");
    expect(res.data.description.length).toBeGreaterThan(0);
    // The pixels stay local: the tool result carries text, never a base64 image.
    const serialized = JSON.stringify(res);
    expect(serialized.length).toBeLessThan(8000);
    expect(serialized).not.toMatch(/data:image|iVBORw0KGgo/); // png/data-uri signatures
    expect(existsSync(res.data.shot)).toBe(true);
  }, 120_000);

  test("record start/stop writes frames + a manifest under the shots dir", async () => {
    await t.fs("profile", "debug"); // ring on for a recording
    const start = await t.fs("record", "start");
    expect(start.ok).toBe(true);
    expect(start.data.recording).toBe(true);
    expect(typeof start.data.dir).toBe("string");

    await t.fs("click", "--css", "#failed-toggle");
    await t.fs("click", "--css", "#failed-toggle");
    await t.fs("click", "--css", "#failed-toggle");

    const stop = await t.fs("record", "stop");
    expect(stop.ok).toBe(true);
    expect(stop.data.recording).toBe(false);
    expect(stop.data.frames).toBeGreaterThan(0);
    expect(existsSync(stop.data.manifest)).toBe(true);
    const manifest = JSON.parse(readFileSync(stop.data.manifest, "utf8"));
    expect(manifest.frameCount).toBe(stop.data.frames);
    expect(Array.isArray(manifest.frames)).toBe(true);
    // A frame file named in the manifest exists on disk.
    expect(existsSync(`${stop.data.dir}/${manifest.frames[0].file}`)).toBe(true);

    const again = await t.fs("record", "stop");
    expect(again.ok).toBe(false);
    expect(again.error.code).toBe("E_BAD_ARGS");
  }, 40_000);
});
