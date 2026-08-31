import type { InventoryRecord } from "./transcript-import-inventory";
import { TRANSCRIPT_IMPORT_LIMITS } from "./transcript-import-adapter";

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
	input: { jobId: string; agentId: string; records: readonly InventoryRecord[] },
): Promise<unknown> {
	if (input.records.length > TRANSCRIPT_IMPORT_LIMITS.maxRecordsPerBatch)
		throw new Error("inventory batch exceeds limit");
	return store.run({
		kind: "source_import",
		operation: "record_batch",
		agentId: input.agentId,
		jobId: input.jobId,
		payload: { records: input.records },
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
