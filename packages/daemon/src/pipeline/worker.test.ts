/**
 * Tests for the pipeline job worker.
 *
 * Uses a real in-memory SQLite database with full migrations applied
 * so the queue schema is exactly as production uses it.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "@signet/core";
import { enqueueExtractionJob, recoverMemoryJobs, startWorker } from "./worker";
import type { DbAccessor, WriteDb, ReadDb } from "../db-accessor";
import type { LlmProvider } from "./provider";
import type { PipelineV2Config } from "../memory-config";
import type { DecisionConfig } from "./decision";
import { syncVecInsert, vectorToBlob } from "../db-helpers";
import { normalizeAndHashContent } from "../content-normalization";

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

function insertMemory(
	db: Database,
	id: string,
	content: string,
	opts?: {
		type?: string;
		project?: string | null;
		scope?: string | null;
		agentId?: string;
		visibility?: "global" | "private" | "archived";
		sourceType?: string;
		sourceId?: string | null;
		normalizedContent?: string;
		contentHash?: string | null;
	},
): void {
	const now = new Date().toISOString();
	db.prepare(
		`INSERT INTO memories
		 (id, type, content, normalized_content, content_hash, confidence, importance, created_at, updated_at,
		  updated_by, vector_clock, is_deleted, extraction_status, project, scope, agent_id,
		  visibility, source_type, source_id)
		 VALUES (?, ?, ?, ?, ?, 1.0, 0.5, ?, ?, 'test', '{}', 0, 'none', ?, ?, ?, ?, ?, ?)`,
	).run(
		id,
		opts?.type ?? "fact",
		content,
		opts?.normalizedContent ?? content,
		opts?.contentHash ?? null,
		now,
		now,
		opts?.project ?? null,
		opts?.scope ?? null,
		opts?.agentId ?? "default",
		opts?.visibility ?? "global",
		opts?.sourceType ?? "manual",
		opts?.sourceId ?? id,
	);
}

function insertMemoryEmbedding(db: Database, sourceId: string, vector: readonly number[]): void {
	const id = `emb-${sourceId}`;
	const now = new Date().toISOString();
	const blob = vectorToBlob(vector);
	db.prepare(
		`INSERT INTO embeddings
		 (id, content_hash, vector, dimensions, source_type, source_id, chunk_text, created_at)
		 VALUES (?, ?, ?, ?, 'memory', ?, ?, ?)`,
	).run(id, `hash-${sourceId}`, blob, vector.length, sourceId, `chunk:${sourceId}`, now);
	syncVecInsert(db as unknown as WriteDb, id, vector);
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
	return db.prepare(`SELECT status, attempts, error, result FROM memory_jobs WHERE memory_id = ?`).get(memoryId) as
		| {
				status: string;
				attempts: number;
				error: string | null;
				result: string | null;
		  }
		| undefined;
}

function getHistoryCount(db: Database, memoryId: string): number {
	const row = db.prepare(`SELECT COUNT(*) as cnt FROM memory_history WHERE memory_id = ?`).get(memoryId) as {
		cnt: number;
	};
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
 * Provider that throws for the first N calls then returns good extraction
 * responses. Used to test backoff recovery behavior.
 */
function failThenSucceedProvider(failures: number): LlmProvider {
	let calls = 0;
	const good = JSON.stringify({
		facts: [{ content: "Test fact", type: "preference", confidence: 0.9 }],
		entities: [{ source: "User", relationship: "prefers", target: "tests", confidence: 0.9 }],
	});
	return {
		name: "mock-fail-then-succeed",
		async generate() {
			calls++;
			if (calls <= failures) throw new Error("Transient LLM failure");
			return good;
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
	mutationsFrozen: false,
	extraction: {
		provider: "ollama",
		model: "qwen3:4b",
		timeout: 5000,
		minConfidence: 0.7,
	},
	worker: {
		pollMs: 10, // fast polling for tests
		maxRetries: 3,
		leaseTimeoutMs: 300000,
		maxLoadPerCpu: 0.8,
		overloadBackoffMs: 30000,
	},
	graph: {
		enabled: false,
		boostWeight: 0.15,
		boostTimeoutMs: 500,
	},
	reranker: {
		enabled: false,
		model: "",
		useExtractionModel: false,
		topN: 20,
		timeoutMs: 2000,
	},
	autonomous: {
		enabled: false,
		frozen: false,
		allowUpdateDelete: false,
		maintenanceIntervalMs: 1800000,
		maintenanceMode: "observe",
	},
	repair: {
		reembedCooldownMs: 300000,
		reembedHourlyBudget: 10,
		requeueCooldownMs: 60000,
		requeueHourlyBudget: 50,
		dedupCooldownMs: 600000,
		dedupHourlyBudget: 3,
		dedupSemanticThreshold: 0.92,
		dedupBatchSize: 100,
	},
	documents: {
		workerIntervalMs: 10000,
		chunkSize: 2000,
		chunkOverlap: 200,
		maxContentBytes: 10 * 1024 * 1024,
	},
	guardrails: {
		maxContentChars: 500,
		chunkTargetChars: 300,
		recallTruncateChars: 500,
	},
	structural: {
		enabled: false,
		classifyBatchSize: 8,
		dependencyBatchSize: 5,
		pollIntervalMs: 10000,
	},
	significance: {
		enabled: false,
		minTurns: 5,
		minEntityOverlap: 1,
		noveltyThreshold: 0.15,
	},
};

const PHASE_C_CFG: PipelineV2Config = {
	...PIPELINE_CFG,
	shadowMode: false,
};

const DECISION_CFG: DecisionConfig = {
	embedding: {
		provider: "ollama",
		model: "nomic-embed-text",
		dimensions: 3, // matches test mock vectors
		base_url: "http://localhost:11434",
	},
	search: { alpha: 0.7, top_k: 20, min_score: 0.0 },
	async fetchEmbedding() {
		return null;
	},
};

function decisionCfgWithEmbedding(vector: readonly number[] | null): DecisionConfig {
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

		const rows = db.prepare(`SELECT id FROM memory_jobs WHERE memory_id = ?`).all("mem-b") as Array<{ id: string }>;

		expect(rows).toHaveLength(1);
	});

	it("allows a new job after the previous one is completed", () => {
		insertMemory(db, "mem-c", "Some content about the user");
		enqueueExtractionJob(accessor, "mem-c");

		// Mark the job completed
		db.prepare(`UPDATE memory_jobs SET status = 'completed' WHERE memory_id = ?`).run("mem-c");

		// Enqueue again - should insert a new one
		enqueueExtractionJob(accessor, "mem-c");

		const rows = db.prepare(`SELECT id FROM memory_jobs WHERE memory_id = ?`).all("mem-c") as Array<{ id: string }>;

		expect(rows).toHaveLength(2);
	});

	it("does not insert a job when a leased job already exists", () => {
		insertMemory(db, "mem-d", "Some content about the user");
		enqueueExtractionJob(accessor, "mem-d");

		// Mark as leased (in-flight)
		db.prepare(`UPDATE memory_jobs SET status = 'leased' WHERE memory_id = ?`).run("mem-d");

		enqueueExtractionJob(accessor, "mem-d");

		const rows = db.prepare(`SELECT id FROM memory_jobs WHERE memory_id = ?`).all("mem-d") as Array<{ id: string }>;

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

		const worker = startWorker(accessor, goodProvider(), PIPELINE_CFG, DECISION_CFG);

		await Bun.sleep(200);
		await worker.stop();

		const job = getJob(db, "mem-proc");
		expect(job?.status).toBe("completed");
		expect(job?.attempts).toBe(1);

		// Extraction status on memory should be 'completed'
		const mem = db.prepare(`SELECT extraction_status FROM memories WHERE id = ?`).get("mem-proc") as
			| { extraction_status: string }
			| undefined;
		expect(mem?.extraction_status).toBe("completed");
	});

	it("records shadow history entries for each proposal", async () => {
		insertMemory(db, "mem-hist", "User prefers dark mode in their IDE setup");
		enqueueExtractionJob(accessor, "mem-hist");

		const worker = startWorker(accessor, goodProvider(), PIPELINE_CFG, DECISION_CFG);

		await Bun.sleep(200);
		await worker.stop();

		// 1 fact, no candidates in empty DB => 1 ADD proposal => 1 history row
		const histCount = getHistoryCount(db, "mem-hist");
		expect(histCount).toBeGreaterThanOrEqual(1);

		// Verify the history record has shadow metadata
		const histRow = db
			.prepare(`SELECT metadata, changed_by, event FROM memory_history WHERE memory_id = ?`)
			.get("mem-hist") as { metadata: string; changed_by: string; event: string } | undefined;

		expect(histRow?.changed_by).toBe("pipeline-shadow");
		expect(histRow?.event).toBe("none");
		const meta = JSON.parse(histRow?.metadata ?? "{}");
		expect(meta.shadow).toBe(true);
		expect(meta.proposedAction).toBe("add");
	});

	it("job result payload includes fact and entity counts", async () => {
		insertMemory(db, "mem-payload", "User prefers dark mode in their IDE setup");
		enqueueExtractionJob(accessor, "mem-payload");

		const worker = startWorker(accessor, goodProvider(), PIPELINE_CFG, DECISION_CFG);

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

		const worker = startWorker(accessor, goodProvider(), PIPELINE_CFG, DECISION_CFG);

		await Bun.sleep(200);
		await worker.stop();

		const job = db.prepare(`SELECT status, result FROM memory_jobs WHERE id = ?`).get("job-ghost") as
			| { status: string; result: string }
			| undefined;

		// Job should be completed with a skipped result
		expect(job?.status).toBe("completed");
		const result = JSON.parse(job?.result ?? "{}");
		expect(result.skipped).toBe("memory_not_found");
	});

	it("fails job with retry when LLM provider throws", async () => {
		// When the LLM throws, extraction now propagates the error so the
		// worker's failJob() path handles it with exponential backoff retry.
		insertMemory(db, "mem-llm-err", "Some content about preferences");
		enqueueExtractionJob(accessor, "mem-llm-err");

		const worker = startWorker(accessor, throwingProvider(), PIPELINE_CFG, DECISION_CFG);

		await Bun.sleep(200);
		await worker.stop();

		const job = getJob(db, "mem-llm-err");
		// Job goes to pending (failed with retry available)
		expect(job?.status).toBe("pending");
		expect(job?.attempts).toBeGreaterThanOrEqual(1);
		expect(job?.error).toContain("LLM extraction failed");
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
		const worker = startWorker(accessor, goodProvider(), PIPELINE_CFG, DECISION_CFG);

		expect(worker.running).toBe(true);
		await worker.stop();
		expect(worker.running).toBe(false);
	});

	it("defers ticks while host load is above maxLoadPerCpu", async () => {
		insertMemory(db, "mem-overload", "User prefers dark mode in their IDE setup");
		enqueueExtractionJob(accessor, "mem-overload");

		const worker = startWorker(
			accessor,
			goodProvider(),
			{
				...PIPELINE_CFG,
				worker: {
					...PIPELINE_CFG.worker,
					maxLoadPerCpu: 0.8,
					overloadBackoffMs: 80,
				},
			},
			DECISION_CFG,
			undefined,
			undefined,
			{ getLoadPerCpu: () => 1.9 },
		);

		await Bun.sleep(120);
		const job = getJob(db, "mem-overload");
		expect(job?.status).toBe("pending");
		expect(worker.stats.overloaded).toBe(true);
		expect(worker.stats.loadPerCpu).toBe(1.9);
		expect(worker.stats.maxLoadPerCpu).toBe(0.8);
		expect(worker.stats.overloadBackoffMs).toBe(80);
		expect(worker.stats.nextTickInMs).toBeGreaterThanOrEqual(0);

		await worker.stop();
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
		insertMemory(db, "mem-src-add", "User prefers dark mode in their IDE setup");
		enqueueExtractionJob(accessor, "mem-src-add");

		const worker = startWorker(accessor, goodProvider(), PHASE_C_CFG, decisionCfgWithEmbedding([0.1, 0.2, 0.3]));

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
		expect(created[0].normalized_content).toBe("user prefers dark mode in their editor settings");
		expect(created[0].extraction_status).toBe("completed");
		expect(created[0].extraction_model).toBe("qwen3:4b");
		expect(created[0].embedding_model).toBe("nomic-embed-text");

		const history = db.prepare(`SELECT event, changed_by FROM memory_history WHERE memory_id = ?`).get(created[0].id) as
			| { event: string; changed_by: string }
			| undefined;
		expect(history?.event).toBe("created");
		expect(history?.changed_by).toBe("pipeline-v2");

		const embedding = db
			.prepare(
				`SELECT source_id, dimensions FROM embeddings
				 WHERE source_type = 'memory' AND source_id = ?`,
			)
			.get(created[0].id) as { source_id: string; dimensions: number } | undefined;
		expect(embedding?.source_id).toBe(created[0].id);
		expect(embedding?.dimensions).toBe(3);

		const job = getJob(db, "mem-src-add");
		const payload = JSON.parse(job?.result ?? "{}");
		expect(payload.writeMode).toBe("phase-c");
		expect(payload.writeStats.added).toBe(1);
		expect(payload.writeStats.embeddingsAdded).toBe(1);
	});

	it("records ADD writes without embedding when fetchEmbedding returns null", async () => {
		insertMemory(db, "mem-src-add-no-emb", "User prefers dark mode in their IDE");
		enqueueExtractionJob(accessor, "mem-src-add-no-emb");

		const worker = startWorker(accessor, goodProvider(), PHASE_C_CFG, DECISION_CFG);

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

		const payload = JSON.parse(getJob(db, "mem-src-add-no-emb")?.result ?? "{}");
		expect(payload.writeStats.added).toBe(1);
		expect(payload.writeStats.embeddingsAdded).toBe(0);
	});

	it("deduplicates extracted ADD writes by content_hash", async () => {
		insertMemory(db, "mem-src-dedupe-1", "Session note one with enough detail to trigger extraction");
		insertMemory(db, "mem-src-dedupe-2", "Session note two with enough detail to trigger extraction");
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
		expect(parsed.some((row) => typeof row.dedupedExistingId === "string")).toBe(true);
	});

	it("inherits the source scope for extracted ADD writes", async () => {
		insertMemory(db, "mem-src-scope", "Source envelope with scope", {
			scope: "scope-a",
		});
		enqueueExtractionJob(accessor, "mem-src-scope");

		const extraction = JSON.stringify({
			facts: [
				{
					content: "Scoped preference memory content",
					type: "preference",
					confidence: 0.93,
				},
			],
			entities: [],
		});
		const addDecision = JSON.stringify({
			action: "add",
			confidence: 0.84,
			reason: "Store as scoped preference memory",
		});

		const worker = startWorker(
			accessor,
			scriptedProvider([extraction, addDecision]),
			PHASE_C_CFG,
			DECISION_CFG,
		);

		await Bun.sleep(300);
		await worker.stop();

		const row = db
			.prepare(
				`SELECT scope FROM memories
				 WHERE source_type = 'pipeline-v2'
				   AND source_id = ?
				 LIMIT 1`,
			)
			.get("mem-src-scope") as { scope: string | null } | undefined;
		expect(row?.scope).toBe("scope-a");
	});

	it("does not dedupe against identical content in a different scope", async () => {
		const scoped = normalizeAndHashContent("User prefers dark mode in editor settings");
		insertMemory(db, "mem-existing-scope-b", scoped.storageContent, {
			scope: "scope-b",
			normalizedContent: scoped.normalizedContent,
			contentHash: scoped.contentHash,
		});
		insertMemory(db, "mem-src-scope-a", "Source envelope in scope A", {
			scope: "scope-a",
		});
		enqueueExtractionJob(accessor, "mem-src-scope-a");

		const extraction = JSON.stringify({
			facts: [
				{
					content: "User prefers dark mode in editor settings",
					type: "preference",
					confidence: 0.95,
				},
			],
			entities: [],
		});
		const addDecision = JSON.stringify({
			action: "add",
			confidence: 0.88,
			reason: "Store as scoped preference memory",
		});

		const worker = startWorker(
			accessor,
			scriptedProvider([extraction, addDecision]),
			PHASE_C_CFG,
			DECISION_CFG,
		);

		await Bun.sleep(300);
		await worker.stop();

		const payload = JSON.parse(getJob(db, "mem-src-scope-a")?.result ?? "{}");
		expect(payload.writeStats.added).toBe(1);
		expect(payload.writeStats.deduped).toBe(0);

		const rows = db
			.prepare(
				`SELECT id, scope FROM memories
				 WHERE content = ?
				   AND is_deleted = 0
				 ORDER BY id`,
			)
			.all(scoped.storageContent) as Array<{ id: string; scope: string | null }>;
		const scopes = rows.map((row) => row.scope).sort();
		expect(scopes).toEqual(["scope-a", "scope-b"]);
	});

	it("does not block write-gate checks with similar memories in a different scope", async () => {
		insertMemory(db, "mem-src-write-gate-scope-a", "Source envelope for scoped adaptive write gate", {
			scope: "scope-a",
		});
		insertMemory(db, "mem-existing-write-gate-scope-b", "User prefers dark mode in editor settings", {
			scope: "scope-b",
		});
		insertMemoryEmbedding(db, "mem-existing-write-gate-scope-b", [1, 0, 0]);
		enqueueExtractionJob(accessor, "mem-src-write-gate-scope-a");

		const extraction = JSON.stringify({
			facts: [
				{
					content: "User likes dark mode in editor settings",
					type: "preference",
					confidence: 0.93,
				},
			],
			entities: [],
		});
		const addDecision = JSON.stringify({
			action: "add",
			confidence: 0.88,
			reason: "Store scoped preference without cross-scope bleed",
		});

		const worker = startWorker(
			accessor,
			scriptedProvider([extraction, addDecision]),
			{
				...PHASE_C_CFG,
				writeGate: {
					enabled: true,
					threshold: 0.4,
					continuityDiscount: 0.15,
				},
			},
			decisionCfgWithEmbedding([1, 0, 0]),
		);

		await Bun.sleep(300);
		await worker.stop();

		const derived = db
			.prepare(
				`SELECT COUNT(*) as cnt
				 FROM memories
				 WHERE source_type = 'pipeline-v2'
				   AND source_id = ?`,
			)
			.get("mem-src-write-gate-scope-a") as { cnt: number };
		expect(derived.cnt).toBe(1);

		const payload = JSON.parse(getJob(db, "mem-src-write-gate-scope-a")?.result ?? "{}");
		expect(payload.writeStats.writeGateConsidered).toBe(1);
		expect(payload.writeStats.writeGatePassed).toBe(1);
		expect(payload.writeStats.writeGateBlocked).toBe(0);
	});

	it("does not block write-gate checks with similar memories in a different visibility", async () => {
		insertMemory(db, "mem-src-write-gate-global", "Source envelope for visibility adaptive write gate", {
			visibility: "global",
		});
		insertMemory(db, "mem-existing-write-gate-private", "User prefers dark mode in editor settings", {
			visibility: "private",
		});
		insertMemoryEmbedding(db, "mem-existing-write-gate-private", [1, 0, 0]);
		enqueueExtractionJob(accessor, "mem-src-write-gate-global");

		const extraction = JSON.stringify({
			facts: [
				{
					content: "User likes dark mode in editor settings",
					type: "preference",
					confidence: 0.93,
				},
			],
			entities: [],
		});
		const addDecision = JSON.stringify({
			action: "add",
			confidence: 0.88,
			reason: "Store visibility-scoped preference without read-policy bleed",
		});

		const worker = startWorker(
			accessor,
			scriptedProvider([extraction, addDecision]),
			{
				...PHASE_C_CFG,
				writeGate: {
					enabled: true,
					threshold: 0.4,
					continuityDiscount: 0.15,
				},
			},
			decisionCfgWithEmbedding([1, 0, 0]),
		);

		await Bun.sleep(300);
		await worker.stop();

		const derived = db
			.prepare(
				`SELECT COUNT(*) as cnt
				 FROM memories
				 WHERE source_type = 'pipeline-v2'
				   AND source_id = ?`,
			)
			.get("mem-src-write-gate-global") as { cnt: number };
		expect(derived.cnt).toBe(1);

		const payload = JSON.parse(getJob(db, "mem-src-write-gate-global")?.result ?? "{}");
		expect(payload.writeStats.writeGateConsidered).toBe(1);
		expect(payload.writeStats.writeGatePassed).toBe(1);
		expect(payload.writeStats.writeGateBlocked).toBe(0);
	});

	it("blocks low-surprisal ADD writes with the adaptive write gate", async () => {
		insertMemory(db, "mem-src-write-gate", "Source envelope for adaptive write gate");
		insertMemory(db, "mem-existing-write-gate", "User prefers dark mode in editor settings", {
			type: "preference",
		});
		insertMemoryEmbedding(db, "mem-existing-write-gate", [1, 0, 0]);
		enqueueExtractionJob(accessor, "mem-src-write-gate");

		const extraction = JSON.stringify({
			facts: [
				{
					content: "User likes dark mode in editor settings",
					type: "preference",
					confidence: 0.93,
				},
			],
			entities: [],
		});
		const addDecision = JSON.stringify({
			action: "add",
			confidence: 0.88,
			reason: "Store as a separate preference",
		});

		const worker = startWorker(
			accessor,
			scriptedProvider([extraction, addDecision]),
			{
				...PHASE_C_CFG,
				writeGate: {
					enabled: true,
					threshold: 0.4,
					continuityDiscount: 0.15,
				},
			},
			decisionCfgWithEmbedding([1, 0, 0]),
		);

		await Bun.sleep(300);
		await worker.stop();

		const derived = db
			.prepare(
				`SELECT COUNT(*) as cnt
				 FROM memories
				 WHERE source_type = 'pipeline-v2'
				   AND source_id = ?`,
			)
			.get("mem-src-write-gate") as { cnt: number };
		expect(derived.cnt).toBe(0);

		const sourceHistory = db
			.prepare(`SELECT metadata FROM memory_history WHERE memory_id = ?`)
			.all("mem-src-write-gate") as Array<{ metadata: string | null }>;
		const parsed = sourceHistory.map((row) => JSON.parse(row.metadata ?? "{}"));
		expect(parsed.some((row) => row.skippedReason === "write_gate_low_surprisal")).toBe(true);

		const payload = JSON.parse(getJob(db, "mem-src-write-gate")?.result ?? "{}");
		expect(payload.writeStats.writeGateConsidered).toBe(1);
		expect(payload.writeStats.writeGateBlocked).toBe(1);
		expect(payload.writeStats.added).toBe(0);
	});

	it("does not block write-gate checks when similar memories are a different fact type", async () => {
		insertMemory(db, "mem-src-write-gate-type", "Source envelope for type-scoped gate check");
		insertMemory(db, "mem-existing-write-gate-type", "User prefers dark mode in editor settings", {
			type: "fact",
		});
		insertMemoryEmbedding(db, "mem-existing-write-gate-type", [1, 0, 0]);
		enqueueExtractionJob(accessor, "mem-src-write-gate-type");

		const extraction = JSON.stringify({
			facts: [
				{
					content: "User likes dark mode in editor settings",
					type: "preference",
					confidence: 0.93,
				},
			],
			entities: [],
		});
		const addDecision = JSON.stringify({
			action: "add",
			confidence: 0.88,
			reason: "Store as a separate preference",
		});

		const worker = startWorker(
			accessor,
			scriptedProvider([extraction, addDecision]),
			{
				...PHASE_C_CFG,
				writeGate: {
					enabled: true,
					threshold: 0.4,
					continuityDiscount: 0.15,
				},
			},
			decisionCfgWithEmbedding([1, 0, 0]),
		);

		await Bun.sleep(300);
		await worker.stop();

		const derived = db
			.prepare(
				`SELECT COUNT(*) as cnt
				 FROM memories
				 WHERE source_type = 'pipeline-v2'
				   AND source_id = ?`,
			)
			.get("mem-src-write-gate-type") as { cnt: number };
		expect(derived.cnt).toBe(1);

		const payload = JSON.parse(getJob(db, "mem-src-write-gate-type")?.result ?? "{}");
		expect(payload.writeStats.writeGateConsidered).toBe(1);
		expect(payload.writeStats.writeGatePassed).toBe(1);
		expect(payload.writeStats.writeGateBlocked).toBe(0);
	});

	it("blocks low-surprisal writes across different projects in the same scope", async () => {
		insertMemory(db, "mem-src-write-gate-project-a", "Source envelope for cross-project gate check", {
			project: "/repo-a",
		});
		insertMemory(db, "mem-existing-write-gate-project-b", "User prefers dark mode in editor settings", {
			project: "/repo-b",
			type: "preference",
		});
		insertMemoryEmbedding(db, "mem-existing-write-gate-project-b", [1, 0, 0]);
		enqueueExtractionJob(accessor, "mem-src-write-gate-project-a");

		const extraction = JSON.stringify({
			facts: [
				{
					content: "User likes dark mode in editor settings",
					type: "preference",
					confidence: 0.93,
				},
			],
			entities: [],
		});
		const addDecision = JSON.stringify({
			action: "add",
			confidence: 0.88,
			reason: "Store as a separate preference",
		});

		const worker = startWorker(
			accessor,
			scriptedProvider([extraction, addDecision]),
			{
				...PHASE_C_CFG,
				writeGate: {
					enabled: true,
					threshold: 0.4,
					continuityDiscount: 0.15,
				},
			},
			decisionCfgWithEmbedding([1, 0, 0]),
		);

		await Bun.sleep(300);
		await worker.stop();

		const derived = db
			.prepare(
				`SELECT COUNT(*) as cnt
				 FROM memories
				 WHERE source_type = 'pipeline-v2'
				   AND source_id = ?`,
			)
			.get("mem-src-write-gate-project-a") as { cnt: number };
		expect(derived.cnt).toBe(0);

		const payload = JSON.parse(getJob(db, "mem-src-write-gate-project-a")?.result ?? "{}");
		expect(payload.writeStats.writeGateConsidered).toBe(1);
		expect(payload.writeStats.writeGateBlocked).toBe(1);
		expect(payload.writeStats.added).toBe(0);
	});

	it("applies continuity discount when the same task is active", async () => {
		insertMemory(db, "mem-src-write-gate-continuity", "Source envelope for continuity-discounted write gate", {
			project: "/repo",
		});
		insertMemory(db, "mem-recent-1", "Recent work item one in the same project", { project: "/repo" });
		insertMemory(db, "mem-recent-2", "Recent work item two in the same project", { project: "/repo" });
		insertMemory(db, "mem-recent-3", "Recent work item three in the same project", { project: "/repo" });
		insertMemoryEmbedding(db, "mem-recent-1", [1, 0, 0]);
		insertMemoryEmbedding(db, "mem-recent-2", [1, 0, 0]);
		insertMemoryEmbedding(db, "mem-recent-3", [1, 0, 0]);
		enqueueExtractionJob(accessor, "mem-src-write-gate-continuity");

		const extraction = JSON.stringify({
			facts: [
				{
					content: "User keeps refining the same editor customization task",
					type: "fact",
					confidence: 0.9,
				},
			],
			entities: [],
		});
		const addDecision = JSON.stringify({
			action: "add",
			confidence: 0.82,
			reason: "Keep an incremental progress memory",
		});

		const worker = startWorker(
			accessor,
			scriptedProvider([extraction, addDecision]),
			{
				...PHASE_C_CFG,
				writeGate: {
					enabled: true,
					threshold: 0.4,
					continuityDiscount: 0.15,
				},
			},
			decisionCfgWithEmbedding([0.7, 0.714, 0]),
		);

		await Bun.sleep(300);
		await worker.stop();

		const derived = db
			.prepare(
				`SELECT COUNT(*) as cnt
				 FROM memories
				 WHERE source_type = 'pipeline-v2'
				   AND source_id = ?`,
			)
			.get("mem-src-write-gate-continuity") as { cnt: number };
		expect(derived.cnt).toBe(1);

		const payload = JSON.parse(getJob(db, "mem-src-write-gate-continuity")?.result ?? "{}");
		expect(payload.writeStats.writeGateContinuityDiscounted).toBe(1);
		expect(payload.writeStats.writeGatePassed).toBe(1);
		expect(payload.writeStats.writeGateBlocked).toBe(0);
	});

	it("bypasses the adaptive write gate for decision memories", async () => {
		insertMemory(db, "mem-src-write-gate-decision", "Source envelope for decision bypass");
		insertMemory(db, "mem-existing-write-gate-decision", "We decided to use Bun instead of npm for this repo");
		insertMemoryEmbedding(db, "mem-existing-write-gate-decision", [1, 0, 0]);
		enqueueExtractionJob(accessor, "mem-src-write-gate-decision");

		const extraction = JSON.stringify({
			facts: [
				{
					content: "Team decided to use Bun rather than npm in this repository",
					type: "decision",
					confidence: 0.91,
				},
			],
			entities: [],
		});
		const addDecision = JSON.stringify({
			action: "add",
			confidence: 0.85,
			reason: "Decision should always be retained",
		});

		const worker = startWorker(
			accessor,
			scriptedProvider([extraction, addDecision]),
			{
				...PHASE_C_CFG,
				writeGate: {
					enabled: true,
					threshold: 0.4,
					continuityDiscount: 0.15,
				},
			},
			decisionCfgWithEmbedding([1, 0, 0]),
		);

		await Bun.sleep(300);
		await worker.stop();

		const derived = db
			.prepare(
				`SELECT COUNT(*) as cnt
				 FROM memories
				 WHERE source_type = 'pipeline-v2'
				   AND source_id = ?`,
			)
			.get("mem-src-write-gate-decision") as { cnt: number };
		expect(derived.cnt).toBe(1);

		const payload = JSON.parse(getJob(db, "mem-src-write-gate-decision")?.result ?? "{}");
		expect(payload.writeStats.writeGateBypassed).toBe(1);
		expect(payload.writeStats.added).toBe(1);
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
			{ ...PHASE_C_CFG, extraction: { ...PHASE_C_CFG.extraction, minConfidence: 0.9 } },
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
		expect(parsed.some((row) => row.skippedReason === "low_fact_confidence")).toBe(true);

		const job = getJob(db, "mem-src-lowconf");
		const payload = JSON.parse(job?.result ?? "{}");
		expect(payload.writeStats.skippedLowConfidence).toBe(1);
	});

	it("skips ADD write when normalized fact content is empty", async () => {
		insertMemory(db, "mem-src-empty-normalized", "Source envelope for punctuation-only extraction output");
		enqueueExtractionJob(accessor, "mem-src-empty-normalized");

		const worker = startWorker(
			accessor,
			scriptedProvider([
				JSON.stringify({
					facts: [
						{
							content: "..........!!!!!!!!!!..........",
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
		expect(parsed.some((row) => row.skippedReason === "empty_fact_content")).toBe(true);

		const payload = JSON.parse(getJob(db, "mem-src-empty-normalized")?.result ?? "{}");
		expect(payload.writeStats.skippedLowConfidence).toBe(1);
	});

	it("blocks destructive proposals and emits review marker on contradiction risk", async () => {
		insertMemory(db, "mem-target-delete", "User does not prefer dark mode editor");
		insertMemory(db, "mem-src-delete", "Source envelope for delete recommendation");
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

		const target = db.prepare(`SELECT id, is_deleted FROM memories WHERE id = ?`).get("mem-target-delete") as
			| { id: string; is_deleted: number }
			| undefined;
		expect(target?.id).toBe("mem-target-delete");
		expect(target?.is_deleted).toBe(0);

		const sourceHistory = db
			.prepare(`SELECT metadata FROM memory_history WHERE memory_id = ?`)
			.all("mem-src-delete") as Array<{ metadata: string | null }>;
		const parsed = sourceHistory.map((row) => JSON.parse(row.metadata ?? "{}"));
		expect(
			parsed.some((row) => row.blockedReason === "destructive_mutations_disabled" && row.reviewNeeded === true),
		).toBe(true);

		const job = getJob(db, "mem-src-delete");
		const payload = JSON.parse(job?.result ?? "{}");
		expect(payload.writeStats.blockedDestructive).toBe(1);
		expect(payload.writeStats.reviewNeeded).toBe(1);
	});

	it("records explicit NONE decisions without creating a derived memory", async () => {
		insertMemory(db, "mem-target-none", "User prefers dark mode in editor");
		insertMemory(db, "mem-src-none", "Source envelope for decision NONE verification");
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

		const worker = startWorker(accessor, scriptedProvider([extraction, noneDecision]), PHASE_C_CFG, DECISION_CFG);

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

		const worker = startWorker(accessor, goodProvider(), { ...PHASE_C_CFG, mutationsFrozen: true }, DECISION_CFG);

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
			.get("mem-src-frozen") as { event: string; changed_by: string; metadata: string | null } | undefined;
		expect(history?.event).toBe("none");
		expect(history?.changed_by).toBe("pipeline-shadow");
		const meta = JSON.parse(history?.metadata ?? "{}");
		expect(meta.shadow).toBe(true);

		const payload = JSON.parse(getJob(db, "mem-src-frozen")?.result ?? "{}");
		expect(payload.writeMode).toBe("shadow");
	});

	it("falls back to shadow-mode audits when native shadow is enabled", async () => {
		insertMemory(db, "mem-src-native-shadow", "User prefers dark mode in editor");
		enqueueExtractionJob(accessor, "mem-src-native-shadow");

		const worker = startWorker(
			accessor,
			goodProvider(),
			{ ...PHASE_C_CFG, nativeShadowEnabled: true },
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

		const payload = JSON.parse(getJob(db, "mem-src-native-shadow")?.result ?? "{}");
		expect(payload.writeMode).toBe("shadow");
	});

	it("executes update mutation when allowUpdateDelete is true", async () => {
		insertMemory(db, "mem-target-update", "User prefers dark mode editor theme with high contrast setting");
		insertMemory(db, "mem-src-update", "Source envelope for update recommendation");
		enqueueExtractionJob(accessor, "mem-src-update");

		const extraction = JSON.stringify({
			facts: [
				{
					content: "User prefers dark mode editor theme",
					type: "preference",
					confidence: 0.9,
				},
			],
			entities: [],
		});
		const updateDecision = JSON.stringify({
			action: "update",
			targetId: "mem-target-update",
			confidence: 0.88,
			reason: "Simplified preference record",
		});

		const worker = startWorker(
			accessor,
			scriptedProvider([extraction, updateDecision]),
			{ ...PHASE_C_CFG, autonomous: { ...PHASE_C_CFG.autonomous, allowUpdateDelete: true } },
			DECISION_CFG,
		);

		await Bun.sleep(300);
		await worker.stop();

		// Target memory content should be updated
		const target = db.prepare(`SELECT content, updated_by FROM memories WHERE id = ?`).get("mem-target-update") as
			| { content: string; updated_by: string }
			| undefined;
		expect(target?.content).toBe("User prefers dark mode editor theme");
		expect(target?.updated_by).toBe("pipeline-v2");

		// Stats should reflect the update
		const job = getJob(db, "mem-src-update");
		const payload = JSON.parse(job?.result ?? "{}");
		expect(payload.writeStats.updated).toBe(1);
		expect(payload.writeStats.blockedDestructive).toBe(0);

		// Decision history should record updatedMemoryId
		const sourceHistory = db
			.prepare(`SELECT metadata FROM memory_history WHERE memory_id = ?`)
			.all("mem-src-update") as Array<{ metadata: string | null }>;
		const parsed = sourceHistory.map((row) => JSON.parse(row.metadata ?? "{}"));
		expect(parsed.some((row) => row.updatedMemoryId === "mem-target-update")).toBe(true);
	});

	it("executes delete mutation when allowUpdateDelete is true", async () => {
		insertMemory(db, "mem-target-del", "User does not prefer dark mode editor theme");
		insertMemory(db, "mem-src-del", "Source envelope for delete recommendation");
		enqueueExtractionJob(accessor, "mem-src-del");

		const extraction = JSON.stringify({
			facts: [
				{
					content: "User does not prefer dark mode editor theme",
					type: "preference",
					confidence: 0.9,
				},
			],
			entities: [],
		});
		const deleteDecision = JSON.stringify({
			action: "delete",
			targetId: "mem-target-del",
			confidence: 0.85,
			reason: "Contradicts current preference",
		});

		const worker = startWorker(
			accessor,
			scriptedProvider([extraction, deleteDecision]),
			{ ...PHASE_C_CFG, autonomous: { ...PHASE_C_CFG.autonomous, allowUpdateDelete: true } },
			DECISION_CFG,
		);

		await Bun.sleep(300);
		await worker.stop();

		// Target memory should be soft-deleted
		const target = db.prepare(`SELECT is_deleted FROM memories WHERE id = ?`).get("mem-target-del") as
			| { is_deleted: number }
			| undefined;
		expect(target?.is_deleted).toBe(1);

		// Stats should reflect the delete
		const job = getJob(db, "mem-src-del");
		const payload = JSON.parse(job?.result ?? "{}");
		expect(payload.writeStats.deleted).toBe(1);
		expect(payload.writeStats.blockedDestructive).toBe(0);

		// Decision history should record deletedMemoryId
		const sourceHistory = db
			.prepare(`SELECT metadata FROM memory_history WHERE memory_id = ?`)
			.all("mem-src-del") as Array<{ metadata: string | null }>;
		const parsed = sourceHistory.map((row) => JSON.parse(row.metadata ?? "{}"));
		expect(parsed.some((row) => row.deletedMemoryId === "mem-target-del")).toBe(true);
	});

	it("skips delete for pinned memories when allowUpdateDelete is true", async () => {
		insertMemory(db, "mem-target-pinned", "User does not prefer dark mode editor theme");
		// Pin the target memory
		db.prepare(`UPDATE memories SET pinned = 1 WHERE id = ?`).run("mem-target-pinned");

		insertMemory(db, "mem-src-del-pinned", "Source envelope for delete of pinned target");
		enqueueExtractionJob(accessor, "mem-src-del-pinned");

		const extraction = JSON.stringify({
			facts: [
				{
					content: "User does not prefer dark mode editor theme",
					type: "preference",
					confidence: 0.9,
				},
			],
			entities: [],
		});
		const deleteDecision = JSON.stringify({
			action: "delete",
			targetId: "mem-target-pinned",
			confidence: 0.85,
			reason: "Contradicts current preference",
		});

		const worker = startWorker(
			accessor,
			scriptedProvider([extraction, deleteDecision]),
			{ ...PHASE_C_CFG, autonomous: { ...PHASE_C_CFG.autonomous, allowUpdateDelete: true } },
			DECISION_CFG,
		);

		await Bun.sleep(300);
		await worker.stop();

		// Target should NOT be deleted (pinned protection)
		const target = db.prepare(`SELECT is_deleted, pinned FROM memories WHERE id = ?`).get("mem-target-pinned") as
			| { is_deleted: number; pinned: number }
			| undefined;
		expect(target?.is_deleted).toBe(0);
		expect(target?.pinned).toBe(1);

		// Stats should show 0 deletes
		const job = getJob(db, "mem-src-del-pinned");
		const payload = JSON.parse(job?.result ?? "{}");
		expect(payload.writeStats.deleted).toBe(0);

		// History should record the skip reason
		const sourceHistory = db
			.prepare(`SELECT metadata FROM memory_history WHERE memory_id = ?`)
			.all("mem-src-del-pinned") as Array<{ metadata: string | null }>;
		const parsed = sourceHistory.map((row) => JSON.parse(row.metadata ?? "{}"));
		expect(parsed.some((row) => row.skippedReason === "delete_pinned_requires_force")).toBe(true);
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
		db.prepare(`UPDATE memory_jobs SET max_attempts = 1 WHERE memory_id = ?`).run("mem-die");

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

		const cfg = { ...PIPELINE_CFG, worker: { ...PIPELINE_CFG.worker, maxRetries: 1, pollMs: 10 } };
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

		const cfg = { ...PIPELINE_CFG, worker: { ...PIPELINE_CFG.worker, maxRetries: 3, pollMs: 10 } };
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

// ---------------------------------------------------------------------------
// Backoff recovery tests (issue #248)
// ---------------------------------------------------------------------------

describe("Backoff recovery", () => {
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

	it("resets backoff on success after failures — all jobs complete promptly", async () => {
		// Enqueue 3 jobs. Provider throws on first call then succeeds.
		// With the old decrement-by-1 logic and 3 failures from retries,
		// backoff would reach ~8s. With reset-to-0, jobs complete within
		// a few hundred ms at 10ms pollMs.
		insertMemory(db, "mem-bf-1", "Content one");
		insertMemory(db, "mem-bf-2", "Content two");
		insertMemory(db, "mem-bf-3", "Content three");
		enqueueExtractionJob(accessor, "mem-bf-1");
		enqueueExtractionJob(accessor, "mem-bf-2");
		enqueueExtractionJob(accessor, "mem-bf-3");

		const cfg = {
			...PIPELINE_CFG,
			worker: { ...PIPELINE_CFG.worker, pollMs: 10, maxRetries: 1 },
		};
		const worker = startWorker(accessor, failThenSucceedProvider(1), cfg, DECISION_CFG);

		// If backoff doesn't reset, 1 failure = 2s delay per tick.
		// 3 jobs at 2s each = 6s minimum. We allow 2s — should be plenty
		// with reset-to-0 and 10ms polling.
		await Bun.sleep(2000);
		await worker.stop();

		// mem-bf-1 may have hit the throwing call — should be dead or completed
		const j0 = getJob(db, "mem-bf-1");
		expect(["completed", "dead"]).toContain(j0?.status);
		const j1 = getJob(db, "mem-bf-2");
		const j2 = getJob(db, "mem-bf-3");
		expect(j1?.status).toBe("completed");
		expect(j2?.status).toBe("completed");
	});

	it("resets backoff when queue empties after failures", async () => {
		// First job will fail all retries (dead). Then we enqueue a second
		// job — it should process promptly, not after 30s backoff.
		insertMemory(db, "mem-drain-1", "Will fail");
		enqueueExtractionJob(accessor, "mem-drain-1");

		const cfg = {
			...PIPELINE_CFG,
			worker: { ...PIPELINE_CFG.worker, pollMs: 10, maxRetries: 1 },
		};
		const worker = startWorker(accessor, failThenSucceedProvider(1), cfg, DECISION_CFG);

		// Let first job fail and enter per-job backoff
		await Bun.sleep(200);

		// Enqueue a fresh job — provider now returns good results
		insertMemory(db, "mem-drain-2", "Will succeed");
		enqueueExtractionJob(accessor, "mem-drain-2");

		// With reset-on-empty, the idle polls after the first failure
		// reset backoff to 0, so the new job picks up at 10ms interval.
		await Bun.sleep(500);
		await worker.stop();

		const job = getJob(db, "mem-drain-2");
		expect(job?.status).toBe("completed");
	});

	it("nudge() forces immediate repoll regardless of current delay", async () => {
		// Start worker with a very long poll interval (60s). Without nudge,
		// the job would not be processed for 60 seconds. Nudge cancels
		// the current delay and forces an immediate poll.
		const cfg = {
			...PIPELINE_CFG,
			worker: { ...PIPELINE_CFG.worker, pollMs: 60000 },
		};
		const worker = startWorker(accessor, goodProvider(), cfg, DECISION_CFG);

		// First tick fires at 60s — nothing happens in 200ms
		await Bun.sleep(200);

		// Enqueue a job and nudge — should pick it up immediately
		insertMemory(db, "mem-nudge", "Content for nudge test");
		enqueueExtractionJob(accessor, "mem-nudge");
		worker.nudge();

		// Job should complete within 500ms (not 60s)
		await Bun.sleep(500);
		await worker.stop();

		const job = getJob(db, "mem-nudge");
		expect(job?.status).toBe("completed");
	});

	it("stats reflect current worker state", async () => {
		insertMemory(db, "mem-stats-1", "Content one");
		insertMemory(db, "mem-stats-2", "Content two");
		enqueueExtractionJob(accessor, "mem-stats-1");
		enqueueExtractionJob(accessor, "mem-stats-2");

		const cfg = {
			...PIPELINE_CFG,
			worker: { ...PIPELINE_CFG.worker, pollMs: 10 },
		};
		const worker = startWorker(accessor, goodProvider(), cfg, DECISION_CFG);

		await Bun.sleep(500);
		await worker.stop();

		const s = worker.stats;
		expect(s.processed).toBeGreaterThanOrEqual(2);
		expect(s.failures).toBe(0);
		expect(s.pending).toBe(0);
		expect(s.lastProgressAt).toBeGreaterThan(0);
		expect(s.backoffMs).toBe(cfg.worker.pollMs);
	});
});

describe("recoverMemoryJobs", () => {
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

	it("marks exhausted pending jobs as dead", () => {
		// Regression: memory_jobs stuck in 'pending' with attempts >= max_attempts
		// are silently skipped by the tick loop (requires attempts < max_attempts)
		// and never recovered. The stall detector fires every 60s indefinitely.
		const now = new Date().toISOString();
		db.prepare(
			`INSERT INTO memory_jobs (id, memory_id, job_type, status, attempts, max_attempts, created_at, updated_at)
			 VALUES ('job-exhausted', NULL, 'extract', 'pending', 3, 3, ?, ?)`,
		).run(now, now);
		db.prepare(
			`INSERT INTO memory_jobs (id, memory_id, job_type, status, attempts, max_attempts, created_at, updated_at)
			 VALUES ('job-active', NULL, 'extract', 'pending', 1, 3, ?, ?)`,
		).run(now, now);

		const { updated } = recoverMemoryJobs(accessor);
		expect(updated).toBe(1);

		const dead = db.prepare("SELECT status FROM memory_jobs WHERE id = 'job-exhausted'").get() as
			| { status: string }
			| undefined;
		const active = db.prepare("SELECT status FROM memory_jobs WHERE id = 'job-active'").get() as
			| { status: string }
			| undefined;

		expect(dead?.status).toBe("dead");
		expect(active?.status).toBe("pending");
	});

	it("returns zero when no exhausted jobs exist", () => {
		const { updated } = recoverMemoryJobs(accessor);
		expect(updated).toBe(0);
	});

	it("recovers jobs exhausted by lowered maxRetries even if max_attempts column is higher", () => {
		// Regression: operator lowers maxRetries from 5 to 3 after rows were
		// inserted with max_attempts=5. jobs with attempts=3 are now above the
		// runtime limit (maxRetries=3) but below the stored column (max_attempts=5).
		// Without the MIN(max_attempts, maxRetries) fix these jobs stay stuck in
		// 'pending' forever: leaseJob() won't pick them up and recoverMemoryJobs
		// without maxRetries won't mark them dead.
		const now = new Date().toISOString();
		// attempts=3 >= maxRetries=3, but max_attempts=5 — should become dead
		db.prepare(
			`INSERT INTO memory_jobs (id, memory_id, job_type, status, attempts, max_attempts, created_at, updated_at)
			 VALUES ('job-runtime-exhausted', NULL, 'extract', 'pending', 3, 5, ?, ?)`,
		).run(now, now);
		// attempts=2 < maxRetries=3 — should stay pending
		db.prepare(
			`INSERT INTO memory_jobs (id, memory_id, job_type, status, attempts, max_attempts, created_at, updated_at)
			 VALUES ('job-still-eligible', NULL, 'extract', 'pending', 2, 5, ?, ?)`,
		).run(now, now);

		const { updated } = recoverMemoryJobs(accessor, 3); // maxRetries lowered to 3
		expect(updated).toBe(1);

		const dead = db
			.prepare("SELECT status FROM memory_jobs WHERE id = 'job-runtime-exhausted'")
			.get() as { status: string } | undefined;
		const active = db
			.prepare("SELECT status FROM memory_jobs WHERE id = 'job-still-eligible'")
			.get() as { status: string } | undefined;

		expect(dead?.status).toBe("dead");
		expect(active?.status).toBe("pending");
	});
});

describe("watchdog pendingCount — exhausted jobs excluded", () => {
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

	it("stats.pending excludes jobs whose attempts equal maxRetries", async () => {
		// Insert one job that has exhausted its retries (attempts === maxRetries === 3)
		// and one job that is still eligible but in exponential backoff so it won't
		// be leased during the short test window (failed_at = now, attempts=1 → 10s backoff).
		const now = new Date().toISOString();
		db.prepare(
			`INSERT INTO memory_jobs (id, memory_id, job_type, status, attempts, max_attempts, created_at, updated_at)
			 VALUES ('job-exhausted', NULL, 'extract', 'pending', 3, 3, ?, ?)`,
		).run(now, now);
		db.prepare(
			`INSERT INTO memory_jobs (id, memory_id, job_type, status, attempts, max_attempts, failed_at, created_at, updated_at)
			 VALUES ('job-in-backoff', NULL, 'extract', 'pending', 1, 3, ?, ?, ?)`,
		).run(now, now, now);

		// maxRetries: 3 — matches PIPELINE_CFG. The watchdog/pendingCount queries
		// now use `attempts < ?` with this value, so 'job-exhausted' (attempts=3)
		// must not be counted. 'job-in-backoff' (attempts=1, failed_at=now) has a
		// 10s backoff window and will not be leased during this test.
		const cfg = { ...PIPELINE_CFG, worker: { ...PIPELINE_CFG.worker, maxRetries: 3, pollMs: 10 } };
		const worker = startWorker(accessor, goodProvider(), cfg, DECISION_CFG);
		// Give a tick to let stats settle.
		await new Promise((r) => setTimeout(r, 50));
		expect(worker.stats.pending).toBe(1); // only job-in-backoff; exhausted job excluded
		worker.stop();
	});

	it("stats.pending is zero when only exhausted jobs remain", async () => {
		const now = new Date().toISOString();
		db.prepare(
			`INSERT INTO memory_jobs (id, memory_id, job_type, status, attempts, max_attempts, created_at, updated_at)
			 VALUES ('job-dead', NULL, 'extract', 'pending', 3, 3, ?, ?)`,
		).run(now, now);

		const cfg = { ...PIPELINE_CFG, worker: { ...PIPELINE_CFG.worker, maxRetries: 3, pollMs: 10 } };
		const worker = startWorker(accessor, goodProvider(), cfg, DECISION_CFG);
		await new Promise((r) => setTimeout(r, 50));
		expect(worker.stats.pending).toBe(0);
		worker.stop();
	});
});
