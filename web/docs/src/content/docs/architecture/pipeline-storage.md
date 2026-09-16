---
title: "Pipeline and storage"
description: "Canonical evidence, Dreaming, derived state, and bounded persistence work."
---

Signet is a local-first memory and context layer. This page is the compact operator reference for ownership, durable state, and recovery; detailed procedures are in [Workers and maintenance](/pipeline/workers-maintenance/).

## Database Schema

The schema and migrations live in `platform/core/src/migrations/` and execute through the database-owner process. The latest migration is `152-memory-artifact-sha-index.ts`.

`platform/daemon` owns orchestration and lifecycle. `platform/core` owns schema, migrations, database access, and search primitives. Exactly one database-owner process has synchronous SQLite access. Requests and workers cross its bounded asynchronous protocol; they do not open the workspace database or use a fallback owner.

## Canonical pipeline

1. The daemon resolves identity and agent scope and records evidence, source provenance, and audit context first.
2. Ingest checkpoints, leases, outcomes, and retries are durable. Restart recovery reclaims stale leases without duplicating committed evidence.
3. Dreaming admits bounded, agent-scoped evidence and is the sole automatic writer of semantic truth.
4. Embeddings, FTS, vector/ANN mirrors, graph indexes, hints, summaries, and `MEMORY.md` are derived or projected state.
5. Maintenance can inspect, rebuild, resync, retain, or purge derived state from authoritative sources, but cannot create or rewrite semantic claims.

No provider, fetch, embedding, or agent call runs inside a SQLite write transaction. External work completes under a deadline before the short durable mutation phase.

## State and recovery invariants

Queue status must distinguish queued, leased/running, stale, retryable, dead/failed, cancelled, and completed work. Repairs are dry-run first, explicitly scoped, capped, idempotent, and audited. Requeue, cancel, and prune preserve job provenance, lease generation, retry history, and operator identity; pruning never removes active work, source evidence, or lineage needed to explain derived state.

Index health is separate from storage health. Coverage, model/dimension compatibility, orphaned rows, FTS/vector consistency, and freshness are checked independently. Incomplete coverage or a partial index is reported as degraded and repaired by rebuilding from authoritative evidence or memory content.

Dreaming admission requires durable evidence and attributable citations. A pass
enforces its write cap before audited ontology application. The durable
consumption watermark is exposed as `state.evidenceCursor` by
`GET /api/dream/status`; it is an episodic cursor (captured time, kind, and
source/evidence id), not the numeric SSE event resume cursor. The pass advances
that cursor only through durably handled evidence and never past skipped or
failed work. Cancellation, timeout, provider failure, and owner loss remain
visible terminal outcomes. Audit records retain scope, pass, evidence,
operation, cap decision, and result.

Operators should inspect the scoped status and pass records through
`GET /api/dream/status`, `GET /api/dream/passes/active`, and the read-only
`GET /api/dream/passes/:passId/events` stream. If evidence was intentionally
excluded, use `POST /api/dream/exclusions/requeue` to request requeue; to make
forward progress, use the bounded `POST /api/dream/trigger` route. The API does
not expose a separate numeric consumption-cursor repair endpoint, so recovery
must use these status, pass, exclusion, and trigger surfaces rather than an
obsolete extraction-worker control path.

These rules preserve the distinction between source truth and derived state: every projection is attributable, rebuildable, correctable, and purgeable through its source lifecycle.

## Focused pages

- [Dreaming and semantic operations](/pipeline/extraction-decisions/): evidence citations, audited ontology application, and retired terminology.
- [Workers and maintenance](/pipeline/workers-maintenance/): queue diagnostics, repair controls, ingest recovery, and index health.
- [Continuity and lineage](/pipeline/continuity-lineage/): transcripts, checkpoints, canonical artifacts, and projections.
- [Retrieval, graph traversal, and hints](/pipeline/knowledge-search/): evidence channels and derived retrieval signals.

## Compatibility terminology

“Pipeline V2” is compatibility terminology in configuration and status surfaces. It names the current supporting controls and workers; it does not restore historical per-memory extraction or decision executors. Unsupported or retired inputs fail explicitly.
