/**
 * End-to-end health check. Runs a battery of probes and reports per-step
 * status. Each probe is isolated so one failure doesn't hide the rest.
 */

import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import { ok, type Result } from "../core/result.ts";
import { requireConfig } from "../core/config.ts";
import { controlSocketPath } from "../core/browser.ts";
import { sendRequest } from "../core/ipc.ts";

type Probe = { name: string; ok: boolean; detail: string };

export async function run(): Promise<Result> {
  const probes: Probe[] = [];

  // 1. config present
  let cfg;
  try { cfg = await requireConfig(); probes.push({ name: "config", ok: true, detail: ".fiber-snatcher/config.json loaded" }); }
  catch (e) {
    probes.push({ name: "config", ok: false, detail: String((e as Error).message) });
    return ok({ healthy: false, probes }, { next_steps: ["Run `fiber-snatcher init`."] });
  }

  // 2. dev server up
  const devOk = await fetchOk(cfg.devUrl);
  probes.push({ name: "dev-server", ok: devOk, detail: devOk ? cfg.devUrl : `no response at ${cfg.devUrl}` });

  // 3. daemon running
  const daemonAlive = existsSync(cfg.daemonPidFile) && (() => {
    try { process.kill(Number.parseInt(require("node:fs").readFileSync(cfg.daemonPidFile, "utf8").trim()), 0); return true; }
    catch { return false; }
  })();
  probes.push({ name: "daemon", ok: daemonAlive, detail: daemonAlive ? "pid present and alive" : "not running — run `fiber-snatcher start`" });

  // 4. IPC responsive + page-url. When the daemon's tab is parked on a
  // chrome-error://* page (typically because the dev server was restarted
  // out from under it), every downstream probe falsely reports failure —
  // there's no __snatcher__ on an error page, no adapters registered.
  // Mark page-url as not-ok with an actionable hint and skip the dependent
  // probes so the user sees ONE clear next step (`fiber-snatcher refresh`)
  // instead of a cascade of red herrings.
  let surfacePresent = false;
  let adapters: string[] = [];
  let onErrorPage = false;
  if (daemonAlive) {
    try {
      const res = await sendRequest(controlSocketPath(cfg), { id: "doctor-info", op: "info" }, 4000);
      probes.push({ name: "ipc", ok: res.ok, detail: res.ok ? "daemon responded" : (res.ok ? "" : res.error) });
      if (res.ok) {
        const info = res.data as { adapters?: string[]; url?: string };
        adapters = info.adapters ?? [];
        const url = info.url ?? "?";
        onErrorPage = url.startsWith("chrome-error://");
        probes.push({
          name: "page-url",
          ok: !onErrorPage,
          detail: onErrorPage
            ? `${url} — daemon's tab is on an error page (typically a dev-server restart parked it here). Run \`fiber-snatcher refresh\` to navigate back to ${cfg.devUrl}; probes below this depend on the page and are skipped until you do.`
            : url,
        });
      }
    } catch (e) {
      probes.push({ name: "ipc", ok: false, detail: String((e as Error).message) });
    }
  }

  // 5. debug surface — meaningless on an error page; skip rather than
  // emit a false "not attached" that points the user at the wrong fix.
  if (daemonAlive && !onErrorPage) {
    const res = await sendRequest(controlSocketPath(cfg), { id: "doctor-sur", op: "eval", code: `typeof window.__snatcher__ === "object" && window.__snatcher__.version` }, 4000)
      .catch((e) => ({ id: "doctor-sur", ok: false as const, error: String(e.message ?? e) }));
    if (res.ok) {
      surfacePresent = !!res.data;
      probes.push({
        name: "debug-surface",
        ok: surfacePresent,
        detail: surfacePresent ? `window.__snatcher__ v${res.data}` : "not attached — see USAGE.md step 'Wire expose.ts'",
      });
    }
  }

  // 6. adapters — same reason: page-url being an error page makes this
  // report 0 adapters, which says nothing about the actual install.
  if (!onErrorPage) {
    probes.push({
      name: "adapters",
      ok: adapters.length > 0,
      detail: adapters.length > 0 ? adapters.join(", ") : "none registered (ok if app doesn't use a store)",
    });
  }

  // 7. auth key present
  const hasKey = existsSync(cfg.authKeyPath);
  probes.push({
    name: "auth-key",
    ok: hasKey,
    detail: hasKey ? `${cfg.authHeader} → .fiber-snatcher/auth/dev-key` : "missing — run `fiber-snatcher auth rotate`",
  });

  const healthy = probes.filter((p) => !p.ok && p.name !== "adapters").length === 0;
  return ok(
    { healthy, probes },
    healthy
      ? {}
      : {
          next_steps: probes.filter((p) => !p.ok).map((p) => `${p.name}: ${p.detail}`),
        },
  );
}

async function fetchOk(url: string, timeoutMs = 1500): Promise<boolean> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    return res.status < 500;
  } catch { return false; } finally { clearTimeout(t); }
}
