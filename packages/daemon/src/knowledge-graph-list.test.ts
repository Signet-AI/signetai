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
import { getKnowledgeEntityDetail, getKnowledgeStats, listKnowledgeEntities } from "./knowledge-graph";

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
});
