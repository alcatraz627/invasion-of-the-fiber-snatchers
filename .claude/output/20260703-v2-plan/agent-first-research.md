# Agent-first browser tooling — research for fiber-snatcher V2

<!-- sessions: fiber-v2-research@2026-07-03 -->

Research into how to design browser-driving tools whose primary user is an LLM
agent, to seed the fiber-snatcher V2 design (CLI + daemon + Playwright +
React-fiber state access for local dev apps) and a general gcc note on "tools
Claude writes for Claude."

Method: web research (July 2026) across primary docs (Playwright MCP, Chrome
DevTools MCP, Stagehand, Maestro, Anthropic engineering), academic sources
(SWE-agent, WebArena, Mind2Web, Agent Workflow Memory), and practitioner
pain-point reports. Every external claim carries a URL.

---

## A. Playwright MCP: accessibility snapshot + ref model

### How the page is represented

Playwright MCP represents the page as a YAML-ish accessibility-tree text
snapshot, not pixels. Each node is a role + accessible name; interactive
elements get a unique ref (`e` + number):

```
- heading "todos" [level=1]
- textbox "What needs to be done?" [ref=e5]
- listitem:
  - checkbox "Toggle Todo" [ref=e10]
  - text: "Buy groceries"
```

Actions then take the ref, not a selector: `browser_click { ref: "e10" }`,
`browser_type { ref: "e5", text: "headphones" }`.
Source: https://playwright.dev/mcp/snapshots

### Why refs beat CSS selectors for agents

- A ref points at *the exact element the LLM just saw* in its last
  observation — there is no re-resolution step where a selector can silently
  match a different element. The docs' guidance is blunt: "use refs, not
  selectors" (https://playwright.dev/mcp/snapshots).
- CSS selectors couple the agent to DOM structure/class names that churn;
  the ref is minted from the semantic tree the agent reasons over, so the
  observation and the action share one address space
  (https://qaskills.sh/blog/playwright-mcp-accessibility-snapshots-reference).
- Refs make agent trajectories auditable: `click e10` is meaningful next to
  the snapshot that defined e10; a 200-char CSS selector is not.

### Staleness handling

- "Refs are stable within a single snapshot — the same element always has the
  same ref until the page changes. After navigation or DOM updates, the tool
  returns a fresh snapshot with new refs"
  (https://playwright.dev/mcp/snapshots).
- The contract is: act → tool returns a fresh snapshot → old refs are dead.
  Guidance: "re-snapshot after navigation," refs are invalidated when the page
  changes. Staleness is prevented by refresh-on-action rather than by
  detecting and repairing stale refs.

### Known pain points (the cautionary half)

- **Snapshot token bloat is the dominant real-world failure.** On enterprise
  apps (Salesforce), a single snapshot ran ~114K tokens; snapshots of
  50KB–540KB are reported, with context overflow after 2–3 page visits
  (https://provar.com/blog/thought-leadership/the-114k-token-problem-why-playwright-mcp-burns-your-ai-coding-agents-control-on-salesforce/,
  https://github.com/microsoft/playwright-mcp/issues/1233).
- **Stale snapshots accumulate in the conversation**: full trees are streamed
  after every navigation, so "by step twelve, conversations carry 90K+ tokens
  of stale page snapshots from screens the agent had already left behind"
  (https://www.test-shift.com/posts/the-token-war-playwright-cli-vs-mcp/).
- **Tool-schema overhead**: 26+ tools, each with a full JSON schema loaded at
  session start, costs thousands of tokens before the first click
  (https://www.test-shift.com/posts/the-token-war-playwright-cli-vs-mcp/).
- Users have filed feature requests for output-size caps and snapshot
  filtering (https://github.com/microsoft/playwright-mcp/issues/889).

Takeaway: the ref model is the right *addressing* design; the unsolved half is
*observation budgeting* — scoping, diffing, and truncating what the agent sees.

---

## B. Chrome DevTools MCP and computer-use-style tools

### Chrome DevTools MCP

- Same textual-snapshot family: `take_snapshot` returns an accessibility-tree
  text listing with per-element uids; actions (`click`, `fill`, `hover`,
  `drag`) take a uid. Explicit guidance: "Always use the latest snapshot.
  Prefer taking a snapshot over taking a screenshot"
  (https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/tool-reference.md).
- **Composite form action**: `fill_form` — "ALWAYS prefer this tool over
  multiple individual 'fill' or 'click' calls ... significantly faster, more
  reliable, and reduces turn count" (same tool-reference URL). Direct evidence
  that turn-count reduction is a first-order design goal.
- **Waiting**: actions auto-wait ("uses puppeteer to automate actions ... and
  automatically wait for action results",
  https://github.com/ChromeDevTools/chrome-devtools-mcp); the explicit wait
  primitive is deliberately tiny — `wait_for` takes a list of texts and
  resolves when any appears.
- **Published design principles**
  (https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/design-principles.md):
  - "Return semantic summaries. 'LCP was 3.2s' is better than 50k lines of JSON."
  - "Reference over Value: for heavy assets (screenshots, traces, videos),
    return a file path or resource URI, never the raw data stream."
  - "Return actionable errors that include context and potential fixes."
  - "Give agents composable tools (Click, Screenshot), not magic buttons."
  - "Output must be readable by machines (structured) AND humans (summaries)."
- Practitioner note: agents that lazily pick tools grab `take_screenshot`
  (~1MB base64) instead of `take_snapshot` (~80KB text) and blow up the
  session; the server's own tool definitions cost ~18K tokens
  (https://www.huuhka.net/browser-verification-for-coding-agents-chrome-devtools-mcp-vs-agent-browser/).

### Computer-use (screenshot + coordinates) as the contrast case

Anthropic's computer use tool observes via screenshots and acts via
coordinates: `screenshot`, `left_click [x, y]`, `type`, `key`, `scroll`,
`wait`, `left_click_drag`, plus a `zoom` region inspector
(https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool).
Two documented reliability lessons:

- The docs recommend prompting: "Claude sometimes assumes outcomes of its
  actions without explicitly checking their results. To prevent this you can
  prompt Claude with 'After each step, take a screenshot and carefully
  evaluate if you have achieved the right outcome'" — i.e., when the tool does
  not return post-action state, the burden shifts to prompt discipline, which
  is exactly what a well-designed tool should absorb.
- Coordinate-space fragility: oversized screenshots get downscaled and
  "Claude returns coordinates for the image it sees," so the harness must
  track scale factors — a whole error class that ref/uid addressing simply
  does not have.

Consensus across B: structured text snapshot as primary observation,
screenshots as secondary verification, semantic addressing over coordinates.

---

## C. Agent-computer-interface research

### SWE-agent (the founding ACI work)

Paper: https://arxiv.org/abs/2405.15793 — a custom agent-computer interface
lifted GPT-4's SWE-bench resolve rate to 12.5% pass@1 vs 3.8% for the prior
best non-interactive system. Documented design findings
(https://swe-agent.com/latest/background/aci/,
https://www.emergentmind.com/topics/swe-agent-scaffold):

- **Guardrails at action time**: "We add a linter that runs when an edit
  command is issued, and do not let the edit command go through if the code
  isn't syntactically correct." Invalid actions are rejected with precise
  error messages rather than allowed to corrupt state.
- **Bounded observation windows**: the file viewer shows ~100 lines per turn
  — empirically better than both smaller windows and dumping whole files.
- **Succinct search results**: "it was important for this tool to succinctly
  list the matches — we simply list each file that had at least one match"
  (capped, e.g., max 50 hits); verbose per-match context hurt performance.
- **Explicit empty-output confirmation**: "Your command ran successfully and
  did not produce any output." Silence is ambiguous to a blind agent.
- Feedback should be "relevant and concise"; detail designed for humans
  overloads the agent
  (https://www.researchgate.net/publication/380907343_SWE-agent_Agent-Computer_Interfaces_Enable_Automated_Software_Engineering).

### Web-agent benchmarks

- **WebArena** (https://arxiv.org/abs/2307.13854,
  https://github.com/web-arena-x/webarena): observation is an accessibility
  tree with integer element ids; actions are id-based (`click [id]`); supports
  `current_viewport_only=True` to bound observation size. Best GPT-4 agent at
  publication: 14.41% end-to-end success vs 78.24% human — the gap that all of
  this interface work is trying to close.
- **Mind2Web / MindAct** (https://arxiv.org/pdf/2306.06070): real pages have
  thousands of DOM elements, "infeasible or too costly" for LLM context. The
  winning architecture is two-stage: a fine-tuned small LM (DeBERTa) ranks
  and filters candidate elements, then the LLM picks among ~5 candidates in
  multi-choice QA form. Element selection as *choice among ranked candidates*
  beats open-ended generation over the full tree.
- **Agent Workflow Memory** (https://arxiv.org/abs/2409.07429): inducing
  reusable workflows (macros) from past trajectories and injecting them into
  the agent improves Mind2Web by 24.6% and WebArena by 51.1% relative success
  rate, while reducing steps per solved task. Strongest quantitative evidence
  that a composite-action/macro library measurably raises agent success.

### Anthropic: writing tools for agents

(https://www.anthropic.com/engineering/writing-tools-for-agents)

- Consolidate: fewer, higher-leverage tools that do a whole meaningful unit
  of work ("`schedule_event` instead of separate `list_users`, `list_events`,
  `create_event`").
- `response_format: concise | detailed` — let the agent choose verbosity.
- "Implement some combination of pagination, range selection, filtering,
  and/or truncation with sensible default parameter values for any tool
  responses that could use up lots of context."
- Errors should give "specific and actionable improvements," not codes.
- Namespacing (common prefixes) reduces wrong-tool selection.
- "Even small refinements to tool descriptions can yield dramatic
  improvements" — descriptions are prompt engineering.
- Build eval loops before optimizing; tools are "contracts between
  deterministic systems and non-deterministic agents."

### What measurably helps (direct answers to the C questions)

- **Fewer, richer observations win over raw dumps, but "rich" means
  *semantically dense*, not *large*.** SWE-agent's 100-line window and 50-hit
  cap, WebArena's viewport scoping, MindAct's candidate filtering, and the
  Playwright-MCP 114K-token failure mode all point the same way.
- **Self-describing errors work**: SWE-agent's linter feedback, Anthropic's
  actionable-error guidance, Chrome DevTools MCP's "errors ... include context
  and potential fixes."
- **Guardrails that reject invalid actions** beat post-hoc recovery
  (SWE-agent linter ablations; "prevents compounding mistakes from a single
  faulty edit").
- **Turn count is a cost**: composite actions (fill_form) and cached
  workflows (AWM) both raise success by shrinking the number of
  LLM-in-the-loop decisions.
- **Idempotent/retryable actions** show up implicitly: Maestro's runtime
  "will retry taps or waits under the hood" — which is only safe because a
  tap on an already-target state is harmless; retryability has to be designed
  into the action semantics
  (https://maestro.dev/insights/5-ways-to-fix-flaky-mobile-ui-tests).

---

## D. Composite-action / macro prior art

- **Playwright codegen** (https://playwright.dev/docs/codegen): records
  interactions → emits code; "Playwright will look at your page and figure
  out the best locator, prioritizing role, text and test id locators." The
  output is explicitly a *starting point a human refines*. Lesson: recording
  is a great authoring path, but the artifact's addressability (role/text/
  test-id) matters more than the recording itself.
- **Maestro** (https://maestro.dev/insights/end-to-end-ui-testing-for-mobile-apps-with-maestro,
  https://github.com/mobile-dev-inc/Maestro): flows are YAML with
  plain-language commands (`tapOn`, `inputText`, `assertVisible`).
  "Maestro embraces the instability of mobile applications ... built-in
  tolerance to flakiness: it will retry taps or waits under the hood if an
  element isn't immediately present ... you do not need to sprinkle sleep()
  calls in your flows." Parameterization via env/externalized parameters in
  the YAML (https://maestro.dev/insights/dynamic-ui-testing-yaml-best-practices).
- **Stagehand act/extract/observe** (https://docs.stagehand.dev/v3/basics/act,
  https://github.com/browserbase/stagehand):
  - `act("click the add to cart button")` — natural-language atomic actions.
  - Parameterization by variables map: `act("type %username% into the email
    field", { variables: { username } })` — values never reach the LLM
    provider (secrets-safe parameterization).
  - **Observe-then-act**: `observe()` returns candidate actions (resolved
    element + method) which can be inspected, then passed to `act()` — a
    preview/commit split.
  - **Action caching**: with `cacheDir`, "subsequent executions reuse cached
    actions without LLM calls" — the LLM resolves a fuzzy instruction once;
    replays are deterministic and free.
  - Design history: they moved from raw-DOM parsing to the Chrome
    accessibility tree because it "offers a much cleaner, more reliable view
    of a webpage by filtering out unnecessary noise"
    (https://www.browserbase.com/blog/ai-web-agent-sdk); later they left
    Playwright itself partly because its test-oriented actionability checks
    "add unwanted latency for automation work"
    (https://www.browserbase.com/blog/stagehand-playwright-evolution-browser-automation).
- **Anthropic Agent Skills**
  (https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills):
  a skill = folder + SKILL.md (YAML name/description frontmatter + markdown
  instructions + optional scripts). Loading is progressive-disclosure in
  three stages: discovery (name+description only), activation (full SKILL.md),
  execution (referenced files/scripts on demand). This is the current best
  pattern for an *action library* that scales without context cost.

### Which format won?

No single winner, but a clear division of labor:

- **Declarative step lists (YAML) won for the replayable artifact** —
  human-diffable, retry semantics live in the runtime not the flow (Maestro),
  and steps map 1:1 to agent-issued atomic actions.
- **Natural language + resolved-action caching won for authoring by agents**
  (Stagehand): the fuzzy form is the source, the resolved action is the
  compiled form.
- **Code won only where a human maintains it** (Playwright codegen output).
- Parameterization convergence: named variables in a map (`%var%` /
  `${ENV}`), not positional args; selection-parameterization ("nth job",
  "by name") is handled at the instruction level (Stagehand: add "positioning
  or visual descriptors" to the instruction) rather than as a formal
  parameter type anywhere — a gap V2 could fill explicitly (target spec:
  `{by: name|index|random, value}`).

---

## E. Waiting

### Playwright actionability (the mature baseline)

(https://playwright.dev/docs/actionability) Before each action, Playwright
auto-waits for the relevant checks: **Visible, Stable (same bounding box for
two consecutive animation frames), Receives Events (actual hit target, not
occluded), Enabled, Editable**. Checks vary per action (click needs
visible+stable+receives-events+enabled; fill needs visible+enabled+editable).
On failure it retries until timeout, then throws `TimeoutError`; `force: true`
skips non-essential checks.

### The agent-facing critique

Stagehand's stated reason for leaving Playwright: those checks are tuned for
E2E *testing* and "add unwanted latency" for automation that wants to "move
quickly and accept more direct control"
(https://www.browserbase.com/blog/stagehand-playwright-evolution-browser-automation).
For a local-dev tool the testing-grade checks are mostly right, but they
should be a policy knob, not a constant.

### What agent-facing wait vocabularies actually shipped

- Playwright MCP `browser_wait_for`: text appears / text gone / time
  (https://github.com/microsoft/playwright-mcp).
- Chrome DevTools MCP `wait_for`: any of a list of texts appears
  (https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/tool-reference.md).
- Maestro: no explicit waits at all in the flow language — "every command
  automatically waits for the UI to settle and retries before failing"
  (https://qaskills.sh/blog/maestro-mobile-testing-guide-2026).

Pattern: implicit auto-wait inside every action + a *tiny* explicit wait
vocabulary keyed to what the agent can name (text, mostly). Nobody makes the
agent construct wait conditions from primitives, and nobody exposes sleep as
the primary tool.

### The V2 opportunity

Generic tools can only wait on DOM/network signals. A fiber-attached tool can
expose **framework-level settledness** — react-query "no queries fetching,"
pending transitions done, a named component re-rendered, a store slice
changed. That is a wait vocabulary no generic browser tool can offer, and it
directly addresses the class of flake that text-appearance waits paper over.

---

## F. Fuzzy / semantic element targeting

Approaches in the wild, and their failure modes:

| Approach | Exists in | Failure modes |
|---|---|---|
| Role + accessible name | Playwright `getByRole`, codegen priority ("role, text and test id", https://playwright.dev/docs/codegen) | Unlabeled `div` soup, duplicate names, apps with poor a11y semantics yield empty trees |
| Text matching | Maestro `tapOn: "Login"`, wait_for text | Duplicates, i18n/dynamic text, matches non-interactive text nodes |
| Snapshot ref/uid (agent picks from tree) | Playwright MCP, Chrome DevTools MCP | Staleness after DOM change; giant trees blow context; agent misreads tree on dense pages |
| Small-model ranking → LLM multi-choice | Mind2Web MindAct (DeBERTa filter → 5-way choice, https://arxiv.org/pdf/2306.06070) | Ranker misses the true element → unrecoverable; training/dataset drift |
| NL instruction → LLM resolves against AXTree | Stagehand `observe`/`act` | Wrong-element picks on ambiguous instructions; per-call LLM cost/latency; iframe blind spots (https://docs.stagehand.dev/v3/basics/act) |
| Self-healing locator repair (LLM regenerates selector on failure, caches fix) | autoheal etc. (https://github.com/headout/autoheal); zero-cost AXTree variant (https://arxiv.org/abs/2603.20358) | Per-run API cost "prohibitive at enterprise scale"; healing can silently bind to the wrong element — a plausible-but-wrong match is worse than a loud failure |
| Coordinates from vision | computer-use | Occlusion, scaling/DPR math, layout shift between screenshot and click (https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool) |

Synthesis: the robust stack is **deterministic-first, fuzzy-as-fallback,
cache-the-resolution**: try role+name/test-id → fall back to snapshot-ref
choice by the agent → only then LLM-rank candidates; whatever resolved,
persist it so the next run is deterministic (Stagehand cacheDir; autoheal
"high-performance caching remembers successful fixes"). A fiber tool has an
extra deterministic tier nobody else has: component name + props from the
fiber tree (`JobRow[3]`, `JobRow[name="acme"]`), which is both more stable
than DOM and closer to how the agent thinks about a dev app.

---

## DESIGN PRINCIPLES for agent-first tooling

1. **Observe as structured semantic text; screenshot only to verify.**
   The accessibility tree "is closer to what the page says it is" and 10x+
   cheaper than pixels — every agent-first browser tool converged here.
   (https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/tool-reference.md,
   https://www.browserbase.com/blog/ai-web-agent-sdk)

2. **Mint short refs in the observation; actions take refs, never selectors
   or coordinates.** The ref points at the exact element the agent just saw,
   collapsing the observe→act gap that selectors and coordinates reopen.
   (https://playwright.dev/mcp/snapshots)

3. **Make staleness an explicit contract: refs die on DOM change, and the
   error says so and says what to do.** Playwright MCP invalidates refs and
   re-snapshots; ambiguity about ref lifetime is where agents thrash.
   (https://playwright.dev/mcp/snapshots)

4. **Budget every observation: scope, filter, paginate, truncate — with good
   defaults.** Un-budgeted snapshots (50KB–540KB, 114K tokens) are the #1
   documented production failure of the current generation.
   (https://provar.com/blog/thought-leadership/the-114k-token-problem-why-playwright-mcp-burns-your-ai-coding-agents-control-on-salesforce/,
   https://www.anthropic.com/engineering/writing-tools-for-agents)

5. **Every action returns a compact post-action state delta.** Agents
   "sometimes assume outcomes of their actions without explicitly checking";
   a tool that reports what changed removes a whole failure class and a whole
   round-trip.
   (https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool,
   https://swe-agent.com/latest/background/aci/)

6. **Never return silence: confirm empty results explicitly.** "Your command
   ran successfully and did not produce any output" — blind agents cannot
   distinguish success-with-no-output from a hang or a swallow.
   (https://swe-agent.com/latest/background/aci/)

7. **Errors must propose the fix.** "Return actionable errors that include
   context and potential fixes"; SWE-agent's linter feedback turned syntax
   errors from compounding failures into one-turn corrections.
   (https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/design-principles.md,
   https://www.anthropic.com/engineering/writing-tools-for-agents)

8. **Reject invalid actions at submit time (guardrails), don't repair after.**
   SWE-agent's don't-let-the-bad-edit-through linter was among its
   highest-value components (12.5% vs 3.8% prior SOTA overall).
   (https://arxiv.org/abs/2405.15793)

9. **Auto-wait inside every action; expose a tiny named wait vocabulary; no
   agent-visible sleeps.** Playwright's actionability checks + Maestro's
   "built-in tolerance to flakiness" both moved waiting out of the
   script/agent and into the runtime.
   (https://playwright.dev/docs/actionability,
   https://maestro.dev/insights/end-to-end-ui-testing-for-mobile-apps-with-maestro)

10. **Offer framework-level settledness as a wait condition when you can.**
    Text-appearance waits are a proxy; "react-query settled" / "no pending
    transitions" is the real signal — a fiber-attached tool's unique edge
    (extension of #9; gap identified across all surveyed wait vocabularies).

11. **Ship composite actions for known multi-step patterns.** fill_form:
    "ALWAYS prefer this tool over multiple individual 'fill' or 'click'
    calls"; Anthropic: consolidate to high-leverage tools. Fewer turns =
    fewer chances to misread state.
    (https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/tool-reference.md,
    https://www.anthropic.com/engineering/writing-tools-for-agents)

12. **Make macros first-class, parameterized by named variables, and cache
    the LLM's resolution so replays are deterministic and LLM-free.**
    Stagehand's `%var%` + cacheDir; workflow memory improved WebArena success
    51.1% relative.
    (https://docs.stagehand.dev/v3/basics/act, https://arxiv.org/abs/2409.07429)

13. **Target fuzzily by ranked candidates, not open-ended generation —
    deterministic tiers first, LLM choice last, persist what resolved.**
    MindAct's filter-then-multi-choice beat full-tree generation; self-healing
    literature warns per-run LLM resolution is costly and can silently bind
    wrong. (https://arxiv.org/pdf/2306.06070, https://arxiv.org/abs/2603.20358)

14. **Treat tool count, schemas, and descriptions as context you're spending;
    return heavy payloads as file paths, not inline data.** 18K tokens of
    tool definitions before the first action; "for heavy assets ... return a
    file path or resource URI, never the raw data stream."
    (https://www.huuhka.net/browser-verification-for-coding-agents-chrome-devtools-mcp-vs-agent-browser/,
    https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/design-principles.md)

15. **Progressive disclosure for capability libraries: name+description at
    rest, full instructions on activation.** Agent Skills' three-stage
    loading is how an action/macro library scales past a handful of entries
    without taxing every session.
    (https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills)

---

## Implications for fiber-snatcher V2 (seed notes, not the design)

- V2's differentiator is the fiber tree: expose **component-addressed
  targeting** (`JobRow[name="acme"]`, `JobRow[3]`) as a deterministic tier
  above DOM refs, and **state-diff observations** ("dispatch X → store slice
  Y changed: {…}") as the post-action delta of principle #5.
- Wait vocabulary should lead with framework signals (react-query idle,
  suspense settled, named-component rendered) per #10 — the thing Playwright
  MCP and Chrome DevTools MCP structurally cannot do.
- Observation budgeting (#4) applies to fiber dumps even more than to
  AXTrees: a component-state snapshot needs depth caps, path scoping, and a
  `concise|detailed` knob from day one.
- Macros: YAML step lists (Maestro-shaped) with named variables and a
  `target: {by: name|index|random}` selection spec, authored by recording an
  agent's resolved actions (Stagehand-shaped), stored skill-style with
  name+description frontmatter for progressive disclosure.
- Keep the daemon's tool surface small and namespaced (`fs_observe`,
  `fs_act`, `fs_wait`, `fs_flow`); heavy outputs (full fiber dumps, traces,
  screenshots) go to files under the project scratchpad, path returned.
