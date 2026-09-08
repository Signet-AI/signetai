import { loadSourcesConfig, resolveDefaultBasePath } from "@signet/core";
import { createHash } from "node:crypto";
import { statfs } from "node:fs/promises";
import { dirname } from "node:path";
import { dbOwnerQuery, dbOwnerTransaction } from "./db-owner-runtime";

export const TRANSCRIPT_CHUNK_BYTES = 64 * 1024;
export const TRANSCRIPT_UPLOAD_BYTES = 1024 * 1024;
// Seven chunks fit below the 1 MiB owner result cap after hex encoding and
// protocol framing, while reducing finalization round trips substantially.
export const TRANSCRIPT_READ_BYTES = 6 * TRANSCRIPT_CHUNK_BYTES;
export const TRANSCRIPT_FILE_BYTES = 64 * 1024 ** 3;
export interface TranscriptUploadScope {
	readonly agentId: string;
	readonly jobId: string;
	readonly fileId: string;
	readonly generation: number;
	readonly signal?: AbortSignal;
}
export interface TranscriptUpload {
	readonly upload_generation: number;
	readonly upload_offset: number;
	readonly upload_size: number | null;
	readonly upload_digest: string;
	readonly storage_state: string;
	readonly content_hash: string | null;
}
const read = { operation: "sources.import.bytes.read", lane: "read" } as const;
const write = { operation: "sources.import.bytes.write", lane: "write" } as const;
const checksum = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

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

export async function beginTranscriptUpload(scope: TranscriptUploadScope, size: number): Promise<void> {
	if (!Number.isSafeInteger(size) || size < 0 || size > TRANSCRIPT_FILE_BYTES)
		throw new RangeError("invalid upload size");
	const current = await transcriptUpload(scope);
	if (current.upload_size !== null) {
		if (
			current.upload_generation !== scope.generation ||
			current.upload_size !== size ||
			current.storage_state !== "uploading"
		)
			throw new Error("upload declaration mismatch");
		return;
	}
	const database = await dbOwnerQuery<{ file: string }>(
		{ sql: "SELECT file FROM pragma_database_list WHERE name = 'main'", result: "get", readonly: true },
		read,
	);
	if (!database?.file) throw new Error("upload requires durable database storage");
	const disk = await statfs(dirname(database.file));
	const available = disk.bavail * disk.bsize;
	if (!Number.isSafeInteger(available) || available <= 0) throw new Error("available disk space is unknown");
	const reservation = size * 3 + 64 * 1024 ** 2;
	try {
		await dbOwnerTransaction(
			[
				{
					sql: "UPDATE source_import_capacity SET reserved_bytes = reserved_bytes WHERE id = 1 AND reserved_bytes + ? <= ?",
					params: [reservation, Math.max(0, available - 1024 ** 3)],
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
	} catch (error) {
		const declared = await transcriptUpload(scope);
		if (
			declared.upload_generation !== scope.generation ||
			declared.upload_size !== size ||
			declared.storage_state !== "uploading"
		)
			throw error;
	}
}

/** The offset CAS and chunk insertion commit together. Replays must match bytes. */
export async function appendTranscriptChunk(
	scope: TranscriptUploadScope,
	offset: number,
	bytes: Uint8Array,
	expectedChecksum: string,
): Promise<number> {
	scope.signal?.throwIfAborted();
	if (
		!Number.isSafeInteger(offset) ||
		offset < 0 ||
		offset % TRANSCRIPT_CHUNK_BYTES !== 0 ||
		bytes.length === 0 ||
		bytes.length > TRANSCRIPT_UPLOAD_BYTES ||
		checksum(bytes) !== expectedChecksum
	)
		throw new RangeError("invalid upload chunk");
	const file = await transcriptUpload(scope);
	if (
		file.upload_generation !== scope.generation ||
		(file.storage_state !== "uploading" && file.storage_state !== "legacy") ||
		file.upload_size === null
	)
		throw new Error("upload generation is not writable");
	if (
		offset + bytes.length > file.upload_size ||
		(bytes.length % TRANSCRIPT_CHUNK_BYTES !== 0 && offset + bytes.length !== file.upload_size)
	)
		throw new RangeError("upload chunk size mismatch");
	if (offset < file.upload_offset) {
		if (offset + bytes.length > file.upload_offset) throw new Error("upload replay overlaps durable offset");
		if ((await transcriptBytesChecksum(scope, offset, bytes.length)) !== expectedChecksum)
			throw new Error("upload replay checksum mismatch");
		return file.upload_offset;
	}
	let digest = file.upload_digest;
	const chunks = [];
	for (let cursor = 0; cursor < bytes.length; cursor += TRANSCRIPT_CHUNK_BYTES) {
		const content = bytes.subarray(cursor, cursor + TRANSCRIPT_CHUNK_BYTES);
		const chunkHash = checksum(content);
		digest = checksum(Buffer.from(`${digest}:${chunkHash}:${content.length}`));
		chunks.push({
			sql: "INSERT INTO source_import_chunks (agent_id,file_id,generation,byte_offset,checksum,content) VALUES (?,?,?,?,?,?)",
			params: [
				scope.agentId,
				scope.fileId,
				scope.generation,
				offset + cursor,
				chunkHash,
				{ type: "bytes" as const, base64: Buffer.from(content).toString("base64") },
			],
			result: "run" as const,
		});
	}
	try {
		await dbOwnerTransaction(
			[
				{
					sql: "UPDATE source_import_files SET upload_offset = ?, upload_digest = ?, updated_at = datetime('now') WHERE id = ? AND job_id = ? AND agent_id = ? AND upload_generation = ? AND upload_offset = ? AND storage_state IN ('uploading','legacy') AND EXISTS (SELECT 1 FROM source_import_jobs WHERE id = ? AND agent_id = ? AND (state = 'staging' OR source_import_files.storage_state = 'legacy') AND (control_request IS NULL OR source_import_files.storage_state = 'legacy'))",
					params: [
						offset + bytes.length,
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
				...chunks,
			],
			write,
		);
	} catch (error) {
		const committed = await transcriptUpload(scope);
		if (committed.upload_generation !== scope.generation || committed.upload_offset < offset + bytes.length)
			throw error;
		// A concurrent CAS winner may have committed this exact request.
		if ((await transcriptBytesChecksum(scope, offset, bytes.length)) !== expectedChecksum)
			throw new Error("upload replay checksum mismatch");
		return committed.upload_offset;
	}
	return offset + bytes.length;
}

/** Each read is independently scoped and bounded, including during export. */
export async function readTranscriptBytes(
	scope: TranscriptUploadScope,
	offset: number,
	length = TRANSCRIPT_CHUNK_BYTES,
): Promise<Buffer> {
	scope.signal?.throwIfAborted();
	if (
		!Number.isSafeInteger(offset) ||
		offset < 0 ||
		!Number.isInteger(length) ||
		length < 1 ||
		length > TRANSCRIPT_READ_BYTES
	)
		throw new RangeError("invalid evidence read");
	const chunkOffset = Math.floor(offset / TRANSCRIPT_CHUNK_BYTES) * TRANSCRIPT_CHUNK_BYTES;
	const rows = await dbOwnerQuery<Array<{ byte_offset: number; content: string; checksum: string }>>(
		{
			sql: "SELECT c.byte_offset,hex(c.content) AS content,c.checksum FROM source_import_chunks c JOIN source_import_files f ON f.id = c.file_id AND f.agent_id = c.agent_id WHERE c.agent_id = ? AND c.file_id = ? AND c.generation = ? AND c.byte_offset >= ? AND c.byte_offset < ? AND f.job_id = ? AND f.upload_generation = c.generation AND f.storage_state IN ('uploading','sealed','legacy') ORDER BY c.byte_offset LIMIT 7",
			params: [scope.agentId, scope.fileId, scope.generation, chunkOffset, offset + length, scope.jobId],
			result: "all",
			readonly: true,
		},
		read,
	);
	if (!rows?.length) throw new Error("source evidence unavailable");
	let position = chunkOffset;
	const chunks = rows.map((row) => {
		if (row.byte_offset !== position) throw new Error("source evidence truncated");
		const bytes = Buffer.from(row.content, "hex");
		if (checksum(bytes) !== row.checksum) throw new Error("source evidence checksum mismatch");
		position += bytes.length;
		return bytes;
	});
	return Buffer.concat(chunks).subarray(offset - chunkOffset, offset - chunkOffset + length);
}

async function transcriptBytesChecksum(scope: TranscriptUploadScope, offset: number, length: number): Promise<string> {
	const hash = createHash("sha256");
	for (let cursor = offset, remaining = length; remaining > 0; ) {
		const bytes = await readTranscriptBytes(scope, cursor, Math.min(TRANSCRIPT_READ_BYTES, remaining));
		if (!bytes.length) throw new Error("source evidence truncated");
		hash.update(bytes);
		cursor += bytes.length;
		remaining -= bytes.length;
	}
	return hash.digest("hex");
}

/** Seal before interpretation. Standard SHA-256 remains the file duplicate identity. */
export async function sealTranscriptUpload(
	scope: TranscriptUploadScope,
	active: () => boolean = () => true,
): Promise<TranscriptUpload> {
	const file = await transcriptUpload(scope);
	if (file.upload_generation !== scope.generation) throw new Error("stale upload generation");
	if (file.storage_state === "sealed") return file;
	if (
		(file.storage_state !== "uploading" && file.storage_state !== "legacy") ||
		file.upload_size === null ||
		file.upload_offset !== file.upload_size
	)
		throw new Error("upload incomplete");
	const hash = createHash("sha256");
	for (let offset = 0; offset < file.upload_size; ) {
		if (!active()) throw new Error("import interrupted");
		const bytes = await readTranscriptBytes(scope, offset, Math.min(TRANSCRIPT_READ_BYTES, file.upload_size - offset));
		if (!bytes.length) throw new Error("source evidence truncated");
		hash.update(bytes);
		offset += bytes.length;
	}
	scope.signal?.throwIfAborted();
	if (!active()) throw new Error("import interrupted");
	const contentHash = hash.digest("hex");
	if (file.storage_state === "legacy" && file.content_hash !== null && file.content_hash !== contentHash)
		throw new Error("legacy source hash mismatch");
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
	return transcriptUpload(scope);
}

/** Compatibility transport: a single streamed PUT uses the same chunk writer. */
export async function uploadTranscriptStream(
	scope: TranscriptUploadScope,
	size: number,
	stream: AsyncIterable<Uint8Array>,
): Promise<void> {
	await beginTranscriptUpload(scope, size);
	let offset = 0;
	let buffered = Buffer.alloc(0);
	for await (const bytes of stream) {
		let cursor = 0;
		while (cursor < bytes.length) {
			const take = Math.min(TRANSCRIPT_UPLOAD_BYTES - buffered.length, bytes.length - cursor);
			buffered = Buffer.concat([buffered, bytes.subarray(cursor, cursor + take)]);
			cursor += take;
			if (offset + buffered.length > size) throw new RangeError("upload exceeds declared size");
			if (buffered.length === TRANSCRIPT_UPLOAD_BYTES) {
				await appendTranscriptChunk(scope, offset, buffered, checksum(buffered));
				offset += buffered.length;
				buffered = Buffer.alloc(0);
			}
		}
	}
	if (buffered.length) await appendTranscriptChunk(scope, offset, buffered, checksum(buffered));
	if (offset + buffered.length !== size) throw new Error("upload incomplete");
}

/** Tombstone first; each delete transaction releases at most sixteen chunks. */
export async function purgeTranscriptBytes(
	scope: Omit<TranscriptUploadScope, "generation">,
	active: () => boolean = () => true,
): Promise<void> {
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
	for (;;) {
		if (!active()) return;
		const result = await dbOwnerTransaction(
			[
				{
					sql: "DELETE FROM source_import_chunks WHERE (agent_id,file_id,generation,byte_offset) IN (SELECT agent_id,file_id,generation,byte_offset FROM source_import_chunks WHERE agent_id = ? AND file_id = ? AND EXISTS (SELECT 1 FROM source_import_files WHERE id = ? AND job_id = ? AND agent_id = ? AND storage_state = 'purging') LIMIT 16)",
					params: [scope.agentId, scope.fileId, scope.fileId, scope.jobId, scope.agentId],
					result: "run",
				},
			],
			write,
		);
		const deleted = result[0] as { changes: number };
		if (deleted.changes === 0) break;
	}
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

/** Complete a source registration after either normal finalization or crash recovery. */
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

/** Cancellation reclaims incomplete uploads; sealed Sources retain their evidence until deletion. */
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
