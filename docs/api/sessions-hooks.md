---
title: "Sessions and hooks API"
description: "Harness hook and session lifecycle endpoints."
order: 17
section: "Reference"
---

# Sessions and hooks API

Harness hook and session lifecycle endpoints.

[Back to HTTP API overview](../API.md).

## Hooks

Hook endpoints integrate with AI harness session lifecycle events. They are
used by connector packages to inject memory context and extract new memories.

The `x-signet-runtime-path` request header (or `runtimePath` body field)
declares whether the caller is the `plugin` or `legacy` runtime path. The
daemon enforces that only one path can be active per session — subsequent
calls from the other path return `409`.

### POST /api/hooks/session-start

Called at the beginning of a session. Returns context and relevant memories
for injection into the harness system prompt. Requires `remember` permission
(via hook routing).

**Request body**

```json
{
  "harness": "claude-code",
  "project": "/workspace/repo",
  "agentId": "optional-signet-agent-id",
  "harnessAgentId": "optional-harness-subagent-id",
  "parentSessionKey": "optional-parent-session-key",
  "sessionKey": "session-uuid",
  "runtimePath": "plugin"
}
```

`harness` is required. `agentId` is the Signet persistence scope. Harness
native sub-agent identifiers, such as Claude Code's `agent_id`, must be sent as
`harnessAgentId`; they are lineage hints and are not used for Signet data
scoping. `parentSessionKey` may be provided when the harness exposes explicit
lineage. If it is absent, Signet infers parent context where possible from
harness-native signals such as OpenClaw lineage session keys or recent Claude
Code parent activity in the same project.

**Response** — implementation-defined context object returned by
`handleSessionStart`.

### POST /api/hooks/user-prompt-submit

Called on each user message. Returns memories relevant to the current prompt
for in-context injection.

**Request body**

```json
{
  "harness": "claude-code",
  "userMessage": "How do I set up dark mode?",
  "userPrompt": "How do I set up dark mode?",
  "lastAssistantMessage": "Earlier we discussed using CSS variables for theme tokens.",
  "sessionKey": "session-uuid",
  "transcriptPath": "/tmp/signet/session-transcript.txt",
  "runtimePath": "plugin"
}
```

`harness` is required.
`userMessage` is preferred when the harness can provide a cleaned user turn.
`userPrompt`, `lastAssistantMessage`, `transcriptPath`, and inline `transcript`
are optional.

Prompt-submit retrieval prefers structured memory recall. When structured
recall is weak or empty, the daemon may attempt temporal-summary fallback
(session DAG artifacts). Raw transcript search is not injected on
prompt-submit; use the dedicated `session_search` MCP/API surface when a
caller needs transcript evidence.

### POST /api/hooks/session-end

Called at session end. Triggers memory extraction from the transcript.
Releases the session's runtime path claim.

**Request body**

```json
{
  "harness": "claude-code",
  "sessionKey": "session-uuid",
  "sessionId": "session-uuid",
  "transcriptPath": "/tmp/signet/session-transcript.txt",
  "runtimePath": "plugin"
}
```

`harness` is required.
`transcriptPath` or inline `transcript` may be provided for transcript
capture. Signet stores a cleaned conversation-only transcript in memory
surfaces and may retain raw auditable traces separately in daemon logs.

When transcript text is available, the daemon first writes the canonical
conversation transcript as JSONL at
`$SIGNET_WORKSPACE/memory/{harness}/transcripts/transcript.jsonl` and records
lineage through the session manifest. Existing markdown transcript artifacts
remain readable for backward compatibility and are backfilled into the JSONL
history.

The manifest is mutable and may later gain a `compaction_path`; the JSONL
transcript is the forward source of truth. The async summary worker later writes
the matching immutable `--summary.md` artifact for normal `session-end` jobs.

### POST /api/hooks/remember

Explicit memory save from within a session. Requires `remember` permission.

**Request body**

```json
{
  "harness": "claude-code",
  "content": "User wants dark mode by default",
  "sessionKey": "session-uuid",
  "runtimePath": "plugin"
}
```

`harness` and `content` are required.

### POST /api/hooks/recall

Explicit memory query from within a session. Requires `recall` permission.

**Request body**

```json
{
  "harness": "claude-code",
  "query": "user UI preferences",
  "keywordQuery": "\"dark mode\" OR theme",
  "project": "/workspace/repo",
  "limit": 5,
  "type": "preference",
  "tags": "ui,editor",
  "who": "claude-code",
  "since": "2026-01-01T00:00:00Z",
  "until": "2026-04-01T00:00:00Z",
  "aggregate": true,
  "aggregateBudget": "small",
  "saveAggregate": true,
  "sessionKey": "session-uuid",
  "agentId": "alice",
  "includeRecalled": false,
  "runtimePath": "plugin"
}
```

`harness` and `query` are required.

This route is a hook-oriented wrapper around `POST /api/memory/recall`. It
accepts a narrower request surface, applies hook/session policy checks, and
then forwards the supported recall filters and explicit aggregate recall flags
into the shared recall path.
When `sessionKey` is present, it participates in the same context-epoch dedupe
ledger as `POST /api/memory/recall`.

`project` on this route is forwarded as the memory `project` filter. It is not
remapped to recall `scope`.

**Response**

Same recall-family shape as `POST /api/memory/recall`, plus legacy
compatibility fields during the transition period:

```json
{
  "results": [],
  "memories": [],
  "count": 0,
  "query": "user UI preferences",
  "method": "hybrid",
  "meta": {
    "totalReturned": 0,
    "hasSupplementary": false,
    "noHits": true
  },
  "message": "No matching memories found."
}
```

Special no-op cases preserve the same shape and add a flag:

- `{ ..., "bypassed": true }` when the session is bypassed
- `{ ..., "internal": true }` for internal no-hook calls

`memories` and `count` are legacy compatibility aliases for older hook
consumers and will mirror `results` and `results.length` during the
transition period. `message` is the canonical formatted recall brief used by
thin harness hooks so connectors do not reimplement ranking or presentation
rules.

### POST /api/hooks/pre-compaction

Called before context window compaction. Returns summary instructions for
the compaction prompt.
This endpoint does not advance the recall context epoch; only
`/api/hooks/compaction-complete` does.

**Request body**

```json
{
  "harness": "claude-code",
  "sessionKey": "session-uuid",
  "runtimePath": "plugin"
}
```

`harness` is required.

### POST /api/hooks/compaction-complete

Save a compaction summary as a memory row, as a temporal DAG artifact, and as a
canonical immutable markdown compaction artifact linked back through the
session manifest.

**Request body**

```json
{
  "harness": "claude-code",
  "summary": "Session covered dark mode setup and vim configuration...",
  "sessionKey": "session-uuid",
  "project": "/workspace/repo",
  "runtimePath": "plugin"
}
```

`harness` and `summary` are required.

If `sessionKey` is present, the daemon uses it to preserve lineage:

- the memory row is agent-scoped
- `source_id` points back to the session lineage
- the temporal node keeps `session_key`
- the artifact can later be expanded through the temporal drill-down API
- transcript and temporal summary persistence are keyed by `agentId +
  sessionKey`, so identical session keys from different agents do not collide
- the canonical compaction file is written to
  `memory/{captured_at}--{session_token}--compaction.md`
- the mutable manifest for that session is backfilled with `compaction_path`
- the recall context epoch advances, so memories recalled before compaction are
  eligible again in the fresh context

If compaction fires before transcript persistence lands, callers should also
send `project`. The daemon uses that explicit project as the fallback lineage
scope until transcript storage catches up.

**Response**

```json
{ "success": true, "memoryId": "uuid", "contextEpoch": 1 }
```

### POST /api/hooks/session-checkpoint-extract

Trigger a mid-session memory extraction for long-lived sessions (Discord bots,
persistent agents) that never call `session-end`. Computes a delta since the
last extraction cursor and enqueues a summary job without releasing the session
claim.

**Request body**

```json
{
  "harness": "openclaw",
  "sessionKey": "session-uuid",
  "agentId": "agent-id",
  "project": "/workspace/repo",
  "transcriptPath": "/tmp/signet/session.jsonl",
  "runtimePath": "plugin"
}
```

`harness` and `sessionKey` are required. `transcript` (inline string) takes
precedence over `transcriptPath`; both fall back to the stored session
transcript from a prior `session-end` or `user-prompt-submit` call. Native
daemon file-backed transcript reads require `transcriptPath` to resolve under
the connector staging root `/tmp/signet`, point to a regular file, and fit
within the transcript size limit.

The endpoint skips silently when:
- The delta since the last extraction cursor is < 500 characters
- No transcript is available
- The session is bypassed

On success the extraction cursor advances so the next call only processes
new content.

**Response**

```json
{ "queued": true, "jobId": "uuid" }
```

`queued: true` means a summary job was enqueued; `jobId` identifies the
async job. The job extracts the delta and writes a temporal node scored
at 0.85 (below compaction summaries at 0.95, above chunks at 0.55). Checkpoint
jobs stay DB-native, they do not create canonical `--summary.md` session
artifacts.

```json
{ "skipped": true }
```

Returned when delta < 500 chars, no transcript is available, or the
session is bypassed.

### GET /api/hooks/synthesis/config

Return the current synthesis configuration (thresholds, model, schedule).

### POST /api/hooks/synthesis

Request a `MEMORY.md` synthesis run. Implementation-defined request body
and response from `handleSynthesisRequest`.

Current `MEMORY.md` generation is a deterministic projection, not a free-form
LLM rewrite:

- scored durable memories come from the memory database
- rolling session-ledger rows come from canonical artifact frontmatter in
  `memory_artifacts`
- temporal context comes from `session_summaries` DAG artifacts
- the response keeps the rendered markdown in `prompt` for backward
  compatibility, with `model: "projection"`
- `indexBlock` contains the exact `## Temporal Index` block already included in
  the rendered projection

The rendered file contains these required sections:

- `## Global Head (Tier 1)`
- `## Thread Heads (Tier 2)`
- `## Session Ledger (Last 30 Days)`
- `## Open Threads`
- `## Durable Notes & Constraints`
- `## Temporal Index`

Optional `agentId` / `sessionKey` inputs may be provided so synthesis resolves
the correct agent-scoped head.

### POST /api/hooks/synthesis/complete

Write a newly synthesized `MEMORY.md`. Backs up the existing file before
overwriting and records DB-backed head metadata used for same-agent
merge protection.

**Request body**

```json
{
  "content": "# Memory\n\n...",
  "agentId": "optional-agent-id",
  "sessionKey": "optional-session-key"
}
```

`content` is required.

If another writer currently holds the active `MEMORY.md` lease for the same
agent head, this route returns `409`.

**Response**

```json
{ "success": true }
```


## Sessions

The sessions API exposes active session state, including per-session bypass
toggles. When bypass is enabled for a session, all hook endpoints return
empty no-op responses with `bypassed: true` — but MCP tools (memory_search,
memory_store, etc.) continue to work normally.

### GET /api/sessions

List active sessions for the requesting agent with their bypass status.
The response merges live tracker claims with live cross-agent presence so
sessions do not disappear just because one surface has not claimed the
session yet. Results are scoped to the authenticated agent; for
cross-agent visibility use `GET /api/cross-agent/presence`.

**Response**

```json
{
  "sessions": [
    {
      "key": "session-uuid",
      "runtimePath": "plugin",
      "claimedAt": "2026-03-08T10:00:00.000Z",
      "expiresAt": "2026-03-08T14:00:00.000Z",
      "bypassed": false
    }
  ],
  "count": 1
}
```

### GET /api/sessions/:key

Get a single session's status by its session key.

Both raw keys (`abc123`) and prefixed keys (`session:abc123`) are accepted.

**Response**

```json
{
  "key": "session-uuid",
  "runtimePath": "plugin",
  "claimedAt": "2026-03-08T10:00:00.000Z",
  "expiresAt": "2026-03-08T14:00:00.000Z",
  "bypassed": false
}
```

Returns `404` if the session key is not found.

### GET /api/sessions/:key/transcript

Return the canonical cleaned transcript for a session. Results are scoped to
the authenticated agent; pass `agent_id` only when calling with an authorized
agent scope.

Both raw keys (`abc123`) and prefixed keys (`session:abc123`) are accepted.

**Response**

```json
{
  "sessionKey": "session-uuid",
  "agentId": "default",
  "content": "User: ...\nAssistant: ..."
}
```

Returns `404` if no transcript exists for that session and agent scope.

### POST /api/sessions/search

Search active or completed session transcripts. This route powers the
`session_search` MCP tool and is intended for sub-agents that need to inspect
the parent session without forcing a large token snapshot into every spawn.
Results are agent-scoped and require `recall` permission.

**Request body**

```json
{
  "query": "Juniper trunk ports",
  "sessionKey": "optional-specific-session",
  "currentSessionKey": "agent:nicholai:subagent:abc123",
  "agentId": "nicholai",
  "project": "/workspace/repo",
  "limit": 5
}
```

`query` is required. `limit` is clamped to `1..20`. If `sessionKey` is absent
and `currentSessionKey` encodes OpenClaw sub-agent lineage, Signet defaults the
search to the inferred parent session. Otherwise, Signet searches transcripts
in the requested agent and project scope while excluding `currentSessionKey`.

**Response**

```json
{
  "query": "Juniper trunk ports",
  "hits": [
    {
      "sessionKey": "agent:nicholai:main",
      "project": "/workspace/repo",
      "updatedAt": "2026-03-25T10:05:00.000Z",
      "excerpt": "keep the Juniper EX4300 VLAN audit focused on trunk ports",
      "rank": -1.2
    }
  ],
  "count": 1
}
```

### GET /api/sessions/summaries

List temporal summary nodes used for drill-down and `MEMORY.md` synthesis.
Results are agent-scoped.

**Response**

```json
{
  "summaries": [
    {
      "id": "sess-1",
      "kind": "session",
      "depth": 0,
      "source_type": "summary",
      "source_ref": "session-uuid",
      "meta_json": "{\"source\":\"summary-worker\"}"
    }
  ]
}
```

### POST /api/sessions/summaries/expand

Expand a temporal node by id. Returns lineage, linked memories, and transcript
context for `MEMORY.md` drill-down and LCM-style expansion. Expansion is
agent-scoped.

**Request body**

```json
{
  "id": "node-id",
  "includeTranscript": true,
  "transcriptCharLimit": 2000
}
```

**Response**

```json
{
  "node": {
    "id": "node-id",
    "kind": "session",
    "depth": 0,
    "sourceType": "summary"
  },
  "parents": [],
  "children": [],
  "linkedMemories": [],
  "transcript": {
    "sessionKey": "session-uuid",
    "excerpt": "..."
  }
}
```

### POST /api/sessions/:key/bypass

Toggle bypass for a session. When enabled, all hook endpoints for this session
return empty no-op responses with `bypassed: true`. MCP tools are not affected.
Both raw keys and `session:<uuid>` forms are accepted.

**Request body**

```json
{
  "enabled": true
}
```

`enabled` is required (boolean).

**Response**

```json
{
  "key": "session-uuid",
  "bypassed": true
}
```

Returns `404` if the session key is not found.
