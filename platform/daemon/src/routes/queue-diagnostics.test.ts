/**
 * Issue #901 — regression tests for /api/diagnostics/queue + repair.
 *
 * Uses an in-memory SQLite DB with real migrations so the queue
 * breakdowns read against production-shaped tables.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { runMigrations } from "../../../core/src/migrations";
import type { DbAccessor, ReadDb, WriteDb } from "../db-accessor";
import { createRateLimiter } from "../repair-actions";
import { registerPipelineRoutes } from "./pipeline-routes";
import { registerQueueDiagnosticsRoutes } from "./queue-diagnostics";

function makeAccessor(db: Database): DbAccessor {
	return {
		withReadDb<T>(fn: (readDb: ReadDb) => T): T {
			return fn(db as unknown as ReadDb);
		},
		withWriteTx<T>(fn: (writeDb: WriteDb) => T): T {
			db.exec("BEGIN IMMEDIATE");
			try {
				const result = fn(db as unknown as WriteDb);
				db.exec("COMMIT");
				return result;
			} catch (err) {
				db.exec("ROLLBACK");
				throw err;
			}
		},
		close(): void {},
	};
}

function seedDb(db: Database): void {
	const nowIso = new Date().toISOString();
	const oldIso = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString();
	const memRow = db
		.prepare(
			`INSERT INTO memories (id, type, content, confidence, tags, created_at, updated_at,
				updated_by, version, manual_override, is_deleted, embedding_model)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
		)
		.get("mem-1", "fact", "seed", 0.9, "[]", nowIso, nowIso, "test", 1, 0, 0, null) as { id: string } | undefined;
	if (!memRow) throw new Error("seed failed");

	db.prepare(
		`INSERT INTO memory_jobs (id, memory_id, job_type, status, attempts, max_attempts,
			created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
	).run("dead-mem-1", memRow.id, "document_ingest", "dead", 3, 3, oldIso, oldIso);

	db.prepare(
		`INSERT INTO summary_jobs (id, session_key, harness, project, transcript, status,
			attempts, max_attempts, created_at, error)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run("dead-sum-1", "session-A", "codex", "demo", "transcript", "dead", 3, 3, oldIso, "boom");
	db.prepare(
		`INSERT INTO summary_jobs (id, session_key, harness, project, transcript, status,
			attempts, max_attempts, created_at, error)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run("dead-sum-2", "session-B", "codex", "demo", "transcript", "dead", 3, 3, oldIso, null);
}

interface DbEnv {
	db: Database;
	accessor: DbAccessor;
	app: Hono;
}

function setup(authConfig?: NonNullable<Parameters<typeof registerQueueDiagnosticsRoutes>[1]>["authConfig"]): DbEnv {
	const db = new Database(":memory:");
	db.exec("PRAGMA journal_mode = WAL");
	runMigrations(db as unknown as Parameters<typeof runMigrations>[0]);
	seedDb(db);
	const accessor = makeAccessor(db);
	const limiter = createRateLimiter();
	const app = new Hono();
	registerQueueDiagnosticsRoutes(app, { accessor, limiter, authConfig });
	return { db, accessor, app };
}

describe("/api/diagnostics/queue", () => {
	let env: DbEnv;
	beforeEach(() => {
		env = setup();
	});
	afterEach(() => {
		env.db.close();
	});

	it("requires admin permission in team mode", async () => {
		const guarded = setup({ mode: "team" } as NonNullable<
			Parameters<typeof registerQueueDiagnosticsRoutes>[1]
		>["authConfig"]);
		try {
			const getResponse = await guarded.app.request("/api/diagnostics/queue");
			expect(getResponse.status).toBe(403);
			const repairResponse = await guarded.app.request("/api/diagnostics/queue/repair", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ action: "cancel" }),
			});
			expect(repairResponse.status).toBe(403);
		} finally {
			guarded.db.close();
		}
	});

	it("returns per-queue counts, oldest deads, and thresholds", async () => {
		const res = await env.app.request("/api/diagnostics/queue");
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			queues: { memory: { dead: number }; summary: { dead: number } };
			oldestDeadSummaryJob: { id: string } | null;
			thresholds: { summaryDeadWarn: number };
		};
		expect(body.queues.memory.dead).toBe(1);
		expect(body.queues.summary.dead).toBe(0);
		expect(body.queues).not.toHaveProperty("extraction");
		expect(body.oldestDeadSummaryJob).toBeNull();
		expect(body.thresholds.summaryDeadWarn).toBe(50);
	});

	it("wins over the generic diagnostics domain route", async () => {
		const app = new Hono();
		registerPipelineRoutes(app);
		registerQueueDiagnosticsRoutes(app, { accessor: env.accessor, limiter: createRateLimiter() });

		const res = await app.request("/api/diagnostics/queue");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { timestamp?: string; queues?: { memory?: unknown } };
		expect(body.timestamp).toEqual(expect.any(String));
		expect(body.queues?.memory).toBeDefined();
	});

	it("preserves the queue admin guard after the generic route forwards", async () => {
		const app = new Hono();
		registerPipelineRoutes(app);
		registerQueueDiagnosticsRoutes(app, {
			accessor: env.accessor,
			limiter: createRateLimiter(),
			authConfig: { mode: "team" } as NonNullable<Parameters<typeof registerQueueDiagnosticsRoutes>[1]>["authConfig"],
		});

		expect((await app.request("/api/diagnostics/queue")).status).toBe(403);
	});

	it("does not shadow the concrete OpenClaw diagnostics route", async () => {
		const app = new Hono();
		registerPipelineRoutes(app);

		const res = await app.request("/api/diagnostics/openclaw");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { status?: string };
		expect(body.status).toBeOneOf(["connected", "stale", "never-seen"]);
	});
});

describe("POST /api/diagnostics/queue/repair", () => {
	let env: DbEnv;
	beforeEach(() => {
		env = setup();
	});
	afterEach(() => {
		env.db.close();
	});

	it("rejects retired summary repair tables with an actionable status", async () => {
		const res = await env.app.request("/api/diagnostics/queue/repair", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ action: "requeue", tables: ["summary"] }),
		});
		expect(res.status).toBe(410);
		const body = (await res.json()) as { success: boolean; message: string };
		expect(body.success).toBe(false);
		expect(body.message).toContain("summary worker retired");
	});

	it("rejects invalid action with 400", async () => {
		const res = await env.app.request("/api/diagnostics/queue/repair", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ action: "explode" }),
		});
		expect(res.status).toBe(400);
	});
});

describe("repair action integration via the new dispatch path", () => {
	it("returns a structured result when a repair action throws (no unstructured 500)", async () => {
		// Simulate a degraded runtime: the write transaction throws (e.g. a
		// missing migrations table, a closed DbAccessor, or a transient SQLite
		// error). The handler must return the documented RepairResult instead
		// of propagating an unhandled exception. Mirrors the GET sibling and
		// the Rust parity handler.
		const db = new Database(":memory:");
		try {
			runMigrations(db as unknown as Parameters<typeof runMigrations>[0]);
			const throwingAccessor: DbAccessor = {
				withReadDb: () => {
					throw new Error("simulated degraded runtime: DbAccessor is closed");
				},
				withWriteTx: () => {
					throw new Error("simulated degraded runtime: DbAccessor is closed");
				},
				close(): void {},
			};
			const app = new Hono();
			registerQueueDiagnosticsRoutes(app, {
				accessor: throwingAccessor,
				limiter: createRateLimiter(),
			});

			const res = await app.request("/api/diagnostics/queue/repair", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ action: "cancel", dryRun: false }),
			});
			expect(res.status).toBe(500);
			const body = (await res.json()) as { action: string; success: boolean; affected: number; message: string };
			expect(body.success).toBe(false);
			expect(body.affected).toBe(0);
			expect(body.action).toBe("cancel");
			expect(body.message).toMatch(/simulated degraded runtime/);
		} finally {
			db.close();
		}
	});
});
