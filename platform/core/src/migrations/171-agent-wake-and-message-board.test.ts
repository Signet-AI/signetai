import { describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { up } from "./171-agent-wake-and-message-board";

const OLD_TABLES = `
	CREATE TABLE board_posts (
		id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, author_agent_id TEXT NOT NULL,
		author_session_key TEXT, author_harness TEXT, body TEXT NOT NULL,
		reply_to_post_id TEXT, created_at TEXT NOT NULL, projected_at TEXT
	);
	CREATE INDEX idx_board_posts_thread ON board_posts(thread_id, created_at, id);
	CREATE TABLE board_reads (
		agent_id TEXT NOT NULL, thread_id TEXT NOT NULL, last_read_at TEXT NOT NULL,
		PRIMARY KEY (agent_id, thread_id)
	);
	CREATE TABLE board_notices (
		agent_id TEXT NOT NULL, session_key TEXT NOT NULL, thread_id TEXT NOT NULL,
		notified_at TEXT NOT NULL, PRIMARY KEY (agent_id, session_key, thread_id)
	);
`;

function names(db: Database, table: string): string[] {
	return (db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
}

function seedOld(db: Database): void {
	db.exec(OLD_TABLES);
	const post = db.prepare(
		"INSERT INTO board_posts (id, thread_id, author_agent_id, body, created_at) VALUES (?, ?, 'a', 'b', ?)",
	);
	post.run("p1", "t1", "2026-01-01T00:00:01Z");
	post.run("p2", "t1", "2026-01-01T00:00:02Z");
	post.run("p3", "t2", "2026-01-01T00:00:00Z");
	post.run("p4", "t1", "2026-01-01T00:00:04Z");
	db.exec(`
		INSERT INTO board_reads VALUES ('r', 't1', '2026-01-01T00:00:02Z');
		INSERT INTO board_reads VALUES ('r', 't3', '2026-01-01T00:00:09Z');
		INSERT INTO board_notices VALUES ('r', 's1', 't1', '2026-01-01T00:00:01Z');
	`);
}

describe("migration 171 agent wake and message board", () => {
	test("fresh and repeated initialization yields the canonical layout", () => {
		const db = new Database(":memory:");
		try {
			up(db);
			up(db);
			expect(names(db, "board_posts")).toContain("seq");
			expect(names(db, "board_notices")).toEqual(["agent_id", "session_key", "thread_id", "notified_post_seq"]);
			db.exec("INSERT INTO board_notices (agent_id, session_key, thread_id) VALUES ('a','s','t')");
		} finally {
			db.close();
		}
	});

	test("repairs the intermediate layout, preserving rows and state", () => {
		const db = new Database(":memory:");
		try {
			seedOld(db);
			up(db);
			const seqs = db.query("SELECT id, seq FROM board_posts ORDER BY seq").all();
			expect(seqs).toEqual([
				{ id: "p1", seq: 1 },
				{ id: "p2", seq: 2 },
				{ id: "p3", seq: 3 },
				{ id: "p4", seq: 4 },
			]);
			expect(db.query("SELECT thread_id, last_read_post_seq AS s FROM board_reads ORDER BY thread_id").all()).toEqual([
				{ thread_id: "t1", s: 2 },
				{ thread_id: "t3", s: 0 },
			]);
			expect(db.query("SELECT * FROM board_notices").all()).toEqual([
				{ agent_id: "r", session_key: "s1", thread_id: "t1", notified_post_seq: 1 },
			]);
			db.exec("INSERT INTO board_notices (agent_id, session_key, thread_id) VALUES ('r','s2','t1')");
			db.exec(
				"INSERT INTO board_posts (id, seq, thread_id, author_agent_id, body, created_at) VALUES ('p5', (SELECT COALESCE(MAX(seq),0)+1 FROM board_posts), 't1','a','b','x')",
			);
			expect((db.query("SELECT seq FROM board_posts WHERE id='p5'").get() as { seq: number }).seq).toBe(5);
			const snapshot = JSON.stringify(db.query("SELECT * FROM board_posts ORDER BY id").all());
			up(db);
			expect(JSON.stringify(db.query("SELECT * FROM board_posts ORDER BY id").all())).toBe(snapshot);
			expect(db.query("SELECT COUNT(*) AS n FROM board_notices").get()).toEqual({ n: 2 });
			const idx = db.query("PRAGMA index_info(idx_board_posts_thread)").all() as Array<{ name: string }>;
			expect(idx.map((i) => i.name)).toEqual(["thread_id", "seq"]);
		} finally {
			db.close();
		}
	});

	test("rolls back the notice rebuild if replacement fails and can retry", () => {
		const db = new Database(":memory:");
		seedOld(db);
		const original = db.exec.bind(db);
		const exec = spyOn(db, "exec").mockImplementation((sql: string) => {
			if (sql === "ALTER TABLE board_notices_repair RENAME TO board_notices") {
				throw new Error("injected replacement failure");
			}
			return original(sql);
		});
		try {
			expect(() => up(db)).toThrow("injected replacement failure");
			expect(names(db, "board_notices")).toContain("notified_at");
			expect(db.query("SELECT * FROM board_notices").all()).toEqual([
				{ agent_id: "r", session_key: "s1", thread_id: "t1", notified_at: "2026-01-01T00:00:01Z" },
			]);
			expect(db.query("SELECT name FROM sqlite_master WHERE name='board_notices_repair'").get()).toBeNull();
			exec.mockRestore();
			up(db);
			expect(db.prepare("SELECT agent_id, session_key, thread_id, notified_post_seq FROM board_notices").all()).toEqual(
				[{ agent_id: "r", session_key: "s1", thread_id: "t1", notified_post_seq: 1 }],
			);
		} finally {
			exec.mockRestore();
			db.close();
		}
	});

	test("repairs partially applied seq columns with null or duplicate values", () => {
		const db = new Database(":memory:");
		try {
			up(db);
			db.exec("DROP INDEX idx_board_posts_seq");
			db.exec("ALTER TABLE board_posts RENAME TO bp");
			db.exec(`CREATE TABLE board_posts (id TEXT PRIMARY KEY, seq INTEGER, thread_id TEXT NOT NULL,
				author_agent_id TEXT NOT NULL, author_session_key TEXT, author_harness TEXT, body TEXT NOT NULL,
				reply_to_post_id TEXT, created_at TEXT NOT NULL, projected_at TEXT)`);
			db.exec(`INSERT INTO board_posts (id, seq, thread_id, author_agent_id, body, created_at) VALUES
				('a', 5, 't', 'x', 'b', 'c'), ('b', 5, 't', 'x', 'b', 'c'), ('c', NULL, 't', 'x', 'b', 'c'), ('d', 0, 't', 'x', 'b', 'c')`);
			up(db);
			expect(db.query("SELECT id, seq FROM board_posts ORDER BY rowid").all()).toEqual([
				{ id: "a", seq: 5 },
				{ id: "b", seq: 6 },
				{ id: "c", seq: 7 },
				{ id: "d", seq: 8 },
			]);
		} finally {
			db.close();
		}
	});
});
