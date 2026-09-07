import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { dbOwnerQuery, dbOwnerTransaction } from "./db-owner-runtime";
import {
	appendTranscriptChunk,
	readTranscriptBytes,
	sealTranscriptUpload,
	TRANSCRIPT_UPLOAD_BYTES,
} from "./transcript-import-bytes";
import {
	openContainedTranscriptFile,
	removeContainedTranscriptPath,
	iterateContainedTranscriptDirectory,
} from "./transcript-import-safe-fs";
import { resolveManagedTranscriptPath } from "./transcript-import-safe-fs";
import { buildCompletedTranscriptCommit, canonicalTranscriptLine } from "./transcript-import-commit";
import { signetExportV1Adapter } from "./transcript-import-adapter";

/** Finite translation of the old evidence store. Normal imports never read legacy paths. */
export async function migrateTranscriptImportFile(
	root: string,
	agentId: string,
	fileId: string,
	active: () => boolean = () => true,
): Promise<void> {
	const options = { operation: "sources.import.migrate", lane: "write" } as const;
	const file = await dbOwnerQuery<{
		job_id: string;
		managed_path: string;
		storage_state: string;
		upload_generation: number;
		upload_offset: number;
		state: string;
		size_bytes: number;
		content_hash: string | null;
	}>(
		{
			sql: "SELECT job_id,managed_path,storage_state,upload_generation,upload_offset,state,size_bytes,content_hash FROM source_import_files WHERE id = ? AND agent_id = ?",
			params: [fileId, agentId],
			result: "get",
			readonly: true,
		},
		options,
	);
	if (!file?.managed_path) return;
	if (process.platform !== "linux" && process.platform !== "darwin")
		throw new Error(
			"Legacy filesystem evidence must be migrated on Linux or macOS before moving this workspace to Windows",
		);
	const path = resolveManagedTranscriptPath(root, file.managed_path);
	const scope = { agentId, jobId: file.job_id, fileId, generation: file.upload_generation };
	if (file.storage_state === "legacy") {
		if (file.state === "staging" && file.size_bytes === 0 && file.content_hash === null) {
			await dbOwnerTransaction(
				[
					{
						sql: "UPDATE source_import_files SET storage_state = 'uploading', managed_path = '' WHERE id = ? AND agent_id = ? AND storage_state = 'legacy'",
						params: [fileId, agentId],
						result: "run",
						requireChanges: true,
					},
					{
						sql: "UPDATE source_import_jobs SET cleanup_state = 'pending' WHERE id = ? AND agent_id = ? AND state = 'cancelled'",
						params: [file.job_id, agentId],
						result: "run",
					},
				],
				options,
			);
			return;
		}
		const handle = await openContainedTranscriptFile(root, path, constants.O_RDONLY);
		try {
			const info = await handle.stat();
			if (!info.isFile() || info.size !== file.size_bytes) throw new Error("legacy source size mismatch");
			await dbOwnerTransaction(
				[
					{
						sql: "UPDATE source_import_files SET upload_size = size_bytes WHERE id = ? AND agent_id = ? AND storage_state = 'legacy'",
						params: [fileId, agentId],
						result: "run",
						requireChanges: true,
					},
				],
				options,
			);
			for (let offset = file.upload_offset; offset < info.size; ) {
				if (!active()) return;
				const bytes = Buffer.alloc(Math.min(TRANSCRIPT_UPLOAD_BYTES, info.size - offset));
				let filled = 0;
				while (filled < bytes.length) {
					const read = await handle.read(bytes, filled, bytes.length - filled, offset + filled);
					if (!read.bytesRead) throw new Error("legacy source truncated");
					filled += read.bytesRead;
				}
				await appendTranscriptChunk(scope, offset, bytes, createHash("sha256").update(bytes).digest("hex"));
				offset += bytes.length;
			}
			if (!active()) return;
			await sealTranscriptUpload(scope, active);
		} finally {
			await handle.close();
		}
	}
	// After sealing, a missing old file means an earlier cleanup already removed it.
	try {
		await removeContainedTranscriptPath(root, path, { force: true });
	} catch (error) {
		if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
	}
	await dbOwnerTransaction(
		[
			{
				sql: "UPDATE source_import_files SET original_path = managed_path, managed_path = '' WHERE id = ? AND agent_id = ? AND storage_state = 'sealed'",
				params: [fileId, agentId],
				result: "run",
				requireChanges: true,
			},
		],
		options,
	);
}

async function retainedCommit(agentId: string, recordId: string) {
	const record = await dbOwnerQuery<{
		file_id: string;
		job_id: string;
		source_id: string;
		byte_offset: number;
		byte_length: number;
		upload_generation: number;
		original_path: string;
	}>(
		{
			sql: "SELECT r.file_id,r.job_id,r.source_id,r.byte_offset,r.byte_length,f.upload_generation,f.original_path FROM source_import_records r JOIN source_import_files f ON f.id = r.file_id AND f.agent_id = r.agent_id WHERE r.id = ? AND r.agent_id = ? AND f.storage_state = 'sealed'",
			params: [recordId, agentId],
			result: "get",
			readonly: true,
		},
		{ operation: "sources.import.migrate.verify", lane: "read" },
	);
	if (!record || record.byte_length > 16 * 1024 ** 2 + 1)
		throw new Error("legacy canonical evidence has no retained source record");
	const scope = { agentId, fileId: record.file_id, jobId: record.job_id, generation: record.upload_generation };
	const parts: Buffer[] = [];
	for (let offset = record.byte_offset; offset < record.byte_offset + record.byte_length; ) {
		const bytes = await readTranscriptBytes(
			scope,
			offset,
			Math.min(64 * 1024, record.byte_offset + record.byte_length - offset),
		);
		if (!bytes.length) throw new Error("legacy source record truncated");
		parts.push(bytes);
		offset += bytes.length;
	}
	const raw = signetExportV1Adapter.parse(
		JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts))),
	);
	return buildCompletedTranscriptCommit(raw, {
		agentId,
		sourceId: record.source_id,
		sourceRecordId: recordId,
		sourcePath: record.original_path,
	});
}

async function verifyCanonicalLine(line: string, agentId: string): Promise<boolean> {
	const value: unknown = JSON.parse(line);
	if (!value || typeof value !== "object" || !("agent_id" in value) || value.agent_id !== agentId)
		throw new Error("legacy canonical agent scope mismatch");
	if (!("source_record_id" in value) || typeof value.source_record_id !== "string")
		throw new Error("unattributed legacy canonical evidence");
	const expected = canonicalTranscriptLine(await retainedCommit(agentId, value.source_record_id));
	if (JSON.stringify(value) !== JSON.stringify(JSON.parse(expected)))
		throw new Error("legacy canonical evidence differs from its retained source");
	return true;
}

async function retireCanonicalFiles(root: string, agentId: string, active: () => boolean): Promise<void> {
	try {
		for await (const name of iterateContainedTranscriptDirectory(root, join(root, "transcripts"))) {
			if (!active()) return;
			if (!/^[a-f0-9]{24}\.jsonl(?:\.append-[a-f0-9-]+)?$/.test(name)) continue;
			const scoped = await dbOwnerQuery(
				{
					sql: "SELECT 1 FROM source_import_migration_streams WHERE agent_id = ? AND stem = ?",
					params: [agentId, name.slice(0, 24)],
					result: "get",
					readonly: true,
				},
				{ operation: "sources.import.migrate.stream", lane: "read" },
			);
			if (!scoped) continue;
			const path = join(root, "transcripts", name);
			const handle = await openContainedTranscriptFile(root, path, constants.O_RDONLY);
			let owned = false;
			let foreign = false;
			try {
				let buffer = Buffer.alloc(0);
				for (;;) {
					if (!active()) return;
					const bytes = Buffer.alloc(64 * 1024);
					const result = await handle.read(bytes, 0, bytes.length, null);
					buffer = Buffer.concat([buffer, bytes.subarray(0, result.bytesRead)]);
					if (buffer.length > 16 * 1024 ** 2) throw new Error("oversized legacy canonical record");
					let newline = buffer.indexOf(10);
					while (newline >= 0) {
						const line = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, newline));
						if (line) {
							if (await verifyCanonicalLine(line, agentId)) owned = true;
							else foreign = true;
						}
						buffer = buffer.subarray(newline + 1);
						newline = buffer.indexOf(10);
					}
					if (!result.bytesRead) {
						if (buffer.length) throw new Error("incomplete legacy canonical record");
						break;
					}
				}
			} finally {
				await handle.close();
			}
			if (owned && foreign) throw new Error("legacy canonical file mixes agent scopes");
			if (owned) await removeContainedTranscriptPath(root, path, { force: true });
		}
	} catch (error) {
		if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
	}
}

export async function migrateTranscriptImports(root: string, agentId: string, active: () => boolean): Promise<void> {
	const options = { operation: "sources.import.migrate", lane: "read" } as const;
	const pending = await dbOwnerQuery(
		{
			sql: "SELECT 1 FROM source_import_migrations WHERE agent_id = ? AND state != 'complete'",
			params: [agentId],
			result: "get",
			readonly: true,
		},
		options,
	);
	if (!pending) return;
	let cursor = "";
	while (active()) {
		const file = await dbOwnerQuery<{ id: string }>(
			{
				sql: "SELECT id FROM source_import_files WHERE agent_id = ? AND id > ? AND managed_path != '' ORDER BY id LIMIT 1",
				params: [agentId, cursor],
				result: "get",
				readonly: true,
			},
			options,
		);
		if (!file) break;
		await migrateTranscriptImportFile(root, agentId, file.id, active);
		cursor = file.id;
	}
	const progress = await dbOwnerQuery<{ cursor: string }>(
		{
			sql: "SELECT cursor FROM source_import_migrations WHERE agent_id = ?",
			params: [agentId],
			result: "get",
			readonly: true,
		},
		options,
	);
	cursor = progress?.cursor ?? "";
	while (active()) {
		const row = await dbOwnerQuery<{
			id: string;
			status: string;
			job_id: string;
			file_id: string;
			ordinal: number;
			line_number: number;
		}>(
			{
				sql: "SELECT id,status,job_id,file_id,ordinal,line_number FROM source_import_records WHERE agent_id = ? AND id > ? ORDER BY id LIMIT 1",
				params: [agentId, cursor],
				result: "get",
				readonly: true,
			},
			options,
		);
		if (!row) break;
		const statements = [
			{
				sql: "INSERT INTO source_import_migration_counts (agent_id,job_id,total,imported,duplicate,rejected,pending) VALUES (?,?,1,?,?,?,?) ON CONFLICT(agent_id,job_id) DO UPDATE SET total = total + 1, imported = imported + excluded.imported, duplicate = duplicate + excluded.duplicate, rejected = rejected + excluded.rejected, pending = pending + excluded.pending",
				params: [
					agentId,
					row.job_id,
					row.status === "imported" ? 1 : 0,
					row.status === "duplicate" ? 1 : 0,
					row.status === "rejected" ? 1 : 0,
					row.status === "pending" ? 1 : 0,
				],
				result: "run" as const,
			},
			{
				sql: "UPDATE source_import_files SET checkpoint_line_number = MAX(checkpoint_line_number,?) WHERE id = ? AND agent_id = ? AND checkpoint_ordinal >= ?",
				params: [row.line_number, row.file_id, agentId, row.ordinal],
				result: "run" as const,
			},
		];
		if (row.status !== "rejected" && row.status !== "cancelled") {
			const commit = await retainedCommit(agentId, row.id);
			const stem = createHash("sha256").update(`${agentId}\0${commit.harness}`).digest("hex").slice(0, 24);
			statements.push({
				sql: "INSERT OR IGNORE INTO source_import_migration_streams (agent_id,stem) VALUES (?,?)",
				params: [agentId, stem],
				result: "run" as const,
			});
		}
		statements.push({
			sql: "UPDATE source_import_migrations SET cursor = ? WHERE agent_id = ?",
			params: [row.id, agentId],
			result: "run" as const,
		});
		await dbOwnerTransaction(statements, { operation: "sources.import.migrate.streams", lane: "write" });
		cursor = row.id;
	}
	while (active()) {
		const counts = await dbOwnerQuery<{ job_id: string }>(
			{
				sql: "SELECT job_id FROM source_import_migration_counts WHERE agent_id = ? ORDER BY job_id LIMIT 1",
				params: [agentId],
				result: "get",
				readonly: true,
			},
			options,
		);
		if (!counts) break;
		await dbOwnerTransaction(
			[
				{
					sql: "UPDATE source_import_jobs SET (total,imported,duplicate,rejected,pending) = (SELECT total,imported,duplicate,rejected,pending FROM source_import_migration_counts WHERE agent_id = ? AND job_id = ?) WHERE agent_id = ? AND id = ?",
					params: [agentId, counts.job_id, agentId, counts.job_id],
					result: "run",
				},
				{
					sql: "DELETE FROM source_import_migration_counts WHERE agent_id = ? AND job_id = ?",
					params: [agentId, counts.job_id],
					result: "run",
				},
			],
			{ operation: "sources.import.migrate.counts", lane: "write" },
		);
	}
	await retireCanonicalFiles(root, agentId, active);
	if (active())
		await dbOwnerTransaction(
			[
				{
					sql: "UPDATE source_import_migrations SET state = 'complete' WHERE agent_id = ?",
					params: [agentId],
					result: "run",
				},
			],
			{ operation: "sources.import.migrate.complete", lane: "write" },
		);
}
