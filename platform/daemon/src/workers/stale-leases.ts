import type { WriteDb } from "../db/owner/accessor";
import { countChanges } from "../db/owner/helpers";

export interface StaleLeaseRecovery {
	readonly pending: number;
	readonly dead: number;
	readonly total: number;
}

interface RecoverOpts {
	readonly cutoff?: string;
	readonly now: string;
	readonly jobType?: string;
}

const LEASE_EXPIRED = "lease expired before completion";

export function recoverStaleLeases(db: WriteDb, opts: RecoverOpts): StaleLeaseRecovery {
	const jobTypeFilter = opts.jobType === undefined ? "" : " AND job_type = ?";
	const cutoffFilter = opts.cutoff === undefined ? "" : " AND leased_at < ?";
	const jobTypeParams = opts.jobType === undefined ? [] : [opts.jobType];
	const cutoffParams = opts.cutoff === undefined ? [] : [opts.cutoff];
	const deadParams = [opts.now, LEASE_EXPIRED, opts.now, ...jobTypeParams, ...cutoffParams];
	const dead = countChanges(
		db
			.prepare(
				`UPDATE memory_jobs
				 SET status = 'dead',
				     leased_at = NULL,
				     lease_token = NULL,
				     failed_at = ?,
				     error = COALESCE(error, ?),
				     updated_at = ?
				 WHERE status = 'leased'
				   ${jobTypeFilter}
				   ${cutoffFilter}
				   AND attempts >= max_attempts`,
			)
			.run(...deadParams),
	);

	const pendingParams = [opts.now, ...jobTypeParams, ...cutoffParams];
	const pending = countChanges(
		db
			.prepare(
				`UPDATE memory_jobs
				 SET status = 'pending',
				     leased_at = NULL,
				     lease_token = NULL,
				     updated_at = ?
				 WHERE status = 'leased'
				   ${jobTypeFilter}
				   ${cutoffFilter}
				   AND attempts < max_attempts`,
			)
			.run(...pendingParams),
	);

	return {
		pending,
		dead,
		total: pending + dead,
	};
}
