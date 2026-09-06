import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { parseAuthConfig } from "../auth";
import type { DbAccessor, ReadDb, WriteDb } from "../db-accessor";
import type { IntegrityCheckResult, OperatorIntegrityCheckOptions } from "../database-integrity-check";
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

function makeApp(
	runIntegrityCheck?: (accessor: DbAccessor, options?: OperatorIntegrityCheckOptions) => Promise<IntegrityCheckResult>,
): Hono {
	const app = new Hono();
	registerRepairRoutes(app, {
		authConfig: parseAuthConfig(undefined, "/tmp/signet-repair-routes-test"),
		getDbAccessor: () => accessor,
		runIntegrityCheck,
	});
	return app;
}

function healthyIntegrityResult(): IntegrityCheckResult {
	return {
		ok: true,
		messages: [],
		quickCheck: { ok: true, messages: [] },
		fullCheck: { ok: true, messages: [] },
		phase: "complete",
		outcome: "passed",
		error: null,
		executionHome: "db-owner.verify",
		checkpointKey: "database.operator-integrity",
		deadlineMs: 60_000,
		durationMs: 8,
		ownerQueueAdmissionMs: 1,
		ownerExecutionMs: 4,
	};
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

describe("GET /api/repair/integrity-check", () => {
	it("waits for the owner result instead of serializing a live Promise", async () => {
		let complete!: () => void;
		let settled = false;
		const ownerResult = new Promise<IntegrityCheckResult>((resolve) => {
			complete = () => {
				settled = true;
				resolve(healthyIntegrityResult());
			};
		});
		const responsePromise = makeApp(() => ownerResult).request("/api/repair/integrity-check");
		await Bun.sleep(10);
		expect(settled).toBe(false);
		complete();

		const response = await responsePromise;
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ outcome: "passed", executionHome: "db-owner.verify" });
	});

	it("returns an owner failure after it settles instead of detaching it", async () => {
		let reject!: (error: Error) => void;
		let settled = false;
		const ownerResult = new Promise<IntegrityCheckResult>((_, rejectPromise) => {
			reject = (error: Error) => {
				settled = true;
				rejectPromise(error);
			};
		});
		const app = makeApp(() => ownerResult);
		app.onError((error, c) => c.json({ error: error.message }, 500));
		const responsePromise = app.request("/api/repair/integrity-check");
		await Bun.sleep(10);
		expect(settled).toBe(false);
		reject(new Error("verification owner unavailable"));

		const response = await responsePromise;
		expect(response.status).toBe(500);
		expect(await response.json()).toEqual({ error: "verification owner unavailable" });
	});
});

describe("retired semantic repair routes", () => {
	it("does not expose structural-backfill after the Dreaming cutover", async () => {
		const response = await makeApp().request("/api/repair/structural-backfill", {
			method: "POST",
			headers: requestHeaders(),
		});

		expect(response.status).toBe(404);
	});

	it("does not expose the legacy LLM entity reclassification route", async () => {
		const response = await makeApp().request("/api/repair/reclassify-entities", {
			method: "POST",
			headers: requestHeaders(),
		});

		expect(response.status).toBe(404);
	});
});
