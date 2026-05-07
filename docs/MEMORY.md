---
title: "Memory System"
description: "The core persistence layer — storage, search, and retrieval."
order: 3
section: "Core Concepts"
---

Memory System
=============

The memory system is the core persistence layer of Signet. Memories are
stored in a SQLite database at `$SIGNET_WORKSPACE/memory/memories.db`. Every
memory has a full-text search index (FTS5), a vector embedding, a
SHA-256 content hash for deduplication, and a versioned audit trail.
The [[daemon]] owns all writes. Direct database modification is unsupported.


Memory Lifecycle
----------------

The path from input to stored memory follows four phases: ingestion,
pipeline processing, indexing, and search.

When a client POSTs to `POST /api/memory/remember`, the daemon
immediately writes the memory row to SQLite. The FTS5 index is
updated synchronously. An embedding is generated asynchronously. The
write succeeds even if the embedding provider is unavailable — those
memories remain searchable by keyword only.

After the write, `enqueueExtractionJob` inserts a row into the
`memory_jobs` table (`job_type = 'extract'`, `status = 'pending'`).
The pipeline worker picks it up, runs extraction and decision, then
optionally writes derived facts as new memory rows. All of this
happens without touching the original memory's content.

Search (`POST /api/memory/recall`) runs hybrid BM25 + vector search,
optionally augmented by the knowledge graph, and returns a scored,
ranked list. This is the current retrieval substrate. Its job is to
produce a useful candidate set for context construction, not merely to
act as a better search engine in isolation.


Pipeline V2 Processing
-----------------------

[[pipeline|Pipeline V2]] is the autonomous memory processing subsystem. It runs
after every `remember` call when `pipelineV2.enabled = true` in
`agent.yaml` (see [[configuration]]).

### Extraction

The extraction stage (`platform/daemon/src/pipeline/extraction.ts`)
sends the raw memory content to an LLM (default: `qwen3:4b` via
Ollama) with a structured prompt. The model returns a JSON object with
two arrays: `facts` and `entities`.

Each fact has a `content` string (10–2000 chars), a `type` (see
Memory Types below), and a `confidence` score from 0 to 1. The
extractor caps output at 20 facts and 50 entities. Input longer than
12,000 characters is truncated with a `[truncated]` marker.

The LLM output is validated strictly. Missing fields, invalid types,
or unparseable JSON produce warnings but do not fail the job — the
stage returns whatever valid facts it could extract. Chain-of-thought
blocks (`<think>...</think>`) are stripped before parsing, which
handles models like qwen3 that emit reasoning preambles.

```
Extracted fact shape:
  { content: string, type: MemoryType, confidence: number }

Extracted entity shape:
  { source: string, relationship: string, target: string, confidence: number }
```

### Decision Engine

The decision stage (`platform/daemon/src/pipeline/decision.ts`)
evaluates each extracted fact against existing memories to determine
what should happen next.

For each fact, the engine runs a focused hybrid search (top 5
candidates). If no candidates are found, it immediately proposes
`add`. Otherwise, it sends the fact and its candidates to the LLM,
which returns one of four actions:

- `add` — no existing memory covers this fact; store it as new
- `update` — the fact refines or supersedes a specific candidate
- `delete` — the fact invalidates a specific candidate
- `none` — the fact is already covered; skip

The decision includes a `targetId` (required for `update` and
`delete`), a `confidence` score, and a `reason` string. Proposals
that reference non-candidate IDs, omit required fields, or return
invalid JSON are rejected with a warning.

### Shadow Mode vs. Controlled Writes

When `pipelineV2.shadowMode = true`, the pipeline runs fully —
extraction and decisions execute — but no memory rows are created or
mutated. All proposals are recorded in `memory_history` with
`changed_by = 'pipeline-shadow'` for inspection. This is safe to
enable on any deployment.

When shadow mode is off and `pipelineV2.mutationsFrozen = false`,
the worker enters controlled-write mode. Only `add` proposals are
applied. `update` and `delete` proposals are blocked by default
unless `pipelineV2.allowUpdateDelete = true`. Destructive proposals
are logged in `memory_history` with `blockedReason` set.

Facts below `pipelineV2.minFactConfidenceForWrite` are skipped.
Empty content after normalization is also skipped. Both cases produce
`skippedReason` entries in history.

### Graph Entity Persistence

If `pipelineV2.graphEnabled = true`, entities extracted during
Pipeline V2 are written to the [[docs/knowledge-architecture|knowledge graph]] after the main
transaction commits. This is a separate transaction — graph failure
never reverts fact extraction. Entities are stored by `canonical_name`
with a `mentions` count. Relations link source entities to targets
with a relationship label. Memory-entity associations are tracked in
`memory_entity_mentions`.


Hybrid Recall
-------------

Recall is implemented in `platform/daemon/src/memory-search.ts` by
`hybridRecall`. Its job is not to find one perfect row. Its job is to
collect a broad candidate set, filter it to the caller's allowed view,
shape the evidence, and return a bounded list of useful context.

The route layer checks the caller has `recall` permission. The search
layer then enforces the data boundary again with one shared filter:

- `agentId` and `readPolicy` control agent visibility. If `agentId` is
  present and `readPolicy` is omitted, recall defaults to isolated access.
- `project` restricts results to that project.
- `scope` restricts results to that explicit scope. When `scope` is
  omitted, normal recall excludes scoped memories.
- `type`, `tags`, `who`, `pinned`, `importance_min`, `since`, and `until`
  narrow the memory rows inside that visibility boundary.

The important safety rule is:

> Candidate IDs may be broad, but memory content is not loaded, reranked,
> summarized, dampened, expanded, or access-tracked until the shared filter
> has authorized those IDs.

That rule matters because vector search and graph traversal are intentionally
high-recall channels. They can produce IDs that did not pass through the FTS
SQL filter. `hybridRecall` therefore runs an explicit `authorize_candidates`
stage before any content-bearing stage.

### Phase 1: Prepare the Query

Recall starts with the original `query`, an optional `keywordQuery`, and a
normalized `limit`. `limit` is clamped to a bounded range so callers cannot
force unbounded recall work.

The keyword side uses `sanitizeFtsQuery` to produce a safe FTS5 `MATCH`
expression. If sanitization leaves no searchable tokens, the FTS and hint
paths are skipped instead of issuing an empty `MATCH`.

`expandRecallKeywordQuery` adds a small mechanical expansion set for known
class-to-instance gaps. The expansion affects keyword and hint search only.
Vector search and model summaries still use the user's original query.

### Phase 2: Collect Candidate IDs

Candidate collection uses several independent channels:

- **Memory FTS** queries `memories_fts`, joins to `memories`, applies the
  shared filter, and normalizes BM25 scores within the batch.
- **Prospective hints** query `memory_hints_fts`. Hints are write-time
  alternate phrasings. They can rescue a memory whose content does not use
  the same words as the current query.
- **Vector search** embeds the original query and searches `vec_embeddings`
  through `sqlite-vec`. Vector search cannot pre-filter every recall scope,
  so constrained searches over-fetch and rely on authorization after merge.
- **Structured path candidates** search entity/aspect/group/claim paths so
  structured knowledge can surface even when its prose is sparse.
- **Graph traversal** resolves focal entities and walks the knowledge graph.
  In traversal-primary mode, graph results are treated as a first-class
  retrieval channel rather than a small boost.

Flat lexical, hint, vector, and structured scores are merged by memory ID.
When a memory appears in multiple channels, the strongest calibrated evidence
wins unless there is an explicit blend. Pure hint-only hits are capped so
generated hints can rescue recall but do not outrank directly grounded
keyword, vector, or structured evidence.

Traversal-primary mode sorts traversal candidates before selection and
max-merges traversal overlap with flat candidates. This prevents a weak graph
score from discarding stronger direct evidence for the same memory.

### Phase 3: Authorize Candidates

After candidate collection and coarse score fusion, `authorize_candidates`
requeries `memories` with the shared filter and removes anything outside the
caller's allowed view. This is the boundary between "IDs only" and "content
can now be read."

New recall stages should follow this rule:

- Stages that only produce IDs and scores may run before authorization.
- Stages that read memory content, send text to a model, build summaries,
  inspect entity coverage, expand transcripts, or update metadata must run
  after authorization.

### Phase 4: Shape Authorized Evidence

Once candidates are authorized, recall can safely use content-bearing
post-processing:

- **Structured Evidence Convolution (SEC-lite)** compares lexical, semantic,
  hint, traversal, and structured signals so graph-only results do not blindly
  dominate direct evidence.
- **Facet coverage** can read candidate content and prefer rows that cover
  more of the query's facets.
- **Rehearsal boost** applies a small access-frequency and recency signal
  when enabled.
- **Reranking** can use an embedding reranker or an LLM reranker on the
  authorized top-N candidates. If the reranker fails or times out, recall
  keeps the existing ordering.
- **Dampening** penalizes low-overlap semantic hits, hub-like entity
  dominance, and other noisy retrieval shapes.
- **Currentness** annotates superseded memories and boosts current
  replacements.

All of these stages are non-fatal. Recall should degrade toward simpler
keyword/vector results rather than fail the whole response.

### Phase 5: Hydrate and Assemble Results

Hydration fetches full memory rows with the same shared filter used by
authorization. Constrained searches use a larger pre-hydration window so
valid later candidates can still return after broad vector or traversal IDs
are removed.

Assembly walks the pre-hydrated scored list, keeps only hydrated rows, and
then applies the caller's `limit`. Access tracking updates only the memory
IDs that actually appear in the returned primary result set. Synthetic cards
and unauthorized candidates never update `access_count`.

Supplementary results may include:

- source-backed Obsidian chunks,
- native memory artifacts,
- transcript fallback cards when `expand` is enabled,
- an LLM summary card when the LLM reranker path has remaining timeout
  budget,
- linked rationale memories for decision results,
- constructed graph context cards.

The final response is capped to `limit`. Supplementary rows are marked with
`supplementary: true` so callers can distinguish them from ordinary memory
rows.

### Source and Transcript Rescue Paths

If normal memory candidates produce no hits, recall can fall back to source
chunks, native memory artifacts, and transcript FTS. These paths return
synthetic recall rows rather than materializing new `memories` records, but
each fallback is only enabled when its backing rows can satisfy the caller's
scope boundary.

Source chunk vector fallback is disabled for project-scoped recall until chunk
embeddings carry a strong source root/project binding. Project-scoped searches
still use authorized memory rows, native source artifacts, and transcript
fallbacks; they do not guess source ownership from chunk text metadata.

When `expand` is enabled and ordinary memory rows reference session source
IDs, recall may fetch raw transcript excerpts and same-session structured
summaries. This is a lossless backing-source path: extracted memories remain
the primary row, but the transcript can restore details that extraction
compressed away.

### Timing and Failure Behavior

Every major stage records timing data in `meta.timings`. Slow recalls log a
stage breakdown so latency regressions can be localized without guessing.

Secondary channels are deliberately best-effort. Embedding, vector search,
graph traversal, structured evidence, reranking, dampening, currentness,
source fallback, transcript expansion, and LLM summary failures are logged
and skipped. The caller should receive the best safe recall response the
daemon can produce from the remaining channels.

### Recall API

```bash
curl -X POST http://localhost:3850/api/memory/recall \
  -H 'Content-Type: application/json' \
  -d '{
    "query": "database preferences",
    "limit": 10,
    "type": "preference",
    "importance_min": 0.5
  }'
```

Optional filters: `type`, `tags`, `who`, `pinned`, `importance_min`,
`since`, `until`, `agentId`, `readPolicy`, `policyGroup`, `project`,
`scope`, and `expand`.


Content Normalization
---------------------

Before any memory is written, content passes through normalization
(`platform/daemon/src/content-normalization.ts`).

Storage content trims whitespace and collapses internal whitespace
runs to single spaces. Normalized content additionally lowercases the
result and strips trailing punctuation. The SHA-256 hash is computed
over normalized content (or over lowercased storage content if
normalization produces an empty string).

```
storageContent  = trim + collapse whitespace
normalizedContent = storageContent.toLowerCase().replace(/[.,!?;:]+$/, "")
hashBasis       = normalizedContent || storageContent.toLowerCase()
contentHash     = sha256(hashBasis)
```

The `content_hash` column has a unique constraint. If a write
produces a hash that already exists as a non-deleted memory, the
write is skipped and the existing memory ID is returned. This
deduplication fires both on explicit `remember` calls and on pipeline
V2 `add` proposals.

### Contradiction Detection

During controlled-write processing, `update` and `delete` proposals
are evaluated for contradiction risk
(`platform/daemon/src/pipeline/worker.ts`).

The detector tokenizes both the new fact and the target memory
content (lowercase, punctuation stripped, minimum 2-char tokens).
A contradiction is flagged when all three conditions hold:

1. Lexical overlap between the two texts is at least 2 tokens
   (they are about the same subject).
2. One text contains a negation token (`not`, `no`, `never`,
   `cannot`, `dont`, `wont`, etc.) and the other does not.
3. Or, the texts contain antonym tokens in opposing positions
   (e.g., one has `enabled` and the other has `disabled`).

Registered antonym pairs: `enabled/disabled`, `allow/deny`,
`accept/reject`, `always/never`, `on/off`, `true/false`.

Proposals that trigger contradiction detection are flagged with
`contradictionRisk: true` and `reviewNeeded: true` in the audit
record. The proposal is still blocked (UPDATE/DELETE are not yet
applied autonomously), but the flag makes it inspectable.


Modify and Forget
-----------------

### Modify

`POST /api/memory/modify` accepts a batch of patch objects. Each
patch targets one memory by ID and can update `content`, `type`,
`importance`, `tags`, `pinned`, or `who`. A `reason` string is
required for every patch (either per-patch or as a request-level
default).

Content changes trigger re-embedding synchronously before the
database write. The new embedding replaces the old one in the
`embeddings` table. Each patch accepts an optional `if_version`
integer for optimistic concurrency control — if the memory's current
version does not match, the patch returns `version_conflict` without
writing.

The batch limit is enforced server-side. Results are returned per
patch, including `status`, `currentVersion`, `newVersion`,
`contentChanged`, `embedded`, and `duplicateMemoryId` if a content
change would have produced a hash collision.

```bash
curl -X POST http://localhost:3850/api/memory/modify \
  -H 'Content-Type: application/json' \
  -d '{
    "reason": "corrected preference",
    "patches": [
      {
        "id": "<memory-id>",
        "content": "User prefers spaces over tabs",
        "if_version": 3
      }
    ]
  }'
```

Every successful modify writes a `modified` event to `memory_history`
with the previous content, new content, actor, reason, and timestamp.

### Forget

`POST /api/memory/forget` operates in two modes: `preview` and
`execute`.

In preview mode, the endpoint evaluates candidates (by query, IDs,
or filter fields: `type`, `tags`, `who`, `source_type`, `since`,
`until`) and returns a candidate list with a `confirmToken`. No
writes occur. For batches exceeding the confirmation threshold, the
`confirmToken` must be echoed back in the execute call.

In execute mode, each candidate is soft-deleted: `is_deleted = 1`
and `deleted_at` are set. The `reason` field is required. Passing
`force: true` hard-deletes the row immediately instead of
soft-deleting. Batch `if_version` is not supported — use
`DELETE /api/memory/:id` for version-guarded single deletes.

```bash
# Preview
curl -X POST http://localhost:3850/api/memory/forget \
  -H 'Content-Type: application/json' \
  -d '{"query": "old project notes", "mode": "preview"}'

# Execute
curl -X POST http://localhost:3850/api/memory/forget \
  -H 'Content-Type: application/json' \
  -d '{
    "query": "old project notes",
    "mode": "execute",
    "reason": "project is archived",
    "confirm_token": "<token-from-preview>"
  }'
```

Every forget writes a `deleted` event to `memory_history`.


Soft-Delete and Recovery
------------------------

Soft-deletion sets `is_deleted = 1` and records a `deleted_at`
timestamp. Soft-deleted memories are excluded from all search results
and API list endpoints. They remain in the database as tombstones for
the retention window (default: 30 days).

Within the retention window, a memory can be recovered:

```bash
POST /api/memory/:id/recover
{ "reason": "accidentally deleted" }
```

Recovery clears `is_deleted` and `deleted_at`, increments the version,
and writes a `recovered` event to `memory_history`. The endpoint
returns the current and new version numbers.

Recovery fails with a 409 if the memory is not deleted
(`not_deleted`), if the retention window has expired
(`retention_expired`), or if an `if_version` check fails
(`version_conflict`). It returns 503 if `mutationsFrozen` is active.

After the retention window elapses, the retention worker hard-deletes
the tombstone and all associated embeddings and graph links. Recovery
is no longer possible after that point.


Memory History
--------------

Every mutation to a memory row is recorded in the `memory_history`
table. This provides a complete, ordered audit trail for each memory.

| Field | Description |
|-------|-------------|
| `id` | UUID for the history event |
| `memory_id` | The memory this event belongs to |
| `event` | Event type: `created`, `modified`, `deleted`, `recovered`, `none` |
| `old_content` | Content before the change (null for creates) |
| `new_content` | Content after the change (null for deletes) |
| `changed_by` | Actor string (harness name, `pipeline-v2`, `pipeline-shadow`) |
| `reason` | Required human-readable reason for the change |
| `metadata` | JSON blob with additional context (pipeline details, flags) |
| `created_at` | ISO timestamp of the event |

Pipeline V2 records history for every proposal evaluated, including
those that were skipped, blocked, or deduplicated. Shadow mode
proposals use `changed_by = 'pipeline-shadow'` and `event = 'none'`
to distinguish them from real mutations. The `metadata` field carries
pipeline-specific fields: `shadow`, `proposedAction`,
`targetMemoryId`, `confidence`, `contradictionRisk`,
`reviewNeeded`, `blockedReason`, and the source fact details.

History events are retained for 180 days by default, then purged by
the retention worker.


Retention and Decay
-------------------

### Importance Decay

Every memory has an `importance` score between 0.0 and 1.0. Over
time, non-pinned memories decay based on days since last access:

```
importance(t) = base_importance × decay_rate ^ days_since_access
```

The default `decay_rate` is 0.95 (5% per day). Accessing a memory
via recall resets its decay timer by updating `last_accessed`. Pinned
memories (`pinned = 1`, set via `critical:` prefix or API) have
`importance = 1.0` and never decay.

Configure in `agent.yaml`:

```yaml
memory:
  decay_rate: 0.99   # slow decay
  decay_rate: 0.95   # default
  decay_rate: 0.90   # fast decay
```

### Retention Worker

The retention worker (`platform/daemon/src/pipeline/retention-worker.ts`)
runs every 6 hours and purges expired data in a strict sequence. Each
step runs in its own short write transaction to avoid holding locks.

The purge order is mandatory — later steps depend on earlier ones
having removed their referencing rows first:

1. **Graph links** (`memory_entity_mentions`) for tombstoned memories
   past the retention window. Entity mention counts are decremented;
   entities with zero mentions are orphaned (removed).
2. **Embeddings** for the same tombstoned memories (from the
   `embeddings` table).
3. **Tombstones** — the `memories` rows themselves are hard-deleted.
   The `memories_ad` trigger handles FTS5 cleanup automatically.
4. **History events** older than the history retention window.
5. **Completed jobs** older than the completed job retention window.
6. **Dead-letter jobs** older than the dead job retention window.

Each step is capped at `batchLimit` rows per sweep (default: 500)
to bound write latency.

Default retention windows:

| Data | Retention |
|------|-----------|
| Soft-deleted memories (tombstones) | 30 days |
| History events | 180 days |
| Completed pipeline jobs | 14 days |
| Dead-letter pipeline jobs | 30 days |

These are configurable in `agent.yaml` under `retention.*`.


Job Queue
---------

Pipeline V2 processing is driven by a persistent job queue in the
`memory_jobs` table. Jobs are atomic — lease acquisition and status
updates happen inside write transactions.

### Job States

```
pending → leased → completed
                 → failed → pending (retry)
                 → dead   (max attempts exceeded)
```

When a job fails, it returns to `pending` status for retry unless
`attempts >= max_attempts`, in which case it moves to `dead`. Dead
jobs are retained for the dead-letter window (default: 30 days) and
then purged.

### Lease Mechanism

The worker polls for pending jobs by selecting the oldest
`pending` row with `attempts < max_attempts`. It atomically sets
`status = 'leased'` and increments `attempts` in the same write
transaction. This prevents two workers from processing the same job.

A stale lease reaper runs every 60 seconds. Jobs that have been
`leased` for longer than `leaseTimeoutMs` (configurable) are reset
to `pending` for pickup by the next poll cycle.

### Retry Backoff

On consecutive failures, the worker applies exponential backoff:

```
delay = min(BASE_DELAY × 2^failures, MAX_DELAY) + random_jitter
```

`BASE_DELAY` is 1000ms, `MAX_DELAY` is 30,000ms, jitter up to 500ms.
Successful jobs reset the failure counter.

### Enqueue Deduplication

`enqueueExtractionJob` checks for existing `pending` or `leased` jobs
for the same `memory_id` before inserting. Duplicate enqueue calls
for the same memory are silently dropped.

### Controlled Writes in the Worker

When not in shadow mode, the worker prefetches embeddings for all
`add` proposals before entering the write transaction. This keeps the
critical write path synchronous and avoids holding a write lock while
waiting on network I/O to the embedding provider. Embedding failures
are non-fatal — the fact is written without an embedding vector and
remains keyword-searchable.


Memory Types
------------

Every memory has a `type` field that classifies its semantic role.
The pipeline extractor assigns types; explicit saves use type
inference from content patterns or accept an explicit `type` parameter.

| Type | Meaning | Example |
|------|---------|---------|
| `fact` | Objective, verifiable information | "Signet stores data in SQLite" |
| `preference` | User or agent preferences and inclinations | "User prefers dark mode" |
| `decision` | Choices made, options selected or rejected | "Decided to use PostgreSQL" |
| `procedural` | How-to knowledge, steps, workflows | "Run bun install before building" |
| `semantic` | Concepts, definitions, and relationships | "BM25 is a term-frequency ranking function" |

Type inference for explicit saves uses keyword matching:

- `preference` — triggers on: prefers, likes, wants
- `decision` — triggers on: decided, agreed, will use
- `rule` — triggers on: never, always, must
- `learning` — triggers on: learned, discovered
- `issue` — triggers on: bug, broken, problem
- `fact` — default when no pattern matches

### Importance and Tags

`importance` is a float from 0.0 to 1.0 set at creation time. The
pipeline uses `fact.confidence` as the importance for autonomously
created memories. Explicit saves default to 0.8.

`tags` is a JSON array of strings. Tags support filtering at recall
time. The `critical:` prefix sets `pinned = 1` and `importance = 1.0`.
The `[tag1,tag2]:` prefix sets tags directly.

Both can be combined: `critical: [project,auth]: never expose tokens`.


API Reference Summary
---------------------

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/memory/remember` | POST | Save a memory |
| `/api/memory/recall` | POST | Hybrid search |
| `/api/memories` | GET | List memories (paginated) |
| `/api/memory/:id` | GET | Fetch one memory by ID |
| `/api/memory/:id` | PATCH | Update fields on one memory |
| `/api/memory/:id` | DELETE | Soft-delete one memory (version-guarded) |
| `/api/memory/:id/recover` | POST | Recover a soft-deleted memory |
| `/api/memory/modify` | POST | Batch patch memories |
| `/api/memory/forget` | POST | Batch soft-delete with preview/execute mode |
| `/memory/search` | GET | Legacy keyword-only search |
| `/api/embeddings` | GET | Export embeddings |

See [[api]] for full request/response schemas.
