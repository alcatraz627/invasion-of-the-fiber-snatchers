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
import type { DigestDelta, PushEvent, Request, Response } from "../protocol/types.ts";
import { lookupAction, listActions } from "../actions/registry.ts";
import { attachNetworkObserver, matchUrl, type NetEvent, type NetworkObserver } from "../actions/network.ts";
import { runAction, type PipelineDeps } from "../pipeline/index.ts";
import { Journal, readJournal } from "../pipeline/journal.ts";
import { FsErrorShaped, type TelemetryProfile } from "../pipeline/contracts.ts";
import { RUNTIME_VERSION } from "../page-runtime/version.ts";
import { attachScreencast, resolveScreencastOptions } from "./screencast.ts";
import { spawnCwd } from "./env.ts";
import type { FsAdaptConfig } from "../core/config.ts";

/** Clamp a project's adapt config to arrays of short plain strings before it
 *  reaches the page — a hostile or fat config can't inject markup, blow the DOM
 *  budget, or feed a ReDoS pattern to the runtime's matchers. */
function sanitizeAdapt(a: FsAdaptConfig | undefined): FsAdaptConfig {
  const strs = (v: unknown, cap: number): string[] =>
    Array.isArray(v)
      ? v.filter((x): x is string => typeof x === "string" && x.length > 0 && x.length <= 120).slice(0, cap)
      : [];
  return {
    surfaceSelectors: strs(a?.surfaceSelectors, 20),
    overlayComponents: strs(a?.overlayComponents, 40),
    contentPropKeys: strs(a?.contentPropKeys, 40),
  };
}

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

/** Live subscriptions for `watch console|route|network`. A watch keeps its CLI
 *  connection open and streams push events until it unwatches or disconnects.
 *  The hub attaches a page/observer listener on the FIRST subscription of a kind
 *  and detaches it on the LAST, so an idle daemon does no watch work. Events fan
 *  out to every connected client (frames.ts broadcasts); a one-shot CLI has no
 *  onPush handler and drops them, so only the watching CLI reacts. */
class WatchHub {
  private emit: ((e: PushEvent) => void) | null = null;
  private seq = 0;
  private consoleSubs = new Map<string, { level?: string }>();
  private routeSubs = new Map<string, {}>();
  private netSubs = new Map<string, { match?: (url: string) => boolean }>();
  private consoleOff: (() => void) | null = null;
  private routeOff: (() => void) | null = null;
  private netOff: (() => void) | null = null;

  constructor(private page: Page, private gen: () => number, private net: NetworkObserver) {}

  /** The push fan-out is the same function every request (frames.ts owns it), so
   *  binding it each call is idempotent — it just captures it for the listeners. */
  bindEmit(emit: (e: PushEvent) => void): void {
    this.emit = emit;
  }

  add(kind: string, opts: { level?: string; match?: (url: string) => boolean }): { watchId: string; kind: string } {
    const watchId = `w${Date.now().toString(36)}-${++this.seq}`;
    if (kind === "console") {
      this.consoleSubs.set(watchId, { level: opts.level });
      this.ensureConsole();
    } else if (kind === "route") {
      this.routeSubs.set(watchId, {});
      this.ensureRoute();
    } else if (kind === "network") {
      this.netSubs.set(watchId, { match: opts.match });
      this.ensureNet();
    } else {
      throw new FsErrorShaped({ code: "E_BAD_ARGS", message: `unknown watch kind: ${kind}`, hint: "watch console | route | network" });
    }
    return { watchId, kind };
  }

  remove(watchId: string): boolean {
    let removed = false;
    if (this.consoleSubs.delete(watchId)) { removed = true; if (this.consoleSubs.size === 0) this.detachConsole(); }
    if (this.routeSubs.delete(watchId)) { removed = true; if (this.routeSubs.size === 0) this.detachRoute(); }
    if (this.netSubs.delete(watchId)) { removed = true; if (this.netSubs.size === 0) this.detachNet(); }
    return removed;
  }

  private ensureConsole(): void {
    if (this.consoleOff) return;
    // A console message emits once if any active sub would accept its level; each
    // CLI still applies its own --level, so multiple watchers don't multiply it.
    const onConsole = (msg: { type(): string; text(): string }) => this.emitConsole(msg.type(), msg.text());
    const onPageError = (err: Error) => this.emitConsole("error", err.message);
    this.page.on("console", onConsole);
    this.page.on("pageerror", onPageError);
    this.consoleOff = () => { this.page.off("console", onConsole); this.page.off("pageerror", onPageError); };
  }

  private emitConsole(level: string, body: string): void {
    const anyAll = [...this.consoleSubs.values()].some((s) => !s.level);
    const wanted = anyAll || [...this.consoleSubs.values()].some((s) => s.level === level);
    if (wanted) this.emit?.({ event: "console", level, body, ts: new Date().toISOString() });
  }

  private ensureRoute(): void {
    if (this.routeOff) return;
    const onNav = (frame: { url(): string }) => {
      if (frame === this.page.mainFrame()) this.emit?.({ event: "route", url: this.page.url(), gen: this.gen(), ts: new Date().toISOString() });
    };
    this.page.on("framenavigated", onNav);
    this.routeOff = () => this.page.off("framenavigated", onNav);
  }

  private ensureNet(): void {
    if (this.netOff) return;
    this.netOff = this.net.subscribe((e: NetEvent) => this.emitNet(e));
  }

  private emitNet(e: NetEvent): void {
    for (const [watchId, sub] of this.netSubs) {
      if (sub.match && !sub.match(e.url)) continue;
      this.emit?.({ event: "watch", watchId, payload: { kind: "network", phase: e.phase, method: e.method, url: e.url, status: e.status ?? null, ok: e.ok }, ts: new Date().toISOString() });
    }
  }

  private detachConsole(): void { this.consoleOff?.(); this.consoleOff = null; }
  private detachRoute(): void { this.routeOff?.(); this.routeOff = null; }
  private detachNet(): void { this.netOff?.(); this.netOff = null; }
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
  // Adapt config is set on window BEFORE the runtime bundle runs, so the runtime
  // reads it at init. Sanitized here (arrays of short strings only) so a bad
  // config can't inject markup or hand the page a hostile value.
  await context.addInitScript(`window.__fsAdapt=${JSON.stringify(sanitizeAdapt(cfg.adapt))};`);
  await context.addInitScript(runtimeBundle);

  // The rolling screencast is attached now but stays OFF until a `profile debug`
  // or a `record` turns it on — capture has a memory/CPU cost we don't pay by
  // default. It re-arms itself after each navigation (Chrome can pause the stream
  // across a cross-document nav).
  const screencast = attachScreencast(page, resolveScreencastOptions(cfg.screencast));
  // Watches network traffic for the whole daemon life: `wait --call` reads its
  // recent-request buffer, `watch network` streams it, and `profile verify`
  // drains its error log into a failing verb's digest.
  const netObserver = attachNetworkObserver(page);

  let gen = 0;
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) {
      gen++;
      void screencast.onNavigated();
    }
  });

  const watches = new WatchHub(page, () => gen, netObserver);

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

  const server = startFrameServer(sockPath, async (req: Request, push: (e: PushEvent) => void): Promise<Response> => {
    // `watch` streams events over server-push; bind the fan-out (stable across
    // requests) so the hub's page listeners can reach it.
    watches.bindEmit(push);
    switch (req.cmd) {
      case "ping":
        return { id: req.id, ok: true, data: { pid: process.pid, runtime: RUNTIME_VERSION, gen } };
      case "watch": {
        const kind = req.args.kind as string | undefined;
        if (!kind) return { id: req.id, ok: false, error: { code: "E_BAD_ARGS", message: "watch needs a kind", hint: "watch console | route | network" } };
        try {
          const match = typeof req.args.pattern === "string" ? matchUrl(req.args.pattern) : undefined;
          const { watchId } = watches.add(kind, { level: req.args.level as string | undefined, match });
          return { id: req.id, ok: true, data: { watchId, kind, pattern: req.args.pattern ?? null } };
        } catch (e) {
          const err = e instanceof FsErrorShaped ? e.err : { code: "E_INTERNAL" as const, message: String((e as Error).message ?? e) };
          return { id: req.id, ok: false, error: err };
        }
      }
      case "unwatch": {
        const watchId = req.args.watchId as string | undefined;
        const removed = watchId ? watches.remove(watchId) : false;
        return { id: req.id, ok: true, data: { unwatched: removed, watchId: watchId ?? null } };
      }
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
        // Mark the network-error log before the action so we attribute only the
        // failures this action caused, not stale ones from earlier traffic.
        const netMark = netObserver.errorMark();
        try {
          const r = await runSerialized(() => runAction(deps, def, args as never));
          let { ok, data, error, digest } = r;
          let next_steps = error?.hint ? [error.hint] : undefined;

          // A request that 500s or fails during the action is a real error, so
          // fold it into the digest. verify (below) then fails the action on it;
          // other profiles just surface it. Only mutating verbs carry a digest to
          // fold into — observation reads don't trigger app traffic.
          const netErrs = netObserver.errorsSince(netMark);
          if (netErrs.length && digest) {
            digest = { ...digest, errors: [...new Set([...(digest.errors ?? []), ...netErrs])].slice(0, 5) };
          }

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
