/** WP4 acceptance: macros, sessions, probes. Drives the real CLI -> daemon ->
 *  fixture path. Load-bearing claims: a journaled flow replays through the SAME
 *  pipeline (digest per step); a parameterized target splices %vars%; a failed
 *  assertion yields an actionable dump; probes run from the store behind consent;
 *  a fill on a secret field is journaled redacted.
 *
 *  The library store is redirected to a subdir of the throwaway target via the
 *  config's `actionsRoot` override, so nothing here touches the real
 *  ~/.claude/fiber-actions. */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startTarget, type Target } from "./harness.ts";

let t: Target;

beforeAll(async () => {
  t = await startTarget();
  // Redirect the action library off the real home BEFORE the daemon boots.
  const cfgPath = join(t.dir, ".fiber-snatcher", "config.json");
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  cfg.actionsRoot = join(t.dir, ".fiber-snatcher", "actions");
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

  const info = await t.fs("info");
  expect(info.ok).toBe(true);
  await t.fs("wait", "--settled");
}, 40_000);

afterAll(async () => {
  await t.stop();
});

/** Write a store-input file (macro YAML / probe JS) under the target for --from-file. */
function fixtureFile(name: string, content: string): string {
  const p = join(t.dir, name);
  writeFileSync(p, content);
  return p;
}

describe("WP4 macros", () => {
  test("from-journal lifts a driven flow and replays it through the pipeline", async () => {
    await t.fs("navigate"); // clean state
    const open = await t.fs("click", "Open Preview");
    expect(open.ok).toBe(true);
    expect(open.digest?.surfaces?.opened?.some((s) => s.startsWith("dialog"))).toBe(true);
    const close = await t.fs("click", "Close");
    expect(close.ok).toBe(true);

    const drafted = await t.fs("macro", "from-journal", "--last", "2", "--name", "modalflow");
    expect(drafted.ok).toBe(true);
    expect(drafted.data.steps).toBe(2);

    // Replay: each step runs through the real pipeline and carries its own digest.
    const run = await t.fs("macro", "run", "modalflow");
    expect(run.ok).toBe(true);
    expect(run.data.ok).toBe(true);
    expect(run.data.steps).toHaveLength(2);
    expect(run.data.steps[0].ok).toBe(true);
    expect(run.data.steps[0].digest?.surfaces?.opened?.some((s: string) => s.startsWith("dialog"))).toBe(true);
    expect(run.data.steps[1].ok).toBe(true);
    expect(run.data.steps[1].digest?.surfaces?.closed?.length).toBeGreaterThan(0);
  }, 30_000);

  test("a parameterized target splices %vars% at run time", async () => {
    const yaml = [
      "name: searchparts",
      "description: search the parts table",
      "tags: [data-read]",
      "params:",
      "  - name: q",
      "    required: true",
      "steps:",
      "  - verb: fill",
      '    target: "parts search"',
      '    value: "%q%"',
      "",
    ].join("\n");
    const saved = await t.fs("macro", "save", "searchparts", "--from-file", fixtureFile("searchparts.yaml", yaml));
    expect(saved.ok).toBe(true);

    await t.fs("navigate");
    const run = await t.fs("macro", "run", "searchparts", "--param", "q=Part 42");
    expect(run.ok).toBe(true);
    expect(run.data.ok).toBe(true);

    // The value the app actually received proves the splice.
    const val = await t.fs("eval", "document.querySelector('[aria-label=\"parts search\"]').value");
    expect(val.data).toBe("Part 42");
  }, 30_000);

  test("a missing required param fails the envelope with a hint", async () => {
    const run = await t.fs("macro", "run", "searchparts");
    expect(run.ok).toBe(false);
    expect(run.error?.code).toBe("E_BAD_ARGS");
    expect(run.error?.message).toContain("missing required --param q");
  });

  test("a failed inline expect stops the run and dumps the failing step", async () => {
    const yaml = [
      "name: badexpect",
      "steps:",
      "  - verb: click",
      '    target: "Open Preview"',
      "    expect:",
      '      text: "NO SUCH TEXT 918273"',
      "      timeoutMs: 800",
      "",
    ].join("\n");
    await t.fs("macro", "save", "badexpect", "--from-file", fixtureFile("badexpect.yaml", yaml));
    await t.fs("navigate");

    const run = await t.fs("macro", "run", "badexpect");
    expect(run.ok).toBe(true); // the command dispatched...
    expect(run.data.ok).toBe(false); // ...but the flow failed
    expect(run.data.failedAt).toBe(0);
    // The dump is actionable: the click that ran, its digest, and why the expect missed.
    expect(run.data.steps[0].ok).toBe(true);
    expect(run.data.steps[0].digest).toBeDefined();
    expect(run.data.steps[0].expect.ok).toBe(false);
    expect(run.data.steps[0].expect.detail).toContain("NO SUCH TEXT");
    expect(run.data.journal).toContain("macro-runs");
  }, 30_000);

  test("list is progressive disclosure — names + descriptions, not bodies", async () => {
    const list = await t.fs("macro", "list");
    expect(list.ok).toBe(true);
    const names = list.data.map((m: { name: string }) => m.name);
    expect(names).toContain("searchparts");
    expect(names).toContain("modalflow");
    // The listing carries metadata, never the steps array (bodies are `show`-only).
    expect(JSON.stringify(list.data)).not.toContain("verb");
    const sp = list.data.find((m: { name: string }) => m.name === "searchparts");
    expect(sp.description).toContain("search the parts table");
    expect(sp.steps).toBe(1);
  });

  test("show returns the YAML body on demand", async () => {
    const shown = await t.fs("macro", "show", "searchparts");
    expect(shown.ok).toBe(true);
    expect(String(shown.data)).toContain("verb: fill");
  });

  test("save rejects an invalid macro with a located error", async () => {
    const bad = "name: broken\nsteps:\n  - verb: cick\n    target: X\n";
    const res = await t.fs("macro", "save", "broken", "--from-file", fixtureFile("broken.yaml", bad));
    expect(res.ok).toBe(false);
    expect(res.error?.message).toContain("unknown verb");
    expect(res.error?.message).toContain("click"); // near-match suggestion
  });
});

describe("WP4 sessions", () => {
  test("a session records assertions and a failure dumps the journal slice", async () => {
    await t.fs("navigate");
    const started = await t.fs("session", "start", "open the preview modal");
    expect(started.ok).toBe(true);

    const clickRes = await t.fs("click", "Open Preview");
    expect(clickRes.ok).toBe(true);

    // A passing assertion.
    const good = await t.fs("expect", "text", "Preview Modal", "--timeout", "2000");
    expect(good.ok).toBe(true);

    // A failing assertion surfaces as an error AND is recorded on the session.
    const bad = await t.fs("expect", "text", "NO SUCH TEXT 55555", "--timeout", "800");
    expect(bad.ok).toBe(false);

    const ended = await t.fs("session", "end");
    expect(ended.ok).toBe(true);
    expect(ended.data.goal).toBe("open the preview modal");
    expect(ended.data.ok).toBe(false); // an assertion failed
    expect(ended.data.assertions.length).toBe(2);
    expect(ended.data.assertionFailures.length).toBe(1);
    expect(ended.data.journalSlice).toBeDefined(); // slice dumped because it failed
    expect(ended.data.steps).toBeGreaterThanOrEqual(1); // the click is in the slice
    expect(ended.data.saved).toContain("/sessions/");
  }, 30_000);

  test("expect count asserts a selector's cardinality", async () => {
    await t.fs("navigate");
    await t.fs("wait", "--settled");
    // The modal has exactly two Export buttons (deliberate duplicate).
    await t.fs("click", "Open Preview");
    const res = await t.fs("expect", "count", "#the-modal button", "3", "--timeout", "2000"); // Close + Export + Export
    expect(res.ok).toBe(true);
    expect(res.data.kind).toBe("count");
  }, 30_000);
});

describe("WP4 probes", () => {
  const body = "document.querySelectorAll('tbody tr').length";

  test("save then run from the store (behind consent)", async () => {
    const saved = await t.fs("probe", "save", "rowcount", "--desc", "count rendered rows", "--tag", "utility", "--from-file", fixtureFile("rowcount.js", body));
    expect(saved.ok).toBe(true);

    // Without consent and no active session, run is refused with the remedy.
    const denied = await t.fs("probe", "run", "rowcount");
    expect(denied.ok).toBe(false);
    expect(denied.error?.message).toContain("consent");

    // --allow grants consent for the daemon's life.
    await t.fs("navigate");
    await t.fs("wait", "--settled");
    const run = await t.fs("probe", "run", "rowcount", "--allow");
    expect(run.ok).toBe(true);
    expect(typeof run.data).toBe("number");
    expect(run.data).toBeGreaterThan(0);
  }, 30_000);

  test("list shows names, descriptions, and tags", async () => {
    const list = await t.fs("probe", "list");
    expect(list.ok).toBe(true);
    const rc = list.data.find((p: { name: string }) => p.name === "rowcount");
    expect(rc.description).toBe("count rendered rows");
    expect(rc.tags).toEqual(["utility"]);
  });
});

describe("WP4 seed #29 — journal redaction", () => {
  test("a fill on a password field is journaled redacted", async () => {
    await t.fs("navigate");
    await t.fs(
      "eval",
      "(()=>{const i=document.createElement('input');i.type='password';i.setAttribute('aria-label','Password');i.id='pw';document.body.appendChild(i);return 'ok'})()"
    );
    const fill = await t.fs("fill", "--css", 'input[type="password"]', "hunter2");
    expect(fill.ok).toBe(true);

    const journal = await t.fs("journal", "--last", "5");
    const fillEntry = [...journal.data].reverse().find((e: { cmd: string }) => e.cmd === "fill");
    expect(fillEntry).toBeDefined();
    expect(fillEntry.args.value).toBe("[redacted]");
    // The plaintext must not appear anywhere in the journal payload.
    expect(JSON.stringify(journal.data)).not.toContain("hunter2");
  }, 30_000);
});
