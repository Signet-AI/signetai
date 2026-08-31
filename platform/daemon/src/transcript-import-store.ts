import type { InventoryRecord } from "./transcript-import-inventory";
import { TRANSCRIPT_IMPORT_LIMITS } from "./transcript-import-adapter";
import { dbOwnerQuery, dbOwnerTransaction } from "./db-owner-runtime";

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
	readonly operation: "create_job" | "checkpoint" | "record_batch" | "reconcile" | "lease" | "control" | "list";
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
					sql: "SELECT * FROM source_import_jobs WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?",
					params: [operation.agentId, Number(p.limit ?? 100)],
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
		if (operation.operation === "control")
			return (await dbOwnerTransaction(
				[
					{
						sql: "UPDATE source_import_jobs SET control_request = ?, updated_at = datetime('now') WHERE id = ? AND agent_id = ?",
						params: [p.control as string, operation.jobId, operation.agentId],
						result: "run",
						requireChanges: true,
					},
				],
				{ operation: "sources.import.store.control", lane: "write" },
			)) as Result;
		if (operation.operation === "checkpoint")
			return (await dbOwnerTransaction(
				[
					{
						sql: "UPDATE source_import_files SET checkpoint_byte_offset = ?, checkpoint_ordinal = ?, updated_at = datetime('now') WHERE id = ? AND job_id = ? AND agent_id = ?",
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
