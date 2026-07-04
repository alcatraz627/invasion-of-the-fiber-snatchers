// Regressions for the four WP0-review findings that were reproduced live
// (WP0-review.md #1-#4) plus the parser traps (#7, #13, #15). Each test is the
// review's probe, inverted into an assertion.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startTarget, type Target } from "./harness.ts";

let t: Target;

beforeAll(async () => {
  t = await startTarget();
  const res = await t.fs("info"); // cold-boot once for the file
  expect(res.ok).toBe(true);
  // WP2: wait for the boot query to settle so tests attribute mutations to their
  // own actions, not to boot-time rendering (replaces the old poll loop).
  await t.fs("wait", "--settled");
}, 40_000);

afterAll(async () => {
  await t.stop();
});

describe("review regressions", () => {
  test("#3 dead click on a NEVER-minted element reads mutations:none", async () => {
    // Fresh CSS mint + click on a handler-less element — the mint itself must
    // not pollute the digest (was: 'minor' on first contact).
    const res = await t.fs("click", "--css", "#theme");
    expect(res.ok).toBe(true);
    expect(res.digest?.mutations).toBe("none");
  }, 20_000);

  test("#2 a ref from a previous document is rejected even after re-minting", async () => {
    const page1 = await t.fs("page");
    const oldRef = page1.data.interactables[5].ref as string;
    await t.fs("reload");
    await t.fs("page"); // re-mints refs in the new document (the P3 trap setup)
    const res = await t.fs("click", oldRef);
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("E_TARGET_STALE");
    expect(res.error?.message).toContain("previous document");
  }, 30_000);

  test("#4 one mounted component = exactly one candidate", async () => {
    const res = await t.fs("eval", "window.__fs.resolveComponent('PartsTable').length");
    expect(res.data).toBe(1);
  }, 15_000);

  test("#4b bracket component expression acts without phantom ambiguity", async () => {
    const res = await t.fs("click", 'SearchBox[id="nav-search"]');
    expect(res.ok).toBe(true);
  }, 15_000);

  test("#1 concurrent actions get independent, correct digests", async () => {
    // Serialized daemon: the icon click's real mutation must not be stolen by
    // the concurrently-issued fill's settle loop.
    const [clickRes, fillRes] = await Promise.all([
      t.fs("click", "--css", "#icon-only"),
      t.fs("fill", "--css", "section input", "Part 42"),
    ]);
    expect(clickRes.ok).toBe(true);
    expect(fillRes.ok).toBe(true);
    expect(clickRes.digest?.mutations).not.toBe("none");
  }, 30_000);

  test("#7 boolean flags do not eat positionals", async () => {
    const res = await t.fs("state", "--shallow", "#row-count");
    expect(res.ok).toBe(true);
    expect(res.data.selector).toBe("#row-count");
  }, 15_000);

  test("#13 intent text with combinator characters stays intent", async () => {
    const res = await t.fs("click", "Save + Close");
    // No such control: must fail as an INTENT miss, not a CSS parse/0-match.
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("E_TARGET_NOT_FOUND");
    expect(res.error?.message).toContain('"Save + Close"');
  }, 15_000);

  test("#15 fill without a value errors instead of clearing the field", async () => {
    const out = await t.fsRaw("fill", "--css", "section input");
    expect(out).toContain("E_BAD_ARGS");
    expect(out).toContain("value");
  }, 15_000);

  test("#9 unactionable click maps to E_NOT_ACTIONABLE, first line only", async () => {
    // The hidden dropdown panel case: nothing matches actionability. Use a
    // 1500ms timeout via --timeout to keep the test fast? Playwright budget is
    // fixed at 5s in the verb — accept the 5s wait once.
    const res = await t.fs("eval", "(() => { const b = document.createElement('button'); b.id='ghost'; b.style.display='none'; b.textContent='Ghost'; document.body.appendChild(b); return true; })()");
    expect(res.data).toBe(true);
    const click = await t.fs("click", "--css", "#ghost");
    expect(click.ok).toBe(false);
    expect(click.error?.code).toBe("E_NOT_ACTIONABLE");
    expect(click.error?.message.includes("\n")).toBe(false);
  }, 20_000);
});
