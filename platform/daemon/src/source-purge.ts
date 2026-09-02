import { resolveDefaultBasePath } from "@signet/core";
import { getDbAccessor } from "./db-accessor";
import { dbOwnerQuery, dbOwnerSourcePurge, dbOwnerTransaction, runDbOwnerDomainOperation } from "./db-owner-runtime";
import { purgeTranscriptImportSourceInTx } from "./transcript-import-commit";
import { purgeTranscriptImportFilesystem } from "./transcript-import-worker";
import { assertTranscriptImportPlatformSupported } from "./transcript-import-safe-fs";
import { purgeSourceOwnedRowsInTx, type PurgeSourceOwnedRowsInput } from "./source-purge-tx";
import { withTranscriptImportOperationLock } from "./transcript-import-operation-lock";

export { purgeSourceOwnedRowsInTx } from "./source-purge-tx";
export type { PurgeSourceOwnedRowsInput } from "./source-purge-tx";

/**
 * Invalidate import leases before touching canonical files. The owner-side
 * generation change closes the gap between a worker guard and its DB commit.
 */
async function invalidateTranscriptImportSource(input: PurgeSourceOwnedRowsInput): Promise<void> {
	const timestamp = new Date().toISOString();
	const jobSql =
		input.agentId !== undefined
			? "UPDATE source_import_jobs SET state = 'cancelled', generation = generation + 1, control_request = NULL, lease_token = NULL, lease_expires_at = NULL, error = COALESCE(error, 'source deleted'), updated_at = ? WHERE agent_id = ? AND state NOT IN ('completed','completed_with_rejections','cancelled') AND EXISTS (SELECT 1 FROM source_import_files WHERE source_import_files.job_id = source_import_jobs.id AND source_import_files.agent_id = source_import_jobs.agent_id AND source_import_files.source_id = ?)"
			: "UPDATE source_import_jobs SET state = 'cancelled', generation = generation + 1, control_request = NULL, lease_token = NULL, lease_expires_at = NULL, error = COALESCE(error, 'source deleted'), updated_at = ? WHERE state NOT IN ('completed','completed_with_rejections','cancelled') AND EXISTS (SELECT 1 FROM source_import_files WHERE source_import_files.job_id = source_import_jobs.id AND source_import_files.source_id = ?)";
	const recordSql =
		input.agentId !== undefined
			? "UPDATE source_import_records SET status = 'cancelled', rejection_code = 'source_deleted', updated_at = ? WHERE agent_id = ? AND status = 'pending' AND EXISTS (SELECT 1 FROM source_import_files WHERE source_import_files.id = source_import_records.file_id AND source_import_files.agent_id = source_import_records.agent_id AND source_import_files.source_id = ?)"
			: "UPDATE source_import_records SET status = 'cancelled', rejection_code = 'source_deleted', updated_at = ? WHERE status = 'pending' AND EXISTS (SELECT 1 FROM source_import_files WHERE source_import_files.id = source_import_records.file_id AND source_import_files.source_id = ?)";
	const scopedParams =
		input.agentId !== undefined ? [timestamp, input.agentId, input.sourceId] : [timestamp, input.sourceId];
	await dbOwnerTransaction(
		[
			{
				sql: jobSql,
				params: scopedParams,
				result: "run" as const,
			},
			{
				sql: recordSql,
				params: scopedParams,
				result: "run" as const,
			},
		],
		{ operation: "sources.import.invalidate", lane: "write" },
	);
}

export async function purgeSourceOwnedRows(input: PurgeSourceOwnedRowsInput): Promise<number> {
	return await withTranscriptImportOperationLock("transcript-import", () => purgeSourceOwnedRowsUnlocked(input));
}

async function purgeSourceOwnedRowsUnlocked(input: PurgeSourceOwnedRowsInput): Promise<number> {
	const sourceId = input.sourceId.trim();
	if (!sourceId) return 0;
	const managedPaths = await runDbOwnerDomainOperation(getDbAccessor(), {
		runWithOwner: async () =>
			(
				await dbOwnerQuery<Array<{ managed_path: string }>>(
					{
						sql: `SELECT managed_path FROM source_import_files WHERE ${input.agentId !== undefined ? "agent_id = ? AND " : ""}source_id = ?`,
						params: input.agentId !== undefined ? [input.agentId, sourceId] : [sourceId],
						result: "all",
						readonly: true,
					},
					{ operation: "sources.import.purge-paths", lane: "read" },
				)
			).map((row) => row.managed_path),
		runInline: ({ read }) =>
			read((db) =>
				(
					db
						.prepare(
							`SELECT managed_path FROM source_import_files WHERE ${input.agentId !== undefined ? "agent_id = ? AND " : ""}source_id = ?`,
						)
						.all(...(input.agentId !== undefined ? [input.agentId] : []), sourceId) as Array<{ managed_path: string }>
				).map((row) => row.managed_path),
			),
	});
	// Only transcript-import sources have managed-path ledger rows. Gate before
	// invalidating DB state, while allowing generic source cleanup on platforms
	// without the descriptor-relative transcript filesystem.
	if (managedPaths.length > 0) assertTranscriptImportPlatformSupported();
	await invalidateTranscriptImportSource({ sourceId, agentId: input.agentId });
	if (managedPaths.length > 0 && !sourceId.includes("/") && !sourceId.includes("\\") && !sourceId.includes("..")) {
		await purgeTranscriptImportFilesystem(resolveDefaultBasePath(), sourceId, input.agentId, managedPaths);
	}

	const result = await runDbOwnerDomainOperation(getDbAccessor(), {
		runWithOwner: async () =>
			await dbOwnerSourcePurge({ agentId: input.agentId, sourceId }, { operation: "sources.purge", lane: "write" }),
		runInline: ({ write }) =>
			write((db) => ({
				purged:
					purgeSourceOwnedRowsInTx(db, { sourceId, agentId: input.agentId }) +
					purgeTranscriptImportSourceInTx(db, input.agentId, sourceId),
			})),
	});
	return typeof result === "number" ? result : result.purged;
}
