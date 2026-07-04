/** WP6 acceptance: network intercept + watches. Drives the real CLI -> daemon ->
 *  fixture, whose NetParts widget makes a real fetch to /api/parts. The
 *  load-bearing claims:
 *   - `mock` swaps that response and the UI renders the mock data;
 *   - `mock list` reports active mocks with hit counts; `unmock` clears them;
 *   - `throttle <preset>` applies (and `off` restores) a network profile;
 *   - `wait --call` resolves both for a request that already fired and for an
 *     upcoming one;
 *   - `watch network|console` stream events over server-push to a live CLI;
 *   - under `profile verify`, a request that 500s fails the action that fired it.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startTarget, type Target } from "./harness.ts";

let t: Target;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  t = await startTarget();
  const info = await t.fs("info");
  expect(info.ok).toBe(true);
  await t.fs("wait", "--settled"); // let the NetParts boot fetch settle
}, 45_000);

afterAll(async () => {
  await t.stop();
});

describe("WP6 network + watches", () => {
  test("the registry exposes the network verbs", async () => {
    const acts = await t.fs("actions");
    const names = (acts.data as Array<{ name: string }>).map((a) => a.name);
    expect(names).toContain("mock");
    expect(names).toContain("unmock");
    expect(names).toContain("throttle");
    expect(names).toContain("wait-call");
  }, 20_000);

  test("mock swaps the API response and the UI renders the mock data", async () => {
    await t.fs("unmock", "--all");
    const m = await t.fs("mock", "**/api/parts", "--body", '[{"id":1,"name":"Mock A","status":"ok"},{"id":2,"name":"Mock B","status":"ok"}]');
    expect(m.ok).toBe(true);
    expect(String(m.data.mocked)).toContain("api/parts");
    // Drive the UI against the mock: refetch → the widget's fetch is intercepted.
    await t.fs("click", "--css", "#net-refetch", "--settled");
    const count = await t.fs("eval", "document.getElementById('net-count').textContent");
    expect(count.data).toBe("2");
    await t.fs("unmock", "--all");
  }, 30_000);

  test("mock list reports active mocks with hit counts; unmock clears", async () => {
    await t.fs("unmock", "--all");
    await t.fs("mock", "**/api/parts", "--body", "[]");
    await t.fs("click", "--css", "#net-refetch", "--settled"); // one hit
    const list = await t.fs("mock", "list");
    const entry = (list.data.mocks as Array<{ pattern: string; hits: number }>).find((mm) => mm.pattern.includes("api/parts"));
    expect(entry).toBeDefined();
    expect(entry!.hits).toBeGreaterThanOrEqual(1);
    const un = await t.fs("unmock", "--all");
    expect(un.data.unmocked).toBeGreaterThanOrEqual(1);
    const after = await t.fs("mock", "list");
    expect(after.data.mocks.length).toBe(0);
  }, 30_000);

  test("throttle applies a preset and off restores", async () => {
    await t.fs("unmock", "--all");
    const th = await t.fs("throttle", "3g");
    expect(th.ok).toBe(true);
    expect(th.data.throttle).toBe("3g");
    // The real API still resolves under throttle (just slower).
    await t.fs("click", "--css", "#net-refetch", "--settled");
    const count = await t.fs("eval", "document.getElementById('net-count').textContent");
    expect(Number(count.data)).toBeGreaterThan(0);
    const off = await t.fs("throttle", "off");
    expect(off.data.throttle).toBe("off");
    const bad = await t.fs("throttle", "hyperloop");
    expect(bad.ok).toBe(false);
    expect(bad.error.code).toBe("E_BAD_ARGS");
  }, 30_000);

  test("wait --call resolves for a request that already fired", async () => {
    await t.fs("unmock", "--all");
    await t.fs("throttle", "off");
    await t.fs("click", "--css", "#net-refetch", "--settled"); // GET /api/parts fires
    const w = await t.fs("wait", "--call", "**/api/parts", "--timeout", "2000");
    expect(w.ok).toBe(true);
    expect(w.data.fired).toBe(true);
    expect(String(w.data.url)).toContain("/api/parts");
    expect(w.data.when).toBe("already");
  }, 30_000);

  test("wait --call resolves for an upcoming (deferred) request", async () => {
    await t.fs("click", "--css", "#net-deferred"); // arms a fetch ~600ms out
    const w = await t.fs("wait-call", "deferred=1", "--timeout", "3000");
    expect(w.ok).toBe(true);
    expect(w.data.fired).toBe(true);
    expect(String(w.data.url)).toContain("deferred=1");
  }, 30_000);

  test("wait --call times out with a shaped error and page state", async () => {
    const w = await t.fs("wait-call", "**/never-fires-xyz", "--timeout", "800");
    expect(w.ok).toBe(false);
    expect(w.error.code).toBe("E_WAIT_TIMEOUT");
    // The pipeline attaches what WAS on screen so the agent re-plans.
    expect(w.digest).toBeDefined();
  }, 20_000);

  test("watch network streams a request as it fires", async () => {
    await t.fs("unmock", "--all");
    const watchProm = t.fsRaw("watch", "network", "**/api/parts", "--for", "3000");
    await sleep(900); // let the subscription register
    await t.fs("click", "--css", "#net-refetch");
    const out = await watchProm;
    expect(out).toContain("/api/parts");
    expect(out).toMatch(/net (request|response)/);
  }, 30_000);

  test("watch console streams a console error live", async () => {
    const watchProm = t.fsRaw("watch", "console", "--for", "3000");
    await sleep(900);
    await t.fs("eval", "console.error('watch-console-boom')");
    const out = await watchProm;
    expect(out).toContain("watch-console-boom");
    expect(out).toMatch(/console \[error\]/);
  }, 30_000);

  test("profile verify fails an action whose request 500s", async () => {
    await t.fs("unmock", "--all");
    await t.fs("mock", "**/api/parts", "--status", "500");
    await t.fs("profile", "verify");
    const res = await t.fs("click", "--css", "#net-refetch");
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe("E_INTERNAL");
    expect(res.error.message).toMatch(/verify/i);
    expect((res.digest!.errors ?? []).join(" ")).toMatch(/500/);
    // cleanup so the shared daemon is left in a neutral state
    await t.fs("profile", "explore");
    await t.fs("unmock", "--all");
  }, 30_000);
});
