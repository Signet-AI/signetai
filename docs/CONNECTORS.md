Connectors
==========

Connectors let Signet pull content from external sources — local
filesystems, documentation repos, cloud drives — and ingest that
content into the memory store as searchable documents. Each connector
follows a consistent register-sync-health lifecycle managed through
the daemon's HTTP API.

The connector framework lives in `packages/daemon/src/connectors/`.
Type definitions are in `packages/core/src/connector-types.ts`.


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


Cursor-Based State
------------------

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
single write transaction.

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
`@signet/core`:

```typescript
import type { ConnectorRuntime, ConnectorConfig, SyncCursor,
              SyncResult, ConnectorResource } from "@signet/core";

class MyConnector implements ConnectorRuntime {
  readonly id: string;
  readonly provider = "github-docs" as const;

  constructor(config: ConnectorConfig) {
    this.id = config.id;
    // parse config.settings here
  }

  async authorize(): Promise<{ ok: boolean; error?: string }> {
    // validate credentials / connectivity
    return { ok: true };
  }

  async listResources(cursor?: string): Promise<{
    resources: readonly ConnectorResource[];
    nextCursor?: string;
  }> {
    // return paginated resource list
    return { resources: [] };
  }

  async syncIncremental(cursor: SyncCursor): Promise<SyncResult> {
    // fetch resources changed since cursor.lastSyncAt
    return {
      documentsAdded: 0,
      documentsUpdated: 0,
      documentsRemoved: 0,
      errors: [],
      cursor: { lastSyncAt: new Date().toISOString() },
    };
  }

  async syncFull(): Promise<SyncResult> {
    // fetch and process all resources
    return {
      documentsAdded: 0,
      documentsUpdated: 0,
      documentsRemoved: 0,
      errors: [],
      cursor: { lastSyncAt: new Date().toISOString() },
    };
  }

  async replay(resourceId: string): Promise<SyncResult> {
    // reprocess a single resource by id
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

Once implemented, wire the factory into the sync routes in
`packages/daemon/src/daemon.ts` where `createFilesystemConnector` is
called, and add the new provider string to `CONNECTOR_PROVIDERS` in
`packages/core/src/connector-types.ts`.

The `provider` field in the API request body must match a value in the
`CONNECTOR_PROVIDERS` tuple, or the register endpoint returns `400`.
