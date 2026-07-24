/** Project-local adapters: a `.fiber-snatcher/adapter.js` in the target project
 *  is injected on every document, can register a custom adapter, and — via the
 *  generalized activity contract — can feed the settle signal, so `--settled`
 *  is honest on apps whose async work is not TanStack. A broken adapter file
 *  must never take the target app down with it. */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startTarget, type Target } from "./harness.ts";

/** Registers a "demo" adapter with a fake work queue: dispatch startWork holds
 *  `pending` up for `ms`, and activity() exposes the {pending, started} shape
 *  the settle loop polls. The runtime bundle is injected before this script,
 *  so window.__fs exists; the retry loop is belt-and-braces only. */
const DEMO_ADAPTER = `
(() => {
  let pending = 0;
  let started = 0;
  const tryReg = () => {
    const fs = window.__fs;
    if (!fs || typeof fs.register !== "function") return false;
    fs.register("demo", {
      getState: () => ({ pending, started }),
      dispatch: (a) => {
        const op = a && a.op;
        if (op === "echo") return { echo: a && a.value };
        if (op === "startWork") {
          started++;
          pending++;
          setTimeout(() => { pending--; }, (a && a.ms) || 500);
          return { ok: true, ms: (a && a.ms) || 500 };
        }
        throw new Error("demo: unknown op " + op);
      },
      activity: () => ({ pending, started }),
    });
    return true;
  };
  if (!tryReg()) {
    let tries = 0;
    const t = setInterval(() => { if (tryReg() || ++tries > 50) clearInterval(t); }, 100);
  }
})();
`;

describe("project adapter injection + generalized activity", () => {
  let t: Target;
  beforeAll(async () => {
    t = await startTarget({ adapterJs: DEMO_ADAPTER });
    await t.fs("navigate", "/");
    await t.fs("wait", "--settled"); // fixture's own TanStack query goes quiet first
  });
  afterAll(async () => {
    await t.stop();
  });

  test("a registered project adapter is dispatchable by name", async () => {
    const res = await t.fs("dispatch", "--adapter", "demo", '{"op":"echo","value":42}');
    expect(res.ok).toBe(true);
    expect(res.data?.echo).toBe(42);
  });

  test("registered activity holds the mutating verb's drain, and the digest is honest", async () => {
    const t0 = Date.now();
    const kicked = await t.fs("dispatch", "--adapter", "demo", '{"op":"startWork","ms":1200}');
    const elapsed = Date.now() - t0;
    expect(kicked.ok).toBe(true);
    // The post-act drain waits out custom in-flight work exactly as it does
    // TanStack fetches; returning early with "settled" is the vacuous bug.
    expect(kicked.digest?.queries).toBe("settled");
    expect(elapsed).toBeGreaterThan(1000);
  });

  test("wait --settled sees custom pending work beyond the drain budget (no vacuous settle)", async () => {
    // Work that outlives the dispatch's own drain timeout (3s): the verb returns
    // with queries:"pending", and the residue is what wait --settled must
    // actually wait out — a vacuous settle would return within the 400ms grace.
    const kicked = await t.fs("dispatch", "--adapter", "demo", '{"op":"startWork","ms":5000}');
    expect(kicked.ok).toBe(true);
    expect(kicked.digest?.queries).toBe("pending");
    const t0 = Date.now();
    const res = await t.fs("wait", "--settled", "--timeout", "10000");
    const elapsed = Date.now() - t0;
    expect(res.ok).toBe(true);
    expect(elapsed).toBeGreaterThan(1000);
  }, 20_000); // 3s drain + ~2s residue outruns bun's 5s default test timeout

  test("adapter activity is visible alongside built-in discovery", async () => {
    const res = await t.fs("dispatch", "--adapter", "demo", '{"op":"echo","value":1}');
    expect(res.ok).toBe(true);
    // The fixture app carries TanStack + jotai; the demo adapter must coexist
    // with (not displace) the discovered ones.
    const doctor = await t.fs("doctor");
    const probes: Array<{ name: string; detail?: string }> = doctor.data?.probes ?? [];
    const adaptersProbe = probes.find((p) => p.name === "adapters");
    expect(adaptersProbe?.detail ?? "").toContain("demo");
    expect(adaptersProbe?.detail ?? "").toContain("queries");
  });
});

/** A careless adapter file must not break the tool: grabbing a built-in name,
 *  returning NaN/stringly activity counts, or throwing from activity() each
 *  degrade loudly (rejected, read as idle, named by doctor) — never silently. */
const HOSTILE_ADAPTER = `
(() => {
  const tryReg = () => {
    const fs = window.__fs;
    if (!fs || typeof fs.register !== "function") return false;
    try { fs.register("queries", { getState: () => ({ hijacked: true }), dispatch: () => ({ hijacked: true }) }); } catch {}
    fs.register("nanny", {
      getState: () => ({}),
      dispatch: () => ({ ok: true }),
      activity: () => ({ pending: NaN, started: "0" }),
    });
    fs.register("thrower", {
      getState: () => ({}),
      dispatch: () => ({ ok: true }),
      activity: () => { throw new Error("boom"); },
    });
    return true;
  };
  if (!tryReg()) {
    let tries = 0;
    const t = setInterval(() => { if (tryReg() || ++tries > 50) clearInterval(t); }, 100);
  }
})();
`;

describe("hostile project adapters (gate findings)", () => {
  let t: Target;
  beforeAll(async () => {
    t = await startTarget({ adapterJs: HOSTILE_ADAPTER });
    await t.fs("navigate", "/");
  });
  afterAll(async () => {
    await t.stop();
  });

  test("reserved name 'queries' cannot be clobbered — TanStack stays reachable", async () => {
    const res = await t.fs("dispatch", "--adapter", "queries", '{"op":"list"}');
    expect(res.ok).toBe(true);
    // The real TanStack snapshot is an array of queries, not the hijack object.
    expect(Array.isArray(res.data)).toBe(true);
  });

  test("NaN/stringly activity cannot jam settle page-wide", async () => {
    const t0 = Date.now();
    const res = await t.fs("wait", "--settled", "--timeout", "5000");
    const elapsed = Date.now() - t0;
    expect(res.ok).toBe(true);
    // A jammed aggregate (NaN never equals 0) burns the whole timeout; a
    // healthy sum settles within the quiet grace.
    expect(elapsed).toBeLessThan(3000);
  });

  test("a throwing activity() source is named by doctor", async () => {
    const doctor = await t.fs("doctor");
    const probes: Array<{ name: string; status: string; detail?: string }> = doctor.data?.probes ?? [];
    const act = probes.find((p) => p.name === "activity");
    expect(act?.status).toBe("warn");
    expect(act?.detail ?? "").toContain("thrower");
  });
});

describe("native <dialog> surfaces", () => {
  let t: Target;
  beforeAll(async () => {
    t = await startTarget();
    await t.fs("navigate", "/");
    await t.fs("wait", "--settled");
  });
  afterAll(async () => {
    await t.stop();
  });

  test("showModal()/close() surface deltas are digested with the dialog: kind", async () => {
    const opened = await t.fs("click", "Open native dialog");
    expect(opened.ok).toBe(true);
    expect(opened.digest?.surfaces?.opened ?? []).toContain("dialog:Native Dialog");
    const closed = await t.fs("click", "Dismiss native");
    expect(closed.ok).toBe(true);
    expect(closed.digest?.surfaces?.closed ?? []).toContain("dialog:Native Dialog");
  });
});

describe("broken project adapter file", () => {
  let t: Target;
  beforeAll(async () => {
    t = await startTarget({ adapterJs: "this is not javascript {{{" });
    await t.fs("navigate", "/");
  });
  afterAll(async () => {
    await t.stop();
  });

  test("a syntax-error adapter never bricks the page or the tool", async () => {
    const page = await t.fs("page");
    expect(page.ok).toBe(true);
    // The fixture app still renders and lists interactables.
    expect((page.data?.interactables ?? []).length).toBeGreaterThan(0);
    // And the built-in adapters still discover fine.
    const doctor = await t.fs("doctor");
    const probes: Array<{ name: string; detail?: string }> = doctor.data?.probes ?? [];
    const adaptersProbe = probes.find((p) => p.name === "adapters");
    expect(adaptersProbe?.detail ?? "").toContain("queries");
  });
});
