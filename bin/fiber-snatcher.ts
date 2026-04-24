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
  "components",
  "portal",
  "count",
  "dispatch",
  "atoms",
  "queries",
  "click",
  "fill",
  "press",
  "navigate",
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

LIFECYCLE
  init                  Scaffold .fiber-snatcher/, optional .mcp.json, auth key.
                        Flags: --force, --no-mcp, --force-mcp
  start                 Launch headful Playwright + daemon
  stop                  Close browser, end daemon
  status                Running? current URL, adapters, recent log
  doctor                End-to-end probe battery

INSPECT
  state [<selector>]    React state/props/hooks for nearest stateful fiber
                        Flags: --full (include React internals), --shallow
  components <name>     List mounted fibers with matching displayName
                        Flags: --count, --shallow, --full, --limit <N>
  portal <id>           Inspect document.getElementById(id) — children + portal origins
                        Flags: --dom-only, --count
  count <selector>      Shortcut: document.querySelectorAll(selector).length
  atoms [list|<name> [<value-json>] | watch <name> [--timeout] [--interval]]
                        Jotai: list / get / set / stream changes by debugLabel
  queries [<sub> [<key-json>] [<data-json>]]
                        TanStack Query: list / get / invalidate / refetch / reset / setData

DRIVE
  click <selector>          Playwright click (real input pipeline, fires React events)
  fill <selector> <value>   Playwright fill (dispatches input+change with bubbling)
  press <key> [--selector]  Keyboard press, optionally on a focused element
  navigate <url-or-path>    page.goto; relative paths resolved against devUrl
  dispatch                  Pipe JSON to the default adapter
  eval <file.ts>            TS-aware: transpiles + returns last expression (--yes-i-know required)

CAPTURE
  shoot [<selector>]    Screenshot to .fiber-snatcher/shots/
                        Flags: --name <tag>
  errors                Grouped error digest. Flags: --since <dur>
  logs                  Tail unified JSONL. Flags: --follow, --source, --level

CARE
  auth <sub>            key | rotate | snapshot <name>
  clean                 Remove stale pidfiles, sockets. Flags: --prune-logs
  version / help

GLOBAL FLAGS
  --json                Machine-readable output
  --cwd <dir>           Act on a different target project

Docs: ~/Code/Claude/invasion-of-the-fiber-snatchers/USAGE.md`;

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
  let result: Result;
  try {
    result = await mod.run(rest);
  } catch (e) {
    // Convert exceptions (like requireConfig → ConfigError) to a clean Result
    // so agents always see structured output, even outside a project dir.
    const err = e as { code?: string; message?: string };
    result = {
      ok: false,
      code: err.code ?? "E_INTERNAL",
      message: err.message ?? String(e),
      next_steps: err.code === "E_NOT_INITIALIZED"
        ? ["Run from inside a Next.js project, or pass --cwd <dir>.", "Or run `fiber-snatcher init` in the target project."]
        : undefined,
    };
  }
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
