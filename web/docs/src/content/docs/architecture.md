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

The daemon submits database work through a bounded asynchronous protocol to one killable owner process. The owner serially drains foreground and maintenance queues, prioritizing foreground work with a bounded burst. Read-only statements use read-only SQLite connections within the owner process; they are not handled by a separate reader process. Job deadlines bound admission and execution, but expiry does not kill the owner or roll back synchronous work already in progress. Failed or abandoned jobs are not silently replayed, and the daemon does not fall back to opening SQLite itself.

See the [DB owner protocol reference](/architecture/db-owner-protocol/) for the job envelope, wire messages, cancellation behavior, and maintenance contract.

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
