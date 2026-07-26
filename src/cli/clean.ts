import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ok, type Result } from "../core/result.ts";
import { requireConfig } from "../core/config.ts";
import { controlSocketPath, v2DaemonPid, v2PidFile, v2SocketPath } from "../core/browser.ts";

export async function run(args: string[]): Promise<Result> {
  const cfg = await requireConfig();
  const removed: string[] = [];

  // Kill orphan daemon if pidfile exists but process is gone
  if (existsSync(cfg.daemonPidFile)) {
    const pid = Number((await fs.readFile(cfg.daemonPidFile, "utf8")).trim());
    const alive = (() => { try { process.kill(pid, 0); return true; } catch { return false; } })();
    if (!alive) {
      await fs.rm(cfg.daemonPidFile, { force: true });
      removed.push("daemon.pid (stale)");
    }
  }
  const sock = controlSocketPath(cfg);
  if (existsSync(sock) && !existsSync(cfg.daemonPidFile)) {
    await fs.rm(sock, { force: true });
    removed.push("control.sock");
  }

  // Same sweep for V2 state: only ever remove what a dead daemon left behind.
  const v2 = v2DaemonPid(cfg);
  if (v2.state === "stale") {
    await fs.rm(v2PidFile(cfg), { force: true });
    removed.push("daemon-v2.pid (stale)");
  }
  const sock2 = v2SocketPath(cfg);
  if (existsSync(sock2) && v2DaemonPid(cfg).state === "none") {
    await fs.rm(sock2, { force: true });
    removed.push("control-v2.sock");
  }

  // Tmp cleanup
  const tmp = join(cfg.profileDir, "..", "tmp");
  if (existsSync(tmp)) {
    await fs.rm(tmp, { recursive: true, force: true });
    removed.push("tmp/");
  }

  // Optional: drop old logs (>7 days)
  if (args.includes("--prune-logs")) {
    const files = await fs.readdir(cfg.logsDir).catch(() => []);
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    for (const f of files) {
      const p = join(cfg.logsDir, f);
      const s = await fs.stat(p).catch(() => null);
      if (s && s.mtimeMs < cutoff) { await fs.rm(p, { force: true }); removed.push(`logs/${f}`); }
    }
  }

  return ok({ removed });
}
