import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { runMigrations } from "../../../core/src/migrations";
import type { DbAccessor, ReadDb, WriteDb } from "../db-accessor";
import { type DurabilityConfig } from "../pipeline/durability-gate";
import { INGEST_JOB_TYPE } from "../pipeline/ingest/lease";
import { IngestPlanSchema } from "../pipeline/ingest/ingest-plan";
import { registerIngestRoutes, type IngestRouteContext } from "./ingest-routes";
import { type WriteGateConfig } from "../pipeline/write-gate";

function makeAccessor(db: Database): DbAccessor {
	return {
		withWriteTx<T>(fn: (d: WriteDb) => T): T {
			return fn(db as unknown as WriteDb);
		},
		withReadDb<T>(fn: (d: ReadDb) => T): T {
			return fn(db as unknown as ReadDb);
		},
		close(): void {
			/* noop */
		},
	};
}

const DURABILITY: DurabilityConfig = { enabled: false };
const WRITE_GATE: WriteGateConfig = { enabled: false, threshold: 0.4, continuityDiscount: 0.15 };

function enqueueJob(db: WriteDb, id: string, memoryId: string, agentId: string): void {
	const now = new Date().toISOString();
	db.prepare(
		`INSERT INTO memory_jobs
		 (id, memory_id, job_type, status, payload, attempts, max_attempts, priority, agent_id, created_at, updated_at)
		 VALUES (?, ?, ?, 'pending', NULL, 0, 5, 0, ?, ?, ?)`,
	).run(id, memoryId, INGEST_JOB_TYPE, agentId, now, now);
}

describe("POST /api/ingest (agentic two-phase)", () => {
	let db: Database;
	let app: Hono;

	beforeEach(() => {
		db = new Database(":memory:");
		runMigrations(db as unknown as Parameters<typeof runMigrations>[0]);
		const accessor = makeAccessor(db);
		const agentsDir = mkdtempSync(join(tmpdir(), "ingest-routes-"));
		const ctx: IngestRouteContext = {
			accessor,
			agentsDir,
			getEmbedder: () => ({ embed: async () => null }),
			applyConfigBase: {
				actor: "agentic",
				minImportanceForWrite: 0.3,
				writeGate: WRITE_GATE,
				durability: DURABILITY,
				sourceType: "ingest",
				extractionModel: "test-model",
				embeddingModel: "test-embed",
			},
			planningLeaseTimeoutMs: 600_000,
			contextWindow: 200_000,
		};
		app = new Hono();
		registerIngestRoutes(app, () => ctx);
	});
	afterEach(() => db.close());

	test("lease returns nothing when no job is eligible", async () => {
		const res = await app.request("/api/ingest/lease", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ agent_id: "default" }),
		});
		const json = (await res.json()) as { eligible: boolean };
		expect(json.eligible).toBe(false);
	});

	test("full two-phase: lease a job, post a plan back, apply completes it", async () => {
		const wdb = db as unknown as WriteDb;
		const now = new Date().toISOString();
		db.prepare(
			`INSERT INTO memories (id, content, agent_id, created_at, updated_at)
			 VALUES ('mem1', 'A preference the harness will reason over.', 'default', ?, ?)`,
		).run(now, now);
		enqueueJob(wdb, "job1", "mem1", "default");

		// 1) Lease.
		const leaseRes = await app.request("/api/ingest/lease", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ agent_id: "default" }),
		});
		const lease = (await leaseRes.json()) as {
			eligible: boolean;
			jobId: string;
			leaseToken: string;
			context: { source: { content: string }; oversize: boolean };
		};
		expect(lease.eligible).toBe(true);
		expect(lease.jobId).toBe("job1");
		expect(lease.leaseToken.length).toBeGreaterThan(0);
		expect(lease.context.source.content).toContain("preference");

		// 2) Harness reasons (here: a canned plan) and posts back.
		const plan = IngestPlanSchema.parse({
			schemaVersion: 1,
			jobId: lease.jobId,
			agentId: "default",
			sourceHash: "sha_test",
			memories: [{ content: "Extracted durable fact from the leased source.", importance: 0.9, type: "fact" }],
			graphOps: [{ operation: "create_entity", payload: { name: "IngestRouteEntity" }, reason: "test" }],
			filePatches: [],
		});
		const applyRes = await app.request("/api/ingest/apply-plan", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ plan, lease_token: lease.leaseToken }),
		});
		const applied = (await applyRes.json()) as { completed: boolean; memories: { outcome: string }[] };
		expect(applied.completed).toBe(true);
		expect(applied.memories[0].outcome).toBe("applied");

		// The job is completed and the memory landed.
		const status = (wdb.prepare("SELECT status FROM memory_jobs WHERE id='job1'").get() as { status: string }).status;
		expect(status).toBe("completed");
	});

	test("apply-plan with a stale lease token does not complete (fencing)", async () => {
		const plan = IngestPlanSchema.parse({
			schemaVersion: 1,
			jobId: "nonexistent",
			agentId: "default",
			sourceHash: "sha_test",
			memories: [{ content: "x", importance: 0.9 }],
			graphOps: [],
			filePatches: [],
		});
		const res = await app.request("/api/ingest/apply-plan", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ plan, lease_token: "not-a-real-token" }),
		});
		const applied = (await res.json()) as { completed: boolean };
		expect(applied.completed).toBe(false);
	});

	test("apply-plan rejects a malformed plan with 400 + details", async () => {
		const res = await app.request("/api/ingest/apply-plan", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ plan: { schemaVersion: 1, jobId: "x" }, lease_token: "tok" }),
		});
		expect(res.status).toBe(400);
		const json = (await res.json()) as { error: string; details: string[] };
		expect(json.error).toMatch(/Invalid IngestPlan/);
		expect(json.details.length).toBeGreaterThan(0);
	});
});
