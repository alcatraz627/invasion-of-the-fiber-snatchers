/** WP3b acceptance: forms + misc verbs through the real CLI -> daemon -> fixture
 *  path. Each verb ships a happy path, a failure path, and a digest assertion.
 *  The load-bearing verb is `close`: it must PROVE the surface left (retrying a
 *  swallowed Escape) rather than assume the first press worked — the V1 export
 *  saga acted on a page behind a modal it believed was gone. No sleeps: `wait
 *  --settled` and the verbs' own settle passes carry the timing. */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTarget, type Target } from "./harness.ts";

let t: Target;
let filesDir: string;
let fileA: string;
let fileB: string;

beforeAll(async () => {
  t = await startTarget();
  const info = await t.fs("info");
  expect(info.ok).toBe(true);
  await t.fs("wait", "--settled"); // dogfood the boot query instead of polling

  filesDir = mkdtempSync(join(tmpdir(), "fs-wp3b-uploads-"));
  fileA = join(filesDir, "alpha.txt");
  fileB = join(filesDir, "beta.csv");
  writeFileSync(fileA, "alpha contents");
  writeFileSync(fileB, "beta,contents");
}, 40_000);

afterAll(async () => {
  rmSync(filesDir, { recursive: true, force: true });
  await t.stop();
});

const textOf = async (selector: string): Promise<string> =>
  String((await t.fs("eval", `document.querySelector(${JSON.stringify(selector)}).textContent`)).data);

describe("WP3b select", () => {
  test("selects a native option by label and reflects it in the digest", async () => {
    const res = await t.fs("select", "--css", "#fs-select", "Failed only");
    expect(res.ok).toBe(true);
    expect(res.data?.value).toBe("failed");
    expect(await textOf("#fs-select-value")).toBe("failed");
    // onChange -> setState -> re-render is a real page mutation.
    expect(["minor", "major"]).toContain(res.digest?.mutations);
  }, 20_000);

  test("selects by value and by index", async () => {
    const byValue = await t.fs("select", "--css", "#fs-select", "--by", "value", "done");
    expect(byValue.ok).toBe(true);
    expect(await textOf("#fs-select-value")).toBe("done");

    const byIndex = await t.fs("select", "--css", "#fs-select", "--by", "index", "0");
    expect(byIndex.ok).toBe(true);
    expect(byIndex.data?.value).toBe("all");
    expect(await textOf("#fs-select-value")).toBe("all");
  }, 20_000);

  test("an unknown option fails fast with the available options listed", async () => {
    const res = await t.fs("select", "--css", "#fs-select", "Nonexistent");
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("E_BAD_ARGS");
    expect(res.error?.hint).toContain("All parts"); // lists what IS selectable
  }, 20_000);

  test("targeting a non-select is a shaped error, not a 5s actionability wait", async () => {
    const res = await t.fs("select", "--css", "#fs-paste", "whatever");
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("E_BAD_ARGS");
    expect(res.error?.message).toContain("<select>");
  }, 20_000);
});

describe("WP3b upload", () => {
  test("sets a file on a file input and the app sees its name", async () => {
    const res = await t.fs("upload", "--css", "#fs-file", fileA);
    expect(res.ok).toBe(true);
    expect(res.data?.uploaded).toEqual(["alpha.txt"]);
    expect(await textOf("#fs-file-names")).toBe("alpha.txt");
    expect(res.digest?.mutations).toBeDefined();
  }, 20_000);

  test("sets multiple files at once", async () => {
    const res = await t.fs("upload", "--css", "#fs-file", fileA, fileB);
    expect(res.ok).toBe(true);
    expect(res.data?.uploaded).toEqual(["alpha.txt", "beta.csv"]);
    expect(await textOf("#fs-file-names")).toBe("alpha.txt, beta.csv");
  }, 20_000);

  test("a missing file path errors before touching the page", async () => {
    const res = await t.fs("upload", "--css", "#fs-file", join(filesDir, "ghost.txt"));
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("E_BAD_ARGS");
    expect(res.error?.message).toContain("file not found");
  }, 20_000);

  test("a target with no file input hands off to WP3a drag machinery", async () => {
    const res = await t.fs("upload", "--css", "#fs-paste", fileA);
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("E_BAD_ARGS");
    expect(res.error?.hint).toContain("drop");
  }, 20_000);
});

describe("WP3b paste", () => {
  test("a real paste fires onPaste (which a fill does not) and lands the text", async () => {
    const before = Number(await textOf("#paste-count"));

    // A plain fill fires input/change but NOT paste, so the counter must not move.
    await t.fs("fill", "--css", "#fs-paste", "typed-not-pasted");
    expect(Number(await textOf("#paste-count"))).toBe(before);

    const res = await t.fs("paste", "--css", "#fs-paste", "clip-board-text");
    expect(res.ok).toBe(true);
    expect(Number(await textOf("#paste-count"))).toBe(before + 1);
    expect(await textOf("#pasted-value")).toBe("clip-board-text");
    expect(res.digest?.mutations).toBeDefined();
  }, 20_000);
});

describe("WP3b resize", () => {
  test("a viewport resize surfaces a layout-driven count delta in the digest", async () => {
    await t.fs("resize", "1280", "800"); // ensure the wide layout baseline
    const narrow = await t.fs("resize", "700", "600");
    expect(narrow.ok).toBe(true);
    expect(narrow.data?.viewport).toEqual({ width: 700, height: 600 });
    // The responsive widget list (10 items) collapses under 800px.
    expect(narrow.digest?.counts?.["list:Responsive Widgets"]).toEqual([10, 0]);

    const wide = await t.fs("resize", "1200", "800");
    expect(wide.ok).toBe(true);
    expect(wide.digest?.counts?.["list:Responsive Widgets"]).toEqual([0, 10]);
  }, 20_000);

  test("non-positive dimensions are rejected", async () => {
    const res = await t.fs("resize", "0", "600");
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("E_BAD_ARGS");
  }, 20_000);
});

describe("WP3b verified close", () => {
  test("Escape closes an escapable modal and the digest reports the closed surface", async () => {
    await t.fs("click", "Open Escape Modal");
    expect((await t.fs("eval", "!!document.querySelector('#escape-modal')")).data).toBe(true);

    const res = await t.fs("close");
    expect(res.ok).toBe(true);
    expect(res.data?.closed).toBe("dialog:Escape Modal");
    expect(res.digest?.surfaces?.closed).toContain("dialog:Escape Modal");
    expect((await t.fs("eval", "!!document.querySelector('#escape-modal')")).data).toBe(false);
  }, 20_000);

  test("clicking a named close control also verifies the surface left", async () => {
    await t.fs("click", "Open Escape Modal");
    const res = await t.fs("close", "Dismiss");
    expect(res.ok).toBe(true);
    expect(res.data?.closed).toBe("dialog:Escape Modal");
    expect((await t.fs("eval", "!!document.querySelector('#escape-modal')")).data).toBe(false);
  }, 20_000);

  test("a swallowed first Escape is retried, so the stuck modal still closes", async () => {
    await t.fs("click", "Open Stuck Modal");
    expect((await t.fs("eval", "!!document.querySelector('#stuck-modal')")).data).toBe(true);

    const res = await t.fs("close");
    expect(res.ok).toBe(true); // first Escape swallowed, retry closes it
    expect(res.data?.closed).toBe("dialog:Stuck Modal");
    expect(res.digest?.surfaces?.closed).toContain("dialog:Stuck Modal");
    expect((await t.fs("eval", "!!document.querySelector('#stuck-modal')")).data).toBe(false);
  }, 20_000);

  test("a modal that never yields to Escape fails loudly, naming the stuck surface", async () => {
    await t.fs("click", "Open Preview"); // #the-modal has no Escape handler
    const res = await t.fs("close");
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("E_INTERNAL");
    expect(res.error?.message).toContain("dialog:Preview Modal");
    // Still on screen — the verb told the truth instead of a false success.
    expect((await t.fs("eval", "!!document.querySelector('#the-modal')")).data).toBe(true);
    await t.fs("click", "Close"); // clean up for isolation
  }, 20_000);

  test("close with nothing open is a no-op, not an error", async () => {
    const res = await t.fs("close");
    expect(res.ok).toBe(true);
    expect(res.data?.closed).toBeNull();
    expect(String(res.data?.note)).toContain("no open surface");
  }, 20_000);
});
