import type { Principal } from "./auth/principal";
import { principalAccess, resolveWriteAgent } from "./auth/agent-access";
import { dbOwnerQuery, dbOwnerTransaction } from "./db-owner-runtime";
import {
	createStagingOwner,
	stagedScopeFilter,
	stagedChunkStatements,
	readStagedChunks,
	purgeStagedChunkBatch,
	TRANSCRIPT_FILE_BYTES,
	type TranscriptUpload,
	type StagedChunk,
	type StoredStagedChunk,
	type StagedChunkScope,
} from "./staged-upload-owner";

export const HOOK_TRANSCRIPT_BYTES = TRANSCRIPT_FILE_BYTES;
export class HookUploadMissing extends Error {}
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
	await dbOwnerTransaction(
		[
			{
				sql: `UPDATE hook_transcript_uploads SET storage_state = 'sealed', content_hash = ?, size_bytes = upload_size WHERE ${filter.sql} AND upload_generation = ? AND upload_offset = upload_size AND storage_state = 'uploading' AND sha256 = ? AND updated_at > datetime('now','-24 hours')`,
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
export const hookUploadStaging = createStagingOwner<HookUploadScope, WriteScope>({
	get: metadata,
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
	const rows = await dbOwnerQuery<HookUploadRow[]>(
		{
			sql: "SELECT *, 1 AS expired FROM hook_transcript_uploads WHERE updated_at <= datetime('now','-24 hours') ORDER BY updated_at,id LIMIT 16",
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
	if (row.expired || row.storage_state === "purging" || row.storage_state === "purged") {
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
): Promise<HookUploadRow> {
	requireUploadAgent(principal, agentId);
	if (!Number.isSafeInteger(input.totalBytes) || input.totalBytes < 1 || input.totalBytes > HOOK_TRANSCRIPT_BYTES)
		throw new RangeError("Transcript exceeds upload byte limit");
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
				sql: "INSERT INTO hook_transcript_uploads (id,agent_id,principal_id,credential_kind,credential_id,harness,session_key,sha256) SELECT ?,?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM (SELECT id FROM hook_transcript_uploads WHERE principal_id = ? AND storage_state IN ('uploading','sealed','purging') LIMIT 32)) < 32 AND (SELECT COUNT(*) FROM (SELECT id FROM hook_transcript_uploads WHERE storage_state IN ('uploading','sealed','purging') LIMIT 256)) < 256 ON CONFLICT DO NOTHING",
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
