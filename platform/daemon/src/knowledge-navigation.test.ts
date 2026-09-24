import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DbAccessor, ReadAdmissionOptions, ReadDb } from "./db-accessor";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "./db-accessor";
import {
	getEntityAspectsByName,
	getEntityKnowledgeTree,
	getAttributesForAspectFiltered,
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
	readonly groupKey: string | null;
	readonly claimKey: string;
	readonly content: string;
	readonly status?: "active" | "superseded";
	readonly kind?: "attribute" | "constraint" | "claim";
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

function countPreparedStatements(accessor: DbAccessor): {
	readonly accessor: DbAccessor;
	readonly count: () => number;
	readonly statements: () => readonly string[];
} {
	let count = 0;
	const statements: string[] = [];
	return {
		accessor: {
			...accessor,
			async withReadDbAsync<T>(fn: (db: ReadDb) => T | Promise<T>, options?: ReadAdmissionOptions): Promise<T> {
				return await accessor.withReadDbAsync(
					(db) =>
						fn({
							prepare(sql) {
								count += 1;
								statements.push(sql);
								return db.prepare(sql);
							},
						}),
					options,
				);
			},
		},
		count: () => count,
		statements: () => statements,
	};
}

function rejectNestedReads(accessor: DbAccessor): DbAccessor {
	let active = false;
	return {
		...accessor,
		async withReadDbAsync<T>(fn: (db: ReadDb) => Promise<T>): Promise<T> {
			if (active) throw new Error("nested read connection acquisition");
			active = true;
			try {
				return await accessor.withReadDbAsync(fn);
			} finally {
				active = false;
			}
		},
	};
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

	test("walks entity -> aspect -> group -> claim -> attributes", async () => {
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

		const aspects = await getEntityAspectsByName(getDbAccessor(), { agentId: "default", entity: "Nicholai" });
		expect(aspects?.items.map((item) => item.aspect.canonicalName)).toEqual(["food"]);

		const groups = await listEntityGroups(getDbAccessor(), {
			agentId: "default",
			entity: "Nicholai",
			aspect: "food",
		});
		expect(groups?.items.map((item) => item.groupKey)).toEqual(["restaurants", "dietary_constraints"]);
		expect(groups?.items[0]?.claimCount).toBe(2);

		const claims = await listEntityClaims(getDbAccessor(), {
			agentId: "default",
			entity: "Nicholai",
			aspect: "food",
			group: "restaurants",
			limit: 50,
			offset: 0,
		});
		expect(claims?.items.map((item) => item.claimKey)).toEqual([
			"favorite_restaurant",
			"korean_restaurants_tried_count",
		]);
		expect(claims?.items[0]?.activeCount).toBe(1);
		expect(claims?.items[0]?.supersededCount).toBe(1);
		expect(claims?.items[0]?.preview).toBe("Nicholai currently prefers Temaki Den.");

		const active = await listEntityAttributesByPath(getDbAccessor(), {
			agentId: "default",
			entity: "Nicholai",
			aspect: "food",
			group: "restaurants",
			claim: "favorite_restaurant",
			limit: 10,
			offset: 0,
		});
		expect(active?.items.map((item) => item.content)).toEqual(["Nicholai currently prefers Temaki Den."]);

		const all = await listEntityAttributesByPath(getDbAccessor(), {
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

	test("holds one read connection while resolving entity aspects by name", async () => {
		dbPath = makeDbPath();
		initDbAccessor(dbPath);
		seedEntity();
		seedAttribute({
			id: "attr-favorite",
			groupKey: "restaurants",
			claimKey: "favorite_restaurant",
			content: "Nicholai currently prefers Temaki Den.",
		});

		const result = await getEntityAspectsByName(rejectNestedReads(getDbAccessor()), {
			agentId: "default",
			entity: "Nicholai",
		});
		expect(result?.items[0]?.attributeCount).toBe(1);
	});

	test("filters claim attributes without broadening to all kinds", async () => {
		dbPath = makeDbPath();
		initDbAccessor(dbPath);
		seedEntity();
		seedAttribute({
			id: "attr-claim",
			groupKey: "restaurants",
			claimKey: "favorite_restaurant",
			content: "Nicholai currently prefers Temaki Den.",
			kind: "claim",
		});
		seedAttribute({
			id: "attr-constraint",
			groupKey: "dietary_constraints",
			claimKey: "shellfish_allergy",
			content: "Nicholai has no known shellfish allergy.",
			kind: "constraint",
		});

		const claims = await getAttributesForAspectFiltered(getDbAccessor(), {
			entityId: "entity-nicholai",
			aspectId: "aspect-food",
			agentId: "default",
			kind: "claim",
			limit: 10,
			offset: 0,
		});
		expect(claims.map((attribute) => attribute.id)).toEqual(["attr-claim"]);
	});

	test("returns a compact tree for agent-visible graph browsing", async () => {
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

		const tree = await getEntityKnowledgeTree(getDbAccessor(), {
			agentId: "default",
			entity: "Nicholai",
			maxAspects: 20,
			maxGroups: 20,
			maxClaims: 50,
			maxTotalClaims: 1_000,
			depth: 3,
		});

		expect(tree?.entity.name).toBe("Nicholai");
		expect(tree?.limits.depth).toBe(3);
		expect(tree?.limits.maxTotalClaims).toBe(1_000);
		expect(tree?.items[0]?.aspect.canonicalName).toBe("food");
		expect(tree?.items[0]?.groups[0]?.groupKey).toBe("restaurants");
		expect(tree?.items[0]?.groups[0]?.claims.map((item) => item.claimKey)).toEqual([
			"favorite_restaurant",
			"korean_restaurants_tried_count",
		]);
		expect(tree?.items[0]?.groups[0]?.claims[0]?.preview).toBe("Nicholai currently prefers Temaki Den.");
	});

	test("merges null and explicit general-group claim previews", async () => {
		dbPath = makeDbPath();
		initDbAccessor(dbPath);
		seedEntity();
		seedAttribute({
			id: "attr-general-null",
			groupKey: null,
			claimKey: "favorite_general",
			content: "Older general-group value",
			updatedAt: "2026-04-18T00:00:00.000Z",
		});
		seedAttribute({
			id: "attr-general-explicit",
			groupKey: "general",
			claimKey: "favorite_general",
			content: "Newer general-group value",
			updatedAt: "2026-04-19T00:00:00.000Z",
		});

		const tree = await getEntityKnowledgeTree(getDbAccessor(), {
			agentId: "default",
			entity: "Nicholai",
			maxAspects: 20,
			maxGroups: 20,
			maxClaims: 50,
			maxTotalClaims: 1_000,
			depth: 3,
		});
		const general = tree?.items[0]?.groups.find((group) => group.groupKey === "general");
		expect(general?.claims).toHaveLength(1);
		expect(general?.claims[0]?.attributeCount).toBe(2);
		expect(general?.claims[0]?.preview).toBe("Newer general-group value");
	});

	test("loads aspects, groups, and claims in a fixed number of read statements", async () => {
		dbPath = makeDbPath();
		initDbAccessor(dbPath);
		seedEntity();
		seedAttribute({ id: "attr-food-a", groupKey: "restaurants", claimKey: "favorite", content: "A" });
		seedAttribute({ id: "attr-food-b", groupKey: "dietary", claimKey: "allergy", content: "B" });
		seedAttribute({ id: "attr-food-c", groupKey: "cafes", claimKey: "favorite_cafe", content: "C" });
		seedAttribute({ id: "attr-food-d", groupKey: "groceries", claimKey: "favorite_market", content: "D" });
		const counted = countPreparedStatements(getDbAccessor());

		const tree = await getEntityKnowledgeTree(counted.accessor, {
			agentId: "default",
			entity: "Nicholai",
			maxAspects: 20,
			maxGroups: 20,
			maxClaims: 50,
			maxTotalClaims: 1_000,
			depth: 3,
		});

		expect(tree?.items).toHaveLength(1);
		expect(tree?.items[0]?.groups).toHaveLength(4);
		expect(tree?.items.flatMap((item) => item.groups.flatMap((group) => group.claims))).toHaveLength(4);
		expect(counted.count()).toBeLessThanOrEqual(3);

		const groupQuery = counted.statements().find((sql) => sql.includes("claim_stats AS"));
		if (!groupQuery) throw new Error("Batched tree query was not captured");
		const plan = await getDbAccessor().withReadDbAsync(
			(db) =>
				db
					.prepare(`EXPLAIN QUERY PLAN ${groupQuery}`)
					.all("aspect-food", 0, "default", 20, "default", "default", 50, 1_000) as Array<{ detail: string }>,
		);
		const scopedAttributeLookups = plan.filter(
			(row) => row.detail.startsWith("SEARCH ea USING INDEX") && row.detail.includes("aspect_id=?"),
		);
		expect(scopedAttributeLookups.length).toBeGreaterThanOrEqual(2);
		expect(plan.some((row) => row.detail.startsWith("CORRELATED SCALAR SUBQUERY"))).toBe(false);
	});

	test("keeps branches represented under the total claims budget and exposes claim pages", async () => {
		dbPath = makeDbPath();
		initDbAccessor(dbPath);
		seedEntity();
		seedAttribute({ id: "attr-rest-a", groupKey: "restaurants", claimKey: "favorite", content: "A" });
		seedAttribute({ id: "attr-rest-b", groupKey: "restaurants", claimKey: "visited", content: "B" });
		seedAttribute({ id: "attr-diet-a", groupKey: "dietary", claimKey: "allergy", content: "C" });
		seedAttribute({ id: "attr-diet-b", groupKey: "dietary", claimKey: "avoid_nuts", content: "D" });

		const tree = await getEntityKnowledgeTree(getDbAccessor(), {
			agentId: "default",
			entity: "Nicholai",
			maxAspects: 20,
			maxGroups: 20,
			maxClaims: 50,
			maxTotalClaims: 2,
			depth: 3,
		});
		const groups = tree?.items[0]?.groups ?? [];
		expect(groups.map((group) => group.claims.length)).toEqual([1, 1]);
		expect(groups.every((group) => group.claimsHasMore)).toBe(true);

		const path = { agentId: "default", entity: "Nicholai", aspect: "food", group: "restaurants" };
		const firstPage = await listEntityClaims(getDbAccessor(), Object.assign({}, path, { limit: 1, offset: 0 }));
		const secondPage = await listEntityClaims(getDbAccessor(), Object.assign({}, path, { limit: 1, offset: 1 }));
		expect(firstPage?.items).toHaveLength(1);
		expect(firstPage?.hasMore).toBe(true);
		expect(secondPage?.items).toHaveLength(1);
		expect(secondPage?.hasMore).toBe(false);
		expect(firstPage?.items[0]?.claimKey).not.toBe(secondPage?.items[0]?.claimKey);
	});

	test("clamps claim page bounds before issuing the owner query", async () => {
		dbPath = makeDbPath();
		initDbAccessor(dbPath);
		seedEntity();
		seedAttribute({ id: "attr-claim-a", groupKey: "restaurants", claimKey: "favorite", content: "A" });
		seedAttribute({ id: "attr-claim-b", groupKey: "restaurants", claimKey: "visited", content: "B" });

		const firstPage = await listEntityClaims(getDbAccessor(), {
			agentId: "default",
			entity: "Nicholai",
			aspect: "food",
			group: "restaurants",
			limit: -5,
			offset: -1,
		});
		const beyondMaximum = await listEntityClaims(getDbAccessor(), {
			agentId: "default",
			entity: "Nicholai",
			aspect: "food",
			group: "restaurants",
			limit: 1_000,
			offset: Number.MAX_SAFE_INTEGER + 1,
		});

		expect(firstPage?.limit).toBe(1);
		expect(firstPage?.offset).toBe(0);
		expect(firstPage?.items).toHaveLength(1);
		expect(firstPage?.hasMore).toBe(true);
		expect(beyondMaximum?.limit).toBe(200);
		expect(beyondMaximum?.offset).toBe(Number.MAX_SAFE_INTEGER);
	});

	test("tree depth can stop before claims", async () => {
		dbPath = makeDbPath();
		initDbAccessor(dbPath);
		seedEntity();
		seedAttribute({
			id: "attr-fav-new",
			groupKey: "restaurants",
			claimKey: "favorite_restaurant",
			content: "Nicholai currently prefers Temaki Den.",
		});

		const tree = await getEntityKnowledgeTree(getDbAccessor(), {
			agentId: "default",
			entity: "Nicholai",
			maxAspects: 20,
			maxGroups: 20,
			maxClaims: 50,
			maxTotalClaims: 1_000,
			depth: 2,
		});

		expect(tree?.items[0]?.groupCount).toBe(1);
		expect(tree?.items[0]?.groups[0]?.claimCount).toBe(1);
		expect(tree?.items[0]?.groups[0]?.claims).toEqual([]);
	});
});
