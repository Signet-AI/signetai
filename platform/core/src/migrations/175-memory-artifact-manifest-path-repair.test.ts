import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { LATEST_SCHEMA_VERSION, runMigrations } from "./index";
import { up } from "./175-memory-artifact-manifest-path-repair";

test("clears non-manifest manifest_path values idempotently and keeps manifest refs", () => {
	const db = new Database(":memory:");
	try {
		runMigrations(db);
		db.exec("DELETE FROM schema_migrations WHERE version = 175");
		const manifest = "memory/2026-11-01T00-00-00.000Z--bbbbbbbbbbbbbbbb--manifest.md";
		const insert = db.prepare(
			`INSERT INTO memory_artifacts (source_path, source_sha256, source_kind, session_id, session_token, captured_at, updated_at, manifest_path)
			 VALUES (?, 'sha', 'transcript', ?, 'aaaaaaaaaaaaaaaa', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z', ?)`,
		);
		insert.run("transcripts/codex/transcript.jsonl#a", "s1", "transcripts/codex/transcript.jsonl");
		insert.run("memory/a--transcript.md", "s2", manifest);
		insert.run("notes/x.md", "s3", "../../outside.txt");
		insert.run("notes/y.md", "s4", null);
		runMigrations(db);
		up(db);
		expect(db.prepare("SELECT session_id, manifest_path FROM memory_artifacts ORDER BY session_id").all()).toEqual([
			{ session_id: "s1", manifest_path: null },
			{ session_id: "s2", manifest_path: manifest },
			{ session_id: "s3", manifest_path: null },
			{ session_id: "s4", manifest_path: null },
		]);
		expect(db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({
			version: LATEST_SCHEMA_VERSION,
		});
	} finally {
		db.close();
	}
});
