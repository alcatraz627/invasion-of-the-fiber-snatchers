import { ok, err, type Result } from "../core/result.ts";
import { requireConfig } from "../core/config.ts";
import { controlSocketPath } from "../core/browser.ts";
import { sendRequest } from "../core/ipc.ts";

export async function run(args: string[]): Promise<Result> {
  const selector = args.find((a) => !a.startsWith("--"));
  const full = args.includes("--full");
  const shallow = args.includes("--shallow");
  const opts = { full, shallow };
  const cfg = await requireConfig();
  const res = await sendRequest(controlSocketPath(cfg), { id: "state", op: "state", selector, opts }, 10000)
    .catch((e) => ({ id: "state", ok: false as const, error: String(e.message ?? e) }));
  if (!res.ok) {
    return err("E_STATE_FAILED", res.error, {
      next_steps: [
        "Is `fiber-snatcher start` running? Check `fiber-snatcher status`.",
        "Is expose.ts imported in your app/layout.tsx (dev-only)? See USAGE.md.",
      ],
    });
  }
  return ok(res.data);
}
