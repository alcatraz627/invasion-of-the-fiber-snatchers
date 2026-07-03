#!/usr/bin/env bun
/** V2 CLI entry: parse → auto-start daemon → request → print. One invocation
 *  does everything, cold or warm (`fs click "Save"` works from a dead start). */

import { requireConfig, ConfigError } from "../src/core/config.ts";
import { connectDaemon } from "../src/daemon/lifecycle.ts";
import { parseArgv, inferTarget } from "../src/cli/parse.ts";
import { printResponse } from "../src/cli/print.ts";
import { listActions } from "../src/actions/registry.ts";

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
  const { cmd, positionals, flags } = parseArgv(argv);

  if (cmd === "help" || flags.help) {
    console.log(HELP);
    return 0;
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

  const client = await connectDaemon(cfg);
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
        args.value = positionals[positionals.length - 1] ?? "";
        args.target = inferTarget(positionals.slice(0, -1).join(" ") || undefined, flags);
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

// keep the import referenced for --help authoring parity with the daemon list
void listActions;
