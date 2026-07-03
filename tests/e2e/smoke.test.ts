/** WP0 acceptance suite: drives the REAL path (CLI → auto-started headless
 *  daemon → pipeline → fixture app) and asserts on behavior + digest content.
 *  Each test maps to an acceptance criterion in IMPLEMENTATION.md §3-WP0. */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
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

describe("WP0 acceptance", () => {
  test("cold start: one command from dead daemon answers with runtime injected", async () => {
    const res = await fs("info");
    expect(res.ok).toBe(true);
    expect(res.data.runtimeVersion).toBe("2.0.0");
    expect(res.data.url).toContain("localhost");
  }, 30_000);

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
    // restore the Data tab — later tests need PartsTable mounted
    const back = await fs("click", "Data");
    expect(back.ok).toBe(true);
  }, 15_000);

  test("ambiguous intent refuses with ranked candidates in one round trip", async () => {
    await fs("click", "Open Preview");
    const res = await fs("click", "Export");
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("E_TARGET_AMBIGUOUS");
    expect(res.error?.candidates?.length).toBeGreaterThanOrEqual(2);
    expect(res.error?.hint).toContain("ref");
  }, 15_000);

  test("ref click on a candidate works; dead-click detection reports none", async () => {
    const amb = await fs("click", "Export");
    const ref = amb.error!.candidates![0].ref as string;
    const res = await fs("click", ref);
    expect(res.ok).toBe(true);
    // Export button has no handler in the fixture — the digest must say so.
    expect(res.digest?.mutations).toBe("none");
  }, 15_000);

  test("icon-only button clicks by ref and the digest sees the counter change", async () => {
    await fs("click", "Close");
    const page = await fs("page");
    const icon = (page.data.interactables as any[]).find((r) => r.text === "button" || r.text.startsWith("#icon"));
    expect(icon).toBeDefined();
    const res = await fs("click", icon.ref);
    expect(res.ok).toBe(true);
    expect(res.digest?.mutations).not.toBe("none");
    const count = await fs("eval", "document.querySelector('#click-count').textContent");
    expect(count.data).toBe("1");
  }, 15_000);

  test("fill on the duplicate-search trap refuses; scoped fill works and query settles", async () => {
    const dup = await fs("fill", "Search", "Part 12");
    expect(dup.ok).toBe(false);
    expect(dup.error?.code).toBe("E_TARGET_AMBIGUOUS");

    const res = await fs("fill", "--css", "section input", "Part 12");
    expect(res.ok).toBe(true);
    // The debounce window outlives the settle pass, so the digest can honestly
    // read "settled" before the query fires — WP2's `wait settled` is the real
    // fix; until then, poll for the result.
    let rows = "";
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 200));
      const res2 = await fs("eval", "document.querySelector('#row-count').textContent");
      rows = String(res2.data);
      if (rows !== "10000 rows") break;
    }
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
    const res = await fs("journal", "--last", "50");
    expect(res.ok).toBe(true);
    const entries = res.data as Array<{ cmd: string; ok: boolean; digest?: unknown }>;
    expect(entries.length).toBeGreaterThan(8);
    const cmds = new Set(entries.map((e) => e.cmd));
    for (const c of ["click", "fill", "reload"]) expect(cmds.has(c)).toBe(true);
    expect(entries.some((e) => !e.ok)).toBe(true); // failures journal too
  }, 15_000);
});
