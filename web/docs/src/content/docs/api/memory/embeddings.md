---
title: "Memory embeddings"
description: "Inspect embedding status, health, vectors, and projection data."
---

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
If a native inference call times out, Signet disables that native worker for
the rest of the daemon session and reports it unavailable here. Signet probes
local llama.cpp and Ollama fallbacks once; when neither is ready, later
embedding requests degrade without repeating those probes.

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
