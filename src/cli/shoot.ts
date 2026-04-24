import { join } from "node:path";
import { ok, err, type Result } from "../core/result.ts";
import { requireConfig } from "../core/config.ts";
import { controlSocketPath } from "../core/browser.ts";
import { sendRequest } from "../core/ipc.ts";

export async function run(args: string[]): Promise<Result> {
  // Treat values of known flags as NON-positional. Previously any non-"--"
  // arg was read as a selector, so `shoot --name diagnosis` picked "diagnosis"
  // as a CSS selector and Playwright hung waiting for an element. Bug #2.
  const FLAG_VALUE_AFTER = new Set(["--name", "--cwd", "--adapter"]);
  const FLAG_SELF = new Set(["--json", "--fullpage"]);
  const positional = args.filter((a, i) => {
    if (a.startsWith("--")) return false;
    const prev = args[i - 1];
    if (prev && FLAG_VALUE_AFTER.has(prev)) return false;
    return true;
  });
  const selector = positional[0];
  const nameIdx = args.indexOf("--name");
  const name = nameIdx >= 0 ? args[nameIdx + 1] : `shot-${Date.now()}`;

  const cfg = await requireConfig();
  const path = join(cfg.shotsDir, `${name}.png`);
  const res = await sendRequest(controlSocketPath(cfg), { id: "shoot", op: "shoot", selector, path }, 15000)
    .catch((e) => ({ id: "shoot", ok: false as const, error: String(e.message ?? e) }));
  if (!res.ok) return err("E_SHOOT_FAILED", res.error);
  return ok(res.data, { next_steps: [`Read via the Read tool or open in Preview.`] });
}
