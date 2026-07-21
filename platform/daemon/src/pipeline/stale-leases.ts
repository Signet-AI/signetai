import type { WriteDb } from "../db-accessor";
import { countChanges } from "../db-helpers";
import { DEFAULT_PLANNING_CEILINGS, type PlanningCeilings, reclaimStalePlanningJob } from "./ingest/lease";

export interface StaleLeaseRecovery {
	readonly pending: number;
	readonly dead: number;
	readonly total: number;
}

interface RecoverOpts {
	readonly cutoff: string;
	readonly now: string;
	/**
	 * Planning-lifecycle ceilings for stale `planning` rows (#913). Defaults to
	 * {@link DEFAULT_PLANNING_CEILINGS} when the caller does not supply any.
	 */
	readonly ceilings?: PlanningCeilings;
}

const LEASE_EXPIRED = "lease expired before completion";

export function recoverStaleLeases(db: WriteDb, opts: RecoverOpts): StaleLeaseRecovery {
	const dead = countChanges(
		db
			.prepare(
				`UPDATE memory_jobs
				 SET status = 'dead',
				     leased_at = NULL,
				     failed_at = ?,
				     error = COALESCE(error, ?),
				     updated_at = ?
				 WHERE status = 'leased'
				   AND leased_at < ?
				   AND attempts >= max_attempts`,
			)
			.run(opts.now, LEASE_EXPIRED, opts.now, opts.cutoff),
	);

	const pending = countChanges(
		db
			.prepare(
				`UPDATE memory_jobs
				 SET status = 'pending',
				     leased_at = NULL,
				     updated_at = ?
				 WHERE status = 'leased'
				   AND leased_at < ?
				   AND attempts < max_attempts`,
			)
			.run(opts.now, opts.cutoff),
	);

	// Planning lifecycle (#913): a `planning` row whose per-row TTL
	// (lease_expires_at) has elapsed was never applied by the agentic harness.
	// Delegate the lenient reclaim + ceiling dead-letter semantics to
	// reclaimStalePlanningJob (clearing the lease token so a late apply cannot
	// double-write) instead of duplicating the ceilings here.
	const ceilings = opts.ceilings ?? DEFAULT_PLANNING_CEILINGS;
	const stalePlanning = db
		.prepare(
			`SELECT id FROM memory_jobs
			 WHERE status = 'planning' AND lease_expires_at < ?`,
		)
		.all(opts.now) as unknown as ReadonlyArray<{ id: string }>;

	let planningPending = 0;
	let planningDead = 0;
	for (const row of stalePlanning) {
		const outcome = reclaimStalePlanningJob(db, row.id, ceilings);
		if (outcome.outcome === "reclaimed") {
			planningPending++;
		} else if (outcome.outcome === "dead-lettered") {
			planningDead++;
		}
	}

	return {
		pending: pending + planningPending,
		dead: dead + planningDead,
		total: pending + dead + planningPending + planningDead,
	};
}
