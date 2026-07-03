/** Daemon main: owns the browser, injects the page runtime on every document,
 *  tracks document generations, and serves the frame protocol by running verbs
 *  through the pipeline. Started detached by lifecycle.ensureDaemon(). */

import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { openPersistent, controlSocketPath } from "../core/browser.ts";
import { requireConfig } from "../core/config.ts";
import { startFrameServer } from "../protocol/frames.ts";
import type { Request, Response } from "../protocol/types.ts";
import { lookupAction, listActions } from "../actions/registry.ts";
import { runAction, type PipelineDeps } from "../pipeline/index.ts";
import { Journal, readJournal } from "../pipeline/journal.ts";
import { FsErrorShaped, type TelemetryProfile } from "../pipeline/contracts.ts";
import { RUNTIME_VERSION } from "../page-runtime/version.ts";
import { spawnCwd } from "./env.ts";

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
  const sockPath = controlSocketPath(cfg);
  if (existsSync(sockPath)) await fs.rm(sockPath, { force: true });

  const runtimeBundle = await buildRuntimeBundle();
  const { context, page } = await openPersistent(cfg);
  await context.addInitScript(runtimeBundle);

  let gen = 0;
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) gen++;
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
          data: { url: page.url(), title: await page.title().catch(() => ""), gen, runtimeVersion, daemonRuntime: RUNTIME_VERSION, profile },
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
        if (next) profile = next;
        return { id: req.id, ok: true, data: { profile } };
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
        // shoot needs the shots dir; daemon owns config, verbs stay pure.
        const args = req.cmd === "shoot" || def.name === "shoot" ? { ...req.args, shotsDir: cfg.shotsDir } : req.args;
        try {
          const r = await runAction(deps, def, args as never);
          return {
            id: req.id,
            ok: r.ok,
            data: r.data,
            error: r.error,
            digest: r.digest,
            gen,
            next_steps: r.error?.hint ? [r.error.hint] : undefined,
          };
        } catch (e) {
          const err = e instanceof FsErrorShaped ? e.err : { code: "E_INTERNAL" as const, message: String((e as Error).message ?? e) };
          return { id: req.id, ok: false, error: err, gen };
        }
      }
    }
  });

  server.listen(sockPath);

  const shutdown = async () => {
    try { server.close(); } catch { /* already down */ }
    try { await context.close(); } catch { /* already down */ }
    try { await fs.rm(sockPath, { force: true }); } catch { /* gone */ }
    try { await fs.rm(cfg.daemonPidFile, { force: true }); } catch { /* gone */ }
    journal.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  context.on("close", () => shutdown());

  await fs.mkdir(join(cfg.daemonPidFile, ".."), { recursive: true }).catch(() => {});
  await fs.writeFile(cfg.daemonPidFile, String(process.pid));
}

main().catch((e) => {
  console.error("fs daemon crashed:", e);
  process.exit(1);
});
