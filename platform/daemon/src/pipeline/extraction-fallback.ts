import { ownerChanges } from "../db-owner-maintenance";
import { dbOwnerTransaction, ownerStatement } from "../db-owner-runtime";

export type LegacyExtractionRetirementTransaction = typeof dbOwnerTransaction;

export interface LegacyExtractionRetirementOptions {
	readonly reason: string;
}
export async function retireLegacyExtractionJobsAsync(
	options: LegacyExtractionRetirementOptions,
	transaction: LegacyExtractionRetirementTransaction = dbOwnerTransaction,
): Promise<number> {
	const now = new Date().toISOString();
	const results = await transaction(
		[
			ownerStatement(
				`UPDATE memories
				 SET extraction_status = 'retired'
				 WHERE id IN (
					 SELECT DISTINCT m.id
					 FROM memory_jobs j
					 JOIN memories m ON m.id = j.memory_id
					 WHERE j.job_type = 'extract'
					   AND j.status IN ('pending', 'leased')
				 )`,
			),
			ownerStatement(
				`UPDATE memory_jobs
				 SET status = 'dead', error = ?, failed_at = ?, updated_at = ?
				 WHERE job_type = 'extract'
				   AND status IN ('pending', 'leased')`,
				[options.reason, now, now],
			),
		],
		{
			operation: "startup.retire-legacy-extraction",
			lane: "write",
			deadlineMs: 5_000,
			estimatedWorkUnits: 2,
		},
	);
	return ownerChanges(results[1]);
}
