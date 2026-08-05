import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "./db-accessor";
import {
	ZERO_ACTIVE_ATTRIBUTE_ENTITIES_SQL,
	getDreamingHygieneCandidatesInDb,
	getKnowledgeHygieneReport,
} from "./knowledge-graph-hygiene";

function makeDbPath(): string {
	const dir = join(tmpdir(), `signet-kg-hygiene-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	return join(dir, "memories.db");
}

function seedEntity(id: string, name: string, mentions = 1, entityType = "project"): void {
	const now = "2026-04-19T00:00:00.000Z";
	getDbAccessor().withWriteTx((db) => {
		db.prepare(
			`INSERT INTO entities
			 (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at)
			 VALUES (?, ?, ?, ?, 'default', ?, ?, ?)`,
		).run(id, name, name.toLowerCase(), entityType, mentions, now, now);
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

	test("finds bounded, source-topology-free cleanup candidates for Dreaming attention", () => {
		dbPath = makeDbPath();
		initDbAccessor(dbPath);
		seedEntity("husk", "Legacy Husk", 5);
		seedEntity("pinned-husk", "Pinned legacy husk", 5);
		seedEntity("source-doc", "README", 0, "source_document");
		seedEntity("linked", "Linked", 1);
		getDbAccessor().withWriteTx((db) => {
			db.prepare("UPDATE entities SET pinned = 1 WHERE id = 'pinned-husk'").run();
			db.prepare(
				`INSERT INTO entity_aspects
				 (id, entity_id, agent_id, name, canonical_name, weight, created_at, updated_at)
				 VALUES ('generic-aspect', 'linked', 'default', 'General', 'general', 0.5, datetime('now'), datetime('now'))`,
			).run();
			db.prepare(
				`INSERT INTO entity_attributes
				 (id, aspect_id, agent_id, kind, content, normalized_content, confidence, importance,
				  status, group_key, claim_key, version, created_at, updated_at)
				 VALUES ('missing-key', 'generic-aspect', 'default', 'attribute', 'Linked has stale metadata.',
				  'linked has stale metadata.', 0.8, 0.5, 'active', 'general', '', 1, datetime('now'), datetime('now'))`,
			).run();
			db.prepare(
				`INSERT INTO entity_dependencies
				 (id, source_entity_id, target_entity_id, agent_id, dependency_type, strength, reason, status, created_at, updated_at)
				 VALUES ('generic-link', 'linked', 'husk', 'default', 'related_to', 0.2, 'legacy catch-all', 'active', datetime('now'), datetime('now'))`,
			).run();
		});

		const candidates = getDbAccessor().withReadDb((db) =>
			getDreamingHygieneCandidatesInDb(db, { agentId: "default", limit: 20 }),
		);
		expect(candidates).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					subjectRef: "entity:husk",
					details: expect.objectContaining({ reason: "zero_active_attributes" }),
				}),
				expect.objectContaining({
					subjectRef: "aspect:generic-aspect",
					details: expect.objectContaining({ reason: "generic_aspect" }),
				}),
				expect.objectContaining({
					subjectRef: "attribute:missing-key",
					details: expect.objectContaining({ reason: "missing_claim_key" }),
				}),
				expect.objectContaining({
					subjectRef: "link:generic-link",
					details: expect.objectContaining({ reason: "generic_related_to" }),
				}),
			]),
		);
		expect(candidates.some((candidate) => candidate.subjectRef === "entity:source-doc")).toBe(false);
		expect(candidates.some((candidate) => candidate.subjectRef === "entity:pinned-husk")).toBe(false);
	});

	test("zero-active-attribute detector probes per-entity aspects, not an agent-wide attribute scan (#1094)", () => {
		// Regression: the detector's NOT EXISTS used a flat
		// entity_aspects JOIN entity_attributes, which let the planner root
		// the subquery in entity_attributes by agent_id alone. On a large
		// install that made the dreaming worker's first check
		// O(entities × attributes) — 200s+ on a 30k-entity/72k-attribute
		// graph — blocking the daemon's event loop minutes after restart.
		// The subquery must drive from entity_aspects (agent_id, entity_id)
		// and probe attributes per aspect.
		dbPath = makeDbPath();
		initDbAccessor(dbPath);
		seedEntity("husk", "Legacy Husk", 5);

		const plan = getDbAccessor().withReadDb((db) => {
			const rows = db.prepare(`EXPLAIN QUERY PLAN ${ZERO_ACTIVE_ATTRIBUTE_ENTITIES_SQL}`).all() as Array<{
				detail: string;
			}>;
			return rows.map((row) => row.detail).join("\n");
		});

		expect(plan).toContain("SEARCH asp USING INDEX idx_entity_aspects_status (agent_id=? AND entity_id=?)");
		expect(plan).not.toContain("SEARCH attr USING INDEX idx_entity_attributes_claim_version (agent_id=?)");
	});
});
