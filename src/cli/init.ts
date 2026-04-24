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

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");

export async function run(args: string[]): Promise<Result> {
  const force = args.includes("--force");
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

  // Merge mcp-template.json into target's .mcp.json
  const mcpTemplate = JSON.parse(await fs.readFile(join(REPO_ROOT, "mcp-template.json"), "utf8"));
  const mcpPath = join(root, ".mcp.json");
  let existingMcp: any = {};
  if (existsSync(mcpPath)) {
    try { existingMcp = JSON.parse(await fs.readFile(mcpPath, "utf8")); } catch {}
  }
  existingMcp.mcpServers = { ...(existingMcp.mcpServers ?? {}), ...mcpTemplate.mcpServers };
  await fs.writeFile(mcpPath, JSON.stringify(existingMcp, null, 2));

  // Gitignore append
  const giPath = join(root, ".gitignore");
  const ignoreLine = "\n# fiber-snatcher\n.fiber-snatcher/\n";
  if (existsSync(giPath)) {
    const gi = await fs.readFile(giPath, "utf8");
    if (!gi.includes(".fiber-snatcher/")) await fs.appendFile(giPath, ignoreLine);
  } else {
    await fs.writeFile(giPath, ignoreLine);
  }

  return ok(
    {
      root,
      dataDir,
      devUrl: cfg.devUrl,
      pm: cfg.sources.pm,
      authKeyFingerprint: key.slice(0, 8) + "…",
    },
    {
      code: "INITIALIZED",
      next_steps: [
        "Read USAGE.md and wire `.fiber-snatcher/runtime/expose.ts` into your app/layout.tsx (dev-only import).",
        "If your app has auth: add the bypass header check per USAGE.md (middleware or your proxy.ts).",
        "Start your dev server, then run `fiber-snatcher start` to attach the browser.",
        "Run `fiber-snatcher doctor` to verify the full loop.",
      ],
    },
  );
}
