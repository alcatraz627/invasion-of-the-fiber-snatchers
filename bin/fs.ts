#!/usr/bin/env bun
/** V2 CLI entry: parse → auto-start daemon → request → print. One invocation
 *  does everything, cold or warm (`fs click "Save"` works from a dead start). */

import { requireConfig, ConfigError } from "../src/core/config.ts";
import { connectDaemon } from "../src/daemon/lifecycle.ts";
import { parseArgv, inferTarget } from "../src/cli/parse.ts";
import { printResponse } from "../src/cli/print.ts";
import { lookupAction, listActions } from "../src/actions/registry.ts";
import { runDoctorCli, renderDoctor } from "../src/actions/doctor.ts";
import { DEFAULT_WAIT_TIMEOUT_MS } from "../src/pipeline/waits.ts";

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

/** Collect every `--param k=v` (repeatable — the flat flag parser keeps only the
 *  last, so we re-scan argv) into a name->value map. */
function collectParams(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    let kv: string | undefined;
    if (a === "--param") {
      const v = argv[i + 1];
      if (v && !v.startsWith("--")) kv = v;
    } else if (a?.startsWith("--param=")) {
      kv = a.slice("--param=".length);
    }
    if (kv) {
      const j = kv.indexOf("=");
      if (j > 0) out[kv.slice(0, j)] = kv.slice(j + 1);
    }
  }
  return out;
}

/** YAML/JS body for `macro save` / `probe save`: a --from-file wins, else stdin
 *  (only when piped — a TTY would block). */
async function readBody(flags: Record<string, string | number | boolean>): Promise<string> {
  if (typeof flags["from-file"] === "string") return await Bun.file(flags["from-file"]).text();
  if (!process.stdin.isTTY) return await Bun.stdin.text();
  return "";
}

function coerceScalar(v: string | number | boolean): unknown {
  if (typeof v !== "string") return v;
  if (v === "true") return true;
  if (v === "false") return false;
  if (v === "null") return null;
  return v;
}

/** Build an `expect` spec from `expect <kind> …`. */
function buildExpectSpec(positionals: string[], flags: Record<string, string | number | boolean>): Record<string, unknown> {
  const kind = positionals[0];
  const spec: Record<string, unknown> = {};
  if (kind === "text") spec.text = positionals.slice(1).join(" ");
  else if (kind === "count") spec.count = { select: positionals[1], equals: Number(positionals[2]) };
  else if (kind === "settled") spec.settled = true;
  else if (kind === "state") {
    const expr = positionals.slice(1).join(" ") || (typeof flags.expr === "string" ? flags.expr : "");
    const st: Record<string, unknown> = { expr };
    if (flags.truthy) st.truthy = true;
    else if (flags.equals !== undefined) st.equals = coerceScalar(flags.equals);
    spec.state = st;
  }
  if (typeof flags.timeout === "number") spec.timeoutMs = flags.timeout;
  return spec;
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
      case "hover":
        args.target = inferTarget(positionals.join(" ") || undefined, flags);
        if (typeof flags.hold === "number") args.hold = flags.hold;
        break;
      case "dblclick":
      case "rclick":
        args.target = inferTarget(positionals.join(" ") || undefined, flags);
        break;
      case "drag": {
        // Two targets, each from its own positional; flags aren't applied to
        // target inference here (one --css can't disambiguate two elements). Use
        // refs/CSS/intent per positional: `fs drag "#a" "#b"` or `fs drag e12 e15`.
        if (positionals.length < 2) {
          console.log('✗ E_BAD_ARGS: drag needs a source and a dest — `fs drag "<source>" "<dest>"`');
          return 1;
        }
        args.target = inferTarget(positionals[0], {});
        args.dest = inferTarget(positionals[1], {});
        if (typeof flags.via === "string") args.via = flags.via;
        break;
      }
      case "chord":
        args.keys = positionals[0];
        args.target = inferTarget(positionals[1], flags);
        break;
      case "type": {
        // Mirrors fill: with a target flag, all positionals are the text; else the
        // last positional is the text and everything before it is the target.
        const hasTargetFlag = flags.ref !== undefined || flags.css !== undefined || flags.component !== undefined;
        if (hasTargetFlag) {
          args.text = positionals.join(" ");
          args.target = inferTarget(undefined, flags);
        } else {
          if (positionals.length < 2) {
            console.log('✗ E_BAD_ARGS: type needs a target and text — `fs type "<target>" "hello"` (or --css/--ref + text)');
            return 1;
          }
          args.text = positionals[positionals.length - 1] ?? "";
          args.target = inferTarget(positionals.slice(0, -1).join(" ") || undefined, flags);
        }
        if (typeof flags.delay === "number") args.delay = flags.delay;
        break;
      }
      case "scroll": {
        if (flags["into-view"] !== undefined) {
          args.intoView = true;
          const iv = typeof flags["into-view"] === "string" ? flags["into-view"] : positionals.join(" ");
          args.target = inferTarget(iv || undefined, flags);
        } else {
          if (flags.to !== undefined) args.to = flags.to; // "top" | "bottom" | <y>
          if (typeof flags.by === "number") args.by = flags.by;
          // A positional (or --css) names the scroll container; absent → the window.
          const containerRaw = positionals.join(" ") || undefined;
          const t = inferTarget(containerRaw, flags);
          if (t) args.target = t;
        }
        break;
      }
      // WP3b verbs. select/paste mirror fill's "last positional is the value,
      // the rest is the target" split; a target flag (--css/--ref/--component)
      // makes every positional the value.
      case "select": {
        const explicit = typeof flags.option === "string" ? flags.option : undefined;
        const hasTargetFlag = flags.ref !== undefined || flags.css !== undefined || flags.component !== undefined;
        const minPositionals = hasTargetFlag ? 1 : 2;
        if (explicit === undefined && positionals.length < minPositionals) {
          console.log('✗ E_BAD_ARGS: select needs an option — `fs select <target> "<option>"` (or --option)');
          return 1;
        }
        args.option = explicit ?? positionals[positionals.length - 1] ?? "";
        const targetRaw = explicit !== undefined ? positionals.join(" ") : positionals.slice(0, -1).join(" ");
        args.target = inferTarget(targetRaw || undefined, flags);
        if (typeof flags.by === "string") args.by = flags.by;
        break;
      }
      case "paste": {
        const explicit = typeof flags.value === "string" ? flags.value : undefined;
        const hasTargetFlag = flags.ref !== undefined || flags.css !== undefined || flags.component !== undefined;
        const minPositionals = hasTargetFlag ? 1 : 2;
        if (explicit === undefined && positionals.length < minPositionals) {
          console.log('✗ E_BAD_ARGS: paste needs text — `fs paste <target> "<text>"` (or --value)');
          return 1;
        }
        args.text = explicit ?? positionals[positionals.length - 1] ?? "";
        const targetRaw = explicit !== undefined ? positionals.join(" ") : positionals.slice(0, -1).join(" ");
        args.target = inferTarget(targetRaw || undefined, flags);
        break;
      }
      case "upload": {
        // Files are the trailing positionals; the target is the first positional
        // OR a target flag (recommended for multi-word intent targets, which a
        // bare positional split can't distinguish from a path).
        const hasTargetFlag = flags.ref !== undefined || flags.css !== undefined || flags.component !== undefined;
        const files = hasTargetFlag ? positionals.slice() : positionals.slice(1);
        if (typeof flags.file === "string") files.push(flags.file);
        if (files.length === 0) {
          console.log("✗ E_BAD_ARGS: upload needs a file path — `fs upload --css <sel> <file...>` or `fs upload <target> <file...>`");
          return 1;
        }
        args.files = files;
        args.target = inferTarget(hasTargetFlag ? undefined : positionals[0], flags);
        break;
      }
      case "resize": {
        const w = positionals[0] ?? (typeof flags.width === "number" ? String(flags.width) : undefined);
        const h = positionals[1] ?? (typeof flags.height === "number" ? String(flags.height) : undefined);
        if (w === undefined || h === undefined) {
          console.log("✗ E_BAD_ARGS: resize needs width and height — `fs resize <width> <height>`");
          return 1;
        }
        args.width = Number(w);
        args.height = Number(h);
        break;
      }
      case "dismiss":
        // `fs close` normalizes to `dismiss` (see misc.ts). Optional close control;
        // bare `fs dismiss` presses Escape on the top surface.
        args.target = inferTarget(positionals.join(" ") || undefined, flags);
        break;
      case "wait": {
        // One condition per call, resolved from flags; the bare positional is a
        // wait-until-visible target. --timeout is the WAIT budget here (see the
        // request-timeout margin below), not a socket timeout.
        if (flags.settled) args.mode = "settled";
        else if (flags["network-idle"]) args.mode = "network-idle";
        else if (typeof flags.text === "string") { args.mode = "text"; args.text = flags.text; }
        else if (typeof flags.url === "string") { args.mode = "url"; args.url = flags.url; }
        else if (flags.gone !== undefined) {
          args.mode = "gone";
          const goneRaw = typeof flags.gone === "string" ? flags.gone : positionals.join(" ");
          args.target = inferTarget(goneRaw || undefined, flags);
        } else {
          args.mode = "target";
          args.target = inferTarget(positionals.join(" ") || undefined, flags);
        }
        if (typeof flags.timeout === "number") args.timeoutMs = flags.timeout;
        if (typeof flags.grace === "number") args.graceMs = flags.grace;
        break;
      }
      case "sleep":
        args.ms = typeof positionals[0] === "string" ? Number(positionals[0]) : (typeof flags.ms === "number" ? flags.ms : 0);
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
        // --at -3s / --at -3 / --at 3 all mean "the frame ~3 seconds ago".
        if (flags.at !== undefined) {
          const raw = typeof flags.at === "number" ? flags.at : parseFloat(String(flags.at));
          if (!Number.isNaN(raw)) args.at = Math.abs(raw);
        }
        break;
      case "look":
        if (typeof flags.selector === "string") args.selector = flags.selector;
        // The question can be a flag or a bare positional: `look "is it open?"`.
        args.prompt = typeof flags.prompt === "string" ? flags.prompt : positionals.length ? positionals.join(" ") : undefined;
        break;
      case "record":
        args.action = positionals[0];
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
      case "macro": {
        args.sub = positionals[0];
        if (positionals[1]) args.name = positionals[1];
        if (typeof flags.name === "string") args.name = flags.name; // --name for from-journal
        args.params = collectParams(argv);
        if (typeof flags.last === "number") args.last = flags.last;
        if (typeof flags.from === "number") args.from = flags.from;
        if (typeof flags.to === "number") args.to = flags.to;
        if (flags["continue-on-error"]) args.stopOnError = false;
        if (args.sub === "save") args.body = await readBody(flags);
        break;
      }
      case "session":
        args.sub = positionals[0];
        if (args.sub === "start") {
          const goal = positionals.slice(1).join(" ");
          if (goal) args.goal = goal;
        }
        if (typeof flags.name === "string") args.name = flags.name;
        break;
      case "expect":
        args.spec = buildExpectSpec(positionals, flags);
        break;
      case "probe": {
        args.sub = positionals[0];
        if (positionals[1]) args.name = positionals[1];
        if (typeof flags.desc === "string") args.desc = flags.desc;
        if (typeof flags.tag === "string") args.tag = flags.tag;
        if (flags.allow) args.allow = true;
        if (args.sub === "save") args.body = await readBody(flags);
        break;
      }
      case "stop":
        break;
      default:
        // ping/info/actions and future verbs pass through untouched.
        Object.assign(args, flags);
        if (positionals.length) args.target = inferTarget(positionals.join(" "), flags);
    }

    // Settle controls apply to mutating verbs uniformly, so no ActionDef repeats
    // them. --settled adds the debounce-aware post-condition; --quiet/--settle-
    // timeout tune the default settle pass; --grace and (with --settled) --timeout
    // tune the post-condition wait.
    const SETTLE_VERBS = new Set(["click", "fill", "press", "dispatch", "hover", "dblclick", "rclick", "drag", "chord", "type", "scroll"]);
    if (SETTLE_VERBS.has(cmd)) {
      if (flags.settled) args.settled = true;
      if (typeof flags.grace === "number") args.graceMs = flags.grace;
      if (flags.settled && typeof flags.timeout === "number") args.timeoutMs = flags.timeout;
    }
    if (typeof flags.quiet === "number") args.settleQuietMs = flags.quiet;
    if (typeof flags["settle-timeout"] === "number") args.settleTimeoutMs = flags["settle-timeout"];

    // wait/sleep, and a mutating verb with --settled, can block for their whole
    // budget; the socket request must outlast that or it kills the verb mid-wait.
    let reqTimeout = typeof flags.timeout === "number" ? flags.timeout : undefined;
    const blocks =
      cmd === "sleep" ? (Number(args.ms) || 0) :
      cmd === "wait" || (SETTLE_VERBS.has(cmd) && flags.settled)
        ? (typeof args.timeoutMs === "number" ? args.timeoutMs : DEFAULT_WAIT_TIMEOUT_MS)
        : cmd === "expect"
          ? ((args.spec as { timeoutMs?: number } | undefined)?.timeoutMs ?? 3_000)
          : cmd === "macro" && args.sub === "run"
            ? 120_000 // a flow can run many settling steps
            : undefined;
    if (blocks !== undefined) reqTimeout = Math.max(30_000, blocks + 5_000);
    // `look` shells out to the local vision model, which loads on first use;
    // the socket must outlast a cold model load, not the 30s default.
    if (cmd === "look") reqTimeout = Math.max(reqTimeout ?? 0, 120_000);

    const wireCmd = cmd === "stop" ? "close" : cmd;
    const res = await client.request(wireCmd, args, reqTimeout);
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
