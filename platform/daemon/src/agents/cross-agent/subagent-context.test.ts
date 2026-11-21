import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { searchSessionTranscripts } from "./subagent-context.js";

let db: Database | null = null;

function createTranscriptDb(): Database {
	const next = new Database(":memory:");
	next.run(`
		CREATE TABLE session_transcripts (
			agent_id TEXT NOT NULL,
			session_key TEXT NOT NULL,
			session_id TEXT NOT NULL,
			project TEXT,
			harness TEXT NOT NULL,
			content TEXT NOT NULL,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)
	`);
	db = next;
	return next;
}

afterEach(() => {
	db?.close();
	db = null;
});

describe("searchSessionTranscripts", () => {
	test("fallback LIKE search preserves parameter order with session and project filters", () => {
		const conn = createTranscriptDb();
		const insert = conn.prepare(`
			INSERT INTO session_transcripts
				(agent_id, session_key, session_id, project, harness, content, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		`);
		insert.run(
			"default",
			"parent-session",
			"parent-session",
			"/repo",
			"opencode",
			"Parent session decided the delegated subagent should inherit the continuity note.",
			"2026-05-06T10:00:00Z",
			"2026-05-06T10:01:00Z",
		);
		insert.run(
			"default",
			"other-session",
			"other-session",
			"/elsewhere",
			"opencode",
			"Parent session decided the delegated subagent should inherit the continuity note.",
			"2026-05-06T10:00:00Z",
			"2026-05-06T10:02:00Z",
		);

		const rows = searchSessionTranscripts({
			db: conn,
			agentId: "default",
			query: "delegated continuity",
			project: "/repo",
			currentSessionKey: "child-session",
			limit: 5,
		});

		expect(rows).toHaveLength(1);
		expect(rows[0]?.sessionKey).toBe("parent-session");
		expect(rows[0]?.excerpt).toContain("delegated");
	});
});
