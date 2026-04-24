/**
 * `fiber-snatcher init` — scaffold target project.
 *
 * Creates .fiber-snatcher/ with config.json, auth key, profile dir, logs dir,
 * shots dir. Copies inject files into .fiber-snatcher/runtime/. Merges into
 * the project's .mcp.json. Does NOT touch the project's source code —
 * integration is spelled out in USAGE.md and the user wires it up.
 */

import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { ok, err, type Result } from "../core/result.ts";
import { DEFAULT_AUTH_HEADER, writeConfig, type FsConfig } from "../core/config.ts";
import { detectPm } from "../core/pm.ts";
import { resolveTargetRoot } from "../core/paths.ts";
import { controlSocketPath } from "../core/browser.ts";
import { sendRequest } from "../core/ipc.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");

export async function run(args: string[]): Promise<Result> {
  const force = args.includes("--force");
  const noMcp = args.includes("--no-mcp");
  const forceMcp = args.includes("--force-mcp");
  const root = await resolveTargetRoot();
  const dataDir = join(root, ".fiber-snatcher");

  // Read target package.json to learn the dev port and PM
  const pkgPath = join(root, "package.json");
  if (!existsSync(pkgPath)) {
    return err("E_NOT_A_PROJECT", "No package.json found walking up from cwd.", {
      next_steps: ["Run from inside a Next.js / React project, or pass --cwd <dir>."],
    });
  }
  const pkg = JSON.parse(await fs.readFile(pkgPath, "utf8"));
  const devScript: string = pkg.scripts?.dev ?? "";
  const portMatch = devScript.match(/-p\s+(\d+)/) ?? devScript.match(/--port[= ](\d+)/) ?? devScript.match(/PORT=(\d+)/);
  const port = portMatch ? Number(portMatch[1]) : 3000;
  if (port === 3000 || port === 5000) {
    // Per global CLAUDE.md policy — nag but don't block
  }

  // Abort if already initialized unless --force
  if (existsSync(join(dataDir, "config.json")) && !force) {
    return err("E_ALREADY_INIT", "fiber-snatcher already initialized here.", {
      context: { dataDir },
      next_steps: ["Pass --force to regenerate (will rotate auth key)."],
    });
  }

  // Create dir tree
  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(join(dataDir, "runtime"), { recursive: true });
  await fs.mkdir(join(dataDir, "logs"), { recursive: true });
  await fs.mkdir(join(dataDir, "shots"), { recursive: true });
  await fs.mkdir(join(dataDir, "auth"), { recursive: true });
  await fs.mkdir(join(dataDir, "browser-profile"), { recursive: true });

  // Copy inject files
  const injectFiles = ["expose.ts", "log-sink-route.ts", "devtools-hook.ts"];
  for (const f of injectFiles) {
    const src = join(REPO_ROOT, "src", "inject", f);
    const dst = join(dataDir, "runtime", f);
    await fs.copyFile(src, dst);
  }

  // Copy adapter files into runtime/adapters/
  await fs.mkdir(join(dataDir, "runtime", "adapters"), { recursive: true });
  const adapterFiles = ["jotai.ts", "tanstack-query.ts"];
  for (const f of adapterFiles) {
    const src = join(REPO_ROOT, "src", "inject", "adapters", f);
    const dst = join(dataDir, "runtime", "adapters", f);
    await fs.copyFile(src, dst);
  }

  // Auth key
  const authKeyPath = join(dataDir, "auth", "dev-key");
  const key = randomBytes(32).toString("hex");
  await fs.writeFile(authKeyPath, key + "\n", { mode: 0o600 });

  // Config
  const cfg: FsConfig = {
    version: "0.1.0",
    devUrl: `http://localhost:${port}`,
    authHeader: DEFAULT_AUTH_HEADER,
    authKeyPath,
    profileDir: join(dataDir, "browser-profile"),
    shotsDir: join(dataDir, "shots"),
    logsDir: join(dataDir, "logs"),
    daemonPidFile: join(dataDir, "daemon.pid"),
    cdpPortHint: 9222,
    sources: {
      nextDevCommand: `${await detectPm()} run dev`,
      pm: await detectPm(),
    },
    adapters: [],
  };
  await writeConfig(cfg);

  // .mcp.json handling — respect the "disabled at rest" pattern some projects
  // use (empty mcpServers deliberately left empty). Never silently modify an
  // existing file. Rules:
  //   --no-mcp                 → skip entirely
  //   --force-mcp              → merge unconditionally (old behavior)
  //   file does not exist      → create it with our template
  //   file exists              → skip, emit a mcp_skipped warning with guidance
  const mcpWarnings: string[] = [];
  const mcpPath = join(root, ".mcp.json");
  if (noMcp) {
    mcpWarnings.push(".mcp.json: skipped (--no-mcp). Merge manually from ~/Code/Claude/invasion-of-the-fiber-snatchers/mcp-template.json if desired.");
  } else {
    const mcpTemplate = JSON.parse(await fs.readFile(join(REPO_ROOT, "mcp-template.json"), "utf8"));
    const alreadyExists = existsSync(mcpPath);
    if (!alreadyExists) {
      await fs.writeFile(mcpPath, JSON.stringify({ mcpServers: mcpTemplate.mcpServers }, null, 2));
    } else if (forceMcp) {
      let existing: any = {};
      try { existing = JSON.parse(await fs.readFile(mcpPath, "utf8")); } catch {}
      existing.mcpServers = { ...(existing.mcpServers ?? {}), ...mcpTemplate.mcpServers };
      await fs.writeFile(mcpPath, JSON.stringify(existing, null, 2));
    } else {
      mcpWarnings.push(
        ".mcp.json: existing file left untouched. Some projects keep MCP servers disabled at rest. To merge the fiber-snatcher template (playwright, chrome-devtools, next-devtools), re-run with --force-mcp or copy manually from ~/Code/Claude/invasion-of-the-fiber-snatchers/mcp-template.json.",
      );
    }
  }

  // Gitignore append
  const giPath = join(root, ".gitignore");
  const ignoreLine = "\n# fiber-snatcher\n.fiber-snatcher/\n";
  if (existsSync(giPath)) {
    const gi = await fs.readFile(giPath, "utf8");
    if (!gi.includes(".fiber-snatcher/")) await fs.appendFile(giPath, ignoreLine);
  } else {
    await fs.writeFile(giPath, ignoreLine);
  }

  // If this was --force AND a daemon is running, auto-reload the page so the
  // new expose.ts runtime takes effect immediately. Without this, the browser
  // keeps running the old bundle until the next navigation and agents see
  // stale behavior.
  let reloaded = false;
  if (force && existsSync(cfg.daemonPidFile)) {
    const sock = controlSocketPath(cfg);
    if (existsSync(sock)) {
      try {
        const res = await sendRequest(sock, { id: "init-reload", op: "eval", code: "(async () => { location.reload(); return 'reloaded'; })()" }, 5000);
        if (res.ok) reloaded = true;
      } catch {}
    }
  }

  const finalWarnings = [...mcpWarnings];
  if (force && !reloaded && existsSync(cfg.daemonPidFile)) {
    finalWarnings.push("Daemon is running but auto-reload failed. Run `fiber-snatcher navigate <path>` or reload the browser manually to pick up the new runtime.");
  }

  return ok(
    {
      root,
      dataDir,
      devUrl: cfg.devUrl,
      pm: cfg.sources.pm,
      authKeyFingerprint: key.slice(0, 8) + "…",
      browserReloaded: reloaded,
    },
    {
      code: "INITIALIZED",
      warnings: finalWarnings.length ? finalWarnings : undefined,
      next_steps: [
        "Read USAGE.md and wire `.fiber-snatcher/runtime/expose.ts` into your app/layout.tsx (dev-only import).",
        "If your app has auth: add the bypass header check per USAGE.md (middleware or your proxy.ts).",
        "Start your dev server, then run `fiber-snatcher start` to attach the browser.",
        "Run `fiber-snatcher doctor` to verify the full loop.",
      ],
    },
  );
}
