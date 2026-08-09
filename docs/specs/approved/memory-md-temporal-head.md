---
title: "MEMORY.md Temporal Head"
status: approved
informed_by:
  - "docs/research/technical/RESEARCH-LCM-ACP.md"
  - "docs/specs/planning/LCM-PATTERNS.md"
  - "docs/specs/approved/desire-paths-epic.md"
success_criteria:
  - "MEMORY.md is rendered from decay-scored database state instead of flat markdown session-summary merges"
  - "Session-end and compaction-complete both produce temporal artifacts that can be surfaced in MEMORY.md"
  - "Rendered MEMORY.md exposes drill-down lineage to temporal nodes and transcripts without flooding the visible summary"
scope_boundary: "Defines MEMORY.md as a rendered temporal head. Does not replace the knowledge graph or predictor."
---

# MEMORY.md Temporal Head

## Context

`MEMORY.md` began as a generated working-memory document stitched from
session summary markdown files. That was useful as a stopgap, but it
left three gaps:

1. stale content persisted because synthesis operated on flat files
   rather than scored database state
2. compaction artifacts were stored as loose memories instead of
   temporal first-class artifacts
3. the rendered file had no durable lineage back to the temporal graph
   that produced it

Issue #218 locked in the requirement that regeneration must be
decay-aware, pin-aware, and budgeted by score rather than position.
LCM research adds the missing temporal shape: transcript-derived leaves,
higher-order condensed nodes, and drill-down lineage.

## Contract

`MEMORY.md` is the rendered temporal head of Signet's lossless working
memory system.

- lossless transcript context is retained in `session_transcripts`; the
  Dreaming content pass creates a sanitized read-time projection
- temporal manifest nodes are written to `session_summaries` by the
  Dreaming content pass
- `MEMORY.md` is a materialized working document rendered from scored
  database state, not assembled from markdown files

The rendered document has two layers:

1. **Operator-facing summary**
   - active projects and threads
   - decisions and constraints
   - relevant people / relationships
   - open blockers and current technical notes

2. **Machine-facing lineage**
   - temporal node identifiers
   - provenance (`transcript`, `summary` for historical rows, `chunk`,
    `compaction`, `condensation`)
   - parent/child traversal handles
   - transcript/session references for drill-down

## Temporal Model

The existing `session_summaries` DAG remains the temporal backbone, but
depth-0 artifacts are distinguished by provenance:

- `transcript` — direct completed-transcript session node written by
  Dreaming's content pass
- `summary` — historical session node retained for provenance only
- `chunk` — transcript-derived leaf node
- `compaction` — harness compaction artifact
- `condensation` — arc/epoch nodes

Compaction artifacts are first-class temporal nodes. They do not
overwrite session summaries.

## Rendering Rules

- `MEMORY.md` is rendered from DB-backed candidate selection
- memories and temporal artifacts are ranked by decay-aware score
- pinned memories are exempt from decay
- under budget pressure, lowest-scoring items are dropped first
- empty sections disappear naturally instead of leaving dead scaffolding
- deep history stays in drill-down tools and temporal lineage, not in
  the visible summary body

## Routing Resolution

`MEMORY.md` model selection must use the canonical inference workload:

- the internal `session_synthesis` operation inherits the routed
  `memoryExtraction` workload
- retired `memory.pipelineV2.synthesis.*` settings are rejected instead of
  selecting or inheriting a provider
- missing or invalid workload routing is surfaced as an error
- deterministic portions of MEMORY.md rendering must continue to work
  even when LLM-backed synthesis is unavailable

## Integration Notes

- Depends on `memory-pipeline-v2` and `session-continuity-protocol`
- Extends the temporal side of `desire-paths-epic`
- Must preserve agent scoping on all new temporal writes
- Rust parity work should follow once the TypeScript behavior is stable
