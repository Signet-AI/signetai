import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { refreshQueryPlannerStatisticsOnOpen } from "./query-planner-statistics";

function plan(db: Database, sql: string, ...params: string[]): string {
	return (db.query(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[])
		.map((row) => row.detail)
		.join(" | ");
}

function seededDb(): Database {
	const db = new Database(":memory:");
	db.exec(`
		CREATE TABLE session_memories (
			id INTEGER PRIMARY KEY,
			session_key TEXT NOT NULL,
			memory_id TEXT NOT NULL,
			agent_id TEXT NOT NULL,
			agent_relevance_score REAL
		);
		CREATE INDEX idx_session_memories_agent_session ON session_memories(agent_id, session_key);
		CREATE INDEX idx_session_memories_memory ON session_memories(memory_id);
	`);
	const insert = db.prepare(
		"INSERT INTO session_memories (session_key, memory_id, agent_id, agent_relevance_score) VALUES (?, ?, 'default', NULL)",
	);
	db.transaction(() => {
		for (let i = 0; i < 4000; i++) insert.run(`session-${i % 200}`, `memory-${i % 1500}`);
	})();
	return db;
}

const observedScores = `SELECT memory_id, AVG(agent_relevance_score) AS score
	FROM session_memories
	WHERE agent_id = ? AND memory_id IN (?, ?, ?) AND agent_relevance_score IS NOT NULL
	GROUP BY memory_id`;

describe("query planner statistics", () => {
	it("records statistics so selective indexes drive hot recall lookups", () => {
		const db = seededDb();
		expect(plan(db, observedScores, "default", "memory-1", "memory-2", "memory-3")).toContain(
			"idx_session_memories_agent_session",
		);
		refreshQueryPlannerStatisticsOnOpen(db);
		const stats = db.query("SELECT COUNT(*) AS n FROM sqlite_stat1 WHERE tbl = 'session_memories'").get() as {
			n: number;
		};
		expect(stats.n).toBeGreaterThan(0);
		expect(plan(db, observedScores, "default", "memory-1", "memory-2", "memory-3")).toContain(
			"idx_session_memories_memory",
		);
		db.close();
	});

	it("is cheap to repeat on an already analyzed database", () => {
		const db = seededDb();
		refreshQueryPlannerStatisticsOnOpen(db);
		const before = db.query("SELECT stat FROM sqlite_stat1 ORDER BY tbl, idx").all();
		refreshQueryPlannerStatisticsOnOpen(db);
		expect(db.query("SELECT stat FROM sqlite_stat1 ORDER BY tbl, idx").all()).toEqual(before);
		db.close();
	});
});
