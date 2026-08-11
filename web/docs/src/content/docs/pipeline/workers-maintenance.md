---
title: "Workers and maintenance"
description: "How pipeline workers ingest, retain, maintain, embed, and route provider work."
---

## Worker Model

The legacy extraction/decision/escalation worker runtime and its threaded
variant are retired. Dreaming now owns all automatic semantic writes; no
runtime creates or leases `memory_jobs` `extract` work. The cross-entity dependency-synthesis worker
(`dependency-synthesis.ts`) was likewise retired — it wrote
`entity_dependencies` rows directly via `upsertDependency`, bypassing the
audited `create_link` path; Dreaming's audited `create_link` is now the
sole semantic dependency writer. The non-semantic workers (document ingest,
retention, maintenance, synthesis, prospective/hints) remain active. The
description below is retained for historical reference.

The extraction pipeline ran as a polling worker loop. A single
`startWorker` call started a `setTimeout`-chain tick loop that leased one
job per tick from the `memory_jobs` table, processed it, and rescheduled
itself. The use of `setTimeout` chains rather than `setInterval` allowed
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

The retired extraction queue no longer accepts new work. Startup terminalizes
each unfinished historical `extract` job so none is abandoned or left leased
forever. It preserves the source's existing provenance and `memory_kind`: only
already-episodic evidence is reachable by Dreaming, while derived rows remain
derived and are not re-ingested as source material.

Backoff state tracks consecutive failures. On zero failures, the tick
interval is `workerPollMs` (default 2,000 ms). Each failure doubles the
delay (starting from 1,000 ms base) up to a 30,000 ms cap, with up to
500 ms of random jitter added.

## Document Ingest

The document worker processes `document_ingest` jobs from the same
`memory_jobs` table. It runs as a fixed-interval polling loop,
defaulting to 10,000 ms between ticks.

The worker processes at most two documents concurrently across all
`startDocumentWorker()` instances in the daemon. Admission is checked before
leasing a `memory_jobs` row, so URL fetch, chunking, embedding, and indexing
cannot outrun the shared budget. A failed operation releases its slot before
retry handling runs, and the durable lease/recovery path remains responsible
for jobs interrupted by shutdown or process failure.

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

The document worker honors the `workerMaxRetries` limit. On exhaustion, the
document row status is set to `failed` with the error string recorded.

## Retention Worker

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

## Maintenance Worker

The maintenance worker performs autonomous diagnostics and, optionally,
self-repair. It is governed by `autonomous.enabled` and `autonomous.frozen`.
If `autonomous.enabled` is false or `autonomous.frozen` is true, the interval
never starts, though the worker's `tick()` method remains callable for
on-demand inspection.

Each maintenance cycle runs three phases. First, `getDiagnostics` produces
a `DiagnosticsReport` that captures queue health (dead rate, stale lease
count), index health (physical FTS document count vs canonical memory count), storage health
(tombstone ratio and SQLite page size), and graph health. A composite score in
[0, 1] summarizes overall health, and when graph is enabled the composite
status propagates graph degradation when the graph has flatlined across many
active memories.

Second, `buildRecommendations` translates the report into a list of repair
actions:
- `requeueDeadJobs` when the dead job rate exceeds 1%.
- `releaseStaleLeases` when stale leases are detected.
- `checkFtsConsistency` when the physical FTS document count does not match
  canonical memory rows, including retained tombstones.
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

### Queue Health and Repair (issue #901)

The live maintenance backlog is held in `memory_jobs`; the legacy
`QueueHealth` aggregate and retired `summary_jobs` queue are no longer active
work surfaces. Migration 117 drains historical summary jobs after preserving
any transcript payloads, and operators can inspect and repair `memory_jobs`
without treating retired extraction work as active.

`/api/diagnostics/queue` returns a structured per-queue report:

```json
{
  "timestamp": "...",
  "queues": {
    "memory":     { "pending": 0, "leased": 0, "completed": 0, "failed": 0, "dead": 0, "oldestAgeSec": 0, "oldestDeadAgeSec": 0, "lastError": null, "completeness": "exact" },
  },
  "oldestDeadSummaryJob":    { "id": "...", "harness": "...", "sessionKey": "...", "createdAt": "...", "attempts": 0, "error": null },
  "oldestDeadMemoryJob":     { "...": "..." },
  "thresholds": { "summaryDeadWarn": 50, "summaryDeadFail": 500, "summaryOldestPendingWarnSec": 300, "..." }
}
```

`signet status` renders the same live queues as a `Pipeline queues` block,
with each queue's `dead` and `oldest dead` highlighted when `dead > 0`.

Three repair commands cover the issue's "Suggested fix":

| CLI | HTTP action | Behavior |
| --- | --- | --- |
| `signet repair queue requeue [--ids …] [--tables …] [--older-than …] [--error-pattern …] [--apply]` | `requeue` | Reset matching dead rows to `pending`; reuses `requeueDeadJobs` semantics (cooldown + hourly budget). |
| `signet repair queue cancel [--tables …] [--older-than 30d] [--apply]` | `cancel` | Copy matching dead/completed rows to `job_cancellations`, flip source `status` to `cancelled`. Audit-preserving. |
| `signet repair queue prune  [--tables …] [--older-than 90d] [--apply]` | `prune`  | Copy matching terminal rows to `job_archive`, then hard delete. Archive-preserving. 1000-row hard cap per call. |

All three default to **dry-run** and require `--apply` to mutate. The
preview includes the first 100 matching ids and the total match count.
Requeue excludes retired `extract` jobs because Dreaming already consumed
their sources; cancel and prune retain those terminal rows for audit cleanup.
Provenance migrations: `089-job-cancellations`, `090-job-archive`.

## Provider Abstraction

All LLM calls go through an `LlmProvider` interface with two methods:
`generate(prompt, opts?)` returning a `Promise<string>`, and `available()`
returning a `Promise<boolean>`.

Two implementations are shipped:

**LlamaCppProvider** calls the llama.cpp server via its OpenAI-compatible
`POST /v1/chat/completions` endpoint. The default base URL is
`http://localhost:8080` and the default model is `qwen3:4b`. No
authentication is required. The `available` check uses a 3-second timeout
against `GET /v1/models`.

**OllamaProvider** calls the Ollama HTTP API at `POST /api/generate` with
`stream: false`. The default base URL is `http://localhost:11434` and the
default model is `qwen3:4b` (deprecated — see below). `nemotron-3-nano:4b` is the
preferred local Ollama model going forward; Nemotron's superior reasoning produces
better extraction results and `qwen3:4b` will be removed in a future update. Each `generate` call sets an `AbortController`
timeout (default 45,000 ms) and throws a descriptive error on abort. HTTP
errors surface the status code and the first 200 characters of the response
body. The `available` check uses a 3-second timeout against `GET /api/tags`.
For live prompt harness commands, see
`platform/daemon/src/pipeline/README.md`.

**ClaudeCodeProvider** invokes the Claude Code CLI as a subprocess:
`claude -p <prompt> --model <model> --no-session-persistence --output-format text`.
The default model is `haiku`. Timeout is 60,000 ms. This provider is
available as a fallback when no local LLM server is running but the
Claude Code CLI is present on PATH.
Daemon-spawned calls strip ambient `ANTHROPIC_API_KEY` and
`ANTHROPIC_AUTH_TOKEN` by default. Set `claudeCode.allowApiKeyEnv: true`
only when those environment credentials should be inherited. The Claude Code
circuit breaker is daemon-wide, so interactive and background `claude-code`
providers share cooldown state.

The interface is intentionally minimal — no streaming, no chat history, no
tool use. Future providers can be added by implementing `LlmProvider` and
passing the instance to `startWorker`.

## Predictor Schema Placeholders

The schema still carries predictor-oriented columns and historical comparison
tables, including nullable `session_memories.predictor_score`,
`session_memories.predictor_rank`, and `predictor_comparisons`. These fields
are retained so future scorer work can attach training and comparison data
without another migration churn.

The current daemon does not ship or start a predictive scorer sidecar.
`session-start` assembles candidates with hybrid search, graph traversal, and
baseline score ordering; predictor score and rank slots remain `null` unless a
future scorer path writes them. Dashboard predictor helpers currently return
empty slices, and entity health reads `predictor_comparisons` only when rows
exist.

## Embedding Tracker

The embedding tracker (`platform/daemon/src/embedding-tracker.ts`) is a
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
   Rows with a persisted provider-failure backoff are excluded until their retry
   time, so a poison row cannot starve other eligible work. Results are ordered
   by `updated_at DESC` and capped at `batchSize`.

3. **Durable admission** — before provider work, the tracker claims a singleton
   SQLite lease and increments the shared hourly batch budget. The lease spans
   the accounting window, so daemon restarts cannot reset the budget or cause a
   slow batch to run twice. The existing repair cooldown and hourly budget
   control this admission.

4. **Sequential embedding fetch** — each stale row's content is embedded
   one at a time, outside any transaction. Failed fetches increment the
   `failed` counter without aborting the cycle. Their retry state is persisted
   by memory id, content hash, and embedding model.

5. **Batch write** — all successful embeddings are upserted in a single
   `withWriteTx` call. For each result: stale embeddings are deleted by
   source (except the new hash), the new embedding row is upserted on
   `content_hash` conflict, the `vec_embeddings` virtual table is synced,
   and `embedding_model` is updated on the memory row.

At daemon startup, the `vec_embeddings` virtual table is checked against the
configured embedding dimensions. If the table was created with stale
`FLOAT[N]` dimensions, the daemon logs schema drift, recreates the virtual
table with the configured size, and backfills stored embeddings that match that
dimension.

The tracker uses `setTimeout` chains for natural backpressure. It
exposes a `getStats()` method returning `{ running, processed, failed,
skippedCycles, lastCycleAt, queueDepth }`.

Configuration lives under `embeddingTracker` in the pipeline config:

| Field | Default | Range | Description |
|-------|---------|-------|-------------|
| `enabled` | `true` | — | Master switch |
| `pollMs` | `5000` | 1000–60000 ms | Polling interval between cycles |
| `batchSize` | `8` | 1–20 | Max embeddings refreshed per cycle |
