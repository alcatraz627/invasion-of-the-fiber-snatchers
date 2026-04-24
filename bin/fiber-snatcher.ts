#!/usr/bin/env bun
/**
 * Fiber Snatcher — CLI dispatcher
 *
 * Subcommands resolve to src/cli/<name>.ts with a default export `run(args)`.
 * Every command returns Result<T>; dispatcher prints it and sets exit code.
 */

import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderResult, type Result } from "../src/core/result.ts";

const COMMANDS = [
  "init",
  "start",
  "stop",
  "status",
  "doctor",
  "state",
  "dispatch",
  "eval",
  "shoot",
  "errors",
  "logs",
  "auth",
  "clean",
  "version",
  "help",
] as const;
type Command = (typeof COMMANDS)[number];

const HELP = `Fiber Snatcher — React dev-app debugging toolkit for Claude.

USAGE
  fiber-snatcher <command> [args] [--json]

COMMANDS (V1)
  init [--target <dir>]          Scaffold target project: inject files, .mcp.json, auth key
  start [--port <N>]             Launch headful Playwright against the dev server; start log daemon
  stop                           Close browser; stop daemon
  status                         Show running browser + daemon state
  doctor                         Verify: MCPs, dev server, debug surface, auth bypass — all reachable
  state [<selector>]             Read React state/props for nearest stateful fiber at selector
  dispatch                       Pipe JSON on stdin; routed to window.__snatcher__.dispatch
  eval <file.ts>                 Evaluate a TS file in the page (escape hatch; --yes-i-know required)
  shoot [<selector>]             Screenshot; saved to .fiber-snatcher/shots/
  errors [--since <dur>]         Unified digest: build + runtime + console + failed-network
  logs [--follow] [--source …]   Tail unified JSONL log
  auth <subcmd>                  key | rotate | snapshot <name>
  clean                          Kill orphan processes, clear .fiber-snatcher/tmp
  version                        Print version
  help                           This message

GLOBAL FLAGS
  --json                         Machine-readable output on stdout
  --cwd <dir>                    Run as if from a different target project

Docs: see ~/Code/Claude/invasion-of-the-fiber-snatchers/USAGE.md`;

async function main() {
  const [cmdRaw, ...rest] = process.argv.slice(2);
  const cmd = (cmdRaw ?? "help") as string;
  const jsonOut = rest.includes("--json");

  if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(HELP);
    process.exit(0);
  }
  if (cmd === "version" || cmd === "--version" || cmd === "-v") {
    const pkg = await import("../package.json", { with: { type: "json" } });
    console.log((pkg as any).default.version);
    process.exit(0);
  }

  if (!COMMANDS.includes(cmd as Command)) {
    renderErr({
      ok: false,
      code: "E_UNKNOWN_COMMAND",
      message: `Unknown command: ${cmd}`,
      next_steps: ["Run `fiber-snatcher help` to see commands."],
    }, jsonOut);
    process.exit(1);
  }

  const here = fileURLToPath(import.meta.url);
  const modPath = resolve(here, "..", "..", "src", "cli", `${cmd}.ts`);
  if (!existsSync(modPath)) {
    renderErr({
      ok: false,
      code: "E_COMMAND_NOT_IMPLEMENTED",
      message: `Command "${cmd}" is declared but not implemented yet.`,
      next_steps: [`Implement src/cli/${cmd}.ts with a default export run(args).`],
    }, jsonOut);
    process.exit(4);
  }

  const mod = (await import(modPath)) as { run: (args: string[]) => Promise<Result> };
  const result = await mod.run(rest);
  await renderResult(result, { json: jsonOut });
  process.exit(result.ok ? 0 : (result.exitCode ?? 1));
}

function renderErr(r: Result, json: boolean) {
  if (json) { console.log(JSON.stringify(r)); return; }
  if (r.ok) return; // only used for error paths
  console.error(`✖ ${r.code}: ${r.message}\n` + (r.next_steps ?? []).map(s => `  → ${s}`).join("\n"));
}

main().catch((e) => {
  console.error("fiber-snatcher: internal error:", e);
  process.exit(4);
});
