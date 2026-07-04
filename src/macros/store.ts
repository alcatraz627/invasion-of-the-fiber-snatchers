/** The action library on disk: macros, session records, and probes for one repo.
 *  Keyed by repo identity (the git remote), not the working directory, so every
 *  worktree of the same project reads and writes the same library. The default
 *  root is ~/.claude/fiber-actions/<repo-key>/; a caller may pass an explicit
 *  root (the daemon threads one from config.json; tests point it at a tmp dir),
 *  so nothing here reads the environment — config is config.json's job. */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type StoreKind = "macros" | "sessions" | "probes";

/** Extensions by kind: macros are diffable YAML, probes are runnable JS, session
 *  records are structured JSON outcomes. */
export const KIND_EXT: Record<StoreKind, string> = {
  macros: ".yaml",
  sessions: ".json",
  probes: ".js",
};

/** Collapse the SSH and HTTPS forms of a remote to one identity, so `git@github
 *  .com:org/repo.git` and `https://github.com/org/repo.git` share a library. */
export function normalizeRemote(url: string): string {
  return url
    .trim()
    .toLowerCase()
    .replace(/^git\+/, "")
    .replace(/^https?:\/\//, "")
    .replace(/^ssh:\/\//, "")
    .replace(/^git@/, "")
    .replace(/:/g, "/") // git@host:org/repo -> host/org/repo
    .replace(/\.git$/, "")
    .replace(/\/+$/, "");
}

/** A short, filesystem-safe key derived from a repo-identity string. */
export function repoKeyFrom(identity: string): string {
  return createHash("sha256").update(identity).digest("hex").slice(0, 12);
}

/** Resolve this project's key: the git remote if there is one (stable across
 *  worktrees), else the repo toplevel, else the cwd — each hashed. The fallbacks
 *  are path-based, so a non-git tree still gets a stable-per-machine key. */
export function repoKey(cwd = process.cwd()): string {
  const remote = runGit(["remote", "get-url", "origin"], cwd);
  if (remote) return repoKeyFrom(`remote:${normalizeRemote(remote)}`);
  const top = runGit(["rev-parse", "--show-toplevel"], cwd);
  if (top) return repoKeyFrom(`path:${top.trim()}`);
  return repoKeyFrom(`path:${cwd}`);
}

function runGit(args: string[], cwd: string): string | null {
  try {
    const p = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "ignore" });
    if (p.exitCode !== 0) return null;
    const out = p.stdout.toString().trim();
    return out || null;
  } catch {
    return null;
  }
}

/** The default per-repo library root under the user's global gcc home. */
export function defaultStoreRoot(cwd = process.cwd()): string {
  return join(homedir(), ".claude", "fiber-actions", repoKey(cwd));
}

/** Guard a name: it becomes a filename, so no traversal, slashes, or dots. */
export function assertSafeName(name: string): string {
  if (!name || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name)) {
    throw new Error(`invalid name "${name}" — use letters, digits, dashes, underscores (e.g. open-job-modal)`);
  }
  return name;
}

/** A resolved library location. One instance == one repo's store; every method
 *  is pure filesystem I/O against `root`, which the caller resolved once. */
export class Store {
  constructor(readonly root: string) {}

  private kindDir(kind: StoreKind): string {
    const dir = join(this.root, kind);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  pathFor(kind: StoreKind, name: string): string {
    return join(this.kindDir(kind), assertSafeName(name) + KIND_EXT[kind]);
  }

  entryExists(kind: StoreKind, name: string): boolean {
    try {
      readFileSync(this.pathFor(kind, name));
      return true;
    } catch {
      return false;
    }
  }

  write(kind: StoreKind, name: string, content: string): string {
    const path = this.pathFor(kind, name);
    writeFileSync(path, content);
    return path;
  }

  read(kind: StoreKind, name: string): string {
    return readFileSync(this.pathFor(kind, name), "utf8");
  }

  remove(kind: StoreKind, name: string): void {
    rmSync(this.pathFor(kind, name), { force: true });
  }

  /** Entry names (without extension) for a kind, sorted. Missing dir -> []. */
  list(kind: StoreKind): string[] {
    const ext = KIND_EXT[kind];
    try {
      return readdirSync(this.kindDir(kind))
        .filter((f) => f.endsWith(ext))
        .map((f) => f.slice(0, -ext.length))
        .sort();
    } catch {
      return [];
    }
  }
}

/** Open the library for a repo: an explicit root (from config / tests) wins,
 *  otherwise the derived ~/.claude/fiber-actions/<repo-key> location. */
export function openStore(rootOverride?: string, cwd?: string): Store {
  return new Store(rootOverride || defaultStoreRoot(cwd));
}
