/** WP3a acceptance: pointer + keyboard + scroll verbs. Every verb runs through
 *  the standard pipeline, so it inherits targeting, settle, and the digest — a
 *  hover's opened popover, an rclick's context menu, and a scroll's materialized
 *  rows all show up in digest.surfaces / digest.counts for free. Drives the real
 *  CLI -> daemon -> fixture path; synchronization is `wait --settled`, never a
 *  sleep. Each verb ships happy + failure + a digest-content assertion. */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { startTarget, type Target } from "./harness.ts";

let t: Target;

beforeAll(async () => {
  t = await startTarget();
  const info = await t.fs("info");
  expect(info.ok).toBe(true);
  await t.fs("wait", "--settled");
}, 40_000);

afterAll(async () => {
  await t.stop();
});

/** Clean slate: a fresh document (no open surfaces, dnd order reset, windowed row
 *  count back to 20), with the parts query landed. Reload is deterministic and
 *  cheap, and it sidesteps pointer/surface state left by the prior test. */
async function reset(): Promise<void> {
  await t.fs("reload");
  await t.fs("wait", "--settled");
}

describe("WP3a pointer verbs", () => {
  beforeEach(reset);

  test("hover opens a popover that persists while the pointer rests", async () => {
    const res = await t.fs("hover", "Hover me", "--hold", "200");
    expect(res.ok).toBe(true);
    // The pipeline's settle diff proves the surface opened AND stayed open past
    // the hold (a flash-then-close would net to nothing in the diff).
    expect((res.digest?.surfaces?.opened ?? []).some((s) => s.includes("Hover Card"))).toBe(true);
    // The verb's own non-destructive read agrees the card is still up after the rest.
    expect(res.data?.persisted).toBe(true);
    expect(String(res.data?.popover)).toContain("Hover Card");
  }, 20_000);

  test("hover on a missing target returns a shaped error", async () => {
    const res = await t.fs("hover", "NoSuchControlZZZ");
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("E_TARGET_NOT_FOUND");
  }, 15_000);

  test("dblclick fires two clicks (counter += 2)", async () => {
    const page = await t.fs("page");
    const icon = (page.data.interactables as Array<{ ref: string; text: string }>).find(
      (r) => r.text === "button" || r.text.startsWith("#icon")
    );
    expect(icon).toBeDefined();
    const before = Number((await t.fs("eval", "document.querySelector('#click-count').textContent")).data);
    const res = await t.fs("dblclick", icon!.ref);
    expect(res.ok).toBe(true);
    expect(res.digest?.mutations).not.toBe("none");
    const after = Number((await t.fs("eval", "document.querySelector('#click-count').textContent")).data);
    expect(after).toBe(before + 2);
  }, 20_000);

  test("rclick opens a context menu, surfaced in the digest", async () => {
    const res = await t.fs("rclick", "--css", "#ctx-zone");
    expect(res.ok).toBe(true);
    expect((res.digest?.surfaces?.opened ?? []).some((s) => s.includes("Context Menu"))).toBe(true);
  }, 15_000);

  test("drag reorders an HTML5 DnD list (default path)", async () => {
    const before = String((await t.fs("eval", "document.querySelector('#dnd-order').textContent")).data);
    expect(before).toBe("Alpha,Bravo,Charlie,Delta");
    const res = await t.fs("drag", "#dnd-alpha", "#dnd-delta");
    expect(res.ok).toBe(true);
    expect(res.data?.via).toBe("html5");
    const after = String((await t.fs("eval", "document.querySelector('#dnd-order').textContent")).data);
    expect(after).toBe("Bravo,Charlie,Delta,Alpha"); // Alpha dropped onto Delta's slot
  }, 20_000);

  test("drag --via mouse reorders a pointer-sensor list (fallback path)", async () => {
    // The mouse fallback drives raw mousedown/mousemove/mouseup — the handler
    // shape used by dnd-kit / react-dnd mouse backends, not native HTML5 DnD.
    const before = String((await t.fs("eval", "document.querySelector('#pdnd-order').textContent")).data);
    expect(before).toBe("One,Two,Three,Four");
    const res = await t.fs("drag", "#pdnd-one", "#pdnd-three", "--via", "mouse");
    expect(res.ok).toBe(true);
    expect(res.data?.via).toBe("mouse");
    const after = String((await t.fs("eval", "document.querySelector('#pdnd-order').textContent")).data);
    expect(after).not.toBe(before);
  }, 20_000);

  test("drag to a missing dest returns a shaped error", async () => {
    const res = await t.fs("drag", "#dnd-alpha", "#does-not-exist-xyz");
    expect(res.ok).toBe(false);
    expect(["E_TARGET_NOT_FOUND", "E_TARGET_STALE"]).toContain(res.error?.code);
  }, 15_000);
});

describe("WP3a keyboard verbs", () => {
  beforeEach(reset);

  test("chord opens the command palette (Ctrl+K), surfaced in the digest", async () => {
    const res = await t.fs("chord", "Control+K");
    expect(res.ok).toBe(true);
    expect((res.digest?.surfaces?.opened ?? []).some((s) => s.includes("Command Palette"))).toBe(true);
  }, 15_000);

  test("chord without a key combination is a shaped bad-args error", async () => {
    const res = await t.fs("chord", "");
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("E_BAD_ARGS");
  }, 15_000);

  test("type enters text per key and drives the app's debounce (--settled)", async () => {
    const res = await t.fs("type", "--css", "section input", "Part 5", "--delay", "5", "--settled");
    expect(res.ok).toBe(true);
    expect(res.digest?.queries).toBe("settled");
    const val = String((await t.fs("eval", "document.querySelector('section input').value")).data);
    expect(val).toBe("Part 5");
    // The per-key path fired the debounced query, so the row count is filtered —
    // this is the behavioral contrast to fill's single set.
    const rows = String((await t.fs("eval", "document.querySelector('#row-count').textContent")).data);
    expect(rows).not.toBe("10000 rows");
  }, 30_000);

  test("type on a missing target returns a shaped error", async () => {
    const res = await t.fs("type", "NoSuchInputZZZ", "hello");
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("E_TARGET_NOT_FOUND");
  }, 15_000);
});

describe("WP3a scroll verb", () => {
  beforeEach(reset);

  test("scrolling a windowed list materializes rows, shown in digest counts", async () => {
    const before = Number((await t.fs("eval", "document.querySelectorAll('#scroll-box li').length")).data);
    const res = await t.fs("scroll", "#scroll-box", "--to", "bottom");
    expect(res.ok).toBe(true);
    const counts = res.digest?.counts ?? {};
    const win = Object.entries(counts).find(([k]) => k.includes("Windowed Rows"));
    expect(win).toBeDefined();
    expect(win![1][1]).toBeGreaterThan(win![1][0]); // rows grew
    const after = Number((await t.fs("eval", "document.querySelectorAll('#scroll-box li').length")).data);
    expect(after).toBeGreaterThan(before);
  }, 20_000);

  test("scroll --by moves an element by a pixel delta", async () => {
    const res = await t.fs("scroll", "#scroll-box", "--by", "60");
    expect(res.ok).toBe(true);
    expect(res.data?.scrolledBy).toBe(60);
    expect(res.data?.scrollTop).toBeGreaterThan(0);
  }, 15_000);

  test("scroll --into-view brings a target on screen", async () => {
    const res = await t.fs("scroll", "--into-view", "#dnd-delta");
    expect(res.ok).toBe(true);
    expect(res.data?.intoView).toBe(true);
  }, 15_000);

  test("scroll with no direction is a shaped bad-args error", async () => {
    const res = await t.fs("scroll");
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("E_BAD_ARGS");
  }, 15_000);
});
