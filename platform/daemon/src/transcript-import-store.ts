import { dbOwnerQuery, dbOwnerTransaction, dbOwnerTranscriptBulkCommit } from "./db-owner-runtime";

export type ImportJobState =
	| "staging"
	| "inventorying"
	| "queued"
	| "running"
	| "paused"
	| "completed"
	| "completed_with_rejections"
	| "cancelled"
	| "failed";
export interface ImportStoreOperation {
	readonly kind: "source_import";
	readonly operation: "lease" | "control" | "list" | "finalize" | "reject" | "commit" | "recover";
	readonly agentId: string;
	readonly jobId: string;
	readonly payload: Readonly<Record<string, unknown>>;
}
export interface ImportStore {
	readonly run: <Result>(operation: ImportStoreOperation) => Promise<Result>;
}

/** Prepare at most 25 retryable records; the generation fences concurrent controls. */
export async function prepareTranscriptRetry(jobId: string, agentId: string, generation: number): Promise<boolean> {
	const rows = await dbOwnerQuery<Array<{ id: string }>>(
		{
			sql: "SELECT r.id FROM source_import_records r JOIN source_import_jobs j ON j.id = r.job_id AND j.agent_id = r.agent_id WHERE j.id = ? AND j.agent_id = ? AND j.generation = ? AND j.state = 'queued' AND j.retry_requested = 1 AND r.id > j.retry_cursor AND r.status = 'rejected' AND r.rejection_code NOT IN ('schema_invalid','malformed','oversized_record','canonical_batch_too_large','conversation_identity_conflict') ORDER BY r.id LIMIT 25",
			params: [jobId, agentId, generation],
			result: "all",
			readonly: true,
		},
		{ operation: "sources.import.retry.records", lane: "read" },
	);
	if (!rows.length) {
		await dbOwnerTransaction(
			[
				{
					sql: "UPDATE source_import_jobs SET retry_requested = 0 WHERE id = ? AND agent_id = ? AND generation = ? AND state = 'queued'",
					params: [jobId, agentId, generation],
					result: "run",
				},
			],
			{ operation: "sources.import.retry.finish", lane: "write" },
		);
		return false;
	}
	await dbOwnerTransaction(
		[
			{
				sql: "UPDATE source_import_jobs SET retry_cursor = ?, pending = pending + ?, rejected = MAX(0,rejected - ?) WHERE id = ? AND agent_id = ? AND generation = ? AND state = 'queued' AND retry_requested = 1",
				params: [rows[rows.length - 1]?.id ?? "", rows.length, rows.length, jobId, agentId, generation],
				result: "run",
				requireChanges: true,
			},
			...rows.map((row) => ({
				sql: "UPDATE source_import_records SET status = 'pending', rejection_code = NULL WHERE id = ? AND job_id = ? AND agent_id = ? AND status = 'rejected'",
				params: [row.id, jobId, agentId],
				result: "run" as const,
				requireChanges: true,
			})),
		],
		{ operation: "sources.import.retry.prepare", lane: "write" },
	);
	return true;
}

/** Production facade: import ledger SQL is always submitted to the DB owner. */
export function createOwnerTranscriptImportStore(): ImportStore {
	return {
		run: async <Result>(operation: ImportStoreOperation): Promise<Result> => {
			const p = operation.payload;
			if (operation.operation === "list")
				return (await dbOwnerQuery(
					{
						sql:
							p.view === "files"
								? "SELECT * FROM source_import_files WHERE job_id = ? AND agent_id = ? ORDER BY ordinal"
								: p.view === "pending"
									? "SELECT id,job_id,file_id,source_id,agent_id,ordinal,line_number,byte_offset AS byteOffset,byte_length AS byteLength,raw_hash AS rawHash,status,rejection_code AS rejectionCode FROM source_import_records WHERE job_id = ? AND agent_id = ? AND file_id = ? AND status = 'pending' ORDER BY ordinal LIMIT ?"
									: p.view === "status"
										? "SELECT * FROM source_import_jobs WHERE id = ? AND agent_id = ?"
										: p.view === "recovery"
											? "SELECT * FROM source_import_jobs WHERE agent_id = ? AND state IN ('running','inventorying') ORDER BY created_at ASC LIMIT ?"
											: "SELECT * FROM source_import_jobs WHERE agent_id = ? AND state IN ('queued','running','inventorying') AND (next_attempt_at IS NULL OR next_attempt_at <= datetime('now')) AND EXISTS (SELECT 1 FROM source_import_files AS work_file WHERE work_file.job_id = source_import_jobs.id AND work_file.agent_id = source_import_jobs.agent_id AND work_file.storage_state = 'sealed') AND NOT EXISTS (SELECT 1 FROM source_import_files AS blocked_file WHERE blocked_file.job_id = source_import_jobs.id AND blocked_file.agent_id = source_import_jobs.agent_id AND (blocked_file.storage_state != 'sealed' OR blocked_file.state = 'staging')) ORDER BY created_at ASC LIMIT ?",
						params:
							p.view === "files"
								? [operation.jobId, operation.agentId]
								: p.view === "pending"
									? [operation.jobId, operation.agentId, p.fileId as string, Number(p.limit ?? 25)]
									: p.view === "status"
										? [operation.jobId, operation.agentId]
										: [operation.agentId, Number(p.limit ?? 100)],
						result: "all",
						readonly: true,
					},
					{ operation: "sources.import.store.list", lane: "read" },
				)) as Result;
			if (operation.operation === "lease")
				return (await dbOwnerQuery(
					{
						sql: "UPDATE source_import_jobs SET state = 'running', lease_token = ?, lease_expires_at = datetime('now','+5 minutes'), next_attempt_at = NULL, started_at = COALESCE(started_at, datetime('now')), updated_at = datetime('now') WHERE id = ? AND agent_id = ? AND state = 'queued' AND generation = ? AND control_request IS NULL RETURNING *",
						params: [p.token as string, operation.jobId, operation.agentId, p.generation as number],
						result: "get",
						readonly: false,
					},
					{ operation: "sources.import.store.lease", lane: "write" },
				)) as Result;
			if (operation.operation === "reject") {
				if (typeof p.generation !== "number" || typeof p.leaseToken !== "string" || typeof p.sourceId !== "string")
					throw new Error("rejection requires a lease and source scope");
				return (await dbOwnerTransaction(
					[
						{
							sql: "UPDATE source_import_records SET status = 'rejected', rejection_code = ?, attempt_count = attempt_count + 1, updated_at = datetime('now') WHERE id = ? AND job_id = ? AND agent_id = ? AND source_id = ? AND status = 'pending' AND EXISTS (SELECT 1 FROM source_import_jobs WHERE id = ? AND agent_id = ? AND generation = ? AND lease_token = ? AND state = 'running')",
							params: [
								String(p.code),
								String(p.recordId),
								operation.jobId,
								operation.agentId,
								p.sourceId,
								operation.jobId,
								operation.agentId,
								p.generation,
								p.leaseToken,
							],
							result: "run",
							requireChanges: true,
						},
						{
							sql: "INSERT INTO source_import_record_attempts (agent_id,job_id,file_id,record_id,generation,outcome,error_code,source_id) SELECT agent_id,job_id,file_id,id,?,'rejected',rejection_code,source_id FROM source_import_records WHERE id = ? AND job_id = ? AND agent_id = ?",
							params: [p.generation, String(p.recordId), operation.jobId, operation.agentId],
							result: "run",
						},
						{
							sql: "UPDATE source_import_jobs SET pending = MAX(0,pending - 1), rejected = rejected + 1 WHERE id = ? AND agent_id = ?",
							params: [operation.jobId, operation.agentId],
							result: "run",
						},
					],
					{ operation: "sources.import.store.reject", lane: "write" },
				)) as Result;
			}
			if (operation.operation === "commit") {
				const commits = p.commits as import("./transcript-import-commit").CompletedTranscriptCommit[];
				const results = await dbOwnerTranscriptBulkCommit(
					{
						agentId: operation.agentId,
						jobId: operation.jobId,
						generation: p.generation as number,
						leaseToken: p.leaseToken as string,
						sourceId: (p.sourceId as string | undefined) ?? commits[0]?.sourceId ?? "",
						harness: commits[0]?.harness ?? "",
						commits,
						...(p.inventory === undefined
							? {}
							: { inventory: p.inventory as import("./db-owner-protocol").DbOwnerTranscriptBulkCommit["inventory"] }),
					},
					{ operation: "sources.import.store.commit", lane: "write" },
				);
				return results as Result;
			}
			if (operation.operation === "finalize")
				return (await dbOwnerTransaction(
					[
						{
							sql: "UPDATE source_import_jobs SET state = CASE WHEN rejected > 0 THEN 'completed_with_rejections' ELSE 'completed' END, lease_token = NULL, lease_expires_at = NULL, completed_at = datetime('now'), reconciled_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND agent_id = ? AND generation = ? AND lease_token = ? AND control_request IS NULL AND state IN ('running','inventorying') AND NOT EXISTS (SELECT 1 FROM source_import_records WHERE job_id = ? AND agent_id = ? AND status = 'pending') AND NOT EXISTS (SELECT 1 FROM source_import_files WHERE job_id = ? AND agent_id = ? AND state != 'completed')",
							params: [
								operation.jobId,
								operation.agentId,
								p.generation as number,
								p.leaseToken as string,
								operation.jobId,
								operation.agentId,
								operation.jobId,
								operation.agentId,
							],
							result: "run",
							requireChanges: true,
						},
					],
					{ operation: "sources.import.store.finalize", lane: "write" },
				)) as Result;
			if (operation.operation === "recover") {
				if (operation.jobId === "*") throw new Error("recovery requires one job");
				const startup = p.startup === true;
				return (await dbOwnerTransaction(
					[
						{
							sql: `UPDATE source_import_jobs SET state = CASE WHEN control_request = 'cancel' THEN 'cancelled' WHEN control_request = 'pause' THEN 'paused' WHEN retry_count >= 7 OR ? = 0 THEN 'failed' WHEN EXISTS (SELECT 1 FROM source_import_files WHERE job_id = source_import_jobs.id AND agent_id = source_import_jobs.agent_id AND state IN ('staging','failed')) THEN 'failed' ELSE 'queued' END, retry_count = retry_count + 1, generation = generation + 1, next_attempt_at = datetime('now','+1 second'), lease_token = NULL, lease_expires_at = NULL, control_request = NULL, error = ?, updated_at = datetime('now') WHERE id = ? AND agent_id = ? AND state IN ('running','inventorying') ${startup ? "" : "AND generation = ? AND lease_token = ?"}`,
							params: [
								startup || p.retryable === true ? 1 : 0,
								typeof p.error === "string" ? p.error : "interrupted import",
								operation.jobId,
								operation.agentId,
								...(startup ? [] : [p.generation as number, p.leaseToken as string]),
							],
							result: "run",
						},
					],
					{ operation: "sources.import.store.recover", lane: "write" },
				)) as Result;
			}
			if (operation.operation === "control") {
				if (p.apply === true) throw new Error("retired import control handshake");
				const control = p.control;
				const state = control === "pause" ? "paused" : control === "cancel" ? "cancelled" : "queued";
				const allowed =
					control === "start"
						? "('staging')"
						: control === "pause"
							? "('queued','running','inventorying')"
							: control === "resume"
								? "('paused')"
								: control === "retry"
									? "('failed','completed','completed_with_rejections','paused','queued','running','inventorying')"
									: control === "cancel"
										? "('staging','queued','running','inventorying','paused','failed')"
										: undefined;
				if (!allowed) throw new Error("unsupported import control");
				return (await dbOwnerTransaction(
					[
						{
							sql: `UPDATE source_import_jobs SET state = ?, cleanup_state = CASE WHEN ? = 'cancelled' THEN 'pending' ELSE cleanup_state END, retry_requested = ?, retry_cursor = '', generation = generation + 1, retry_count = 0, control_request = NULL, lease_token = NULL, lease_expires_at = NULL, next_attempt_at = NULL, error = NULL, updated_at = datetime('now') WHERE id = ? AND agent_id = ? AND state IN ${allowed} ${state === "queued" ? "AND EXISTS (SELECT 1 FROM source_import_files WHERE job_id = source_import_jobs.id AND agent_id = source_import_jobs.agent_id) AND NOT EXISTS (SELECT 1 FROM source_import_files WHERE job_id = source_import_jobs.id AND agent_id = source_import_jobs.agent_id AND (storage_state != 'sealed' OR state = 'staging'))" : ""}`,
							params: [state, state, control === "retry" ? 1 : 0, operation.jobId, operation.agentId],
							result: "run",
						},
					],
					{ operation: "sources.import.store.control", lane: "write" },
				)) as Result;
			}
			throw new Error(`Unsupported transcript import store operation: ${operation.operation}`);
		},
	};
}
export function createJob(input: {
	readonly jobId: string;
	readonly agentId: string;
	readonly schemaId?: string;
	readonly duplicateMode?: "skip" | "replace" | "reimport";
	readonly files?: readonly { readonly id: string; readonly name: string }[];
}): Promise<readonly unknown[]> {
	if (!input.agentId || (input.files?.length ?? 0) > 25) throw new Error("invalid import scope or file count");
	return dbOwnerTransaction(
		[
			{
				sql: "INSERT INTO source_import_jobs (id,kind,agent_id,schema_id,adapter_version,state,generation,duplicate_mode) VALUES (?, 'import', ?, ?, 1, 'staging', 0, ?)",
				params: [input.jobId, input.agentId, input.schemaId ?? "signet-export", input.duplicateMode ?? "skip"],
				result: "run",
			},
			...(input.files ?? []).map((file, ordinal) => ({
				sql: "INSERT INTO source_import_files (id,job_id,source_id,agent_id,ordinal,name,managed_path,state,storage_state) VALUES (?,?,?,?,?,?,?,'staging','uploading')",
				params: [file.id, input.jobId, `reserved:${input.jobId}:${file.id}`, input.agentId, ordinal, file.name, ""],
				result: "run" as const,
			})),
		],
		{ operation: "sources.import.create", lane: "write" },
	);
}
export async function controlImport(
	store: ImportStore,
	input: { jobId: string; agentId: string; control: "start" | "pause" | "resume" | "retry" | "cancel" },
): Promise<boolean> {
	const results = await store.run<readonly { readonly changes: number }[]>({
		kind: "source_import",
		operation: "control",
		agentId: input.agentId,
		jobId: input.jobId,
		payload: { control: input.control },
	});
	return (results[0]?.changes ?? 0) > 0;
}
