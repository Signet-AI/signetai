---
title: "Sprint Brief: Knowledge Architecture KA-2"
---

# Sprint Brief: Knowledge Architecture KA-2

Structural Assignment Pipeline (Two-Pass)

---

## What You're Building

Facts extracted by the pipeline get structurally assigned to entities,
aspects, and constraints. This is the bridge between flat fact storage
and the structured knowledge graph described in
`docs/KNOWLEDGE-ARCHITECTURE.md`.

The architecture is two-pass:
- **Pass 1** runs synchronously after extraction. No LLM. Links facts
  to their primary entity.
- **Pass 2** runs in the background as pipeline jobs. Uses LLM to
  classify aspects/constraints (2a) and extract dependencies (2b).

## Required Reading

1. `docs/specs/INDEX.md` — Cross-Cutting Invariants
2. `docs/specs/complete/knowledge-architecture-schema.md` — section 6
   (structural assignment architecture)
3. `docs/KNOWLEDGE-ARCHITECTURE.md` — conceptual model
4. `docs/specs/SPRINT-BRIEF-KA1.md` — KA-1 deliverables (schema and
   helpers this sprint depends on)

## Prerequisites

KA-1 must be complete before this sprint begins:
- Migration 019 landed (entity_aspects, entity_attributes,
  entity_dependencies, task_meta tables exist)
- Core types exported (EntityAspect, EntityAttribute, etc.)
- Read/write helpers in `knowledge-graph.ts` working

## Deliverables

### 1. Pass 1: Heuristic entity linking

**Where:** Hook into `worker.ts` after `txPersistEntities` completes.

After extraction persists entity triples and the decision phase writes
new fact memories, run pass 1 for each written fact:

1. Look up the primary entity from the extraction triple's `source`
   field (already in `entities` table via `txPersistEntities`)
2. Create a stub `entity_attributes` row:
   ```typescript
   {
     id: crypto.randomUUID(),
     aspectId: null,          // awaiting classification
     agentId: 'default',
     memoryId: newMemoryId,   // the fact memory just written
     kind: 'attribute',       // default, may be reclassified
     content: factContent,
     normalizedContent: normalizedFactContent,
     confidence: fact.confidence,
     importance: 0.5,         // default
     status: 'active',
     supersededBy: null,
   }
   ```
3. Enqueue `structural_classify` job for this fact
4. If the extraction triple has a target entity that exists in the
   graph, also enqueue `structural_dependency` job

**Schema note:** `entity_attributes.aspect_id` is NOT NULL in the
current spec. For pass 1 stubs, either:
- (a) Create a catch-all "unclassified" aspect per entity, or
- (b) ALTER the FK to allow NULL (preferred — cleaner, no fake aspects)

Recommend option (b): update migration 019 to make `aspect_id`
nullable. Facts with `aspect_id = NULL` are valid and mean "awaiting
structural classification."

**Key constraint:** Pass 1 must NOT call the LLM. It runs on the hot
path inside the existing extraction worker. Keep it fast.

### 2. New job types in pipeline

Add two new job types alongside the existing `'extract'` type:

```typescript
type PipelineJobType = 'extract' | 'structural_classify' | 'structural_dependency';
```

Both use the same `memory_jobs` table with different `job_type` values.
Same lease/retry/dead-letter mechanics. Same exponential backoff.

**Job payload for `structural_classify`:**
```json
{
  "memory_id": "...",
  "entity_id": "...",
  "entity_name": "...",
  "entity_type": "project",
  "fact_content": "ooIDE uses bun as its package manager",
  "attribute_id": "..."
}
```

**Job payload for `structural_dependency`:**
```json
{
  "memory_id": "...",
  "entity_id": "...",
  "entity_name": "...",
  "fact_content": "ooIDE uses WorkOS AuthKit for authentication",
  "target_entity_name": "WorkOS"
}
```

### 3. Pass 2a: Structural classification worker

New file: `packages/daemon/src/pipeline/structural-classify.ts`

This worker:
1. Leases `structural_classify` jobs in batches (group by entity_id,
   max 8-10 per batch)
2. Loads the entity's existing aspects from `entity_aspects`
3. Builds the classification prompt (see Prompt Specifications below)
4. Parses the LLM response
5. For each classified fact:
   - Upsert the aspect via `upsertAspect()` from `knowledge-graph.ts`
   - Update the `entity_attributes` row: set `aspect_id` and `kind`
6. Mark jobs completed

**Batching strategy:** Group pending `structural_classify` jobs by
`entity_id`. Process one entity's batch at a time. This ensures the
prompt has accurate "existing aspects" context.

**Error handling:** If the LLM returns malformed JSON or drops facts
from the batch, mark only the successfully parsed facts as completed.
Failed facts stay pending for retry.

### 4. Pass 2b: Dependency extraction worker

New file: `packages/daemon/src/pipeline/structural-dependency.ts`

This worker:
1. Leases `structural_dependency` jobs in batches (max 5 per batch)
2. Builds the dependency prompt (see Prompt Specifications below)
3. Parses the LLM response
4. For each identified dependency:
   - Resolve target entity in the graph (by canonical_name)
   - Call `upsertDependency()` from `knowledge-graph.ts`
5. Mark jobs completed

**Pre-filter:** Only facts whose extraction triples have a target
entity that exists in the `entities` table should get
`structural_dependency` jobs. Skip self-referential facts.

### 5. Worker lifecycle integration

Wire both workers into the daemon alongside the existing extraction
worker. They should:
- Start after the extraction worker is initialized
- Share the same `LlmProvider` instance
- Respect `procedural.enabled` and `mutationsFrozen` config flags
- Poll on a configurable interval (separate from extraction polling)
- Stop cleanly in `cleanup()`

Suggested config additions to `PipelineV2Config`:

```typescript
readonly structural?: {
  readonly enabled: boolean;              // default true
  readonly classifyBatchSize: number;     // default 8
  readonly dependencyBatchSize: number;   // default 5
  readonly pollIntervalMs: number;        // default 10000
};
```

### 6. Aspect type suggestions

New file or constant map:
`packages/daemon/src/pipeline/aspect-suggestions.ts`

A mapping from entity type to suggested aspect names. Used in the
classification prompt to guide the LLM:

```typescript
export const ASPECT_SUGGESTIONS: Record<string, readonly string[]> = {
  project: [
    'architecture', 'dependencies', 'deployment', 'auth',
    'data model', 'testing', 'team', 'configuration',
    'development workflow', 'api', 'frontend', 'backend',
    'infrastructure', 'security',
  ],
  person: [
    'preferences', 'communication style', 'expertise',
    'projects', 'decision patterns', 'background',
    'boundaries', 'work habits',
  ],
  tool: [
    'capabilities', 'configuration', 'integration',
    'usage patterns', 'limitations',
  ],
  system: [
    'architecture', 'endpoints', 'configuration',
    'dependencies', 'security', 'monitoring',
  ],
  concept: [
    'definition', 'relationships', 'applications',
    'constraints',
  ],
  skill: [
    'capabilities', 'usage', 'configuration',
    'triggers', 'limitations',
  ],
  task: [
    'requirements', 'dependencies', 'status',
    'blockers', 'deliverables',
  ],
  unknown: [
    'general', 'relationships', 'properties',
  ],
};
```

---

## Prompt Specifications

These prompts were tested against qwen3:4b via Ollama on 2026-03-04.
On 2026-03-29, the dependency prompt was tightened with explicit
cardinality rules, null-handling rules, and compact verb-specific
examples. After that change, `nemotron-3-nano:4b` passed the live
structural dependency harness across all scenarios (21/21 dependency
types, 5/5 scenarios parseable). Results documented below each prompt.

### Classification Prompt (Pass 2a)

```text
Classify each fact into an aspect and kind for the given entity.

Entity: {entityName} ({entityType})
Existing aspects: {existingAspects | "[none yet]"}
Suggested: {ASPECT_SUGGESTIONS[entityType].join(", ")}

Facts:
1. {fact1}
2. {fact2}
...
N. {factN}

JSON array, each: {"i": number, "aspect": string, "kind": "attribute"|"constraint", "new": boolean}
/no_think
```

**Template variables:**
- `{entityName}` — entity.name from DB
- `{entityType}` — entity.entity_type from DB
- `{existingAspects}` — comma-separated list of existing aspect names
  for this entity, or `"[none yet]"` if empty
- `{facts}` — numbered list of fact content strings
- Max 8-10 facts per batch

**LLM settings:**
- Model: same as extraction worker (default `qwen3:4b`)
- Temperature: 0.1
- `/no_think` appended to suppress chain-of-thought

**Expected output:**
```json
[
  {"i": 1, "aspect": "auth system", "kind": "attribute", "new": false},
  {"i": 2, "aspect": "boundaries", "kind": "constraint", "new": true}
]
```

**Field definitions:**
- `i` — 1-indexed fact number matching the input list
- `aspect` — existing aspect name OR new aspect name to create
- `kind` — `"attribute"` for regular facts, `"constraint"` for rules
  that must always be followed
- `new` — `true` if this creates a new aspect, `false` if using an
  existing one

**Tested results (qwen3:4b):**
- 10 facts, project entity: 9/10 correct classifications, 1 debatable
  (monorepo structure → "dependencies" vs "architecture")
- 12 facts, person entity: 12/12 correct with tighter prompt format
- 20 facts: degraded — dropped 4 facts, lost format discipline. Hard
  limit is ~10 facts per batch.
- Constraint detection is strong: "never push to main", "must include
  agent_id", "always run typecheck" all correctly identified
- New aspect creation works: model suggests "frontend", "backend",
  "boundaries" when not in existing list
- Existing aspect reuse works: model correctly uses existing aspects
  and sets `new: false`

**Known failure modes:**
- >12 facts: starts dropping facts from output
- >15 facts: may hallucinate fact content or change field names
- Verbose prompt preamble: causes format confusion. Keep it minimal.
- Long field names in JSON schema: use short names (i, aspect, kind, new)

### Dependency Prompt (Pass 2b)

```text
Classify each fact. Also identify if the fact implies a dependency between entities.

Entity: {entityName} ({entityType})
Aspects: {existingAspects}

Dependency types: uses, requires, owned_by, blocks, informs

1. {fact1}
2. {fact2}
...
N. {factN}

For each fact return: {"i": N, "aspect": "...", "kind": "attribute"|"constraint", "dep_target": "entity or null", "dep_type": "type or null"}
/no_think
```

**Template variables:**
- Same as classification prompt
- Max 5 facts per batch (stricter limit due to more complex output)

**LLM settings:**
- Model: same as extraction worker (default `qwen3:4b`)
- Temperature: 0.1
- `/no_think` appended

**Expected output:**
```json
[
  {
    "i": 1,
    "aspect": "auth system",
    "kind": "attribute",
    "dep_target": "WorkOS AuthKit",
    "dep_type": "uses"
  },
  {
    "i": 2,
    "aspect": "development workflow",
    "kind": "attribute",
    "dep_target": null,
    "dep_type": null
  }
]
```

**Field definitions:**
- `i` — 1-indexed fact number
- `aspect` — aspect classification (bonus: also classifies here)
- `kind` — attribute or constraint
- `dep_target` — name of target entity if dependency exists, else null
- `dep_type` — one of: `uses`, `requires`, `owned_by`, `blocks`,
  `informs`, or null if no dependency

**Dependency type semantics:**
- `uses` — entity actively uses the target (ooIDE uses WorkOS)
- `requires` — entity cannot function without the target (backend
  requires PostgreSQL)
- `owned_by` — entity is owned/maintained by target (ooIDE owned_by
  Nicholai)
- `blocks` — entity blocks progress on target (auth flow blocks
  deployment)
- `informs` — entity's design was influenced by target (testing
  informed by Signet pipeline)

**Tested results (qwen3:4b):**
- 5 facts: 5/5 correct format, 4/5 correct dependencies
- Correctly identified: WorkOS → uses, React 19 → requires,
  PostgreSQL → requires
- Correctly returned null for facts with no dependency
- One miss: Nicholai as primary developer → no dependency detected
  (expected owned_by, got null). Acceptable — person→project
  ownership is subtle.

**Known failure modes:**
- >5 facts: starts dropping facts or hallucinating content
- Combined with verbose prompt: loses format, reverts to markdown
- 8+ facts with dependencies: returned only 16/20 in stress test,
  changed field names

**Design note:** The dependency prompt also returns aspect and kind
classifications as a bonus. When both pass 2a and 2b run on the same
fact, the dependency prompt's classification can serve as a
confirmation signal. If they disagree, the classification prompt (2a)
takes precedence since it was designed and tested specifically for
that task.

---

## JSON Parsing

Use the same `stripFences` and `tryParseJson` helpers from
`packages/daemon/src/pipeline/extraction.ts`. The model occasionally
wraps output in markdown fences or includes trailing commas.

Additional validation for structural prompts:
- Verify `i` field maps to a valid fact index in the batch
- Verify `aspect` is a non-empty string
- Verify `kind` is exactly `"attribute"` or `"constraint"`
- Verify `dep_type` is one of the valid dependency types or null
- Skip malformed entries, don't fail the whole batch

---

## Key Files

- `packages/daemon/src/pipeline/worker.ts` — hook pass 1 after writes
- `packages/daemon/src/pipeline/structural-classify.ts` — new, pass 2a
- `packages/daemon/src/pipeline/structural-dependency.ts` — new, pass 2b
- `packages/daemon/src/pipeline/aspect-suggestions.ts` — new, type map
- `packages/daemon/src/knowledge-graph.ts` — CRUD helpers (from KA-1)
- `packages/daemon/src/pipeline/provider.ts` — LlmProvider
- `packages/daemon/src/pipeline/extraction.ts` — JSON parsing helpers
- `packages/daemon/src/memory-config.ts` — structural config defaults
- `packages/daemon/src/daemon.ts` — wire worker lifecycle
- `packages/core/src/types.ts` — structural config types

## What NOT to Build (KA-3+)

- Traversal query builder (KA-3)
- Session-start context injection from graph (KA-3)
- Constraint surfacing in retrieval (KA-3)
- Predictor structural features (KA-4)
- Checkpoint structural snapshots (KA-5)
- Dashboard visualization (KA-5)
- API endpoints for aspects/attributes (KA-3)
- Backfill worker for legacy memories (separate sprint after KA-2)

## Verification

1. `bun run build` — no type errors
2. `bun test` — existing tests pass
3. `bun run typecheck` — clean
4. Save a memory via daemon, verify:
   - Extraction runs (existing behavior)
   - Pass 1 creates stub `entity_attributes` row with `aspect_id = NULL`
   - `structural_classify` job enqueued in `memory_jobs`
   - `structural_dependency` job enqueued (if fact has target entity)
5. Wait for pass 2a worker to run, verify:
   - `entity_attributes.aspect_id` populated
   - `entity_attributes.kind` set to attribute or constraint
   - `entity_aspects` row created if new aspect
6. Wait for pass 2b worker to run, verify:
   - `entity_dependencies` row created for facts with dependencies
   - Target entity resolved by canonical_name
7. Save a fact like "never push directly to main" — verify it gets
   `kind = 'constraint'`
8. Save 3 facts about the same entity — verify they batch into one
   LLM call for classification
9. Verify malformed LLM response doesn't crash worker (graceful skip)
10. Verify `structural.enabled = false` disables both workers
