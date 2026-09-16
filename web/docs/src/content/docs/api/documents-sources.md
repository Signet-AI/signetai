---
title: "Documents and sources API"
description: "Document ingestion, external sources, and durable transcript imports."
---

Reference for document ingestion and source-backed evidence. Routes are scoped to
the daemon's resolved agent. Protected deployments apply the permission named
below; loopback-only picker routes also require a local request.

[Back to HTTP API overview](/api/).

## Documents

All document routes require `documents` permission.

### POST /api/documents

Queues a document for extraction, chunking, embedding, and indexing. JSON body:
`source_type` (`text`, `url`, or `file`) plus the fields required by that type;
`content`, `url`, `title`, `content_type`, `connector_id`, and `metadata` are
accepted by the registered handler. New work returns `201`; a duplicate in the
same agent/project scope returns the existing document with `deduplicated: true`.
The response contains `id`, `status`, and, when queued, `jobId`.

### GET /api/documents

Lists documents. Query: `status`, `limit`, and `offset`. The response contains
`documents`, `total`, `limit`, and `offset`; each item is a persisted document
row.

### GET /api/documents/:id

Returns one document row, or `404` when it is absent or outside the resolved
scope.

### GET /api/documents/:id/chunks

Returns derived chunks as `{ chunks, count }`. Each chunk includes its memory
identifier, content, chunk index, and source/document provenance.

### DELETE /api/documents/:id

Requires a deletion `reason` (query or request body). Marks the document deleted
and removes only derived memories that have no other live document reference.
Shared derived memories remain. The response reports `{ deleted,
memoriesRemoved }`; `memoriesRemoved` counts memories actually tombstoned, not
links.

## Configured sources

Source routes require `sources` permission. Supported kinds are `obsidian`,
`discord`, `github`, `web`, and `import`.

### GET /api/sources

Lists visible configured sources and index/health data. The envelope contains
`version` and `sources`. Source entries expose `id`, `kind`, configuration,
`enabled`, timestamps, index statistics, and health. Health may include
`permission`, `failures`, `checkpoints`, `purge`, `semantic`, and an
`indexJob`; unavailable extraction data is omitted, not reported as zero.

### POST /api/sources/obsidian

Adds or updates a read-only Obsidian source and queues indexing. Body uses
`path` (or `root`), optional `name`, and `excludeGlobs`. Response status is
`202` with `{ source, created, indexed: 0, queued: true, job }`.

### POST /api/sources/discord

Adds or updates a Discord source and queues indexing. Body supports the
registered Discord configuration, including `guildIds`/`guildId`,
`channelFilter`/`channels`, `tokenRef`, `syncMode`, and bounded inclusion
options. Raw tokens are rejected. `desktop-cache` is observational and does
not reconcile deletes from missing cache files; `gateway-tail` records delete
tombstones and closes on cancellation/removal. Response status is `202` with
the same source/job envelope.

### POST /api/sources/github

Adds or updates a GitHub source and queues indexing. Body supports `repos`/`repo`,
`tokenRef`, `resourceTypes`, `state`, `includeComments`, `labels`, `docPaths`,
and `maxItemsPerRepo`. Raw tokens are rejected. Response status is `202` with
the source/job envelope.

### POST /api/sources/web

Adds or updates a web source and queues indexing. JSON body requires `url` and
may include `name`. Response status is `202` with `{ source, created, indexed,
queued, job }`.

### GET /api/sources/:sourceId/health

Returns the source configuration, stats, and the health object used by the list
route. Diagnostic failure is represented by `health.status: "unhealthy"` and an
`error` field; it is not converted to healthy output.

### DELETE /api/sources/:sourceId

Removes the source configuration and purges Signet-owned rows and embeddings.
The response is `{ source, purged }`. Deletion is source-kind-specific:

- `obsidian`, `discord`, `github`, and `web` purge source artifacts, chunks,
  indexes, aggregates, and provider-owned state. Original external data is not
  modified. Partial listings/cache absence is not treated as an authoritative
  delete.
- `import` removes retained imported artifacts and raw transcript chunks,
  `session_transcripts`, indexes, aggregates, and consumption/review rows.
  Fingerprints and audit tombstones remain; derived knowledge is marked
  unsupported/stale for Dreaming review.

A deletion tombstone remains while purge/index work is in flight so a retry can
finish cleanup. Cross-agent or invisible source IDs return `404`.

### GET /api/sources/:sourceId/snapshot

Exports source-owned artifacts and provenance. `includeLocalDiscord` defaults to
`false`; local Discord `@me` artifacts are omitted unless explicitly included.

### POST /api/sources/:sourceId/snapshot/import

Imports the snapshot JSON into an existing source using the normal artifact
upsert path. The response reports `ok`, `imported`, and skipped local Discord
artifacts.

### POST /api/sources/import

Multipart importer for files (`files`, or loopback-only `paths`) with optional
`duplicateMode` (`skip`, `replace`, `reimport`). Each file returns an individual
result; the envelope reports imported/failed counts and structured errors.
This is distinct from durable transcript import.

### POST /api/sources/pick-files

Loopback-only native file picker. Returns `{ paths }`, or `501` when no permitted
local picker is available.

### POST /api/sources/pick-directory

Loopback-only directory picker. Body may contain `title`; returns `{ path }`, or
`501` when unavailable.

## Durable transcript imports

All transcript-import routes require `modify` permission and reject a supplied
`agentId` that does not equal the daemon's resolved target agent.

### POST /api/sources/imports
Creates a job; response includes `id`, `jobId`, `agentId`, and `state`.

### GET /api/sources/imports
Lists jobs for the resolved agent.

### GET /api/sources/imports/:jobId
Returns a job and files, including `upload_offset`, `upload_generation`,
`upload_size`, and `upload_digest`.

### PUT /api/sources/imports/:jobId/files/:fileId
Compatibility whole-file upload. Requires `upload-length` or `content-length`.

### PATCH /api/sources/imports/:jobId/files/:fileId
Resumable upload. Uses `upload-length`, `upload-offset`,
`upload-generation`, and per-request SHA-256 `upload-checksum`; response
acknowledges the durable offset.

### POST /api/sources/imports/:jobId/files/:fileId/finalize
Verifies and seals a complete upload, then registers the source idempotently.

### POST /api/sources/imports/:jobId/files/:fileId/reset
Discards an incomplete upload and advances its generation.

### GET /api/sources/imports/:jobId/files/:fileId/content
Streams exact retained bytes of a sealed file.

### POST /api/sources/imports/:jobId/start
Queues a staged job.

### POST /api/sources/imports/:jobId/pause
Invalidates the worker lease; response reports whether state changed.

### POST /api/sources/imports/:jobId/resume
Resumes a paused job.

### POST /api/sources/imports/:jobId/retry
Retries retryable records.

### POST /api/sources/imports/:jobId/cancel
Cancels processing and reports cleanup state and partial counters.

### GET /api/sources/imports/:jobId/rejections
Lists rejected records; use the returned cursor for the next page.

### GET /api/sources/imports/:jobId/reconciliation
Returns durable status counts. Active jobs expose pending work; completed jobs
set pending to zero.

### GET /api/sources/imports/export/transcripts
Streams conversation JSONL (or JSON with `json=true`) with `harness`, `since`,
`until`, `limit`, `offset`, and `messagesOnly` filters.
