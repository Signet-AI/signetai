---
title: "Pipeline and storage"
description: "How Signet preserves evidence, runs Dreaming, indexes documents, and stores retrieval projections."
---

Signet separates canonical evidence from the derived structures used for
retrieval and maintenance.

Conversation transcripts, memory rows, imported documents, and canonical
Markdown artifacts are evidence. Embeddings, FTS indexes, graph projections,
content-safety decisions, and `MEMORY.md` are derived or rebuildable surfaces.
Semantic changes must retain provenance back to the evidence that justified
them.

The main runtime pieces are:

- the session and source paths, which capture evidence;
- Dreaming, which performs bounded semantic consolidation through audited
  operations;
- non-semantic pipeline workers for document indexing, retention, maintenance,
  synthesis, and prospective hints;
- SQLite tables and indexes, which provide durable state and retrieval speed.

No provider call runs inside a SQLite write transaction. Providers, embeddings,
URL fetches, and agent execution happen before the transaction that applies the
result.

## Semantic processing: Dreaming

Dreaming is the semantic writer. It replaced the former Pipeline V2 extraction,
decision, and autonomous graph-writing workers. The `memory.pipelineV2`
configuration namespace remains because it still owns non-semantic workers and
retrieval features; enabling it does not restore the retired extraction runtime.

The daemon's Dreaming worker periodically checks all known agent scopes. A pass
runs only when there is pending attention or enough episodic evidence to justify
the inference cost. Scheduled sweeps defer while the system is under queue or
resource pressure, and failed passes use bounded backoff.

A pass:

1. selects scoped evidence from completed transcripts, memory artifacts,
   summaries, memories, and pending Dreaming attention;
2. builds an evidence window and a runbook for the selected pass mode;
3. runs one bounded agent through the configured inference workload;
4. lets the agent search evidence and inspect or create attention records through
   the Dreaming tool surface;
5. applies the agent's ontology and memory operations through the daemon-owned
   `applyDreamingOperations` seam;
6. records the pass, tool calls, usage, mutations, failures, and evidence
   exclusions for later inspection.

The apply seam is deliberately narrower than a general database API. Content
operations must cite exact quotes from scoped episodic evidence. Hygiene archive
and merge operations must cite an `attention:<id>` record whose target matches
the operation. The applicator enforces agent scope, provenance, operation
schemas, and write caps before entering its write transactions.

Dreaming supports combined and focused pass modes:

- `incremental` and `compact` cover the normal full runbook;
- `incremental-hygiene` handles bounded structural cleanup;
- `incremental-content` handles evidence-linked content work.

The default Dreaming configuration uses a 100,000-token episodic threshold, a
six-hour maximum interval, a 20-minute pass timeout, and a 128,000-token input
budget. These are configuration defaults, not guarantees that every pass will
consume those limits.

### What Pipeline V2 still owns

Pipeline V2 still provides configuration and supporting workers for:

- document ingest;
- retention and queue maintenance;
- `MEMORY.md` and related projection work;
- prospective hint indexing;
- graph-aware retrieval, traversal, reranking, and dampening;
- embedding tracking and migration;
- operational repair and diagnostics.

The following are retired and must not be described or configured as active
semantic stages:

- the old `extraction.ts` fact/entity extraction contract;
- the per-fact `decision.ts` stage;
- `applyPhaseCWrites` and the old controlled-write worker;
- the old inline LLM graph extraction and `txPersistEntities` path;
- the old summary worker as the session-end delivery mechanism.

The config loader rejects legacy extraction provider/model/command settings and
old write-gate or durability settings rather than silently selecting a fallback.

### Remember-time entity linking

The normal remember path may extract candidate proper nouns and attach the new
memory to entities that already exist for the same `agent_id`. This writes
`memory_entity_mentions` rows only. It does not create entities, aspects,
attributes, or dependency edges from raw text. Semantic graph authorship belongs
to structured writes, explicit user or agent operations, Dreaming, and reviewed
repair passes.

### Prospective hints

When `memory.pipelineV2.hints.enabled` is enabled, the hints worker generates
hypothetical future queries for memories and indexes them in `memories_fts`.
Hints are retrieval aids, not semantic graph assertions. Their generation is
performed outside write locks; the resulting index update is applied separately.

## Session transcripts and lineage

As hooks run, Signet writes a canonical retained conversation transcript as
JSONL under:

```text
$SIGNET_WORKSPACE/memory/{harness}/transcripts/transcript.jsonl
```

The path is normalized by harness name. The transcript artifact contains the
conversation turns needed for memory use. Raw tool traces may remain in daemon
logs for audit, but are not silently treated as semantic evidence in the same
projection.

`session_transcripts` is the canonical database index for retained transcripts.
Session-end, recovery, and TTL paths mark rows complete directly. They do not
create a summary job or wait for a summary worker. Completed transcript rows are
the direct episodic input for the Dreaming content pass.

The table includes `session_key`, `content`, `harness`, `project`, `agent_id`,
`created_at`, `updated_at`, `completed_at`, and `content_hash`. Reads and writes
are agent-scoped.

The memory recall endpoint supports `expand: true`. When requested, session
keys associated with recalled results are batch-looked up in
`session_transcripts`, and bounded transcript content is joined into the
response. This preserves context that may not have become a separate memory
row without creating a second hidden recall path.

Canonical Markdown artifacts under `$SIGNET_WORKSPACE/memory/` remain the
lineage surface for transcript, summary, and compaction history. `MEMORY.md` is
a rebuildable projection over durable memory rows, temporal state, and the
canonical artifact ledger. Before retained content enters prompt-facing
projections, the versioned content-safety policy must mark it eligible.

## Job queue

`memory_jobs` is a durable SQLite queue. Jobs survive daemon restarts and carry
an explicit `job_type`, payload, retry counters, lease timestamps, completion
state, and error information.

The active document-ingest lifecycle is:

```text
pending -> leased -> completed
                   \-> pending (retry)
                   \-> dead (max attempts)
```

A document worker leases only `document_ingest` jobs. Leasing is performed in a
write transaction: the oldest eligible pending job is selected, marked leased,
and its attempt count is incremented atomically. URL fetching, chunking, and
embedding happen outside that transaction. A stale-lease recovery path returns
interrupted jobs to a processable state, and terminal jobs are retained until
maintenance or retention policy removes them.

The old `extract` job type may still exist in historical databases and repair
fixtures, but the semantic extraction worker that consumed it is retired. The
queue is generic rather than limited to the two-worker model described by the
old documentation. Current diagnostics deliberately exclude retired
extraction rows from their bounded queue indexes.

Queue repair actions can requeue dead jobs, release stale leases, cancel
obsolete work, and prune terminal history. These actions are scoped, rate
limited, and dry-run by default at their diagnostic HTTP surface.

## Document ingest

Document ingest handles URLs, raw content, and configured source connectors. A
document row moves through visible processing states:

```text
queued -> extracting -> chunking -> embedding -> indexing -> done
                                                        \-> failed
```

Here, `extracting` means obtaining or preparing document content. It is not the
retired semantic fact-extraction stage.

For a URL source, the worker fetches content with the configured byte limit and
stores a fetched title when one is not already present. Raw content is split
into overlapping chunks using the configured `chunkSize` and `chunkOverlap`.
Each accepted chunk becomes a `document_chunk` memory and is linked to its
source through `document_memories(document_id, memory_id, chunk_index)`.

Embedding calls happen before the write transaction. Chunks are normalized and
hashed; an identical chunk already linked to the same document is skipped.
Canonical vectors are stored in `embeddings`, with the sqlite-vec table serving
as a derived ANN mirror when the extension is available. If sqlite-vec cannot
load, including Bun's system SQLite on macOS, semantic recall uses a bounded
cosine scan over the newest canonical vectors instead. This fallback is
explicitly partial: recall responses identify `vectorCompleteness` as
`"recent-window"` and report the `searchedWindow` size (10,000 rows by default).
It preserves a useful semantic channel without claiming complete workspace
coverage, and the scan runs in the dedicated recall owner process.

A failed document updates the document row with an error and follows the same
retry budget as its queue job. Deleting a document while work is in flight
cancels the remaining operation instead of recreating source-owned rows.

## Knowledge graph and retrieval

The graph is an augmentation and structured-retrieval layer. Core episodic
recall remains available when graph traversal is disabled or has no matching
entities.

The graph-related storage includes:

- `entities`, with canonical names and scoped identity;
- `entity_aspects` and `entity_attributes`, which store structured knowledge;
- `entity_dependencies`, which stores structural links used by ontology
  traversal;
- `relations` and `memory_entity_mentions`, retained for semantic relation and
  mention projections;
- ontology proposal, provenance, attention, contradiction, and Dreaming pass
  tables that record how graph state was inspected or changed.

Semantic graph writes do not come from an unconstrained LLM extraction trigger.
Structured remember payloads, explicit mutations, Dreaming's audited apply seam,
and reviewed repair paths are the writers. Retention removes orphaned mention
and graph rows when a tombstoned memory is permanently purged.

When graph traversal is enabled, `hybridRecall` resolves focal entities from the
query, traverses aspects, attributes, and dependency hops, and blends that
candidate pool with flat lexical and vector retrieval. Flat FTS5/vector
candidates retain a reserved share of the result budget so a highly connected
entity cannot displace every direct match. Evidence channels remain separate:
lexical, semantic, prospective-hint, and traversal evidence are shaped before
final ranking.

When traversal is disabled or produces no match, recall falls back to flat BM25
and vector retrieval with the legacy graph boost available as an optional
augmentation. Post-fusion dampening can independently apply gravity, hub, and
resolution corrections before the final sort.

All explicit recall surfaces should use the same daemon recall implementation or
preserve this evidence-channel contract. Hook recall, HTTP recall, search
aliases, and MCP memory search share `hybridRecall`. Prompt-submit context is a
deliberately narrower ontology/entity lookup, not an independent general recall
implementation.

## Database Schema

Signet uses SQLite in WAL mode. Migrations are numbered sequentially under
`platform/core/src/migrations/`, run in order, and recorded in
`schema_migrations` with checksum and timing data in
`schema_migrations_audit`. The latest migration is `146-repair-rate-limits.ts`.

### Evidence and semantic state

**`memories`** is the central durable memory table. It stores content, type,
source identity, agent/project scope, confidence, importance, tags, timestamps,
provenance fields, and lifecycle state. Pipeline-era columns such as
`content_hash`, `normalized_content`, `is_deleted`, `deleted_at`,
`extraction_status`, embedding/extraction model metadata, and update counters
remain part of the schema for compatibility and lifecycle management. A scoped
partial uniqueness rule prevents duplicate non-deleted content hashes.

**`memory_history`** is the immutable audit trail for memory lifecycle events,
including created, updated, deleted, recovered, and proposal/observation events.
It stores old and new content where applicable, the actor, reason, metadata,
session, and request identifiers.

**`memory_content_safety`** is an agent-scoped derived ledger for content-safety
decisions over memories, artifacts, transcripts, summaries, and source chunks.
It stores the decision status, prompt eligibility, reasons, policy version, and
scan time. It never replaces or rewrites the underlying evidence.

**`session_transcripts`** stores the canonical retained conversation index. Its
current lifecycle fields include completion and content-hash metadata, in
addition to session, harness, project, agent, content, and timestamps.

**`memory_artifacts`** indexes canonical Markdown history, including source path,
content hash, artifact kind, session identity, project, harness, timing, and
memory-sentence metadata. It is rebuildable from the Markdown artifacts.

**`memory_artifact_tombstones`** prevents removed canonical artifact sessions
from being reintroduced during re-indexing.

**`session_summaries`** and **`summary_jobs`** are historical/provenance surfaces.
The summary queue is retained for migration compatibility; new session-end
transcript delivery does not enqueue summary work. Legacy payloads are promoted
into `session_transcripts` during migration where possible.

### Retrieval projections

**`embeddings`** stores canonical embedding vectors and their content/source
metadata. **`vec_embeddings`** is the sqlite-vec ANN mirror and is rebuildable.

**`memories_fts`** is an FTS5 external-content index over memory text and
prospective hints. Its triggers keep it synchronized with the canonical memory
rows.

**`memory_search_telemetry`** is an opt-in, local-only recall QA ledger. It may
contain query text and result snapshots, so routes that expose it enforce
analytics permission and agent/project scope. It is not sent through anonymous
telemetry sinks.

**`umap_cache`** stores replaceable embedding projections keyed by embedding
count and dimension.

### Queue, documents, and sources

**`memory_jobs`** stores durable work items, including job type, status, payload,
result, retry counters, lease and terminal timestamps, errors, and document
identity where applicable. Retired extraction rows are preserved as historical
state but excluded from current bounded queue diagnostics.

**`documents`** stores source URL/type, content metadata and hash, raw content,
visible processing status, errors, connector identity, chunk/memory counts, and
completion metadata.

**`document_memories`** links source documents to generated chunk memories and
preserves chunk ordering.

**`connectors`** stores external source registrations, provider configuration,
incremental cursor state, status, and synchronization errors. Connector data is
scoped and its indexed rows remain purgeable when a source is disconnected.

### Dreaming and ontology control plane

The Dreaming subsystem persists its own state rather than hiding it in logs:

- `dreaming_state` stores per-agent cursor, failure, and last-pass state;
- `dreaming_passes` stores mode, status, usage, mutation counts, summaries, and
  errors;
- `dreaming_attention` stores bounded hygiene, review, evidence-retry, and
  surprisal work;
- `dreaming_tool_calls` stores the ordered tool-call trace for a pass;
- `dreaming_evidence_exclusions` records evidence rejected or deferred by a
  pass, including retry state;
- `dreaming_evidence_reviews` records terminal reviewed dispositions for
  immutable source revisions without changing the underlying evidence;
- `dreaming_runbook` and evidence-window columns preserve the pass context used
  for later inspection;
- `ontology_proposals` and related provenance tables preserve structured
  mutation proposals and their application state;
- `ontology_contradictions` stores scoped contradiction observations as
  evidence-backed derived records rather than replacing either claim.

The graph and ontology tables are durable state. The agent's reasoning is not
stored as an unscoped replacement for that state; only validated operations,
evidence, provenance, and audit metadata are applied.

## Data ownership rules

The ownership boundary is the important part of the schema:

- canonical transcript, Markdown, source, and memory rows remain the evidence;
- graph claims, embeddings, FTS rows, UMAP data, safety decisions, and
  `MEMORY.md` are derived projections or controlled semantic state;
- re-indexing and repair must preserve agent scope, project scope, source
  attribution, and deletion/tombstone state;
- removing a source purges its source-owned projections without mutating the
  external source or silently deleting unrelated Dreaming-derived history;
- every semantic mutation must be attributable to a scoped actor, an exact
  evidence citation, or a validated hygiene-attention record.
