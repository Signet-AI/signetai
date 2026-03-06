---
title: "Sprint Brief: Knowledge Architecture KA-3"
---

# Sprint Brief: Knowledge Architecture KA-3

Traversal Retrieval Path

---

## What You're Building

The knowledge graph built in KA-1 (schema) and KA-2 (structural
assignment) is populated but passive — nothing reads from it at
retrieval time. This sprint wires traversal-first retrieval into the
session-start and recall paths so that the graph actively influences
which memories get surfaced.

The core idea: when an entity is in scope (matched by project path,
query terms, or checkpoint), walk its aspects, constraints, and
one-hop dependencies to collect structurally relevant memory IDs.
These join the candidate pool alongside the existing effective-score
and embedding candidates.

The hard invariant: constraints always surface when their entity is
in scope, regardless of score rank.

## Required Reading

1. `docs/specs/INDEX.md` — Cross-Cutting Invariants (especially #5:
   constraints always surface)
2. `docs/specs/approved/knowledge-architecture-schema.md` — section 7
   (retrieval contract)
3. `docs/KNOWLEDGE-ARCHITECTURE.md` — conceptual model
4. `docs/specs/SPRINT-BRIEF-KA1.md` — schema and helpers this depends on
5. `docs/specs/SPRINT-BRIEF-KA2.md` — structural assignment (populates
   the tables this sprint reads from)

## Prerequisites

KA-1 and KA-2 must be complete:
- `entity_aspects`, `entity_attributes`, `entity_dependencies`,
  `task_meta` tables exist and are indexed
- KA-1 CRUD helpers in `knowledge-graph.ts` are working
- KA-2 structural assignment pipeline is populating rows
- `getConstraintsForEntity()` returns correct results

## Current Retrieval Architecture

Understanding the existing flow is critical. Here's how retrieval
works today — KA-3 adds a new candidate source without replacing
anything.

### Session-start (`handleSessionStart` in hooks.ts:753)

1. `getAllScoredCandidates(project, limit)` — queries memories ordered
   by `created_at DESC`, scores each with `effectiveScore(importance,
   createdAt, pinned)` using 5%/day decay, filters `effScore > 0.2`
2. `selectWithBudget(candidates, 2000)` — picks top candidates within
   2000 char budget
3. `getPredictedContextMemories(project, 10, 600, excludeIds)` —
   extracts recurring terms from recent session summaries, FTS query
   for supplementary memories within 600 char budget
4. `recordSessionCandidates(sessionKey, candidates, injectedIds)` —
   records all candidates + which were injected into `session_memories`
5. Recovery checkpoint injection — loads latest checkpoint digest
   within 4h window, reserved separately from main budget

### Hybrid recall (`hybridRecall` in memory-search.ts:114)

1. BM25 keyword search (FTS5) — normalize scores to [0,1]
2. Vector search (sqlite-vec) — normalize cosine distances to [0,1]
3. Score merge — `alpha * vec + (1-alpha) * bm25` blend
4. Rehearsal boost — `log(access_count + 1) * recencyFactor`
5. **Graph boost** — `getGraphBoostIds()` in `graph-search.ts`,
   1-hop through `relations` table via `memory_entity_mentions`
6. Optional reranker — cross-encoder re-rank of top-N

### Current graph boost (graph-search.ts)

The existing `getGraphBoostIds()` does:
1. Tokenize query, match entities by `canonical_name LIKE %token%`
2. One-hop expansion through `relations` table (both directions)
3. Collect memory IDs via `memory_entity_mentions`
4. Apply flat boost weight (default 0.15)

This uses the OLD graph structure (`relations` + `memory_entity_mentions`).
KA-3 adds a PARALLEL traversal path through the NEW KA tables
(`entity_aspects`, `entity_attributes`, `entity_dependencies`).

---

## Deliverables

### 1. Traversal query builder

New file: `packages/daemon/src/pipeline/graph-traversal.ts`

This is the core of KA-3. A single function that takes focal entity
IDs and returns a structurally coherent set of memory IDs plus
constraint content.

```typescript
export interface TraversalResult {
  /** Memory IDs collected from entity_attributes.memory_id */
  readonly memoryIds: Set<string>;
  /** Constraint content that must always be surfaced */
  readonly constraints: ReadonlyArray<{
    readonly entityName: string;
    readonly content: string;
    readonly importance: number;
  }>;
  /** Entities traversed (for telemetry) */
  readonly entityCount: number;
  /** Whether traversal hit the timeout */
  readonly timedOut: boolean;
}

export interface TraversalConfig {
  /** Max aspects per entity, ordered by weight DESC (default 10) */
  readonly maxAspectsPerEntity: number;
  /** Max attributes per aspect (default 20) */
  readonly maxAttributesPerAspect: number;
  /** Max one-hop dependency expansions (default 30) */
  readonly maxDependencyHops: number;
  /** Minimum dependency strength to traverse (default 0.3) */
  readonly minDependencyStrength: number;
  /** Timeout in ms (default 500) */
  readonly timeoutMs: number;
}

export function traverseKnowledgeGraph(
  focalEntityIds: ReadonlyArray<string>,
  db: ReadDb,
  agentId: string,
  config: TraversalConfig,
): TraversalResult;
```

**Traversal algorithm** (all synchronous, same pattern as
`getGraphBoostIds`):

1. For each focal entity:
   a. Pull all active constraints (`entity_attributes` where
      `kind='constraint'` and `status='active'`) via JOIN through
      `entity_aspects`. These go into `constraints` output
      unconditionally.
   b. Pull top aspects by `weight DESC`, limited to
      `maxAspectsPerEntity`.
   c. For each aspect, pull active attributes limited to
      `maxAttributesPerAspect`. Collect `memory_id` values (skip
      NULL — those are unclassified stubs from pass 1).
2. One-hop dependency expansion:
   a. Query `entity_dependencies` for focal entities where
      `strength >= minDependencyStrength`, limited to
      `maxDependencyHops`.
   b. For each dependency target entity, repeat step 1 (constraints
      + top aspects + attributes). Do NOT recurse further — one hop
      only.
3. Deduplicate memory IDs across all collected attributes.
4. Check deadline at each major step (same `Date.now()` pattern as
   `graph-search.ts`).

**Key design decisions:**
- Constraints from dependency targets are also collected (if entity
  X depends on entity Y, Y's constraints matter for X's context)
- `memory_id = NULL` rows are skipped (awaiting KA-2 classification)
- The function is pure — takes a `ReadDb`, no side effects
- Timeout protection at each step, returns partial results on timeout

### 2. Focal entity resolution

New function in `graph-traversal.ts`:

```typescript
export interface FocalEntityResult {
  readonly entityIds: string[];
  readonly source: 'project' | 'checkpoint' | 'query' | 'session_key';
}

export function resolveFocalEntities(
  db: ReadDb,
  agentId: string,
  signals: {
    project?: string;
    sessionKey?: string;
    checkpointEntityIds?: string[];
    queryTokens?: string[];
  },
): FocalEntityResult;
```

Resolution priority:
1. **Checkpoint entity IDs** — if the recovery checkpoint includes
   structural snapshot fields (KA-5 future), use those directly
2. **Project path** — match project path against entity names/
   canonical names where `entity_type = 'project'`
3. **Session key lineage** — look up the most recent checkpoint for
   this session key, extract entity mentions from its digest
4. **Query tokens** — tokenize and match against entity
   `canonical_name` (same as `getGraphBoostIds` tokenizer)

For now, focus on project path matching (#2) and query token
matching (#4). The checkpoint fields (#1) are KA-5 and session key
lineage (#3) is a nice-to-have.

**Project path matching:**
```sql
SELECT id FROM entities
WHERE agent_id = ?
  AND entity_type = 'project'
  AND (canonical_name LIKE ? OR name LIKE ?)
ORDER BY mentions DESC
LIMIT 5
```

Normalize the project path: extract the last 1-2 directory segments
as search tokens. `/home/nicholai/signet/signetai` → search for
`%signetai%` and `%signet%`.

### 3. Wire traversal into session-start

**Where:** `packages/daemon/src/hooks.ts`, inside `handleSessionStart`

After `getAllScoredCandidates()` and before `selectWithBudget()`:

1. Resolve focal entities from `req.project`
2. Call `traverseKnowledgeGraph()` with focal entity IDs
3. Merge traversal memory IDs into the candidate pool:
   - For each traversal memory ID not already in `allCandidates`,
     fetch the memory row and add it with source `'ka_traversal'`
   - Traversal candidates get a synthetic effective score based on
     the attribute's importance (not the decay-based score)
4. Inject constraint content as a dedicated section in the output,
   AFTER the "Relevant Memories" section but BEFORE recovery context

**Constraint injection format:**
```
## Active Constraints

Constraints for entities in scope. These always apply.

- [EntityName] content of constraint
- [EntityName] another constraint
```

**Budget:** Constraints get their own reserved budget (default 1000
chars), carved out of `maxInjectChars` alongside the recovery context
reservation. Constraints are never truncated by the main budget —
they are appended after budget truncation, same pattern as recovery
context.

**Key constraint:** If there are no constraints and no traversal
memories, this path should be a no-op with zero overhead beyond the
focal entity resolution query.

### 4. Wire traversal into hybrid recall

**Where:** `packages/daemon/src/memory-search.ts`, inside
`hybridRecall`

After the existing graph boost block (line ~270) and before the
reranker:

1. Resolve focal entities from query tokens (use the same tokenizer
   as `getGraphBoostIds`)
2. Call `traverseKnowledgeGraph()` with focal entity IDs
3. For each traversal memory ID:
   - If already in `scored`, apply a boost (same pattern as graph
     boost: `(1 - tw) * score + tw` where `tw` is configurable,
     default 0.2)
   - If NOT in `scored`, add it with a base score derived from
     attribute importance
4. Re-sort after boost application
5. Constraints from traversal are NOT injected in recall (recall is
   a search, not context assembly — constraints only apply at
   session-start)

**Guard:** Only run if `cfg.pipelineV2.graph.enabled` and the KA
tables exist. Use a try/catch with graceful fallback (same pattern
as existing graph boost).

### 5. Update candidate pool fusion

**Where:** `packages/daemon/src/hooks.ts` and
`packages/daemon/src/session-memories.ts`

The KA spec defines the new candidate pool as:

```
traversal pool ∪ effective top-50 ∪ embedding top-50
```

Currently it's just `effective top-N`. After this deliverable:

1. Extend `SessionMemoryCandidate.source` type:
   ```typescript
   source: 'effective' | 'fts_only' | 'ka_traversal';
   ```
2. Record traversal candidates in `session_memories` with
   `source = 'ka_traversal'`
3. Cap the merged pool at a configurable limit (default 100) before
   budget selection

This ensures the predictive scorer (KA-4) can see which candidates
came from traversal vs effective score vs FTS.

### 6. Traversal configuration

Add to `PipelineV2Config` (in `packages/core/src/types.ts`):

```typescript
readonly traversal?: {
  readonly enabled: boolean;              // default true
  readonly maxAspectsPerEntity: number;    // default 10
  readonly maxAttributesPerAspect: number; // default 20
  readonly maxDependencyHops: number;      // default 30
  readonly minDependencyStrength: number;  // default 0.3
  readonly timeoutMs: number;             // default 500
  readonly boostWeight: number;           // default 0.2
  readonly constraintBudgetChars: number; // default 1000
};
```

Wire defaults in `packages/daemon/src/memory-config.ts` with YAML
parsing, same pattern as `structural` config from KA-2.

Guard: traversal only runs when `traversal.enabled && graph.enabled`.
If KA tables don't exist yet (migration hasn't run), traversal
silently returns empty results.

### 7. Telemetry

Add traversal metrics to the session-start log entry (already logged
at hooks.ts:966):

```typescript
traversalEntities: number;     // focal entities resolved
traversalMemories: number;     // unique memory IDs from traversal
traversalConstraints: number;  // constraints surfaced
traversalTimedOut: boolean;    // whether traversal hit timeout
```

Also add to the `/api/pipeline/status` endpoint so the dashboard
can show traversal health.

---

## Key Files

- `packages/daemon/src/pipeline/graph-traversal.ts` — new, core
  traversal logic
- `packages/daemon/src/pipeline/graph-search.ts` — existing graph
  boost (reference, not modified)
- `packages/daemon/src/hooks.ts` — wire traversal into session-start
- `packages/daemon/src/memory-search.ts` — wire traversal into recall
- `packages/daemon/src/session-memories.ts` — extend source type
- `packages/daemon/src/knowledge-graph.ts` — KA-1 helpers (read, not
  modified)
- `packages/core/src/types.ts` — traversal config types
- `packages/daemon/src/memory-config.ts` — traversal config defaults

## What NOT to Build (KA-4+)

- Predictor structural features (KA-4)
- Checkpoint structural snapshots (KA-5)
- Dashboard visualization of graph traversal (KA-5)
- Multi-hop traversal beyond one-hop dependencies (future)
- API endpoints for browsing aspects/attributes (future)
- Automatic task execution from task_meta (out of scope)

## Verification

1. `bun run build` — no type errors
2. `bun test` — existing tests pass
3. `bun run typecheck` — clean
4. With graph populated (KA-2 has run on some memories):
   - Session-start with a known project path resolves focal entities
   - Traversal collects memory IDs from entity_attributes
   - Constraints appear in the "Active Constraints" section of inject
5. Save a constraint fact (e.g., "never push directly to main for
   signetai") — verify it appears in session-start inject when
   project path matches
6. Save multiple facts about a project entity — verify traversal
   pulls them into session-start candidates
7. Verify constraint budget is reserved separately (constraints
   survive main budget truncation)
8. Verify traversal is a no-op when no KA data exists (empty tables)
9. Verify traversal respects `traversal.enabled = false`
10. Verify traversal timeout works (doesn't block session-start)
11. Verify recall graph boost includes traversal candidates
12. Verify `session_memories` records traversal candidates with
    `source = 'ka_traversal'`
13. Check telemetry: traversal metrics appear in session-start log
