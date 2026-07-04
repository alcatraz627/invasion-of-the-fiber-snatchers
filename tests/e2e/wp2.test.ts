/** WP2 acceptance: waits + settle. Drives the real CLI → daemon → fixture path.
 *  The load-bearing claim is the debounce hole: after a `fill`, the app's debounce
 *  timer has not fired, so a naive settle reads "idle" before the query starts.
 *  `--settled` (post-condition) and `wait --settled` (verb) must both see through
 *  that. Every test here is written WITHOUT a sleep or a poll loop — that absence
 *  is the acceptance, not decoration. */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startTarget, type Target } from "./harness.ts";

let t: Target;

beforeAll(async () => {
  t = await startTarget();
  const info = await t.fs("info");
  expect(info.ok).toBe(true);
  // Dogfood: wait for the boot query instead of polling #row-count.
  await t.fs("wait", "--settled");
}, 40_000);

afterAll(async () => {
  await t.stop();
});

/** Back to the all-rows baseline, deterministically, with no sleep. */
async function resetSearch(): Promise<void> {
  await t.fs("fill", "--css", "section input", "", "--settled");
}

describe("WP2 waits + settle", () => {
  test("fill --settled closes the debounce hole with zero sleeps or polls", async () => {
    await resetSearch();
    const res = await t.fs("fill", "--css", "section input", "Part 12", "--settled");
    expect(res.ok).toBe(true);
    // No poll: --settled guarantees the debounced query fired and resolved before
    // the command returned, so the count already reflects the filter.
    const rows = await t.fs("eval", "document.querySelector('#row-count').textContent");
    expect(String(rows.data)).toMatch(/^\d+ rows$/);
    expect(String(rows.data)).not.toBe("10000 rows");
    // The digest should agree that queries are settled.
    expect(res.digest?.queries).toBe("settled");
  }, 30_000);

  test("wait --settled returns once the TanStack query is idle (fill without the flag)", async () => {
    await resetSearch();
    // Plain fill: its default settle pass can honestly read idle mid-debounce.
    await t.fs("fill", "--css", "section input", "Part 7");
    const res = await t.fs("wait", "--settled");
    expect(res.ok).toBe(true);
    expect(res.data?.waited).toBe("settled");
    const rows = await t.fs("eval", "document.querySelector('#row-count').textContent");
    expect(String(rows.data)).not.toBe("10000 rows");
  }, 30_000);

  test("wait --text appears when the async query renders the row", async () => {
    await resetSearch();
    const absent = await t.fs("eval", "document.body.innerText.includes('Part 9999')");
    expect(absent.data).toBe(false); // Part 9999 is past the first 50 rendered rows
    await t.fs("fill", "--css", "section input", "9999"); // no --settled: text arrives async
    const res = await t.fs("wait", "--text", "Part 9999");
    expect(res.ok).toBe(true);
    const present = await t.fs("eval", "document.body.innerText.includes('Part 9999')");
    expect(present.data).toBe(true);
  }, 30_000);

  test("wait --gone times out while the modal is open, resolves once it closes", async () => {
    await t.fs("click", "Open Preview");
    expect((await t.fs("eval", "!!document.querySelector('#the-modal')")).data).toBe(true);

    // Still open → --gone must time out (bounded) rather than hang.
    const stuck = await t.fs("wait", "--gone", "#the-modal", "--timeout", "800");
    expect(stuck.ok).toBe(false);
    expect(stuck.error?.code).toBe("E_WAIT_TIMEOUT");

    await t.fs("click", "Close"); // unique label in the modal (Export ×2 are the dupes)
    const gone = await t.fs("wait", "--gone", "#the-modal");
    expect(gone.ok).toBe(true);
    expect((await t.fs("eval", "!!document.querySelector('#the-modal')")).data).toBe(false);
  }, 30_000);

  test("a wait timeout carries the page state so the agent can re-plan", async () => {
    const res = await t.fs("wait", "--text", "This Text Never Appears QZX", "--timeout", "700");
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("E_WAIT_TIMEOUT");
    // Concise snapshot attached as data; state digest attached too.
    expect(Array.isArray(res.data?.interactables)).toBe(true);
    expect(res.digest?.queries).toBeDefined();
  }, 20_000);

  test("--settled on a mutating verb honors a custom budget: too short times out, but the act still landed", async () => {
    await resetSearch();
    // 100ms < the fixture's 250ms debounce, so the settle wait must time out...
    const res = await t.fs("fill", "--css", "section input", "Part 8", "--settled", "--timeout", "100");
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("E_WAIT_TIMEOUT");
    // ...yet the fill itself ran before the wait, so the value is typed.
    const val = await t.fs("eval", "document.querySelector('section input').value");
    expect(val.data).toBe("Part 8");
    await resetSearch(); // let the lingering query settle before the next test
  }, 20_000);

  test("sleep journals a smell marker and nudges toward wait", async () => {
    const res = await t.fs("sleep", "50");
    expect(res.ok).toBe(true);
    expect(String(res.data?.note)).toContain("wait");
    const journal = await t.fs("journal", "--last", "15");
    const entries = journal.data as Array<{ cmd: string; args: { smell?: boolean } }>;
    const sleepEntry = [...entries].reverse().find((e) => e.cmd === "sleep");
    expect(sleepEntry).toBeDefined();
    expect(sleepEntry!.args.smell).toBe(true);
  }, 15_000);
});
