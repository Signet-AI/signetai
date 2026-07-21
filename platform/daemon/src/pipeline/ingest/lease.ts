/**
 * Unified ingest queue leasing (#913).
 *
 * `memory_jobs` is the single durable queue drained by both the daemon (24/7)
 * and an external harness (agentic, cron). This module owns the fenced,
 * agent-scoped lease that makes the two runners safe to overlap:
 *
 *   - `agent_id`     — DATA OWNERSHIP. Filtering by agent_id alone does NOT
 *                      stop the daemon and a harness serving the same agent
 *                      from overlapping; that is what the fencing below is for.
 *   - `lease_owner`  — which executor currently holds the attempt.
 *   - `lease_token`  — FENCING proof. Compare-and-swap target on every
 *                      complete/fail/release/apply. A stale token cannot write.
 *
 * The current `leaseJob`/`completeJob`/`failJob` (worker.ts) lease by job_type
 * + status only, with no agent_id filter and no lease_token CAS — the SELECT
 * then UPDATE is not atomic and completeJob is open to any caller. This module
 * replaces that for the unified path: atomic SELECT-then-CAS acquire (the CAS
 * guards on status='pending', so concurrent leasers cannot both win), and every
 * terminal op CASes on the token. Idempotent by construction.
 *
 * Priority lanes (live > recent/import > backfill > maintenance) are ordered
 * here as `priority DESC`. Per-agent fairness and the reserved-live-slot guard
 * live in an admission/selection layer ABOVE this primitive (the broker stays
 * agent-agnostic); this module is the fenced lease itself.
 */

import { randomUUID } from "node:crypto";
import type { WriteDb } from "../../db-accessor";
import { countChanges } from "../../db-helpers";

/** Lane priorities. Higher is leased first. Enqueue uses these. */
export const INGEST_PRIORITY_LIVE = 100; // session just ended
export const INGEST_PRIORITY_RECENT = 50; // recent import / capture
export const INGEST_PRIORITY_BACKFILL = 10; // bulk historical
export const INGEST_PRIORITY_MAINTENANCE = 0; // default; graph hygiene etc.

export const INGEST_JOB_TYPE = "ingest"; // the unified queue discriminator

export type IngestJobStatus =
	| "pending"
	| "leased" // daemon apply path holds it
	| "planning" // agentic runner holds it across an external reasoning turn
	| "applying" // apply phase in progress (daemon or agentic)
	| "completed"
	| "failed" // transient terminal before re-queue (unused by current model; pending is the retry state)
	| "dead"; // dead-lettered

/** A memory_jobs row, including the agent-scoped lease columns from migration 088. */
export interface IngestJobRow {
	readonly id: string;
	readonly memory_id: string | null;
	readonly document_id: string | null;
	readonly job_type: string;
	readonly status: string;
	readonly payload: string | null;
	readonly attempts: number;
	readonly max_attempts: number;
	readonly priority: number;
	readonly agent_id: string;
}

export interface AcquireIngestLeaseOptions {
	readonly agentId: string;
	readonly owner: string;
	readonly leaseTimeoutMs: number;
	readonly jobType?: string;
	readonly maxAttempts?: number;
	/** Bounded retries when a concurrent leaser wins the CAS. Default 4. */
	readonly contentionRetries?: number;
}

export type IngestLeaseResult =
	| { readonly ok: true; readonly job: IngestJobRow; readonly leaseToken: string; readonly leaseExpiresAt: string }
	| { readonly ok: false; readonly reason: "none-eligible" };

function isoNow(): string {
	return new Date().toISOString();
}

function epochNow(): number {
	return Math.floor(Date.now() / 1000);
}

/**
 * Atomically lease the next agent-scoped, highest-priority pending job.
 *
 * Two-step SELECT-then-CAS, both inside the caller's write tx. The CAS guards
 * on `status='pending' AND agent_id=?`, so if two executors select the same
 * row only one wins (countChanges===1); the loser re-selects. SQLite serializes
 * writers, so this is race-free without a single atomic statement. Per-job
 * exponential backoff is preserved from the legacy `leaseJob`.
 *
 * Leasing increments `attempts` (the apply-attempt counter). The planning
 * lifecycle (below) uses a SEPARATE `planning_attempts` counter.
 */
export function acquireIngestLease(db: WriteDb, opts: AcquireIngestLeaseOptions): IngestLeaseResult {
	const jobType = opts.jobType ?? INGEST_JOB_TYPE;
	const maxAttempts = opts.maxAttempts ?? 5;
	const retries = opts.contentionRetries ?? 4;
	const nowEpoch = epochNow();

	for (let attempt = 0; attempt <= retries; attempt++) {
		const row = db
			.prepare(
				`SELECT id, memory_id, document_id, job_type, status, payload,
				        attempts, max_attempts, priority, agent_id
				 FROM memory_jobs
				 WHERE agent_id = ? AND job_type = ? AND status = 'pending'
				   AND attempts < ?
				   AND (failed_at IS NULL
				        OR (? - CAST(strftime('%s', failed_at) AS INTEGER))
				           > MIN((1 << attempts) * 5, 120))
				 ORDER BY priority DESC, created_at ASC
				 LIMIT 1`,
			)
			.get(opts.agentId, jobType, maxAttempts, nowEpoch) as IngestJobRow | undefined;

		if (!row) return { ok: false, reason: "none-eligible" };

		const token = randomUUID();
		const leaseExpiresAt = new Date(Date.now() + opts.leaseTimeoutMs).toISOString();
		const result = db
			.prepare(
				`UPDATE memory_jobs
				 SET status = 'leased', leased_at = ?, attempts = attempts + 1,
				     lease_token = ?, lease_owner = ?, lease_expires_at = ?, updated_at = ?
				 WHERE id = ? AND agent_id = ? AND status = 'pending'`,
			)
			.run(isoNow(), token, opts.owner, leaseExpiresAt, isoNow(), row.id, opts.agentId);

		if (countChanges(result) === 1) {
			return { ok: true, job: { ...row, status: "leased", attempts: row.attempts + 1 }, leaseToken: token, leaseExpiresAt };
		}
		// CAS miss: a concurrent leaser won this row. Loop and re-select.
	}
	// Exhausted retries under heavy contention. Caller treats as no-eligible;
	// the next tick re-tries. This is not a correctness failure — every lease
	// is still fenced — only a throughput limit under extreme contention.
	return { ok: false, reason: "none-eligible" };
}

/**
 * Verify a lease token still owns a job (for the apply phase to confirm it
 * holds the lease before writing). Returns the row if the token matches and
 * the job is in an active state, else null. Apply calls this before any write
 * so a stale token (reclaimed by the reaper) cannot double-apply.
 */
export function verifyIngestLease(db: WriteDb, jobId: string, leaseToken: string): IngestJobRow | null {
	const row = db
		.prepare(
			`SELECT id, memory_id, document_id, job_type, status, payload,
			        attempts, max_attempts, priority, agent_id
			 FROM memory_jobs
			 WHERE id = ? AND lease_token = ?
			   AND status IN ('leased', 'planning', 'applying')`,
		)
		.get(jobId, leaseToken) as IngestJobRow | undefined;
	return row ?? null;
}

/**
 * Complete a leased job. CAS on lease_token — a stale token is a no-op
 * (countChanges 0). Idempotent: the same token completing twice is a no-op the
 * second time. `planHash` is recorded as the idempotency-key component so a
 * retried apply of the same plan is recognized.
 */
export function completeIngestJob(
	db: WriteDb,
	jobId: string,
	leaseToken: string,
	planHash?: string,
): boolean {
	const result = db
		.prepare(
			`UPDATE memory_jobs
			 SET status = 'completed', completed_at = ?, updated_at = ?,
			     lease_token = NULL, lease_owner = NULL, lease_expires_at = NULL,
			     plan_hash = COALESCE(?, plan_hash)
			 WHERE id = ? AND lease_token = ?
			   AND status IN ('leased', 'planning', 'applying')`,
		)
		.run(isoNow(), isoNow(), planHash ?? null, jobId, leaseToken);
	return countChanges(result) === 1;
}

/**
 * Fail a leased job. CAS on lease_token. Releases back to `pending` for retry
 * (attempts were already incremented at acquire), or to `dead` when attempts
 * reach the ceiling. A stale token is a no-op.
 */
export function failIngestJob(
	db: WriteDb,
	jobId: string,
	leaseToken: string,
	error: string,
	maxAttempts: number,
): "retry" | "dead" | "noop" {
	const row = verifyIngestLease(db, jobId, leaseToken);
	if (!row) return "noop";
	const nextStatus = row.attempts >= maxAttempts ? "dead" : "pending";
	db.prepare(
		`UPDATE memory_jobs
		 SET status = ?, error = ?, failed_at = ?, updated_at = ?,
		     lease_token = NULL, lease_owner = NULL, lease_expires_at = NULL
		 WHERE id = ? AND lease_token = ?`,
	).run(nextStatus, error, isoNow(), isoNow(), jobId, leaseToken);
	return nextStatus === "dead" ? "dead" : "retry";
}

/**
 * Release a lease back to pending WITHOUT consuming an attempt. Used when an
 * executor cancels mid-flight (the #918 broker cancels in-flight inference on
 * pause; the job must return to pending whole). CAS on lease_token.
 */
export function releaseIngestLease(db: WriteDb, jobId: string, leaseToken: string): boolean {
	const result = db
		.prepare(
			`UPDATE memory_jobs
			 SET status = 'pending',
			     attempts = MAX(attempts - 1, 0),
			     leased_at = NULL, error = NULL, updated_at = ?,
			     lease_token = NULL, lease_owner = NULL, lease_expires_at = NULL
			 WHERE id = ? AND lease_token = ? AND status IN ('leased', 'planning', 'applying')`,
		)
		.run(isoNow(), jobId, leaseToken);
	return countChanges(result) === 1;
}

// ---------------------------------------------------------------------------
// Agentic two-phase: planning lifecycle
//
// The agentic runner leases a job into `planning`, takes the context bundle
// away to reason in its own harness turn, then posts the IngestPlan back for
// apply (which re-verifies the SAME lease token). A planning round-trip that
// never applies counts as a PLANNING attempt (a separate, larger ceiling than
// apply attempts), and is also bounded by cumulative wall-clock and a per-item
// cooldown so a tight cron cannot burn all cycles on one hard item.
// ---------------------------------------------------------------------------

export interface PlanningCeilings {
	readonly maxPlanningAttempts: number; // e.g. 10
	readonly planningWallClockCeilingMs: number; // cumulative time-in-planning, e.g. 30 min
	readonly planningCooldownMs: number; // min gap between planning rounds for one item
}

export const DEFAULT_PLANNING_CEILINGS: PlanningCeilings = {
	maxPlanningAttempts: 10,
	planningWallClockCeilingMs: 30 * 60 * 1000,
	planningCooldownMs: 60 * 1000,
};

export interface LeaseForPlanningOptions {
	readonly agentId: string;
	readonly owner: string;
	readonly planningLeaseTimeoutMs: number; // LONGER than apply lease (spans an external turn)
	readonly ceilings?: PlanningCeilings;
	readonly maxAttempts?: number;
	readonly contentionRetries?: number;
}

export type PlanningLeaseResult =
	| { readonly ok: true; readonly job: IngestJobRow; readonly leaseToken: string; readonly leaseExpiresAt: string }
	| { readonly ok: false; readonly reason: "none-eligible" };

/**
 * Lease a job into `planning` for the agentic runner. Increments
 * `planning_attempts` (NOT apply attempts), stamps planning_started_at on the
 * first round and last_planning_at every round. Respects the per-item cooldown.
 * The apply that follows re-uses the same lease token (the job stays in
 * `planning` until apply completes it).
 */
export function leaseForPlanning(db: WriteDb, opts: LeaseForPlanningOptions): PlanningLeaseResult {
	const ceilings = opts.ceilings ?? DEFAULT_PLANNING_CEILINGS;
	const maxAttempts = opts.maxAttempts ?? 5;
	const retries = opts.contentionRetries ?? 4;
	const nowEpoch = epochNow();
	// A cooldown of <= 0 means "no cooldown". Expressed in integer seconds, a
	// small ms value would otherwise floor to a 1-second gate that blocks
	// same-second re-lease; only apply the gate when a real cooldown is set.
	const cooldownSec = Math.floor(ceilings.planningCooldownMs / 1000);
	const cooldownClause =
		cooldownSec > 0
			? `AND (last_planning_at IS NULL
			        OR (? - CAST(strftime('%s', last_planning_at) AS INTEGER)) > ?)`
			: "";
	const selectSql = `SELECT id, memory_id, document_id, job_type, status, payload,
			        attempts, max_attempts, priority, agent_id,
			        planning_attempts
			 FROM memory_jobs
			 WHERE agent_id = ? AND job_type = ? AND status = 'pending'
			   AND attempts < ?
			   AND planning_attempts < ?
			   ${cooldownClause}
			   AND (failed_at IS NULL
			        OR (? - CAST(strftime('%s', failed_at) AS INTEGER))
			           > MIN((1 << attempts) * 5, 120))
			 ORDER BY priority DESC, created_at ASC
			 LIMIT 1`;
	const selectParams: unknown[] = [
		opts.agentId,
		INGEST_JOB_TYPE,
		maxAttempts,
		ceilings.maxPlanningAttempts,
	];
	if (cooldownSec > 0) selectParams.push(nowEpoch, cooldownSec);
	selectParams.push(nowEpoch);

	for (let attempt = 0; attempt <= retries; attempt++) {
		const row = db.prepare(selectSql).get(...selectParams) as
			| (IngestJobRow & { planning_attempts: number })
			| undefined;

		if (!row) return { ok: false, reason: "none-eligible" };

		const token = randomUUID();
		const leaseExpiresAt = new Date(Date.now() + opts.planningLeaseTimeoutMs).toISOString();
		// planning_started_at is set once (first round); last_planning_at updates every round.
		const result = db
			.prepare(
				`UPDATE memory_jobs
				 SET status = 'planning',
				     planning_attempts = planning_attempts + 1,
				     planning_started_at = COALESCE(planning_started_at, ?),
				     last_planning_at = ?,
				     lease_token = ?, lease_owner = ?, lease_expires_at = ?, updated_at = ?
				 WHERE id = ? AND agent_id = ? AND status = 'pending'`,
			)
			.run(isoNow(), isoNow(), token, opts.owner, leaseExpiresAt, isoNow(), row.id, opts.agentId);

		if (countChanges(result) === 1) {
			return {
				ok: true,
				job: { ...row, status: "planning" },
				leaseToken: token,
				leaseExpiresAt,
			};
		}
	}
	return { ok: false, reason: "none-eligible" };
}

export type PlanningReclaimOutcome =
	| { readonly outcome: "reclaimed"; readonly jobId: string }
	| { readonly outcome: "dead-lettered"; readonly jobId: string; readonly reason: string }
	| { readonly outcome: "still-planning"; readonly jobId: string };

/**
 * Reclaim a stale `planning` job (lease expired, harness never applied).
 * Lenient: returns to `pending` so the next round re-plans, clearing the lease
 * token so a late apply with the stale token cannot double-apply. Dead-letters
 * when any planning ceiling is exceeded, with a distinguished reason.
 *
 * Called by the stale-lease reaper for rows in `planning` past lease_expires_at.
 */
export function reclaimStalePlanningJob(
	db: WriteDb,
	jobId: string,
	ceilings: PlanningCeilings = DEFAULT_PLANNING_CEILINGS,
): PlanningReclaimOutcome {
	const row = db
		.prepare(
			`SELECT id, status, planning_attempts, planning_started_at, lease_expires_at
			 FROM memory_jobs
			 WHERE id = ? AND status = 'planning'`,
		)
		.get(jobId) as
		| {
				id: string;
				status: string;
				planning_attempts: number;
				planning_started_at: string | null;
				lease_expires_at: string | null;
		  }
		| undefined;

	if (!row) return { outcome: "still-planning", jobId };

	// Ceiling 1: planning cycle count.
	if (row.planning_attempts >= ceilings.maxPlanningAttempts) {
		deadLetterPlanning(db, jobId, "planning cycle ceiling — no harness ever applied");
		return { outcome: "dead-lettered", jobId, reason: "planning cycle ceiling" };
	}

	// Ceiling 2: cumulative wall-clock in planning.
	if (row.planning_started_at) {
		const elapsedMs = Date.now() - Date.parse(row.planning_started_at);
		if (Number.isFinite(elapsedMs) && elapsedMs > ceilings.planningWallClockCeilingMs) {
			deadLetterPlanning(db, jobId, "planning wall-clock ceiling exceeded");
			return { outcome: "dead-lettered", jobId, reason: "planning wall-clock ceiling" };
		}
	}

	// Lenient reclaim: back to pending, clear the lease (stale apply will CAS-fail).
	db.prepare(
		`UPDATE memory_jobs
		 SET status = 'pending',
		     lease_token = NULL, lease_owner = NULL, lease_expires_at = NULL,
		     error = NULL, updated_at = ?
		 WHERE id = ? AND status = 'planning'`,
	).run(isoNow(), jobId);
	return { outcome: "reclaimed", jobId };
}

function deadLetterPlanning(db: WriteDb, jobId: string, reason: string): void {
	db.prepare(
		`UPDATE memory_jobs
		 SET status = 'dead', error = ?, failed_at = ?, updated_at = ?,
		     lease_token = NULL, lease_owner = NULL, lease_expires_at = NULL
		 WHERE id = ? AND status = 'planning'`,
	).run(reason, isoNow(), isoNow(), jobId);
}
