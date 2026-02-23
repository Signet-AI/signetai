---
title: "Architecture"
description: "Full technical architecture documentation."
order: 16
section: "Infrastructure"
---

Signet Architecture
===================

Technical reference for the Signet daemon and supporting packages.
This document covers the full system — from package boundaries through
database schema — with enough detail to reason about correctness,
performance, and failure modes.

---

Package Overview
----------------

Signet is organized as a bun workspace monorepo under `signetai/`.
Packages divide along a clear ownership boundary: `@signet/core` owns
types and data; the daemon owns all runtime behavior; connectors own
the platform-specific surface area.

`@signet/core` is the shared foundation. It defines TypeScript
interfaces, the SQLite wrapper, hybrid search, manifest parsing, and
constants. Every other package imports from core; core imports from
nothing internal.

`@signet/daemon` is the background service. It runs the Hono HTTP
server on port 3850, the pipeline workers, the file watcher, and the
retention and maintenance workers. It targets bun directly, which
gives it access to `bun:sqlite` and JSX for the dashboard.

`@signet/cli` is the user-facing tool. It handles setup, config
editing, daemon lifecycle, secrets, and skills. It targets Node for
broad compatibility, but runs fine under bun.

`@signet/connector-base` provides the abstract `BaseConnector` class
that all platform connectors extend. It re-exports shared utilities
(block injection, skill symlinking) so connector implementations stay
thin.

`@signet/connector-claude-code`, `@signet/connector-opencode`, and
`@signet/connector-openclaw` are concrete platform adapters. Each
implements `install`, `uninstall`, `isInstalled`, and `getConfigPath`.

`@signet/sdk` is the embedding library for third-party apps that want
to call the daemon API without shelling out to the CLI.

---

End-to-End Data Flow
--------------------

The path from a conversation event to a searchable memory is:

```
Harness hook fires (session-start / user-prompt / session-end)
    → connector calls daemon HTTP API
    → /api/hooks/remember enqueues memory_jobs row (type: extract)
    → extraction worker leases job, calls LLM for facts + entities
    → decision worker evaluates each fact against existing memories
    → controlled writes: new memories inserted via txIngestEnvelope
    → graph persistence: entities and relations written in a
      separate transaction
    → embeddings prefetched outside write lock, stored atomically
    → memory_history records every proposal (shadow or applied)
    → /api/memory/recall runs hybrid search (BM25 + vector + graph)
```

The database is the source of truth. The daemon's file watcher is
responsible for syncing agent config changes to harness-specific
files (CLAUDE.md, AGENTS.md). That flow is independent from the
memory pipeline:

```
User edits ~/.agents/AGENTS.md
    → chokidar detects change
    → 2s debounced sync: regenerate ~/.claude/CLAUDE.md etc.
    → 5s debounced git commit: auto-commit with timestamp
```

---

Pipeline V2
-----------

The memory pipeline lives at `packages/daemon/src/pipeline/`. It
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
inserts via `txIngestEnvelope`. `update` and `delete` actions are
blocked in the current implementation — they are recorded in history
with a `blockedDestructive` reason. Contradiction detection (negation
and antonym analysis) flags high-risk cases for review.

**Graph persistence** happens in a separate transaction after fact
writes complete. A failure here is non-fatal — it logs a warning and
does not revert the extracted memories.

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
| `graphEnabled` | Run graph entity persistence |
| `autonomousEnabled` | Allow agent-triggered repairs |
| `autonomousFrozen` | Hard stop on all autonomous actions |
| `maintenanceMode` | `observe` or `execute` for maintenance worker |

---

Job Queue
---------

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

Knowledge Graph
---------------

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

**Graph extraction**: when the extractor returns entity triples
(source, relationship, target), `txPersistEntities` is called inside
its own `withWriteTx`. Entities are upserted by canonical name;
relations are upserted by the (source, target, type) triplet with
mention counts incremented. Mention links are inserted into
`memory_entity_mentions`.

**Graph-augmented search** (`graph-search.ts`): `getGraphBoostIds`
is called at query time with a deadline. It tokenizes the query,
resolves matching entities by `canonical_name LIKE ?` (ordered by
`mentions DESC`, limit 20), then expands one hop through `relations`
in both directions (limit 50 neighbors). Finally it collects all
`memory_id` values from `memory_entity_mentions` for the expanded
entity set (limit 200). The result is a set of IDs that can be
boosted or pre-included in search results. Any error returns an
empty set — the graph never degrades core search.

**Retention and orphaning**: when memories are tombstoned past their
retention window, the retention worker purges `memory_entity_mentions`
rows for those memories, decrements `entities.mentions`, and removes
entities whose mention count reaches zero (orphan collection).

---

Auth Middleware
--------------

The daemon supports three deployment modes, controlled by `authMode`
in the config.

**local** (default): no authentication required. All requests are
accepted and `auth` is set to `{ authenticated: false, claims: null }`.
Rate limiting is also skipped in local mode.

**team**: a Bearer token is required on every request. Tokens are
HMAC-SHA256 signed using a 32-byte secret loaded from disk. The token
format is `base64url(payload).base64url(hmac)`. Payload is a JSON
object with `sub`, `scope`, `role`, `iat`, and `exp` fields. Expired
or malformed tokens return 401.

**hybrid**: localhost requests (identified by the `Host` header)
bypass the token requirement and get implicit full access. Remote
requests require a valid token. In hybrid mode, if a localhost caller
sends a token anyway, it is validated and its claims are used.

**Roles and permissions**: four roles exist — `admin`, `operator`,
`agent`, and `readonly`. Each role maps to a static permission set.

| Role | Permissions |
|------|-------------|
| admin | all |
| operator | all except `admin` |
| agent | remember, recall, modify, forget, recover, documents |
| readonly | recall only |

The `requirePermission` middleware enforces permission checks per
route. The `requireScope` middleware checks whether a token's scope
(project, agent, user fields) matches the request target. Unscoped
tokens and admin-role tokens bypass scope checks.

**Rate limiting** (`rate-limiter.ts`): a sliding-window rate limiter
keyed by `actor:operation`. In team and hybrid modes, the actor is
the token's `sub` claim or the `x-signet-actor` header. When the
limit is exceeded, the response is 429 with a `Retry-After` header.

---

Analytics
---------

`packages/daemon/src/analytics.ts` implements an in-memory analytics
accumulator. All state is ephemeral — it resets on daemon restart.
Durable history lives in `memory_history` and structured logs.

**Usage counters**: four Maps track endpoints, actors, providers, and
connectors. Endpoint stats record call count, error count, and total
latency. Actor stats classify requests as remember/recall/mutate/other
by path pattern. Provider stats track LLM call count, failures, and
latency. Connector stats track syncs, errors, and documents processed.

**Error ring buffer**: a fixed-capacity array (default 500 entries)
of `ErrorEntry` records. When full, the oldest entry is evicted. Each
entry carries timestamp, stage, error code, message, and optional
memory ID and actor. Error codes form a taxonomy by stage:
`EXTRACTION_TIMEOUT`, `EXTRACTION_PARSE_FAIL`, `DECISION_TIMEOUT`,
`DECISION_INVALID`, `EMBEDDING_PROVIDER_DOWN`, `EMBEDDING_TIMEOUT`,
`MUTATION_CONFLICT`, `MUTATION_SCOPE_DENIED`, `CONNECTOR_SYNC_FAIL`,
`CONNECTOR_AUTH_FAIL`.

**Latency histograms**: four operations are tracked (`remember`,
`recall`, `mutate`, `jobs`) using a ring-buffer of 1,000 samples each.
Snapshots expose p50, p95, p99, count, and mean. The sort is deferred
until a snapshot is requested.

---

Connector Framework
-------------------

The connector framework manages external data source integrations that
push documents and memories into the pipeline. It is distinct from the
harness connector packages (claude-code, opencode, openclaw) — those
handle platform hook installation; this framework handles ongoing sync.

**Registry** (`connectors/registry.ts`): CRUD operations on the
`connectors` table. `registerConnector` inserts a new row with
`status = 'idle'` and returns its UUID. `updateConnectorStatus`
transitions a connector between `idle`, `syncing`, and `error` states.
`updateCursor` persists the sync cursor after a successful run. The
cursor is a JSON object stored in `cursor_json`; it tracks the
high-water mark for incremental sync (typically a timestamp or offset).

**Filesystem connector** (`connectors/filesystem.ts`): watches a
directory path, ingests files as documents, and tracks the cursor
based on file modification times.

**Document count** is tracked by querying `documents.source_url` with
a prefix match against the connector's configured root path.

**Health**: connector health is one of the six diagnostic domains.
It measures the count of connectors with `last_error IS NOT NULL` and
the age of the oldest unresolved error.

---

Document Ingest
---------------

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

Diagnostics and Repair
-----------------------

`packages/daemon/src/diagnostics.ts` provides read-only health signals
across six domains. All functions accept a `ReadDb` or `ProviderTracker`
and return plain data — no mutations, no side effects.

**Composite score**: each domain score is multiplied by a fixed weight
and summed. Scores range from 0 to 1. Status thresholds are: `>= 0.8`
healthy, `>= 0.5` degraded, `< 0.5` unhealthy.

| Domain | Weight | Key signals |
|--------|--------|-------------|
| queue | 0.28 | depth > 50, dead rate > 1%, age > 5min, stale leases |
| storage | 0.14 | tombstone ratio > 30% |
| index | 0.19 | FTS/memory count mismatch > 10%, embedding coverage < 80% |
| provider | 0.24 | LLM availability rate from ring buffer |
| mutation | 0.10 | recovery events > 5 in last 7 days |
| connector | 0.05 | connectors with errors, age of oldest error |

**Provider tracker**: a ring buffer (default 100 entries) of
`success`/`failure`/`timeout` outcomes. Evicted entries have their
count decremented so the running totals stay accurate without a full
scan.

**Repair actions** (`repair-actions.ts`): four actions are defined.

- `requeueDeadJobs`: resets dead jobs to `pending` with `attempts = 0`
  (batch limit 50 per call).
- `releaseStaleLeases`: resets `leased` jobs whose `leased_at` predates
  the lease timeout back to `pending`.
- `checkFtsConsistency`: compares FTS row count to active memory count.
  If mismatch > 10% and `repair = true`, runs
  `INSERT INTO memories_fts(memories_fts) VALUES('rebuild')`.
- `triggerRetentionSweep`: calls the retention worker's `sweep()` method
  immediately outside the normal schedule.

All repair actions pass through a policy gate (`checkRepairGate`). The
gate checks `autonomousFrozen` first (hard stop), then
`autonomousEnabled` for agent-role callers (operators and daemon bypass
this), then a rate limiter with per-action cooldown and hourly budget.
Each successful repair writes an audit event to `memory_history` with
`memory_id = 'system'`.

**Maintenance worker** (`pipeline/maintenance-worker.ts`): runs on a
configurable interval. Each cycle calls `getDiagnostics`, builds repair
recommendations from the report, and either logs them (`observe` mode)
or executes them (`execute` mode). A halt tracker prevents the same
ineffective repair from running more than 3 consecutive cycles without
improving the composite score. The worker only starts its interval
timer when `autonomousEnabled && !autonomousFrozen`.

---

Database Schema
---------------

SQLite with WAL mode. Migrations are numbered sequentially under
`packages/core/src/migrations/`. Each migration is idempotent — safe
to re-run against an existing database. Schema version is tracked in
`schema_migrations`.

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

**embeddings**

Stores raw embedding vectors as BLOBs. Keyed by `content_hash`
(unique). Fields: `vector` (BLOB), `dimensions`, `source_type`,
`source_id`, `chunk_text`. The `vec_embeddings` virtual table
(sqlite-vec `vec0`) provides ANN search when the extension is loaded.

**memories_fts**

FTS5 external content table backed by `memories`. Three triggers
(`memories_ai`, `memories_ad`, `memories_au`) keep the index in sync
with inserts, deletes, and updates. Queried with BM25 scoring via
`bm25(memories_fts)`.

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

**tokens**

(Planned) Persistent token store for team mode token management.
Currently tokens are issued and verified against the in-memory secret;
revocation requires a daemon restart to rotate the secret.

---

Content Normalization
---------------------

`packages/daemon/src/content-normalization.ts` provides deterministic
normalization and hashing for deduplication.

The pipeline is:

1. `normalizeContentForStorage`: trim whitespace, collapse internal
   runs of whitespace to a single space. This is what gets stored in
   the `content` column.
2. `deriveNormalizedContent`: lowercase the storage content, strip
   trailing punctuation. This is the canonical form used for hashing.
3. Hash: SHA-256 of the normalized content. If normalization produces
   an empty string, the hash falls back to the lowercased storage
   content.

The returned `contentHash` is stored in `memories.content_hash`. The
unique partial index on that column ensures that two memories with
semantically identical content (differing only in case or trailing
punctuation) cannot both exist as non-deleted rows. Collision at insert
time (UNIQUE constraint violation) is handled gracefully — the worker
treats it as a dedup hit and records a `dedupedExistingId` in history.

Contradiction detection in the worker (`detectContradictionRisk`) runs
a lightweight token-level analysis: it checks for negation token
asymmetry (one side has a negation word, the other doesn't) and
antonym pair conflicts across a predefined set of boolean pairs
(`enabled`/`disabled`, `allow`/`deny`, etc.). At least two tokens must
overlap before either check is applied.

---

Retention
---------

`packages/daemon/src/pipeline/retention-worker.ts` purges expired data
on a configurable interval (default 6 hours). Each purge step runs in
its own short `withWriteTx` to avoid holding write locks across the
full sweep.

**Purge order** (from spec section 32.5 D2.3):

1. **Graph links**: delete `memory_entity_mentions` rows for tombstoned
   memories past `tombstoneRetentionMs` (default 30 days). Decrement
   `entities.mentions` for affected entities; remove entities whose
   count reaches zero.
2. **Embeddings**: delete `embeddings` rows for those same expired
   tombstone IDs.
3. **Tombstones**: hard-delete the `memories` rows. The `memories_ad`
   trigger fires synchronously and cleans the FTS index. Row count is
   taken from the pre-delete ID list to avoid FTS trigger inflation in
   the change count.
4. **History**: delete `memory_history` rows older than
   `historyRetentionMs` (default 180 days).
5. **Completed jobs**: delete `memory_jobs` rows with
   `status = 'completed'` older than `completedJobRetentionMs`
   (default 14 days).
6. **Dead jobs**: delete `memory_jobs` rows with `status = 'dead'`
   older than `deadJobRetentionMs` (default 30 days).

Each step is capped at `batchLimit` rows (default 500) per sweep to
bound latency. Backpressure accumulates until the next interval fires.

Default retention windows:

| Data | Default |
|------|---------|
| Soft-deleted memories (tombstones) | 30 days |
| History events | 180 days |
| Completed jobs | 14 days |
| Dead-letter jobs | 30 days |

---

User Data Layout
----------------

All agent data lives at `~/.agents/`:

```
~/.agents/
├── agent.yaml           # Config manifest
├── AGENTS.md            # Agent identity and instructions
├── SOUL.md              # Personality and tone
├── IDENTITY.md          # Structured identity metadata
├── USER.md              # User profile
├── MEMORY.md            # Generated working memory summary
├── memory/
│   ├── memories.db      # SQLite database (source of truth)
│   └── scripts/         # Optional batch tools (Python)
├── skills/              # Installed skills (subdirs)
├── .secrets/            # Encrypted secret store
└── .daemon/
    ├── pid
    └── logs/
        └── daemon-YYYY-MM-DD.log
```

The daemon binds to localhost only. All data stays local by design.
There is no telemetry.

---

HTTP API Reference
------------------

All endpoints are served by the Hono server on port 3850.

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/health` | GET | none | Uptime, pid, version |
| `/api/status` | GET | none | Full daemon status |
| `/api/config` | GET | local | List config files |
| `/api/config` | POST | local | Save a config file |
| `/api/identity` | GET | local | Agent identity |
| `/api/memories` | GET | recall | List with pagination |
| `/api/memory/remember` | POST | remember | Save a memory, enqueue extraction |
| `/api/memory/recall` | POST | recall | Hybrid search |
| `/memory/search` | GET | recall | Legacy keyword search |
| `/memory/similar` | GET | recall | Vector similarity search |
| `/api/embeddings` | GET | recall | Export embeddings |
| `/api/hooks/session-start` | POST | remember | Inject context into session |
| `/api/hooks/user-prompt-submit` | POST | recall | Per-prompt context load |
| `/api/hooks/session-end` | POST | remember | Extract session memories |
| `/api/hooks/remember` | POST | remember | Save a memory via hook |
| `/api/hooks/recall` | POST | recall | Search via hook |
| `/api/harnesses` | GET | local | List configured harnesses |
| `/api/harnesses/regenerate` | POST | local | Regenerate harness configs |
| `/api/skills` | GET | local | List installed skills |
| `/api/secrets` | GET | admin | List secret names |
| `/api/analytics` | GET | analytics | Usage counters and latency |
| `/api/diagnostics` | GET | diagnostics | Health report |
| `/api/repair` | POST | operator | Trigger repair action |
| `/api/connectors` | GET/POST | connectors | List or register connectors |
| `/api/documents` | GET/POST | documents | List or enqueue documents |
| `/*` | GET | none | Dashboard static files |

---

Key Files
---------

```
packages/core/src/
    types.ts                  TypeScript interfaces
    database.ts               SQLite wrapper (runtime-detecting)
    search.ts                 Hybrid search
    migrations/               Numbered migration scripts

packages/daemon/src/
    daemon.ts                 HTTP server + file watcher
    db-accessor.ts            withReadDb / withWriteTx wrappers
    transactions.ts           txIngestEnvelope and history helpers
    content-normalization.ts  SHA-256 dedup normalization
    analytics.ts              In-memory counters and histograms
    diagnostics.ts            Six-domain health scoring
    repair-actions.ts         Policy-gated repair functions
    session-tracker.ts        Plugin vs legacy runtime mutex
    memory-config.ts          PipelineV2Config type and defaults

    auth/
        types.ts              AuthMode, TokenRole, Permission
        tokens.ts             HMAC-SHA256 token sign/verify
        middleware.ts         Hono middleware: auth, scope, rate limit
        policy.ts             Permission matrix, scope enforcement

    connectors/
        registry.ts           CRUD for connectors table
        filesystem.ts         Filesystem connector

    pipeline/
        worker.ts             Extraction job worker
        extraction.ts         LLM fact + entity extraction
        decision.ts           LLM shadow decision engine
        graph-transactions.ts txPersistEntities, entity decrement
        graph-search.ts       Query-time graph boost (entity resolution)
        document-worker.ts    Document ingest job worker
        retention-worker.ts   Purge worker (6-step ordered purge)
        maintenance-worker.ts Autonomous diagnostics + repair loop
        provider.ts           LlmProvider interface + Ollama impl
        reranker.ts           Optional result reranking
```
