#!/usr/bin/env bun
/** V2 CLI entry: parse → auto-start daemon → request → print. One invocation
 *  does everything, cold or warm (`fs click "Save"` works from a dead start). */

import { requireConfig, ConfigError } from "../src/core/config.ts";
import { connectDaemon } from "../src/daemon/lifecycle.ts";
import { parseArgv, inferTarget } from "../src/cli/parse.ts";
import { printResponse } from "../src/cli/print.ts";
import { lookupAction } from "../src/actions/registry.ts";

const HELP = `fs — fiber-snatcher V2 (agent-first browser + React state driver)

usage: fs <command> [target] [args] [--flags]

targets (inferred; force with --ref/--css/--component):
  e12                     ref from a previous \`fs page\`
  "Export"                intent text (role+text match)
  'JobRow[title~="X"]'    component expression (fiber)
  '.toolbar button'       CSS (add --nth N if ambiguous)

commands:
  navigate <url>          open url/path        reload            hard reload
  click <target>          click it             fill <t> <value>  fill input
  press <key> [target]    keyboard             page [--detailed] snapshot+refs
  state [selector]        fiber state          shoot [--selector] screenshot
  eval <code|->           run JS (- = stdin)   info              daemon status
  actions                 verb list            journal [--last N] action log
  profile <name>          telemetry profile    stop              kill daemon
  --json on anything      raw Response envelope`;

async function main() {
  const argv = process.argv.slice(2);
  const parsed = parseArgv(argv);
  const { positionals, flags } = parsed;
  // Aliases normalize to primary names so flag mapping below can't be skipped
  // by calling a verb under its alias (snapshot/goto/screenshot).
  const cmd = lookupAction(parsed.cmd)?.name ?? parsed.cmd;

  if (cmd === "help" || flags.help) {
    console.log(HELP);
    return 0;
  }
  if (flags.cwd !== undefined) {
    console.log("✗ E_BAD_ARGS: --cwd is not supported in V2; run from the target project directory");
    return 1;
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
