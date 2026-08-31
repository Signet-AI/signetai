import type { InventoryRecord } from "./transcript-import-inventory";
import { TRANSCRIPT_IMPORT_LIMITS } from "./transcript-import-adapter";
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
	readonly operation:
		| "create_job"
		| "checkpoint"
		| "record_batch"
		| "reconcile"
		| "lease"
		| "control"
		| "list"
		| "file_complete"
		| "finalize"
		| "reject"
		| "commit"
		| "recover";
	readonly agentId: string;
	readonly jobId: string;
	readonly payload: Readonly<Record<string, unknown>>;
}
export interface ImportStore {
	readonly run: <Result>(operation: ImportStoreOperation) => Promise<Result>;
}

/** Repository facade: production callers provide the DB-owner runner, never a SQLite writer. */
export function createTranscriptImportStore(run: ImportStore["run"]): ImportStore {
	return { run };
}

/** Production facade: import ledger SQL is always submitted to the DB owner. */
export function createOwnerTranscriptImportStore(): ImportStore {
	return createTranscriptImportStore(async <Result>(operation: ImportStoreOperation): Promise<Result> => {
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
										: "SELECT * FROM source_import_jobs WHERE agent_id = ? AND state IN ('queued','running','inventorying') ORDER BY created_at ASC LIMIT ?",
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
		if (operation.operation === "reconcile")
			return (await dbOwnerQuery(
				{
					sql: "SELECT status, COUNT(*) AS count FROM source_import_records WHERE job_id = ? AND agent_id = ? GROUP BY status",
					params: [operation.jobId, operation.agentId],
					result: "all",
					readonly: true,
				},
				{ operation: "sources.import.store.reconcile", lane: "read" },
			)) as Result;
		if (operation.operation === "lease")
			return (await dbOwnerQuery(
				{
					sql: "UPDATE source_import_jobs SET state = 'running', lease_token = ?, lease_expires_at = datetime('now','+5 minutes'), started_at = COALESCE(started_at, datetime('now')), updated_at = datetime('now') WHERE id = ? AND agent_id = ? AND state = 'queued' AND generation = ? AND control_request IS NULL RETURNING *",
					params: [p.token as string, operation.jobId, operation.agentId, p.generation as number],
					result: "get",
					readonly: false,
				},
				{ operation: "sources.import.store.lease", lane: "write" },
			)) as Result;
		if (operation.operation === "record_batch") {
			const records = p.records as InventoryRecord[];
			const statements = [
				{
					sql: "UPDATE source_import_jobs SET updated_at = datetime('now') WHERE id = ? AND agent_id = ? AND generation = ? AND lease_token = ? AND state IN ('running','inventorying')",
					params: [operation.jobId, operation.agentId, p.generation as number, p.leaseToken as string],
					result: "run" as const,
					requireChanges: true,
				},
				...records.map((r) => ({
					sql: "INSERT OR IGNORE INTO source_import_records (id,job_id,file_id,source_id,agent_id,ordinal,line_number,byte_offset,byte_length,raw_hash,status,rejection_code) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
					params: [
						`${operation.jobId}:${p.fileId}:${r.ordinal}`,
						operation.jobId,
						p.fileId as string,
						p.sourceId as string,
						operation.agentId,
						r.ordinal,
						r.lineNumber,
						r.byteOffset,
						r.byteLength,
						r.rawHash,
						r.status,
						r.rejectionCode ?? null,
					],
					result: "run" as const,
				})),
			];
			statements.push({
				sql: "UPDATE source_import_files SET checkpoint_byte_offset = MAX(checkpoint_byte_offset, ?), checkpoint_ordinal = MAX(checkpoint_ordinal, ?), record_count = (SELECT COUNT(*) FROM source_import_records WHERE file_id = ? AND agent_id = ?), malformed_count = (SELECT COUNT(*) FROM source_import_records WHERE file_id = ? AND agent_id = ? AND status = 'rejected'), state = 'inventorying', updated_at = datetime('now') WHERE id = ? AND job_id = ? AND agent_id = ? AND checkpoint_ordinal <= ? AND checkpoint_byte_offset <= ?",
				params: [
					(p.checkpoint as { byteOffset: number }).byteOffset,
					(p.checkpoint as { ordinal: number }).ordinal,
					p.fileId as string,
					operation.agentId,
					p.fileId as string,
					operation.agentId,
					p.fileId as string,
					operation.jobId,
					operation.agentId,
					(p.checkpoint as { ordinal: number }).ordinal,
					(p.checkpoint as { byteOffset: number }).byteOffset,
				],
				result: "run" as const,
			});
			statements.push({
				sql: "UPDATE source_import_jobs SET total = (SELECT COUNT(*) FROM source_import_records WHERE job_id = ? AND agent_id = ?), updated_at = datetime('now') WHERE id = ? AND agent_id = ?",
				params: [operation.jobId, operation.agentId, operation.jobId, operation.agentId],
				result: "run" as const,
			});
			return (await dbOwnerTransaction(statements, {
				operation: "sources.import.store.record-batch",
				lane: "write",
			})) as Result;
		}
		if (operation.operation === "file_complete")
			return (await dbOwnerTransaction(
				[
					{
						sql: "UPDATE source_import_files SET state = 'completed', updated_at = datetime('now') WHERE id = ? AND job_id = ? AND agent_id = ? AND EXISTS (SELECT 1 FROM source_import_jobs WHERE id = ? AND agent_id = ? AND generation = ? AND lease_token = ?)",
						params: [
							p.fileId as string,
							operation.jobId,
							operation.agentId,
							operation.jobId,
							operation.agentId,
							p.generation as number,
							p.leaseToken as string,
						],
						result: "run",
					},
				],
				{ operation: "sources.import.store.file-complete", lane: "write" },
			)) as Result;
		if (operation.operation === "reject")
			return (await dbOwnerTransaction(
				[
					{
						sql: "UPDATE source_import_records SET status = 'rejected', rejection_code = ?, updated_at = datetime('now') WHERE id = ? AND job_id = ? AND agent_id = ? AND status = 'pending'",
						params: [p.code as string, p.recordId as string, operation.jobId, operation.agentId],
						result: "run",
					},
					{
						sql: "INSERT INTO source_import_record_attempts (agent_id,job_id,file_id,record_id,generation,outcome,error_code,source_id) SELECT agent_id,job_id,file_id,id,0,'rejected',?,source_id FROM source_import_records WHERE id = ? AND job_id = ? AND agent_id = ?",
						params: [p.code as string, p.recordId as string, operation.jobId, operation.agentId],
						result: "run",
					},
				],
				{ operation: "sources.import.store.reject", lane: "write" },
			)) as Result;
		if (operation.operation === "commit") {
			const commits = p.commits as import("./transcript-import-commit").CompletedTranscriptCommit[];
			const results = await dbOwnerTranscriptBulkCommit(
				{
					agentId: operation.agentId,
					jobId: operation.jobId,
					generation: p.generation as number,
					leaseToken: p.leaseToken as string,
					sourceId: commits[0]?.sourceId ?? "",
					harness: commits[0]?.harness ?? "",
					commits,
				},
				{ operation: "sources.import.store.commit", lane: "write" },
			);
			for (let i = 0; i < commits.length; i++)
				await dbOwnerTransaction(
					[
						{
							sql: "UPDATE source_import_records SET status = ?, canonical_id = ?, canonical_key = ?, external_identity = ?, conversation_fingerprint = ?, updated_at = datetime('now') WHERE id = ? AND job_id = ? AND agent_id = ? AND EXISTS (SELECT 1 FROM source_import_jobs WHERE id = ? AND agent_id = ? AND generation = ? AND lease_token = ?)",
							params: [
								(results[i] as { outcome: string }).outcome === "conversation_identity_conflict"
									? "rejected"
									: (results[i] as { outcome: string }).outcome,
								commits[i]?.canonicalId ?? null,
								commits[i]?.canonicalKey ?? null,
								commits[i]?.externalIdentity ?? null,
								commits[i]?.contentHash ?? null,
								commits[i]?.sourceRecordId ?? "",
								operation.jobId,
								operation.agentId,
								operation.jobId,
								operation.agentId,
								p.generation as number,
								p.leaseToken as string,
							],
							result: "run",
						},
						{
							sql: "INSERT INTO source_import_record_attempts (agent_id,job_id,file_id,record_id,generation,outcome,error_code,source_id) SELECT agent_id,job_id,file_id,id,0,?,?,source_id FROM source_import_records WHERE id = ? AND job_id = ? AND agent_id = ?",
							params: [
								(results[i] as { outcome: string }).outcome,
								(results[i] as { outcome: string }).outcome === "conversation_identity_conflict"
									? "conversation_identity_conflict"
									: null,
								commits[i]?.sourceRecordId ?? "",
								operation.jobId,
								operation.agentId,
							],
							result: "run",
						},
					],
					{ operation: "sources.import.store.commit-record", lane: "write" },
				);
			return results as Result;
		}
		if (operation.operation === "finalize")
			return (await dbOwnerTransaction(
				[
					{
						sql: "UPDATE source_import_jobs SET state = CASE WHEN (SELECT COUNT(*) FROM source_import_records WHERE job_id = ? AND agent_id = ? AND status = 'rejected') > 0 THEN 'completed_with_rejections' ELSE 'completed' END, imported = (SELECT COUNT(*) FROM source_import_records WHERE job_id = ? AND agent_id = ? AND status = 'imported'), duplicate = (SELECT COUNT(*) FROM source_import_records WHERE job_id = ? AND agent_id = ? AND status = 'duplicate'), rejected = (SELECT COUNT(*) FROM source_import_records WHERE job_id = ? AND agent_id = ? AND status = 'rejected'), pending = (SELECT COUNT(*) FROM source_import_records WHERE job_id = ? AND agent_id = ? AND status = 'pending'), lease_token = NULL, lease_expires_at = NULL, completed_at = datetime('now'), reconciled_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND agent_id = ? AND generation = ? AND lease_token = ?",
						params: [
							operation.jobId,
							operation.agentId,
							operation.jobId,
							operation.agentId,
							operation.jobId,
							operation.agentId,
							operation.jobId,
							operation.agentId,
							operation.jobId,
							operation.agentId,
							operation.jobId,
							operation.agentId,
							p.generation as number,
							p.leaseToken as string,
						],
						result: "run",
						requireChanges: true,
					},
				],
				{ operation: "sources.import.store.finalize", lane: "write" },
			)) as Result;
		if (operation.operation === "recover")
			return (await dbOwnerTransaction(
				[
					{
						sql: "UPDATE source_import_jobs SET lease_token = NULL, lease_expires_at = NULL, state = CASE WHEN state IN ('running','inventorying') THEN 'queued' ELSE state END, updated_at = datetime('now') WHERE agent_id = ? AND (? = '*' OR id = ?)",
						params: [operation.agentId, operation.jobId, operation.jobId],
						result: "run",
					},
				],
				{ operation: "sources.import.store.recover", lane: "write" },
			)) as Result;
		if (operation.operation === "control")
			return (await dbOwnerTransaction(
				[
					{
						sql:
							p.apply === true
								? "UPDATE source_import_jobs SET state = CASE WHEN control_request = 'pause' THEN 'paused' WHEN control_request = 'cancel' THEN 'cancelled' ELSE state END, lease_token = CASE WHEN control_request IN ('pause','cancel') THEN NULL ELSE lease_token END, control_request = CASE WHEN control_request IN ('pause','cancel') THEN NULL ELSE control_request END, updated_at = datetime('now') WHERE id = ? AND agent_id = ? AND generation = ? AND lease_token = ?"
								: "UPDATE source_import_jobs SET control_request = ?, updated_at = datetime('now') WHERE id = ? AND agent_id = ?",
						params:
							p.apply === true
								? [operation.jobId, operation.agentId, p.generation as number, p.leaseToken as string]
								: [p.control as string, operation.jobId, operation.agentId],
						result: "run",
					},
					...(p.apply === true
						? [
								{
									sql: "UPDATE source_import_records SET status = 'cancelled', rejection_code = 'cancelled_by_user', updated_at = datetime('now') WHERE job_id = ? AND agent_id = ? AND status = 'pending'",
									params: [operation.jobId, operation.agentId],
									result: "run" as const,
								},
							]
						: []),
				],
				{ operation: "sources.import.store.control", lane: "write" },
			)) as Result;
		if (operation.operation === "checkpoint")
			return (await dbOwnerTransaction(
				[
					{
						sql: "UPDATE source_import_files SET checkpoint_byte_offset = MAX(checkpoint_byte_offset, ?), checkpoint_ordinal = MAX(checkpoint_ordinal, ?), updated_at = datetime('now') WHERE id = ? AND job_id = ? AND agent_id = ?",
						params: [
							p.byteOffset as number,
							p.ordinal as number,
							p.fileId as string,
							operation.jobId,
							operation.agentId,
						],
						result: "run",
						requireChanges: true,
					},
				],
				{ operation: "sources.import.store.checkpoint", lane: "write" },
			)) as Result;
		if (operation.operation === "create_job")
			return (await dbOwnerTransaction(
				[
					{
						sql: "INSERT INTO source_import_jobs (id,kind,agent_id,schema_id,adapter_version,state,generation) VALUES (?, 'import', ?, ?, 1, 'staging', 0)",
						params: [operation.jobId, operation.agentId, p.schemaId as string],
						result: "run",
					},
				],
				{ operation: "sources.import.store.create", lane: "write" },
			)) as Result;
		throw new Error(`Unsupported transcript import store operation: ${operation.operation}`);
	});
}
export function createJob(
	store: ImportStore,
	input: { jobId: string; agentId: string; schemaId?: string },
): Promise<unknown> {
	return store.run({
		kind: "source_import",
		operation: "create_job",
		agentId: input.agentId,
		jobId: input.jobId,
		payload: { schemaId: input.schemaId ?? "signet-export", adapterVersion: 1, state: "staging", generation: 0 },
	});
}
export function checkpointInventory(
	store: ImportStore,
	input: { jobId: string; agentId: string; fileId: string; byteOffset: number; ordinal: number },
): Promise<unknown> {
	if (input.byteOffset < 0 || input.ordinal < 0) throw new Error("checkpoint must be nonnegative");
	return store.run({
		kind: "source_import",
		operation: "checkpoint",
		agentId: input.agentId,
		jobId: input.jobId,
		payload: { fileId: input.fileId, byteOffset: input.byteOffset, ordinal: input.ordinal, inventoryVersion: 1 },
	});
}
export function recordInventoryBatch(
	store: ImportStore,
	input: { jobId: string; agentId: string; fileId?: string; sourceId?: string; records: readonly InventoryRecord[] },
): Promise<unknown> {
	if (input.records.length > TRANSCRIPT_IMPORT_LIMITS.maxRecordsPerBatch)
		throw new Error("inventory batch exceeds limit");
	return store.run({
		kind: "source_import",
		operation: "record_batch",
		agentId: input.agentId,
		jobId: input.jobId,
		payload: { fileId: input.fileId, sourceId: input.sourceId, records: input.records },
	});
}
export function reconcileImport(store: ImportStore, input: { jobId: string; agentId: string }): Promise<unknown> {
	return store.run({
		kind: "source_import",
		operation: "reconcile",
		agentId: input.agentId,
		jobId: input.jobId,
		payload: {},
	});
}
export function controlImport(
	store: ImportStore,
	input: { jobId: string; agentId: string; control: "pause" | "resume" | "retry" | "cancel" },
): Promise<unknown> {
	return store.run({
		kind: "source_import",
		operation: "control",
		agentId: input.agentId,
		jobId: input.jobId,
		payload: { control: input.control },
	});
}
