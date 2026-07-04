# WP4 report — macros, sessions, probes

Branch: `v2-wp4` (worktree `fs-worktrees/wp4`, from `v2` at `74d47c6`, after WP2
merged). Commits: `7693ca2` (store + format) → `2852299` (run + from-journal) →
`532468f` (verbs + CLI + redaction) → `78e2db3` (e2e).

Status: built, behaviorally validated, live-driven. `bunx tsc --noEmit` clean;
`bun test` **105 pass / 0 fail / 326 expect across 11 files** (baseline was 58;
+35 unit, +12 e2e). **No frozen file touched** (`protocol/types.ts` and
`pipeline/contracts.ts` untouched), **no CONTRACT-CHANGE requests**. One
config-shape note and one coordinator decision to confirm are called out below.

## Built

### 1. Store — `src/macros/store.ts` (+ `context.ts`)
The action library on disk, keyed by **repo identity, not working directory**, so
every worktree of the same project shares one library. `repoKey()` hashes
`git remote get-url origin` (SSH/HTTPS forms normalized to one identity), falling
back to the repo toplevel, then the cwd. Default root
`~/.claude/fiber-actions/<repo-key>/{macros,sessions,probes}`. A `Store` object
carries a resolved root and does pure fs I/O; `openStore(root?)` resolves the
default or an explicit override. Names are guarded against path traversal.

`context.ts` resolves the store + journal dirs once per command from config, and
holds the single read of the **`actionsRoot` override** (see §deviations).

### 2. Format — `src/macros/format.ts`
The macro artifact is declarative YAML (Maestro's lesson: retries/waits in the
runtime, not the flow). `Macro` = name + description + tags + params + steps;
a step is `verb` + `target` + optional `value`/`key`/`args`/`expect`/`from`.
`validateMacro` collects **located, actionable errors** (never throws): unknown
verb with an edit-distance near-match, undeclared `%var%` in any string field,
`by:index|random` shape, `by:name|id` value, the tag allow-list, and expect kind.
The verb set is **injected** (`knownVerbs`), so format has no registry import and
no cycle. Depends on `yaml@2.9.0` (see §deps).

### 3. Run + assertions — `src/macros/run.ts`
- **`%var%` substitution** and `resolveVars` (declared defaults overlaid with
  `--param`; missing-required is a run-time error).
- **Target resolution** for the `by name|index|random|id` selection the research
  found missing in every surveyed tool: `name`→intent, `id`→ref/`#id`,
  `index`/`random`→enumerate the `select` set (CSS via `locator.count`+nth,
  intent/component via the pipeline's candidate resolver) and pick one.
- **`runMacro`** reconstructs a `PipelineDeps` from the `ctx` it's handed (same
  live `page`, same `gen` closure, a per-run `Journal`) and pushes each step
  through the **real `runAction`** — so a replay is identical to hand-driving,
  digest and journal included. Stop-on-error (default) returns the failing step's
  digest + its journal `seq`.
- **`runAssertion`** maps `text|count|state|settled` onto existing waits/reads;
  a miss is a recorded result, not a throw (that is what separates `expect` from
  `wait`).

### 4. from-journal — `src/macros/record.ts`
`draftFromJournal` lifts a journal slice (`--last N` / `--from`/`--to`) into a
draft macro: reads and smells (`sleep`) dropped, `navigate` keeps its url, each
action's **portable resolved text** becomes the target (never the
generation-scoped ref) with the original resolved descriptor kept in `from:` for
the agent that edits the draft. Empty `params` — the agent adds them.

### 5. Verbs + CLI — `src/actions/{macros,sessions,probes}.ts`, registry, `bin/fs.ts`
- **`macro`** list/show/run/from-journal/save. `list` is progressive disclosure
  (names + descriptions + tags, never the steps array); `show` returns the YAML.
- **`session`** start/end/status + **`expect`**. Active-session state is a
  module-level var — the daemon is one long-lived process, so it persists across
  separate CLI calls **without the daemon needing to know sessions exist**.
  `session end` recovers the journal slice by timestamp (`ts >= startedAt`; ISO
  sorts chronologically), emits a summary that doubles as a regression record,
  and dumps the journal slice + frame refs only on failure.
- **`probe`** save/run/list — the eval library, behind **session-level consent**
  replacing V1's per-call `--yes-i-know`: `--allow` grants it for the daemon's
  life, or an open session implies it. Bodies allow an expression, statements
  with `return`, and `await`.
- Registry: three appended rows. `bin/fs.ts`: arg-mapping for the four verbs
  (repeatable `--param` collected from argv, stdin/`--from-file` bodies, the
  `expect` spec builder, blocking request timeouts for `expect`/`macro run`).

### 6. Seed #29 — journal redaction — `src/pipeline/journal.ts` (surgical)
A `fill` on a secret-looking field is journaled with `value:"[redacted]"`. Keyed
on the **target descriptor** (resolved label or CSS selector matching a
secret/`[type=password]` pattern) — see the limitation in §deviations. Also added
a `lastSeq` read-accessor (the journal ref a macro/session dump cites).

## Acceptance criteria — evidence

| Criterion (IMPLEMENTATION.md §3-WP4) | Result |
|---|---|
| record open-modal flow from journal, replay | PASS — e2e "from-journal lifts…replays"; live drive: draft `open-close-modal`, replay with `surfaces.opened/closed:["dialog:Preview Modal"]` per step |
| replay with a `--param` on fixture | PASS — e2e "%vars% at run time" (`--param q="Part 42"`, verified via the app's input value); live `macro run search --param q="Part 7"` |
| failed assertion produces actionable dump | PASS — e2e "failed inline expect" (`data.ok:false`, `failedAt:0`, step digest + `expect.detail`); session e2e dumps `journalSlice` + `assertionFailures` |
| probes run from store | PASS — e2e "save then run" (consent gate refuses, `--allow` runs → row count 50); `probe list` tags |
| YAML schema-validated, actionable errors | PASS — 18 format unit tests; e2e "save rejects an invalid macro" (unknown-verb + near-match) |
| store keyed so worktrees share | PASS — store unit tests (SSH/HTTPS normalize to one key); repo-key from `git remote` |
| `actions list` progressive disclosure | PASS (as `macro list`) — names+descriptions, bodies via `show`; e2e asserts the listing carries no `verb` |
| seed #29 redaction | PASS — 5 redaction unit tests + e2e (`input[type=password]` fill journaled `[redacted]`, plaintext absent) |
| `tsc --noEmit` clean + `bun test` green | PASS — tsc exit 0; 105 pass / 0 fail |

## Deviations from spec / decisions to confirm

1. **`actions list` shipped as `macro list`** (the spec's "or add `macro list`").
   The builtin `actions` verb lives in `daemon/server.ts` (frozen, off-limits) and
   returns the machine-readable **verb** list; the **macro library** list is its
   own command. `fs macro list` / `probe list` / `session status` cover the
   library. No daemon edit.

2. **Macro/session run OUTCOME lives in the returned `data.ok`, not the Response
   envelope** — the `macro`/`session` command dispatched fine; whether the flow
   passed is the data (with the per-step dump). **Structural** problems (no such
   macro, invalid YAML, missing required param) still fail the envelope with a
   hint. This is deliberate (a failed-flow dump is more useful than an opaque
   envelope error) but worth a coordinator nod — an alternative is to also flip
   `Response.ok`, which would need a print/exit-code touch. Recommend keeping as
   is; flagging per the "surface the coupling" rule.

3. **`config.json` gains an optional `actionsRoot`** — the store's default is
   `~/.claude/fiber-actions/<repo-key>`, but tests (and a non-standard home) need
   to redirect it. It is **not** a new env var (the env-access convention forbids
   that — the PreToolUse hook caught my first attempt); it is an optional field
   read via a narrow cast in `context.ts`, so `core/config.ts`'s `FsConfig` type
   is untouched. Only the test harness sets it. If the coordinator prefers it
   typed, add `actionsRoot?: string` to `FsConfig` — a one-line, non-breaking add
   I left out to stay within file ownership.

4. **Per-macro-run journals live in `macro-runs/`, apart from the daemon's
   `runs/`.** `from-journal` and `fs journal` read `runs/` (manual actions); a
   replay's step journal goes to `macro-runs/` so it never pollutes the source a
   later `from-journal` lifts. Consequence: a `macro run` nested inside a session
   contributes only its top-level entry to the session's journal slice (its steps
   are in `macro-runs/`); the macro's own result carries the steps. Acceptable;
   noted.

5. **Seed #29 redaction is descriptor-based, not type-based.** The ideal ("knowable
   via the resolved element") would key off `input[type=password]`, but the
   runtime reports role `"textbox"` for every text input (`page-runtime/index.ts:117`)
   and the frozen `JournalEntry`/pipeline contract carries no element `type`.
   Redaction fires on a secret-ish resolved label or a `[type=password]` selector
   — it catches the common cases but **cannot** catch a password reached by an
   opaque ref with a bland label, and **does not** touch `eval`/`dispatch`
   payloads (documented in the code). Type-accurate redaction needs the resolved
   element's type plumbed into the journal entry — a change to a frozen contract,
   left as a follow-up (see below).

6. **`by:index|random` operate over CSS or intent/component sets.** A CSS `select`
   uses `locator.count`+nth; an intent/component `select` uses the pipeline's
   candidate resolver. Both work; documented in the format types.

## New runtime dependency

**`yaml@2.9.0`** (first V2 dep beyond Playwright). Justification: the macro
artifact is user-authored, human-diffable YAML (the format decision in
`agent-first-research.md §D` and `V2-PLAN.md §8`); hand-rolling a YAML
parser/serializer would be strictly worse than the mature, Bun-compatible `yaml`
package. Used only in `format.ts` (parse/stringify). No transitive bloat (1
package).

## Test evidence

```
bunx tsc --noEmit                 -> exit 0
bun test                          -> 105 pass / 0 fail / 326 expect / 11 files (~89s)
  tests/unit/store.test.ts          store round-trips, repo-key identity
  tests/unit/format.test.ts         valid macros + 8 located-error cases
  tests/unit/record-run.test.ts     from-journal draft, resolveVars, substituteVars
  tests/unit/redaction.test.ts      fill redaction (label/selector/token) + non-fill pass-through
  tests/e2e/wp4.test.ts             12 e2e through real CLI->daemon->fixture
Live journaled drive (real CLI): from-journal draft (portable target + `from`
provenance), replay with per-step surfaces.opened/closed, --param splice verified
via the app input value, probe consent gate + `--allow` -> row count 50.
```

## Suggested follow-ups (out of scope; not built)

- **Type-accurate redaction**: plumb the resolved element's `type` (or an
  `isSecret` flag) into `ResolvedTarget`/`JournalEntry` (a coordinator-owned
  contract change), then redact on that instead of the label heuristic. Would also
  let `eval`/`dispatch` opt into redaction.
- **`actionsRoot` typed in `FsConfig`** (deviation 3) if the coordinator wants it
  first-class rather than an untyped override.
- **`by:index|random` over a component set with an explicit expr**: today an
  intent/component `select` resolves via candidates; a raw component expr
  (`JobRow[...]`) works too, but there's no nth-into-a-component-expr sugar.
- **NL-authored → cached resolution (Stagehand)**: a string target is resolved
  fresh each run via intent (deterministic given the resolver). A future pass
  could cache the resolved stable descriptor back into the step on first run to
  skip re-resolution; the `from`-provenance plumbing already records what such a
  cache would hold.
- **Session-scoped macro-run journaling**: if a session should own its nested
  macro steps (deviation 4), thread the session's journal into `macro run`.
