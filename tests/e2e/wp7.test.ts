/** WP7 acceptance: doctor (healthy + broken), routes (fake Next tree), thin
 *  state verbs (queries/count/atoms/dispatch), and remount detection. Drives the
 *  real CLI → daemon → fixture path. Each test self-establishes its precondition
 *  (no reliance on prior test order). */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTarget, type Target } from "./harness.ts";

const FS_BIN = new URL("../../bin/fs.ts", import.meta.url).pathname;

/** Run the CLI in an arbitrary cwd (for the config-less / dead-server targets
 *  that never boot a daemon). */
async function fsIn(dir: string, ...argv: string[]): Promise<string> {
  const proc = Bun.spawn(["bun", FS_BIN, ...argv], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out;
}

let t: Target;

beforeAll(async () => {
  t = await startTarget();
  // Seed a fake Next App Router tree in the target so `routes` has something to
  // read (the daemon's cwd is this dir).
  const app = join(t.dir, "src", "app");
  const write = (rel: string) => {
    const p = join(app, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, "export default function P(){return null}");
  };
  write("page.tsx");
  write("jobs/page.tsx");
  write("jobs/[jobId]/page.tsx");
  write("(marketing)/about/page.tsx");
  write("blog/[...slug]/page.tsx");
  mkdirSync(join(app, "settings"), { recursive: true });
  writeFileSync(join(app, "settings", "layout.tsx"), "export default function L(){return null}"); // no page => no route

  // Cold-boot once and let the initial query land.
  const info = await t.fs("info");
  expect(info.ok).toBe(true);
  for (let i = 0; i < 20; i++) {
    const r = await t.fs("eval", "document.querySelector('#row-count')?.textContent ?? ''");
    if (String(r.data).includes("rows")) break;
    await new Promise((r) => setTimeout(r, 200));
  }
}, 40_000);

afterAll(async () => {
  await t.stop();
});

describe("WP7 doctor", () => {
  test("healthy target: every probe passes", async () => {
    const res = await t.fs("doctor");
    expect(res.ok).toBe(true);
    expect(res.data.healthy).toBe(true);
    const byName = Object.fromEntries((res.data.probes as any[]).map((p) => [p.name, p]));
    expect(byName.config.status).toBe("ok");
    expect(byName["dev-server"].status).toBe("ok");
    expect(byName["v2-daemon"].status).toBe("ok");
    expect(byName["runtime-match"].status).toBe("ok");
    expect(byName.adapters.detail).toContain("queries");
  }, 20_000);

  test("uninitialized project: config probe fails, exit non-zero", async () => {
    const bare = mkdtempSync(join(tmpdir(), "fs-doctor-bare-"));
    writeFileSync(join(bare, "package.json"), "{}");
    const out = await fsIn(bare, "doctor");
    expect(out).toContain("config");
    expect(out).toMatch(/config\s+no \.fiber-snatcher/);
    expect(out).toContain("unhealthy");
    rmSync(bare, { recursive: true, force: true });
  }, 15_000);

  test("dead dev server: dev-server fails, daemon-dependent probes skip (no boot)", async () => {
    const broken = mkdtempSync(join(tmpdir(), "fs-doctor-broken-"));
    const dd = join(broken, ".fiber-snatcher");
    mkdirSync(dd, { recursive: true });
    writeFileSync(join(broken, "package.json"), "{}");
    writeFileSync(
      join(dd, "config.json"),
      JSON.stringify({
        version: "2.0.0",
        devUrl: "http://localhost:1", // nothing serves here
        authHeader: "X-Fiber-Snatcher-Key",
        authKeyPath: join(dd, "auth", "key"),
        profileDir: join(dd, "browser-profile"),
        shotsDir: join(dd, "shots"),
        logsDir: join(dd, "logs"),
        daemonPidFile: join(dd, "daemon.pid"),
        headless: true,
        cdpPortHint: 0,
        sources: { nextDevCommand: "npm run dev", pm: "bun" },
        adapters: [],
      })
    );
    const raw = await fsIn(broken, "doctor", "--json");
    const parsed = JSON.parse(raw) as { ok: boolean; data: { healthy: boolean; probes: any[] } };
    const byName = Object.fromEntries(parsed.data.probes.map((p) => [p.name, p]));
    expect(parsed.data.healthy).toBe(false);
    expect(byName["dev-server"].status).toBe("fail");
    expect(byName["v2-daemon"].status).toBe("warn"); // down, not booted
    expect(byName["runtime-match"].status).toBe("skip");
    rmSync(broken, { recursive: true, force: true });
  }, 15_000);

  test("daemon parked on a blank page: page probes skip, not fail", async () => {
    await t.fs("navigate", "about:blank");
    const res = await t.fs("doctor");
    const byName = Object.fromEntries((res.data.probes as any[]).map((p) => [p.name, p]));
    expect(byName["v2-daemon"].status).toBe("ok"); // daemon itself is reachable
    expect(byName["page-url"].status).toBe("warn"); // ...but on a blank page
    expect(byName["runtime-match"].status).toBe("skip");
    expect(byName.adapters.status).toBe("skip");
    // Restore the fixture page for the describes that follow.
    await t.fs("navigate");
    for (let i = 0; i < 20; i++) {
      const r = await t.fs("eval", "document.querySelector('#row-count')?.textContent ?? ''");
      if (String(r.data).includes("rows")) break;
      await new Promise((r) => setTimeout(r, 200));
    }
  }, 20_000);
});

describe("WP7 routes", () => {
  test("reads the fake App Router tree; groups stripped, dynamic kept", async () => {
    const res = await t.fs("routes");
    expect(res.ok).toBe(true);
    expect(res.data.router).toBe("app");
    const routes = res.data.routes as string[];
    expect(routes).toContain("/");
    expect(routes).toContain("/jobs");
    expect(routes).toContain("/jobs/[jobId]");
    expect(routes).toContain("/about"); // (marketing) group stripped
    expect(routes).toContain("/blog/[...slug]");
    expect(routes).not.toContain("/settings"); // layout only, no page
    expect(res.data.dynamic).toContain("/jobs/[jobId]");
  }, 15_000);
});

describe("WP7 state verbs", () => {
  test("queries lists the parts query and filters by key substring", async () => {
    const all = await t.fs("queries");
    expect(all.ok).toBe(true);
    expect(Array.isArray(all.data)).toBe(true);
    expect(all.data.length).toBeGreaterThan(0);
    expect(all.data[0].key).toBeDefined(); // WP1: adapter results keep the query key



    const parts = await t.fs("queries", "parts");
    expect(parts.ok).toBe(true);
    expect(parts.data.length).toBeGreaterThan(0);

    const none = await t.fs("queries", "zzz-no-such-key");
    expect(none.ok).toBe(true);
    expect(none.data.length).toBe(0);
  }, 15_000);

  test("count returns the rendered DOM row count", async () => {
    const res = await t.fs("count", "table tbody tr");
    expect(res.ok).toBe(true);
    expect(res.data).toBe(50); // fixture renders rows.slice(0,50)
  }, 15_000);

  test("atoms returns an array (jotai adapter present; dev store may be absent)", async () => {
    const res = await t.fs("atoms");
    expect(res.ok).toBe(true);
    expect(Array.isArray(res.data)).toBe(true);
  }, 15_000);

  test("dispatch runs a JSON adapter action; bad JSON is E_BAD_ARGS", async () => {
    const ok = await t.fs("dispatch", '{"op":"invalidate","key":["parts",""]}', "--adapter", "queries");
    expect(ok.ok).toBe(true);
    expect((ok.data as any).ok).toBe(true);

    const bad = await t.fs("dispatch", "not-json");
    expect(bad.ok).toBe(false);
    expect(bad.error?.code).toBe("E_BAD_ARGS");
  }, 15_000);
});

describe("WP7 remount", () => {
  beforeEach(async () => {
    // Reset to a known document so the sentinel arms on a live React root.
    await t.fs("reload");
    for (let i = 0; i < 20; i++) {
      const r = await t.fs("eval", "document.querySelector('#row-count')?.textContent ?? ''");
      if (String(r.data).includes("rows")) break;
      await new Promise((r) => setTimeout(r, 200));
    }
  });

  test("arms a sentinel and counts a root remount", async () => {
    const armed = await t.fs("remount");
    expect(armed.ok).toBe(true);
    expect(armed.data.armed).toBe(true);
    expect(armed.data.remounts).toBe(0);

    // Simulate a full Fast Refresh: replace the watched container's child node.
    const trig = await t.fs(
      "eval",
      "(()=>{const c=window.__fsRemount.container;const n=document.createElement('main');c.replaceChild(n,c.firstElementChild);return true;})()"
    );
    expect(trig.data).toBe(true);
    await new Promise((r) => setTimeout(r, 200));

    const read = await t.fs("remount");
    expect(read.data.remounts).toBe(1);
    expect(read.data.lastAt).toBeGreaterThan(0);
  }, 30_000);
});
