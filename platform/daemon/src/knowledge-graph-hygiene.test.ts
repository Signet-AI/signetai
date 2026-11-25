import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "../../core/src/migrations";
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

	afterEach(async () => {
		await closeDbAccessor();
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
	function seedAspectWithAttributes(aspectId: string, entityId: string, name: string, count: number): void {
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO entity_aspects
				 (id, entity_id, agent_id, name, canonical_name, weight, created_at, updated_at)
				 VALUES (?, ?, 'default', ?, ?, 0.5, datetime('now'), datetime('now'))`,
			).run(aspectId, entityId, name, name.toLowerCase());
			for (let i = 0; i < count; i++) {
				db.prepare(
					`INSERT INTO entity_attributes
					 (id, aspect_id, agent_id, kind, content, normalized_content, confidence, importance,
					  status, group_key, claim_key, version, created_at, updated_at)
					 VALUES (?, ?, 'default', 'fact', ?, ?, 0.9, 0.5, 'active', 'general', ?, 1, datetime('now'), datetime('now'))`,
				).run(`attr-${aspectId}-${i}`, aspectId, `content ${i}`, `content ${i}`, `key-${i}`);
			}
		});
	}

	test("flags aspects over the attribute cap and entities over the aspect cap", () => {
		dbPath = makeDbPath();
		initDbAccessor(dbPath);
		seedEntity("fat-entity", "Fat Entity", 5);
		seedEntity("lean-entity", "Lean Entity", 5);
		seedAspectWithAttributes("fat-aspect", "fat-entity", "status_history", 7);
		seedAspectWithAttributes("lean-aspect", "lean-entity", "facts", 2);
		seedAspectWithAttributes("extra-aspect", "fat-entity", "extra", 1);

		const caps = { maxAspectsPerEntity: 1, maxAttributesPerAspect: 5 };
		const candidates = getDbAccessor().withReadDb((db) =>
			getDreamingHygieneCandidatesInDb(db, { agentId: "default", limit: 20, caps }),
		);

		expect(candidates).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					subjectRef: "aspect:fat-aspect",
					details: expect.objectContaining({
						reason: "attribute_over_cap",
						attributeCount: "7",
						maxAttributesPerAspect: "5",
					}),
				}),
				expect.objectContaining({
					subjectRef: "entity:fat-entity",
					details: expect.objectContaining({
						reason: "aspect_over_cap",
						aspectCount: "2",
						maxAspectsPerEntity: "1",
					}),
				}),
			]),
		);
		expect(candidates.some((candidate) => candidate.subjectRef === "aspect:lean-aspect")).toBe(false);
		expect(candidates.some((candidate) => candidate.subjectRef === "entity:lean-entity")).toBe(false);
	});

	test("does not emit over-cap candidates when caps are omitted (backward compat)", () => {
		dbPath = makeDbPath();
		initDbAccessor(dbPath);
		seedEntity("fat-entity", "Fat Entity", 5);
		seedAspectWithAttributes("fat-aspect", "fat-entity", "status_history", 7);

		const candidates = getDbAccessor().withReadDb((db) =>
			getDreamingHygieneCandidatesInDb(db, { agentId: "default", limit: 20 }),
		);
		expect(candidates.some((candidate) => candidate.details.reason === "attribute_over_cap")).toBe(false);
		expect(candidates.some((candidate) => candidate.details.reason === "aspect_over_cap")).toBe(false);
	});
});

describe("Dreaming hygiene exact compartments", () => {
	test("preserves structural people while ordinary external people remain hygiene candidates", () => {
		const db = new Database(":memory:");
		try {
			runMigrations(db);
			db.exec(
				"INSERT INTO entities(id, agent_id, name, canonical_name, entity_type, person_user_id, mentions, created_at, updated_at) VALUES ('structural', 'default', 'Alice', 'alice', 'person', 'usr_alice', 0, datetime('now'), datetime('now')), ('external', 'default', 'External Author', 'external author', 'person', NULL, 0, datetime('now'), datetime('now'))",
			);
			const candidates = getDreamingHygieneCandidatesInDb(db, { agentId: "default", limit: 100 });
			expect(candidates.some((candidate) => candidate.subjectRef === "entity:structural")).toBe(false);
			expect(candidates.some((candidate) => candidate.subjectRef === "entity:external")).toBe(true);
		} finally {
			db.close();
		}
	});

	test("hidden rows cannot change candidates, caps, duplicate membership or bounded selection", () => {
		const db = new Database(":memory:");
		try {
			runMigrations(db);
			db.exec(
				"INSERT INTO compartments (id, key, created_at) VALUES (1, 'private', datetime('now')), (2, 'other', datetime('now'))",
			);
			const seed = (prefix: string, compartmentId: number | null): void => {
				for (const suffix of ["first", "second", "husk"]) {
					db.prepare(`INSERT INTO entities (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at, compartment_id)
					 VALUES (?, ?, ?, 'project', 'default', 5, '2026-01-01', '2026-01-01', ?)`).run(
						`${prefix}${suffix}`,
						`${prefix}${suffix}`,
						suffix === "husk" ? "husk" : "duplicate",
						compartmentId,
					);
				}
				for (const suffix of ["general", "extra"]) {
					db.prepare(`INSERT INTO entity_aspects (id, entity_id, agent_id, name, canonical_name, created_at, updated_at, compartment_id)
					 VALUES (?, ?, 'default', ?, ?, '2026-01-01', '2026-01-01', ?)`).run(
						`${prefix}${suffix}`,
						`${prefix}first`,
						suffix,
						suffix,
						compartmentId,
					);
				}
				for (let index = 0; index < 2; index++) {
					db.prepare(`INSERT INTO entity_attributes (id, aspect_id, agent_id, kind, content, normalized_content, status, claim_key, created_at, updated_at, compartment_id)
					 VALUES (?, ?, 'default', 'attribute', 'claim', 'claim', 'active', '', '2026-01-01', '2026-01-01', ?)`).run(
						`${prefix}claim${index}`,
						`${prefix}general`,
						compartmentId,
					);
				}
				db.prepare(`INSERT INTO entity_dependencies (id, source_entity_id, target_entity_id, agent_id, dependency_type, strength, reason, status, created_at, updated_at, compartment_id)
				 VALUES (?, ?, ?, 'default', 'related_to', 0.2, 'generic', 'active', '2026-01-01', '2026-01-01', ?)`).run(
					`${prefix}link`,
					`${prefix}first`,
					`${prefix}second`,
					compartmentId,
				);
			};
			const caps = { maxAspectsPerEntity: 1, maxAttributesPerAspect: 1 };
			seed("visible-", null);
			const baseline = getDreamingHygieneCandidatesInDb(db, { agentId: "default", limit: 100, caps });
			const bounded = getDreamingHygieneCandidatesInDb(db, { agentId: "default", limit: 1, caps });
			expect(baseline.map((candidate) => candidate.details.reason)).toEqual(
				expect.arrayContaining([
					"attribute_over_cap",
					"aspect_over_cap",
					"zero_active_attributes",
					"missing_claim_key",
					"duplicate_canonical_name",
					"generic_related_to",
				]),
			);
			seed("hidden-", 1);
			const classified = getDreamingHygieneCandidatesInDb(db, {
				agentId: "default",
				limit: 100,
				caps,
				compartmentId: 1,
			});
			expect(classified).toEqual(
				baseline.map((candidate) => ({
					...candidate,
					subjectRef: candidate.subjectRef.replaceAll("visible-", "hidden-"),
					details:
						candidate.details.reason === "duplicate_canonical_name"
							? expect.objectContaining({ count: "2", reason: "duplicate_canonical_name" })
							: Object.fromEntries(
									Object.entries(candidate.details).map(([key, value]) => [
										key,
										value.replaceAll("visible-", "hidden-"),
									]),
								),
				})),
			);
			seed("other-", 2);
			db.exec(
				"UPDATE entity_aspects SET entity_id = 'visible-husk' WHERE id = 'other-general'; UPDATE entity_attributes SET aspect_id = 'visible-general' WHERE id = 'other-claim1'; UPDATE entity_dependencies SET target_entity_id = 'visible-first' WHERE id = 'other-link'",
			);
			expect(getDreamingHygieneCandidatesInDb(db, { agentId: "default", limit: 100, caps })).toEqual(baseline);
			expect(getDreamingHygieneCandidatesInDb(db, { agentId: "default", limit: 1, caps })).toEqual(bounded);
			expect(getDreamingHygieneCandidatesInDb(db, { agentId: "default", limit: 100, caps, compartmentId: 1 })).toEqual(
				classified,
			);
		} finally {
			db.close();
		}
	});
});
