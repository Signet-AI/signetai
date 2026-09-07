import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { runMigrations } from "../../../core/src/migrations";
import { parseAuthConfig } from "../auth";
import type { DbAccessor, ReadDb, WriteDb } from "../db-accessor";
import { createRateLimiter } from "../repair-actions";
import { DEFAULT_PIPELINE_V2 } from "../memory-config";
import { registerRepairRoutes } from "./repair-routes";

let db: Database;
let accessor: DbAccessor;

function makeAccessor(database: Database): DbAccessor {
	return {
		withReadDb<T>(fn: (readDb: ReadDb) => T): T {
			return fn(database as unknown as ReadDb);
		},
		withReadDbAsync<T>(fn: (readDb: ReadDb) => T | Promise<T>): Promise<T> {
			return Promise.resolve(fn(database as unknown as ReadDb));
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
		withWriteTxAsync<T>(fn: (writeDb: WriteDb) => T): Promise<T> {
			return Promise.resolve(this.withWriteTx(fn));
		},
		close(): void {},
	};
}

function app(): Hono {
	const instance = new Hono();
	registerRepairRoutes(instance, {
		authConfig: parseAuthConfig(undefined, "/tmp/signet-repair-admission-test"),
		getDbAccessor: () => accessor,
		limiter: createRateLimiter({ durable: true }),
		pipelineConfig: {
			...DEFAULT_PIPELINE_V2,
			autonomous: { ...DEFAULT_PIPELINE_V2.autonomous, enabled: true, frozen: false },
			repair: { ...DEFAULT_PIPELINE_V2.repair, requeueCooldownMs: 60_000, requeueHourlyBudget: 5 },
		},
	});
	return instance;
}

beforeEach(() => {
	db = new Database(":memory:");
	runMigrations(db as unknown as Parameters<typeof runMigrations>[0]);
	accessor = makeAccessor(db);
	const now = new Date().toISOString();
	db.prepare(
		`INSERT INTO memories (id, content, type, created_at, updated_at, updated_by)
		 VALUES ('route-memory', 'route memory', 'fact', ?, ?, 'test')`,
	).run(now, now);
	db.prepare(
		`INSERT INTO memory_jobs
		 (id, memory_id, job_type, status, attempts, max_attempts, created_at, updated_at)
		 VALUES ('route-job', 'route-memory', 'document_ingest', 'dead', 3, 3, ?, ?)`,
	).run(now, now);
});

afterEach(() => {
	db.close();
});

describe("repair route admission", () => {
	it("returns a truthful 429 when another actor retries inside the durable cooldown", async () => {
		const first = await app().request("/api/repair/requeue-dead", {
			method: "POST",
			headers: { "x-signet-actor": "operator", "x-signet-actor-type": "operator" },
		});
		expect(first.status).toBe(200);

		const retry = await app().request("/api/repair/requeue-dead", {
			method: "POST",
			headers: { "x-signet-actor": "maintenance-worker", "x-signet-actor-type": "daemon" },
		});
		expect(retry.status).toBe(429);
		expect(await retry.json()).toMatchObject({
			success: false,
			code: "repair_admission_denied",
		});
		expect(retry.headers.get("retry-after")).toBeTruthy();
	});
});
