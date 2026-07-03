/**
 * WP0 spike: can the V2 page runtime be injected via addInitScript with zero
 * target-repo footprint, and can it discover store adapters without app-side
 * register() calls? Prints 6 pass/fail checks against a live dev app.
 * Run: bun scripts/spike-cdp-inject.ts <target-repo-with-.fiber-snatcher> [devUrl]
 */

import { chromium } from "playwright";
import { readFileSync, existsSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const targetRepo = process.argv[2];
if (!targetRepo) {
  console.error("usage: bun scripts/spike-cdp-inject.ts <target-repo> [devUrl]");
  process.exit(1);
}

const cfgPath = join(targetRepo, ".fiber-snatcher/config.json");
const cfg = existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, "utf8")) : null;
const devUrl = process.argv[3] ?? cfg?.devUrl ?? "http://localhost:3006";

const headers: Record<string, string> = {};
if (cfg?.authKeyPath && existsSync(cfg.authKeyPath)) {
  const key = readFileSync(cfg.authKeyPath, "utf8").trim();
  if (key) headers[cfg.authHeader ?? "X-Fiber-Snatcher-Key"] = key;
}

// The injected runtime probe. Deliberately uses a spike-only global so a V1
// bundle-copied __snatcher__ in the target app cannot confound the results.
const SPIKE_RUNTIME = String.raw`
(() => {
  if (window.__fs_spike__) return;
  const bootTs = Date.now();

  function fiberOf(node) {
    if (!node) return null;
    const k = Object.keys(node).find((k) => k.startsWith("__reactFiber$"));
    return k ? node[k] : null;
  }
  function displayName(t) {
    if (!t) return "?";
    if (typeof t === "string") return t;
    return t.displayName ?? t.name ?? "Anonymous";
  }
  function* walkAllFibers(limit = 200000) {
    const seen = new WeakSet();
    let n = 0;
    for (const el of document.querySelectorAll("*")) {
      let f = fiberOf(el);
      while (f && n < limit) {
        if (seen.has(f)) break;
        seen.add(f);
        n++;
        yield f;
        f = f.return ?? null;
      }
    }
  }

  window.__fs_spike__ = {
    bootTs,
    fiberCheck() {
      let components = 0;
      const names = new Set();
      for (const f of walkAllFibers()) {
        if (typeof f.type === "function" || (f.type && typeof f.type === "object" && typeof f.type !== "string")) {
          components++;
          const n = displayName(f.type);
          if (n && n !== "?" && n !== "Anonymous" && names.size < 12) names.add(n);
        }
      }
      return { components, sampleNames: [...names] };
    },
    discoverQueryClient() {
      // Duck-type: any fiber whose props carry an object with getQueryCache().
      for (const f of walkAllFibers()) {
        const c = f.memoizedProps?.client;
        if (c && typeof c.getQueryCache === "function") {
          let queries = -1;
          try { queries = c.getQueryCache().getAll().length; } catch {}
          return { found: true, via: displayName(f.type), queries };
        }
      }
      return { found: false };
    },
    discoverJotai() {
      // Provider fiber carries the store; default-store apps hide it in module
      // scope, so this is a soft check. Duck-type: object with get+set+sub.
      for (const f of walkAllFibers()) {
        const s = f.memoizedProps?.store ?? f.memoizedProps?.value;
        if (s && typeof s.get === "function" && typeof s.set === "function" && typeof s.sub === "function") {
          const hasDev = typeof s.dev4_get_mounted_atoms === "function";
          let mounted = -1;
          if (hasDev) { try { mounted = [...s.dev4_get_mounted_atoms()].length; } catch {} }
          return { found: true, via: displayName(f.type), devApi: hasDev, mounted };
        }
      }
      return { found: false };
    },
  };
})();
`;

async function main() {
  const profile = mkdtempSync(join(tmpdir(), "fs-spike-"));
  const context = await chromium.launchPersistentContext(profile, {
    headless: true,
    viewport: { width: 1400, height: 900 },
    extraHTTPHeaders: headers,
    args: ["--disable-blink-features=AutomationControlled"],
  });
  const page = context.pages()[0] ?? (await context.newPage());
  await context.addInitScript(SPIKE_RUNTIME);

  const results: Record<string, unknown> = {};

  await page.goto(devUrl, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3500); // let hydration finish

  results["1-injected"] = await page.evaluate(() => !!(window as any).__fs_spike__);
  results["2-fiber"] = await page.evaluate(() => (window as any).__fs_spike__?.fiberCheck());
  results["3-queryClient"] = await page.evaluate(() => (window as any).__fs_spike__?.discoverQueryClient());
  results["4-jotai"] = await page.evaluate(() => (window as any).__fs_spike__?.discoverJotai());

  // 5: soft navigation (client-side) — global must survive (same document)
  const bootBefore = await page.evaluate(() => (window as any).__fs_spike__?.bootTs);
  await page.evaluate(() => (window as any).next?.router?.push?.("/jobs") ?? history.pushState({}, "", "/jobs"));
  await page.waitForTimeout(1500);
  const bootAfterSoft = await page.evaluate(() => (window as any).__fs_spike__?.bootTs);
  results["5-softNav"] = { survives: bootBefore === bootAfterSoft, bootBefore, bootAfterSoft };

  // 6: hard reload — addInitScript must re-inject (new bootTs)
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  const bootAfterHard = await page.evaluate(() => (window as any).__fs_spike__?.bootTs);
  results["6-hardReload"] = {
    reinjected: typeof bootAfterHard === "number" && bootAfterHard !== bootBefore,
    fiberAfterReload: await page.evaluate(() => (window as any).__fs_spike__?.fiberCheck()?.components),
  };

  console.log(JSON.stringify(results, null, 2));
  await context.close();
}

main().catch((e) => {
  console.error("spike failed:", e);
  process.exit(1);
});
