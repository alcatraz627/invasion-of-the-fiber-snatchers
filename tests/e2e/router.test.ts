/** Built-in React Router adapter: the runtime discovers a data router exposed
 *  at window.__reactRouterDataRouter, feeds its navigation/fetcher activity to
 *  settle, exposes state + navigate/revalidate via dispatch, and answers the
 *  `routes` verb from the live route table on non-Next apps. Exercised against
 *  the fixture's fake router (shape-matched to the real v7 dev global); the
 *  real-framework pass happens in the live-app integration tier. */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startTarget, type Target } from "./harness.ts";

describe("react-router adapter", () => {
  let t: Target;
  beforeAll(async () => {
    t = await startTarget();
    await t.fs("navigate", "/");
    await t.fs("wait", "--settled");
  });
  afterAll(async () => {
    await t.stop();
  });

  test("router is discovered and readable", async () => {
    const res = await t.fs("dispatch", "--adapter", "router", '{"op":"list"}');
    expect(res.ok).toBe(true);
    expect(res.data?.navigation).toBe("idle");
    expect(res.data?.loaderData?.root?.seeded).toBe(true);
  });

  test("router navigation activity holds the drain until loaders settle", async () => {
    const t0 = Date.now();
    const res = await t.fs("dispatch", "--adapter", "router", '{"op":"navigate","to":"/parts"}');
    const elapsed = Date.now() - t0;
    expect(res.ok).toBe(true);
    // The fake holds a 600ms loading window; the mutating verb's drain must
    // outlast it and report the truth.
    expect(res.digest?.queries).toBe("settled");
    expect(elapsed).toBeGreaterThan(500);
    const after = await t.fs("dispatch", "--adapter", "router", '{"op":"list"}');
    expect(after.data?.location).toBe("/parts");
  });

  test("routes verb reads the live route table on a non-Next target", async () => {
    const res = await t.fs("routes");
    expect(res.ok).toBe(true);
    expect(res.data?.router).toBe("react-router");
    expect(res.data?.routes ?? []).toContain("/parts/:id");
    expect(res.data?.dynamic ?? []).toContain("/parts/:id");
  });

  test("revalidate is dispatchable and settles", async () => {
    const res = await t.fs("dispatch", "--adapter", "router", '{"op":"revalidate"}');
    expect(res.ok).toBe(true);
    expect(res.digest?.queries).toBe("settled");
  });

  test("started counter sees a busy cycle that begins and ends between polls", async () => {
    // Drive a full loading→idle cycle synchronously through the fake's notify —
    // by construction inside one poll gap, so only the subscription's edge
    // counter can have seen it. A point-in-time pending read never will.
    const before = await t.fs("eval", "window.__fs.queriesActivity().started");
    const blip = await t.fs(
      "eval",
      "(() => { const r = window.__reactRouterDataRouter; r.state.navigation = { state: 'loading' }; r._notify(); r.state.navigation = { state: 'idle' }; r._notify(); return true; })()"
    );
    expect(blip.ok).toBe(true);
    const after = await t.fs("eval", "window.__fs.queriesActivity().started");
    expect(Number(after.data)).toBeGreaterThan(Number(before.data));
  });

  // Keep this LAST: it replaces the page's router global for the target's life.
  test("a hot-swapped router global is re-bound on the next call", async () => {
    const swap = await t.fs(
      "eval",
      "(() => { window.__reactRouterDataRouter = { state: { location: { pathname: '/swapped', search: '' }, navigation: { state: 'idle' }, fetchers: new Map(), matches: [], loaderData: {} }, routes: [], subscribe: () => () => {}, navigate: () => {} }; return true; })()"
    );
    expect(swap.ok).toBe(true);
    const res = await t.fs("dispatch", "--adapter", "router", '{"op":"list"}');
    expect(res.ok).toBe(true);
    expect(res.data?.location).toBe("/swapped");
  });
});
