---
title: "Lossless Context Patterns"
description: "Five patterns from LCM adapted for Signet's memory architecture."
order: 4
section: "Core Concepts"
---

Lossless Context Patterns
=========================

*Deterministic guarantees for a learning system.*

> *LCM provides the floor. Desire paths provide the ceiling.
> Together they're stronger than either alone.*

This document describes five patterns adapted from Voltropy's Lossless
Context Management (LCM) paper and its reference implementation
(lossless-claw). These patterns are not LCM itself -- they are
principles extracted from LCM and recontextualized for Signet's
cross-session memory architecture.

These patterns form the foundation layer that [[DESIRE-PATHS|desire paths]]
builds on. They can be implemented independently, before desire paths,
and each one strengthens the system on its own.

References:
- LCM paper: https://papers.voltropy.com/LCM (Ehrlich & Blackman, Feb 2026)
- lossless-claw: `references/lossless-claw/`
- Research notes: `docs/RESEARCH-LCM-ACP.md`

---


Pattern 1: Lossless Retention
-----------------------------

### The Principle

Nothing is ever truly lost. Information moves between tiers, not out
of the system. Decay reduces visibility, not existence.

### The LCM Pattern

LCM maintains an immutable store alongside an active context. Every
message is persisted verbatim and never deleted. Summaries are
materialized views over this store -- derived artifacts, not
replacements. Any summary can be expanded back to its constituent
messages via `lcm_expand`.

### Current Signet Behavior

The retention worker (`retention-worker.ts`) performs hard deletes of
tombstoned memories past the retention window. When a memory is pruned,
the content is gone. When an entity attribute is superseded by a newer
extraction, the old attribute is deleted. The `memory_history` table
preserves brief snapshots, but these decay too.

### The Adaptation

Replace hard deletion with cold-tier archival. A memory that is
pruned, superseded, or decayed below threshold moves to a
`memories_cold` table with the same schema but no FTS5 index and
no vector index. Pure text storage. The retention worker archives
instead of purges.

The cold tier is not queried during normal retrieval. It is available
for:

1. **Explorer bee traversals** -- when a speculative traversal walks
   into cold territory, it can surface forgotten connections that
   turn out to be relevant in a new context.

2. **Entity health diagnostics** -- when a path consistently produces
   poor feedback, one diagnostic question is "what did this entity
   look like three months ago?" The cold tier answers that.

3. **Recovery from bad extractions** -- if the pipeline corrupts an
   entity (overwrites correct attributes with incorrect ones), the
   cold tier enables rollback to the last known-good state.

4. **Principle discovery** -- cross-entity patterns may span active
   and archived knowledge. A superseded attribute from a year ago
   might be the bridge between two entities that haven't been
   connected yet.

### Implementation

- Migration: create `memories_cold` table (identical schema to
  `memories`, no FTS5 trigger, no vector index)
- Modify `retention-worker.ts`: `INSERT INTO memories_cold SELECT *
  FROM memories WHERE id IN (...)` before `DELETE`
- Add `cold_source_id` column to `memories` for supersession chains
  (when memory B supersedes memory A, A moves to cold with
  `cold_source_id` pointing to B)
- Add `/api/repair/cold-stats` endpoint for dashboard visibility
- Explorer bee traversal gains access to cold tier via a separate
  query path (no FTS, just direct ID lookup and basic LIKE search)

### What This Enables

Desire paths' feedback-driven decay becomes non-destructive. A path
that gets demoted by consistently bad feedback can still be
rediscovered by an explorer bee, confirmed as good in a new context,
and promoted back to active. The system's topology can evolve without
permanent information loss.

The philosophical shift: from "old things fade away" to "old things
step back but remain reachable." The practical shift: one migration
and a retention worker change.


---


Pattern 2: Three-Level Extraction Escalation
--------------------------------------------

### The Principle

Every pipeline stage must have a convergence guarantee. If the
normal path fails to produce bounded output, escalate to
progressively stricter strategies until a deterministic fallback
guarantees termination.

### The LCM Pattern

LCM's compaction uses three levels:
1. Normal: LLM summarize with full detail preservation
2. Aggressive: LLM summarize with bullet points at half the token budget
3. Deterministic: hard truncation to 512 tokens, no LLM involved

If any level produces output smaller than input, it returns. Level 3
always converges. Compaction never makes things worse.

### Current Signet Behavior

The extraction pipeline runs an LLM pass that can produce an
unbounded number of entities and attributes. There is no structural
backstop preventing a runaway extraction from producing 5,000
entities from a single document. The 43,000-entity bloat problem is
partially a consequence of this missing guarantee.

### The Adaptation

Apply three-level escalation to the extraction pipeline:

**Level 1 (Normal):** Current extraction prompt. Full fact
identification, structural assignment, entity creation. Run as-is.

**Level 2 (Aggressive):** If Level 1 produces more than N new
entities or M new attributes for this session chunk, re-run with a
stricter prompt: "Extract only decisions, constraints, and persistent
facts. Ignore transient states, error messages, and conversational
scaffolding. Maximum 5 new entities per chunk."

**Level 3 (Deterministic):** If Level 2 still produces too much,
apply structural rules with no LLM involved:
- Keep only items that the deduplication pass finds no existing match
  for (genuinely new knowledge)
- Keep any items explicitly flagged as constraints
- Discard everything else

The thresholds that trigger escalation can be calibrated per entity
type: a project entity tolerates 30 attributes; a person entity
shouldn't exceed 15; an unknown-type entity getting more than 5
attributes in a single session is suspicious.

### Implementation

- Add escalation logic to the extraction stage in
  `packages/daemon/src/pipeline/worker.ts`
- Define threshold constants (configurable via agent.yaml):
  `maxNewEntitiesPerChunk` (default 10),
  `maxNewAttributesPerEntity` (default 20)
- Level 2 prompt variant stored alongside existing extraction prompts
- Level 3 is pure TypeScript filtering logic, no LLM call
- Add `extraction_level` field to pipeline telemetry so we can
  observe how often escalation triggers
- Dashboard: surface escalation frequency in pipeline status

**Confidence scoring integration:**

Each escalation level assigns a confidence score to extracted dependencies:

- **Level 1 (Normal):** `confidence: 0.7`, `reason: 'single-memory'` — standard extraction
- **Level 2 (Aggressive):** `confidence: 0.5`, `reason: 'pattern-matched'` — stricter prompt means lower certainty
- **Level 3 (Deterministic):** `confidence: 0.3`, `reason: 'llm-uncertain'` — no LLM involved, minimal certainty

This ensures the escalation pattern feeds directly into the confidence-weighted graph that desire paths traverses. Higher escalation → lower confidence → less influence on traversal until confirmed by feedback.

See [GitNexus Pattern Analysis](./RESEARCH-GITNEXUS-PATTERNS.md#pattern-2-confidence--reason-on-every-dependency-edge) for full confidence scoring implementation.

### What This Enables

The entity bloat problem becomes structurally impossible. The
extraction pipeline always terminates, output is always bounded,
and the system never makes the database worse by adding pure noise.
This is a prerequisite for desire paths -- if the graph is polluted
with noise entities, path scoring learns from garbage.


---


Pattern 3: Zero-Cost Continuity
-------------------------------

### The Principle

Below a significance threshold, the system is invisible. No
extraction, no summarization, no overhead. The cost of the memory
pipeline is zero when there is nothing worth remembering.

### The LCM Pattern

LCM defines `tau_soft` and `tau_hard` thresholds. Below `tau_soft`,
the system is a passive logger -- no summarization, no retrieval, no
latency penalty. The overhead appears only when it is needed.

### Current Signet Behavior

The pipeline runs on every session-end hook regardless of session
length or content significance. A 3-turn conversation about a
trivial question still runs through extraction, structural
assignment, deduplication, and retention. The cost is not zero: it
produces low-quality memories that increase the deduplication and
decay burden, and those memories generate misleading path
reinforcement signals.

### The Adaptation

Add a significance gate at the pipeline entry point. If a session
fails the gate, skip extraction entirely and log the session for
potential later backfill.

The significance gate checks:
1. **Turn count**: sessions with fewer than N substantive turns
   (default 5) are candidates for skip. "Substantive" means the
   user message is longer than a greeting and the assistant response
   contains more than acknowledgment.
2. **Entity mention density**: if the session transcript has zero
   FTS matches against existing high-importance entities, there is
   likely nothing to extract.
3. **Content novelty**: if the session's embedding is within a
   threshold distance of recent session embeddings, it is likely
   rehashing known territory.

If all three checks indicate low significance, the pipeline emits
a `session_skipped` telemetry event and returns. The raw session
transcript is still persisted (lossless retention applies here too)
-- it just doesn't trigger extraction.

### Implementation

- Add `significanceGate()` function to pipeline entry
  (`packages/daemon/src/pipeline/worker.ts`)
- Gate runs before extraction, after session transcript is received
- Configurable thresholds in agent.yaml: `pipeline.minTurns`,
  `pipeline.minEntityOverlap`, `pipeline.noveltyThreshold`
- Telemetry: `session_skipped` event with gate results for
  observability
- Backfill path: `/api/repair/backfill-skipped` endpoint to
  retroactively run extraction on skipped sessions if needed

### What This Enables

Cleaner path reinforcement signals for desire paths. If 30% of
extractions are noise from trivial sessions, 30% of path
reinforcement signals are misleading. Zero-cost continuity prevents
noise from entering the system in the first place.

Also reduces daemon load. On a busy day with 20+ sessions, many are
quick questions or status checks. Skipping those saves LLM calls
and database writes.


---


Pattern 4: Session Summary DAG
------------------------------

### The Principle

Session histories should form a hierarchical structure with
increasing levels of abstraction, not a flat list of summaries.
Individual sessions compose into arcs. Arcs compose into epochs.
Each level is traversable with drill-down to the level below.

### The LCM Pattern

LCM builds a Directed Acyclic Graph of summaries:
- Leaf summaries (depth 0): condensed versions of raw message chunks
- Condensed summaries (depth 1+): higher-order summaries merging
  lower nodes
- Parent links enable drill-down recovery of original content
- Depth-aware prompts: leaf summaries preserve operational detail,
  higher depths focus on goals and decisions

### Current Signet Behavior

`summary-worker.ts` produces flat markdown summaries at session end.
These are stored as files in `~/.agents/memory/summaries/`. There is
no hierarchy, no parent links, no depth-aware condensation. Sessions
from three months ago are equally flat whether they were a 5-minute
fix or part of a week-long architecture sprint.

### The Adaptation

Build a session summary DAG alongside the existing entity graph.
The entity graph organizes knowledge *spatially* (by topic). The
session DAG organizes knowledge *temporally* (by when it happened).

**Depth 0 (Session):** Individual session summaries. Produced by
the existing summary worker. Enhanced with structured metadata:
linked memory IDs, mentioned entity IDs, project entity reference,
predecessor session link (if the session continues recent work on
the same project).

**Depth 1 (Arc):** After every N sessions on the same project
(default 8), generate an arc summary that condenses the session
summaries. Arc summaries preserve decisions, outcomes, and turning
points. Operational details (specific commands, error messages) are
dropped. Parent links point to constituent session summaries.

**Depth 2 (Epoch):** After every M arcs (default 4), generate an
epoch summary. Epoch summaries preserve only architectural facts,
major pivots, and persistent constraints. Parent links point to
constituent arc summaries.

The depth-aware prompt strategy follows LCM directly:
- Session prompts: "Preserve operational detail, commands, error
  messages, and specific decisions."
- Arc prompts: "Preserve decisions and outcomes. Drop transient
  errors and command-level detail."
- Epoch prompts: "Preserve only architectural facts, major
  direction changes, and constraints that still apply."

### Implementation

- Migration: create `session_summaries` table:
  ```
  id TEXT PRIMARY KEY,
  project_entity_id TEXT,
  depth INTEGER DEFAULT 0,
  kind TEXT CHECK(kind IN ('session', 'arc', 'epoch')),
  content TEXT,
  token_count INTEGER,
  earliest_at TEXT,
  latest_at TEXT,
  parent_summary_id TEXT,  -- for arcs/epochs: NULL for sessions
  agent_id TEXT DEFAULT 'default'
  ```
- Junction table `session_summary_children`:
  ```
  parent_id TEXT,
  child_id TEXT,
  ordinal INTEGER
  ```
- Junction table `session_summary_memories`:
  ```
  summary_id TEXT,
  memory_id TEXT
  ```
- Modify `summary-worker.ts` to write structured session summary
  nodes instead of flat markdown
- Add arc/epoch condensation as a periodic maintenance task
  (runs after session summary, checks if arc threshold met)
- Add `/api/sessions/summaries` endpoint for dashboard
- Add `signet_expand_session(summary_id)` tool for agent mid-session
  drill-down into temporal history

### What This Enables

Desire paths gain a temporal dimension. The predictor can learn that
"when a query is about a recent refactor, traverse the last 3 session
summaries before walking entity aspects." Temporal sequence becomes a
learnable routing signal alongside the spatial entity graph.

The session DAG also enables the "what happened three sessions ago"
retrieval problem -- instead of searching flat memories, the agent
can walk the DAG from the current session backward through parent
links.


---


Pattern 5: On-Demand Expansion
------------------------------

### The Principle

Eager context assembly at session start handles the common case.
On-demand expansion handles the rest. The agent should be able to
drill deeper into any entity mid-session without the system having
to predict what it will need.

### The LCM Pattern

LCM provides `lcm_expand_query` -- a tool the agent calls
mid-session when it needs detail that was compacted away. The tool
spawns a scoped sub-agent that walks the DAG, finds the relevant
content, and returns a focused answer. The main agent's context is
not flooded; only the answer comes back.

### Current Signet Behavior

The agent can call `/api/memory/recall` for flat search mid-session.
This returns ranked memories by hybrid search. There is no
graph-aware expansion -- the agent cannot say "tell me everything
about entity X's auth aspect" and get a structured traversal result.

### The Adaptation

Add a `signet_expand_entity` tool available to agents mid-session.
The tool takes an entity name, optional aspect filter, and a natural
language question. It performs a focused graph traversal scoped to
that entity and returns a structured answer.

The tool does NOT spawn a sub-agent (simpler than LCM's approach).
It runs the existing graph traversal logic
(`packages/daemon/src/pipeline/graph-traversal.ts`) with the entity
as the sole focal entity and the aspect filter narrowing the walk.
The result is formatted as a structured context block with cited
aspect and attribute IDs.

The key constraint: expansion results are appended to the session
context, not injected at the system level. The agent requested them;
the agent sees them as a tool response. This prevents the "context
flooding" problem LCM solves with sub-agent isolation -- the agent
controls when and how much to expand.

### Implementation

- Add `/api/memory/expand` endpoint:
  ```
  POST /api/memory/expand
  {
    "entity": "predictive_scorer",
    "aspect": "cold_start_behavior",
    "question": "what are the training pair requirements?",
    "maxTokens": 2000
  }
  ```
- The endpoint calls `traverseKnowledgeGraph()` with the specified
  entity as sole focal entity, filters to the requested aspect (if
  provided), and returns the traversal result formatted as a context
  block
- Register as an MCP tool so agents with MCP access can call it
  directly
- Add to hook-generated CLAUDE.md/AGENTS.md as an available tool
- Token budget on the response prevents unbounded expansion

**Blast radius analysis (variant expansion):**

A specialized expansion pattern answers: "what would break if I changed this entity?" This is impact analysis — traversing upstream dependencies to find entities that depend on the focal entity.

```
POST /api/graph/impact
{
  "entityId": "signet",
  "direction": "upstream",
  "minConfidence": 0.7,
  "maxDepth": 3
}
```

Response groups by depth:
- **Depth 1 (WILL BREAK):** Direct dependents that will definitely break
- **Depth 2 (LIKELY AFFECTED):** Entities depending on depth-1 entities
- **Depth 3 (MAY NEED TESTING):** Transitive dependencies, lower certainty

Confidence filtering (`minConfidence: 0.7`) removes speculative edges from impact analysis, making predictions more reliable. Only edges the system is confident about contribute to the blast radius.

This pattern is adapted from GitNexus's impact analysis tool, where it answers "what functions call this function?" for code change planning. In Signet's domain, it answers "what entities rely on this entity?" for knowledge modification decisions.

### What This Enables

Desire paths' eager traversal at session start is the push path --
the system predicts what the agent needs. On-demand expansion is the
pull path -- the agent requests what it knows it needs. Together they
cover both the predictable and the unpredictable.

The explorer bees mechanism can also use expansion: when a
speculative traversal surfaces something interesting, the agent can
immediately expand on it without waiting for the next session start.


---


Implementation Sequence
-----------------------

These patterns are independent and can be implemented in any order.
The recommended sequence prioritizes the ones that reduce noise
(making desire paths' future learning signal cleaner):

1. **Three-Level Extraction Escalation** -- stops the bleeding on
   entity bloat. Immediate value, small scope.

2. **Zero-Cost Continuity** -- prevents noise sessions from entering
   the pipeline. Compounds with escalation.

3. **Lossless Retention** -- migration + retention worker change.
   Non-destructive decay is philosophically important but not urgent.

4. **On-Demand Expansion** -- new endpoint + MCP tool registration.
   Useful immediately, even before desire paths.

5. **Session Summary DAG** -- the most ambitious pattern. New tables,
   new condensation logic, new maintenance task. Worth doing but
   depends on the summary worker being solid.

Total estimated scope: each pattern is roughly 1-3 days of focused
work. The full set is a sprint, not a quarter.

---

*This document describes adaptations from LCM, not LCM itself.
Signet is a cross-session knowledge system; LCM is a within-session
context manager. The patterns transfer; the architecture does not.*

---

*Written by Nicholai and Mr. Claude. March 8, 2026.*
