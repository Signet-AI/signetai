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
      transactional?: boolean
    }
  } | {
    kind: "sleep",
    durationMs: number
  }
}
```

`enqueuedAt` and `deadlineAt` use Unix milliseconds. `deadlineAt` is an absolute deadline, so queue wait and execution consume the same budget. `estimatedWorkUnits` is admission and telemetry metadata, not permission to exceed the deadline. The `sleep` request exists only for lifecycle and deadline tests and is not a production database operation.

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

The first implementation has one FIFO process. `read` jobs and `write` or `maintenance` jobs are still tagged separately, preserving the lane split for a future transport with parallel readers and one writer. A `run` statement is wrapped in `BEGIN IMMEDIATE`/`COMMIT` unless `transactional: false` is explicit. Read statements do not open a transaction.

A queued cancellation is removed logically before execution. A cancellation received while synchronous native SQLite work is running is best effort because the owner cannot observe stdin until that call returns. A deadline is different: the client kills the entire child with `SIGKILL` at the absolute deadline. This is the hard boundary for uninterruptible native work. The subsequent owner death fails all other in-flight and queued jobs closed.

Construction failure, malformed protocol input, owner exit, deadline kill, and job failure are all observable through the health state or the rejected handle. A dead owner is recoverable without a daemon restart, but no job is silently replayed because writes may have reached SQLite before a process crash.

## Client surface

`DbOwnerClient` is the only daemon-facing interface:

- `start()` waits for owner construction and readiness.
- `submit(request, options)` returns a serializable job envelope and a typed result handle.
- `awaitResult(handle, timeoutMs?)` awaits a result and cancels on the optional caller timeout.
- `cancel(jobId)` requests cancellation.
- `health()` returns owner state, PID, generation, queued count, active job, and last error without touching SQLite.
- `close()` sends shutdown and is idempotent.

No callback receives a database handle. No synchronous SQLite symbol is exported by the client or the recall seam. The owner module is the sanctioned synchronous site.
