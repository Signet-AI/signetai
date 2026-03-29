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

Pipeline v2 exists because the original [[memory]] system was purely reactive:
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

This is substrate work. The pipeline's job is to turn raw interaction
data into cleaner, more structured material the rest of the system can
use for retrieval, repair, and eventually learned context selection.

The central constraint governing every design decision here is: **no LLM
calls inside write-locked transactions.** SQLite write locks are exclusive,
and a blocking HTTP call to Ollama inside one would stall the entire [[daemon]].
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

This stage is intentionally conservative. It is better understood as a
proposal and curation layer than as autonomous semantic rewriting. Its
output improves memory quality and auditability; it does not eliminate
the need for downstream relevance learning.

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


Inline Entity Linker
---

Before any async pipeline job runs, the inline entity linker
(`packages/daemon/src/inline-entity-linker.ts`) performs a fast,
synchronous extraction pass at memory write time. This is the "fast
path" that complements the "deep path" of LLM-based extraction.

The linker runs without an LLM call. It scans the memory's content
text using regex patterns to extract entities, aspects, and attributes.
Extracted entities are inserted or matched against `canonical_name` in
the `entities` table, and corresponding `memory_entity_mentions` and
`entity_attributes` rows are written in the same transaction as the
memory itself.

The key benefit is immediacy: entities are queryable via knowledge
graph traversal the moment the memory is committed — there is no
waiting for the async extraction worker to pick up the job. When the
extraction pipeline processes the same memory later, it performs deeper
analysis: supersession detection, dependency synthesis, and confidence
calibration. The async pass may refine or extend the entities the
inline linker created, but the fast path ensures baseline graph
connectivity is never delayed by queue depth or LLM availability.

Because the linker runs inside the write transaction, it must be fast
and deterministic. There are no network calls, no LLM inference, and
no blocking I/O — only regex matching and SQLite writes.


Structural Classification
---

After extraction writes facts to the database, the structural classification
worker (`structural-classify.ts`) runs a second LLM pass to assign each
extracted fact to its entity's aspect hierarchy. Jobs are enqueued as
`structural_classify` entries in `memory_jobs` and processed by a separate
polling worker that batches by `entity_id` — all facts for the same entity
in one LLM call.

The prompt presents the entity name, type, existing aspects, and suggested
aspect names (from `ASPECT_SUGGESTIONS` keyed by entity type). The LLM
returns a JSON array of `{i, aspect, kind, new}` objects. Each fact is
assigned to a named aspect and classified as either `attribute` or
`constraint`. Aspects are upserted into `entity_aspects` on
`(entity_id, canonical_name)` conflict. The `entity_attributes` row written
during extraction has its `aspect_id` and `kind` filled in.

When an entity's type was not determinable during extraction (stored as
`"extracted"`), the classify prompt also asks the LLM to infer the type.
If a valid canonical type is returned (`person`, `project`, `system`,
`tool`, `concept`, `skill`, `task`, or `unknown`), the `entities` row is
updated in the same transaction.

The worker configuration lives under `structural` in the pipeline config:
`pollIntervalMs` (how often to check for pending jobs) and
`classifyBatchSize` (max facts per entity per LLM call).

For details on the knowledge graph persistence stage, see
[KNOWLEDGE-GRAPH.md](./KNOWLEDGE-GRAPH.md).


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


Aspect Feedback
---

After recall, `aspect-feedback.ts` feeds behavioral signals back to the
knowledge graph by measuring FTS overlap between retrieved content and
entity aspects. The function `applyFtsOverlapFeedback` is called at
session end with the session key and agent ID.

The feedback loop operates as follows. Memories that received at least one
FTS hit during the session (tracked in `session_memories.fts_hit_count`) are
looked up. For each confirmed memory, the `entity_attributes` table is
queried to find its parent `aspect_id`. Confirmation counts are summed per
aspect, and each aspect's `weight` column is incremented by
`delta × confirmations`, clamped to `[minWeight, maxWeight]`. This updates
which aspects were structurally "correct" for the session — aspects whose
memories were actively searched for gain weight, aspects whose memories were
ignored do not.

A separate `decayAspectWeights` function handles time-based decay. Aspects
that have not been updated in more than `staleDays` days have their weight
reduced by `decayRate`, floored at `minWeight`. Session decay is governed
by a counter so it runs every N sessions rather than on every call.

Telemetry is accumulated in an in-process snapshot (`getFeedbackTelemetry`)
and exposed on the pipeline status endpoint: `feedbackAspectsUpdated`,
`feedbackFtsConfirmations`, `feedbackDecayedAspects`, and
`feedbackPropagatedAttributes`.


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
`documentMaxContentBytes` (default 10 MB). The URL fetcher accepts responses
with content types `text/html`, `text/*`, `application/json`, and
`application/xml`. For HTML, it extracts the page title and strips `<script>`
and `<style>` tags before passing text to the chunker. Non-matching content
types are rejected. The HTTP request timeout is 30 seconds, independent of
the byte limit. If the HTTP response provides a page title and the document
row has none, it is backfilled.

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

Two implementations are shipped:

**OllamaProvider** calls the Ollama HTTP API at `POST /api/generate` with
`stream: false`. The default base URL is `http://localhost:11434` and the
default model is `qwen3:4b` (deprecated — see below). `nemotron-3-nano:4b` is the
preferred local Ollama model going forward; Nemotron's superior reasoning produces
better extraction results and `qwen3:4b` will be removed in a future update. Each `generate` call sets an `AbortController`
timeout (default 45,000 ms) and throws a descriptive error on abort. HTTP
errors surface the status code and the first 200 characters of the response
body. The `available` check uses a 3-second timeout against `GET /api/tags`.
For live prompt harness commands, see
`packages/daemon/src/pipeline/README.md`.

**ClaudeCodeProvider** invokes the Claude Code CLI as a subprocess:
`claude -p <prompt> --model <model> --no-session-persistence --output-format text`.
The default model is `haiku`. Timeout is 60,000 ms. This provider is
available as a fallback when Ollama is not running locally but the
Claude Code CLI is present on PATH.

The interface is intentionally minimal — no streaming, no chat history, no
tool use. Future providers can be added by implementing `LlmProvider` and
passing the instance to `startWorker`.


Predictor Scorer Integration
---

The predictive memory scorer hooks into the pipeline at two lifecycle
points.

**Session-start (scoring):** During `session-start` hook processing, after
the baseline candidate pool is assembled via hybrid search and graph
traversal, `runPredictorScoring` is called with the candidate set and their
feature vectors. The sidecar (Rust predictor process) re-ranks candidates
using its trained model. If the predictor is unavailable or in cold-start,
baseline ordering is used unchanged. The fused scores are used to re-sort
the final injection list. A predictor status line is appended to the
injected context when the predictor is active.

**Session-end (training pairs):** After the continuity scoring pass writes
per-memory relevance scores to `session_memories`, `runSessionComparison`
is called in the summary worker. It builds comparison pairs from the session
— injected memories with their final relevance scores — and writes them to
`predictor_comparisons`. The EMA health signal and drift detector are updated
based on the session's NDCG@10 score.

In the current config defaults, the predictor path is enabled, but it
still fails open. During cold start, sidecar unavailability, or explicit
`predictor.enabled: false`, both hooks fall back to baseline ordering and
the baseline pipeline remains unchanged.


Optional Reranking
---

After baseline hybrid search returns a scored candidate list, an optional
reranking pass can reorder the top-N entries using a cross-encoder or other
scoring model. Reranking is disabled by default (`reranker.enabled: false`).

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

### Embedding-Based Reranker

An embedding-based reranker implementation is provided in
`reranker-embedding.ts`. It re-scores candidates using full-content cosine
similarity against the query embedding vector. Cached embeddings from the
database are used when available, avoiding extra provider calls in most
cases.

The factory function `createEmbeddingReranker` takes a `DbAccessor` and
a pre-computed `queryVector` (Float32Array) and returns a `RerankProvider`.
For each candidate with a cached embedding, the score is blended:
`0.7 × original_score + 0.3 × cosine_similarity`. Candidates without a
cached embedding keep their original score. Results are sorted by blended
score descending. This reranker is fast (no LLM call), deterministic, and
catches cases where BM25 candidates were not vector-compared at all.


Semantic Contradiction Detection
---

The pipeline includes two layers of contradiction detection for UPDATE and
DELETE proposals.

**Syntactic detection** (in `worker.ts`) is the fast path. It tokenizes
both the fact content and the target memory's content, checks for lexical
overlap of at least two tokens, then looks for either a negation-polarity
difference (one has a negation token, the other doesn't) or an antonym
pair conflict (enabled/disabled, allow/deny, etc.).

**Semantic detection** (in `contradiction.ts`) is the slow path. It uses
an LLM to catch semantic contradictions like "uses PostgreSQL" vs
"migrated to MongoDB". It is only called for update proposals with lexical
overlap >= 3 tokens where syntactic detection returned false. The LLM is
prompted to return a JSON object with `contradicts` (boolean), `confidence`
(0–1), and `reasoning` (string).

Semantic contradiction detection is gated by `semanticContradictionEnabled`
(default `false`). When enabled, the LLM call uses a configurable timeout
controlled by `semanticContradictionTimeoutMs` (default 45 seconds, range
5s–300s). On timeout or parse failure, the result defaults to "no
contradiction" — the check is advisory and never blocks a proposal.

These same detection primitives are reused by the retroactive supersession
system (`supersession.ts`), which applies contradiction detection to sibling
attributes on the same entity/aspect rather than to UPDATE/DELETE proposals.
See the [retroactive supersession spec](./specs/planning/retroactive-supersession.md)
and [KNOWLEDGE-GRAPH.md](./KNOWLEDGE-GRAPH.md#retroactive-supersession) for
details.

```yaml
memory:
  pipelineV2:
    semanticContradictionEnabled: false
    semanticContradictionTimeoutMs: 45000  # ms, range 5000–300000
```


URL Fetcher
---

The document ingest pipeline fetches web content through `url-fetcher.ts`.
The fetcher provides timeout and size guards, and strips HTML to plain text
for downstream chunking and embedding.

`fetchUrlContent(url, opts?)` accepts a URL and optional `FetchOptions`
(`timeoutMs` default 30,000 ms, `maxBytes` default 10 MB). It performs
a pre-flight size check from the `Content-Length` header, then stream-reads
the response body with a running byte counter. If total bytes exceed
`maxBytes` during streaming, the fetch is aborted.

Supported content types: `text/html`, `text/*`, `application/json`,
`application/xml`. Binary and unsupported types are rejected with an
error. For HTML responses, `<script>` and `<style>` blocks are stripped
entirely, remaining tags are removed, common HTML entities are decoded,
and the page title is extracted from the first `<title>` tag. The result
includes `content`, `contentType`, optional `title`, and `byteLength`.


Embedding Tracker
---

The embedding tracker (`packages/daemon/src/embedding-tracker.ts`) is a
background polling loop that detects stale or missing embeddings and
refreshes them in small batches. It is separate from the extraction
pipeline and runs alongside it.

Each cycle:

1. **Provider health check** — calls the embedding provider's health
   endpoint (uses existing 30-second cache). If the provider is
   unavailable, the cycle is skipped and `skippedCycles` is incremented.

2. **Stale detection query** — a read-only query finds memories where:
   - No embedding row exists (missing)
   - The embedding's `content_hash` differs from the memory's (stale)
   - The memory's `embedding_model` differs from the configured model
     (model switch)
   Results are ordered by `updated_at DESC` and capped at `batchSize`.

3. **Sequential embedding fetch** — each stale row's content is embedded
   one at a time, outside any transaction. Failed fetches increment the
   `failed` counter without aborting the cycle.

4. **Batch write** — all successful embeddings are upserted in a single
   `withWriteTx` call. For each result: stale embeddings are deleted by
   source (except the new hash), the new embedding row is upserted on
   `content_hash` conflict, the `vec_embeddings` virtual table is synced,
   and `embedding_model` is updated on the memory row.

The tracker uses `setTimeout` chains for natural backpressure. It
exposes a `getStats()` method returning `{ running, processed, failed,
skippedCycles, lastCycleAt, queueDepth }`.

Configuration lives under `embeddingTracker` in the pipeline config:

| Field | Default | Range | Description |
|-------|---------|-------|-------------|
| `enabled` | `true` | — | Master switch |
| `pollMs` | `5000` | 1000–60000 ms | Polling interval between cycles |
| `batchSize` | `8` | 1–20 | Max embeddings refreshed per cycle |


Session Checkpoints
---

Session checkpoints (`packages/daemon/src/session-checkpoints.ts`) capture
periodic snapshots of session state for continuity recovery. They store
a digest of the session's current focus, prompt count, memory queries,
and recent remembers.

Checkpoints are triggered by five event types:

- `periodic` — fired on a timer or prompt-count interval
- `pre_compaction` — fired when the harness signals context compaction
- `session_end` — fired when a session closes
- `agent` — fired by agent-initiated events
- `explicit` — fired by manual API calls

Each checkpoint row stores `session_key`, `harness`, `project`,
`project_normalized`, `trigger`, `digest`, `prompt_count`,
`memory_queries` (JSON array), and `recent_remembers` (JSON array).
Secrets are redacted before storage using pattern-based scrubbing
(Bearer tokens, API keys, base64 credential blobs, env variable values).

A buffered flush queue (`queueCheckpointWrite`) debounces writes at
2,500 ms intervals. If two triggers fire within the flush window for
the same session, queries and remembers are merged (union with caps:
20 queries, 10 remembers) and prompt counts are summed.

Per-session caps are enforced: when checkpoint count exceeds
`maxCheckpointsPerSession`, the oldest rows are deleted.

Digest formatters produce structured markdown for each trigger type:

- `formatPeriodicDigest` — project, prompt count, duration, recent
  prompts, memory activity
- `formatPreCompactionDigest` — same plus optional session context
- `formatSessionEndDigest` — same with total prompt count

Pruning is strict: `pruneCheckpoints(db, retentionDays)` hard-deletes
all checkpoints older than the retention window.

Configuration lives under `continuity` in the pipeline config:

| Field | Default | Range | Description |
|-------|---------|-------|-------------|
| `enabled` | `true` | — | Master switch |
| `promptInterval` | `10` | 1–1000 | Prompts between periodic checkpoints |
| `timeIntervalMs` | `900000` | 60s–1h | Time between periodic checkpoints (15 min) |
| `maxCheckpointsPerSession` | `50` | 1–500 | Per-session cap |
| `retentionDays` | `7` | 1–90 | Days before old checkpoints are pruned |
| `recoveryBudgetChars` | `2000` | 200–10000 | Max characters for recovery digest |


Continuity Scoring
---

At session end, the summary worker scores how effectively injected
memories were used during the session. The scoring flow:

1. **Load injected memories** — queries `session_memories` joined with
   `memories` for the session, filtered to `was_injected = 1`, ordered
   by `rank ASC`.

2. **LLM evaluation** — the injected memories and session transcript are
   sent to the LLM, which returns a JSON object with `score` (0–1),
   `confidence` (0–1), `memories_used` (count), `novel_context_count`,
   `reasoning`, and `per_memory` (array of `{ id, relevance }`).

3. **Per-memory relevance** — each entry in `per_memory` uses an 8-char
   prefix of the memory ID. The prefix is resolved to the full UUID via
   a map built from the injected memories. The `relevance_score` column
   on `session_memories` is updated for each matched memory.

4. **Score persistence** — the overall score, confidence, memory counts,
   reasoning, and continuity reasoning are written to `session_scores`.
   The `memories_recalled` field uses the actual injected count (not zero).

The scoring handles edge cases gracefully: markdown fences and `<think>`
blocks are stripped from LLM output, missing optional fields default to
zero/empty, out-of-range scores are clamped to [0, 1], and sessions
without `session_memories` data still get a valid score row.


Prospective Indexing (Hints)
---

After a memory is written, a `prospective_index` job is enqueued in
`memory_jobs`. The hints worker
(`packages/daemon/src/pipeline/prospective-index.ts`) processes these
jobs as a background polling loop, generating hypothetical future
queries — "hints" — that the memory might answer.

The approach is inspired by Kumiho (arXiv:2603.17244) prospective
indexing. Rather than relying solely on the memory's literal content
for retrieval, the pipeline asks the extraction LLM to imagine what
questions a user might ask that this memory would help answer. The LLM
returns up to `hints.max` (default 5) hint strings per memory.

Hints are stored in the `memory_hints` table, each linking back to the
source `memory_id`. A companion `memory_hints_fts` FTS5 index makes
hints searchable with BM25 scoring.

At search time, the hints FTS5 table is queried alongside the content
FTS5 table. When a hint matches, its BM25 score is merged with the
memory's content score using `Math.max` — a hint match elevates its
parent memory but does not stack additively with the content score.
This prevents a memory with both a content match and a hint match from
being double-boosted; instead, the stronger of the two signals wins.

Configuration lives under `hints` in the pipeline config:

| Field | Default | Range | Description |
|-------|---------|-------|-------------|
| `enabled` | `false` | — | Master switch |
| `max` | `5` | 1–20 | Max hints generated per memory |
| `timeout` | `45000` | 5000–300000 ms | LLM generation timeout |
| `poll` | `5000` | 1000–60000 ms | Worker polling interval |

```yaml
memory:
  pipelineV2:
    hints:
      enabled: true
      max: 5
```


Post-Fusion Dampening
---

After hybrid recall combines traversal, FTS, and vector results into a
fused score list, the dampening pipeline
(`packages/daemon/src/pipeline/dampening.ts`) applies three corrections
before the final sort. The goal is to break score bunching where relevant
and irrelevant results land at similar fusion scores.

**Stage 1: Gravity dampening** penalizes results that arrived via a
semantic path (vector, hybrid, or traversal) but share zero query-term
overlap with the actual content. These are "semantic hallucinations" —
the embedding model thinks they are related but the surface words have
nothing in common. Results with a score above 0.3 from a semantic source
are tokenized (lowercase, stop-word stripped) and checked against the
query tokens. Zero overlap halves the score (default `gravityPenalty:
0.5`).

**Stage 2: Hub dampening** penalizes results whose linked entities are
all high-degree hubs. Entity mention counts from
`memory_entity_mentions` are sorted to compute a P90 threshold (default
`hubPercentile: 0.9`). If every entity linked to a memory sits above
that threshold, the memory's score is multiplied by `hubPenalty` (default
0.7). This prevents popular entities like "Signet" or "Nicholai" from
dominating recall when the query targets something specific.

**Stage 3: Resolution boost** rewards actionable, specific memories.
Memories with type `constraint` or `decision` receive a 1.2x multiplier
(default `resolutionBoost: 1.2`). Other memories with temporal anchors
(ISO dates or month names) receive a lighter boost: `1 + (boost - 1) *
0.5`, which is 1.1x at default settings. Short or vague content (under
50 characters) receives no boost.

All three stages are independently togglable. After dampening, results
are re-sorted by adjusted score descending.


Lossless Session Transcripts
---

After the summary worker extracts facts from a session, it also writes
the raw transcript to the `session_transcripts` table (migration 040).
This preserves completeness — extraction creates the search surface, but
the full conversation text is never lost.

The table schema (`session_key TEXT PRIMARY KEY, content TEXT NOT NULL,
harness TEXT, project TEXT, agent_id TEXT, created_at TEXT`) is indexed
on `project` and `created_at`. The summary worker writes one row per
session via `INSERT OR IGNORE`, keyed on `session_key`.

The `/api/memory/remember` endpoint accepts an optional `transcript`
field. When present and a `sourceId` (session key) is available, the
transcript is written to `session_transcripts` in a separate write
transaction. This allows connectors to push the raw conversation text
alongside memories without waiting for session-end summary processing.

At recall time, the `/api/memory/recall` endpoint supports `expand:
true`. When set, session keys from the result set are batch-looked up
in `session_transcripts` and the transcript content is joined into the
response. This lets callers retrieve the full conversation context
behind a recalled memory without a separate API call.


Canonical Markdown Lineage and MEMORY.md Projection
---

Rolling history now has an explicit authority split.

Canonical historical content lives as immutable markdown artifacts in
`$SIGNET_WORKSPACE/memory/`:

- `--transcript.md`
- `--summary.md`
- `--compaction.md`

Each session also has one mutable `--manifest.md` file. The manifest is the
only artifact that may gain new links after session end, such as a later
`compaction_path`.

`MEMORY.md` is no longer canonical history. It is a rebuildable projection over:

- durable memory rows for the Tier 1 head
- persisted thread heads plus temporal DAG state for Tier 2
- canonical artifact frontmatter for the strict 30-day session ledger

The renderer is programmatic. LLM output in this lane is limited to the single
`memory_sentence` stored in summary and compaction frontmatter, with a
deterministic fallback when the quality gate fails. The final `MEMORY.md`
projection always includes:

- `## Global Head (Tier 1)`
- `## Thread Heads (Tier 2)`
- `## Session Ledger (Last 30 Days)`
- `## Open Threads`
- `## Durable Notes & Constraints`
- `## Temporal Index`

Session-end jobs write canonical transcript artifacts immediately, then the
summary worker writes the matching canonical summary artifact for normal
`session_end` jobs. `compaction-complete` writes a canonical compaction
artifact and backfills the session manifest. Mid-session
`session-checkpoint-extract` jobs remain DB-native and only write checkpoint
nodes into `session_summaries`.


Decision Auto-Protection
---

The inline entity linker (`packages/daemon/src/inline-entity-linker.ts`)
runs a 14-pattern regex battery on memory content at write time. When
decision language is detected, extracted attributes are promoted from
`kind='attribute'` to `kind='constraint'` with `importance=0.85`
(default attributes use `importance=0.5`).

The patterns cover common decision-indicating phrases:

- "chose/chosen to use X over Y", "decided to/on/against"
- "switched from/to", "migrated from/to/away"
- "picked X over Y", "went with", "sticking with"
- "committed to", "settled on", "will use/go with/stick with"
- "prefers X over/instead/rather", "adopted"
- "architecture decision", "design decision"

The detection function `isDecisionContent` returns true if any pattern
matches. The linker then sets `kind='constraint'` on all attributes
extracted from that memory's clauses, ensuring they receive the
resolution boost during dampening (see Post-Fusion Dampening, Stage 3)
and always surface in recall per INDEX.md invariant 5: constraints must
be retrievable.

This is a write-time classification — no LLM call is involved. The
regex battery is fast and deterministic, consistent with the inline
linker's contract of no network calls inside the write transaction.


Configuration Reference
---

All pipeline config lives under `memory.pipelineV2` in `agent.yaml` (see
[[configuration]]). The config uses a nested structure with grouped
sub-objects. Legacy flat keys are also supported for backward
compatibility (nested keys take precedence).

### Top-level flags

```
enabled                         true
shadowMode                      false
mutationsFrozen                 false
semanticContradictionEnabled        false
semanticContradictionTimeoutMs      45000   # ms, range 5000–300000
telemetryEnabled                    false
```

### Nested sub-objects and defaults

Extraction safety note:

- intended usage is Claude Code on Haiku, Codex CLI on GPT Mini with a
  Pro/Max subscription, or local Ollama with at least `qwen3:4b`
- set `provider: none` on a VPS if you do not want background
  extraction
- remote API extraction can accumulate extreme fees quickly
  (`anthropic`, `openrouter`, or remote OpenCode routes)

```yaml
extraction:
  provider: ollama               # "none" | "ollama" | "claude-code" | "codex" | "opencode" | "anthropic" | "openrouter" | "command"
  model: qwen3:4b
  timeout: 90000                 # ms, range 5000–300000
  minConfidence: 0.7             # fraction 0.0–1.0
  command:                       # required when provider: command
    bin: node
    args: ["./extract.mjs", "--transcript", "$TRANSCRIPT", "--session", "$SESSION_KEY", "--agent", "$AGENT_ID"]
    # tokens: $TRANSCRIPT (temp file path), $SESSION_KEY, $PROJECT, $AGENT_ID, $SIGNET_PATH
    # keep bin/cwd fixed (or trusted $SIGNET_PATH/$AGENT_ID only); use args/env for session/project tokens
    # command stdout/stderr are ignored; command must write memories to Signet state directly
    # after command success, synthesis hooks can run when configured, but markdown/fact writes are skipped in command mode

synthesis:
  enabled: true
  provider: ollama               # same provider choices as extraction, except "command"
  model: qwen3:4b
  timeout: 120000                # ms, range 5000–300000
  # when omitted entirely, synthesis falls back to extraction provider/model
  # except extraction.provider=command, which falls back to synthesis defaults

worker:
  pollMs: 2000                   # ms, range 100–60000
  maxRetries: 3                  # range 1–10
  leaseTimeoutMs: 300000         # ms, range 10000–600000
  maxLoadPerCpu: 0.8             # load-per-CPU threshold, range 0.1–8.0
  overloadBackoffMs: 30000       # ms, range 1000–300000

graph:
  enabled: true
  boostWeight: 0.15              # fraction 0.0–1.0
  boostTimeoutMs: 500            # ms, range 50–5000

reranker:
  enabled: true
  model: ""
  topN: 20                       # range 1–100
  timeoutMs: 2000                # ms, range 100–30000

autonomous:
  enabled: true
  frozen: false
  allowUpdateDelete: true
  maintenanceIntervalMs: 1800000 # 30 min, range 60s–24h
  maintenanceMode: execute       # "observe" | "execute"

repair:
  reembedCooldownMs: 300000      # 5 min, range 10s–1h
  reembedHourlyBudget: 10        # range 1–1000
  requeueCooldownMs: 60000       # 1 min, range 5s–1h
  requeueHourlyBudget: 50        # range 1–1000
  dedupCooldownMs: 600000        # 10 min, range 10s–1h
  dedupHourlyBudget: 3           # range 1–100
  dedupSemanticThreshold: 0.92   # fraction 0.0–1.0
  dedupBatchSize: 100            # range 10–1000

documents:
  workerIntervalMs: 10000        # ms, range 1s–300s
  chunkSize: 2000                # chars, range 200–50000
  chunkOverlap: 200              # chars, range 0–10000
  maxContentBytes: 10485760      # 10 MB, range 1 KB–100 MB

guardrails:
  maxContentChars: 500           # range 50–100000
  chunkTargetChars: 300          # range 50–50000
  recallTruncateChars: 500       # range 50–100000

continuity:
  enabled: true
  promptInterval: 10             # range 1–1000
  timeIntervalMs: 900000         # 15 min, range 60s–1h
  maxCheckpointsPerSession: 50   # range 1–500
  retentionDays: 7               # range 1–90
  recoveryBudgetChars: 2000      # range 200–10000

telemetry:
  posthogHost: ""
  posthogApiKey: ""
  flushIntervalMs: 60000         # ms, range 5s–10min
  flushBatchSize: 50             # range 1–500
  retentionDays: 90              # range 1–365

embeddingTracker:
  enabled: true
  pollMs: 5000                   # ms, range 1s–60s
  batchSize: 8                   # range 1–20

hints:
  enabled: false
  max: 5                         # range 1–20
  timeout: 45000                 # ms, range 5000–300000
  poll: 5000                     # ms, range 1000–60000

dampening:
  gravityEnabled: true
  hubEnabled: true
  resolutionEnabled: true
  hubPercentile: 0.9             # fraction 0.0–1.0
  hubPenalty: 0.7                # fraction 0.0–1.0
  gravityPenalty: 0.5            # fraction 0.0–1.0
  resolutionBoost: 1.2           # multiplier
```

### Example configurations

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
    graph:
      enabled: true
    extraction:
      minConfidence: 0.75
```

To enable autonomous maintenance in execute mode:

```yaml
memory:
  pipelineV2:
    enabled: true
    autonomous:
      enabled: true
      maintenanceMode: execute
```

Full production configuration:

```yaml
memory:
  pipelineV2:
    enabled: true
    semanticContradictionEnabled: true
    extraction:
      provider: ollama
      model: qwen3:4b
    graph:
      enabled: true
    autonomous:
      enabled: true
      maintenanceMode: execute
    continuity:
      enabled: true
      promptInterval: 10
    embeddingTracker:
      enabled: true
      pollMs: 5000
```


---

Multi-Agent Pipeline Notes
---------------------------

When multiple agents share a daemon, the pipeline tags each extracted memory
with the requesting agent's ID. The `agent_id` is resolved from the
session-start hook request: if the caller provides `agentId` in the body it
is used directly; otherwise the daemon parses OpenClaw's session key format
(`agent:{id}:{rest}`) as a fallback.

Extracted memories default to `visibility = 'global'`. Callers that want
private memories must set `visibility = 'private'` explicitly in the
remember request or via `signet remember --private`.

The pipeline worker itself is agent-agnostic: it operates on the `memory_jobs`
queue and reads `agent_id` from each job record. Entity graph operations
(extraction, traversal, aspect updates) all pass `agent_id` through to
ensure knowledge is scoped to the correct agent.
