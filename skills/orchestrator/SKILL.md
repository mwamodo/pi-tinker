---
name: orchestrator
description: Orchestrate parallel or long-running work through Solo MCP by spawning child Claude, Codex, Pi, or Cursor agents. Use when the user asks for orchestration, when independent agents should work in parallel, or when implementation plus review should happen outside the main context.
---

# Orchestrator

Use Solo-managed child agents when a task is too broad for the main session, benefits from parallel opinions, or needs an implementation/review loop the user can watch in the Solo UI. Do not use orchestration for a small fix you can complete directly in a few tool calls.

## Quick start

1. `solo_whoami` and `solo_list_agent_tools` to confirm project and available runtimes.
2. `solo_spawn_process(kind="agent", agent_tool_id=<id>, name="<clear-slug>")`.
3. Configure the child if needed (`/model ...`, `/effort ...`), then `solo_send_input` with a self-contained brief.
4. `solo_timer_fire_when_idle_all` (or `..._any`) with a standalone callback body. Do not poll.
5. When the timer fires, read `solo_scratchpad_*` artifacts or `solo_get_process_output(lines=200+)`, then follow up or close.

## Tested behavior in this repo

Verified on 2026-05-15 from Pi/Solo in `pi-tinker`:

- `solo_list_agent_tools`, `solo_spawn_process`, `solo_send_input`, `solo_timer_fire_when_idle_all`, `solo_get_process_output`, `solo_scratchpad_write/list/read`, and `solo_whoami` work through Pi's `mcp` gateway.
- Current agent runtime IDs were Pi `8`, Claude `9`, Codex `11`, Cursor `13`. Always call `solo_list_agent_tools`; IDs can change.
- A Pi child agent confirmed Solo tools are available through the Pi MCP gateway as `solo_*`. Bare `whoami` and `mcp__solo__whoami` did not work in Pi.
- A Claude child accepted `/model sonnet` and `/effort medium` and reported Sonnet 4.6 / medium effort.
- A Codex child in this environment did not get a direct Solo tool surface in the model turn. Treat child-side MCP as runtime-specific: ask the child to confirm, and fall back to stdout if it cannot write scratchpads itself.

## Runtime/tool-name reference

From the main Pi session, use the MCP wrapper with `solo_*` tool names:

```text
mcp(tool="solo_spawn_process", args="{...}")
mcp(tool="solo_send_input", args="{...}")
```

Other harnesses expose different names. Do not guess; discover first.

| Context | Expected Solo tool names | Notes |
|---|---|---|
| Main Pi session | `solo_*` through `mcp` | Confirmed here. |
| Pi child | `solo_*` through Pi MCP gateway | Confirmed; bare names failed. |
| Claude Code direct-MCP | often `mcp__solo__*` | Use that form only when Claude exposes it. |
| Codex child | varies; may expose none to the model | If unavailable, have Codex write stdout and let the orchestrator collect output. |

Core tools:

- `solo_whoami` — confirm bound process and project.
- `solo_list_agent_tools` — get current `agent_tool_id` values.
- `solo_spawn_process` — start an agent or terminal.
- `solo_send_input` — send prompts, follow-ups, slash commands, or raw bytes.
- `solo_timer_fire_when_idle_all` / `solo_timer_fire_when_idle_any` — wait for child idle state without polling.
- `solo_get_process_output(lines=200+)` — read terminal scrollback.
- `solo_scratchpad_list/read/write` — structured reports/artifacts.
- `solo_scratchpad_archive/delete` and `solo_close_process` — cleanup.

## Decide whether to orchestrate

Fast path:

```text
New task
├─ Small/direct/read-only? ───────────► Do it inline. No Solo orchestration.
├─ User wants step-by-step approval? ─► Do it inline; orchestration moves broad and fast.
├─ Contested design? ─────────────────► 2 counselors → synthesize → ask user → worker.
├─ Implementation from clear spec? ───► 1 worker.
├─ Worker done, small diff? ──────────► Inspect yourself; send follow-up if needed.
└─ Worker done, large/risky diff? ────► Fresh reviewer → filter findings → same worker fixes.
```

Role rules:

- **Counselors:** contested design, unclear architecture, or useful independent second opinions. Spawn two agents from different model families when available. Analysis only.
- **Worker:** implementation from a locked spec. Spawn one worker, not a swarm.
- **Reviewer:** fresh-eye review for larger diffs or high-risk changes. For small diffs (roughly ≤150 lines and ≤2 files), inspect the diff yourself.

Keep roles separate. Do not make one child design, implement, and review its own work.

| Role | Count | Typical runtime | Output |
|---|---:|---|---|
| Counselor | 2 | strongest reasoning available, diverse families | Scratchpad analysis, no code. |
| Worker | 1 | fast strong implementer, often Claude Sonnet | Code + tests; stops at “tests green, awaiting review”. |
| Reviewer | 1 fresh agent | strongest reviewer available | Short findings report, not a full diff dump. |

## Evidence first

Before dispatching a child, gather enough concrete evidence yourself:

- File paths and line numbers.
- Relevant command output, failing test names, logs, or database/schema facts.
- Expected behavior vs actual behavior.
- What is already ruled out.

A prompt like “investigate X and figure out what is wrong” is a red flag. Give paths and facts; children can read files, so pass paths instead of pasting large file contents.

## Spawn and configure

```text
solo_spawn_process(kind="agent", agent_tool_id=<from solo_list_agent_tools>, name="<descriptive-slug>")
```

Use descriptive names; they appear in Solo's process list.

For Claude children, model/effort switching was confirmed here:

```text
solo_send_input(process_id=<pid>, input="/model sonnet")
solo_send_input(process_id=<pid>, input="/effort medium")
```

For other runtimes, ask the child to confirm its available controls. Avoid hardcoding exact model versions in the skill; defaults change.

## Brief the child

Spawned agents have no shared context. Every first prompt must stand alone:

1. **Goal:** one sentence.
2. **Context/evidence:** why this matters, what was tried, file paths/line numbers, failing commands.
3. **Scope:** exact files, command, diff range, or question boundaries.
4. **Constraints:** at minimum: `Do NOT commit.` For workers: `Do not spawn sub-agents. Stop at "tests green, awaiting review".`
5. **Deliverables:** stdout summary or exact scratchpad name/tags.

If `solo_send_input` displays a pasted-text marker and the child does not start, send an empty input to submit:

```text
solo_send_input(process_id=<pid>, input="")
```

## Use timers, not polling

Schedule a Solo timer after briefing agents:

```text
solo_timer_fire_when_idle_all(
  processes=[<pid1>, <pid2>],
  max_wait_ms=900000,
  body="Agents <ids/names> are idle or timed out. Read scratchpads tagged <tag> and process output lines=200+. Synthesize next steps."
)
```

Timeout guidelines:

- Smoke/quick confirmation: `30000–60000` ms.
- Short research/review: `180000` ms.
- Implementation or known-slow work: `900000+` ms.

The `body` is injected as a fresh user turn when the timer fires. Write it with enough context to be useful by itself: process IDs, scratchpad names/tags, and the decision to make.

## Collect results

Prefer scratchpads for structured reports:

1. `solo_scratchpad_list(tags=[...])`
2. `solo_scratchpad_read(scratchpad_id=<id>)`

Use `solo_get_process_output(process_id=<pid>, lines=200+)` for stdout summaries or when a child cannot access scratchpads. The default output length is often too short for real reports.

## Review and follow up

### Small diff: inspect yourself

Look for common worker smells:

- Defensive scaffolding for impossible cases.
- Duplicate constants/helpers that say the same thing.
- Over-broad framework types where a narrow domain type fits.
- Missing closure parameter types or return types.
- Try/catch around internal code that cannot fail.
- New abstraction for one call site.
- Drift from the brief.

If you find issues, send a precise follow-up to the same worker. Do not spawn a new worker for the same topic unless the context is unrecoverable.

### Larger diff: fresh reviewer

Spawn a new reviewer with no prior context. Brief it with:

- The original task/spec.
- The worker's summary.
- Explicit diff scope: specific files, or a commit range.
- Known intentional prior work so it does not flag approved changes as scope creep.
- The smell list above.

Diff scope is critical. `git diff HEAD` includes every uncommitted change, not just the current worker's work. Prefer `git diff HEAD -- path1 path2` or a commit range.

Read the reviewer report, filter obvious false positives, then relay actionable fixes back to the original worker via `solo_send_input`.

## Counselors fan-out pattern

Use for design choices or contested plans:

1. Spawn two agents, preferably different model families.
2. Send the same self-contained prompt to both.
3. Require analysis only, no code.
4. Ask each to write a scratchpad named `<topic> — <runtime>` with shared tags.
5. Wait with `solo_timer_fire_when_idle_all`.
6. Read reports and synthesize consensus, disagreements, and blind spots for the user.

The disagreement is the value. Do not flatten it into a fake consensus.

## Commit and cleanup rules

- Workers never commit unless the user explicitly granted “commit when green” up front.
- The orchestrator waits for clear user approval before committing.
- If the user explicitly pre-authorized “commit when green,” the orchestrator may commit after validation; report exactly what was committed.
- After the user accepts or the result is no longer needed, close idle child agents with `solo_close_process`.
- Archive or delete temporary scratchpads after extracting their content. Keep durable design/review scratchpads only when useful to the user.

## Common pitfalls

- Assuming child MCP tool names. Always discover/ask; Pi uses `solo_*`, Codex may have no direct surface.
- Forgetting an empty submit after a multi-line paste.
- Timer body too vague to understand when injected later.
- Too-short timers for implementation work.
- Reading only the default 50 output lines.
- Letting stale agents pile up in Solo UI.
- Asking a child to “investigate” without evidence, paths, or a bounded deliverable.
- Reviewing an unscoped `git diff HEAD` when the tree contains unrelated changes.
