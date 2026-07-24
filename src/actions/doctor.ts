/** `doctor` — one-shot environment health check. Two halves: a daemon-side
 *  ActionDef that reports in-page facts (runtime version, adapters), and a
 *  CLI orchestrator (runDoctorCli) that runs the environment probes WITHOUT
 *  starting the daemon, then dispatches the ActionDef only if the daemon is
 *  already up. Skip-downstream: a down daemon (or an error page) marks the
 *  page-dependent probes `skip` instead of emitting false failures. */

import { existsSync, readFileSync, constants as fsConstants } from "node:fs";
import { promises as fs } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import type { ActionDef, PipelineCtx } from "../pipeline/contracts.ts";
import { RUNTIME_VERSION } from "../page-runtime/version.ts";
import { loadConfig } from "../core/config.ts";
import { dataDir } from "../core/paths.ts";
import { controlSocketPath } from "../core/browser.ts";
import { connectDaemon } from "../daemon/lifecycle.ts";

// Daemon-side verb: the probes that need the live page.
type DoctorPageProbe = {
  daemonRuntime: string;
  pageRuntime: string | null;
  url: string;
  onErrorPage: boolean;
  adapters: string[];
};

export const doctorActions: ActionDef<never>[] = [
  {
    name: "doctor",
    summary: "Health check: config, dirs, dev server, daemon, runtime match, adapters",
    target: "none",
    observation: true,
    settle: false,
    async run(ctx: PipelineCtx): Promise<DoctorPageProbe> {
      const url = ctx.page.url();
      const onErrorPage = url.startsWith("chrome-error://") || url === "about:blank" || url === "";
      let pageRuntime: string | null = null;
      let adapters: string[] = [];
      if (!onErrorPage) {
        pageRuntime = await ctx.runtime<string>("version").catch(() => null);
        adapters = await ctx.runtime<string[]>("adapters").catch(() => []);
      }
      return { daemonRuntime: RUNTIME_VERSION, pageRuntime, url, onErrorPage, adapters };
    },
  } as ActionDef<never>,
];

// CLI-side orchestrator: environment probes + optional daemon dispatch.
export type ProbeStatus = "ok" | "fail" | "warn" | "skip";
export type Probe = { name: string; status: ProbeStatus; detail: string; hint?: string };

export async function runDoctorCli(): Promise<{ healthy: boolean; probes: Probe[] }> {
  const probes: Probe[] = [];

  const cfg = await loadConfig();
  if (!cfg) {
    probes.push({ name: "config", status: "fail", detail: "no .fiber-snatcher/config.json", hint: "run `fiber-snatcher init`" });
    return finalize(probes);
  }
  probes.push({ name: "config", status: "ok", detail: `loaded (devUrl ${cfg.devUrl})` });

  probes.push(await checkDirs([cfg.shotsDir, cfg.logsDir, join(cfg.logsDir, "..", "runs")]));

  const devOk = await fetchOk(cfg.devUrl);
  probes.push(
    devOk
      ? { name: "dev-server", status: "ok", detail: cfg.devUrl }
      : { name: "dev-server", status: "fail", detail: `no response at ${cfg.devUrl}`, hint: `start it: ${cfg.sources?.nextDevCommand || "your dev server"}` }
  );

  const v1Live = (await socketAccepts(controlSocketPath(cfg))) || pidAlive(cfg.daemonPidFile);
  probes.push(
    v1Live
      ? { name: "v1-daemon", status: "warn", detail: "a V1 daemon is running for this project", hint: "V2 has its own socket, but shares the browser profile — run `fiber-snatcher stop` if you hit profile-lock errors" }
      : { name: "v1-daemon", status: "ok", detail: "none holding the profile" }
  );

  // doctor observes; it never starts the daemon (that would defeat the probe).
  const client = await connectDaemon(cfg, {}, { spawnIfDown: false }).catch(() => null);
  if (!client) {
    probes.push({ name: "v2-daemon", status: "warn", detail: "not running", hint: "auto-starts on the next command; run `fs info`, then re-run `fs doctor` for page probes" });
    probes.push({ name: "runtime-match", status: "skip", detail: "daemon down" });
    probes.push({ name: "adapters", status: "skip", detail: "daemon down" });
    return finalize(probes);
  }
  try {
    const res = await client.request("doctor", {}, 8000);
    if (!res.ok) {
      probes.push({ name: "v2-daemon", status: "warn", detail: "reachable but the doctor probe failed", hint: res.error?.message });
      return finalize(probes);
    }
    const d = res.data as DoctorPageProbe;
    probes.push({ name: "v2-daemon", status: "ok", detail: `reachable (gen ${res.gen ?? "?"}, runtime ${d.daemonRuntime})` });

    if (d.onErrorPage) {
      probes.push({ name: "page-url", status: "warn", detail: `${d.url} — daemon tab on an error/blank page`, hint: "run `fs reload` to load devUrl; page probes skipped until then" });
      probes.push({ name: "runtime-match", status: "skip", detail: "page on error page" });
      probes.push({ name: "adapters", status: "skip", detail: "page on error page" });
      return finalize(probes);
    }
    probes.push({ name: "page-url", status: "ok", detail: d.url });

    if (d.pageRuntime === null) {
      probes.push({ name: "runtime-match", status: "fail", detail: "page runtime not injected", hint: "run `fs reload` to refresh the page with the runtime" });
    } else if (d.pageRuntime !== d.daemonRuntime) {
      probes.push({ name: "runtime-match", status: "fail", detail: `page ${d.pageRuntime} != daemon ${d.daemonRuntime}`, hint: "stale runtime in the page — run `fs reload`" });
    } else {
      probes.push({ name: "runtime-match", status: "ok", detail: `page + daemon both ${d.daemonRuntime}` });
    }

    probes.push({ name: "adapters", status: "ok", detail: d.adapters.length ? d.adapters.join(", ") : "none discovered (fine if the app has no TanStack/jotai store)" });

    // Project adapter file: present-but-silent is the broken-file signature
    // (init scripts fail in isolation, so a syntax error shows up ONLY here).
    const adapterFile = join(await dataDir(), "adapter.js");
    if (existsSync(adapterFile)) {
      const custom = d.adapters.filter((n) => n !== "queries" && n !== "jotai");
      probes.push(
        custom.length
          ? { name: "project-adapter", status: "ok", detail: `adapter.js loaded — registered: ${custom.join(", ")}` }
          : { name: "project-adapter", status: "warn", detail: "adapter.js present but nothing registered", hint: "likely a syntax error or register() never ran — check the browser console" }
      );
    }
    return finalize(probes);
  } finally {
    client.close();
  }
}

const GLYPH: Record<ProbeStatus, string> = { ok: "✓", fail: "✗", warn: "!", skip: "·" };

export function renderDoctor(probes: Probe[], healthy: boolean): string {
  const lines = probes.map((p) => {
    const head = `${GLYPH[p.status]} ${p.name.padEnd(14)}${p.detail}`;
    return p.hint ? `${head}\n    -> ${p.hint}` : head;
  });
  lines.push("", healthy ? "healthy" : "unhealthy — resolve the failing probes above");
  return lines.join("\n");
}

function finalize(probes: Probe[]): { healthy: boolean; probes: Probe[] } {
  return { healthy: !probes.some((p) => p.status === "fail"), probes };
}

async function checkDirs(dirs: string[]): Promise<Probe> {
  const bad: string[] = [];
  for (const d of dirs) {
    try {
      await fs.mkdir(d, { recursive: true });
      await fs.access(d, fsConstants.W_OK);
    } catch {
      bad.push(d);
    }
  }
  return bad.length
    ? { name: "dirs", status: "fail", detail: `not writable: ${bad.join(", ")}`, hint: "check permissions on .fiber-snatcher/" }
    : { name: "dirs", status: "ok", detail: "shots/logs/runs writable" };
}

async function fetchOk(url: string, timeoutMs = 1500): Promise<boolean> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: "HEAD", signal: ctrl.signal });
    return res.status < 500;
  } catch {
    // Some dev servers 405 on HEAD; a reachable-but-HEAD-averse server is still up.
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      return res.status < 500;
    } catch {
      return false;
    }
  } finally {
    clearTimeout(t);
  }
}

function socketAccepts(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (!existsSync(path)) return resolve(false);
    const probe = net.createConnection(path);
    const timer = setTimeout(() => {
      probe.destroy();
      resolve(false);
    }, 400);
    probe.once("connect", () => {
      clearTimeout(timer);
      probe.destroy();
      resolve(true);
    });
    probe.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

function pidAlive(pidFile: string): boolean {
  try {
    const pid = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10);
    if (!pid) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
