import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { runMigrations } from "../../../../core/src/migrations";
import type { DbAccessor, ReadDb, WriteDb } from "../../db-accessor";
import type { LlmProvider } from "../provider";
import { type DurabilityConfig } from "../durability-gate";
import { type WriteGateConfig } from "../write-gate";
import { INGEST_JOB_TYPE } from "./lease";
import { startIngestWorker } from "./runner";

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

const VALID_BODY = {
	memories: [{ content: "Runner test: a durable preference.", importance: 0.9, type: "preference" }],
	graphOps: [{ operation: "create_entity", payload: { name: "RunnerEntity" }, reason: "test" }],
	filePatches: [],
};

function fakeProvider(): LlmProvider {
	return {
		name: "fake",
		async generate(): Promise<string> {
			return JSON.stringify(VALID_BODY);
		},
		async available(): Promise<boolean> {
			return true;
		},
	} as LlmProvider;
}

function enqueueIngestJob(db: WriteDb, id: string, memoryId: string, agentId: string): void {
	const now = new Date().toISOString();
	db.prepare(
		`INSERT INTO memory_jobs
		 (id, memory_id, job_type, status, payload, attempts, max_attempts, priority, agent_id, created_at, updated_at)
		 VALUES (?, ?, ?, 'pending', NULL, 0, 5, 0, ?, ?, ?)`,
	).run(id, memoryId, INGEST_JOB_TYPE, agentId, now, now);
}

function jobStatus(db: WriteDb, id: string): string {
	return (db.prepare("SELECT status FROM memory_jobs WHERE id = ?").get(id) as { status: string }).status;
}

async function poll(fn: () => boolean, timeoutMs = 1000, intervalMs = 5): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (fn()) return true;
		await new Promise((r) => setTimeout(r, intervalMs));
	}
	return fn();
}

describe("ingest runner", () => {
	let db: Database;
	let accessor: DbAccessor;
	let agentsDir: string;

	beforeEach(() => {
		db = new Database(":memory:");
		runMigrations(db as unknown as Parameters<typeof runMigrations>[0]);
		accessor = makeAccessor(db);
		agentsDir = mkdtempSync(join(tmpdir(), "ingest-runner-"));
	});
	afterEach(() => db.close());

	test("drains an eligible ingest job: plans + applies + completes it", async () => {
		const wdb = db as unknown as WriteDb;
		const now = new Date().toISOString();
		db.prepare(
			`INSERT INTO memories (id, content, agent_id, created_at, updated_at)
			 VALUES ('mem1', 'Source transcript content about a preference.', 'default', ?, ?)`,
		).run(now, now);
		enqueueIngestJob(wdb, "job1", "mem1", "default");

		const handle = startIngestWorker({
			accessor,
			provider: fakeProvider(),
			embedder: { embed: async () => null },
			agentsDir,
			agentId: "default",
			enabled: true,
			applyConfig: {
				actor: "ingest-runner",
				minImportanceForWrite: 0.3,
				writeGate: WRITE_GATE,
				durability: DURABILITY,
				sourceType: "ingest",
				extractionModel: "test-model",
				embeddingModel: "test-embed",
			},
			leaseTimeoutMs: 60_000,
			tickIntervalMs: 5,
		});

		handle.nudge();
		const done = await poll(() => jobStatus(wdb, "job1") === "completed");
		await handle.stop();
		expect(done).toBe(true);
		expect(handle.stats.processed).toBeGreaterThanOrEqual(1);
		// The memory landed.
		const memCount = (wdb.prepare("SELECT COUNT(*) AS c FROM memories WHERE agent_id='default'").get() as { c: number }).c;
		expect(memCount).toBeGreaterThanOrEqual(2); // source + extracted
	});

	test("a disabled worker starts but does not process jobs", async () => {
		const wdb = db as unknown as WriteDb;
		const now = new Date().toISOString();
		db.prepare(
			`INSERT INTO memories (id, content, agent_id, created_at, updated_at) VALUES ('mem1', 'x', 'default', ?, ?)`,
		).run(now, now);
		enqueueIngestJob(wdb, "job1", "mem1", "default");

		const handle = startIngestWorker({
			accessor,
			provider: fakeProvider(),
			embedder: { embed: async () => null },
			agentsDir,
			agentId: "default",
			enabled: false,
			applyConfig: {
				actor: "ingest-runner",
				minImportanceForWrite: 0.3,
				writeGate: WRITE_GATE,
				durability: DURABILITY,
				sourceType: "ingest",
				extractionModel: null,
				embeddingModel: null,
			},
			leaseTimeoutMs: 60_000,
			tickIntervalMs: 5,
		});

		expect(handle.running).toBe(false);
		await new Promise((r) => setTimeout(r, 20));
		expect(jobStatus(wdb, "job1")).toBe("pending"); // untouched
		await handle.stop();
	});
});
