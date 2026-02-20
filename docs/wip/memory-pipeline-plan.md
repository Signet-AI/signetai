# Signet Memory Pipeline v2: Implementation Specification

Status: Draft for implementation

Audience: Core + Daemon maintainers

Scope note: This document is a delivery spec. It intentionally defines
behavior, contracts, and validation criteria. It does not include
implementation code.

---

## 1) Purpose

Signet needs a memory pipeline that is not only searchable, but
selective, self-correcting, auditable, and safe under concurrency.

This spec hardens the prior plan into an implementation-ready design
with:

- explicit data contracts and lifecycle states
- durable async processing
- lock-safe transaction boundaries
- provider and privacy controls
- graph-aware retrieval
- measurable quality, latency, reliability, and cost targets

---

## 2) Product Objectives

### Primary goals

1. Increase recall relevance and consistency over current append-only
   memory behavior.
2. Prevent duplicate and contradictory memory growth.
3. Keep user data safe under provider outages and concurrent writes.
4. Preserve reversibility through complete memory history and recovery.
5. Keep local-first defaults, with optional remote provider support.
6. Enable bounded autonomous maintenance so agents can diagnose and
   repair common failure states without human intervention.

### Non-goals (for this release)

- Full multi-hop graph reasoning beyond one-hop expansion.
- Autonomous memory pruning by LLM without recoverable audit trail.
- External graph databases (Neo4j, etc.).
- Mandatory online provider dependency.

---

## 3) Success Criteria (Release Gates)

The release is complete only if all are true:

1. No data loss when extraction/LLM fails (raw memory persists).
2. Pinned memories cannot be deleted by model decisions.
3. Duplicate insert race for identical content is blocked at DB level.
4. `/remember` remains responsive under provider outage via async
   fallback and retry queue.
5. Search quality improves against baseline on offline eval set.
6. History endpoint shows complete ADD/UPDATE/DELETE lineage.
7. Soft-deleted memories are recoverable during retention window.
8. Agents can explicitly modify a memory by ID with audit-safe semantics.
9. Agents can explicitly forget by ID or query without hard delete.
10. Autonomous maintenance loops resolve common degradation states within
    SLO and always leave an auditable trail.

---

## 4) Current Constraints and Assumptions

1. Memory pipeline is migrating from Python subprocesses into daemon
   TypeScript.
2. Existing schemas in the wild are mixed (legacy daemon schema,
   unified core schema, and migration edge cases).
3. Daemon currently opens multiple SQLite connections per request path;
   this is acceptable short term, but write contention increases under
   LLM-stage latency.
4. sqlite-vec remains the vector backend for this release.
5. Default model path is local Ollama unless user explicitly chooses
   remote provider.

### 4.1 Mem0 comparison findings (implemented behavior)

Review source:

- `references/mem0/mem0/memory/main.py`
- `references/mem0/mem0-ts/src/oss/src/memory/index.ts`
- `references/mem0/server/main.py`

Observed parity requirements:

1. Mem0 supports both inferred and explicit mutation paths:
   - inferred: ADD/UPDATE/DELETE/NONE in add pipeline
   - explicit: update(id), delete(id), delete_all(filters), history(id)
2. Mem0 treats update/delete as first-class operations with history
   entries for each mutation.
3. Mem0 exposes API surface for modify/forget (`PUT /memories/{id}` and
   `DELETE /memories/{id}`), not only infer-on-add behavior.

Signet implication: inferred mutation is not enough; agent-directed
modify/forget must be a formal API + policy surface.

### 4.2 OpenClaw integration baseline and gap

Current Signet state in-repo:

1. `@signet/connector-openclaw` is install-time wiring that patches
   OpenClaw config and installs command-hook files under
   `~/.agents/hooks/agent-memory/`.
2. Installed hook handler supports command actions `/remember`,
   `/recall`, and `/context` via daemon hook endpoints.
3. `@signet/adapter-openclaw` exists as a runtime plugin entry point and
   currently exposes lifecycle calls for session start/pre-compaction/
   compaction complete plus manual remember/recall helpers.
4. Daemon hook surface already includes richer lifecycle endpoints,
   including user-prompt-submit and session-end.

Gap vs desired state:

1. Runtime plugin path is not yet the single canonical path for
   OpenClaw memory operations.
2. Legacy command-hook path can overlap with plugin behavior and must be
   guarded against duplicate recall/capture.
3. Explicit modify/forget tools are not yet available in the runtime
   OpenClaw integration path.

---

## 5) High-Level Architecture

### 5.1 Pipeline modes

`remember` supports three execution modes:

- `sync`: do extraction and update-decision inline within latency budget.
- `async`: persist raw memory immediately and enqueue processing job.
- `auto` (default): attempt sync until timeout budget, then degrade to
  async without failing write.

### 5.2 Lifecycle stages

1. Ingest and normalize input.
2. Idempotency and exact dedup check.
3. Persist raw memory envelope.
4. Run extraction (facts + entities).
5. For each fact: retrieve candidates, decide ADD/UPDATE/DELETE/NONE,
   apply decision.
6. Persist embeddings and graph links.
7. Persist history and metrics.

### 5.3 Key principle

No long-running external call is allowed inside a write-locked
transaction.

---

## 6) Data Model Specification

### 6.1 `memories` table

Required fields:

- identity: `id`
- content: `content`, `normalized_content`, `content_hash` (SHA-256)
- classification: `type`, `category`
- source: `source_type`, `source_id`, `who`
- control: `pinned`, `manual_override`, `is_deleted`, `deleted_at`
- quality/process: `confidence`, `update_count`, `extraction_status`
- retrieval: `importance`, `access_count`, `last_accessed`
- model provenance: `embedding_model`, `extraction_model`
- audit stamps: `created_at`, `updated_at`, `updated_by`, `version`

Required indexes:

- unique partial index on `content_hash` where not null
- index on `is_deleted`, `pinned`, `type`, `created_at`
- index on `source_type, source_id`

### 6.2 `memory_history` table

Purpose: immutable audit trail for all semantic decisions.

Fields:

- identity: `id`, `memory_id`
- event: `event` in {ADD, UPDATE, DELETE, RECOVER, MERGE, NONE}
- payload: `old_content`, `new_content`, `old_metadata`, `new_metadata`
- actor: `actor_type`, `actor_id`
- model provenance: `provider`, `model`, `prompt_version`
- reasoning metadata: `decision_confidence`, `decision_reason`
- traceability: `request_id`, `session_id`, `created_at`

### 6.3 `memory_jobs` table (durable queue)

Purpose: retries, crash-safe processing, and backpressure control.

Fields:

- identity: `id`, `memory_id`
- type: `job_type` in {extract, decision, graph, reembed}
- payload: `payload_json`
- state: `status` in {pending, leased, retry_scheduled, done, dead}
- retries: `attempt_count`, `max_attempts`, `next_attempt_at`
- lease: `lease_owner`, `lease_expires_at`
- diagnostics: `last_error`, `last_error_code`
- timestamps: `created_at`, `updated_at`

### 6.4 Graph tables

`entities`:

- `id`, `name`, `canonical_name`, `entity_type`, `mentions`,
  `embedding`, `created_at`, `updated_at`

`relations`:

- `id`, `source_entity_id`, `target_entity_id`, `relationship`,
  `mentions`, `confidence`, `created_at`, `updated_at`

`memory_entity_mentions` (required link table):

- `id`, `memory_id`, `entity_id`, `mention_text`, `confidence`,
  `created_at`

Without `memory_entity_mentions`, graph-augmented retrieval cannot map
entity expansion back to memory rows reliably.

---

## 7) Migration and Rollback Strategy

### 7.1 Pre-migration safety

1. Create timestamped SQLite backup.
2. Verify backup integrity.
3. Run schema detection and emit migration plan report.

### 7.2 Migration behavior

1. Use additive migrations first (new columns/tables/indexes).
2. Backfill derived fields in batched jobs (`content_hash`,
   `normalized_content`, `embedding_model`, etc.).
3. Never block startup on full backfill; process in background queue.

### 7.3 Rollback

1. Rollback mechanism is DB restore from pre-migration backup.
2. Keep migration execution idempotent so re-run is safe.
3. Store migration audit record with start/end time and outcome.

---

## 8) Concurrency and Transaction Model

### 8.1 Transaction boundaries

Use short transactions only:

- Tx A: ingest write (insert raw memory envelope + queue job)
- Tx B: apply one semantic decision atomically
- Tx C: finalize metadata/access/history updates

No LLM or embedding call may execute while holding write lock.

### 8.2 Race prevention

1. DB-level uniqueness on `content_hash` for exact duplicate collapse.
2. Compare-and-set update using memory `version` to prevent stale write.
3. Re-check candidate state immediately before applying UPDATE/DELETE.

### 8.3 Connection policy

1. Single shared DB accessor in daemon process.
2. Read-only handles for search paths where possible.
3. Standard pragmas on write connections:
   - WAL mode
   - busy timeout
   - synchronous NORMAL
   - memory temp store

---

## 9) Provider Abstraction and Policy

### 9.1 Supported providers

1. Local Ollama (default)
2. API providers (OpenAI/Anthropic)
3. Harness passthrough (Claude Code/OpenCode/OpenClaw)

### 9.2 Capability contract

Each provider must declare:

- extraction support
- decision support
- optional reranking support
- timeout and token constraints
- structured output reliability level

### 9.3 Fallback order

1. Preferred provider
2. Secondary provider (optional)
3. Raw-save + async retry queue

If all provider calls fail, memory remains stored with
`extraction_status=unprocessed` and is retried.

---

## 10) Privacy and Security Requirements

### 10.1 Default posture

- Local-first processing is default.
- Remote providers are opt-in.

### 10.2 Data handling controls

Before remote inference:

1. redact obvious secret patterns (tokens, API keys, private keys)
2. redact configured sensitive terms
3. preserve reversible placeholder map locally for audit

### 10.3 Governance controls

- provider allowlist in config
- explicit `local_only=true` enforcement mode
- outbound inference logs must avoid storing raw redacted content

### 10.4 Safety invariants

1. `pinned=1` cannot be deleted by model output.
2. soft-delete only; hard purge only via retention worker.
3. all mutating decisions require history event insert in same commit.

---

## 11) Extraction and Decision Contracts

### 11.1 Extraction output contract

Required structure:

- `facts[]`: content + memory type + confidence
- `entities[]`: source, relationship, target, confidence
- `warnings[]`: optional parser/quality issues

Validation rules:

- reject empty or trivial facts
- enforce max fact length
- enforce max output count per request
- schema validation failure triggers raw-save fallback

### 11.2 Decision output contract

For each candidate memory, model returns one of:

- ADD
- UPDATE
- DELETE
- NONE

Additional fields required:

- target temp id (for UPDATE/DELETE/NONE)
- confidence
- short reason

Invalid target ids or malformed decisions are discarded and recorded as
pipeline warnings.

### 11.3 Contradiction handling

If same batch contains opposing claims for same subject:

1. block automatic destructive decision
2. store both with contradiction marker
3. emit review-needed history event

---

## 12) Search and Ranking Specification

### 12.1 Baseline retrieval

- hybrid vector + BM25 search remains primary path
- excluded from retrieval: `is_deleted=1` unless explicit include flag

### 12.2 Score components

`final_score = a*vector + b*bm25 + c*access + d*graph (+ optional rerank)`

Where:

- `access` is logarithmic frequency boost
- `graph` is one-hop connectivity boost
- reranker is opt-in and latency-bounded

### 12.3 Reranking policy

- disabled by default
- only applied to top-N candidates
- bounded timeout; fallback to pre-rerank order on timeout/failure

---

## 13) Graph Memory Specification

### 13.1 Extraction behavior

Entity and relation extraction runs in same pipeline pass as fact
extraction, but persisted independently.

### 13.2 Merge behavior

- entity merge via semantic threshold + canonical name normalization
- relation merge by `(source, relationship, target)` tuple
- mention counts increment, not duplicate row insertion

### 13.3 Query-time usage

1. extract query entities
2. resolve nearest stored entities
3. expand one-hop neighbors
4. boost linked memories via `memory_entity_mentions`

If no entities resolve, search behaves exactly like baseline hybrid.

---

## 14) API Specification (Delta)

### 14.1 `POST /api/memory/remember`

New request fields:

- `mode`: `auto | sync | async`
- `raw`: boolean (bypass extraction)
- `idempotency_key`: optional client key
- `pipeline_timeout_ms`: optional override within safe bounds

Response includes:

- `memory_id`
- `status`: `processed | queued | raw_saved`
- `job_id` when queued
- `warnings[]`

### 14.2 `GET /api/memory/jobs/:id`

Returns job state, attempts, next retry, and last error summary.

### 14.3 `GET /api/memory/:id/history`

Returns ordered event log with model/provider provenance and reasons.

### 14.4 `POST /api/memory/:id/recover`

Recovers soft-deleted memory if still in retention window.

### 14.5 `PATCH /api/memory/:id`

Explicit modify endpoint for agent/operator corrections.

Request supports:

- `content` (optional)
- `type`, `tags`, `importance`, `pinned` (optional metadata updates)
- `reason` (required; stored in history)
- `if_version` (optional optimistic concurrency guard)

Behavior:

1. Fails on version mismatch when `if_version` is provided.
2. Updates embedding if content changes.
3. Writes `UPDATE` event to `memory_history` in same commit.

### 14.6 `DELETE /api/memory/:id`

Explicit forget endpoint (soft delete).

Request/query supports:

- `reason` (required)
- `force` (optional; required for pinned memory)

Behavior:

1. Default is soft-delete (`is_deleted=1`, `deleted_at=now`).
2. Rejects pinned delete unless `force=true` and policy permits caller.
3. Writes `DELETE` event to `memory_history`.

### 14.7 `POST /api/memory/forget`

Batch forget by query and filters (agent-safe forget flow).

Request supports:

- `query` (semantic or keyword)
- optional filters (`type`, `tags`, `who`, `source_type`, time range)
- `mode`: `preview | execute`
- `limit`
- `reason` (required for execute)

Behavior:

1. `preview` returns candidate memory IDs and scores only.
2. `execute` applies soft-delete to selected IDs.
3. For large deletes above threshold, require explicit confirm token.

### 14.8 `POST /api/memory/modify`

Batch modify operation for structured edits.

Request supports list of patches:

- `{ id, content?, tags?, type?, importance?, reason, if_version? }`

Behavior:

1. Atomic per item, not all-or-nothing across batch.
2. Per-item result includes success/failure + conflict reason.
3. Each successful item writes `UPDATE` history event.

### 14.9 Compatibility

Legacy aliases remain functional, mapped to the new pipeline behavior.

---

## 15) Configuration Specification

### 15.1 Pipeline config block

Config supports:

- provider selection and model per provider
- mode defaults (`auto/sync/async`)
- timeout and retry budgets
- dedup thresholds
- reranker enablement
- graph enablement
- `local_only` privacy enforcement
- mutation policy (allow/deny delete of pinned, max batch delete size)
- forget safeguards (preview required, confirm threshold)

### 15.2 Safe defaults

- provider: local Ollama
- mode: auto
- reranker: off
- graph boost: low weight
- remote redaction: on

---

## 16) Observability and Operations

### 16.1 Required metrics

Pipeline throughput and reliability:

- remembers total, processed, queued, fallback raw saves
- extraction success rate
- decision parse failure rate
- queue depth, queue age p95, dead-letter count
- retry distribution by attempt

Latency:

- remember end-to-end p50/p95/p99 by mode
- extraction stage latency
- decision stage latency
- search latency p50/p95/p99

Quality indicators:

- duplicate suppression rate
- contradiction flag rate
- update-vs-add ratio

Cost/usage:

- tokens in/out per provider
- estimated cost per 1k remembers

Storage/DB:

- DB file size growth
- sqlite busy/lock error rate

### 16.2 Logging requirements

Structured logs must include request id, memory id, job id, stage,
provider, model, latency, and outcome.

### 16.3 Alert thresholds

Minimum alerts:

- dead-letter rate > 1% over 15m
- queue age p95 > 5m
- remember p95 > SLO for 30m
- sqlite busy errors above baseline threshold

### 16.4 Autonomous maintenance plane (self-healing)

The system must expose machine-actionable diagnostics and safe repair
actions so agents can maintain memory health.

Required health signals (read-only):

- queue health (`depth`, `oldest_age`, `dead_rate`, lease anomalies)
- storage health (DB size growth, fragmentation, WAL growth)
- index health (FTS/vec consistency and freshness)
- model/provider health (availability, timeout rate, parse failure rate)
- mutation safety health (wrong-target rate, rollback/recover success)

Required repair actions (mutating, policy-gated):

- requeue dead/retryable jobs
- release stale leases
- reindex FTS and vector linkage consistency checks
- reembed subset by model/version drift
- run retention/purge jobs in safe order
- execute targeted rollback/recover for recent destructive mutations

Control constraints:

- all repair actions require reason + actor + correlation id
- every repair action writes an audit event
- per-action rate limits and cooldown windows
- policy-level allowlist of autonomous actions
- emergency kill switch to disable all autonomous mutations

---

## 17) Rollout Plan

### Phase A: Infrastructure hardening

- schema additions, queue table, history table, new indexes
- transaction boundary refactor
- DB connection access unification

Gate: no regression in existing remember/recall behavior.

### Phase B: Shadow extraction

- run extraction + decision in shadow mode
- do not mutate memory semantics yet; only log proposed actions

Gate: acceptable parse reliability and decision quality on real traffic.

### Phase C: Controlled writes

- enable ADD/NONE decisions
- keep UPDATE/DELETE behind feature flag

Gate: low duplicate growth, no data-loss incidents.

### Phase D: Full semantic decisions

- enable UPDATE/DELETE with safety invariants
- enable recover endpoint and retention worker

Gate: pinned protection and recoverability validated.

### Phase E: Graph and optional reranking

- enable graph extraction + low-weight graph boost
- reranker optional per config

Gate: retrieval quality improvement without latency SLO breach.

### Phase F: Autonomous maintenance enablement

- expose diagnostics endpoints and health score
- ship policy-gated repair action endpoints
- enable agent maintenance loop in observe-only mode first
- graduate to execute mode after guardrail gates pass

Gate: self-healing actions improve system health metrics without
increasing accidental mutation incidents.

### Phase G: OpenClaw plugin-first runtime migration

- define canonical runtime path as `@signet/adapter-openclaw`
- keep `@signet/connector-openclaw` as install/bootstrap only
- add runtime operations for explicit modify/forget and full lifecycle
  parity with daemon hook surface
- keep legacy command-hook files as compatibility fallback behind config
  gate
- enforce single active runtime path per session (plugin or legacy, not
  both)

Gate: plugin path reaches functional parity and no duplicate
capture/recall occurs when compatibility mode is enabled.

---

## 18) Validation and Test Strategy

### 18.1 Unit validation

- normalization, trivial-content filters, parser validation
- contradiction detector
- decision application safety checks

### 18.2 Integration validation

- remember -> queue -> process -> recall end-to-end
- soft-delete and recovery behavior
- schema migration on representative legacy DB snapshots

### 18.3 Concurrency validation

- simultaneous identical remembers
- simultaneous conflicting updates
- worker lease contention and lease expiry recovery

### 18.4 Fault injection

- provider timeout
- malformed model output
- temporary DB lock contention
- process restart during leased job

### 18.5 Self-healing validation

- inject queue stalls and verify autonomous requeue + lease recovery
- inject index drift and verify autonomous consistency repair
- inject provider outage and verify degrade/recover without data loss
- inject accidental forget in canary and verify recover workflow
- verify kill switch disables autonomous mutations immediately

### 18.6 OpenClaw integration validation

- plugin lifecycle path validates session-start, user-prompt-submit,
  session-end, and compaction callbacks
- plugin tools validate search/store/get/list/forget/modify contracts
- compatibility mode validates legacy command hooks continue to function
- mixed-mode tests verify duplicate recall/capture protection
- daemon outage tests verify graceful degradation and recovery behavior

---

## 19) Success Metrics

### 19.1 Quality metrics

1. Recall@5 and Recall@10 on labeled recall set.
2. nDCG@10 for ranking quality.
3. Duplicate creation rate per 1,000 remembers.
4. Decision precision/recall for ADD/UPDATE/DELETE against human labels.
5. Contradiction handling precision (flagged contradictions that are
   genuinely conflicting).
6. Modify precision: percent of explicit edits applied to intended IDs.
7. Forget precision: percent of forget executions deleting only
   intended IDs.

Target deltas vs baseline:

- Recall@10: +15% relative minimum
- nDCG@10: +10% relative minimum
- duplicate rate: -60% relative minimum
- decision precision: >= 0.90 for UPDATE/DELETE in canary

### 19.2 Reliability metrics

1. End-to-end remember success rate >= 99.9% (raw-save counts as success).
2. Queue dead-letter rate <= 0.5% daily.
3. Pinned-delete incidents = 0.
4. Recovery success for soft-deleted memories >= 99% within retention
   window.
5. Accidental deletion incidents = 0 in canary and GA.

### 19.3 Latency metrics

For local default provider:

- remember p95 (auto mode): <= 1.2s
- remember p99 (auto mode): <= 2.5s
- fallback raw-save p95 under provider outage: <= 200ms
- recall/search p95: <= 400ms without reranker
- explicit modify p95: <= 300ms (single ID)
- explicit forget p95: <= 250ms (single ID)

### 19.4 Cost and efficiency metrics

1. Median tokens per remember decision path.
2. Estimated provider cost per 1,000 remembers.
3. Queue processing throughput (jobs/minute) at target concurrency.
4. Storage growth per 10,000 remembers.

### 19.5 Self-healing effectiveness metrics

1. Mean time to detect (MTTD) and mean time to recover (MTTR) for queue,
   provider, and index incidents.
2. Autonomous remediation success rate by action type.
3. Percent of incidents resolved without human intervention.
4. False-remediation rate (action taken but no health improvement).
5. Safety incident rate attributable to autonomous actions.

Targets:

- autonomous resolution >= 80% of sev-3 memory incidents
- MTTR improvement >= 50% vs non-autonomous baseline
- false-remediation rate <= 5%
- autonomous-action safety incidents = 0

### 19.6 OpenClaw integration metrics

1. Plugin adoption rate vs legacy command-hook path.
2. Duplicate recall/capture incident rate.
3. Plugin callback success rate by lifecycle event.
4. Tool success rate for explicit modify/forget operations.
5. OpenClaw-to-daemon roundtrip latency p95 for hook/tool calls.

Targets:

- plugin adoption >= 90% before deprecating legacy path
- duplicate recall/capture incidents = 0
- callback and tool success rates >= 99%

---

## 20) Benchmarking Methodology

### 20.1 Benchmark datasets

Build three datasets:

1. Real anonymized remember/recall pairs from active usage.
2. Synthetic gold dataset with known facts, updates, and contradictions.
3. Adversarial dataset (ambiguous phrasing, negation, noisy formatting,
   trivial chatter, malformed JSON-like input).

Build one additional mutation dataset:

4. Modify/forget intent dataset with gold target IDs, including
   near-duplicate memories and pinned-memory edge cases.

Each dataset must include expected retrieval labels and expected update
actions for scoring.

### 20.2 Offline quality benchmark

Method:

1. Run baseline pipeline and v2 pipeline on identical dataset snapshots.
2. Freeze embedding model and extraction model versions for run
   comparability.
3. Score Recall@k, nDCG, duplicate rate, decision precision/recall.
4. Score modify precision and forget precision on mutation dataset.

Output:

- per-dataset report
- aggregate weighted score
- regression diff report by metric and error category

### 20.3 Online canary benchmark

Method:

1. Route small traffic slice to v2 with feature flags.
2. Keep baseline as control.
3. Compare latency, queue stability, and user-visible recall quality.
4. Compare modify/forget safety metrics (false delete, wrong-target edit).

Guardrails:

- automatic rollback if latency or error thresholds breach for fixed
  window.

### 20.4 Load and stress benchmark

Scenarios:

1. sustained remember traffic
2. burst remember traffic
3. mixed remember+recall traffic
4. provider degraded/unavailable periods

Measurements:

- throughput (RPS/jobs-per-minute)
- queue lag
- sqlite busy rates
- p95/p99 latency
- wrong-target modify rate
- wrong-target forget rate

### 20.5 Resilience benchmark

Inject failures:

- daemon restart during leased jobs
- provider timeout spikes
- malformed model responses
- temporary file lock contention

Pass criteria:

- no memory loss
- eventual job completion or dead-letter with audit trail
- recovery path functional
- no unrecoverable delete from explicit forget endpoints

### 20.6 Cost benchmark

Run controlled 10k remember workload per provider mode and collect:

- tokens consumed
- estimated spend
- median and p95 processing latency
- quality score deltas vs local provider

### 20.7 Self-healing benchmark

Method:

1. Run deterministic failure scenarios (queue stall, lease leak,
   provider outage, index drift, rollback requirement).
2. Compare control (alerts only) vs autonomous maintenance mode.
3. Measure MTTD, MTTR, successful repairs, and safety outcomes.

Pass criteria:

- autonomous mode meets MTTR and safety targets from section 19.5
- no autonomous action bypasses policy controls
- complete audit chain exists for every autonomous action

### 20.8 OpenClaw runtime benchmark

Method:

1. Run the same scripted conversations through:
   - plugin-first runtime path (`@signet/adapter-openclaw`)
   - legacy command-hook compatibility path
2. Measure recall quality parity, capture quality parity, and operation
   latency.
3. Validate explicit modify/forget behavior and audit events.

Pass criteria:

- plugin path is non-inferior on recall/capture quality
- plugin path meets latency and reliability SLOs
- no duplicate actions in compatibility or mixed-mode tests

---

## 21) Risks and Mitigations

1. Over-locking from naive transaction scope
   - Mitigation: strict short transactions + compare-and-set writes.
2. Model hallucinated updates/deletes
   - Mitigation: pinned hard-block, confidence thresholds, recoverability,
     history audit.
3. Queue backlog under provider degradation
   - Mitigation: mode fallback, retry backoff, queue alerts, dead-letter.
4. Schema drift across installations
   - Mitigation: robust schema detection + additive migration + backup.
5. Privacy leakage to remote providers
   - Mitigation: local default, redaction, provider allowlist, local-only
     enforcement.

---

## 22) Failure Modes and Guardrails

Each guardrail below is required and has a release gate.

### 22.1 Unauthorized modify/forget

- Required controls:
  - caller identity must be resolved for every mutate request
  - role-based policy for `remember`, `modify`, `forget`, `recover`
  - actor identity must be written to history for every mutation
- Release gate:
  - policy tests prove unauthorized requests are denied and authorized
    requests succeed with correct audit actor

### 22.2 Mass forget blast radius

- Required controls:
  - mandatory `preview` mode for query forget
  - max-delete threshold per request
  - confirm token required above threshold
  - optional dry-run-only policy mode for canary
- Release gate:
  - simulated broad forget cannot execute without preview + confirmation,
    and threshold policy blocks oversized requests

### 22.3 Wrong-target modify/forget

- Required controls:
  - strict ID-based execution after preview selection
  - optimistic concurrency via `if_version`
  - per-item result reporting for batch operations
- Release gate:
  - mutation benchmark meets wrong-target thresholds for edit/delete

### 22.4 Human edit override erosion

- Required controls:
  - `manual_override` lock with configurable TTL
  - inferred LLM updates blocked during lock window unless forced by
    explicit operator intent
- Release gate:
  - tests verify inferred updates do not overwrite locked memories

### 22.5 Cross-tenant or cross-scope memory leakage

- Required controls:
  - mandatory filter scoping (`user_id`/`agent_id`/`run_id`) on all
    search/mutation paths
  - reject unscoped destructive operations unless explicit admin policy
- Release gate:
  - tenant isolation tests show no cross-scope read/write/delete leakage

### 22.6 Prompt injection via stored memory content

- Required controls:
  - memory text treated as untrusted input in prompts
  - prompt templates isolate instructions from content blocks
  - strip or neutralize high-risk control tokens in model context
- Release gate:
  - adversarial prompt-injection test suite passes with no policy bypass

### 22.7 Retry duplication and non-idempotent mutations

- Required controls:
  - idempotency keys for explicit mutate endpoints
  - compare-and-set updates by version
  - dedup key for queued jobs to prevent duplicate processing
- Release gate:
  - retry/replay tests show no duplicate UPDATE/DELETE side effects

### 22.8 Graph drift after modify/forget

- Required controls:
  - modify/delete updates `memory_entity_mentions` and relation counts
  - periodic graph consistency checker job
- Release gate:
  - consistency checks show no orphan links after mutation workloads

### 22.9 Tombstone/history retention gaps

- Required controls:
  - separate retention policies for active memory, tombstones, history,
    and jobs
  - purge worker must run in safe order (links -> tombstones -> history)
- Release gate:
  - retention tests prove recoverability within SLA and clean purge after
    expiry

### 22.10 Low-quality eval labels

- Required controls:
  - human-labeled gold set for modify/forget with adjudication
  - inter-rater agreement threshold before benchmark acceptance
- Release gate:
  - benchmark report includes label quality metrics and passes minimum
    agreement requirement

### 22.11 Operational recovery failure

- Required controls:
  - tested backup/restore runbook
  - tested queue replay from crash state
  - tested rollback trigger and procedure
- Release gate:
  - game-day drill passes with documented timings and no data loss

### 22.12 Abuse and anomaly spikes

- Required controls:
  - anomaly alerts for delete spikes and wrong-target mutation spikes
  - per-caller rate limits for forget/modify
  - emergency mutation freeze switch
- Release gate:
  - staged abuse simulation triggers alerts and freeze switch behaves as
    expected

### 22.13 Runaway or unsafe autonomous remediation

- Required controls:
  - bounded action budgets per hour/day and per incident
  - mandatory health re-check after each repair step
  - automatic halt after repeated ineffective repairs
  - human escalation path with full state snapshot
- Release gate:
  - chaos test proves loop halts safely on non-improving conditions and
    escalates correctly

### 22.14 OpenClaw dual-path execution conflicts

- Required controls:
  - runtime arbitration key per session that selects plugin or legacy
    path
  - idempotency keys on capture actions across both paths
  - clear precedence rules in config and docs
- Release gate:
  - mixed-mode tests prove no duplicate remember/recall/capture actions

---

## 23) Implementation Deliverables

1. Updated schema and migration set with rollback runbook.
2. Durable memory job queue + worker loop semantics.
3. Extraction/decision pipeline integrated with remember endpoint.
4. Explicit modify/forget API + history and recovery endpoints.
5. Graph extraction storage and graph-boosted retrieval.
6. Metrics, dashboards, and alert rules.
7. Benchmark harness + baseline and canary report templates.
8. Agent maintenance plane (diagnostics + repair actions + policy engine).
9. Autonomous maintenance benchmark suite and runbooks.
10. Operator docs for config, rollout, failure handling, and escalation.
11. OpenClaw plugin-first runtime integration with legacy fallback mode.
12. OpenClaw migration and deprecation runbook for command-hook path.

---

## 24) Final Acceptance Checklist

All must pass:

- schema migration dry run and live run tested
- queue recovery tested across restart
- pinned deletion prevention verified
- soft-delete retention + recover verified
- explicit modify endpoint concurrency guard tested
- explicit forget preview/execute safeguards tested
- offline benchmark meets quality targets
- canary metrics meet latency/reliability targets
- autonomous maintenance gates meet section 19.5 targets
- kill switch and escalation workflows tested end-to-end
- OpenClaw plugin path passes parity and no-duplication gates
- rollout and rollback procedures documented and exercised

---

## 25) Immediate Next Steps

1. Approve this spec as implementation contract.
2. Create phase-level tickets (A through G) with explicit owners.
3. Capture baseline benchmark snapshot before first code change.
4. Start Phase A behind feature flags, then proceed by gates.
5. Define autonomous maintenance action policy and escalation matrix.
6. Finalize OpenClaw plugin-vs-legacy arbitration policy and migration
   timeline.

---

## 26) OpenClaw Plugin-First Integration Specification

### 26.1 Scope and intent

This section defines how OpenClaw wiring fits into the memory pipeline
implementation so runtime behavior, safety, and observability remain
consistent with the rest of this spec.

### 26.2 Component responsibilities

1. `@signet/connector-openclaw` (install/bootstrap):
   - patch OpenClaw config entries
   - install compatibility hook files
   - no long-term ownership of runtime memory policy
2. `@signet/adapter-openclaw` (runtime integration):
   - lifecycle callbacks to daemon hook endpoints
   - runtime tool surface for memory operations
   - primary path for remember/recall/modify/forget in OpenClaw
3. Signet daemon:
   - single source of truth for memory semantics, policy, and audit
   - endpoint contract owner for hooks and memory APIs

### 26.3 Runtime path selection

One path must be active per OpenClaw session:

- `plugin` (preferred)
- `legacy-hook` (compatibility)

Selection rules:

1. If plugin capability is present and healthy, use plugin.
2. If plugin capability is absent, fall back to legacy-hook.
3. If both are configured, arbitration enforces one active path and logs
   the decision.

### 26.4 Required OpenClaw runtime capabilities

1. Lifecycle callbacks:
   - session start
   - user prompt submit
   - session end
   - pre-compaction
   - compaction complete
2. Tool operations:
   - memory_search, memory_store, memory_get, memory_list
   - memory_modify, memory_forget
3. Error handling:
   - graceful daemon timeout behavior
   - explicit user-visible error summaries
   - retry only when idempotency is guaranteed

### 26.5 Safety and consistency requirements

1. No duplicate capture/recall per event.
2. Explicit modify/forget must route through the same policy checks and
   history writes as non-OpenClaw callers.
3. Plugin and legacy compatibility paths must emit equivalent audit
   fields (`actor`, `session`, `request`, `path`).

### 26.6 Deprecation policy for legacy command-hook path

1. Keep compatibility path until plugin adoption and reliability targets
   are met (section 19.6).
2. Announce deprecation window with migration instructions.
3. Remove legacy path only after canary and GA windows complete without
   duplicate-action incidents.

---

## 27) Locked Implementation Decisions

These decisions are approved defaults for implementation unless
explicitly superseded by a future revision.

### 27.1 OpenClaw legacy fallback sunset

1. Keep legacy command-hook fallback for at least 90 days after
   plugin-first GA.
2. Legacy removal is blocked until section 19.6 targets are met:
   - plugin adoption >= 90%
   - duplicate recall/capture incidents = 0
   - callback and tool success rates >= 99%

### 27.2 Force-delete authority for pinned memories

1. Force-delete of pinned memories is operator-only by default.
2. Autonomous agents are denied force-delete unless a future policy
   explicitly enables it.
3. Force-delete requires reason, preview/confirmation flow, and audit
   event with actor identity.

### 27.3 Privacy default

1. New installs default to `local_only = true` for memory pipeline LLM
   processing.
2. Remote providers remain opt-in.
3. Existing installs preserve current behavior unless users opt into
   stricter privacy mode.

### 27.4 Retention defaults

Default retention windows:

1. Soft-deleted memories (tombstones): 30 days.
2. Memory history events: 180 days.
3. Completed jobs: 14 days.
4. Dead-letter jobs: 30 days.

These values are configurable and may be tightened by policy.

Privacy-sensitive install policy:

1. History retention must be explicitly chosen during setup (no implicit
   default).
2. Recommended choices are 90 or 180 days based on operator risk posture.

### 27.5 Autonomous maintenance bounds (GA)

Allowed unattended actions:

1. Requeue retryable jobs and release stale leases.
2. Run index/consistency checks and non-destructive repairs.
3. Run bounded re-embed jobs for model/version drift.

Human-approval-required actions:

1. Bulk forget operations.
2. Force-delete or pinned deletions.
3. Retention purge overrides and destructive rollback operations.

### 27.6 OpenClaw migration benchmark bar

Plugin-first migration passes only when all are true:

1. Plugin path is non-inferior to legacy path on recall/capture quality.
2. Plugin path is equal or better on reliability and latency SLOs.
3. Duplicate actions remain zero in mixed-mode and canary windows.

---

## 28) Competitive Gap Mapping (Supermemory Comparison)

This section maps current observed product gaps (vs `references/supermemory/`)
to this implementation plan so prioritization stays explicit.

### 28.1 Current gap categories (as of this draft)

1. Memory lifecycle completeness:
   - missing shipped explicit `modify/forget/history/recover` endpoints
   - limited mutation safety tooling in GA path today
2. Ingestion breadth:
   - limited native ingest surface compared to URL/file/media/connectors
3. Ecosystem integrations:
   - thinner framework middleware and SDK ergonomics
4. MCP distribution posture:
   - less standardized hosted OAuth/API-key style MCP path
5. Product analytics:
   - less complete usage/error analytics for operator workflows

### 28.2 What v2 phases close directly

1. Phases A-D close most memory lifecycle and safety gaps:
   - durable queue + retries
   - explicit modify/forget + history + recover
   - pinned safety invariants and mutation policy controls
2. Phase E closes graph-aware retrieval quality gaps.
3. Phase F closes self-healing and operational rigor gaps.
4. Phase G closes OpenClaw runtime parity and duplicate-path safety gaps.

### 28.3 What remains after v2 (out of scope for A-G)

1. Broad connector catalog and sync orchestration.
2. Framework-native middleware/tooling parity across major app stacks.
3. Hosted multi-tenant analytics and scoped auth experience.

---

## 29) Post-v2 Expansion Phases (H-K)

These phases begin only after section 24 acceptance criteria pass.

### Phase H: Ingestion and Connector Foundation (local-first first)

- Add first-class document ingest contracts for text/URL/file with
  asynchronous processing status (`queued/extracting/chunking/embedding/indexing/done/failed`).
- Introduce connector runtime interface and provider contract:
  auth, incremental sync, replay, idempotency, provenance.
- Ship initial connector set focused on highest leverage:
  GitHub docs, local filesystem/project docs, and Google Drive.
- Gate: connector imports are idempotent, auditable, and do not violate
  local-first defaults.

### Phase I: SDK and Agent Integration Surface

- Expand `@signet/sdk` to typed memory lifecycle APIs aligned with v2
  (`remember/recall/modify/forget/history/recover/jobs`).
- Add framework adapters:
  - Vercel AI SDK middleware/tool package
  - OpenAI SDK helper package (TypeScript first, Python optional)
- Standardize examples and reference templates for memory injection
  prompts and safe tool calling.
- Gate: integration examples pass conformance tests and benchmark parity
  with direct daemon API usage.

### Phase J: Auth Scope and Deployment Modes

- Keep localhost/no-auth as default path.
- Add optional authenticated mode for remote/team deployments:
  scoped API tokens, role policy, and operation-level authorization.
- Add project/agent/user scoping guarantees for read/write/mutate
  operations.
- Gate: tenant/scope isolation tests pass with zero cross-scope leakage.

### Phase K: Analytics and Operator UX

- Add memory pipeline analytics endpoints and dashboard cards:
  throughput, error taxonomy, queue health, latency, mutation safety.
- Include exportable audit and incident timelines.
- Add benchmark report publishing workflow for canary/GA decisions.
- Gate: operators can diagnose top memory failures without ad-hoc log
  spelunking.

---

## 30) Prioritization Guardrails for H-K

1. Do not expand connector breadth before v2 mutation safety gates are
   green.
2. Favor depth over breadth: one production-grade connector beats five
   partial connectors.
3. Preserve local-first defaults in every new surface.
4. Any destructive operation must remain previewable, reversible, and
   fully audited.
5. New integration layers must reuse daemon contracts rather than invent
   parallel semantics.

---

## 31) Immediate Planning Actions (next cycle)

1. Convert Phases A-G into owner-assigned milestones with explicit
   acceptance tests per gate.
2. Freeze and capture baseline benchmark snapshot before A starts.
3. Draft Phase H RFC in parallel (contracts only, no implementation)
   so post-v2 execution can start without discovery lag.
4. Scope `@signet/sdk` v2 API surface in parallel with D/E so Phase I is
   not blocked on SDK design.
5. Define deployment mode policy matrix now (localhost default,
   authenticated optional) to de-risk Phase J.

---

## 32) Deep Implementation Plan (A-G)

This section converts phases into concrete implementation tracks,
component ownership, and sequencing constraints.

### 32.1 Package ownership map

1. `@signet/core` owns:
   - schema and migrations API surface
   - memory domain types and validators
   - extraction/decision contracts
   - retrieval scoring and graph boost logic
2. `@signet/daemon` owns:
   - queue worker runtime and job leasing
   - API handlers and authorization policy checks
   - observability endpoints and health diagnostics
3. `@signet/sdk` owns:
   - typed client surface for all memory lifecycle APIs
   - integration-safe wrappers and transport defaults
4. `@signet/adapter-openclaw` owns runtime plugin behavior.
5. `@signet/connector-openclaw` owns install/bootstrap and fallback hooks.

### 32.2 Phase A implementation tracks (infrastructure hardening)

Track A1: Schema and migration runtime

1. Add migrations for:
   - `memories` new columns (`content_hash`, `normalized_content`,
     `is_deleted`, `deleted_at`, `pinned`, `importance`,
     `extraction_status`, provenance fields)
   - `memory_history`
   - `memory_jobs`
   - graph tables (`entities`, `relations`, `memory_entity_mentions`)
2. Add migration audit table:
   - `schema_migrations_audit(id, started_at, ended_at, outcome, details)`
3. Add preflight command/API:
   - detect schema state
   - produce additive migration plan report
   - verify backup existence + checksum

Track A2: DB access and transaction boundaries

1. Introduce single daemon DB accessor factory with:
   - one write handle
   - pooled read handles when beneficial
2. Implement explicit transaction wrappers:
   - `txIngestEnvelope()`
   - `txApplyDecision()`
   - `txFinalizeAccessAndHistory()`
3. Enforce no provider call inside write transaction via lintable guard:
   - central helper requiring pure DB closures

Track A3: Feature flags and kill switches

1. Add config keys:
   - `memory.pipelineV2.enabled`
   - `memory.pipelineV2.shadowMode`
   - `memory.pipelineV2.allowUpdateDelete`
   - `memory.pipelineV2.graph.enabled`
   - `memory.pipelineV2.autonomous.enabled`
2. Add emergency freeze controls:
   - `memory.pipelineV2.mutationsFrozen`
   - `memory.pipelineV2.autonomousFrozen`

Track A4: Baseline compatibility

1. Keep legacy remember/recall behavior default-on until gates pass.
2. Add dual-read diagnostics mode:
   - compare baseline vs v2 candidate retrieval silently
   - log divergence metrics only

Exit criteria for Phase A (must all pass)

1. Additive migration succeeds on representative legacy DB snapshots.
2. Daemon restarts safely during migration/backfill.
3. No regression in existing `/remember` + `/recall` user path.

### 32.3 Phase B implementation tracks (shadow extraction)

Track B1: Contract-first extractors

1. Implement extractor interface:
   - `extractFactsAndEntities(input): ExtractionResult`
2. Add validator with hard caps:
   - max facts
   - max entities/relations
   - max fact length
   - reject trivial or malformed outputs
3. Persist warnings even when extraction fails.

Track B2: Shadow decision engine

1. Implement candidate retrieval for each fact (top-K hybrid).
2. Implement decision contract parser for `ADD/UPDATE/DELETE/NONE`.
3. Persist proposed decisions to history with `event=NONE` +
   `decision_reason`, without mutating memories.

Track B3: Job worker + retry behavior

1. Worker loop with leasing:
   - lease timeout
   - stale lease reaper
   - exponential backoff with jitter
2. Job dedup keys:
   - one active extract job per memory/version
3. Dead-letter path with machine-readable error codes.

Exit criteria for Phase B

1. Parse reliability reaches threshold on real traffic sample.
2. Shadow decisions produce explainable audit records.
3. Queue remains stable under provider timeouts/outages.

### 32.4 Phase C implementation tracks (controlled writes: ADD/NONE)

Track C1: ADD write path

1. Enable ADD application with idempotency checks:
   - exact hash duplicate collapse at DB layer
2. Write mandatory history event in same commit as memory mutation.
3. Update embedding linkage for newly added memory.

Track C2: Contradiction and duplicate suppression

1. Run contradiction detector before destructive recommendations.
2. When contradiction risk present:
   - block destructive write
   - emit review-needed marker

Track C3: Read-path confidence controls

1. Exclude low-confidence extracted facts from write path by threshold.
2. Keep raw envelope available regardless of quality outcome.

Exit criteria for Phase C

1. Duplicate growth is materially reduced from baseline.
2. No data-loss incidents under repeated retries/restarts.

### 32.5 Phase D implementation tracks (full semantic decisions)

Track D1: Explicit mutation APIs

1. Implement endpoints from section 14.5-14.8.
2. Require `reason` for all mutate operations.
3. Add `if_version` optimistic concurrency guards.

Track D2: Soft-delete and recoverability

1. Implement soft-delete semantics in all forget flows.
2. Implement recover endpoint with retention-window checks.
3. Retention worker enforces purge order:
   links -> tombstones -> history.

Track D3: Pinned and policy guardrails

1. Reject pinned delete unless force + policy-authorized actor.
2. Deny autonomous force delete by default (locked decision 27.2).
3. Record actor identity + request/session correlation for all mutations.

Exit criteria for Phase D

1. Wrong-target edit/delete metrics meet section 22 release gates.
2. Recover path passes SLA and audit-chain checks.

### 32.6 Phase E implementation tracks (graph + optional rerank)

Track E1: Graph extraction persistence

1. Persist entities/relations with merge policies.
2. Maintain `memory_entity_mentions` as mandatory link table.
3. On modify/delete, update mention counts and orphan cleanup safely.

Track E2: Query-time graph boost

1. Query entity extraction and nearest-entity resolution.
2. One-hop expansion and score boost integration:
   `final = a*vector + b*bm25 + c*access + d*graph`.
3. Graceful fallback to baseline hybrid if entity resolution fails.

Track E3: Optional reranker

1. Add reranker hook for top-N only.
2. Enforce strict timeout with fallback to pre-rerank ordering.
3. Instrument latency overhead separately.

Exit criteria for Phase E

1. Recall@10 and nDCG targets met without latency SLO breach.
2. Graph consistency checks show no orphan-link drift.

### 32.7 Phase F implementation tracks (autonomous maintenance)

Track F1: Diagnostics plane

1. Add read-only health endpoints for:
   queue, storage, index, provider, mutation safety.
2. Compute health score with sub-scores per domain.

Track F2: Repair action plane

1. Implement policy-gated actions:
   requeue, lease release, reindex checks, bounded reembed.
2. Require reason + actor + correlation id on every action.
3. Enforce per-action cooldown and hourly/day action budgets.

Track F3: Safety automation loop

1. Observe-only mode first (recommendations, no mutation).
2. Promote to execute mode only after canary gates.
3. Auto-halt on repeated non-improving remediations.

Exit criteria for Phase F

1. MTTR improves while maintaining zero autonomous safety incidents.
2. Kill switch proven effective immediately.

### 32.8 Phase G implementation tracks (OpenClaw plugin-first)

Track G1: Runtime path arbitration

1. Session-level arbitration key chooses plugin vs legacy path.
2. Emit audit field `runtime_path` for every memory operation.
3. Enforce one active path per session.

Track G2: Tool and lifecycle parity

1. Ensure plugin supports full lifecycle callbacks.
2. Ensure plugin exposes memory tool parity:
   search/store/get/list/modify/forget.
3. Route plugin mutations through same daemon policy engine as all callers.

Track G3: Compatibility de-risking

1. Keep legacy hooks gated and measurable.
2. Add duplicate-action guard keys across both paths.
3. Publish migration + deprecation runbook.

Exit criteria for Phase G

1. Plugin path non-inferior quality, equal/better reliability/latency.
2. Duplicate actions remain zero in mixed-mode canary.

### 32.9 Dependency-critical sequencing

1. A must complete before any B-F mutating behavior.
2. B shadow data should run long enough to calibrate thresholds before C.
3. D cannot ship before mutation policy and retention worker are complete.
4. E graph boost should be enabled only after D mutation correctness gates.
5. F execute mode cannot ship before D+E safety baselines are stable.
6. G deprecation timeline starts only after F operational maturity.

---

## 33) Deep Implementation Plan (H-K)

These phases focus on product surface parity while preserving local-first
and mutation safety guarantees from v2.

### 33.1 Phase H: Ingestion and connector foundation

H1: Document ingest API and lifecycle

1. Introduce document-level model:
   - `documents` table with status machine and provenance
   - mapping from document -> derived memories
2. Proposed ingest endpoints:
   - `POST /api/documents` (text/url payload)
   - `POST /api/documents/file` (file upload)
   - `GET /api/documents/:id` (status + diagnostics)
   - `GET /api/documents/:id/chunks` (debug/inspection)
3. Status machine:
   `queued -> extracting -> chunking -> embedding -> indexing -> done|failed`.

H2: Connector runtime contract

1. Define connector interface:
   - `authorize()`
   - `listResources()`
   - `syncIncremental(cursor)`
   - `syncFull()`
   - `replay(resourceId, fromVersion)`
2. Required connector metadata:
   - provider, tenant scope, cursor, last sync, rate-limit state,
     error state, provenance tags.
3. Shared connector safeguards:
   - idempotency keys by source document hash + provider version
   - per-connector backoff and dead-letter queue
   - replay-safe mutation behavior

H3: Initial connector set (depth-first)

1. GitHub docs connector (text docs only first pass).
2. Local filesystem docs connector (watch + snapshot modes).
3. Google Drive connector as first OAuth source.

H4: Connector operations

1. Connector-specific health diagnostics and forced resync API.
2. Manual sync + preview impact report before destructive sync actions.
3. Connector runbook for quota/permission/replay failures.

Exit criteria for H

1. At least one connector is production-grade with replay + idempotency.
2. Document ingest lifecycle is visible and debuggable end-to-end.

### 33.2 Phase I: SDK and framework integrations

I1: `@signet/sdk` v2 client

1. Add typed methods for:
   remember, recall, modify, forget, history, recover, jobs, documents.
2. Add strong request/response schemas and error classes.
3. Add transport policies:
   retries only for idempotent operations by default.

I2: Framework adapters

1. Vercel AI SDK adapter:
   - context injection middleware
   - memory tool bindings
   - safety defaults for mutation operations
2. OpenAI SDK adapter (TS first):
   - helper for tool definitions + execution wrappers
   - conversation-scoped memory context helpers
3. Optional Python adapter follows after TS parity and adoption signal.

I3: Conformance + examples

1. Golden integration tests verify adapters match daemon API semantics.
2. Reference examples for chat agents and coding agents.
3. Include "safe defaults" templates:
   preview-first forget, version-guarded modify.

Exit criteria for I

1. Adapter flows show non-inferior recall quality vs direct API calls.
2. Mutation safety invariants preserved through all adapter layers.

### 33.3 Phase J: Auth scope and deployment modes

J1: Deployment mode matrix

1. `local-default` mode:
   - localhost only
   - no mandatory auth
2. `team-auth` mode (optional):
   - token auth required
   - scoped policy enforcement
3. `hybrid` mode:
   - local commands remain frictionless
   - remote endpoints require auth and scope

J2: Token and policy model

1. Token classes:
   - personal full-scope token
   - scoped token (project/agent-restricted)
   - short-lived session token (optional)
2. v1 scope granularity includes project + agent + user dimensions.
3. Permission matrix by operation:
   remember/recall/modify/forget/recover/admin.
4. Mandatory scope filters in all query and mutation paths.

J3: Security and abuse controls

1. Rate limits for destructive operations.
2. Threshold confirmation for bulk forget and force delete.
3. Full audit provenance for caller identity and role.

Exit criteria for J

1. Isolation tests prove no cross-scope leakage.
2. Unauthorized mutation tests pass under all deployment modes.

### 33.4 Phase K: Analytics and operator UX

K1: Analytics data model

1. Usage counters by endpoint, actor, provider, connector.
2. Error taxonomy with stage-level codes.
3. Latency histograms for remember/recall/mutate/jobs.

K2: API endpoints and dashboard

1. Proposed endpoints:
   - `GET /api/analytics/usage`
   - `GET /api/analytics/errors`
   - `GET /api/analytics/logs`
   - `GET /api/analytics/memory-safety`
2. Dashboard cards:
   queue health, dead-letter trend, mutation safety,
   provider status, connector sync health.

K3: Operator incident workflow

1. One-click export of timeline for a request/session/memory id.
2. Include policy decisions and automated actions in timeline.
3. Add benchmark report publication to release decision checklist.

Exit criteria for K

1. Top incident classes diagnosable from dashboard + APIs alone.
2. Canary/GA decisions use standard published benchmark artifacts.

---

## 34) Detailed Milestone Graph and Suggested Sprinting

Assumes 2-week iterations and parallel work where safe.

### 34.1 Milestone groups

1. M1 (A1-A3): Schema + DB access + flags
2. M2 (B1-B3): Shadow extraction + queue stabilization
3. M3 (C1-C3): Controlled ADD writes + contradiction controls
4. M4 (D1-D3): Explicit mutation APIs + recovery + policy hardening
5. M5 (E1-E3): Graph persistence + graph boost + optional rerank
6. M6 (F1-F3): Diagnostics + repair actions + autonomous observe mode
7. M7 (G1-G3): OpenClaw plugin-first arbitration and parity
8. M8 (H1-H4): Document ingest + first production-grade connector
9. M9 (I1-I3): SDK v2 + framework adapters + conformance
10. M10 (J1-J3 + K1-K3): deployment auth modes + analytics UX

### 34.2 Parallelism guidance

1. M1 and benchmark harness prep can run together.
2. M2 shadow mode and API contract stubs for D can run together.
3. M5 graph extraction implementation can start during late M4,
   but feature-flagged off until D gates pass.
4. M8 RFC and interface contracts can start during M6/M7.
5. M9 SDK surface design should start before M8 completes.

### 34.3 Suggested de-risking order

1. Prioritize mutation correctness before connector breadth.
2. Prioritize policy correctness before authenticated deployment.
3. Prioritize observability before autonomous execute mode.

---

## 35) Engineering Findings and Recommendations

1. The strongest competitive leverage is not connector count first; it is
   trusted memory correctness under mutation and recovery.
2. Shipping explicit modify/forget/history/recover (D) is the highest
   product-perception unlock for parity.
3. Graph quality work (E) should stay conservative until mutation safety
   error rates are well-characterized.
4. OpenClaw plugin-first migration (G) is strategic for ecosystem
   coherence; treat duplicate-action prevention as a hard invariant.
5. Post-v2 connector work (H) should be depth-first with one excellent
   connector before expansion.
6. SDK/integration surfaces (I) need conformance tests so wrappers never
   drift from daemon policy semantics.
7. Optional auth modes (J) should not compromise local-default UX.
8. Analytics (K) should be considered a reliability feature, not just UX.

---

## 36) Operator Interview Outcomes (resolved)

The following implementation decisions were confirmed by operator input
and now act as planning defaults.

1. Phase H OAuth connector priority:
   - Google Drive first.
2. Phase J auth scope model for v1:
   - include project + agent + user scoping in first authenticated mode.
3. Phase I adapter scope:
   - defer Python adapter from wave 1; prioritize TypeScript adapter
     quality and adoption signal.
4. Privacy-focused retention policy:
   - history retention must be config-required at setup.
5. Analytics redaction default:
   - configurable at setup with safe presets (not one hard global mode).
6. Release-blocking metric priority:
   - wrong-target mutation precision takes precedence over latency p95.

### 36.1 Plan implications from interview

1. Phase J complexity increases; allocate extra validation budget for
   scope-composition and isolation tests.
2. Setup UX must include retention + analytics redaction decisions.
3. Phase I timeline should assume TS adapter is productionized before
   Python starts.
4. Canary gates should halt rollout on mutation precision regressions
   even when latency remains within SLO.
