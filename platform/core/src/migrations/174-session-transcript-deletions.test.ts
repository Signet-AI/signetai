import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { runMigrations } from "./index";
import { up } from "./174-session-transcript-deletions";

test("upgrades the real migrated schema idempotently without changing scoped evidence", () => {
	const db = new Database(":memory:");
	try {
		runMigrations(db);
		db.exec(
			"DROP INDEX idx_import_records_session_delete; ALTER TABLE source_import_records DROP COLUMN redacted_bytes; DROP TABLE session_transcript_delete_files; DROP TABLE session_transcript_deleted_positions; DROP TABLE session_transcript_deleted_prefixes; DROP TABLE session_transcript_deleted_sources; DROP TABLE session_transcript_deletions; DELETE FROM schema_migrations WHERE version = 174",
		);
		db.prepare(
			"INSERT INTO session_transcripts (session_key,agent_id,content,harness,project,created_at) VALUES ('shared','agent-a','User: original','codex','project-a',datetime('now')), ('shared','agent-b','User: other','codex','project-b',datetime('now'))",
		).run();
		runMigrations(db);
		up(db);
		up(db);
		expect(db.prepare("SELECT agent_id,content,project FROM session_transcripts ORDER BY agent_id").all()).toEqual([
			{ agent_id: "agent-a", content: "User: original", project: "project-a" },
			{ agent_id: "agent-b", content: "User: other", project: "project-b" },
		]);
		db.prepare(
			"INSERT INTO session_transcript_deletions (agent_id,session_key,watermark) VALUES ('agent-a','shared','2026-11-17T00:00:00.000Z'), ('agent-b','shared','2026-11-17T00:00:00.000Z')",
		).run();
		expect(
			db.prepare("SELECT agent_id,generation,phase FROM session_transcript_deletions ORDER BY agent_id").all(),
		).toEqual([
			{ agent_id: "agent-a", generation: 1, phase: "evidence" },
			{ agent_id: "agent-b", generation: 1, phase: "evidence" },
		]);
		db.exec("PRAGMA foreign_keys = ON");
		db.prepare("INSERT INTO session_transcript_deleted_prefixes VALUES ('agent-a','shared',1,1,'hash')").run();
		db.prepare("INSERT INTO session_transcript_deleted_positions VALUES ('agent-a','shared',1,'row',1,'hash')").run();
		db.prepare(
			"DELETE FROM session_transcript_deleted_prefixes WHERE agent_id = 'agent-a' AND session_key = 'shared' AND generation = 1",
		).run();
		expect(db.prepare("SELECT * FROM session_transcript_deleted_positions").all()).toEqual([]);
		expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
	} finally {
		db.close();
	}
});
