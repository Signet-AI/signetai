import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { runMigrations } from "@signet/core";

describe("skill-analytics queries", () => {
	let db: Database;

	beforeEach(() => {
		db = new Database(":memory:");
		runMigrations(db);
	});

	afterEach(() => {
		if (db) db.close();
	});

	function seed(
		rows: ReadonlyArray<{
			id: string;
			skillName: string;
			agentId?: string;
			source?: string;
			taskId?: string;
			latencyMs: number;
			success?: boolean;
		}>,
	): void {
		const stmt = db.prepare(
			`INSERT INTO skill_invocations (id, skill_name, agent_id, source, task_id, latency_ms, success, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
		);
		for (const row of rows) {
			stmt.run(
				row.id,
				row.skillName,
				row.agentId ?? "default",
				row.source ?? "scheduled-task",
				row.taskId ?? null,
				row.latencyMs,
				(row.success ?? true) ? 1 : 0,
			);
		}
	}

	it("returns zero counts with empty table", () => {
		const totals = db
			.prepare(
				"SELECT COUNT(*) as total, COALESCE(SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END), 0) as successes FROM skill_invocations WHERE agent_id = ?",
			)
			.get("default") as { total: number; successes: number };
		expect(totals.total).toBe(0);
		expect(totals.successes).toBe(0);
	});

	it("aggregates invocations correctly", () => {
		seed([
			{ id: "s1", skillName: "recall", latencyMs: 100 },
			{ id: "s2", skillName: "recall", latencyMs: 200 },
			{ id: "s3", skillName: "remember", latencyMs: 50, success: false },
			{ id: "s4", skillName: "signet", latencyMs: 300 },
		]);

		const total = db.prepare("SELECT COUNT(*) as c FROM skill_invocations WHERE agent_id = 'default'").get() as {
			c: number;
		};
		expect(total.c).toBe(4);

		const skills = db
			.prepare(
				"SELECT skill_name, COUNT(*) as count FROM skill_invocations WHERE agent_id = 'default' GROUP BY skill_name ORDER BY count DESC",
			)
			.all() as { skill_name: string; count: number }[];
		expect(skills[0].skill_name).toBe("recall");
		expect(skills[0].count).toBe(2);
	});

	it("scopes by agent_id", () => {
		seed([
			{ id: "a1", skillName: "recall", agentId: "agent-a", latencyMs: 100 },
			{ id: "b1", skillName: "recall", agentId: "agent-b", latencyMs: 200 },
		]);

		const agentA = db.prepare("SELECT COUNT(*) as c FROM skill_invocations WHERE agent_id = 'agent-a'").get() as {
			c: number;
		};
		expect(agentA.c).toBe(1);
	});

	it("tracks source column", () => {
		seed([
			{ id: "t1", skillName: "recall", source: "scheduled-task", latencyMs: 100 },
			{ id: "t2", skillName: "recall", source: "cli", latencyMs: 200 },
		]);

		const sources = db
			.prepare("SELECT source, COUNT(*) as c FROM skill_invocations GROUP BY source ORDER BY source")
			.all() as { source: string; c: number }[];
		expect(sources).toEqual([
			{ source: "cli", c: 1 },
			{ source: "scheduled-task", c: 1 },
		]);
	});

	it("stores task_id for scheduled-task invocations", () => {
		seed([{ id: "t1", skillName: "recall", taskId: "task-123", latencyMs: 100 }]);

		const row = db.prepare("SELECT task_id FROM skill_invocations WHERE id = 't1'").get() as { task_id: string };
		expect(row.task_id).toBe("task-123");
	});

	it("matches lowercase skill_name in queries (normalization)", () => {
		// Writes should always lowercase — verify reads match
		seed([
			{ id: "n1", skillName: "recall", latencyMs: 100 },
			{ id: "n2", skillName: "recall", latencyMs: 200 },
		]);

		// Query with different cases should all match lowercase-stored rows
		const exact = db
			.prepare("SELECT COUNT(*) as c FROM skill_invocations WHERE skill_name = ?")
			.get("recall") as { c: number };
		expect(exact.c).toBe(2);

		// Uppercase query would miss rows — this confirms writes must be lowercased
		const upper = db
			.prepare("SELECT COUNT(*) as c FROM skill_invocations WHERE skill_name = ?")
			.get("Recall") as { c: number };
		expect(upper.c).toBe(0);
	});

	it("filters by since cutoff", () => {
		const old = "2024-01-01T00:00:00.000Z";
		const recent = new Date().toISOString();

		const stmt = db.prepare(
			`INSERT INTO skill_invocations (id, skill_name, agent_id, source, latency_ms, success, created_at)
			 VALUES (?, ?, 'default', 'scheduled-task', ?, 1, ?)`,
		);
		stmt.run("old-1", "recall", 100, old);
		stmt.run("new-1", "recall", 200, recent);

		const all = db
			.prepare("SELECT COUNT(*) as c FROM skill_invocations WHERE agent_id = 'default'")
			.get() as { c: number };
		expect(all.c).toBe(2);

		const filtered = db
			.prepare(
				"SELECT COUNT(*) as c FROM skill_invocations WHERE agent_id = 'default' AND created_at >= datetime(?)",
			)
			.get("2025-01-01T00:00:00.000Z") as { c: number };
		expect(filtered.c).toBe(1);
	});

	it("validates isValidIsoDate helper logic", () => {
		const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
		function isValidIsoDate(value: string): boolean {
			if (!ISO_DATE_RE.test(value)) return false;
			const d = new Date(value);
			return !Number.isNaN(d.getTime());
		}

		expect(isValidIsoDate("2025-01-01T00:00:00Z")).toBe(true);
		expect(isValidIsoDate("2025-01-01")).toBe(true);
		expect(isValidIsoDate("2025-03-15T14:30:00+05:30")).toBe(true);
		expect(isValidIsoDate("not-a-date")).toBe(false);
		expect(isValidIsoDate("")).toBe(false);
		expect(isValidIsoDate("March 15, 2025")).toBe(false);
		expect(isValidIsoDate("15/03/2025")).toBe(false);
	});

	it("write path: records invocation with correct agent_id and normalized skill", () => {
		// Simulate the write path from worker.ts / daemon.ts
		const skillName = "Recall"; // mixed case — should be lowercased
		const agentId = "agent-x";
		const normalizedSkill = skillName.toLowerCase();
		const completedAt = new Date().toISOString();

		db.prepare(
			`INSERT INTO skill_invocations (id, skill_name, agent_id, source, task_id, latency_ms, success, error_text, created_at)
			 VALUES (?, ?, ?, 'scheduled-task', ?, ?, ?, ?, datetime(?))`,
		).run("sinv-write-1", normalizedSkill, agentId, "task-abc", 150, 1, null, completedAt);

		const row = db.prepare("SELECT * FROM skill_invocations WHERE id = 'sinv-write-1'").get() as Record<string, unknown>;
		expect(row.skill_name).toBe("recall");
		expect(row.agent_id).toBe("agent-x");
		expect(row.source).toBe("scheduled-task");
		expect(row.task_id).toBe("task-abc");
		expect(row.latency_ms).toBe(150);
		expect(row.success).toBe(1);
	});

	it("write path: agent-scoped reads match agent-scoped writes", () => {
		// Write under two different agents
		db.prepare(
			`INSERT INTO skill_invocations (id, skill_name, agent_id, source, latency_ms, success, created_at)
			 VALUES (?, ?, ?, 'api', 100, 1, datetime('now'))`,
		).run("sinv-a1", "recall", "agent-a");
		db.prepare(
			`INSERT INTO skill_invocations (id, skill_name, agent_id, source, latency_ms, success, created_at)
			 VALUES (?, ?, ?, 'api', 100, 1, datetime('now'))`,
		).run("sinv-b1", "recall", "agent-b");
		db.prepare(
			`INSERT INTO skill_invocations (id, skill_name, agent_id, source, latency_ms, success, created_at)
			 VALUES (?, ?, ?, 'api', 100, 1, datetime('now'))`,
		).run("sinv-b2", "recall", "agent-b");

		// Read scoped to agent-b should only see 2
		const result = db.prepare(
			"SELECT COUNT(*) as c FROM skill_invocations WHERE agent_id = ? AND skill_name = ?",
		).get("agent-b", "recall") as { c: number };
		expect(result.c).toBe(2);

		// Read scoped to agent-a should only see 1
		const resultA = db.prepare(
			"SELECT COUNT(*) as c FROM skill_invocations WHERE agent_id = ? AND skill_name = ?",
		).get("agent-a", "recall") as { c: number };
		expect(resultA.c).toBe(1);
	});
});
