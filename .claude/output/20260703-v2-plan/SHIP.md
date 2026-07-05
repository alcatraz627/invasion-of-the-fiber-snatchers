# Shipping V2 — handoff (git ops are yours to run)

The entire V2 build lives on the `v2` branch (65 commits ahead of `main`,
clean tree, 173 tests green, tsc clean). Git ops that publish are yours per the
no-push-without-approval rule; below is everything staged for you.

## Pre-flight (already verified)

- 173 tests pass, per-file (the full-fan `bun test` has a known load-sensitive
  boot-timeout flake — run per-file or with bounded concurrency; `PERF-AUDIT.md`).
- `bunx tsc --noEmit` clean.
- `.gitignore` decision still open: `.claude/output/` ships 20+ internal WP
  reports. Keep them (build history) or `git rm -r --cached .claude/output` +
  gitignore before publishing. Recommendation: keep on `v2`, gitignore only if
  you cut a clean public `main`.

## The ship commands (run yourself)

```sh
cd ~/Code/Claude/invasion-of-the-fiber-snatchers
git checkout main && git merge --no-ff v2 -m "Release 2.0.0 — agent-first rebuild"
git tag -a v2.0.0 -m "V2: refs, digests, waits, macros, adaptation layer"
git push origin main --tags          # fresh approval each time
bash scripts/install.sh              # relink ~/.local/bin/fs to the merged code
fs doctor                            # confirm the loop
```

Or keep `v2` as the working default and never touch `main` — your call. The
tool works today from `v2`; nothing blocks daily use.

## What shipped in this follow-up round (on top of the 8 WPs)

- WP60 per-project adaptation (`.fiber-snatcher/config.json` `adapt` block):
  non-ARIA surface selectors + overlay/prop tuning — Versable's URL-modal is now
  tracked; other codebases are a config edit.
- WP61 settle drain-first: ~166ms → ~65ms per quiet action.
- WP63 onboarding: `fs init` on the V2 CLI, version stamp, watch/init in help,
  macro expect-footgun guard.
- WP64 CLI startup: ~130ms → ~31ms per `fs` call (lazy Playwright/screencast).
- WP9/WP60 red-team: a fresh hostile agent found 6 breaks; 5 fixed (crash,
  token-flood, structural-keys, surface-pollution, byte-DoS), 1 reduced
  (cross-contamination, bounded to 0.7 confidence). Report: WP60-REDTEAM.md.

## Remaining (not blocking ship)

- **Contract-thaw batch** (its own focused unit, needs a frozen-contract note):
  type-accurate journal redaction (currently label/selector heuristic — works,
  additive fix available); watch GC on subscriber disconnect + per-subscriber
  push (broadcast works for single-consumer today). `signals` on TargetCandidate
  is already handled via the "(opens X)" text-fold — no thaw needed.
- **Cross-contamination residual**: two controls under one overlay wrapper both
  read its menu (0.7 confidence → ambiguity, not a wrong click). Full
  trigger-attribution is a hard problem; documented, not risked.
- **`fs init` still scaffolds the obsolete V1 `runtime/expose.ts` tree** (harmless,
  gitignored). A V2-only init is a small follow-up.
