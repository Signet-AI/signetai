import { createHash } from "node:crypto";
import type { WriteDb } from "./db-accessor";
import {
	TRANSCRIPT_IMPORT_LIMITS,
	canonicalTranscriptIdentity,
	externalIdentityFingerprint,
	type SignetExportRecord,
} from "./transcript-import-adapter";

export interface CompletedTranscriptEvidence {
	readonly recordId: string;
	readonly sourceId: string;
	readonly sourceRecordId: string;
	readonly agentId: string;
	readonly harness: string;
	readonly project: string | null;
	readonly sessionKey: string;
	readonly capturedAt: string;
	readonly messages: readonly {
		readonly role: "user" | "assistant" | "system" | "tool" | "unknown";
		readonly content: string;
	}[];
	readonly contentHash: string;
	readonly sourceMetaJson: string | null;
	/** Managed relative path of the staged import file, when imported. */
	readonly sourcePath: string | null;
}

export interface CompletedTranscriptCommit extends CompletedTranscriptEvidence {
	readonly externalIdentity: string;
	readonly canonicalId: string;
	readonly canonicalKey: string;
}

export type TranscriptCommitOutcome = "imported" | "duplicate" | "conversation_identity_conflict";
export interface TranscriptCommitResult {
	readonly outcome: TranscriptCommitOutcome;
	readonly canonicalId: string;
	readonly sessionKey: string;
}

/** Evidence and its ledger outcome share the caller's owner transaction. */
export function commitTranscriptImportBatchInTx(
	db: WriteDb,
	input: import("./db-owner-protocol").DbOwnerTranscriptBulkCommit,
): TranscriptCommitResult[] {
	if (
		input.commits.length > TRANSCRIPT_IMPORT_LIMITS.maxRecordsPerBatch ||
		(input.commits.length === 0 && !input.inventory) ||
		(input.inventory?.records.length ?? 0) > TRANSCRIPT_IMPORT_LIMITS.maxRecordsPerBatch
	)
		throw new RangeError("invalid transcript commit batch");
	if (transcriptCommitBatchBytes(input.commits) > TRANSCRIPT_IMPORT_LIMITS.maxCanonicalBatchBytes)
		throw new RangeError("canonical_batch_too_large");
	if (
		!input.agentId ||
		!input.sourceId ||
		input.commits.some((item) => item.agentId !== input.agentId || item.sourceId !== input.sourceId)
	)
		throw new Error("transcript commit provenance does not match owner request");
	const lease = db
		.prepare(
			"SELECT 1 FROM source_import_jobs WHERE id = ? AND agent_id = ? AND generation = ? AND lease_token = ? AND state IN ('running','inventorying') AND control_request IS NULL",
		)
		.get(input.jobId, input.agentId, input.generation, input.leaseToken);
	if (lease == null) throw new Error("stale import lease");
	const inventory = input.inventory;
	if (inventory) {
		const file = db
			.prepare(
				"SELECT 1 FROM source_import_files WHERE id = ? AND job_id = ? AND agent_id = ? AND source_id = ? AND storage_state = 'sealed' AND checkpoint_byte_offset = ?",
			)
			.get(inventory.fileId, input.jobId, input.agentId, input.sourceId, inventory.previousByteOffset);
		if (!file || inventory.checkpoint.byteOffset < inventory.previousByteOffset)
			throw new Error("stale inventory checkpoint");
		for (const row of inventory.records) {
			if (
				row.byteOffset < inventory.previousByteOffset ||
				row.byteOffset + row.byteLength > inventory.checkpoint.byteOffset
			)
				throw new Error("invalid inventory record range");
			db.prepare(
				"INSERT INTO source_import_records (id,job_id,file_id,source_id,agent_id,ordinal,line_number,byte_offset,byte_length,raw_hash,status,rejection_code) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
			).run(
				`${input.jobId}:${inventory.fileId}:${row.ordinal}`,
				input.jobId,
				inventory.fileId,
				input.sourceId,
				input.agentId,
				row.ordinal,
				row.lineNumber,
				row.byteOffset,
				row.byteLength,
				row.rawHash,
				row.status,
				row.rejectionCode ?? null,
			);
			if (row.status === "rejected")
				db.prepare(
					"INSERT INTO source_import_record_attempts (agent_id,job_id,file_id,record_id,generation,outcome,error_code,source_id) VALUES (?,?,?,?,?,'rejected',?,?)",
				).run(
					input.agentId,
					input.jobId,
					inventory.fileId,
					`${input.jobId}:${inventory.fileId}:${row.ordinal}`,
					input.generation,
					row.rejectionCode ?? null,
					input.sourceId,
				);
		}
		const pending = inventory.records.filter((row) => row.status === "pending").length;
		db.prepare(
			"UPDATE source_import_jobs SET total = total + ?, pending = pending + ?, rejected = rejected + ? WHERE id = ? AND agent_id = ?",
		).run(inventory.records.length, pending, inventory.records.length - pending, input.jobId, input.agentId);
	}
	const results: TranscriptCommitResult[] = [];
	for (const item of input.commits) {
		const row = db
			.prepare(
				"SELECT status, canonical_id, canonical_key FROM source_import_records WHERE id = ? AND job_id = ? AND agent_id = ? AND source_id = ?",
			)
			.get(item.sourceRecordId, input.jobId, input.agentId, input.sourceId) as
			| { status: string; canonical_id: string; canonical_key: string }
			| undefined;
		if (!row) throw new Error("import record scope denied");
		if (row.status === "imported" || row.status === "duplicate") {
			results.push({ outcome: row.status, canonicalId: row.canonical_id, sessionKey: row.canonical_key });
			continue;
		}
		if (row.status !== "pending") throw new Error("import record is not pending");
		const result = commitCompletedTranscriptBatchInTx(db, [item])[0];
		if (!result) throw new Error("missing transcript commit outcome");
		const rejected = result.outcome === "conversation_identity_conflict";
		db.prepare(
			"UPDATE source_import_records SET status = ?, canonical_id = ?, canonical_key = ?, external_identity = ?, conversation_fingerprint = ?, rejection_code = ?, attempt_count = attempt_count + 1, updated_at = datetime('now') WHERE id = ? AND job_id = ? AND agent_id = ?",
		).run(
			rejected ? "rejected" : result.outcome,
			result.canonicalId,
			result.sessionKey,
			item.externalIdentity,
			item.contentHash,
			rejected ? result.outcome : null,
			item.sourceRecordId,
			input.jobId,
			input.agentId,
		);
		db.prepare(
			"INSERT INTO source_import_record_attempts (agent_id,job_id,file_id,record_id,generation,outcome,error_code,source_id) SELECT agent_id,job_id,file_id,id,?,?,?,source_id FROM source_import_records WHERE id = ? AND job_id = ? AND agent_id = ?",
		).run(
			input.generation,
			result.outcome,
			rejected ? result.outcome : null,
			item.sourceRecordId,
			input.jobId,
			input.agentId,
		);
		db.prepare(
			"UPDATE source_import_jobs SET pending = MAX(0,pending - 1), imported = imported + ?, duplicate = duplicate + ?, rejected = rejected + ? WHERE id = ? AND agent_id = ?",
		).run(
			result.outcome === "imported" ? 1 : 0,
			result.outcome === "duplicate" ? 1 : 0,
			rejected ? 1 : 0,
			input.jobId,
			input.agentId,
		);
		results.push(result);
	}
	if (inventory) {
		db.prepare(
			"UPDATE source_import_files SET checkpoint_byte_offset = ?, checkpoint_ordinal = ?, checkpoint_line_number = ?, record_count = record_count + ?, malformed_count = malformed_count + ?, state = ?, reserved_bytes = CASE WHEN ? THEN 0 ELSE reserved_bytes END, updated_at = datetime('now') WHERE id = ? AND job_id = ? AND agent_id = ?",
		).run(
			inventory.checkpoint.byteOffset,
			inventory.checkpoint.ordinal,
			inventory.checkpoint.lineNumber,
			inventory.records.length,
			inventory.records.filter((row) => row.status === "rejected").length,
			inventory.complete ? "completed" : "inventorying",
			inventory.complete ? 1 : 0,
			inventory.fileId,
			input.jobId,
			input.agentId,
		);
	}
	return results;
}

const fixed = (fields: readonly string[]) => fields.map((field) => `${field.length}:${field}`).join("|");

export function buildCompletedTranscriptCommit(
	record: SignetExportRecord,
	input: {
		readonly agentId: string;
		readonly sourceId: string;
		readonly sourceRecordId: string;
		readonly sourceMetaJson?: string | null;
		readonly sourcePath?: string | null;
	},
): CompletedTranscriptCommit {
	const identity = canonicalTranscriptIdentity(record);
	const externalIdentity = externalIdentityFingerprint(record);
	const recordId = createHash("sha256")
		.update(fixed([input.agentId, input.sourceId, input.sourceRecordId, record.harness, identity.contentHash]))
		.digest("hex");
	return {
		recordId,
		sourceId: input.sourceId,
		sourceRecordId: input.sourceRecordId,
		agentId: input.agentId,
		harness: record.harness,
		project: record.project,
		sessionKey: identity.canonicalKey,
		capturedAt: record.timestamp,
		messages: record.messages,
		contentHash: identity.contentHash,
		sourceMetaJson: input.sourceMetaJson ?? null,
		sourcePath: input.sourcePath ?? null,
		externalIdentity,
		canonicalId: identity.canonicalId,
		canonicalKey: identity.canonicalKey,
	};
}

/** Lossless storage representation. It deliberately does not normalize whitespace or prefix roles. */
export function serializeCompletedTranscriptMessages(messages: CompletedTranscriptEvidence["messages"]): string {
	return JSON.stringify(messages);
}

export function canonicalTranscriptLine(commit: CompletedTranscriptCommit): string {
	return `${JSON.stringify({
		id: commit.recordId,
		session_id: commit.canonicalId,
		session_key: commit.canonicalKey,
		agent_id: commit.agentId,
		harness: commit.harness,
		project: commit.project,
		captured_at: commit.capturedAt,
		source_id: commit.sourceId,
		source_record_id: commit.sourceRecordId,
		content_hash: commit.contentHash,
		source_path: commit.sourcePath,
		source_meta_json:
			commit.sourceMetaJson ?? (commit.sourcePath === null ? null : JSON.stringify({ managedPath: commit.sourcePath })),
		messages: commit.messages,
	})}\n`;
}

/** Bound the payload crossing the owner protocol. */
export function transcriptCommitBatchBytes(commits: readonly CompletedTranscriptCommit[]): number {
	return Buffer.byteLength(JSON.stringify(commits), "utf8");
}
/** Insert the durable transcript exactly once when recovering a committing claim. */
function insertSessionTranscriptIfMissing(db: WriteDb, commit: CompletedTranscriptCommit): void {
	const existing = db
		.prepare("SELECT 1 FROM session_transcripts WHERE session_key = ? AND agent_id = ? LIMIT 1")
		.get(commit.canonicalKey, commit.agentId);
	if (existing) return;
	const content = serializeCompletedTranscriptMessages(commit.messages);
	const columns = db.prepare("PRAGMA table_info(session_transcripts)").all() as Array<{ name: string }>;
	const names = new Set(columns.map((column) => column.name));
	const insertColumns = ["session_key", "content", "harness", "project", "agent_id", "created_at"];
	const values: unknown[] = [
		commit.canonicalKey,
		content,
		commit.harness,
		commit.project,
		commit.agentId,
		commit.capturedAt,
	];
	if (names.has("updated_at")) {
		insertColumns.push("updated_at");
		values.push(commit.capturedAt);
	}
	if (names.has("completed_at")) {
		insertColumns.push("completed_at");
		values.push(commit.capturedAt);
	}
	if (names.has("content_hash")) {
		insertColumns.push("content_hash");
		values.push(commit.contentHash);
	}
	if (names.has("source_id")) {
		insertColumns.push("source_id");
		values.push(commit.sourceId);
	}
	if (names.has("source_record_id")) {
		insertColumns.push("source_record_id");
		values.push(commit.sourceRecordId);
	}
	if (names.has("source_meta_json")) {
		insertColumns.push("source_meta_json");
		values.push(commit.sourceMetaJson);
	}
	db.prepare(
		`INSERT INTO session_transcripts (${insertColumns.join(",")}) VALUES (${insertColumns.map(() => "?").join(",")})`,
	).run(...values);
}

function updateSessionTranscriptOwnership(db: WriteDb, commit: CompletedTranscriptCommit): void {
	const columns = db.prepare("PRAGMA table_info(session_transcripts)").all() as Array<{ name: string }>;
	const names = new Set(columns.map((column) => column.name));
	const updates: string[] = [];
	const values: unknown[] = [];
	const add = (name: string, value: unknown): void => {
		if (!names.has(name)) return;
		updates.push(`${name} = ?`);
		values.push(value);
	};
	add("content", serializeCompletedTranscriptMessages(commit.messages));
	add("harness", commit.harness);
	add("project", commit.project);
	add("updated_at", commit.capturedAt);
	add("completed_at", commit.capturedAt);
	add("content_hash", commit.contentHash);
	add("source_id", commit.sourceId);
	add("source_record_id", commit.sourceRecordId);
	add("source_meta_json", commit.sourceMetaJson);
	if (!updates.length) return;
	values.push(commit.canonicalKey, commit.agentId);
	db.prepare(`UPDATE session_transcripts SET ${updates.join(", ")} WHERE session_key = ? AND agent_id = ?`).run(
		...values,
	);
}
/** Owner-side atomic DB prepare/finalize operation. Filesystem finalization is separate and replay-safe by recordId. */
export function commitCompletedTranscriptBatchInTx(
	db: WriteDb,
	commits: readonly CompletedTranscriptCommit[],
): TranscriptCommitResult[] {
	if (commits.length === 0 || commits.length > TRANSCRIPT_IMPORT_LIMITS.maxRecordsPerBatch)
		throw new RangeError("invalid transcript commit batch");
	if (transcriptCommitBatchBytes(commits) > TRANSCRIPT_IMPORT_LIMITS.maxCanonicalBatchBytes)
		throw new RangeError("canonical_batch_too_large");
	const results: TranscriptCommitResult[] = [];
	for (const commit of commits) {
		const existing = db
			.prepare(
				"SELECT conversation_fingerprint, canonical_id, canonical_key, state FROM transcript_import_conversations WHERE agent_id = ? AND external_identity = ?",
			)
			.get(commit.agentId, commit.externalIdentity) as
			| { conversation_fingerprint: string; canonical_id: string; canonical_key: string; state: string }
			| undefined;
		if (existing) {
			if (existing.conversation_fingerprint !== commit.contentHash) {
				results.push({
					outcome: "conversation_identity_conflict",
					canonicalId: existing.canonical_id,
					sessionKey: existing.canonical_key,
				});
				continue;
			}
			if (existing.state === "committing") {
				insertSessionTranscriptIfMissing(db, commit);
				db.prepare(
					"UPDATE transcript_import_conversations SET owner_source_id = ?, owner_record_id = ?, state = 'committed', content_hash = ?, harness = ?, timestamp = ?, updated_at = datetime('now') WHERE agent_id = ? AND external_identity = ? AND state = 'committing'",
				).run(
					commit.sourceId,
					commit.sourceRecordId,
					commit.contentHash,
					commit.harness,
					commit.capturedAt,
					commit.agentId,
					commit.externalIdentity,
				);
				updateSessionTranscriptOwnership(db, commit);
				results.push({ outcome: "imported", canonicalId: existing.canonical_id, sessionKey: existing.canonical_key });
			} else if (existing.state === "removed") {
				insertSessionTranscriptIfMissing(db, commit);
				updateSessionTranscriptOwnership(db, commit);
				db.prepare(
					"UPDATE transcript_import_conversations SET owner_source_id = ?, owner_record_id = ?, state = 'committed', content_hash = ?, harness = ?, timestamp = ?, updated_at = datetime('now') WHERE agent_id = ? AND external_identity = ? AND state = 'removed'",
				).run(
					commit.sourceId,
					commit.sourceRecordId,
					commit.contentHash,
					commit.harness,
					commit.capturedAt,
					commit.agentId,
					commit.externalIdentity,
				);
				results.push({ outcome: "imported", canonicalId: existing.canonical_id, sessionKey: existing.canonical_key });
			} else {
				results.push({ outcome: "duplicate", canonicalId: existing.canonical_id, sessionKey: existing.canonical_key });
			}
			continue;
		}
		insertSessionTranscriptIfMissing(db, commit);
		db.prepare(`INSERT INTO transcript_import_conversations
			(agent_id, external_identity, canonical_key, conversation_fingerprint, canonical_id, owner_source_id, owner_record_id, state, content_hash, harness, timestamp)
			VALUES (?, ?, ?, ?, ?, ?, ?, 'committed', ?, ?, ?)`).run(
			commit.agentId,
			commit.externalIdentity,
			commit.canonicalKey,
			commit.contentHash,
			commit.canonicalId,
			commit.sourceId,
			commit.sourceRecordId,
			commit.contentHash,
			commit.harness,
			commit.capturedAt,
		);
		results.push({ outcome: "imported", canonicalId: commit.canonicalId, sessionKey: commit.canonicalKey });
	}
	return results;
}

export function purgeTranscriptImportSourceInTx(db: WriteDb, agentId: string | undefined, sourceId: string): number {
	const active = db
		.prepare(
			`SELECT 1 FROM source_import_jobs j WHERE state NOT IN ('completed','completed_with_rejections','cancelled') ${agentId === undefined ? "" : "AND agent_id = ?"} AND EXISTS (SELECT 1 FROM source_import_files f WHERE f.job_id = j.id AND f.agent_id = j.agent_id AND f.source_id = ?) LIMIT 1`,
		)
		.get(...(agentId === undefined ? [] : [agentId]), sourceId);
	if (active) throw new Error("source purge requires cancelled import leases");
	const raw = db
		.prepare(
			`SELECT 1 FROM source_import_chunks c JOIN source_import_files f ON f.id = c.file_id AND f.agent_id = c.agent_id WHERE f.source_id = ? ${agentId === undefined ? "" : "AND f.agent_id = ?"} LIMIT 1`,
		)
		.get(sourceId, ...(agentId === undefined ? [] : [agentId]));
	if (raw) throw new Error("source purge requires completed raw-byte cleanup");
	let changed = 0;
	const conversations =
		agentId !== undefined
			? (db
					.prepare(
						"SELECT agent_id, external_identity, canonical_key FROM transcript_import_conversations WHERE agent_id = ? AND owner_source_id = ? AND state != 'removed' LIMIT 25",
					)
					.all(agentId, sourceId) as Array<{ agent_id: string; external_identity: string; canonical_key: string }>)
			: (db
					.prepare(
						"SELECT agent_id, external_identity, canonical_key FROM transcript_import_conversations WHERE owner_source_id = ? AND state != 'removed' LIMIT 25",
					)
					.all(sourceId) as Array<{ agent_id: string; external_identity: string; canonical_key: string }>);
	for (const conversation of conversations) {
		const replacement = db
			.prepare(
				"SELECT id, source_id FROM source_import_records WHERE agent_id = ? AND external_identity = ? AND source_id != ? AND status IN ('imported','duplicate') ORDER BY CASE status WHEN 'imported' THEN 0 ELSE 1 END, updated_at DESC LIMIT 1",
			)
			.get(conversation.agent_id, conversation.external_identity, sourceId) as
			| { id: string; source_id: string }
			| undefined;
		if (replacement) {
			changed += Number(
				db
					.prepare(
						"UPDATE transcript_import_conversations SET owner_source_id = ?, owner_record_id = ?, state = 'committed', updated_at = datetime('now') WHERE agent_id = ? AND external_identity = ?",
					)
					.run(replacement.source_id, replacement.id, conversation.agent_id, conversation.external_identity).changes >
					0,
			);
			updateSessionTranscriptSource(
				db,
				conversation.canonical_key,
				conversation.agent_id,
				replacement.source_id,
				replacement.id,
			);
		} else {
			changed += Number(
				db
					.prepare("DELETE FROM session_transcripts WHERE agent_id = ? AND session_key = ?")
					.run(conversation.agent_id, conversation.canonical_key).changes > 0,
			);
			changed += Number(
				db
					.prepare(
						"UPDATE transcript_import_conversations SET state = 'removed', updated_at = datetime('now') WHERE agent_id = ? AND external_identity = ?",
					)
					.run(conversation.agent_id, conversation.external_identity).changes > 0,
			);
		}
	}
	const scoped = agentId === undefined ? [sourceId] : [agentId, sourceId];
	const predicate = agentId === undefined ? "source_id = ?" : "agent_id = ? AND source_id = ?";
	const remaining = db
		.prepare(
			`SELECT 1 FROM transcript_import_conversations WHERE ${agentId === undefined ? "" : "agent_id = ? AND "}owner_source_id = ? AND state != 'removed' LIMIT 1`,
		)
		.get(...scoped);
	if (remaining) return changed;
	changed += db
		.prepare(
			`DELETE FROM source_import_records WHERE id IN (SELECT id FROM source_import_records WHERE ${predicate} LIMIT 25)`,
		)
		.run(...scoped).changes;
	const records = db.prepare(`SELECT 1 FROM source_import_records WHERE ${predicate} LIMIT 1`).get(...scoped);
	if (!records)
		changed += db
			.prepare(
				`DELETE FROM source_import_files WHERE id IN (SELECT id FROM source_import_files WHERE ${predicate} LIMIT 25)`,
			)
			.run(...scoped).changes;
	return changed;
}

function updateSessionTranscriptSource(
	db: WriteDb,
	sessionKey: string,
	agentId: string,
	sourceId: string,
	sourceRecordId: string,
): void {
	const columns = db.prepare("PRAGMA table_info(session_transcripts)").all() as Array<{ name: string }>;
	const names = new Set(columns.map((column) => column.name));
	const updates: string[] = [];
	const values: unknown[] = [];
	if (names.has("source_id")) {
		updates.push("source_id = ?");
		values.push(sourceId);
	}
	if (names.has("source_record_id")) {
		updates.push("source_record_id = ?");
		values.push(sourceRecordId);
	}
	if (names.has("updated_at")) updates.push("updated_at = datetime('now')");
	if (!updates.length) return;
	values.push(agentId, sessionKey);
	db.prepare(`UPDATE session_transcripts SET ${updates.join(", ")} WHERE agent_id = ? AND session_key = ?`).run(
		...values,
	);
}
