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

## What is not the current path

The historical per-memory extraction worker, decision loop, structural classifiers, dependency-synthesis worker, and summary-worker session-end path are retired. Historical names may remain in migrations, fixtures, or compatibility state. They are not active executors and must not be described as current pipeline stages.

The `memory_extraction` workload name is retained where Dreaming uses that inference binding. It does not enable a retired extraction worker. “Pipeline V2” likewise refers only to compatibility configuration and status terminology.

## Explicit operations

Structured remember payloads, user or agent operations, and reviewed repair paths can apply their own audited changes where the public contract permits. They are distinct from scheduled automatic Dreaming. A prospective hint is a retrieval aid for an existing memory, not a semantic fact.

For runtime controls, see [Pipeline configuration](/configuration/pipeline/). For retrieval, see [Retrieval, graph traversal, and hints](/pipeline/knowledge-search/).
