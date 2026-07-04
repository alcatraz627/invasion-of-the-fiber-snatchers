# WP8 report — docs + doctrine

## Shipped
- CLAUDE.md rewritten for V2 agent readers: core loop, targeting table, wait
  vocabulary, profiles, session pattern, rules (incl. redaction limits + auth
  hygiene carried over from V1), what-not-to-use-it-for, V1 freeze note.
- CHANGELOG 2.0.0 entry (breaking/superseding, core, verbs, flows, profiles,
  and the "deliberately not done" decision list).
- package.json → 2.0.0; `fs` added as first bin; description updated.
- gcc doctrine note ~/.claude/conventions/agent-first-tools.md (5 obligations,
  15 principles, lived additions) + Tier-2 pointer row in ~/.claude/CLAUDE.md —
  the user-requested "prominent GCC note for tools Claude writes for Claude".

## Decisions ruled (right-sized, not built)
- close→shutdown wire rename: SKIPPED — dismiss+alias works; zero user impact.
- chord/press collapse: SKIPPED — both self-documenting; no confusion observed.
- press --verify: SKIPPED — `dismiss` covers the need.
Rationale: cosmetic churn on a working surface fails the right-sizing gate.

## Deferred (needs a deliberate contract-thaw round, not WP8)
- Per-subscriber push + watch GC on disconnect (WP6 handoffs).
- Type-accurate journal redaction (WP4 handoff; JournalEntry change).
- explore-profile count as a real digest field (WP5 deviation, accepted as-is).

## Not done in WP8
- USAGE.md full rewrite: superseded by task #20 (product documentation run),
  which owns the human-facing docs for both the user and the public repo.
