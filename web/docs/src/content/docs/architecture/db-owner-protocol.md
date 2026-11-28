---
title: "DB owner protocol"
description: "Contributor reference for the daemon-to-database-owner job and wire contract."
---

This page documents the daemon-to-owner contract. The executable protocol types live in `platform/daemon/src/db-owner-protocol.ts`; the daemon client and owner runtime are in `db-owner-client.ts` and `db-owner-worker.ts`. Only the owner imports SQLite and executes synchronous SQL.

## Job envelope

A job carries an identifier, operation, lane, workload class, enqueue time, absolute deadline, estimated work units, cancellation state, and a request. The excerpt below shows common SQL request shapes; the complete request union and field types are defined in `db-owner-protocol.ts`.

```ts
{
  id: string,
  operation: string,
  lane: "read" | "write" | "maintenance" | "verify",
  workloadClass: "foreground" | "maintenance",
  enqueuedAt: number,
  deadlineAt: number,
  estimatedWorkUnits: number,
  cancellation: "pending" | "requested" | "started",
  request: {
    kind: "query",
    statement: {
      sql: string,
      params?: Array<string | number | boolean | null | { type: "bytes", base64: string }>,
      result: "all" | "get" | "run",
      maxResultBytes?: number,
      readonly?: boolean,
      transactional?: boolean,
      requireChanges?: boolean
    }
  } | {
    kind: "transaction",
    transaction: {
      statements: Array<DbOwnerStatement>
    }
  } | {
    kind: "batch",
    statements: Array<{
      sql: string,
      params?: Array<string | number | boolean | null | { type: "bytes", base64: string }>,
      result: "run",
      requireChanges?: boolean
    }>,
    requireChanges?: boolean
  } | {
    kind: "recall",
    payload: {
      params: unknown,
      config: unknown,
      agentId?: string,
      query?: string,
      queryEmbedding?: number[] | null
    }
  } | {
    kind: "vacuum_conversion"
  } | {
    kind: "sleep",
    durationMs: number
  }
}
```

`enqueuedAt` and `deadlineAt` use Unix milliseconds. `deadlineAt` is an absolute deadline, so queue wait and execution consume the same budget. Each workload class has an independent bounded admission queue of 64 pending jobs, so foreground work retains capacity while maintenance is saturated. A full queue rejects a submission with `DB_OWNER_QUEUE_FULL`. The daemon's query, batch, and maintenance helpers wait for admission within the job's own deadline instead of failing at once; callers that schedule their own backoff, such as migration integrity verification, opt out with `admission: "reject"`. The owner scheduler prioritizes foreground jobs and forces a maintenance turn after a bounded foreground burst; it never preempts synchronous work already running. Each job is also limited to 10,000 estimated work units and a 60-second deadline for read/write jobs. Maintenance and verification jobs may use a 15-minute deadline for bounded operations such as the one-time VACUUM conversion. `maxResultBytes` is bounded at 1 MiB. A result above that limit is rejected with `DB_OWNER_RESULT_TOO_LARGE`; callers must page the SQL query or select fewer columns. The owner never emits an unbounded result line. `estimatedWorkUnits` is admission and telemetry metadata, not permission to exceed the deadline. The `sleep` request exists only for lifecycle and deadline tests and is not a production database operation.

Reads that can queue behind other jobs, such as the knowledge-graph reads behind the Dreaming tools, submit `DB_OWNER_READ_DEADLINE_MS` (15 seconds). The owner runs a single-row lookup in milliseconds, but the deadline starts at enqueue, so a shorter budget would reject the read before the owner reached it.

## Wire messages

Messages are newline-delimited JSON over the owner's stdin/stdout. Each frame is limited to 64 MiB of UTF-8 bytes, including fragmented frames. An oversized frame fails with `DB_OWNER_FRAME_TOO_LARGE`; the connection is retired and the child is reaped before replacement startup. This transport cap does not increase the smaller per-job result limits. The daemon sends:

- `{"type":"submit","job": ...}`
- `{"type":"cancel","jobId": ...}`
- `{"type":"shutdown"}`

The owner sends:

- `{"type":"ready","pid": ...}` when the worker process starts. This is transport readiness, not database readiness; database initialization is a separate owner job/result.
- `{"type":"started","jobId": ...,"workloadClass": ...}` when a job begins execution.
- `{"type":"result","jobId": ...,"outcome":"completed","result": ...}`
- `{"type":"result","jobId": ...,"outcome":"cancelled"}`
- `{"type":"result","jobId": ...,"outcome":"timed_out"}`
- `{"type":"result","jobId": ...,"outcome":"failed","error":{"name": ...,"message": ...}}`
- `{"type":"fatal","error":{"name": ...,"message": ...}}` when construction or protocol handling fails.

`owner_died` is a daemon-observed outcome. The owner cannot report it after its process exits. The client rejects every pending handle with `DbOwnerDiedError`, marks health as `dead`, and starts a new owner on the next submission. It never falls back to the daemon's legacy SQLite accessor.

## Execution and cancellation

`transcript_capture_transition` completes, fails, or recovers capture jobs in the owner. Completion and terminal failure settle upload storage and its receipt in the same transaction; a failed settlement cannot publish a completed job. Recovery and the upload sweep settle old terminal uploads in bounded batches.

The single owner process serially drains bounded foreground and maintenance queues. It prioritizes foreground jobs and admits a maintenance turn after a bounded foreground burst; no job preempts synchronous work already running. Read-only statements use read-only SQLite connections within that same process, not a separate reader process. A `run` statement is wrapped in `BEGIN IMMEDIATE`/`COMMIT` unless `transactional: false` is explicit. A transaction request wraps all of its statements atomically. A `batch` contains only `run` statements and also rolls back on failure; `requireChanges` is a fail-closed zero-change precondition.

A queued cancellation is removed from the client pending map, clears its deadline timer, and is removed from the owner's queue before execution. A cancellation received while synchronous native SQLite work is running is best effort because the owner cannot observe stdin until that call returns. A deadline rejects the caller and sends cancellation when dispatched. The owner drops a still-queued job. An executing operation has a 1-second grace period to finish cooperatively before the supervisor retires the process.

Construction failure, malformed protocol input, owner exit, deadline abandonment, and job failure are observable through the health state or the rejected handle. Expiry immediately rejects the caller and requests cooperative cancellation. If an executing job has still not returned 1 second after its hard deadline, the supervisor fences that owner generation, SIGKILLs it, and fails its remaining admitted requests with `owner_retired`. It reaps the old child before starting and initializing one replacement. Health remains degraded until database readiness is restored. No failed job is replayed; an interrupted SQLite transaction rolls back, while an already committed write can have an unknown outcome to its caller.

## Client surface

`DbOwnerClient` is the only daemon-facing interface:

- `start()` starts the worker process and waits for its `ready` transport event; it does not establish database readiness.
- `initialize(agentsDir?)` submits the initialization job and waits for its result. A completed result establishes database readiness.
- `submit(request, options)` returns a serializable job envelope and a typed result handle.
- `awaitResult(handle, timeoutMs?)` awaits a result and cancels on the optional caller timeout.
- `cancel(jobId)` requests cancellation.
- `health()` returns owner state, PID, generation, total and per-class queue counts, active job/class, oldest pending ages, and last error without touching SQLite. Deadline expiry rejects the handle and sends cancellation when dispatched. A separate supervisor watchdog retains the executing job until completion or hard-deadline retirement, even after its caller has stopped waiting.
- `close()` sends shutdown and is idempotent.

No callback receives a database handle. No synchronous SQLite symbol is exported by the client or the recall seam. The owner module is the sanctioned synchronous site.

## Migration startup

The daemon binds its diagnostic HTTP surface before database initialization. While migrations run, `/health` and `/api/status` report `migrating`, `db: false`, and `dbOwner.migration` with the current version, name, phase, and completed database-operation count. This is observed work, not a row count or percentage. `/health/ready` returns 503 until startup finishes. Application work is unavailable: supplied credentials receive 503 without database-backed authentication, while missing credentials on protected team requests still receive the canonical 401 response. The diagnostic status contains no corpus content.

The migration owner sends sequenced progress after completed database operations, throttled to one update per 250 ms plus phase transitions. These are not timer-only keepalives: a blocked native call cannot renew its own lease. Increasing progress suspends the ordinary 60-second initialization budget; that unchanged budget starts after migrations finish. Thirty seconds without new progress retires the owner once with `DB_OWNER_MIGRATION_STALLED`, preserves the backup, and fails startup instead of restarting automatically. A single native statement must finish within that observation window; longer backfills need bounded operations between progress updates.

Migration transactions remain atomic. Restart skips committed migration versions; an interrupted version rolls back and repeats. Backup-copy checkpoints retain their existing resume behavior. The aggregate repair markers are not row-level resume cursors.

## Session transcript writes

Async transcript upserts and live appends submit `session_transcript_write` on the foreground write lane. The payload carries the resolved agent, exact session key, transcript text, project, and an optional `append` flag; it never carries a callback or an abort signal. The owner calls the canonical `writeSessionTranscriptRow` inside one transaction, including the existing-content read and trailing-text deduplication for appends. The result is `written`, `skipped`, or `conflict`. Cancellation stays on the client, and an unavailable owner never falls back to a daemon-side write.

## FTS and Dreaming maintenance

`db-owner-maintenance.ts` owns bounded FTS repair and backfill. Startup creates only the canonical FTS schema and triggers, then submits keyset-paginated chunks to the maintenance lane. Each chunk uses a durable `db_owner_maintenance_checkpoints` row and one atomic batch that advances the cursor and inserts the matching anti-join rows. The checkpoint is the resume contract after an owner crash. Tokenizer rebuilds recreate the schema in the owner before chunking; they never perform a full synchronous backfill on the daemon event loop. A backfill invocation also has a total wall-clock budget, total estimated work-unit budget, and cooperative `AbortSignal`; when any budget is exhausted it returns `running` with the durable checkpoint for a later invocation.

The maintenance lane publishes the queue-pressure gate used by scheduled Dreaming sweeps and autonomous pipeline maintenance. Dreaming pass lifecycle rows and retention/repair admission are submitted through that lane, while queue depth, oldest pending age, recent dead rate, and stale leases are evaluated in the owner before work starts. Manual Dreaming work, pipeline scheduling/retry behavior, retention lifecycle, and existing evidence ordering remain unchanged; queue pressure only defers scheduled work.
