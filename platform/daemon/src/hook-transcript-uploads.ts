import { createHash } from "node:crypto";
import type { SessionEndResponse } from "./hooks";
import type { Principal } from "./auth/principal";
import { principalAccess, resolveWriteAgent } from "./auth/agent-access";
import { dbOwnerQuery, dbOwnerTransaction, dbOwnerCaptureTransition, getDbOwner } from "./db-owner-runtime";
import {
	createStagingOwner,
	stagedScopeFilter,
	stagedChunkStatements,
	readStagedChunks,
	purgeStagedChunkBatch,
	TRANSCRIPT_CHUNK_BYTES,
	UploadOffsetConflict,
	type TranscriptUpload,
	type StagedChunk,
	type StoredStagedChunk,
	type StagedChunkScope,
} from "./staged-upload-owner";

export const HOOK_TRANSCRIPT_BYTES = 256 * 1024 * 1024;
export const HOOK_TRANSCRIPT_CHUNK_OVERHEAD_BYTES = 4096;
export class HookUploadMissing extends Error {}
export class HookUploadChecksumMismatch extends Error {}
export class HookUploadBusy extends Error {}
export interface HookUploadRow extends TranscriptUpload {
	readonly id: string;
	readonly agent_id: string;
	readonly principal_id: string;
	readonly credential_kind: string;
	readonly credential_id: string;
	readonly harness: string;
	readonly session_key: string;
	readonly sha256: string;
	readonly updated_at: string;
	readonly result_json: string | null;
	readonly expired: number;
}
export type HookUploadScope = Extract<StagedChunkScope, { kind: "hook" }>;
interface WriteScope extends HookUploadScope {
	readonly generation: number;
	readonly signal?: AbortSignal;
}
const read = { operation: "hooks.upload.read", lane: "read" } as const;
const write = { operation: "hooks.upload.write", lane: "write" } as const;
function principalId(principal: Principal): string {
	return JSON.stringify([principal.kind, principal.userId ?? principal.credential.id]);
}
export function createHookUploadAdmission(): (principal: Principal) => (() => void) | null {
	let active = 0;
	const principals = new Map<string, number>();
	return (principal) => {
		const key = principalId(principal),
			count = principals.get(key) ?? 0;
		if (active >= 16 || count >= 4) return null;
		active++;
		principals.set(key, count + 1);
		let released = false;
		return () => {
			if (released) return;
			released = true;
			active--;
			const remaining = (principals.get(key) ?? 1) - 1;
			if (remaining) principals.set(key, remaining);
			else principals.delete(key);
		};
	};
}
function requireUploadAgent(principal: Principal, agentId: string): void {
	const access = principalAccess(principal);
	if (access) {
		const resolved = resolveWriteAgent(principal, agentId, access);
		if (!resolved.ok || resolved.value !== agentId) throw new HookUploadMissing();
		return;
	}
	if (principal.kind === "user") throw new HookUploadMissing();
	if (principal.kind === "local" || principal.boundAgentId === agentId || principal.role === "admin") return;
	throw new HookUploadMissing();
}
export function hookUploadScope(row: HookUploadRow): HookUploadScope {
	return {
		kind: "hook",
		agentId: row.agent_id,
		fileId: row.id,
		principalId: row.principal_id,
		credentialKind: row.credential_kind,
		credentialId: row.credential_id,
		harness: row.harness,
		sessionKey: row.session_key,
	};
}
async function metadata(scope: HookUploadScope): Promise<HookUploadRow> {
	const filter = stagedScopeFilter(scope, "");
	const row = await dbOwnerQuery<HookUploadRow>(
		{
			sql: `SELECT *, updated_at <= datetime('now','-24 hours') AS expired FROM hook_transcript_uploads WHERE ${filter.sql}`,
			params: filter.params,
			result: "get",
			readonly: true,
		},
		read,
	);
	if (!row) throw new HookUploadMissing();
	return row;
}
async function databasePath(): Promise<string> {
	const row = await dbOwnerQuery<{ file: string }>(
		{ sql: "SELECT file FROM pragma_database_list WHERE name = 'main'", result: "get", readonly: true },
		read,
	);
	if (!row?.file) throw new Error("Upload requires durable database storage");
	return row.file;
}
async function declare(scope: WriteScope, size: number, reservation: number, available: number): Promise<void> {
	const filter = stagedScopeFilter(scope, "");
	await dbOwnerTransaction(
		[
			{
				sql: "UPDATE source_import_capacity SET reserved_bytes = reserved_bytes WHERE id = 1 AND reserved_bytes + ? <= ?",
				params: [reservation, available],
				result: "run",
				requireChanges: true,
			},
			{
				sql: `UPDATE hook_transcript_uploads SET upload_size = ?, reserved_bytes = ? WHERE ${filter.sql} AND upload_generation = ? AND upload_size IS NULL AND storage_state = 'uploading' AND updated_at > datetime('now','-24 hours')`,
				params: [size, reservation, ...filter.params, scope.generation],
				result: "run",
				requireChanges: true,
			},
		],
		write,
	);
}
async function append(
	scope: WriteScope,
	offset: number,
	length: number,
	digest: string,
	chunks: readonly StagedChunk[],
): Promise<void> {
	const filter = stagedScopeFilter(scope, "");
	await dbOwnerTransaction(
		[
			{
				sql: `UPDATE hook_transcript_uploads SET upload_offset = ?, upload_digest = ?, updated_at = datetime('now') WHERE ${filter.sql} AND upload_generation = ? AND upload_offset = ? AND storage_state = 'uploading' AND updated_at > datetime('now','-24 hours')`,
				params: [offset + length, digest, ...filter.params, scope.generation, offset],
				result: "run",
				requireChanges: true,
			},
			...stagedChunkStatements(scope, scope.generation, chunks),
		],
		write,
	);
}
async function readChunks(scope: WriteScope, start: number, end: number): Promise<readonly StoredStagedChunk[]> {
	return readStagedChunks(scope, scope.generation, start, end);
}
async function seal(scope: WriteScope, sha256: string): Promise<void> {
	const filter = stagedScopeFilter(scope, "");
	const row = await metadata(scope);
	if (row.sha256 !== sha256) {
		await discardHookUpload(row, true);
		throw new HookUploadChecksumMismatch();
	}
	await dbOwnerTransaction(
		[
			{
				sql: `UPDATE hook_transcript_uploads SET storage_state = CASE WHEN storage_state = 'consumed' THEN 'consumed' ELSE 'sealed' END, content_hash = ?, size_bytes = upload_size WHERE ${filter.sql} AND upload_generation = ? AND upload_offset = upload_size AND storage_state IN ('uploading','sealed','consumed') AND sha256 = ? AND updated_at > datetime('now','-24 hours')`,
				params: [sha256, ...filter.params, scope.generation, sha256],
				result: "run",
				requireChanges: true,
			},
		],
		write,
	);
}
async function beginPurge(scope: HookUploadScope): Promise<void> {
	const filter = stagedScopeFilter(scope, "");
	await dbOwnerTransaction(
		[
			{
				sql: `UPDATE hook_transcript_uploads SET storage_state = 'purging', upload_generation = upload_generation + 1 WHERE ${filter.sql} AND storage_state NOT IN ('purging','purged') AND updated_at <= datetime('now','-24 hours')`,
				params: filter.params,
				result: "run",
			},
		],
		write,
	);
}
async function finishPurge(scope: HookUploadScope): Promise<void> {
	const filter = stagedScopeFilter(scope, "");
	await dbOwnerTransaction(
		[
			{
				sql: `UPDATE hook_transcript_uploads SET storage_state = 'purged', reserved_bytes = 0 WHERE ${filter.sql} AND storage_state = 'purging' AND NOT EXISTS (SELECT 1 FROM hook_transcript_chunks WHERE file_id = ? AND agent_id = ?)`,
				params: [...filter.params, scope.fileId, scope.agentId],
				result: "run",
			},
		],
		write,
	);
}
async function discardHookUpload(row: HookUploadRow, checksumFailure: boolean): Promise<void> {
	if (row.storage_state === "consumed") throw new UploadOffsetConflict(row.upload_offset);
	const filter = stagedScopeFilter(hookUploadScope(row), "");
	await dbOwnerTransaction(
		[
			{
				sql: `UPDATE hook_transcript_uploads SET storage_state = 'purging',upload_generation = upload_generation + 1 WHERE ${filter.sql} AND storage_state IN ('uploading','sealed') AND upload_generation = ?`,
				params: [...filter.params, row.upload_generation],
				result: "run",
				requireChanges: true,
			},
			...(checksumFailure
				? [
						{
							sql: `INSERT INTO hook_transcript_receipts (id,agent_id,principal_id,credential_kind,credential_id,harness,session_key,sha256,size_bytes,result_json) SELECT id,agent_id,principal_id,credential_kind,credential_id,harness,session_key,sha256,upload_offset,json_object('memoriesSaved',0,'queued',json('false'),'captureFailed',json('true'),'reason','upload_checksum_mismatch') FROM hook_transcript_uploads WHERE ${filter.sql} AND storage_state = 'purging'`,
							params: filter.params,
							result: "run" as const,
						},
					]
				: []),
			{
				sql: `DELETE FROM hook_transcript_chunks WHERE file_id = ? AND agent_id = ? AND EXISTS (SELECT 1 FROM hook_transcript_uploads WHERE ${filter.sql} AND storage_state = 'purging')`,
				params: [row.id, row.agent_id, ...filter.params],
				result: "run",
			},
			{
				sql: `DELETE FROM hook_transcript_uploads WHERE ${filter.sql} AND storage_state = 'purging'`,
				params: filter.params,
				result: "run",
			},
		],
		write,
	);
}
export async function abortHookUpload(principal: Principal, id: string): Promise<void> {
	await discardHookUpload(await getHookUpload(principal, id), false);
}
export const hookUploadStaging = createStagingOwner<HookUploadScope, WriteScope>({
	get: metadata,
	reservationBytes: (size) => size + Math.ceil(size / TRANSCRIPT_CHUNK_BYTES) * HOOK_TRANSCRIPT_CHUNK_OVERHEAD_BYTES,
	databasePath,
	declare,
	append,
	read: readChunks,
	seal,
	beginPurge,
	purgeBatch: purgeStagedChunkBatch,
	finishPurge,
});
async function purge(row: HookUploadRow, active: () => boolean): Promise<void> {
	const scope = hookUploadScope(row);
	await hookUploadStaging.purge(scope, active);
	if (!active()) return;
	const filter = stagedScopeFilter(scope, "");
	await dbOwnerTransaction(
		[
			{
				sql: `DELETE FROM hook_transcript_uploads WHERE ${filter.sql} AND storage_state = 'purged'`,
				params: filter.params,
				result: "run",
			},
		],
		write,
	);
}
export async function purgeExpiredHookUploads(): Promise<void> {
	const deadline = Date.now() + 5000;
	await dbOwnerCaptureTransition(await getDbOwner(), { action: "settle" }, { operation: "hooks.upload.settle" });
	await dbOwnerTransaction(
		[
			{
				sql: "DELETE FROM hook_transcript_receipts WHERE id IN (SELECT id FROM hook_transcript_receipts WHERE consumed_at <= datetime('now','-7 days') ORDER BY consumed_at,id LIMIT 16)",
				result: "run",
			},
		],
		write,
	);
	const rows = await dbOwnerQuery<HookUploadRow[]>(
		{
			sql: "SELECT *, 1 AS expired FROM hook_transcript_uploads WHERE storage_state <> 'consumed' AND updated_at <= datetime('now','-24 hours') ORDER BY updated_at,id LIMIT 16",
			result: "all",
			readonly: true,
		},
		read,
	);
	for (const row of rows) {
		if (Date.now() >= deadline) return;
		await purge(row, () => Date.now() < deadline);
	}
}
export type HookUploadEndState =
	| (HookUploadRow & { readonly kind: "upload" })
	| {
			readonly kind: "receipt";
			readonly id: string;
			readonly agent_id: string;
			readonly harness: string;
			readonly session_key: string;
			readonly result_json: string;
			readonly expired: number;
	  };
export async function getHookUploadForSessionEnd(principal: Principal, id: string): Promise<HookUploadEndState> {
	const row = await dbOwnerQuery<HookUploadEndState>(
		{
			sql: `SELECT CASE WHEN r.id IS NOT NULL THEN 'receipt' ELSE 'upload' END AS kind,
 COALESCE(r.id,u.id) AS id,COALESCE(r.agent_id,u.agent_id) AS agent_id,COALESCE(r.principal_id,u.principal_id) AS principal_id,
 COALESCE(r.credential_kind,u.credential_kind) AS credential_kind,COALESCE(r.credential_id,u.credential_id) AS credential_id,
 COALESCE(r.harness,u.harness) AS harness,COALESCE(r.session_key,u.session_key) AS session_key,COALESCE(r.sha256,u.sha256) AS sha256,
 COALESCE(r.result_json,u.result_json) AS result_json,u.upload_generation,u.upload_offset,u.upload_size,u.upload_digest,u.storage_state,u.content_hash,u.updated_at,
 CASE WHEN r.id IS NOT NULL THEN r.consumed_at <= datetime('now','-7 days') ELSE u.updated_at <= datetime('now','-24 hours') END AS expired
 FROM (SELECT ? AS id) target LEFT JOIN hook_transcript_receipts r ON r.id = target.id LEFT JOIN hook_transcript_uploads u ON u.id = target.id
 WHERE (r.id IS NOT NULL OR u.id IS NOT NULL) AND COALESCE(r.principal_id,u.principal_id) = ? AND COALESCE(r.credential_kind,u.credential_kind) = ? AND COALESCE(r.credential_id,u.credential_id) = ?`,
			params: [id, principalId(principal), principal.credential.kind, principal.credential.id],
			result: "get",
			readonly: true,
		},
		read,
	);
	if (!row) throw new HookUploadMissing();
	requireUploadAgent(principal, row.agent_id);
	if (row.kind === "receipt") {
		if (!row.expired) return row;
		await purgeExpiredHookUploads();
	} else if (!row.expired && row.storage_state !== "purging" && row.storage_state !== "purged") return row;
	else {
		const deadline = Date.now() + 5000;
		await purge(row, () => Date.now() < deadline);
	}
	throw new HookUploadMissing();
}
export async function getHookUpload(principal: Principal, id: string): Promise<HookUploadRow> {
	const row = await dbOwnerQuery<HookUploadRow>(
		{
			sql: "SELECT *, updated_at <= datetime('now','-24 hours') AS expired FROM hook_transcript_uploads WHERE id = ? AND principal_id = ? AND credential_kind = ? AND credential_id = ?",
			params: [id, principalId(principal), principal.credential.kind, principal.credential.id],
			result: "get",
			readonly: true,
		},
		read,
	);
	if (!row) throw new HookUploadMissing();
	requireUploadAgent(principal, row.agent_id);
	if (
		(row.expired && row.storage_state !== "consumed") ||
		row.storage_state === "purging" ||
		row.storage_state === "purged"
	) {
		const deadline = Date.now() + 5000;
		await purge(row, () => Date.now() < deadline);
		throw new HookUploadMissing();
	}
	return row;
}
export async function createHookUpload(
	principal: Principal,
	agentId: string,
	input: { sessionKey: string; harness: string; totalBytes: number; sha256: string },
): Promise<{ readonly id: string; readonly upload_offset: number }> {
	requireUploadAgent(principal, agentId);
	if (!Number.isSafeInteger(input.totalBytes) || input.totalBytes < 1 || input.totalBytes > HOOK_TRANSCRIPT_BYTES)
		throw new RangeError("Transcript exceeds upload byte limit");
	const receipt = await dbOwnerQuery<{ id: string; agent_id: string; size_bytes: number }>(
		{
			sql: "SELECT id,agent_id,size_bytes FROM hook_transcript_receipts WHERE principal_id = ? AND credential_kind = ? AND credential_id = ? AND agent_id = ? AND harness = ? AND session_key = ? AND sha256 = ? AND json_extract(result_json,'$.captureFailed') IS NOT 1 AND consumed_at > datetime('now','-7 days') ORDER BY consumed_at DESC,id LIMIT 1",
			params: [
				principalId(principal),
				principal.credential.kind,
				principal.credential.id,
				agentId,
				input.harness,
				input.sessionKey,
				input.sha256,
			],
			result: "get",
			readonly: true,
		},
		read,
	);
	if (receipt) {
		if (receipt.agent_id !== agentId || receipt.size_bytes !== input.totalBytes) throw new HookUploadMissing();
		return { id: receipt.id, upload_offset: receipt.size_bytes };
	}
	const existing = await dbOwnerQuery<HookUploadRow>(
		{
			sql: "SELECT *, updated_at <= datetime('now','-24 hours') AS expired FROM hook_transcript_uploads WHERE principal_id = ? AND harness = ? AND session_key = ? AND sha256 = ?",
			params: [principalId(principal), input.harness, input.sessionKey, input.sha256],
			result: "get",
			readonly: true,
		},
		read,
	);
	if (existing) {
		const row = await getHookUpload(principal, existing.id);
		if (row.agent_id !== agentId || (row.upload_size !== null && row.upload_size !== input.totalBytes))
			throw new HookUploadMissing();
		if (row.upload_size === null)
			await hookUploadStaging.begin({ ...hookUploadScope(row), generation: row.upload_generation }, input.totalBytes);
		return getHookUpload(principal, row.id);
	}
	const id = crypto.randomUUID();
	await dbOwnerTransaction(
		[
			{
				sql: "INSERT INTO hook_transcript_uploads (id,agent_id,principal_id,credential_kind,credential_id,harness,session_key,sha256) SELECT ?,?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM (SELECT id FROM hook_transcript_uploads WHERE principal_id = ? AND storage_state IN ('uploading','sealed','purging') LIMIT 8)) < 8 AND (SELECT COUNT(*) FROM (SELECT id FROM hook_transcript_uploads WHERE storage_state IN ('uploading','sealed','purging') LIMIT 256)) < 256 ON CONFLICT DO NOTHING",
				params: [
					id,
					agentId,
					principalId(principal),
					principal.credential.kind,
					principal.credential.id,
					input.harness,
					input.sessionKey,
					input.sha256,
					principalId(principal),
				],
				result: "run",
			},
		],
		write,
	);
	const inserted = await dbOwnerQuery<{ id: string }>(
		{
			sql: "SELECT id FROM hook_transcript_uploads WHERE principal_id = ? AND harness = ? AND session_key = ? AND sha256 = ?",
			params: [principalId(principal), input.harness, input.sessionKey, input.sha256],
			result: "get",
			readonly: true,
		},
		read,
	);
	if (!inserted) throw new HookUploadBusy();
	const row = await getHookUpload(principal, inserted.id);
	if (row.agent_id !== agentId) throw new HookUploadMissing();
	try {
		await hookUploadStaging.begin({ ...hookUploadScope(row), generation: row.upload_generation }, input.totalBytes);
	} catch (error) {
		if (row.id === id) {
			const filter = stagedScopeFilter(hookUploadScope(row), "");
			await dbOwnerTransaction(
				[
					{
						sql: `DELETE FROM hook_transcript_uploads WHERE ${filter.sql} AND upload_size IS NULL AND upload_offset = 0 AND reserved_bytes = 0 AND storage_state = 'uploading'`,
						params: filter.params,
						result: "run",
					},
				],
				write,
			);
		}
		throw error;
	}
	return getHookUpload(principal, row.id);
}

export function hookUploadResult(row: { readonly result_json: unknown }): SessionEndResponse | null {
	if (row.result_json === null) return null;
	if (typeof row.result_json !== "string") throw new Error("Invalid upload receipt");
	const result: unknown = JSON.parse(row.result_json);
	if (
		typeof result !== "object" ||
		result === null ||
		!("memoriesSaved" in result) ||
		result.memoriesSaved !== 0 ||
		!("queued" in result) ||
		typeof result.queued !== "boolean"
	)
		throw new Error("Invalid upload receipt");
	if ("reason" in result && result.reason === "upload_checksum_mismatch") throw new HookUploadChecksumMismatch();
	if (!result.queued)
		return {
			memoriesSaved: 0,
			queued: false,
			...("captureFailed" in result && result.captureFailed === true ? { captureFailed: true } : {}),
		};
	if (!("transcriptCaptureJobId" in result) || typeof result.transcriptCaptureJobId !== "string")
		throw new Error("Invalid upload receipt");
	return { memoriesSaved: 0, queued: true, transcriptCaptureJobId: result.transcriptCaptureJobId };
}
export async function readHookUploadTranscript(
	agentId: string,
	jobId: string,
	uploadId: string,
): Promise<{ raw: string; sha256: string; sizeBytes: number }> {
	const row = await dbOwnerQuery<HookUploadRow>(
		{
			sql: "SELECT * FROM hook_transcript_uploads WHERE id = ? AND agent_id = ? AND storage_state = 'consumed' AND json_extract(result_json,'$.transcriptCaptureJobId') = ?",
			params: [uploadId, agentId, jobId],
			result: "get",
			readonly: true,
		},
		read,
	);
	if (!row || row.upload_size === null || row.upload_size > HOOK_TRANSCRIPT_BYTES) throw new HookUploadMissing();
	const scope = { ...hookUploadScope(row), generation: row.upload_generation, signal: AbortSignal.timeout(60_000) };
	const parts: Buffer[] = [];
	const hash = createHash("sha256");
	for (let offset = 0; offset < row.upload_size; ) {
		const bytes = await hookUploadStaging.read(scope, offset, Math.min(65536, row.upload_size - offset));
		parts.push(bytes);
		hash.update(bytes);
		offset += bytes.length;
	}
	const sha256 = hash.digest("hex");
	if (sha256 !== row.sha256) throw new Error("Transcript upload checksum mismatch");
	return { raw: Buffer.concat(parts).toString("utf8"), sha256, sizeBytes: row.upload_size };
}
