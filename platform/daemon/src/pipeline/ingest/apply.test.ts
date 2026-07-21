import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { runMigrations } from "../../../../core/src/migrations";
import type { DbAccessor, ReadDb, WriteDb } from "../../db-accessor";
import { type DurabilityConfig, assessDurability } from "../durability-gate";
import { type WriteGateConfig, assessWriteGate } from "../write-gate";
import { applyIngestPlan, computePlanHash, type IngestEmbedder } from "./apply";
import { IngestPlanSchema, type IngestPlan } from "./ingest-plan";
import { INGEST_JOB_TYPE, acquireIngestLease } from "./lease";

/** Single-connection DbAccessor over an in-memory DB (correct for single-threaded tests). */
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

const DURABILITY: DurabilityConfig = { enabled: false }; // bypass: exercise the other guards
const WRITE_GATE: WriteGateConfig = { enabled: false, threshold: 0.4, continuityDiscount: 0.15 };

// Re-exported only to satisfy module-eval order in some bundlers; the gates are
// referenced so unused-import lint stays clean.
void assessDurability;
void assessWriteGate;

const NULL_EMBEDDER: IngestEmbedder = { embed: async () => null };

function enqueue(db: WriteDb, id: string, agentId: string): void {
	const now = new Date().toISOString();
	db.prepare(
		`INSERT INTO memory_jobs
		 (id, memory_id, job_type, status, payload, attempts, max_attempts,
		  priority, agent_id, created_at, updated_at)
		 VALUES (?, NULL, ?, 'pending', '{}', 0, 5, 0, ?, ?, ?)`,
	).run(id, INGEST_JOB_TYPE, agentId, now, now);
}

function memoryCount(db: WriteDb, agentId: string): number {
	const row = db.prepare("SELECT COUNT(*) AS c FROM memories WHERE agent_id = ?").get(agentId) as { c: number };
	return row.c;
}

function entityExists(db: WriteDb, name: string, agentId: string): boolean {
	const row = db
		.prepare("SELECT 1 FROM entities WHERE agent_id = ? AND canonical_name = ? LIMIT 1")
		.get(agentId, name);
	return row !== undefined;
}

function jobStatus(db: WriteDb, id: string): string {
	return (db.prepare("SELECT status FROM memory_jobs WHERE id = ?").get(id) as { status: string }).status;
}

function buildPlan(jobId: string, agentId: string): IngestPlan {
	return IngestPlanSchema.parse({
		schemaVersion: 1,
		jobId,
		agentId,
		sourceHash: "sha_test",
		createdAt: new Date().toISOString(),
		memories: [
			{
				id: "m1",
				content: "Nicholai prefers GLM 5.1 routed through Z.AI, not OpenRouter.",
				why: "stated provider preference",
				importance: 0.9,
				type: "preference",
				tags: ["providers"],
			},
		],
		graphOps: [
			{
				id: "g1",
				operation: "create_entity",
				payload: { name: "GLM 5.1", entity_type: "model" },
				reason: "new entity referenced by the preference",
			},
		],
		filePatches: [],
	});
}

describe("applyIngestPlan", () => {
	let db: Database;
	let accessor: DbAccessor;

	beforeEach(() => {
		db = new Database(":memory:");
		runMigrations(db as unknown as Parameters<typeof runMigrations>[0]);
		accessor = makeAccessor(db);
	});
	afterEach(() => db.close());

	test("a valid plan writes its memory, applies its graph op, and completes the lease", async () => {
		const wdb = db as unknown as WriteDb;
		enqueue(wdb, "job1", "default");
		const lease = acquireIngestLease(wdb, { agentId: "default", owner: "daemon", leaseTimeoutMs: 60_000 });
		expect(lease.ok).toBe(true);
		if (!lease.ok) return;

		const plan = buildPlan("job1", "default");
		const result = await applyIngestPlan(
			accessor,
			plan,
			lease.leaseToken,
			{
				actor: "daemon",
				minImportanceForWrite: 0.3,
				writeGate: WRITE_GATE,
				durability: DURABILITY,
				sourceType: "ingest",
				sourceId: "job1",
				extractionModel: "test-model",
				embeddingModel: "test-embed",
			},
			NULL_EMBEDDER,
		);

		expect(result.completed).toBe(true);
		expect(result.memories).toHaveLength(1);
		expect(result.memories[0].outcome).toBe("applied");
		expect(result.graph.applied).toBe(1);
		expect(result.graph.failed).toBe(0);
		expect(memoryCount(wdb, "default")).toBe(1);
		expect(entityExists(wdb, "GLM 5.1", "default")).toBe(true);
		expect(jobStatus(wdb, "job1")).toBe("completed");
	});

	test("a stale lease token writes nothing and does not complete (fencing)", async () => {
		const wdb = db as unknown as WriteDb;
		enqueue(wdb, "job1", "default");
		// Never acquire — apply with a fabricated token. The lease is unverified.
		const plan = buildPlan("job1", "default");
		const result = await applyIngestPlan(
			accessor,
			plan,
			"not-a-real-lease-token",
			{
				actor: "daemon",
				minImportanceForWrite: 0.3,
				writeGate: WRITE_GATE,
				durability: DURABILITY,
				sourceType: "ingest",
				sourceId: "job1",
				extractionModel: null,
				embeddingModel: null,
			},
			NULL_EMBEDDER,
		);

		expect(result.completed).toBe(false);
		expect(result.memories).toHaveLength(0); // fence stops before any write
		expect(result.graph.applied).toBe(0);
		expect(result.graph.failed).toBe(0);
		expect(memoryCount(wdb, "default")).toBe(0);
		expect(jobStatus(wdb, "job1")).toBe("pending"); // untouched
	});

	test("a memory below the importance floor is skipped, not written", async () => {
		const wdb = db as unknown as WriteDb;
		enqueue(wdb, "job1", "default");
		const lease = acquireIngestLease(wdb, { agentId: "default", owner: "daemon", leaseTimeoutMs: 60_000 });
		if (!lease.ok) return;
		const plan = buildPlan("job1", "default");
		plan.memories[0].importance = 0.1; // below the 0.3 floor

		const result = await applyIngestPlan(
			accessor,
			plan,
			lease.leaseToken,
			{
				actor: "daemon",
				minImportanceForWrite: 0.3,
				writeGate: WRITE_GATE,
				durability: DURABILITY,
				sourceType: "ingest",
				sourceId: "job1",
				extractionModel: null,
				embeddingModel: null,
			},
			NULL_EMBEDDER,
		);

		expect(result.memories[0].outcome).toBe("skipped");
		expect(result.memories[0].reason).toBe("low_importance");
		expect(memoryCount(wdb, "default")).toBe(0);
	});

	test("computePlanHash is deterministic and reflects the op set (not model-authored)", () => {
		const p1 = buildPlan("job1", "default");
		const p2 = buildPlan("job1", "default");
		expect(computePlanHash(p1)).toBe(computePlanHash(p2));
		p2.memories[0].content = "different content";
		expect(computePlanHash(p1)).not.toBe(computePlanHash(p2));
	});
});
