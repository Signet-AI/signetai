---
title: "Memory Pipeline"
description: "The background services that preserve, index, and maintain Signet state."
---

The memory pipeline is the daemon's background runtime. It preserves and indexes evidence, maintains bounded derived state, and exposes its status to operators. It is not a per-memory LLM extraction pipeline.

## Current model

Evidence is saved first. The daemon may then run non-semantic work such as document ingestion, retention, embedding refresh, working-memory projection, maintenance, and optional prospective hint generation. These workers do not replace the evidence they process.

Dreaming is the only automatic semantic writer. It selects agent-scoped episodic evidence and submits audited ontology operations. Legacy extraction, decision, structural-classification, and dependency-synthesis workers are retired; historical `extract` jobs are terminalized rather than leased.

Inference routing is configured through the canonical router workloads. The `memory_extraction` workload name remains because Dreaming uses it for inference; it does not enable a retired extraction worker.

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
or `rejected`; blank lines are counted separately. The worker uses one active
job/file, 25 records per database batch, an 8 MiB canonical batch, 16 MiB record
and 4 MiB message caps, and a 50,000-message cap. Job counters reconcile as
`total = imported + duplicate + rejected + pending`, and terminal jobs have no
pending records. Restart recovery reclaims leases and resumes byte checkpoints;
filesystem-first canonical writes are idempotent. Replaying the same export is
reported as duplicates, not as new evidence.

Dreaming remains separate: a committed batch emits one attention nudge, then the
existing delivery, consumption, and review path determines pending Dreaming
work. Removing the source purges imported evidence, canonical lines, indexes,
and consumption rows while preserving bounded audit tombstones and routing
derived knowledge through unsupported/stale review.

For supported runtime configuration, use [Inference and routing](/configuration/inference-routing/) and [Pipeline configuration](/configuration/pipeline/). This section intentionally does not duplicate operator configuration.