/** Daemon main: owns the browser, injects the page runtime on every document,
 *  tracks document generations, and serves the frame protocol by running verbs
 *  through the pipeline. Started detached by lifecycle.ensureDaemon(). */

import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import { join } from "node:path";
import net from "node:net";
import type { Page } from "playwright";
import { openPersistent, v2PidFile, v2SocketPath } from "../core/browser.ts";
import { requireConfig } from "../core/config.ts";
import { startFrameServer } from "../protocol/frames.ts";
import type { DigestDelta, Request, Response } from "../protocol/types.ts";
import { lookupAction, listActions } from "../actions/registry.ts";
import { runAction, type PipelineDeps } from "../pipeline/index.ts";
import { Journal, readJournal } from "../pipeline/journal.ts";
import { FsErrorShaped, type TelemetryProfile } from "../pipeline/contracts.ts";
import { RUNTIME_VERSION } from "../page-runtime/version.ts";
import { attachScreencast, resolveScreencastOptions } from "./screencast.ts";
import { spawnCwd } from "./env.ts";

/** minimal profile: strip the digest to the dead-click signal + errors so a
 *  terse-T0 session pays no attention tax on surfaces/counts/focus/queries. */
function terseDigest(d: DigestDelta): DigestDelta {
  const t: DigestDelta = { mutations: d.mutations };
  if (d.errors?.length) t.errors = d.errors;
  return t;
}

/** explore profile: the T1 interactable count handed back after a navigation so
 *  the agent knows what `fs page` would surface without paying for it yet. */
async function interactableCount(page: Page): Promise<number | null> {
  return await page
    .evaluate(() => {
      const runtime = (window as unknown as { __fs?: { snapshot?: (o: unknown) => { interactables?: unknown[] } } }).__fs;
      try {
        const snap = runtime?.snapshot?.({ budget: "concise" });
        return snap && Array.isArray(snap.interactables) ? snap.interactables.length : null;
      } catch {
        return null;
      }
    })
    .catch(() => null);
}

async function buildRuntimeBundle(): Promise<string> {
  const entry = new URL("../page-runtime/index.ts", import.meta.url).pathname;
  const result = await Bun.build({ entrypoints: [entry], target: "browser", minify: false });
  const out = result.outputs[0];
  if (!result.success || !out) throw new Error(`runtime bundle failed: ${result.logs.join("\n")}`);
  return await out.text();
}

async function main() {
  const cwd = spawnCwd();
  if (cwd) process.chdir(cwd);
  const cfg = await requireConfig();
  const sockPath = v2SocketPath(cfg);
  const pidFile = v2PidFile(cfg);
  // Only clear a DEAD socket file; a connectable one means another daemon is
  // live and this process must bow out, not unlink it (spawn-race safety).
  if (existsSync(sockPath)) {
    const live = await new Promise<boolean>((resolve) => {
      const probe = net.createConnection(sockPath);
      const timer = setTimeout(() => { probe.destroy(); resolve(false); }, 500);
      probe.once("connect", () => { clearTimeout(timer); probe.destroy(); resolve(true); });
      probe.once("error", () => { clearTimeout(timer); resolve(false); });
    });
    if (live) {
      console.error("another V2 daemon already serves this project; exiting");
      process.exit(1);
    }
    await fs.rm(sockPath, { force: true });
  }

  const runtimeBundle = await buildRuntimeBundle();
  const { context, page } = await openPersistent(cfg);
  await context.addInitScript(runtimeBundle);

  // The rolling screencast is attached now but stays OFF until a `profile debug`
  // or a `record` turns it on — capture has a memory/CPU cost we don't pay by
  // default. It re-arms itself after each navigation (Chrome can pause the stream
  // across a cross-document nav).
  const screencast = attachScreencast(page, resolveScreencastOptions(cfg.screencast));

  let gen = 0;
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) {
      gen++;
      void screencast.onNavigated();
    }
  });

  await page.goto(cfg.devUrl, { waitUntil: "domcontentloaded" }).catch(() => {});

  const journal = new Journal(join(cfg.logsDir, "..", "runs"));
  let profile: TelemetryProfile = "explore";

  const deps: PipelineDeps = {
    page,
    journal,
    gen: () => gen,
    profile: () => profile,
    log: (body) => journal.append({ cmd: "log", args: { body }, ok: true, durMs: 0 }),
  };

  // One page, one actor: verbs run strictly serialized so settle loops and the
  // observation buffer can't steal each other's digests. Daemon-level reads
  // (ping/info/journal) stay concurrent.
  let actionChain: Promise<unknown> = Promise.resolve();
  const runSerialized = <T>(fn: () => Promise<T>): Promise<T> => {
    const p = actionChain.then(fn, fn);
    actionChain = p.catch(() => undefined);
    return p;
  };

  const server = startFrameServer(sockPath, async (req: Request): Promise<Response> => {
    switch (req.cmd) {
      case "ping":
        return { id: req.id, ok: true, data: { pid: process.pid, runtime: RUNTIME_VERSION, gen } };
      case "info": {
        const runtimeVersion = await page
          .evaluate(() => (window as unknown as { __fs?: { version: string } }).__fs?.version ?? null)
          .catch(() => null);
        return {
          id: req.id,
          ok: true,
          data: { url: page.url(), title: await page.title().catch(() => ""), gen, runtimeVersion, daemonRuntime: RUNTIME_VERSION, profile, screencast: screencast.stats() },
          gen,
        };
      }
      case "actions":
        return { id: req.id, ok: true, data: listActions() };
      case "journal": {
        const entries = await readJournal(join(cfg.logsDir, "..", "runs"), req.args.run as string | undefined, (req.args.last as number) ?? 20);
        return { id: req.id, ok: true, data: entries };
      }
      case "profile": {
        const next = req.args.profile as TelemetryProfile | undefined;
        if (next) {
          profile = next;
          // debug wants the ring for `shoot --at`; minimal force-stops capture.
          // explore/verify leave the ring in whatever state it was.
          if (profile === "debug") await screencast.start().catch(() => {});
          else if (profile === "minimal") await screencast.stop().catch(() => {});
        }
        return { id: req.id, ok: true, data: { profile, screencast: screencast.stats() } };
      }
      case "close":
        setTimeout(() => shutdown(), 50);
        return { id: req.id, ok: true, data: { closing: true } };
      default: {
        const def = lookupAction(req.cmd);
        if (!def) {
          return {
            id: req.id,
            ok: false,
            error: {
              code: "E_BAD_ARGS",
              message: `unknown command: ${req.cmd}`,
              hint: `run \`fs actions\` for the verb list`,
            },
          };
        }
        // shoot/look/record write under the shots dir; daemon owns config, verbs
        // stay pure. The screencast controller is reached off the page (WeakMap).
        const needsShots = def.name === "shoot" || def.name === "look" || def.name === "record";
        const args = needsShots ? { ...req.args, shotsDir: cfg.shotsDir } : req.args;
        try {
          const r = await runSerialized(() => runAction(deps, def, args as never));
          let { ok, data, error, digest } = r;
          let next_steps = error?.hint ? [error.hint] : undefined;

          // Profile shapes the T0 emit WITHOUT touching the pipeline: minimal
          // trims the digest, verify fails on recorded errors, explore annotates
          // navigations. debug's extra verbosity (observation digests, ring) is
          // already handled in the pipeline + the profile handler above.
          if (digest && profile === "minimal") digest = terseDigest(digest);

          if (profile === "verify" && ok && digest?.errors?.length) {
            const errs = digest.errors;
            error = {
              code: "E_INTERNAL",
              message: `verify: ${errs.length} console error(s)/remount during \`${def.name}\`: ${errs.slice(0, 3).join(" | ")}`,
              hint: "verify fails any action that logs a console error or triggers a remount; use `explore` to observe without failing",
            };
            ok = false;
            next_steps = [error.hint!];
          }

          if (profile === "explore" && ok && (def.name === "navigate" || def.name === "reload")) {
            const count = await interactableCount(page);
            if (count !== null) next_steps = [`${count} interactables on the new page — run \`fs page\` for their refs`];
          }

          return { id: req.id, ok, data, error, digest, gen, next_steps };
        } catch (e) {
          const err = e instanceof FsErrorShaped ? e.err : { code: "E_INTERNAL" as const, message: String((e as Error).message ?? e) };
          return { id: req.id, ok: false, error: err, gen };
        }
      }
    }
  });

  server.listen(sockPath);

  const shutdown = async () => {
    try { await screencast.stop(); } catch { /* finalizes any recording */ }
    try { server.close(); } catch { /* already down */ }
    try { await context.close(); } catch { /* already down */ }
    try { await fs.rm(sockPath, { force: true }); } catch { /* gone */ }
    try { await fs.rm(pidFile, { force: true }); } catch { /* gone */ }
    await journal.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  context.on("close", () => shutdown());

  await fs.mkdir(join(pidFile, ".."), { recursive: true }).catch(() => {});
  await fs.writeFile(pidFile, String(process.pid));
}

main().catch((e) => {
  console.error("fs daemon crashed:", e);
  process.exit(1);
});
