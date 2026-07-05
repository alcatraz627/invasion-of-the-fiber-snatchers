// WP60: per-project adaptation. A codebase teaches the tool its conventions via
// `adapt` config — non-ARIA surface selectors, custom overlay component names —
// so the tool works on apps that don't follow the ARIA assumptions. Also the
// red-team guards: a broad/invalid/hostile config must not flood or crash.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startTarget, type Target } from "./harness.ts";

describe("WP60 adaptation — with adapt config", () => {
  let t: Target;
  beforeAll(async () => {
    // Includes a hostile "*" (matches everything) and an invalid selector next
    // to the real one, plus a custom overlay name — all in one config.
    t = await startTarget({
      adapt: {
        surfaceSelectors: [".fs-fake-modal", "div[[[bad", "*"],
        overlayComponents: ["flyout"],
      },
    });
    expect((await t.fs("info")).ok).toBe(true);
    await t.fs("wait", "--settled");
  }, 40_000);
  afterAll(async () => t.stop());

  test("a non-ARIA overlay is tracked as a surface via config selector", async () => {
    const open = await t.fs("click", "Open Fake Modal");
    expect(open.digest?.surfaces?.opened).toContain("overlay:Fake Modal (no role)");
    const close = await t.fs("click", "--css", "#close-fake-modal");
    expect(close.digest?.surfaces?.closed).toContain("overlay:Fake Modal (no role)");
  }, 15_000);

  test("a broad selector ('*') does NOT flood the surfaces digest", async () => {
    // Opening the modal again — the digest must carry the one real overlay, not
    // dozens of #root/main/etc. matches from the '*' selector.
    await t.fs("click", "--css", "#close-fake-modal").catch(() => {});
    const open = await t.fs("click", "Open Fake Modal");
    const opened = open.digest?.surfaces?.opened ?? [];
    expect(opened).toContain("overlay:Fake Modal (no role)");
    expect(opened.length).toBeLessThanOrEqual(2); // not flooded
    await t.fs("click", "--css", "#close-fake-modal").catch(() => {});
  }, 15_000);

  test("the daemon survives an invalid selector in config", async () => {
    // 'div[[[bad' threw in querySelectorAll but was caught — the daemon is fine.
    expect((await t.fs("info")).ok).toBe(true);
  }, 15_000);

  test("a custom overlay component's closed menu is read via adapt.overlayComponents", async () => {
    const res = await t.fs("why", "--css", "#flyout-trigger");
    expect(res.ok).toBe(true);
    expect((res.data.signals as string[])).toContain("Archive Job");
  }, 15_000);
});

describe("WP60 red-team resilience", () => {
  let t: Target;
  beforeAll(async () => {
    t = await startTarget({ adapt: { overlayComponents: ["a"], contentPropKeys: ["className", "children"] } });
    expect((await t.fs("info")).ok).toBe(true);
    await t.fs("wait", "--settled");
  }, 40_000);
  afterAll(async () => t.stop());

  test("a control with a throwing-getter prop does NOT crash page/why/resolve", async () => {
    // The worst break: one poisoned fiber blinding the whole page. Attach a
    // React element with a throwing getter to a real control's fiber prop.
    await t.fs(
      "eval",
      `(() => {
        const b = document.querySelector('#icon-only');
        const k = Object.keys(b).find((x) => x.startsWith('__reactProps$'));
        const bad = { get children() { throw new Error('poisoned'); }, get tooltip() { throw new Error('poisoned'); } };
        const el = { $$typeof: Symbol.for('react.element'), type: 'div', props: bad };
        const fk = Object.keys(b).find((x) => x.startsWith('__reactFiber$'));
        if (b[fk]) b[fk].memoizedProps = { dropdown: el };
        return true;
      })()`
    );
    expect((await t.fs("page")).ok).toBe(true);
    expect((await t.fs("why", "--css", "#icon-only")).ok).toBe(true);
    expect((await t.fs("click", "Open Fake Modal")).ok).toBe(true);
  }, 20_000);

  test("a 1-char overlay token and structural content keys yield no signal flood", async () => {
    const res = await t.fs("why", "--css", "#export-trigger");
    // adapt.overlayComponents=["a"] and contentPropKeys=["className","children"]
    // were all rejected by sanitizeAdapt, so recovery falls back to the built-in
    // path (export-trigger's own Flyout/Dropdown menu), never a subtree flood.
    const sig = (res.data.signals as string[]) ?? [];
    expect(sig.every((s) => !s.includes("btn ") && s.length <= 60)).toBe(true);
  }, 15_000);
});

describe("WP60 adaptation — WITHOUT adapt config (baseline)", () => {
  let t: Target;
  beforeAll(async () => {
    t = await startTarget(); // no adapt
    expect((await t.fs("info")).ok).toBe(true);
    await t.fs("wait", "--settled");
  }, 40_000);
  afterAll(async () => t.stop());

  test("the same non-ARIA modal is NOT tracked without a config selector", async () => {
    const open = await t.fs("click", "Open Fake Modal");
    const opened = open.digest?.surfaces?.opened ?? [];
    expect(opened).not.toContain("overlay:Fake Modal (no role)");
  }, 15_000);

  test("a custom-named overlay's menu is missed without adapt.overlayComponents", async () => {
    // 'Flyout' matches no built-in overlay token, so its closed children aren't read.
    const res = await t.fs("why", "--css", "#flyout-trigger");
    expect((res.data.signals as string[]) ?? []).not.toContain("Archive Job");
  }, 15_000);
});
