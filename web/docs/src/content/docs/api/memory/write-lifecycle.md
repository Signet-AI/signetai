---
title: "Memory write lifecycle"
description: "Create, read, revise, recover, and forget memories through the HTTP API."
---

Memory, embedding, recall, and similarity endpoints.

[Back to HTTP API overview](/api/).


The [Memory](/memory/) API is the primary interface for reading and writing agent
memory. All write operations respect the `mutationsFrozen` kill switch — if
enabled, writes return `503`. For a typed client wrapper, see the [Sdk](/sdk/).

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
  "reviewAfter": "2026-08-03T00:00:00.000Z",
  "supersedes": "existing-memory-id",
  "reason": "newer evidence replaces the old claim",
  "agentId": "alice",
  "visibility": "global"
}
```

Only `content` is required. Multi-agent fields:

| Field        | Description |
|--------------|-------------|
| `agentId`    | Agent that owns this memory. Defaults to `"default"`. |
| `visibility` | `"global"` (any permitted agent can read), `"private"` (owner only). Defaults to `"global"`. |

First-seen named `agentId` values are registered in the `agents` table with
`read_policy` set to `shared`; existing agent policy rows are preserved.

`createdAt` is optional and must be a valid ISO timestamp. Use it when the
memory is sourced from an older conversation or imported artifact so structured
currentness and supersession can compare facts by source time instead of ingest
time.

`occurredAt`, `observedAt`, `sourceCreatedAt`, and `validFrom`/`validUntil`
attach explicit temporal edges to the memory without duplicating the memory
content. Use them when the memory is saved later than the event, observation,
source creation time, or validity window it describes. Each value must be a
valid ISO timestamp; `validUntil` must be after `validFrom` when both are set.

`reviewAfter` is an optional ISO timestamp for a future temporal claim. Dreaming
uses it to surface the memory for review after the deadline instead of assuming
that the planned event occurred.

`supersedes` is an optional memory id. When set, the named memory is marked
`superseded_by` = the new id in the same transaction (atomic lineage, no
orphans). The new row becomes the head of a drillable chain; `reason` is
recorded on the superseded row. A missing or cross-scope supersedes target
fails the whole write. Chain history is readable from any row via
`GET /api/memory/:id/lineage`, which walks `superseded_by` links newest-first.

Row-level provenance fields are optional: `sourcePath`/`source_path` stores the
original source path, `runtimePath`/`runtime_path` stores the runtime-relative
path, and `idempotencyKey`/`idempotency_key` stores a stable import key. When an
`idempotencyKey` is supplied, remember checks it before content-hash dedupe;
retries with the same key return the existing row instead of inserting a
duplicate within the same `agentId`, `visibility`, and `scope` tuple. Importers
may also supply the snake_case names inside a `metadata` object for
compatibility.

Structured callers may also pass `structured.entities`, `structured.aspects`,
and `structured.hints`. As of the episodic-evidence cutover, a `structured`
payload is **retained as immutable episodic evidence** alongside the memory
content but is **no longer applied directly to the knowledge graph** from the
remember endpoint. The response includes `structured: true` and
`structured_applied: false` to signal this explicitly. `structured.hints` are
still written as prospective recall aids for the saved evidence. Only Dreaming
derives semantic state (entities, aspects, attributes, links) from episodic
evidence through the audited ontology control plane.

All remember saves (plain, chunked, or structured) are immutable **episodic
evidence** (`memory_kind = 'episodic'`). They are immediately retrievable via
recall, search, list, and `GET /api/memory/:id`, and are selectable by Dreaming
as evidence through the shared episodic-sources selector. The remember endpoint
no longer performs any direct semantic side effects: it does not persist
structured graph state, does not inline-link entities, and does not enqueue
legacy extraction jobs. Extraction status is `none` — Dreaming owns semantic
processing.

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
  "entities_linked": 0,
  "hints_written": 0,
  "structured": false,
  "structured_applied": false,
  "deduped": false
}
```

`entities_linked` is always `0` for remember saves (no direct graph writes).
`structured_applied` is `false` even when a `structured` payload is supplied,
signaling that it was retained as episodic evidence but not applied to the
graph. If a structured payload was supplied, `structured` is `true`.

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

### GET /api/memory/:id/lineage

Supersession chain for a memory, newest first. Requires `recall` permission.
Walks `superseded_by` links from any row in the chain to the head, so drilling
from an old version surfaces the full v3 → v2 → v1 history.

**Query parameters**

| Parameter | Type    | Default | Description              |
|-----------|---------|---------|--------------------------|
| `limit`   | integer | 50      | Max chain rows (cap: 500) |

**Response**

```json
{
  "memoryId": "old-uuid",
  "count": 3,
  "lineage": [
    { "id": "newest-uuid", "content": "newest claim", "type": "fact", "importance": 0.9, "version": 3, "createdAt": "...", "updatedAt": "...", "supersededBy": null, "supersededAt": null, "supersededReason": null },
    { "id": "middle-uuid", "content": "middle claim", "type": "fact", "importance": 0.8, "version": 2, "createdAt": "...", "updatedAt": "...", "supersededBy": "newest-uuid", "supersededAt": "...", "supersededReason": "newer evidence" },
    { "id": "old-uuid", "content": "original claim", "type": "fact", "importance": 0.7, "version": 1, "createdAt": "...", "updatedAt": "...", "supersededBy": "middle-uuid", "supersededAt": "...", "supersededReason": "newer evidence" }
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

Update a memory's metadata fields. At least one of `content`, `type`, `tags`,
`importance`, or `pinned` must be provided. Requires `modify` permission.
Rate-limited to 60/min.

Scoped tokens in non-local mode have their project scope checked against the
target memory's `project` field before the mutation is applied.

**Episodic evidence immutability:** memories saved via remember (`memory_kind =
'episodic'`) are immutable evidence. `content` and `type` cannot be changed on
an episodic memory — attempts return `episodic_content_immutable` (409).
Metadata fields (`tags`, `importance`, `pinned`) remain editable so curators can
re-rank or re-label evidence without altering the originally recorded content.
To correct episodic evidence, save a new memory and optionally supersede the old
one.

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

| Status                       | Code | Meaning                                  |
|------------------------------|------|------------------------------------------|
| `updated`                    | 200  | Success                                  |
| `no_changes`                 | 200  | Patch produced no diff                   |
| `not_found`                  | 404  | Memory does not exist                    |
| `deleted`                    | 409  | Cannot modify a deleted memory           |
| `version_conflict`           | 409  | `if_version` mismatch                    |
| `duplicate_content_hash`     | 409  | New content matches an existing memory   |
| `episodic_content_immutable` | 409  | Episodic evidence content/type protected |

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
