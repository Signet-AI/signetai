import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { runMigrations } from "../../../core/src/migrations";

/**
 * Tests for skill invocation analytics SQL patterns.
 * Uses in-memory SQLite with migrations applied.
 */

function seedInvocations(
	db: Database,
	rows: ReadonlyArray<{
		id: string;
		skillName: string;
		agentId?: string;
		source?: string;
		latencyMs: number;
		success?: boolean;
		createdAt?: string;
	}>,
): void {
	const stmt = db.prepare(
		`INSERT INTO skill_invocations (id, skill_name, agent_id, source, latency_ms, success, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
	);
	for (const row of rows) {
		stmt.run(
			row.id,
			row.skillName,
			row.agentId ?? "default",
			row.source ?? "scheduled-task",
			row.latencyMs,
			(row.success ?? true) ? 1 : 0,
			row.createdAt ?? new Date().toISOString(),
		);
	}
}

// Builtin skills that should be excluded from analytics
const BUILTIN_SKILLS = ["remember", "recall", "memory-debug", "onboarding", "signet"];

describe("skill analytics SQL patterns", () => {
	let db: Database;

	beforeEach(() => {
		db = new Database(":memory:");
		runMigrations(db);
	});

	afterEach(() => {
		if (db) db.close();
	});

	it("returns empty totals when no invocations", () => {
		const totals = db
			.prepare(
				"SELECT COUNT(*) as total, COALESCE(SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END), 0) as successes FROM skill_invocations WHERE agent_id = ?",
			)
			.get("default") as { total: number; successes: number };
		expect(totals.total).toBe(0);
	});

	it("aggregates skill usage correctly", () => {
		seedInvocations(db, [
			{ id: "s1", skillName: "signet-coding-copilot", latencyMs: 1000 },
			{ id: "s2", skillName: "signet-coding-copilot", latencyMs: 2000 },
			{ id: "s3", skillName: "signet-design", latencyMs: 500, success: false },
		]);

		const total = db.prepare("SELECT COUNT(*) as c FROM skill_invocations WHERE agent_id = 'default'").get() as {
			c: number;
		};
		expect(total.c).toBe(3);

		const topSkills = db
			.prepare(
				`SELECT skill_name, COUNT(*) as count,
				        SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as successCount,
				        CAST(AVG(latency_ms) AS INTEGER) as avgLatencyMs
				 FROM skill_invocations WHERE agent_id = 'default'
				 GROUP BY skill_name ORDER BY count DESC`,
			)
			.all() as Array<{ skill_name: string; count: number; successCount: number; avgLatencyMs: number }>;

		expect(topSkills.length).toBe(2);
		expect(topSkills[0].skill_name).toBe("signet-coding-copilot");
		expect(topSkills[0].count).toBe(2);
		expect(topSkills[1].skill_name).toBe("signet-design");
		expect(topSkills[1].successCount).toBe(0);
	});

	it("excludes builtin skills from analytics", () => {
		seedInvocations(db, [
			{ id: "s1", skillName: "remember", latencyMs: 100 },
			{ id: "s2", skillName: "recall", latencyMs: 200 },
			{ id: "s3", skillName: "signet", latencyMs: 300 },
			{ id: "s4", skillName: "memory-debug", latencyMs: 400 },
			{ id: "s5", skillName: "onboarding", latencyMs: 500 },
			{ id: "s6", skillName: "signet-coding-copilot", latencyMs: 1000 },
		]);

		const placeholders = BUILTIN_SKILLS.map(() => "?").join(", ");
		const results = db
			.prepare(
				`SELECT skill_name, COUNT(*) as count FROM skill_invocations
				 WHERE agent_id = 'default' AND LOWER(skill_name) NOT IN (${placeholders})
				 GROUP BY skill_name ORDER BY count DESC`,
			)
			.all(...BUILTIN_SKILLS) as Array<{ skill_name: string; count: number }>;

		expect(results.length).toBe(1);
		expect(results[0].skill_name).toBe("signet-coding-copilot");
	});

	it("computes latency percentiles", () => {
		seedInvocations(db, [
			{ id: "s1", skillName: "copilot", latencyMs: 100 },
			{ id: "s2", skillName: "copilot", latencyMs: 200 },
			{ id: "s3", skillName: "copilot", latencyMs: 300 },
			{ id: "s4", skillName: "copilot", latencyMs: 400 },
			{ id: "s5", skillName: "copilot", latencyMs: 5000 },
		]);

		const latencies = db
			.prepare("SELECT latency_ms FROM skill_invocations WHERE agent_id = 'default' ORDER BY latency_ms")
			.all() as Array<{ latency_ms: number }>;

		const sorted = latencies.map((r) => r.latency_ms);
		const p50Idx = Math.ceil((50 / 100) * sorted.length) - 1;
		const p95Idx = Math.ceil((95 / 100) * sorted.length) - 1;

		expect(sorted[p50Idx]).toBe(300);
		expect(sorted[p95Idx]).toBe(5000);
	});

	it("filters by date range", () => {
		seedInvocations(db, [
			{ id: "s1", skillName: "copilot", latencyMs: 100, createdAt: "2026-03-01T00:00:00Z" },
			{ id: "s2", skillName: "copilot", latencyMs: 200, createdAt: "2026-03-29T00:00:00Z" },
		]);

		const recent = db
			.prepare("SELECT COUNT(*) as c FROM skill_invocations WHERE agent_id = 'default' AND created_at >= datetime(?)")
			.get("2026-03-28T00:00:00Z") as { c: number };

		expect(recent.c).toBe(1);
	});

	it("scopes by agent_id", () => {
		seedInvocations(db, [
			{ id: "s1", skillName: "copilot", latencyMs: 100, agentId: "agent-a" },
			{ id: "s2", skillName: "copilot", latencyMs: 200, agentId: "agent-b" },
			{ id: "s3", skillName: "copilot", latencyMs: 300, agentId: "agent-a" },
		]);

		const agentA = db.prepare("SELECT COUNT(*) as c FROM skill_invocations WHERE agent_id = 'agent-a'").get() as {
			c: number;
		};
		expect(agentA.c).toBe(2);

		const agentB = db.prepare("SELECT COUNT(*) as c FROM skill_invocations WHERE agent_id = 'agent-b'").get() as {
			c: number;
		};
		expect(agentB.c).toBe(1);
	});
});
