---
title: "Memory API"
description: "Memory, embedding, recall, and similarity endpoints."
order: 14
section: "Reference"
---

# Memory API

Memory, embedding, recall, and similarity endpoints.

[Back to HTTP API overview](../API.md).

## Memories

The [[memory]] API is the primary interface for reading and writing agent
memory. All write operations respect the `mutationsFrozen` kill switch — if
enabled, writes return `503`. For a typed client wrapper, see the [[sdk]].

### GET /api/memories

List memories with basic stats. Simple pagination only; for filtered search
use `POST /api/memory/recall` or `GET /memory/search`.

Requires `recall` permission.

**Query parameters**

| Parameter | Type    | Default | Description                  |
|-----------|---------|---------|------------------------------|
| `limit`   | integer | 100     | Max records to return        |
| `offset`  | integer | 0       | Pagination offset            |

**Response**

```json
{
  "memories": [
    {
      "id": "uuid",
      "content": "User prefers dark mode",
      "created_at": "2026-02-21T10:00:00.000Z",
      "who": "claude-code",
      "importance": 0.8,
      "tags": "preference,ui",
      "source_type": "manual",
      "pinned": 0,
      "type": "preference"
    }
  ],
  "stats": {
    "total": 1247,
    "withEmbeddings": 1200,
    "critical": 12
  }
}
```

### POST /api/memory/remember

Create a new memory. Requires `remember` permission.

Content prefixes are parsed automatically:
- `critical: <content>` — sets `pinned=true`, `importance=1.0`
- `[tag1,tag2]: <content>` — sets tags

Body-level fields override prefix-parsed values.

**Request body**

```json
{
  "content": "User prefers vim keybindings",
  "who": "claude-code",
  "project": "my-project",
  "importance": 0.9,
  "tags": "preference,editor",
  "pinned": false,
  "sourceType": "manual",
  "sourceId": "optional-external-id",
  "sourcePath": "/absolute/or/original/source.md",
  "runtimePath": "memory/MEMORY.md",
  "idempotencyKey": "stable-import-key",
  "createdAt": "2026-02-21T10:00:00.000Z",
  "occurredAt": "2026-02-20T15:00:00.000Z",
  "observedAt": "2026-02-21T09:55:00.000Z",
  "sourceCreatedAt": "2026-02-20T15:05:00.000Z",
  "validFrom": "2026-02-20T00:00:00.000Z",
  "validUntil": "2026-03-01T00:00:00.000Z",
  "agentId": "alice",
  "visibility": "global"
}
```

Only `content` is required. Multi-agent fields:

| Field        | Description |
|--------------|-------------|
| `agentId`    | Agent that owns this memory. Defaults to `"default"`. |
| `visibility` | `"global"` (any permitted agent can read), `"private"` (owner only). Defaults to `"global"`. |

`createdAt` is optional and must be a valid ISO timestamp. Use it when the
memory is sourced from an older conversation or imported artifact so structured
currentness and supersession can compare facts by source time instead of ingest
time.

`occurredAt`, `observedAt`, `sourceCreatedAt`, and `validFrom`/`validUntil`
attach explicit temporal edges to the memory without duplicating the memory
content. Use them when the memory is saved later than the event, observation,
source creation time, or validity window it describes. Each value must be a
valid ISO timestamp; `validUntil` must be after `validFrom` when both are set.

Row-level provenance fields are optional: `sourcePath`/`source_path` stores the
original source path, `runtimePath`/`runtime_path` stores the runtime-relative
path, and `idempotencyKey`/`idempotency_key` stores a stable import key. When an
`idempotencyKey` is supplied, remember checks it before content-hash dedupe;
retries with the same key return the existing row instead of inserting a
duplicate within the same `agentId`, `visibility`, and `scope` tuple. Importers
may also supply the snake_case names inside a `metadata` object for
compatibility.

Structured callers may also pass `structured.entities`, `structured.aspects`,
and `structured.hints`. Aspect attributes are persisted directly under
`entity_attributes`. Include `groupKey` to create a navigable subgroup inside an
aspect, and include `claimKey` when the claim can be updated over time.
Supersession only runs within the same entity/aspect/groupKey/claimKey, so
unrelated events under one aspect do not replace each other. Newer conflicting
attributes on the same grouped claim can mark older attributes as `superseded`
with `superseded_by` pointing at the replacement.

When `structured` is omitted, the default remember path is deliberately
conservative. It embeds and stores the memory, then links mentions to existing
entities for the same `agentId` when they are mechanically recognizable. It does
not create new entities, aspects, attributes, dependencies, or supersession
claims from raw text. Use a structured payload when the caller intends to author
or update the knowledge graph.

**Response**

```json
{
  "id": "uuid",
  "type": "preference",
  "tags": "preference,editor",
  "pinned": false,
  "importance": 0.9,
  "content": "User prefers vim keybindings",
  "embedded": true,
  "deduped": false
}
```

If an identical memory (by `sourceId`, `idempotencyKey`, or content hash) already
exists in the relevant scope, `deduped: true` is returned with the existing
record — no duplicate is created.

### POST /api/memory/save

Alias for `POST /api/memory/remember`. Accepts the same request body and
returns the same response. Requires `remember` permission.

### POST /api/memory/codex-native-note

Write an explicit Codex native memory note under the local Codex memory
extension path. Requires `remember` permission and respects the
`mutationsFrozen` kill switch.

**Request body**

```json
{
  "content": "Small scoped note to preserve",
  "title": "Optional title",
  "tags": "codex,note"
}
```

`content` is required and capped at 8000 characters. `title` and `tags` are
optional strings.

**Response**

```json
{
  "ok": true,
  "path": "/home/user/.codex/memories/extensions/ad_hoc/notes/..."
}
```

### POST /api/hook/remember

Alias for `POST /api/memory/remember`. Used by Claude Code skill
compatibility. Requires `remember` permission.

### GET /api/memory/:id

Get a single memory by ID. Returns deleted memories only if the query
explicitly requests them; by default, soft-deleted records return `404`.
Direct reads are filtered through the same resolved agent read policy used by
recall/search. Pass `agentId`/`agent_id`, `x-signet-agent-id`, or an
`x-signet-session-key` that resolves to an agent when reading non-default
agent memories; cross-agent or private memories outside that read scope return
`404` without provenance fields.

Requires `recall` permission.

**Response**

```json
{
  "id": "uuid",
  "content": "User prefers vim keybindings",
  "type": "preference",
  "importance": 0.9,
  "tags": "preference,editor",
  "pinned": 0,
  "who": "claude-code",
  "source_id": "optional-external-id",
  "source_type": "manual",
  "source_path": "/absolute/or/original/source.md",
  "runtime_path": "memory/MEMORY.md",
  "idempotency_key": "stable-import-key",
  "sourcePath": "/absolute/or/original/source.md",
  "runtimePath": "memory/MEMORY.md",
  "idempotencyKey": "stable-import-key",
  "project": null,
  "session_id": null,
  "confidence": null,
  "access_count": 3,
  "last_accessed": "2026-02-21T11:00:00.000Z",
  "is_deleted": 0,
  "deleted_at": null,
  "extraction_status": "done",
  "embedding_model": "nomic-embed-text",
  "version": 2,
  "created_at": "2026-02-21T10:00:00.000Z",
  "updated_at": "2026-02-21T10:30:00.000Z",
  "updated_by": "operator"
}
```

`sourcePath`, `runtimePath`, and `idempotencyKey` are camelCase aliases for
`source_path`, `runtime_path`, and `idempotency_key` so import provenance written
through `POST /api/memory/remember` is visible on direct reads.

### GET /api/memory/:id/history

Full audit history for a memory in chronological order. Requires `recall`
permission.

**Query parameters**

| Parameter | Type    | Default | Description              |
|-----------|---------|---------|--------------------------|
| `limit`   | integer | 200     | Max events (cap: 1000)   |

**Response**

```json
{
  "memoryId": "uuid",
  "count": 3,
  "history": [
    {
      "id": "hist-uuid",
      "event": "created",
      "oldContent": null,
      "newContent": "User prefers vim keybindings",
      "changedBy": "claude-code",
      "actorType": "operator",
      "reason": null,
      "metadata": null,
      "createdAt": "2026-02-21T10:00:00.000Z",
      "sessionId": null,
      "requestId": null
    }
  ]
}
```

### POST /api/memory/:id/recover

Restore a soft-deleted memory. The recovery window is 30 days from deletion.
Requires `recover` permission.

**Request body**

```json
{
  "reason": "Accidentally deleted",
  "if_version": 3
}
```

`reason` is required. `if_version` is optional — if provided, the operation
is rejected with `409` if the current version does not match (optimistic
concurrency).

**Response**

```json
{
  "id": "uuid",
  "status": "recovered",
  "currentVersion": 3,
  "newVersion": 4,
  "retentionDays": 30
}
```

Possible `status` values and their HTTP codes:

| Status               | Code | Meaning                                 |
|----------------------|------|-----------------------------------------|
| `recovered`          | 200  | Success                                 |
| `not_found`          | 404  | Memory does not exist                   |
| `not_deleted`        | 409  | Memory is not deleted                   |
| `retention_expired`  | 409  | Outside 30-day recovery window          |
| `version_conflict`   | 409  | `if_version` mismatch                   |

### PATCH /api/memory/:id

Update a memory's fields. At least one of `content`, `type`, `tags`,
`importance`, or `pinned` must be provided. Requires `modify` permission.
Rate-limited to 60/min.

Scoped tokens in non-local mode have their project scope checked against the
target memory's `project` field before the mutation is applied.

**Request body**

```json
{
  "content": "Updated content",
  "type": "fact",
  "tags": ["updated", "fact"],
  "importance": 0.7,
  "pinned": false,
  "reason": "Correcting outdated information",
  "if_version": 2,
  "changed_by": "operator"
}
```

`reason` is required. `if_version` is optional optimistic concurrency guard.
`tags` may be a string (comma-separated), an array of strings, or `null` to
clear tags.

**Response**

```json
{
  "id": "uuid",
  "status": "updated",
  "currentVersion": 2,
  "newVersion": 3,
  "contentChanged": true,
  "embedded": true
}
```

Possible `status` values and their HTTP codes:

| Status                  | Code | Meaning                                  |
|-------------------------|------|------------------------------------------|
| `updated`               | 200  | Success                                  |
| `no_changes`            | 200  | Patch produced no diff                   |
| `not_found`             | 404  | Memory does not exist                    |
| `deleted`               | 409  | Cannot modify a deleted memory           |
| `version_conflict`      | 409  | `if_version` mismatch                    |
| `duplicate_content_hash`| 409  | New content matches an existing memory   |

### DELETE /api/memory/:id

Soft-delete a memory. Deleted memories can be recovered within 30 days.
Requires `forget` permission. Rate-limited to 30/min.

Scoped tokens have their project scope checked before the deletion. Pinned
memories require `force: true`. Autonomous agents (pipeline/agent actor type)
cannot force-delete pinned memories.

**Request body** (or query parameters)

```json
{
  "reason": "No longer relevant",
  "force": false,
  "if_version": 3
}
```

`reason` is required, either in the body or as `?reason=...` query parameter.
`force` defaults to `false`. `if_version` is optional.

**Response**

```json
{
  "id": "uuid",
  "status": "deleted",
  "currentVersion": 3,
  "newVersion": 4
}
```

Possible `status` values and their HTTP codes:

| Status                    | Code | Meaning                                    |
|---------------------------|------|--------------------------------------------|
| `deleted`                 | 200  | Success                                    |
| `not_found`               | 404  | Memory does not exist                      |
| `already_deleted`         | 409  | Memory is already deleted                  |
| `version_conflict`        | 409  | `if_version` mismatch                      |
| `pinned_requires_force`   | 409  | Pinned memory requires `force: true`       |
| `autonomous_force_denied` | 403  | Autonomous agents cannot force-delete      |

### POST /api/memory/forget

Batch forget with preview/execute workflow. Requires `forget` permission.
Rate-limited to 5/min (batch forget limiter).

Requires at least one of: `query`, `ids`, or a filter field (`type`, `tags`,
`who`, `source_type`, `since`, `until`). The batch size cap is 200.

For large operations (>25 candidates), the `execute` mode requires a
`confirm_token` obtained from a prior `preview` call.

**Request body — preview mode**

```json
{
  "mode": "preview",
  "query": "outdated preferences",
  "type": "preference",
  "tags": "old",
  "who": "claude-code",
  "source_type": "manual",
  "since": "2025-01-01T00:00:00Z",
  "until": "2026-01-01T00:00:00Z",
  "limit": 20
}
```

Or target specific IDs:

```json
{
  "mode": "preview",
  "ids": ["uuid1", "uuid2"]
}
```

**Preview response**

```json
{
  "mode": "preview",
  "count": 3,
  "requiresConfirm": false,
  "confirmToken": "abc123...",
  "candidates": [
    { "id": "uuid1", "score": 0.85, "pinned": false, "version": 2 }
  ]
}
```

**Request body — execute mode**

```json
{
  "mode": "execute",
  "query": "outdated preferences",
  "reason": "Cleaning up stale data",
  "force": false,
  "confirm_token": "abc123..."
}
```

`reason` is required in execute mode. `confirm_token` is required when
`requiresConfirm` was `true` in the preview.

**Execute response**

```json
{
  "mode": "execute",
  "requested": 3,
  "deleted": 3,
  "results": [
    { "id": "uuid1", "status": "deleted", "currentVersion": 2, "newVersion": 3 }
  ]
}
```

### POST /api/memory/modify

Batch update multiple memories in a single request. Requires `modify`
permission. Rate-limited to 60/min. Maximum 200 patches per request.

**Request body**

```json
{
  "reason": "Bulk correction",
  "changed_by": "operator",
  "patches": [
    {
      "id": "uuid1",
      "content": "Updated content",
      "reason": "Per-patch reason override",
      "if_version": 2
    },
    {
      "id": "uuid2",
      "tags": ["updated"],
      "importance": 0.6
    }
  ]
}
```

Top-level `reason` and `changed_by` are defaults applied to all patches. Each
patch can override `reason` individually. `if_version` per patch is optional.

**Response**

```json
{
  "total": 2,
  "updated": 2,
  "results": [
    {
      "id": "uuid1",
      "status": "updated",
      "currentVersion": 2,
      "newVersion": 3,
      "contentChanged": true,
      "embedded": true
    },
    {
      "id": "uuid2",
      "status": "updated",
      "currentVersion": 1,
      "newVersion": 2,
      "contentChanged": false
    }
  ]
}
```

Individual patch items that fail validation return `status: "invalid_request"`
with an `error` field. The batch continues — partial success is possible.

### POST /api/memory/recall

Hybrid recall combining FTS5, prospective hints, vector similarity,
structured path evidence, graph traversal, and optional reranking. The daemon
authorizes candidate IDs before any content-bearing rerank, summary,
dampening, expansion, or access-tracking stage runs. Requires `recall`
permission. For the full execution model, see [Hybrid Recall](../MEMORY.md#hybrid-recall).

**Request body**

```json
{
  "query": "user preferences for editor",
  "limit": 10,
  "type": "preference",
  "tags": "editor,ui",
  "who": "claude-code",
  "pinned": false,
  "importance_min": 0.5,
  "since": "2026-01-01T00:00:00Z",
  "time": {
    "start": "2026-05-13T00:00:00.000Z",
    "end": "2026-05-14T00:00:00.000Z",
    "facets": ["session", "occurred", "source", "captured"],
    "mode": "auto"
  },
  "aggregate": false,
  "aggregateBudget": "small",
  "saveAggregate": true,
  "agentId": "alice",
  "sessionKey": "session-uuid",
  "includeRecalled": false
}
```

Only `query` is required.

Exact date phrases in `query`, such as `2026/05/13`, `2026-05-13`, or
`May 13 2026`, activate temporal recall automatically. A date-only query
returns a timeline assembled from existing session, source, captured-memory,
and explicit temporal-edge metadata. A date plus topic uses the date as a
filter and the remaining words as the content query. Callers can also pass a
`time` object directly. Supported temporal facets are `session`, `source`,
`captured`, `observed`, `occurred`, and `valid`; `mode` may be `auto`,
`timeline`, or `filter`.

When `sessionKey` is present, recall uses a daemon-owned context ledger keyed by
`(sessionKey, agentId, contextEpoch)`. Rows returned once in the current epoch
are suppressed by default across direct recall, hook recall, and automatic
injection paths. Sessionless recall is unchanged. Set `includeRecalled: true`
to return repeats; repeated rows are annotated with
`already_recalled: true`, and newly returned rows are still recorded.

**Response**

```json
{
  "results": [
    {
      "id": "uuid",
      "content": "User prefers vim keybindings",
      "score": 0.92,
      "source": "hybrid",
      "type": "preference",
      "tags": "preference,editor",
      "pinned": false,
      "importance": 0.9,
      "who": "claude-code",
      "project": null,
      "created_at": "2026-02-21T10:00:00.000Z",
      "temporal_facet": "occurred",
      "temporal_start_at": "2026-02-20T15:00:00.000Z",
      "temporal_end_at": "2026-02-20T15:00:00.000Z",
      "subject_type": "memory",
      "subject_id": "uuid",
      "supplementary": false,
      "already_recalled": false
    }
  ],
  "query": "user preferences for editor",
  "method": "hybrid",
  "meta": {
    "totalReturned": 1,
    "hasSupplementary": false,
    "noHits": false,
    "timings": {
      "totalMs": 14.25,
      "stages": [
        { "name": "memory_fts", "durationMs": 1.12 },
        { "name": "query_embedding_wait", "durationMs": 8.4 },
        { "name": "final_rank", "durationMs": 0.08 }
      ]
    },
    "dedupe": {
      "enabled": true,
      "contextEpoch": 0,
      "suppressed": 0,
      "repeatedReturned": 0
    },
    "temporal": {
      "mode": "filter",
      "source": "query",
      "originalQuery": "2026/05/13 editor",
      "contentQuery": "editor",
      "start": "2026-05-13T06:00:00.000Z",
      "end": "2026-05-14T06:00:00.000Z",
      "facets": ["session", "source", "occurred", "observed", "valid", "captured"]
    }
  }
}
```

Common `source` values include `hybrid`, `vector`, `keyword`, `hint`, `sec`,
`structured`, `traversal`, `ka_traversal`, `source_obsidian`,
`native_memory`, `constructed`, `graph`, and `llm_summary`.
`method` on the response reflects whether vector search was available for
this call.

`meta.totalReturned` reflects the number of returned rows. `meta.hasSupplementary`
is `true` when the response includes supporting context such as an LLM summary
card or linked rationale context. `meta.noHits` is `true` when recall completed
normally but found no matching results.
`meta.timings`, when present, reports daemon-side stage timings in
milliseconds. Aggregate recall fills the same field with aggregate-specific
stages such as `aggregate_planning`, `aggregate_followup_recalls`, and
`aggregate_synthesis`.
`meta.temporal`, when present, describes the resolved temporal window, facets,
and content query used by automatic date parsing or an explicit `time` request.
When session dedupe is enabled, `meta.dedupe.suppressed` counts rows omitted
because they were already recalled in the current epoch, and
`meta.dedupe.repeatedReturned` counts repeated rows returned only because the
caller set `includeRecalled: true`.

Set `aggregate: true` to opt into bounded aggregate recall. The daemon first
runs normal hybrid recall, optionally asks the inference router for follow-up
recall queries, synthesizes one concise answer from unique evidence rows, and
returns only that aggregate row. Normal recall ranking is unchanged when
`aggregate` is omitted or `false`.

Aggregate budgets cap total recall queries: `small` = 3, `medium` = 5,
`large` = 8. `saveAggregate` defaults to `true`; saved aggregate answers are
normal memories with `source_type: "aggregate-recall"` and tags
`aggregate,recall`. Saving requires `remember` permission; recall-only callers
can still use aggregate mode by sending `saveAggregate: false`. Repeating the
same agent/query/project/budget/source-memory set returns the same saved memory
through the aggregate idempotency key.

When aggregate synthesis cannot complete, the response is a no-hit recall
shape with `results: []` and `aggregate.stoppedReason` set to `no_evidence`,
`router_unavailable`, or `synthesis_failed`.

When the routed inference provider reports token or billing metadata,
`aggregate.usage` includes planning/synthesis totals plus per-stage target,
attempt, fallback, token, duration, and cost fields. Missing provider usage is
reported as `null` rather than estimated.

Successful aggregate responses include aggregate metadata:

```json
{
  "aggregate": {
    "savedMemoryId": "uuid",
    "saved": true,
    "deduped": false,
    "budget": "small",
    "queries": ["user preferences for editor"],
    "sourceMemoryIds": ["source-memory-id"],
    "stoppedReason": "complete",
    "usage": {
      "inputTokens": 534,
      "outputTokens": 84,
      "cacheReadTokens": 128,
      "cacheCreationTokens": null,
      "totalCost": 0.00018,
      "totalDurationMs": 812,
      "stages": [
        {
          "name": "planning",
          "targetRef": "recall-openrouter-mercury/default",
          "attemptCount": 1,
          "fallbackCount": 0,
          "inputTokens": 142,
          "outputTokens": 28,
          "cacheReadTokens": 64,
          "cacheCreationTokens": null,
          "totalCost": 0.00005,
          "totalDurationMs": 310
        }
      ]
    }
  }
}
```

When `memory.pipelineV2.reranker.useExtractionModel` is enabled, an
additional synthesized summary card may be prepended to results. This card
has `source: "llm_summary"`, `supplementary: true`, and an id of the form
`summary:<sha1-12>`. It is only injected when `limit >= 2` so callers
always receive at least one real memory to verify the summary against. The
card is not stored in the database and does not affect access-time tracking.

**Operational note**: `useExtractionModel` moves recall onto a live LLM
call path. When auth mode is not `local`, the daemon enforces a dedicated
rate-limit bucket — `auth.rateLimits.recallLlm` (default: 60 req/min per
token). Configure it in `agent.yaml` alongside the other operation limits:

```yaml
auth:
  mode: team
  rateLimits:
    recallLlm:
      windowMs: 60000
      max: 30
```

No additional permission level is required beyond `recall`.

### GET /api/memory/search

GET-compatible alias for `POST /api/memory/recall`. Forwards query parameters
to the recall endpoint. Requires `recall` permission.

**Query parameters**

| Parameter      | Description                   |
|----------------|-------------------------------|
| `q`            | Search query (required)       |
| `limit`        | Max results (default: 10)     |
| `type`         | Filter by memory type         |
| `tags`         | Filter by tag (comma-sep)     |
| `who`          | Filter by author              |
| `pinned`       | `1` or `true` to filter       |
| `importance_min` | Minimum importance float    |
| `since`        | ISO timestamp lower bound     |
| `until`        | ISO timestamp upper bound     |
| `sessionKey` / `session_key` | Session key for context dedupe |
| `includeRecalled` / `include_recalled` | `1` or `true` to return repeats |

**Response** — same shape as `POST /api/memory/recall`.

### GET /memory/search

Legacy keyword search endpoint. Also supports filter-only queries without a
search term. Requires `recall` permission.

**Query parameters**

| Parameter       | Description                                  |
|-----------------|----------------------------------------------|
| `q`             | FTS5 query string (optional)                 |
| `distinct`      | `who` — returns distinct authors instead     |
| `limit`         | Max results (default: 20 with query, 50 without) |
| `type`          | Filter by type                               |
| `tags`          | Comma-separated tag filter                   |
| `who`           | Filter by author                             |
| `pinned`        | `1` or `true`                                |
| `importance_min`| Float minimum                                |
| `since`         | ISO timestamp                                |

When `distinct=who` is passed, all other parameters are ignored and the
response is `{ "values": ["alice", "bob"] }`.

Otherwise: `{ "results": [...] }` where each result includes `id`, `content`,
`created_at`, `who`, `importance`, `tags`, `type`, `pinned`, and optionally
`score` (BM25 or recency-weighted).

### GET /memory/similar

Vector similarity search anchored to an existing memory's embedding. Returns
memories most similar to the given record. Requires `recall` permission.

**Query parameters**

| Parameter | Description                              |
|-----------|------------------------------------------|
| `id`      | Memory ID to use as the anchor (required)|
| `k`       | Number of results (default: 10)          |
| `type`    | Optional type filter                     |

**Response**

```json
{
  "results": [
    {
      "id": "uuid",
      "content": "...",
      "type": "preference",
      "tags": [],
      "score": 0.87,
      "confidence": null,
      "created_at": "2026-02-21T10:00:00.000Z"
    }
  ]
}
```

Returns `404` if the anchor memory has no stored embedding.


## Embeddings

### GET /api/embeddings

Export all stored embeddings with their parent memory metadata. Falls back to
a legacy Python export script if the `embeddings` table does not exist.
Requires `recall` permission.

**Query parameters**

| Parameter | Type    | Default | Range        | Description              |
|-----------|---------|---------|--------------|--------------------------|
| `limit`   | integer | 600     | 50–5000      | Page size                |
| `offset`  | integer | 0       | 0–100000     | Page offset              |
| `vectors` | boolean | false   | —            | Include raw float arrays |

**Response**

```json
{
  "embeddings": [
    {
      "id": "uuid",
      "content": "...",
      "text": "...",
      "who": "claude-code",
      "importance": 0.8,
      "type": "preference",
      "tags": ["preference"],
      "sourceType": "memory",
      "sourceId": "uuid",
      "createdAt": "2026-02-21T10:00:00.000Z",
      "vector": [0.1, 0.2, ...]
    }
  ],
  "count": 50,
  "total": 1200,
  "limit": 600,
  "offset": 0,
  "hasMore": true
}
```

`vector` is only present when `vectors=true` is set.

### GET /api/embeddings/status

Check the configured embedding provider's availability. Results are cached for
30 seconds. Requires `recall` permission.

**Response**

```json
{
  "provider": "ollama",
  "model": "nomic-embed-text",
  "available": true,
  "dimensions": 768,
  "base_url": "http://localhost:11434",
  "checkedAt": "2026-02-21T10:00:00.000Z"
}
```

On failure, `available` is `false` and `error` contains a description.

### GET /api/embeddings/health

Returns embedding health metrics including coverage and staleness.

**Response** — embedding health object with coverage percentage, stale
count, and provider status.

### GET /api/embeddings/projection

Returns a server-computed UMAP projection of all stored embeddings.
Results are cached in the `umap_cache` table; cache is invalidated when
the embedding count changes. Requires `recall` permission.

**Query parameters**

| Parameter    | Type    | Default | Description                    |
|--------------|---------|---------|--------------------------------|
| `dimensions` | integer | 2       | Output dimensions: `2` or `3`  |

If the projection is still computing, the endpoint returns `202 Accepted`
with `status: "computing"`. Poll again when ready.

**Response (computed)**

```json
{
  "status": "cached",
  "dimensions": 2,
  "count": 847,
  "total": 847,
  "nodes": [
    {
      "id": "uuid",
      "x": 42.1,
      "y": -18.7,
      "content": "User prefers vim keybindings",
      "who": "claude-code",
      "importance": 0.8,
      "type": "preference",
      "tags": ["preference"],
      "pinned": false,
      "sourceType": "memory",
      "sourceId": "uuid",
      "createdAt": "2026-02-21T10:00:00.000Z"
    }
  ],
  "edges": [[0, 3], [0, 7]],
  "cachedAt": "2026-02-21T10:05:00.000Z"
}
```

**Response (computing)**

```json
{ "status": "computing", "dimensions": 2, "count": 0, "total": 847 }
```
