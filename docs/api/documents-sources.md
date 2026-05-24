---
title: "Documents and sources API"
description: "Document ingestion and source-backed recall endpoints."
order: 15
section: "Reference"
---

# Documents and sources API

Document ingestion and source-backed recall endpoints.

[Back to HTTP API overview](../API.md).

## Documents

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


## Sources

Sources connect read-only external knowledge bases to Signet recall without
turning them into ordinary saved memories. Supported source kinds are
`obsidian` and `discord`.

### GET /api/sources

List configured sources and lightweight index stats for the current daemon
agent.

**Response**

```json
{
  "version": 1,
  "sources": [
    {
      "id": "obsidian:abc123",
      "kind": "obsidian",
      "name": "Research Vault",
      "root": "/home/user/ObsidianVault",
      "enabled": true,
      "mode": "read-only",
      "createdAt": "2026-05-06T09:00:00.000Z",
      "updatedAt": "2026-05-06T09:00:00.000Z",
      "lastIndexedAt": "2026-05-06T09:01:00.000Z",
      "excludeGlobs": ["**/.obsidian/**", "**/.trash/**", "**/.hermes/**"],
      "stats": { "artifacts": 42, "chunks": 108, "indexed": 42 }
    }
  ]
}
```

### POST /api/sources/obsidian

Add or update an Obsidian vault source and queue a source index job. The vault
stays read-only; Signet writes only derived source artifacts, graph rows, and
chunk embeddings to its own database.

**Request body**

```json
{
  "path": "/home/user/ObsidianVault",
  "name": "Research Vault",
  "excludeGlobs": ["private/**"]
}
```

`root` is also accepted as an alias for `path`.

**Response**

```json
{
  "source": { "id": "obsidian:abc123", "kind": "obsidian" },
  "created": true,
  "indexed": 0,
  "queued": true,
  "job": { "status": "queued", "sourceId": "obsidian:abc123" }
}
```

### POST /api/sources/discord

Add or update a Discord source and queue a shared source index job. REST and
gateway modes require a bot token secret reference; raw Discord tokens are
rejected at the config boundary. Desktop cache mode reads local Discord Desktop
cache artifacts and does not require a token.

**Request body**

```json
{
  "guildIds": ["123456789012345678"],
  "tokenRef": "DISCORD_BOT_TOKEN",
  "name": "Team Discord",
  "channelFilter": ["general", "234567890123456789"],
  "maxMessagesPerChannel": 1000,
  "includeThreads": true,
  "includeArchivedThreads": true,
  "includePrivateArchivedThreads": false,
  "includeMembers": true,
  "includeAttachments": true,
  "includeEmbeds": true,
  "includePolls": true,
  "includeThreadMembers": true,
  "since": "2026-01-01T00:00:00.000Z",
  "syncMode": "rest"
}
```

`guildId` is accepted as a single-guild alias. `channels` is accepted as an
alias for `channelFilter`.

For local Discord Desktop cache import:

```json
{
  "name": "Local Discord Cache",
  "syncMode": "desktop-cache",
  "desktopCachePath": "/home/user/.config/discord",
  "desktopCacheFullScan": false
}
```

`desktopCachePath` is optional when the platform default Discord Desktop data
folder exists. The selected cache root must be a known Discord-compatible
application data folder. `desktopCacheFullScan` expands cache file scanning;
the default scans LevelDB/log JSON and route-bearing Chromium cache entries.

**Response**

```json
{
  "source": { "id": "discord:abc123", "kind": "discord" },
  "created": true,
  "indexed": 0,
  "queued": true,
  "job": { "status": "queued", "sourceId": "discord:abc123" }
}
```

The REST sync path indexes guilds, categories, channels, announcement
channels, forums, active and archived threads, member snapshots, thread member
snapshots, per-message artifacts, message windows, mentions, attachment
metadata, embeds, polls, checkpoints, and partial-failure artifacts. Partial Discord listings are not
used as authoritative deletes.

The desktop-cache sync path indexes classifiable route-bearing cached messages,
DMs under the synthetic guild id `@me`, cache-observed channel metadata, message
windows, attachments, mentions, embeds, polls, checkpoints, and import stats.
Cache imports are observational and never reconcile deletes from missing or
evicted local cache files.

### DELETE /api/sources/:sourceId

Remove a source config and purge Signet-owned source artifacts, graph rows,
and source chunk embeddings. Source files are not modified.

**Response**

```json
{
  "source": { "id": "obsidian:abc123", "kind": "obsidian" },
  "purged": 150
}
```

### POST /api/sources/pick-directory

Best-effort local directory picker used by dashboard/browser flows. It returns
`501` when no OS picker command is available.

**Request body**

```json
{ "title": "Choose Obsidian vault" }
```

**Response**

```json
{ "path": "/home/user/ObsidianVault" }
```
