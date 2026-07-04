/** Delegated vision (telemetry T4). A screenshot is read by a LOCAL vision model
 *  and only its TEXT description comes back to the agent — the pixels never enter
 *  the tool result, so a visual read costs almost no context and no dollars.
 *
 *  The reader is the user's `see` CLI (local-only, never uploads). We shell out
 *  to it in `--json` mode and hand back the text. When `see` is not installed we
 *  fail with a self-describing error that names the dependency rather than a bare
 *  "command not found". */

import { FsErrorShaped } from "../pipeline/contracts.ts";

export type VisionResult = { description: string; model?: string; ms?: number };

/** Run the local vision model over an image on disk. `prompt` turns the read
 *  into a grounded question ("is the modal open?") instead of a full description. */
export async function runVision(imagePath: string, prompt?: string): Promise<VisionResult> {
  const bin = Bun.which("see");
  if (!bin) {
    throw new FsErrorShaped({
      code: "E_INTERNAL",
      message: "the `see` vision CLI is not installed",
      hint: "`look` pipes a screenshot through the local `see` command (github: the user's local-models kit). Install `see` on PATH, or use `shoot` for a raw screenshot.",
    });
  }

  const argv = prompt ? [bin, imagePath, prompt, "--json"] : [bin, imagePath, "--json"];
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (code !== 0) {
    throw new FsErrorShaped({
      code: "E_INTERNAL",
      message: `see exited ${code}: ${(err || out).split("\n")[0]?.slice(0, 200) ?? "no output"}`,
      hint: "check the local vision model is available (`see --help`); is a model pulled?",
    });
  }

  // --json mode returns {ok, text, model, ms}; fall back to raw stdout if the
  // shape ever changes so a `look` still yields the description.
  try {
    const parsed = JSON.parse(out) as { ok?: boolean; text?: string; model?: string; ms?: number };
    if (parsed && typeof parsed.text === "string") {
      return { description: parsed.text.trim(), model: parsed.model, ms: parsed.ms };
    }
  } catch {
    /* not JSON — use raw text below */
  }
  return { description: out.trim() };
}
