---
title: "Memory embeddings"
description: "Inspect embedding status, health, vectors, and projection data."
---

### GET /api/embeddings

Export all stored embeddings with their parent memory metadata.
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

Check the configured embedding provider's availability and any active embedding
index migration. Results are cached for 30 seconds. Requires `recall`
permission.

**Response**

```json
{
  "provider": "ollama",
  "model": "nomic-embed-text",
  "available": true,
  "dimensions": 768,
  "base_url": "http://localhost:11434",
  "checkedAt": "2026-02-21T10:00:00.000Z",
  "index": {
    "state": "building",
    "coverage": {
      "active": 45004,
      "staged": 45003,
      "missing": 1,
      "wrongDimensions": 0,
      "quarantined": 1,
      "ready": true
    }
  }
}
```

`index.coverage.quarantined` counts active rows that the target provider
rejected as permanently unrepresentable, such as an input exceeding its
context limit. These rows retain their source id and content hash in the
durable migration-failure table, are excluded from future polls for that
target profile, and do not block promotion. The status response therefore
reports staging coverage separately from active-index coverage.

On failure, `available` is `false` and `error` contains a description.
If a native inference call times out, Signet disables that native worker for
the rest of the daemon session and reports it unavailable here. Signet probes
local llama.cpp and Ollama fallbacks once; when neither is ready, later
embedding requests degrade without repeating those probes.

### GET /api/embeddings/health

Returns embedding health metrics including coverage and staleness. Requires
`recall` permission.

**Response** — embedding health object with coverage percentage, stale
count, and provider status.

### GET /api/embeddings/projection

Returns a UMAP projection of stored memory embeddings. Requires `recall`
permission. SQLite reads and the immutable embedding snapshot run through the
DB owner; UMAP runs in a killable worker so this endpoint cannot block the
daemon event loop.

Each job is capped at 1,000 rows. A request without `limit` uses that cap and
sets `sampled: true` when more rows match. `limit` is clamped to 1,000. There
is no unbounded or all-row mode.

**Query parameters**

| Parameter    | Type    | Default | Description                                      |
|--------------|---------|---------|--------------------------------------------------|
| `dimensions` | integer | 2       | Output dimensions: `2` or `3`                    |
| `limit`      | integer | 1,000   | Maximum rows in the immutable snapshot            |
| `offset`     | integer | 0       | Offset, capped at 100,000                        |
| `q` and filters | string | —     | Existing embedding filters, applied in the owner |
| `jobId`      | string  | —       | Poll an accepted job                         |

A cache hit returns `status: "ready"`. A cache miss is admitted with
`202 Accepted` and returns a `jobId`:

```json
{ "status": "accepted", "jobId": "projection-...", "dimensions": 2,
  "limit": 1000, "offset": 0 }
```

Poll with the same endpoint and `?jobId=...`. Poll responses use
`accepted`, `running`, or `ready`. Failed jobs report `timeout`, `cancelled`,
or `error` as typed status-resource responses with HTTP `200`; the complete
snapshot-plus-worker job has a hard 10-second deadline. When the two-job global
capacity is full, new work returns `429` with `status: "overloaded"`.

Cancel an active job with `DELETE /api/embeddings/projection/:jobId`. A successful
cancellation returns `200` with `status: "cancelled"`; an unknown or foreign
job returns `404`. Cancellation kills the worker and closes the disposable
projection DB owner, including any in-flight snapshot. Successful results are
kept in a bounded in-memory ready cache; timeout, cancellation, and failure
never publish cache entries.

**Response (ready)**

```json
{
  "status": "ready",
  "dimensions": 2,
  "count": 847,
  "total": 1200,
  "limit": 1000,
  "offset": 0,
  "hasMore": true,
  "sampled": true,
  "nodes": [],
  "edges": [],
  "cachedAt": "2026-02-21T10:05:00.000Z"
}
```
