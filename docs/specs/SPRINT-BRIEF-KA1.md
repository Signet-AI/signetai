---
title: "Sprint Brief: Knowledge Architecture KA-1"
---

# Sprint Brief: Knowledge Architecture KA-1

Schema + Types + Read/Write Helpers

---

## What You're Building

The knowledge graph gets its structural backbone. Entities gain aspects,
attributes, constraints, dependencies, and task lifecycle — the data
model described in `docs/KNOWLEDGE-ARCHITECTURE.md`. This sprint is
schema and types only. Structural assignment (KA-2) and traversal
retrieval (KA-3) come later.

## Required Reading

1. `docs/specs/INDEX.md` — **read the Cross-Cutting Invariants section
   first.** These override anything in the individual spec.
2. `docs/specs/approved/knowledge-architecture-schema.md` — sections
   5 (data model) and 6 (extraction contracts, for context only)
3. `docs/KNOWLEDGE-ARCHITECTURE.md` — conceptual north star

## Cross-Cutting Rules (from INDEX)

- **`agent_id` on every new table.** All four new tables must have an
  `agent_id TEXT NOT NULL DEFAULT 'default'` column with an index.
  This is infrastructure for tenant isolation, not a KA concern.
- **`entities` needs `agent_id` backfill.** The `entities` table
  (migration 002) predates the multi-agent invariant. This migration
  adds the column.
- **Entity type taxonomy is canonical.** Valid types: `person`,
  `project`, `system`, `tool`, `concept`, `skill`, `task`, `unknown`.
- **Constraints always surface.** `entity_attributes` rows with
  `kind = 'constraint'` are never suppressed by scoring. Design the
  schema to make this query cheap.

## Deliverables

### 1. Migration: `019-knowledge-structure.ts`

New migration file in `packages/core/src/migrations/`. Register it in
`migrations/index.ts` as version 19.

#### 1a. Backfill `agent_id` on `entities`

```sql
-- ALTER TABLE won't fail if column already exists (use addColumnIfMissing pattern)
ALTER TABLE entities ADD COLUMN agent_id TEXT NOT NULL DEFAULT 'default';
CREATE INDEX IF NOT EXISTS idx_entities_agent ON entities(agent_id);
```

Use the same `PRAGMA table_info` + column check pattern as migration
017 to make this idempotent.

#### 1b. `entity_aspects`

```sql
CREATE TABLE IF NOT EXISTS entity_aspects (
  id            TEXT PRIMARY KEY,
  entity_id     TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  agent_id      TEXT NOT NULL DEFAULT 'default',
  name          TEXT NOT NULL,
  canonical_name TEXT NOT NULL,
  weight        REAL NOT NULL DEFAULT 0.5,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(entity_id, canonical_name)
);

CREATE INDEX IF NOT EXISTS idx_entity_aspects_entity ON entity_aspects(entity_id);
CREATE INDEX IF NOT EXISTS idx_entity_aspects_agent ON entity_aspects(agent_id);
CREATE INDEX IF NOT EXISTS idx_entity_aspects_weight ON entity_aspects(weight DESC);
```

#### 1c. `entity_attributes`

```sql
CREATE TABLE IF NOT EXISTS entity_attributes (
  id                TEXT PRIMARY KEY,
  aspect_id         TEXT NOT NULL REFERENCES entity_aspects(id) ON DELETE CASCADE,
  agent_id          TEXT NOT NULL DEFAULT 'default',
  memory_id         TEXT REFERENCES memories(id) ON DELETE SET NULL,
  kind              TEXT NOT NULL,
  content           TEXT NOT NULL,
  normalized_content TEXT NOT NULL,
  confidence        REAL NOT NULL DEFAULT 0.0,
  importance        REAL NOT NULL DEFAULT 0.5,
  status            TEXT NOT NULL DEFAULT 'active',
  superseded_by     TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_entity_attributes_aspect ON entity_attributes(aspect_id);
CREATE INDEX IF NOT EXISTS idx_entity_attributes_agent ON entity_attributes(agent_id);
CREATE INDEX IF NOT EXISTS idx_entity_attributes_kind ON entity_attributes(kind);
CREATE INDEX IF NOT EXISTS idx_entity_attributes_status ON entity_attributes(status);
```

`kind` values: `'attribute'` or `'constraint'`. Constraints are
first-class rows, not inferred.

`status` values: `'active'`, `'superseded'`, `'deleted'`.

#### 1d. `entity_dependencies`

```sql
CREATE TABLE IF NOT EXISTS entity_dependencies (
  id                TEXT PRIMARY KEY,
  source_entity_id  TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  target_entity_id  TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  agent_id          TEXT NOT NULL DEFAULT 'default',
  aspect_id         TEXT REFERENCES entity_aspects(id) ON DELETE SET NULL,
  dependency_type   TEXT NOT NULL,
  strength          REAL NOT NULL DEFAULT 0.5,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_entity_dependencies_source ON entity_dependencies(source_entity_id);
CREATE INDEX IF NOT EXISTS idx_entity_dependencies_target ON entity_dependencies(target_entity_id);
CREATE INDEX IF NOT EXISTS idx_entity_dependencies_agent ON entity_dependencies(agent_id);
```

`dependency_type` values: `'uses'`, `'requires'`, `'owned_by'`,
`'blocks'`, `'informs'`.

#### 1e. `task_meta`

```sql
CREATE TABLE IF NOT EXISTS task_meta (
  entity_id       TEXT PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
  agent_id        TEXT NOT NULL DEFAULT 'default',
  status          TEXT NOT NULL,
  expires_at      TEXT,
  retention_until TEXT,
  completed_at    TEXT,
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_task_meta_agent ON task_meta(agent_id);
CREATE INDEX IF NOT EXISTS idx_task_meta_status ON task_meta(status);
CREATE INDEX IF NOT EXISTS idx_task_meta_retention ON task_meta(retention_until);
```

`status` values: `'open'`, `'in_progress'`, `'blocked'`, `'done'`,
`'cancelled'`.

### 2. Core types

Add to `packages/core/src/types.ts`:

```typescript
// -- Knowledge Architecture types --

export const ENTITY_TYPES = [
  'person', 'project', 'system', 'tool',
  'concept', 'skill', 'task', 'unknown',
] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

export const ATTRIBUTE_KINDS = ['attribute', 'constraint'] as const;
export type AttributeKind = (typeof ATTRIBUTE_KINDS)[number];

export const ATTRIBUTE_STATUSES = ['active', 'superseded', 'deleted'] as const;
export type AttributeStatus = (typeof ATTRIBUTE_STATUSES)[number];

export const DEPENDENCY_TYPES = [
  'uses', 'requires', 'owned_by', 'blocks', 'informs',
] as const;
export type DependencyType = (typeof DEPENDENCY_TYPES)[number];

export const TASK_STATUSES = [
  'open', 'in_progress', 'blocked', 'done', 'cancelled',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export interface EntityAspect {
  readonly id: string;
  readonly entityId: string;
  readonly agentId: string;
  readonly name: string;
  readonly canonicalName: string;
  readonly weight: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface EntityAttribute {
  readonly id: string;
  readonly aspectId: string;
  readonly agentId: string;
  readonly memoryId: string | null;
  readonly kind: AttributeKind;
  readonly content: string;
  readonly normalizedContent: string;
  readonly confidence: number;
  readonly importance: number;
  readonly status: AttributeStatus;
  readonly supersededBy: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface EntityDependency {
  readonly id: string;
  readonly sourceEntityId: string;
  readonly targetEntityId: string;
  readonly agentId: string;
  readonly aspectId: string | null;
  readonly dependencyType: DependencyType;
  readonly strength: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TaskMeta {
  readonly entityId: string;
  readonly agentId: string;
  readonly status: TaskStatus;
  readonly expiresAt: string | null;
  readonly retentionUntil: string | null;
  readonly completedAt: string | null;
  readonly updatedAt: string;
}
```

Also update the existing `Entity` interface to include `agentId`:

```typescript
export interface Entity {
  id: string;
  name: string;
  canonicalName?: string;
  entityType: string;
  agentId: string;          // <-- add
  description?: string;
  mentions?: number;
  createdAt: string;
  updatedAt: string;
}
```

### 3. Read/write helpers

New module: `packages/daemon/src/knowledge-graph.ts`

Provide CRUD operations using the `DbAccessor` pattern (same as
`skill-graph.ts`). All write operations go through `withWriteTx`,
all reads through `withReadDb`.

Required functions:

```typescript
// -- Aspects --
upsertAspect(accessor, params): EntityAspect
getAspectsForEntity(accessor, entityId, agentId): EntityAspect[]
deleteAspect(accessor, aspectId): void

// -- Attributes --
createAttribute(accessor, params): EntityAttribute
getAttributesForAspect(accessor, aspectId, agentId): EntityAttribute[]
getConstraintsForEntity(accessor, entityId, agentId): EntityAttribute[]
supersedeAttribute(accessor, id, supersededById): void
deleteAttribute(accessor, id): void

// -- Dependencies --
upsertDependency(accessor, params): EntityDependency
getDependenciesFrom(accessor, entityId, agentId): EntityDependency[]
getDependenciesTo(accessor, entityId, agentId): EntityDependency[]
deleteDependency(accessor, id): void

// -- Task meta --
upsertTaskMeta(accessor, params): TaskMeta
getTaskMeta(accessor, entityId): TaskMeta | null
updateTaskStatus(accessor, entityId, status): void

// -- Structural density --
getStructuralDensity(accessor, entityId, agentId): {
  aspectCount: number;
  attributeCount: number;
  constraintCount: number;
  dependencyCount: number;
}
```

Key implementation notes:

- `upsertAspect` matches on `(entity_id, canonical_name)` unique
  constraint. Use INSERT OR REPLACE or ON CONFLICT.
- `getConstraintsForEntity` must join through `entity_aspects` to get
  all `kind = 'constraint'` attributes for an entity. This is the
  query that enforces the "constraints always surface" invariant.
- `upsertDependency` is idempotent on
  `(source_entity_id, target_entity_id, dependency_type)`.
- All functions take `agentId` param and filter by it.
- Generate IDs with the existing pattern from `skill-graph.ts` (check
  how entity IDs and `crypto.randomUUID()` are used there).

### 4. Update Entity interface consumers

After adding `agentId` to the `Entity` interface, update any code that
creates entity rows to include `agent_id = 'default'`. Key locations:

- `packages/daemon/src/pipeline/graph-transactions.ts` — `txPersistEntities`
- `packages/daemon/src/pipeline/skill-graph.ts` — `installSkillNode`
- Any other direct INSERT into `entities`

Search for: `INSERT INTO entities` and `INSERT OR REPLACE INTO entities`

## Key Files

- `packages/core/src/migrations/` — new migration goes here
- `packages/core/src/migrations/index.ts` — register migration
- `packages/core/src/types.ts` — add types and update Entity
- `packages/daemon/src/knowledge-graph.ts` — new module
- `packages/daemon/src/db-accessor.ts` — DbAccessor interface (reference)
- `packages/daemon/src/pipeline/skill-graph.ts` — pattern reference
- `packages/daemon/src/pipeline/graph-transactions.ts` — update for agent_id

## What NOT to Build (KA-2+)

- Structural assignment stage in the pipeline (KA-2)
- Traversal query builder or session-start wiring (KA-3)
- Predictor structural features (KA-4)
- Checkpoint structural snapshots (KA-5)
- Backfill worker for legacy memories (KA-2)
- Dashboard visualization (KA-5)
- API endpoints for aspects/attributes (KA-3)

## Verification

1. `bun run build` — no type errors
2. `bun test` — existing tests pass (713+)
3. `bun run typecheck` — clean
4. Daemon startup creates all four new tables + entities.agent_id
5. Verify indexes exist: `PRAGMA index_list(entity_aspects)` etc.
6. Existing entity creation still works (agent_id defaults to 'default')
7. `getConstraintsForEntity` returns correct rows in a simple test
8. `getStructuralDensity` returns zeroes for an entity with no aspects
9. Verify `agent_id = 'default'` on all rows created by existing code
