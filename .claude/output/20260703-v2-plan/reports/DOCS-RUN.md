# DOCS-RUN: friction found while writing the V2 docs

Written 2026-07-04 while producing `docs/DRIVING.md` (owner quickstart) and the
`README.md` rewrite (public surface). Every claim below was checked against the
real CLI: the verb surface came from `bun bin/fs.ts help` (registry-generated) and
the source under `src/actions/`, and the behaviors came from driving a real
headless daemon against the fixture app through the e2e harness (`validate*.ts`
throwaways). Where I cite an output, I saw it print.

Two lists: friction for the owner (things I had to reverse-engineer, naming
confusions, missing affordances, config rough edges), and adoption blockers for a
stranger's first ten minutes. Effort tags: tiny (< 30 min), small (a few hours),
medium (~a day), large (multi-day).

## A. Owner onboarding friction

Ranked by how much it slowed me down or would mislead the next agent.

### A1. `install.sh` never links `fs`, so the V2 CLI is not on PATH

`scripts/install.sh` builds a launcher for `fiber-snatcher` only (`BIN_DST=$HOME/.local/bin/fiber-snatcher`). `package.json` declares both bins (`"fs"` and `"fiber-snatcher"`), but nothing links `fs`. On this machine right now `which fs` returns nothing while `fiber-snatcher` resolves. Every V2 example (CLAUDE.md, the plan, the reports, my new docs) calls `fs`, so the documented tool is not installed by the documented install step. I had to add a manual launcher in the README to make the quickstart real. Effort: **tiny**. Add an `fs` launcher block to `install.sh` mirroring the `fiber-snatcher` one.

### A2. The digest's flagship signal is invisible in the default output

`src/cli/print.ts:40-48` renders the one-line digest from `mutations / url / queries / errors` only. `surfaces`, `focus`, and `counts` are in the digest object but never printed in text mode. CLAUDE.md's core-loop example advertises `Δ mutations:minor  surfaces:+dialog:Preview  queries:settled` as what you see; you do not. Driving it: `fs click "Failed only"` printed `Δ mutations:major  queries:settled`, and only `--json` carried `focus: "Showing failed"` and `counts: { "table:PartsTable": [50, 8] }`. The `surfaces:+dialog:Preview` shape in CLAUDE.md is not even the JSON encoding (`surfaces: { opened: ["dialog:Preview Modal"] }`). This is the biggest doc/behavior drift: the surface-delta is the headline feature and it does not appear where the primary doc says it does. Effort: **small**. Render `surfaces`/`focus`/`counts` in the text digest one-liner (preferred), or fix the CLAUDE.md example to match reality. I documented the real behavior in DRIVING.md, but the tool should probably close the gap rather than the doc.

### A3. There is no `fs init`; bootstrapping needs the other CLI

The `fs` registry has no `init`. A fresh project errors with `E_NOT_INITIALIZED: … Run \`fiber-snatcher init\` first` (`src/core/config.ts:63`), so you switch to the V1 CLI to scaffold `.fiber-snatcher/config.json`, then switch back to `fs` to drive. I only worked out the two-CLI split by reading `bin/fs.ts` and the harness (which hand-writes a config rather than calling `init` at all). The division (`fs` drives, `fiber-snatcher` bootstraps and owns V1) is defensible but undocumented and non-obvious. Effort: **small**. Add a thin `fs init` that shells to the V1 init, or state the split at the top of CLAUDE.md.

### A4. `init`'s printed next-steps are V1-era and wrong for V2

`src/cli/init.ts:174-179` tells the user to wire `.fiber-snatcher/runtime/expose.ts` into `layout.tsx` and add an auth-bypass check, then run `fiber-snatcher start`. In V2 the runtime is CDP-injected at daemon boot (per CHANGELOG 2.0.0), there is no app-side import, and `fs` auto-starts the daemon. A newcomer who follows `init`'s own output does obsolete work. Effort: **small**. Branch `init`'s warnings/next_steps on V2, or drop the wiring step.

### A5. The macro `expect` step has a save-passes / run-fails footgun

Assertions inside a macro must be an inline `expect:` field on a step (`src/macros/format.ts:47`, consumed at `src/macros/run.ts:257`). The natural authoring, a standalone step `verb: expect` with a top-level `text:`, passes `parseMacro` validation and saves fine (validateStep ignores unknown top-level fields), then fails at run with `expect needs a kind`, because `buildStepArgs` (`run.ts:139-145`) forwards only `args/value/key/target`, never a top-level `text`. I hit this directly on my first macro. The error is at run time, far from the authoring mistake. Effort: **small**. Reject a `verb: expect` step that carries a top-level assertion field at save time, with a hint to use the inline `expect:` form.

### A6. `watch` is a real command that `fs help` does not list

`fs watch console|route|network` is handled in `bin/fs.ts:228` (`runWatch`) and backed by daemon handlers (`src/daemon/server.ts:223,235`), but it is not an `ActionDef`, so the registry-generated command list omits it and the hand-written `daemon:` block does not include it either. It is absent from `fs help` output entirely. An agent relying on help for discovery will never find it. Effort: **tiny**. Add a `watch` line to the hand-written help block in `bin/fs.ts:buildHelp`.

### A7. Config file carries stale metadata and a version that lies

`init` writes `version: "0.1.0"` into `config.json` (`src/cli/init.ts:87`) even though the daemon/runtime is `2.0.0`. `src/core/config.ts:35-37` still comments `adapters: string[] // V1 supports "redux","zustand". V1.1 will add "tanstack-query","jotai"`, but the adapters are discovered from the fiber tree now, not listed here. Neither breaks anything, but both mislead a reader who trusts the config as documentation. Effort: **tiny**.

### A8. The macro/probe/session store lives behind an opaque repo hash

Saves land in `~/.claude/fiber-actions/<repo-key>/{macros,probes,sessions}/`, where `<repo-key>` is a 12-hex identity hash (e.g. `3ab9a5ad0862`). The only way I found where a macro went was reading the `saved:` path in the command output. Neither `fs info` nor `fs doctor` surfaces the store directory. Effort: **small**. Add the resolved store path to `fs info` (and/or a `fs macro where`).

### A9. `atoms` degrades silently on a production build

Against the fixture (a Bun production build), `fs atoms` returned a `degraded` note: the jotai dev-enumeration API (`dev4_get_mounted_atoms`) is absent, so atoms cannot be listed or read by name. This is correct behavior and the message is good, but it is a failure mode I only learned by running it. Worth a line in the atoms docs, since the enhancement-product dev build is fine but a prod-mode preview is not. Effort: **tiny** (doc only).

### A10. Naming overloads I had to hold in my head

- **`fs` vs `fiber-snatcher`**: two CLIs, one for V2 driving, one for V1 and `init`/lifecycle. The most load-bearing confusion (see A1, A3).
- **`dismiss` vs `close`**: `close` is an alias, but the wire command `close` is reserved for daemon shutdown (`stop` maps to it), so the verb is named `dismiss` internally (`src/actions/misc.ts:52-56`). An internal reason leaking into the surface.
- **`wait --call` vs `wait-call` vs `waitcall`**: the same network wait has three spellings; `fs wait --call` re-routes to the `wait-call` verb in `bin/fs.ts:195`.
- **`dismiss` bare = Escape only**: a modal with no Escape handler fails `fs dismiss` with `E_INTERNAL` ("still on screen after Escape and one retry"); you must name the control (`fs dismiss "Close"`). The name implies it finds the close control; it does not, unless you give it one.

## B. Public adoption blockers

A stranger cloning the public repo, ranked by how early they hit the wall. (Context: zero external users today, and the owner knows it.)

1. **`fs` is not installed by the install script** (same root as A1). Follow the README, run `bash scripts/install.sh`, type `fs page`, get "command not found." The single hardest wall, and it is the first command anyone runs. Effort: **tiny** (fix `install.sh`).
2. **Not published; git-clone-and-symlink only.** `package.json` has `"private": true` and no compiled entry. There is no `npx fiber-snatcher` / `bunx`. Install is clone plus `bun install` plus a shell script that assumes a fixed clone path and `~/.bun/bin/bun`. Effort: **medium** (unset private, add a bun-finding bin shim, publish).
3. **Bun required, no Node fallback.** Both bins are `.ts` run under Bun ≥ 1.3; a Node-only shop must install Bun first, and the install script hard-codes `~/.bun/bin/bun`. Effort: **medium** (ship a compiled single-file binary, a V2 goal that is still unbuilt).
4. **macOS-only in practice.** Unix-socket IPC; Linux untested, Windows unsupported. A Linux or Windows stranger is blocked at hello. Effort: **large** (portable transport).
5. **The two-CLI bootstrap is unexplained to a newcomer.** Nobody guesses that you `fiber-snatcher init` but drive with `fs`. My README now says it, but the friction is real. Effort: **small** (an `fs init` alias erases it).
6. **No runnable demo asset.** The README banner is decorative; there is no GIF, asciinema, or screenshot of a real session. A stranger cannot see it work before committing to the install. My 30-second transcript helps but a recorded cast lands harder, and `fs record` already produces frames to make one. Effort: **small**.
7. **`npx playwright install chromium` is an easy-to-miss one-time step.** Skip it and the daemon cannot boot a browser; the failure shows up as a boot timeout, not "run playwright install." Effort: **small** (`doctor` could detect a missing Chromium and say the exact command).
8. **The public repo ships the personal build apparatus.** `.claude/` is not gitignored (18 tracked files: the full `V2-PLAN.md`, `IMPLEMENTATION.md`, every `WP*.md`, `PERF-AUDIT.md`, and now this file). A stranger browsing the repo sees a lot of internal, gcc-flavored planning scaffolding. Fine if intentional (it is honest and shows the work), but worth a conscious keep/exclude decision. Effort: **tiny** (gitignore `.claude/` if you'd rather not ship it).

## What was smooth (so the list above stays honest)

`fs help` is genuinely accurate because it is registry-generated, which is why I could trust the verb surface. The error shapes are strong: ambiguous targets print the candidate list with refs and confidence, timeouts return the current page state, and `doctor` skips page-dependent probes instead of cascading false failures. The digest-in-JSON, the journal, `from-journal`, sessions, and parameterized macro replay all worked first try against the fixture. The friction is almost entirely at the install/init seam and in a few doc/behavior drifts, not in the driving loop itself.
