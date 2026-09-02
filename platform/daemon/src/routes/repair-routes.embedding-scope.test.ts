import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { parseAuthConfig } from "../auth";
import type { DbAccessor, ReadDb, WriteDb } from "../db-accessor";
import { registerRepairRoutes } from "./repair-routes";

let db: Database;
let app: Hono;

function makeAccessor(database: Database): DbAccessor {
	const read = (fn: (readDb: ReadDb) => unknown): unknown => fn(database as unknown as ReadDb);
	const write = (fn: (writeDb: WriteDb) => unknown): unknown => fn(database as unknown as WriteDb);
	return {
		withReadDb: read,
		withReadDbAsync: async (fn) => await fn(database as unknown as ReadDb),
		withWriteDbAsync: async (fn) => await fn(database as unknown as WriteDb),
		withWriteTxAsync: async (fn) => await fn(database as unknown as WriteDb),
		close: () => undefined,
		write,
	} as unknown as DbAccessor;
}

function seedSameHashMemories(): void {
	db.exec(`
		CREATE TABLE memories (
			id TEXT PRIMARY KEY,
			content TEXT NOT NULL,
			content_hash TEXT,
			agent_id TEXT,
			is_deleted INTEGER NOT NULL DEFAULT 0,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
		CREATE TABLE embeddings (
			id TEXT PRIMARY KEY,
			content_hash TEXT,
			source_type TEXT NOT NULL,
			source_id TEXT NOT NULL
		);
		CREATE TABLE embedding_repair_budget (
			id INTEGER PRIMARY KEY,
			window_started_at TEXT NOT NULL,
			batches_started INTEGER NOT NULL,
			last_completed_at TEXT,
			last_affected INTEGER NOT NULL,
			lease_id TEXT,
			lease_expires_at TEXT,
			last_error TEXT,
			updated_at TEXT NOT NULL
		);
	`);

	const now = new Date().toISOString();
	db.prepare(
		"INSERT INTO embedding_repair_budget (id, window_started_at, batches_started, last_completed_at, last_affected, lease_id, lease_expires_at, last_error, updated_at) VALUES (1, ?, 0, NULL, 0, NULL, NULL, NULL, ?)",
	).run(now, now);
	db.prepare(
		"INSERT INTO memories (id, content, content_hash, agent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
	).run("memory-a", "same content", "same-hash", "agent-a", now, now);
	db.prepare(
		"INSERT INTO memories (id, content, content_hash, agent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
	).run("memory-b", "same content", "same-hash", "agent-b", now, now);
	db.prepare("INSERT INTO embeddings (id, content_hash, source_type, source_id) VALUES (?, ?, 'memory', ?)").run(
		"embedding-a",
		"same-hash",
		"memory-a",
	);
}

beforeEach(() => {
	db = new Database(":memory:");
	seedSameHashMemories();
	app = new Hono();
	registerRepairRoutes(app, {
		authConfig: parseAuthConfig(undefined, "/tmp/signet-repair-scope-test"),
		getDbAccessor: () => makeAccessor(db),
	});
});

afterEach(() => {
	db.close();
});

describe("GET /api/repair/embedding-gaps", () => {
	it("keeps same-hash coverage scoped to the requested agent for issue #1794", async () => {
		const agentB = await app.request("/api/repair/embedding-gaps?agentId=agent-b");
		expect(agentB.status).toBe(200);
		expect(await agentB.json()).toMatchObject({
			total: 1,
			unembedded: 1,
			embedded: 0,
			complete: false,
		});

		const agentA = await app.request("/api/repair/embedding-gaps?agentId=agent-a");
		expect(agentA.status).toBe(200);
		expect(await agentA.json()).toMatchObject({
			total: 1,
			unembedded: 0,
			embedded: 1,
			complete: true,
		});
	});
});
