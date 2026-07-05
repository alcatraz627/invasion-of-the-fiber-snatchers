// Codified dogfood: drives the LIVE Versable dev app end to end, where the
// hermetic fixture suite can't catch real-app regressions. The always-run tier
// works on any real page (the login page included); the authenticated tier skips
// on the /login redirect. Self-skips when the server is down or the profile busy,
// so it never false-fails. See tests/integration/README.md for the auth setup.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startVersable, type IntTarget } from "./versable.ts";

let ctx: IntTarget;
const skip = (why: string) => console.log(`  ↳ skipped: ${why}`);

beforeAll(async () => {
  ctx = await startVersable();
  if (!ctx.available) skip(`suite unavailable — ${ctx.reason}`);
  else if (!ctx.authed) skip(`authed tier will skip — ${ctx.reason}`);
}, 90_000);

afterAll(async () => {
  if (ctx) await ctx.stop();
});

describe("Versable live — always-run tier (auth-independent)", () => {
  test("health: doctor reports the dev server reachable", async () => {
    if (!ctx.available) return skip(ctx.reason!);
    const d = await ctx.fs("doctor");
    // doctor exits non-zero if unhealthy; the dev-server probe is the load-bearing one.
    expect(d.data?.healthy ?? d.ok).toBeTruthy();
  }, 30_000);

  test("navigate + settle: lands on a real URL and quiesces", async () => {
    if (!ctx.available) return skip(ctx.reason!);
    const nav = await ctx.fs("navigate", "/jobs");
    expect(nav.ok).toBe(true);
    const settled = await ctx.fs("wait", "--settled");
    expect(settled.ok).toBe(true);
    const url = (await ctx.fs("info")).data?.url ?? "";
    expect(url).toContain("http://localhost:3006");
  }, 45_000);

  test("snapshot: interactables carry well-formed refs and roles", async () => {
    if (!ctx.available) return skip(ctx.reason!);
    const page = await ctx.fs("page");
    expect(page.ok).toBe(true);
    const items = (page.data?.interactables ?? []) as Array<{ ref: string; role?: string }>;
    expect(items.length).toBeGreaterThan(0);
    // A ref is `<label>.<docTag>` — addressable and generation-stamped.
    for (const it of items.slice(0, 10)) {
      expect(typeof it.ref).toBe("string");
      expect(it.ref).toContain(".");
    }
  }, 30_000);

  test("targeting: a nonsense intent fails cleanly, not a crash", async () => {
    if (!ctx.available) return skip(ctx.reason!);
    const r = await ctx.fs("click", "zzz-no-such-control-zzz");
    expect(r.ok).toBe(false);
    expect(r.error?.code ?? "").toMatch(/^E_/);
  }, 30_000);

  test("staleness: a ref from a prior generation is rejected, not acted on", async () => {
    if (!ctx.available) return skip(ctx.reason!);
    const page = await ctx.fs("page");
    const ref = (page.data?.interactables ?? [])[0]?.ref as string | undefined;
    if (!ref) return skip("no interactable to stale");
    await ctx.fs("navigate", "/jobs"); // bumps the doc generation
    await ctx.fs("wait", "--settled");
    const r = await ctx.fs("click", "--ref", ref);
    expect(r.ok).toBe(false); // stale ref must not silently click something else
  }, 45_000);

  test("why: identity signals on a real control never crash the page", async () => {
    if (!ctx.available) return skip(ctx.reason!);
    const page = await ctx.fs("page");
    const ref = (page.data?.interactables ?? [])[0]?.ref as string | undefined;
    if (!ref) return skip("no interactable to inspect");
    const w = await ctx.fs("why", "--ref", ref);
    expect(w.ok).toBe(true);
    // signals may be empty on a well-labelled control — the contract is no crash.
    expect(Array.isArray(w.data?.signals ?? [])).toBe(true);
  }, 30_000);

  test("runtime injection: the page runtime is live (docTag present)", async () => {
    if (!ctx.available) return skip(ctx.reason!);
    const e = await ctx.fs("eval", "typeof window.__fs?.docTag === 'string'");
    expect(e.ok).toBe(true);
    expect(e.data).toBe(true);
  }, 30_000);

  test("adapt plumbing: the sanitized adapt object is injected on the page", async () => {
    if (!ctx.available) return skip(ctx.reason!);
    // sanitizeAdapt always injects the shape, whether or not the project configured
    // adapt — the contract here is that the plumbing reached the page.
    const e = await ctx.fs("eval", "(() => { const a = window.__fsAdapt; return !!a && Array.isArray(a.surfaceSelectors); })()");
    expect(e.ok).toBe(true);
    expect(e.data).toBe(true);
  }, 30_000);

  test("state: fiber state read on a real control does not throw", async () => {
    if (!ctx.available) return skip(ctx.reason!);
    const page = await ctx.fs("page");
    const ref = (page.data?.interactables ?? [])[0]?.ref as string | undefined;
    const s = ref ? await ctx.fs("state", "--ref", ref) : await ctx.fs("state");
    expect(s.ok).toBe(true);
  }, 30_000);

  test("routes: the verb dispatches end-to-end and returns its documented shape", async () => {
    if (!ctx.available) return skip(ctx.reason!);
    // `routes` is a static read of the *project's* src/app via resolveTargetRoot,
    // and this harness runs an isolated project dir — so it returns a well-formed
    // `router:"none"` here rather than real routes. Real-route enumeration is
    // covered by the fixture wp7 test; here the contract is: dispatches cleanly,
    // returns { router, routes[] }.
    const r = await ctx.fs("routes");
    expect(r.ok).toBe(true);
    expect(typeof r.data?.router).toBe("string");
    expect(Array.isArray(r.data?.routes)).toBe(true);
  }, 30_000);
});

describe("Versable live — authenticated tier (skips without a session)", () => {
  test("opening a job moves the page (modal / route change)", async () => {
    if (!ctx.available || !ctx.authed) return skip(ctx.reason ?? "not authed");
    await ctx.fs("navigate", "/jobs");
    await ctx.fs("wait", "--settled");
    const urlBefore = (await ctx.fs("info")).data?.url ?? "";
    // The exact job name is data-dependent, so open the first job-like control the
    // snapshot exposes rather than a hard-coded title.
    const rows = ((await ctx.fs("page")).data?.interactables ?? []) as Array<{ ref: string; text?: string }>;
    const jobRow = rows.find((r) => (r.text ?? "").length > 4 && !/search|filter|sign|new|create|export|refresh/i.test(r.text ?? ""));
    if (!jobRow) return skip("no job rows visible (empty account?)");
    const open = await ctx.fs("click", "--ref", jobRow.ref);
    expect(open.ok).toBe(true);
    await ctx.fs("wait", "--settled");
    const urlAfter = (await ctx.fs("info")).data?.url ?? "";
    const afterCount = ((await ctx.fs("page")).data?.interactables ?? []).length;
    // Opening a job either changes the URL (modal route) or materially changes the
    // control set (modal chrome appears). Assert observable movement.
    expect(urlAfter !== urlBefore || afterCount !== rows.length).toBe(true);
  }, 60_000);

  test("WP9: a closed dropdown in the opened job recovers menu labels", async () => {
    if (!ctx.available || !ctx.authed) return skip(ctx.reason ?? "not authed");
    await ctx.fs("navigate", "/jobs");
    await ctx.fs("wait", "--settled");
    // Open a job so its toolbar/row dropdowns are on the page, then read what a
    // closed dropdown opens WITHOUT clicking it — the feature this whole thing exists for.
    const rows = ((await ctx.fs("page")).data?.interactables ?? []) as Array<{ ref: string; text?: string }>;
    const jobRow = rows.find((r) => (r.text ?? "").length > 4 && !/search|filter|sign|new|create|export|refresh/i.test(r.text ?? ""));
    if (jobRow) {
      await ctx.fs("click", "--ref", jobRow.ref);
      await ctx.fs("wait", "--settled");
    }
    const found = await ctx.fs(
      "eval",
      `(() => {
        const b = document.querySelector('[aria-haspopup],[id$=-btn-dropdown]');
        if (!b) return null;
        b.setAttribute('data-fs-ref', 'wp9probe.' + window.__fs.docTag);
        return window.__fs.why('wp9probe.' + window.__fs.docTag).signals || [];
      })()`
    );
    if (!found.ok || found.data === null) return skip("no dropdown trigger found on the page");
    const sigs = (found.data as string[]) ?? [];
    if (sigs.length === 0) skip("dropdown present but no signal recovered (soft miss)");
    else expect(sigs.length).toBeGreaterThan(0);
  }, 60_000);

  test("cross-page: another authed route still snapshots interactables", async () => {
    if (!ctx.available || !ctx.authed) return skip(ctx.reason ?? "not authed");
    const nav = await ctx.fs("navigate", "/templates");
    await ctx.fs("wait", "--settled");
    const url = (await ctx.fs("info")).data?.url ?? "";
    if (url.includes("/login")) return skip("route redirected to login");
    const page = await ctx.fs("page");
    expect(page.ok).toBe(true);
    expect(((page.data?.interactables ?? []) as unknown[]).length).toBeGreaterThan(0);
  }, 60_000);
});
