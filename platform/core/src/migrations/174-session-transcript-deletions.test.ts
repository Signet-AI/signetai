import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { up } from "./174-session-transcript-deletions";

test("upgrades retained rows idempotently and fences legacy writers in the exact agent scope", () => {
	const db = new Database(":memory:");
	try {
		db.exec(`
			CREATE TABLE source_import_records (agent_id TEXT, canonical_key TEXT);
			CREATE TABLE session_transcripts (agent_id TEXT, session_key TEXT, content TEXT);
			CREATE TABLE transcript_capture_jobs (agent_id TEXT, session_key TEXT);
			CREATE TABLE session_summaries (agent_id TEXT, session_key TEXT);
			CREATE TABLE memory_artifacts (agent_id TEXT, session_key TEXT);
			CREATE TABLE memories (id TEXT, agent_id TEXT, source_id TEXT, source_type TEXT, type TEXT, is_deleted INTEGER);
			CREATE TABLE derived_memory_sources (agent_id TEXT, source_kind TEXT, source_id TEXT);
			INSERT INTO session_transcripts VALUES ('alpha','session','original evidence');
			INSERT INTO memories VALUES ('summary','alpha','session','pi','session_summary',0);
		`);
		up(db);
		up(db);
		expect(db.prepare("SELECT content FROM session_transcripts").get()).toEqual({ content: "original evidence" });
		db.exec(
			"INSERT INTO session_transcript_deletions (agent_id,session_key,harness,requested_at) VALUES ('alpha','session','pi',datetime('now'))",
		);
		expect(() => db.exec("INSERT INTO session_transcripts VALUES ('alpha','session','resurrection')")).toThrow(
			"session transcript deleted",
		);
		expect(() => db.exec("UPDATE session_transcripts SET content = 'resurrection' WHERE agent_id = 'alpha'")).toThrow(
			"session transcript deleted",
		);
		db.exec("INSERT INTO session_transcripts VALUES ('beta','session','unrelated evidence')");
		db.exec("UPDATE memories SET is_deleted = 1 WHERE id = 'summary'");
		expect(() => db.exec("UPDATE memories SET is_deleted = 0 WHERE id = 'summary'")).toThrow(
			"session transcript deleted",
		);
		expect(() => db.exec("INSERT INTO derived_memory_sources VALUES ('alpha','transcript','session')")).toThrow(
			"session transcript deleted",
		);
		expect(db.prepare("SELECT content FROM session_transcripts WHERE agent_id = 'beta'").get()).toEqual({
			content: "unrelated evidence",
		});
	} finally {
		db.close();
	}
});
