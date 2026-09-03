import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { runMigrations } from "../../../core/src/migrations";
import { parseAuthConfig, type TokenClaims } from "../auth";
import type { DbAccessor, ReadDb, WriteDb } from "../db-accessor";
import { registerRepairRoutes } from "./repair-routes";

interface TestEnvironment {
	readonly db: Database;
	readonly accessor: DbAccessor;
	readonly app: Hono;
}

function makeAccessor(db: Database): DbAccessor {
	return {
		withReadDb<T>(fn: (readDb: ReadDb) => T): T {
			return fn(db as unknown as ReadDb);
		},
		withReadDbAsync<T>(fn: (readDb: ReadDb) => Promise<T>): Promise<T> {
			return fn(db as unknown as ReadDb);
		},
		withWriteTx<T>(fn: (writeDb: WriteDb) => T): T {
			db.exec("BEGIN IMMEDIATE");
			try {
				const result = fn(db as unknown as WriteDb);
				db.exec("COMMIT");
				return result;
			} catch (error) {
				db.exec("ROLLBACK");
				throw error;
			}
		},
		withWriteTxAsync<T>(fn: (writeDb: WriteDb) => T): Promise<T> {
			return Promise.resolve().then(() => this.withWriteTx(fn));
		},
		close(): void {
			db.close();
		},
	};
}

function seedSameHashMemories(db: Database): void {
	const now = new Date().toISOString();
	db.prepare(
		`INSERT INTO memories (id, content, content_hash, agent_id, type, created_at, updated_at, updated_by)
		 VALUES (?, ?, ?, ?, 'fact', ?, ?, 'test')`,
	).run("memory-a", "same content", "same-hash", "agent-a", now, now);
	db.prepare(
		`INSERT INTO memories (id, content, content_hash, agent_id, type, created_at, updated_at, updated_by)
		 VALUES (?, ?, ?, ?, 'fact', ?, ?, 'test')`,
	).run("memory-b", "same content", "same-hash", "agent-b", now, now);
	db.prepare(
		`INSERT INTO embeddings (id, content_hash, vector, dimensions, source_type, source_id, chunk_text, created_at, agent_id)
		 VALUES (?, ?, ?, 3, 'memory', ?, ?, ?, ?)`,
	).run(
		"embedding-a",
		"same-hash",
		Buffer.from(new Float32Array([0.1, 0.2, 0.3]).buffer),
		"memory-a",
		"same content",
		now,
		"agent-a",
	);
}

function setup(): TestEnvironment {
	const db = new Database(":memory:");
	runMigrations(db as unknown as Parameters<typeof runMigrations>[0]);
	seedSameHashMemories(db);
	const accessor = makeAccessor(db);
	const app = new Hono();
	registerRepairRoutes(app, {
		authConfig: parseAuthConfig(undefined, "/tmp/signet-repair-scope-test"),
		getDbAccessor: () => accessor,
	});
	return { db, accessor, app };
}

let environment: TestEnvironment;

beforeEach(() => {
	environment = setup();
});

afterEach(() => {
	environment.db.close();
});

describe("GET /api/repair/embedding-gaps", () => {
	it("keeps same-hash coverage scoped to the requested agent", async () => {
		const agentB = await environment.app.request("/api/repair/embedding-gaps?agentId=agent-b");
		expect(agentB.status).toBe(200);
		expect(await agentB.json()).toMatchObject({
			total: 1,
			unembedded: 1,
			embedded: 0,
			complete: false,
		});

		const agentA = await environment.app.request("/api/repair/embedding-gaps?agentId=agent-a");
		expect(agentA.status).toBe(200);
		expect(await agentA.json()).toMatchObject({
			total: 1,
			unembedded: 0,
			embedded: 1,
			complete: true,
		});
	});
});

describe("agent authorization for embedding repair routes", () => {
	it("rejects a target agent outside the authenticated request scope", async () => {
		const authConfig = {
			...parseAuthConfig(undefined, "/tmp/signet-repair-scope-test"),
			mode: "team" as const,
		};
		const claims: TokenClaims = {
			sub: "agent-a-operator",
			scope: { agent: "agent-a" },
			role: "operator",
			iat: Math.floor(Date.now() / 1000),
			exp: Math.floor(Date.now() / 1000) + 3600,
		};
		const guarded = new Hono();
		guarded.use("*", async (c, next) => {
			c.set("auth", { authenticated: true, claims });
			await next();
		});
		registerRepairRoutes(guarded, {
			authConfig,
			getDbAccessor: () => environment.accessor,
		});

		const getResponse = await guarded.request("/api/repair/embedding-gaps?agentId=agent-b");
		expect(getResponse.status).toBe(403);

		const postResponse = await guarded.request("/api/repair/re-embed", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ agentId: "agent-b", dryRun: true }),
		});
		expect(postResponse.status).toBe(403);
	});
});
