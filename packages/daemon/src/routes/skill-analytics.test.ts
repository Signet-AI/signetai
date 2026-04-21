import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { runMigrations } from "../../../core/src/migrations";
import { querySkillAnalytics } from "./skill-analytics.js";

function seedSkills(db: Database, rows: ReadonlyArray<{ id: string; name: string; agentId?: string }>): void {
	const entity = db.prepare(
		`INSERT INTO entities
		 (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at)
		 VALUES (?, ?, ?, 'skill', ?, 1, datetime('now'), datetime('now'))`,
	);
	const meta = db.prepare(
		`INSERT INTO skill_meta
		 (entity_id, agent_id, source, installed_at, fs_path)
		 VALUES (?, ?, 'signet', datetime('now'), ?)`,
	);

	for (const row of rows) {
		entity.run(row.id, row.name, row.name.toLowerCase(), row.agentId ?? "default");
		meta.run(row.id, row.agentId ?? "default", `/tmp/skills/${row.name}/SKILL.md`);
	}
}

function seedInvocations(
	db: Database,
	rows: ReadonlyArray<{
		id: string;
		skillName: string;
		agentId?: string;
		source?: string;
		latencyMs: number;
		success?: boolean;
		errorText?: string;
		createdAt?: string;
	}>,
): void {
	const stmt = db.prepare(
		`INSERT INTO skill_invocations
		 (id, skill_name, agent_id, source, latency_ms, success, error_text, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
	);

	for (const row of rows) {
		stmt.run(
			row.id,
			row.skillName,
			row.agentId ?? "default",
			row.source ?? "agent",
			row.latencyMs,
			(row.success ?? true) ? 1 : 0,
			row.errorText ?? null,
			row.createdAt ?? new Date().toISOString(),
		);
	}
}

describe("skill analytics", () => {
	let db: Database;

	beforeEach(() => {
		db = new Database(":memory:");
		runMigrations(db as unknown as Parameters<typeof runMigrations>[0]);
	});

	afterEach(() => {
		db.close();
	});

	it("aggregates top skills by invocation count", () => {
		seedSkills(db, [
			{ id: "skill-1", name: "browser-use" },
			{ id: "skill-2", name: "web-search" },
		]);
		seedInvocations(db, [
			{ id: "inv-1", skillName: "browser-use", latencyMs: 150 },
			{ id: "inv-2", skillName: "browser-use", latencyMs: 250 },
			{ id: "inv-3", skillName: "web-search", latencyMs: 100, success: false, errorText: "oops" },
		]);

		const result = querySkillAnalytics(db, {
			agentId: "default",
			limit: 10,
		});

		expect(result.totalCalls).toBe(3);
		expect(result.successRate).toBeCloseTo(0.667, 3);
		expect(result.topSkills[0]?.skillName).toBe("browser-use");
		expect(result.topSkills[0]?.count).toBe(2);
		expect(result.topSkills[0]?.avgLatencyMs).toBe(200);
		expect(result.topSkills[1]?.skillName).toBe("web-search");
		expect(result.latency.p50).toBe(150);
		expect(result.latency.p95).toBe(250);
	});

	it("scopes analytics by agent_id", () => {
		seedSkills(db, [
			{ id: "skill-a", name: "browser-use-a", agentId: "agent-a" },
			{ id: "skill-b", name: "browser-use-b", agentId: "agent-b" },
		]);
		seedInvocations(db, [
			{ id: "inv-a", skillName: "browser-use-a", agentId: "agent-a", latencyMs: 100 },
			{ id: "inv-b1", skillName: "browser-use-b", agentId: "agent-b", latencyMs: 200 },
			{ id: "inv-b2", skillName: "browser-use-b", agentId: "agent-b", latencyMs: 300 },
		]);

		const result = querySkillAnalytics(db, {
			agentId: "agent-a",
			limit: 10,
		});

		expect(result.totalCalls).toBe(1);
		expect(result.topSkills[0]?.count).toBe(1);
		expect(result.latency.p50).toBe(100);
	});

	it("applies the since filter", () => {
		seedSkills(db, [{ id: "skill-1", name: "browser-use" }]);
		seedInvocations(db, [
			{ id: "inv-old", skillName: "browser-use", latencyMs: 100, createdAt: "2025-01-01T00:00:00Z" },
			{ id: "inv-new", skillName: "browser-use", latencyMs: 200, createdAt: "2025-06-15T12:00:00Z" },
		]);

		const result = querySkillAnalytics(db, {
			agentId: "default",
			since: "2025-06-01T00:00:00Z",
			limit: 10,
		});

		expect(result.totalCalls).toBe(1);
		expect(result.topSkills[0]?.count).toBe(1);
		expect(result.latency.p50).toBe(200);
	});
});
