import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "./db-accessor";
import {
	getEntityAspectsByName,
	getEntityKnowledgeTree,
	listEntityAttributesByPath,
	listEntityClaims,
	listEntityGroups,
} from "./knowledge-graph";

function makeDbPath(): string {
	const dir = join(tmpdir(), `signet-kg-nav-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	return join(dir, "memories.db");
}

function seedEntity(): void {
	const now = "2026-04-19T00:00:00.000Z";
	getDbAccessor().withWriteTx((db) => {
		db.prepare(
			`INSERT INTO entities
			 (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at)
			 VALUES ('entity-nicholai', 'Nicholai', 'nicholai', 'person', 'default', 10, ?, ?)`,
		).run(now, now);
		db.prepare(
			`INSERT INTO entity_aspects
			 (id, entity_id, agent_id, name, canonical_name, weight, created_at, updated_at)
			 VALUES ('aspect-food', 'entity-nicholai', 'default', 'food', 'food', 0.8, ?, ?)`,
		).run(now, now);
	});
}

function seedAttribute(input: {
	readonly id: string;
	readonly groupKey: string;
	readonly claimKey: string;
	readonly content: string;
	readonly status?: "active" | "superseded";
	readonly kind?: "attribute" | "constraint";
	readonly updatedAt?: string;
}): void {
	const updatedAt = input.updatedAt ?? "2026-04-19T00:00:00.000Z";
	getDbAccessor().withWriteTx((db) => {
		db.prepare(
			`INSERT INTO entity_attributes
			 (id, aspect_id, agent_id, kind, content, normalized_content, group_key, claim_key,
			  confidence, importance, status, created_at, updated_at)
			 VALUES (?, 'aspect-food', 'default', ?, ?, ?, ?, ?, 0.9, 0.7, ?, ?, ?)`,
		).run(
			input.id,
			input.kind ?? "attribute",
			input.content,
			input.content.toLowerCase(),
			input.groupKey,
			input.claimKey,
			input.status ?? "active",
			updatedAt,
			updatedAt,
		);
	});
}

describe("knowledge graph navigation", () => {
	let dbPath = "";

	afterEach(() => {
		closeDbAccessor();
		if (dbPath) {
			const dir = join(dbPath, "..");
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		}
		dbPath = "";
	});

	test("walks entity -> aspect -> group -> claim -> attributes", () => {
		dbPath = makeDbPath();
		initDbAccessor(dbPath);
		seedEntity();
		seedAttribute({
			id: "attr-fav-old",
			groupKey: "restaurants",
			claimKey: "favorite_restaurant",
			content: "Nicholai used to like Sushi Den.",
			status: "superseded",
			updatedAt: "2025-01-01T00:00:00.000Z",
		});
		seedAttribute({
			id: "attr-fav-new",
			groupKey: "restaurants",
			claimKey: "favorite_restaurant",
			content: "Nicholai currently prefers Temaki Den.",
			updatedAt: "2026-04-19T00:00:00.000Z",
		});
		seedAttribute({
			id: "attr-count",
			groupKey: "restaurants",
			claimKey: "korean_restaurants_tried_count",
			content: "Nicholai has tried four Korean restaurants.",
		});
		seedAttribute({
			id: "attr-allergy",
			groupKey: "dietary_constraints",
			claimKey: "shellfish_allergy",
			content: "Nicholai has no known shellfish allergy.",
		});

		const aspects = getEntityAspectsByName(getDbAccessor(), { agentId: "default", entity: "Nicholai" });
		expect(aspects?.items.map((item) => item.aspect.canonicalName)).toEqual(["food"]);

		const groups = listEntityGroups(getDbAccessor(), {
			agentId: "default",
			entity: "Nicholai",
			aspect: "food",
		});
		expect(groups?.items.map((item) => item.groupKey)).toEqual(["restaurants", "dietary_constraints"]);
		expect(groups?.items[0]?.claimCount).toBe(2);

		const claims = listEntityClaims(getDbAccessor(), {
			agentId: "default",
			entity: "Nicholai",
			aspect: "food",
			group: "restaurants",
		});
		expect(claims?.items.map((item) => item.claimKey)).toEqual([
			"favorite_restaurant",
			"korean_restaurants_tried_count",
		]);
		expect(claims?.items[0]?.activeCount).toBe(1);
		expect(claims?.items[0]?.supersededCount).toBe(1);
		expect(claims?.items[0]?.preview).toBe("Nicholai currently prefers Temaki Den.");

		const active = listEntityAttributesByPath(getDbAccessor(), {
			agentId: "default",
			entity: "Nicholai",
			aspect: "food",
			group: "restaurants",
			claim: "favorite_restaurant",
			limit: 10,
			offset: 0,
		});
		expect(active?.items.map((item) => item.content)).toEqual(["Nicholai currently prefers Temaki Den."]);

		const all = listEntityAttributesByPath(getDbAccessor(), {
			agentId: "default",
			entity: "Nicholai",
			aspect: "food",
			group: "restaurants",
			claim: "favorite_restaurant",
			status: "all",
			limit: 10,
			offset: 0,
		});
		expect(all?.items.map((item) => item.status)).toEqual(["active", "superseded"]);
	});

	test("returns a compact tree for agent-visible graph browsing", () => {
		dbPath = makeDbPath();
		initDbAccessor(dbPath);
		seedEntity();
		seedAttribute({
			id: "attr-fav-new",
			groupKey: "restaurants",
			claimKey: "favorite_restaurant",
			content: "Nicholai currently prefers Temaki Den.",
		});
		seedAttribute({
			id: "attr-count",
			groupKey: "restaurants",
			claimKey: "korean_restaurants_tried_count",
			content: "Nicholai has tried four Korean restaurants.",
		});

		const tree = getEntityKnowledgeTree(getDbAccessor(), {
			agentId: "default",
			entity: "Nicholai",
			maxAspects: 20,
			maxGroups: 20,
			maxClaims: 50,
			depth: 3,
		});

		expect(tree?.entity.name).toBe("Nicholai");
		expect(tree?.limits.depth).toBe(3);
		expect(tree?.items[0]?.aspect.canonicalName).toBe("food");
		expect(tree?.items[0]?.groups[0]?.groupKey).toBe("restaurants");
		expect(tree?.items[0]?.groups[0]?.claims.map((item) => item.claimKey)).toEqual([
			"favorite_restaurant",
			"korean_restaurants_tried_count",
		]);
		expect(tree?.items[0]?.groups[0]?.claims[0]?.preview).toBe("Nicholai currently prefers Temaki Den.");
	});

	test("tree depth can stop before claims", () => {
		dbPath = makeDbPath();
		initDbAccessor(dbPath);
		seedEntity();
		seedAttribute({
			id: "attr-fav-new",
			groupKey: "restaurants",
			claimKey: "favorite_restaurant",
			content: "Nicholai currently prefers Temaki Den.",
		});

		const tree = getEntityKnowledgeTree(getDbAccessor(), {
			agentId: "default",
			entity: "Nicholai",
			maxAspects: 20,
			maxGroups: 20,
			maxClaims: 50,
			depth: 2,
		});

		expect(tree?.items[0]?.groupCount).toBe(1);
		expect(tree?.items[0]?.groups[0]?.claimCount).toBe(1);
		expect(tree?.items[0]?.groups[0]?.claims).toEqual([]);
	});
});
