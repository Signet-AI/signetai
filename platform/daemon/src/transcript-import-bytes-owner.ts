import { createHash } from "node:crypto";
import { type WriteDb, prepareTypedStatement } from "./db-accessor";

export function redactSessionTranscriptUploadBatchInTx(db: WriteDb, agentId: string, sessionKey: string): number {
	const record = prepareTypedStatement<{
		id: string;
		file_id: string;
		job_id: string;
		byte_offset: number;
		byte_length: number;
		redacted_bytes: number;
		status: string;
	}>(
		db,
		"SELECT id,file_id,job_id,byte_offset,byte_length,redacted_bytes,status FROM source_import_records WHERE agent_id = ? AND canonical_key = ? AND redacted_bytes < byte_length LIMIT 1",
	).get(agentId, sessionKey);
	if (!record) return 0;
	const position = record.byte_offset + record.redacted_bytes;
	const chunk = prepareTypedStatement<{ content: Uint8Array; generation: number; byte_offset: number }>(
		db,
		"SELECT content,generation,byte_offset FROM source_import_chunks WHERE agent_id = ? AND file_id = ? AND byte_offset <= ? AND byte_offset + length(content) > ? ORDER BY generation DESC LIMIT 1",
	).get(agentId, record.file_id, position, position);
	if (!chunk) {
		const file = db
			.prepare("SELECT storage_state FROM source_import_files WHERE agent_id = ? AND id = ?")
			.get(agentId, record.file_id);
		if (file?.storage_state !== "purged") throw new Error("Transcript upload cleanup requires retained chunk bytes");
		db.prepare("UPDATE source_import_records SET redacted_bytes = byte_length WHERE agent_id = ? AND id = ?").run(
			agentId,
			record.id,
		);
		return -1;
	}
	const content = new Uint8Array(chunk.content);
	const start = position - chunk.byte_offset;
	const end = Math.min(content.length, record.byte_offset + record.byte_length - chunk.byte_offset);
	for (let index = start; index < end; index++) if (content[index] !== 10 && content[index] !== 13) content[index] = 32;
	db.prepare(
		"UPDATE source_import_chunks SET content = ?, checksum = ? WHERE agent_id = ? AND file_id = ? AND generation = ? AND byte_offset = ?",
	).run(content, checksum(content), agentId, record.file_id, chunk.generation, chunk.byte_offset);
	const complete = record.redacted_bytes + end - start >= record.byte_length;
	db.prepare(
		"UPDATE source_import_records SET redacted_bytes = redacted_bytes + ?, status = CASE WHEN ? THEN 'rejected' ELSE status END, rejection_code = CASE WHEN ? THEN 'session_transcript_deleted' ELSE rejection_code END WHERE agent_id = ? AND id = ?",
	).run(end - start, complete, complete, agentId, record.id);
	db.prepare(
		"UPDATE source_import_files SET content_hash = NULL, upload_digest = 'redacted' WHERE agent_id = ? AND id = ?",
	).run(agentId, record.file_id);
	if (complete && record.status !== "rejected")
		db.prepare(
			"UPDATE source_import_jobs SET imported = MAX(0,imported - ?), duplicate = MAX(0,duplicate - ?), pending = MAX(0,pending - ?), rejected = rejected + 1 WHERE agent_id = ? AND id = ?",
		).run(
			Number(record.status === "imported"),
			Number(record.status === "duplicate"),
			Number(record.status === "pending"),
			agentId,
			record.job_id,
		);
	return end - start;
}

function checksum(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}
