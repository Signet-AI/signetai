---
title: "Health and status API"
description: "Health, status, and runtime feature endpoints."
---

Health, status, and runtime feature endpoints.

[Back to HTTP API overview](/api/).

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
  "dbWriter": {
    "queued": 0,
    "maxQueue": 64,
    "oldestWaitMs": null,
    "lastDurationMs": 2.1,
    "active": false,
    "oldestOperation": null,
    "rejected": 0,
    "cancelled": 0,
    "timedOut": 0,
    "lastQueueWaitMs": 0
  },
  "dbReader": {
    "activeLeases": 2,
    "maxConnections": 16,
    "queued": 0,
    "maxQueue": 64,
    "oldestWaitMs": null,
    "lastWaitMs": 0.4,
    "rejected": 0,
    "syncRejected": 0,
    "cancelled": 0,
    "timedOut": 0
  },
  "dbRuntime": {
    "operations": {
      "read": { "count": 10, "p50Ms": 1.2, "p95Ms": 4.5, "p99Ms": 5.1, "maxMs": 5.1 },
      "write": { "count": 4, "p50Ms": 2.1, "p95Ms": 8.0, "p99Ms": 8.0, "maxMs": 8.0 }
    },
    "queueWait": {
      "read": { "count": 10, "p50Ms": 0, "p95Ms": 12, "p99Ms": 12, "maxMs": 12 },
      "write": { "count": 4, "p50Ms": 0, "p95Ms": 25, "p99Ms": 25, "maxMs": 25 }
    },
    "cancelled": 0,
    "rejected": 0,
    "timedOut": 0,
    "failed": 0,
    "completed": 14,
    "eventLoopLag": {
      "count": 20,
      "p50Ms": 1.1,
      "p95Ms": 3.2,
      "p99Ms": 8.0,
      "maxMs": 8.0
    },
    "queue": {
      "readDepth": 0,
      "readMaxDepth": 64,
      "readOldestAgeMs": null,
      "readActiveLeases": 2,
      "writeDepth": 0,
      "writeMaxDepth": 64,
      "writeOldestAgeMs": null,
      "writeActive": false
    }
  },
  "eventLoop": {
    "status": "ok",
    "stallMs": 0,
    "stallSeconds": 0,
    "lastHeartbeatAtMs": 1771677600000,
    "heartbeatIntervalMs": 2000,
    "lagP95Ms": 3,
    "lagP99Ms": 8
  },
  "shuttingDown": false,
  "updateAvailable": false,
  "pendingRestart": false,
  "resources": {
    "total": -1,
    "memoryMd": 0,
    "sockets": 0,
    "inotify": 0,
    "pipes": 0,
    "db": 0,
    "other": 0,
    "rss": 169,
    "heapUsed": 106,
    "physicalFootprint": 2867,
    "peakPhysicalFootprint": 3584
  }
}
```

`dbReader` reports active read leases, FIFO waiter depth and age, bounded
admission limits, and cancellation/rejection counts. `syncRejected` counts
legacy synchronous read attempts rejected at the hard connection cap. The
`dbRuntime.queue` snapshot reports current read/write depth, queue age, and
active leases; `eventLoopLag` is the bounded independent event-loop sample.

The process-local `eventLoop` signal separates a responsive daemon from one
whose event loop is falling behind. Its health semantics are:

| Field | Meaning |
| --- | --- |
| `eventLoop.status` | `ok` when the heartbeat is on schedule, `degraded` when the loop is stalled for less than 2 seconds, or `wedged` when the stall is at least 2 seconds. |
| `eventLoop.stallSeconds` | Seconds beyond the expected heartbeat interval. |
| `eventLoop.lastHeartbeatAtMs` | Epoch-millisecond timestamp of the last heartbeat callback. |
| `eventLoop.heartbeatIntervalMs` | Expected interval used to calculate the stall. |

The signal is diagnostic only. It is held in module memory, does not query the
database, and does not change the HTTP status of `/health/live`, which remains
200 while the process can answer.

Memory resource values are MiB. On macOS, `physicalFootprint` and
`peakPhysicalFootprint` come from `proc_pid_rusage` and include compressed
and driver-backed memory that RSS can miss. They are `null` on platforms
where this metric is unavailable.

When incremental database maintenance is active, `databaseIntegrity.incrementalProgress`
contains `inventoryObjects`, `checkedObjects`, `skippedObjects`, and
`remainingObjects`. For a stable schema, the coverage invariant is:

```text
checkedObjects + skippedObjects + remainingObjects = inventoryObjects
```

Expected FTS5 virtual tables are represented by the separate
`databaseIntegrity.ftsVerification` object. Its `status` is `unverifiable`
when FTS objects were intentionally skipped because SQLite does not provide a
killable chunked FTS integrity operation; this status is coverage information,
not database corruption, and does not make `/health` degraded. Check failures
and owner or deadline failures continue to report their actionable health
states and guidance.

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
  "shuttingDown": false,
  "eventLoop": {
    "status": "ok",
    "stallMs": 0,
    "stallSeconds": 0,
    "lastHeartbeatAtMs": 1771677600000,
    "heartbeatIntervalMs": 2000,
    "lagP95Ms": 3,
    "lagP99Ms": 8
  }
}
```

The response includes a `workspace` object with `status`, `path`, `source`, and `reasons`. Its status is `fresh`, `ready`, `missing`, or `incomplete`. `/health` reports `degraded` for `missing` or `incomplete`; it does not recreate the selected workspace.

`status` is `"healthy"`, or `"shutting_down"` once shutdown has begun. The
`eventLoop` block is diagnostic only and does not make this independent probe
depend on database availability. It reports the current heartbeat stall and
bounded event-loop lag samples; `"degraded"` and `"wedged"` are possible while
the process still returns 200.

The `@signet/daemon` service-management API uses this liveness endpoint for
`getDaemonStatus()` with a 1.2-second deadline. Its returned `status` is
`"healthy"` when the probe succeeds, `"degraded"` when the service manager
reports a running process but the probe fails or reports shutdown, and
`"unavailable"` when no service is running.

### GET /health/ready

No authentication required. Readiness probe: reports whether the daemon can
actually serve work. Returns 200 only when every gate passes, otherwise 503
with a human-readable `reasons` list. Gates:

- `workspace` — the selected workspace is `ready`; `missing` and `incomplete`
  states include recovery reasons and return 503.
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
    "dbReader": {
      "activeLeases": 1,
      "maxConnections": 16,
      "queued": 0,
      "maxQueue": 64,
      "oldestWaitMs": null,
      "lastWaitMs": 0.4,
      "rejected": 0,
      "syncRejected": 0,
      "cancelled": 0,
      "timedOut": 0
    },
    "dbRuntime": {
      "queue": {
        "readDepth": 0,
        "readMaxDepth": 64,
        "readOldestAgeMs": null,
        "readActiveLeases": 1,
        "writeDepth": 0,
        "writeMaxDepth": 64,
        "writeOldestAgeMs": null,
        "writeActive": false
      }
    },
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

`signet doctor` consumes this probe as its runtime contract: `healthy` means
`/health/ready` returned `ready` and local installation checks passed (`ok: true`,
exit 0); `degraded` means the daemon is reachable but returned `not_ready`
(`ok: false`, exit 2); `unavailable` means the required daemon or local
installation is unavailable or invalid (`ok: false`, exit 1). A queue-caused
periodic scheduler decision deferred for queue pressure includes an explicit
Automatic Dreaming deferral finding with the queue age and last error. A queue
readiness failure alone does not claim that Dreaming was deferred by the queue:
the scheduler can instead defer for higher-priority system pressure.

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
  "resources": {
    "rss": 169,
    "heapUsed": 106,
    "physicalFootprint": 2867,
    "peakPhysicalFootprint": 3584
  },
  "pipelineV2": {
    "enabled": true,
    "paused": false,
    "shadowMode": false,
    "mutationsFrozen": false,
    "graph": {
      "enabled": true
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
    "queue": {
      "memory": { "pending": 0, "leased": 0, "completed": 0, "failed": 0, "dead": 0, "oldestAgeSec": 0, "oldestDeadAgeSec": 0, "lastError": null, "completeness": "exact" },
      "summary": { "pending": 0, "leased": 0, "completed": 0, "failed": 0, "dead": 0, "oldestAgeSec": 0, "oldestDeadAgeSec": 0, "lastError": null, "completeness": "exact" }
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
      "blockedBy": [],
      "since": null,
      "enabled": true,
      "paused": false,
      "workerRunning": false,
      "ready": true,
      "blockedReason": null
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
    "available": true,
    "usage": {
      "total": { "requests": 2084, "tokens": 812345 },
      "today": { "requests": 12, "tokens": 4567 },
      "bySource": [
        { "source": "artifact-index", "requests": 2050, "tokens": 800000 },
        { "source": "memory-capture", "requests": 30, "tokens": 12000 },
        { "source": "recall", "requests": 4, "tokens": 345 }
      ],
      "byProvider": [
        { "provider": "ollama", "requests": 2080, "tokens": 812000 },
        { "provider": "llama-cpp", "requests": 4, "tokens": 345 }
      ]
    }
  }
}
```

The `embedding.usage` block reports embedding token consumption recorded at
the shared embedding-fetch boundary (migration 108). Counts come from the
real tokenizer (`countTokens`) applied to the text actually sent to the
provider — never provider-reported usage, since Ollama's `/api/embeddings`
returns none and the native ONNX path reports none either. `requests` counts
successful embedding fetches; `tokens` sums their input token counts.
`bySource` breaks totals down by `memory-capture`, `artifact-index`,
`recall`, `dreaming`, and `other`; `byProvider` breaks them down by the
provider that actually served (`ollama`, `llama-cpp`, `native`, `openai` —
the native fallback chain reports the real serving provider). The block is
omitted when the table does not exist (pre-migration database).

The `bypassedSessions` field reports how many active sessions currently have
bypass enabled (see [Sessions and hooks API](/api/sessions-hooks/#sessions)).
`providerResolution.extraction` is the canonical workload-state object. Its
`configured`, `resolved`, and `effective` labels describe provider selection;
they do not imply that jobs are being serviced. Use `enabled`, `paused`, and
`ready` to determine whether extraction is actually available for work. The
standalone extraction worker was retired under the Dreaming cutover (#946),
so `workerRunning` is always `false` and `ready` reflects route resolution
alone (`active` or `degraded`). `blockedReason` is populated only for a
blocked route.
Monitor `status` for `degraded` or `blocked` states when the configured
extraction provider is unavailable or routed to a fallback target.
When extraction is blocked, `providerResolution.extraction.blockedBy` contains
the first routing candidate's policy and runtime gate reasons in evaluation
order. The array is empty for non-blocked states.
`pipeline.queue` exposes per-queue counts (memory / summary).
`pipeline.dreaming` records the latest periodic Dreaming scheduler decision.
It is `null` before the worker starts. A `deferred` result with
`reason: "queue_pressure"` means the scheduler itself yielded that sweep to
queue health. It does not infer a queue deferral from another readiness gate.
The retired worker's load/overload telemetry is no longer reported.
`transcripts.capture` exposes compact durable transcript-capture queue counts;
use `GET /api/diagnostics/transcripts` for detailed artifact/audit diagnostics.
Use `GET /api/inference/status` for the shared inference control plane status.


### GET /api/diagnostics/workloads

Returns bounded in-flight workload pressure for one resolved agent. The
inference snapshot covers background routed work and Pi agent sessions; the
MCP snapshot covers stateless Streamable HTTP requests; the provider semaphore
snapshot covers global LLM permit occupancy; and the Dreaming snapshot covers
running passes plus pending attention. Counts are held in memory except for
the Dreaming snapshot, which reads scoped durable rows. Ages are calculated
from admission or persisted start/creation time, so this endpoint does not
scan general-purpose durable queue tables. `agentId` may be supplied as a
query parameter or `x-signet-agent-id` header; scoped deployments reject
requests for another agent.

**Response**

```json
{
  "agentId": "default",
  "inference": {
    "active": 1,
    "agentSessions": 1,
    "oldestAgeMs": 3200,
    "oldestAgentSessionAgeMs": 3200,
    "byOperation": { "memory_extraction": 1 }
  },
  "mcp": { "inFlight": 0, "oldestAgeMs": null, "maxInFlight": 8 },
  "pi": { "active": 1, "oldestAgeMs": 3200 },
  "providerSemaphore": { "running": 1, "pending": 0, "limit": 2, "oldestPendingAgeMs": null },
  "dreaming": {
    "activePasses": 0,
    "oldestPassAgeMs": null,
    "pendingAttention": 0,
    "oldestAttentionAgeMs": null
  }
}
```


### GET /api/diagnostics/queue

Per-queue counts (memory / summary), oldest-dead job
references, and threshold metadata. Counts are bounded at 1,000 rows per
status; `completeness` is `truncated` when a counter is capped and `unknown`
when the queue schema cannot be observed. Backend path uses the same shared
threshold constants that `GET /api/status` and `/health/ready` consume.

Admin permission required.

**Response**

```json
{
  "timestamp": "2026-07-19T00:00:00.000Z",
  "queues": {
    "memory": { "pending": 0, "leased": 0, "completed": 1, "failed": 0, "dead": 0, "oldestAgeSec": 0, "oldestDeadAgeSec": 0, "lastError": null, "completeness": "exact" },
    "summary": { "pending": 0, "leased": 0, "completed": 0, "failed": 0, "dead": 0, "oldestAgeSec": 0, "oldestDeadAgeSec": 0, "lastError": null, "completeness": "exact" }
  },
  "oldestDeadSummaryJob": null,
  "oldestDeadMemoryJob": { "...": "..." },
  "thresholds": {
    "memoryDeadWarn": 50, "memoryDeadFail": 500,
    "memoryOldestPendingWarnSec": 300, "memoryOldestPendingFailSec": 1800,
    "summaryDeadWarn": 50, "summaryDeadFail": 500,
    "summaryOldestPendingWarnSec": 300, "summaryOldestPendingFailSec": 1800,
    "summaryOldestDeadWarnSec": 86400
  }
}
```

Counts default to `0` and `null` if a table does not exist on the running
database. Historical `summary_jobs` rows are retired by migration 117 and are
not reported as live work. The `summary` queue and summary thresholds remain
zero/compatibility fields for older clients.


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
  "tables": ["memory"],
  "olderThanMs": 2592000000,
  "errorPattern": "timeout"
}
```

- `action` — one of `requeue`, `cancel`, `prune`.
- `dryRun` — boolean; defaults to `true` (safe preview).
- `ids` — optional array of row ids; bypasses filter for max precision.
- `tables` — optional array containing `memory` (default: `memory`). The
  historical `summary` target is retired and returns HTTP `410`.
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
  "preview": ["memory_jobs:abc", "memory_jobs:def"],
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

### GET /api/mode

Environment probe (issue #1001). Deliberately lightweight and **unauthenticated** — the dashboard uses it to distinguish "talking to a real daemon" (any hostname: localhost, Tailscale, `.local`, tunnel, LAN IP) from the marketing site or the cloud app. If this endpoint responds, there is a real daemon behind the URL.

**Response**

```json
{
  "mode": "local",
  "requiresAuth": false
}
```

- `mode`: the daemon's auth mode (`local`, `team`, or `hybrid`).
- `requiresAuth`: `false` in `local` mode, `true` in `team` and `hybrid` modes. The endpoint itself is always unauthenticated and carries no data beyond this documented shape. Authenticated data endpoints use Bearer tokens only, with no cookies.
