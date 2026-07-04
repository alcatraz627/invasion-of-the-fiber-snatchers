/** WP1 acceptance: T0 digest full shape (surfaces/focus/counts), T1 snapshot
 *  quality (label ladder, collection summaries, budget), intent targeting v2,
 *  and the review seeds (#16/#21/#23) + WP7 handoffs. Drives the real
 *  CLI -> daemon -> fixture path against a shared target; each test that cares
 *  about page state re-establishes it via beforeEach(reset). */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { startTarget, type Target } from "./harness.ts";

let t: Target;

async function waitForParts(): Promise<void> {
  for (let i = 0; i < 25; i++) {
    const r = await t.fs("eval", "document.querySelector('#row-count')?.textContent ?? ''");
    if (String(r.data).startsWith("10000")) return; // full unfiltered result landed
    await new Promise((res) => setTimeout(res, 200));
  }
}

/** Baseline: no modal, Data tab active, Failed-only off, parts query landed. */
async function reset(): Promise<void> {
  await t.fs(
    "eval",
    `(() => {
      const m = document.querySelector('#the-modal button'); if (m) m.click();
      const d = [...document.querySelectorAll('[role=tab]')].find((b) => b.textContent === 'Data');
      if (d && d.getAttribute('aria-selected') !== 'true') d.click();
      return true;
    })()`
  );
  await waitForParts();
  await t.fs("eval", "(() => { const ft = document.querySelector('#failed-toggle'); if (ft && ft.textContent.includes('Showing')) ft.click(); return true; })()");
}

beforeAll(async () => {
  t = await startTarget();
  const info = await t.fs("info");
  expect(info.ok).toBe(true);
  await waitForParts();
}, 40_000);

afterAll(async () => {
  await t.stop();
});

describe("WP1 T1 snapshot quality", () => {
  beforeEach(reset);

  test("concise snapshot of the 10k-row table stays under 3KB", async () => {
    const res = await t.fs("page");
    expect(res.ok).toBe(true);
    const size = JSON.stringify(res.data).length;
    expect(size).toBeLessThan(3072);
    // The table is summarized as a collection, not enumerated row-by-row.
    const cols = (res.data.collections ?? []) as Array<{ kind: string; label: string; rows: number }>;
    expect(cols.some((c) => c.kind === "table" && c.rows >= 3)).toBe(true);
    // Its row controls are NOT in the flat interactable list in concise mode.
    const items = (res.data.interactables ?? []) as Array<{ text: string }>;
    expect(items.some((i) => /^Part \d+$/.test(i.text))).toBe(false);
  }, 15_000);

  test("icon-only controls get non-generic labels via the fallback ladder", async () => {
    const res = await t.fs("page", "--detailed");
    expect(res.ok).toBe(true);
    const items = (res.data.interactables ?? []) as Array<{ role: string; text: string; component?: string }>;
    const labels = items.map((i) => i.text);
    expect(labels).toContain("refresh-action"); // data-testid rung
    expect(labels).toContain("Notifications"); // svg <title> rung
    // No control degrades to a bare tag name ("never bare button").
    expect(items.filter((i) => i.role === "button").every((i) => i.text !== "button")).toBe(true);
  }, 15_000);

  test("--scope paginates into a collection's individual controls", async () => {
    const res = await t.fs("page", "--scope", "table");
    expect(res.ok).toBe(true);
    const items = (res.data.interactables ?? []) as Array<{ text: string }>;
    expect(items.some((i) => /^Part \d+$/.test(i.text))).toBe(true);
  }, 15_000);
});

describe("WP1 T0 digest full shape", () => {
  beforeEach(reset);

  test("modal open/close appears in digest surfaces", async () => {
    const open = await t.fs("click", "Open Preview");
    expect(open.ok).toBe(true);
    expect((open.digest?.surfaces?.opened ?? []).some((s) => s.includes("Preview Modal"))).toBe(true);

    const close = await t.fs("click", "Close");
    expect(close.ok).toBe(true);
    expect((close.digest?.surfaces?.closed ?? []).some((s) => s.includes("Preview Modal"))).toBe(true);
  }, 20_000);

  test("a synchronous row-count change appears in digest counts", async () => {
    const res = await t.fs("click", "--css", "#failed-toggle");
    expect(res.ok).toBe(true);
    const counts = res.digest?.counts ?? {};
    const entries = Object.entries(counts);
    // shown = rows.slice(0,50) (ids 0..49); failed (i%7===0) = 8 of them.
    expect(entries.some(([k, v]) => k.startsWith("table:") && v[0] === 50 && v[1] === 8)).toBe(true);
    await t.fs("click", "--css", "#failed-toggle"); // restore
  }, 15_000);

  test("focus movement is reported in the digest", async () => {
    const res = await t.fs("click", "--css", "section input");
    expect(res.ok).toBe(true);
    expect(res.digest?.focus).toBeDefined();
  }, 15_000);

  test("dead click on a fresh element reads mutations:none", async () => {
    const res = await t.fs("click", "--css", "#click-count");
    expect(res.ok).toBe(true);
    expect(res.digest?.mutations).toBe("none");
  }, 15_000);

  test("observation verbs emit a single-drain digest under profile debug (review #21)", async () => {
    const noDigest = await t.fs("page");
    expect(noDigest.digest).toBeUndefined(); // default profile: reads stay quiet

    await t.fs("profile", "debug");
    const res = await t.fs("page");
    expect(res.ok).toBe(true);
    expect(res.digest).toBeDefined();
    expect(res.digest?.mutations).toBeDefined();
    await t.fs("profile", "explore"); // restore
  }, 15_000);
});

describe("WP1 intent targeting v2", () => {
  beforeEach(reset);

  test("a single low-confidence match names the mismatch, not '1 matches' (review #23)", async () => {
    // "parts search" matches exactly one control — a textbox. Forcing --role
    // button leaves one below-threshold candidate.
    const res = await t.fs("click", "parts search", "--role", "button");
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("E_TARGET_NOT_FOUND");
    expect(res.error?.message).toContain("not a button");
    expect(res.error?.message).not.toContain("plausible matches");
  }, 15_000);

  test("degenerate intent inputs return shaped errors, never crash", async () => {
    for (const bad of ["", "   ", "!@#$%^&*()", "(((", "Save + Close", "x".repeat(400)]) {
      const res = await t.fs("click", bad);
      expect(typeof res.ok).toBe("boolean");
      if (!res.ok) expect(res.error?.code).toBeDefined();
    }
  }, 30_000);

  test("intent matching is literal and whitespace-normalized", async () => {
    // Extra/irregular whitespace still resolves the exact control.
    const hit = await t.fs("click", "  Failed   only ");
    expect(hit.ok).toBe(true); // toggles the table filter
    await t.fs("click", "--css", "#failed-toggle"); // restore off

    // "Open (Preview)" as a REGEX would match "Open Preview"; as a literal
    // substring it does not — so it must miss, proving matching isn't regex.
    const miss = await t.fs("click", "Open (Preview)");
    expect(miss.ok).toBe(false);
    expect(miss.error?.code).toBe("E_TARGET_NOT_FOUND");
  }, 15_000);
});

describe("WP1 review seeds + WP7 handoffs", () => {
  beforeEach(reset);

  test("jotai without a dev store reports degraded, self-describing (review #16)", async () => {
    const res = await t.fs("atoms");
    expect(res.ok).toBe(true);
    expect(Array.isArray(res.data)).toBe(true);
    // The fixture is a production Bun build (no dev4 atom API).
    expect(JSON.stringify(res.data)).toMatch(/degraded|dev enumeration API/i);
  }, 15_000);

  test("fs queries keeps the TanStack query key (WP7 handoff 1)", async () => {
    const res = await t.fs("queries");
    expect(res.ok).toBe(true);
    expect(res.data.length).toBeGreaterThan(0);
    expect(res.data[0].key).toBeDefined(); // previously stripped by safeSnapshot
  }, 15_000);
});

describe("WP1 between-action remount (WP7 handoff 2)", () => {
  test("a remount between commands surfaces in the next digest (auto-armed)", async () => {
    // Fresh document so the auto-armed sentinel watches a live React root.
    await t.fs("reload");
    await waitForParts();

    // The sentinel must arm itself at injection — no `fs remount` call.
    let armed = false;
    for (let i = 0; i < 15; i++) {
      const a = await t.fs("eval", "!!window.__fsRemount");
      if (a.data === true) { armed = true; break; }
      await new Promise((res) => setTimeout(res, 200));
    }
    expect(armed).toBe(true);

    // Trigger a full root remount while no mutating command is running. `eval` is
    // an observation verb: it neither preDrains nor acks the remount counter. The
    // sentinel's MutationObserver fires as a microtask, so poll for the count
    // rather than reading it synchronously in the trigger eval.
    await t.fs("eval", "(() => { const c = window.__fsRemount.container; const n = document.createElement('main'); c.replaceChild(n, c.firstElementChild); return true; })()");
    let counted = false;
    for (let i = 0; i < 15; i++) {
      const c = await t.fs("eval", "window.__fsRemount.count");
      if (Number(c.data) >= 1) { counted = true; break; }
      await new Promise((res) => setTimeout(res, 200));
    }
    expect(counted).toBe(true);

    // The next mutating action's digest must fold the between-action remount in,
    // even though preDrain ran between the two.
    const res = await t.fs("click", "--css", "main");
    expect((res.digest?.errors ?? []).some((e) => /remount detected/.test(e))).toBe(true);
  }, 30_000);
});
