import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "./db-accessor";
import { getKnowledgeHygieneReport } from "./knowledge-graph-hygiene";

function makeDbPath(): string {
	const dir = join(tmpdir(), `signet-kg-hygiene-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	return join(dir, "memories.db");
}

function seedEntity(id: string, name: string, mentions = 1): void {
	const now = "2026-04-19T00:00:00.000Z";
	getDbAccessor().withWriteTx((db) => {
		db.prepare(
			`INSERT INTO entities
			 (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at)
			 VALUES (?, ?, ?, 'concept', 'default', ?, ?, ?)`,
		).run(id, name, name.toLowerCase(), mentions, now, now);
	});
}

function seedMemory(id: string, content: string): void {
	const now = "2026-04-19T00:00:00.000Z";
	getDbAccessor().withWriteTx((db) => {
		db.prepare(
			`INSERT INTO memories
			 (id, content, type, agent_id, updated_by, created_at, updated_at, is_deleted)
			 VALUES (?, ?, 'fact', 'default', 'test', ?, ?, 0)`,
		).run(id, content, now, now);
	});
}

describe("knowledge graph hygiene report", () => {
	let dbPath = "";

	afterEach(() => {
		closeDbAccessor();
		if (dbPath) {
			const dir = join(dbPath, "..");
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		}
		dbPath = "";
	});

	test("reports suspicious entities and safe mention candidates without mutating", () => {
		dbPath = makeDbPath();
		initDbAccessor(dbPath);
		seedEntity("entity-signet", "Signet", 5);
		seedEntity("entity-the", "The", 1);
		seedMemory("mem-1", "Signet should keep graph repair mechanical.");

		const report = getKnowledgeHygieneReport(getDbAccessor(), {
			agentId: "default",
			limit: 10,
			memoryLimit: 10,
		});

		expect(report.suspiciousEntities.some((entity) => entity.id === "entity-the")).toBe(true);
		expect(report.safeMentionCandidates).toEqual([
			{
				memoryId: "mem-1",
				entityId: "entity-signet",
				entityName: "Signet",
				mentionText: "Signet",
				snippet: "Signet should keep graph repair mechanical.",
			},
		]);

		const mentions = getDbAccessor().withReadDb(
			(db) => db.prepare("SELECT COUNT(*) AS count FROM memory_entity_mentions").get() as { count: number },
		);
		expect(mentions.count).toBe(0);
	});
});
