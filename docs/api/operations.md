---
title: "Operations API"
description: "Git sync, updates, diagnostics, repair, and pipeline operation endpoints."
order: 18
section: "Reference"
---

# Operations API

Git sync, updates, diagnostics, repair, and pipeline operation endpoints.

[Back to HTTP API overview](../API.md).

## Git

The git API manages optional automatic commit and sync of the `$SIGNET_WORKSPACE/` directory.
Config is loaded from `agent.yaml` under the `git` key. Defaults: `autoCommit:
false`, `autoSync: false`, `syncInterval: 300s`, `remote: origin`,
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
  "autoCommit": false,
  "autoSync": false,
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
  "autoCommit": true,
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


## Update

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
  "currentVersion": "0.124.5",
  "latestVersion": "0.124.4",
  "updateAvailable": true,
  "releaseUrl": "https://github.com/Signet-AI/signetai/releases/tag/v0.124.4",
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
  "channel": "stable",
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
  "checkInterval": 43200,
  "channel": "nightly"
}
```

`checkInterval` must be between 300 and 604800 seconds. `channel` must be `stable` or `nightly`.

**Response**

```json
{
  "success": true,
  "config": { "autoInstall": true, "checkInterval": 43200, "channel": "nightly" },
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
  "installedVersion": "0.110.0",
  "restartRequired": true
}
```

If already up to date, returns `success: true` with a message indicating no
update is needed.


## Diagnostics

Requires `diagnostics` permission.

### GET /api/diagnostics

Full diagnostic report across all domains. Includes a composite health score
derived from queue, storage, index, provider, mutation, duplicate, connector,
update, and graph health. `storage.dbSizeBytes` is computed from SQLite page
metadata. When graph is enabled, `graph.status` is included in composite status
so a flatlined knowledge graph cannot be hidden behind otherwise healthy
storage and index signals. `graph.extractionWritesEnabled` reports whether the
background extractor is allowed to persist extracted entities into the graph.

**Response** — a multi-domain report object. Domains include `queue`,
`storage`, `index`, `provider`, `mutation`, `duplicate`, `connector`, `update`,
`graph`, `openclaw`, and `composite`. The `composite` field looks like:

```json
{ "score": 0.95, "status": "healthy" }
```

### GET /api/diagnostics/:domain

Diagnostic data for a single domain. Known domains include `queue`, `storage`,
`index`, `provider`, `mutation`, `duplicate`, `connector`, `update`, `graph`,
`openclaw`, and `composite`.

Returns `400` for unknown domains.

### GET /api/diagnostics/database/schema

Read-only SQLite schema explorer data for the dashboard database table view.
Returns live table metadata grouped by conceptual area, with row counts,
columns, indexes, foreign keys, and whether sample rows are available.

**Response**

```json
{
  "generatedAt": "2026-05-15T12:00:00.000Z",
  "groups": { "core": 8, "provenance": 6, "runtime": 12, "internal": 3, "other": 1 },
  "tables": [
    {
      "name": "entities",
      "group": "core",
      "kind": "table",
      "rowCount": 42,
      "sampleAllowed": true,
      "columns": [
        { "cid": 0, "name": "id", "type": "TEXT", "notNull": false, "defaultValue": null, "primaryKey": true }
      ],
      "indexes": [],
      "foreignKeys": [],
      "sql": "CREATE TABLE entities (...)"
    }
  ]
}
```

### GET /api/diagnostics/database/tables/:table/sample

Returns a bounded read-only sample for a validated table name. The daemon
derives valid table names from SQLite metadata before constructing SQL.
Internal index and virtual tables can return `400` with an explanatory error.

Query parameters:

| Name | Default | Notes |
|------|---------|-------|
| `limit` | `25` | Clamped to `1..100`. |
| `offset` | `0` | Clamped to non-negative values. |

**Response**

```json
{
  "table": "entities",
  "columns": ["id", "name", "entity_type"],
  "rows": [{ "id": "entity-1", "name": "Signet", "entity_type": "system" }],
  "limit": 25,
  "offset": 0,
  "rowCount": 42,
  "hasMore": true
}
```


## Repair

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
if pipeline workers crashed and left jobs locked. Stale jobs that still have
remaining retries are returned to `pending`. Stale jobs that have already
reached `max_attempts` are moved to `dead` instead of being requeued again.

**Response**

```json
{
  "action": "releaseStaleLeases",
  "success": true,
  "affected": 3,
  "message": "released 2 stale lease(s) back to pending and dead-lettered 1 exhausted job(s)"
}
```

### POST /api/repair/check-fts

Check FTS5 index consistency against the memories table and detect legacy
tokenizer drift. Optionally repair mismatches by rebuilding the index or
recreating `memories_fts` with the canonical `unicode61` tokenizer.

**Request body** (optional)

```json
{ "repair": true }
```

**Response**

```json
{ "action": "checkFtsConsistency", "success": true, "affected": 0, "message": "..." }
```

### POST /api/repair/retention-sweep

Trigger a bounded retention cleanup sweep immediately. This purges expired
tombstones, old history rows, expired completed/dead jobs, orphaned graph links,
and orphaned embeddings without waiting for the retention worker interval.
Requires `admin` permission.

**Response**

```json
{
  "action": "retention_sweep",
  "success": true,
  "affected": 3,
  "message": "retention sweep completed; 3 row(s) purged",
  "details": {
    "tombstones": 1,
    "history": 1,
    "completedJobs": 1
  }
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

### POST /api/repair/clean-orphans

Remove embedding rows that reference memories which no longer exist.
Rate-limited. Requires `admin` permission.

**Response**

```json
{
  "action": "cleanOrphanedEmbeddings",
  "success": true,
  "affected": 12,
  "message": "cleaned 12 orphaned embeddings"
}
```

### GET /api/repair/dedup-stats

Returns statistics on potential duplicate memories (by content hash).
Requires `admin` permission.

**Response** — object with duplicate counts and affected memory IDs.

### POST /api/repair/deduplicate

Deduplicate memories by content hash and optionally by semantic similarity.
Rate-limited. Requires `admin` permission.

**Request body**

```json
{
  "batchSize": 50,
  "dryRun": false,
  "semanticEnabled": false,
  "semanticThreshold": 0.95
}
```

All fields are optional. `dryRun: true` reports what would be deduplicated
without making changes. `semanticEnabled` adds vector-similarity dedup on
top of hash-based dedup.

**Response**

```json
{
  "action": "deduplicateMemories",
  "success": true,
  "affected": 7,
  "message": "deduplicated 7 memories"
}
```


## Pipeline

### GET /api/pipeline/status

Composite pipeline status snapshot for dashboard visualization. Returns
worker status, job queue counts (memory and summary), diagnostics, latency
histograms, error summary, and the current pipeline mode.

Known `mode` values: `controlled-write`, `shadow`, `frozen`, `paused`,
`disabled`.

**Response**

```json
{
  "workers": { ... },
  "queues": {
    "memory": { "pending": 3, "leased": 1, "completed": 200, "failed": 0, "dead": 0 },
    "summary": { "pending": 0, "leased": 0, "completed": 5, "failed": 0, "dead": 0 }
  },
  "diagnostics": { ... },
  "latency": { ... },
  "errorSummary": { ... },
  "mode": "controlled-write"
}
```

Mode is one of: `disabled`, `frozen`, `shadow`, `paused`, `controlled-write`.

### POST /api/pipeline/pause

Pause the extraction runtime in-place without restarting the daemon.
Requires `admin` permission and uses the admin rate limit bucket.

Returns `409` if another pause/resume transition is already running.

**Response**

```json
{
  "success": true,
  "changed": true,
  "paused": true,
  "file": "/home/user/.agents/agent.yaml",
  "mode": "paused"
}
```

### POST /api/pipeline/resume

Resume the extraction runtime in-place without restarting the daemon.
Requires `admin` permission and uses the admin rate limit bucket.

**Response**

```json
{
  "success": true,
  "changed": true,
  "paused": false,
  "file": "/home/user/.agents/agent.yaml",
  "mode": "controlled-write"
}
```

`changed` is `false` when the persisted pause flag already matches the
requested state.
