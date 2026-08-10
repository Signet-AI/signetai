---
title: "Pipeline and storage"
description: "Pipeline, queue, graph, document, and database architecture."
---

## Pipeline V2

The memory pipeline lives at `platform/daemon/src/pipeline/`. It
processes memories asynchronously through a job queue, using an LLM
for extraction and a second LLM pass for decision-making. The key
architectural constraint is the transaction boundary rule: no LLM
calls inside write locks. Embeddings and LLM completions are always
fetched before `withWriteTx` is entered.

**Extraction stage** (`extraction.ts`): given raw memory content,
prompts the LLM to return a JSON object with `facts` and `entities`
arrays. Facts carry a type (`fact`, `preference`, `decision`,
`procedural`, `semantic`) and a confidence score. Entities carry
source, relationship, target, and confidence. Output is strictly
validated — malformed fields produce warnings but do not fail the
job. Input is capped at 12,000 characters; facts are capped at 20
per call, entities at 50. The extractor strips `<think>` blocks from
chain-of-thought models (qwen3, etc.) before parsing.

**Decision stage** (`decision.ts`): for each extracted fact, a
focused hybrid search retrieves up to 5 candidate memories. If no
candidates exist, the system proposes an `add` action immediately.
Otherwise it sends a second LLM prompt with the fact and candidates
and parses an action (`add`, `update`, `delete`, `none`) with a
target memory ID and confidence. `update` and `delete` decisions must
reference a valid candidate ID or they are rejected. Decision results
are called "shadow decisions" because they are always proposals first.

**Controlled writes** (`worker.ts`, `applyPhaseCWrites`): when
`enabled && !shadowMode && !mutationsFrozen`, the worker enters
controlled-write mode. For each `add` proposal, the worker checks
confidence against `minFactConfidenceForWrite`, normalizes and hashes
the content, checks for an existing memory with the same hash, and
inserts via `txIngestEnvelope`. `update` and `delete` proposals are
blocked unless `autonomous.allowUpdateDelete` is true. When enabled,
updates go through `txModifyMemory`, deletes go through `txForgetMemory`,
and the previous target state is archived to the cold tier first. Pinned
memories are not deleted without force. Contradiction detection can still
block high-risk update proposals and record them for review.

**Inline entity linking** (`inline-entity-linker.ts`): runs
synchronously at write time inside `withWriteTx`, before any async
pipeline work. It extracts candidate proper nouns from memory
content and links the memory to entities that already exist for the same
`agent_id` by writing `memory_entity_mentions` rows. It does not create
entities, aspects, attributes, or dependency edges from raw text. Structured
remember payloads, explicit user/agent actions, and reviewed repair passes
own semantic graph authorship. The async pipeline still runs later for
extraction, decisions, and optional graph persistence.

**Hints worker** (`prospective-index.ts`): generates hypothetical
future queries ("hints") for each memory at write time. For each new
memory, it prompts the LLM for diverse questions a user might ask
when the fact would be helpful. Hints are indexed in `memories_fts`
so search can match memories by anticipated cue — bridging the
semantic gap between stored facts and natural-language queries.
Gated on `hints.enabled` in pipeline config.

**Graph persistence** happens in a separate transaction after fact
writes complete. A failure here is non-fatal — it logs a warning and
does not revert the extracted memories.

**Lossless transcripts**: Signet stores the cleaned conversation transcript as
JSONL under `$SIGNET_WORKSPACE/memory/{harness}/transcripts/transcript.jsonl`
and keeps `session_transcripts` (migration 040) as a compatibility/indexing
surface alongside extracted memories. Tool calls, tool outputs, and thinking
traces are kept out of this memory surface so retrieval and summarization
operate on the human/agent exchange. Raw auditable traces may still be written
to daemon logs outside the memory lineage. The recall endpoint's `expand: true`
flag joins transcript content back into search results via `source_id`.

**Shadow mode**: when `shadowMode = true`, all proposals are logged
to `memory_history` under the `pipeline-shadow` actor but no
memories are written. This lets operators observe what the pipeline
would do before enabling writes.

**Configuration flags**:

| Flag | Effect |
|------|--------|
| `enabled` | Master pipeline switch |
| `shadowMode` | Extract and propose, never write |
| `mutationsFrozen` | Reads only; pipeline stays quiet |
| `graph.enabled` | Enable graph reads, traversal, and recall boosting |
| `autonomous.enabled` | Allow scheduled maintenance and repair |
| `autonomous.frozen` | Hard stop on autonomous maintenance actions |
| `hints.enabled` | Run prospective hint generation at write time |
| `autonomous.maintenanceMode` | `observe` or `execute` for maintenance worker |

---

## Job Queue

The job queue is backed by the `memory_jobs` table. This makes it
durable — jobs survive daemon restarts. The queue supports two job
types: `extract` (memory pipeline) and `document_ingest` (document
worker). Both types use the same lease/complete/fail mechanics.

A job's lifecycle is: `pending` → `leased` → `completed` or
`failed` → (on max retries) `dead`.

**Enqueue**: callers insert a row with `status = 'pending'`, `attempts
= 0`, and a `max_attempts` (default 3). Duplicate jobs for the same
target (same memory_id + job_type with pending/leased status) are
silently dropped.

**Lease**: the worker calls `leaseJob` inside `withWriteTx`. It
selects the oldest pending job with `attempts < max_attempts`, then
updates `status = 'leased'`, increments `attempts`, and records
`leased_at`. This is atomic — no two workers can lease the same job.

**Failure and retry**: on error, the worker calls `failJob`. If
`attempts < max_attempts`, the job goes back to `pending`. On the
final attempt it transitions to `dead` (dead-letter state).

**Backoff**: the worker uses exponential backoff on consecutive
failures. The delay is `min(BASE_DELAY * 2^n, MAX_DELAY)` plus up
to 500ms of jitter. The base delay is 1 second; the cap is 30 seconds.

**Stale lease reaper**: a separate `setInterval` (every 60 seconds)
calls `reapStaleLeases`, which resets `leased` jobs whose `leased_at`
is older than `leaseTimeoutMs` back to `pending`. This handles the
case where a worker crashes mid-job without completing or failing it.

**Dead-letter**: jobs with `status = 'dead'` stay in the table until
the retention worker purges them (default: 30 days after `failed_at`).
The repair action `requeueDeadJobs` can reset them to `pending` with
`attempts = 0` to force a retry.

---

## Knowledge Graph

The knowledge graph stores entities and relations extracted from
memories. It is an augmentation layer — search still works without it,
and graph persistence errors never revert fact extraction.

**Tables**: `entities` stores named entities with a `canonical_name`
(lowercased, for lookups), a `mentions` count, and an optional
embedding. `relations` stores typed edges between entity pairs with
a `strength`, a `mentions` count (incremented on each re-extraction),
and a `confidence`. `memory_entity_mentions` is a junction table
linking memories to the entities they mention, with optional
`mention_text` and `confidence` provenance fields.

**Graph extraction**: semantic graph authorship flows through the audited
ontology apply path. The retired `txPersistEntities` / inline LLM extraction
chain (`extractFactsAndEntities`) was removed under the Dreaming cutover
(#946); the only retained write closure is `txDecrementEntityMentions`, used
by the retention worker to decrement mention counts and delete orphaned
entities (plus dangling relations) after a memory purge. Entities and
relations are still upserted by canonical name and (source, target, type)
triplet respectively by the retained audited writers; mention links are
stored in `memory_entity_mentions`.

**Traversal-primary search** (`memory-search.ts`,
`graph-traversal.ts`): when `traversal.primary` is enabled (the
default when both `graph.enabled` and `traversal.enabled` are true),
graph traversal is the primary candidate-building path. It resolves
focal entities from query tokens, traverses the knowledge graph through
aspects, attributes, and dependency hops, and produces a scored
candidate pool blended with cosine similarity (70% cosine, 30%
structural importance). Flat FTS5/vector search fills remaining
slots — at least 40% of the result budget is reserved for flat
candidates so hub entities cannot exclude keyword/vector matches
entirely. After merging, structured evidence shaping keeps lexical,
semantic, prospective hint, and traversal evidence as separate channels.
Traversal-only candidates are capped below directly anchored evidence,
while exact prospective hints can rescue memories whose stored text uses
a specific instance rather than the user's query class. When traversal
is disabled or the graph has no matching entities, the system falls back
to the legacy path: flat BM25 + vector search with optional graph boost
(`getGraphBoostIds`). This improves the quality of the pool the rest of
the system ranks; it is not, by itself, the whole Signet thesis.

**Post-fusion dampening** (`dampening.ts`): three corrections run
after fusion scoring but before the final sort/return. (1) *Gravity*
penalizes high-cosine results that share zero query-term overlap
with the actual content (0.5x). (2) *Hub* penalizes results whose
linked entities are all in the top-10% by degree (P90 threshold,
0.7x). (3) *Resolution* boosts constraints, decisions, and
date-anchored memories (1.2x). All three stages are independently
toggleable via `DampeningConfig`.

**Recall surface parity**: explicit recall entry points should route through
the same daemon recall implementation whenever possible. Current daemon HTTP
recall, search aliases, hook recall, and MCP memory search call `hybridRecall`,
so they receive the same structured evidence shaping behavior. Prompt-submit is
intentionally not an explicit recall surface: it listens for known ontology
entities or active aliases, uses that entity match as the search scope, and
injects compact current-view attributes only when scoped attribute relevance
clears the configured confidence gate. Any future recall surface, including CLI
shortcuts, SDK helpers, desktop UI search,
connector-specific recall, must either call the
daemon recall API or implement the same evidence-channel contract. Do not add a
separate recall path that bypasses lexical, semantic, prospective hint, and
traversal evidence shaping.

**Graph boost fallback** (`graph-search.ts`): `getGraphBoostIds`
is the legacy graph-augmented search path, used when traversal is
disabled. It tokenizes the query, resolves matching entities by
`canonical_name LIKE ?` (ordered by `mentions DESC`, limit 20),
then expands one hop through `relations` in both directions (limit
50 neighbors). Finally it collects all `memory_id` values from
`memory_entity_mentions` for the expanded entity set (limit 200).
The result is a set of IDs whose scores are boosted. Any error
returns an empty set — the graph never degrades core search.

**Entity communities** (`community-detection.ts`): the Louvain
algorithm clusters entities into functional neighborhoods based on
`entity_dependencies` edge weights. Results are persisted to the
`entity_communities` table and `entities.community_id` is updated.
Community structure provides quality signals (fragmented, moderate,
strong) and enables community-scoped retrieval.

**Retention and orphaning**: when memories are tombstoned past their
retention window, the retention worker purges `memory_entity_mentions`
rows for those memories, decrements `entities.mentions`, and removes
entities whose mention count reaches zero (orphan collection).

---

## Document Ingest

The document worker handles URL fetches and raw content ingestion.
It follows the same `memory_jobs` queue as the extraction worker,
using job type `document_ingest`.

**Lifecycle**: a document row starts at `status = 'queued'` when
registered. The worker transitions it through `extracting` → `chunking`
→ `embedding` → `indexing` → `done`. Each transition is a separate
`withWriteTx` call so the current status is always visible without
holding a write lock during I/O.

**URL fetch**: if `source_type = 'url'`, the worker calls `fetchUrlContent`
with a configurable byte limit. The fetched title is written back to
the document row if not already set.

**Chunking**: `chunkText` splits content into overlapping fixed-size
chunks. The chunk size and overlap are configurable via
`documentChunkSize` and `documentChunkOverlap`. Each chunk becomes
a memory row of type `document_chunk` with `importance = 0.3`.

**Embedding and deduplication**: the embedding call happens outside
the write lock. Each chunk is normalized and hashed; if an identical
hash already exists as a memory linked to the same document, the
chunk is skipped. Embeddings are stored in the `embeddings` table
keyed by content hash.

**Linking**: each chunk memory is linked to its source document via
`document_memories(document_id, memory_id, chunk_index)`.

**Failure**: on error the document status is set to `failed` with an
error message. The job follows standard retry logic — up to
`max_attempts` tries before going `dead`.

---

## Database Schema

SQLite with WAL mode. Migrations are numbered sequentially under
`platform/core/src/migrations/`. Each migration is idempotent — safe
to re-run against an existing database. Schema version is tracked in
`schema_migrations`. The latest migration is `125-memory-content-safety.ts`.

**schema_migrations**

Tracks applied migration versions with checksum and timestamp. A
separate `schema_migrations_audit` table records duration per run.

**conversations**

Session-scoped records from harness hooks. Fields: `session_id`,
`harness`, `started_at`, `ended_at`, `summary`, `topics`, `decisions`,
`vector_clock`, `version`, `manual_override`. Indexed on `session_id`
and `harness`.

**memories**

The central table. Core fields: `id` (UUID), `type`, `category`,
`content`, `confidence`, `importance`, `source_id`, `source_type`,
`tags` (JSON array), `who`, `why`, `project`.

Pipeline v2 additions: `content_hash` (SHA-256 of normalized content),
`normalized_content`, `is_deleted` (soft delete flag), `deleted_at`,
`extraction_status` (`none`, `pending`, `completed`, `failed`),
`embedding_model`, `extraction_model`, `update_count`.

Access tracking: `last_accessed`, `access_count`, `pinned`.

A unique partial index enforces `content_hash` uniqueness among
non-deleted memories:

```sql
CREATE UNIQUE INDEX idx_memories_content_hash_unique
    ON memories(content_hash)
    WHERE content_hash IS NOT NULL AND is_deleted = 0
```

**memory_content_safety**

An agent-scoped derived ledger records the versioned content-safety decision
for memories, artifacts, transcripts, summaries, and source chunks. It stores
`status`, `context_eligible`, `reasons_json`, `policy_version`, and
`scanned_at`; it never replaces the raw evidence rows. Prompt-facing readers
must re-scan the exact projection and require a clean ledger decision.

**embeddings**

Stores raw embedding vectors as BLOBs. Keyed by `content_hash`
(unique). Fields: `vector` (BLOB), `dimensions`, `source_type`,
`source_id`, `chunk_text`. The `vec_embeddings` virtual table
(sqlite-vec `vec0`) provides ANN search when the extension is loaded.

**memories_fts**

FTS5 external content table backed by `memories`, created with the
`unicode61` tokenizer to avoid overly aggressive stemming on recall
queries. Three triggers (`memories_ai`, `memories_ad`, `memories_au`)
keep the index in sync with inserts, deletes, and updates. Queried with
BM25 scoring via `bm25(memories_fts)`.

**memory_jobs**

Durable job queue. Fields: `job_type`, `status` (`pending`, `leased`,
`completed`, `failed`, `dead`), `payload`, `result`, `attempts`,
`max_attempts`, `leased_at`, `completed_at`, `failed_at`, `error`,
`document_id` (for document_ingest jobs). Indexed on `status`,
`memory_id`, `completed_at` (partial, status=completed), and
`failed_at` (partial, status=dead).

**memory_history**

Immutable audit trail. Fields: `memory_id`, `event` (`created`,
`updated`, `deleted`, `recovered`, `none`), `old_content`,
`new_content`, `changed_by`, `reason`, `metadata` (JSON), `actor_type`
(`operator`, `agent`, `daemon`), `session_id`, `request_id`. The
pipeline writes shadow proposals here as `event = 'none'` with a JSON
`metadata` blob containing the full proposal.

**entities**

Knowledge graph nodes. Fields: `name`, `entity_type`, `description`,
`canonical_name` (lowercased for lookup), `mentions` (denormalized
count), `embedding` (BLOB, optional). Indexed on `canonical_name`.

**relations**

Knowledge graph edges. Fields: `source_entity_id`, `target_entity_id`,
`relation_type`, `strength`, `mentions`, `confidence`, `metadata`,
`updated_at`. Unique on (source, target, type). Indexed on source,
target, and a composite (source, type) for outgoing edge traversal.

**memory_entity_mentions**

Junction table linking memories to entities. Composite primary key
`(memory_id, entity_id)`. Additional fields: `mention_text`,
`confidence`, `created_at`. Indexed on `entity_id` for inbound
traversal during graph boost.

**documents**

Documents queued for ingest. Fields: `source_url`, `source_type`,
`content_type`, `content_hash`, `title`, `raw_content`, `status`
(`queued`, `extracting`, `chunking`, `embedding`, `indexing`, `done`,
`failed`), `error`, `connector_id`, `chunk_count`, `memory_count`,
`metadata_json`, `completed_at`. Indexed on `status`, `source_url`,
`connector_id`, and `content_hash`.

**document_memories**

Links documents to the memory chunks generated from them. Composite
primary key `(document_id, memory_id)`. Includes `chunk_index` for
ordering.

**connectors**

External data source registrations. Fields: `provider`, `display_name`,
`config_json` (full config as JSON), `cursor_json` (incremental sync
state), `status` (`idle`, `syncing`, `error`), `last_sync_at`,
`last_error`. Indexed on `provider`.

**summary_jobs**

Historical session-summary queue retained for migration and provenance
compatibility. Fields include `session_key`, `session_id`, `trigger`,
`captured_at`, `started_at`, `ended_at`, `harness`, `status`, `error`, and
`created_at`. Migration 117 promotes non-empty legacy transcript payloads into
`session_transcripts` before draining this table. New session-end delivery does
not create summary jobs; completed canonical transcripts are projected directly
into Dreaming.

**memory_artifacts**

Derived DB index over canonical markdown history. Fields include
`agent_id`, `source_path`, `source_sha256`, `source_kind`,
`session_id`, `session_key`, `session_token`, `project`, `harness`,
timing fields, `manifest_path`, `memory_sentence`,
`memory_sentence_quality`, `content`, and `updated_at`. This table is
rebuildable from markdown artifacts and powers rolling ledger reads.

**memory_artifact_tombstones**

Privacy-removal guardrail for canonical artifact sessions. Fields:
`agent_id`, `session_token`, `removed_at`, `reason`, `removed_paths`.
Re-index honors tombstones so deleted canonical history does not
reappear.

**session_transcripts** (migration 040)

Lossless session transcript storage. Fields: `session_key` (PK),
`content` (cleaned conversation transcript), `harness`, `project`,
`agent_id`, `created_at`. The transcript keeps only user/assistant
conversation turns for memory use. Raw tool traces may be retained in
daemon logs for audit. The recall endpoint supports `expand: true` to
join transcript content back into results via `source_id`, preserving
facts that extraction may drop. Indexed on `project` and `created_at`.

**memory_search_telemetry** (migration 066)

Local-only recall QA ledger created only when
`memory.pipelineV2.telemetry.memorySearchQaEnabled` is enabled. Fields:
`id`, `created_at`, `route`, `agent_id`, `session_key`, `project`,
`query`, `keyword_query`, `filters_json`, `method`, `result_count`,
`top_score`, `no_hits`, `duration_ms`, `timings_json`, `results_json`,
and `sources_json`. This table intentionally stores recall query text
and recalled result snapshots, so it is treated as sensitive memory
content: list/export routes require `analytics` permission and enforce
the authenticated token's agent/project scope before serialization.
Rows stay local and are retained until explicitly pruned or the local
SQLite database is removed; they are never sent through anonymous
telemetry event sinks.

**umap_cache**

UMAP projection cache. Fields: `id`, `dimensions`, `embedding_count`,
`result_json` (full projection as JSON), `cached_at`. One row per
dimension value. Invalidated and replaced whenever the embedding count
changes.

**tokens**

(Planned) Persistent token store for team mode token management.
Currently tokens are issued and verified against the in-memory secret;
revocation requires a daemon restart to rotate the secret.

**skill_meta** (migration 018)

Procedural memory metadata for installed skills. Fields: `skill_name`,
`decay_rate`, `use_count`, `role_classification`, `filesystem_path`.
Supports retention decay and role-based skill prioritization.

**entity_aspects** (migration 019)

Knowledge architecture: conceptual domains per entity. Fields:
`entity_id`, `aspect_name`, `description`, `confidence`. Organizes
entity knowledge into thematic clusters for structured retrieval.

**predictor_comparisons** (migration 020)

Predictive scorer: session comparison pairs used for preference
learning. Fields: `session_id`, `memory_a_id`, `memory_b_id`,
`preferred`, `confidence`, `created_at`.

**entity_attributes** (migration 021)

Knowledge architecture: facts and constraints under aspects. Fields:
`aspect_id`, `entity_id`, `attribute_key`, `attribute_value`,
`confidence`, `source_memory_id`. Stores structured facts about entity
aspects.

**entity_dependencies** (migration 022)

Knowledge architecture: structural edges between entities distinct from
semantic `relations`. Fields: `source_entity_id`, `target_entity_id`,
`dependency_type`, `strength`, `metadata`. Models build-time or
logical dependency graphs.

**predictor_training_pairs** (migration 023)

Predictive scorer: labeled training data for the preference model.
Fields: `session_id`, `memory_id`, `feature_vector` (BLOB), `label`,
`created_at`. Used for incremental model updates.

**agent_feedback** (migration 024)

Storage for the `memory_feedback` MCP tool. Fields: `memory_id`,
`session_id`, `feedback_type` (`positive`, `negative`, `correction`),
`correction_text`, `actor`, `created_at`. Records agent-provided
feedback for memory quality improvement.

**task_meta** (migration 025)

Knowledge architecture: task-specific entity metadata. Fields:
`entity_id`, `task_type`, `priority`, `status`, `due_at`,
`context_json`. Extends entities with actionable task properties.

**entity_pinning** (migration 026)

KA-6: user-driven entity weight overrides. Fields: `entity_id`,
`pin_type` (`pin` or `suppress`), `weight_override`, `reason`,
`created_at`. Allows users to amplify or suppress specific entities
in graph-augmented search results.

---
