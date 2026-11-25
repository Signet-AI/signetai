import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { ensureAgentRegistered } from "../agent-id";
import { closeDbAccessor, getDbAccessor, initDbAccessor, runWriteTxAsync } from "../db-accessor";
import { getKnowledgeGraphForConstellation } from "../knowledge-graph";
import {
	invalidateDreamingEpisodicTokenBacklog,
	recordDreamingEpisodicTokenBacklog,
} from "../pipeline/dreaming-token-cache";
import { registerKnowledgeRoutes } from "./knowledge-routes";
import { reloadAuthState } from "./state";
import { writeFileSync } from "node:fs";

async function seedKnowledgeNavigation(): Promise<void> {
	await runWriteTxAsync(getDbAccessor(), (db) => {
		const now = "2026-09-23T00:00:00.000Z";
		db.prepare(
			`INSERT INTO entities
			 (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at)
			 VALUES ('entity-navigation', 'Knowledge', 'knowledge', 'topic', 'default', 1, ?, ?)`,
		).run(now, now);
		db.prepare(
			`INSERT INTO entity_aspects
			 (id, entity_id, agent_id, name, canonical_name, weight, created_at, updated_at)
			 VALUES ('aspect-navigation', 'entity-navigation', 'default', 'food', 'food', 1, ?, ?)`,
		).run(now, now);
		const insert = db.prepare(
			`INSERT INTO entity_attributes
			 (id, aspect_id, agent_id, kind, content, normalized_content, group_key, claim_key,
			  confidence, importance, status, created_at, updated_at)
			 VALUES (?, 'aspect-navigation', 'default', 'attribute', ?, ?, ?, ?, 1, 1, 'active', ?, ?)`,
		);
		for (const [id, group, claim] of [
			["nav-rest-a", "restaurants", "favorite"],
			["nav-rest-b", "restaurants", "visited"],
			["nav-diet-a", "dietary", "allergy"],
			["nav-diet-b", "dietary", "avoid_nuts"],
		] as const) {
			insert.run(id, claim, claim, group, claim, now, now);
		}
	});
}

async function seedEpisodicSources(count: number): Promise<void> {
	await runWriteTxAsync(getDbAccessor(), (db) => {
		const insert = db.prepare(
			`INSERT INTO memory_artifacts
			 (agent_id, source_path, source_sha256, source_kind, session_id, session_token, captured_at, content, updated_at, is_deleted)
			 VALUES ('default', ?, ?, 'transcript', ?, ?, '2026-09-23T12:00:00.000Z', ?, '2026-09-23T12:00:00.000Z', 0)`,
		);
		for (let index = 0; index < count; index++) {
			const id = String(index).padStart(64, "0");
			insert.run(
				`sessions/constellation-${index}.md`,
				id,
				`session-${index}`,
				`token-${index}`,
				`evidence ${index} supports the current plan`,
			);
		}
	});
}

describe("GET /api/knowledge/constellation backlog measurement", () => {
	let dir = "";

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "signet-constellation-route-"));
		mkdirSync(join(dir, "memory"), { recursive: true });
		initDbAccessor(join(dir, "memory", "memories.db"));
	});

	afterEach(async () => {
		invalidateDreamingEpisodicTokenBacklog("default");
		await closeDbAccessor();
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = "";
	});

	test("marks a backlog probe capped after 50 sources instead of returning a partial exact count", async () => {
		await seedEpisodicSources(51);
		const app = new Hono();
		registerKnowledgeRoutes(app);

		const response = await app.request("/api/knowledge/constellation?agent_id=default");
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body).toMatchObject({
			metadata: {
				dreaming: {
					episodicTokensPending: null,
					episodicBacklogProbe: {
						kind: "indeterminate",
					},
				},
			},
		});
		expect(body).not.toHaveProperty("metadata.dreaming.episodicBacklogProbe.tokenLowerBound");
	});

	test("keeps an exact pending-token count when the backlog fits within the probe limit", async () => {
		await seedEpisodicSources(1);
		const app = new Hono();
		registerKnowledgeRoutes(app);

		const response = await app.request("/api/knowledge/constellation?agent_id=default");
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			metadata: {
				dreaming: {
					episodicTokensPending: expect.any(Number),
					episodicBacklogProbe: {
						kind: "exact",
					},
				},
			},
		});
	});

	test("does not pair an incomplete probe with an exact cached token total", async () => {
		recordDreamingEpisodicTokenBacklog("default", 12345);
		const graph = await getKnowledgeGraphForConstellation(getDbAccessor(), "default", {
			backlogProbe: {
				kind: "indeterminate",
				tokenLowerBound: 50,
				hasBacklog: true,
				sourcesScanned: 50,
			},
		});

		expect(graph.metadata.dreaming.episodicTokensPending).toBeNull();
		expect(graph.metadata.dreaming.episodicBacklogProbe?.kind).toBe("indeterminate");
	});

	test("pages tree claim summaries through the registered navigation routes", async () => {
		await seedKnowledgeNavigation();
		const app = new Hono();
		registerKnowledgeRoutes(app);

		const treeResponse = await app.request("/api/knowledge/navigation/tree?entity=Knowledge&max_total_claims=2");
		expect(treeResponse.status).toBe(200);
		const tree = await treeResponse.json();
		expect(tree.limits.maxTotalClaims).toBe(2);
		const groups = tree.items[0].groups;
		expect(groups.map((group: { readonly claims: readonly unknown[] }) => group.claims.length)).toEqual([1, 1]);
		expect(groups.every((group: { readonly claimsHasMore: boolean }) => group.claimsHasMore)).toBe(true);

		const claimsResponse = await app.request(
			"/api/knowledge/navigation/claims?entity=Knowledge&aspect=food&group=restaurants&limit=1&offset=1",
		);
		expect(claimsResponse.status).toBe(200);
		expect(await claimsResponse.json()).toMatchObject({
			items: [expect.any(Object)],
			limit: 1,
			offset: 1,
			hasMore: false,
		});
	});

	test("uses the exact token total from the current probe", async () => {
		const graph = await getKnowledgeGraphForConstellation(getDbAccessor(), "default", {
			backlogProbe: {
				kind: "exact",
				tokens: 42,
				hasBacklog: true,
				sourcesScanned: 1,
			},
		});

		expect(graph.metadata.dreaming.episodicTokensPending).toBe(42);
		expect(graph.metadata.dreaming.episodicBacklogProbe?.kind).toBe("exact");
	});
});

async function seedIsolatedAgentEntities(): Promise<void> {
	await runWriteTxAsync(getDbAccessor(), (db) => {
		const now = "2026-09-23T00:00:00.000Z";
		for (const agent of ["haystack-a", "haystack-b"]) {
			db.prepare(
				"INSERT INTO agents (id, name, read_policy, created_at, updated_at) VALUES (?, ?, 'isolated', ?, ?)",
			).run(agent, agent, now, now);
			db.prepare(
				`INSERT INTO entities
				 (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at)
				 VALUES (?, ?, ?, 'person', ?, 3, ?, ?)`,
			).run(`entity-${agent}`, `User of ${agent}`, `user of ${agent}`, agent, now, now);
			db.prepare(
				`INSERT INTO entity_aspects
				 (id, entity_id, agent_id, name, canonical_name, weight, created_at, updated_at)
				 VALUES (?, ?, ?, 'preferences', 'preferences', 1, ?, ?)`,
			).run(`aspect-${agent}`, `entity-${agent}`, agent, now, now);
		}
	});
}

describe("GET /api/knowledge/constellation agent scope", () => {
	let dir = "";

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "signet-constellation-scope-"));
		mkdirSync(join(dir, "memory"), { recursive: true });
		initDbAccessor(join(dir, "memory", "memories.db"));
	});

	afterEach(() => {
		closeDbAccessor();
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = "";
	});

	test("shows every agent's entities with their owning agent only when all agents are requested", async () => {
		await seedIsolatedAgentEntities();
		const app = new Hono();
		registerKnowledgeRoutes(app);
		const entities = async (query: string) =>
			(
				(await (await app.request(`/api/knowledge/constellation?${query}`)).json()) as {
					entities: Array<{ id: string; agentId: string }>;
				}
			).entities.map((entity) => `${entity.agentId}:${entity.id}`);

		expect(await entities("agent_id=default")).toEqual([]);
		expect(await entities("agent_id=haystack-a")).toEqual(["haystack-a:entity-haystack-a"]);
		expect(await entities("agentId=haystack-b")).toEqual(["haystack-b:entity-haystack-b"]);
		expect((await entities("agent_id=all")).sort()).toEqual([
			"haystack-a:entity-haystack-a",
			"haystack-b:entity-haystack-b",
		]);
	});

	test("keeps agents registered implicitly out of each other's view", async () => {
		await ensureAgentRegistered("hook-a");
		await ensureAgentRegistered("hook-b");
		await runWriteTxAsync(getDbAccessor(), (db) => {
			const now = "2026-09-23T00:00:00.000Z";
			for (const agent of ["hook-a", "hook-b"]) {
				db.prepare(
					`INSERT INTO entities
					 (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at)
					 VALUES (?, ?, ?, 'person', ?, 3, ?, ?)`,
				).run(`entity-${agent}`, `User of ${agent}`, `user of ${agent}`, agent, now, now);
			}
		});

		const graph = await getKnowledgeGraphForConstellation(getDbAccessor(), "hook-a");

		expect(graph.entities.map((entity) => `${entity.agentId}:${entity.id}`)).toEqual(["hook-a:entity-hook-a"]);
	});

	test("enforces the team credential constellation scope", async () => {
		await seedIsolatedAgentEntities();
		writeFileSync(join(dir, "agent.yaml"), "auth:\n  mode: team\n");
		reloadAuthState(dir);
		try {
			for (const role of ["agent", "admin"] as const) {
				const app = new Hono();
				app.use("*", async (c, next) => {
					c.set("auth", {
						authenticated: true,
						claims: { sub: "key", role, scope: { agent: "haystack-a" }, iat: 0, exp: 4102444800 },
					});
					await next();
				});
				registerKnowledgeRoutes(app);
				const own = await app.request("/api/knowledge/constellation");
				expect(own.status).toBe(200);
				expect((await own.json()).entities.map((entity: { agentId: string }) => entity.agentId)).toEqual([
					"haystack-a",
				]);
				const all = await app.request("/api/knowledge/constellation?agent_id=all");
				expect(all.status).toBe(role === "admin" ? 200 : 403);
				if (role === "admin") expect((await all.json()).entities).toHaveLength(2);
			}
		} finally {
			writeFileSync(join(dir, "agent.yaml"), "auth:\n  mode: local\n");
			reloadAuthState(dir);
		}
	});

	test("refuses an all-agents view without admin permission outside local mode", async () => {
		await seedIsolatedAgentEntities();
		writeFileSync(join(dir, "agent.yaml"), "auth:\n  mode: team\n");
		reloadAuthState(dir);
		try {
			const app = new Hono();
			registerKnowledgeRoutes(app);
			expect((await app.request("/api/knowledge/constellation?agent_id=all")).status).toBe(403);
		} finally {
			writeFileSync(join(dir, "agent.yaml"), "auth:\n  mode: local\n");
			reloadAuthState(dir);
		}
	});
});

async function seedRankedFacts(): Promise<void> {
	await runWriteTxAsync(getDbAccessor(), (db) => {
		const now = "2026-09-23T00:00:00.000Z";
		for (const [entity, mentions] of [
			["entity-first", 9],
			["entity-second", 1],
		] as const) {
			db.prepare(
				`INSERT INTO entities
				 (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at)
				 VALUES (?, ?, ?, 'project', 'default', ?, ?, ?)`,
			).run(entity, entity, entity, mentions, now, now);
			for (let index = 0; index < mentions; index++) {
				const memoryId = `${entity}-mention-${index}`;
				db.prepare("INSERT INTO memories(id,content,agent_id,created_at,updated_at) VALUES(?,?,'default',?,?)").run(
					memoryId,
					entity,
					now,
					now,
				);
				db.prepare("INSERT INTO memory_entity_mentions(memory_id,entity_id) VALUES(?,?)").run(memoryId, entity);
			}
		}
		const aspect = db.prepare(
			`INSERT INTO entity_aspects
			 (id, entity_id, agent_id, name, canonical_name, weight, created_at, updated_at)
			 VALUES (?, 'entity-first', 'default', ?, ?, 1, ?, ?)`,
		);
		const fact = db.prepare(
			`INSERT INTO entity_attributes
			 (id, aspect_id, agent_id, kind, content, normalized_content, confidence, importance, status, created_at, updated_at)
			 VALUES (?, ?, 'default', 'attribute', ?, ?, 1, ?, 'active', ?, ?)`,
		);
		for (const name of ["a", "b"]) {
			aspect.run(`aspect-${name}`, name, name, now, now);
			for (const [rank, importance] of [0.9, 0.8, 0.7].entries()) {
				const id = `fact-${name}${rank + 1}`;
				fact.run(id, `aspect-${name}`, id, id, importance, now, now);
			}
		}
	});
}

describe("GET /api/knowledge/constellation bounds", () => {
	let dir = "";

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "signet-constellation-bounds-"));
		mkdirSync(join(dir, "memory"), { recursive: true });
		initDbAccessor(join(dir, "memory", "memories.db"));
	});

	afterEach(async () => {
		await closeDbAccessor();
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = "";
	});

	const read = async (query: string) => {
		const app = new Hono();
		registerKnowledgeRoutes(app);
		const response = await app.request(`/api/knowledge/constellation?agent_id=default&${query}`);
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			entities: Array<{ id: string; aspects: Array<{ id: string; attributes: Array<{ id: string }> }> }>;
			metadata: { truncated: Record<string, boolean> };
		};
		return {
			facts: body.entities.flatMap((entity) =>
				entity.aspects.map((aspect) => `${aspect.id}:${aspect.attributes.map((attr) => attr.id).join(",")}`),
			),
			entities: body.entities.map((entity) => entity.id),
			truncated: body.metadata.truncated,
		};
	};

	test("spends a total fact budget breadth-first and reports what it omitted", async () => {
		await seedRankedFacts();
		expect(await read("max_attributes_per_aspect=2&max_attributes=3")).toEqual({
			facts: ["aspect-a:fact-a1,fact-a2", "aspect-b:fact-b1"],
			entities: ["entity-first", "entity-second"],
			truncated: { entities: false, aspects: false, attributes: true, dependencies: false, assertions: false },
		});
		expect(await read("limit=1&max_aspects_per_entity=1&max_attributes_per_aspect=250")).toMatchObject({
			facts: ["aspect-a:fact-a1,fact-a2,fact-a3"],
			entities: ["entity-first"],
			truncated: { entities: true, aspects: true, attributes: false },
		});
	});

	test("reports a complete graph when every bound has room", async () => {
		await seedRankedFacts();
		expect(await read("max_attributes_per_aspect=3&max_attributes=6")).toMatchObject({
			facts: ["aspect-a:fact-a1,fact-a2,fact-a3", "aspect-b:fact-b1,fact-b2,fact-b3"],
			truncated: { entities: false, aspects: false, attributes: false, dependencies: false, assertions: false },
		});
		expect((await read("max_attributes_per_aspect=3&max_attributes=abc")).truncated.attributes).toBe(false);
	});

	test("returns each node's created and updated time as ISO UTC", async () => {
		await seedRankedFacts();
		await runWriteTxAsync(getDbAccessor(), (db) => {
			db.prepare("UPDATE entities SET created_at = '2026-09-20 01:02:03' WHERE id = 'entity-first'").run();
			db.prepare("UPDATE entity_aspects SET updated_at = 'not a time' WHERE id = 'aspect-a'").run();
			db.prepare("UPDATE entity_attributes SET updated_at = '2026-09-21 04:05:06' WHERE id = 'fact-a1'").run();
		});
		const app = new Hono();
		registerKnowledgeRoutes(app);
		const body = (await (await app.request("/api/knowledge/constellation?agent_id=default")).json()) as {
			entities: Array<{
				id: string;
				createdAt: string | null;
				updatedAt: string | null;
				aspects: Array<{
					id: string;
					createdAt: string | null;
					updatedAt: string | null;
					attributes: Array<{ id: string; createdAt: string | null; updatedAt: string | null }>;
				}>;
			}>;
		};
		const entity = body.entities.find((row) => row.id === "entity-first");
		const aspect = entity?.aspects.find((row) => row.id === "aspect-a");
		const fact = aspect?.attributes.find((row) => row.id === "fact-a1");
		expect([entity?.createdAt, entity?.updatedAt]).toEqual(["2026-09-20T01:02:03.000Z", "2026-09-23T00:00:00.000Z"]);
		expect([aspect?.createdAt, aspect?.updatedAt]).toEqual(["2026-09-23T00:00:00.000Z", null]);
		expect([fact?.createdAt, fact?.updatedAt]).toEqual(["2026-09-23T00:00:00.000Z", "2026-09-21T04:05:06.000Z"]);
	});

	test("revalidates an unchanged graph with its ETag and serves the new graph after a write", async () => {
		await seedRankedFacts();
		const app = new Hono();
		registerKnowledgeRoutes(app);
		const path = "/api/knowledge/constellation?agent_id=default";
		const first = await app.request(path);
		const tag = first.headers.get("ETag");
		expect(first.status).toBe(200);
		expect(tag).toBeTruthy();
		const unchanged = await app.request(path, { headers: { "If-None-Match": tag ?? "" } });
		expect(unchanged.status).toBe(304);
		expect(await unchanged.text()).toBe("");
		await runWriteTxAsync(getDbAccessor(), (db) => {
			db.prepare("UPDATE entity_attributes SET content = 'changed' WHERE id = 'fact-a1'").run();
		});
		const changed = await app.request(path, { headers: { "If-None-Match": tag ?? "" } });
		expect(changed.status).toBe(200);
		expect(changed.headers.get("ETag")).not.toBe(tag);
		expect(JSON.stringify(await changed.json())).toContain("changed");
	});
});
