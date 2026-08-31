import { createHash } from "node:crypto";
import type { WriteDb } from "./db-accessor";
import {
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

/** Owner-side atomic DB prepare/finalize operation. Filesystem finalization is separate and replay-safe by recordId. */
export function commitCompletedTranscriptBatchInTx(
	db: WriteDb,
	commits: readonly CompletedTranscriptCommit[],
): TranscriptCommitResult[] {
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
			if (existing.conversation_fingerprint === commit.contentHash) {
				results.push({ outcome: "duplicate", canonicalId: existing.canonical_id, sessionKey: existing.canonical_key });
			} else {
				results.push({
					outcome: "conversation_identity_conflict",
					canonicalId: existing.canonical_id,
					sessionKey: existing.canonical_key,
				});
			}
			continue;
		}
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
