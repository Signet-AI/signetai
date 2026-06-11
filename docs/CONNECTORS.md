---
title: "Connectors"
description: "Platform-specific connector framework."
order: 14
section: "Reference"
---

Connectors
==========

Connectors let Signet pull content from external sources — local
filesystems, documentation repos, cloud drives — and ingest that
content into the memory store as searchable [[documents]]. Each connector
follows a consistent register-sync-health lifecycle managed through
the [[daemon]]'s [[api|HTTP API]].

The connector framework lives in `platform/daemon/src/connectors/`.
Type definitions are in `platform/core/src/connector-types.ts`.


Overview
--------

When a connector is registered, the daemon persists a row in the
`connectors` SQLite table and assigns it a UUID. From that point on,
sync operations can be triggered on demand. Each sync walk produces
`documents` rows, which are picked up by the document ingest pipeline
for chunking, embedding, and indexing into memory.

Connectors do not run on a schedule by default. You trigger syncs
explicitly via the API, or wire them into your own automation.

The document pipeline stages after ingest: `queued` → `extracting` →
`chunking` → `embedding` → `indexing` → `done`. Failures land at
`failed` with an error field on the document row.


Connector Status States
-----------------------

Every connector has a `status` field that tracks its current state.
The possible values (from `CONNECTOR_STATUSES` in
`platform/core/src/connector-types.ts`):

| Status | Description |
|--------|-------------|
| `idle` | Default state. The connector is registered and ready to sync. |
| `syncing` | A sync operation is in progress. |
| `error` | The last sync threw an unhandled exception. Check `last_error`. |

Status transitions:

```
idle → syncing → idle       (successful sync)
idle → syncing → error      (sync threw an exception)
error → syncing → idle      (next sync succeeds)
```

The `status` field is updated via `updateConnectorStatus()` in
`platform/daemon/src/connectors/registry.ts`.


Connector Lifecycle
-------------------

**Register.** POST a provider type and settings to create a new
connector. The daemon validates the provider name and stores a config
row. The connector starts in `idle` status.

**Sync (incremental).** POST to `/:id/sync` to process only resources
that have changed since the last successful sync. The stored
`sync_cursor` (a JSON blob with `lastSyncAt`) determines the cutoff.
This is the normal sync path — fast, low I/O.

**Sync (full).** POST to `/:id/sync/full?confirm=true` to reprocess
every matching resource regardless of the cursor. Requires the
`?confirm=true` query parameter as a guard against accidental
re-ingestion. Use this when you want to force re-embedding of existing
content.

**Replay.** Force-reprocess a single named resource without touching
the cursor or other documents. Useful for debugging a specific file.
(WIP — the `replay()` method exists on `ConnectorRuntime` but is not
yet exposed via an HTTP endpoint.)

**Health.** GET `/:id/health` returns current status, last sync
timestamp, any last error, and a live document count sourced from the
`documents` table.

**Unregister.** DELETE `/:id` removes the connector row. Pass
`?cascade=true` to also delete associated document rows.


API Endpoints
-------------

All write endpoints (`POST`, `DELETE`) require the `admin` permission.
`GET` endpoints are publicly accessible on the local daemon.

### List connectors

```
GET /api/connectors
```

Response:

```json
{
  "connectors": [
    {
      "id": "b3a2...",
      "provider": "filesystem",
      "display_name": "My Docs",
      "status": "idle",
      "last_sync_at": "2026-02-20T14:00:00.000Z",
      "last_error": null,
      "cursor_json": "{\"lastSyncAt\":\"2026-02-20T14:00:00.000Z\"}",
      "created_at": "2026-02-01T10:00:00.000Z",
      "updated_at": "2026-02-20T14:00:01.000Z"
    }
  ],
  "count": 1
}
```

### Register a connector

```
POST /api/connectors
Content-Type: application/json
```

Request body:

```json
{
  "provider": "filesystem",
  "displayName": "My Docs",
  "settings": {
    "rootPath": "/home/user/docs",
    "patterns": ["**/*.md", "**/*.txt"],
    "maxFileSize": 1048576
  }
}
```

`provider` must be one of: `filesystem`, `github-docs`, `gdrive`.
`settings` is passed through to the connector implementation as-is.

Response (`201 Created`):

```json
{ "id": "b3a2c4d5-..." }
```

### Get connector details

```
GET /api/connectors/:id
```

Returns the full `ConnectorRow` object.

### Trigger incremental sync

```
POST /api/connectors/:id/sync
```

Returns immediately. The sync runs in the background.

Response:

```json
{ "status": "syncing" }
```

If the connector is already syncing, returns `200` with the same body
rather than starting a duplicate run.

### Trigger full resync

```
POST /api/connectors/:id/sync/full?confirm=true
```

The `?confirm=true` parameter is required. Without it the endpoint
returns `400`. The sync runs in the background; poll the health
endpoint to track completion.

### Connector health

```
GET /api/connectors/:id/health
```

Response:

```json
{
  "id": "b3a2...",
  "status": "idle",
  "lastSyncAt": "2026-02-20T14:00:00.000Z",
  "lastError": null,
  "documentCount": 42
}
```

`documentCount` is a live count of documents whose `source_url` begins
with the connector's `rootPath`. It reflects the current state of the
database, not the last sync result.

### Delete a connector

```
DELETE /api/connectors/:id
DELETE /api/connectors/:id?cascade=true
```

Without `cascade`, only the connector row is removed. With
`cascade=true`, associated document rows are also deleted.

Response:

```json
{ "deleted": true }
```


Filesystem Connector
--------------------

The filesystem connector is the only built-in provider. It walks a
local directory tree using glob patterns and ingests matching files as
documents.

### Configuration

| Field | Type | Default | Description |
|---|---|---|---|
| `rootPath` | string | required | Absolute path to scan |
| `patterns` | string[] | `["**/*.md", "**/*.txt"]` | Glob patterns to match |
| `ignorePatterns` | string[] | `[".git", "node_modules", ".DS_Store"]` | Paths to exclude |
| `maxFileSize` | number | `1048576` (1 MB) | Files larger than this are skipped |

Example registration:

```bash
curl -s -X POST http://localhost:3850/api/connectors \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "filesystem",
    "displayName": "Obsidian Vault",
    "settings": {
      "rootPath": "/home/user/obsidian-vault",
      "patterns": ["**/*.md"],
      "maxFileSize": 524288
    }
  }'
```

### How it works

**authorize** checks that `rootPath` exists and is readable. If the
path is missing or permission is denied, registration still succeeds
but the first sync will fail with the error captured on the connector
row.

**listResources** runs the glob patterns against `rootPath` and returns
a flat list of matching files. Each resource has an `id` (relative
path), a `name` (basename), and an `updatedAt` (file mtime). The
listing is not paginated — all matching files are returned at once.

**syncIncremental** filters the discovered files to those whose mtime
is newer than `cursor.lastSyncAt`. Only changed files are processed.
This makes routine syncs fast even over large directory trees.

**syncFull** processes every matching file unconditionally, setting
`forceUpdate: true`. Existing document rows are reset to `queued` and
re-enqueued for the ingest pipeline.

**replay** reprocesses a single file identified by its relative path
(as returned by `listResources`). Useful for manually re-ingesting a
specific document without touching anything else.

For each file processed, the connector either inserts a new `documents`
row or updates the existing one (matched by `source_url`, which is the
absolute file path). After writing, it enqueues a `document_ingest`
job. The ingest pipeline handles chunking, embedding, and indexing
from that point on.

Files that cannot be read, or that exceed `maxFileSize`, produce a
`SyncError` entry in the sync result rather than halting the run.


Cursor-Based Incremental Sync
------------------------------

After each successful sync, the connector's `cursor_json` column is
updated with a new `SyncCursor`:

```typescript
interface SyncCursor {
  lastSyncAt: string;    // ISO timestamp
  checkpoint?: string;   // optional opaque continuation token
  version?: number;      // optional schema version
}
```

For the filesystem connector, only `lastSyncAt` is used. The
incremental sync compares each file's mtime against this value and
skips anything older. A full sync ignores the cursor entirely but still
writes a fresh `lastSyncAt` when it completes.

The cursor is stored as JSON in the `connectors` table and updated
atomically alongside the connector's `last_sync_at` timestamp in a
single write transaction (via `updateCursor()` in `registry.ts`).

On first sync (no cursor present), `lastSyncAt` defaults to the Unix
epoch (`1970-01-01T00:00:00.000Z`), which causes all files to be
treated as new.


Error Handling
--------------

Sync errors are non-fatal by design. If a single file fails to read,
the error is captured in the `SyncResult.errors` array and the sync
continues with remaining files. The connector's `status` field stays
`"syncing"` until the entire run completes, then transitions to either
`"idle"` (success) or `"error"` (if the sync itself throws).

A per-resource `SyncError` has this shape:

```typescript
interface SyncError {
  resourceId: string;  // relative path or resource identifier
  message: string;     // human-readable reason
  retryable: boolean;  // whether replaying would likely succeed
}
```

The `last_error` column on the connector row captures the message from
any unhandled exception that aborts a sync run. Per-resource errors
within a sync are surfaced in the sync result response but do not set
`last_error`.

Polling `GET /api/connectors/:id/health` after triggering a sync is
the intended way to check completion and surface errors.


Building Custom Connectors
--------------------------

To add a new provider, implement the `ConnectorRuntime` interface from
`@signet/core`. This section walks through the full process.

### Step 1: Implement ConnectorRuntime

Create a new file in `platform/daemon/src/connectors/`:

```typescript
import type {
  ConnectorRuntime,
  ConnectorConfig,
  ConnectorResource,
  SyncCursor,
  SyncResult,
  SyncError,
} from "@signet/core";

class MyConnector implements ConnectorRuntime {
  readonly id: string;
  readonly provider = "my-provider" as const;

  private readonly settings: MySettings;

  constructor(config: ConnectorConfig) {
    this.id = config.id;
    // Parse and validate config.settings
    this.settings = parseMySettings(config.settings);
  }

  async authorize(): Promise<{ readonly ok: boolean; readonly error?: string }> {
    // Validate credentials, connectivity, or access permissions.
    // Return { ok: false, error: "reason" } if authorization fails.
    // Registration still succeeds even if authorize() fails — the
    // error surfaces on the first sync attempt.
    return { ok: true };
  }

  async listResources(cursor?: string): Promise<{
    readonly resources: readonly ConnectorResource[];
    readonly nextCursor?: string;
  }> {
    // Return a list of resources available for syncing.
    // Each resource needs: id (unique string), name, updatedAt (ISO).
    // Use cursor/nextCursor for paginated listings if needed.
    return { resources: [] };
  }

  async syncIncremental(cursor: SyncCursor): Promise<SyncResult> {
    // Fetch and process only resources changed since cursor.lastSyncAt.
    // For each resource:
    //   - Insert or update a documents row
    //   - Enqueue a document_ingest job
    //   - Track added/updated counts
    //   - Capture per-resource errors in the errors array
    return {
      documentsAdded: 0,
      documentsUpdated: 0,
      documentsRemoved: 0,
      errors: [],
      cursor: { lastSyncAt: new Date().toISOString() },
    };
  }

  async syncFull(): Promise<SyncResult> {
    // Fetch and process ALL resources regardless of cursor.
    // Same logic as syncIncremental but with forceUpdate: true.
    return {
      documentsAdded: 0,
      documentsUpdated: 0,
      documentsRemoved: 0,
      errors: [],
      cursor: { lastSyncAt: new Date().toISOString() },
    };
  }

  async replay(resourceId: string): Promise<SyncResult> {
    // Reprocess a single resource by its id.
    // Does not update the cursor.
    return {
      documentsAdded: 0,
      documentsUpdated: 0,
      documentsRemoved: 0,
      errors: [],
      cursor: { lastSyncAt: new Date().toISOString() },
    };
  }
}
```

### Step 2: Add the provider to the type system

In `platform/core/src/connector-types.ts`, add your provider string to
the `CONNECTOR_PROVIDERS` tuple:

```typescript
export const CONNECTOR_PROVIDERS = [
  "filesystem",
  "github-docs",
  "gdrive",
  "my-provider",  // ← add here
] as const;
```

This ensures the API validates the provider name at registration time.

### Step 3: Wire the factory into the daemon

In `platform/daemon/src/daemon.ts`, find where `createFilesystemConnector`
is called in the sync route handlers. Add a branch for your provider:

```typescript
function createConnectorRuntime(
  config: ConnectorConfig,
  accessor: DbAccessor,
): ConnectorRuntime {
  switch (config.provider) {
    case "filesystem":
      return createFilesystemConnector(config, accessor);
    case "my-provider":
      return createMyConnector(config, accessor);
    default:
      throw new Error(`Unknown provider: ${config.provider}`);
  }
}
```

### Step 4: Export a factory function

```typescript
export function createMyConnector(
  config: ConnectorConfig,
  accessor: DbAccessor,
): ConnectorRuntime {
  return new MyConnector(config);
}
```

### Key implementation notes

- **Document rows:** Each synced resource should map to a `documents`
  table row with a unique `source_url`. Use the existing
  `insertDocument()` / `updateDocument()` helpers from `filesystem.ts`
  as a reference, or write your own using `DbAccessor`.

- **Ingest pipeline:** After inserting or updating a document row, call
  `enqueueDocumentIngestJob(accessor, docId)` to kick off chunking and
  embedding.

- **Error resilience:** Individual resource failures should be captured
  in the `SyncResult.errors` array, not thrown. Only throw for
  unrecoverable errors that should abort the entire sync.

- **Cursor management:** The daemon handles cursor persistence — your
  connector just returns the new cursor in the `SyncResult`. The
  `updateCursor()` function in `registry.ts` writes it atomically.

- **Status updates:** The daemon's sync route handlers call
  `updateConnectorStatus()` before and after your sync methods. You
  don't need to manage status yourself.


Health Lifecycle
----------------

Connector health is tracked through the `status`, `last_sync_at`, and
`last_error` fields on the connector row.

The daemon manages these fields around sync operations:

1. **Before sync:** Status is set to `"syncing"`, `last_error` is cleared
2. **After successful sync:** Status returns to `"idle"`, cursor is updated
3. **After failed sync:** Status is set to `"error"`, `last_error` captures
   the exception message

The health endpoint (`GET /api/connectors/:id/health`) returns a
snapshot of these fields plus a live `documentCount` computed from the
`documents` table.

Health data is useful for monitoring dashboards or automation that
triggers syncs and needs to know when they complete.


Registered Providers
--------------------

The `CONNECTOR_PROVIDERS` tuple in `platform/core/src/connector-types.ts`
defines the valid provider names:

| Provider | Status | Description |
|----------|--------|-------------|
| `filesystem` | Implemented | Local directory tree ingestion |
| `github-docs` | Placeholder | GitHub repository documentation (not yet implemented) |
| `gdrive` | Placeholder | Google Drive documents (not yet implemented) |

The register endpoint returns `400` if the `provider` field doesn't
match a value in this tuple.
