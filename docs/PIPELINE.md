---
title: "Memory Pipeline"
description: "LLM-based memory extraction and processing pipeline."
order: 4
section: "Core Concepts"
---

Memory Pipeline v2
==================

Overview and Philosophy
---

Pipeline v2 exists because the original memory system was purely reactive:
callers wrote whatever they wanted, the database accepted it, and recall
quality depended entirely on how well the caller chose what to store. That
model worked for bootstrapping but doesn't scale — memories accumulate
noise, contradict each other, and fragment across overlapping phrasings of
the same fact.

The pipeline introduces a background extraction layer. When a memory
arrives, it is persisted immediately (raw-first safety), and a job is
enqueued to analyze it asynchronously. The job runs extraction and
decision passes using a local LLM, then optionally writes derived facts
back into the memory store. This means the caller's raw content is never
lost — it is always durably committed before any LLM call runs — and
derived facts are layered on top rather than replacing the original.

The central constraint governing every design decision here is: **no LLM
calls inside write-locked transactions.** SQLite write locks are exclusive,
and a blocking HTTP call to Ollama inside one would stall the entire daemon.
The pipeline enforces a strict two-phase discipline: fetch and embed outside
the lock, then commit atomically inside `withWriteTx`. Any violation of this
rule introduces unbounded latency into every other writer.


Pipeline Modes
---

Three operational modes are composed from five boolean flags.

**Shadow mode** is active when `enabled` is true but `shadowMode` is also
true, or when `mutationsFrozen` is true. In this mode the pipeline runs the
full extraction and decision sequence, records all proposals to
`memory_history` for audit, but makes no writes to the memories table.
Shadow mode is useful for validating extraction quality without affecting
production data.

**Controlled-write mode** is active when `enabled` is true, `shadowMode` is
false, and `mutationsFrozen` is false. In this mode, ADD and NONE decisions
are applied. ADD creates new memory rows and embeddings; NONE is recorded
for audit only. Destructive decisions (UPDATE and DELETE) are blocked by
default and require the separate `allowUpdateDelete` flag.

**Full mode** is the same as controlled-write mode with `allowUpdateDelete`
set to true. In the current implementation, destructive mutations are
recognized in the decision output but their application is reserved for a
future phase — they are blocked with reason
`destructive_mutations_not_implemented` and logged.

The five config flags in detail:

- `enabled` — Master switch. When false, no extraction jobs are processed.
- `shadowMode` — Run extraction and decisions without writing any facts.
- `allowUpdateDelete` — Permit UPDATE/DELETE decisions to mutate existing
  memories. Currently infrastructure-only; mutations are not yet applied.
- `mutationsFrozen` — Emergency brake. Disables all writes even if
  `shadowMode` is false.
- `autonomousFrozen` — Disables the maintenance worker's scheduled interval
  even if `autonomousEnabled` is true.


Extraction Stage
---

Extraction is the first LLM pass. Its job is to decompose a raw memory
string into a list of discrete, reusable facts and a list of entity
relationship triples.

The extraction prompt instructs the model to return a JSON object with two
arrays. Each fact carries a `content` string, a `type` discriminant
(`fact`, `preference`, `decision`, `procedural`, or `semantic`), and a
floating-point `confidence` in [0, 1]. Each entity triple carries `source`,
`relationship`, `target`, and `confidence`. The prompt includes worked
examples and explicitly tells the model to skip ephemeral details and return
only the JSON object — no surrounding text.

The model's output is post-processed before validation. `<think>` blocks
emitted by chain-of-thought models like qwen3 are stripped first. Then
Markdown code fences are removed if present. The resulting string is
parsed as JSON.

Validation is strict and partial-failure safe. Facts are capped at 20 per
input. Any fact shorter than 10 characters is rejected. Any fact longer
than 2000 characters is truncated. An unknown type string is coerced to
`fact` with a warning recorded. Entities are capped at 50 per input; each
must have non-empty `source` and `target` strings and a non-empty
`relationship`. Input longer than 12,000 characters is truncated before the
prompt is built.

Validation failures produce warnings that are accumulated in the
`ExtractionResult` and surfaced in the job's result payload. They never
throw — partial results are always returned.


Decision Stage
---

The decision stage evaluates each extracted fact independently against the
existing memory store. For each fact, the engine retrieves the top-5
candidate memories via hybrid search, then asks the LLM which of four
actions to take: ADD, UPDATE, DELETE, or NONE.

Candidate retrieval uses the same BM25 + vector hybrid search that powers
recall. The BM25 leg queries `memories_fts` with the fact's content as the
full-text query; scores are normalized to [0, 1] via `1 / (1 + |score|)`.
The vector leg embeds the fact content and calls `vectorSearch` against the
embeddings table. Results from both legs are merged by ID, then combined
with a weighted sum: `alpha × vector + (1 - alpha) × bm25` when both legs
returned a score, or the single available score otherwise. Candidates below
`min_score` are dropped. The top 5 are fetched from the memories table.

When no candidates are found, the engine immediately proposes ADD without an
LLM call, using the fact's own confidence as the proposal confidence and a
fixed reason string.

When candidates exist, the decision prompt presents the fact and a numbered
list of candidates with their IDs, types, and content. The model is asked
to return a JSON object with `action`, `targetId` (required for UPDATE and
DELETE), `confidence`, and `reason`. The response is parsed with the same
`<think>`-strip and fence-removal logic as extraction.

Validation on the decision output ensures that UPDATE and DELETE decisions
reference an ID that actually appears in the candidate set. Proposals with
missing or hallucinated IDs are dropped with a warning. An empty `reason`
string is also rejected.

The function is named `runShadowDecisions` regardless of mode — "shadow"
here means the function itself makes no writes. Whether the proposals are
applied or merely recorded is a concern of the worker that calls this
function.


Controlled Writes
---

When controlled-write mode is active, the worker applies ADD decisions
inside a single `withWriteTx` call after all LLM and embedding work has
completed. The write path is implemented in `applyPhaseCWrites`.

Before entering the transaction, the worker pre-fetches embeddings for all
ADD proposals in parallel. Each fact content is passed through
`normalizeAndHashContent` to compute a `contentHash`, and the storage
content (original casing) and hash are used as the key for caching the
vector. The embedding fetch is intentionally outside the transaction lock.

Inside the transaction, each ADD proposal passes through a sequence of
safety gates. First, the fact's confidence is compared to
`minFactConfidenceForWrite` (default 0.7); facts below this threshold are
skipped with reason `low_fact_confidence`. Second, the normalized content
is checked for zero length; empty facts are skipped with reason
`empty_fact_content`. Third, the `content_hash` is checked against the
memories table to detect exact duplicates — both at the pre-insert check
and defensively on UNIQUE constraint collision. Duplicates are recorded with
the existing memory's ID and counted as `deduped`.

For facts that clear all gates, `txIngestEnvelope` creates the memory row
in a single insert, with `who` set to `pipeline-v2`, `why` to
`extracted-fact`, and the pipeline's extraction model name in
`extractionModel`. If a pre-fetched embedding vector is available for this
content hash, it is upserted into the embeddings table in the same
transaction.

Audit records are written for every proposal in every outcome: ADD
(created), ADD (deduped), ADD (skipped), NONE (recorded), and destructive
(blocked). Each record lands in `memory_history` with enough metadata to
reconstruct the decision context: proposal action, fact content, confidence,
the source memory ID, the extraction model, and fact and entity counts.

The contradiction detector runs on UPDATE and DELETE proposals before they
are blocked. It tokenizes both the fact content and the target memory's
content, checks for lexical overlap of at least two tokens, and then looks
for either a negation-polarity difference (one has a negation token, the
other doesn't) or an antonym pair conflict (enabled/disabled, allow/deny,
etc.). Proposals that trigger the detector are flagged `reviewNeeded: true`
in their audit record.


Content Normalization
---

All content passes through `normalizeAndHashContent` before storage or
hashing. The function is deterministic and produces three derived values.

`storageContent` is the text after trimming and whitespace collapsing
(`/\s+/g → " "`). This is what gets written to the database. Original
casing is preserved.

`normalizedContent` takes `storageContent`, lowercases it, and strips
trailing punctuation (`[.,!?;:]+$`). This is used for FTS indexing and as
the hash basis when non-empty.

`contentHash` is a SHA-256 digest of the hash basis (normalized content if
non-empty, otherwise lowercased storage content). This 64-character hex
string is the deduplication key. Upserts on the embeddings table use it as
the unique key, and memory inserts check it to avoid exact-content
duplicates.


Knowledge Graph
---

When `graphEnabled` is true, extracted entity triples are persisted to a
set of graph tables alongside the main fact writes. This happens in a
**separate** transaction immediately after the main write transaction
commits. Graph persistence failure is non-fatal — it logs a warning but
never reverts the fact extraction results.

Entities are stored in the `entities` table with `name` (original casing),
`canonical_name` (lowercase, whitespace-normalized), `entity_type`, and
`mentions` (an integer count). New entities are inserted; existing entities
(matched by `canonical_name`) have their `mentions` counter incremented.
UNIQUE constraint collisions on the `name` column are handled gracefully by
falling back to the existing row and incrementing mentions there.

Relations are stored in the `relations` table linking two entity rows by
`source_entity_id`, `target_entity_id`, and `relation_type`. The `strength`
field is fixed at 1.0 for all pipeline-extracted relations. When a relation
already exists (same source, target, and type), `mentions` is incremented
and `confidence` is updated via a running average:
`(old_avg × n + new_confidence) / (n + 1)`.

Every source and target entity is linked back to the originating memory row
via `memory_entity_mentions`. The link stores `mention_text` (the raw
string before canonicalization) and `confidence`. Inserts use
`INSERT OR IGNORE` so re-processing the same memory is idempotent.


Graph-Augmented Search
---

At query time, when `graphEnabled` is true and the caller requests a graph
boost, `getGraphBoostIds` is called synchronously against the read database.
The function returns a set of memory IDs that should receive a score boost
in the final recall ranking.

The lookup proceeds in three steps. First, query tokens (2+ character
alphanumeric runs, lowercased) are matched against `canonical_name LIKE ?`
for each token, with results ordered by `mentions` descending and capped at
20 entity hits. Second, the matched entity IDs are expanded one hop through
the `relations` table in both directions (source and target), collecting up
to 50 additional neighbor entity IDs. Third, the expanded entity ID set is
joined through `memory_entity_mentions` to collect up to 200 distinct
non-deleted memory IDs.

The entire function is deadline-bounded. A `Date.now()` cutoff is checked
after each step; if the deadline is exceeded, the function returns whatever
it has accumulated so far with `timedOut: true`. On any exception, it
returns an empty result. There is no degradation in recall correctness —
graph boosting is always additive.

The boost weight (default 0.15) is applied by the search layer on top of
the hybrid BM25 + vector score. IDs in the graph-linked set receive a score
increment of `graphBoostWeight`.


Worker Model
---

The extraction pipeline runs as a polling worker loop. A single
`startWorker` call starts a `setTimeout`-chain tick loop that leases one
job per tick from the `memory_jobs` table, processes it, and reschedules
itself. The use of `setTimeout` chains rather than `setInterval` allows
dynamic delay adjustment via exponential backoff on failure.

Job leasing is atomic. The tick calls `accessor.withWriteTx` to both select
and update the job row in one transaction: `SELECT ... LIMIT 1` on pending
extract jobs ordered by `created_at`, immediately followed by an `UPDATE`
setting `status = 'leased'`, `leased_at`, and incrementing `attempts`. This
ensures no two workers can lease the same job even if multiple processes
were running.

On failure, a job's `attempts` counter is already incremented (happens
during lease). If `attempts >= max_attempts` (default 3), the job is
moved to status `dead`; otherwise it returns to `pending` for retry on the
next tick. A dead job stays in the table for audit and cleanup purposes.

Job deduplication is enforced at enqueue time: `enqueueExtractionJob` checks
for any existing job for the same `memory_id` with status `pending` or
`leased` before inserting a new one.

A stale lease reaper runs on a fixed 60-second `setInterval`. Any job with
`status = 'leased'` and `leased_at` older than `leaseTimeoutMs` (default
300,000 ms / 5 minutes) is reset to `pending`. This handles worker crashes
that leave jobs leased indefinitely.

Backoff state tracks consecutive failures. On zero failures, the tick
interval is `workerPollMs` (default 2,000 ms). Each failure doubles the
delay (starting from 1,000 ms base) up to a 30,000 ms cap, with up to
500 ms of random jitter added.


Document Ingest
---

The document worker processes `document_ingest` jobs from the same
`memory_jobs` table. It runs as a fixed-interval polling loop separate from
the extraction worker, defaulting to 10,000 ms between ticks.

A document ingest job carries a `document_id` rather than a `memory_id`.
The referenced row in the `documents` table carries the source content and
type. Two source types are supported: `url` (content fetched via HTTP) and
anything else (content read from `raw_content`). URL fetch is bounded by
`documentMaxContentBytes` (default 10 MB). If the HTTP response provides a
page title and the document row has none, it is backfilled.

Processing advances through explicit status transitions recorded in the
`documents` table: `extracting` → `chunking` → `embedding` → `indexing`
→ `done`. These transitions serve as progress indicators visible via the
API.

Chunking splits the extracted content into overlapping windows.
`documentChunkSize` (default 2,000 chars) sets the window size;
`documentChunkOverlap` (default 200 chars) sets how many characters each
window shares with the previous one. A document shorter than one chunk is
not split.

Each chunk is independently embedded (outside any transaction), normalized
and hashed, deduplication-checked against existing memories already linked
to this document via `document_memories`, and then written as a memory row
in its own transaction. Embedding calls and write transactions alternate for
each chunk rather than batching. The chunk memory row has `type =
'document_chunk'`, `importance = 0.3`, and is tagged with the document
title if available.

The chunk-to-document relationship is recorded in `document_memories` with
the chunk index. This table allows the document's chunks to be enumerated
or deleted as a unit.

The document worker uses the same `workerMaxRetries` limit as the
extraction worker. On exhaustion, the document row status is set to
`failed` with the error string recorded.


Retention Worker
---

The retention worker purges expired data on a periodic schedule (default
6-hour interval). It runs independently of the extraction pipeline and is
started whenever the pipeline is active or as a standalone service for
users who don't run the full extraction pipeline.

Purges follow a strict ordering to maintain referential safety:

1. **Graph links** — `memory_entity_mentions` rows for memories that are
   soft-deleted and past the tombstone retention window are deleted. Entity
   mention counts are decremented; entities that reach zero mentions are
   orphaned and deleted along with their dangling relation rows.

2. **Embeddings** — Embedding rows for the same expired memories are
   deleted.

3. **Tombstones** — The memory rows themselves are hard-deleted. The
   SQLite `memories_ad` trigger handles FTS cleanup automatically.

4. **History** — `memory_history` rows older than the history retention
   window are purged.

5. **Completed jobs** — `memory_jobs` rows with `status = 'completed'`
   and `completed_at` older than the completed job retention window are
   deleted.

6. **Dead jobs** — `memory_jobs` rows with `status = 'dead'` and
   `failed_at` older than the dead job retention window are deleted.

Each step runs in its own short `withWriteTx` to avoid holding a write
lock across the full sweep. Each step is also batch-limited to 500 rows
per sweep to bound write latency. If more rows than the batch limit exist,
they will be caught in subsequent sweeps.

Default retention windows: tombstones 30 days, history 180 days, completed
jobs 14 days, dead jobs 30 days.


Maintenance Worker
---

The maintenance worker performs autonomous diagnostics and, optionally,
self-repair. It is governed by `autonomousEnabled` and `autonomousFrozen`.
If `autonomousEnabled` is false or `autonomousFrozen` is true, the interval
never starts, though the worker's `tick()` method remains callable for
on-demand inspection.

Each maintenance cycle runs three phases. First, `getDiagnostics` produces
a `DiagnosticsReport` that captures queue health (dead rate, stale lease
count), index health (FTS row count vs active memory count), and storage
health (tombstone ratio). A composite score in [0, 1] summarizes overall
health.

Second, `buildRecommendations` translates the report into a list of repair
actions:
- `requeueDeadJobs` when the dead job rate exceeds 1%.
- `releaseStaleLeases` when stale leases are detected.
- `checkFtsConsistency` when the FTS row count does not match active
  memories.
- `triggerRetentionSweep` when tombstones exceed 30% of total memories.

Third, if `maintenanceMode` is `observe`, the recommendations are logged and
the cycle returns. If `maintenanceMode` is `execute`, each recommendation
is executed through the corresponding repair action, subject to rate
limiting (cooldown and hourly budget per action type). After all repairs
run, diagnostics are re-evaluated and the health score delta is recorded.

The halt tracker prevents the maintenance worker from spinning on ineffective
repairs. Each repair action tracks consecutive non-improving runs. After 3
consecutive runs that do not improve the health score, the action is halted
for the lifetime of the worker. The tracker resets when a cycle produces no
recommendations (i.e., health is good).


Provider Abstraction
---

All LLM calls go through an `LlmProvider` interface with two methods:
`generate(prompt, opts?)` returning a `Promise<string>`, and `available()`
returning a `Promise<boolean>`.

The only shipped implementation is `OllamaProvider`, which calls the Ollama
HTTP API at `POST /api/generate` with `stream: false`. The default base URL
is `http://localhost:11434` and the default model is `qwen3:4b`. Each
`generate` call sets an `AbortController` timeout (default 45,000 ms) and
throws a descriptive error on abort. HTTP errors surface the status code and
the first 200 characters of the response body. The `available` check uses a
3-second timeout against `GET /api/tags`.

The interface is intentionally minimal — no streaming, no chat history, no
tool use. Future providers (cloud APIs, other local runtimes) can be added
by implementing `LlmProvider` and passing the instance to `startWorker`.


Optional Reranking
---

After baseline hybrid search returns a scored candidate list, an optional
reranking pass can reorder the top-N entries using a cross-encoder or other
scoring model. Reranking is disabled by default (`rerankerEnabled: false`).

The `rerank` function accepts a query string, a mutable candidate list, a
`RerankProvider` callback, and a `RerankConfig`. It slices the list at
`topN` (default 20), passes the head to the provider, and appends the
untouched tail to the result. If the provider call exceeds `timeoutMs`
(default 2,000 ms) or throws, the original ordering is returned unchanged
via a `Promise.race` against a timeout promise. There is no secondary
attempt.

The `noopReranker` pass-through is provided for testing. Custom providers
implement the `RerankProvider` signature
`(query, candidates, cfg) => Promise<RerankCandidate[]>` and can call any
scoring backend.


Configuration Reference
---

All pipeline config lives under `memory.pipelineV2` in `agent.yaml` (or
`AGENT.yaml` / `config.yaml`). The full set of keys with their defaults:

```
enabled                     false
shadowMode                  false
allowUpdateDelete           false
graphEnabled                false
autonomousEnabled           false
mutationsFrozen             false
autonomousFrozen            false

extractionModel             "qwen3:4b"
extractionTimeout           45000   (ms, range 5000–300000)

workerPollMs                2000    (ms, range 100–60000)
workerMaxRetries            3       (range 1–10)
leaseTimeoutMs              300000  (ms, range 10000–600000)

minFactConfidenceForWrite   0.7     (fraction 0.0–1.0)

graphBoostWeight            0.15    (fraction 0.0–1.0)
graphBoostTimeoutMs         500     (ms, range 50–5000)

rerankerEnabled             false
rerankerModel               ""
rerankerTopN                20      (range 1–100)
rerankerTimeoutMs           2000    (ms, range 100–30000)

maintenanceIntervalMs       1800000 (30 min, range 60000–86400000)
maintenanceMode             "observe"  ("observe" | "execute")
repairReembedCooldownMs     300000  (ms, range 10000–3600000)
repairReembedHourlyBudget   10      (range 1–1000)
repairRequeueCooldownMs     60000   (ms, range 5000–3600000)
repairRequeueHourlyBudget   50      (range 1–1000)

documentWorkerIntervalMs    10000   (ms, range 1000–300000)
documentChunkSize           2000    (chars, range 200–50000)
documentChunkOverlap        200     (chars, range 0–10000)
documentMaxContentBytes     10485760 (10 MB, range 1024–104857600)
```

A minimal configuration to enable the pipeline in shadow mode:

```yaml
memory:
  pipelineV2:
    enabled: true
    shadowMode: true
```

To enable controlled writes with graph support:

```yaml
memory:
  pipelineV2:
    enabled: true
    graphEnabled: true
    minFactConfidenceForWrite: 0.75
```

To enable autonomous maintenance in execute mode:

```yaml
memory:
  pipelineV2:
    enabled: true
    autonomousEnabled: true
    maintenanceMode: execute
```
