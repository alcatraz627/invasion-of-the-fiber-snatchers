#!/usr/bin/env bun
/** V2 CLI entry: parse → auto-start daemon → request → print. One invocation
 *  does everything, cold or warm (`fs click "Save"` works from a dead start). */

import { requireConfig, ConfigError } from "../src/core/config.ts";
import { connectDaemon } from "../src/daemon/lifecycle.ts";
import { parseArgv, inferTarget } from "../src/cli/parse.ts";
import { printResponse } from "../src/cli/print.ts";
import { lookupAction, listActions } from "../src/actions/registry.ts";
import { runDoctorCli, renderDoctor } from "../src/actions/doctor.ts";

/** Help is generated from the registry so the commands list can't drift from
 *  the verb table (WP0 shipped it hand-written and already out of sync). The
 *  header, daemon commands, and targets stay hand-written. */
function buildHelp(): string {
  const header = `fs — fiber-snatcher V2 (agent-first browser + React state driver)

usage: fs <command> [target] [args] [--flags]

targets (inferred; force with --ref/--css/--component):
  e12                     ref from a previous \`fs page\`
  "Export"                intent text (role+text match)
  'JobRow[title~="X"]'    component expression (fiber)
  '.toolbar button'       CSS (add --nth N if ambiguous)`;

  const verbs = listActions();
  const width = Math.min(26, Math.max(...verbs.map((v) => verbLabel(v).length)) + 2);
  const commands = verbs.map((v) => `  ${verbLabel(v).padEnd(width)}${v.summary}`).join("\n");

  const daemon = `daemon:
  info                    daemon + runtime status
  journal [--last N]      recent action log
  profile <name>          telemetry profile (explore|debug|verify|minimal)
  actions                 machine-readable verb list
  stop                    shut the daemon down`;

  const footer = `aliases show in (parens) and normalize to the primary verb.
--json on any command prints the raw Response envelope.`;

  return `${header}\n\ncommands:\n${commands}\n\n${daemon}\n\n${footer}`;
}

function verbLabel(v: { name: string; aliases?: string[] }): string {
  return v.aliases?.length ? `${v.name} (${v.aliases.join(", ")})` : v.name;
}

async function main() {
  const argv = process.argv.slice(2);
  const parsed = parseArgv(argv);
  const { positionals, flags } = parsed;
  // Aliases normalize to primary names so flag mapping below can't be skipped
  // by calling a verb under its alias (snapshot/goto/screenshot).
  const cmd = lookupAction(parsed.cmd)?.name ?? parsed.cmd;

  if (cmd === "help" || flags.help) {
    console.log(buildHelp());
    return 0;
  }
  if (flags.cwd !== undefined) {
    console.log("✗ E_BAD_ARGS: --cwd is not supported in V2; run from the target project directory");
    return 1;
  }

  // doctor diagnoses the environment, so it must NOT auto-start the daemon —
  // it runs its own probes and only queries the daemon if already up.
  if (cmd === "doctor") {
    const { healthy, probes } = await runDoctorCli();
    if (flags.json) console.log(JSON.stringify({ ok: healthy, data: { healthy, probes } }, null, 2));
    else console.log(renderDoctor(probes, healthy));
    return healthy ? 0 : 1;
  }

  let cfg;
  try {
    cfg = await requireConfig();
  } catch (e) {
    if (e instanceof ConfigError) {
      console.log(`✗ ${e.code}: ${e.message}`);
      return 1;
    }
    throw e;
  }

  // stop must not cold-boot a browser just to kill it
  const client = await connectDaemon(cfg, {}, { spawnIfDown: cmd !== "stop" });
  if (!client) {
    console.log("daemon not running");
    return 0;
  }
  try {
    const args: Record<string, unknown> = {};
    switch (cmd) {
      case "navigate":
      case "goto":
      case "nav":
        args.url = positionals[0] ?? cfg.devUrl;
        break;
      case "click": {
        args.target = inferTarget(positionals.join(" ") || undefined, flags);
        break;
      }
      case "fill": {
        // Last positional is the value; everything before it is the target.
        // An absent value must error, not silently clear the field.
        const explicitValue = typeof flags.value === "string" ? flags.value : undefined;
        const hasTargetFlag = flags.ref !== undefined || flags.css !== undefined || flags.component !== undefined;
        const minPositionals = hasTargetFlag ? 1 : 2;
        if (explicitValue === undefined && positionals.length < minPositionals) {
          console.log('✗ E_BAD_ARGS: fill needs a value — `fs fill <target> "<value>"` (or --value)');
          return 1;
        }
        args.value = explicitValue ?? positionals[positionals.length - 1] ?? "";
        const targetRaw = explicitValue !== undefined ? positionals.join(" ") : positionals.slice(0, -1).join(" ");
        args.target = inferTarget(targetRaw || undefined, flags);
        break;
      }
      case "press":
        args.key = positionals[0];
        args.target = inferTarget(positionals[1], flags);
        break;
      case "page":
        args.budget = flags.detailed ? "detailed" : "concise";
        if (typeof flags.scope === "string") args.scope = flags.scope;
        break;
      case "state":
        if (positionals[0]) args.selector = positionals[0];
        args.full = !!flags.full;
        args.shallow = !!flags.shallow;
        break;
      case "shoot":
        if (typeof flags.selector === "string") args.selector = flags.selector;
        if (typeof flags.path === "string") args.path = flags.path;
        break;
      case "eval": {
        const code = positionals.join(" ");
        args.code = code === "-" || code === "" ? await Bun.stdin.text() : code;
        break;
      }
      case "journal":
        if (typeof flags.last === "number") args.last = flags.last;
        if (typeof flags.run === "string") args.run = flags.run;
        break;
      case "profile":
        if (positionals[0]) args.profile = positionals[0];
        break;
      case "routes":
        break;
      case "remount":
        args.reset = !!flags.reset;
        break;
      case "count":
        args.selector = positionals[0];
        break;
      case "queries":
        if (positionals[0]) args.filter = positionals[0];
        break;
      case "atoms":
        if (positionals[0]) args.name = positionals[0];
        break;
      case "dispatch": {
        const raw = positionals.join(" ");
        args.action = raw === "-" || raw === "" ? await Bun.stdin.text() : raw;
        if (typeof flags.adapter === "string") args.adapter = flags.adapter;
        break;
      }
      case "stop":
        break;
      default:
        // ping/info/actions and future verbs pass through untouched.
        Object.assign(args, flags);
        if (positionals.length) args.target = inferTarget(positionals.join(" "), flags);
    }

    const wireCmd = cmd === "stop" ? "close" : cmd;
    const res = await client.request(wireCmd, args, typeof flags.timeout === "number" ? flags.timeout : undefined);
    return printResponse(res, !!flags.json);
  } finally {
    client.close();
  }
}

main().then(
  (code) => process.exit(code ?? 0),
  (e) => {
    console.error(`✗ ${String((e as Error).message ?? e)}`);
    process.exit(1);
  }
);
