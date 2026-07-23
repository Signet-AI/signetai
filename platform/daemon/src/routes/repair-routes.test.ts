import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { parseAuthConfig } from "../auth";
import type { DbAccessor, ReadDb, WriteDb } from "../db-accessor";
import { registerRepairRoutes } from "./repair-routes";

let db: Database;
let accessor: DbAccessor;

function makeAccessor(database: Database): DbAccessor {
	return {
		withReadDb<T>(fn: (readDb: ReadDb) => T): T {
			return fn(database as unknown as ReadDb);
		},
		withWriteTx<T>(fn: (writeDb: WriteDb) => T): T {
			database.exec("BEGIN IMMEDIATE");
			try {
				const result = fn(database as unknown as WriteDb);
				database.exec("COMMIT");
				return result;
			} catch (error) {
				database.exec("ROLLBACK");
				throw error;
			}
		},
		close(): void {},
	};
}

function makeApp(): Hono {
	const app = new Hono();
	registerRepairRoutes(app, {
		authConfig: parseAuthConfig(undefined, "/tmp/signet-repair-routes-test"),
		getDbAccessor: () => accessor,
	});
	return app;
}

function requestHeaders(): Record<string, string> {
	return { "Content-Type": "application/json" };
}

function seedRelinkCandidate(): void {
	const now = new Date().toISOString();
	accessor.withWriteTx((db) => {
		db.prepare(
			`INSERT INTO memories (id, content, type, agent_id, created_at, updated_at, updated_by)
			 VALUES (?, ?, 'fact', ?, ?, ?, 'test')`,
		).run("memory-relink", "Nicholai maintains Signet.", "agent-relink", now, now);
		db.prepare(
			`INSERT INTO entities (
				id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at
			) VALUES (?, ?, ?, 'person', ?, 0, ?, ?)`,
		).run("entity-nicholai", "Nicholai", "nicholai", "agent-relink", now, now);
	});
}

function readMutationState(): { mentions: number; entityMentions: number } {
	return accessor.withReadDb((db) => {
		const mentionRow = db.prepare("SELECT COUNT(*) AS count FROM memory_entity_mentions").get() as { count: number };
		const entityRow = db.prepare("SELECT mentions FROM entities WHERE id = ?").get("entity-nicholai") as {
			mentions: number;
		};
		return { mentions: mentionRow.count, entityMentions: entityRow.mentions };
	});
}

beforeEach(() => {
	db = new Database(":memory:");
	db.exec(`
		CREATE TABLE memories (
			id TEXT PRIMARY KEY,
			content TEXT NOT NULL,
			type TEXT,
			agent_id TEXT,
			is_deleted INTEGER DEFAULT 0,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			updated_by TEXT
		);
		CREATE TABLE entities (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			canonical_name TEXT,
			entity_type TEXT,
			agent_id TEXT NOT NULL,
			mentions INTEGER DEFAULT 0,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
		CREATE TABLE memory_entity_mentions (
			memory_id TEXT NOT NULL,
			entity_id TEXT NOT NULL,
			mention_text TEXT,
			confidence REAL,
			created_at TEXT,
			PRIMARY KEY (memory_id, entity_id)
		);
	`);
	accessor = makeAccessor(db);
	seedRelinkCandidate();
});

afterEach(() => {
	db.close();
});

describe("POST /api/repair/relink-entities", () => {
	it("previews relinking without persisting mentions when dryRun is true", async () => {
		const before = readMutationState();
		const response = await makeApp().request("/api/repair/relink-entities", {
			method: "POST",
			headers: requestHeaders(),
			body: JSON.stringify({ agentId: "agent-relink", batchSize: 1, dryRun: true }),
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			action: "relink-entities",
			dryRun: true,
			processed: 1,
			linked: 1,
			entities: 1,
			remaining: 1,
			projectedRemaining: 0,
		});
		expect(readMutationState()).toEqual(before);
	});

	it("still persists the same links when dryRun is false", async () => {
		const response = await makeApp().request("/api/repair/relink-entities", {
			method: "POST",
			headers: requestHeaders(),
			body: JSON.stringify({ agentId: "agent-relink", batchSize: 1, dryRun: false }),
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			action: "relink-entities",
			dryRun: false,
			processed: 1,
			linked: 1,
			entities: 1,
			remaining: 0,
		});
		expect(readMutationState()).toEqual({ mentions: 1, entityMentions: 1 });
	});
});
