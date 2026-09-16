---
title: "Dreaming and semantic operations"
description: "The current evidence-backed path for automatic semantic changes."
---

Signet stores memories, transcripts, documents, and source artifacts as scoped evidence first. Dreaming is the current and sole automatic semantic writer. It may derive ontology state from selected evidence, but it does not rewrite that evidence.

## A bounded Dreaming pass

A pass:

1. selects agent-scoped episodic evidence and pending attention;
2. builds a bounded evidence window and runbook;
3. calls the configured inference workload within the pass deadline;
4. uses scoped read and review capabilities;
5. submits structured ontology operations through the daemon-owned apply seam;
6. records pass state, tool calls, usage, mutations, failures, and exclusions.

Operations are validated before the write transaction. Content operations cite exact evidence; hygiene operations cite the relevant attention record. Scope, provenance, schemas, and write caps are enforced by the daemon. Inference never holds a SQLite write lock.

Dreaming has combined and focused pass modes, including incremental content and hygiene work. These are pass modes, not per-fact `ADD`/`UPDATE`/`DELETE` decisions.

## Terminology and lifecycle

The repository retains historical extraction, decision, structural-classification, dependency-synthesis, and summary-worker names in migrations, fixtures, and compatibility state. The active semantic path is the bounded Dreaming pass described above; these historical names identify stored or compatibility data, not current worker ownership.

The `memory_extraction` workload name identifies the inference binding used by Dreaming. “Pipeline V2” identifies compatibility configuration and status terminology. Both names appear alongside the current Dreaming lifecycle in runtime diagnostics.

## Explicit operations

Structured remember payloads, user or agent operations, and reviewed repair paths can apply their own audited changes where the public contract permits. They are distinct from scheduled automatic Dreaming. A prospective hint is a retrieval aid for an existing memory, not a semantic fact.

For runtime controls, see [Pipeline configuration](/configuration/pipeline/). For retrieval, see [Retrieval, graph traversal, and hints](/pipeline/knowledge-search/).
