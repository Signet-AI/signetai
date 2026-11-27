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

type SeedRow = readonly [sessionKey: string, sessionId: string, project: string, content: string, updatedAt: string];

function seed(rows: ReadonlyArray<SeedRow>): Database {
	const conn = createTranscriptDb();
	const insert = conn.prepare(`
		INSERT INTO session_transcripts
			(agent_id, session_key, session_id, project, harness, content, created_at, updated_at)
		VALUES ('default', ?, ?, ?, 'opencode', ?, '2026-05-06T10:00:00Z', ?)
	`);
	for (const row of rows) insert.run(...row);
	return conn;
}

function searchKeys(
	conn: Database,
	params: {
		readonly query: string;
		readonly project?: string;
		readonly sessionKey?: string;
		readonly currentSessionKey?: string;
	},
): string[] {
	return searchSessionTranscripts({ db: conn, agentId: "default", limit: 5, ...params }).map((hit) => hit.sessionKey);
}

function seedScopedSessions(): Database {
	return seed([
		["agent:default:main", "main-id", "/repo", "Alpha notes.", "2026-05-06T10:01:00Z"],
		["session-q", "session-q-id", "/other", "Bravo notes.", "2026-05-06T10:02:00Z"],
		["session-p", "session-p-id", "/repo", "Charlie notes.", "2026-05-06T10:03:00Z"],
	]);
}

describe("searchSessionTranscripts", () => {
	test("fallback LIKE search preserves parameter order with session and project filters", () => {
		const note = "Parent session decided the delegated subagent should inherit the continuity note.";
		const conn = seed([
			["parent-session", "parent-session", "/repo", note, "2026-05-06T10:01:00Z"],
			["other-session", "other-session", "/elsewhere", note, "2026-05-06T10:02:00Z"],
		]);

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

	test("exact session key or id from another project returns nothing", () => {
		const conn = seedScopedSessions();

		expect(searchKeys(conn, { query: "session-q", project: "/repo" })).toEqual([]);
		expect(searchKeys(conn, { query: "session-q-id", project: "/repo" })).toEqual([]);
		expect(searchKeys(conn, { query: "session-q", project: "/other" })).toEqual(["session-q"]);
		expect(searchKeys(conn, { query: "session-q-id", project: "/other" })).toEqual(["session-q"]);
		expect(searchKeys(conn, { query: "session-q-id" })).toEqual(["session-q"]);
	});

	test("exact session key or id follows the currentSessionKey rule", () => {
		const conn = seedScopedSessions();

		expect(searchKeys(conn, { query: "session-p", project: "/repo", currentSessionKey: "session-p" })).toEqual([]);
		expect(searchKeys(conn, { query: "session-p-id", project: "/repo", currentSessionKey: "session-p" })).toEqual([]);
		expect(searchKeys(conn, { query: "session-p", project: "/repo", currentSessionKey: "child-session" })).toEqual([
			"session-p",
		]);

		const subagent = "agent:default:subagent:abc123";
		expect(searchKeys(conn, { query: "session-p", project: "/repo", currentSessionKey: subagent })).toEqual([]);
		expect(searchKeys(conn, { query: "main-id", project: "/repo", currentSessionKey: subagent })).toEqual([
			"agent:default:main",
		]);
		expect(searchKeys(conn, { query: "session-p", project: "/repo", sessionKey: "session-p" })).toEqual(["session-p"]);
		expect(searchKeys(conn, { query: "session-p", project: "/repo", sessionKey: "agent:default:main" })).toEqual([]);
	});
});
