/** The `macro` verb: the action library's front door. list/show give progressive
 *  disclosure (names+descriptions first, the YAML body only on `show`); save
 *  validates before writing; from-journal drafts a flow from what was just
 *  driven; run replays a flow through the pipeline with params.
 *
 *  A run's OUTCOME lives in the returned data's `ok` field (with the per-step
 *  dump), not in the Response envelope — the `macro` command itself dispatched
 *  fine; whether the flow passed is the data. Structural problems (no such macro,
 *  invalid YAML, missing required param) still fail the envelope with a hint. */

import { FsErrorShaped, type ActionDef, type PipelineCtx } from "../pipeline/contracts.ts";
import { Journal, readJournal } from "../pipeline/journal.ts";
import { macroContext } from "../macros/context.ts";
import { parseMacro, stringifyMacro } from "../macros/format.ts";
import { draftFromJournal } from "../macros/record.ts";
import { resolveVars, runMacro } from "../macros/run.ts";

const badArgs = (message: string, hint: string) => new FsErrorShaped({ code: "E_BAD_ARGS", message, hint });

export type MacroArgs = {
  sub?: string;
  name?: string;
  body?: string; // YAML for save (read from stdin/--from-file by the CLI)
  params?: Record<string, string>;
  last?: number;
  from?: number;
  to?: number;
  stopOnError?: boolean;
};

export const macroActions: ActionDef<MacroArgs>[] = [
  {
    name: "macro",
    summary: "Action library: macro list | show <name> | run <name> [--param k=v] | from-journal [--last N] [--name n] | save <name>",
    target: "none",
    observation: true,
    settle: false,
    async run(ctx: PipelineCtx, args: MacroArgs) {
      const { store, runsDir, macroRunsDir } = await macroContext();
      const registry = await import("./registry.ts");
      const knownVerbs = new Set(registry.listActions().flatMap((a) => [a.name, ...(a.aliases ?? [])]));

      switch (args.sub) {
        case "list":
          // Progressive disclosure: the shape a chooser needs, never the bodies.
          return store.list("macros").map((name) => {
            const parsed = parseMacro(store.read("macros", name), { knownVerbs });
            const m = parsed.ok ? parsed.macro : undefined;
            return { name, description: m?.description, tags: m?.tags, steps: m?.steps.length, valid: parsed.ok };
          });

        case "show": {
          if (!args.name) throw badArgs("macro show needs a name", "fs macro show open-job-modal");
          if (!store.entryExists("macros", args.name)) throw badArgs(`no macro "${args.name}"`, "`fs macro list` for what's saved");
          return store.read("macros", args.name); // the body, on demand
        }

        case "save": {
          if (!args.name) throw badArgs("macro save needs a name", "fs macro save open-job-modal < flow.yaml");
          if (!args.body || !args.body.trim()) throw badArgs("macro save needs YAML on stdin or --from-file", "fs macro save open-job-modal --from-file flow.yaml");
          const parsed = parseMacro(args.body, { knownVerbs });
          if (!parsed.ok) throw badArgs(`macro did not validate:\n- ${parsed.errors.join("\n- ")}`, "fix the YAML and re-save");
          const path = store.write("macros", args.name, args.body);
          return { saved: path, name: args.name, steps: parsed.macro.steps.length };
        }

        case "from-journal": {
          const entries = await readJournal(runsDir).catch(() => []);
          if (entries.length === 0) throw badArgs("journal is empty — drive some actions, then lift them", "fs click …; fs fill …; then `fs macro from-journal --name flow`");
          const draft = draftFromJournal(entries, { name: args.name ?? "draft", lastN: args.last, fromSeq: args.from, toSeq: args.to });
          const yaml = stringifyMacro(draft);
          if (args.name) {
            const path = store.write("macros", args.name, yaml);
            return { saved: path, name: args.name, steps: draft.steps.length, yaml };
          }
          return { steps: draft.steps.length, yaml };
        }

        case "run": {
          if (!args.name) throw badArgs("macro run needs a name", "fs macro run open-job-modal --param job=JEGS");
          if (!store.entryExists("macros", args.name)) throw badArgs(`no macro "${args.name}"`, "`fs macro list` for what's saved");
          const parsed = parseMacro(store.read("macros", args.name), { knownVerbs });
          if (!parsed.ok) throw badArgs(`macro "${args.name}" is invalid:\n- ${parsed.errors.join("\n- ")}`, "edit it: `fs macro show` then fix the YAML");
          const vars = resolveVars(parsed.macro, args.params ?? {});
          if (!vars.ok) throw badArgs(vars.errors.join("; "), "pass values: --param name=value");

          const journal = new Journal(macroRunsDir);
          try {
            return await runMacro(ctx, { journal, lookup: registry.lookupAction }, parsed.macro, vars.vars, { stopOnError: args.stopOnError });
          } finally {
            await journal.close();
          }
        }

        default:
          throw badArgs(`unknown macro subcommand "${args.sub ?? ""}"`, "use: list | show <name> | run <name> | from-journal | save <name>");
      }
    },
  },
];
