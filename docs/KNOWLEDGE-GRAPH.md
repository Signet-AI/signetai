---
title: "Knowledge Graph"
description: "Implementation reference for Signet's scoped ontology and graph traversal layer."
order: 3
section: "Core Concepts"
---

# Knowledge Graph

The knowledge graph is Signet's scoped ontology storage and traversal layer. It
organizes raw memories, structured remember payloads, source artifacts, and
reviewed ontology operations into entities, aspects, grouped claim slots,
attributes, dependencies, proposals, and assertions.

For the conceptual model, see
[KNOWLEDGE-ARCHITECTURE.md](./KNOWLEDGE-ARCHITECTURE.md). This document is the
implementation reference.

## Core Tables

The base graph schema starts in migration 019 and is extended by later
migrations.

### `entities`

Top-level graph nodes. Important fields include:

- `id`
- `name`
- `canonical_name`
- `entity_type`
- `agent_id`
- `description`
- `mentions`
- `pinned`
- `pinned_at`
- `status`
- `archived_at`, `archived_by`, `archive_reason`
- `proposal_id`
- `proposal_evidence`
- `last_synthesized_at`
- timestamps

`ENTITY_TYPES` is defined in `platform/core/src/types.ts` and currently includes
people, projects, systems, tools, concepts, skills, tasks, sources, artifacts,
agents, policies, actions, workflows, events, object types, interfaces,
observations, claim slots, claim values, and `unknown`.

List queries filter to `agent_id` and active rows, then sort pinned entities
first:

```sql
ORDER BY e.pinned DESC, e.pinned_at DESC, e.mentions DESC, e.updated_at DESC, e.name ASC
```

### `entity_aspects`

Named dimensions under an entity. Important fields include:

- `id`
- `entity_id`
- `agent_id`
- `name`
- `canonical_name`
- `weight`
- `status`
- archive fields
- proposal fields
- timestamps

Aspects are unique on `(entity_id, canonical_name)`. Traversal reads active
aspects ordered by `weight DESC`.

### `entity_attributes`

Stored facts and constraints under an aspect. Important fields include:

- `id`
- `aspect_id`
- `agent_id`
- `memory_id`
- `kind`: `attribute` or `constraint`
- `content`
- `normalized_content`
- `group_key`
- `claim_key`
- `confidence`
- `importance`
- `status`: `active`, `superseded`, or `deleted`
- `superseded_by`
- `version`
- `version_root_id`
- `previous_attribute_id`
- archive fields
- source provenance fields
- proposal fields
- timestamps

`group_key` and `claim_key` are the navigation and update identity layer:

```text
entity -> aspect -> group_key -> claim_key -> attribute versions
```

When `group_key` is missing, navigation treats the row as part of `general`.
When `claim_key` is present, claim history and supersession are scoped to that
specific claim slot instead of the whole aspect.

### `entity_dependencies`

Directed cross-entity edges. Important fields include:

- `id`
- `source_entity_id`
- `target_entity_id`
- `agent_id`
- `aspect_id`
- `dependency_type`
- `strength`
- `confidence`
- `reason`
- `status`
- archive fields
- source provenance fields
- proposal fields
- timestamps

`DependencyType` is defined in `platform/core/src/types.ts`. Traversal currently
uses outgoing dependency edges and gates them by both:

```text
confidence * strength >= minDependencyStrength
confidence >= minConfidence
```

`related_to` edges require a non-empty reason. Migration 050 adds
`entity_dependency_history`, an append-only audit table populated by triggers
for dependency insert, update, and delete events.

### `task_meta`

Task lifecycle metadata keyed by `entity_id`. It stores `status`, `expires_at`,
`retention_until`, and `completed_at` for entities whose lifecycle should behave
like a task rather than durable background knowledge.

## Audit and Control Tables

### `ontology_proposals`

Proposal and operation history. Pending proposals are review queues; applied
rows are audit records for direct operation handlers. Fields include:

- `operation`
- `status`: `pending`, `applied`, `rejected`, or `failed`
- `payload`
- `confidence`
- `rationale`
- `evidence`
- `risk`
- source provenance
- `created_by`, `applied_by`, `rejected_by`
- `result`
- timestamps

The daemon operation handlers can run in three modes:

- dry-run: validate and preview without mutation
- apply: mutate graph rows and write an applied proposal row
- propose: write pending proposal rows for later review

### `epistemic_assertions`

Attribution records for statements that should not automatically become current
ontology truth. Fields include:

- `subject_entity_id`
- optional `claim_attribute_id`
- `predicate`: `claims`, `believes`, `observed`, `decided`, `prefers`,
  `denies`, or `questions`
- `content`
- `speaker`
- `asserted_at`
- `confidence`
- `evidence`
- source provenance
- `status`: `active`, `archived`, or `superseded`
- `supersedes_assertion_id`
- archive fields
- timestamps

Assertions can be linked to current claim attributes, but they remain a
separate evidence/attribution layer.

## Write Paths

### Structured Remember Payloads

Source: `platform/daemon/src/pipeline/graph-transactions.ts`

`txPersistStructured` writes caller-provided structured data from the remember
API. It:

1. persists extracted entity triples through `txPersistEntities`;
2. upserts mentioned entities;
3. upserts aspects by `(entity_id, canonical_name)`;
4. inserts attributes with optional `groupKey` and `claimKey`;
5. links rows to the source memory through `memory_id` and
   `memory_entity_mentions`;
6. supersedes likely conflicting sibling attributes in the same
   `aspect_id + group_key + claim_key` slot;
7. creates low-strength `related_to` dependencies between co-occurring
   structured entities.

If the source memory is decision-like, structured attributes are promoted to
`kind = 'constraint'`; otherwise they are normal attributes.

### Extracted Entity Mentions

`txPersistEntities` persists extracted source/relationship/target triples into
`entities`, the older `relations` table, and `memory_entity_mentions`.

This path links memories to entities and maintains mention counts. It does not
create aspect or attribute rows by itself.

### Pipeline Graph Writes

Background extraction graph writes are controlled by
`memory.pipelineV2.graph.extractionWritesEnabled`, which defaults to `true`.
Set it to `false` when graph traversal should stay enabled but the async
extractor should not author ontology structure.
When graph reads are enabled but extraction writes remain disabled, the daemon
emits a startup warning and `/api/diagnostics` exposes the disabled write gate
as `graph.extractionWritesEnabled: false`.

### Ontology Operation Handlers

Source: `platform/daemon/src/ontology-proposals.ts`

The control plane applies or proposes graph operations such as:

- `create_entity`
- `add_claim_value`
- `set_claim_value`
- `rename_entity`
- `archive_entity`
- `create_aspect`
- `rename_aspect`
- `archive_aspect`
- `archive_claim_value`
- `restore_claim_version`
- `create_link`
- `update_link`
- `archive_link`
- `merge_entities`
- `supersede_claim_value`
- policy, action type, and interface operations

These handlers are the preferred path for explicit ontology maintenance because
they validate inputs, preserve provenance, update version lineage, and leave an
audit row.

## Traversal

Source: `platform/daemon/src/pipeline/graph-traversal.ts`

Traversal resolves focal entities, walks a bounded subgraph, and returns memory
IDs plus structural metadata for recall.

### Focal Resolution

`resolveFocalEntities` gathers entities in this order:

1. pinned entities, unless disabled;
2. checkpoint entity IDs, when supplied;
3. project-path matches against project entities;
4. query-token matches using `entities_fts` when available, with LIKE fallback;
5. session-key fallback as source metadata when no entity resolves.

Pinned entities are merged into the focal set, not used as a replacement for
query or project matches.

### Walk Budget

`TraversalConfig` controls the walk:

| Field | Meaning |
|---|---|
| `scope` | Optional memory scope filter |
| `maxAspectsPerEntity` | Active aspects per entity, ordered by weight |
| `maxAttributesPerAspect` | Attribute memory IDs per aspect |
| `maxDependencyHops` | Historical config field; current walk uses branching and path budgets |
| `minDependencyStrength` | Minimum combined `confidence * strength` |
| `maxBranching` | Max outgoing edges per focal entity |
| `maxTraversalPaths` | Total memory ID budget |
| `minConfidence` | Minimum edge confidence |
| `timeoutMs` | Hard deadline |
| `aspectFilter` | Optional aspect-name filter for on-demand expansion |

### Collection Rules

For each entity, traversal:

1. collects active constraints across all active aspects;
2. fetches top active aspects by `weight DESC`;
3. collects active attribute `memory_id` values by `importance DESC`;
4. falls back to `memory_entity_mentions` if attributes do not yield enough
   memory IDs;
5. follows qualifying outgoing dependencies from the focal entity set;
6. records memory paths for feedback propagation and telemetry.

The result includes:

- `memoryIds`
- `memoryScores`
- `memoryPaths`
- `constraints`
- `entityCount`
- `timedOut`
- `activeAspectIds`
- `focalEntityIds`

Recall merges this graph result with vector, FTS, hint, structured-evidence,
reranker, dampening, and context-construction stages.

## Feedback and Maintenance

Source: `platform/daemon/src/pipeline/aspect-feedback.ts`

Aspect feedback is driven by session outcomes. FTS overlap can increase aspect
weights when previously injected memories later match full-text searches.
Aspect decay lowers stale weights toward a configured floor.

Source: `platform/daemon/src/pipeline/supersession.ts`

### Retroactive Supersession

Supersession detects and marks conflicting active sibling attributes. Structured
remember does this at write time for matching claim slots. Maintenance can also
catch older contradictions. Constraints are not automatically superseded by this
heuristic.

Source: `platform/daemon/src/knowledge-graph-hygiene.ts`

Hygiene reporting is read-only. It surfaces suspicious entities, duplicate
canonical groups, missing group/claim/source fields, and safe known-entity
mention candidates.

## HTTP API

Read-oriented graph endpoints live in `platform/daemon/src/routes/knowledge-routes.ts`.

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/knowledge/entities` | GET | List active entities with structural counts |
| `/api/knowledge/navigation/entities` | GET | Alias for paginated entity navigation |
| `/api/knowledge/navigation/entity` | GET | Resolve an entity by name |
| `/api/knowledge/navigation/tree` | GET | Entity -> aspect -> group -> claim outline |
| `/api/knowledge/navigation/aspects` | GET | List aspects for an entity |
| `/api/knowledge/navigation/groups` | GET | List groups under an entity/aspect |
| `/api/knowledge/navigation/claims` | GET | List claims under an entity/aspect/group |
| `/api/knowledge/navigation/attributes` | GET | List attributes for a claim path |
| `/api/knowledge/entities/:id` | GET | Entity detail and counts |
| `/api/knowledge/entities/:id/aspects` | GET | Aspect counts |
| `/api/knowledge/entities/:id/aspects/:aspectId/attributes` | GET | Attributes for an aspect |
| `/api/knowledge/entities/:id/dependencies` | GET | Incoming and outgoing dependencies |
| `/api/knowledge/entities/:id/pin` | POST | Pin an entity, requires `modify` |
| `/api/knowledge/entities/:id/pin` | DELETE | Unpin an entity, requires `modify` |
| `/api/knowledge/entities/pinned` | GET | List pinned entities |
| `/api/knowledge/entities/health` | GET | Predictor comparison health by entity |
| `/api/knowledge/hygiene` | GET | Read-only hygiene report |
| `/api/knowledge/stats` | GET | Graph coverage and feedback stats |
| `/api/knowledge/communities` | GET | Community summaries |
| `/api/knowledge/traversal/status` | GET | Last traversal telemetry |
| `/api/knowledge/constellation` | GET | Dashboard graph payload |
| `/api/knowledge/expand` | POST | Entity expansion with related memory/session context |
| `/api/knowledge/expand/session` | POST | Session-summary expansion |

Ontology-control endpoints live in `platform/daemon/src/routes/ontology-routes.ts`.

| Endpoint family | Purpose |
|---|---|
| `/api/ontology/operations/*` | Apply, dry-run, or batch explicit ontology operations |
| `/api/ontology/proposals/*` | List, create, apply, reject, and inspect proposals |
| `/api/ontology/proposals/repair/*` | Duplicate and merge-plan helpers |
| `/api/ontology/claims/*` | Claim evidence, versions, and version reads |
| `/api/ontology/links/*` | Link evidence |
| `/api/ontology/assertions/*` | Epistemic assertion CRUD and lifecycle |
| `/api/ontology/extract` | Extract proposals/assertions from a source |
| `/api/ontology/consolidate` | Consolidate proposals with optional provider support |

Mutation endpoints require `modify` permission. Read endpoints require recall
permission when auth is enabled.

Recall-related endpoints also use graph data:

| Endpoint | Method | Graph role |
|---|---|---|
| `/api/memory/recall` | POST | Merges traversal candidates with recall candidates |
| `/api/memory/search` | GET | Search with entity context |
| `/api/embeddings/projection` | GET | Dashboard memory projection; graph overlay comes from `/api/knowledge/constellation` |

## CLI Surfaces

Read navigation:

```bash
signet knowledge entities
signet knowledge tree <entity>
signet knowledge aspects <entity>
signet knowledge groups <entity> <aspect>
signet knowledge claims <entity> <aspect> <group>
signet knowledge attributes <entity> <aspect> <group> <claim>
signet knowledge hygiene
```

Control plane:

```bash
signet ontology entity ...
signet ontology claim ...
signet ontology aspect ...
signet ontology link ...
signet ontology stream apply ...
signet ontology assertion ...
signet ontology proposals ...
signet ontology extract ...
signet ontology consolidate ...
```

Use `--json` on either command family for automation.

## Dashboard Payload

`getKnowledgeGraphForConstellation` in `platform/daemon/src/knowledge-graph.ts`
builds the dashboard graph. It fetches active entities, aspects, attributes,
dependencies, proposal overlays, and dreaming summaries within bounded limits.
The dashboard then converts that payload into entity, aspect, attribute, memory,
proposal, and relationship nodes.

When the request does not include `agent_id`, `/api/knowledge/constellation`
uses the configured daemon agent ID (`SIGNET_AGENT_ID`, falling back to
`default`). The constellation payload includes rows owned by the requested
agent and rows owned by agents whose `read_policy` is `shared`, so the main
dashboard can surface shared named-agent graphs instead of showing an empty
default-agent view.

## Agent Scope

Every graph read or write must be scoped by `agent_id`. Route defaults should
resolve through the daemon's configured agent ID where possible; internal logic
should thread the resolved agent ID through queries and mutations rather than
relying on a global graph.

## See Also

- [KNOWLEDGE-ARCHITECTURE.md](./KNOWLEDGE-ARCHITECTURE.md)
- [PIPELINE.md](./PIPELINE.md)
- [API.md](./API.md)
- [dreaming-skill-runbook.md](./dreaming-skill-runbook.md)
- [knowledge-graph-control-plane.md](./knowledge-graph-control-plane.md)
