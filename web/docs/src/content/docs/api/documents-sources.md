---
title: "Documents and sources API"
description: "Document ingestion and source-backed recall endpoints."
---

Document ingestion and source-backed recall endpoints.

[Back to HTTP API overview](/api/).

## Documents

The documents API ingests external content (text, URLs, files) for chunking
and embedding. Each document generates linked memory records via the pipeline.
All document endpoints require `documents` permission.

### POST /api/documents

Submit a document for ingestion. The document is queued and processed
asynchronously. A new request returns `201` with the queued document and job
IDs. A duplicate URL returns the existing document's ID and its real current
status when it is already active in the same agent and project scope.

**Request body**

```json
{
  "source_type": "text",
  "content": "Full text content here",
  "title": "My Document",
  "content_type": "text/plain",
  "connector_id": null,
  "metadata": { "author": "example" }
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
{ "id": "uuid", "status": "queued", "jobId": "memory-job-uuid" }
```

Or if deduplicated:

```json
{ "id": "existing-uuid", "status": "chunking", "deduplicated": true }
```

### GET /api/documents

List all documents with optional status filter.

**Query parameters**

| Parameter | Description                              |
|-----------|------------------------------------------|
| `status`  | Filter by lifecycle status (`queued`, `extracting`, `chunking`, `embedding`, `indexing`, `done`, `failed`, `deleted`) |
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
      "type": "document_chunk",
      "created_at": "2026-02-21T10:00:00.000Z",
      "chunk_index": 0
    }
  ],
  "count": 12
}
```

### DELETE /api/documents/:id

Soft-delete a document and its unshared derived memory records. The document is
marked `deleted` and any pending document-ingest job is completed. A linked
memory is soft-deleted with audit history only when no other non-deleted
document still references it; shared memories remain available to their other
documents.

**Query parameters**

| Parameter | Description                    |
|-----------|--------------------------------|
| `reason`  | Required. Deletion reason.     |

**Response**

```json
{ "deleted": true, "memoriesRemoved": 12 }
```

`memoriesRemoved` is the number of memories actually soft-deleted, not the
number of chunk links on the document.


## Sources

Sources connect read-only external knowledge bases to Signet recall without
turning them into ordinary saved memories. Supported source kinds are
`obsidian`, `discord`, `github`, and `import`.

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
        "semantic": {
          "entities": 8,
          "aspects": 3,
          "attributes": 0,
          "dependencies": 12,
          "communities": 3,
          "total": 26,
          "documentEntityId": null
        },
        "permission": { "status": "clear", "issues": [] }
      }
    }
  ]
}
```

For `import` sources, `health.importExtraction` is present when the daemon has
the durable extraction outcome. It reports the source-document entity id plus
the aspects and attributes created by the import pipeline. This is distinct
from `health.semantic`, which remains the current source-attributed graph
diagnostic and can include later Dreaming-derived work.

For macOS sources whose configured paths are protected by TCC, `health.status`
is `unhealthy` and `health.permission` is `{ "status": "denied", "issues":
[{ "path": "...", "guidance": "..." }] }`. The guidance names Full Disk
Access and includes the denied path. The daemon backs off denied paths until
permission is restored.

### POST /api/sources/import

Import one or more files as durable, read-only source artifacts. The request is
`multipart/form-data` with one or more `files` fields and an optional
`duplicateMode` field. `duplicateMode` is `skip` by default and can also be
`replace` or `reimport`.

The dashboard importer accepts text, Markdown, JSON, HTML, CSV, and document
formats supported by AnyDoc (`doc`, `docx`, `docm`, `odt`, `rtf`, `pdf`, `ppt`,
`pptx`, `ppsx`, `odp`, `epub`, `xls`, `xlsx`, `xlsm`, and `ods`). JSON is stored
as both a structured canonical artifact and a searchable projection. CSV keeps
one table artifact and adds bounded searchable row-range chunks with row-range
provenance. Document formats are converted to a Markdown projection. Raw upload
bytes are not retained by the importer.

A local desktop daemon may also receive repeated `paths` fields instead of
`files`; it reads those paths directly only for loopback requests. Remote
clients must upload file bytes through `files`, so a desktop path is never
interpreted by a remote daemon.

Imported artifacts are available immediately through source-backed recall, with
`source_id` and `source_path` pointing back to the imported source. Import
completion queues a hygiene Dreaming attention for asynchronous semantic
processing. Removing or replacing an imported source removes its searchable
artifacts, preserves derived provenance rows, records an `unsupported`
lifecycle marker, and queues another hygiene review rather than silently
deleting derived ontology.

The default safety bounds are 25 files per request, 25 MiB per file, and 100
MiB per batch. Each file returns an individual result so a mixed batch can
partially succeed.

### Durable transcript imports

Transcript imports are a separate durable API; they do not use the synchronous
`POST /api/sources/import` document importer or `transcript_capture_jobs`.
`POST /api/sources/imports` creates a job, `PUT
/api/sources/imports/:jobId/files/:fileId` streams one JSONL file, and `POST
.../:jobId/start` queues it. `GET .../:jobId`, `.../rejections`, and
`.../reconciliation` report progress and outcomes. `pause`, `resume`, `retry`,
and `cancel` are durable controls. All routes require `modify` permission and
fail closed when `agentId` is not the daemon's resolved target agent.

### POST /api/sources/imports

Creates a durable transcript import job.

### GET /api/sources/imports

Lists transcript import jobs for the resolved agent.

### GET /api/sources/imports/:jobId

Returns one job and its staged files.

### PUT /api/sources/imports/:jobId/files/:fileId

Streams one JSONL file into the staged slot.

### POST /api/sources/imports/:jobId/start

Queues the staged job for inventory and commit.

### POST /api/sources/imports/:jobId/pause

Requests a pause at the next bounded worker checkpoint.

### POST /api/sources/imports/:jobId/resume

Resumes a paused job.

### POST /api/sources/imports/:jobId/retry

Retries interrupted or retryable records in a job.

### POST /api/sources/imports/:jobId/cancel

Cancels a job and terminalizes remaining pending records.

### GET /api/sources/imports/:jobId/rejections

Lists rejected records and bounded rejection codes.

### GET /api/sources/imports/:jobId/reconciliation

Returns the durable status-count reconciliation.

The only accepted adapter is `signet-export` version `1` (`source: "signet"`).
Each line is classified exactly once as `imported`, `duplicate`, or `rejected`;
blank lines are counted separately. Validation rejects malformed JSON, unknown
roles, count mismatches, missing/nonempty-invalid messages, invalid timestamps,
and records over 16 MiB or messages over 4 MiB. The hard limits are 25 records
per database batch, 8 MiB canonical batch, 50,000 messages, and one active
job/file. The response counters satisfy `total = imported + duplicate +
rejected + pending` while a job is active and `pending = 0` when terminal.

Imported transcripts preserve message roles (`user`, `assistant`, `system`,
`tool`, `unknown`), exact content whitespace and newlines, project, and the
historical timestamp. The selected target agent owns the rows; embedded
`agent_id` is provenance only. Source identity and content fingerprints make
same-identity replay a duplicate and same-identity/different-content a
`conversation_identity_conflict` rejection. Staging is an fsynced managed JSONL
file under `imports/transcripts/<source-id>/`; canonical harness files and
`session_transcripts` are written with deterministic IDs. Recovery resumes byte
checkpoints and replays filesystem writes idempotently before finalizing DB
ownership.

Removing an import Source purges its staged file, canonical lines,
`session_transcripts`, artifacts, indexes, aggregates, and consumption/review
rows. Bounded record fingerprints and audit tombstones remain. Derived
knowledge is marked unsupported/stale and reviewed by the normal Dreaming path;
transcript import creates one attention nudge per committed source batch, not
one Dreaming job per conversation.

**Create response**

```json
{ "id": "job-uuid", "jobId": "job-uuid", "agentId": "target", "state": "staging" }
```

**Reconciliation response**

```json
{ "jobId": "job-uuid", "reconciliation": [{ "status": "imported", "count": 42 }] }
```

**Response**

```json
{
  "imported": 1,
  "failed": 0,
  "files": [
    {
      "fileName": "export.json",
      "status": "imported",
      "sourceId": "import:abc123",
      "format": "json",
      "duplicate": false,
      "extraction": {
        "documentEntityId": "entity-abc123",
        "aspectsCreated": 2,
        "attributesCreated": 3
      }
    }
  ]
}
```

For an imported result, `extraction` reports the graph rows created by the
source-artifact extraction transaction. A duplicate result also includes the
current persisted extraction counts when the existing source has a linked
document entity. Failed results omit `extraction` and retain their structured
error. Older daemons may omit this object; clients should show an unavailable
state rather than infer zero counts.

### POST /api/sources/pick-files

Open the native multi-file picker on a local desktop daemon. This endpoint is
loopback-only and returns filesystem paths for a subsequent `paths`-based import.
On macOS, it returns `501` immediately with actionable guidance when no Aqua GUI
session or Automation permission is available. A remote client must upload bytes
through `POST /api/sources/import` instead.

**Response**

```json
{
  "paths": ["/home/user/Downloads/export.json"]
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

When a source artifact is indexed but its embedding provider is unavailable,
`GET /api/sources` exposes `indexJob.statusMessage` as
`"embeddings pending - provider down"` while embeddings wait for a bounded
retry window.

Each source may also expose an `indexJob` while its source scan is queued,
running, complete, paused, or failed. A paused job is a partial scan stopped
because the provider is unavailable. Its `partial` field is `true`, and
`scanned` and `indexed` report the counts reached before the pause, including
zero when the provider was unavailable before the first file. `pauseReason`
identifies the cause, and `resumeFrontier` is the file path from which the next
scan resumes, or `null` when no file was checkpointed. A paused scan does not
update the source's `lastIndexedAt`.

```json
{
  "indexJob": {
    "status": "paused",
    "partial": true,
    "scanned": 2,
    "indexed": 1,
    "pauseReason": "provider_unavailable",
    "resumeFrontier": "/home/user/ObsidianVault/permanent/Next.md"
  }
}
```

<a id="post-api-sources-discord"></a>

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
  "includeAttachmentText": false,
  "maxAttachmentTextBytes": 262144,
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

For live gateway tailing:

```json
{
  "guildIds": ["123456789012345678"],
  "tokenRef": "DISCORD_BOT_TOKEN",
  "name": "Team Discord Tail",
  "syncMode": "gateway-tail"
}
```

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
metadata, optional bounded text-like attachment contents, embeds, polls,
checkpoints, and partial-failure artifacts. Partial Discord listings are not
used as authoritative deletes. Attachment text extraction is opt-in and skips
binary/media uploads by default.

The gateway-tail sync path keeps the shared source job open while it listens for
Discord gateway events. It indexes message create/update/delete lifecycle
events, deleted-message tombstones, channel/thread upserts, member upserts,
member removals, and per-channel tail checkpoints. Canceling or removing the
source closes the gateway connection.

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
    "semantic": {
      "entities": 12,
      "aspects": 3,
      "attributes": 4,
      "dependencies": 6,
      "communities": 2,
      "total": 27,
      "documentEntityId": "entity-abc123"
    }
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
`501` when no OS picker command is available or when macOS has no active Aqua
GUI session or Automation permission. The error explains how to run the desktop
app in a logged-in session or configure a picker override.

**Request body**

```json
{ "title": "Choose Obsidian vault" }
```

**Response**

```json
{ "path": "/home/user/ObsidianVault" }
```
