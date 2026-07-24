# Decision ledger — adapter enablement (versable-builder + speedway)

<!-- sessions: fiber-snatcher-adapter@2026-07-25 -->

Decisions made with you away, for later review. Flip any of these and I'll rework.

1. **Branch:** work lands on `v2-adapters` off `v2` (not `main` — `v2`→`main` merge is still your call from SHIP.md). Commits per logical unit.
2. **Activity contract:** `Adapter` gained an optional `activity?: () => {pending, started}` field; `register()` wires it into the settle signal. The runtime method kept the name `queriesActivity` for pipeline contract stability, though it now aggregates all sources.
3. **Drain-hold semantics kept:** a mutating verb (incl. `dispatch`) holds its post-act drain until custom activity is quiet, exactly as it always did for TanStack — deemed by-design and pinned by a test, not "fixed".
4. **Project adapter path:** `.fiber-snatcher/adapter.js`, injected as an init script after the runtime bundle on every document. 512 KiB cap. Broken files fail in isolation; `doctor` gets a `project-adapter` probe whose warn state flags present-but-silent files.
5. **Native dialogs are core surfaces:** added `dialog[open]` to `SURFACE_SELECTOR` in the runtime (labeled `dialog:`), rather than per-project adapt config — an open native dialog is a surface on any app. Benefits speedway's identical kit.
6. **Kit adapter scope (playground):** modal OPEN only via real UI clicks — the kit's modal state lives in jotai *default-store* atoms unreachable from an injected script (no Provider to fiber-discover). Dispatch ops are `list` and `closeModal` (native `dialog.close()`, same path as the kit's own ESC). A kit-side dev handle (e.g. exposing the store on window in dev) would unlock full open/args dispatch but needs a Versable commit — left as a proposal for you.
7. **Existing playground config patched, not re-inited:** found `.fiber-snatcher/` already present with stale `devUrl localhost:3000`; patched the one field to `:5104` instead of `fs init --force` (which would rotate the auth key and reset the profile).
8. **Pre-existing test debt fixed as a rider:** `smoke.test.ts` pinned runtime version literal `"2.0.0"` (stale since the 2.1.0 bump); now compares `RUNTIME_VERSION`.
9. **No Versable-repo commits, ever, this workstream.** All Versable-side files live in gitignored `.fiber-snatcher/`. No `.mcp.json` was touched.
10. **Mid-turn goal accepted (your message):** vb-fable gets the tool + an open fix-loop — it tasks me with issues over ipc, I fix and it re-verifies, until it calls the tool working. My inbox monitor wakes this session on its messages.
11. **Speedway sequencing:** bloop 2 (RR7 adapter built into discovery + routes-from-live-router + auth via existing e2e creds) starts after bloop 1's gate closes. `:5105` is never touched (another session's server); speedway drives via the pm2 `speedway-fe` on `:5101`.

12. **Stop-race fix scoped to V2 only (commit 404b069):** chasing a live repro (stop→navigate lost its destination 3/3) surfaced three coupled holes — close acked before shutdown, no boot lock across the socket-probe window, unconditional pidfile deletion. Fixed in `bin/fs.ts` + `daemon/server.ts`; my accidental edits to V1's `src/cli/stop.ts` were reverted to honor the V1 freeze.
13. **Out-of-scope observation, needs your call:** `src/cli/{stop,status,clean,start}.ts` (the V1 `fiber-snatcher` binary) all read the V1 pidfile/socket and cannot see V2 daemons at all. Left untouched (frozen), but `fiber-snatcher stop` reporting "not running" while a V2 daemon lives is a standing confusion.

14. **Budget downgrade authorized by you (2026-07-25):** if the fable/5h window reads near-full, the wake no longer disarms — the session continues in degraded mode (minimal fable main-loop output, all heavy work on opus-pinned sub-agent seats). Note: a session cannot swap its own main-loop model; delegation to opus seats is the mechanism. Wake job re-armed as 566e960b with this behavior.

15. **Gate verdict ISSUES-FOUND, all dispositioned (commit e4a0eff):** reserved adapter names (`queries`/`jotai` now rejected by `register()`), activity reads coerced+clamped, throwing sources named by a doctor warn. Full report + dispositions: `.claude/output/20260725-bloop1-validation/report.md`. Two accepted-no-action items you may want to eyeball: the runtimeVersion pin is structurally tautological (guards injection failure only), and a source claiming an absurd-but-finite pending count is honored as in-flight (can't distinguish honest from buggy).

_Appended as further decisions land._
