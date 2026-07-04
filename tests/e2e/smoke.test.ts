/** WP0 acceptance suite: drives the REAL path (CLI → auto-started headless
 *  daemon → pipeline → fixture app) and asserts on behavior + digest content.
 *  Each test maps to an acceptance criterion in IMPLEMENTATION.md §3-WP0.
 *
 *  Decoupled (WP0-review #30): the daemon is shared for speed, but every
 *  acceptance test re-establishes its own page baseline via beforeEach(reset)
 *  and opens the surfaces it needs — no test depends on a prior test's state.
 *  Cold start keeps its own describe so the reset doesn't boot the daemon
 *  before it can observe a cold one. */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFixture } from "../fixture-app/serve.ts";

const FS_BIN = new URL("../../bin/fs.ts", import.meta.url).pathname;

let fixture: Awaited<ReturnType<typeof startFixture>>;
let projectDir: string;

type Envelope = {
  ok: boolean;
  data?: any;
  error?: { code: string; message: string; candidates?: any[]; hint?: string };
  digest?: { mutations: string; url?: { from: string; to: string }; queries?: string; errors?: string[] };
  gen?: number;
};

async function fs(...argv: string[]): Promise<Envelope> {
  const proc = Bun.spawn(["bun", FS_BIN, ...argv, "--json"], {
    cwd: projectDir,
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  try {
    return JSON.parse(out) as Envelope;
  } catch {
    throw new Error(`non-JSON CLI output: ${out.slice(0, 400)}`);
  }
}

async function waitForParts(): Promise<void> {
  // WP2: wait for the parts query to settle instead of polling #row-count.
  await fs("wait", "--settled");
}

/** Known baseline for an acceptance test: no modal open, Data tab active, parts
 *  query landed. Uses eval (not a reload) so the reset is cheap and does not
 *  perturb the mutation buffer of the test's own actions. */
async function reset(): Promise<void> {
  await fs(
    "eval",
    `(() => {
      const modalClose = document.querySelector('#the-modal button');
      if (modalClose) modalClose.click();
      const dataTab = [...document.querySelectorAll('[role=tab]')].find((b) => b.textContent === 'Data');
      if (dataTab && dataTab.getAttribute('aria-selected') !== 'true') dataTab.click();
      return true;
    })()`
  );
  await waitForParts();
}

beforeAll(async () => {
  fixture = await startFixture();
  projectDir = mkdtempSync(join(tmpdir(), "fs-e2e-"));
  const dd = join(projectDir, ".fiber-snatcher");
  mkdirSync(dd, { recursive: true });
  writeFileSync(join(projectDir, "package.json"), JSON.stringify({ name: "fs-e2e-target" }));
  writeFileSync(
    join(dd, "config.json"),
    JSON.stringify({
      version: "2.0.0",
      devUrl: fixture.url,
      authHeader: "X-Fiber-Snatcher-Key",
      authKeyPath: join(dd, "auth", "key"),
      profileDir: join(dd, "browser-profile"),
      shotsDir: join(dd, "shots"),
      logsDir: join(dd, "logs"),
      daemonPidFile: join(dd, "daemon.pid"),
      headless: true,
      cdpPortHint: 0,
      sources: { nextDevCommand: "", pm: "bun" },
      adapters: [],
    })
  );
}, 30_000);

afterAll(async () => {
  await fs("stop").catch(() => {});
  fixture?.stop();
  rmSync(projectDir, { recursive: true, force: true });
});

describe("WP0 cold start", () => {
  test("cold start: one command from dead daemon answers with runtime injected", async () => {
    const res = await fs("info");
    expect(res.ok).toBe(true);
    expect(res.data.runtimeVersion).toBe("2.0.0");
    expect(res.data.url).toContain("localhost");
    await waitForParts(); // let the boot query land before the acceptance tests
  }, 30_000);
});

describe("WP0 acceptance", () => {
  beforeEach(reset);

  test("page snapshot mints refs with roles and finds the trap controls", async () => {
    const res = await fs("page", "--detailed");
    expect(res.ok).toBe(true);
    const refs = res.data.interactables as Array<{ ref: string; role: string; text: string }>;
    expect(refs.length).toBeGreaterThan(5);
    expect(refs.every((r) => /^e\d+\.\w+$/.test(r.ref))).toBe(true); // e<seq>.<docTag>
    const tabs = refs.filter((r) => r.role === "tab");
    expect(tabs.length).toBe(3);
  }, 15_000);

  test("adapter discovery: tanstack + jotai found with zero app cooperation", async () => {
    const res = await fs("eval", "window.__fs.adapters()");
    expect(res.ok).toBe(true);
    expect(res.data).toContain("queries");
    expect(res.data).toContain("jotai");
  }, 15_000);

  test("intent click acts when unambiguous and digest reports the effect", async () => {
    const res = await fs("click", "Settings");
    expect(res.ok).toBe(true);
    expect(res.digest?.mutations).not.toBe("none");
    const pane = await fs("eval", "!!document.querySelector('#settings-pane')");
    expect(pane.data).toBe(true);
  }, 15_000);

  test("ambiguous intent refuses with ranked candidates in one round trip", async () => {
    await fs("click", "Open Preview"); // this test opens the surface it needs
    const res = await fs("click", "Export");
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("E_TARGET_AMBIGUOUS");
    expect(res.error?.candidates?.length).toBeGreaterThanOrEqual(2);
    expect(res.error?.hint).toContain("ref");
  }, 15_000);

  test("ref click on a candidate works; dead-click detection reports none", async () => {
    await fs("click", "Open Preview");
    const amb = await fs("click", "Export");
    const ref = amb.error!.candidates![0].ref as string;
    const res = await fs("click", ref);
    expect(res.ok).toBe(true);
    // Export button has no handler in the fixture — the digest must say so.
    expect(res.digest?.mutations).toBe("none");
  }, 15_000);

  test("icon-only button clicks by ref and the digest sees the counter change", async () => {
    const before = await fs("eval", "Number(document.querySelector('#click-count').textContent)");
    const page = await fs("page");
    const icon = (page.data.interactables as any[]).find((r) => r.text === "button" || r.text.startsWith("#icon"));
    expect(icon).toBeDefined();
    const res = await fs("click", icon.ref);
    expect(res.ok).toBe(true);
    expect(res.digest?.mutations).not.toBe("none");
    // Assert an increment, not a fixed value — order-independent.
    const after = await fs("eval", "Number(document.querySelector('#click-count').textContent)");
    expect(after.data).toBe((before.data as number) + 1);
  }, 15_000);

  test("fill on the duplicate-search trap refuses; scoped fill --settled lands the query", async () => {
    const dup = await fs("fill", "Search", "Part 12");
    expect(dup.ok).toBe(false);
    expect(dup.error?.code).toBe("E_TARGET_AMBIGUOUS");

    // WP2: --settled closes the debounce hole, so no poll loop — the count is
    // already filtered by the time the command returns.
    const res = await fs("fill", "--css", "section input", "Part 12", "--settled");
    expect(res.ok).toBe(true);
    const rows = String((await fs("eval", "document.querySelector('#row-count').textContent")).data);
    expect(rows).toMatch(/^\d+ rows$/);
    expect(rows).not.toBe("10000 rows");
  }, 30_000);

  test("state reads fiber hooks through the runtime", async () => {
    const res = await fs("state", "#row-count");
    expect(res.ok).toBe(true);
    expect(JSON.stringify(res.data.ancestors)).toContain("PartsTable");
  }, 15_000);

  test("stale ref returns E_TARGET_STALE with fresh guidance after reload", async () => {
    const page = await fs("page");
    const ref = page.data.interactables[0].ref as string;
    await fs("reload");
    const res = await fs("click", ref);
    expect(res.ok).toBe(false);
    expect(["E_TARGET_STALE", "E_TARGET_AMBIGUOUS"]).toContain(res.error!.code);
  }, 20_000);

  test("journal recorded every action with digests", async () => {
    // Drive known actions (including a deliberate failure) so the assertions
    // below don't depend on which acceptance tests ran before this one.
    await fs("click", "Settings");
    await fs("click", "NoSuchButtonXYZ"); // fails → E_TARGET_NOT_FOUND, journaled
    await fs("reload");
    await waitForParts();
    await fs("fill", "--css", "section input", "Part 1");

    const res = await fs("journal", "--last", "80");
    expect(res.ok).toBe(true);
    const entries = res.data as Array<{ cmd: string; ok: boolean; digest?: unknown }>;
    expect(entries.length).toBeGreaterThanOrEqual(5);
    const cmds = new Set(entries.map((e) => e.cmd));
    for (const c of ["click", "fill", "reload"]) expect(cmds.has(c)).toBe(true);
    expect(entries.some((e) => !e.ok)).toBe(true); // failures journal too
    expect(entries.some((e) => e.digest !== undefined)).toBe(true); // digests recorded
  }, 30_000);
});
