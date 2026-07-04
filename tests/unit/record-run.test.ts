/** Unit tests for the pure orchestration helpers: journal -> draft macro, param
 *  overlay, and %var% substitution. The step-running path needs a browser and
 *  lives in the e2e suite. */

import { describe, expect, test } from "bun:test";
import type { JournalEntry } from "../../src/pipeline/contracts.ts";
import { draftFromJournal } from "../../src/macros/record.ts";
import { resolveVars, substituteVars } from "../../src/macros/run.ts";
import type { Macro } from "../../src/macros/format.ts";

function entry(seq: number, cmd: string, over: Partial<JournalEntry> = {}): JournalEntry {
  return { ts: `t${seq}`, run: "r", seq, cmd, args: {}, ok: true, durMs: 1, ...over };
}

describe("draftFromJournal", () => {
  const journal: JournalEntry[] = [
    entry(1, "navigate", { args: { url: "http://x/app" } }),
    entry(2, "page"), // observation — dropped
    entry(3, "click", { target: { ref: "e5.abc", role: "button", text: "Open Preview", component: "App" } }),
    entry(4, "fill", { args: { value: "JEGS" }, target: { ref: "e9.abc", role: "textbox", text: "parts search" } }),
    entry(5, "sleep", { args: { ms: 500 } }), // smell — dropped
    entry(6, "click", { target: { ref: "e12.abc", role: "button", text: "Export" } }),
  ];

  test("keeps only recordable actions, drops reads and smells", () => {
    const macro = draftFromJournal(journal, { name: "flow" });
    expect(macro.steps.map((s) => s.verb)).toEqual(["navigate", "click", "fill", "click"]);
  });

  test("targets are the portable resolved text, not the ref", () => {
    const macro = draftFromJournal(journal, { name: "flow" });
    const click = macro.steps[1]!;
    expect(click.target).toBe("Open Preview");
    expect(click.from).toContain("e5.abc"); // provenance preserved
    expect(JSON.stringify(macro.steps)).not.toContain("e5.abc\","); // ref not used AS a target value
  });

  test("navigate keeps its url; fill keeps its value", () => {
    const macro = draftFromJournal(journal, { name: "flow" });
    expect(macro.steps[0]).toMatchObject({ verb: "navigate", args: { url: "http://x/app" } });
    expect(macro.steps[2]).toMatchObject({ verb: "fill", target: "parts search", value: "JEGS" });
  });

  test("lastN keeps the tail of the recordable steps", () => {
    const macro = draftFromJournal(journal, { name: "flow", lastN: 2 });
    expect(macro.steps.map((s) => s.verb)).toEqual(["fill", "click"]);
  });

  test("seq range filters", () => {
    const macro = draftFromJournal(journal, { name: "flow", fromSeq: 4, toSeq: 6 });
    expect(macro.steps.map((s) => s.verb)).toEqual(["fill", "click"]);
  });

  test("a redacted fill value is carried through for the agent to parameterize", () => {
    const j = [entry(1, "fill", { args: { value: "[redacted]" }, target: { ref: "e1.a", role: "textbox", text: "Password" } })];
    const macro = draftFromJournal(j, { name: "login" });
    expect(macro.steps[0]!.value).toBe("[redacted]");
  });
});

describe("resolveVars", () => {
  const macro: Macro = {
    name: "m",
    params: [
      { name: "job", required: true },
      { name: "tab", default: "data" },
    ],
    steps: [{ verb: "click", target: "%job%" }],
  };

  test("overlays provided onto defaults", () => {
    const r = resolveVars(macro, { job: "JEGS" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.vars).toEqual({ job: "JEGS", tab: "data" });
  });

  test("provided overrides default", () => {
    const r = resolveVars(macro, { job: "JEGS", tab: "settings" });
    if (r.ok) expect(r.vars.tab).toBe("settings");
  });

  test("missing required param is an error", () => {
    const r = resolveVars(macro, {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toContain("missing required --param job");
  });
});

describe("substituteVars", () => {
  test("splices declared vars", () => {
    expect(substituteVars("open %job% now", { job: "JEGS" })).toBe("open JEGS now");
  });
  test("multiple and repeated vars", () => {
    expect(substituteVars("%a%-%b%-%a%", { a: "1", b: "2" })).toBe("1-2-1");
  });
  test("unresolved var throws", () => {
    expect(() => substituteVars("%nope%", {})).toThrow(/unresolved %nope%/);
  });
});
