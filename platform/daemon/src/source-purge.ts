import { controlImport, createOwnerTranscriptImportStore } from "./transcript-import-store";
import { dbOwnerQuery, dbOwnerSourcePurge } from "./db-owner-runtime";
import { migrateTranscriptImports } from "./transcript-import-migration";
import { resolveDefaultBasePath, loadSourcesConfig } from "@signet/core";
import { purgeTranscriptBytes, bindTranscriptSource } from "./transcript-import-bytes";
import type { PurgeSourceOwnedRowsInput } from "./source-purge-tx";
import { withTranscriptImportOperationLock } from "./transcript-import-operation-lock";
export { purgeSourceOwnedRowsInTx } from "./source-purge-tx";
export type { PurgeSourceOwnedRowsInput } from "./source-purge-tx";

async function invalidateTranscriptImportSource(input: PurgeSourceOwnedRowsInput): Promise<void> {
	for (;;) {
		const jobs = await dbOwnerQuery<Array<{ id: string; agent_id: string }>>(
			{
				sql: `SELECT id,agent_id FROM source_import_jobs j WHERE state NOT IN ('completed','completed_with_rejections','cancelled') ${input.agentId === undefined ? "" : "AND agent_id = ?"} AND EXISTS (SELECT 1 FROM source_import_files f WHERE f.job_id = j.id AND f.agent_id = j.agent_id AND f.source_id = ?) LIMIT 25`,
				params: [...(input.agentId === undefined ? [] : [input.agentId]), input.sourceId],
				result: "all",
				readonly: true,
			},
			{ operation: "sources.import.invalidate", lane: "read" },
		);
		if (!jobs.length) return;
		for (const job of jobs)
			await controlImport(createOwnerTranscriptImportStore(), {
				jobId: job.id,
				agentId: job.agent_id,
				control: "cancel",
			});
	}
}

export async function purgeSourceOwnedRows(input: PurgeSourceOwnedRowsInput): Promise<number> {
	return withTranscriptImportOperationLock("transcript-import", async () => {
		if (!input.sourceId.trim()) return 0;
		if (input.agentId !== undefined)
			await migrateTranscriptImports(resolveDefaultBasePath(), input.agentId, () => true);
		const registered = loadSourcesConfig(resolveDefaultBasePath()).sources.find(
			(source) =>
				source.id === input.sourceId &&
				source.kind === "import" &&
				(input.agentId === undefined || source.providerSettings?.agentId === input.agentId),
		);
		const key = registered?.providerSettings?.importKey;
		const registeredAgent = registered?.providerSettings?.agentId;
		if (typeof key === "string" && typeof registeredAgent === "string") {
			const [jobId, fileId, generation] = key.split(":");
			if (jobId && fileId && generation !== undefined) {
				const staged = await dbOwnerQuery(
					{
						sql: "SELECT 1 FROM source_import_files WHERE id = ? AND job_id = ? AND agent_id = ? AND upload_generation = ? AND state = 'staging' AND storage_state = 'sealed'",
						params: [fileId, jobId, registeredAgent, Number(generation)],
						result: "get",
						readonly: true,
					},
					{ operation: "sources.import.recover-registration", lane: "read" },
				);
				if (staged)
					await bindTranscriptSource(
						{ jobId, fileId, agentId: registeredAgent, generation: Number(generation) },
						input.sourceId,
					);
			}
		}
		await invalidateTranscriptImportSource(input);
		let cursor = "";
		for (;;) {
			const files = await dbOwnerQuery<Array<{ id: string; job_id: string; agent_id: string; storage_state: string }>>(
				{
					sql: `SELECT id,job_id,agent_id,storage_state FROM source_import_files WHERE source_id = ? AND id > ? ${input.agentId === undefined ? "" : "AND agent_id = ?"} ORDER BY id LIMIT 25`,
					params: [input.sourceId, cursor, ...(input.agentId === undefined ? [] : [input.agentId])],
					result: "all",
					readonly: true,
				},
				{ operation: "sources.import.purge.files", lane: "read" },
			);
			if (!files.length) break;
			for (const file of files) {
				if (file.storage_state === "legacy")
					await migrateTranscriptImports(resolveDefaultBasePath(), file.agent_id, () => true);
				await purgeTranscriptBytes({ fileId: file.id, jobId: file.job_id, agentId: file.agent_id });
				cursor = file.id;
			}
		}
		let purged = 0;
		for (;;) {
			const result = await dbOwnerSourcePurge(input, { operation: "sources.purge", lane: "write" });
			purged += typeof result === "number" ? result : result.purged;
			const remains = await dbOwnerQuery(
				{
					sql: `SELECT 1 FROM source_import_files WHERE source_id = ? ${input.agentId === undefined ? "" : "AND agent_id = ?"} LIMIT 1`,
					params: [input.sourceId, ...(input.agentId === undefined ? [] : [input.agentId])],
					result: "get",
					readonly: true,
				},
				{ operation: "sources.import.purge.remaining", lane: "read" },
			);
			if (!remains) return purged;
		}
	});
}
