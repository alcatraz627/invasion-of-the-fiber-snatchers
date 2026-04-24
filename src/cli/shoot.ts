import { join } from "node:path";
import { ok, err, type Result } from "../core/result.ts";
import { requireConfig } from "../core/config.ts";
import { controlSocketPath } from "../core/browser.ts";
import { sendRequest } from "../core/ipc.ts";

export async function run(args: string[]): Promise<Result> {
  const selector = args.find((a) => !a.startsWith("--"));
  const nameIdx = args.indexOf("--name");
  const name = nameIdx >= 0 ? args[nameIdx + 1] : `shot-${Date.now()}`;

  const cfg = await requireConfig();
  const path = join(cfg.shotsDir, `${name}.png`);
  const res = await sendRequest(controlSocketPath(cfg), { id: "shoot", op: "shoot", selector, path }, 15000)
    .catch((e) => ({ id: "shoot", ok: false as const, error: String(e.message ?? e) }));
  if (!res.ok) return err("E_SHOOT_FAILED", res.error);
  return ok(res.data, { next_steps: [`Read via the Read tool or open in Preview.`] });
}
