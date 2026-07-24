// Throwaway probe: does speedway's RR7 dev build expose its data router on window?
import { chromium } from "playwright";

const b = await chromium.launch({ headless: true });
const p = await b.newPage();
await p.goto("http://localhost:5101/", { waitUntil: "domcontentloaded" });
await p.waitForTimeout(2000);
const probe = await p.evaluate(() => {
  const w = window as any;
  const router = w.__reactRouterDataRouter;
  return {
    url: location.href,
    dataRouterType: typeof router,
    routerWindowKeys: Object.keys(w).filter((k) => k.toLowerCase().includes("router")),
    version: w.__reactRouterVersion ?? null,
    routerShape: router
      ? {
          hasSubscribe: typeof router.subscribe === "function",
          hasNavigate: typeof router.navigate === "function",
          navigationState: router.state?.navigation?.state ?? null,
          fetcherCount: router.state?.fetchers?.size ?? null,
          routeCount: Array.isArray(router.routes) ? router.routes.length : null,
          location: router.state?.location?.pathname ?? null,
        }
      : null,
  };
});
console.log(JSON.stringify(probe, null, 2));
await b.close();
