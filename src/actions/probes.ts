/** Probes are the eval library: named JS snippets saved to the repo's store and
 *  replayed in the page. They inherit V1's power (arbitrary evaluation) but trade
 *  its per-call `--yes-i-know` for session-level consent — granted once with
 *  `--allow` (held for the daemon's life) or implied by an open session, so a
 *  driving agent isn't re-prompted on every probe. */

import { FsErrorShaped, type ActionDef, type PipelineCtx } from "../pipeline/contracts.ts";
import { macroContext } from "../macros/context.ts";
import { isSessionActive } from "./sessions.ts";

// Daemon-lifetime consent: the first --allow (or any open session) unlocks probe
// execution for the rest of this daemon's life.
let probeConsent = false;

const badArgs = (message: string, hint: string) => new FsErrorShaped({ code: "E_BAD_ARGS", message, hint });

export type ProbeArgs = { sub?: string; name?: string; body?: string; desc?: string; tag?: string; allow?: boolean };

export const probeActions: ActionDef<ProbeArgs>[] = [
  {
    name: "probe",
    summary: "Eval library: probe save <name> [--desc --tag] (stdin/--from-file) | probe run <name> [--allow] | probe list",
    target: "none",
    observation: true,
    settle: false,
    async run(ctx: PipelineCtx, args: ProbeArgs) {
      const { store } = await macroContext();
      switch (args.sub) {
        case "list":
          return store.list("probes").map((name) => {
            const meta = parseProbe(store.read("probes", name));
            return { name, description: meta.description, tags: meta.tags };
          });

        case "save": {
          if (!args.name) throw badArgs("probe save needs a name", "fs probe save check-rows --desc '…' < probe.js");
          if (!args.body || !args.body.trim()) throw badArgs("probe save needs code on stdin or --from-file", "echo 'document.title' | fs probe save title");
          const path = store.write("probes", args.name, buildProbeFile(args.body, args.desc, args.tag));
          return { saved: path, name: args.name };
        }

        case "run": {
          if (!args.name) throw badArgs("probe run needs a name", "fs probe run <name> — see `fs probe list`");
          if (args.allow) probeConsent = true;
          if (!probeConsent && !isSessionActive()) {
            throw badArgs(
              "probe run needs consent — it evaluates arbitrary JS in the page",
              "grant once with `fs probe run <name> --allow`, or `fs session start <goal>` (a session implies consent)"
            );
          }
          if (!store.entryExists("probes", args.name)) throw badArgs(`no probe "${args.name}"`, "`fs probe list` to see what's saved");
          const { code } = parseProbe(store.read("probes", args.name));
          return await evalProbe(ctx, code);
        }

        default:
          throw badArgs(`unknown probe subcommand "${args.sub ?? ""}"`, "use: save <name> | run <name> | list");
      }
    },
  },
];

/** Run a probe body in the page. An expression returns its value; statements are
 *  allowed if they `return`, and `await` works (the body runs as an async fn). */
async function evalProbe(ctx: PipelineCtx, code: string): Promise<unknown> {
  try {
    return await ctx.page.evaluate((src: string) => {
      const wrapped = /\breturn\b/.test(src) ? src : `return (${src})`;
      const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (body: string) => () => Promise<unknown>;
      return new AsyncFunction(wrapped)();
    }, code);
  } catch (e) {
    throw new FsErrorShaped({
      code: "E_EVAL",
      message: String((e as Error).message ?? e),
      hint: "probe body: an expression, or statements with an explicit return; await is allowed",
    });
  }
}

/** A probe file is optional `// key: value` header lines followed by the code.
 *  Parsing stops at the first line that isn't a recognised header, so a code
 *  comment further down is never mistaken for metadata. */
function parseProbe(text: string): { description?: string; tags: string[]; code: string } {
  const lines = text.split("\n");
  let description: string | undefined;
  const tags: string[] = [];
  let i = 0;
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === "") continue; // allow blank lines between headers
    const m = line.match(/^\/\/\s*(name|description|tags):\s*(.*)$/);
    if (!m) break;
    if (m[1] === "description") description = m[2]!.trim();
    else if (m[1] === "tags") tags.push(...m[2]!.split(",").map((t) => t.trim()).filter(Boolean));
    // `name` is redundant with the filename — ignored.
  }
  return { description, tags: tags.length ? tags : ["utility"], code: lines.slice(i).join("\n").trim() };
}

function buildProbeFile(code: string, desc?: string, tag?: string): string {
  const header: string[] = [];
  if (desc) header.push(`// description: ${desc}`);
  header.push(`// tags: ${tag || "utility"}`);
  return `${header.join("\n")}\n${code.trim()}\n`;
}
