---
title: "GitNexus Pattern Analysis"
description: "Techniques from GitNexus applicable to Signet's architecture."
order: 10
section: "Research"
---

GitNexus Pattern Analysis
=========================

*Engineering patterns from a code intelligence system, adapted for agent memory.*

> *GitNexus knows what your code looks like. Signet knows what your agent
> learned. The intersection is how you build navigable structure.*

This document analyzes techniques from [GitNexus](https://github.com/your-fork/gitnexus) (v1.3.10), a code intelligence system that builds a knowledge graph of codebases and exposes it via MCP tools. While GitNexus solves a different problem (static code analysis) than Signet (cross-session agent memory), several engineering patterns transfer directly.

Reference: `references/GitNexus/` in the Signet monorepo.

---

## What GitNexus Is

GitNexus is a **code intelligence layer** that indexes codebases into a knowledge graph of symbols, call chains, imports, and execution flows. It exposes that graph to AI agents via 7 MCP tools so agents can make structural changes without breaking dependencies.

**The key insight**: GitNexus doesn't just store facts about code — it builds *navigable structure* that agents can traverse. This is the same shift Signet needs to make: from flat retrieval to graph traversal.

What GitNexus provides:
- AST parsing for 12 languages (Tree-sitter)
- Knowledge graph in KuzuDB (Cypher queries)
- 7 MCP tools (query, context, impact, rename, detect_changes, cypher, list_repos)
- Leiden community detection (functional clustering)
- Execution flow tracing (process detection)
- Confidence scoring on every graph edge
- SWE-bench evaluation harness

What Signet needs from GitNexus:
- How to make the entity graph navigable
- How to bootstrap structure before feedback accumulates
- How to bound traversal to prevent runaway walks
- How to prove the system works with benchmarks

---

## Pattern 1: Leiden Community Detection for Entity Clustering

### The Problem

Signet's entity graph currently has no clustering. 43,520 entities exist as a flat list connected by typed dependencies (uses/requires/owned_by/blocks/informs). Desire Paths describes learned traversal topology but assumes the graph already has navigable structure. It doesn't — the graph is a warehouse, not a map.

Without clustering, the predictor has no way to route through related entities. Every entity is equally distant from every other entity. The graph lacks the density signal that makes traversal efficient.

### What GitNexus Does

GitNexus vendors the Leiden algorithm (Traag et al., 2019) from `graphology/communities-leiden`. It runs on CALLS + EXTENDS + IMPLEMENTS edges to cluster code into functional areas.

**Key parameters:**
- `resolution: 1.0` — balanced modularity (tunable: < 1.0 favors larger communities)
- `randomness: 0.01` — 1% stochasticity in refinement phase
- `randomWalk: true` — shuffled node processing order
- `weighted: false` — all edges treated equally (configurable)

**Output:**
- Community nodes with `cohesion` score (internal edges / total edges, 0-1)
- `heuristicLabel` generated from folder names or common name prefixes
- `MEMBER_OF` edges linking symbols to communities
- `modularity` global health metric (0-1, higher = stronger clustering)

**Source:** `gitnexus/vendor/leiden/index.cjs` (356 LOC), `gitnexus/src/core/ingestion/community-processor.ts` (374 LOC)

### How It Maps to Signet

Build a graphology graph from Signet entities:
- **Nodes** = entities
- **Edges** = dependency edges + co-mention edges (entities extracted from the same memory)
- **Weights** = mention count for co-mention, strength for dependencies

Run Leiden with `resolution: 0.5` (favor fewer, larger clusters since entity relationships are sparser than code call graphs) and `weighted: true`.

### Implementation Details

**Files to create:**
- `packages/daemon/src/graph/clustering/leiden-processor.ts` — wraps vendored Leiden
- `packages/daemon/src/graph/clustering/community-builder.ts` — converts Signet graph to graphology format

**Migration 030:**
```sql
-- Community nodes
CREATE TABLE entity_communities (
  id TEXT PRIMARY KEY,
  heuristic_label TEXT NOT NULL,
  cohesion REAL NOT NULL,
  member_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Membership edges
CREATE TABLE entity_community_members (
  community_id TEXT NOT NULL REFERENCES entity_communities(id) ON DELETE CASCADE,
  entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  PRIMARY KEY (community_id, entity_id)
);

CREATE INDEX idx_entity_communities_cohesion ON entity_communities(cohesion);
CREATE INDEX idx_entity_community_members_entity ON entity_community_members(entity_id);
```

**Graph construction:**
```typescript
// Build graphology graph from Signet entities
const graph = new Graph({ type: 'undirected' });

// Add entities as nodes
for (const entity of entities) {
  graph.addNode(entity.id, {
    name: entity.canonicalName,
    type: entity.type
  });
}

// Add dependency edges (weighted by strength)
for (const dep of dependencies) {
  if (!graph.hasEdge(dep.sourceEntityId, dep.targetEntityId)) {
    graph.addUndirectedEdge(dep.sourceEntityId, dep.targetEntityId, {
      weight: dep.strength
    });
  }
}

// Add co-mention edges (weighted by frequency)
for (const mention of coMentions) {
  if (!graph.hasEdge(mention.entityIdA, mention.entityIdB)) {
    graph.addUndirectedEdge(mention.entityIdA, mention.entityIdB, {
      weight: mention.count / maxCoMentionCount
    });
  }
}

// Run Leiden
const details = leiden.detailed(graph, {
  resolution: 0.5,
  randomWalk: true,
  weighted: true
});
```

**Cohesion scoring:**
```typescript
// Same approach as GitNexus: sample first 50 members for large communities
const calculateCohesion = (memberIds: string[], graph: Graph): number => {
  if (memberIds.length <= 1) return 1.0;

  const memberSet = new Set(memberIds);
  const SAMPLE_SIZE = 50;
  const sample = memberIds.length <= SAMPLE_SIZE
    ? memberIds
    : memberIds.slice(0, SAMPLE_SIZE);

  let internalEdges = 0;
  let totalEdges = 0;

  for (const nodeId of sample) {
    if (!graph.hasNode(nodeId)) continue;
    graph.forEachNeighbor(nodeId, (neighbor: string) => {
      totalEdges++;
      if (memberSet.has(neighbor)) {
        internalEdges++;
      }
    });
  }

  if (totalEdges === 0) return 1.0;
  return Math.min(1.0, internalEdges / totalEdges);
};
```

**Repair endpoint:** `/api/repair/cluster-entities`
```typescript
// packages/daemon/src/routes/repair.ts
router.post('/cluster-entities', async (req, res) => {
  const result = await clusterEntities(db);
  res.json({
    communities: result.communities.length,
    modularity: result.modularity,
    lowCohesionCount: result.communities.filter(c => c.cohesion < 0.4).length
  });
});
```

### What This Gives Desire Paths

**Bootstraps navigable structure:** Initial communities for the scorer to route through before any feedback accumulates.

**Quality signal for pruning:**
- Cohesion < 0.4 = weak cluster, members are pruning candidates
- Modularity < 0.3 = fragmented graph, prune aggressively
- Singletons (entities in no community) = definitionally disconnected

**Human-readable landmarks:** Community labels in constellation view as navigation aids.

**Explorer bee targets:** Low-cohesion communities are exactly where explorer bees should probe — weak structure might mean undiscovered connections.

### Relationship to LCM Patterns

- **Three-level extraction escalation (Pattern 2)** prevents *new* bloat. Leiden-based pruning cleans up *existing* bloat. Complementary.
- **Zero-cost continuity (Pattern 3)** prevents noise sessions from creating weak entities that dilute community quality.

**Implementation scope:** 2-3 days. Port vendored Leiden (MIT-licensed CommonJS), build graph from entity tables, add repair endpoint, surface in dashboard.

---

## Pattern 2: Confidence + Reason on Every Dependency Edge

### The Problem

Signet's `EntityDependency` has `strength` (how important) but no `confidence` (how certain) or `reason` (how discovered). These are different signals:

- **Strength**: "this dependency matters a lot" (importance)
- **Confidence**: "we're sure this dependency exists" (certainty)

Currently, an LLM-extracted dependency from a single ambiguous mention has the same structural weight as one the user explicitly stated. The Desire Paths scorer can't distinguish trustworthy edges from speculative ones.

### What GitNexus Does

Every CALLS relationship has `confidence: number` (0-1) and `reason: string`:

| Reason | Confidence | When Applied |
|--------|-----------|--------------|
| `import-resolved` | 0.9 | Call target found in imported file(s) |
| `same-file` | 0.85 | Call target in same source file |
| `fuzzy-global` single match | 0.5 | One global match, no import hint |
| `fuzzy-global` multiple matches | 0.3 | Ambiguous, multiple candidates |

Hard threshold of 0.5 filters edges during process tracing. Impact analysis defaults to 0.7 minimum. Rename tool tags edits as "graph" (high confidence) vs "text_search" (low confidence).

**Source:** `gitnexus/src/core/ingestion/call-processor.ts` (lines 237-283)

### How It Maps to Signet

Add confidence + reason to `entity_dependencies` table. Assign confidence based on extraction method.

### Implementation Details

**Migration 031:**
```sql
-- Add confidence and reason columns to entity_dependencies
ALTER TABLE entity_dependencies ADD COLUMN confidence REAL NOT NULL DEFAULT 0.7;
ALTER TABLE entity_dependencies ADD COLUMN reason TEXT NOT NULL DEFAULT 'single-memory';

-- Index for filtering
CREATE INDEX idx_entity_dependencies_confidence ON entity_dependencies(confidence);
```

**Reason enum for Signet:**

| Reason | Confidence | When |
|--------|-----------|------|
| `user-asserted` | 1.0 | User explicitly created or confirmed |
| `multi-memory` | 0.9 | LLM extracted from 2+ independent memories |
| `single-memory` | 0.7 | LLM extracted from one memory (default) |
| `pattern-matched` | 0.5 | Heuristic detection ("X requires Y" substring) |
| `inferred` | 0.4 | Transitive closure or co-mention clustering |
| `llm-uncertain` | 0.3 | LLM hedged or low-signal extraction |

**Types update:**
```typescript
// packages/core/src/types.ts
export type DependencyReason =
  | 'user-asserted'
  | 'multi-memory'
  | 'single-memory'
  | 'pattern-matched'
  | 'inferred'
  | 'llm-uncertain';

export interface EntityDependency {
  readonly id: string;
  readonly sourceEntityId: string;
  readonly targetEntityId: string;
  readonly agentId: string;
  readonly aspectId: string | null;
  readonly dependencyType: DependencyType;
  readonly strength: number;
  readonly confidence: number; // NEW: 0-1, how certain
  readonly reason: DependencyReason; // NEW: how discovered
  readonly createdAt: string;
  readonly updatedAt: string;
}
```

**Extraction worker update:**
```typescript
// packages/daemon/src/pipeline/structural-dependency.ts

// Level 1: Normal extraction
const confidence = 0.7;
const reason = 'single-memory';

// Level 2: Escalated extraction (stricter LLM)
const confidence = 0.5;
const reason = 'pattern-matched';

// Level 3: Deterministic filtering
const confidence = 0.3;
const reason = 'llm-uncertain';

// User confirmation path
const confidence = 1.0;
const reason = 'user-asserted';

// Cross-validation: extracted in 2+ memories
if (await countMemoriesWithDependency(sourceId, targetId) >= 2) {
  confidence = 0.9;
  reason = 'multi-memory';
}
```

**Graph traversal update:**
```typescript
// packages/daemon/src/graph/graph-traversal.ts

// Weight traversal candidates by confidence * strength
const sortedDeps = dependencies
  .filter(d => d.confidence >= minConfidence)
  .sort((a, b) => (b.confidence * b.strength) - (a.confidence * a.strength));

// Take top N by weighted score
const candidates = sortedDeps.slice(0, maxBranching);
```

**API endpoint update:**
```typescript
// POST /api/graph/dependencies
{
  "sourceEntityId": "...",
  "targetEntityId": "...",
  "dependencyType": "uses",
  "strength": 0.8,
  "confidence": 0.7, // NEW
  "reason": "single-memory" // NEW
}
```

**Impact analysis tool (new MCP tool):**
```typescript
// POST /api/graph/impact
{
  "entityId": "signet",
  "direction": "upstream", // or "downstream"
  "minConfidence": 0.7,
  "maxDepth": 3
}

// Response:
{
  "depth_1": {
    "description": "WILL BREAK",
    "entities": [
      { "id": "dashboard", "confidence": 0.9, "reason": "user-asserted" },
      { "id": "daemon", "confidence": 0.85, "reason": "multi-memory" }
    ]
  },
  "depth_2": {
    "description": "LIKELY AFFECTED",
    "entities": [...]
  },
  "depth_3": {
    "description": "MAY NEED TESTING",
    "entities": [...]
  }
}
```

### What This Gives Desire Paths

**Meaningful prior weights:** The scorer starts with signal instead of treating all edges equally.

**Traversal preferences:** High-confidence edges are preferred candidates before feedback accumulates. Low-confidence edges are natural explorer bee territory.

**Feedback upgrade path:** Positive feedback can upgrade confidence (confirmed speculation). Negative feedback can downgrade it (unreliable extraction).

**Blast radius analysis:** Filter at `confidence >= 0.7` for impact analysis removes speculative edges, making predictions more reliable.

### Relationship to LCM Patterns

- **Three-level extraction escalation (Pattern 2)** assigns confidence by escalation level: Level 1 = 0.7, Level 2 = 0.5, Level 3 = 0.3.
- **Session summary DAG (Pattern 4)** summaries carry forward only high-confidence dependencies (>= 0.7).

**Implementation scope:** 1-2 days. Migration + types update + extraction worker change + graph traversal update + API endpoint.

---

## Pattern 3: Bounded Traversal Parameters

### The Problem

Signet's graph traversal (`graph-traversal.ts`) has `maxDependencyHops` and `constraintBudgetChars` but no branching limit. On the 43k entity graph, an unbounded traversal from a well-connected entity could walk thousands of paths.

Desire Paths assumes bounded candidate paths for the scorer to rank. Without bounds, the scorer would rank thousands of paths per query — too slow and too noisy.

### What GitNexus Does

Process tracing uses explicit bounds:
- `maxTraceDepth: 10` — maximum hops from entry point
- `maxBranching: 4` — at each node, follow at most 4 edges
- `maxProcesses: 75` — total processes to generate
- `minSteps: 3` — minimum steps for valid process

Minimum confidence threshold (0.5) filters noisy edges before traversal even starts.

**Source:** `gitnexus/src/core/ingestion/process-processor.ts`

### How It Maps to Signet

Add branching limits to graph traversal config.

### Implementation Details

**Traversal config:**
```typescript
// packages/daemon/src/graph/graph-traversal.ts

export interface TraversalConfig {
  maxDependencyHops: number; // existing
  constraintBudgetChars: number; // existing

  // NEW: branching limits
  maxBranching: number; // at each entity, follow at most N edges
  maxTraversalPaths: number; // total paths to score
  minPathLength: number; // don't score trivial single-hop paths
  minConfidence: number; // filter edges below this confidence
}

const DEFAULT_CONFIG: TraversalConfig = {
  maxDependencyHops: 5,
  constraintBudgetChars: 2000,
  maxBranching: 4,
  maxTraversalPaths: 50,
  minPathLength: 2,
  minConfidence: 0.5
};
```

**Traversal enforcement:**
```typescript
// packages/daemon/src/graph/graph-traversal.ts

const traverseEntity = (
  entityId: string,
  depth: number,
  pathSoFar: Path,
  paths: Path[],
  config: TraversalConfig
): void => {
  if (depth >= config.maxDependencyHops) return;
  if (paths.length >= config.maxTraversalPaths) return;

  // Get dependencies, sorted by confidence * strength, filtered by min confidence
  const deps = getDependencies(entityId)
    .filter(d => d.confidence >= config.minConfidence)
    .sort((a, b) => (b.confidence * b.strength) - (a.confidence * a.strength))
    .slice(0, config.maxBranching);

  for (const dep of deps) {
    const newPath = [...pathSoFar, dep];

    // Only score paths that meet minimum length
    if (newPath.length >= config.minPathLength) {
      paths.push(newPath);
    }

    // Continue traversal
    traverseEntity(dep.targetEntityId, depth + 1, newPath, paths, config);
  }
};
```

**Config exposure:**
```typescript
// packages/daemon/src/routes/config.ts

router.get('/traversal', (req, res) => {
  res.json(getTraversalConfig());
});

router.post('/traversal', (req, res) => {
  const config = updateTraversalConfig(req.body);
  res.json(config);
});
```

### What This Gives Desire Paths

**Bounded candidate paths:** The scorer can efficiently rank paths without drowning in noise.

**Explorer bee room:** Branching limits on main traversal ensure explorer bees have space to contribute novel paths without being drowned out.

**Predictable performance:** Traversal cost is bounded by `maxBranching ^ maxDependencyHops * maxTraversalPaths`.

### Implementation Scope

**Half day.** Add constants to traversal config, enforce in graph-traversal.ts.

---

## Pattern 4: Execution Flow Tracing (Temporal Continuity)

### The Problem

Signet entities have dependencies, but those dependencies lack temporal structure. Entity A uses entity B is a static fact. But "entity A calls entity B, which then updates entity C" is a flow — a cause-and-effect chain.

GitNexus models execution flows explicitly. Signet could use the same technique for entity dependency chains that represent workflows.

### What GitNexus Does

GitNexus detects entry points (functions with high call ratio, exported, framework-specific names), then BFS-traces from those entry points through CALLS edges to build "processes" — execution flow representations.

**Process detection config:**
- `maxTraceDepth: 10`
- `maxBranching: 4`
- `maxProcesses: 75`
- `minSteps: 3`

**Process nodes:**
```typescript
{
  id: 'process_onCreate_toastNotification',
  entryPoint: 'onCreate',
  terminalNode: 'showToast',
  stepCount: 5,
  processType: 'cross-community', // or 'intra-community'
  trace: [
    { step: 1, nodeId: 'onCreate', confidence: 0.9 },
    { step: 2, nodeId: 'validateInput', confidence: 0.85 },
    { step: 3, nodeId: 'saveToDatabase', confidence: 0.9 },
    { step: 4, nodeId: 'notifyUser', confidence: 0.8 },
    { step: 5, nodeId: 'showToast', confidence: 0.85 }
  ]
}
```

**Source:** `gitnexus/src/core/ingestion/process-processor.ts`, `gitnexus/src/core/ingestion/entry-point-scoring.ts`

### How It Maps to Signet

Entity workflows are already partially captured via dependency edges. But there's no explicit representation of *sequence* — "this happens, then that happens."

**Potential adaptation:** Create "workflow" entities that chain dependency edges into ordered sequences. These workflows become traversable nodes themselves.

**Example:**
```
workflow: "deploy_new_feature"
  step_1: signet -> depends_on -> github_repo
  step_2: github_repo -> triggers -> ci_pipeline
  step_3: ci_pipeline -> updates -> signet_version
  step_4: signet_version -> deployed_to -> production
```

This is more speculative than the other patterns. It requires further research. Documenting here as a potential future direction.

---

## Pattern 5: Coordinated Entity Renaming

### The Problem

When an entity's canonical name changes (deduplication merges, user correction), every reference to that entity needs updating: dependency edges, memory mentions, aspect references.

Currently this is a manual scatter-shot process. GitNexus has a graph-aware rename tool.

### What GitNexus Does

The `rename` MCP tool takes a symbol name and new name, then:
1. **Graph-based renames:** Find all edges referencing the symbol, tag edits as high-confidence ("graph")
2. **Text search renames:** Grep for string matches in source files, tag edits as lower-confidence ("text_search")
3. **Dry-run mode:** Show what would change without applying
4. **Confidence tagging:** Every edit is labeled with confidence level

**Source:** `gitnexus/src/mcp/local/local-backend.ts` (lines 1135-1142)

### How It Maps to Signet

Create a `/api/graph/rename-entity` endpoint that propagates canonical name changes through the graph.

### Implementation Details

```typescript
// POST /api/graph/rename-entity
{
  "entityId": "old_name",
  "newCanonicalName": "correct_name",
  "dryRun": false
}

// Response:
{
  "edgesUpdated": 47,
  "memoriesUpdated": 12,
  "aspectsUpdated": 3,
  "edits": [
    {
      "type": "dependency",
      "id": "dep_123",
      "field": "sourceEntityId",
      "oldValue": "old_name",
      "newValue": "correct_name",
      "confidence": "graph"
    },
    {
      "type": "memory_mention",
      "id": "mention_456",
      "field": "content",
      "oldValue": "old_name",
      "newValue": "correct_name",
      "confidence": "text_search"
    }
  ]
}
```

This is a useful tool but lower priority than clustering, confidence, and bounded traversal. Documenting for completeness.

---

## Pattern 6: Raw Graph Queries for Power Users

### The Problem

Predefined traversal patterns (session-start injection, impact analysis, etc.) cover common cases. But power users sometimes need arbitrary graph queries that the tools don't anticipate.

### What GitNexus Does

The `cypher` MCP tool lets agents write raw Cypher queries against KuzuDB. LLMs are surprisingly good at writing Cypher because it's declarative and graph-native.

**Source:** `gitnexus/src/mcp/tools.ts`

### How It Maps to Signet

Signet uses SQLite, not KuzuDB. SQLite doesn't speak Cypher. But the *concept* maps: expose a read-only SQL endpoint for arbitrary entity/aspect/attribute queries.

**Potential implementation:**
```typescript
// POST /api/graph/query
{
  "sql": "SELECT e.canonicalName, COUNT(a.id) as aspect_count FROM entities e LEFT JOIN entity_aspects a ON e.id = a.entityId GROUP BY e.id ORDER BY aspect_count DESC LIMIT 10"
}

// Response:
{
  "columns": ["canonicalName", "aspect_count"],
  "rows": [
    ["signet", 12],
    ["nicholai", 8],
    ["dashboard", 6]
  ]
}
```

Security concern: this requires careful SQL sanitization and read-only enforcement. Lower priority than other patterns. Documenting for future consideration.

---

## Pattern 7: Sigma.js Graph Visualization

### The Problem

Signet's constellation view uses 3d-force-graph for entity visualization. It looks beautiful but struggles at scale because it runs physics simulation on every frame for every node. GitNexus uses Sigma.js, which handles thousands of nodes smoothly via WebGL rendering with static layouts.

### What GitNexus Does

Sigma.js renders large graphs efficiently by:
- WebGL rendering (GPU-accelerated)
- Static or once-computed layouts (no per-frame physics)
- Edge bundling and decluttering
- Progressive rendering for huge graphs

**Source:** `gitnexus-web/src/components/` (React + Sigma.js integration)

### How It Maps to Signet

The constellation view should migrate from 3d-force-graph to Sigma.js. This isn't just cosmetic — it's structural. If we're adding community clusters, confidence-weighted edges, and traversal paths to the visualization, we need a renderer that can handle the complexity without catching fire.

**Implementation scope:** 2-3 days. Replace 3d-force-graph with Sigma.js in constellation view. Preserve entity mode visualization. Add community cluster rendering.

---

## Pattern 8: SWE-Bench Evaluation Harness

### The Problem

Signet has continuity scoring (self-reported) but no task-completion benchmarks. You can't currently prove that memory injection helps agents do better work.

### What GitNexus Does

Full SWE-bench evaluation framework in Python:
- **3 modes**: baseline (no tools), native (explicit tools), native_augment (tools + automatic grep enrichment)
- **Docker containers** per task instance
- **Eval-server** keeps KuzuDB warm for fast tool calls (~100ms)
- **Metrics**: patch_rate, resolve_rate, cost, api_calls, tool_calls, augmentation_hit_rate

**Source:** `eval/run_eval.py` (509 LOC), `eval/agents/gitnexus_agent.py` (210 LOC)

### How It Maps to Signet

This is critical for proving the Desire Paths thesis. If constructed memories don't beat flat retrieval on benchmarks, the architecture is wrong.

**Proposed Signet eval design:**

**Modes:**
- `baseline`: `SIGNET_BYPASS=1` — agent has zero memory
- `signet`: Normal daemon — session-start injection, per-prompt context
- `signet-warm`: Pre-seeded memories from previous sessions — tests multi-session continuity

**Task types:**
1. Knowledge retention: Agent learns facts in session 1, gets quizzed in session 5
2. Constraint enforcement: Agent told "never use X" in session 1, does it respect that in session 10?
3. Cross-project transfer: Agent learns pattern in project A, does it apply it in project B?
4. Context efficiency: Does memory injection reduce redundant analysis (fewer LLM calls)?
5. Noise resilience: After 100 sessions, is injected context still relevant?

**Metrics:**
- `retention_rate` — % of seeded facts correctly recalled
- `constraint_violation_rate` — % of tasks where a constraint was broken
- `cost_delta` — cost vs baseline (should be lower with memory)
- `api_call_delta` — LLM calls vs baseline (should be fewer)
- `context_precision` — % of injected memories that were actually used
- `context_recall` — % of relevant memories that were injected

**Implementation scope:** 1-2 weeks for minimal viable harness. This validates everything but can be deferred until Desire Paths has a working prototype.

---

## Pattern 9: Reciprocal Rank Fusion (RRF) for Search

### The Problem

Signet uses alpha blending: `alpha * vector_score + (1-alpha) * bm25_score`. This requires both scores to be on comparable scales, which they often aren't. Alpha tuning is fragile.

### What GitNexus Does

Reciprocal Rank Fusion with k=60: `score = 1 / (60 + rank)`. Sums RRF scores from BM25 and semantic, sorts by total. No score normalization needed — purely rank-based.

**Source:** `gitnexus/src/core/search/hybrid-search.ts`

### How It Maps to Signet

Offer both strategies as a search config option. Default to RRF (simpler, more robust), allow alpha blending for users who want fine-grained control.

**Implementation scope:** 1 day. Add `searchFusionStrategy: 'rrf' | 'alpha'` to search config. Implement RRF merger alongside existing alpha blender.

---

## Adoption Priority

| Pattern | Impact | Effort | Priority | Blocks |
|---------|--------|--------|----------|--------|
| **Confidence + reason on edges** | High (unlocks better traversal) | 1-2 days | P1 | Desire Paths path scoring |
| **Bounded traversal params** | Medium (prevents runaway walks) | 0.5 day | P1 | Desire Paths performance |
| **Leiden entity clustering** | High (bootstraps structure) | 2-3 days | P2 | Entity bloat resolution |
| **Sigma.js visualization** | Medium (scalable rendering) | 2-3 days | P2 | Community visualization |
| **RRF search fusion** | Medium (more robust search) | 1 day | P2 | Nothing |
| **Evaluation harness** | Critical (proves the thesis) | 1-2 weeks | P3 | Nothing (but validates everything) |
| **Execution flow tracing** | Medium (temporal continuity) | Research needed | P3 | Nothing |
| **Coordinated rename** | Low (maintenance tool) | 1 day | P4 | Nothing |
| **Raw graph queries** | Low (power user feature) | 2 days | P4 | Security review needed |

P1 items are prerequisites for Desire Paths implementation. P2 items are independent improvements. P3 validates the roadmap.

---

## Implementation Notes

**Where to put the Leiden vendor:**
- `packages/daemon/src/graph/clustering/vendor/leiden/` — copy `index.cjs` and `utils.cjs` from GitNexus
- It's MIT-licensed CommonJS, can import directly

**Database considerations:**
- Leiden runs in-memory on graphology graph built from SQLite query
- Clustering is expensive but doesn't need to run often (weekly? on-demand via repair endpoint?)
- Store community membership persistently, not recomputed every traversal

**Constellation view integration:**
- Community nodes appear as larger, labeled clusters
- Edge thickness = confidence (new field)
- Edge brightness = strength (existing field)
- Communities can be expanded/collapsed in UI

**Dashboard repair actions:**
- `/api/repair/cluster-entities` — run Leiden, create community nodes
- `/api/repair/prune-low-confidence` — delete dependencies with confidence < 0.3
- `/api/repair/prune-disconnected` — delete entities in no community AND no dependencies

---

## Key Files Summary

| File | Purpose |
|------|---------|
| `gitnexus/vendor/leiden/index.cjs` | Leiden algorithm implementation (356 LOC) |
| `gitnexus/vendor/leiden/utils.cjs` | Refinement phase & data structures (393 LOC) |
| `gitnexus/src/core/ingestion/community-processor.ts` | Graph building, Leiden invocation, cohesion scoring (374 LOC) |
| `gitnexus/src/core/ingestion/call-processor.ts` | Confidence scoring (lines 237-283) |
| `gitnexus/src/core/ingestion/process-processor.ts` | Bounded traversal |
| `gitnexus/src/mcp/local/local-backend.ts` | Impact analysis, rename tool |
| `gitnexus/src/core/search/hybrid-search.ts` | RRF implementation |
| `gitnexus-web/src/components/` | Sigma.js visualization |
| `eval/run_eval.py` | SWE-bench evaluation runner |

---

*GitNexus is a scalpel — sharp, precise, does one thing exceptionally well. Signet is a workshop — broader, more ambitious, building toward a complete agent identity platform. These patterns are the tools worth borrowing from the scalpel shop.*

---

*Analysis conducted March 11, 2026. GitNexus version 1.3.10 (112 commits ahead of initial review). Written by Mr. Claude and Nicholai.*
