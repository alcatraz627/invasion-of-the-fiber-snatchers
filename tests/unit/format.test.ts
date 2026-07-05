/** Format unit tests: valid macros parse, and every schema violation produces a
 *  located, actionable error. No browser, no pipeline. */

import { describe, expect, test } from "bun:test";
import { parseMacro, validateMacro, stringifyMacro, type Macro } from "../../src/macros/format.ts";

const VERBS = new Set(["click", "fill", "press", "navigate", "hover"]);

function errs(raw: unknown): string[] {
  const r = validateMacro(raw, { knownVerbs: VERBS });
  return r.ok ? [] : r.errors;
}

describe("valid macros", () => {
  test("a minimal macro round-trips through YAML", () => {
    const yaml = `
name: open-job-modal
description: Open a job preview
tags: [feature]
params:
  - name: job
    required: true
steps:
  - verb: click
    target: "%job%"
  - verb: click
    target: "Open Preview"
`;
    const r = parseMacro(yaml, { knownVerbs: VERBS });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.macro.name).toBe("open-job-modal");
    expect(r.macro.steps).toHaveLength(2);
    // stringify -> parse is stable
    const round = parseMacro(stringifyMacro(r.macro), { knownVerbs: VERBS });
    expect(round.ok).toBe(true);
  });

  test("object target forms validate", () => {
    const macro: Macro = {
      name: "picks",
      params: [{ name: "q" }],
      steps: [
        { verb: "click", target: { by: "index", select: "tr button", index: 2 } },
        { verb: "click", target: { by: "random", select: "JobRow" } },
        { verb: "fill", target: { by: "id", value: "search" }, value: "%q%" },
      ],
    };
    expect(errs(macro)).toEqual([]);
  });

  test("inline expects validate", () => {
    const macro: Macro = {
      name: "with-expect",
      steps: [{ verb: "click", target: "Save", expect: { count: { select: "tr", equals: 8 } } }],
    };
    expect(errs(macro)).toEqual([]);
  });
});

describe("schema violations are located and actionable", () => {
  test("missing name and steps", () => {
    const e = errs({});
    expect(e.some((x) => x.includes("`name`"))).toBe(true);
    expect(e.some((x) => x.includes("`steps`"))).toBe(true);
  });

  test("unknown verb suggests the near match", () => {
    const e = errs({ name: "m", steps: [{ verb: "clik", target: "X" }] });
    expect(e.some((x) => x.includes("steps[0]") && x.includes("clik") && x.includes("click"))).toBe(true);
  });

  test("undeclared %var% is caught in every string field", () => {
    const e = errs({ name: "m", params: [{ name: "job" }], steps: [{ verb: "fill", target: "%jbo%", value: "%job%" }] });
    expect(e.some((x) => x.includes("%jbo%") && x.includes("job"))).toBe(true);
  });

  test("by:index without select/index errors", () => {
    const e = errs({ name: "m", steps: [{ verb: "click", target: { by: "index" } }] });
    expect(e.some((x) => x.includes("by:index needs `select`"))).toBe(true);
    expect(e.some((x) => x.includes("by:index needs a numeric `index`"))).toBe(true);
  });

  test("bad by value lists the allowed set", () => {
    const e = errs({ name: "m", steps: [{ verb: "click", target: { by: "colour", value: "x" } }] });
    expect(e.some((x) => x.includes("name, index, random, id"))).toBe(true);
  });

  test("disallowed tag lists the allowed set", () => {
    const e = errs({ name: "m", tags: ["frobnicate"], steps: [{ verb: "click", target: "X" }] });
    expect(e.some((x) => x.includes("frobnicate") && x.includes("domain, feature, utility, data-read"))).toBe(true);
  });

  test("expect with no recognized kind errors", () => {
    const e = errs({ name: "m", steps: [{ verb: "click", target: "X", expect: {} }] });
    expect(e.some((x) => x.includes("text | count | state | settled"))).toBe(true);
  });

  test("`verb: expect` (the footgun) is rejected with a fix hint", () => {
    // Writing an assertion as its own step instead of attaching `expect:` to a step.
    const e = errs({ name: "m", steps: [{ verb: "expect", text: "Saved" }] });
    expect(e.some((x) => x.includes('"expect" is not a verb') && x.includes("expect:"))).toBe(true);
  });

  test("malformed YAML reports a parse error, not a crash", () => {
    const r = parseMacro("name: x\n  bad: : :", { knownVerbs: VERBS });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toContain("not valid YAML");
  });
});
