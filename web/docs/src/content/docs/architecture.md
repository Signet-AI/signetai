---
title: "Architecture"
description: "Contributor-facing package, data, and runtime architecture."
---

This section is a technical reference for contributors. It describes the current runtime and persistence boundaries, not a product tutorial or a configuration guide.

Signet has one canonical state layer: agent-scoped SQLite rows and user-facing workspace artifacts. Search indexes, embeddings, caches, and projections are derived from that state. The daemon owns writes and exposes the HTTP surface; the CLI, dashboard, and harness integrations are clients of that daemon.

## In this section

- [Packages and data flow](/architecture/packages-data-flow/): repository ownership and the current evidence-to-retrieval path.
- [Pipeline and storage](/architecture/pipeline-storage/): active workers, persistence, and retired worker boundaries.
- [Platform services](/architecture/platform-services/): authentication, connectors, diagnostics, and repair.
- [Data lifecycle](/architecture/data-lifecycle/): normalization, retention, projections, and workspace layout.
- [Interfaces and agents](/architecture/interfaces-agents/): public runtime boundaries and agent scoping.

## Database owner boundary

The daemon-facing database contract is an asynchronous, serializable job protocol. A job contains an operation name, lane (`read`, `write`, or `maintenance`), enqueue timestamp, absolute deadline, estimated work units, cancellation state, and a query request. The first implementation runs one killable owner process. The lane is part of the frozen interface so a future transport can route recall reads to parallel readers and writes or maintenance to one writer without changing callers.

The owner process is the only place that imports SQLite or runs synchronous SQL. The daemon client exposes `submit`, `awaitResult`, `cancel`, `health`, and `close`; it never exposes a database handle or callback. The parent kills the owner at a hard deadline, reports `owner_died` when the process exits unexpectedly, and starts a fresh owner for the next job. Pending jobs fail closed rather than waiting behind a dead process. Owner construction failures are reported as unavailable and do not silently fall back to main-thread SQLite.

The wire messages are newline-delimited JSON: `submit(job)`, `cancel(jobId)`, and `shutdown` from the daemon, with `ready`, `result`, and `fatal` events from the owner. Results are `completed`, `cancelled`, `timed_out`, `failed`, or `owner_died`. This boundary is the migration seam for recall, writes, integrity and repair, index and embedding work, FTS maintenance, and source ingestion. The core rollout proves the seam with an owner-routed recall query; category migrations must not reintroduce synchronous SQLite in the daemon.

## Execution boundaries

`async` and `await` do not create a process. They keep ordinary I/O work in the daemon and yield its event loop; synchronous CPU work still runs on the current thread. A `node:worker_threads` `Worker` creates another JavaScript isolate and thread in the same daemon process. It can be terminated independently without starting another compiled `signet.exe`.

Internal helpers use these in-process boundaries with explicit admission and lifecycle limits. The pipeline does not create one runtime per queued task: document ingestion admits at most two in-flight jobs, and the LLM semaphore defaults to two calls and is clamped to a maximum of sixteen. Work that cannot be admitted waits behind the bounded queue or reaches its declared deadline and fails explicitly.

Some boundaries intentionally remain separate from the ordinary helper runtime:

- The database owner is one killable process because it owns synchronous SQLite access and must be restartable without wedging the daemon.
- Native embedding keeps its own worker and model lifecycle because the model and WASM runtime are memory-heavy. Its idle TTL evicts the worker after inactivity; it is not part of the general helper pool.
- Database integrity checks and repairs, and transcript recovery when enabled, retain killable process boundaries for deadline, crash, and restart containment.
- External provider commands remain external subprocesses. They are not internal helper fan-out.

The compiled runtime materializes worker entrypoints as assets and starts them with `Worker`; it must not be invoked once per internal helper job. The daemon regression test `src/worker-process-boundary.test.ts` audits compiled-runtime launch sites and prints the remaining intentional process owners.

For product concepts, start with [What Is Signet](/what-is-signet/), [Memory and recall](/memory/), and [Knowledge architecture](/knowledge-architecture/).
