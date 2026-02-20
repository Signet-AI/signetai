/**
 * Tests for the pipeline job worker.
 *
 * Uses a real in-memory SQLite database with full migrations applied
 * so the queue schema is exactly as production uses it.
 */

import {
	describe,
	it,
	expect,
	beforeEach,
	afterEach,
} from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "@signet/core";
import { enqueueExtractionJob, startWorker } from "./worker";
import type { DbAccessor, WriteDb, ReadDb } from "../db-accessor";
import type { LlmProvider } from "./provider";
import type { PipelineV2Config } from "../memory-config";
import type { DecisionConfig } from "./decision";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAccessor(db: Database): DbAccessor {
	return {
		withWriteTx<T>(fn: (db: WriteDb) => T): T {
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
		withReadDb<T>(fn: (db: ReadDb) => T): T {
			return fn(db as unknown as ReadDb);
		},
		close() {
			db.close();
		},
	};
}

function insertMemory(db: Database, id: string, content: string): void {
	const now = new Date().toISOString();
	db.prepare(
		`INSERT INTO memories
		 (id, type, content, confidence, importance, created_at, updated_at,
		  updated_by, vector_clock, is_deleted, extraction_status)
		 VALUES (?, 'fact', ?, 1.0, 0.5, ?, ?, 'test', '{}', 0, 'none')`,
	).run(id, content, now, now);
}

function getJob(
	db: Database,
	memoryId: string,
): { status: string; attempts: number; error: string | null; result: string | null } | undefined {
	return db
		.prepare(
			`SELECT status, attempts, error, result FROM memory_jobs WHERE memory_id = ?`,
		)
		.get(memoryId) as
		| { status: string; attempts: number; error: string | null; result: string | null }
		| undefined;
}

function getHistoryCount(db: Database, memoryId: string): number {
	const row = db
		.prepare(
			`SELECT COUNT(*) as cnt FROM memory_history WHERE memory_id = ?`,
		)
		.get(memoryId) as { cnt: number };
	return row.cnt;
}

/** Provider that returns a valid extraction response (1 fact, no candidates). */
function goodProvider(): LlmProvider {
	const extractionResponse = JSON.stringify({
		facts: [
			{
				content: "User prefers dark mode in their editor settings",
				type: "preference",
				confidence: 0.9,
			},
		],
		entities: [
			{
				source: "User",
				relationship: "prefers",
				target: "dark mode",
				confidence: 0.9,
			},
		],
	});
	return {
		name: "mock-good",
		async generate() {
			return extractionResponse;
		},
		async available() {
			return true;
		},
	};
}

/**
 * Provider that returns an empty-but-valid extraction response.
 * Simulates LLM returning nothing useful (e.g., error was caught inside
 * extractFactsAndEntities and returned as warnings).
 */
function emptyProvider(): LlmProvider {
	return {
		name: "mock-empty",
		async generate() {
			return JSON.stringify({ facts: [], entities: [] });
		},
		async available() {
			return true;
		},
	};
}

/**
 * Provider that throws. Note: extraction catches this and returns
 * empty facts, so the job still completes. The error appears in the
 * result.warnings payload.
 */
function throwingProvider(): LlmProvider {
	return {
		name: "mock-throw",
		async generate() {
			throw new Error("LLM unavailable");
		},
		async available() {
			return false;
		},
	};
}

/**
 * Build a provider that throws from generate() on the N-th call,
 * where N = the SECOND call. Used to simulate extraction succeeding
 * but something else going wrong at the worker level via a mock accessor.
 */

const PIPELINE_CFG: PipelineV2Config = {
	enabled: true,
	shadowMode: true,
	allowUpdateDelete: false,
	graphEnabled: false,
	autonomousEnabled: false,
	mutationsFrozen: false,
	autonomousFrozen: false,
	extractionModel: "qwen3:4b",
	extractionTimeout: 5000,
	workerPollMs: 10, // fast polling for tests
	workerMaxRetries: 3,
	leaseTimeoutMs: 300000,
};

const DECISION_CFG: DecisionConfig = {
	embedding: {
		provider: "ollama",
		model: "nomic-embed-text",
		dimensions: 768,
		base_url: "http://localhost:11434",
	},
	search: { alpha: 0.7, top_k: 20, min_score: 0.0 },
	async fetchEmbedding() {
		return null;
	},
};

// ---------------------------------------------------------------------------
// enqueueExtractionJob tests
// ---------------------------------------------------------------------------

describe("enqueueExtractionJob", () => {
	let db: Database;
	let accessor: DbAccessor;

	beforeEach(() => {
		db = new Database(":memory:");
		runMigrations(db as unknown as Parameters<typeof runMigrations>[0]);
		accessor = makeAccessor(db);
	});

	afterEach(() => {
		db.close();
	});

	it("inserts a pending job for the given memory_id", () => {
		insertMemory(db, "mem-a", "Some content about the user");
		enqueueExtractionJob(accessor, "mem-a");

		const row = db
			.prepare(
				`SELECT status, job_type, attempts, max_attempts
				 FROM memory_jobs WHERE memory_id = ?`,
			)
			.get("mem-a") as
			| {
					status: string;
					job_type: string;
					attempts: number;
					max_attempts: number;
			  }
			| undefined;

		expect(row).toBeDefined();
		expect(row?.status).toBe("pending");
		expect(row?.job_type).toBe("extract");
		expect(row?.attempts).toBe(0);
		expect(row?.max_attempts).toBe(3);
	});

	it("deduplicates: does not insert a second job when one is already pending", () => {
		insertMemory(db, "mem-b", "Some content about the user");
		enqueueExtractionJob(accessor, "mem-b");
		enqueueExtractionJob(accessor, "mem-b");

		const rows = db
			.prepare(`SELECT id FROM memory_jobs WHERE memory_id = ?`)
			.all("mem-b") as Array<{ id: string }>;

		expect(rows).toHaveLength(1);
	});

	it("allows a new job after the previous one is completed", () => {
		insertMemory(db, "mem-c", "Some content about the user");
		enqueueExtractionJob(accessor, "mem-c");

		// Mark the job completed
		db.prepare(
			`UPDATE memory_jobs SET status = 'completed' WHERE memory_id = ?`,
		).run("mem-c");

		// Enqueue again - should insert a new one
		enqueueExtractionJob(accessor, "mem-c");

		const rows = db
			.prepare(`SELECT id FROM memory_jobs WHERE memory_id = ?`)
			.all("mem-c") as Array<{ id: string }>;

		expect(rows).toHaveLength(2);
	});

	it("does not insert a job when a leased job already exists", () => {
		insertMemory(db, "mem-d", "Some content about the user");
		enqueueExtractionJob(accessor, "mem-d");

		// Mark as leased (in-flight)
		db.prepare(
			`UPDATE memory_jobs SET status = 'leased' WHERE memory_id = ?`,
		).run("mem-d");

		enqueueExtractionJob(accessor, "mem-d");

		const rows = db
			.prepare(`SELECT id FROM memory_jobs WHERE memory_id = ?`)
			.all("mem-d") as Array<{ id: string }>;

		expect(rows).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// Worker processing tests
// ---------------------------------------------------------------------------

describe("Worker processing", () => {
	let db: Database;
	let accessor: DbAccessor;

	beforeEach(() => {
		db = new Database(":memory:");
		runMigrations(db as unknown as Parameters<typeof runMigrations>[0]);
		accessor = makeAccessor(db);
	});

	afterEach(() => {
		db.close();
	});

	it("processes a job and marks it completed", async () => {
		insertMemory(db, "mem-proc", "User prefers dark mode in their IDE setup");
		enqueueExtractionJob(accessor, "mem-proc");

		const worker = startWorker(
			accessor,
			goodProvider(),
			PIPELINE_CFG,
			DECISION_CFG,
		);

		await Bun.sleep(200);
		await worker.stop();

		const job = getJob(db, "mem-proc");
		expect(job?.status).toBe("completed");
		expect(job?.attempts).toBe(1);

		// Extraction status on memory should be 'completed'
		const mem = db
			.prepare(`SELECT extraction_status FROM memories WHERE id = ?`)
			.get("mem-proc") as { extraction_status: string } | undefined;
		expect(mem?.extraction_status).toBe("completed");
	});

	it("records shadow history entries for each proposal", async () => {
		insertMemory(db, "mem-hist", "User prefers dark mode in their IDE setup");
		enqueueExtractionJob(accessor, "mem-hist");

		const worker = startWorker(
			accessor,
			goodProvider(),
			PIPELINE_CFG,
			DECISION_CFG,
		);

		await Bun.sleep(200);
		await worker.stop();

		// 1 fact, no candidates in empty DB => 1 ADD proposal => 1 history row
		const histCount = getHistoryCount(db, "mem-hist");
		expect(histCount).toBeGreaterThanOrEqual(1);

		// Verify the history record has shadow metadata
		const histRow = db
			.prepare(
				`SELECT metadata, changed_by FROM memory_history WHERE memory_id = ?`,
			)
			.get("mem-hist") as
			| { metadata: string; changed_by: string }
			| undefined;

		expect(histRow?.changed_by).toBe("pipeline-shadow");
		const meta = JSON.parse(histRow?.metadata ?? "{}");
		expect(meta.shadow).toBe(true);
		expect(meta.proposedAction).toBe("add");
	});

	it("job result payload includes fact and entity counts", async () => {
		insertMemory(db, "mem-payload", "User prefers dark mode in their IDE setup");
		enqueueExtractionJob(accessor, "mem-payload");

		const worker = startWorker(
			accessor,
			goodProvider(),
			PIPELINE_CFG,
			DECISION_CFG,
		);

		await Bun.sleep(200);
		await worker.stop();

		const job = getJob(db, "mem-payload");
		expect(job?.result).toBeTruthy();
		const result = JSON.parse(job?.result ?? "{}");
		expect(Array.isArray(result.facts)).toBe(true);
		expect(Array.isArray(result.entities)).toBe(true);
		expect(Array.isArray(result.proposals)).toBe(true);
		expect(result.facts.length).toBe(1);
		expect(result.entities.length).toBe(1);
	});

	it("skips gracefully when memory_id is not found", async () => {
		// Manually insert a job for a non-existent memory
		const now = new Date().toISOString();
		db.prepare(
			`INSERT INTO memory_jobs
			 (id, memory_id, job_type, status, attempts, max_attempts, created_at, updated_at)
			 VALUES ('job-ghost', 'mem-ghost', 'extract', 'pending', 0, 3, ?, ?)`,
		).run(now, now);

		const worker = startWorker(
			accessor,
			goodProvider(),
			PIPELINE_CFG,
			DECISION_CFG,
		);

		await Bun.sleep(200);
		await worker.stop();

		const job = db
			.prepare(`SELECT status, result FROM memory_jobs WHERE id = ?`)
			.get("job-ghost") as { status: string; result: string } | undefined;

		// Job should be completed with a skipped result
		expect(job?.status).toBe("completed");
		const result = JSON.parse(job?.result ?? "{}");
		expect(result.skipped).toBe("memory_not_found");
	});

	it("records LLM error in result warnings when provider throws", async () => {
		// When the LLM throws, extractFactsAndEntities catches it and returns
		// empty facts with a warning. The job still completes successfully
		// (no facts = no proposals = clean write). The error is in the payload.
		insertMemory(db, "mem-llm-err", "Some content about preferences");
		enqueueExtractionJob(accessor, "mem-llm-err");

		const worker = startWorker(
			accessor,
			throwingProvider(),
			PIPELINE_CFG,
			DECISION_CFG,
		);

		await Bun.sleep(200);
		await worker.stop();

		const job = getJob(db, "mem-llm-err");
		// Job completes (extraction caught the error and returned empty)
		expect(job?.status).toBe("completed");

		const result = JSON.parse(job?.result ?? "{}");
		expect(Array.isArray(result.warnings)).toBe(true);
		expect(result.warnings.some((w: string) => w.includes("LLM error"))).toBe(true);
	});

	it("worker stop() waits for in-flight job", async () => {
		let resolveJob!: () => void;
		const barrier = new Promise<void>((res) => {
			resolveJob = res;
		});

		const slowProvider: LlmProvider = {
			name: "slow",
			async generate() {
				await barrier;
				return JSON.stringify({ facts: [], entities: [] });
			},
			async available() {
				return true;
			},
		};

		insertMemory(db, "mem-slow", "User prefers slow dark mode setup");
		enqueueExtractionJob(accessor, "mem-slow");

		const worker = startWorker(accessor, slowProvider, PIPELINE_CFG, DECISION_CFG);

		// Give the worker a moment to pick up the job
		await Bun.sleep(50);

		// Stop is called while job is in flight
		const stopPromise = worker.stop();

		// Resolve the barrier so the job can finish
		resolveJob();

		// Stop should resolve now that the job is done
		await stopPromise;

		expect(worker.running).toBe(false);

		// Job should be completed after stop
		const job = getJob(db, "mem-slow");
		expect(job?.status).toBe("completed");
	});

	it("worker is not running after stop()", async () => {
		const worker = startWorker(
			accessor,
			goodProvider(),
			PIPELINE_CFG,
			DECISION_CFG,
		);

		expect(worker.running).toBe(true);
		await worker.stop();
		expect(worker.running).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Worker failure/retry path tests
// ---------------------------------------------------------------------------

describe("Worker dead-job path", () => {
	let db: Database;
	let accessor: DbAccessor;

	beforeEach(() => {
		db = new Database(":memory:");
		runMigrations(db as unknown as Parameters<typeof runMigrations>[0]);
		accessor = makeAccessor(db);
	});

	afterEach(() => {
		db.close();
	});

	/**
	 * To test the failJob path we need processExtractJob to throw.
	 * Injection strategy: fail on call 2 (completion write inside
	 * processExtractJob), let calls 1 and 3 through (leaseJob and
	 * the failJob recovery write).
	 *
	 * Call sequence per tick:
	 *   1. accessor.withWriteTx -> leaseJob
	 *   2. accessor.withWriteTx -> completeJob (inside processExtractJob)
	 *   3. accessor.withWriteTx -> failJob (inside catch block in tick)
	 */
	it("marks job dead after max_attempts when processExtractJob throws", async () => {
		insertMemory(db, "mem-die", "User prefers dark mode in IDE");
		enqueueExtractionJob(accessor, "mem-die");

		// max_attempts = 1 so first failure = dead
		db.prepare(
			`UPDATE memory_jobs SET max_attempts = 1 WHERE memory_id = ?`,
		).run("mem-die");

		let writeCalls = 0;
		const faultyAccessor: DbAccessor = {
			withWriteTx<T>(fn: (db: WriteDb) => T): T {
				writeCalls++;
				// Call 2 is the processExtractJob completion write - inject failure
				if (writeCalls === 2) {
					throw new Error("DB write failed");
				}
				// All other calls (lease, failJob) succeed on the real db
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
			withReadDb<T>(fn: (db: ReadDb) => T): T {
				return fn(db as unknown as ReadDb);
			},
			close() {},
		};

		const cfg = { ...PIPELINE_CFG, workerMaxRetries: 1, workerPollMs: 10 };
		const worker = startWorker(faultyAccessor, goodProvider(), cfg, DECISION_CFG);
		await Bun.sleep(300);
		await worker.stop();

		const job = getJob(db, "mem-die");
		expect(job?.status).toBe("dead");
		expect(job?.attempts).toBeGreaterThanOrEqual(1);
	});

	it("re-queues job as pending when below max_attempts", async () => {
		insertMemory(db, "mem-retry", "User prefers dark editor mode");
		enqueueExtractionJob(accessor, "mem-retry");

		// max_attempts = 3, so first failure should go back to pending
		let writeCalls = 0;
		const faultyAccessor: DbAccessor = {
			withWriteTx<T>(fn: (db: WriteDb) => T): T {
				writeCalls++;
				// Call 2 (completion write) fails; calls 1 and 3 succeed
				if (writeCalls === 2) {
					throw new Error("transient failure");
				}
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
			withReadDb<T>(fn: (db: ReadDb) => T): T {
				return fn(db as unknown as ReadDb);
			},
			close() {},
		};

		const cfg = { ...PIPELINE_CFG, workerMaxRetries: 3, workerPollMs: 10 };
		const worker = startWorker(faultyAccessor, goodProvider(), cfg, DECISION_CFG);
		// Wait for tick 1 to complete (lease + fail + failJob)
		await Bun.sleep(150);
		await worker.stop();

		const job = getJob(db, "mem-retry");
		expect(job).toBeDefined();
		expect(job!.attempts).toBeGreaterThanOrEqual(1);
		// With max_attempts=3 and attempts=1, job goes back to pending
		expect(job!.status).toBe("pending");
	});
});
