# DB owner protocol

This is the frozen daemon/owner contract introduced by Phase C. The daemon side is `db-owner-client.ts`; the owner side is `db-owner-worker.ts`. Only the owner imports SQLite and executes synchronous SQL.

## Job envelope

Every submitted job has this shape:

```ts
{
  id: string,
  operation: string,
  lane: "read" | "write" | "maintenance",
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
      transactional?: boolean,
      requireChanges?: boolean
    }
  } | {
    kind: "transaction",
    transaction: {
      statements: Array<Statement>
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
    kind: "sleep",
    durationMs: number
  }
}
```

`enqueuedAt` and `deadlineAt` use Unix milliseconds. `deadlineAt` is an absolute deadline, so queue wait and execution consume the same budget. Admission is bounded at 64 pending jobs, 10,000 estimated work units per job, and a 60-second deadline. `maxResultBytes` is bounded at 1 MiB. A result above that limit is rejected with `DB_OWNER_RESULT_TOO_LARGE`; callers must page the SQL query or select fewer columns. The owner never emits an unbounded result line. `estimatedWorkUnits` is admission and telemetry metadata, not permission to exceed the deadline. The `sleep` request exists only for lifecycle and deadline tests and is not a production database operation.

## Wire messages

Messages are newline-delimited JSON over the owner's stdin/stdout. The daemon sends:

- `{"type":"submit","job": ...}`
- `{"type":"cancel","jobId": ...}`
- `{"type":"shutdown"}`

The owner sends:

- `{"type":"ready","pid": ...}` after it has opened its SQLite connection.
- `{"type":"result","jobId": ...,"outcome":"completed","result": ...}`
- `{"type":"result","jobId": ...,"outcome":"cancelled"}`
- `{"type":"result","jobId": ...,"outcome":"timed_out"}`
- `{"type":"result","jobId": ...,"outcome":"failed","error":{"name": ...,"message": ...}}`
- `{"type":"fatal","error":{"name": ...,"message": ...}}` when construction or protocol handling fails.

`owner_died` is a daemon-observed outcome. The owner cannot report it after its process exits. The client rejects every pending handle with `DbOwnerDiedError`, marks health as `dead`, and starts a new owner on the next submission. It never falls back to the daemon's legacy SQLite accessor.

## Execution and cancellation

The owner has two independent FIFO processes: a reader for `read` jobs and a
serial writer for `write` and `maintenance` jobs. A read job therefore does
not wait behind a synchronous maintenance job. Each process has its own SQLite
connection; WAL mode provides the concurrent read/write boundary. The writer
still serializes all writes and maintenance work. A `run` statement is wrapped
in `BEGIN IMMEDIATE`/`COMMIT` unless `transactional: false` is explicit. A
transaction request wraps all of its statements atomically. A `batch` contains
only `run` statements and also rolls back on failure; `requireChanges` is a
fail-closed zero-change precondition.

A queued cancellation is removed from the client pending map, clears its deadline timer, and is removed from the owner's queue before execution. A cancellation received while synchronous native SQLite work is running is best effort because the owner cannot observe stdin until that call returns. A deadline is different: the client kills the entire child with `SIGKILL` at the absolute deadline. The subsequent owner death fails all other in-flight and queued jobs closed.

Construction failure, malformed protocol input, owner exit, deadline kill, and job failure are all observable through the health state or the rejected handle. A dead owner is recoverable without a daemon restart, but no job is silently replayed because writes may have reached SQLite before a process crash.

## Client surface

`DbOwnerClient` is the only daemon-facing interface:

- `start()` waits for owner construction and readiness.
- `submit(request, options)` returns a serializable job envelope and a typed result handle.
- `awaitResult(handle, timeoutMs?)` awaits a result and cancels on the optional caller timeout.
- `cancel(jobId)` requests cancellation.
- `health()` returns owner state, PID, generation, queued count, active job, and last error without touching SQLite.
- `health()` also reports hard-deadline kills, so maintenance pressure is visible without touching SQLite.
- `close()` sends shutdown and is idempotent.

No callback receives a database handle. No synchronous SQLite symbol is exported by the client or the recall seam. The owner module is the sanctioned synchronous site.
## FTS and Dreaming maintenance

`db-owner-maintenance.ts` owns bounded FTS repair and backfill. Startup creates only the canonical FTS schema and triggers, then submits keyset-paginated chunks to the maintenance lane. Each chunk uses a durable `db_owner_maintenance_checkpoints` row and one atomic batch that advances the cursor and inserts the matching anti-join rows. The checkpoint is the resume contract after an owner crash. Tokenizer rebuilds recreate the schema in the owner before chunking; they never perform a full synchronous backfill on the daemon event loop. A backfill invocation also has a total wall-clock budget, total estimated work-unit budget, and cooperative `AbortSignal`; when any budget is exhausted it returns `running` with the durable checkpoint for a later invocation.

The maintenance lane publishes the queue-pressure gate used by scheduled Dreaming sweeps and autonomous pipeline maintenance. Dreaming pass lifecycle rows and retention/repair admission are submitted through that lane, while queue depth, oldest pending age, recent dead rate, and stale leases are evaluated in the owner before work starts. Manual Dreaming work, pipeline scheduling/retry behavior, retention lifecycle, and existing evidence ordering remain unchanged; queue pressure only defers scheduled work.
