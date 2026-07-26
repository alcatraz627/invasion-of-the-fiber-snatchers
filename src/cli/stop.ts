import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import { ok, err, type Result } from "../core/result.ts";
import { requireConfig } from "../core/config.ts";
import { controlSocketPath, v2DaemonPid, v2PidFile, v2SocketPath } from "../core/browser.ts";
import { sendRequest } from "../core/ipc.ts";

export async function run(): Promise<Result> {
  const cfg = await requireConfig();

  // A V2 daemon may hold this project. Its socket speaks the frame protocol
  // (this CLI can't ask it to close), but SIGTERM runs its clean shutdown
  // handler, browser close included.
  let v2: { wasRunning: boolean; pid?: number } = { wasRunning: false };
  const v2Live = v2DaemonPid(cfg);
  if (v2Live.state === "live" && v2Live.pid) {
    try { process.kill(v2Live.pid, "SIGTERM"); } catch {}
    if (!(await waitForDeath(v2Live.pid, 5000))) {
      try { process.kill(v2Live.pid, "SIGKILL"); } catch {}
      await waitForDeath(v2Live.pid, 1000);
    }
    await fs.rm(v2PidFile(cfg), { force: true });
    await fs.rm(v2SocketPath(cfg), { force: true });
    v2 = { wasRunning: true, pid: v2Live.pid };
  }

  if (!existsSync(cfg.daemonPidFile)) {
    return ok({ wasRunning: v2.wasRunning, v2 }, { code: v2.wasRunning ? "STOPPED" : "NOT_RUNNING" });
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
  return ok({ wasRunning: true, pid, v2 }, { code: "STOPPED" });
}

async function waitForDeath(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return !isAlive(pid);
}

function isAlive(pid: number) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
