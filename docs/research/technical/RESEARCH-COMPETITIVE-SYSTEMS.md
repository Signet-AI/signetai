---
title: "Competitive Systems Analysis: Project H, Project S, Project M"
question: "What retrieval, memory lifecycle, and integration patterns from competing agent memory systems should be adopted into Signet?"
informed_by:
  - "references/hermes-agent"
  - "references/supermemory"
  - "references/hindsight"
relevance:
  - desire-paths-epic
  - retroactive-supersession
  - predictive-memory-scorer
  - memory-pipeline-v2
---

Competitive Systems Analysis: Project H, Project S, Project M
==============================================================

*Retrieval, memory lifecycle, and integration patterns from three
production agent memory systems, cataloged for adoption into Signet.
Extends RESEARCH-REFERENCE-REPOS.md (Ori-Mnemos, Zikkaron) with
three additional systems.*

Reference: `references/hermes-agent/`, `references/supermemory/`,
`references/hindsight/` in the Signet monorepo.

---

## 1. System Profiles

### 1.1 Project H (Agent Runtime)

Python/JS, approximately 90+ tools, multi-platform gateway.

Project H is a tool-calling agent runtime with multi-platform reach.
Its memory system is secondary to its execution model, but it contains
several patterns worth noting.

**Architecture.** Tool-calling loop using OpenAI-spec function calls.
Multi-turn agent loop with automatic continuation until completion or
max_turns. Session persistence to SQLite for cross-restart continuity.
Centralized tool registry where each tool self-registers via module-level
calls, decoupling tool definition from the dispatch loop.

**Memory model.** Dual-layer persistence: local memory tools (save/update
durable facts, session search via FTS5 with LLM summarization) and an
optional external user modeling service that builds peer representations
(user + AI) over time via dialectic synthesis. Memory is injected into
every turn via system prompt. Skills auto-created after complex tasks
(5+ tool calls), forming a closed learning loop.

**Retrieval strategy.** No multi-signal fusion. Search is single-channel
(semantic or keyword). Smart model routing detects "simple" turns (short,
no code/tools/URLs) and routes to cheaper model. Context compression uses
three stages: prune old tool results (cheap, no LLM), protect head/tail
messages with token budgets, summarize middle via structured LLM prompt.

**Extraction pipeline.** Stateless prompt assembly with composable
components: identity, memory guidance, session search guidance, skills
guidance, platform hints, context file injection. Prompt injection
detection via regex patterns for hidden divs and exfiltration attempts.

**Integration surface.** Multi-provider (OpenAI, Anthropic, OpenRouter,
200+ models). Six terminal backends (local shell, Docker, SSH, Modal,
Daytona, Singularity). Gateway abstraction supporting Telegram, Discord,
Slack, WhatsApp, Signal, Email, Home Assistant. MCP bridge for external
tool servers.

**Unique capabilities.** Scheduled automations (natural language cron job
creation with output routing to any platform). Subagent parallelization
via delegate_task tool. RL-ready architecture with trajectory saving in
ShareGPT format for training data generation. Batch runner with
checkpointing for fault tolerance.

### 1.2 Project S (Memory API)

TypeScript, Cloudflare Workers, multi-framework SDK.

Project S is a hosted memory API and context engine. Not just RAG. It
provides automatic memory extraction, user profile generation, hybrid
search, and temporal logic (forgetting, contradiction resolution).

**Architecture.** Monorepo: web dashboard (Next.js on Cloudflare Workers),
MCP server (Hono + Durable Objects), browser extension (WXT), SDK packages
for multiple frameworks. Database via Drizzle ORM. Auth via better-auth
with org support.

**Memory model.** Two-tier: documents (raw content with processing pipeline)
and memory entries (extracted facts with version chains). Documents track
processing state machine: unknown, queued, extracting, chunking, embedding,
indexing, done, failed. Memory entries have version chains via
parentMemoryId/rootMemoryId/memoryRelations (updates/extends/derives) with
isLatest flag. Temporal forgetting via forgetAfter date with LLM-decided
forgetReason. Soft deletes via isForgotten flag.

**Retrieval strategy.** Hybrid search by default: both RAG (document chunks)
and memory entries in a single query. Dual thresholds: chunkThreshold +
documentThreshold for tuning precision (0=inclusive, 1=strict). Three search
modes: hybrid (default), memories-only, documents-only. Optional LLM-based
result filtering via shouldLLMFilter + custom filterPrompt.

**Extraction pipeline.** Automatic extraction with LLM during conversation.
Default mode "profile" extracts static user facts + dynamic recent activity.
Content hashing prevents duplicate processing. Multi-modal extraction: PDFs,
images (OCR), videos (transcription), code (AST-aware chunking).

**Integration surface.** Framework wrappers: Vercel AI SDK middleware
(withSupermemory wraps any model with memory injection), OpenAI SDK, Mastra,
LangChain, n8n. Python SDK for OpenAI, Pipecat, agent frameworks. MCP server
with OAuth2 support. Browser extension and Raycast extension.

**Unique capabilities.**

*Dual embedding storage.* Two embedding columns per table: current model +
previous model. Zero-downtime model upgrades by writing both during
migration, then swapping the query column. Eliminates stop-the-world
re-embedding events.

*Profile generation.* `/v3/profile` returns structured
`{ static: string[], dynamic: string[] }` in ~50ms. Auto-extracted from
memory, no manual prompting. Static = long-term facts. Dynamic = recent
activity. Connectors inject this into system prompts instead of dumping
entire memory context.

*Container tags.* Memories scoped to multiple contexts (user_123,
project_456) via container tags. Cleaner multi-tenant isolation than
org_id + user_id queries everywhere.

*Processing metadata.* Every pipeline step tracked with
`{ name, startTime, endTime, status, error, metadata }`. Full
observability into why a memory failed to process.

### 1.3 Project M (Biomimetic Memory)

Python, PostgreSQL-native, 157K LOC, Fortune 500 deployments.

Project M is a biomimetic agent memory system that organizes knowledge into
types mirroring human cognition. State-of-the-art on LongMemEval benchmark
(independently verified).

**Architecture.** PostgreSQL-only backend (deliberate commitment to single
database, no abstraction layer). FastAPI server (port 8888). Multi-tenant
via SQL schema isolation using contextvars. Memories organized into "banks"
(equivalent to agent profiles). Pluggable LLM providers (OpenAI, Anthropic,
Gemini, Groq, MiniMax, Ollama, LM Studio).

**Memory model.** Three fact types mirroring human cognition:
- World facts: general knowledge ("The stove gets hot")
- Experience facts: agent's own observations ("I touched the stove and it hurt")
- Opinions: synthesized knowledge with confidence scores (0-1)

Plus two higher-order types:
- Observations: auto-synthesized from raw facts by a background consolidation
  engine. Track proof_count and source_memory_ids. Temporal aggregation
  inherits date ranges from source facts.
- Mental models: user-pinned reflections (explicit queries stored for reuse).
  Refreshed on demand.

**Retrieval strategy (TEMPR).** Four parallel strategies fused with
Reciprocal Rank Fusion:

1. *Semantic search.* HNSW vector index via pgvector. Over-fetches by 5x to
   compensate for HNSW approximation.
2. *Keyword search (BM25).* PostgreSQL native tsvector + GIN indexes.
   Ensures proper names and exact terms match.
3. *Graph traversal.* Three pluggable strategies: MPFP (Multi-Path Fact
   Propagation, spreading activation with entity fan-out control), BFS
   (simple breadth-first), or LinkExpansion (follows explicit memory links).
4. *Temporal search.* Filters by event_date or occurred_start/occurred_end
   ranges.

RRF formula: `score(d) = sum(1 / (k + rank_i(d)))` where k = 60 (standard).
Results appearing in multiple strategies rank higher. Then cross-encoder
reranking (ms-marco-MiniLM-L-6-v2, ~80MB, ~80ms for 100 pairs on CPU)
produces final ranking.

Token budget retrieval: results returned by context token budget (maxTokens),
not fixed K count. Budget levels: low, mid, high.

**Extraction pipeline.** LLM extracts structured facts with schema: fact
text, fact_type (world/experience/opinion), occurred_start/occurred_end
(ISO datetime), entities with labels, causal_relations with strength scores.
Temporal inference falls back to regex patterns ("last night" = -1 day
offset) when LLM extraction fails. Entity resolution via trigram matching
+ string similarity (SequenceMatcher) with deduplication.

**Integration surface.** SDKs generated from OpenAPI spec in Python,
TypeScript, Rust, Go. LiteLLM integration wraps any completion() call with
automatic memory retrieval + injection + storage. Framework wrappers for
LangChain, LangGraph, CrewAI, Pydantic AI, AI SDK.

**Unique capabilities.**

*Consolidation engine.* Background worker synthesizes observations from
raw facts after every retain operation. Three actions: create new
observation, update existing with new evidence, delete outdated.
Observations track proof_count, source_memory_ids, and change history.
Consolidation metadata includes temporal aggregation from source facts.

*Disposition traits.* Per-bank configurable personality parameters
(skepticism, literalism, empathy, each 1-5) injected into reflect prompts.
Shapes how the LLM reasons over retrieved facts.

*Directives.* Per-bank mandatory rules injected at the top of every system
prompt regardless of entity scope. "Always verify facts before stating."
Reminder repeated before expecting response.

*Reflect agent.* Tool-calling loop with hierarchical retrieval: search
mental models first (highest quality), then observations (consolidated
knowledge), then raw facts (ground truth). Anti-hallucination enforcement:
"ONLY use information from tool results."

*Entity co-occurrence.* `entity_cooccurrences` table tracks which entities
appear together. MPFP uses co-occurrence counts to guide spreading
activation. Smarter than BFS, cheaper than full graph algorithms.

*Causal relations.* Facts can encode causal relationships to earlier facts
with strength scores (0.0-1.0) and relation_type. Target index prevents
cycles. Used by consolidation engine for synthesis.

---

## 2. Adoptable Capabilities

19 capabilities organized into four tiers by impact and integration
complexity. Each entry specifies the concept, integration contract,
documentation coverage, testing plan, and benchmark impact.

### Tier 1: High-Impact, Maps to Existing Roadmap

#### 2.1 Cross-Encoder Reranking

**Concept.** After multi-channel retrieval and fusion, candidates pass
through a neural cross-encoder that scores (query, candidate) pairs
jointly, capturing semantic interactions that bi-encoder cosine
similarity misses. Project M uses ms-marco-MiniLM-L-6-v2 (~80MB,
~80ms for 100 candidate pairs on CPU) as the final reranking stage
after 4-way RRF fusion. This is arguably the single largest contributor
to their state-of-the-art LongMemEval performance.

**Integration contract.**
- Maps to: DP-6 enhancement (new substory DP-6.4)
- Insertion point: `packages/daemon/src/memory-search.ts`, after Channel
  A/B fusion and DP-16 dampening
- Interface: `rerank(query: string, candidates: ScoredMemory[]): Promise<ScoredMemory[]>`
- Existing code: `packages/daemon/src/pipeline/reranker.ts` already
  provides a reranking interface. Extend with cross-encoder backend.
- Model hosting: ONNX Runtime via Bun FFI, or sidecar HTTP service
  (mirrors predictor Rust sidecar pattern)
- Invariant 5 compliance: cross-encoder can reorder but cannot filter
  out constraint-bearing results. Constraints injected after fusion,
  preserved through reranking.
- Config: `retrieval.crossEncoderEnabled` (default false),
  `retrieval.crossEncoderModel`, `retrieval.crossEncoderTopK` (max
  candidates to rerank, default 100)

**Documentation coverage.**
- Update `docs/PIPELINE.md`: reranking stage description
- Update `docs/API.md`: if exposed as search endpoint parameter
- Add to `docs/CONFIGURATION.md`: retrieval section

**Testing plan.**
- `reranker.test.ts`: cross-encoder produces different ordering than
  cosine similarity for known query/candidate pairs
- Constraint preservation: constraint-bearing results survive reranking
  regardless of score
- Integration: end-to-end search with cross-encoder produces higher
  MRR than without on LoCoMo fixture data
- Performance: reranking 100 candidates completes in <200ms

**Benchmark impact.**
- MRR improvement on LoCoMo 8-question suite (baseline: 0.615)
- Precision@5 improvement (baseline: 26.3%)
- A/B: same queries with/without cross-encoder

---

#### 2.2 Consolidation / Observation Synthesis

**Concept.** Background worker automatically synthesizes higher-order
"observations" from clusters of related raw facts. Three actions: create
new observation (from fact cluster), update existing observation (new
evidence found), delete stale observation (source facts superseded).
Each observation tracks proof_count, source_memory_ids, and a change
history. Observations sit above raw facts in a retrieval hierarchy:
mental models > observations > raw facts.

Project M runs consolidation after every retain operation. The
consolidation engine identifies clusters of facts sharing the same
entity and aspect, synthesizes them into concise observations via LLM,
and tracks provenance through source_memory_ids. Temporal aggregation
inherits date ranges from the earliest and latest source facts.

**Integration contract.**
- Maps to: DP-20 (Sleep Replay), enriches from random pair comparison
  to full consolidation engine
- New table: `observations` (id, content, entity_id, aspect_id,
  proof_count, source_memory_ids JSON, embedding, status, agent_id,
  created_at, updated_at)
- New file: `packages/daemon/src/pipeline/consolidation.ts`
- Trigger: idle timeout (DP-20 spec default 300s) or after extraction
- LLM call: runs OUTSIDE write transaction (transaction boundary rule)
- Retrieval hierarchy: `memory-search.ts` traversal checks observations
  FIRST, falls back to raw entity_attributes if no observation covers
  the aspect
- Invariant 1: agent_id on observations table
- Invariant 2: observations count toward entity structural density
- Entity constraints (kind='constraint') are never merged into
  observations, they stand alone

**Documentation coverage.**
- New section in `docs/PIPELINE.md`: "Consolidation Engine"
- Update `docs/ARCHITECTURE.md`: data flow diagram
- Update `docs/CONFIGURATION.md`: consolidation config
- Update `docs/specs/INDEX.md`: system graph (DP-20 enrichment)

**Testing plan.**
- `consolidation.test.ts`: 5 related facts about same entity/aspect
  produces 1 observation with proof_count=5
- Observation update: new fact in cluster updates existing observation
- Observation deletion: all source facts superseded marks observation stale
- Integration: observations appear in search results ahead of raw facts
- Agent scoping: agent A observations absent for agent B
- Edge case: constraints never merged into observations

**Benchmark impact.**
- Answer quality on LoCoMo (observations produce more coherent context)
- Context token efficiency (fewer, denser results)
- Time-to-first-observation after 10 sessions

---

#### 2.3 Multi-Strategy Parallel Retrieval

**Concept.** Four parallel retrieval strategies, each producing a
ranked list, fused via Reciprocal Rank Fusion (RRF):

1. Semantic search (vector similarity via embeddings)
2. Keyword search (BM25 via full-text indexing)
3. Graph traversal (entity-anchored walk)
4. Temporal search (date-range filtering)

RRF formula: `score(d) = sum(1 / (k + rank_i(d)))` where k=60.
Items appearing in multiple strategies rank higher (consensus signal).
Then cross-encoder reranking on top (see 2.1).

Project M parallelizes all four via asyncio.gather, fuses with RRF,
then reranks with cross-encoder.

**Integration contract.**
- Maps to: DP-6 extension (currently Channel A = traversal, Channel B
  = FTS5 flat search)
- Current code: `packages/daemon/src/memory-search.ts` has 2 channels
- Expand to 4 channels:
  - Channel A: Graph traversal (existing, `graph-traversal.ts`)
  - Channel B: FTS5 keyword search (existing but entity-scoped,
    needs memory-level FTS5 virtual table)
  - Channel C: Vector similarity (existing in `search.ts` but not
    as independent parallel path)
  - Channel D: Temporal search (NEW, filter by session timestamps,
    memory created_at ranges)
- New file: `packages/daemon/src/pipeline/rrf-fusion.ts`
- New file: `packages/daemon/src/pipeline/temporal-search.ts`
- Budget split: existing 40% minimum for flat candidates (Channel B)
  applies to Channels B+C+D combined. Channel A retains primary status.
- Invariant 5: constraints surface regardless of RRF rank
- Invariant 1: all channels filter by agent_id
- DP-3: timeout applies to all channels collectively
- DP-16: dampening runs after fusion, before cross-encoder

Dependency chain:
```
Channel A (traversal) --+
Channel B (FTS5)      --+--> RRF Fusion --> DP-16 --> Cross-Encoder --> Final
Channel C (vector)    --+
Channel D (temporal)  --+
```

**Documentation coverage.**
- Rewrite retrieval section in `docs/PIPELINE.md`
- Update `docs/ARCHITECTURE.md`: 4-channel diagram
- Add RRF explanation to `docs/KNOWLEDGE-ARCHITECTURE.md`

**Testing plan.**
- `rrf-fusion.test.ts`: RRF correctly merges 4 ranked lists, items in
  multiple lists rank higher
- RRF with k=60 produces expected scores for known rank inputs
- Temporal search returns memories within date range
- Integration: 4-channel search produces higher recall than 2-channel
- Constraint preservation through RRF
- Performance: 4-channel parallel search completes in <500ms

**Benchmark impact.**
- Hit@10 on temporal questions (need larger temporal question set)
- Recall on multi-hop questions (stress test beyond current 4/4)
- MRR improvement from RRF vs simple concatenation

---

#### 2.4 Entity Co-occurrence Tracking

**Concept.** Track which entities appear together in the same memory or
retrieval session. Co-occurrence counts guide graph traversal: entities
frequently seen together are more likely relevant when one is focal.
Project M uses an entity_cooccurrences table. Ori-Mnemos (already in
RESEARCH-REFERENCE-REPOS.md) uses NPMI normalization.

**Integration contract.**
- Maps to: DP-9 (path feedback propagation) enhancement
- Existing: `entity_dependencies` has strength + confidence but no
  co-occurrence count. Inline entity linker already creates related_to
  edges for entities in the same memory.
- Change: add `cooccurrence_count INTEGER DEFAULT 0` column to
  `entity_dependencies`. Increment on co-mention in same memory at
  extraction time and co-retrieval in same search result set.
- Traversal: `graph-traversal.ts` uses confidence * strength for edge
  filtering. Add cooccurrence_count as multiplier or tiebreaker.
- NPMI normalization (from Ori-Mnemos):
  `NPMI(a,b) = log(P(a,b) / (P(a)*P(b))) / -log(P(a,b))`
  Prevents high-frequency entities from inflating co-occurrence.
- Per-entity homeostasis cap (from Ori-Mnemos): prevents hub entities
  from accumulating unbounded co-occurrence weight.
- Migration: add column to entity_dependencies table

**Documentation coverage.**
- Update `docs/KNOWLEDGE-ARCHITECTURE.md`: co-occurrence section
- Update DP-9 spec with co-occurrence tracking details

**Testing plan.**
- Co-occurrence increments on co-mention in same memory
- Co-occurrence increments on co-retrieval in same search result
- NPMI normalization produces expected values for known distributions
- Homeostasis cap prevents any entity from exceeding max weight
- Traversal follows high-co-occurrence edges preferentially

**Benchmark impact.**
- Traversal path quality (do high-co-occurrence paths lead to relevant results?)
- False positive rate on suggested edges

---

### Tier 2: Novel Capabilities (New Specs Needed)

#### 2.5 Temporal Forgetting

**Concept.** Memories carry an optional forget_after timestamp and
forget_reason string. When the timestamp passes, the memory is
soft-deleted (forgotten_at set, content preserved for audit). The LLM
extraction step detects temporal bounds during fact extraction: "I have
an exam tomorrow" produces forget_after = tomorrow + 1 day.

Project S implements this with forgetAfter date, isForgotten boolean,
and forgetReason string fields.

**Integration contract.**
- Maps to: NEW spec (memory-lifecycle) or enrichment of
  retroactive-supersession
- Migration: add to memories table:
  - `forget_after INTEGER` (unix timestamp, nullable)
  - `forgotten_at INTEGER` (unix timestamp, nullable)
  - `forget_reason TEXT` (nullable)
- Extraction: add temporal bound detection to extraction prompt in
  `packages/daemon/src/pipeline/worker.ts`
- Background sweep: new maintenance task checks
  `WHERE forget_after IS NOT NULL AND forget_after < now()
  AND forgotten_at IS NULL`, sets forgotten_at = now()
- Search: add `WHERE forgotten_at IS NULL` to all memory queries
  in search.ts and memory-search.ts
- Entity pruning: forgotten memories reduce entity mention counts
- Invariant 5: constraints NEVER auto-forgotten
- Agent-scoped, lossless (soft delete preserves rows)
- Config: `memory.temporalForgetEnabled` (default true),
  `memory.forgetGracePeriodDays` (default 1)

**Documentation coverage.**
- New section in `docs/PIPELINE.md`: "Temporal Memory Lifecycle"
- Update `docs/CONFIGURATION.md`
- Update `docs/API.md`: forgotten memories excluded from search

**Testing plan.**
- Extraction detects temporal bounds ("meeting tomorrow" = forget_after
  tomorrow + 1 day)
- Sweep marks expired memories as forgotten
- Forgotten memories excluded from search results
- Constraints never auto-forgotten
- Protected memories skip sweep
- Integration: create memory with temporal bound, advance time, verify
- Edge case: forget_after in the past at creation time

**Benchmark impact.**
- Entity count reduction after 30 days of forgetting
- Search precision improvement (fewer stale results)

---

#### 2.6 Memory Version Chains

**Concept.** Memories form directed acyclic graphs where updates,
extensions, and derivations are tracked as explicit relationships.
Each memory has optional parent_id (what it supersedes), root_id
(original in the chain), and relation_type (supersedes/extends/derives).
An is_latest flag marks the current version.

Project S implements this with parentMemoryId, rootMemoryId,
memoryRelations, isLatest, and version fields.

**Integration contract.**
- Maps to: enrichment of retroactive-supersession spec
- Supersession spec already has entity_attributes.superseded_by for
  attribute-level tracking. Memory version chains add memory-level
  lineage.
- Migration: add to memories table:
  - `parent_id INTEGER REFERENCES memories(id)` (nullable)
  - `root_id INTEGER REFERENCES memories(id)` (nullable)
  - `relation_type TEXT` (nullable: supersedes, extends, derives)
  - `is_latest INTEGER DEFAULT 1`
- When supersession marks an attribute as superseded, also set source
  memory is_latest = 0 and link new memory as parent_id.
- Search: prefer is_latest = 1 memories. Old versions via expansion
  endpoint for history.
- API: `/api/memory/{id}/history` returns version chain
- Agent-scoped. Version chains don't cross agent boundaries.

**Documentation coverage.**
- Update retroactive supersession spec with memory-level lineage
- Add to `docs/API.md`: version history endpoint
- Update `docs/PIPELINE.md`: version chain creation during supersession

**Testing plan.**
- Creating a superseding memory sets parent_id and updates is_latest
- root_id traces back to original in chain
- Search prefers is_latest=1 memories
- /api/memory/{id}/history returns complete chain
- Supersession + version chain work together

**Benchmark impact.**
- Knowledge update accuracy on LongMemEval
- History traversal completeness

---

#### 2.7 Dual Embedding Storage

**Concept.** Store two embedding vectors per memory: current model and
previous model. During model migration, write both embeddings on new
memories and backfill old memories incrementally. Search uses the current
model's embedding. Once migration completes, drop the old column.

Project S implements this with embedding + embeddingModel (current) and
embeddingOld + embeddingModelOld (previous) columns per table.

**Integration contract.**
- Maps to: NEW spec (embedding-migration-infrastructure)
- Migration: add to embeddings table:
  - `embedding_v2 BLOB` (nullable)
  - `embedding_model_v2 TEXT` (nullable)
- Migration worker: background job re-embeds memories with new model,
  writing to embedding_v2. Progress tracked via
  embedding_model_v2 IS NOT NULL.
- Search: use embedding_v2 when populated, fallback to embedding
- Completion: swap columns via migration (DROP old, RENAME new)
- Native accelerators: @signet/native SIMD ops handle both columns

**Documentation coverage.**
- New section in `docs/ARCHITECTURE.md`: "Embedding Model Migration"
- Runbook: step-by-step migration procedure

**Testing plan.**
- New memories get both embeddings during migration period
- Search uses v2 when available, falls back to v1
- Migration progress tracking (count migrated vs total)
- Integration: full migration cycle (add, backfill, swap, drop)
- Performance: backfill rate (memories per second)

**Benchmark impact.**
- Migration downtime (target: zero)
- Search quality continuity during migration (no regression)

---

#### 2.8 Profile Generation API

**Concept.** Daemon endpoint returns structured user/agent profile split
into static facts (long-term: "Senior engineer", "Prefers vim") and
dynamic context (recent: "Working on auth migration"). ~50ms latency.
Auto-extracted from entity graph.

Project S implements `/v3/profile` returning
`{ static: string[], dynamic: string[] }`.

**Integration contract.**
- Maps to: NEW daemon endpoint, enhances harness connector context
  injection
- New endpoint: `GET /api/profile?agentId=default`
- Implementation in daemon:
  - Static: query entity_attributes for person-type entities matching
    user, return high-stability attributes (old, many mentions,
    never superseded)
  - Dynamic: query recent session summaries + recent memory extractions
    (last 24h)
- Response: `{ static: string[], dynamic: string[], generated_at: string }`
- Harness integration: connectors inject profile instead of full
  MEMORY.md
- Cache: 5 minutes, invalidated on new memory write

**Documentation coverage.**
- Add to `docs/API.md`: profile endpoint
- Update connector docs with profile injection option
- Update `docs/CONFIGURATION.md`: profile cache TTL

**Testing plan.**
- Profile extracts static facts from entity graph
- Profile includes recent session summaries as dynamic
- Profile respects agent_id scoping
- Integration: endpoint responds in <100ms
- Harness connector uses profile in system prompt

**Benchmark impact.**
- Context injection token count reduction (profile vs full MEMORY.md)
- Retrieval quality with profile vs MEMORY.md as context

---

#### 2.9 Disposition Traits

**Concept.** Per-agent configurable numeric traits (skepticism,
creativity, precision, each 1-5) injected into extraction and recall
prompts. Shapes how the LLM reasons over retrieved facts.

Project M implements per-bank skepticism, literalism, empathy traits.

**Integration contract.**
- Maps to: agent.yaml extension, extraction prompt enhancement
- Config: add optional disposition object to agent manifest:
  ```yaml
  disposition:
    skepticism: 3
    creativity: 4
    precision: 5
  ```
- Injection: extraction prompt in worker.ts and recall prompt in
  memory-search.ts include traits when configured
- Validation: values 1-5, optional

**Documentation coverage.**
- Update `docs/CONFIGURATION.md`: disposition traits
- Update `docs/HARNESSES.md`: how traits affect behavior

**Testing plan.**
- Traits parsed from agent.yaml
- Extraction prompt includes traits when configured
- Recall prompt includes traits when configured
- Invalid values (0, 6, negative) rejected

**Benchmark impact.**
- Qualitative A/B test on extraction quality with different profiles

---

#### 2.10 Directives / Hard Rules

**Concept.** Global rules injected at the top of every system prompt,
regardless of entity scope. "Always verify facts." "Never reveal
internal names." Mandatory constraints that override all reasoning.

Project M implements per-bank directives stored in a directives table.

**Integration contract.**
- Maps to: agent.yaml extension, system prompt enhancement
- Config: add directives array to agent manifest:
  ```yaml
  directives:
    - "Never reveal API keys in memory extractions"
    - "Always preserve user terminology"
  ```
- Injection: every prompt (extraction, recall, consolidation) starts
  with directives block. Separate from entity constraints (structural).
- Invariants: directives cannot override cross-cutting invariants

**Documentation coverage.**
- Update `docs/CONFIGURATION.md`: directives section
- Update `docs/PIPELINE.md`: directive injection in prompts

**Testing plan.**
- Directives parsed from agent.yaml
- Directives injected into extraction and recall prompts
- Integration: directive "never extract X" prevents extraction of X

**Benchmark impact.**
- Qualitative: extraction compliance with directives

---

### Tier 3: Architectural Patterns

#### 2.11 Token Budget Retrieval

Return results by context token budget, not fixed K count. Modify
searchMemories() in memory-search.ts to accept maxTokens parameter.
Fill results from ranked list until budget exhausted. Requires token
counting utility (tiktoken or character estimation). More agent-centric
since it respects context window size.

#### 2.12 Pipeline Observability

Track every pipeline step with timestamps, status, and errors. Add
processing_metadata JSON column to memory_jobs table. Each stage
(extraction, decision, structural-classify, embedding) records
start/end/status/error. Surface via /api/diagnostics/pipeline endpoint.
Valuable for debugging failed extractions.

#### 2.13 Content Hashing for Dedup -- ALREADY IMPLEMENTED

Signet already has content_hash (TEXT, SHA-256) on the memories table
(migration 002) with a scope-aware unique index
(`idx_memories_content_hash_unique`). Dedup check runs in
`normalizeAndHashContent()` in worker.ts before insert. If hash exists
and is_deleted=0, the write is skipped and access_count incremented on
the existing memory. No action needed. Project S implements the same
pattern with their contentHash field.

#### 2.14 Smart Model Routing

Route simple turns to cheaper extraction model. Classify input
complexity before LLM call. Simple (short, no code, no tools): cheaper
model. Complex: primary model. Project H detects "simple" turns via
max_simple_chars (160) and max_simple_words (28). Config:
pipeline.smartRoutingEnabled, pipeline.cheapModel.

#### 2.15 Framework Wrappers

Plug-and-play memory injection for popular frameworks. New packages:
@signet/vercel-ai, @signet/langchain, @signet/litellm. Each wraps
Signet daemon API calls into framework-specific tool/middleware.
Pattern: intercept user message, search Signet, inject results into
system prompt, optionally save response. Project S has Vercel/Mastra/
LangChain/n8n wrappers. Project M has LiteLLM integration (2-line
adoption via wrapping completion() calls).

---

### Tier 4: Lower Priority

#### 2.16 Gateway / Multi-Platform Abstraction

Project H provides a single agent instance reachable from Telegram,
Discord, Slack, WhatsApp, Signal, Email, Home Assistant. Platform
auto-detected in system prompt via SessionContext injection. Cross-
platform session continuity. Revisit post-runtime when Signet Runtime
is operational.

#### 2.17 Cron Delivery Routing

Project H supports natural language cron job creation with output
routing to specific platforms/channels via DeliveryRouter. Jobs stored
in JSON, outputs saved as markdown. Revisit alongside gateway work.

#### 2.18 RL-Ready Trajectory Generation

Project H saves conversations in ShareGPT format for training data.
Trajectory compression for efficient storage. Benchmark environments
for RL training. Long-term valuable for training personalized models.
Revisit post-predictor when training pipeline is proven.

#### 2.19 Dialectic User Modeling

Project H integrates with an external user modeling service that builds
user and AI peer representations over time via dialectic synthesis
(semantic search, structured profiles, LLM-powered Q&A). Session keys
map to platform identity. Per-host settings and linked hosts. Revisit
post-DP-14 (discovered principles) when entity graph reaches sufficient
sophistication.

---

## 3. Cross-Reference Table

| Pattern | Project H | Project S | Project M | Signet Equivalent | Gap | Priority |
|---------|-----------|-----------|-----------|-------------------|-----|----------|
| Multi-signal fusion | -- | Hybrid (RAG+memory) | 4-signal TEMPR + RRF | Channel A/B (2-signal) | Add BM25 + temporal channels | HIGH |
| Cross-encoder reranking | -- | -- | ms-marco-MiniLM | Cosine re-scoring (DP-6.2) | Add neural reranker | HIGH |
| Consolidation | -- | -- | Background synthesis | DP-20 sleep replay (not started) | Enrich DP-20 | HIGH |
| Co-occurrence tracking | -- | -- | entity_cooccurrences + MPFP | entity_dependencies (static) | Add co-occurrence count | HIGH |
| Temporal forgetting | -- | forgetAfter + isForgotten | -- | Retention decay (score-based) | Add explicit expiry | MEDIUM |
| Memory version chains | -- | parentMemoryId + DAG | -- | memory_history (audit only) | Add lineage DAG | MEDIUM |
| Dual embeddings | -- | old+new embedding columns | -- | Single embedding column | Add migration infra | MEDIUM |
| Profile generation | -- | /v3/profile (static+dynamic) | -- | MEMORY.md (manual) | Add structured endpoint | MEDIUM |
| Disposition traits | -- | -- | Per-bank personality | SOUL.md (unstructured) | Add numeric traits | LOW |
| Directives | -- | -- | Per-bank mandatory rules | Entity constraints (scoped) | Add global rules | LOW |
| Token budget retrieval | -- | -- | maxTokens parameter | limit (count-based) | Add token budget | LOW |
| Pipeline observability | -- | Processing metadata | Async operation tracking | memory_jobs status | Add step-level tracking | LOW |
| Content hashing | -- | contentHash dedup | -- | None | Add hash dedup | LOW |
| Smart model routing | Cheap/strong routing | -- | Per-op LLM config | Single extraction model | Add routing | LOW |
| Framework wrappers | -- | Vercel/Mastra/n8n | LiteLLM/OpenAI | SDK (raw API) | Add wrappers | LOW |
| Gateway abstraction | Multi-platform | -- | -- | Per-harness connectors | Revisit post-runtime | DEFER |
| Cron delivery routing | Platform-routed outputs | -- | -- | Cron (limited routing) | Revisit with gateway | DEFER |
| RL trajectories | ShareGPT saving | -- | -- | None | Revisit post-predictor | DEFER |
| Dialectic modeling | Honcho peer reps | -- | -- | Entity graph | Revisit post-DP-14 | DEFER |

---

## 4. Integration Contracts

### Contract 1: Retrieval Pipeline Extension

**Parties.** memory-search.ts, rrf-fusion.ts (new), temporal-search.ts
(new), reranker.ts, dampening.ts

**Interface.**
```typescript
type RetrievalChannel = {
  name: string
  search(query: string, opts: SearchOpts): Promise<RankedResult[]>
}

type RankedResult = {
  memoryId: number
  score: number
  rank: number
  channel: string
}

function rrfFuse(channels: RankedResult[][], k?: number): RankedResult[]
function crossEncoderRerank(query: string, candidates: RankedResult[]): Promise<RankedResult[]>
```

**Invariant compliance.**
- Invariant 1 (agent scoping): all channels filter by agent_id
- Invariant 5 (constraints surface): constraint results injected after
  fusion, before reranking. Reranker reorders but cannot remove them.
- DP-3 (bounded traversal): timeout applies to all channels collectively
- DP-16 (dampening): runs after fusion, before cross-encoder

**Pipeline.**
```
Channel A (traversal) --+
Channel B (FTS5)      --+--> RRF Fusion --> DP-16 --> Cross-Encoder --> Final
Channel C (vector)    --+
Channel D (temporal)  --+
```

### Contract 2: Memory Lifecycle Extension

**Parties.** memories table, maintenance-worker.ts, memory-search.ts,
inline-entity-linker.ts

**Interface.**
```typescript
type MemoryLifecycle = {
  forget_after: number | null
  forgotten_at: number | null
  forget_reason: string | null
  parent_id: number | null
  root_id: number | null
  relation_type: 'supersedes' | 'extends' | 'derives' | null
  is_latest: number
  content_hash: string | null
}
```

**Invariant compliance.**
- Constraints never auto-forgotten
- Superseded attribute propagation triggers version chain update
- Content hashing runs before write transaction (idempotent)

### Contract 3: Consolidation Engine

**Parties.** consolidation.ts (new), observations table (new),
memory-search.ts, maintenance-worker.ts

**Interface.**
```typescript
type Observation = {
  id: number
  content: string
  entity_id: number
  aspect_id: number
  proof_count: number
  source_memory_ids: number[]
  embedding: Float32Array
  status: 'active' | 'stale' | 'superseded'
  agent_id: string
}

function consolidate(entityId: number, aspectId: number): Promise<Observation | null>
function refreshObservation(obsId: number, evidence: Memory[]): Promise<void>
```

**Invariant compliance.**
- Agent-scoped (invariant 1)
- Observations contribute to structural density (invariant 2)
- No LLM calls inside write transactions
- Constraints never merged into observations

---

## 5. Testing Suite

### 5.1 Retrieval Tests

Location: `packages/daemon/src/__tests__/retrieval/`

| Test File | Coverage |
|-----------|----------|
| `rrf-fusion.test.ts` | RRF algorithm, k parameter, empty channels, single result |
| `temporal-search.test.ts` | Date range queries, temporal markers, timezone handling |
| `cross-encoder.test.ts` | Model loading, scoring interface, constraint preservation |
| `4-channel-integration.test.ts` | End-to-end 4-channel, parallelism, timeout |

**Fixtures.** LoCoMo 8-question dataset as JSON. 50-question dataset for
full regression. 10 synthetic temporal queries with date ranges.

### 5.2 Memory Lifecycle Tests

Location: `packages/daemon/src/__tests__/lifecycle/`

| Test File | Coverage |
|-----------|----------|
| `temporal-forget.test.ts` | Forget detection, sweep, constraint protection, grace period |
| `version-chains.test.ts` | Parent/root linking, is_latest management, history |
| `content-dedup.test.ts` | Hash computation, duplicate detection, merge |
| `lifecycle-integration.test.ts` | Full lifecycle: create, forget, supersede, chain |

**Fixtures.** 20 synthetic memories with temporal bounds. 10 memory
update chains.

### 5.3 Consolidation Tests

Location: `packages/daemon/src/__tests__/consolidation/`

| Test File | Coverage |
|-----------|----------|
| `consolidation.test.ts` | Observation creation, update, deletion, proof tracking |
| `hierarchy.test.ts` | Retrieval hierarchy (observations before raw facts) |
| `consolidation-integration.test.ts` | End-to-end: ingest, idle, consolidate, search |

**Fixtures.** 50 synthetic facts across 5 entities, each with 3 aspects.

### 5.4 Profile and Config Tests

Location: `packages/daemon/src/__tests__/`

| Test File | Coverage |
|-----------|----------|
| `profile.test.ts` | Static extraction, dynamic extraction, cache |
| `disposition.test.ts` | Trait parsing, validation, prompt injection |
| `directives.test.ts` | Directive parsing, prompt injection, invariant compliance |

### Test Infrastructure

All tests use Signet's existing patterns (Bun test runner, bunfig.toml).
Test database: in-memory SQLite with migrations applied. LLM mocking:
mock extraction responses for deterministic tests. Benchmark fixtures
checked into `packages/daemon/src/__tests__/fixtures/`.

---

## 6. Benchmarking Methodology

### 6.1 Retrieval Quality

**Suite.** Extended LoCoMo (50 questions + 10 synthetic temporal).

| Metric | Baseline | Target | Measurement |
|--------|----------|--------|-------------|
| Accuracy | 87.5% (8Q) | 90%+ (60Q) | Correct answer / total questions |
| Hit@10 | 100% | 100% | Correct document in top 10 |
| MRR | 0.615 | 0.75+ | Mean reciprocal rank |
| Precision@5 | 26.3% | 40%+ | Relevant results in top 5 |
| NDCG@10 | 0.639 | 0.75+ | Normalized discounted cumulative gain |

**A/B test matrix.**

| Config | Description |
|--------|-------------|
| Baseline | 2-channel, cosine re-scoring, dampening |
| +BM25 | Add keyword channel |
| +Temporal | Add temporal channel |
| +RRF | Replace concatenation with RRF fusion |
| +CrossEncoder | Add cross-encoder reranking |
| +Consolidation | Add observation layer |
| Full Stack | All improvements enabled |

**Procedure.**
1. Run each config against LoCoMo 60-question set
2. Record per-question: retrieved IDs, scores, ranks, timing
3. Compute metrics per config
4. Statistical significance: paired t-test on per-question MRR
5. Ablation: disable each improvement individually

### 6.2 Memory Lifecycle

**Suite.** Synthetic 30-day memory lifecycle simulation.

| Metric | Description |
|--------|-------------|
| Entity count | After temporal forgetting + pruning |
| Memory count (active) | After forgetting sweep |
| Search precision | Relevant / total after lifecycle |
| Stale result rate | Superseded/forgotten in top-10 |

### 6.3 Consolidation

**Suite.** 100 memories across 10 entities, 5 aspects each.

| Metric | Description |
|--------|-------------|
| Observation coverage | % aspects with observations |
| Proof completeness | Average source facts per observation |
| Token efficiency | Tokens in observations vs raw facts |
| Observation accuracy | LLM-judge rating of quality |

### 6.4 Performance

**Suite.** Latency under load.

| Operation | Current | Target |
|-----------|---------|--------|
| 2-channel search | ~150ms | -- |
| 4-channel search | -- | <500ms |
| Cross-encoder rerank (100) | -- | <200ms |
| Profile generation | -- | <100ms |
| Consolidation (per entity) | -- | <2000ms |
| Temporal sweep (1000) | -- | <500ms |

### 6.5 Infrastructure

Port 3851 (isolated benchmark daemon, per existing convention).
Separate SQLite database (never pollute production). Reproducible:
dataSourceRunId pinned for consistent data. CI-compatible: JSON output,
automated comparison against baseline. Location:
`packages/daemon/src/__tests__/benchmarks/`.

---

## 7. Recommended Adoption Sequence

**Immediate (fold into Wave 6 Phase 4 work).**
1. Entity co-occurrence tracking (small lift, improves DP-9)
2. Content hashing on ingestion (prevents memory bloat)

**Near-term (enrich existing specs).**
3. Cross-encoder reranking (new DP story DP-6.4)
4. BM25 + temporal as parallel channels (TEMPR pattern)
5. Consolidation engine design (enriches DP-20)

**Medium-term (new specs needed).**
6. Temporal forgetting (forget_after on memories)
7. Memory version chains (enriches retroactive supersession)
8. Profile generation endpoint
9. Dual embedding storage for model migrations

**Longer-term (backlog).**
10. Disposition traits and directives in agent.yaml
11. Token budget retrieval
12. Pipeline observability
13. Smart model routing
14. Framework wrappers
