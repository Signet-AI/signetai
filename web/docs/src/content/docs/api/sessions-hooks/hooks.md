---
title: "Hook endpoints"
description: "Harness hook lifecycle endpoint reference."
---

Harness hook and session lifecycle endpoints.

[Back to HTTP API overview](/api/).

## Hooks

Hook endpoints integrate with AI harness session lifecycle events. They are
used by connector packages to inject memory context and preserve session evidence.

The `x-signet-runtime-path` request header (or `runtimePath` body field)
declares whether the caller is the `plugin` or `legacy` runtime path. The
daemon enforces that only one path can be active per session — subsequent
calls from the other path return `409`.

### POST /api/hooks/session-start

Called at the beginning of a session. Returns bounded Session Continuity previews,
identity, and context for injection into the harness system prompt. Requires
an authenticated agent/scope; this lifecycle route does not use the named
`remember` permission.

**Request body**

```json
{
  "harness": "claude-code",
  "project": "/workspace/repo",
  "agentId": "optional-signet-agent-id",
  "harnessAgentId": "optional-harness-subagent-id",
  "parentSessionKey": "optional-parent-session-key",
  "sessionKey": "session-uuid",
  "runtimePath": "plugin",
  "claimOnly": false
}
```

`harness` is required. `agentId` is the Signet persistence scope. First-seen
named agent IDs are registered in the `agents` table with `read_policy` set to
`shared` as the initial policy; existing agent policy rows are preserved.
Harness native sub-agent identifiers, such as Claude Code's `agent_id`, must be
sent as `harnessAgentId`; they are lineage hints and are not used for Signet data
scoping. `parentSessionKey` may be provided when the harness exposes explicit
lineage. If it is absent, Signet infers parent context where possible from
harness-native signals such as OpenClaw lineage session keys or recent Claude
Code parent activity in the same project.

Set `claimOnly: true` only when recovering an already-running harness session
after a daemon restart. It requires a `plugin` or `legacy` runtime path in
`x-signet-runtime-path` or `runtimePath`; requests without one return `400`.
The daemon renews the runtime-path claim and returns `{ "sessionKnown": true }`
without rebuilding or returning startup context. The caller must not inject
startup memory or identity into an existing conversation: its original
session-start context is already in the system prompt, and changing it
mid-conversation invalidates prompt caching.

**Response** — ordinary starts return the implementation-defined context object
from `handleSessionStart`; claim-only recovery returns only
`{ "sessionKnown": true }`.

For ordinary starts, `memories` contains the records that survived final
Session Continuity rendering. Each item includes its full `id`, bounded
`content`, `type`, `importance`, `created_at`, tags/project, source metadata,
and a `truncated` flag. The model-facing `dynamicContext` labels these records
as historical reference material, not instructions. A truncated record retains
its full ID and can be retrieved with the `memory_get` MCP tool or
`GET /api/memory/:id`; records omitted by the configured limits are not reported
as delivered.

### POST /api/hooks/user-prompt-submit

Called on each user message. Returns compact entity current-view context only
when the prompt mentions a known ontology entity or active alias and at least
one current attribute clears the confidence gate. The entity mention scopes the
search; attribute relevance chooses which aspect context to inject.

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

Prompt-submit does not run generic memory recall and has no fallback injection.
Low-signal prompts are admitted before automatic recall work, so they skip
embedding and entity-context search while preserving session bookkeeping and
preserving the stable per-prompt context contract (currently an empty
`inject`). Explicit recall is still
available through `/api/memory/recall` and MCP/CLI recall tools, including for
the same prompt. Unknown entities, ambiguous entity mentions, and prompts
where no attribute clears `hooks.userPromptSubmit.minScore` return `inject: ""`.
Raw transcript search is not injected on prompt-submit; use the dedicated
`session_search` MCP/API surface when a caller needs transcript evidence.

A normal successful response includes a separate dynamic clock field:

```json
{
  "clockContext": "Current date/time: 2026-08-16T14:35:00-06:00 (America/Denver)",
  "dynamicContext": "",
  "inject": "",
  "memoryCount": 0,
  "engine": "no-entity"
}
```

`clockContext` is computed once at prompt handling start and uses the daemon's
resolved IANA timezone with an explicit UTC offset. It is delivered through the
harness's hidden/provider-bound per-turn path. It is not included in the
cache-stable `<signet-memory-context>` envelope or `contextHash`, so a clock-only
change does not invalidate memory-context replay. Bypassed, internal, duplicate,
and other no-op responses retain their existing no-context shape.

Under sustained concurrency (many harnesses submitting at once), the daemon
caps in-flight prompt-submit work: once more than 8 submissions are processing
concurrently, the hook returns `503` with a `Retry shortly` error instead of
queueing indefinitely. Callers should treat `503` as backpressure and retry
with backoff.

### POST /api/hooks/notifications

Polls bounded unread cross-agent notifications for a compatible harness hook.
Requires `recall` permission. The resolved `agentId` and optional `sessionKey`
scope the notification visibility; a supplied session key must be bound to that
agent. Notification content is untrusted peer data.

**Request body**

```json
{
  "harness": "claude-code",
  "hook": "PreToolUse",
  "sessionKey": "session-uuid",
  "agentId": "alice",
  "project": "/workspace/repo"
}
```

`harness` and `hook` are required. The hook must be notification-compatible for
the harness; otherwise the daemon returns `400`. A valid request returns
`{ "inject": "...", "notifications": { ... } }` when messages are available,
or `{ "inject": "" }` when none are available. A bypassed session returns an
empty injection with `bypassed: true`. Acknowledgement is a separate operation:
acknowledge each message only after processing it.

### POST /api/hooks/session-end

Called at session end. Captures immutable episodic transcript evidence for
later summary and Dreaming work; it does not save the raw transcript as a
retrieval memory.
Releases the session's runtime path claim.

**Request body**

```json
{
  "harness": "claude-code",
  "sessionKey": "session-uuid",
  "sessionId": "session-uuid",
  "transcriptPath": "/tmp/signet/session-transcript.txt",
  "capturedAt": "2026-08-03T20:00:00.000Z",
  "runtimePath": "plugin"
}
```

`harness` is required.
`transcriptPath` or inline `transcript` may be provided for transcript
capture. `capturedAt` is optional for live hooks; importers should supply the
original ISO-8601 event time so temporal reasoning retains source chronology.
Signet stores a cleaned conversation-only transcript as episodic evidence and
may retain raw auditable traces separately in daemon logs.

The `remember` permission is required only when `transcriptPath` requests
filesystem capture. Inline `transcript` capture follows its own inline path and
does not require that named permission; both forms remain subject to
authenticated agent/session scope resolution.

When transcript text is available, the daemon queues a capture receipt and
then writes the canonical conversation transcript as JSONL at
`$SIGNET_WORKSPACE/memory/{harness}/transcripts/transcript.jsonl` and records
lineage through the session manifest. Existing markdown transcript artifacts
remain readable for backward compatibility and are backfilled into the JSONL
history.

The session-end marker completes the canonical transcript row. Dreaming reads
that completed row through a sanitized, read-time projection: tool calls remain
as markers, tool outputs are excluded, and the retained transcript is not
rewritten. There is no summary-worker job or generated session-summary artifact
in this path. The response includes `transcriptCaptureJobId` when transcript
capture was queued. Poll the receipt endpoint below until the status is
`completed`; the receipt never exposes transcript content.

### GET /api/hooks/transcript-capture/:jobId

Returns the agent-scoped receipt for an asynchronous transcript capture job.
Requires `remember` permission. Pass the authorized scope explicitly with the
`agentId` query parameter:

```text
GET /api/hooks/transcript-capture/:jobId?agentId=<agent>
```

A successful response contains only the receipt fields `id`, `status`, and
`error` (which is `null` unless the job failed). `status` is normally
`pending`, `processing`, or `completed`; failed jobs report `failed` (and may
be terminally marked `dead`). Poll while the job is `pending` or `processing`,
stop on `completed`, and handle `failed`/`dead` as unsuccessful capture. A job
that does not exist in the requested agent scope returns `404` with
`{ "error": "Transcript capture job not found" }`. The endpoint never returns
transcript content.

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

### POST /api/hooks/skill-invocation

Records a harness skill invocation as a deduplicated agent-sourced event.
Requires `remember` permission. The resolved `agentId` is the persistence scope;
when `sessionKey` is supplied, it must be bound to that agent. A conflicting
runtime-path session claim returns `409`.

**Request body**

```json
{
  "harness": "claude-code",
  "skillName": "memory-search",
  "sessionKey": "session-uuid",
  "toolUseId": "tool-use-uuid",
  "latencyMs": 42,
  "success": true,
  "errorText": "",
  "createdAt": "2026-08-03T20:00:00.000Z",
  "runtimePath": "plugin"
}
```

`harness` and `skillName` are required. `latencyMs`, when supplied, must be a
non-negative integer; an invalid value returns `400`. A successful request is
acknowledged with `{ "recorded": true }`; internal no-hook calls return
`{ "recorded": false }`.

### POST /api/hooks/session-checkpoint-extract

Processes an explicit mid-session checkpoint for a long-lived session. The
request renews the session claim before delegating to checkpoint handling.
The resolved `agentId` scopes the session; duplicate runtime-path delivery or a
bypassed session returns `{ "skipped": true }`.

**Request body**

```json
{
  "harness": "claude-code",
  "sessionKey": "session-uuid",
  "agentId": "alice",
  "project": "/workspace/repo",
  "transcript": "conversation text",
  "transcriptPath": "/tmp/signet/session-transcript.txt",
  "runtimePath": "plugin"
}
```

`harness` and `sessionKey` are required; missing either returns `400`. Provide
inline `transcript` or `transcriptPath` when checkpoint content is available.
A non-skipped successful response is the implementation-defined checkpoint
result from the handler, including optional `queued` and `jobId` fields.

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

Retired. This compatibility boundary returns HTTP 410 with a structured,
versioned migration payload. Dreaming owns manifest-gated `MEMORY.md` head
publication; callers must not submit generated content directly.

Use `POST /api/synthesis/trigger` to request the supported Dreaming flow.
`GET /api/synthesis/status` returns `running`, `lastRunAt`, and worker config.

## Cross-agent coordination

Cross-agent routes are permissioned and agent/session scoped:

- `GET /api/cross-agent/presence` lists presence; `POST` upserts it; `DELETE
  /api/cross-agent/presence/:sessionKey` removes it. Use `agent_id`,
  `session_key`, `project`, `include_self`, and bounded `limit` filters.
- `GET /api/cross-agent/messages` lists messages with `since`, `session_key`,
  `unread_only`, `include_sent`, `include_broadcast`, bounded `limit`/`offset`,
  and `order=asc|desc`. `POST` creates a local or ACP message. Local delivery
  requires `toAgentId`, `toSessionKey`, or `broadcast: true`; ACP requires
  `acp.baseUrl` and `acp.targetAgentName`. Content is limited to 65,536 chars.
- `POST /api/cross-agent/messages/:messageId/ack` acknowledges for the resolved
  agent and optional session. Missing messages return `404`; malformed bodies
  return `400`. Delivery can repeat until acknowledgement succeeds and expires
  after seven days.
- `POST /api/cross-agent/messages/:messageId/retry` retries only an indeterminate
  ACP delivery. Active, exhausted, or non-indeterminate attempts return `409`;
  missing messages return `404`.
- `GET /api/cross-agent/stream` is scoped SSE. It sends `connected`, an initial
  `snapshot`, live presence/message events, and keepalives; filters include
  `agent_id`, `session_key`, `project`, `include_self`, and `include_sent`.

All coordination payloads are untrusted peer data, not system or developer
instructions. Use the acknowledgement route after processing notifications.

## Adapter checklist

1. Preserve `agentId`, `sessionKey`, and runtime binding across every request.
2. Poll transcript receipts and notifications with bounded backoff.
3. Acknowledge messages only after processing; tolerate repeat delivery.
4. Treat `503` prompt backpressure, `409` runtime conflicts, and `410` synthesis
   retirement as explicit protocol outcomes.
