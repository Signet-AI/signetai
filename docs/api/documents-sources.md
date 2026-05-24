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
`obsidian`, `discord`, and `github`.

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
      "stats": { "artifacts": 42, "chunks": 108, "indexed": 42 },
      "health": {
        "status": "healthy",
        "generatedAt": "2026-05-06T09:01:00.000Z",
        "latestArtifactAt": "2026-05-06T09:01:00.000Z",
        "latestCheckpointAt": null,
        "chunkCoverage": 1,
        "failures": { "total": 0, "recoverable": 0 },
        "checkpoints": { "total": 0, "partial": 0, "stale": 0 },
        "purge": { "deletedArtifacts": 0, "orphanChunks": 0 },
        "semantic": { "entities": 8, "attributes": 0, "dependencies": 12, "communities": 3, "total": 23 }
      }
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

### POST /api/sources/github

Add or update a GitHub source and queue a shared source index job. Without a
token reference, GitHub sources default to issues, pull requests, and selected
Markdown docs. Discussions require `tokenRef` because they use the GitHub
GraphQL API. Raw GitHub tokens are rejected; pass a Signet secret name or
external secret reference instead.

**Request body**

```json
{
  "repos": ["Signet-AI/signetai"],
  "tokenRef": "GITHUB_TOKEN",
  "name": "Signet GitHub",
  "resourceTypes": ["issues", "pulls", "discussions", "docs"],
  "state": "all",
  "includeComments": true,
  "labels": ["bug", "needs review"],
  "docPaths": ["README.md", "docs/**/*.md"],
  "maxItemsPerRepo": 500
}
```

`repo` is accepted as a single-repository alias. `docPaths` are limited to
Markdown files or Markdown globs so GitHub source indexing stays focused on
chosen docs instead of broad source-code ingestion.

**Response**

```json
{
  "source": { "id": "github:abc123", "kind": "github" },
  "created": true,
  "indexed": 0,
  "queued": true,
  "job": { "status": "queued", "sourceId": "github:abc123" }
}
```

The sync path indexes source-owned artifacts for issues, pull requests,
discussions, selected Markdown docs, comments, and partial-failure artifacts.
Partial GitHub failures cause the shared source job to report failure while
preserving source-owned rows that were indexed successfully.

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

### GET /api/sources/:sourceId/health

Return operational diagnostics for a configured source. The payload is the same
health object embedded in `GET /api/sources`, plus the source config and index
stats.

Diagnostics include artifact/chunk counts, latest artifact and checkpoint
timestamps, Discord partial-failure/checkpoint counts, stale checkpoint counts,
purge residue, and source-provenance graph row counts. If diagnostic queries
fail, the route returns `status: "unhealthy"` with an `error` field instead of
synthesizing a healthy source.

**Response**

```json
{
  "source": { "id": "discord:abc123", "kind": "discord", "name": "Team Discord" },
  "stats": { "artifacts": 420, "chunks": 250, "indexed": 420 },
  "health": {
    "status": "degraded",
    "generatedAt": "2026-05-24T00:00:00.000Z",
    "latestArtifactAt": "2026-05-24T00:00:00.000Z",
    "latestCheckpointAt": "2026-05-24T00:00:00.000Z",
    "chunkCoverage": 0.6,
    "failures": { "total": 1, "recoverable": 1 },
    "checkpoints": { "total": 20, "partial": 1, "stale": 0 },
    "purge": { "deletedArtifacts": 0, "orphanChunks": 0 },
    "semantic": { "entities": 12, "attributes": 4, "dependencies": 6, "communities": 2, "total": 24 }
  }
}
```

### GET /api/sources/:sourceId/snapshot

Export source-owned artifact rows as a Signet source snapshot. Snapshots use
`memory_artifacts` provenance instead of a provider-specific archive database.

**Query parameters**

| Parameter | Description |
|-----------|-------------|
| `includeLocalDiscord` | Include local Discord Desktop `@me` cache artifacts. Defaults to `false`. |

By default, Discord Desktop cache DMs under the synthetic guild id `@me` are
excluded so shared snapshots do not publish local-only private data.

**Response**

```json
{
  "version": 1,
  "exportedAt": "2026-05-24T00:00:00.000Z",
  "source": { "id": "discord:abc123", "kind": "discord", "name": "Team Discord", "root": "discord://123" },
  "agentId": "default",
  "artifacts": [
    {
      "sourcePath": "discord://guild/123/channel/456/message/789",
      "sourceKind": "source_discord_message",
      "sourceId": "discord:abc123",
      "content": "# Discord Message\n..."
    }
  ],
  "skipped": { "localDiscordArtifacts": 0 }
}
```

### POST /api/sources/:sourceId/snapshot/import

Import a Signet source snapshot into an existing configured source. The import
replaces source-owned artifact rows for that source and reuses the normal
artifact upsert path so FTS and provenance stay consistent.

**Query parameters**

| Parameter | Description |
|-----------|-------------|
| `includeLocalDiscord` | Import local Discord Desktop `@me` cache artifacts from the snapshot. Defaults to `false`. |

Default imports preserve existing local `@me` Discord cache artifacts and skip
any `@me` artifacts present in the incoming snapshot.

**Request body**

The JSON returned by `GET /api/sources/:sourceId/snapshot`.

**Response**

```json
{
  "ok": true,
  "imported": 42,
  "skipped": { "localDiscordArtifacts": 3 }
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
