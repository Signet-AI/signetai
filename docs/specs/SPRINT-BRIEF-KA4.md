---
title: "Sprint Brief: Knowledge Architecture KA-4"
---

# Sprint Brief: Knowledge Architecture KA-4

Predictor Coupling — Structural Features + Evaluation Slices

---

## What You're Building

The predictive memory scorer (Rust sidecar) ranks memory candidates
based on learned patterns. Right now it receives raw features like
age, importance, access count, and embeddings. KA-4 enriches each
candidate with structural features from the knowledge graph so the
model can learn entity-level and aspect-level relevance patterns.

This sprint does NOT build the predictor client or sidecar lifecycle
(that's scorer phase 3). It builds the feature assembly layer that
phase 3 will consume, plus the comparison reporting infrastructure
that uses structural slices.

Think of it as: KA-3 taught the system *which* memories to consider
via graph traversal. KA-4 teaches the scorer *why* those memories
are structurally relevant, so it can learn patterns like "constraints
are always important" or "memories about auth are relevant when
working on signetai."

## Required Reading

1. `docs/specs/INDEX.md` — Integration Contracts, especially
   "Knowledge Architecture <-> Predictive Scorer"
2. `docs/specs/approved/knowledge-architecture-schema.md` — section 8
   (predictor integration)
3. `docs/specs/approved/predictive-memory-scorer.md` — sections on
   candidate features, scoring signals, and Phase 3
4. `docs/specs/SPRINT-BRIEF-KA3.md` — traversal (what this builds on)

## Prerequisites

KA-1, KA-2, and KA-3 must be complete:
- KA tables populated by structural assignment pipeline
- Traversal retrieval wired into session-start and recall
- `knowledge-graph.ts` CRUD helpers working
- `graph-traversal.ts` resolving focal entities and collecting
  traversal candidates

The predictor Rust crate (phases 1-2) should exist at
`packages/predictor/` with the JSON-RPC protocol defined in
`src/protocol.rs`. The daemon-side predictor client does NOT need
to exist yet — this sprint prepares the data it will send.

## The Four Structural Features

From `docs/specs/INDEX.md` integration contract:

1. **`entity_slot`** — hashed entity ID. Allows the model to learn
   entity-specific relevance patterns (e.g., "memories about
   signetai are more relevant in afternoon sessions").

2. **`aspect_slot`** — hashed primary aspect ID. Allows the model
   to learn aspect-level patterns (e.g., "auth-related memories
   are important early in sessions, deployment memories matter
   near the end").

3. **`is_constraint`** — boolean (0 or 1). Constraints are always
   surfaced by the retrieval invariant, but the model can still
   learn that constraints correlate with session quality.

4. **`structural_density`** — aspect count + attribute count for the
   parent entity. Dense entities are likely more important to the
   user. This is a single scalar, not the full `StructuralDensity`
   struct.

These are concatenated to the existing `candidate_features` vector
that the predictor protocol already supports.

---

## Deliverables

### 1. Structural feature assembler

New file: `packages/daemon/src/structural-features.ts`

This module computes structural features for a batch of candidate
memories. It's called before sending candidates to the predictor.

```typescript
export interface StructuralFeatures {
  /** Hashed entity ID (0-255, for embedding table lookup) */
  readonly entitySlot: number;
  /** Hashed primary aspect ID (0-255) */
  readonly aspectSlot: number;
  /** 1 if this memory is a constraint, 0 otherwise */
  readonly isConstraint: number;
  /** aspect_count + attribute_count for parent entity */
  readonly structuralDensity: number;
  /** Source: 'ka_traversal' | 'effective' | 'fts_only' | null */
  readonly candidateSource: string | null;
}

/**
 * Compute structural features for a batch of memory IDs.
 * Returns a map from memory_id to features.
 * Memories with no structural assignment get null features
 * (the caller should use zero-filled defaults).
 */
export function getStructuralFeatures(
  accessor: DbAccessor,
  memoryIds: ReadonlyArray<string>,
  agentId: string,
): Map<string, StructuralFeatures>;
```

**Implementation:**

1. Batch-query `entity_attributes` for all memory IDs:
   ```sql
   SELECT ea.memory_id, ea.kind, ea.aspect_id,
          asp.entity_id, asp.canonical_name AS aspect_name
   FROM entity_attributes ea
   JOIN entity_aspects asp ON asp.id = ea.aspect_id
   WHERE ea.memory_id IN (?, ?, ...)
     AND ea.agent_id = ?
     AND ea.status = 'active'
   ```

2. For each memory with a match:
   - `entitySlot` = hash entity_id to 0-255 (simple string hash % 256)
   - `aspectSlot` = hash aspect_id to 0-255
   - `isConstraint` = 1 if `kind = 'constraint'`, else 0
   - `structuralDensity` = query `getStructuralDensity()` for the
     parent entity (cache per entity within the batch to avoid
     repeated queries)

3. For memories with no `entity_attributes` row (not yet structurally
   assigned), return null. The caller fills defaults: entitySlot=0,
   aspectSlot=0, isConstraint=0, structuralDensity=0.

**Hashing:** Use a simple djb2 or fnv1a hash on the string ID,
modulo 256. The predictor Rust crate's `ScoreParams.candidate_features`
is `Vec<Vec<f64>>` — these 4-5 features get appended to whatever
other features already exist per candidate.

### 2. Feature vector assembly helper

New function in `structural-features.ts`:

```typescript
/**
 * Build the full candidate_features vector for the predictor.
 * Merges behavioral features (age, importance, access_count, etc.)
 * with structural features from KA.
 *
 * Returns a parallel array of feature vectors aligned with
 * candidate_ids.
 */
export function buildCandidateFeatures(
  accessor: DbAccessor,
  candidates: ReadonlyArray<{
    readonly id: string;
    readonly importance: number;
    readonly createdAt: string;
    readonly accessCount: number;
    readonly lastAccessed: string | null;
    readonly pinned: boolean;
    readonly isSuperseded: boolean;
    readonly source?: string;
  }>,
  agentId: string,
  sessionContext: {
    readonly projectSlot: number;
    readonly timeOfDay: number;  // 0-23
    readonly dayOfWeek: number;  // 0-6
    readonly monthOfYear: number; // 0-11
    readonly sessionGapDays: number;
  },
): ReadonlyArray<ReadonlyArray<number>>;
```

**Feature vector layout** (per candidate):

| Index | Feature | Source |
|-------|---------|--------|
| 0 | `log(age_days)` | behavioral |
| 1 | `importance` | behavioral |
| 2 | `log(access_count + 1)` | behavioral |
| 3 | `tod_sin` | temporal |
| 4 | `tod_cos` | temporal |
| 5 | `dow_sin` | temporal |
| 6 | `dow_cos` | temporal |
| 7 | `moy_sin` | temporal |
| 8 | `moy_cos` | temporal |
| 9 | `log(session_gap_days + 1)` | temporal |
| 10 | `is_embedded` | path |
| 11 | `is_superseded` | behavioral |
| 12 | `entity_slot / 255.0` | structural (KA-4) |
| 13 | `aspect_slot / 255.0` | structural (KA-4) |
| 14 | `is_constraint` | structural (KA-4) |
| 15 | `log(structural_density + 1)` | structural (KA-4) |
| 16 | `is_ka_traversal` | structural (KA-4) |

Features 0-11 match the scorer spec's existing signal list. Features
12-16 are the new structural signals from KA. All values are
normalized to roughly [0, 1] range for the model.

**Note on `is_embedded`:** check whether the memory has an entry in
the `embeddings` table. If yes, 1.0, else 0.0. This tells the model
which encoding path (downprojection vs HashTrick) is being used.

### 3. Update predictor protocol types

Update `packages/predictor/src/protocol.rs` to document the
structural feature indices:

```rust
/// Feature vector layout per candidate:
/// [0]  log(age_days)
/// [1]  importance
/// [2]  log(access_count + 1)
/// [3]  tod_sin
/// [4]  tod_cos
/// [5]  dow_sin
/// [6]  dow_cos
/// [7]  moy_sin
/// [8]  moy_cos
/// [9]  log(session_gap_days + 1)
/// [10] is_embedded
/// [11] is_superseded
/// [12] entity_slot (normalized 0-1)
/// [13] aspect_slot (normalized 0-1)
/// [14] is_constraint
/// [15] log(structural_density + 1)
/// [16] is_ka_traversal
pub const FEATURE_DIM: usize = 17;
```

Update the gate layer parameter count comment in `model.rs` to
reflect 17 features instead of 12.

### 4. Predictor comparison migration

New migration: `packages/core/src/migrations/020-predictor-comparisons.ts`

```sql
CREATE TABLE IF NOT EXISTS predictor_comparisons (
  id TEXT PRIMARY KEY,
  session_key TEXT NOT NULL,
  agent_id TEXT NOT NULL DEFAULT 'default',
  predictor_ndcg REAL NOT NULL,
  baseline_ndcg REAL NOT NULL,
  predictor_won INTEGER NOT NULL,
  margin REAL NOT NULL,
  alpha REAL NOT NULL,
  ema_updated INTEGER NOT NULL DEFAULT 0,
  focal_entity_id TEXT,
  focal_entity_name TEXT,
  project TEXT,
  candidate_count INTEGER NOT NULL,
  traversal_count INTEGER NOT NULL DEFAULT 0,
  constraint_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_predictor_comparisons_session
  ON predictor_comparisons(session_key);
CREATE INDEX IF NOT EXISTS idx_predictor_comparisons_agent
  ON predictor_comparisons(agent_id);
CREATE INDEX IF NOT EXISTS idx_predictor_comparisons_project
  ON predictor_comparisons(project);
CREATE INDEX IF NOT EXISTS idx_predictor_comparisons_entity
  ON predictor_comparisons(focal_entity_id);

CREATE TABLE IF NOT EXISTS predictor_training_log (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL DEFAULT 'default',
  model_version INTEGER NOT NULL,
  loss REAL NOT NULL,
  sample_count INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  canary_ndcg REAL,
  canary_ndcg_delta REAL,
  canary_score_variance REAL,
  canary_topk_churn REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_predictor_training_agent
  ON predictor_training_log(agent_id);
```

Register as version 20 in `packages/core/src/migrations/index.ts`.

Key additions beyond the base scorer spec:
- `agent_id` on both tables (cross-cutting invariant)
- `focal_entity_id` and `focal_entity_name` on comparisons
  (structural slicing)
- `traversal_count` and `constraint_count` on comparisons
  (KA metrics per comparison)
- `project` on comparisons (project-level slicing)

### 5. Comparison recording helpers

New file: `packages/daemon/src/predictor-comparisons.ts`

```typescript
export interface RecordComparisonParams {
  readonly sessionKey: string;
  readonly agentId: string;
  readonly predictorNdcg: number;
  readonly baselineNdcg: number;
  readonly predictorWon: boolean;
  readonly margin: number;
  readonly alpha: number;
  readonly emaUpdated: boolean;
  readonly focalEntityId?: string;
  readonly focalEntityName?: string;
  readonly project?: string;
  readonly candidateCount: number;
  readonly traversalCount: number;
  readonly constraintCount: number;
}

export function recordComparison(
  accessor: DbAccessor,
  params: RecordComparisonParams,
): void;

/**
 * Get comparison stats sliced by project.
 * Returns win rate and average margin per project.
 */
export function getComparisonsByProject(
  accessor: DbAccessor,
  agentId: string,
  since?: string,
): ReadonlyArray<{
  readonly project: string;
  readonly wins: number;
  readonly losses: number;
  readonly winRate: number;
  readonly avgMargin: number;
}>;

/**
 * Get comparison stats sliced by focal entity.
 * Returns win rate and average margin per entity.
 */
export function getComparisonsByEntity(
  accessor: DbAccessor,
  agentId: string,
  since?: string,
): ReadonlyArray<{
  readonly entityId: string;
  readonly entityName: string;
  readonly wins: number;
  readonly losses: number;
  readonly winRate: number;
  readonly avgMargin: number;
}>;

/**
 * Record a training run result.
 */
export function recordTrainingRun(
  accessor: DbAccessor,
  params: {
    readonly agentId: string;
    readonly modelVersion: number;
    readonly loss: number;
    readonly sampleCount: number;
    readonly durationMs: number;
    readonly canaryNdcg?: number;
    readonly canaryNdcgDelta?: number;
    readonly canaryScoreVariance?: number;
    readonly canaryTopkChurn?: number;
  },
): void;
```

### 6. API endpoints for structural slices

Add to `packages/daemon/src/daemon.ts`:

```
GET /api/predictor/comparisons
  ?project=signetai
  ?entity_id=...
  ?since=2026-03-01
  ?until=2026-03-05
  ?limit=50&offset=0

GET /api/predictor/comparisons/by-project
  ?since=2026-03-01
  ?agent_id=default

GET /api/predictor/comparisons/by-entity
  ?since=2026-03-01
  ?agent_id=default

GET /api/predictor/training
  ?agent_id=default
  ?limit=20
```

These endpoints expose the structural slice data for the dashboard
(KA-5) and for agent-facing diagnostics. They read from
`predictor_comparisons` and `predictor_training_log`.

### 7. Extend session_memories with structural features

Add columns to `session_memories` via migration 020 (same migration
as comparisons):

```sql
ALTER TABLE session_memories ADD COLUMN entity_slot INTEGER;
ALTER TABLE session_memories ADD COLUMN aspect_slot INTEGER;
ALTER TABLE session_memories ADD COLUMN is_constraint INTEGER DEFAULT 0;
ALTER TABLE session_memories ADD COLUMN structural_density INTEGER;
```

Use the same `PRAGMA table_info` idempotent pattern.

When recording session candidates (in `recordSessionCandidates`),
include structural features so the training pipeline can access
them without re-computing. The predictor's `data.rs` reads from
`session_memories` to build training pairs — these columns give
it the structural signals directly.

---

## Key Files

- `packages/daemon/src/structural-features.ts` — new, feature assembly
- `packages/daemon/src/predictor-comparisons.ts` — new, comparison
  recording and slicing
- `packages/core/src/migrations/020-predictor-comparisons.ts` — new,
  comparison + training tables + session_memories columns
- `packages/core/src/migrations/index.ts` — register migration 020
- `packages/predictor/src/protocol.rs` — update feature layout docs
- `packages/predictor/src/model.rs` — update gate layer dimension
- `packages/daemon/src/daemon.ts` — new API endpoints
- `packages/daemon/src/hooks.ts` — wire feature assembly into
  session candidate recording
- `packages/daemon/src/session-memories.ts` — extend recording with
  structural columns
- `packages/daemon/src/knowledge-graph.ts` — read helpers (not modified)
- `packages/daemon/src/pipeline/graph-traversal.ts` — read (not modified)

## What NOT to Build (Scorer Phase 3+)

- Predictor client (`predictor-client.ts`) — scorer phase 3
- Sidecar lifecycle management — scorer phase 3
- RRF fusion in session-start — scorer phase 3
- Success rate EMA tracking — scorer phase 3
- Training trigger from session-end — scorer phase 3
- Dashboard predictor tab — KA-5 / scorer phase 4
- Checkpoint structural snapshots — KA-5

## Verification

1. `bun run build` — no type errors
2. `bun test` — existing tests pass
3. `bun run typecheck` — clean
4. Migration 020 creates both tables and adds session_memories columns
5. `getStructuralFeatures()` returns correct features for a memory
   with known entity_attributes rows
6. `getStructuralFeatures()` returns null for memories with no
   structural assignment
7. `buildCandidateFeatures()` produces 17-element vectors
8. Feature values are normalized (0-1 range for slots, log-scaled
   for counts)
9. Entity slot hashing is deterministic (same entity_id always
   produces same slot)
10. Structural density is cached per entity within a batch (not
    N separate queries for N memories of the same entity)
11. `recordComparison()` writes correct rows with structural slice
    fields
12. `getComparisonsByProject()` aggregates correctly
13. `getComparisonsByEntity()` aggregates correctly
14. API endpoints return valid JSON with correct filtering
15. `session_memories` records include structural feature columns
16. `FEATURE_DIM` constant in Rust matches TypeScript vector length
