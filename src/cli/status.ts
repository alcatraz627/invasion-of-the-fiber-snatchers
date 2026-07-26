import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import { ok, err, type Result } from "../core/result.ts";
import { requireConfig } from "../core/config.ts";
import { controlSocketPath, v2DaemonPid } from "../core/browser.ts";
import { sendRequest } from "../core/ipc.ts";

export async function run(): Promise<Result> {
  const cfg = await requireConfig();
  const sock = controlSocketPath(cfg);
  // A V2 daemon on this project answers a different protocol; report its
  // liveness here rather than "not running" while it holds the browser.
  const v2 = v2DaemonPid(cfg);
  if (!existsSync(cfg.daemonPidFile)) {
    if (v2.state === "live") {
      return ok({ running: true, generation: 2, pid: v2.pid, devUrl: cfg.devUrl }, {
        code: "RUNNING_V2",
        next_steps: ["Use `fs info` / `fs doctor` for details; `fs stop` (or this CLI's stop) to stop it."],
      });
    }
    if (v2.state === "stale") {
      return ok({ running: false, generation: 2, pid: v2.pid, stale: true, devUrl: cfg.devUrl }, {
        code: "STALE_PID",
        next_steps: ["Run `fiber-snatcher clean` to remove stale V2 state."],
      });
    }
    return ok({ running: false, devUrl: cfg.devUrl }, { code: "NOT_RUNNING" });
  }
  const pid = Number((await fs.readFile(cfg.daemonPidFile, "utf8")).trim());
  const alive = isAlive(pid);
  if (!alive) {
    return ok({ running: false, pid, stale: true }, {
      code: "STALE_PID",
      next_steps: ["Run `fiber-snatcher clean` to remove stale state."],
    });
  }
  try {
    const info = await sendRequest(sock, { id: "status", op: "info" }, 3000);
    if (!info.ok) return err("E_DAEMON_NOT_RESPONDING", info.error);
    return ok({ running: true, pid, ...(info.data as Record<string, unknown>) }, { code: "RUNNING" });
  } catch (e) {
    return err("E_IPC_FAILED", String((e as Error).message), {
      next_steps: ["Daemon appears alive but socket is unresponsive. Try `fiber-snatcher stop` then `start`."],
    });
  }
}

function isAlive(pid: number) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
