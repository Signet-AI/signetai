---
title: "Memory Pipeline"
description: "The background services that preserve, index, and maintain Signet state."
---

The memory pipeline is the daemon's background runtime. It preserves and indexes evidence, maintains bounded derived state, and exposes its status to operators. It is not a per-memory LLM extraction pipeline.

## Current model

Evidence is saved first. The daemon may then run non-semantic work such as document ingestion, retention, embedding refresh, working-memory projection, maintenance, and optional prospective hint generation. These workers do not replace the evidence they process.

Dreaming is the only automatic semantic writer. It selects agent-scoped episodic evidence and submits audited ontology operations. Legacy extraction, decision, structural-classification, and dependency-synthesis workers are retired; historical `extract` jobs are terminalized rather than leased.

Inference routing is configured through the canonical router workloads. The `memory_extraction` workload name remains because Dreaming uses it for inference; it does not enable a retired extraction worker.

## Runtime and concurrency

Pipeline work is asynchronous inside the daemon. Promise-based I/O yields the event loop, while a `Worker` moves blocking or CPU-heavy helper code to another thread in the same daemon process. Neither mechanism launches another compiled `signet.exe` for each job.

Admission is bounded. Document ingestion allows two in-flight jobs across the daemon, and LLM calls use a shared semaphore with a default concurrency of two and a configured ceiling of sixteen. Other workers use single-flight or bounded lifecycle handles. Queued work is observed, cancellable, and subject to its operation deadline; it is not an unbounded subprocess pool.

The database owner remains a separate killable process because it is the sole synchronous SQLite owner. Native embedding remains a separate model-owning worker with idle-TTL eviction. Integrity checks and transcript recovery retain separate killable processes when their crash or deadline containment requires it. These are deliberate state or failure-isolation boundaries, not a general recipe for spawning internal helpers.

## In this section

- [Evidence, Dreaming, and ontology changes](/pipeline/extraction-decisions/)
- [Retrieval, graph traversal, and hints](/pipeline/knowledge-search/)
- [Workers and maintenance](/pipeline/workers-maintenance/)
- [Continuity and lineage](/pipeline/continuity-lineage/)

## Durable transcript import boundary

Agent transcript imports are evidence ingestion, not a semantic pipeline stage.
The durable worker inventories streamed `signet-export` v1 JSONL by byte offset,
then commits typed completed-transcript DTOs in bounded batches. It preserves
roles, exact whitespace, multiline content, projects, historical timestamps, and
source provenance. Embedded agent ids never override the selected target scope.

Each nonblank line has one durable outcome: `pending`, `imported`, `duplicate`,
or `rejected`; blank lines are ignored. The worker uses one active
job/file, 25 records per database batch, an 8 MiB canonical batch, 16 MiB record
and 4 MiB message caps, and a 50,000-message cap. Job counters reconcile as
`total = imported + duplicate + rejected + pending`, and completed jobs have no
pending records. Restart recovery reclaims leases and resumes byte checkpoints;
evidence, outcomes, audit entries, and checkpoints commit atomically. Replaying the same export is
reported as duplicates, not as new evidence.

Dreaming remains separate: a committed batch emits one attention nudge, then the
existing delivery, consumption, and review path determines pending Dreaming
work. Removing the source purges imported evidence, indexes,
and consumption rows while preserving bounded audit tombstones and routing
derived knowledge through unsupported/stale review.

Transcript imports and imported-source deletion support Windows, Linux, and macOS.
The single database owner retains the raw bytes and resumes checksummed uploads.
See the [import API](/api/documents-sources/#durable-transcript-imports) for upload
limits, disk-space admission, and migration of older filesystem imports.

For supported runtime configuration, use [Inference and routing](/configuration/inference-routing/) and [Pipeline configuration](/configuration/pipeline/). This section intentionally does not duplicate operator configuration.
