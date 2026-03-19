---
title: "Knowledge Graph"
description: "Structural memory layer organizing entities, aspects, attributes, and dependencies."
order: 3
section: "Core Concepts"
---

# Knowledge Graph

The knowledge graph is the structural layer of Signet's memory system. It organizes
raw memories into a navigable hierarchy of entities, aspects, attributes, and
dependencies, enabling deterministic context retrieval without relying solely on
embedding similarity. When the pipeline identifies what a session is about, the
graph is walked rather than searched — producing bounded, structurally coherent
context.

## Data Model

### Entity Hierarchy

The graph uses a three-tier hierarchy beneath each entity node:

```
entity
  └── aspect (named dimension of the entity)
        ├── attribute (an atomic fact, kind = 'attribute')
        └── constraint (a non-negotiable rule, kind = 'constraint')
```

Memory nodes attach at the attribute level: each `entity_attribute` row carries an
optional `memory_id` foreign key linking it back to the source `memories` row.

**Tables:**

`entities` — top-level nodes. Fields include `id`, `name`, `canonical_name`,
`entity_type`, `agent_id`, `description`, `mentions` (incremented on each pipeline
extraction hit), `pinned`, `pinned_at`, `created_at`, `updated_at`.

`entity_aspects` — named dimensions of an entity. Unique on
`(entity_id, canonical_name)`. Key fields:
- `weight` (REAL, default 0.5) — learned salience of this aspect; updated by the
  behavioral feedback loop
- `canonical_name` — lowercased, whitespace-normalized form of `name`; used for
  deduplication

`entity_attributes` — facts and constraints attached to an aspect. Key fields:
- `kind` (TEXT) — either `'attribute'` (informational) or `'constraint'`
  (non-negotiable; always surfaced during traversal regardless of weight)
- `status` (TEXT) — `'active'`, `'superseded'`, or `'deleted'`
- `superseded_by` (TEXT, nullable) — ID of the attribute that replaced this one
- `memory_id` (TEXT, nullable) — source memory row
- `confidence` (REAL, default 0.0), `importance` (REAL, default 0.5)

`memory_entity_mentions` — join table linking memories to entities extracted from
them. Created by the extraction pipeline via `txPersistEntities`. Fields:
`memory_id`, `entity_id`, `mention_text`, `confidence`, `created_at`.

### Entity Dependencies

`entity_dependencies` — directed edges between entities. Unique on
`(source_entity_id, target_entity_id, dependency_type)`. Key fields:
- `dependency_type` (TEXT) — the type of relationship. Values come from the
  `DependencyType` union in `@signet/core` (e.g. `'uses'`, `'depends_on'`,
  `'related_to'`, `'part_of'`)
- `strength` (REAL, default 0.5) — edge weight; used by traversal to filter
  low-confidence hops
- `aspect_id` (TEXT, nullable) — the aspect on the source entity that motivated
  this dependency, if known

During traversal, the graph follows outgoing dependency edges from focal entities,
collecting attributes from neighbors whose `strength >= minDependencyStrength`
(default 0.3).

### Entity Pinning

Pinning is stored directly on the `entities` table (migration 022):
- `pinned` (INTEGER, default 0) — boolean flag
- `pinned_at` (TEXT, nullable) — ISO timestamp of when the entity was pinned

Pinned entities are always included as focal entities during traversal, regardless
of project path matching or query token matching. They are collected first by
`resolveFocalEntities` before any other resolution strategy runs, and the final
focal set is the union of pinned IDs and context-resolved IDs.

In list queries (`listKnowledgeEntities`), pinned entities sort to the top:
`ORDER BY e.pinned DESC, e.pinned_at DESC, e.mentions DESC`.

## Graph Traversal

Source: `packages/daemon/src/pipeline/graph-traversal.ts`

### Focal Entity Resolution

Before walking the graph, traversal resolves a set of focal entities from
available signals, in priority order:

1. **Checkpoint entity IDs** — if a session checkpoint carried entity IDs forward
   from a prior session, those are used directly (source = `"checkpoint"`)
2. **Project path** — path components of the current project directory are matched
   against entity `canonical_name` / `name` with `LIKE` queries, filtered to
   `entity_type = 'project'`, ordered by `mentions DESC`, limit 5
   (source = `"project"`)
3. **Query tokens** — normalized tokens from the recall query are matched across
   all entity types, limit 20 (source = `"query"`)
4. **Session key** — fallback label when nothing else resolves
   (source = `"session_key"`)

Pinned entities are fetched independently and merged into the focal set regardless
of which resolution path fired.

### Walk Algorithm

`traverseKnowledgeGraph` takes the focal entity IDs and walks the graph within
a configurable budget:

| Config field | Default | Description |
|---|---|---|
| `maxAspectsPerEntity` | 10 | Aspects per entity, ordered by `weight DESC` |
| `maxAttributesPerAspect` | 20 | Attributes per aspect, ordered by `importance DESC` |
| `maxDependencyHops` | 30 | One-hop neighbor expansions |
| `minDependencyStrength` | 0.3 | Minimum edge strength to follow |
| `timeoutMs` | 500 | Hard deadline for the entire walk |

For each focal entity, the walk:
1. Collects all `kind = 'constraint'` attributes across all aspects (no
   aspect-count limit — constraints always surface)
2. Fetches top-N aspects by `weight DESC`
3. For each aspect, collects top-M attribute `memory_id` values
4. After all focal entities are processed, expands one hop via outgoing
   `entity_dependencies` edges where `strength >= minDependencyStrength`,
   ordered by `strength DESC`, capped at `maxDependencyHops`
5. Runs `collectForEntity` on each neighbor (visited-entity deduplication
   prevents cycles)

The walk returns a `TraversalResult` containing the collected `memoryIds` set,
the `constraints` array (sorted by importance descending), the count of traversed
entities, whether the timeout fired, and the `activeAspectIds` list. The calling
code merges `memoryIds` with vector/FTS search results before ranking.

A module-level `traversalTablesAvailableCache` flag (invalidated via
`invalidateTraversalCache()`) prevents redundant `sqlite_master` checks after the
tables are confirmed present.

## Behavioral Feedback Loop

Source: `packages/daemon/src/pipeline/aspect-feedback.ts`

The feedback loop adjusts aspect weights based on actual usage signals at session
end. Two mechanisms run:

### FTS Overlap Feedback (`applyFtsOverlapFeedback`)

After a session, the pipeline queries `session_memories` for rows belonging to
that session where `fts_hit_count > 0`. These are memories that were both
injected at session-start and later hit in a full-text search — behavioral
confirmation that the injection was useful.

For each confirmed memory, the code looks up its associated `aspect_id` via
`entity_attributes` (one per memory, status = `'active'`). It accumulates
confirmation counts per aspect, then applies:

```
new_weight = clamp(
  current_weight + delta * confirmations,
  minWeight,
  maxWeight
)
```

Default `delta` is configured in `PipelineV2Config`; `maxWeight` caps at 1.0
and `minWeight` floors at 0.1. Aspects with more FTS confirmations receive
larger weight increases.

### Aspect Decay (`decayAspectWeights`)

Aspects that haven't been updated within `staleDays` days and have weight above
`minWeight` are decayed:

```
new_weight = max(minWeight, current_weight - decayRate)
```

Decay runs on a configurable interval (checked via `shouldRunSessionDecay` which
throttles to every N sessions per agent). This ensures weights drift down over
time for aspects that are no longer confirmed by actual usage.

Both functions record telemetry via `recordFeedbackTelemetry`, accessible
through `getFeedbackTelemetry()`.

## Graph Persistence

Source: `packages/daemon/src/pipeline/graph-transactions.ts`

Two transaction closures handle the write path for the extraction pipeline:

**`txPersistEntities(db, input)`** — called after the LLM extraction step produces
entity triples. For each triple:
- Upserts source and target entities by `canonical_name` (names shorter than 4
  characters are rejected). On conflict, increments `mentions` and optionally
  upgrades `entity_type` from `'extracted'` to a more specific type
- Upserts the relation between source and target in the `relations` table, updating
  confidence via running average on conflict
- Inserts `memory_entity_mentions` rows linking both entities to the source memory
  (`INSERT OR IGNORE` for idempotency)

**`txDecrementEntityMentions(db, input)`** — called when memories are purged.
Decrements `mentions` for affected entities (floor at 0), then deletes entities
whose mentions reach 0, cleaning up dangling `relations` and
`memory_entity_mentions` rows in the same transaction.

Both closures are designed to run inside a `withWriteTx` wrapper; they take a
`WriteDb` handle rather than a `DbAccessor` so they can participate in a larger
transaction.

The higher-level CRUD layer (`knowledge-graph.ts`) uses `upsertAspect`,
`createAttribute`, and `upsertDependency` for manual and pipeline writes.
Attribute lifecycle transitions (supersede, delete) are soft: status is set to
`'superseded'` or `'deleted'` rather than row deletion. `propagateMemoryStatus`
sweeps attributes whose `memory_id` refers to a deleted memory and marks them
`'superseded'`.

### Retroactive Supersession

Beyond orphaned-memory cleanup, `supersession.ts` detects contradictions
between active sibling attributes on the same aspect. Two paths trigger this:
an inline pass after `structural_classify` populates `aspect_id` (catching
contradictions at classification time), and a periodic sweep in the
maintenance worker (catching pre-existing contradictions across sessions).
Detection uses a four-signal heuristic (negation polarity, antonym pairs,
value conflict, temporal markers) with an optional LLM fallback via
`detectSemanticContradiction()`. Attributes with `kind='constraint'` are
never auto-superseded. See the
[retroactive supersession spec](./specs/planning/retroactive-supersession.md)
for full design details.

## API

Graph data is surfaced through these HTTP API endpoints on the daemon:

| Endpoint | Method | Description |
|---|---|---|
| `/api/embeddings/projection` | GET | UMAP 2D/3D projection; constellation view fetches this to position memory nodes. Graph overlay data (`/api/knowledge/constellation`) is fetched separately |
| `/api/memory/recall` | POST | Hybrid search; traversal results are merged with vector/FTS candidates before reranking |
| `/api/memory/search` | GET | Keyword search; entity context is injected into results |

The constellation overlay is served by `getKnowledgeGraphForConstellation` in
`knowledge-graph.ts`. It fetches up to 500 entities (filtered to those with
`mentions > 0`, `pinned = 1`, or at least one aspect), their aspects and active
attributes, and all dependencies where both endpoints are in the fetched set.

## See Also

- [KNOWLEDGE-ARCHITECTURE.md](./KNOWLEDGE-ARCHITECTURE.md) — conceptual design and
  rationale for the entity/aspect/constraint model
- [DASHBOARD.md](./DASHBOARD.md) — constellation visualization that renders the
  graph
- [PIPELINE.md](./PIPELINE.md) — how the graph is populated during extraction
