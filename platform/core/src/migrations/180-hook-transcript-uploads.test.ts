import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { MIGRATIONS } from "./index";

test("hook upload migration is self-contained, repeatable and preserves scoped chunks", () => {
	const migration = MIGRATIONS.find((entry) => entry.version === 180);
	expect(migration).toBeDefined();
	if (!migration) throw new Error("Hook upload migration is not registered");
	const db = new Database(":memory:");
	try {
		db.exec("PRAGMA foreign_keys = ON; CREATE TABLE preserved (value TEXT); INSERT INTO preserved VALUES ('evidence')");
		migration.up(db);
		db.exec("UPDATE source_import_capacity SET reserved_bytes = 99 WHERE id = 1");
		const insert = db.prepare(
			"INSERT INTO hook_transcript_uploads (id,agent_id,principal_id,credential_kind,credential_id,harness,session_key,sha256) VALUES (?,?,?,'api_key',?,'codex','session',?)",
		);
		const sha256 = "a".repeat(64);
		insert.run("first", "agent-a", "alice", "key-a", sha256);
		insert.run("second", "agent-b", "bob", "key-b", sha256);
		expect(() => insert.run("duplicate", "agent-a", "alice", "key-a", sha256)).toThrow();
		db.prepare(
			"INSERT INTO hook_transcript_chunks (agent_id,file_id,generation,byte_offset,checksum,content) VALUES ('agent-a','first',0,0,?,?)",
		).run(sha256, new Uint8Array([1, 2, 3]));
		migration.up(db);
		expect(db.prepare("SELECT reserved_bytes FROM source_import_capacity WHERE id = 1").get()).toEqual({
			reserved_bytes: 99,
		});
		expect(db.prepare("SELECT value FROM preserved").get()).toEqual({ value: "evidence" });
		expect(
			db.prepare("SELECT hex(content) AS content FROM hook_transcript_chunks WHERE file_id = 'first'").get(),
		).toEqual({ content: "010203" });
		expect(() =>
			db
				.prepare(
					"INSERT INTO hook_transcript_chunks (agent_id,file_id,generation,byte_offset,checksum,content) VALUES ('agent-b','first',0,65536,?,?)",
				)
				.run(sha256, new Uint8Array([4])),
		).toThrow();
		db.prepare("DELETE FROM hook_transcript_uploads WHERE id = 'first'").run();
		expect(db.prepare("SELECT COUNT(*) AS count FROM hook_transcript_chunks").get()).toEqual({ count: 0 });
		expect(db.prepare("SELECT id FROM hook_transcript_uploads").all()).toEqual([{ id: "second" }]);
	} finally {
		db.close();
	}
});
