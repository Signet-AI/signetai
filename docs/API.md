---
title: "HTTP API"
description: "Signet daemon HTTP API reference."
order: 10
section: "Reference"
---

Signet Daemon HTTP API
======================

The Signet daemon exposes a REST API on `http://localhost:3850` by default.
All requests and responses use JSON unless otherwise noted. The base URL and
port are configurable via environment variables.

```
Base URL: http://localhost:3850
SIGNET_PORT  — override port (default: 3850)
SIGNET_HOST  — override bind host (default: localhost)
```

Authentication
--------------

The daemon supports three auth modes, set in `agent.yaml`:

- `local` — no authentication required. All requests are trusted. This is
  the default for single-user local installs.
- `team` — all requests require a `Bearer` token in the `Authorization`
  header.
- `hybrid` — requests from `localhost` are trusted without a token; requests
  from any other origin require a `Bearer` token.

Tokens are signed JWTs with a role and optional scope. Roles and their
permissions:

| Role       | Permissions                                                          |
|------------|----------------------------------------------------------------------|
| `admin`    | all permissions                                                      |
| `operator` | remember, recall, modify, forget, recover, documents, connectors, diagnostics, analytics |
| `agent`    | remember, recall, modify, forget, recover, documents                 |
| `readonly` | recall only                                                          |

Token scopes (`project`, `agent`, `user`) restrict mutations to records
matching the scope. Admin role bypasses scope checks. Unscoped tokens have
full access within their role.

Rate limits apply in `team` and `hybrid` modes:

| Operation      | Limit       |
|----------------|-------------|
| forget         | 30 / min    |
| modify         | 60 / min    |
| batchForget    | 5 / min     |
| admin actions  | 10 / min    |

Errors follow a consistent shape:

```json
{ "error": "human-readable message" }
```

Rate-limit rejections return `429`. Auth failures return `401`. Permission
violations return `403`. Version conflicts and state violations return `409`.
Mutations blocked by the kill switch return `503`.


Health & Status
---------------

### GET /health

No authentication required. Lightweight liveness check.

**Response**

```json
{
  "status": "healthy",
  "uptime": 3600.5,
  "pid": 12345,
  "version": "0.1.69",
  "port": 3850,
  "agentsDir": "/home/user/.agents"
}
```

### GET /api/status

Full daemon status including pipeline config, embedding provider, and a
composite health score derived from diagnostics.

**Response**

```json
{
  "status": "running",
  "version": "0.1.69",
  "pid": 12345,
  "uptime": 3600.5,
  "startedAt": "2026-02-21T10:00:00.000Z",
  "port": 3850,
  "host": "localhost",
  "agentsDir": "/home/user/.agents",
  "memoryDb": true,
  "pipelineV2": {
    "enabled": true,
    "shadowMode": false,
    "mutationsFrozen": false,
    "graphEnabled": false,
    "autonomousEnabled": false,
    "extractionModel": "qwen3:4b"
  },
  "health": { "score": 0.97, "status": "healthy" },
  "embedding": {
    "provider": "ollama",
    "model": "nomic-embed-text",
    "available": true
  }
}
```


Auth
----

### GET /api/auth/whoami

Returns the identity and claims of the current request's token. In `local`
mode, `authenticated` is always `false` and `claims` is `null`.

**Response**

```json
{
  "authenticated": true,
  "claims": {
    "sub": "token:operator",
    "role": "operator",
    "scope": { "project": "my-project" },
    "iat": 1740000000,
    "exp": 1740086400
  },
  "mode": "team"
}
```

### POST /api/auth/token

Create a signed JWT. Requires `admin` permission. Rate-limited to 10
requests/min.

**Request body**

```json
{
  "role": "agent",
  "scope": { "project": "my-project", "agent": "claude", "user": "nicholai" },
  "ttlSeconds": 86400
}
```

`role` is required and must be one of `admin`, `operator`, `agent`,
`readonly`. `scope` is optional — an empty object creates an unscoped token.
`ttlSeconds` defaults to the value in `authConfig.defaultTokenTtlSeconds`.

**Response**

```json
{
  "token": "<jwt>",
  "expiresAt": "2026-02-22T10:00:00.000Z"
}
```

Returns `400` if `role` is invalid or auth secret is unavailable (local
mode). Returns `400` if the request body is missing or malformed.


Config
------

### GET /api/config

Returns all `.md` and `.yaml` files from the agents directory (`~/.agents/`),
sorted by priority: `agent.yaml`, `AGENTS.md`, `SOUL.md`, `IDENTITY.md`,
`USER.md`, then alphabetically.

**Response**

```json
{
  "files": [
    { "name": "agent.yaml", "content": "...", "size": 1024 },
    { "name": "AGENTS.md", "content": "...", "size": 4096 }
  ]
}
```

### POST /api/config

Write a config file. File name must end in `.md` or `.yaml` and must not
contain path separators.

**Request body**

```json
{
  "file": "SOUL.md",
  "content": "# Soul\n..."
}
```

**Response**

```json
{ "success": true }
```

Returns `400` for invalid file names, path traversal attempts, or wrong file
types.


Identity
--------

### GET /api/identity

Parses `IDENTITY.md` and returns the structured fields.

**Response**

```json
{
  "name": "Aria",
  "creature": "fox",
  "vibe": "calm and curious"
}
```

Returns defaults (`{ "name": "Unknown", "creature": "", "vibe": "" }`) if the
file is missing or unreadable.


Memories
--------

The memory API is the primary interface for reading and writing agent memory.
All write operations respect the `mutationsFrozen` kill switch — if enabled,
writes return `503`.

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
  "sourceId": "optional-external-id"
}
```

Only `content` is required.

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

If an identical memory (by content hash or `sourceId`) already exists,
`deduped: true` is returned with the existing record — no duplicate is
created.

### POST /api/memory/save

Alias for `POST /api/memory/remember`. Accepts the same request body and
returns the same response. Requires `remember` permission.

### POST /api/hook/remember

Alias for `POST /api/memory/remember`. Used by Claude Code skill
compatibility. Requires `remember` permission.

### GET /api/memory/:id

Get a single memory by ID. Returns deleted memories only if the query
explicitly requests them; by default, soft-deleted records return `404`.

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
  "source_type": "manual",
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

Hybrid search combining BM25 keyword (FTS5) and vector similarity. Results
are fused using a configurable alpha weight (`cfg.search.alpha`). Optional
graph boost and reranker pass are applied if enabled in pipeline config.
Requires `recall` permission.

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
  "since": "2026-01-01T00:00:00Z"
}
```

Only `query` is required.

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
      "created_at": "2026-02-21T10:00:00.000Z"
    }
  ],
  "query": "user preferences for editor",
  "method": "hybrid"
}
```

`source` per result is one of `hybrid`, `vector`, or `keyword`. `method` on
the response reflects whether vector search was available for this call.

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


Embeddings
----------

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


Documents
---------

The documents API ingests external content (text, URLs, files) for chunking
and embedding. Each document generates linked memory records via the pipeline.
All document endpoints require `documents` permission.

### POST /api/documents

Submit a document for ingestion. The document is queued and processed
asynchronously. Returns `201` on success, or the existing document's ID and
status if a duplicate URL is detected.

**Request body**

```json
{
  "source_type": "text",
  "content": "Full text content here",
  "title": "My Document",
  "content_type": "text/plain",
  "connector_id": null,
  "metadata": { "author": "nicholai" }
}
```

For `source_type: "url"`:

```json
{
  "source_type": "url",
  "url": "https://example.com/page",
  "title": "Example Page"
}
```

`source_type` is required and must be `text`, `url`, or `file`. `content` is
required for `text`. `url` is required for `url`.

**Response**

```json
{ "id": "uuid", "status": "queued" }
```

Or if deduplicated:

```json
{ "id": "existing-uuid", "status": "processing", "deduplicated": true }
```

### GET /api/documents

List all documents with optional status filter.

**Query parameters**

| Parameter | Description                              |
|-----------|------------------------------------------|
| `status`  | Filter by status (`queued`, `processing`, `done`, `failed`, `deleted`) |
| `limit`   | Page size (default: 50, max: 500)        |
| `offset`  | Pagination offset (default: 0)           |

**Response**

```json
{
  "documents": [...],
  "total": 42,
  "limit": 50,
  "offset": 0
}
```

Each document includes all columns from the `documents` table.

### GET /api/documents/:id

Get a single document by ID.

**Response** — full document row, or `404`.

### GET /api/documents/:id/chunks

List the memory records derived from this document, ordered by chunk index.

**Response**

```json
{
  "chunks": [
    {
      "id": "memory-uuid",
      "content": "Chunk text...",
      "type": "fact",
      "created_at": "2026-02-21T10:00:00.000Z",
      "chunk_index": 0
    }
  ],
  "count": 12
}
```

### DELETE /api/documents/:id

Soft-delete a document and all its derived memory records. Memories linked to
the document are soft-deleted one at a time with audit history.

**Query parameters**

| Parameter | Description                    |
|-----------|--------------------------------|
| `reason`  | Required. Deletion reason.     |

**Response**

```json
{ "deleted": true, "memoriesRemoved": 12 }
```


Connectors
----------

Connectors ingest documents from external sources on a schedule or on demand.
Currently only the `filesystem` provider is operational; `github-docs` and
`gdrive` are registered but not yet functional.

GET requests to connector endpoints are open. POST, DELETE, and mutation
requests require `admin` permission (or `connectors` for operators).

### GET /api/connectors

List all registered connectors.

**Response**

```json
{
  "connectors": [
    {
      "id": "uuid",
      "status": "idle",
      "config_json": "{...}",
      "cursor_json": "{...}",
      "last_sync_at": "2026-02-21T09:00:00.000Z",
      "last_error": null
    }
  ],
  "count": 1
}
```

### POST /api/connectors

Register a new connector. Requires `admin` permission.

**Request body**

```json
{
  "provider": "filesystem",
  "displayName": "My Notes",
  "settings": {
    "rootPath": "/home/nicholai/notes",
    "glob": "**/*.md"
  }
}
```

`provider` must be `filesystem`, `github-docs`, or `gdrive`.

**Response**

```json
{ "id": "uuid" }
```

Returns `201`.

### GET /api/connectors/:id

Get a single connector's details and current state.

### POST /api/connectors/:id/sync

Trigger an incremental sync for a filesystem connector. The sync runs in the
background — poll `GET /api/connectors/:id` for status updates. Requires
`admin` permission.

**Response**

```json
{ "status": "syncing" }
```

Returns `{ "status": "syncing", "message": "Already syncing" }` if a sync is
already running.

### POST /api/connectors/:id/sync/full

Trigger a full resync, discarding the cursor. Requires `?confirm=true` query
parameter as a safety guard. Requires `admin` permission.

**Response**

```json
{ "status": "syncing" }
```

### DELETE /api/connectors/:id

Remove a connector from the registry. Requires `admin` permission.

**Query parameters**

| Parameter | Description                                              |
|-----------|----------------------------------------------------------|
| `cascade` | `true` — also soft-delete documents from this connector  |

**Response**

```json
{ "deleted": true }
```

### GET /api/connectors/:id/health

Lightweight health check for a connector, including document count.

**Response**

```json
{
  "id": "uuid",
  "status": "idle",
  "lastSyncAt": "2026-02-21T09:00:00.000Z",
  "lastError": null,
  "documentCount": 142
}
```


Skills
------

### GET /api/skills

List all installed skills from `~/.agents/skills/`. Each skill must have a
`SKILL.md` with YAML frontmatter.

**Response**

```json
{
  "skills": [
    {
      "name": "browser-use",
      "description": "Browser automation skill",
      "version": "1.0.0",
      "author": "browser-use",
      "license": "MIT",
      "user_invocable": true,
      "arg_hint": "<url>",
      "path": "/home/user/.agents/skills/browser-use"
    }
  ],
  "count": 3
}
```

### GET /api/skills/search

Search the skills.sh registry for installable skills.

**Query parameters**

| Parameter | Description                     |
|-----------|---------------------------------|
| `q`       | Search query string (required)  |

**Response**

```json
{
  "results": [
    {
      "name": "browser-use",
      "description": "browser-use/browser-use@browser-use (32.6K installs)",
      "installed": false
    }
  ]
}
```

### GET /api/skills/:name

Get a single skill's metadata and full `SKILL.md` content.

**Response**

```json
{
  "name": "browser-use",
  "description": "...",
  "version": "1.0.0",
  "path": "/home/user/.agents/skills/browser-use",
  "content": "---\ndescription: ...\n---\n\n# Browser Use\n..."
}
```

Returns `400` for invalid names (path traversal). Returns `404` if not
installed.

### POST /api/skills/install

Install a skill via the configured package manager (bun, npm, or pnpm).
Runs `skills add <pkg> --global --yes`. Times out after 60 seconds.

**Request body**

```json
{
  "name": "browser-use",
  "source": "browser-use/browser-use@browser-use"
}
```

`name` is required. `source` overrides the install package name if provided.

**Response**

```json
{ "success": true, "name": "browser-use", "output": "..." }
```

Returns `500` with `{ "success": false, "error": "..." }` on failure.

### DELETE /api/skills/:name

Uninstall a skill by removing its directory from `~/.agents/skills/`.

**Response**

```json
{ "success": true, "name": "browser-use", "message": "Removed browser-use" }
```


Harnesses
---------

### GET /api/harnesses

List known harness config file locations and whether each exists on disk.

**Response**

```json
{
  "harnesses": [
    { "name": "Claude Code", "path": "/home/user/.claude/CLAUDE.md", "exists": true },
    { "name": "OpenCode", "path": "/home/user/.config/opencode/AGENTS.md", "exists": false },
    { "name": "OpenClaw (Source)", "path": "/home/user/.agents/AGENTS.md", "exists": true }
  ]
}
```

### POST /api/harnesses/regenerate

Run the `generate-harness-configs.py` script from the scripts directory to
rebuild all harness config files from source. The script must exist at
`~/.agents/scripts/generate-harness-configs.py`.

**Response**

```json
{ "success": true, "message": "Configs regenerated successfully", "output": "..." }
```

Returns `404` if the script is not found.


Secrets
-------

Secrets are stored encrypted on disk at `~/.agents/.secrets/`. Values are
never returned in API responses — only names are exposed.

### POST /api/secrets/:name

Store or overwrite a secret value.

**Request body**

```json
{ "value": "sk-abc123..." }
```

`value` must be a non-empty string.

**Response**

```json
{ "success": true, "name": "OPENAI_API_KEY" }
```

### GET /api/secrets

List stored secret names. Values are never included.

**Response**

```json
{ "secrets": ["OPENAI_API_KEY", "GITHUB_TOKEN"] }
```

### DELETE /api/secrets/:name

Delete a stored secret.

**Response**

```json
{ "success": true, "name": "OPENAI_API_KEY" }
```

Returns `404` if the secret does not exist.

### POST /api/secrets/:name/exec

Execute a shell command with secrets injected into the subprocess environment.
Callers pass references (env var name → secret name), never values. The daemon
resolves and injects the actual values before spawning the subprocess.

**Request body**

```json
{
  "command": "curl -H 'Authorization: Bearer $OPENAI_API_KEY' https://api.openai.com/v1/models",
  "secrets": {
    "OPENAI_API_KEY": "OPENAI_API_KEY"
  }
}
```

`command` is required. `secrets` is optional — if omitted, the named secret
from the URL path is injected under its own name.

**Response**

```json
{ "code": 0, "stdout": "...", "stderr": "" }
```


Hooks
-----

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
  "sessionKey": "session-uuid",
  "runtimePath": "plugin"
}
```

`harness` is required.

**Response** — implementation-defined context object returned by
`handleSessionStart`.

### POST /api/hooks/user-prompt-submit

Called on each user message. Returns memories relevant to the current prompt
for in-context injection.

**Request body**

```json
{
  "harness": "claude-code",
  "userPrompt": "How do I set up dark mode?",
  "lastAssistantMessage": "Earlier we discussed using CSS variables for theme tokens.",
  "sessionKey": "session-uuid",
  "runtimePath": "plugin"
}
```

`harness` and `userPrompt` are required.
`lastAssistantMessage` is optional and improves recall matching.

### POST /api/hooks/session-end

Called at session end. Triggers memory extraction from the transcript.
Releases the session's runtime path claim.

**Request body**

```json
{
  "harness": "claude-code",
  "sessionKey": "session-uuid",
  "sessionId": "session-uuid",
  "runtimePath": "plugin"
}
```

`harness` is required.

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
  "sessionKey": "session-uuid",
  "runtimePath": "plugin"
}
```

`harness` and `query` are required.

### POST /api/hooks/pre-compaction

Called before context window compaction. Returns summary instructions for
the compaction prompt.

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

Save a compaction summary as a `session_summary` memory.

**Request body**

```json
{
  "harness": "claude-code",
  "summary": "Session covered dark mode setup and vim configuration...",
  "sessionKey": "session-uuid",
  "runtimePath": "plugin"
}
```

`harness` and `summary` are required.

**Response**

```json
{ "success": true, "memoryId": "uuid" }
```

### GET /api/hooks/synthesis/config

Return the current synthesis configuration (thresholds, model, schedule).

### POST /api/hooks/synthesis

Request a `MEMORY.md` synthesis run. Implementation-defined request body
and response from `handleSynthesisRequest`.

### POST /api/hooks/synthesis/complete

Write a newly synthesized `MEMORY.md`. Backs up the existing file before
overwriting.

**Request body**

```json
{ "content": "# Memory\n\n..." }
```

`content` is required.

**Response**

```json
{ "success": true }
```


Git
---

The git API manages automatic commit and sync of the `~/.agents/` directory.
Config is loaded from `agent.yaml` under the `git` key. Defaults: `autoCommit:
true`, `autoSync: true`, `syncInterval: 300s`, `remote: origin`,
`branch: main`.

### GET /api/git/status

Return git status for the agents directory.

**Response** — output of `getGitStatus()` including `branch`, `ahead`,
`behind`, `dirty`, `lastCommit`.

### POST /api/git/pull

Pull from the configured remote and branch.

**Response** — result of `gitPull()` including `success`, `output`, `error`.

### POST /api/git/push

Push the current branch to the configured remote.

**Response** — result of `gitPush()`.

### POST /api/git/sync

Pull then push — equivalent to running both operations in sequence.

**Response** — result of `gitSync()`.

### GET /api/git/config

Return the current in-memory git configuration.

**Response**

```json
{
  "enabled": true,
  "autoCommit": true,
  "autoSync": true,
  "syncInterval": 300,
  "remote": "origin",
  "branch": "main"
}
```

### POST /api/git/config

Update runtime git configuration. Changes take effect immediately; the sync
timer is restarted if `autoSync` or `syncInterval` changes.

**Request body** (all fields optional)

```json
{
  "autoSync": true,
  "syncInterval": 600,
  "remote": "origin",
  "branch": "main"
}
```

**Response**

```json
{ "success": true, "config": { ... } }
```


Update
------

The update system checks GitHub releases and the npm registry, then optionally
auto-installs using the detected package manager.

### GET /api/update/check

Check for a newer version. Results are cached for 1 hour unless `?force=true`
is passed.

**Query parameters**

| Parameter | Description                         |
|-----------|-------------------------------------|
| `force`   | `true` — bypass 1-hour cache        |

**Response**

```json
{
  "currentVersion": "0.1.69",
  "latestVersion": "0.1.70",
  "updateAvailable": true,
  "releaseUrl": "https://github.com/Signet-AI/signetai/releases/tag/v0.1.70",
  "releaseNotes": "...",
  "publishedAt": "2026-02-20T12:00:00Z",
  "restartRequired": false,
  "pendingVersion": null,
  "cached": false,
  "checkedAt": "2026-02-21T10:00:00.000Z"
}
```

### GET /api/update/config

Return current update configuration and runtime state.

**Response**

```json
{
  "autoInstall": false,
  "checkInterval": 21600,
  "minInterval": 300,
  "maxInterval": 604800,
  "pendingRestartVersion": null,
  "lastAutoUpdateAt": null,
  "lastAutoUpdateError": null,
  "updateInProgress": false
}
```

### POST /api/update/config

Modify auto-update settings. Changes are persisted to `agent.yaml`.

**Request body** (all fields optional)

```json
{
  "autoInstall": true,
  "checkInterval": 43200
}
```

`checkInterval` must be between 300 and 604800 seconds.

**Response**

```json
{
  "success": true,
  "config": { "autoInstall": true, "checkInterval": 43200 },
  "persisted": true,
  "pendingRestartVersion": null,
  "lastAutoUpdateAt": null,
  "lastAutoUpdateError": null
}
```

### POST /api/update/run

Install the latest version immediately. Runs the global install command for
the detected package manager. A daemon restart is required to activate the
update.

**Response**

```json
{
  "success": true,
  "message": "Update installed. Restart daemon to apply.",
  "output": "...",
  "installedVersion": "0.1.70",
  "restartRequired": true
}
```

If already up to date, returns `success: true` with a message indicating no
update is needed.


Diagnostics
-----------

Requires `diagnostics` permission.

### GET /api/diagnostics

Full diagnostic report across all domains. Includes a composite health score
derived from database health, pipeline state, embedding availability, and
mutation integrity.

**Response** — a multi-domain report object. Domains include `database`,
`pipeline`, `embedding`, `mutation`, `fts`, and `composite`. The `composite`
field looks like:

```json
{ "score": 0.95, "status": "healthy" }
```

### GET /api/diagnostics/:domain

Diagnostic data for a single domain. Known domains: `database`, `pipeline`,
`embedding`, `mutation`, `fts`, `composite`.

Returns `400` for unknown domains.


Repair
------

Administrative repair operations. All require `admin` permission. Operations
are rate-limited internally by the repair limiter and return `429` when the
limit is exceeded.

### POST /api/repair/requeue-dead

Requeue extraction jobs stuck in a terminal-failed state. Typically used
after resolving a pipeline configuration issue.

**Response**

```json
{ "action": "requeueDeadJobs", "success": true, "affected": 12, "message": "..." }
```

### POST /api/repair/release-leases

Release stale pipeline job leases that have exceeded their timeout. Run this
if pipeline workers crashed and left jobs locked.

**Response**

```json
{ "action": "releaseStaleLeases", "success": true, "affected": 3, "message": "..." }
```

### POST /api/repair/check-fts

Check FTS5 index consistency against the memories table. Optionally repair
mismatches.

**Request body** (optional)

```json
{ "repair": true }
```

**Response**

```json
{ "action": "checkFtsConsistency", "success": true, "affected": 0, "message": "..." }
```

### POST /api/repair/retention-sweep

Trigger a manual retention decay sweep. This endpoint is currently not wired
to the pipeline worker and returns `501`.

**Response**

```json
{
  "action": "triggerRetentionSweep",
  "success": false,
  "affected": 0,
  "message": "Use the maintenance worker for automated sweeps..."
}
```

### GET /api/repair/embedding-gaps

Returns the count of memories that are missing vector embeddings.
Requires `admin` permission.

**Response**

```json
{
  "unembedded": 42,
  "total": 1200,
  "coverage": "96.5%"
}
```

### POST /api/repair/re-embed

Batch re-embeds memories that are missing vector embeddings. Processes
up to `batchSize` memories per call. Requires `admin` permission.
Rate-limited — returns `429` when the limit is exceeded.

**Request body**

```json
{
  "batchSize": 50,
  "dryRun": false
}
```

`batchSize` defaults to `50`. `dryRun: true` reports what would be
embedded without calling the embedding provider.

**Response**

```json
{
  "action": "reEmbedMissingVectors",
  "success": true,
  "affected": 42,
  "message": "re-embedded 42 memories"
}
```


Analytics
---------

Requires `analytics` permission.

### GET /api/analytics/usage

Aggregate request counts, memory operation totals, and per-endpoint hit
counts collected since daemon start.

**Response** — collector-defined usage summary object.

### GET /api/analytics/errors

Recent error events from the analytics collector.

**Query parameters**

| Parameter | Description                                   |
|-----------|-----------------------------------------------|
| `stage`   | Filter by pipeline stage (e.g., `mutation`)   |
| `since`   | ISO timestamp — only errors after this time   |
| `limit`   | Max errors to return                          |

**Response**

```json
{
  "errors": [ { "stage": "mutation", "message": "...", "at": "..." } ],
  "summary": { "total": 5, "byStage": { "mutation": 5 } }
}
```

### GET /api/analytics/latency

Latency histograms for key operation groups: `remember`, `recall`, `mutate`.

**Response** — collector-defined latency object with p50/p95/p99 per group.

### GET /api/analytics/logs

Recent structured log entries. Same data as `GET /api/logs` but namespaced
under analytics.

**Query parameters**

| Parameter  | Description                                           |
|------------|-------------------------------------------------------|
| `limit`    | Max log entries (default: 100)                        |
| `level`    | `debug`, `info`, `warn`, or `error`                   |
| `category` | Filter by log category (e.g., `memory`, `pipeline`)   |
| `since`    | ISO timestamp lower bound                             |

**Response**

```json
{ "logs": [...], "count": 47 }
```

### GET /api/analytics/memory-safety

Combined view of mutation diagnostics and recent mutation errors. Useful for
auditing data integrity.

**Response**

```json
{
  "mutation": { ... },
  "recentErrors": [ ... ],
  "errorSummary": { ... }
}
```


Timeline
--------

Requires `analytics` permission.

### GET /api/timeline/:id

Build a chronological timeline for a memory entity, combining mutation
history, log events, and errors associated with the given ID.

**Response** — timeline object with ordered events from `buildTimeline()`.

### GET /api/timeline/:id/export

Same as `GET /api/timeline/:id` but wraps the result in an export envelope
with version and timestamp metadata.

**Response**

```json
{
  "meta": {
    "version": "0.1.69",
    "exportedAt": "2026-02-21T10:00:00.000Z",
    "entityId": "uuid"
  },
  "timeline": { ... }
}
```


Logs
----

### GET /api/logs

Return recent structured log entries from the in-memory log buffer.

**Query parameters**

| Parameter  | Description                                           |
|------------|-------------------------------------------------------|
| `limit`    | Max entries (default: 100)                            |
| `level`    | Minimum level: `debug`, `info`, `warn`, `error`       |
| `category` | Filter by category string                             |
| `since`    | ISO timestamp — only logs after this time             |

**Response**

```json
{ "logs": [...], "count": 100 }
```

### GET /api/logs/stream

Server-Sent Events stream of live log output. Each event is a JSON-serialized
`LogEntry`. The connection sends an initial `{"type":"connected"}` event and
then emits entries in real time as the daemon generates them.

```
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
```

Each SSE event:

```
data: {"level":"info","category":"memory","message":"Memory saved","at":"..."}
```

The stream stays open until the client disconnects.


MCP Server
----------

### ALL /mcp

Model Context Protocol endpoint using Streamable HTTP transport (stateless).
Supports POST (send messages), GET (SSE stream), and DELETE (session teardown).

Exposes memory tools: `memory_search`, `memory_store`, `memory_get`,
`memory_list`, `memory_modify`, `memory_forget`. See `docs/MCP.md` for full
tool documentation.

**POST /mcp** — Send MCP JSON-RPC messages. Returns JSON or SSE stream.

**GET /mcp** — Open an SSE stream for server-initiated notifications.

**DELETE /mcp** — Terminate MCP session (no-op in stateless mode).


Scheduled Tasks
----------------

### GET /api/tasks

List all scheduled tasks with their last run status.

**Response**

```json
{
  "tasks": [{
    "id": "uuid",
    "name": "Review open PRs",
    "prompt": "Review all open pull requests",
    "cron_expression": "0 9 * * *",
    "harness": "claude-code",
    "working_directory": "/path/to/project",
    "enabled": 1,
    "last_run_at": "2026-02-23T09:00:00Z",
    "next_run_at": "2026-02-24T09:00:00Z",
    "last_run_status": "completed",
    "last_run_exit_code": 0
  }],
  "presets": [
    {"label": "Every 15 min", "expression": "*/15 * * * *"},
    {"label": "Hourly", "expression": "0 * * * *"},
    {"label": "Daily 9am", "expression": "0 9 * * *"},
    {"label": "Weekly Mon 9am", "expression": "0 9 * * 1"}
  ]
}
```

### POST /api/tasks

Create a new scheduled task.

**Request body**

```json
{
  "name": "Review open PRs",
  "prompt": "Review all open pull requests and summarize findings",
  "cronExpression": "0 9 * * *",
  "harness": "claude-code",
  "workingDirectory": "/path/to/project"
}
```

**Response** (201)

```json
{"id": "uuid", "nextRunAt": "2026-02-24T09:00:00Z"}
```

### GET /api/tasks/:id

Get a single task with its 20 most recent runs.

### PATCH /api/tasks/:id

Update a task's name, prompt, cron, harness, working directory, or enabled state.

### DELETE /api/tasks/:id

Delete a task and all its run history (cascade).

### POST /api/tasks/:id/run

Trigger an immediate manual run. Returns 202 with `runId`. Returns 409 if
the task already has a running execution.

### GET /api/tasks/:id/runs

Paginated run history. Supports `limit` and `offset` query parameters.


Dashboard
---------

### GET /

Serves the SvelteKit dashboard as a single-page application. Static files are
served from the built dashboard directory. Any path without a file extension
falls back to `index.html` for client-side routing.

If the dashboard build is not found, a minimal HTML fallback page is served
with links to key API endpoints.
