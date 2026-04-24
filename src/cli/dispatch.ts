import { ok, err, type Result } from "../core/result.ts";
import { requireConfig } from "../core/config.ts";
import { controlSocketPath } from "../core/browser.ts";
import { sendRequest } from "../core/ipc.ts";

/**
 * Reads JSON action from stdin. Optional --adapter flag selects which store.
 * Emits { before, after, changed } from the runtime surface.
 */
export async function run(args: string[]): Promise<Result> {
  const adapterIdx = args.indexOf("--adapter");
  const adapter = adapterIdx >= 0 ? args[adapterIdx + 1] : undefined;

  const stdinJson = await readStdin();
  if (!stdinJson.trim()) {
    return err("E_NO_ACTION", "No action provided on stdin.", {
      next_steps: [`Pipe a JSON action: echo '{"type":"X"}' | fiber-snatcher dispatch`],
    });
  }
  let action: unknown;
  try { action = JSON.parse(stdinJson); } catch (e) {
    return err("E_INVALID_JSON", "stdin must be valid JSON.", { context: { stdin: stdinJson.slice(0, 200) } });
  }

  const cfg = await requireConfig();
  const res = await sendRequest(controlSocketPath(cfg), { id: "dispatch", op: "dispatch", action, adapter }, 10000)
    .catch((e) => ({ id: "dispatch", ok: false as const, error: String(e.message ?? e) }));
  if (!res.ok) {
    return err("E_DISPATCH_FAILED", res.error, {
      next_steps: [
        "Ensure you've called `window.__snatcher__.register(name, adapter)` in app init.",
        "Run `fiber-snatcher status` to see registered adapters.",
      ],
    });
  }
  const data = res.data as { before: unknown; after: unknown; changed: boolean };
  return ok(data, {
    warnings: data.changed ? undefined : ["Action had no effect (state unchanged)."],
  });
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) { resolve(""); return; }
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
  });
}
