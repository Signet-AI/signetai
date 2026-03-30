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
});
