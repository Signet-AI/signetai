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

/** Return the complete payload size that crosses both filesystem and owner boundaries. */
export function transcriptCommitBatchBytes(commits: readonly CompletedTranscriptCommit[]): number {
	const canonicalBytes = Buffer.byteLength(commits.map(canonicalTranscriptLine).join(""), "utf8");
	const ownerPayloadBytes = Buffer.byteLength(JSON.stringify(commits), "utf8");
	return canonicalBytes + ownerPayloadBytes;
}

/** Split commits without exceeding either the record-count or byte budget. */
export function splitTranscriptCommitBatches(
	commits: readonly CompletedTranscriptCommit[],
	maxBytes = TRANSCRIPT_IMPORT_LIMITS.maxCanonicalBatchBytes,
): CompletedTranscriptCommit[][] {
	if (maxBytes < 1) throw new RangeError("invalid transcript batch byte limit");
	const batches: CompletedTranscriptCommit[][] = [];
	let current: CompletedTranscriptCommit[] = [];
	for (const commit of commits) {
		const single = transcriptCommitBatchBytes([commit]);
		if (single > maxBytes) throw new RangeError("canonical_batch_too_large");
		const candidate = [...current, commit];
		if (
			current.length >= TRANSCRIPT_IMPORT_LIMITS.maxRecordsPerBatch ||
			(current.length > 0 && transcriptCommitBatchBytes(candidate) > maxBytes)
		) {
			batches.push(current);
			current = [commit];
		} else {
			current = candidate;
		}
	}
	if (current.length) batches.push(current);
	return batches;
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

export function purgeTranscriptImportSourceInTx(db: WriteDb, agentId: string, sourceId: string): number {
	const conversations = db
		.prepare(
			"SELECT external_identity, canonical_key FROM transcript_import_conversations WHERE agent_id = ? AND owner_source_id = ?",
		)
		.all(agentId, sourceId) as Array<{ external_identity: string; canonical_key: string }>;
	let changed = 0;
	for (const conversation of conversations) {
		const replacement = db
			.prepare(
				"SELECT id, source_id FROM source_import_records WHERE agent_id = ? AND external_identity = ? AND source_id != ? AND status IN ('imported','duplicate') ORDER BY CASE status WHEN 'imported' THEN 0 ELSE 1 END, updated_at DESC LIMIT 1",
			)
			.get(agentId, conversation.external_identity, sourceId) as { id: string; source_id: string } | undefined;
		if (replacement) {
			changed += Number(
				db
					.prepare(
						"UPDATE transcript_import_conversations SET owner_source_id = ?, owner_record_id = ?, state = 'committed', updated_at = datetime('now') WHERE agent_id = ? AND external_identity = ?",
					)
					.run(replacement.source_id, replacement.id, agentId, conversation.external_identity).changes > 0,
			);
			updateSessionTranscriptSource(db, conversation.canonical_key, agentId, replacement.source_id, replacement.id);
		} else {
			changed += Number(
				db
					.prepare("DELETE FROM session_transcripts WHERE agent_id = ? AND session_key = ?")
					.run(agentId, conversation.canonical_key).changes > 0,
			);
			changed += Number(
				db
					.prepare(
						"UPDATE transcript_import_conversations SET state = 'removed', updated_at = datetime('now') WHERE agent_id = ? AND external_identity = ?",
					)
					.run(agentId, conversation.external_identity).changes > 0,
			);
		}
	}
	changed += db
		.prepare("DELETE FROM source_import_records WHERE agent_id = ? AND source_id = ?")
		.run(agentId, sourceId).changes;
	changed += db
		.prepare("DELETE FROM source_import_files WHERE agent_id = ? AND source_id = ?")
		.run(agentId, sourceId).changes;
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
