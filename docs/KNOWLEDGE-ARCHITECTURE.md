---
title: "Knowledge Architecture"
description: "How Signet organizes memory into scoped, navigable, auditable knowledge."
order: 2
section: "Core Concepts"
---

# Knowledge Architecture

Signet's knowledge architecture is the structured layer above raw memories,
transcripts, and connected sources. Its job is not to replace recall search or
to build a complete world model. Its job is to turn user-owned evidence into a
bounded, inspectable candidate pool that agents can use before flatter retrieval
and reranking finish the job.

The current system has four responsibilities:

1. Preserve source truth in memories, transcripts, and source artifacts.
2. Store current operational knowledge as scoped ontology rows.
3. Keep attribution, proposals, and version history available for audit.
4. Shape recall with graph traversal, structured evidence, and hybrid search.

The implementation reference is [KNOWLEDGE-GRAPH.md](./KNOWLEDGE-GRAPH.md).
This document describes the model and the boundaries that should guide future
changes.

## Source Truth and Current Truth

Signet separates evidence from current ontology truth.

Raw evidence lives in sources such as:

- `memories`
- session transcripts and summaries
- source artifacts from connected knowledge bases
- proposal evidence and source provenance fields
- epistemic assertions for attributed statements

Current operational truth lives in ontology rows:

- `entities`
- `entity_aspects`
- `entity_attributes`
- `entity_dependencies`

This split matters. A transcript can record that someone said a thing. An
epistemic assertion can preserve who said it, when, with what confidence, and
where the evidence came from. An `entity_attribute` represents the current claim
value Signet should use when acting. These are related, but they are not the same
layer.

## Ontology Shape

The main navigable shape is:

```text
entity
  aspect
    group_key
      claim_key
        entity_attribute
```

An entity is a durable semantic object: a person, project, system, tool, source,
artifact, agent, policy, workflow, event, interface, observation, claim slot, or
claim value. The supported type vocabulary is defined in `ENTITY_TYPES` in
`platform/core/src/types.ts`.

An aspect is a broad dimension of an entity, such as build, identity, auth, or
collaboration. Aspects carry a `weight` used by traversal and feedback.

A group key is a navigable subdivision inside an aspect. It keeps broad aspects
from turning into undifferentiated lists.

A claim key identifies a specific updateable slot inside a group. Supersession
and version history are meaningful at this level: a new value for
`build/tooling/package_manager` can replace an older value without making every
other build fact obsolete.

An attribute is the stored value. It has a `kind` of either `attribute` or
`constraint`. Constraints represent rules that should be surfaced during graph
traversal regardless of ordinary aspect limits.

## Links and Tasks

Cross-entity relationships live in `entity_dependencies`. These are directed
edges with:

- `dependency_type`
- `strength`
- `confidence`
- optional `reason`
- optional source and proposal provenance

Traversal currently follows outgoing dependency edges whose combined
`confidence * strength` and confidence floor pass the configured thresholds.
Loose `related_to` edges require a non-empty reason so they remain auditable.

Tasks are represented as entities plus `task_meta`. They can use the same graph
vocabulary as other entities, but their lifecycle is different: task status,
expiration, and retention are tracked separately so completed work does not have
to behave like permanent world knowledge.

## Mutation Model

Current ontology maintenance is apply-first when an operation is explicit and
bounded. The daemon exposes operation handlers that can dry-run, apply, or write
reviewable proposals using the same operation payloads.

The core operation surface includes:

- creating, renaming, archiving, and merging entities
- creating, renaming, and archiving aspects
- adding, setting, superseding, restoring, and archiving claim values
- creating, updating, and archiving links
- importing or managing attributed epistemic assertions

Every applied ontology operation writes an `ontology_proposals` row as audit
history. Pending proposals still exist, but they are for broad graph refactors,
risky maintenance, duplicate-merge campaigns, or explicit review queues rather
than for every small update.

Claim values carry version lineage through `version`, `version_root_id`, and
`previous_attribute_id`. Archive fields keep deleted ontology rows reviewable
without hard-deleting their history.

## Retrieval Role

The graph is a candidate shaper, not the whole recall system.

At session start or recall time, Signet resolves focal entities from checkpoint
entity IDs, project path, query tokens, and pinned entities. It then walks a
bounded portion of the graph:

- constraints for each focal entity
- top weighted aspects
- top attributes with linked memory IDs
- mention-linked fallback memories
- one-hop outgoing dependencies within confidence and strength budgets

The traversal result is merged with other recall candidates, including FTS,
hints, embeddings, structured evidence, reranking, dampening, and context
assembly. The graph gives recall a structured floor; it does not remove the need
for search.

## Feedback

Aspect feedback is intentionally narrow. The current daemon adjusts aspect
weights from usage signals such as FTS overlap and applies decay to stale
aspects. Entity pinning is a manual inclusion mechanism: pinned entities are
always considered focal entities during traversal and sort first in list views.

Do not document autonomous constraint lifecycle, visual confidence signals, or
complete self-maintaining graph behavior unless the code implements them. Today,
constraints are stored as attributes with `kind = 'constraint'`; they surface in
traversal, but there is no separate constraint-confidence lifecycle exposed to
users.

## Navigation Surfaces

The user and agents can inspect the graph through:

- `signet knowledge ...` for read-oriented navigation
- `signet ontology ...` for apply/propose/assertion/control-plane operations
- `/api/knowledge/*` for entities, tree navigation, hygiene, stats, traversal,
  expansion, and the constellation payload
- `/api/ontology/*` for proposals, operations, claim evidence, link evidence,
  claim versions, merge planning, extraction, consolidation, and assertions
- the dashboard ontology/constellation view

All user-data reads and writes are agent-scoped. New code should thread
`agent_id` through every graph read and mutation rather than falling back to an
implicit global graph.

## Design Rule

The architecture should stay small enough to inspect and strict enough to trust:

- evidence remains distinguishable from current truth;
- current truth is scoped, versioned, and auditable;
- traversal is bounded and observable;
- broad graph refactors can be reviewed before mutation;
- explicit local operations can apply immediately with provenance.

When this document and [KNOWLEDGE-GRAPH.md](./KNOWLEDGE-GRAPH.md) disagree, the
code in `platform/core/src/migrations/`, `platform/daemon/src/knowledge-graph.ts`,
`platform/daemon/src/routes/knowledge-routes.ts`,
`platform/daemon/src/routes/ontology-routes.ts`, and
`platform/daemon/src/pipeline/graph-traversal.ts` is the source of truth.
