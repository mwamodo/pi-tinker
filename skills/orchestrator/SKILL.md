---
name: orchestrator
description: Orchestrate parallel and long-running work through solo MCP - spawn child Claude, Codex, or Pi agents. Use when a user asks you to be an orchestrator, or when a task spans more than one round of agent work.
---

# Orchestrator

Orchestrate work across multiple Solo-managed child agents instead of doing it all in the main session. Use when:

- A task is large enough that doing it inline would blow the main context window.
- Independent sub-questions can run in parallel (research, code-spelunking, second opinions).
- The user wants visible side processes they can watch live in the Solo UI.
- A long-running command would otherwise block your main session.

Both you and the user can see Solo agents' output in real time. That's the whole point — orchestrate, don't hide.

## Tools

Solo tool names vary by runtime. Confirmed in this project:

- From Pi's MCP gateway, call tools as `solo_*` through the `mcp` wrapper, e.g. `solo_spawn_process`, `solo_send_input`, `solo_whoami`.
- In Claude Code direct-MCP contexts, the same tools may appear as `mcp__solo__*`, e.g. `mcp__solo__spawn_process`.
- Inside Codex, `/mcp` displays a `solo` server with unprefixed tool names, e.g. `spawn_process`, `send_input`, `scratchpad_write`, `timer_fire_when_idle_all`, `whoami`.
- Inside Pi child agents, Solo tools may appear prefixed as `solo_*`; if bare `whoami` fails, use `solo_whoami`.

Core tools:

- `list_agent_tools` / `solo_list_agent_tools` — discover available agent runtimes
- `spawn_process` / `solo_spawn_process` — start a child agent (`kind=agent`, pick `agent_tool_id`)
- `send_input` / `solo_send_input` — send the prompt (and any follow-ups)
- `timer_fire_when_idle_all` / `solo_timer_fire_when_idle_all` and `timer_fire_when_idle_any` / `solo_timer_fire_when_idle_any` — wait for child(ren) to finish without polling
- `get_process_output` / `solo_get_process_output` — read terminal scrollback after they're idle
- `scratchpad_list` / `solo_scratchpad_list`, `scratchpad_read` / `solo_scratchpad_read`, `scratchpad_write` / `solo_scratchpad_write` — structured artifacts
- `scratchpad_delete` / `solo_scratchpad_delete` or `scratchpad_archive` / `solo_scratchpad_archive` — clean up temporary artifacts
- `close_process` / `solo_close_process` — clean up agents when done

---

## The three roles — keep them separate

Don't make one agent both design AND implement, or implement AND self-review. Distinct roles → distinct agents:

Opus and Sonnet models are available through Claude, and GPT models are available through Codex and Pi agents.

| Role | Spawn count | Model | Output |
|---|---|---|---|
| **Counselor** | 2 (different model families for diversity) | Strong reasoning + medium/high effort. Opus 4.7 high paired with Codex gpt-5.5 high is the go-to. | Analysis only, no code. Writes to a scratchpad named `<topic> — <model>`. |
| **Worker** | 1 | Sonnet 4.6 high is plenty for most implementation. | Code + tests. Stops at "tests green, awaiting review". |
| **Reviewer** | 1 (fresh, no prior context) | Opus 4.7 high. | Diff inspection report — short message back to orchestrator. |

Why three? A worker who designs their own approach skips trade-offs the user might want input on. A reviewer who watched the work happen has confirmation bias. Counselors who also implement get attached to their proposal.

**Collapse when appropriate:**
- One-shot trivial fix → no orchestration, just edit inline.
- Small diff (≤ ~150 lines, ≤ 2 files), uncontested design → just a worker. Read the diff yourself.
- Contested design, small diff → counselors → worker. Skip the reviewer.
- Larger diff → always delegate review.

---

## Evidence first, then dispatch

Before briefing any agents through solo, gather concrete evidence yourself:

- Confirm any given task, information or query.
- Run tests if or when you have to.

Put the evidence in the worker's brief — file paths, line numbers, query results, expected vs actual. This stops drift into "exploration" and gives a concrete target.

**Red flag:** dispatching agents with phrasing like "investigate X and figure out what's wrong" means you skipped the evidence step.

---

## Workflow

### 1. Spawn

```
solo_spawn_process(kind="agent", agent_tool_id=N, name="<descriptive-slug>")
```

Use the runtime's naming variant if needed (`mcp__solo__spawn_process` in Claude direct-MCP, or bare `spawn_process` inside Codex).

Use a descriptive name — it shows up in Solo's process list. The user is going to be looking for it.

### 2. Set model & effort

Default Sonnet 4.6 medium for breadth-of-search and routine implementation. Opus 4.7 high or Codex gpt-5.5 high for counselors and contested design questions.

Claude model switching is confirmed: `/model sonnet` changes Claude Code to Sonnet 4.6, and `/effort medium` changes effort to medium.

```
solo_send_input(process_id, input="/model sonnet")
solo_send_input(process_id, input="/effort medium")  # claude
```

For Codex, `/mcp` displays MCP servers and tools; the Solo server appears as `solo` with unprefixed tools such as `spawn_process`, `send_input`, `scratchpad_write`, `timer_fire_when_idle_all`, and `whoami`. Codex starts on gpt-5.5 medium in this project. For model changes, `/model` opens an interactive menu. Send arrow-key bytes to navigate:
- Down arrow: `bytes=[27, 91, 66]`
- Enter: empty `input=""` with default submit/Enter behavior (`submit=true` in Pi's MCP wrapper)

Wait briefly (~300–500 ms) between commands so the model switch lands.

### 3. Brief like the agent has just walked into the room

Spawned agents have zero shared context. Every prompt is self-contained. Sections in order:

1. **One-sentence goal** at the top.
2. **Context** — why this matters, what was tried, what's been ruled out.
3. **Concrete files / line numbers** to ground the work.
4. **Constraints** — explicit "do NOT" rules. The two that matter most, by default:
   - `Do NOT commit. Stop at "tests green, awaiting review".`
5. **Deliverables** — what to produce, where to put it (scratchpad name + tags, or stdout summary).

Treat the agent like a smart colleague who walked into the room. They don't know what you've tried, what was ruled out, or why this matters. Brief them like a human.

### 4. Use timers, never poll

```
solo_timer_fire_when_idle_all(
  processes=[<pids>],
  max_wait_ms=900000,
  body="<self-contained instruction for what to do when the timer fires>"
)
```

Timer timeout defaults by task size:
- Smoke/quick confirmation: `30000–60000` ms
- Short research or review: `180000` ms
- Implementation or long-running work: `900000` ms or more

The `body` is injected back to you as a fresh user turn when the timer fires. Write it to be useful with no surrounding context: who's idle, where to read output (scratchpad ids, process ids), what to decide. Example:

> "Worker 106 idle. Spawn a fresh reviewer agent to inspect the diff — do NOT read the diff into orchestrator context. Brief the reviewer with the original spec and the worker's summary. Then synthesize."

Don't sleep. Don't poll. The harness will call you back.

### 5. Collect output

**Prefer scratchpads** for structured output (markdown reports, code snippets, design analysis). `scratchpad_list` (filter by tag) → `scratchpad_read`.

**Fall back to `get_process_output`** for short replies. Pass `lines=200+` for thorough reports — terminal scrollback is verbose.

### 6. Review — delegate past a threshold

For **small diffs** (single file, < ~150 lines): read the diff/files yourself. Look for:
- Defensive scaffolding for impossible cases (`defined()`/`constant()` reflection on a known-shape class, null-coalesce on guaranteed values)
- Redundant duplication (a constant + a method that returns it)
- Wide framework type-hints where a narrow domain interface fits
- Missing type hints in closures, missing return types
- Try/catch wrapping internal code that can't fail
- New abstractions for a single call site
- Drift from the spec

When you spot any of these, **follow up via `send_input`** with a precise fix instruction — don't surface them to the user. The user's review time is for spec/architecture/judgment calls, not catching obvious code-quality misses.

For **larger diffs**: spawn a fresh reviewer agent. Don't read the diff into orchestrator context.

```
spawn reviewer (fresh agent, no prior history)
brief: original task spec + worker's self-summary + smell categories above
            + EXPLICIT diff scope (specific files OR commit range)
ask for: synthesis, not full diff dump
read their report (short message)
pipe findings back to the worker as a follow-up — not a fresh worker
```

**Critical: scope the diff explicitly.** When the working tree has multiple uncommitted rounds, `git diff HEAD` will show ALL of them — the reviewer will treat prior approved work as "scope creep" by this worker. Either:
- Give them the specific files this worker touched (`git diff HEAD -- path1 path2`), AND tell them prior rounds may also have touched those files (the reviewer must focus on changes matching the worker's spec).
- Or, if you're disciplined about commits, commit each round before review so the reviewer can `git diff <last-commit>..HEAD`.

After receiving findings, **filter them**: false positives from a misbriefed reviewer are common. The orchestrator knows what was approved earlier; the reviewer doesn't. Reframe the report before relaying to the user.

The trade-off: a fresh reviewer might miss subtle context. Mitigate by including the original spec verbatim and noting which prior rounds are intentional.

### 7. Stop short of commit

- Workers stop at "tests green, awaiting review". Always.
- Orchestrator does not commit autonomously. Wait for the user to say "commit", "ship it", "looks good — commit", etc.
- After commit-go-ahead, write the commit message yourself or delegate; don't bundle unrelated concerns.

User-mode override: if the user explicitly delegates "commit when green" upfront, you can commit. Surface what you committed in your reply.

### 8. Close idle agents and temporary artifacts

After their TODO is done AND user has accepted, `close_process`. Don't leave finished agents in the user's UI "just in case" — if you need that context later, spawn fresh and `/resume` the prior session.

For temporary scratchpads used only for smoke tests or intermediate coordination, delete or archive them after extracting the result. Keep durable design/review scratchpads only when they are part of the user's requested artifact or likely to be referenced later.

---

## Counselors fan-out pattern

Two parallel agents on the same prompt, each independent. Useful for design reviews, contested decisions, second opinions.

```
spawn 2 agents in parallel (one tool call per spawn) — different model families if you can
each: /model + /effort high
send each the SAME prompt (worded once, identical)
ask each to save its report to a scratchpad named "<topic> — <model>" with consistent tags
timer_fire_when_idle_all([all pids])
on fire: read all scratchpads
synthesize: consensus / disagreements / blind spots
close all
```

Counselors should produce **analysis only, no code.** A separate worker implements after the user signs off on the synthesis.

The two reports rarely converge perfectly — the disagreements are the value. Surface them to the user, don't paper over them.

When you fan out a prompt, **the children don't know they're one of multiple.** They don't know the user's background. They don't know what other skills exist. The orchestrator is the human-equivalent — children are LLM workers you've briefed. Don't expect them to ask clarifying questions; bake the clarifications into the prompt.

---

## Following up vs respawning

A spawned agent has loaded context. If you spawn a new one for the same topic, that work is wasted.

- **Follow up via `send_input`** when the topic is the same and you just need refinement, more depth, or to fill a gap.
- **Spawn fresh** only when the topic genuinely changes or the agent's context is irrecoverably wrong (or you specifically want a fresh-eye review).

---

## Common pitfalls

- **Tool-name drift across runtimes.** Codex shows Solo tools as bare names under `/mcp` (`whoami`, `spawn_process`), while Pi may expose `solo_whoami`, `solo_spawn_process`, etc. If a child says a tool is missing, ask it to use the displayed Solo tool name variant rather than assuming one prefix.
- **Multi-line prompts sit in paste buffer.** When `send_input` shows `[Pasted text #N]` rather than echoing the prompt, the input was captured but not submitted. Send an empty `input=""` to commit.
- **Timers with too-short `max_wait_ms`.** Long research/implementation can take 7-15 min. Use `30000–60000` only for smoke tests, `180000` for short research/review, and `900000+` for implementation or known-slow work.
- **Reading too few terminal lines.** Default `lines=50` truncates real reports. Pass `lines=200+`.
- **Forgetting to close agents.** Stale agents pile up in the user's UI. Close after extracting what you need.
- **Re-creating instead of resuming an idle agent.** Resuming preserves context cost and time.
- **Inlining giant file contents in prompts.** Solo agents can read the filesystem — give them paths, not contents.

---

## Decision tree

```
New task arrives
│
├─ Trivial / one-shot? ──────────────► Edit inline. No orchestration.
│
├─ Read-only investigation? ─────────► Use Bash / Read / DB query directly.
│
├─ Contested / new design?
│   └─ Yes ─► Spawn 2 counselors (different models, parallel). Synthesize.
│             Confirm direction with user. Then ↓
│
├─ Implementation needed
│   └─ Spawn ONE worker with the locked spec.
│       Constraints: do work yourself, no sub-agents, don't commit.
│
├─ Worker idle
│   ├─ Diff small (< ~150 lines, ≤ 2 files) ─► Read it yourself. Follow up if needed.
│   └─ Diff larger ────────────────────────► Spawn reviewer agent. Read their report.
│
├─ Issues found ─► send_input to worker for fix. Loop.
│
└─ Clean state ─► Report to user. Wait for commit go-ahead. Close agents.
```

---

## When NOT to use this

- A single small task you can do directly in 2–3 tool calls.
- Anything where the user wants you to confirm before each step (orchestration moves fast and broad).
