import { promises as fs } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { ok, err, type Result } from "../core/result.ts";
import { requireConfig } from "../core/config.ts";
import { controlSocketPath } from "../core/browser.ts";
import { sendRequest } from "../core/ipc.ts";

export async function run(args: string[]): Promise<Result> {
  const [sub, ...rest] = args;
  const cfg = await requireConfig();

  switch (sub) {
    case "key": {
      const key = (await fs.readFile(cfg.authKeyPath, "utf8")).trim();
      return ok({ header: cfg.authHeader, key });
    }
    case "rotate": {
      const newKey = randomBytes(32).toString("hex");
      await fs.writeFile(cfg.authKeyPath, newKey + "\n", { mode: 0o600 });
      return ok({ header: cfg.authHeader, keyFingerprint: newKey.slice(0, 8) + "…" }, {
        code: "ROTATED",
        next_steps: ["Restart the daemon (`fiber-snatcher stop && fiber-snatcher start`) so the new header takes effect."],
      });
    }
    case "snapshot": {
      const name = rest[0] ?? "default";
      const out = join(cfg.profileDir, "..", "auth", `${name}.json`);
      // Ask the daemon to write storage state
      const res = await sendRequest(controlSocketPath(cfg), { id: "auth-snap", op: "eval", code: `"<unsupported: use browser_storage_state MCP tool in V1>"` }, 5000)
        .catch((e) => ({ id: "auth-snap", ok: false as const, error: String(e.message ?? e) }));
      return ok({ note: "V1 leans on Playwright MCP's browser_storage_state. See USAGE.md." });
    }
    default:
      return err("E_BAD_SUBCOMMAND", `auth <key|rotate|snapshot>`);
  }
}
