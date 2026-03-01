---
title: Session Continuity Protocol
description: Spec for capturing context at compaction boundaries so agents survive context window resets.
section: Specs
---

# Session Continuity Protocol

## Context

When AI coding assistants hit their context window limit, they compact/summarize
the conversation and lose nuance — decisions, state, reasoning. The agent
"forgets" mid-task. Signet already sits as an external memory layer. This feature
makes it catch what the compactor drops, so agents can survive their own context
window dying.

Three components: **rolling session digest**, **context offload hook**, and
**session recovery**.

## Architecture Overview

Two data channels feed checkpoints:

1. **Passive accumulation** (all platforms) — daemon observes search queries from
   user-prompt-submit and /remember calls, writes structural checkpoints every N prompts
2. **Agent-initiated digest** (all platforms via MCP, Phase 2) — `session_digest` MCP
   tool lets the agent write a rich narrative checkpoint with decisions, state, blockers

```
Passive channel (automatic):
  user-prompt-submit fires →
    daemon accumulates queries + /remember calls in continuity-state →
    every N prompts: buffer checkpoint write (batched, not per-prompt)

Active channel (agent-initiated via MCP, Phase 2):
  agent calls session_digest tool →
    daemon writes rich narrative checkpoint with agent-provided summary

Pre-compaction (Phase 3):
  pre-compaction hook fires →
    daemon writes emergency checkpoint with sessionContext

Recovery (automatic):
  session-start fires →
    daemon checks for recent checkpoints matching this project →
    if found: inject latest checkpoint in pre-reserved budget section
```

## Phased Rollout

**Phase 1**: schema + sessionKey plumbing + passive checkpoints + recovery injection + API
**Phase 2**: MCP session_digest tool + agent instruction updates
**Phase 3**: pre-compaction enrichment + pruning policy tuning + scorer integration

## Data Model

New migration `016-session-checkpoints.ts`:

```sql
CREATE TABLE IF NOT EXISTS session_checkpoints (
    id TEXT PRIMARY KEY,
    session_key TEXT NOT NULL,
    harness TEXT NOT NULL,
    project TEXT,
    project_normalized TEXT,           -- realpath-resolved for matching
    trigger TEXT NOT NULL,             -- 'periodic' | 'pre_compaction' | 'agent' | 'explicit'
    digest TEXT NOT NULL,
    prompt_count INTEGER NOT NULL,
    memory_queries TEXT,               -- JSON: recent search terms
    recent_remembers TEXT,             -- JSON: recent /remember content
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_checkpoints_session
    ON session_checkpoints(session_key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_checkpoints_project
    ON session_checkpoints(project_normalized, created_at DESC);
```

Changes from original:
- **Dropped `sequence` column and UNIQUE constraint** — avoids race condition on
  concurrent writes. Use `created_at DESC` ordering instead. Each checkpoint is
  uniquely identified by `id` (UUID). No sequence math needed.
- **Added `project_normalized`** — `realpath()`-resolved project path for reliable
  matching across symlinks/aliases. Raw `project` kept for display.

Why a new table instead of `memories`: checkpoints are ephemeral session state with
a different lifecycle (hours not weeks), different query patterns (lookup by
session/project not FTS/vector), different retention. Mixing them would pollute
the scoring/decay pipeline.

## Implementation

### 0. SessionKey plumbing fix: CLI hooks + daemon

**This is the prerequisite.** Currently, the CLI hook commands (`signet hook
session-start`, `user-prompt-submit`, `session-end`, `pre-compaction`) don't
parse or forward `session_id` from stdin. Claude Code sends it as a common field
on all hook events (ref: [Claude Code hooks docs](https://code.claude.com/docs/en/hooks)).

**CLI changes** (`packages/cli/src/cli.ts`):
- In each hook command's stdin parser, extract `session_id` (or `sessionId`)
- Forward as `sessionKey` in the POST body to the daemon
- All hooks already accept `sessionKey` on the daemon side — this just connects the pipe

**Stdin JSON from Claude Code** (common fields on all hooks):
```json
{
    "session_id": "abc123",
    "transcript_path": "/path/to/transcript.jsonl",
    "cwd": "/path/to/project",
    "permission_mode": "default",
    "hook_event_name": "UserPromptSubmit"
}
```

### 1. Migration: `packages/core/src/migrations/016-session-checkpoints.ts`

Create the table + indexes above. Register in `migrations/index.ts`.

### 2. Continuity state module: `packages/daemon/src/continuity-state.ts`

**New file.** Separate from session-tracker.ts (which stays focused on runtime
claim mutex). This module tracks per-session accumulation state for checkpointing.

```typescript
interface ContinuityState {
    readonly sessionKey: string;
    readonly harness: string;
    readonly project: string | undefined;
    readonly projectNormalized: string | undefined;
    promptCount: number;
    lastCheckpointAt: number;
    pendingQueries: string[];      // capped at 20
    pendingRemembers: string[];    // capped at 10
    startedAt: number;
}

const state = new Map<string, ContinuityState>();
```

Exports:
- `initContinuity(sessionKey, harness, project)` — called from session-start
- `recordPrompt(sessionKey, queryTerms)` — increment count, push query
- `recordRemember(sessionKey, content)` — push to pendingRemembers
- `shouldCheckpoint(sessionKey, config)` — check prompt count + time threshold
- `consumeState(sessionKey)` — returns accumulated state, resets pending arrays
- `clearContinuity(sessionKey)` — called from session-end
- `getState(sessionKey)` — read-only for diagnostics

Path normalization: `projectNormalized` is set via `fs.realpathSync()` on init,
falling back to raw path if realpath fails. All checkpoint queries use the
normalized path.

### 3. Checkpoint module: `packages/daemon/src/session-checkpoints.ts`

New file with core checkpoint operations:

**`writeCheckpoint(db, params)`**
- Params: sessionKey, harness, project, projectNormalized, trigger, digest,
  promptCount, memoryQueries, recentRemembers
- Generates UUID for `id`
- Single INSERT — no sequence math, no race conditions
- Enforces maxCheckpointsPerSession by counting existing rows and deleting
  oldest if over limit

**`getLatestCheckpoint(db, projectNormalized, withinMs)`**
- Query: `WHERE project_normalized = ? AND created_at > ? ORDER BY created_at DESC LIMIT 1`
- Also supports lookup by sessionKey directly (for explicit linking)
- Returns checkpoint row or null

**`getCheckpointsBySession(db, sessionKey)`**
- Returns all checkpoints for a session, ordered by created_at
- Used by API endpoint

**`pruneCheckpoints(db, retentionDays)`**
- Delete checkpoints older than retentionDays
- Keep the most recent checkpoint per session_key within the retention window
- **Called from daemon scheduler/maintenance loop, NOT session-tracker**

### 4. Buffered checkpoint writes

To avoid blocking the user-prompt-submit hot path with synchronous SQLite
writes on every checkpoint trigger:

- `shouldCheckpoint()` returns true but doesn't write immediately
- The daemon accumulates the checkpoint data and flushes on a short timer
  (2-3 second debounce, similar to the existing file watcher debounce pattern)
- If multiple checkpoints are pending for the same session, merge them
  (latest state wins)
- Flush on session-end to ensure no data loss

Implementation: a simple `setTimeout`-based flush queue in the checkpoint
module. Not a full async worker — just delayed writes.

### 5. Checkpoint digest format (passive channel)

For daemon-accumulated checkpoints (trigger `"periodic"`):

```
## Session Checkpoint
Project: {project}
Prompts: {count} | Duration: {elapsed}

### Memory Activity Since Last Checkpoint
Queries: {recent search terms from user-prompt-submit}
Remembered: {recent /remember contents}
Top memories accessed: {most-hit memory IDs from session_memories FTS tracking}
```

For agent-initiated checkpoints (trigger `"agent"`, Phase 2): the agent's
summary verbatim.

For pre-compaction (trigger `"pre_compaction"`, Phase 3): daemon accumulated
state + runtime-provided sessionContext.

### 6. Hook integration: `packages/daemon/src/hooks.ts`

**handleSessionStart** (modify):
- Call `initContinuity(sessionKey, harness, project)` to set up accumulator
- After loading memories, before building inject: call
  `getLatestCheckpoint(projectNormalized, 4hrs)`
- Recovery matching priority: sessionKey lineage (via `previousSessionKey` field)
  > exact normalized project path > skip
- If checkpoint found: inject as `## Session Recovery Context` section within a
  **pre-reserved 2000-char budget** (deducted from total budget upfront, not
  truncated at the end)

**handleUserPromptSubmit** (modify):
- After FTS query: call `recordPrompt(sessionKey, queryTerms)`
- Check `shouldCheckpoint(sessionKey)` — if true, queue a buffered write

**handleRemember** (modify):
- After memory saved: call `recordRemember(sessionKey, content)`

**handleSessionEnd** (modify):
- Flush any pending checkpoint writes
- Call `clearContinuity(sessionKey)` to free memory

**handlePreCompaction** (Phase 3, modify):
- Write a checkpoint with trigger `"pre_compaction"`
- Include `req.sessionContext` in the digest if provided

### 7. SessionKey plumbing in CLI: `packages/cli/src/cli.ts`

For each hook command (`session-start`, `user-prompt-submit`, `session-end`,
`pre-compaction`), update the stdin parser to extract `session_id` and forward
it as `sessionKey` in the POST body. Example for user-prompt-submit:

```typescript
const parsed = JSON.parse(input);
userPrompt = parsed.user_prompt || parsed.userPrompt || "";
sessionKey = parsed.session_id || parsed.sessionId || "";
// ... forward sessionKey in body
```

### 8. Redaction: `packages/daemon/src/session-checkpoints.ts`

Agent-initiated digests (Phase 2) may contain secrets/tokens. Before storing:
- Apply a denylist pattern scan (common patterns: Bearer tokens, API keys,
  base64-encoded credentials, env var patterns like `$SECRET_NAME`)
- Redact matches with `[REDACTED]`
- Same redaction applied before serving via `/api/checkpoints` responses
- Reuse existing content normalization from `packages/daemon/src/content-normalization.ts`
  if applicable

### 9. Configuration: `packages/core/src/types.ts`

Add under `PipelineV2Config` (nested, not top-level):

```typescript
readonly continuity?: {
    readonly enabled: boolean;          // default true
    readonly promptInterval: number;    // default 10
    readonly timeIntervalMs: number;    // default 900000 (15 min)
    readonly maxCheckpointsPerSession: number;  // default 50
    readonly retentionDays: number;     // default 7
    readonly recoveryBudgetChars: number; // default 2000
};
```

Wire defaults in `packages/daemon/src/memory-config.ts`.

### 10. API endpoints: `packages/daemon/src/daemon.ts`

Read-only endpoints behind auth middleware:

- `GET /api/checkpoints?project=...&limit=10` — recent checkpoints for a project
- `GET /api/checkpoints/:sessionKey` — all checkpoints for a specific session
- Apply auth scope + rate limiting consistent with other `/api/*` routes

### 11. Checkpoint pruning: daemon scheduler

Wire `pruneCheckpoints()` into the existing daemon maintenance/scheduler loop
(see `packages/daemon/src/scheduler/`), NOT into session-tracker cleanup.
Run on the same cadence as other maintenance tasks.

## Platform Support Matrix

| Capability | Claude Code | OpenCode | OpenClaw Plugin | OpenClaw Legacy |
|---|---|---|---|---|
| Passive checkpoints (Phase 1) | yes | yes | yes | yes* |
| Session recovery (Phase 1) | yes | yes | yes | yes |
| MCP session_digest (Phase 2) | yes | yes | yes | yes |
| Pre-compaction offload (Phase 3) | yes (new) | yes | yes | no |

*OpenClaw legacy requires /recall or /context commands to trigger user-prompt-submit
equivalent

## Predictive Memory Scorer Integration (Phase 3)

Deferred to Phase 3 per rollout plan. Connection points documented in
`docs/specs/planning/predictive-memory-scorer.md`:

- Recovery sessions vs cold starts create natural A/B for scorer training
- Checkpoint `memory_queries` feed FTS behavioral signal pipeline
- `session_scores.novel_context_count` measures recovery effectiveness
- Agent digests capture what the agent was *actually doing* for tighter labels

## Key Design Decisions

**Two data channels, not one.** Passive works everywhere automatically. Active
(MCP) provides rich narrative data. Both feed the same table. Useful on day one,
dramatically better as agents learn to call session_digest.

**Separate continuity-state.ts from session-tracker.ts.** Session tracker is
pure in-memory mutex logic. Continuity state is accumulation/buffering. Different
concerns, different modules.

**No sequence column.** UUID primary key + `created_at DESC` ordering avoids the
race condition on concurrent writes. Simpler, no retry logic needed.

**Buffered writes, not per-prompt.** Debounced 2-3s timer prevents blocking the
hot path. Merged if multiple triggers fire close together.

**Path normalization for recovery matching.** `realpath()` resolves symlinks and
aliases. Prevents false matches and missed matches from path variations.

**Pre-reserved recovery budget.** 2000 chars deducted from total inject budget
upfront, not truncated at the end. Guarantees space for recovery context.

**Redaction before storage.** Agent-authored digests may contain sensitive data.
Denylist scan catches common secret patterns before write and before API serve.

**SQLite-only storage.** Machine-readable recovery artifacts. Dashboard surfaces
them via API.

## Files to Create/Modify

| File | Action | Description |
|---|---|---|
| `packages/core/src/migrations/016-session-checkpoints.ts` | create | New migration |
| `packages/core/src/migrations/index.ts` | modify | Register migration 016 |
| `packages/core/src/types.ts` | modify | Add continuity config under PipelineV2Config |
| `packages/daemon/src/continuity-state.ts` | create | Per-session accumulation state |
| `packages/daemon/src/session-checkpoints.ts` | create | Checkpoint read/write/prune/redact |
| `packages/daemon/src/hooks.ts` | modify | Wire checkpoint triggers + recovery injection |
| `packages/daemon/src/daemon.ts` | modify | Add /api/checkpoints routes with auth |
| `packages/daemon/src/memory-config.ts` | modify | Wire continuity config defaults |
| `packages/cli/src/cli.ts` | modify | Parse session_id from stdin in all hook commands |
| `packages/daemon/src/mcp/tools.ts` | modify | Add session_digest MCP tool (Phase 2) |
| `packages/connector-claude-code/src/index.ts` | modify | Add PreCompaction hook (Phase 3) |

## Verification

1. `bun run build` — confirm no type errors across workspace
2. `bun test` — run existing tests, confirm nothing breaks
3. Unit test: continuity-state.ts accumulation, shouldCheckpoint logic, buffer flush
4. Unit test: session-checkpoints.ts write/read/prune, path normalization
5. Integration: start session via CLI hook, send 10+ prompts, verify checkpoints in DB
6. Integration: kill session, start new in same project — verify recovery context injected
7. Integration: verify sessionKey flows through CLI hooks to daemon
8. `GET /api/checkpoints?project=...` — verify API returns data with auth
9. Verify pruning: create old checkpoints, trigger maintenance, confirm retention
