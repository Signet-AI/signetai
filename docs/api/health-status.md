---
title: "Health and status API"
description: "Health, status, and runtime feature endpoints."
order: 11
section: "Reference"
---

# Health and status API

Health, status, and runtime feature endpoints.

[Back to HTTP API overview](../API.md).

## Health & Status

### GET /health

No authentication required. Legacy health check retained for backward
compatibility. New integrations should prefer `GET /health/live` for liveness
and `GET /health/ready` for readiness.

**Response**

```json
{
  "status": "healthy",
  "uptime": 3600.5,
  "pid": 12345,
  "version": "0.124.5",
  "port": 3850,
  "agentsDir": "/home/user/.agents",
  "db": true,
  "shuttingDown": false,
  "updateAvailable": false,
  "pendingRestart": false,
  "pipeline": {
    "extractionRunning": true,
    "extractionStalled": false,
    "extractionPending": 0,
    "extractionBackoffMs": 0
  },
  "resources": { "...": "..." }
}
```

### GET /health/live

No authentication required. Cheap liveness probe: reports that the daemon
process is up and serving HTTP. It never touches the database or any
subsystem, and always returns 200 while the process is alive.

**Response** (always 200)

```json
{
  "status": "healthy",
  "uptime": 3600.5,
  "pid": 12345,
  "version": "0.124.5",
  "port": 3850,
  "shuttingDown": false
}
```

`status` is `"healthy"`, or `"shutting_down"` once shutdown has begun.

### GET /health/ready

No authentication required. Readiness probe: reports whether the daemon can
actually serve work. Returns 200 only when every gate passes, otherwise 503
with a human-readable `reasons` list. Gates:

- `db` — a readonly database connection answers `SELECT 1`.
- `migrations` — no pending database migrations.
- `embedding` — the configured embedding provider is reachable. Passes with
  `note: "disabled"` when the provider is intentionally `"none"`.
- `inference` — the extraction route is not fully `blocked`; a `degraded`
  route still passes readiness.
- `queue` — durable queue depth, dead-letter rate, and oldest pending job age
  are within thresholds. Becomes `{ "error": "database unavailable" }` when
  the database check fails.

**Response** (200 when ready)

```json
{
  "status": "ready",
  "version": "0.124.5",
  "shuttingDown": false,
  "checks": {
    "db": true,
    "migrations": true,
    "embedding": {
      "provider": "ollama",
      "available": true,
      "checkedAt": "2026-02-21T10:00:00.000Z"
    },
    "inference": {
      "status": "active",
      "configured": "ollama",
      "effective": "ollama",
      "reason": null
    },
    "queue": {
      "score": 1,
      "status": "healthy",
      "depth": 0,
      "oldestAgeSec": 0,
      "deadRate": 0,
      "leaseAnomalies": 0
    }
  },
  "reasons": []
}
```

**Response** (503 when not ready) — same shape, with `status: "not_ready"`
and one entry per failing gate in `reasons`:

```json
{
  "status": "not_ready",
  "version": "0.124.5",
  "shuttingDown": false,
  "checks": {
    "db": true,
    "migrations": false,
    "embedding": { "provider": "none", "available": true, "note": "disabled" },
    "inference": {
      "status": "active",
      "configured": "ollama",
      "effective": "ollama",
      "reason": null
    },
    "queue": {
      "score": 1,
      "status": "healthy",
      "depth": 0,
      "oldestAgeSec": 0,
      "deadRate": 0,
      "leaseAnomalies": 0
    }
  },
  "reasons": ["pending migrations"]
}
```

### GET /api/status

Full daemon status including pipeline config, embedding provider, and a
composite health score derived from diagnostics. Extraction provider
runtime resolution persists startup degradation so operators can detect
silent fallback or hard-blocked extraction after boot.

**Response**

```json
{
  "status": "running",
  "version": "0.124.5",
  "pid": 12345,
  "uptime": 3600.5,
  "startedAt": "2026-02-21T10:00:00.000Z",
  "port": 3850,
  "host": "127.0.0.1",
  "bindHost": "127.0.0.1",
  "networkMode": "localhost",
  "agentId": "default",
  "agentsDir": "/home/user/.agents",
  "memoryDb": true,
  "pipelineV2": {
    "enabled": true,
    "paused": false,
    "shadowMode": false,
    "mutationsFrozen": false,
    "graph": {
      "enabled": true,
      "extractionWritesEnabled": true
    },
    "autonomous": {
      "enabled": true,
      "allowUpdateDelete": true
    },
    "extraction": {
      "provider": "llama-cpp",
      "model": "qwen3:4b"
    }
  },
  "pipeline": {
    "extraction": {
      "running": true,
      "overloaded": false,
      "loadPerCpu": 0.42,
      "maxLoadPerCpu": 0.8,
      "overloadBackoffMs": 30000,
      "overloadSince": null,
      "nextTickInMs": 1200
    }
  },
  "providerResolution": {
    "extraction": {
      "configured": "llama-cpp",
      "resolved": "llama-cpp",
      "effective": "llama-cpp",
      "fallbackProvider": "llama-cpp",
      "status": "active",
      "degraded": false,
      "fallbackApplied": false,
      "reason": null,
      "since": null
    }
  },
  "logging": {
    "logDir": "/home/user/.agents/.daemon/logs",
    "logFile": "/home/user/.agents/.daemon/logs/signet-2026-04-29.log"
  },
  "activeSessions": 1,
  "bypassedSessions": 1,
  "agentCreatedAt": "2026-02-21T10:00:00.000Z",
  "transcripts": {
    "capture": { "pending": 0, "processing": 0, "failed": 0, "dead": 0 }
  },
  "health": { "score": 0.97, "status": "healthy" },
  "update": {
    "currentVersion": "0.124.5",
    "latestVersion": null,
    "updateAvailable": false,
    "pendingRestart": null,
    "autoInstall": false,
    "checkInterval": 21600,
    "lastCheckAt": null,
    "lastError": null,
    "timerActive": true
  },
  "embedding": {
    "provider": "ollama",
    "model": "nomic-embed-text",
    "available": true
  }
}
```

The `bypassedSessions` field reports how many active sessions currently have
bypass enabled (see [Sessions and hooks API](./sessions-hooks.md#sessions)).
Monitor `providerResolution.extraction.status` for `degraded` or `blocked`
states when the configured extraction provider is unavailable or routed to a
fallback target.
When `pipeline.extraction.overloaded` is `true`, the extraction worker is
intentionally backing off for `overloadBackoffMs` between polls.
`transcripts.capture` exposes compact durable transcript-capture queue counts;
use `GET /api/diagnostics/transcripts` for detailed artifact/audit diagnostics.
Use `GET /api/inference/status` for the shared inference control plane status.


### GET /api/diagnostics/queue

Per-queue counts (memory / summary / extraction), oldest-dead job
references, and threshold metadata. Backend path uses the same shared
threshold constants that `GET /api/status` and `/health/ready` consume.

Admin permission required.

**Response**

```json
{
  "timestamp": "2026-07-19T00:00:00.000Z",
  "queues": {
    "memory":     { "pending": 0, "leased": 0, "completed": 1, "failed": 0, "dead": 1667, "oldestAgeSec": 0, "oldestDeadAgeSec": 5.4e6, "lastError": null },
    "summary":    { "pending": 0, "leased": 0, "completed": 92,  "failed": 0, "dead": 1667, "oldestAgeSec": 0, "oldestDeadAgeSec": 5.4e6, "lastError": "boom" },
    "extraction": { "pending": 0, "leased": 0, "completed": 1,  "failed": 0, "dead": 0,    "oldestAgeSec": 0, "oldestDeadAgeSec": 0,    "lastError": null }
  },
  "oldestDeadSummaryJob":    { "id": "...", "harness": "codex", "sessionKey": "...", "createdAt": "...", "attempts": 3, "error": "boom" },
  "oldestDeadMemoryJob":     { "...": "..." },
  "oldestDeadExtractionJob": { "...": "..." },
  "thresholds": {
    "summaryDeadWarn": 50, "summaryDeadFail": 500,
    "summaryOldestPendingWarnSec": 300, "summaryOldestPendingFailSec": 1800,
    "summaryOldestDeadWarnSec": 86400,
    "memoryDeadWarn": 50, "memoryDeadFail": 500,
    "memoryOldestPendingWarnSec": 300, "memoryOldestPendingFailSec": 1800,
    "extractionDeadWarn": 10, "extractionDeadFail": 100
  }
}
```

Counts default to `0` and `null` if a table does not exist on the running
database (older installs before the
`summary_jobs` migration landed).


### POST /api/diagnostics/queue/repair

Dispatches a queue repair action. Admin permission required. The body
shape covers `requeue` (extending `requeueDeadJobs`), `cancel`
(audit-preserving soft cancel into `job_cancellations`), and `prune`
(archive-preserving hard delete into `job_archive`).

**Request body**

```json
{
  "action": "cancel",
  "dryRun": true,
  "tables": ["summary"],
  "olderThanMs": 2592000000,
  "errorPattern": "timeout"
}
```

- `action` — one of `requeue`, `cancel`, `prune`.
- `dryRun` — boolean; defaults to `true` (safe preview).
- `ids` — optional array of row ids; bypasses filter for max precision.
- `tables` — optional array of `memory` and/or `summary` (default: both).
- `olderThanMs` — only match rows whose `created_at` is older than `now - olderThanMs`.
- `errorPattern` — optional `LIKE %pattern%` over the `error` column.
- `retentionMs` — optional override for `prune`'s default 90-day window.
- `maxBatch` — optional hard cap on rows touched (default: 50 for
  requeue; 1000 for cancel/prune).

**Response**

```json
{
  "action": "cancelObsoleteJobs",
  "success": true,
  "affected": 0,
  "message": "dry-run: 1667 job(s) match cancel filter; preview shows 100",
  "preview": ["summary_jobs:abc", "summary_jobs:def"],
  "totalMatching": 1667
}
```

Both queue endpoints require the `admin` permission in authenticated modes.
When the policy gate denies an action, the response carries `success: false`
and HTTP `429` (cooldown active / hourly budget exhausted / agents without
`autonomous.enabled`). Wrong `action` values or malformed JSON return `400`.
Cancel and prune apply requests require migrations 089 and 090; neither daemon
creates audit tables from the request path, and a missing table is reported as
a migration error.


### GET /api/features

Returns all runtime feature flags.

**Response**

```json
{
  "featureName": true,
  "anotherFeature": false
}
```
