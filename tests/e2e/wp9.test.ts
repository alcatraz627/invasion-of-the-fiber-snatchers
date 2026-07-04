// WP9: recover a control's label from ancestor fiber props when the DOM has
// none — the closed-dropdown menu items and always-mounted tooltip content the
// Versable dogfood exposed. The fixture's LabelHostileToolbar reproduces both
// patterns (floating-ui conditional-render menu; content-prop tooltip).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startTarget, type Target } from "./harness.ts";

let t: Target;

beforeAll(async () => {
  t = await startTarget();
  expect((await t.fs("info")).ok).toBe(true);
  await t.fs("wait", "--settled");
}, 40_000);

afterAll(async () => {
  await t.stop();
});

describe("WP9 un-rendered element-prop signals", () => {
  test("closed dropdown's menu item labels are recovered without opening it", async () => {
    // #export-trigger renders its menu only while open; the menu element (with
    // its items) lives on the trigger's ancestor fiber as an un-mounted prop.
    const res = await t.fs("why", "--css", "#export-trigger");
    expect(res.ok).toBe(true);
    const sig = res.data.signals as string[];
    expect(sig).toContain("Export All Sheets"); // ReactNode label, extracted
    expect(sig).toContain("Download the whole file"); // string tooltip
    expect(res.data.labelWeak).toBe(true); // DOM label was useless (#id)
    // the menu is genuinely not open — no role=menu in the DOM
    const open = await t.fs("eval", "!!document.querySelector('#wp9-toolbar [role=menu]')");
    expect(open.data).toBe(false);
  }, 15_000);

  test("always-mounted tooltip content is recovered from its prop", async () => {
    const res = await t.fs("why", "--css", "#refresh-icon");
    expect(res.ok).toBe(true);
    expect((res.data.signals as string[])).toContain("Refresh data");
  }, 15_000);

  test("page snapshot attaches signals to weak controls only", async () => {
    const res = await t.fs("page", "--scope", "#wp9-toolbar");
    const items = res.data.interactables as Array<{ text: string; signals?: string[] }>;
    const exportEntry = items.find((i) => i.text.includes("export-trigger"));
    expect(exportEntry?.signals).toContain("Export All Sheets");
  }, 15_000);

  test("resolveIntent matches the closed-menu text and annotates 'opens'", async () => {
    const res = await t.fs("eval", "window.__fs.resolveIntent('Export All Sheets')");
    const cands = res.data as Array<{ ref: string; text: string; confidence: number }>;
    expect(cands.length).toBeGreaterThan(0);
    expect(cands[0].text).toContain("opens");
    // signal match resolves lower than a direct label match (0.7, not ~1.0)
    expect(cands[0].confidence).toBeLessThan(0.85);
    expect(cands[0].confidence).toBeGreaterThan(0.4);
  }, 15_000);

  test("why also surfaces the handler source as 'what does this do' evidence", async () => {
    const res = await t.fs("why", "--css", "#export-trigger");
    expect(typeof res.data.handler).toBe("string");
    expect(res.data.handler).toContain("setOpen");
  }, 15_000);

  test("a strong-labelled control gets no signal noise", async () => {
    // The parts search has aria-label='parts search' — a strong DOM label, so
    // no fiber extraction runs and no signals are attached.
    const res = await t.fs("page", "--scope", "section");
    const items = res.data.interactables as Array<{ text: string; signals?: string[] }>;
    const strong = items.find((i) => i.text.toLowerCase().includes("parts search"));
    if (strong) expect(strong.signals).toBeUndefined();
  }, 15_000);
});
