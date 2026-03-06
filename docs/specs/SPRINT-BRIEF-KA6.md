---
title: "Sprint Brief: Knowledge Architecture KA-6"
---

# Sprint Brief: Knowledge Architecture KA-6

Entity Weight Override + Behavioral Feedback Loop

---

## What You're Building

KA-1 through KA-5 built the knowledge graph, wired traversal
retrieval, prepared structural features for the predictor, and added
dashboard visibility. But the system has a fundamental gap: it can
only refine what it already knows is important. There is no mechanism
to front-load importance on an entity before behavioral data proves
it, and no mechanism for behavioral outcomes to flow back into the
structural graph.

KA-6 closes this loop in two ways:

1. **Entity weight override** — users (or the system) can pin
   entities as focal, ensuring they're always traversed regardless
   of project path matching or query tokens. This is the exploration
   mechanism: a bet that an entity matters before the evidence
   accumulates.

2. **Behavioral feedback** — session outcomes flow back into the
   graph. FTS overlap (memories the user actually searched for during
   a session) adjusts aspect weights. Per-entity predictor win rates
   surface as graph health signals. Superseded memory labels propagate
   to entity_attributes status.

Think of it as: KA-1-5 built the map and the instruments. KA-6 lets
you place pins on the map and lets the territory reshape the map
over time.

## Why This Sprint Exists

Read `docs/KNOWLEDGE-ARCHITECTURE.md`, section "Love, Hate, and the
Exploration Problem" before writing any code.

The entire pipeline up to this point is exploitation — refining what
the system already knows. This sprint adds the exploration mechanism.

**Weight override is love expressed as architecture.** It is the only
way to assign importance to something before the evidence justifies
it. Without it, the system only maps what it has evidence is worth
mapping. With it, the system maps the unknown because something in
there matters to the user even before they know what they will find.

The manual pin and the predictor's learned intuition are the same
mechanism at different scales. The pin is explicit: "this matters."
The predictor is implicit: "based on patterns I've learned, this
should matter." The pin is training data for the predictor. Over
time, the predictor starts making the same bets the user makes
manually — that is the system learning to explore on its own.

**FTS overlap feedback is the system learning from its own bets.**
When a memory is injected at session-start and the user later
searches for it (FTS hit), that's behavioral confirmation — the bet
paid off. That signal flows back to aspect weights, raising the
importance of aspects that produce useful memories. Without this
feedback loop, aspect weights stagnate and the structural graph
diverges from what the user actually needs.

**Aspect decay is the system forgetting what no longer serves it.**
Without decay, weights only go up. Aspects that were important six
months ago but haven't been confirmed recently hold the same weight
as aspects confirmed yesterday. Decay ensures the graph reflects
current reality, not historical accumulation.

**Weight override at minimum is hate** — "stop surfacing this." The
floor matters as much as the ceiling. The system needs to learn to
stop betting on entities that don't pay off just as much as it needs
to learn to bet on new ones.

The danger: love can build enormous infrastructure around an entity
that turns out to be wrong. The most catastrophic load-bearing
failures come from betting too hard on the wrong thing. The
comparison slices (per-entity win rate, trend) are the safety net —
they tell you when a bet is failing before the infrastructure
collapses.

If the implementation focuses only on the technical mechanics without
understanding this, it will optimize metrics without serving the
user. Every deliverable in this sprint exists to answer one of two
questions: "what does the user need to know right now?" (exploitation)
or "what does the user need to explore right now?" (exploration). The
tension between those questions is what makes the system alive rather
than merely efficient.

## Required Reading

1. `docs/KNOWLEDGE-ARCHITECTURE.md` — **start here**, especially
   "Love, Hate, and the Exploration Problem". This explains WHY
   every deliverable in this sprint exists, not just what it does.
2. `docs/specs/INDEX.md` — Integration Contracts, especially
   "Knowledge Architecture <-> Predictive Scorer"
3. `docs/specs/approved/knowledge-architecture-schema.md` — sections
   7 (retrieval contract) and 8 (predictor integration)
4. `docs/specs/SPRINT-BRIEF-KA4.md` — predictor comparison slices
   (the behavioral signal source)
5. `docs/specs/SPRINT-BRIEF-KA5.md` — dashboard Knowledge tab
   (where feedback visibility lives)

## Prerequisites

KA-1 through KA-5 must be complete:
- Knowledge graph populated, traversal wired, structural features
  assembled
- `predictor_comparisons` table exists with per-entity slices
- `session_memories` table tracks `fts_hit_count` and `source`
- Knowledge tab exists in dashboard
- `resolveFocalEntities()` has the priority chain:
  checkpoint > project > query

---

## Deliverables

### 1. Entity pinning

Entity pinning is the manual exploration mechanism. It is how the
user says "this matters" before the system has evidence. See
`docs/KNOWLEDGE-ARCHITECTURE.md` section "Love, Hate, and the
Exploration Problem" for the full rationale.

A pinned entity is always included as focal during traversal. This
means its aspects, attributes, constraints, and dependencies are
walked every session — regardless of whether the project path or
query tokens would have resolved it. The predictor then observes
whether this bet pays off through normal comparison scoring. Over
time, the predictor learns the pattern and starts making similar
bets autonomously.

The pin at maximum is exploration. The pin at minimum (or unpin +
low weight) is pruning — "stop betting on this." Both directions
matter.

**Migration:** New migration `022-entity-pinning.ts`:

```sql
ALTER TABLE entities ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
ALTER TABLE entities ADD COLUMN pinned_at TEXT;
```

Use the standard `addColumnIfMissing` / PRAGMA table_info pattern.
Register as version 22 in `packages/core/src/migrations/index.ts`.

**Knowledge graph helpers:** Add to
`packages/daemon/src/knowledge-graph.ts`:

```typescript
export function pinEntity(
  accessor: DbAccessor,
  entityId: string,
  agentId: string,
): void;

export function unpinEntity(
  accessor: DbAccessor,
  entityId: string,
  agentId: string,
): void;

export function getPinnedEntities(
  accessor: DbAccessor,
  agentId: string,
): ReadonlyArray<{ id: string; name: string; pinnedAt: string }>;
```

`pinEntity` sets `pinned = 1, pinned_at = now()` where
`id = ? AND agent_id = ?`. `unpinEntity` sets `pinned = 0,
pinned_at = NULL`. `getPinnedEntities` returns all pinned entities
for an agent, ordered by `pinned_at DESC`.

**Focal entity resolution:** Update `resolveFocalEntities()` in
`packages/daemon/src/pipeline/graph-traversal.ts`. Pinned entities
are priority 0 — they are ALWAYS included as focal entities,
regardless of which signal source resolves additional entities.

New resolution order:
1. **Pinned entities** — always included (union, not replacement)
2. **Checkpoint entity IDs** — if recovery checkpoint has them
3. **Project path** — match against entity canonical_name
4. **Query tokens** — tokenize and match

The key change: pinned entities are unioned with whatever other
source resolves, not a fallback. If the user pins entity A and the
project path resolves entity B, both A and B are focal.

Update `FocalEntityResult` to track pinned vs resolved:

```typescript
export interface FocalEntityResult {
  readonly entityIds: string[];
  readonly entityNames: string[];
  readonly pinnedEntityIds: string[];
  readonly source: "project" | "checkpoint" | "query" | "session_key";
}
```

The `source` field still reflects the non-pinned resolution source.
`pinnedEntityIds` is the subset that came from pinning.

**API endpoints:** Add to `packages/daemon/src/daemon.ts`:

```
POST /api/knowledge/entities/:id/pin
  ?agent_id=default
  Returns: { pinned: true, pinnedAt: string }

DELETE /api/knowledge/entities/:id/pin
  ?agent_id=default
  Returns: { pinned: false }

GET /api/knowledge/entities/pinned
  ?agent_id=default
  Returns: Array<{ id, name, pinnedAt }>
```

**Dashboard:** Add a pin/unpin toggle to the entity detail panel in
the Knowledge tab (KA-5). A small pin icon button next to each
entity name. Pinned entities get a visual indicator (badge or
highlight) in the entity list.

### 2. Aspect weight feedback from FTS overlap

This is the system learning from its own bets. Without this feedback
loop, aspect weights are set once by structural assignment and never
updated. The structural graph diverges from what the user actually
needs. With it, the graph reshapes itself based on outcomes.

**Where:** `packages/daemon/src/pipeline/aspect-feedback.ts` (new)

When a session ends, the system already knows which memories were
injected at session-start and which the user actually searched for
during the session (via `fts_hit_count` in `session_memories`).
Memories with FTS hits are behaviorally confirmed — the user went
looking for them, validating that they were relevant.

This signal should flow back to aspect weights:

```typescript
export interface AspectFeedbackResult {
  readonly aspectsUpdated: number;
  readonly totalFtsConfirmations: number;
}

/**
 * After a session ends, compute FTS overlap feedback and adjust
 * aspect weights for confirmed memories.
 *
 * For each memory with fts_hit_count > 0:
 * 1. Look up its entity_attributes row to find its aspect_id
 * 2. Increment the aspect's weight by a small delta
 *
 * Weight adjustment: aspect.weight += delta * confirmations,
 * clamped to [0.1, 1.0]. Default delta = 0.02 per confirmation.
 */
export function applyFtsOverlapFeedback(
  accessor: DbAccessor,
  sessionKey: string,
  agentId: string,
  config: {
    readonly delta: number;       // default 0.02
    readonly maxWeight: number;   // default 1.0
    readonly minWeight: number;   // default 0.1
  },
): AspectFeedbackResult;
```

**Implementation:**

1. Query `session_memories` for the session where
   `fts_hit_count > 0`:
   ```sql
   SELECT memory_id, fts_hit_count
   FROM session_memories
   WHERE session_key = ? AND fts_hit_count > 0
   ```

2. For each confirmed memory, look up its `entity_attributes` row
   to get `aspect_id`:
   ```sql
   SELECT aspect_id FROM entity_attributes
   WHERE memory_id = ? AND agent_id = ? AND status = 'active'
   LIMIT 1
   ```

3. Accumulate confirmations per aspect_id, then batch-update:
   ```sql
   UPDATE entity_aspects
   SET weight = MIN(?, weight + ? * ?),
       updated_at = ?
   WHERE id = ? AND agent_id = ?
   ```

**Wiring:** Call `applyFtsOverlapFeedback` during session-end
processing in `hooks.ts`, after `recordSessionCandidates` and before
the session summary. Guard with a config flag:

```typescript
readonly feedback?: {
  readonly enabled: boolean;           // default true
  readonly ftsWeightDelta: number;     // default 0.02
  readonly maxAspectWeight: number;    // default 1.0
  readonly minAspectWeight: number;    // default 0.1
  readonly decayEnabled: boolean;      // default true
  readonly decayRate: number;          // default 0.005
  readonly decayIntervalSessions: number; // default 10
};
```

Add to `PipelineV2Config` in `packages/core/src/types.ts` and wire
defaults in `packages/daemon/src/memory-config.ts`.

### 3. Aspect weight decay

**Where:** `packages/daemon/src/pipeline/aspect-feedback.ts`

Without decay, aspect weights only go up. Aspects that were important
six months ago but haven't been confirmed recently should lose weight
over time.

```typescript
/**
 * Apply passive decay to aspect weights.
 * Run periodically (e.g., every N sessions or daily via maintenance).
 *
 * weight = max(minWeight, weight - decayRate)
 * Only aspects not updated in the last N sessions are decayed.
 */
export function decayAspectWeights(
  accessor: DbAccessor,
  agentId: string,
  config: {
    readonly decayRate: number;      // default 0.005
    readonly minWeight: number;      // default 0.1
    readonly staleDays: number;      // default 14
  },
): number; // returns count of aspects decayed
```

**Implementation:**

```sql
UPDATE entity_aspects
SET weight = MAX(?, weight - ?),
    updated_at = ?
WHERE agent_id = ?
  AND updated_at < ?  -- older than staleDays
  AND weight > ?      -- above minimum
```

**Wiring:** Call from the maintenance worker
(`packages/daemon/src/pipeline/maintenance-worker.ts`) on a
configurable interval — default every 10 sessions or daily,
whichever comes first.

### 4. Per-entity health signal

**Where:** `packages/daemon/src/knowledge-graph.ts`

Add a helper that computes per-entity health from predictor
comparison data:

```typescript
export interface EntityHealth {
  readonly entityId: string;
  readonly entityName: string;
  readonly comparisonCount: number;
  readonly winRate: number;
  readonly avgMargin: number;
  readonly trend: "improving" | "stable" | "declining";
}

/**
 * Compute per-entity predictor health from comparison slices.
 * Returns entities with enough comparison data to be meaningful
 * (minimum 3 comparisons).
 */
export function getEntityHealth(
  accessor: DbAccessor,
  agentId: string,
  since?: string,
  minComparisons?: number,  // default 3
): ReadonlyArray<EntityHealth>;
```

`trend` is computed by comparing win rate in the first half vs
second half of the comparison window. If second half win rate is
>10% higher → improving, >10% lower → declining, else stable.

**API endpoint:**

```
GET /api/knowledge/entities/health
  ?agent_id=default
  ?since=2026-03-01
  ?min_comparisons=3
  Returns: Array<EntityHealth>
```

**Dashboard:** Add a health indicator to entity cards in the
Knowledge tab. Entities with comparison data show a small colored
dot: green (improving/high win rate), yellow (stable/medium),
red (declining/low win rate). Entities without comparison data
show no indicator.

### 5. Superseded memory propagation

**Where:** `packages/daemon/src/knowledge-graph.ts`

When a memory is superseded (via `supersedeAttribute`), its
`entity_attributes` row is already marked `status = 'superseded'`.
But if the memory itself is later deleted or superseded in the
memories table, the entity_attributes status doesn't update
automatically.

Add a maintenance function:

```typescript
/**
 * Find entity_attributes rows whose linked memory has been
 * deleted or superseded, and update their status accordingly.
 * Run during maintenance sweeps.
 */
export function propagateMemoryStatus(
  accessor: DbAccessor,
  agentId: string,
): number; // returns count of attributes updated
```

**Implementation:**

```sql
UPDATE entity_attributes
SET status = 'superseded', updated_at = ?
WHERE agent_id = ?
  AND status = 'active'
  AND memory_id IS NOT NULL
  AND memory_id NOT IN (
    SELECT id FROM memories WHERE is_deleted = 0
  )
```

**Wiring:** Call from the maintenance worker alongside the existing
retention sweep.

### 6. Feedback telemetry

Add feedback metrics to the session-end log entry and the
`/api/pipeline/status` endpoint:

```typescript
// Session-end telemetry
feedbackAspectsUpdated: number;
feedbackFtsConfirmations: number;
feedbackDecayedAspects: number;
feedbackPropagatedAttributes: number;
```

Also add to the Knowledge tab stats section:
- Aspects updated by feedback (last 7 days)
- Average aspect weight across all entities
- Aspects at max weight (1.0)
- Aspects at min weight (0.1)

Data source: compute from `entity_aspects` table directly.

### 7. Feedback configuration

Add to `PipelineV2Config` in `packages/core/src/types.ts`:

```typescript
readonly feedback?: {
  readonly enabled: boolean;
  readonly ftsWeightDelta: number;
  readonly maxAspectWeight: number;
  readonly minAspectWeight: number;
  readonly decayEnabled: boolean;
  readonly decayRate: number;
  readonly staleDays: number;
};
```

Wire defaults in `packages/daemon/src/memory-config.ts` with YAML
parsing, same pattern as `traversal` and `structural` configs.

Guard: feedback only runs when `feedback.enabled && graph.enabled`.

---

## Key Files

- `packages/core/src/migrations/022-entity-pinning.ts` — new
  migration for pinned column
- `packages/core/src/migrations/index.ts` — register migration 022
- `packages/core/src/types.ts` — feedback config types
- `packages/daemon/src/knowledge-graph.ts` — pin/unpin helpers,
  entity health, superseded propagation
- `packages/daemon/src/pipeline/graph-traversal.ts` — pinned entity
  resolution in `resolveFocalEntities()`
- `packages/daemon/src/pipeline/aspect-feedback.ts` — new, FTS
  overlap feedback and aspect decay
- `packages/daemon/src/pipeline/maintenance-worker.ts` — wire decay
  and superseded propagation
- `packages/daemon/src/hooks.ts` — wire FTS feedback at session-end
- `packages/daemon/src/daemon.ts` — pin/unpin and health API endpoints
- `packages/daemon/src/memory-config.ts` — feedback config defaults
- `packages/cli/dashboard/src/lib/components/tabs/KnowledgeTab.svelte`
  — pin toggle, health indicators, feedback stats

## What NOT to Build

- Automatic entity pinning based on heuristics (future — manual
  only for now)
- Aspect weight feedback from predictor scores (requires scorer
  phase 3 integration, not just comparisons)
- Cross-entity weight balancing (e.g., reducing weight on entity A
  when entity B gains weight — adds complexity for unclear benefit)
- Entity archiving or lifecycle management (separate concern)
- Graph visualization with force-directed layout (still future)
- Traversal depth modulation based on win rates (future — KA-6
  surfaces the signal, doesn't act on it automatically)

## Verification

1. `bun run build` — no type errors
2. `bun test` — existing tests pass
3. `bun run typecheck` — clean
4. Migration 022 adds `pinned` and `pinned_at` columns idempotently
5. `pinEntity()` / `unpinEntity()` work correctly
6. `resolveFocalEntities()` always includes pinned entities alongside
   other resolved entities
7. Pinned entity appears as focal in session-start regardless of
   project path
8. Pin/unpin API endpoints work with correct agent_id scoping
9. Dashboard pin toggle updates entity state and refreshes view
10. FTS overlap feedback increases aspect weight for confirmed aspects
11. Weight stays clamped to [0.1, 1.0]
12. Feedback is a no-op when no FTS hits exist for the session
13. Aspect decay reduces weights on stale aspects
14. Decay respects minWeight floor
15. Superseded propagation catches orphaned entity_attributes
16. Entity health computes correct win rate and trend
17. Health indicators appear on entity cards in dashboard
18. Feedback telemetry appears in session-end logs
19. Feedback config respects `enabled` flag
20. Everything is a no-op when KA tables don't exist
