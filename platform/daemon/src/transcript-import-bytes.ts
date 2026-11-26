import { loadSourcesConfig, resolveDefaultBasePath } from "@signet/core";
import { dbOwnerQuery, dbOwnerTransaction } from "./db-owner-runtime";
import {
	createStagingOwner,
	stagedChunkStatements,
	readStagedChunks,
	purgeStagedChunkBatch,
	type StagedChunk,
	type StoredStagedChunk,
	type TranscriptUpload,
} from "./staged-upload-owner";
export {
	TRANSCRIPT_CHUNK_BYTES,
	TRANSCRIPT_UPLOAD_BYTES,
	TRANSCRIPT_READ_BYTES,
	TRANSCRIPT_FILE_BYTES,
	type TranscriptUpload,
} from "./staged-upload-owner";

export interface TranscriptUploadScope {
	readonly agentId: string;
	readonly jobId: string;
	readonly fileId: string;
	readonly generation: number;
	readonly signal?: AbortSignal;
}
const read = { operation: "sources.import.bytes.read", lane: "read" } as const;
const write = { operation: "sources.import.bytes.write", lane: "write" } as const;
export async function transcriptUpload(scope: Omit<TranscriptUploadScope, "generation">): Promise<TranscriptUpload> {
	if (!scope.agentId || !scope.jobId || !scope.fileId) throw new Error("upload scope required");
	const file = await dbOwnerQuery<TranscriptUpload>(
		{
			sql: "SELECT upload_generation,upload_offset,upload_size,upload_digest,storage_state,content_hash FROM source_import_files WHERE id = ? AND job_id = ? AND agent_id = ?",
			params: [scope.fileId, scope.jobId, scope.agentId],
			result: "get",
			readonly: true,
		},
		read,
	);
	if (!file) throw new Error("upload not found");
	return file;
}
async function databasePath(): Promise<string> {
	const database = await dbOwnerQuery<{ file: string }>(
		{ sql: "SELECT file FROM pragma_database_list WHERE name = 'main'", result: "get", readonly: true },
		read,
	);
	if (!database?.file) throw new Error("upload requires durable database storage");
	return database.file;
}
async function declareUpload(
	scope: TranscriptUploadScope,
	size: number,
	reservation: number,
	available: number,
): Promise<void> {
	await dbOwnerTransaction(
		[
			{
				sql: "UPDATE source_import_capacity SET reserved_bytes = reserved_bytes WHERE id = 1 AND reserved_bytes + ? <= ?",
				params: [reservation, available],
				result: "run",
				requireChanges: true,
			},
			{
				sql: "UPDATE source_import_files SET upload_size = ?, storage_state = 'uploading' WHERE id = ? AND job_id = ? AND agent_id = ? AND upload_generation = ? AND storage_state = 'uploading' AND (upload_size IS NULL OR upload_size = ?) AND EXISTS (SELECT 1 FROM source_import_jobs WHERE id = ? AND agent_id = ? AND state = 'staging' AND (control_request IS NULL OR source_import_files.storage_state = 'legacy'))",
				params: [size, scope.fileId, scope.jobId, scope.agentId, scope.generation, size, scope.jobId, scope.agentId],
				result: "run",
				requireChanges: true,
			},
			{
				sql: "UPDATE source_import_files SET reserved_bytes = ? WHERE id = ? AND job_id = ? AND agent_id = ? AND reserved_bytes = 0",
				params: [reservation, scope.fileId, scope.jobId, scope.agentId],
				result: "run",
				requireChanges: true,
			},
		],
		write,
	);
}
async function appendChunks(
	scope: TranscriptUploadScope,
	offset: number,
	length: number,
	digest: string,
	chunks: readonly StagedChunk[],
): Promise<void> {
	const statements = stagedChunkStatements({ ...scope, kind: "source" }, scope.generation, chunks);
	await dbOwnerTransaction(
		[
			{
				sql: "UPDATE source_import_files SET upload_offset = ?, upload_digest = ?, updated_at = datetime('now') WHERE id = ? AND job_id = ? AND agent_id = ? AND upload_generation = ? AND upload_offset = ? AND storage_state IN ('uploading','legacy') AND EXISTS (SELECT 1 FROM source_import_jobs WHERE id = ? AND agent_id = ? AND (state = 'staging' OR source_import_files.storage_state = 'legacy') AND (control_request IS NULL OR source_import_files.storage_state = 'legacy'))",
				params: [
					offset + length,
					digest,
					scope.fileId,
					scope.jobId,
					scope.agentId,
					scope.generation,
					offset,
					scope.jobId,
					scope.agentId,
				],
				result: "run",
				requireChanges: true,
			},
			...statements,
		],
		write,
	);
}
async function readChunks(
	scope: TranscriptUploadScope,
	start: number,
	end: number,
): Promise<readonly StoredStagedChunk[]> {
	return readStagedChunks({ ...scope, kind: "source" }, scope.generation, start, end);
}
async function sealUpload(scope: TranscriptUploadScope, contentHash: string): Promise<void> {
	await dbOwnerTransaction(
		[
			{
				sql: "UPDATE source_import_files SET storage_state = 'sealed', content_hash = ?, size_bytes = upload_size WHERE id = ? AND job_id = ? AND agent_id = ? AND upload_generation = ? AND storage_state IN ('uploading','legacy') AND upload_offset = upload_size AND EXISTS (SELECT 1 FROM source_import_jobs WHERE id = ? AND agent_id = ? AND (state = 'staging' OR source_import_files.storage_state = 'legacy') AND (control_request IS NULL OR source_import_files.storage_state = 'legacy'))",
				params: [contentHash, scope.fileId, scope.jobId, scope.agentId, scope.generation, scope.jobId, scope.agentId],
				result: "run",
				requireChanges: true,
			},
		],
		write,
	);
}
async function beginPurge(scope: Omit<TranscriptUploadScope, "generation">): Promise<void> {
	await dbOwnerTransaction(
		[
			{
				sql: "UPDATE source_import_files SET storage_state = 'purging', upload_generation = upload_generation + 1 WHERE id = ? AND job_id = ? AND agent_id = ? AND storage_state NOT IN ('purging','purged','legacy')",
				params: [scope.fileId, scope.jobId, scope.agentId],
				result: "run",
			},
		],
		write,
	);
}
async function purgeBatch(scope: Omit<TranscriptUploadScope, "generation">): Promise<number> {
	return purgeStagedChunkBatch({ ...scope, kind: "source" });
}
async function finishPurge(scope: Omit<TranscriptUploadScope, "generation">): Promise<void> {
	await dbOwnerTransaction(
		[
			{
				sql: "UPDATE source_import_files SET storage_state = 'purged', reserved_bytes = 0 WHERE id = ? AND job_id = ? AND agent_id = ? AND storage_state = 'purging' AND NOT EXISTS (SELECT 1 FROM source_import_chunks WHERE agent_id = ? AND file_id = ?)",
				params: [scope.fileId, scope.jobId, scope.agentId, scope.agentId, scope.fileId],
				result: "run",
			},
		],
		write,
	);
}
const staging = createStagingOwner<Omit<TranscriptUploadScope, "generation">, TranscriptUploadScope>({
	get: transcriptUpload,
	databasePath,
	declare: declareUpload,
	append: appendChunks,
	read: readChunks,
	seal: sealUpload,
	beginPurge,
	purgeBatch,
	finishPurge,
});
export const beginTranscriptUpload = staging.begin;
export const appendTranscriptChunk = staging.append;
export const readTranscriptBytes = staging.read;
export const sealTranscriptUpload = async (...args: Parameters<typeof staging.seal>) =>
	(await staging.seal(...args)).upload;
export const uploadTranscriptStream = staging.upload;
export const purgeTranscriptBytes = staging.purge;

export async function bindTranscriptSource(scope: TranscriptUploadScope, sourceId: string): Promise<void> {
	await dbOwnerTransaction(
		[
			{
				sql: "UPDATE source_import_files SET source_id = ?,state = 'ready',error = NULL,updated_at = datetime('now') WHERE id = ? AND job_id = ? AND agent_id = ? AND upload_generation = ? AND storage_state = 'sealed' AND state IN ('staging','ready') AND EXISTS (SELECT 1 FROM source_import_jobs WHERE id = ? AND agent_id = ? AND state IN ('staging','cancelled'))",
				params: [sourceId, scope.fileId, scope.jobId, scope.agentId, scope.generation, scope.jobId, scope.agentId],
				result: "run",
				requireChanges: true,
			},
		],
		write,
	);
}
export async function cleanupCancelledTranscriptImport(
	agentId: string,
	requestedJobId?: string,
	active: () => boolean = () => true,
): Promise<void> {
	const jobId =
		requestedJobId ??
		(
			await dbOwnerQuery<{ id: string }>(
				{
					sql: "SELECT id FROM source_import_jobs WHERE agent_id = ? AND state = 'cancelled' AND cleanup_state = 'pending' ORDER BY id LIMIT 1",
					params: [agentId],
					result: "get",
					readonly: true,
				},
				read,
			)
		)?.id;
	if (!jobId) return;
	const files = await dbOwnerQuery<Array<{ id: string; storage_state: string; upload_generation: number }>>(
		{
			sql: "SELECT id,storage_state,upload_generation FROM source_import_files WHERE job_id = ? AND agent_id = ? AND (storage_state IN ('uploading','purging') OR (storage_state = 'sealed' AND state = 'staging')) AND EXISTS (SELECT 1 FROM source_import_jobs WHERE id = ? AND agent_id = ? AND state = 'cancelled') ORDER BY id LIMIT 25",
			params: [jobId, agentId, jobId, agentId],
			result: "all",
			readonly: true,
		},
		read,
	);
	for (const file of files) {
		if (!active()) return;
		if (file.storage_state === "sealed") {
			const registered = loadSourcesConfig(resolveDefaultBasePath()).sources.find(
				(source) =>
					source.kind === "import" &&
					source.providerSettings?.agentId === agentId &&
					source.providerSettings?.importKey === `${jobId}:${file.id}:${file.upload_generation}`,
			);
			if (registered) {
				await bindTranscriptSource(
					{ jobId, agentId, fileId: file.id, generation: file.upload_generation },
					registered.id,
				);
				continue;
			}
		}
		await purgeTranscriptBytes({ jobId, agentId, fileId: file.id }, active);
	}
	if (!active()) return;
	await dbOwnerTransaction(
		[
			{
				sql: "UPDATE source_import_files SET reserved_bytes = 0 WHERE job_id = ? AND agent_id = ? AND EXISTS (SELECT 1 FROM source_import_jobs WHERE id = ? AND agent_id = ? AND state = 'cancelled')",
				params: [jobId, agentId, jobId, agentId],
				result: "run",
			},
			{
				sql: "UPDATE source_import_jobs SET cleanup_state = 'complete' WHERE id = ? AND agent_id = ? AND state = 'cancelled' AND NOT EXISTS (SELECT 1 FROM source_import_files WHERE job_id = ? AND agent_id = ? AND (storage_state IN ('uploading','purging') OR (storage_state = 'sealed' AND state = 'staging')))",
				params: [jobId, agentId, jobId, agentId],
				result: "run",
			},
		],
		write,
	);
}
