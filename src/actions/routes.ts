/** `routes` reads the target app's route map from its Next.js App Router source
 *  so an agent can `fs navigate` to a page without guessing the URL. It walks
 *  the app directory for `page.*` files and renders each as a URL path, keeping
 *  dynamic segments as `[param]`. Static filesystem read, no browser needed. */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ActionDef } from "../pipeline/contracts.ts";
import { resolveTargetRoot } from "../core/paths.ts";

const PAGE_FILES = ["page.tsx", "page.jsx", "page.ts", "page.js"];

type RouteEntry = { path: string; dynamic: boolean };

/** Walk a Next App Router directory, emitting a route for every dir that holds a
 *  page file. Route groups `(group)` and parallel slots `@slot` are structural
 *  and contribute no URL segment; dynamic dirs `[id]`/`[...slug]` pass through. */
function walkAppRouter(appDir: string): RouteEntry[] {
  const out: RouteEntry[] = [];
  const visit = (dir: string, segments: string[]) => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.isFile() && PAGE_FILES.includes(e.name))) {
      const path = "/" + segments.filter(Boolean).join("/");
      out.push({ path: path === "/" ? "/" : path, dynamic: segments.some((s) => s.includes("[")) });
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const name = e.name;
      if (name === "node_modules" || name.startsWith(".")) continue;
      // Route group / parallel slot: descend but add no segment.
      const segment = name.startsWith("(") && name.endsWith(")") ? "" : name.startsWith("@") ? "" : name;
      visit(join(dir, name), segment ? [...segments, segment] : segments);
    }
  };
  visit(appDir, []);
  return out;
}

export const routeActions: ActionDef<never>[] = [
  {
    name: "routes",
    summary: "List the target app's Next.js App Router pages (dynamic segments as [param])",
    target: "none",
    observation: true,
    settle: false,
    async run(ctx) {
      const root = await resolveTargetRoot();
      const appDir = [join(root, "src", "app"), join(root, "app")].find((d) => existsSync(join(d, "layout.tsx")) || existsSync(join(d, "layout.js")) || existsSync(join(d, "page.tsx")) || existsSync(join(d, "page.js")));
      if (!appDir) {
        // Not a Next App Router tree — ask the live page: a React Router data
        // router knows its own route table, no source parsing needed.
        const live = await ctx.runtime<string[]>("routerRoutes").catch(() => [] as string[]);
        if (live.length) {
          return {
            router: "react-router",
            count: live.length,
            routes: live,
            dynamic: live.filter((p) => p.includes(":")),
          };
        }
        return {
          router: "none",
          detail: "no Next App Router tree and no live data router — Pages Router is not supported",
          routes: [] as string[],
        };
      }
      const entries = walkAppRouter(appDir).sort((a, b) => a.path.localeCompare(b.path));
      return {
        router: "app",
        appDir: appDir.slice(root.length + 1) || appDir,
        count: entries.length,
        routes: entries.map((e) => e.path),
        dynamic: entries.filter((e) => e.dynamic).map((e) => e.path),
      };
    },
  } as ActionDef<Record<string, never>>,
];
