# Plan: Surface and repair the dead summary-job backlog (issue #901)

> Closes <https://github.com/Signet-AI/signetai/issues/901>.
> Branch: `fix/issue-901-queue-backlog-visibility` cut from `origin/main`
> at `68d4352f` (release 0.147.15).
>
> **Adjacent PR:** <https://github.com/Signet-AI/signetai/pull/932>
> (`fix(daemon): split /health into liveness and readiness probes`)
> owns the `/health/live` and `/health/ready` probes plus CLI liveness
> labeling. This plan deliberately does **not** touch those routes or
> labels; it adds its own surfaces for queue visibility and repair.

## Problem

A live `0.147.1` database contained 92 completed summary jobs and
**1,667 dead summary jobs**. After
<a href="https://github.com/Signet-AI/signetai/issues/181">issue #181</a>
landed `summary_jobs` requeue support inside `requeueDeadJobs`, summary
job rows still slipped under every operator surface:

- `signet status` only renders memory-side extraction metrics.
- `GET /health` (legacy) reports `pipeline.extractionPending` from worker
  stats and never touches `summary_jobs` or `memory_jobs` counts.
- `GET /api/status` returns `pipeline.extraction.*` only.
- `GET /api/diagnostics` exposes `QueueHealth` whose `getQueueHealth`
  helper at `platform/daemon/src/diagnostics.ts:202` reads **only**
  `memory_jobs` (`summary_jobs` is invisible to diagnostics).
- `GET /api/pipeline/status` already returns `queues.memory` and
  `queues.summary` count maps at
  `platform/daemon/src/routes/pipeline-routes.ts:382` but they are
  flat `{pending,leased,completed,failed,dead}` integers without
  oldest-dead age, last error, dead-rate, or queue thresholds.
- The single repair action that knows about `summary_jobs`
  (`requeueDeadJobs` at `platform/daemon/src/repair-actions.ts:188`)
  has **no dry-run**, accepts no id/age filter, and there is **no**
  `cancelObsoleteJobs` / `pruneTerminalJobs` for the rows operators
  actually want to clean up — dead summary rows from months ago.

The issue's "Suggested fix" lists four operator-visible capabilities
that today are invisible or unsafe:

1. counts + oldest + last error on every surface,
2. readiness degraded under threshold,
3. safe repair commands with dry-run / preview,
4. provenance-preserving cancel / prune.

## Goals

- Make the dead summary-job backlog impossible to miss.
- Make repair **predictable**: dry-run by default, filters exposed,
  provenance preserved.
- Keep `/health` byte-for-byte compatible with #932 (legacy probes
  untouched).
- Achieve Rust daemon parity for every new HTTP route.

## Non-goals

- Anything owned by PR #932 (`/health/live`, `/health/ready`,
  `signet status` liveness labeling, queue-threshold constants
  shared with readiness).
- Renaming `memory_jobs` / `summary_jobs`.
- Adding new queue types beyond memory / summary / extraction.
- Auto-execution of repair commands by the maintenance worker
  (the worker can keep *recommending*; operators trigger manually).

## Recon

- `platform/daemon/src/diagnostics.ts:202` — `getQueueHealth` reads
  `memory_jobs` only.
- `platform/daemon/src/diagnostics.ts:240` — same helper computes a
  composite score with depth, dead rate, oldest age, lease anomalies.
- `platform/daemon/src/routes/health.ts:5` — `/health` adds
  `pipeline.extractionPending` only.
- `platform/daemon/src/routes/pipeline-routes.ts:382` —
  `/api/pipeline/status.queues.{memory,summary}` flat integer maps.
- `platform/daemon/src/repair-actions.ts:188` —
  `requeueDeadJobs(accessor, cfg, ctx, limiter, maxBatch)` requeues
  both tables under a single budget but exposes no dry-run / id /
  age filter.
- `platform/core/src/migrations/009-summary-jobs.ts` —
  `summary_jobs` schema (`id, session_key, harness, project,
  transcript, status, result, attempts, max_attempts, created_at,
  completed_at, error`).
- `platform/core/src/migrations/087-summary-jobs-boundary-reason.ts` —
  adds `boundary_reason`; both migrations are idempotent.
- `surfaces/cli/src/features/health.ts` — `signet status` renders
  `health.status`, `health.composite`, extraction-degraded banner.
  No `pipeline queues` block today.
- `platform/daemon-rs/crates/signet-daemon/src/routes/repair.rs:331`
  — Rust handler for `POST /api/repair/requeue-dead` already mirrors
  TypeScript shape; precedent for parity on repair endpoints.
- `platform/daemon-rs/contracts/route-parity.json` —
  328 routes, 319 `native-rust-replay-proven`, 7 `mounted-shallow`,
  2 `missing`. New routes must land `native-rust-replay-proven` to
  satisfy PR-readiness gates.

---

## Phase 1 — Per-queue diagnostics data

> Lift `summary_jobs` and `extraction_jobs` into the health surface
> without breaking the legacy aggregate fields `getQueueHealth` already
> publishes.

- [ ] Add a new module `platform/daemon/src/diagnostics-queue.ts`
      exporting:
      - `interface QueueCounts` with `pending, leased, completed, failed,
        dead, oldestAgeSec, oldestDeadAgeSec, lastError: string | null`.
      - `getQueueCounts(db, source): QueueCounts` for each of
        `memory_jobs`, `summary_jobs`, and the `memory_jobs WHERE
        job_type = 'extraction'` extraction slice.
      - `getOldestDeadJob(db, source): {id, harness, session_key,
        created_at, attempts, error} | null`.
- [ ] Refactor `platform/daemon/src/diagnostics.ts` so `getQueueHealth`
      composes three `QueueCounts` (memory / summary / extraction) and
      keeps the legacy aggregate fields (`depth`, `oldestAgeSec`,
      `deadRate`, `leaseAnomalies`) for back-compat with `/api/status`,
      `/api/pipeline/status`, and the dashboard.
- [ ] Export `scoreCountsWithThresholds(counts, thresholds)` that
      gives a `(score, status)` from a `QueueCounts` + threshold set;
      `getQueueHealth` computes thresholds from one source of truth
      (reuse `cfg.health.queue` if present; else defaults
      `summaryDeadWarn=50`, `summaryDeadFail=500`,
      `summaryOldestPendingWarnSec=300`,
      `summaryOldestPendingFailSec=1800`,
      `summaryOldestDeadWarnSec=86400`).
- [ ] Tests in `platform/daemon/src/diagnostics.test.ts`: empty queue,
      mixed dead + leased, missing `summary_jobs` (older DBs, must
      gracefully zero-fill), threshold boundaries (`summaryDeadWarn`,
      `summaryDeadFail`).

## Phase 2 — Two migrations for audit & archive provenance

> Operators want to cancel or prune dead rows, but never lose provenance.

- [ ] `platform/core/src/migrations/089-job-cancellations.ts`: creates
      `job_cancellations` audit table (`id, source_table, source_id,
      reason, actor, actor_type, request_id, payload_json, created_at`)
      with `CREATE TABLE IF NOT EXISTS` + idempotent indexes.
- [ ] `platform/core/src/migrations/090-job-archive.ts`: creates
      `job_archive` table mirroring `memory_jobs` and `summary_jobs`
      columns (`*_at, archived_at, archived_by, reason, source_table`)
      using a JSON `payload` plus typed bookkeeping columns.
- [ ] Register both in `platform/core/src/migrations/index.ts` after
      `087-summary-jobs-boundary-reason`. Migrations are run inside
      a transaction per file, idempotent, self-healing on upgrades.

## Phase 3 — Repair actions: extend requeue, add cancel & prune

> Repair actions all reuse the existing `RepairContext`,
> `createRateLimiter`, `checkRepairGate`, and `insertHistoryEvent`
> plumbing — no new gate policy.

### 3a. Extend `requeueDeadJobs`

- [ ] New optional `options: RequeueOptions = {}` parameter:
      `{dryRun?: boolean, ids?: readonly string[], olderThanMs?: number,
      errorPattern?: string}`. Defaults match today's behavior so all
      existing callers stay correct.
- [ ] Dry-run returns the same `RepairResult` shape with `affected = 0`
      and a new `preview?: readonly string[]` listing ids that *would*
      be requeued (capped at 100 for log size).
- [ ] Apply path honors `ids`, `olderThanMs`, `errorPattern` against
      both `memory_jobs` and `summary_jobs`; rate-limit gate behaves
      identically (dry-run bypasses budget consumption).

### 3b. New `cancelObsoleteJobs`

- [ ] Signature: `cancelObsoleteJobs(accessor, cfg, ctx, limiter,
      options?: {dryRun?: boolean, tables?: readonly ('memory'|
      'summary')[], olderThanMs?: number, errorPattern?: string})`.
- [ ] Targets rows where `status IN ('dead', 'completed')` and
      `created_at < now - olderThanMs` (default 30 days). Honors
      `tables` (default both) and `errorPattern`.
- [ ] "Cancel" = copy the full row into `job_cancellations`, set
      `status = 'cancelled'` on the source row, and write an audit
      event. Source rows are never hard-deleted. `summary_jobs`
      schema remains untouched.
- [ ] Dry-run default for CLI; `--apply` flag required to mutate.
      Bypasses rate-limit budget for the dry-run path; apply path
      uses the same `requeueCooldownMs` / `requeueHourlyBudget`
      gate as `requeueDeadJobs`.

### 3c. New `pruneTerminalJobs`

- [ ] Signature mirrors `cancelObsoleteJobs` plus
      `{retentionMs?: number}` (default 90 days for `dead`,
      14 days for `completed`, per-`status` table inside the
      implementation).
- [ ] Default target: `status IN ('cancelled', 'completed', 'dead')`
      and `created_at < now - retentionMs`. Honors `tables`.
- [ ] Before delete, copy the row to `job_archive` (full payload JSON
      + bookkeeping columns). Hard cap 1000 rows per call; operators
      re-run.
- [ ] Dry-run default; `--apply` to mutate. Same rate-limit gate as
      `requeueDeadJobs`. Audit row written via `insertHistoryEvent`
      with `repairAction: "pruneTerminalJobs"`.

### 3d. Result shape

- [ ] Extend the `RepairResult` type with optional `preview?: readonly
      string[]` and `totalMatching?: number` fields. Existing callers
      unaffected.

## Phase 4 — HTTP routes

- [ ] `GET /api/diagnostics/queue` (new, `requirePermission('admin')`):
      returns `{ timestamp, queues: {memory, summary, extraction,
      aggregate}, oldestDeadSummaryJob, oldestDeadMemoryJob,
      oldestDeadExtractionJob, lastProviderError, thresholds }`.
- [ ] `POST /api/diagnostics/queue/repair`
      (new, `requirePermission('admin')`): body
      `{ action: 'requeue'|'cancel'|'prune', dryRun?: bool,
      ids?: string[], tables?: string[], olderThanMs?: number,
      errorPattern?: string, retentionMs?: number }` →
      `RepairResult`.
- [ ] `GET /api/status` adds `pipeline.queue` block under the existing
      `pipeline` object (mirrors the same flat shape with thresholds +
      oldest dead), additive only — no existing field moved.
- [ ] `/health` left **byte-for-byte unchanged** (PR #932 owns its
      contract). New visibility comes through `/api/diagnostics/queue`
      and `/api/status`.

## Phase 5 — CLI surface

- [ ] `signet status` (in `surfaces/cli/src/features/health.ts`) fetches
      `/api/diagnostics/queue` and renders a `Pipeline queues`
      block with three rows (memory / summary / extraction), each
      showing pending, leased, completed, failed, dead, oldest dead
      age, and the active thresholds. Block is rendered below the
      existing extraction block — additive, no existing line moved.
- [ ] When `dead > 0`, the queue's `dead` count and oldest dead age are
      highlighted (chalk.yellow / chalk.red) without changing the
      existing liveness label that PR #932 will introduce.
- [ ] New `signet repair queue` subcommands wired through
      `surfaces/cli/src/cli.ts`:
      - `signet repair queue requeue [--ids=a,b,c]
        [--older-than=7d] [--error-pattern=...] [--dry-run|--apply]`
      - `signet repair queue cancel [--tables=summary,memory]
        [--older-than=30d] [--error-pattern=...] [--dry-run|--apply]`
      - `signet repair queue prune [--tables=summary,memory]
        [--older-than=90d] [--dry-run|--apply]`
      Each prints the same `RepairResult` with `preview` array
      (capped at 100) and a colored footer (yellow dry-run, green
      apply, red denied by gate).
- [ ] Tests in `surfaces/cli/src/features/health.test.ts` and a new
      `surfaces/cli/src/features/repair-queue.test.ts` covering:
      daemon unreachable → existing behavior unchanged; queues with
      dead rows render correctly; CLI dry-run vs apply paths hit the
      right endpoint with the right body.

## Phase 6 — Rust daemon parity

> Every new HTTP route lands `native-rust-replay-proven` so the
> `bun run check:rust-parity` gate is green.

- [ ] `platform/daemon-rs/crates/signet-daemon/src/routes/diagnostics.rs`:
      add `queue_diagnostics` returning the same `{queues, oldestDead*,
      lastProviderError, thresholds}` shape derived from the SQLite
      handle (`memories` table extracted from `signet_core::queries`
      the same way the `get_diagnostics` handler does today).
- [ ] Same file: add `queue_repair` that dispatches on `action`
      (`requeue`/`cancel`/`prune`) and returns the same `RepairResult`
      JSON shape as `repair.rs:33`.
- [ ] Mount both in `crates/signet-daemon/src/main.rs` next to the
      existing `/api/diagnostics/*` and `/api/repair/*` mounts.
      Update `isAuthOpenPath` so admin-only routes stay gated.
- [ ] `platform/daemon-rs/contracts/route-parity.json`: add the two
      new routes with `status: "native-rust-replay-proven"`.
- [ ] `platform/daemon-rs/contracts/parity-rules.json`: add per-endpoint
      `ignoreFields` so non-deterministic fields (`pid`, `uptime`,
      `version`, etc.) are tolerated.
- [ ] `platform/daemon-rs/contracts/replay-corpus/cases/`: add replay
      fixtures for both routes; mirror them in
      `platform/daemon-rs/parity/01-route-inventory.md`.
- [ ] Update `parity/00-correspondence-map.md` and `02-behavioral-cores.md`
      to note queue diagnostics.

## Phase 7 — `/api/status` parity

- [ ] Update `parity-rules.json` so the new
      `pipeline.queue.*` fields fall under deterministic compare
      (or add ignore fields if they include runtime-derived values).
- [ ] Replay fixture for `/api/status` updated to include
      `pipeline.queue` block.

## Phase 8 — Regression tests

> Per PR template: "Regression tests added for each bug fix."

- [ ] `platform/daemon/src/diagnostics.test.ts` (existing) — extend
      to cover the three-table `QueueCounts` (memory / summary /
      extraction) and threshold boundaries.
- [ ] `platform/daemon/src/repair-actions.test.ts` — extend with
      `requeueDeadJobs` dry-run idempotency, ids/olderThanMs/
      errorPattern filters; new `cancelObsoleteJobs` and
      `pruneTerminalJobs` happy + dry-run + audit paths.
- [ ] `platform/daemon/src/routes/diagnostics-routes.test.ts` (new) —
      `/api/diagnostics/queue` returns the documented payload for
      healthy / degraded / unhealthy fixtures; auth gate returns 403
      without admin token.
- [ ] `platform/daemon/src/routes/repair-queue-routes.test.ts` (new) —
      each repair action dry-runs without mutation, applies correctly,
      honors rate-limit gate, returns the documented `RepairResult`.
- [ ] `platform/daemon/src/migrations/migrations.test.ts` (existing) —
      exercise `089-job-cancellations` and `090-job-archive` up +
      idempotency on a fresh DB.
- [ ] End-to-end fixture script
      `platform/daemon/scripts/seed-dead-summary-jobs.ts` that seeds
      N dead + N stale leased summary jobs and prints
      `signet status`, `/api/diagnostics/queue`,
      `/api/pipeline/status` pre/post. Reusable as a starting point
      for future backlog probes.

## Phase 9 — Documentation

- [ ] `docs/PIPELINE.md` — add a "Queue health and repair" section
      with thresholds + the new CLI + HTTP surfaces.
- [ ] `docs/api/health-status.md` — document `/api/diagnostics/queue`
      and `/api/diagnostics/queue/repair`.
- [ ] `docs/api/route-inventory.md` — list the two new routes.
- [ ] `docs/api/diagnostics.md` — example payloads for the new
      endpoints.
- [ ] `CHANGELOG.md` — entry under `Unreleased` referencing #901.

## Phase 10 — Self-review & ship

- [ ] `bun run typecheck`
- [ ] `bun run lint`
- [ ] `bun run format`
- [ ] `bun test`
- [ ] `bun run check:rust-parity`
- [ ] Manual smoke: launch the daemon, seed dead summary rows via
      the new fixture script, run every new CLI command with
      `--dry-run` then `--apply`, diff `/api/status` pre/post.
- [ ] `autoreview` against the diff; address every
      `severity >= medium` finding; final `autoreview` returns
      zero new findings before marking PR ready.
- [ ] Squash into conventional commits with `Assisted-by` tags per
      `AI_POLICY.md`.

---

## Notes for the reviewer

- The plan deliberately keeps `/health` byte-for-byte unchanged so
  PR #932 can land its `/health/live` + `/health/ready` contract
  without a re-baseline. New visibility comes through
  `/api/diagnostics/queue`, `/api/status.pipeline.queue`, and the
  CLI's `Pipeline queues` block.
- Thresholds default to the values already cited in `docs/PIPELINE.md`
  §"Maintenance Worker"; no surprise defaults for existing operators.
- The schema-light approach (audit table for cancel, archive table
  for prune) preserves provenance without a breaking migration on
  `summary_jobs` — both migrations are `CREATE TABLE IF NOT EXISTS`
  and self-heal on upgrade.
- Rust parity is a hard gate, not a stretch goal: every new HTTP
  route lands `native-rust-replay-proven` before the PR goes ready.
- Every CLI repair command defaults to dry-run; `--apply` is required
  to mutate. This matches the spirit of the issue's "verify repair
  preview does not mutate data" regression test.
