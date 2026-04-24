/**
 * Fiber Snatcher daemon.
 *
 * Lifetime: from `fiber-snatcher start` to `fiber-snatcher stop`.
 * Owns: one BrowserContext, one Page, one IPC server, log stream writers.
 *
 * IPC operations (see core/ipc.ts):
 *   eval    { code }                   → returns evaluated expression
 *   state   { selector? }              → shortcut for __snatcher__.state()
 *   dispatch{ action, adapter? }        → routes through __snatcher__.dispatch
 *   goto    { url }
 *   shoot   { selector?, path? }        → returns saved path
 *   info                                → url, title, adapters, last logs n
 *   close                               → graceful shutdown
 */

import { promises as fs } from "node:fs";
import { existsSync, createWriteStream } from "node:fs";
import { join } from "node:path";
import { openPersistent, controlSocketPath } from "./core/browser.ts";
import { requireConfig } from "./core/config.ts";
import { startServer, type IpcRequest, type IpcResponse } from "./core/ipc.ts";

async function main() {
  const cwd = process.env.FS_CONFIG_CWD;
  if (cwd) process.chdir(cwd);

  const cfg = await requireConfig();
  const sockPath = controlSocketPath(cfg);
  if (existsSync(sockPath)) await fs.rm(sockPath, { force: true });

  const { context, page } = await openPersistent(cfg);
  await page.goto(cfg.devUrl, { waitUntil: "domcontentloaded" }).catch(() => {});

  // Pipe browser console directly into the log file
  const logFile = join(cfg.logsDir, `daemon-${todayStamp()}.jsonl`);
  await fs.mkdir(cfg.logsDir, { recursive: true });
  const logWriter = createWriteStream(logFile, { flags: "a" });
  const writeLog = (entry: Record<string, unknown>) => {
    logWriter.write(JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
  };

  page.on("console", (msg) => {
    writeLog({
      source: "cdp-console",
      level: msg.type(),
      body: msg.text(),
      page: page.url(),
    });
  });
  page.on("pageerror", (e) => {
    writeLog({ source: "cdp-pageerror", level: "error", body: e.message, stack: e.stack });
  });
  page.on("requestfailed", (req) => {
    writeLog({
      source: "cdp-network",
      level: "error",
      body: `${req.method()} ${req.url()} failed: ${req.failure()?.errorText}`,
    });
  });
  page.on("response", async (res) => {
    if (res.status() >= 400) {
      writeLog({
        source: "cdp-network",
        level: "error",
        body: `${res.request().method()} ${res.url()} → ${res.status()}`,
      });
    }
  });

  const server = startServer(sockPath, async (req): Promise<IpcResponse> => {
    try {
      switch (req.op) {
        case "info": {
          const url = page.url();
          const title = await page.title();
          const adapters = await page.evaluate(() => (window as any).__snatcher__?.adapters?.() ?? []);
          const logs = await page.evaluate((n) => (window as any).__snatcher__?.logs?.(n) ?? [], 10);
          return { id: req.id, ok: true, data: { url, title, adapters, recentLogs: logs } };
        }
        case "goto":
        case "navigate": {
          await page.goto(String(req.url), { waitUntil: "domcontentloaded" });
          return { id: req.id, ok: true, data: { url: page.url() } };
        }
        case "click": {
          const selector = String((req as any).selector);
          await page.click(selector, { timeout: 5000 });
          return { id: req.id, ok: true, data: { clicked: selector } };
        }
        case "fill": {
          const selector = String((req as any).selector);
          const value = String((req as any).value ?? "");
          await page.fill(selector, value, { timeout: 5000 });
          return { id: req.id, ok: true, data: { filled: selector, value } };
        }
        case "press": {
          const key = String((req as any).key);
          const selector = (req as any).selector as string | undefined;
          if (selector) {
            await page.press(selector, key, { timeout: 5000 });
          } else {
            await page.keyboard.press(key);
          }
          return { id: req.id, ok: true, data: { pressed: key, selector: selector ?? null } };
        }
        case "state": {
          const data = await page.evaluate(
            ({ sel, opts }) => {
              const s = (window as any).__snatcher__;
              if (!s) throw new Error("__snatcher__ not present; integrate expose.ts per USAGE.md");
              return s.state(sel, opts);
            },
            { sel: (req as any).selector, opts: (req as any).opts },
          );
          return { id: req.id, ok: true, data };
        }
        case "dispatch": {
          const data = await page.evaluate(
            ({ action, adapter }) => {
              const s = (window as any).__snatcher__;
              if (!s) throw new Error("__snatcher__ not present");
              return s.dispatch(action, { adapter });
            },
            { action: (req as any).action, adapter: (req as any).adapter },
          );
          return { id: req.id, ok: true, data };
        }
        case "eval": {
          const data = await page.evaluate((code) => {
            // eslint-disable-next-line no-new-func
            return new Function(`return (${code})`)();
          }, String((req as any).code));
          return { id: req.id, ok: true, data };
        }
        case "shoot": {
          const p = String((req as any).path ?? join(cfg.shotsDir, `shot-${Date.now()}.png`));
          const sel = (req as any).selector as string | undefined;
          if (sel) {
            const loc = page.locator(sel).first();
            await loc.screenshot({ path: p });
          } else {
            await page.screenshot({ path: p, fullPage: true });
          }
          return { id: req.id, ok: true, data: { path: p } };
        }
        case "close": {
          setTimeout(() => process.exit(0), 50);
          return { id: req.id, ok: true, data: { closing: true } };
        }
        default:
          return { id: req.id, ok: false, error: `unknown op: ${req.op}` };
      }
    } catch (e) {
      return { id: req.id, ok: false, error: String((e as Error).message ?? e) };
    }
  });

  server.listen(sockPath, () => {
    writeLog({ source: "daemon", level: "info", body: `daemon listening on ${sockPath}` });
  });

  // Graceful shutdown
  const shutdown = async () => {
    try { server.close(); } catch {}
    try { await context.close(); } catch {}
    try { await fs.rm(sockPath, { force: true }); } catch {}
    try { await fs.rm(cfg.daemonPidFile, { force: true }); } catch {}
    logWriter.end();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  // If the browser is closed manually, shut down
  context.on("close", () => shutdown());
}

function todayStamp() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

main().catch((e) => {
  console.error("fiber-snatcher daemon crashed:", e);
  process.exit(1);
});
