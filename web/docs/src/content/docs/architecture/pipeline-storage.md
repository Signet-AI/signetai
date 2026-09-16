---
title: "Pipeline and storage"
description: "Canonical evidence, Dreaming, derived state, and bounded persistence work."
---

This page is an index of the current pipeline model. It keeps the ownership rules short; focused pages describe individual responsibilities.

## Database Schema

The schema and migrations live in `platform/core/src/migrations/` and execute through the database-owner process. The latest migration is `152-memory-artifact-sha-index.ts`.

## Current model

1. The daemon records agent-scoped evidence before interpreting it.
2. Dreaming selects bounded evidence and is the sole automatic semantic writer.
3. Non-semantic work maintains retrieval and operational projections.
4. The database owner applies durable transitions through its bounded protocol.
5. Derived state remains attributable, rebuildable, and purgeable from its source lifecycle.

No provider call runs inside a SQLite write transaction. Provider, fetch, embedding, and agent work happens before the short mutation phase.

## Focused pages

- [Dreaming and semantic operations](/pipeline/extraction-decisions/): current semantic path, evidence citations, audited ontology application, and the retired terminology boundary.
- [Workers and maintenance](/pipeline/workers-maintenance/): current non-semantic workers, admission, retention, repair, and provider lifecycle.
- [Continuity and lineage](/pipeline/continuity-lineage/): transcripts, checkpoints, canonical artifacts, and `MEMORY.md` as a projection.
- [Retrieval, graph traversal, and hints](/pipeline/knowledge-search/): evidence channels and derived retrieval signals.

## Compatibility terminology

“Pipeline V2” is compatibility terminology used by configuration and status surfaces. It names the current collection of supporting runtime controls and workers; it does not imply the historical per-memory extraction or decision pipeline is active. Retired inputs and executors must not be reactivated by compatibility code.

## Ownership

`platform/daemon` owns orchestration and lifecycle. `platform/core` owns schema, migrations, database access, and search primitives. The database owner is the only synchronous SQLite owner. Workspace artifacts remain source or lineage surfaces; FTS, vectors, graph indexes, safety ledgers, hints, and `MEMORY.md` are derived or controlled semantic state with an explicit source relationship.
