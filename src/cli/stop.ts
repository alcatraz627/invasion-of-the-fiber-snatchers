import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import { ok, err, type Result } from "../core/result.ts";
import { requireConfig } from "../core/config.ts";
import { controlSocketPath } from "../core/browser.ts";
import { sendRequest } from "../core/ipc.ts";

export async function run(): Promise<Result> {
  const cfg = await requireConfig();
  if (!existsSync(cfg.daemonPidFile)) {
    return ok({ wasRunning: false }, { code: "NOT_RUNNING" });
  }
  const pid = Number((await fs.readFile(cfg.daemonPidFile, "utf8")).trim());
  const sock = controlSocketPath(cfg);
  // Try graceful first
  if (existsSync(sock)) {
    try {
      await sendRequest(sock, { id: "stop", op: "close" }, 2000);
    } catch {}
  }
  // Escalate if still alive
  await new Promise((r) => setTimeout(r, 400));
  if (isAlive(pid)) {
    try { process.kill(pid, "SIGTERM"); } catch {}
    await new Promise((r) => setTimeout(r, 400));
  }
  if (isAlive(pid)) {
    try { process.kill(pid, "SIGKILL"); } catch {}
  }
  await fs.rm(cfg.daemonPidFile, { force: true });
  await fs.rm(sock, { force: true });
  return ok({ wasRunning: true, pid }, { code: "STOPPED" });
}

function isAlive(pid: number) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
