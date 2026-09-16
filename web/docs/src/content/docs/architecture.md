---
title: "Architecture"
description: "Contributor-facing package, data, and runtime architecture."
---

This section describes Signet's current runtime and persistence boundaries. It is a developer reference, not a product tutorial or configuration guide.

Signet records agent-scoped evidence first. SQLite rows and workspace artifacts preserve that evidence; indexes, embeddings, caches, and projections are derived state. The daemon owns core behavior and durable transitions. The CLI, dashboard, SDK, and harness integrations call the daemon rather than implementing competing transitions.

## In this section

- [Packages and data flow](/architecture/packages-data-flow/): source/package ownership and the current evidence-to-retrieval path.
- [Pipeline and storage](/architecture/pipeline-storage/): canonical state, derived state, Dreaming, and persistence boundaries.
- [Platform services](/architecture/platform-services/): authentication, connectors, diagnostics, and repair.
- [Data lifecycle](/architecture/data-lifecycle/): normalization, retention, projections, and workspace layout.
- [Interfaces and agents](/architecture/interfaces-agents/): public boundaries and agent scoping.

## Database owner boundary

Exactly one owner process has direct access to a workspace database. The daemon submits bounded asynchronous jobs over the owner protocol; it never receives a database handle, imports synchronous SQLite, or runs SQL itself. Owner failure, cancellation, deadlines, and cleanup are explicit outcomes. Pending work fails closed when the owner is unavailable. There is no main-thread or legacy database fallback.

The owner protocol is a migration seam for reads, writes, maintenance, recall, indexing, embedding work, repair, and source ingestion. Moving a category across the seam must preserve the single database owner.

## Bounded execution

`async`/`await` yields the daemon event loop but does not create a process. A `Worker` creates a thread and JavaScript isolate in the daemon process. Separate killable processes are reserved for boundaries that need database ownership or crash/deadline containment, such as integrity repair and transcript recovery when enabled. External provider commands remain subprocesses.

Admission and lifecycle are bounded. Document ingestion allows at most two in-flight jobs, and the shared LLM semaphore defaults to two calls with a configured ceiling of sixteen. Work has an owner, deadline, cancellation behavior, cleanup boundary, and observable result.

For product concepts, see [What Is Signet](/what-is-signet/), [Memory and recall](/memory/), and [Knowledge architecture](/knowledge-architecture/).
