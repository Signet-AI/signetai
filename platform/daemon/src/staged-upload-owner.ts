import { createHash } from "node:crypto";
import { statfs } from "node:fs/promises";
import { dirname } from "node:path";
import type { DbOwnerStatement, DbOwnerParameter } from "./db-owner-protocol";
import { dbOwnerQuery, dbOwnerTransaction } from "./db-owner-runtime";

export const TRANSCRIPT_CHUNK_BYTES = 64 * 1024;
export const TRANSCRIPT_UPLOAD_BYTES = 1024 * 1024;
export const TRANSCRIPT_READ_BYTES = 6 * TRANSCRIPT_CHUNK_BYTES;
export const TRANSCRIPT_FILE_BYTES = 64 * 1024 ** 3;

export interface TranscriptUpload {
	readonly upload_generation: number;
	readonly upload_offset: number;
	readonly upload_size: number | null;
	readonly upload_digest: string;
	readonly storage_state: string;
	readonly content_hash: string | null;
}
export interface StagedChunk {
	readonly offset: number;
	readonly checksum: string;
	readonly bytes: Uint8Array;
}
export interface StoredStagedChunk {
	readonly byte_offset: number;
	readonly checksum: string;
	readonly content: string;
}
interface ReadScope {
	readonly signal?: AbortSignal;
}
export interface StagingStore<Read extends ReadScope, Write extends Read & { readonly generation: number }> {
	readonly get: (scope: Read) => Promise<TranscriptUpload>;
	readonly databasePath: () => Promise<string>;
	readonly declare: (scope: Write, size: number, reservation: number, available: number) => Promise<void>;
	readonly append: (
		scope: Write,
		offset: number,
		length: number,
		digest: string,
		chunks: readonly StagedChunk[],
	) => Promise<void>;
	readonly read: (scope: Write, start: number, end: number) => Promise<readonly StoredStagedChunk[]>;
	readonly seal: (scope: Write, sha256: string) => Promise<void>;
	readonly beginPurge: (scope: Read) => Promise<void>;
	readonly purgeBatch: (scope: Read) => Promise<number>;
	readonly finishPurge: (scope: Read) => Promise<void>;
}
const checksum = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

export function createStagingOwner<Read extends ReadScope, Write extends Read & { readonly generation: number }>(
	store: StagingStore<Read, Write>,
) {
	async function begin(scope: Write, size: number): Promise<void> {
		if (!Number.isSafeInteger(size) || size < 0 || size > TRANSCRIPT_FILE_BYTES)
			throw new RangeError("invalid upload size");
		const current = await store.get(scope);
		if (current.upload_size !== null) {
			if (
				current.upload_generation !== scope.generation ||
				current.upload_size !== size ||
				current.storage_state !== "uploading"
			)
				throw new Error("upload declaration mismatch");
			return;
		}
		const disk = await statfs(dirname(await store.databasePath()));
		const available = disk.bavail * disk.bsize;
		if (!Number.isSafeInteger(available) || available <= 0) throw new Error("available disk space is unknown");
		const reservation = size * 3 + 64 * 1024 ** 2;
		try {
			await store.declare(scope, size, reservation, Math.max(0, available - 1024 ** 3));
		} catch (error) {
			const declared = await store.get(scope);
			if (
				declared.upload_generation !== scope.generation ||
				declared.upload_size !== size ||
				declared.storage_state !== "uploading"
			)
				throw error;
		}
	}
	async function read(scope: Write, offset: number, length = TRANSCRIPT_CHUNK_BYTES): Promise<Buffer> {
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
		const rows = await store.read(scope, chunkOffset, offset + length);
		if (!rows.length) throw new Error("source evidence unavailable");
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
	async function rangeChecksum(scope: Write, offset: number, length: number): Promise<string> {
		const hash = createHash("sha256");
		for (let cursor = offset, remaining = length; remaining > 0; ) {
			const bytes = await read(scope, cursor, Math.min(TRANSCRIPT_READ_BYTES, remaining));
			if (!bytes.length) throw new Error("source evidence truncated");
			hash.update(bytes);
			cursor += bytes.length;
			remaining -= bytes.length;
		}
		return hash.digest("hex");
	}
	async function append(scope: Write, offset: number, bytes: Uint8Array, expectedChecksum: string): Promise<number> {
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
		const file = await store.get(scope);
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
			if ((await rangeChecksum(scope, offset, bytes.length)) !== expectedChecksum)
				throw new Error("upload replay checksum mismatch");
			return file.upload_offset;
		}
		let digest = file.upload_digest;
		const chunks: StagedChunk[] = [];
		for (let cursor = 0; cursor < bytes.length; cursor += TRANSCRIPT_CHUNK_BYTES) {
			const content = bytes.subarray(cursor, cursor + TRANSCRIPT_CHUNK_BYTES);
			const chunkHash = checksum(content);
			digest = checksum(Buffer.from(`${digest}:${chunkHash}:${content.length}`));
			chunks.push({ offset: offset + cursor, checksum: chunkHash, bytes: content });
		}
		try {
			await store.append(scope, offset, bytes.length, digest, chunks);
		} catch (error) {
			const committed = await store.get(scope);
			if (committed.upload_generation !== scope.generation || committed.upload_offset < offset + bytes.length)
				throw error;
			if ((await rangeChecksum(scope, offset, bytes.length)) !== expectedChecksum)
				throw new Error("upload replay checksum mismatch");
			return committed.upload_offset;
		}
		return offset + bytes.length;
	}
	async function seal(scope: Write, active: () => boolean = () => true): Promise<TranscriptUpload> {
		const file = await store.get(scope);
		if (file.upload_generation !== scope.generation) throw new Error("stale upload generation");
		if (file.storage_state === "sealed" || file.storage_state === "consumed") return file;
		if (
			(file.storage_state !== "uploading" && file.storage_state !== "legacy") ||
			file.upload_size === null ||
			file.upload_offset !== file.upload_size
		)
			throw new Error("upload incomplete");
		const hash = createHash("sha256");
		for (let offset = 0; offset < file.upload_size; ) {
			if (!active()) throw new Error("import interrupted");
			const bytes = await read(scope, offset, Math.min(TRANSCRIPT_READ_BYTES, file.upload_size - offset));
			if (!bytes.length) throw new Error("source evidence truncated");
			hash.update(bytes);
			offset += bytes.length;
		}
		scope.signal?.throwIfAborted();
		if (!active()) throw new Error("import interrupted");
		const contentHash = hash.digest("hex");
		if (file.storage_state === "legacy" && file.content_hash !== null && file.content_hash !== contentHash)
			throw new Error("legacy source hash mismatch");
		await store.seal(scope, contentHash);
		return store.get(scope);
	}
	async function upload(scope: Write, size: number, stream: AsyncIterable<Uint8Array>): Promise<void> {
		await begin(scope, size);
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
					await append(scope, offset, buffered, checksum(buffered));
					offset += buffered.length;
					buffered = Buffer.alloc(0);
				}
			}
		}
		if (buffered.length) await append(scope, offset, buffered, checksum(buffered));
		if (offset + buffered.length !== size) throw new Error("upload incomplete");
	}
	async function purge(scope: Read, active: () => boolean = () => true): Promise<void> {
		await store.beginPurge(scope);
		for (;;) {
			if (!active()) return;
			if ((await store.purgeBatch(scope)) === 0) break;
		}
		await store.finishPurge(scope);
	}
	return { get: store.get, begin, append, read, seal, upload, purge };
}

export type StagedChunkScope = {
	readonly agentId: string;
	readonly fileId: string;
	readonly signal?: AbortSignal;
} & (
	| { readonly kind: "source"; readonly jobId: string }
	| {
			readonly kind: "hook";
			readonly principalId: string;
			readonly credentialKind: string;
			readonly credentialId: string;
			readonly harness: string;
			readonly sessionKey: string;
	  }
);
export function stagedScopeFilter(
	scope: StagedChunkScope,
	prefix: string,
): { sql: string; params: readonly DbOwnerParameter[] } {
	const base = `${prefix}id = ? AND ${prefix}agent_id = ?`;
	if (scope.kind === "source")
		return { sql: `${base} AND ${prefix}job_id = ?`, params: [scope.fileId, scope.agentId, scope.jobId] };
	return {
		sql: `${base} AND ${prefix}principal_id = ? AND ${prefix}credential_kind = ? AND ${prefix}credential_id = ? AND ${prefix}harness = ? AND ${prefix}session_key = ?`,
		params: [
			scope.fileId,
			scope.agentId,
			scope.principalId,
			scope.credentialKind,
			scope.credentialId,
			scope.harness,
			scope.sessionKey,
		],
	};
}
function stagedTables(scope: StagedChunkScope) {
	return scope.kind === "source"
		? { files: "source_import_files", chunks: "source_import_chunks" }
		: { files: "hook_transcript_uploads", chunks: "hook_transcript_chunks" };
}
export function stagedChunkStatements(
	scope: StagedChunkScope,
	generation: number,
	chunks: readonly StagedChunk[],
): readonly DbOwnerStatement[] {
	const table = stagedTables(scope).chunks;
	return chunks.map((chunk) => ({
		sql: `INSERT INTO ${table} (agent_id,file_id,generation,byte_offset,checksum,content) VALUES (?,?,?,?,?,?)`,
		params: [
			scope.agentId,
			scope.fileId,
			generation,
			chunk.offset,
			chunk.checksum,
			{ type: "bytes", base64: Buffer.from(chunk.bytes).toString("base64") },
		],
		result: "run",
	}));
}
export async function readStagedChunks(
	scope: StagedChunkScope,
	generation: number,
	start: number,
	end: number,
): Promise<readonly StoredStagedChunk[]> {
	const tables = stagedTables(scope),
		filter = stagedScopeFilter(scope, "f.");
	return dbOwnerQuery<StoredStagedChunk[]>(
		{
			sql: `SELECT c.byte_offset,hex(c.content) AS content,c.checksum FROM ${tables.chunks} c JOIN ${tables.files} f ON f.id = c.file_id AND f.agent_id = c.agent_id WHERE c.generation = ? AND c.byte_offset >= ? AND c.byte_offset < ? AND ${filter.sql} AND f.upload_generation = c.generation AND f.storage_state IN ('uploading','sealed','legacy','consumed') ORDER BY c.byte_offset LIMIT 7`,
			params: [generation, start, end, ...filter.params],
			result: "all",
			readonly: true,
		},
		{ operation: "transcripts.staging.read", lane: "read" },
	);
}
export async function purgeStagedChunkBatch(scope: StagedChunkScope): Promise<number> {
	const tables = stagedTables(scope),
		filter = stagedScopeFilter(scope, "f.");
	const result = await dbOwnerTransaction(
		[
			{
				sql: `DELETE FROM ${tables.chunks} WHERE (agent_id,file_id,generation,byte_offset) IN (SELECT agent_id,file_id,generation,byte_offset FROM ${tables.chunks} WHERE agent_id = ? AND file_id = ? AND EXISTS (SELECT 1 FROM ${tables.files} f WHERE ${filter.sql} AND f.storage_state = 'purging') LIMIT 16)`,
				params: [scope.agentId, scope.fileId, ...filter.params],
				result: "run",
			},
		],
		{ operation: "transcripts.staging.purge", lane: "write" },
	);
	const row = result[0];
	if (row === null || typeof row !== "object" || !("changes" in row) || typeof row.changes !== "number")
		throw new Error("Invalid staging purge result");
	return row.changes;
}
