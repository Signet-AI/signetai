/**
 * Tests for the pipeline job worker.
 *
 * Uses a real in-memory SQLite database with full migrations applied
 * so the queue schema is exactly as production uses it.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
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
):
	| {
			status: string;
			attempts: number;
			error: string | null;
			result: string | null;
	  }
	| undefined {
	return db
		.prepare(
			`SELECT status, attempts, error, result FROM memory_jobs WHERE memory_id = ?`,
		)
		.get(memoryId) as
		| {
				status: string;
				attempts: number;
				error: string | null;
				result: string | null;
		  }
		| undefined;
}

function getHistoryCount(db: Database, memoryId: string): number {
	const row = db
		.prepare(`SELECT COUNT(*) as cnt FROM memory_history WHERE memory_id = ?`)
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

function scriptedProvider(outputs: readonly string[]): LlmProvider {
	let cursor = 0;
	return {
		name: "mock-scripted",
		async generate() {
			// Clamp to the final scripted output once the sequence is exhausted.
			const output = outputs[Math.min(cursor, outputs.length - 1)] ?? "";
			cursor += 1;
			return output;
		},
		async available() {
			return true;
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
	minFactConfidenceForWrite: 0.7,
};

const PHASE_C_CFG: PipelineV2Config = {
	...PIPELINE_CFG,
	shadowMode: false,
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

function decisionCfgWithEmbedding(
	vector: readonly number[] | null,
): DecisionConfig {
	return {
		...DECISION_CFG,
		async fetchEmbedding() {
			return vector ? Array.from(vector) : null;
		},
	};
}

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
				`SELECT metadata, changed_by, event FROM memory_history WHERE memory_id = ?`,
			)
			.get("mem-hist") as
			| { metadata: string; changed_by: string; event: string }
			| undefined;

		expect(histRow?.changed_by).toBe("pipeline-shadow");
		expect(histRow?.event).toBe("none");
		const meta = JSON.parse(histRow?.metadata ?? "{}");
		expect(meta.shadow).toBe(true);
		expect(meta.proposedAction).toBe("add");
	});

	it("job result payload includes fact and entity counts", async () => {
		insertMemory(
			db,
			"mem-payload",
			"User prefers dark mode in their IDE setup",
		);
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
		expect(result.warnings.some((w: string) => w.includes("LLM error"))).toBe(
			true,
		);
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

		const worker = startWorker(
			accessor,
			slowProvider,
			PIPELINE_CFG,
			DECISION_CFG,
		);

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
// Phase C controlled-write tests
// ---------------------------------------------------------------------------

describe("Worker phase C controlled writes", () => {
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

	it("applies ADD proposals into new memory rows and writes embedding linkage", async () => {
		insertMemory(
			db,
			"mem-src-add",
			"User prefers dark mode in their IDE setup",
		);
		enqueueExtractionJob(accessor, "mem-src-add");

		const worker = startWorker(
			accessor,
			goodProvider(),
			PHASE_C_CFG,
			decisionCfgWithEmbedding([0.1, 0.2, 0.3]),
		);

		await Bun.sleep(250);
		await worker.stop();

		const created = db
			.prepare(
				`SELECT id, content, normalized_content, extraction_status,
				        extraction_model, embedding_model, type, source_type, source_id
					 FROM memories
					 WHERE source_type = 'pipeline-v2' AND source_id = ?`,
			)
			.all("mem-src-add") as Array<{
			id: string;
			content: string;
			normalized_content: string | null;
			extraction_status: string | null;
			extraction_model: string | null;
			embedding_model: string | null;
			type: string;
			source_type: string;
			source_id: string;
		}>;

		expect(created).toHaveLength(1);
		expect(created[0].type).toBe("preference");
		expect(created[0].content).toContain("dark mode");
		expect(created[0].normalized_content).toBe(
			"user prefers dark mode in their editor settings",
		);
		expect(created[0].extraction_status).toBe("completed");
		expect(created[0].extraction_model).toBe("qwen3:4b");
		expect(created[0].embedding_model).toBe("nomic-embed-text");

		const history = db
			.prepare(
				`SELECT event, changed_by FROM memory_history WHERE memory_id = ?`,
			)
			.get(created[0].id) as { event: string; changed_by: string } | undefined;
		expect(history?.event).toBe("created");
		expect(history?.changed_by).toBe("pipeline-v2");

		const embedding = db
			.prepare(
				`SELECT source_id, dimensions FROM embeddings
				 WHERE source_type = 'memory' AND source_id = ?`,
			)
			.get(created[0].id) as
			| { source_id: string; dimensions: number }
			| undefined;
		expect(embedding?.source_id).toBe(created[0].id);
		expect(embedding?.dimensions).toBe(3);

		const job = getJob(db, "mem-src-add");
		const payload = JSON.parse(job?.result ?? "{}");
		expect(payload.writeMode).toBe("phase-c");
		expect(payload.writeStats.added).toBe(1);
		expect(payload.writeStats.embeddingsAdded).toBe(1);
	});

	it("records ADD writes without embedding when fetchEmbedding returns null", async () => {
		insertMemory(
			db,
			"mem-src-add-no-emb",
			"User prefers dark mode in their IDE",
		);
		enqueueExtractionJob(accessor, "mem-src-add-no-emb");

		const worker = startWorker(
			accessor,
			goodProvider(),
			PHASE_C_CFG,
			DECISION_CFG,
		);

		await Bun.sleep(250);
		await worker.stop();

		const created = db
			.prepare(
				`SELECT id FROM memories
				 WHERE source_type = 'pipeline-v2' AND source_id = ?`,
			)
			.all("mem-src-add-no-emb") as Array<{ id: string }>;
		expect(created).toHaveLength(1);

		const embeddingCount = db
			.prepare(
				`SELECT COUNT(*) as cnt FROM embeddings
				 WHERE source_type = 'memory' AND source_id = ?`,
			)
			.get(created[0].id) as { cnt: number };
		expect(embeddingCount.cnt).toBe(0);

		const payload = JSON.parse(
			getJob(db, "mem-src-add-no-emb")?.result ?? "{}",
		);
		expect(payload.writeStats.added).toBe(1);
		expect(payload.writeStats.embeddingsAdded).toBe(0);
	});

	it("deduplicates extracted ADD writes by content_hash", async () => {
		insertMemory(
			db,
			"mem-src-dedupe-1",
			"Session note one with enough detail to trigger extraction",
		);
		insertMemory(
			db,
			"mem-src-dedupe-2",
			"Session note two with enough detail to trigger extraction",
		);
		enqueueExtractionJob(accessor, "mem-src-dedupe-1");
		enqueueExtractionJob(accessor, "mem-src-dedupe-2");

		const extractionPayload = JSON.stringify({
			facts: [
				{
					content: "User prefers dark mode in their editor settings",
					type: "preference",
					confidence: 0.9,
				},
			],
			entities: [],
		});
		const addDecision = JSON.stringify({
			action: "add",
			confidence: 0.83,
			reason: "Store as standalone preference memory",
		});

		const worker = startWorker(
			accessor,
			scriptedProvider([extractionPayload, extractionPayload, addDecision]),
			PHASE_C_CFG,
			DECISION_CFG,
		);

		await Bun.sleep(350);
		await worker.stop();

		const extractedMemories = db
			.prepare(
				`SELECT id FROM memories
				 WHERE source_type = 'pipeline-v2'
				   AND content = 'User prefers dark mode in their editor settings'`,
			)
			.all() as Array<{ id: string }>;
		expect(extractedMemories).toHaveLength(1);

		const historyRows = db
			.prepare(
				`SELECT metadata FROM memory_history
				 WHERE memory_id IN ('mem-src-dedupe-1', 'mem-src-dedupe-2')`,
			)
			.all() as Array<{ metadata: string | null }>;
		const parsed = historyRows.map((row) => JSON.parse(row.metadata ?? "{}"));
		expect(
			parsed.some((row) => typeof row.dedupedExistingId === "string"),
		).toBe(true);
	});

	it("skips low-confidence extracted facts from write path", async () => {
		insertMemory(db, "mem-src-lowconf", "Initial source content");
		enqueueExtractionJob(accessor, "mem-src-lowconf");

		const lowConfidenceProvider = scriptedProvider([
			JSON.stringify({
				facts: [
					{
						content: "User prefers muted editor contrast for readability",
						type: "preference",
						confidence: 0.2,
					},
				],
				entities: [],
			}),
		]);

		const worker = startWorker(
			accessor,
			lowConfidenceProvider,
			{ ...PHASE_C_CFG, minFactConfidenceForWrite: 0.9 },
			DECISION_CFG,
		);

		await Bun.sleep(250);
		await worker.stop();

		const extractedCount = db
			.prepare(
				`SELECT COUNT(*) as cnt
				 FROM memories
				 WHERE source_type = 'pipeline-v2'`,
			)
			.get() as { cnt: number };
		expect(extractedCount.cnt).toBe(0);

		const sourceHistory = db
			.prepare(`SELECT metadata FROM memory_history WHERE memory_id = ?`)
			.all("mem-src-lowconf") as Array<{ metadata: string | null }>;
		const parsed = sourceHistory.map((row) => JSON.parse(row.metadata ?? "{}"));
		expect(
			parsed.some((row) => row.skippedReason === "low_fact_confidence"),
		).toBe(true);

		const job = getJob(db, "mem-src-lowconf");
		const payload = JSON.parse(job?.result ?? "{}");
		expect(payload.writeStats.skippedLowConfidence).toBe(1);
	});

	it("skips ADD write when normalized fact content is empty", async () => {
		insertMemory(
			db,
			"mem-src-empty-normalized",
			"Source envelope for punctuation-only extraction output",
		);
		enqueueExtractionJob(accessor, "mem-src-empty-normalized");

		const worker = startWorker(
			accessor,
			scriptedProvider([
				JSON.stringify({
					facts: [
						{
							content: "..........",
							type: "preference",
							confidence: 0.92,
						},
					],
					entities: [],
				}),
			]),
			PHASE_C_CFG,
			DECISION_CFG,
		);

		await Bun.sleep(250);
		await worker.stop();

		const extractedCount = db
			.prepare(
				`SELECT COUNT(*) as cnt
				 FROM memories
				 WHERE source_type = 'pipeline-v2'
				   AND source_id = 'mem-src-empty-normalized'`,
			)
			.get() as { cnt: number };
		expect(extractedCount.cnt).toBe(0);

		const sourceHistory = db
			.prepare(`SELECT metadata FROM memory_history WHERE memory_id = ?`)
			.all("mem-src-empty-normalized") as Array<{ metadata: string | null }>;
		const parsed = sourceHistory.map((row) => JSON.parse(row.metadata ?? "{}"));
		expect(
			parsed.some((row) => row.skippedReason === "empty_fact_content"),
		).toBe(true);

		const payload = JSON.parse(
			getJob(db, "mem-src-empty-normalized")?.result ?? "{}",
		);
		expect(payload.writeStats.skippedLowConfidence).toBe(1);
	});

	it("blocks destructive proposals and emits review marker on contradiction risk", async () => {
		insertMemory(
			db,
			"mem-target-delete",
			"User does not prefer dark mode editor",
		);
		insertMemory(
			db,
			"mem-src-delete",
			"Source envelope for delete recommendation",
		);
		enqueueExtractionJob(accessor, "mem-src-delete");

		const extraction = JSON.stringify({
			facts: [
				{
					content: "User prefer dark mode editor",
					type: "preference",
					confidence: 0.9,
				},
			],
			entities: [],
		});
		const destructiveDecision = JSON.stringify({
			action: "delete",
			targetId: "mem-target-delete",
			confidence: 0.84,
			reason: "Conflicts with latest preference",
		});

		const worker = startWorker(
			accessor,
			scriptedProvider([extraction, destructiveDecision]),
			PHASE_C_CFG,
			DECISION_CFG,
		);

		await Bun.sleep(300);
		await worker.stop();

		const target = db
			.prepare(`SELECT id, is_deleted FROM memories WHERE id = ?`)
			.get("mem-target-delete") as
			| { id: string; is_deleted: number }
			| undefined;
		expect(target?.id).toBe("mem-target-delete");
		expect(target?.is_deleted).toBe(0);

		const sourceHistory = db
			.prepare(`SELECT metadata FROM memory_history WHERE memory_id = ?`)
			.all("mem-src-delete") as Array<{ metadata: string | null }>;
		const parsed = sourceHistory.map((row) => JSON.parse(row.metadata ?? "{}"));
		expect(
			parsed.some(
				(row) =>
					row.blockedReason === "destructive_mutations_disabled" &&
					row.reviewNeeded === true,
			),
		).toBe(true);

		const job = getJob(db, "mem-src-delete");
		const payload = JSON.parse(job?.result ?? "{}");
		expect(payload.writeStats.blockedDestructive).toBe(1);
		expect(payload.writeStats.reviewNeeded).toBe(1);
	});

	it("records explicit NONE decisions without creating a derived memory", async () => {
		insertMemory(db, "mem-target-none", "User prefers dark mode in editor");
		insertMemory(
			db,
			"mem-src-none",
			"Source envelope for decision NONE verification",
		);
		enqueueExtractionJob(accessor, "mem-src-none");

		const extraction = JSON.stringify({
			facts: [
				{
					content: "User prefers dark mode in editor",
					type: "preference",
					confidence: 0.9,
				},
			],
			entities: [],
		});
		const noneDecision = JSON.stringify({
			action: "none",
			confidence: 0.91,
			reason: "Already covered by existing memory",
		});

		const worker = startWorker(
			accessor,
			scriptedProvider([extraction, noneDecision]),
			PHASE_C_CFG,
			DECISION_CFG,
		);

		await Bun.sleep(300);
		await worker.stop();

		const extractedCount = db
			.prepare(
				`SELECT COUNT(*) as cnt
				 FROM memories
				 WHERE source_type = 'pipeline-v2' AND source_id = 'mem-src-none'`,
			)
			.get() as { cnt: number };
		expect(extractedCount.cnt).toBe(0);

		const historyRows = db
			.prepare(`SELECT event, metadata FROM memory_history WHERE memory_id = ?`)
			.all("mem-src-none") as Array<{
			event: string;
			metadata: string | null;
		}>;
		expect(historyRows.some((row) => row.event === "none")).toBe(true);
		const parsed = historyRows.map((row) => JSON.parse(row.metadata ?? "{}"));
		expect(parsed.some((row) => row.proposedAction === "none")).toBe(true);

		const payload = JSON.parse(getJob(db, "mem-src-none")?.result ?? "{}");
		expect(payload.writeStats.added).toBe(0);
		expect(payload.writeStats.deduped).toBe(0);
	});

	it("falls back to shadow-mode audits when mutations are frozen", async () => {
		insertMemory(db, "mem-src-frozen", "User prefers dark mode in editor");
		enqueueExtractionJob(accessor, "mem-src-frozen");

		const worker = startWorker(
			accessor,
			goodProvider(),
			{ ...PHASE_C_CFG, mutationsFrozen: true },
			DECISION_CFG,
		);

		await Bun.sleep(250);
		await worker.stop();

		const extractedCount = db
			.prepare(
				`SELECT COUNT(*) as cnt
				 FROM memories
				 WHERE source_type = 'pipeline-v2'`,
			)
			.get() as { cnt: number };
		expect(extractedCount.cnt).toBe(0);

		const history = db
			.prepare(
				`SELECT event, changed_by, metadata
				 FROM memory_history
				 WHERE memory_id = ?
				 LIMIT 1`,
			)
			.get("mem-src-frozen") as
			| { event: string; changed_by: string; metadata: string | null }
			| undefined;
		expect(history?.event).toBe("none");
		expect(history?.changed_by).toBe("pipeline-shadow");
		const meta = JSON.parse(history?.metadata ?? "{}");
		expect(meta.shadow).toBe(true);

		const payload = JSON.parse(getJob(db, "mem-src-frozen")?.result ?? "{}");
		expect(payload.writeMode).toBe("shadow");
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
		const worker = startWorker(
			faultyAccessor,
			goodProvider(),
			cfg,
			DECISION_CFG,
		);
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
		const worker = startWorker(
			faultyAccessor,
			goodProvider(),
			cfg,
			DECISION_CFG,
		);
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
