import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
	buildCompletedTranscriptCommit,
	canonicalTranscriptLine,
	commitCompletedTranscriptBatchInTx,
	purgeTranscriptImportSourceInTx,
	serializeCompletedTranscriptMessages,
	splitTranscriptCommitBatches,
	transcriptCommitBatchBytes,
} from "./transcript-import-commit";
import { signetExportV1Adapter } from "./transcript-import-adapter";

const record = (agent_id: string, content = "  exact\n\ntext  ") =>
	signetExportV1Adapter.parse({
		source: "signet",
		id: "conversation-1",
		harness: "claude",
		agent_id,
		session_key: "same-session",
		project: null,
		timestamp: "2024-01-01T00:00:00.000Z",
		message_count: 3,
		messages: [
			{ role: "system", content: "system\nline" },
			{ role: "tool", content: '{"x":1}' },
			{ role: "user", content },
		],
	});

describe("transcript import invariants", () => {
	test("lossless roles and whitespace are retained without role-prefixed text", () => {
		const commit = buildCompletedTranscriptCommit(record("agent-a"), {
			agentId: "agent-a",
			sourceId: "source-a",
			sourceRecordId: "record-a",
		});
		expect(commit.messages[0]).toEqual({ role: "system", content: "system\nline" });
		expect(serializeCompletedTranscriptMessages(commit.messages)).toContain("  exact\\n\\ntext  ");
		expect(canonicalTranscriptLine(commit)).toContain('"role":"tool"');
	});
	test("agent scope is part of deterministic identity", () => {
		const a = buildCompletedTranscriptCommit(record("agent-a"), {
			agentId: "agent-a",
			sourceId: "source-a",
			sourceRecordId: "record-a",
		});
		const b = buildCompletedTranscriptCommit(record("agent-b"), {
			agentId: "agent-b",
			sourceId: "source-a",
			sourceRecordId: "record-a",
		});
		expect(a.recordId).not.toBe(b.recordId);
		expect(a.canonicalId).not.toBe(b.canonicalId);
	});
	test("replay uses the same record id and canonical revision", () => {
		const input = { agentId: "agent-a", sourceId: "source-a", sourceRecordId: "record-a" } as const;
		expect(buildCompletedTranscriptCommit(record("agent-a"), input)).toEqual(
			buildCompletedTranscriptCommit(record("agent-a"), input),
		);
	});
	test("source purge invalidates active import generations before deleting source rows", () => {
		const db = new Database(":memory:");
		try {
			db.exec(`
				CREATE TABLE source_import_jobs (
					id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, state TEXT NOT NULL,
					generation INTEGER NOT NULL, control_request TEXT,
					lease_token TEXT, lease_expires_at TEXT, updated_at TEXT
				);
				CREATE TABLE source_import_files (
					id TEXT PRIMARY KEY, job_id TEXT NOT NULL, source_id TEXT NOT NULL,
					agent_id TEXT NOT NULL
				);
				CREATE TABLE source_import_records (
					id TEXT PRIMARY KEY, job_id TEXT NOT NULL, file_id TEXT NOT NULL,
					source_id TEXT NOT NULL, agent_id TEXT NOT NULL
				);
				CREATE TABLE transcript_import_conversations (
					agent_id TEXT NOT NULL, external_identity TEXT NOT NULL,
					canonical_key TEXT NOT NULL, owner_source_id TEXT NOT NULL
				);
			`);
			db.prepare(
				"INSERT INTO source_import_jobs (id, agent_id, state, generation, lease_token) VALUES ('purge-job', 'agent-a', 'running', 4, 'lease-a')",
			).run();
			db.prepare(
				"INSERT INTO source_import_files (id, job_id, source_id, agent_id) VALUES ('purge-file', 'purge-job', 'source-a', 'agent-a')",
			).run();
			db.prepare(
				"INSERT INTO source_import_records (id, job_id, file_id, source_id, agent_id) VALUES ('purge-record', 'purge-job', 'purge-file', 'source-a', 'agent-a')",
			).run();

			purgeTranscriptImportSourceInTx(db as never, "agent-a", "source-a");

			expect(
				db.query("SELECT state, generation, lease_token FROM source_import_jobs WHERE id = 'purge-job'").get(),
			).toEqual({
				state: "cancelled",
				generation: 5,
				lease_token: null,
			});
			expect(db.query("SELECT COUNT(*) AS count FROM source_import_files").get()).toEqual({ count: 0 });
			expect(db.query("SELECT COUNT(*) AS count FROM source_import_records").get()).toEqual({ count: 0 });
		} finally {
			db.close();
		}
	});
	test("splits canonical batches by the complete payload byte budget", () => {
		const commit = buildCompletedTranscriptCommit(record("agent-a"), {
			agentId: "agent-a",
			sourceId: "source-a",
			sourceRecordId: "record-a",
		});
		const oneCommitBytes = transcriptCommitBatchBytes([commit]);
		expect(splitTranscriptCommitBatches([commit, commit], oneCommitBytes)).toEqual([[commit], [commit]]);
		expect(() => splitTranscriptCommitBatches([commit], oneCommitBytes - 1)).toThrow("canonical_batch_too_large");
	});
	test("purge transfers duplicate ownership and permits lossless reimport", () => {
		const db = new Database(":memory:");
		try {
			db.exec(`
				CREATE TABLE source_import_jobs (
					id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, state TEXT NOT NULL,
					generation INTEGER NOT NULL, control_request TEXT,
					lease_token TEXT, lease_expires_at TEXT, updated_at TEXT
				);
				CREATE TABLE source_import_files (
					id TEXT PRIMARY KEY, job_id TEXT NOT NULL, source_id TEXT NOT NULL,
					agent_id TEXT NOT NULL
				);
				CREATE TABLE source_import_records (
					id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, external_identity TEXT NOT NULL,
					source_id TEXT NOT NULL, status TEXT NOT NULL, updated_at TEXT NOT NULL
				);
				CREATE TABLE session_transcripts (
					session_key TEXT NOT NULL, content TEXT NOT NULL, harness TEXT,
					project TEXT, agent_id TEXT NOT NULL, created_at TEXT NOT NULL,
					updated_at TEXT, completed_at TEXT, content_hash TEXT,
					source_id TEXT, source_record_id TEXT, source_meta_json TEXT,
					PRIMARY KEY (agent_id, session_key)
				);
				CREATE TABLE transcript_import_conversations (
					agent_id TEXT NOT NULL, external_identity TEXT NOT NULL,
					canonical_key TEXT NOT NULL, conversation_fingerprint TEXT NOT NULL,
					canonical_id TEXT NOT NULL, owner_source_id TEXT NOT NULL,
					owner_record_id TEXT NOT NULL, state TEXT NOT NULL,
					content_hash TEXT NOT NULL, harness TEXT NOT NULL, timestamp TEXT NOT NULL,
					updated_at TEXT,
					PRIMARY KEY (agent_id, external_identity)
				);
			`);
			const first = buildCompletedTranscriptCommit(record("agent-a"), {
				agentId: "agent-a",
				sourceId: "source-a",
				sourceRecordId: "record-a",
			});
			const second = buildCompletedTranscriptCommit(record("agent-a"), {
				agentId: "agent-a",
				sourceId: "source-b",
				sourceRecordId: "record-b",
			});
			expect(commitCompletedTranscriptBatchInTx(db as never, [first])[0]?.outcome).toBe("imported");
			db.prepare(
				"INSERT INTO source_import_records (id,agent_id,external_identity,source_id,status,updated_at) VALUES (?,?,?,?,?,?)",
			).run("record-a", "agent-a", first.externalIdentity, "source-a", "imported", "2026-01-01T00:00:00Z");
			expect(commitCompletedTranscriptBatchInTx(db as never, [second])[0]?.outcome).toBe("duplicate");
			db.prepare(
				"INSERT INTO source_import_records (id,agent_id,external_identity,source_id,status,updated_at) VALUES (?,?,?,?,?,?)",
			).run("record-b", "agent-a", second.externalIdentity, "source-b", "duplicate", "2026-01-01T00:00:01Z");

			purgeTranscriptImportSourceInTx(db as never, "agent-a", "source-a");
			expect(
				db.prepare("SELECT owner_source_id, owner_record_id, state FROM transcript_import_conversations").get(),
			).toEqual({
				owner_source_id: "source-b",
				owner_record_id: "record-b",
				state: "committed",
			});
			expect(db.prepare("SELECT source_id, source_record_id FROM session_transcripts").get()).toEqual({
				source_id: "source-b",
				source_record_id: "record-b",
			});
			expect(
				db.prepare("SELECT COUNT(*) AS count FROM source_import_records WHERE source_id = 'source-a'").get(),
			).toEqual({
				count: 0,
			});

			purgeTranscriptImportSourceInTx(db as never, "agent-a", "source-b");
			expect(db.prepare("SELECT state FROM transcript_import_conversations").get()).toEqual({ state: "removed" });
			expect(db.prepare("SELECT COUNT(*) AS count FROM session_transcripts").get()).toEqual({ count: 0 });

			expect(commitCompletedTranscriptBatchInTx(db as never, [first])[0]?.outcome).toBe("imported");
			expect(
				db.prepare("SELECT owner_source_id, owner_record_id, state FROM transcript_import_conversations").get(),
			).toEqual({
				owner_source_id: "source-a",
				owner_record_id: "record-a",
				state: "committed",
			});
			expect(db.prepare("SELECT source_id, source_record_id FROM session_transcripts").get()).toEqual({
				source_id: "source-a",
				source_record_id: "record-a",
			});
		} finally {
			db.close();
		}
	});
});
