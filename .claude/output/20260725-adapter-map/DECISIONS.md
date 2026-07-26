# Decision ledger — adapter enablement (versable-builder + speedway)

<!-- sessions: fiber-snatcher-adapter@2026-07-25 -->

Three sections, by what each asks of you. Detail for any entry on request.

## Needs your call (3)

1. **Ship it?** 15 commits sit on local `v2-adapters` — gate-validated twice, battery-blessed by vb-fable. Merging to `v2` and pushing is your call, as is the older open item from July 5: `v2` → `main` + tag `v2.1.0` (commands in `.claude/output/20260703-v2-plan/SHIP.md`). I touch neither without your word.
2. **Kit dev-handle.** Exposing the kit's modal store on `window` in dev builds (a small versable-builder commit) would unlock programmatic modal-open with args via `fs dispatch`. Today modal-open must be a real UI click. Build it, or keep click-driven?
3. **V1 lifecycle confusion.** The frozen V1 binary's `stop`/`status`/`clean` can't see V2 daemons — `fiber-snatcher stop` says "not running" while a V2 daemon lives. Unfreeze and fix, document only, or leave as-is?

## Defaults I chose — say so if you disagree, I'll rework

- `Adapter` gained an optional `activity()` field; the runtime method kept the name `queriesActivity` for contract stability.
- Mutating verbs' drain-hold extends to custom activity sources (matches TanStack behavior; pinned by a test, treated as by-design).
- Project adapters load from `.fiber-snatcher/adapter.js`: 512 KiB cap, isolated failure, `doctor` probes for present-but-silent files and throwing activity sources.
- `dialog[open]` went into the **core** surface selector rather than per-project adapt config.
- Reserved adapter names (`queries`/`jotai`/`router`) are rejected by `register()` with a clear error.
- The stop-race fix is V2-only; V1's `src/cli/stop.ts` stayed frozen.
- Orphan-fetcher exclusion is remount-gated instead of adding a config knob (a slow action with no hot-reload keeps blocking settle honestly). It has no hermetic test — the 30s window needs an injectable clock if you want it pinned.
- Two gate items accepted with no action: the smoke `runtimeVersion` pin is structurally tautological (guards injection failure only), and a source claiming an absurd-but-finite pending count is honored as in-flight.
- Speedway driving stayed strictly read-only in your workspaces; jobs→detail is unexercised on real data (the test workspace had zero jobs; vb-fable's battery covered it in its own workspace).
- vb-fable's once-seen digest counts race is tracked with a repro request (journal seq), not blind-patched.
- Existing `.fiber-snatcher` configs were patched in place (stale `devUrl` fields → `:5104`/`:5101`) instead of `--force` re-init, preserving auth keys and profiles.

## Round 2 (2026-07-27, your three approvals) — defaults chosen while executing

- **Kit dev-handle shipped and verified** (versable-builder `e293d21`, local — vb-fable asked that kit publishing stay theirs via release.sh; agreed, I push nothing there). Verified on speedway: open and close drive the real store to rendered dialogs; URL-controlled modals (new-job with `?new=1`) are properly driven by URL instead — documented to vb-fable.
- **NODE_ENV sweep rode along** (5 kit/toolkit files): `process.env?.NODE_ENV` defeats bundler static replacement, so every dev-only kit feature was silently off in client bundles. Same-class fix, flagged rather than silent.
- **I broke and repaired the playground service:** its pm2 runs `next start` (production) — I mistook it for a dev server and deleted `.next` as a "cache", crash-looping it. Rebuilt with the new kit, serving 200. The wrongly-assumed-dev lesson is logged.
- **Speedway dependency wiring handed to its owner** when my `pnpm install --force` materialized registry copies against their committed `^0.0.11` pin; vb-fable's `release.sh dev-link` was the known-good fix. Speedway healthy throughout.
- **v2.1.0 tagged at its historical commit (9620d19), adapter round became v2.2.0** — tagging 2.1.0 on a head full of adapter work would have mislabeled it.

## Record only (verified working; no plausible disagreement)

- Work on branch `v2-adapters` off `v2`; commits per logical unit; validation reports committed at `.claude/output/20260725-bloop1-validation/report.md` and `.claude/output/20260725-bloop2-validation/report.md`.
- The stale smoke version literal now compares `RUNTIME_VERSION`.
- No commits or pushes in any Versable repo; all app-side files live in gitignored `.fiber-snatcher/`.
- Your mid-turn goal ran to convergence: vb-fable's battery closed with "the adapter is genuinely good to drive"; its dropzone finding was fixed and pinned same-day.
- The wake job carried your downgrade-to-opus instruction, then snoozed itself when the mission completed. Efficacy events logged for both bloop runs.
