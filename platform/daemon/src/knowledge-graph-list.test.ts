/**
 * Regression tests for the paginated-ID rewrites of
 * `listKnowledgeEntities`, `getKnowledgeEntityDetail`, and
 * `getKnowledgeStats`. See Signet-AI/signetai#515.
 *
 * These seed a small graph (2 agents, mixed aspects/attributes/dependencies)
 * and assert counts + ordering match expected values. They'd fail if the
 * scalar subqueries drift from the original GROUP BY semantics.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "./db-accessor";
import {
	archiveEntityAlias,
	createEntityAlias,
	getDependenciesFrom,
	getDependenciesTo,
	getKnowledgeEntityDetail,
	getKnowledgeGraphForConstellation,
	getKnowledgeStats,
	listEntityAliases,
	listKnowledgeEntities,
} from "./knowledge-graph";

function makeDbPath(): string {
	const dir = join(tmpdir(), `signet-kg-list-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	return join(dir, "memories.db");
}

function seedEntity(
	id: string,
	name: string,
	opts: {
		entityType?: string;
		agentId?: string;
		mentions?: number;
		pinned?: boolean;
		pinnedAt?: string | null;
		updatedAt?: string;
	} = {},
): void {
	const agentId = opts.agentId ?? "default";
	const entityType = opts.entityType ?? "concept";
	const mentions = opts.mentions ?? 1;
	const pinned = opts.pinned ? 1 : 0;
	const pinnedAt = opts.pinnedAt ?? null;
	const updatedAt = opts.updatedAt ?? new Date().toISOString();
	getDbAccessor().withWriteTx((db) => {
		db.prepare(
			`INSERT INTO entities
			 (id, name, entity_type, canonical_name, mentions, agent_id, pinned, pinned_at, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(id, name, entityType, name.toLowerCase(), mentions, agentId, pinned, pinnedAt, updatedAt, updatedAt);
	});
}

function seedAspect(id: string, entityId: string, name: string, agentId = "default"): void {
	const now = new Date().toISOString();
	getDbAccessor().withWriteTx((db) => {
		db.prepare(
			`INSERT INTO entity_aspects
			 (id, entity_id, agent_id, name, canonical_name, weight, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, 0.5, ?, ?)`,
		).run(id, entityId, agentId, name, name.toLowerCase(), now, now);
	});
}

function seedAttribute(
	id: string,
	aspectId: string,
	opts: {
		agentId?: string;
		kind?: "attribute" | "constraint";
		status?: "active" | "superseded";
		content?: string;
		memoryId?: string | null;
	} = {},
): void {
	const agentId = opts.agentId ?? "default";
	const kind = opts.kind ?? "attribute";
	const status = opts.status ?? "active";
	const content = opts.content ?? `content-${id}`;
	const memoryId = opts.memoryId ?? null;
	const now = new Date().toISOString();
	getDbAccessor().withWriteTx((db) => {
		db.prepare(
			`INSERT INTO entity_attributes
			 (id, aspect_id, agent_id, memory_id, kind, content, normalized_content,
			  confidence, importance, status, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, 0.8, 0.5, ?, ?, ?)`,
		).run(id, aspectId, agentId, memoryId, kind, content, content.toLowerCase(), status, now, now);
	});
}

function seedDependency(
	id: string,
	sourceId: string,
	targetId: string,
	opts: { agentId?: string; type?: string; strength?: number } = {},
): void {
	const agentId = opts.agentId ?? "default";
	const type = opts.type ?? "depends_on";
	const strength = opts.strength ?? 0.5;
	const now = new Date().toISOString();
	getDbAccessor().withWriteTx((db) => {
		db.prepare(
			`INSERT INTO entity_dependencies
			 (id, source_entity_id, target_entity_id, agent_id, dependency_type, strength, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(id, sourceId, targetId, agentId, type, strength, now, now);
	});
}

function seedMemory(id: string, agentId = "default"): void {
	const now = new Date().toISOString();
	getDbAccessor().withWriteTx((db) => {
		db.prepare(
			`INSERT INTO memories
			 (id, content, type, agent_id, updated_by, created_at, updated_at, is_deleted)
			 VALUES (?, ?, 'fact', ?, 'test', ?, ?, 0)`,
		).run(id, `content-${id}`, agentId, now, now);
	});
}

function seedAgent(id: string, readPolicy: "isolated" | "shared"): void {
	const now = new Date().toISOString();
	getDbAccessor().withWriteTx((db) => {
		db.prepare(
			`INSERT INTO agents (id, name, read_policy, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?)
			 ON CONFLICT(id) DO UPDATE SET read_policy = excluded.read_policy, updated_at = excluded.updated_at`,
		).run(id, id, readPolicy, now, now);
	});
}

function seedMention(memoryId: string, entityId: string): void {
	getDbAccessor().withWriteTx((db) => {
		db.prepare(
			`INSERT INTO memory_entity_mentions
			 (memory_id, entity_id)
			 VALUES (?, ?)`,
		).run(memoryId, entityId);
	});
}

describe("listKnowledgeEntities (issue #515)", () => {
	let dbPath = "";

	afterEach(() => {
		closeDbAccessor();
		if (dbPath) {
			const dir = join(dbPath, "..");
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		}
		dbPath = "";
	});

	test("returns entities in the documented order (pinned, pinned_at, mentions, updated_at, name)", () => {
		dbPath = makeDbPath();
		initDbAccessor(dbPath);

		seedEntity("e-alpha", "Alpha", { mentions: 3, updatedAt: "2026-01-01T00:00:00Z" });
		seedEntity("e-beta", "Beta", { mentions: 10, updatedAt: "2026-02-01T00:00:00Z" });
		seedEntity("e-gamma", "Gamma", {
			mentions: 5,
			pinned: true,
			pinnedAt: "2026-03-15T00:00:00Z",
			updatedAt: "2026-01-10T00:00:00Z",
		});

		const result = listKnowledgeEntities(getDbAccessor(), {
			agentId: "default",
			limit: 10,
			offset: 0,
		});

		expect(result.map((r) => r.entity.id)).toEqual(["e-gamma", "e-beta", "e-alpha"]);
	});

	test("counts aspects, attributes, constraints, and dependencies (incoming + outgoing) per entity", () => {
		dbPath = makeDbPath();
		initDbAccessor(dbPath);

		seedEntity("e-hub", "Hub", { mentions: 5 });
		seedEntity("e-leaf", "Leaf", { mentions: 1 });
		seedAspect("asp-1", "e-hub", "capability");
		seedAspect("asp-2", "e-hub", "dependency");
		seedAttribute("attr-1", "asp-1", { kind: "attribute", status: "active" });
		seedAttribute("attr-2", "asp-1", { kind: "attribute", status: "active" });
		// Superseded attribute should not be counted
		seedAttribute("attr-3", "asp-1", { kind: "attribute", status: "superseded" });
		seedAttribute("attr-4", "asp-2", { kind: "constraint", status: "active" });
		// Dependency where hub is source
		seedDependency("dep-1", "e-hub", "e-leaf");
		// Dependency where hub is target (inbound) — should also count
		seedDependency("dep-2", "e-leaf", "e-hub");

		const result = listKnowledgeEntities(getDbAccessor(), {
			agentId: "default",
			limit: 10,
			offset: 0,
		});

		const hub = result.find((r) => r.entity.id === "e-hub");
		expect(hub).toBeDefined();
		expect(hub?.aspectCount).toBe(2);
		expect(hub?.attributeCount).toBe(2);
		expect(hub?.constraintCount).toBe(1);
		expect(hub?.dependencyCount).toBe(2);
	});

	test("excludes archived graph rows from default list counts", () => {
		dbPath = makeDbPath();
		initDbAccessor(dbPath);

		seedEntity("e-active", "Active", { mentions: 5 });
		seedEntity("e-archived", "Archived", { mentions: 10 });
		seedAspect("asp-active", "e-active", "capability");
		seedAspect("asp-archived", "e-active", "retired");
		seedAttribute("attr-active", "asp-active", { kind: "attribute" });
		seedAttribute("constraint-archived-aspect", "asp-archived", { kind: "constraint" });
		seedDependency("dep-archived", "e-active", "e-archived");
		getDbAccessor().withWriteTx((db) => {
			db.prepare("UPDATE entities SET status = 'archived' WHERE id = ?").run("e-archived");
			db.prepare("UPDATE entity_aspects SET status = 'archived' WHERE id = ?").run("asp-archived");
		});

		const result = listKnowledgeEntities(getDbAccessor(), {
			agentId: "default",
			limit: 10,
			offset: 0,
		});

		expect(result.map((item) => item.entity.id)).toEqual(["e-active"]);
		expect(result[0]?.aspectCount).toBe(1);
		expect(result[0]?.attributeCount).toBe(1);
		expect(result[0]?.constraintCount).toBe(0);
		expect(result[0]?.dependencyCount).toBe(0);
	});

	test("dependency reads hide edges attached to archived endpoint entities", () => {
		dbPath = makeDbPath();
		initDbAccessor(dbPath);

		seedEntity("e-active", "Active");
		seedEntity("e-archived", "Archived");
		seedEntity("e-other", "Other");
		seedDependency("dep-hidden-target", "e-active", "e-archived");
		seedDependency("dep-hidden-source", "e-archived", "e-active");
		seedDependency("dep-visible-out", "e-active", "e-other");
		seedDependency("dep-visible-in", "e-other", "e-active");
		getDbAccessor().withWriteTx((db) => {
			db.prepare("UPDATE entities SET status = 'archived' WHERE id = ?").run("e-archived");
		});

		expect(getDependenciesFrom(getDbAccessor(), "e-active", "default").map((dep) => dep.id)).toEqual([
			"dep-visible-out",
		]);
		expect(getDependenciesTo(getDbAccessor(), "e-active", "default").map((dep) => dep.id)).toEqual(["dep-visible-in"]);
	});

	test("respects limit and offset pagination", () => {
		dbPath = makeDbPath();
		initDbAccessor(dbPath);
		for (let i = 0; i < 5; i++) {
			seedEntity(`e-${i}`, `Name-${i}`, { mentions: 10 - i, updatedAt: "2026-01-01T00:00:00Z" });
		}

		const page1 = listKnowledgeEntities(getDbAccessor(), { agentId: "default", limit: 2, offset: 0 });
		const page2 = listKnowledgeEntities(getDbAccessor(), { agentId: "default", limit: 2, offset: 2 });

		expect(page1.map((r) => r.entity.id)).toEqual(["e-0", "e-1"]);
		expect(page2.map((r) => r.entity.id)).toEqual(["e-2", "e-3"]);
	});

	test("filters by type and query (canonical_name LIKE)", () => {
		dbPath = makeDbPath();
		initDbAccessor(dbPath);

		seedEntity("e-proj-1", "Muse", { entityType: "project" });
		seedEntity("e-proj-2", "XLNT", { entityType: "project" });
		seedEntity("e-concept-1", "Muse Pipeline", { entityType: "concept" });

		const projectsOnly = listKnowledgeEntities(getDbAccessor(), {
			agentId: "default",
			type: "project",
			limit: 10,
			offset: 0,
		});
		expect(projectsOnly.map((r) => r.entity.id).sort()).toEqual(["e-proj-1", "e-proj-2"]);

		const museMatches = listKnowledgeEntities(getDbAccessor(), {
			agentId: "default",
			query: "muse",
			limit: 10,
			offset: 0,
		});
		expect(museMatches.map((r) => r.entity.id).sort()).toEqual(["e-concept-1", "e-proj-1"]);
	});

	test("agent scoping isolates entities across agent_id values", () => {
		dbPath = makeDbPath();
		initDbAccessor(dbPath);

		seedEntity("e-main", "Main-scoped", { agentId: "main" });
		seedEntity("e-def", "Default-scoped", { agentId: "default" });

		const mainScope = listKnowledgeEntities(getDbAccessor(), { agentId: "main", limit: 10, offset: 0 });
		const defaultScope = listKnowledgeEntities(getDbAccessor(), { agentId: "default", limit: 10, offset: 0 });

		expect(mainScope.map((r) => r.entity.id)).toEqual(["e-main"]);
		expect(defaultScope.map((r) => r.entity.id)).toEqual(["e-def"]);
	});

	test("entity alias archive is scoped to the owning entity", () => {
		dbPath = makeDbPath();
		initDbAccessor(dbPath);

		seedEntity("e-signet", "Signet");
		seedEntity("e-other", "Other");
		const alias = createEntityAlias(getDbAccessor(), {
			agentId: "default",
			entityId: "e-signet",
			alias: "SignetAI",
			source: "test",
		});

		const wrongEntity = archiveEntityAlias(getDbAccessor(), {
			agentId: "default",
			entityId: "e-other",
			aliasId: alias.id,
		});
		expect(wrongEntity).toBeNull();
		expect(listEntityAliases(getDbAccessor(), { agentId: "default", entityId: "e-signet" })).toHaveLength(1);

		const archived = archiveEntityAlias(getDbAccessor(), {
			agentId: "default",
			entityId: "e-signet",
			aliasId: alias.id,
		});
		expect(archived?.status).toBe("archived");
		expect(listEntityAliases(getDbAccessor(), { agentId: "default", entityId: "e-signet" })).toHaveLength(0);
	});

	test("builds a bounded constellation graph without loading every graph row", () => {
		dbPath = makeDbPath();
		initDbAccessor(dbPath);

		seedEntity("e-hub", "Hub", { mentions: 10 });
		seedEntity("e-leaf", "Leaf", { mentions: 9 });
		seedEntity("e-hidden", "Hidden", { mentions: 0 });
		seedAspect("asp-hub-a", "e-hub", "alpha");
		seedAspect("asp-hub-b", "e-hub", "beta");
		seedAspect("asp-hidden", "e-hidden", "hidden");
		seedAttribute("attr-hub-a-1", "asp-hub-a", { content: "important alpha", memoryId: "mem-a" });
		seedAttribute("attr-hub-a-2", "asp-hub-a", { content: "less important alpha" });
		seedAttribute("attr-hidden", "asp-hidden", { content: "hidden attr" });
		seedDependency("dep-visible", "e-hub", "e-leaf", { strength: 0.9 });
		seedDependency("dep-hidden", "e-hub", "e-hidden", { strength: 0.8 });
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`UPDATE entity_attributes
				 SET version = 2,
				     version_root_id = 'attr-hub-a-root',
				     previous_attribute_id = 'attr-hub-a-0',
				     group_key = 'general',
				     claim_key = 'alpha_claim',
				     source_kind = 'transcript',
				     source_path = 'sessions/alpha.jsonl',
				     proposal_id = 'proposal-applied-alpha',
				     proposal_evidence = '[{"kind":"memory","id":"mem-a"}]'
				 WHERE id = 'attr-hub-a-1'`,
			).run();
			db.prepare(
				`INSERT INTO ontology_proposals
				 (id, agent_id, operation, status, payload, confidence, rationale, evidence, source_kind, source_path, created_at, updated_at)
				 VALUES (?, 'default', 'add_claim_value', 'pending', ?, 0.91, 'needs alpha claim', ?, 'transcript',
				         'sessions/alpha.jsonl', '2026-05-16T12:00:00Z', '2026-05-16T12:00:00Z')`,
			).run(
				"proposal-pending-alpha",
				JSON.stringify({ entity: "Hub", aspect: "alpha", claim_key: "alpha_claim", value: "important alpha" }),
				JSON.stringify([{ kind: "memory", id: "mem-a" }]),
			);
			db.prepare(
				`INSERT INTO ontology_proposals
				 (id, agent_id, operation, status, payload, confidence, rationale, evidence, created_at, updated_at, applied_at)
				 VALUES (?, 'default', 'add_claim_value', 'applied', ?, 0.82, 'already applied', '[]',
				         datetime('now'), datetime('now'), datetime('now'))`,
			).run("proposal-recent-applied", JSON.stringify({ entity: "Hub" }));
			db.prepare(
				`INSERT INTO dreaming_state
				 (agent_id, tokens_since_last_pass, consecutive_failures, last_pass_at, last_pass_id, last_pass_mode)
				 VALUES ('default', 2400, 0, '2026-05-16T13:00:00Z', 'dream-alpha', 'incremental')`,
			).run();
			db.prepare(
				`INSERT INTO dreaming_passes
				 (id, agent_id, mode, status, started_at, completed_at, mutations_applied, mutations_skipped, mutations_failed, created_at)
				 VALUES ('dream-alpha', 'default', 'incremental', 'completed', '2026-05-16T12:50:00Z',
				         '2026-05-16T13:00:00Z', 3, 1, 0, '2026-05-16T12:50:00Z')`,
			).run();
		});

		const graph = getKnowledgeGraphForConstellation(getDbAccessor(), "default", {
			limit: 2,
			maxAspectsPerEntity: 1,
			maxAttributesPerAspect: 1,
			dependencyLimit: 10,
		});

		expect(graph.entities.map((entity) => entity.id)).toEqual(["e-hub", "e-leaf"]);
		expect(graph.entities[0].aspects.map((aspect) => aspect.id)).toEqual(["asp-hub-a"]);
		expect(graph.entities[0].aspects[0].attributes.map((attr) => attr.id)).toEqual(["attr-hub-a-1"]);
		expect(graph.entities[0].aspects[0].attributes[0].version).toBe(2);
		expect(graph.entities[0].aspects[0].attributes[0].proposalId).toBe("proposal-applied-alpha");
		expect(graph.entities[0].aspects[0].attributes[0].proposalEvidenceCount).toBe(1);
		expect(graph.dependencies.map((dependency) => dependency.sourceEntityId)).toEqual(["e-hub"]);
		expect(graph.dependencies.map((dependency) => dependency.targetEntityId)).toEqual(["e-leaf"]);
		expect(graph.proposals.map((proposal) => proposal.id)).toContain("proposal-pending-alpha");
		expect(graph.proposals[0]?.targetEntityId).toBe("e-hub");
		expect(graph.proposals[0]?.targetAspectName).toBe("alpha");
		expect(graph.metadata.proposals.pending).toBe(1);
		expect(graph.metadata.proposals.appliedRecent).toBe(1);
		expect(graph.metadata.dreaming.tokensSinceLastPass).toBe(2400);
		expect(graph.metadata.dreaming.latestPass?.mutationsApplied).toBe(3);
	});

	test("constellation includes shared-agent graph rows for the current view", () => {
		dbPath = makeDbPath();
		initDbAccessor(dbPath);

		seedAgent("default", "shared");
		seedAgent("noam", "shared");
		seedAgent("private-agent", "isolated");
		seedEntity("e-default", "Default Entity", { agentId: "default", mentions: 5 });
		seedEntity("e-noam", "Noam Entity", { agentId: "noam", mentions: 4 });
		seedEntity("e-private", "Private Entity", { agentId: "private-agent", mentions: 9 });
		seedAspect("asp-noam", "e-noam", "shared aspect", "noam");
		seedAttribute("attr-noam", "asp-noam", { agentId: "noam", content: "shared attribute" });
		seedDependency("dep-shared", "e-default", "e-noam", { agentId: "noam", strength: 0.9 });

		const graph = getKnowledgeGraphForConstellation(getDbAccessor(), "default", {
			limit: 10,
			maxAspectsPerEntity: 2,
			maxAttributesPerAspect: 2,
			dependencyLimit: 10,
		});

		expect(graph.entities.map((entity) => entity.id)).toEqual(["e-default", "e-noam"]);
		expect(graph.entities.map((entity) => entity.id)).not.toContain("e-private");
		const noamEntity = graph.entities.find((entity) => entity.id === "e-noam");
		expect(noamEntity?.aspects[0]?.attributes[0]?.id).toBe("attr-noam");
		expect(graph.dependencies.map((dependency) => dependency.sourceEntityId)).toEqual(["e-default"]);
	});
});

describe("getKnowledgeEntityDetail (issue #515)", () => {
	let dbPath = "";

	afterEach(() => {
		closeDbAccessor();
		if (dbPath) {
			const dir = join(dbPath, "..");
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		}
		dbPath = "";
	});

	test("returns incoming + outgoing dependency counts independently", () => {
		dbPath = makeDbPath();
		initDbAccessor(dbPath);

		seedEntity("e-hub", "Hub");
		seedEntity("e-a", "A");
		seedEntity("e-b", "B");
		seedEntity("e-c", "C");
		seedDependency("dep-out-1", "e-hub", "e-a");
		seedDependency("dep-out-2", "e-hub", "e-b");
		seedDependency("dep-in-1", "e-c", "e-hub");

		const detail = getKnowledgeEntityDetail(getDbAccessor(), "e-hub", "default");
		expect(detail).not.toBeNull();
		expect(detail?.outgoingDependencyCount).toBe(2);
		expect(detail?.incomingDependencyCount).toBe(1);
		expect(detail?.dependencyCount).toBe(3);
	});

	test("returns null for unknown entity id", () => {
		dbPath = makeDbPath();
		initDbAccessor(dbPath);

		const detail = getKnowledgeEntityDetail(getDbAccessor(), "does-not-exist", "default");
		expect(detail).toBeNull();
	});
});

describe("getKnowledgeStats (issue #515)", () => {
	let dbPath = "";

	afterEach(() => {
		closeDbAccessor();
		if (dbPath) {
			const dir = join(dbPath, "..");
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		}
		dbPath = "";
	});

	test("counts memories linked to agent-scoped entities via memory_entity_mentions", () => {
		dbPath = makeDbPath();
		initDbAccessor(dbPath);

		seedEntity("e-def-1", "DefOne", { agentId: "default" });
		seedEntity("e-def-2", "DefTwo", { agentId: "default" });
		seedEntity("e-main", "MainOne", { agentId: "main" });

		seedMemory("m1");
		seedMemory("m2");
		seedMemory("m3");
		seedMention("m1", "e-def-1");
		seedMention("m2", "e-def-1");
		seedMention("m2", "e-def-2");
		seedMention("m3", "e-main");

		const defaultStats = getKnowledgeStats(getDbAccessor(), "default");
		expect(defaultStats.entityCount).toBe(2);
		expect(defaultStats.unassignedMemoryCount).toBe(2);

		const mainStats = getKnowledgeStats(getDbAccessor(), "main");
		expect(mainStats.entityCount).toBe(1);
		expect(mainStats.unassignedMemoryCount).toBe(1);
	});

	test("ignores soft-deleted memories", () => {
		dbPath = makeDbPath();
		initDbAccessor(dbPath);

		seedEntity("e-def-1", "DefOne", { agentId: "default" });
		seedMemory("m1");
		seedMention("m1", "e-def-1");

		getDbAccessor().withWriteTx((db) => {
			db.prepare("UPDATE memories SET is_deleted = 1 WHERE id = ?").run("m1");
		});

		const stats = getKnowledgeStats(getDbAccessor(), "default");
		expect(stats.unassignedMemoryCount).toBe(0);
	});

	test("excludes archived graph rows from stats and coverage", () => {
		dbPath = makeDbPath();
		initDbAccessor(dbPath);

		seedEntity("e-active", "Active", { agentId: "default" });
		seedEntity("e-archived", "Archived", { agentId: "default" });
		seedAspect("asp-active", "e-active", "capability");
		seedAspect("asp-archived", "e-active", "retired");
		seedAttribute("attr-active", "asp-active", { memoryId: "m-active" });
		seedAttribute("attr-archived-aspect", "asp-archived", { memoryId: "m-archived-aspect" });
		seedDependency("dep-archived-target", "e-active", "e-archived");
		seedMemory("m-active");
		seedMemory("m-archived-entity");
		seedMention("m-active", "e-active");
		seedMention("m-archived-entity", "e-archived");
		getDbAccessor().withWriteTx((db) => {
			db.prepare("UPDATE entities SET status = 'archived' WHERE id = ?").run("e-archived");
			db.prepare("UPDATE entity_aspects SET status = 'archived' WHERE id = ?").run("asp-archived");
		});

		const stats = getKnowledgeStats(getDbAccessor(), "default");
		expect(stats.entityCount).toBe(1);
		expect(stats.aspectCount).toBe(1);
		expect(stats.attributeCount).toBe(1);
		expect(stats.dependencyCount).toBe(0);
		expect(stats.unassignedMemoryCount).toBe(0);
		expect(stats.coveragePercent).toBe(100);
	});
});
