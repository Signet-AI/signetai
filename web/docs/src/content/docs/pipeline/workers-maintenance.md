---
title: "Workers and maintenance"
description: "Operate bounded ingestion, indexing, queue, and retention work."
---

This page covers active supporting work. It excludes retired per-memory extraction, decision, structural-classification, dependency-synthesis, and session-end summary workers. Historical `extract` rows are compatibility history, not executable work.

## Inspect before repairing

Use the daemon-backed pipeline status and operator diagnostics before changing state:

- `GET /api/pipeline/status` reports worker admission, queue counts, leases, retries, terminal failures, and paused or degraded state.
- `GET /api/diagnostics/queue` reports queued, leased, stale, retryable, and dead work. Check agent scope, job type, lease age, attempt count, and last error.
- `GET /api/embeddings/health` and `GET /api/embeddings/status` report model-worker and coverage state. `GET /api/repair/embedding-gaps` identifies scoped gaps.
- `GET /api/dream/status` reports Dreaming passes and their terminal outcome.

Treat partial, stale, blocked, cancelled, timed-out, and failed results as states to resolve, not as success. All operator routes require the daemon and their documented authorization.

## Ingest lifecycle and recovery

Document and transcript ingestion is evidence work. It preserves source bytes, content, timestamps, scope, and provenance before any derived interpretation. Active jobs move through `pending`/`queued` → `leased`/`running` → `completed`; bounded retries may return a job to `queued`, while exhausted or non-retryable work becomes `dead`/`failed`. Pause and cancel are durable controls.

A lease has an owner, token, expiry, and generation. On restart or expiry, recovery reclaims stale leases and resumes from the durable checkpoint; it must not duplicate committed evidence. Inspect `next_attempt_at`, retry count, checkpoint, and error before retrying. Imported records reconcile as `total = imported + duplicate + rejected + pending`; completed work has no pending records. Source removal purges source-owned evidence and indexes while retaining bounded audit tombstones.

## Queue repair: dry-run first

Queue repair is an admin-authorized operator action, not an automatic second executor. The CLI exposes `signet repair queue requeue`, `signet repair queue cancel`, and `signet repair queue prune`. Each command is dry-run by default; pass `--apply` to apply the mutation. The commands are thin clients of the canonical `POST /api/diagnostics/queue/repair` endpoint, which remains available for authenticated HTTP clients such as `curl`. The JSON `action` is required and must be `requeue`, `cancel`, or `prune`; invalid JSON, a missing action, or an invalid action returns HTTP `400` with a structured `{ "error": "..." }` response. HTTP requests are dry-run by default and only `"dryRun": false` applies a mutation.

```bash
signet repair queue requeue --tables=memory --older-than=1h --max-batch=50
signet repair queue requeue --tables=memory --older-than=1h --max-batch=50 --apply
signet repair queue cancel --ids=JOB_ID
signet repair queue prune --tables=memory --older-than=90d --max-batch=1000 --apply
```

The CLI uses `SIGNET_DAEMON_URL` when set and otherwise targets the local daemon at `http://127.0.0.1:3850`. `requeue` accepts `--ids`, `--tables`, `--older-than`, `--error-pattern`, and `--max-batch`; `prune` accepts `--ids`, `--tables`, `--older-than`, and `--max-batch`; `cancel` accepts `--ids`, `--tables`, `--older-than`, and `--error-pattern`, but does not register `--max-batch`. `--apply` changes the request from dry-run to mutation. A daemon repair failure makes the CLI exit with status `1`; an acknowledged dry-run or successful apply exits `0`.

```bash
curl -X POST "$SIGNET_DAEMON_URL/api/diagnostics/queue/repair" \
  -H "Authorization: Bearer $SIGNET_TOKEN" \
  -H "Content-Type: application/json" \
  -H "X-Signet-Actor: operator-name" \
  -H "X-Signet-Actor-Type: operator" \
  -H "X-Signet-Reason: recover stale memory jobs" \
  -H "X-Signet-Request-Id: queue-repair-2025-01-15-001" \
  --data '{"action":"requeue","tables":["memory"],"olderThanMs":3600000,"maxBatch":50}'
```

The request fields are `action`, `dryRun`, `ids`, `tables`, `olderThanMs`, `errorPattern`, `retentionMs`, and `maxBatch`. `ids` selects explicit non-empty job IDs; the numeric filters must be positive. Defaults and caps are action-specific:

- `requeue` targets dead memory jobs. Its default `maxBatch` is 50, and its hard cap is 1,000 rows per call. The CLI exposes that setting as `--max-batch`. `olderThanMs` and `errorPattern` are optional filters.
- `cancel` targets dead or completed memory jobs older than 30 days by default. The endpoint uses a default `maxBatch` of 1,000 and a hard cap of 1,000 rows per call; the CLI does not expose `--max-batch`. `olderThanMs` replaces the 30-day default.
- `prune` targets dead, cancelled, or completed memory jobs older than 90 days by default. Its default `maxBatch` is 1,000, and its hard cap is 1,000 rows per call. The CLI exposes that setting as `--max-batch`; `retentionMs` supplies the retention window (the CLI flag is `--older-than`).

`--tables=summary` is a syntactically valid CLI selector, so the CLI sends it to the daemon; it is not a local flag error. The endpoint rejects any repair selecting `summary` with HTTP `410`, `success: false`, `affected: 0`, and a message that the summary worker is retired and session transcripts are delivered directly to Dreaming. The CLI renders that failure and exits with status `1`. An unsupported CLI table value (anything other than `memory` or `summary`) is rejected by Commander before the daemon request and exits with status `1`. For HTTP clients, invalid JSON returns `400` with `{ "error": "invalid json body" }`, and missing or invalid `action` returns `400` with `{ "error": "missing or invalid action" }`. The endpoint does not revive retired job types. Dry-run responses contain `preview` (capped at 100 IDs) and `totalMatching`; applied responses report `affected`. The response also contains `action`, `success`, and `message` (and may include `details`). Inspect the response rather than assuming every selected row changed.

Scope the request with explicit `tables` and/or `ids`, and do not combine an ambiguous broad selection with a destructive action. The queue repair endpoint does not accept an agent selector; use the daemon's resolved agent/authorization scope and confirm it in diagnostics before applying. Every request must identify the operator with `X-Signet-Actor`, `X-Signet-Actor-Type`, `X-Signet-Reason`, and `X-Signet-Request-Id` (the daemon supplies defaults, but explicit values make the audit reproducible). Applied repairs write a durable history event containing the action, actor, actor type, reason, request ID, affected count, and result message; dry-run intent is observable in the returned preview/message and logs but does not write a mutation audit event.

Requeue only stale or retryable jobs and respect the retry budget. Cancel work that must not run; cancellation does not erase evidence or audit history. Prune only explicitly selected terminal records after retention policy permits it; never prune active leases, source evidence, or the provenance needed to explain a derived row. `summary` repair is rejected because the summary worker is retired; session transcripts are completed at session end and delivered directly to Dreaming. Do not revive retired job types.

## Embeddings, indexes, and storage

Embedding rows, FTS, vector/ANN mirrors, graph indexes, hints, and projections are derived state. Check coverage, configured model and dimensions, stale or orphaned rows, FTS/vector consistency, and index freshness separately. Low coverage or an incomplete index must be reported as degraded or partial; it is not zero-result success.

Use these current daemon operations, all admin-authorized:

- `GET /api/repair/embedding-gaps[?agentId=AGENT_ID]` reports `total`, `embedded`, `unembedded`, and `complete` for the resolved agent scope. `agent_id` and `X-Signet-Agent-Id` are accepted aliases; cross-agent scope is denied.
- `POST /api/repair/re-embed` backfills missing memory embeddings. Its JSON payload accepts `agentId` (or `agent_id`), `batchSize` (positive integer, default 50), `dryRun` (default `false`), and `fullSweep` (default `false`). `batchSize` is capped at 500; positive finite values are floored and clamped to that cap, while invalid or non-positive values fall back to 50. A normal request processes one batch; `fullSweep: true` continues batch-by-batch until no progress or no rows remain (operator-only cooldown bypass). The operation is agent-scoped, rejects overlapping runs, and returns a structured repair result with `affected` and `message`; failures include policy, provider, stale-row, or cross-agent-hash details.
- `POST /api/repair/resync-vec` rebuilds the vector index mirror from embedding rows. It takes `{}` and returns the same structured repair result. Check the active embedding model/dimensions first; do not use it as a substitute for generating missing embeddings.

Provider work runs outside the short database mutation phase; writes re-check content, hash, agent, and active embedding profile before promotion. Successful backfills write a durable repair audit event with actor, reason, request ID, affected count, and result. After either operation, re-run `/api/embeddings/health`, `/api/embeddings/status`, and `/api/repair/embedding-gaps`; treat remaining gaps, profile changes, provider failures, and index mismatches as partial or failed outcomes. The database owner remains the sole synchronous SQLite owner.

## Dreaming invariants

Dreaming is the sole automatic semantic writer. It admits bounded, agent-scoped episodic evidence only after evidence is durably recorded and provenance is available. Each pass has an explicit admission decision, evidence selection, deadline, write cap, outcome, and audit trail. Candidates remain preview or question state until the audited ontology operation applies them; ingestion, indexing, retention, and maintenance never write semantic truth.

A pass must cite its evidence and preserve source lineage. Enforce the configured write cap before applying operations, advance the consumption/watermark only for durably handled evidence, and never advance it past skipped, failed, or uncommitted work. Replays are idempotent. Audit entries record scope, pass, evidence, operation, cap decision, and outcome. On cancellation, timeout, owner loss, or provider failure, report the terminal state and retry only through the bounded review path.

See [Pipeline and storage](/architecture/pipeline-storage/), [Dreaming and semantic operations](/pipeline/extraction-decisions/), and [Pipeline configuration](/configuration/pipeline/).
