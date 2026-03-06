---
title: "Sprint Brief: Knowledge Architecture KA-5"
---

# Sprint Brief: Knowledge Architecture KA-5

Continuity Integration + Dashboard Visualization

---

## What You're Building

KA-1 through KA-4 built the knowledge graph, populated it via
structural assignment, wired traversal retrieval into session-start
and recall, and prepared structural features for the predictive scorer.
But two things are missing:

1. **Checkpoint structural snapshots** — session checkpoints don't
   capture which entities, aspects, and constraints were in scope.
   Recovery injection can't prioritize structural context because
   it doesn't know what was structurally relevant in the prior session.

2. **Dashboard visibility** — the knowledge graph is invisible to
   users. There's no way to browse entities, see aspect/attribute
   structure, inspect traversal behavior, or view predictor comparison
   slices. The dashboard has Memory, Embeddings, Pipeline, and Engine
   tabs but nothing for the structural layer.

This sprint adds structural snapshots to the checkpoint system and
builds a "Knowledge" dashboard tab that surfaces entity browsing,
traversal telemetry, and predictor comparison slices.

Think of it as: KA-1-4 built the engine, KA-5 adds the instrument
panel and the flight recorder.

## Required Reading

1. `docs/specs/INDEX.md` — Integration Contracts, especially
   "Knowledge Architecture <-> Session Continuity"
2. `docs/specs/approved/knowledge-architecture-schema.md` — sections
   10 (continuity integration), 11 (phase plan, KA-5)
3. `docs/specs/approved/predictive-memory-scorer.md` — section 4.6
   (dashboard predictor tab) for design patterns
4. `docs/specs/SPRINT-BRIEF-KA4.md` — predictor comparisons (what
   this visualizes)

## Prerequisites

KA-1 through KA-4 must be complete:
- KA tables populated by structural assignment pipeline
- Traversal retrieval wired into session-start and recall
- Structural features assembled for predictor candidates
- `predictor_comparisons` and `predictor_training_log` tables exist
- Comparison recording helpers and API endpoints exist

The dashboard (`packages/cli/dashboard/`) must build and serve. The
existing tab/navigation system must be understood — this sprint adds
a new tab to it.

---

## Deliverables

### 1. Structural snapshot in checkpoints

**Where:** `packages/daemon/src/session-checkpoints.ts`

Extend `WriteCheckpointParams` and `CheckpointRow` with optional
structural snapshot fields:

```typescript
// Add to WriteCheckpointParams:
readonly focalEntityIds?: ReadonlyArray<string>;
readonly focalEntityNames?: ReadonlyArray<string>;
readonly activeAspectIds?: ReadonlyArray<string>;
readonly surfacedConstraintCount?: number;
readonly traversalMemoryCount?: number;
```

These are stored as JSON arrays in new nullable TEXT columns on the
`session_checkpoints` table (via migration).

**Migration:** New migration `021-checkpoint-structural.ts`:

```sql
-- Idempotent column additions using PRAGMA table_info pattern
ALTER TABLE session_checkpoints ADD COLUMN focal_entity_ids TEXT;
ALTER TABLE session_checkpoints ADD COLUMN focal_entity_names TEXT;
ALTER TABLE session_checkpoints ADD COLUMN active_aspect_ids TEXT;
ALTER TABLE session_checkpoints ADD COLUMN surfaced_constraint_count INTEGER;
ALTER TABLE session_checkpoints ADD COLUMN traversal_memory_count INTEGER;
```

Register as version 21 in `packages/core/src/migrations/index.ts`.

**Wiring:** In `packages/daemon/src/hooks.ts`, inside
`handleSessionStart` after traversal completes, capture the structural
snapshot data. Pass it through to checkpoint writes (periodic,
pre-compaction, and session-end digests).

The focal entity IDs and names come from `resolveFocalEntities()`.
Active aspect IDs come from the traversal result (the aspects that
were walked). Constraint count and traversal memory count are already
tracked as telemetry variables — just forward them.

### 2. Recovery injection with structural priority

**Where:** `packages/daemon/src/hooks.ts`, recovery injection block
(around line 1135)

When a checkpoint has structural snapshot fields, the recovery section
should include them as structured context:

```
## Session Recovery Context
## Session Checkpoint
Project: /home/nicholai/signet/signetai
Prompts: 12 | Duration: 45m

### Structural Context
Focal entities: signetai, signet-core
Active constraints: 3
Traversal memories: 24

### Recent Prompts
- fix the build error in daemon
- add the new migration
```

The structural context section is injected BEFORE the recent prompts
section when available. When checkpoint budget is tight, structural
context takes priority over prompt snippets (truncate snippets first,
keep structural context).

**Implementation:** Update `formatPeriodicDigest`,
`formatPreCompactionDigest`, and `formatSessionEndDigest` to accept
optional structural snapshot data and include the structural context
section.

### 3. Knowledge Graph API endpoints

**Where:** `packages/daemon/src/daemon.ts`

Add read-only API endpoints for browsing the knowledge graph:

```
GET /api/knowledge/entities
  ?agent_id=default
  ?type=project|person|system|tool|concept|skill|task
  ?q=signet          (search canonical_name)
  ?limit=50&offset=0

GET /api/knowledge/entities/:id
  ?agent_id=default
  Returns: entity + aspects + attribute counts + dependency counts
           + structural density

GET /api/knowledge/entities/:id/aspects
  ?agent_id=default
  Returns: aspects with attribute counts per aspect

GET /api/knowledge/entities/:id/aspects/:aspectId/attributes
  ?agent_id=default
  ?kind=attribute|constraint
  ?status=active|superseded
  Returns: paginated attributes

GET /api/knowledge/entities/:id/dependencies
  ?agent_id=default
  ?direction=outgoing|incoming|both  (default: both)
  Returns: dependency edges with target entity names

GET /api/knowledge/stats
  ?agent_id=default
  Returns: {
    entityCount, aspectCount, attributeCount,
    constraintCount, dependencyCount,
    unassignedMemoryCount,
    coveragePercent   // assigned / total active memories
  }

GET /api/knowledge/traversal/status
  Returns: latest TraversalStatusSnapshot (already exists via
           getTraversalStatus(), just expose it)
```

**Implementation notes:**
- Use `DbAccessor` pattern consistent with existing endpoints
- All queries include `agent_id` scoping
- Entity search uses `canonical_name LIKE ?` with `%` wrapping
- Attribute queries support `kind` and `status` filters
- Stats endpoint computes coverage: count memories with at least one
  `entity_attributes` row vs total active memories
- Traversal status is already tracked in-memory by
  `graph-traversal.ts` — just expose the getter

### 4. Dashboard "Knowledge" tab

**Where:** `packages/cli/dashboard/src/`

Add a new "Knowledge" tab to the dashboard. This requires changes to:

1. **Navigation:** Add `"knowledge"` to `TabId` union and `VALID_TABS`
   in `navigation.svelte.ts`. Add to the `MEMORY_TABS` group (it's
   a memory-adjacent view). Add page header in `page-headers.ts`.

2. **Sidebar:** Add nav item in `app-sidebar.svelte` (use a graph or
   network icon from lucide).

3. **Tab component:** New file
   `packages/cli/dashboard/src/lib/components/tabs/KnowledgeTab.svelte`

4. **Route wiring:** Add the tab to the conditional rendering in
   `+page.svelte`

**Tab layout — three sections:**

#### 4a. Entity Browser

Top section. A searchable list of entities with type filtering.

- Search input + entity type dropdown filter
- Entity cards showing: name, type badge, aspect count, attribute
  count, constraint count, dependency count
- Click an entity to expand an inline detail panel showing:
  - Aspects list (sorted by weight DESC) with attribute counts
  - Click an aspect to see its attributes/constraints
  - Dependency edges (both directions) with target entity names
  - Structural density metrics

Data source: `GET /api/knowledge/entities`, then
`GET /api/knowledge/entities/:id` for detail.

#### 4b. Traversal Status

Middle section. Shows the latest traversal snapshot from session-start.

- Focal entity names and source (project/query/checkpoint)
- Entities traversed count
- Memory IDs collected
- Constraints surfaced
- Timeout indicator (yellow badge if timed out)
- Auto-refreshes on tab focus

Data source: `GET /api/knowledge/traversal/status`

#### 4c. Knowledge Stats

Bottom section. Overview metrics card.

- Total entities / aspects / attributes / constraints / dependencies
- Structural coverage bar (% of memories with structural assignment)
- Unassigned memory count

Data source: `GET /api/knowledge/stats`

**Design guidelines:**
- Use shadcn-svelte components (Card, Badge, Input, Select, Skeleton)
- Follow existing tab patterns (see `PipelineTab.svelte` for layout
  reference, `MemoryTab.svelte` for search patterns)
- Use the same CSS variable system (`--sig-*`) as existing tabs
- Loading states use Skeleton components
- Error states show inline error messages, don't crash the tab

### 5. Predictor comparison visualization

**Where:** `packages/cli/dashboard/src/lib/components/tabs/KnowledgeTab.svelte`
(or a sub-component)

Add a "Predictor Slices" section to the Knowledge tab that visualizes
the comparison data from KA-4's API endpoints.

#### 5a. By-Project Slice

Table showing per-project predictor performance:

| Project | Wins | Losses | Win Rate | Avg Margin |
|---------|------|--------|----------|------------|

With a bar chart or inline sparkline for win rate per project.

Data source: `GET /api/predictor/comparisons/by-project`

#### 5b. By-Entity Slice

Same table format but sliced by focal entity:

| Entity | Wins | Losses | Win Rate | Avg Margin |
|--------|------|--------|----------|------------|

Data source: `GET /api/predictor/comparisons/by-entity`

#### 5c. Date range filter

Both slice views share a "since" date picker. Default to last 7 days.
Use the existing shadcn-svelte Calendar component.

**Guard:** If no comparisons exist yet (predictor hasn't run), show
an informational message: "No predictor comparisons yet. Comparisons
appear after the predictive scorer completes its first session."

### 6. Training log visualization

**Where:** Same Knowledge tab, under predictor slices.

A simple table of recent training runs from
`GET /api/predictor/training`:

| Version | Loss | Samples | Duration | Canary NDCG | Date |
|---------|------|---------|----------|-------------|------|

Sorted by `created_at DESC`, limited to 20 rows.

If canary metrics are available (`canary_ndcg` not null), show them.
If not, show "—" placeholders.

**Guard:** Same empty-state message as comparisons if no training
runs exist.

### 7. Continuity state structural extension

**Where:** `packages/daemon/src/continuity-state.ts`

Extend `ContinuityState` to accumulate structural snapshot data
during the session:

```typescript
// Add to ContinuityState:
focalEntityIds: string[];
focalEntityNames: string[];
activeAspectIds: string[];
surfacedConstraintCount: number;
traversalMemoryCount: number;
```

Add a helper to record structural context from session-start:

```typescript
export function recordStructuralContext(
  sessionKey: string | undefined,
  ctx: {
    readonly focalEntityIds: string[];
    readonly focalEntityNames: string[];
    readonly activeAspectIds: string[];
    readonly surfacedConstraintCount: number;
    readonly traversalMemoryCount: number;
  },
): void;
```

Wire this in `hooks.ts` after traversal completes, so the data flows
through to checkpoint writes.

---

## Key Files

- `packages/daemon/src/session-checkpoints.ts` — structural snapshot
  fields on checkpoints
- `packages/daemon/src/continuity-state.ts` — structural context
  accumulation
- `packages/daemon/src/hooks.ts` — wire structural snapshot into
  checkpoints and recovery injection
- `packages/daemon/src/daemon.ts` — knowledge graph API endpoints
- `packages/core/src/migrations/021-checkpoint-structural.ts` — new
  migration for checkpoint columns
- `packages/core/src/migrations/index.ts` — register migration 021
- `packages/cli/dashboard/src/lib/stores/navigation.svelte.ts` —
  add Knowledge tab
- `packages/cli/dashboard/src/lib/components/layout/page-headers.ts` —
  Knowledge header
- `packages/cli/dashboard/src/lib/components/app-sidebar.svelte` —
  sidebar nav item
- `packages/cli/dashboard/src/lib/components/tabs/KnowledgeTab.svelte` —
  new tab component
- `packages/cli/dashboard/src/routes/+page.svelte` — tab rendering
- `packages/daemon/src/pipeline/graph-traversal.ts` — read
  (getTraversalStatus, not modified)
- `packages/daemon/src/knowledge-graph.ts` — read helpers (not modified)
- `packages/daemon/src/predictor-comparisons.ts` — read helpers
  (not modified)

## What NOT to Build

- Predictor client or sidecar lifecycle (scorer phase 3)
- RRF fusion in session-start (scorer phase 3)
- Success rate EMA tracking (scorer phase 3)
- Training trigger from session-end (scorer phase 3)
- Full predictor dashboard tab (scorer phase 4) — KA-5 surfaces
  comparison slices within the Knowledge tab, not the full predictor
  observability suite
- Entity/aspect editing UI (future — read-only browsing only)
- Graph visualization with force-directed layout (future — text-based
  browsing for now)
- Multi-hop traversal configuration UI (future)

## Verification

1. `bun run build` — no type errors
2. `bun test` — existing tests pass
3. `bun run typecheck` — clean
4. Migration 021 adds checkpoint columns idempotently
5. Checkpoint writes include structural snapshot when traversal data
   is available
6. Checkpoint writes work correctly when no traversal data exists
   (null columns, backwards compatible)
7. Recovery injection includes structural context section when
   checkpoint has snapshot data
8. Recovery injection works normally when checkpoint has no snapshot
   (backwards compatible)
9. `GET /api/knowledge/entities` returns paginated entity list with
   type filtering
10. `GET /api/knowledge/entities/:id` returns entity detail with
    aspects, density
11. `GET /api/knowledge/stats` returns correct coverage percentage
12. `GET /api/knowledge/traversal/status` returns latest snapshot
13. Knowledge tab renders in dashboard with entity browser
14. Knowledge tab shows traversal status section
15. Knowledge tab shows stats overview
16. Predictor slice tables render with comparison data
17. Predictor slice tables show empty state when no data exists
18. Training log table renders with training history
19. Tab navigation works (hash routing, sidebar active state)
20. All API endpoints include agent_id scoping
