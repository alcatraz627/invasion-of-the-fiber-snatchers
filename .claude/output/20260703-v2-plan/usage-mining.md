# fiber-snatcher usage mining — real transcript data for the V2 redesign

<!-- sessions: fs-mine-6e@2026-07-03 -->

Mined 2026-07-03 from Claude session transcripts (`~/.claude/projects/`, 108 JSONL files matched
"fiber-snatcher"; only 7 contained actual Bash invocations, the rest matched on CLAUDE.md prompt
noise). Method: parsed every transcript, extracted `Bash` tool_use blocks containing
`fiber-snatcher`, tokenized each into an ordered stream of subcommand invocations plus inline
`sleep`s, paired each Bash call with its tool_result to classify failures, and interleaved `Read`
tool calls on shot PNGs. Miner + streams live in the session scratchpad
(`mine_fs.py`, `analyze_fs.py`, `streams/*.json`).

## Data universe

Effectively ONE real-usage corpus: session `6ec6743c` in
`~/.claude/projects/-Users-alcatraz627-Code-Versable-two-enhancement-product/` (45MB, resumed
across 2026-06-22 to 2026-07-03).

| Metric | Value |
|---|---|
| Bash calls containing fiber-snatcher | 73 (71 substantive) |
| Total fiber-snatcher invocations | 205 (~2.9 per Bash call, max 8 in one call) |
| Inline `sleep` calls / total slept | 106 / 244 s (1 sleep per ~2 invocations) |
| Invocations piped to `\| tail -N` | 149 (73%) |
| Distinct working phases | 3 (Jun 26 eval-debugging, Jul 2 afternoon visual QA, Jul 2 evening visual QA) plus 2 preflight-only touches |
| Other sessions | Only meta: wrapper inspection (Jun 18), availability probes (Jun 21/22), and this mining session itself. Zero drive usage outside the Versable frontend project. |

Shell-mem history confirms the same commands (same session IDs); no independent shell usage found.

## A. Command frequency

Main session, 205 invocations. Prose-noise tokens (regex hits on "fiber-snatcher not found" etc.)
excluded.

| Subcommand | Count | Notes |
|---|---|---|
| click | 70 | the workhorse |
| eval | 36 | all with `--yes-i-know`; almost all via `/tmp/fs-*.ts` files |
| shoot | 28 | all with `--name <intent>`; all 28 PNGs later Read |
| navigate | 26 | routes: `/jobs` (dominant), `/jobs/?<modal+params>`, `/jobs/data-history-v3` |
| fill | 10 | only ever `#search-control` |
| press | 7 | all `Escape` (close modal) |
| status | 6 | preflight ritual |
| logs | 5 | one-shot `--json`, never `-f` |
| doctor | 4 | after start / preflight |
| state | 4 | early exploration only, then abandoned for eval |
| config, start | 2 each | |
| hover | 1 | invoked arg-less by mistake (dead call) |
| dispatch, atoms, queries, components, errors, stop | **0** | see F |

Flags: `--yes-i-know` 35, `--name` 28, `--nth` 25 (23x `0`, 2x `1`), `--json` 7, `--level` 2.

Selector kinds (click/state/fill/hover args): `#id` 39 (the app's `#<name>-control` convention),
`text=` 24, plain CSS 15, Playwright-relational (`:has`, `:has-text`, `:right-of`) 4.

## B. Recurring sequences (composite-action candidates)

Top token n-grams (flattened stream): `sleep>click>sleep` 44, `click>sleep>click` 24,
`click>sleep>shoot` 22, `navigate>sleep>click` 16, `click>sleep>eval` 15, `eval>navigate>sleep` 12,
`shoot>click` 12.

Verbatim recurring runs, ranked by how often they recur:

1. **Open-job-modal prefix** (10+ occurrences, 6 of them full replays after state loss):
   ```
   fiber-snatcher navigate /jobs; sleep 3-5;
   fiber-snatcher click "text=<job title>" [--nth 0]; sleep 3-8
   ```
   This is THE unit of work. Every visual-QA task starts by re-establishing "modal open for job X".

2. **Dropdown-facet interaction** (8+):
   ```
   click "#<facet>-control"; sleep 1; click "text=<option>"; sleep 1;
   [click "#<facet>-control" again to close]; shoot --name <intent>
   ```
   Facets seen: `#missingData-control`, `#missingDataCols-control`, `#status-control`,
   `#expandRows-control`, `#showMetadata-control`.

3. **Eval-probe loop** (36 evals, 17 distinct scripts, 20 heredoc writes):
   ```
   cat > /tmp/fs-<x>.ts <<'TS' ... TS
   fiber-snatcher eval /tmp/fs-<x>.ts --yes-i-know 2>&1 | tail -N
   ```
   Probe scripts return small JSON objects (URL search string, control IDs in DOM, modal
   presence, monkey-patched history log, counters on `window`). Several are reset/read pairs
   (`fs-reset.ts` / `fs-read.ts`, `fs-hydreset.ts` / `fs-hydread.ts`) forming an
   instrument-act-read pattern around a click.

4. **Async-load watch** (3 sagas): `shoot --name x-early; sleep 2-10; shoot --name x-later`
   (multisheet, scraper: early/later/loaded). Manual polling for "has it loaded yet".

5. **Reset ritual** (7): `press Escape; sleep 1; click "text=<job>"` to get a fresh modal.
   Escape is fired blind; there is no verification the modal actually closed (see C).

6. **Preflight ritual** (every phase start, 3x):
   `curl :3006 -> fiber-snatcher status | rg running -> [start -> doctor]`.
   2 of 3 phase starts found the daemon NOT_RUNNING.

7. **Fill-and-verify** (5): `fill '#search-control' <q>; sleep 1-2; eval readurl.ts | shoot`.

## C. Failure and retry patterns

13 of 71 Bash calls (18%) hit a multi-match; it is by far the dominant failure mode.

- **`--nth` fishing.** 25 `--nth` uses; 23 guessed `0` blindly. The multi-match error says only
  `"matches": N` plus "Narrow the selector or pass --nth" and does NOT describe the matched
  nodes, so the agent cannot pick intelligently. Worst case: `button:right-of(:text('Sheets'))`
  matched **67** elements and the agent took `--nth 0` on faith.
- **Export-button saga (calls 46-50): 5 Bash calls + 3 screenshots to open one dropdown.**
  `#job-output-export-btn` matched 2 because an earlier `press Escape` had not actually closed
  the previous modal, leaving a stale duplicate in the DOM. `--nth 0` still failed. Recovery was
  a full re-navigation replay of the entire path. An unverified Escape upstream produced a
  misleading multi-match downstream.
- **Selector reformulation ladder (calls 65-67):** `text=Sheets` (ambiguous) ->
  `button:has(svg.lucide-table-cells-merge)` (multi-match) -> `div:has-text('Sheets') > button`
  (3 matches, nth 0) -> `button:right-of(:text('Sheets'))` (67 matches, nth 0). Roughly 3
  attempts per success when the target has no id.
- **Wrong-nth verification by screenshot (calls 60-61):** `text=Features & Benefits` matched 2;
  nth 0 was the wrong one; the agent needed a screenshot to detect that, then retried nth 1 with
  a second screenshot. 2 full drive+shoot rounds to disambiguate one click.
- **Daemon lifecycle:** 2 NOT_RUNNING encounters; each costs status -> start -> doctor (and once
  a `chrome-error://` page immediately after start, fixed by re-navigating). The daemon
  never survived between working phases.
- **Dead clicks:** clicks report `"matches": 1` (success) while the UI does nothing; the
  tab-click bug phase (call 70, `tab-click-fixed`) exists because a click "succeeded" without
  effect earlier. Click success is currently "found and dispatched", not "something happened".
- **Fill contract confusion (call 55):** agent shell-hedged
  `fill "#search-control input" ... || fill "#search-control" ...` because it did not know
  whether fill wants the wrapper or the input.

## D. Observation cost

- **28 shoots; 28 PNG Reads. Every screenshot was read back.** Screenshots are the primary
  observation channel in visual-QA phases, not optional confirmation.
- Read timing: ~80% read immediately after the shoot, before deciding the next action; the rest
  batched (early/later pairs read together) or superseded (the first export-dropdown shot was
  re-taken before ever being read).
- `shoot > click` occurs 12x in the token stream: the agent often keeps driving inside the same
  Bash call after a shoot and reads the PNG afterwards, using the shot as a checkpoint marker.
- The contrast that matters for V2: the June 26 debugging phase (36 Bash calls) used **zero**
  screenshots. All observation was `eval` returning small JSON. When the question is "what is
  the state", text wins; screenshots only appear when the question is "what does it look like"
  or "did my click visibly work". A cheap DOM/text digest (visible modal, active tab, chip
  labels, row counts) could replace the confirmation subset of shots, roughly the
  dropdown-count and chip-verification shots, i.e. an estimated third to half of the 28.

## E. Intent inventory

High-level goals actually pursued (from shot names, probe scripts, and routes):

1. **Debug/verify URL-query-state sync** (`useQSync`, job-preview modal, Jun 26; eval-only):
   param hydration before/after mount, `history.pushState/replaceState` tracing via monkey-patch,
   console-log capture level checks, search-fill to URL write path, share-link restore, filter
   params, hydration run counts, load-timing sensitivity (0.3/1/3 s navigate-then-read).
2. **Visual QA of the data-history v3 job modal** (Jul 2 afternoon; shoot-heavy): initial page
   and list render, modal open, missing-data facet counts, properties-missing filter, export
   dropdown, multi-sheet counts, scraper-job async loading states, status + combined filters,
   in-columns filter chips.
3. **Visual QA of summary tabs/cards** (Jul 2 evening): sheets summary expander card,
   summary-all view, marketing-description clickthrough, single-column labels, tab-click fix
   verification.
4. **Environment preflight** (every phase): is the dev server up, is the daemon up.
5. Meta: tool availability probes and this mining work. No usage in any other project.

## F. Surprises vs USAGE.md assumptions

1. **The React-state features that name the tool are unused.** `dispatch`, `atoms`, `queries`,
   `components`, `errors`: 0 invocations. `state`: 4, all in the first ten minutes, then
   abandoned in favor of `eval`. USAGE.md's "Common Claude loops" showcase `state`, `dispatch`,
   `errors --since`, `logs -f`; the real loop is click/eval/shoot/navigate. In practice
   fiber-snatcher is a headless-browser driver plus a JS eval REPL.
2. **`--yes-i-know` is 100% boilerplate** (35/35 evals). It gates nothing behaviorally; it just
   adds tokens to every eval call.
3. **Agents author probe scripts as files, not inline args.** 17 distinct `/tmp/fs-*.ts` files,
   written via heredoc then evaled, because inline JS inside bash quoting is painful. File/stdin
   eval is the de-facto API surface.
4. **Output volume is wrong by default.** 73% of invocations are piped to `tail -N`; JSON
   post-processing is done with `python3 -c`, never `jq`. The agent almost never wants the full
   pretty-printed JSON envelope; it wants one line.
5. **No wait primitive, so 106 manual sleeps (244 s).** The entire `sleep>click>sleep` n-gram
   family plus the early/later double-shoot sagas are hand-rolled waiting. Guessed durations
   (1-10 s) are both too long (wasted wall clock) and too short (dead clicks, empty modals).
6. **Multi-match errors are uninformative at the exact moment the agent needs data.** The error
   suggests `--nth` but does not list the matches, so agents guess nth 0 (92% of the time) and
   burn a screenshot to check the guess.
7. **State re-establishment is the biggest hidden cost.** 6 full navigate-and-click-through
   replays of the same path in one afternoon because Escape/state loss is cheap to cause and
   expensive to recover from. A declarative "ensure: modal open for job X with facet Y" composite
   would collapse the largest recurring sequence.
8. **Blind Escape is a correctness hazard, not just waste** (the export-button saga: stale modal
   -> duplicate DOM -> multi-match on an id that should be unique).
9. **The daemon is assumed long-lived but never is.** Every working phase started with the
   status/start/doctor ritual; 2 of 3 found it down. Auto-start on first drive command would
   remove 2-3 calls per session.
10. **Screenshots are always named with intent** (`--name summary-tabs`, `combined-chip2`) and
    always Read back. The shot path plus a Read is a fixed two-step; a mode that returns the
    image (or a digest) directly would save a round trip per observation.
11. **Adoption is narrower than the docs assume:** one project, one session lineage, no shell
    usage by the human. The V2 customer is the agent loop itself.

## Implications for V2 (direct consequences of the data)

- Composites: `ensure-state`/`flow` (navigate + click-path + waits as one command) kills the
  replay tax; `pick-from-dropdown <control-id> <option-text>` covers the second-most-common run.
- Replace manual sleeps with built-in readiness: wait-for-selector/idle after navigate and
  click, plus `--wait <sel>` on drive commands.
- Multi-match should return the match list (tag, id, text, aria) so nth is chosen, not fished.
- Click should report an effect signal (DOM mutation/nav/url change) to expose dead clicks.
- Escape/close should verify and report what closed.
- Default output: one compact line; `--json` for the envelope. Assume `tail` means the current
  default is wrong.
- Eval: accept stdin/file as first-class, drop `--yes-i-know`, keep JSON-out.
- Shoot: return-and-digest option; a text digest (visible modal, tabs, chips, counts) would
  replace the confirmation subset of screenshots.
- Deprioritize (or split out) dispatch/atoms/queries/components until a real consumer exists;
  the observed product is drive + eval + shoot.
