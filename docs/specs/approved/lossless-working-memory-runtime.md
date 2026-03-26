---
title: "Lossless Working Memory Runtime"
status: approved
informed_by:
  - "docs/research/technical/RESEARCH-LCM-ACP.md"
  - "docs/specs/planning/LCM-PATTERNS.md"
  - "docs/specs/approved/memory-md-temporal-head.md"
  - "docs/specs/complete/session-continuity-protocol.md"
success_criteria:
  - "One agent can accumulate context across many sessions and branches while rendering a single shared MEMORY.md head"
  - "Live transcripts are persisted with agent/session scoping and remain queryable before full structural distillation finishes"
  - "Session-end and compaction paths both feed the same temporal head model without splitting memory state across incompatible branches"
scope_boundary: "Defines the runtime behavior around MEMORY.md, live transcripts, session summaries, and compaction nodes. Does not replace the knowledge graph or retrieval scorer."
---

# Lossless Working Memory Runtime

## Context

The `memory-md-temporal-head` spec defines `MEMORY.md` as a rendered
temporal head. This contract defines how that head behaves at runtime.

The goal is not a periodic report. The goal is a live working-memory
system where one agent can move across many sessions, branches, and
harnesses while keeping a single coherent head.

## Core Runtime Invariant

One agent, many sessions, one head.

- different sessions and branches for the same agent write into the same
  temporal memory body
- `MEMORY.md` is the single rendered head over that body
- LCM patterns drive refinement over time, regardless of whether the
  source event was a prompt, a session end, or a compaction event

The rendered head must be both:

1. a dense operator-facing context buffer for immediate reinjection
2. a machine-facing index that points back to transcript, summary, and
   compaction lineage

## Temporal Ownership and Scoping

All temporal state must remain scoped by `agent_id` and `session_key`
where applicable.

- live transcripts are written with agent/session scoping
- session summaries inherit the same scoping
- compaction nodes inherit the same scoping
- lineage surfaced through `MEMORY.md` must preserve those identities
- identical `session_key` values across different agents must not
  collide, overwrite, or block transcript and summary persistence

Multiple instances of the same agent may write into the same temporal
index. Runtime must therefore use merge-safe write protection, lease
semantics, or equivalent conflict control so concurrent updates do not
silently clobber the rendered head.

## Live Session Behavior

### Session start

At session start, context is injected immediately from:

- `MEMORY.md`
- other workspace identity files
- any harness-specific instruction files already supported

The point of `MEMORY.md` is continuity. Starting `/new` should still let
the agent pick up where it left off.

### Session in progress

While a conversation is active:

- transcript content is written to the database in real time
- transcript rows become queryable as soon as they are persisted
- transcript content may be embedded eagerly when runtime allows
- structural distillation continues separately through the existing
  entity/aspect/attribute pipeline

Transcript retrieval is not the primary retrieval path. It is a fallback
source used when structured traversal cannot yet fire because the
session has not been fully distilled, or when transcript-specific query
behavior is explicitly needed.

## Session End Behavior

When a session ends:

- a session summary is written and attached to transcript lineage
- the summary becomes a temporal artifact in the DAG
- `MEMORY.md` is updated with a shorter rendered reflection of the
  useful state change
- the rendered head keeps references back to the deeper temporal nodes

The result should be dense and rich enough that the next new session can
resume with minimal context loss.

## Compaction Behavior

If a session does not end cleanly and instead compacts:

- lossless compaction methodology produces a compaction artifact
- that artifact is stored as a first-class temporal node
- it feeds the same LCM/DAG refinement path as ordinary session-end
  summaries
- `MEMORY.md` remains the same head rather than forking into a separate
  compaction-only state

In other words, compaction is not a different memory system. It is
another input path into the same one.

## Retrieval and Distillation

Throughout the session lifecycle:

- entities, aspects, and attributes are distilled continuously
- duplicates and stale structural facts are maintained through the
  distillation pipeline
- prompt-submit retrieval should prefer the structured memory body when
  available
- transcripts are the fallback source until structural state catches up

This keeps prompt-time retrieval focused on the most relevant context
without making raw transcripts the default source of truth.

## Harness Realization

Harnesses will realize this model with different fidelity depending on:

- which hooks exist
- whether prompt-loop control is available
- whether compaction can be intercepted
- whether transcripts can be streamed or only flushed at checkpoints

The ideal model stays constant. Each harness maps onto it as closely as
its runtime allows while preserving compatibility and scoping
invariants.

## Relationship to MEMORY.md

`MEMORY.md` is the universal context buffer for the agent, but it is not
the only stored state.

- it always references deeper temporal artifacts
- temporal artifacts must remain discoverable from it
- its visible section stays concise enough for reinjection
- its index section preserves drill-down handles into the temporal body

That is the working model going forward.
