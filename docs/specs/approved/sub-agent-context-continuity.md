---
title: "Sub-Agent Context Continuity"
description: "Incremental session transcript persistence and automatic context inheritance for sub-agent sessions."
status: approved
informed_by:
  - docs/research/technical/RESEARCH-LCM-ACP.md
  - docs/research/technical/HARNESS-HOOKS-RESEARCH.md
success_criteria:
  - "Parent session transcript is queryable by any session (including sub-agents) while the parent is still active"
  - "Sub-agent sessions receive a deterministic context block from the parent at session-start with no LLM call"
  - "Sub-agents can search parent session content via session_search tool"
  - "Inheritance is transparent — no explicit prepare/claim steps required from the agent"
---

Sub-Agent Context Continuity
=============================

*Engine-managed context threading from parent to sub-agent.*

> "The engine manages memory deterministically. The agent doesn't have to
> think about memory management — the engine just does the right thing."
> — LCM paper, adapted

---

## Background

Issue #315 surfaced a gap: when a parent agent spawns a sub-agent, the
sub-agent starts cold. No memories. No entity context. No awareness of
what the parent session has accumulated. The parent must manually
summarize relevant context in the task description to compensate,
which is fragile and burdens every sub-agent invocation.

There is a deeper root cause underneath this: session transcripts are
only persisted at session end. An active session is dark — its content
is unavailable to any other session until it terminates. This makes the
parent→child context problem unsolvable even if we wanted to solve it,
because the parent's transcript doesn't exist yet at the time the
sub-agent spawns.

This spec addresses both: fix the persistence gap first, then build
context inheritance on top of it.

---

## Phase 1: Live Transcript Persistence

**Status:** complete.

### The Problem

`session_transcripts` (migration 040, hardened by migration 047) stores
the complete transcript and keeps it agent-scoped. Prompt-time upserts
already keep active sessions visible before session end. If a session
is interrupted or still running when a sub-agent spawns, the latest
prompt-time snapshot remains queryable.

### The Fix

Keep writing to `session_transcripts` on every `UserPromptSubmit` hook
call and at `SessionEnd`. The shared `upsertSessionTranscript` helper
preserves `created_at`, refreshes `updated_at`, and updates the FTS
surface through the table triggers.

The active schema supports this:

```sql
CREATE TABLE session_transcripts (
    session_key TEXT NOT NULL,
    content     TEXT NOT NULL,
    harness     TEXT,
    project     TEXT,
    agent_id    TEXT NOT NULL DEFAULT 'default',
    created_at  TEXT NOT NULL,
    updated_at  TEXT,
    PRIMARY KEY (agent_id, session_key)
);
```

The upsert on each `UserPromptSubmit` keeps `content` current as the
session grows. The `created_at` column preserves the original write
time and `updated_at` records the latest active snapshot. `session_end`
retains its own write as a final snapshot to ensure the terminal state
is captured even if the last few turns missed a hook.

### What This Enables Immediately

Any session — sub-agent or otherwise — can now query a running parent
session's transcript via the existing `session_transcripts` table. A
new `session_search` MCP tool and `/api/sessions/search` endpoint
expose this. Cross-session transcript availability also improves
debugging, diagnostics, and the session summary DAG (LCM Pattern 4)
which currently can only process completed sessions.

### Implementation

- `platform/daemon/src/hooks.ts`: `handleUserPromptSubmit` reads the
  transcript path or inline transcript, normalizes it, and calls
  `upsertSessionTranscript`.
- `platform/daemon/src/hooks.ts`: `handleSessionEnd` calls the same
  helper for the terminal write.
- `platform/daemon/src/session-transcripts.ts`: owns the scoped upsert,
  read, and FTS-backed search helpers.

---

## Phase 2: Sub-Agent Context Inheritance

### The Principle

When a sub-agent spawns, the daemon should thread the parent's context
to it automatically. No prepare/claim tokens. No explicit tool calls.
The engine observes the parent-child relationship through harness-native
signals and injects at session-start.

This is the LCM scope-reduction invariant applied to Signet: the parent
delegates a scoped task and the engine ensures the sub-agent has the
context it needs to perform it.

### Harness Detection Matrix

Each harness surfaces parent-child relationships differently. Signet
handles each natively:

**Claude Code** — `agent_id` is present on all hook payloads inside a
sub-agent session (added CC v2.1.69, March 5 2026). No `SubagentStart`
hook needed. Detection:
- Sub-agent's `SessionStart` arrives with `agent_id` present.
- Daemon queries `session_transcripts` for the most recently updated
  row matching the same `project`, `harness`, and Signet `agent_id` where
  `session_key != current`:
  `SELECT * FROM session_transcripts WHERE agent_id = ? AND project = ? AND harness = ? ORDER BY updated_at DESC LIMIT 1`
- That row is the parent. No TTL, no pending-spawn slot, no extra agent
  action. If two parent sessions exist for the same project, the most
  recently active one is the least surprising choice.

**OpenClaw** — session keys self-describe lineage:
`agent:{id}:subagent:{uuid}` vs `agent:{id}:main`. The `resolveAgentId`
function already parses this format (Multi-Agent Phase 8). Detection:
- In `handleSessionStart`, if `isSubagentSessionKey(sessionKey)` is
  true, extract the parent session key from the format and query
  `session_transcripts` directly. No pending-spawn slot needed.

**OpenCode** — `session.created` SSE event includes `parentID` on
child sessions. Detection:
- The plugin records the child session's `parentID` and passes it
  through the next session-start hook body as `parentSessionKey`.
  Daemon uses it for direct lookup.

**Codex** — sub-agent sessions are indistinguishable from external
hook payloads. No parent info is available. Graceful degradation:
no context block injected. The agent can still call `session_search`
manually if the parent session key is known.

### The Context Block

The inherited context block is assembled deterministically from data
already in the DB. No LLM call. This keeps the session-start latency
budget intact and avoids the cost-at-spawn problem LCM's
`lcm_expand_query` sub-agent isolates.

Content (ordered by usefulness, subject to token budget):

1. **Checkpoint summary** — content from the most recent
   `session_checkpoints` row for the parent session key, if one
   exists. Checkpoints are already budgeted and formatted for
   injection; no re-processing needed.
2. **Transcript tail** — last 3000 characters of
   `session_transcripts.content` for turns since the last checkpoint
   (or from the start if no checkpoint exists). Character budget, no
   turn parsing, no harness-specific format logic.
3. **Active constraints** — `entity_attributes` where
   `kind = 'constraint'` for focal entities in the checkpoint.
   Always included per Invariant 5.
4. **Focal entity names** — entity names from the checkpoint's
   structural snapshot, if present.

If the parent has neither a checkpoint nor a transcript yet, the
block is omitted rather than injected empty.

The block is formatted as a named section in the inject:

```
## Inherited from Parent Session

[session title or "active session"]
Recent context:
  [last N turns, truncated to budget]
Focal entities: [entity names]
Active constraints: [constraint text]
```

If the parent session has no transcript yet (e.g., it just started),
the block is omitted rather than injected empty.

### Sub-Agent Session Search

With Phase 1 in place, sub-agents can query any session's transcript,
including the parent's active session, via a new MCP tool:

```
mcp__signet__session_search(query, sessionKey?)
```

- `query` — natural language or keyword search applied to
  `session_transcripts.content` via FTS5
- `sessionKey` — optional; defaults to the parent session key if
  the current session is a sub-agent

This gives sub-agents pull access to parent context on demand,
complementing the push at session-start. Follows LCM's On-Demand
Expansion pattern (Pattern 5) applied across session boundaries.

The `session_search` MCP tool is also useful for the parent agent to
retrospectively search its own prior sessions, independent of the
sub-agent use case.

### Configuration

```yaml
memory:
  pipelineV2:
    subagents:
      inheritContext: true    # default: true when parent is detected
      tailChars: 3000         # chars from transcript tail since last checkpoint
```

`includeEntities` and `includeConstraints` are always on — constraints
surface unconditionally per Invariant 5. `inheritContext: false` disables
the inject block entirely while leaving `session_search` available.

Visibility scoping is not configurable: sub-agents always inherit the
parent's `agent_id` for all queries. An `isolated` parent's sub-agents
see only the parent's data; a `shared` parent's sub-agents see all
`visibility=global` data. The existing agent scoping invariant handles
this with no special-casing.

### Implementation

- `platform/daemon/src/hooks.ts`: add parent-lookup logic to
  `handleSessionStart()`. For CC: if `agent_id` is present in the
  payload, query `session_transcripts WHERE project = ? AND session_key != ?
  ORDER BY updated_at DESC LIMIT 1`. For OpenClaw: if
  `isSubagentSessionKey(sessionKey)`, extract parent key from session key
  format and query directly. For OpenCode: if `parentSessionKey` is present in
  the hook body, use it directly. If parent found, call
  `assembleInheritBlock()`.
- `platform/daemon/src/hooks.ts`: add `assembleInheritBlock(parentKey,
  cfg)` — fetches latest `session_checkpoints` row for parent, takes
  `cfg.tailChars` from tail of `session_transcripts.content`, fetches
  active constraints for checkpoint's focal entities. Pure DB reads,
  no LLM. Returns formatted block or `null` if no data exists yet.
- `platform/daemon/src/mcp.ts`: register `session_search` tool. Queries
  `session_transcripts` via FTS5; `sessionKey` param defaults to parent
  key when current session is a sub-agent.
- `platform/daemon/src/daemon.ts`: add `GET /api/sessions/{key}/transcript`
  and `POST /api/sessions/search` endpoints.
- `platform/core/src/types.ts`: extend `AgentManifest` with
  `memory.pipelineV2.subagents` config block.
- No connector changes needed for CC — no `SubagentStart` hook required.

---

## Relationship to LCM Patterns

This spec is a direct application of two LCM patterns from
`docs/specs/planning/LCM-PATTERNS.md`:

**Pattern 1 (Lossless Retention)** — Phase 1 applies lossless retention
at the turn level. Active sessions are no longer dark. The immutable
store (LCM's term) is the `session_transcripts` table; every turn is
persisted verbatim as it arrives.

**Pattern 5 (On-Demand Expansion)** — the `session_search` tool is the
pull path. The inherited context block is the push path. Together they
cover both the predictable (what the engine infers the sub-agent needs)
and the unpredictable (what the sub-agent discovers it needs mid-task).

The key deviation from LCM's `lcm_expand_query` (which spawns a
sub-agent for expansion) is that Signet's expansion runs in-process.
No sub-agent needed for expansion because the knowledge is structured in
SQLite — a targeted query is cheaper and faster than a spawned agent.

---

## Decisions

1. **Transcript slice format** — character budget (3000 chars from
   tail), not discrete turn parsing. The inherit block is for
   orientation, not perfect reproduction. `session_search` is the
   pull path for anything more specific. No harness-specific parsing
   needed.

2. **CC parent detection** — project-keyed recency query on
   `session_transcripts`, no `SubagentStart` hook and no pending-spawn
   slot. `ORDER BY updated_at DESC LIMIT 1` where project, harness, and
   Signet agent scope match and session key differs. Simpler, no extra
   prepare step, and it follows the most recently active parent.

3. **Visibility scoping** — sub-agents inherit parent's `agent_id`
   automatically. Not configurable. The existing agent scoping
   invariant (cross-cutting invariant 1) handles this with no
   special-casing.

4. **Harness sub-agent IDs are not Signet agent IDs** — Claude Code's
   `agent_id` hook field is treated as harness lineage metadata only.
   It must not be used as Signet's persistence `agent_id` or sub-agent
   sessions would silently fork user memory scope.

---

*Written by Nicholai and Ant. March 24, 2026. Informed by issue #315
and harness hook research (Claude Code v2.1.69+, OpenClaw plugin
hooks, OpenCode session.created parentID, Codex graceful degradation).*
