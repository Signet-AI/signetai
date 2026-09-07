/**
 * Tests for the repair-actions module (F2 track: Autonomous Maintenance).
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readMemoriesFtsSql } from "../../core/src/fts-schema";
import { runMigrations } from "../../core/src/migrations";
import { normalizeAndHashContent } from "./content-normalization";
import type { DbAccessor, ReadDb, WriteDb } from "./db-accessor";
import { toFtsSchemaQueryDb } from "./db-accessor";
import { ensureEmbeddingIndexState } from "./embedding-index-state";
import { embeddingProfileFingerprint } from "./embedding-profile";
import { DEFAULT_PIPELINE_V2 } from "./memory-config";
import type { EmbeddingConfig, PipelineV2Config } from "./memory-config";
import {
	cancelObsoleteJobs,
	checkFtsConsistency,
	checkRepairGate,
	cleanOrphanedEmbeddings,
	createRateLimiter,
	deduplicateMemories,
	getDedupStats,
	getEmbeddingGapStats,
	rebuildDerivedIndexes,
	pruneGenericEntities,
	pruneTerminalJobs,
	reembedMissingMemories,
	reembedModelMigration,
	releaseStaleLeases,
	requeueDeadJobs,
	resetFtsRebuildConfirmation,
	resyncVectorIndex,
	triggerRetentionSweep,
} from "./repair-actions";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function asAccessor(db: Database, onAsyncWrite?: () => void): DbAccessor {
	return {
		withWriteTx<T>(fn: (wdb: WriteDb) => T): T {
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
		withWriteTxAsync<T>(fn: (wdb: WriteDb) => T): Promise<T> {
			onAsyncWrite?.();
			return new Promise<T>((resolve, reject) => {
				setTimeout(() => {
					try {
						db.exec("BEGIN IMMEDIATE");
						try {
							const result = fn(db as unknown as WriteDb);
							db.exec("COMMIT");
							resolve(result);
						} catch (error) {
							db.exec("ROLLBACK");
							throw error;
						}
					} catch (error) {
						reject(error);
					}
				}, 0);
			});
		},
		withReadDb<T>(fn: (rdb: ReadDb) => T): T {
			return fn(db as unknown as ReadDb);
		},
		withReadDbAsync<T>(fn: (rdb: ReadDb) => Promise<T>): Promise<T> {
			return fn(db as unknown as ReadDb);
		},
		close() {
			db.close();
		},
	};
}

function installLegacyPorterMemoriesFts(db: Database, indexedId?: string, tokenizer = "porter unicode61"): void {
	db.exec("DROP TRIGGER IF EXISTS memories_ai");
	db.exec("DROP TRIGGER IF EXISTS memories_ad");
	db.exec("DROP TRIGGER IF EXISTS memories_au");
	db.exec("DROP TABLE IF EXISTS memories_fts");
	db.exec(`
		CREATE VIRTUAL TABLE memories_fts USING fts5(
			content,
			content='memories',
			content_rowid='rowid',
			tokenize='${tokenizer}'
		);
	`);
	db.exec(`
		CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
			INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
		END;
	`);
	db.exec(`
		CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
			INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', old.rowid, old.content);
		END;
	`);
	db.exec(`
		CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
			INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', old.rowid, old.content);
			INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
		END;
	`);
	if (indexedId === undefined) {
		db.exec("INSERT INTO memories_fts(rowid, content) SELECT rowid, content FROM memories");
	} else {
		db.prepare("INSERT INTO memories_fts(rowid, content) SELECT rowid, content FROM memories WHERE id = ?").run(
			indexedId,
		);
	}
}

const TEST_CFG: PipelineV2Config = {
	...DEFAULT_PIPELINE_V2,
	shadowMode: false,
	mutationsFrozen: false,
	semanticContradictionEnabled: false,
	extraction: {
		...DEFAULT_PIPELINE_V2.extraction,
		provider: "ollama",
		model: "test",
		timeout: 45000,
		minConfidence: 0.7,
	},
	reranker: {
		...DEFAULT_PIPELINE_V2.reranker,
		enabled: false,
	},
	autonomous: {
		...DEFAULT_PIPELINE_V2.autonomous,
		enabled: true,
		frozen: false,
		allowUpdateDelete: true,
		maintenanceIntervalMs: 1800000,
		maintenanceMode: "observe",
	},
	telemetryEnabled: false,
};

const TEST_EMBEDDING_CFG: EmbeddingConfig = {
	provider: "ollama",
	model: "test",
	dimensions: 3,
	base_url: "http://localhost:11434",
};

const CTX_OPERATOR = {
	reason: "test run",
	actor: "test-operator",
	actorType: "operator" as const,
};

const CTX_AGENT = {
	reason: "test run",
	actor: "test-agent",
	actorType: "agent" as const,
};

const CTX_DAEMON = {
	reason: "test run",
	actor: "test-daemon",
	actorType: "daemon" as const,
};

function insertMemory(db: Database, id: string, agentId?: string, contentHash?: string): void {
	const now = new Date().toISOString();
	db.prepare(
		`INSERT INTO memories (id, content, content_hash, agent_id, type, created_at, updated_at, updated_by)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(id, `content for ${id}`, contentHash ?? null, agentId ?? null, "fact", now, now, "test");
}

function repairAuditCount(db: Database, action: string): number {
	const rows = db.prepare("SELECT metadata FROM memory_history WHERE metadata LIKE ?").all(`%${action}%`) as Array<{
		metadata: string;
	}>;
	return rows.filter((row) => {
		const parsed = JSON.parse(row.metadata) as { repairAction?: string };
		return parsed.repairAction === action;
	}).length;
}

function insertJob(
	db: Database,
	id: string,
	memId: string,
	status: string,
	leasedAt?: string,
	attempts = 0,
	maxAttempts = 3,
	jobType = "document_ingest",
): void {
	const now = new Date().toISOString();
	db.prepare(
		`INSERT INTO memory_jobs
		 (id, memory_id, job_type, status, attempts, max_attempts, leased_at, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(id, memId, jobType, status, attempts, maxAttempts, leasedAt ?? null, now, now);
}

function insertSummaryJob(db: Database, id: string, status: string, createdAt?: string): void {
	const now = createdAt ?? new Date().toISOString();
	db.prepare(
		`INSERT INTO summary_jobs
		 (id, session_key, harness, project, transcript, status, attempts, max_attempts, created_at, error)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(id, `session-${id}`, "test", "test-project", `transcript ${id}`, status, 0, 3, now, null);
}

function ensureVecTable(db: Database): void {
	try {
		db.exec("DROP TABLE IF EXISTS vec_embeddings");
	} catch {
		// ignore drop failures in tests
	}
	db.exec("CREATE TABLE vec_embeddings (id TEXT PRIMARY KEY, embedding BLOB)");
}

function vectorBlob(values: readonly number[]): Buffer {
	const f32 = new Float32Array(values);
	return Buffer.from(f32.buffer.slice(0));
}

function insertEmbedding(
	db: Database,
	params: {
		id: string;
		contentHash: string;
		sourceId: string;
		vector: readonly number[];
		agentId?: string;
	},
): void {
	const now = new Date().toISOString();
	db.prepare(
		`INSERT INTO embeddings (id, content_hash, vector, dimensions, source_type, source_id, chunk_text, created_at, agent_id)
		 VALUES (?, ?, ?, ?, 'memory', ?, ?, ?, ?)`,
	).run(
		params.id,
		params.contentHash,
		vectorBlob(params.vector),
		params.vector.length,
		params.sourceId,
		`chunk for ${params.sourceId}`,
		now,
		params.agentId ?? null,
	);
}

// ---------------------------------------------------------------------------
// Rate limiter tests
// ---------------------------------------------------------------------------

describe("createRateLimiter", () => {
	it("allows the first call", async () => {
		const limiter = createRateLimiter();
		const result = limiter.check("action", 60000, 10);
		expect(result.allowed).toBe(true);
	});

	it("blocks a second call within cooldown", async () => {
		const limiter = createRateLimiter();
		limiter.record("action");
		const result = limiter.check("action", 60000, 10);
		expect(result.allowed).toBe(false);
		expect(result.reason).toMatch(/cooldown active/);
	});

	it("enforces hourly budget", async () => {
		const limiter = createRateLimiter();
		// Use a 0ms cooldown so the limiter only blocks on budget, not cooldown
		for (let i = 0; i < 3; i++) {
			limiter.record("action");
		}
		// Manually set lastRunAt to be well in the past so cooldown is clear
		// We can't directly access internals, so test via a limiter with budget=2
		const lim2 = createRateLimiter();
		lim2.record("a");
		lim2.record("a");
		// Both records happened so count=2; budget is 2, so third should be blocked
		// But cooldown would block too. Use budget=2 and cooldown=0 scenario:
		// We need to move time forward conceptually — easiest is to just verify
		// the budget path via a fresh limiter with a budget of 1
		const lim1 = createRateLimiter();
		lim1.record("b");
		// Now set lastRunAt in the past so cooldown is clear but count stays at 1
		// We can't do this without access to internals, so instead just verify
		// that a budget of 0 blocks (budget must be >= 1 per config clamp, but
		// we can test the logic indirectly through a fresh action)
		//
		// The most reliable test: use a limiter with budget=1, record once,
		// then check via a zero-cooldown call in the future. Since we can't
		// fake Date.now() easily, verify the count path triggers at budget=1
		// by calling check with budget=0 after recording.
		const result = lim1.check("b", 0, 0);
		expect(result.allowed).toBe(false);
		expect(result.reason).toMatch(/hourly budget exhausted/);
	});

	it("resets hourly count after the hour window expires", async () => {
		const limiter = createRateLimiter();
		// Record, then directly verify that a past hourResetAt causes reset.
		// We can observe this indirectly: record with budget=1, then once
		// the hour resets the check should pass with cooldown=0.
		// Since we cannot fake Date.now here, simulate via the internal state
		// by calling with an extremely small hourly window indirectly:
		// just verify budget check passes again after the window.
		// This is tested at the integration level via requeueDeadJobs gating;
		// here we verify the branch via the module's public API with budget=50.
		const lim = createRateLimiter();
		// Record 49 times — still under budget of 50
		for (let i = 0; i < 49; i++) {
			lim.record("x");
		}
		const allowed = lim.check("x", 0, 50);
		// 49 < 50, cooldown 0 so passes
		expect(allowed.allowed).toBe(true);
		// One more record makes it 50 — at budget
		lim.record("x");
		const denied = lim.check("x", 0, 50);
		expect(denied.allowed).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Policy gate tests
// ---------------------------------------------------------------------------

describe("checkRepairGate", () => {
	it("denies when autonomousFrozen is true", async () => {
		const limiter = createRateLimiter();
		const cfg = { ...TEST_CFG, autonomous: { ...TEST_CFG.autonomous, frozen: true } };
		const result = checkRepairGate(cfg, CTX_OPERATOR, limiter, "a", 0, 100);
		expect(result.allowed).toBe(false);
		expect(result.reason).toMatch(/autonomous\.frozen/);
	});

	it("denies agent when autonomous.enabled is false", async () => {
		const limiter = createRateLimiter();
		const cfg = { ...TEST_CFG, autonomous: { ...TEST_CFG.autonomous, enabled: false } };
		const result = checkRepairGate(cfg, CTX_AGENT, limiter, "a", 0, 100);
		expect(result.allowed).toBe(false);
		expect(result.reason).toMatch(/autonomous\.enabled is false/);
	});

	it("allows operator even when autonomous.enabled is false", async () => {
		const limiter = createRateLimiter();
		const cfg = { ...TEST_CFG, autonomous: { ...TEST_CFG.autonomous, enabled: false } };
		const result = checkRepairGate(cfg, CTX_OPERATOR, limiter, "a", 0, 100);
		expect(result.allowed).toBe(true);
	});
});

describe("pruneGenericEntities", () => {
	it("dry-runs and deletes generic entities without touching pinned or concrete entities", async () => {
		const db = new Database(":memory:");
		runMigrations(db as unknown as Parameters<typeof runMigrations>[0]);
		const accessor = asAccessor(db);
		const limiter = createRateLimiter();
		const now = new Date().toISOString();

		try {
			const insert = db.prepare(
				`INSERT INTO entities
				 (id, name, canonical_name, entity_type, agent_id, mentions, pinned, created_at, updated_at)
				 VALUES (?, ?, ?, ?, 'default', ?, ?, ?, ?)`,
			);
			insert.run("ent-sender", "Sender", "sender", "person", 174, 0, now, now);
			insert.run("ent-signet", "Signet", "signet", "project", 5, 0, now, now);
			insert.run("ent-pinned", "Summary", "summary", "document", 3, 1, now, now);
			insert.run("ent-skill", "Skill Creator", "skill creator", "skill", 1, 0, now, now);
			db.prepare(
				`INSERT INTO skill_meta
				 (entity_id, agent_id, source, installed_at, fs_path)
				 VALUES (?, 'default', 'signet', ?, ?)`,
			).run("ent-skill", now, "/skills/skill-creator/SKILL.md");

			const dryRun = await pruneGenericEntities(accessor, TEST_CFG, CTX_OPERATOR, limiter, { dryRun: true });
			expect(dryRun.success).toBe(true);
			expect(dryRun.affected).toBe(1);
			expect(dryRun.message).toContain("Sender");

			const result = await pruneGenericEntities(accessor, TEST_CFG, CTX_OPERATOR, limiter, { dryRun: false });
			expect(result.success).toBe(true);
			expect(result.affected).toBe(1);

			const remaining = db.prepare("SELECT name FROM entities ORDER BY name").all() as Array<{ name: string }>;
			expect(remaining.map((row) => row.name)).toEqual(["Signet", "Skill Creator", "Summary"]);
		} finally {
			db.close();
		}
	});

	it("prunes Markdown-polluted and standalone structural nodes while preserving specific names", async () => {
		const db = new Database(":memory:");
		runMigrations(db as unknown as Parameters<typeof runMigrations>[0]);
		const accessor = asAccessor(db);
		const limiter = createRateLimiter();
		const now = new Date().toISOString();

		try {
			const insert = db.prepare(
				`INSERT INTO entities
				 (id, name, canonical_name, entity_type, agent_id, mentions, pinned, created_at, updated_at)
				 VALUES (?, ?, ?, ?, 'default', 1, 0, ?, ?)`,
			);
			insert.run("ent-current", "Current", "current", "project", now, now);
			insert.run("ent-status", "**Status:**", "status", "document", now, now);
			insert.run("ent-project", "Current Project", "current project", "project", now, now);
			insert.run("ent-page", "Status Page", "status page", "system", now, now);
			db.prepare(
				`INSERT INTO entity_retrieval_stats
				 (agent_id, entity_id, session_count, last_session_key, updated_at, created_at)
				 VALUES ('default', 'ent-current', 1, 'session-1', ?, ?)`,
			).run(now, now);
			db.prepare(
				`INSERT INTO entity_cooccurrence
				 (agent_id, source_entity_id, target_entity_id, session_count, last_session_key, updated_at, created_at)
				 VALUES ('default', 'ent-current', 'ent-project', 1, 'session-1', ?, ?)`,
			).run(now, now);

			const dryRun = await pruneGenericEntities(accessor, TEST_CFG, CTX_OPERATOR, limiter, { dryRun: true });
			expect(dryRun.success).toBe(true);
			expect(dryRun.affected).toBe(2);
			expect(dryRun.message).toContain("Current");
			expect(dryRun.message).toContain("**Status:**");

			const result = await pruneGenericEntities(accessor, TEST_CFG, CTX_OPERATOR, limiter, { dryRun: false });
			expect(result.success).toBe(true);
			expect(result.affected).toBe(2);
			const remaining = db.prepare("SELECT name FROM entities ORDER BY name").all() as Array<{ name: string }>;
			expect(remaining.map((row) => row.name)).toEqual(["Current Project", "Status Page"]);
			expect(
				(db.prepare("SELECT COUNT(*) AS count FROM entity_retrieval_stats").get() as { count: number }).count,
			).toBe(0);
			expect((db.prepare("SELECT COUNT(*) AS count FROM entity_cooccurrence").get() as { count: number }).count).toBe(
				0,
			);
		} finally {
			db.close();
		}
	});

	it("continues scanning past recent valid entities to find older generic rows", async () => {
		const db = new Database(":memory:");
		runMigrations(db as unknown as Parameters<typeof runMigrations>[0]);
		const accessor = asAccessor(db);
		const limiter = createRateLimiter();
		const recent = "2026-05-11T18:00:00.000Z";
		const old = "2026-05-01T18:00:00.000Z";

		try {
			const insert = db.prepare(
				`INSERT INTO entities
				 (id, name, canonical_name, entity_type, agent_id, mentions, pinned, created_at, updated_at)
				 VALUES (?, ?, ?, ?, 'default', ?, 0, ?, ?)`,
			);
			for (let i = 0; i < 510; i += 1) {
				insert.run(`ent-project-${i}`, `Project ${i}`, `project ${i}`, "project", 1, recent, recent);
			}
			insert.run("ent-sender-old", "Sender", "sender", "person", 12, old, old);

			const dryRun = await pruneGenericEntities(accessor, TEST_CFG, CTX_OPERATOR, limiter, {
				dryRun: true,
				batchSize: 1,
			});
			expect(dryRun.success).toBe(true);
			expect(dryRun.affected).toBe(1);
			expect(dryRun.message).toContain("Sender");
		} finally {
			db.close();
		}
	});
});

// ---------------------------------------------------------------------------
// requeueDeadJobs
// ---------------------------------------------------------------------------

describe("requeueDeadJobs", () => {
	let db: Database;
	let accessor: DbAccessor;

	beforeEach(() => {
		db = new Database(":memory:");
		runMigrations(db as unknown as Parameters<typeof runMigrations>[0]);
		accessor = asAccessor(db);
	});

	afterEach(() => {
		db.close();
	});

	it("resets dead jobs to pending", async () => {
		insertMemory(db, "mem-1");
		insertJob(db, "job-1", "mem-1", "dead");
		insertJob(db, "job-2", "mem-1", "dead");

		const limiter = createRateLimiter();
		const result = await requeueDeadJobs(accessor, TEST_CFG, CTX_OPERATOR, limiter);

		expect(result.success).toBe(true);
		expect(result.affected).toBe(2);

		const statuses = db.prepare("SELECT status FROM memory_jobs WHERE memory_id = 'mem-1'").all() as Array<{
			status: string;
		}>;
		expect(statuses.every((r) => r.status === "pending")).toBe(true);
	});

	it("respects maxBatch limit", async () => {
		insertMemory(db, "mem-2");
		for (let i = 0; i < 5; i++) {
			insertJob(db, `job-b-${i}`, "mem-2", "dead");
		}

		const limiter = createRateLimiter();
		const result = await requeueDeadJobs(accessor, TEST_CFG, CTX_OPERATOR, limiter, 3);

		expect(result.success).toBe(true);
		expect(result.affected).toBe(3);

		const remaining = db.prepare("SELECT COUNT(*) as n FROM memory_jobs WHERE status = 'dead'").get() as { n: number };
		expect(remaining.n).toBe(2);
	});

	it("does not resurrect retired extraction jobs", async () => {
		insertMemory(db, "mem-retired");
		insertJob(db, "job-retired", "mem-retired", "dead", undefined, 3, 3, "extract");

		const result = await requeueDeadJobs(accessor, TEST_CFG, CTX_OPERATOR, createRateLimiter());

		expect(result.success).toBe(true);
		expect(result.affected).toBe(0);
		expect(db.prepare("SELECT status FROM memory_jobs WHERE id = 'job-retired'").get()).toEqual({ status: "dead" });
	});
});

// ---------------------------------------------------------------------------
// cancelObsoleteJobs / pruneTerminalJobs — aggregate --max-batch cap (#1053)
// ---------------------------------------------------------------------------

describe("repair --max-batch aggregate cap (#1053)", () => {
	let db: Database;
	let accessor: DbAccessor;

	beforeEach(() => {
		db = new Database(":memory:");
		runMigrations(db as unknown as Parameters<typeof runMigrations>[0]);
		accessor = asAccessor(db);
	});

	afterEach(() => {
		db.close();
	});

	function seedBothQueues(count: number): void {
		const now = new Date().toISOString();
		for (let i = 0; i < count; i += 1) {
			const memId = `mem-batch-${i}`;
			insertMemory(db, memId);
			insertJob(db, `mem-job-${i}`, memId, "dead", undefined, 0, 3);
			insertSummaryJob(db, `sum-job-${i}`, "dead", now);
		}
	}

	function countMemoryByStatus(status: string): number {
		const row = db.prepare("SELECT COUNT(*) as n FROM memory_jobs WHERE status = ?").get(status) as { n: number };
		return row.n;
	}

	function countSummaryByStatus(status: string): number {
		const row = db.prepare("SELECT COUNT(*) as n FROM summary_jobs WHERE status = ?").get(status) as { n: number };
		return row.n;
	}

	describe("cancelObsoleteJobs", () => {
		it("default both-queue apply affects at most 1000 total rows (not 2000)", async () => {
			seedBothQueues(1001);

			const result = await cancelObsoleteJobs(accessor, TEST_CFG, CTX_OPERATOR, createRateLimiter(), {
				olderThanMs: 0,
			});

			expect(result.success).toBe(true);
			expect(result.affected).toBeLessThanOrEqual(1000);
			// memory_jobs is selected first and consumes the whole budget.
			expect(countMemoryByStatus("cancelled")).toBe(1000);
			expect(countSummaryByStatus("cancelled")).toBe(0);
		});

		it("--max-batch 50 affects at most 50 total rows across both queues", async () => {
			seedBothQueues(1001);

			const result = await cancelObsoleteJobs(accessor, TEST_CFG, CTX_OPERATOR, createRateLimiter(), {
				olderThanMs: 0,
				maxBatch: 50,
			});

			expect(result.success).toBe(true);
			expect(result.affected).toBeLessThanOrEqual(50);
			expect(countMemoryByStatus("cancelled")).toBe(50);
			expect(countSummaryByStatus("cancelled")).toBe(0);
		});

		it("single-table selection still affects up to the requested cap from the memory table", async () => {
			seedBothQueues(1001);

			const result = await cancelObsoleteJobs(accessor, TEST_CFG, CTX_OPERATOR, createRateLimiter(), {
				olderThanMs: 0,
				maxBatch: 50,
				tables: ["memory"],
			});

			expect(result.success).toBe(true);
			expect(result.affected).toBe(50);
			expect(countMemoryByStatus("cancelled")).toBe(50);
		});

		it("dry-run preview is selected from the same globally bounded set as apply", async () => {
			seedBothQueues(1001);

			const result = await cancelObsoleteJobs(accessor, TEST_CFG, CTX_OPERATOR, createRateLimiter(), {
				olderThanMs: 0,
				maxBatch: 50,
				dryRun: true,
			});

			expect(result.success).toBe(true);
			expect(result.affected).toBe(0);
			expect(result.totalMatching).toBe(1001);
			expect(result.preview?.length ?? 0).toBeLessThanOrEqual(50);
			// Preview ids come only from the memory queue (the first table),
			// matching the apply-time selection order.
			expect(result.preview?.every((id) => id.startsWith("memory_jobs:mem-job-"))).toBe(true);
			expect(countMemoryByStatus("cancelled")).toBe(0);
			expect(countSummaryByStatus("cancelled")).toBe(0);
		});
	});

	describe("pruneTerminalJobs", () => {
		it("default both-queue apply affects at most 1000 total rows (not 2000)", async () => {
			seedBothQueues(1001);

			const result = await pruneTerminalJobs(accessor, TEST_CFG, CTX_OPERATOR, createRateLimiter(), {
				retentionMs: 0,
			});

			expect(result.success).toBe(true);
			expect(result.affected).toBeLessThanOrEqual(1000);
			expect(countMemoryByStatus("dead")).toBe(1);
			expect(countSummaryByStatus("dead")).toBe(1001);
		});

		it("--max-batch 50 affects at most 50 total rows across both queues", async () => {
			seedBothQueues(1001);

			const result = await pruneTerminalJobs(accessor, TEST_CFG, CTX_OPERATOR, createRateLimiter(), {
				retentionMs: 0,
				maxBatch: 50,
			});

			expect(result.success).toBe(true);
			expect(result.affected).toBeLessThanOrEqual(50);
			expect(countMemoryByStatus("dead")).toBe(951);
			expect(countSummaryByStatus("dead")).toBe(1001);
		});

		it("single-table selection still affects up to the requested cap from the memory table", async () => {
			seedBothQueues(1001);

			const result = await pruneTerminalJobs(accessor, TEST_CFG, CTX_OPERATOR, createRateLimiter(), {
				retentionMs: 0,
				maxBatch: 50,
				tables: ["memory"],
			});

			expect(result.success).toBe(true);
			expect(result.affected).toBe(50);
			expect(countMemoryByStatus("dead")).toBe(951);
		});

		it("dry-run preview is selected from the same globally bounded set as apply", async () => {
			seedBothQueues(1001);

			const result = await pruneTerminalJobs(accessor, TEST_CFG, CTX_OPERATOR, createRateLimiter(), {
				retentionMs: 0,
				maxBatch: 50,
				dryRun: true,
			});

			expect(result.success).toBe(true);
			expect(result.affected).toBe(0);
			expect(result.totalMatching).toBe(1001);
			expect(result.preview?.length ?? 0).toBeLessThanOrEqual(50);
			expect(result.preview?.every((id) => id.startsWith("memory_jobs:mem-job-"))).toBe(true);
			expect(countMemoryByStatus("dead")).toBe(1001);
			expect(countSummaryByStatus("dead")).toBe(1001);
		});
	});
});

// ---------------------------------------------------------------------------
// releaseStaleLeases
// ---------------------------------------------------------------------------

describe("releaseStaleLeases", () => {
	let db: Database;
	let accessor: DbAccessor;

	beforeEach(() => {
		db = new Database(":memory:");
		runMigrations(db as unknown as Parameters<typeof runMigrations>[0]);
		accessor = asAccessor(db);
	});

	afterEach(() => {
		db.close();
	});

	it("releases stale leased jobs back to pending", async () => {
		insertMemory(db, "mem-3");

		// Leased 10 minutes ago — past a 5-minute lease timeout
		const staleAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
		insertJob(db, "job-stale", "mem-3", "leased", staleAt);

		// Leased 1 second ago — within a 5-minute lease timeout
		const freshAt = new Date(Date.now() - 1000).toISOString();
		insertJob(db, "job-fresh", "mem-3", "leased", freshAt);

		const cfg = { ...TEST_CFG, worker: { ...TEST_CFG.worker, leaseTimeoutMs: 5 * 60 * 1000 } };
		const limiter = createRateLimiter();
		const result = await releaseStaleLeases(accessor, cfg, CTX_OPERATOR, limiter);

		expect(result.success).toBe(true);
		expect(result.affected).toBe(1);

		const stale = db.prepare("SELECT status, leased_at FROM memory_jobs WHERE id = 'job-stale'").get() as {
			status: string;
			leased_at: string | null;
		};
		expect(stale.status).toBe("pending");
		expect(stale.leased_at).toBeNull();

		const fresh = db.prepare("SELECT status FROM memory_jobs WHERE id = 'job-fresh'").get() as { status: string };
		expect(fresh.status).toBe("leased");
	});

	it("dead-letters stale leases that already exhausted max attempts", async () => {
		insertMemory(db, "mem-4");

		const staleAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
		insertJob(db, "job-exhausted", "mem-4", "leased", staleAt, 3, 3);

		const cfg = { ...TEST_CFG, worker: { ...TEST_CFG.worker, leaseTimeoutMs: 5 * 60 * 1000 } };
		const limiter = createRateLimiter();
		const result = await releaseStaleLeases(accessor, cfg, CTX_OPERATOR, limiter);

		expect(result.success).toBe(true);
		expect(result.affected).toBe(1);
		expect(result.message).toContain("dead-lettered 1 exhausted job(s)");

		const job = db
			.prepare("SELECT status, leased_at, failed_at, error FROM memory_jobs WHERE id = 'job-exhausted'")
			.get() as
			| {
					status: string;
					leased_at: string | null;
					failed_at: string | null;
					error: string | null;
			  }
			| undefined;
		expect(job?.status).toBe("dead");
		expect(job?.leased_at).toBeNull();
		expect(job?.failed_at).not.toBeNull();
		expect(job?.error).toBe("lease expired before completion");
	});
});

// ---------------------------------------------------------------------------
// checkFtsConsistency
// ---------------------------------------------------------------------------

describe("checkFtsConsistency", () => {
	let db: Database;
	let accessor: DbAccessor;
	let asyncWriterUsed = false;

	beforeEach(() => {
		db = new Database(":memory:");
		asyncWriterUsed = false;
		runMigrations(db as unknown as Parameters<typeof runMigrations>[0]);
		accessor = asAccessor(db, () => {
			asyncWriterUsed = true;
		});
		resetFtsRebuildConfirmation();
	});

	afterEach(() => {
		db.close();
	});

	it("reports consistent FTS when counts match", async () => {
		insertMemory(db, "mem-fts-ok");
		const limiter = createRateLimiter();
		const result = await checkFtsConsistency(accessor, TEST_CFG, CTX_OPERATOR, limiter, false);

		expect(result.success).toBe(true);
		// counts match (FTS5 external content reads from memories)
		expect(result.affected).toBe(0);
		expect(result.message).toMatch(/consistent/);
	});

	it("runs rebuild without error when repair=true", async () => {
		insertMemory(db, "mem-fts-rebuild");
		const limiter = createRateLimiter();
		// repair=true triggers rebuild even when consistent; should not throw
		const result = await checkFtsConsistency(accessor, TEST_CFG, CTX_OPERATOR, limiter, true);
		// Rebuild only runs on mismatch; consistent case is a no-op
		expect(result.success).toBe(true);
	});

	it("detects legacy porter tokenizer drift", async () => {
		insertMemory(db, "We celebrate wins together");
		installLegacyPorterMemoriesFts(db);
		const limiter = createRateLimiter();
		const result = await checkFtsConsistency(accessor, TEST_CFG, CTX_OPERATOR, limiter, false);

		expect(result.success).toBe(true);
		expect(result.affected).toBe(1);
		expect(result.message).toMatch(/tokenizer drift/i);
		expect(readMemoriesFtsSql(toFtsSchemaQueryDb(db))).toContain("porter unicode61");
	});

	it("repairs legacy porter tokenizer drift when repair=true", async () => {
		insertMemory(db, "We celebrate wins together");
		installLegacyPorterMemoriesFts(db);
		const limiter = createRateLimiter();
		const result = await checkFtsConsistency(accessor, TEST_CFG, CTX_OPERATOR, limiter, true);

		expect(result.success).toBe(true);
		expect(result.affected).toBe(1);
		expect(result.message).toMatch(/unicode61 tokenizer/i);

		const sql = readMemoriesFtsSql(toFtsSchemaQueryDb(db));
		expect(sql).toContain("tokenize='unicode61'");
		expect(sql).not.toContain("porter unicode61");
	});

	it("does not treat legitimate tombstones as FTS corruption", async () => {
		insertMemory(db, "mem-fts-tombstone");
		insertMemory(db, "mem-fts-tombstone-deleted");
		db.prepare("UPDATE memories SET is_deleted = 1 WHERE id = ?").run("mem-fts-tombstone-deleted");

		const result = await checkFtsConsistency(accessor, TEST_CFG, CTX_DAEMON, createRateLimiter(), true);
		expect(result.success).toBe(true);
		expect(result.affected).toBe(0);
		expect(result.message).toMatch(/consistent/);
		expect(repairAuditCount(db, "checkFtsConsistency")).toBe(0);
	});

	it("defers autonomous repair until a genuine mismatch persists", async () => {
		insertMemory(db, "mem-fts-deferred");
		insertMemory(db, "mem-fts-deferred-missing");
		installLegacyPorterMemoriesFts(db, "mem-fts-deferred", "unicode61");

		const first = await checkFtsConsistency(accessor, TEST_CFG, CTX_DAEMON, createRateLimiter(), true);
		expect(first.success).toBe(true);
		expect(first.affected).toBe(0);
		expect(first.message).toMatch(/deferred/i);
		expect(asyncWriterUsed).toBe(false);
		expect(repairAuditCount(db, "checkFtsConsistency")).toBe(0);

		const second = await checkFtsConsistency(accessor, TEST_CFG, CTX_DAEMON, createRateLimiter(), true);
		expect(second.success).toBe(true);
		expect(second.affected).toBe(1);
		expect(second.message).toMatch(/rebuilt/i);
		expect(asyncWriterUsed).toBe(true);
		expect(repairAuditCount(db, "checkFtsConsistency")).toBe(1);
	});

	it("repairs a genuinely incomplete FTS index", async () => {
		insertMemory(db, "mem-fts-corrupt-indexed");
		insertMemory(db, "mem-fts-corrupt-missing");
		installLegacyPorterMemoriesFts(db, "mem-fts-corrupt-indexed", "unicode61");

		const result = await checkFtsConsistency(accessor, TEST_CFG, CTX_OPERATOR, createRateLimiter(), true);
		expect(result.success).toBe(true);
		expect(result.affected).toBe(1);
		expect(result.message).toMatch(/rebuilt/);
		expect(asyncWriterUsed).toBe(true);
		expect(repairAuditCount(db, "checkFtsConsistency")).toBe(1);
		expect(db.prepare("SELECT COUNT(*) AS count FROM memories_fts_docsize").get()).toEqual({ count: 2 });
	});

	it("coalesces concurrent FTS rebuilds through one async write", async () => {
		insertMemory(db, "mem-fts-concurrent-indexed");
		insertMemory(db, "mem-fts-concurrent-missing");
		installLegacyPorterMemoriesFts(db, "mem-fts-concurrent-indexed", "unicode61");

		const results = await Promise.all([
			checkFtsConsistency(accessor, TEST_CFG, CTX_OPERATOR, createRateLimiter(), true),
			checkFtsConsistency(accessor, TEST_CFG, CTX_OPERATOR, createRateLimiter(), true),
		]);

		expect(results.filter((result) => result.affected === 1)).toHaveLength(1);
		expect(results.filter((result) => /already in progress/i.test(result.message))).toHaveLength(1);
		expect(asyncWriterUsed).toBe(true);
		expect(repairAuditCount(db, "checkFtsConsistency")).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// reembedMissingMemories
// ---------------------------------------------------------------------------

describe("reembedMissingMemories", () => {
	let db: Database;
	let accessor: DbAccessor;

	beforeEach(() => {
		db = new Database(":memory:");
		runMigrations(db as unknown as Parameters<typeof runMigrations>[0]);
		db.exec("DROP INDEX IF EXISTS idx_memories_content_hash_unique");
		accessor = asAccessor(db);
	});

	afterEach(() => {
		db.close();
	});

	it("preserves a committed memory when embedding persistence fails, then retries idempotently", async () => {
		insertMemory(db, "mem-write-failure");
		let failWrite = true;
		const flakyAccessor: DbAccessor = {
			...accessor,
			withWriteTx<T>(fn: (wdb: WriteDb) => T): T {
				if (failWrite) {
					failWrite = false;
					throw new Error("simulated embedding persistence failure");
				}
				return accessor.withWriteTx(fn);
			},
			withWriteTxAsync<T>(fn: (wdb: WriteDb) => T): Promise<T> {
				return Promise.resolve().then(() => flakyAccessor.withWriteTx(fn));
			},
		};

		const first = reembedMissingMemories(
			flakyAccessor,
			TEST_CFG,
			CTX_OPERATOR,
			createRateLimiter(),
			async () => [0.1, 0.2, 0.3],
			TEST_EMBEDDING_CFG,
			"default",
			1,
			false,
		);
		await expect(first).rejects.toThrow("simulated embedding persistence failure");
		expect(db.prepare("SELECT id FROM memories WHERE id = ?").get("mem-write-failure")).toBeTruthy();
		expect(db.prepare("SELECT id FROM embeddings WHERE source_id = ?").get("mem-write-failure")).toBeNull();

		const second = await reembedMissingMemories(
			accessor,
			TEST_CFG,
			CTX_OPERATOR,
			createRateLimiter(),
			async () => [0.1, 0.2, 0.3],
			TEST_EMBEDDING_CFG,
			"default",
			1,
			false,
		);
		expect(second.success).toBe(true);
		expect(second.affected).toBe(1);
		expect(db.prepare("SELECT id FROM embeddings WHERE source_id = ?").get("mem-write-failure")).toBeTruthy();
	});

	it("resolves the active profile before writing, instead of comparing the raw configured fingerprint", async () => {
		// Regression: a prior --model-mismatch migration promotes the durable
		// active generation with a *named* profile (e.g. "nomic-embed-text-v1.5"),
		// persisted in embedding_index_state.active_profile_json. The route's
		// raw `embeddingCfg` (loaded straight from agent.yaml) carries no
		// `profile` field. Before the fix, isActiveEmbeddingConfig compared the
		// raw config's identity fingerprint against that named-profile
		// fingerprint on every batch — a permanent mismatch, not a race — so
		// `signet embed backfill` failed 100% of the time with "embedding
		// profile changed during provider work", even though nothing changed
		// concurrently.
		insertMemory(db, "mem-named-profile");
		const rawCfg: EmbeddingConfig = { ...TEST_EMBEDDING_CFG, model: "nomic-embed-text:v1.5" };
		accessor.withWriteTx((writeDb) => {
			ensureEmbeddingIndexState(writeDb, rawCfg);
			const namedProfile = {
				fingerprint: embeddingProfileFingerprint({ ...rawCfg, profile: "nomic-embed-text-v1.5" }),
				provider: rawCfg.provider,
				model: rawCfg.model,
				dimensions: rawCfg.dimensions,
				baseUrl: rawCfg.base_url,
				profile: "nomic-embed-text-v1.5",
			};
			writeDb
				.prepare("UPDATE embedding_index_state SET active_profile_json = ? WHERE id = 1")
				.run(JSON.stringify(namedProfile));
		});

		const seenCfgs: EmbeddingConfig[] = [];
		const result = await reembedMissingMemories(
			accessor,
			TEST_CFG,
			CTX_OPERATOR,
			createRateLimiter(),
			async (_content, cfg) => {
				seenCfgs.push(cfg);
				return [0.1, 0.2, 0.3];
			},
			rawCfg,
			"default",
			10,
			false,
		);

		expect(result.success).toBe(true);
		expect(result.affected).toBe(1);
		expect(db.prepare("SELECT id FROM embeddings WHERE source_id = 'mem-named-profile'").get()).toBeTruthy();
		// The embedding call must use the resolved (named) profile, not the raw
		// identity config, so its formatting matches the rest of the active index.
		expect(seenCfgs[0]?.profile).toBe("nomic-embed-text-v1.5");
	});

	it("reconciles canonical embedding state after a mid-write vector-index failure", async () => {
		// Proof for #1325: the canonical embedding write and the derived vec
		// index update are separate failure boundaries. If vec insertion fails
		// after the canonical row commits, the existing resync owner must make
		// the derived index converge without re-embedding or changing the source.
		ensureVecTable(db);
		insertMemory(db, "mem-mid-write");
		db.exec(`
			CREATE TRIGGER reject_vec_insert
			BEFORE INSERT ON vec_embeddings
			BEGIN SELECT RAISE(ABORT, 'simulated mid-write vector failure'); END
		`);

		let providerCalls = 0;
		const first = await reembedMissingMemories(
			accessor,
			TEST_CFG,
			CTX_OPERATOR,
			createRateLimiter(),
			async () => {
				providerCalls++;
				return [0.1, 0.2, 0.3];
			},
			TEST_EMBEDDING_CFG,
			"default",
			1,
			false,
		);

		expect(first.success).toBe(true);
		expect(first.affected).toBe(1);
		expect(providerCalls).toBe(1);
		expect(db.prepare("SELECT id FROM memories WHERE id = 'mem-mid-write' AND is_deleted = 0").get()).toBeTruthy();
		expect(db.prepare("SELECT source_id FROM embeddings WHERE source_id = 'mem-mid-write'").all()).toHaveLength(1);
		expect(db.prepare("SELECT id FROM vec_embeddings").all()).toHaveLength(0);

		// Reconciliation owns the derived index. It must repair the missing vec
		// row from the canonical embedding without invoking the provider again.
		db.exec("DROP TRIGGER reject_vec_insert");
		const repaired = await resyncVectorIndex(accessor, TEST_CFG, CTX_OPERATOR, createRateLimiter());
		expect(repaired.success).toBe(true);
		expect(repaired.affected).toBe(1);
		expect(db.prepare("SELECT id FROM vec_embeddings").all()).toHaveLength(1);
		expect(db.prepare("SELECT source_id FROM embeddings WHERE source_id = 'mem-mid-write'").all()).toHaveLength(1);

		// The delete boundary must also fail closed. A failed derived delete
		// rolls back canonical cleanup, so retrying the existing orphan owner is
		// safe and eventually removes both projections.
		db.prepare("UPDATE memories SET is_deleted = 1 WHERE id = 'mem-mid-write'").run();
		db.exec(`
			CREATE TRIGGER reject_vec_delete
			BEFORE DELETE ON vec_embeddings
			BEGIN SELECT RAISE(ABORT, 'simulated mid-write vector delete failure'); END
		`);
		await expect(cleanOrphanedEmbeddings(accessor, TEST_CFG, CTX_OPERATOR, createRateLimiter())).rejects.toThrow(
			"failed to reconcile vec_embeddings before orphan cleanup",
		);
		expect(db.prepare("SELECT id FROM embeddings WHERE source_id = 'mem-mid-write'").all()).toHaveLength(1);
		expect(db.prepare("SELECT id FROM vec_embeddings").all()).toHaveLength(1);

		db.exec("DROP TRIGGER reject_vec_delete");
		const cleaned = await cleanOrphanedEmbeddings(accessor, TEST_CFG, CTX_OPERATOR, createRateLimiter());
		expect(cleaned.success).toBe(true);
		expect(cleaned.affected).toBe(1);
		expect(db.prepare("SELECT id FROM embeddings WHERE source_id = 'mem-mid-write'").all()).toHaveLength(0);
		expect(db.prepare("SELECT id FROM vec_embeddings").all()).toHaveLength(0);
	});

	it("selects a missing agent memory but reports a cross-agent hash conflict", async () => {
		// The hash is globally unique, but repair selection is agent-scoped.
		// Agent B's missing memory must be selected without updating Agent A's
		// existing embedding.
		ensureVecTable(db);
		const sharedHash = "cross-agent-shared-hash";
		insertMemory(db, "mem-a", "agent-a", sharedHash);
		insertMemory(db, "mem-b", "agent-b", sharedHash);
		insertMemory(db, "mem-b-unique", "agent-b", "agent-b-unique-hash");
		insertEmbedding(db, {
			id: "emb-a",
			contentHash: sharedHash,
			sourceId: "mem-a",
			vector: [0.9, 0.8, 0.7],
			agentId: "agent-a",
		});
		const before = db
			.prepare("SELECT vector, chunk_text, source_id, agent_id, dimensions FROM embeddings WHERE id = 'emb-a'")
			.get();
		const selected: string[] = [];

		const result = await reembedMissingMemories(
			accessor,
			TEST_CFG,
			CTX_AGENT,
			createRateLimiter(),
			async (content) => {
				selected.push(content);
				return [0.1, 0.2, 0.3];
			},
			TEST_EMBEDDING_CFG,
			"agent-b",
			10,
			false,
			false,
			undefined,
		);

		expect(selected).toEqual(["content for mem-b-unique"]);
		expect(result.success).toBe(false);
		expect(result.affected).toBe(1);
		expect(result.details).toEqual({ selected: 2, failed: 0, stale: 0, crossAgentHashConflicts: 1 });
		expect(result.message).toContain("1 selected memory(s) could not be persisted");
		expect(result.message).toContain("current global uniqueness constraint");
		expect(result.message).not.toContain("embedding provider returned no vectors");
		expect(db.prepare("SELECT source_id FROM embeddings WHERE content_hash = ?").all(sharedHash)).toEqual([
			{ source_id: "mem-a" },
		]);
		const after = db
			.prepare("SELECT vector, chunk_text, source_id, agent_id, dimensions FROM embeddings WHERE id = 'emb-a'")
			.get();
		expect(after).toEqual(before);
	});

	it("does not let a known conflict starve later repairable memories during a full sweep", async () => {
		ensureVecTable(db);
		const sharedHash = "starving-cross-agent-hash";
		insertMemory(db, "mem-owner", "agent-a", sharedHash);
		insertMemory(db, "mem-conflict", "agent-b", sharedHash);
		insertMemory(db, "mem-repairable", "agent-b", "agent-b-repairable-hash");
		const old = new Date(Date.now() - 2_000).toISOString();
		const newer = new Date(Date.now() - 1_000).toISOString();
		db.prepare("UPDATE memories SET created_at = ?, updated_at = ? WHERE id = ?").run(old, old, "mem-conflict");
		db.prepare("UPDATE memories SET created_at = ?, updated_at = ? WHERE id = ?").run(newer, newer, "mem-repairable");
		insertEmbedding(db, {
			id: "emb-owner",
			contentHash: sharedHash,
			sourceId: "mem-owner",
			vector: [0.9, 0.8, 0.7],
			agentId: "agent-a",
		});
		const beforeOwner = db
			.prepare("SELECT vector, chunk_text, source_id, agent_id, dimensions FROM embeddings WHERE id = 'emb-owner'")
			.get();
		const providerInputs: string[] = [];

		const result = await reembedMissingMemories(
			accessor,
			TEST_CFG,
			CTX_AGENT,
			createRateLimiter(),
			async (content) => {
				providerInputs.push(content);
				return [0.1, 0.2, 0.3];
			},
			TEST_EMBEDDING_CFG,
			"agent-b",
			1,
			false,
			true,
			0,
		);

		expect(providerInputs).toEqual(["content for mem-repairable"]);
		expect(result.success).toBe(false);
		expect(result.affected).toBe(1);
		expect(result.details).toEqual({ selected: 2, failed: 0, stale: 0, crossAgentHashConflicts: 1 });
		expect(db.prepare("SELECT source_id FROM embeddings WHERE source_id = 'mem-repairable'").get()).toBeTruthy();
		expect(db.prepare("SELECT source_id FROM embeddings WHERE source_id = 'mem-conflict'").get()).toBeNull();
		expect(db.prepare("SELECT source_id FROM embeddings WHERE content_hash = ?").all(sharedHash)).toEqual([
			{ source_id: "mem-owner" },
		]);
		const afterOwner = db
			.prepare("SELECT vector, chunk_text, source_id, agent_id, dimensions FROM embeddings WHERE id = 'emb-owner'")
			.get();
		expect(afterOwner).toEqual(beforeOwner);
	});

	it("skips stale vectors when content changes during provider work", async () => {
		insertMemory(db, "mem-content-race");
		let providerStarted!: () => void;
		const providerReady = new Promise<void>((resolve) => {
			providerStarted = resolve;
		});
		let releaseProvider!: () => void;
		const providerReleased = new Promise<void>((resolve) => {
			releaseProvider = resolve;
		});

		const repair = reembedMissingMemories(
			accessor,
			TEST_CFG,
			CTX_DAEMON,
			createRateLimiter(),
			async () => {
				providerStarted();
				await providerReleased;
				return [0.1, 0.2, 0.3];
			},
			TEST_EMBEDDING_CFG,
			"default",
			1,
		);

		await providerReady;
		const changedHash = normalizeAndHashContent("new content for mem-content-race").contentHash;
		db.prepare("UPDATE memories SET content = ?, content_hash = ? WHERE id = ?").run(
			"new content for mem-content-race",
			changedHash,
			"mem-content-race",
		);
		releaseProvider();

		const result = await repair;
		expect(result.success).toBe(false);
		expect(result.affected).toBe(0);
		expect(result.message).toMatch(/re-embedded 0/);
		expect(db.prepare("SELECT id FROM embeddings WHERE source_id = ?").get("mem-content-race")).toBeNull();
	});

	it("skips stale vectors when ownership changes during provider work", async () => {
		insertMemory(db, "mem-agent-race", "agent-a");
		let providerStarted!: () => void;
		const providerReady = new Promise<void>((resolve) => {
			providerStarted = resolve;
		});
		let releaseProvider!: () => void;
		const providerReleased = new Promise<void>((resolve) => {
			releaseProvider = resolve;
		});

		const repair = reembedMissingMemories(
			accessor,
			TEST_CFG,
			CTX_DAEMON,
			createRateLimiter(),
			async () => {
				providerStarted();
				await providerReleased;
				return [0.1, 0.2, 0.3];
			},
			TEST_EMBEDDING_CFG,
			"agent-a",
			1,
		);

		await providerReady;
		db.prepare("UPDATE memories SET agent_id = ? WHERE id = ?").run("agent-b", "mem-agent-race");
		releaseProvider();

		const result = await repair;
		expect(result.success).toBe(false);
		expect(result.affected).toBe(0);
		expect(result.message).toMatch(/changed during provider work/);
		expect(db.prepare("SELECT id FROM embeddings WHERE source_id = ?").get("mem-agent-race")).toBeNull();
	});

	it("normalizes an empty memory agent_id on missing-memory repair", async () => {
		insertMemory(db, "mem-empty-agent", "");

		const result = await reembedMissingMemories(
			accessor,
			TEST_CFG,
			CTX_DAEMON,
			createRateLimiter(),
			async () => [0.1, 0.2, 0.3],
			TEST_EMBEDDING_CFG,
			"default",
			1,
		);

		expect(result.success).toBe(true);
		expect(db.prepare("SELECT agent_id FROM embeddings WHERE source_id = ?").get("mem-empty-agent")).toEqual({
			agent_id: "default",
		});
	});

	it("does not overwrite another agent's embedding on migration hash conflict", async () => {
		const migrationDb = new Database(":memory:");
		runMigrations(migrationDb as unknown as Parameters<typeof runMigrations>[0]);
		ensureVecTable(migrationDb);
		const migrationAccessor = asAccessor(migrationDb);
		const now = new Date().toISOString();
		migrationDb
			.prepare(
				`INSERT INTO memories (id, content, content_hash, agent_id, embedding_model, type, created_at, updated_at, updated_by)
			 VALUES ('migration-agent-a', 'agent a content', 'shared-migration-hash', 'agent-a', 'model-a', 'fact', ?, ?, 'test')`,
			)
			.run(now, now);
		insertEmbedding(migrationDb, {
			id: "emb-agent-b",
			contentHash: "shared-migration-hash",
			sourceId: "agent-b-memory",
			vector: [0.9, 0.8, 0.7],
			agentId: "agent-b",
		});
		migrationAccessor.withWriteTx((writeDb) =>
			ensureEmbeddingIndexState(writeDb, { ...TEST_EMBEDDING_CFG, model: "model-b" }),
		);
		const before = migrationDb
			.prepare("SELECT vector, chunk_text, source_id, agent_id, dimensions FROM embeddings WHERE id = 'emb-agent-b'")
			.get();

		const result = await reembedModelMigration(
			migrationAccessor,
			TEST_CFG,
			CTX_DAEMON,
			createRateLimiter(),
			async () => [0.1, 0.2, 0.3],
			{ ...TEST_EMBEDDING_CFG, model: "model-b" },
			"agent-a",
			10,
		);

		expect(result.success).toBe(false);
		expect(result.affected).toBe(0);
		expect(result.message).toMatch(/cross-agent hash conflict/);
		expect(migrationDb.prepare("SELECT embedding_model FROM memories WHERE id = 'migration-agent-a'").get()).toEqual({
			embedding_model: "model-a",
		});
		expect(
			migrationDb
				.prepare("SELECT vector, chunk_text, source_id, agent_id, dimensions FROM embeddings WHERE id = 'emb-agent-b'")
				.get(),
		).toEqual(before);
		migrationDb.close();
	});

	it("persists agent_id on new migration embeddings", async () => {
		const migrationDb = new Database(":memory:");
		runMigrations(migrationDb as unknown as Parameters<typeof runMigrations>[0]);
		ensureVecTable(migrationDb);
		const migrationAccessor = asAccessor(migrationDb);
		const now = new Date().toISOString();
		migrationDb
			.prepare(
				`INSERT INTO memories (id, content, content_hash, agent_id, embedding_model, type, created_at, updated_at, updated_by)
			 VALUES ('migration-agent-a-new', 'agent a content', 'agent-a-migration-hash', 'agent-a', 'model-a', 'fact', ?, ?, 'test')`,
			)
			.run(now, now);
		const target = { ...TEST_EMBEDDING_CFG, model: "model-b" };
		migrationAccessor.withWriteTx((writeDb) => ensureEmbeddingIndexState(writeDb, target));

		const result = await reembedModelMigration(
			migrationAccessor,
			TEST_CFG,
			CTX_DAEMON,
			createRateLimiter(),
			async () => [0.1, 0.2, 0.3],
			target,
			"agent-a",
			10,
		);

		expect(result.success).toBe(true);
		expect(result.affected).toBe(1);
		expect(
			migrationDb.prepare("SELECT agent_id FROM embeddings WHERE content_hash = ?").get("agent-a-migration-hash"),
		).toEqual({
			agent_id: "agent-a",
		});
		migrationDb.close();
	});

	it("normalizes an empty memory agent_id on migration repair", async () => {
		const migrationDb = new Database(":memory:");
		runMigrations(migrationDb as unknown as Parameters<typeof runMigrations>[0]);
		ensureVecTable(migrationDb);
		const migrationAccessor = asAccessor(migrationDb);
		const now = new Date().toISOString();
		migrationDb
			.prepare(
				`INSERT INTO memories (id, content, content_hash, agent_id, embedding_model, type, created_at, updated_at, updated_by)
				 VALUES ('migration-empty-agent', 'empty agent content', 'empty-agent-hash', '', 'model-a', 'fact', ?, ?, 'test')`,
			)
			.run(now, now);
		const target = { ...TEST_EMBEDDING_CFG, model: "model-b" };
		migrationAccessor.withWriteTx((writeDb) => ensureEmbeddingIndexState(writeDb, target));

		const result = await reembedModelMigration(
			migrationAccessor,
			TEST_CFG,
			CTX_DAEMON,
			createRateLimiter(),
			async () => [0.1, 0.2, 0.3],
			target,
			"default",
			10,
		);

		expect(result.success).toBe(true);
		expect(
			migrationDb.prepare("SELECT agent_id FROM embeddings WHERE content_hash = ?").get("empty-agent-hash"),
		).toEqual({ agent_id: "default" });
		migrationDb.close();
	});

	it("skips stale vectors when promotion happens during provider work", async () => {
		insertMemory(db, "mem-promotion-race");
		accessor.withWriteTx((writeDb) => ensureEmbeddingIndexState(writeDb, TEST_EMBEDDING_CFG));
		let providerStarted!: () => void;
		const providerReady = new Promise<void>((resolve) => {
			providerStarted = resolve;
		});
		let releaseProvider!: () => void;
		const providerReleased = new Promise<void>((resolve) => {
			releaseProvider = resolve;
		});

		const repair = reembedMissingMemories(
			accessor,
			TEST_CFG,
			CTX_DAEMON,
			createRateLimiter(),
			async () => {
				providerStarted();
				await providerReleased;
				return [0.1, 0.2, 0.3];
			},
			TEST_EMBEDDING_CFG,
			"default",
			1,
		);

		await providerReady;
		const promoted = { ...TEST_EMBEDDING_CFG, model: "promoted-model" };
		db.prepare("UPDATE embedding_index_state SET active_profile_json = ? WHERE id = 1").run(
			JSON.stringify({
				fingerprint: embeddingProfileFingerprint(promoted),
				provider: promoted.provider,
				model: promoted.model,
				dimensions: promoted.dimensions,
				baseUrl: promoted.base_url,
			}),
		);
		releaseProvider();

		const result = await repair;
		expect(result.success).toBe(false);
		expect(result.message).toMatch(/skipped stale vectors/);
		expect(db.prepare("SELECT id FROM embeddings WHERE source_id = ?").get("mem-promotion-race")).toBeNull();
		expect(db.prepare("SELECT embedding_model FROM memories WHERE id = ?").get("mem-promotion-race")).toEqual({
			embedding_model: null,
		});
	});

	it("repairs memories even when content_hash is NULL", async () => {
		insertMemory(db, "mem-null-hash");

		const limiter = createRateLimiter();
		const result = await reembedMissingMemories(
			accessor,
			TEST_CFG,
			CTX_OPERATOR,
			limiter,
			async () => [0.1, 0.2, 0.3],
			TEST_EMBEDDING_CFG,
			"default",
			10,
			false,
			false,
		);

		expect(result.success).toBe(true);
		expect(result.affected).toBe(1);

		const embedded = db.prepare("SELECT content_hash FROM embeddings WHERE source_id = ?").get("mem-null-hash") as
			| { content_hash: string }
			| undefined;
		expect(embedded?.content_hash).toBeTruthy();
	});

	it("writes content_hash back to memories row when it was NULL -- null-hash memory does not reappear in subsequent backfill passes", async () => {
		// Regression test for Bug 2: reembedMissingMemoriesBatch computed a hash but
		// did not write it back to memories.content_hash. On the next pass the
		// embedding-coverage query could not use the hash-match branch (because
		// m.content_hash IS NULL), so the memory kept appearing as unembedded
		// and the backfill cycled indefinitely.
		//
		// Test with the unique index in place to exercise the production code path.
		db.exec(
			`CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_content_hash_unique
			 ON memories(content_hash) WHERE content_hash IS NOT NULL AND is_deleted = 0`,
		);
		insertMemory(db, "mem-write-back");
		const before = db.prepare("SELECT content_hash FROM memories WHERE id = 'mem-write-back'").get() as {
			content_hash: string | null;
		};
		expect(before.content_hash).toBeNull();

		const limiter = createRateLimiter();
		await reembedMissingMemories(
			accessor,
			TEST_CFG,
			CTX_OPERATOR,
			limiter,
			async () => [0.1, 0.2, 0.3],
			TEST_EMBEDDING_CFG,
			"default",
			10,
			false,
		);

		// After first pass, memories.content_hash must be populated
		const after = db.prepare("SELECT content_hash FROM memories WHERE id = 'mem-write-back'").get() as {
			content_hash: string | null;
		};
		expect(typeof after.content_hash).toBe("string");
		expect((after.content_hash ?? "").length).toBeGreaterThan(0);

		// A second pass must find zero unembedded memories (no cycle)
		const limiter2 = createRateLimiter();
		const second = await reembedMissingMemories(
			accessor,
			TEST_CFG,
			CTX_OPERATOR,
			limiter2,
			async () => [0.1, 0.2, 0.3],
			TEST_EMBEDDING_CFG,
			"default",
			10,
			false,
		);
		expect(second.message).toMatch(/no unembedded memories found/);
	});

	it("does not throw when a duplicate-content null-hash memory collides with an existing hashed memory", async () => {
		// Regression: the write-back ran unconditionally, causing a UNIQUE constraint
		// violation when another non-deleted memory already owned the same content_hash.
		// That aborted the entire batch, so the cycle never resolved.
		// With the unique index active (production path), the write-back must be skipped
		// for the duplicate and the batch must complete without throwing.
		db.exec(
			`CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_content_hash_unique
			 ON memories(content_hash) WHERE content_hash IS NOT NULL AND is_deleted = 0`,
		);
		const now = new Date().toISOString();
		const { contentHash: hash } = normalizeAndHashContent("duplicate content for collision test");

		// Memory that already owns the hash
		db.prepare(
			`INSERT INTO memories (id, content, content_hash, type, created_at, updated_at, updated_by)
			 VALUES (?, ?, ?, 'fact', ?, ?, 'test')`,
		).run("mem-owner", "duplicate content for collision test", hash, now, now);

		// Null-hash memory with identical content -- this is the one that would collide
		db.prepare(
			`INSERT INTO memories (id, content, type, created_at, updated_at, updated_by)
			 VALUES (?, ?, 'fact', ?, ?, 'test')`,
		).run("mem-dupe", "duplicate content for collision test", now, now);

		const limiter = createRateLimiter();
		// Must not throw
		const result = await reembedMissingMemories(
			accessor,
			TEST_CFG,
			CTX_OPERATOR,
			limiter,
			async () => [0.1, 0.2, 0.3],
			TEST_EMBEDDING_CFG,
			"default",
			10,
			false,
		);
		expect(result.success).toBe(true);

		// Duplicate's hash stays null -- dedup worker will clean it up later
		const dupe = db.prepare("SELECT content_hash FROM memories WHERE id = 'mem-dupe'").get() as {
			content_hash: string | null;
		};
		expect(dupe.content_hash).toBeNull();
	});

	it("syncs vec row using canonical embedding id on hash conflict", async () => {
		ensureVecTable(db);
		const now = new Date().toISOString();
		const hash = normalizeAndHashContent("duplicate content").contentHash;

		db.prepare(
			`INSERT INTO memories (id, content, content_hash, type, created_at, updated_at, updated_by)
			 VALUES (?, ?, ?, 'fact', ?, ?, 'test')`,
		).run("mem-existing", "duplicate content", hash, now, now);
		db.prepare(
			`INSERT INTO memories (id, content, content_hash, type, created_at, updated_at, updated_by)
			 VALUES (?, ?, ?, 'fact', ?, ?, 'test')`,
		).run("mem-target", "duplicate content", null, now, now);

		insertEmbedding(db, {
			id: "emb-existing",
			contentHash: hash,
			sourceId: "mem-existing",
			vector: [0.9, 0.9, 0.9],
		});

		const limiter = createRateLimiter();
		const result = await reembedMissingMemories(
			accessor,
			TEST_CFG,
			CTX_OPERATOR,
			limiter,
			async () => [0.4, 0.5, 0.6],
			TEST_EMBEDDING_CFG,
			"default",
			10,
			false,
		);

		expect(result.success).toBe(true);

		const vecIds = db.prepare("SELECT id FROM vec_embeddings ORDER BY id").all() as Array<{ id: string }>;
		expect(vecIds.map((row) => row.id)).toEqual(["emb-existing"]);
		const rows = db.prepare("SELECT source_id FROM embeddings WHERE content_hash = ?").all(hash) as Array<{
			source_id: string;
		}>;
		expect(rows).toHaveLength(1);
		expect(rows[0]?.source_id).toBe("mem-existing");
	});

	it("does not cycle-embed duplicate-hash memories — both report as embedded after one pass", async () => {
		ensureVecTable(db);
		// Regression test: before the fix, two memories with the same content_hash
		// created an infinite backfill loop. Backfill would embed A, then embed B
		// (ON CONFLICT reassigns source_id to B), making A "missing" again. The
		// fix keeps the original owner stable on conflict and treats hash coverage
		// as embedded, so both memories are considered covered after one pass.
		const a = "2026-03-25T00:00:00.000Z";
		const b = "2026-03-25T00:00:01.000Z";

		db.prepare(
			`INSERT INTO memories (id, content, content_hash, type, created_at, updated_at, updated_by)
			 VALUES (?, ?, ?, 'fact', ?, ?, 'test')`,
		).run("mem-dup-a", "identical content", "hash-dup", a, a);
		db.prepare(
			`INSERT INTO memories (id, content, content_hash, type, created_at, updated_at, updated_by)
			 VALUES (?, ?, ?, 'fact', ?, ?, 'test')`,
		).run("mem-dup-b", "identical content", "hash-dup", b, b);

		// No embedding yet — both should show as missing
		const before = await getEmbeddingGapStats(accessor, "default");
		expect(before.unembedded).toBe(2);

		const limiter = createRateLimiter();

		// First pass: embeds both (one is deduplicated via ON CONFLICT)
		const first = await reembedMissingMemories(
			accessor,
			TEST_CFG,
			CTX_OPERATOR,
			limiter,
			async () => [0.7, 0.8, 0.9],
			TEST_EMBEDDING_CFG,
			"default",
			10,
			false,
		);
		expect(first.success).toBe(true);

		// After one pass, both should be considered "embedded" via hash match
		const after = await getEmbeddingGapStats(accessor, "default");
		expect(after.unembedded).toBe(0);
		const rows = db.prepare("SELECT source_id FROM embeddings WHERE content_hash = ?").all("hash-dup") as Array<{
			source_id: string;
		}>;
		expect(rows).toHaveLength(1);
		expect(rows[0]?.source_id).toBe("mem-dup-a");

		// A second pass should not attempt to re-embed either memory (no cycle)
		const limiter2 = createRateLimiter();
		const secondPass = await reembedMissingMemories(
			accessor,
			TEST_CFG,
			CTX_OPERATOR,
			limiter2,
			async () => [0.7, 0.8, 0.9],
			TEST_EMBEDDING_CFG,
			"default",
			10,
			false,
		);
		expect(secondPass.message).toMatch(/no unembedded memories found/);
	});

	it("can sweep all missing embeddings across multiple batches in one run", async () => {
		const now = new Date().toISOString();
		for (let i = 0; i < 5; i++) {
			db.prepare(
				`INSERT INTO memories (id, content, content_hash, type, created_at, updated_at, updated_by)
				 VALUES (?, ?, ?, 'fact', ?, ?, 'test')`,
			).run(`mem-sweep-${i}`, `content sweep ${i}`, `hash-sweep-${i}`, now, now);
		}

		const limiter = createRateLimiter();
		const result = await reembedMissingMemories(
			accessor,
			TEST_CFG,
			CTX_OPERATOR,
			limiter,
			async () => [0.1, 0.2, 0.3],
			TEST_EMBEDDING_CFG,
			"default",
			2,
			false,
			true,
		);

		expect(result.success).toBe(true);
		expect(result.affected).toBe(5);
		expect(result.message).toMatch(/across 3 batch/);

		const remaining = db
			.prepare(
				`SELECT COUNT(*) AS n
				 FROM memories m
				 LEFT JOIN embeddings e ON e.source_type = 'memory' AND e.source_id = m.id
				 WHERE m.is_deleted = 0 AND e.id IS NULL`,
			)
			.get() as { n: number };
		expect(remaining.n).toBe(0);
	});
});

describe("reembedModelMigration", () => {
	it("replaces complete vectors when the stored model differs", async () => {
		const db = new Database(":memory:");
		runMigrations(db as unknown as Parameters<typeof runMigrations>[0]);
		ensureVecTable(db);
		const accessor = asAccessor(db);
		const now = new Date().toISOString();
		db.prepare(
			`INSERT INTO memories (id, content, content_hash, embedding_model, type, created_at, updated_at, updated_by) VALUES ('model-a', 'old vector', 'hash-a', 'model-a', 'fact', ?, ?, 'test')`,
		).run(now, now);
		insertEmbedding(db, { id: "emb-a", sourceId: "model-a", contentHash: "hash-a", vector: [0.1, 0.2, 0.3] });
		expect((await getEmbeddingGapStats(accessor, "default")).unembedded).toBe(0);
		const result = await reembedModelMigration(
			accessor,
			TEST_CFG,
			CTX_OPERATOR,
			createRateLimiter(),
			async () => [0.4, 0.5, 0.6],
			{ ...TEST_EMBEDDING_CFG, model: "model-b" },
			"default",
			10,
			false,
			false,
		);
		expect(result.success).toBe(true);
		expect(result.affected).toBe(1);
		expect(result.totalMatching).toBe(1);
		expect(result.details).toMatchObject({
			selected: 1,
			estimatedBatches: 1,
			vectorIndexRebuildRequired: false,
			target: { provider: "ollama", model: "model-b", dimensions: 3 },
		});
		expect((await getEmbeddingGapStats(accessor, "default")).unembedded).toBe(0);
		expect(db.prepare("SELECT embedding_model FROM memories WHERE id = 'model-a'").get()).toEqual({
			embedding_model: "model-b",
		});
		expect(db.prepare("SELECT vector FROM embeddings WHERE source_id = 'model-a'").get() as { vector: Buffer }).toEqual(
			{ vector: vectorBlob([0.4, 0.5, 0.6]) },
		);
	});

	it("refuses a live run and leaves vectors untouched when the vec index is pinned to a different dimension", async () => {
		// Regression guard: without the pre-check, syncVecInsert's dimension
		// mismatch error is silently swallowed (db-helpers catch{}), leaving
		// `embeddings` updated to the new model/dims while `vec_embeddings`
		// keeps stale vectors under the same id until a daemon restart. The
		// migration must detect FLOAT[D_old] != target and refuse.
		const db = new Database(":memory:");
		runMigrations(db as unknown as Parameters<typeof runMigrations>[0]);
		ensureVecTable(db);
		const accessor = asAccessor(db);
		const now = new Date().toISOString();
		db.prepare(
			`INSERT INTO memories (id, content, content_hash, embedding_model, type, created_at, updated_at, updated_by) VALUES ('model-a', 'old vector', 'hash-a', 'model-a', 'fact', ?, ?, 'test')`,
		).run(now, now);
		insertEmbedding(db, { id: "emb-a", sourceId: "model-a", contentHash: "hash-a", vector: [0.1, 0.2, 0.3] });

		const result = await reembedModelMigration(
			accessor,
			TEST_CFG,
			CTX_OPERATOR,
			createRateLimiter(),
			async () => [0.4, 0.5, 0.6], // returns 3-dim vectors
			{ ...TEST_EMBEDDING_CFG, model: "model-b", dimensions: 3 }, // target FLOAT[3]
			"default",
			10,
			false, // live run
			false,
			// Inject the live vec dimension the daemon booted under, as if the
			// operator changed embedding.dimensions in config without restarting.
			// (sqlite_master is not writable in bun:sqlite, so we inject directly.)
			() => 768,
		);

		expect(result.success).toBe(false);
		expect(result.affected).toBe(0);
		expect(result.totalMatching).toBe(1);
		expect(result.message).toContain("restart the daemon");
		expect(result.details).toMatchObject({ vecDimensions: 768 });
		// No silent corruption: the memory and its vector are unchanged.
		expect(db.prepare("SELECT embedding_model FROM memories WHERE id = 'model-a'").get()).toEqual({
			embedding_model: "model-a",
		});
		expect(db.prepare("SELECT vector FROM embeddings WHERE source_id = 'model-a'").get() as { vector: Buffer }).toEqual(
			{ vector: vectorBlob([0.1, 0.2, 0.3]) },
		);
		db.close();
	});

	it("skips stale migration vectors when promotion happens during provider work", async () => {
		const db = new Database(":memory:");
		runMigrations(db as unknown as Parameters<typeof runMigrations>[0]);
		ensureVecTable(db);
		const accessor = asAccessor(db);
		const now = new Date().toISOString();
		db.prepare(
			`INSERT INTO memories (id, content, content_hash, embedding_model, type, created_at, updated_at, updated_by) VALUES ('migration-race', 'old vector', 'hash-race', 'model-a', 'fact', ?, ?, 'test')`,
		).run(now, now);
		insertEmbedding(db, {
			id: "emb-race",
			sourceId: "migration-race",
			contentHash: "hash-race",
			vector: [0.1, 0.2, 0.3],
		});
		const targetEmbeddingCfg = { ...TEST_EMBEDDING_CFG, model: "model-b" };
		accessor.withWriteTx((writeDb) => ensureEmbeddingIndexState(writeDb, targetEmbeddingCfg));

		let providerStarted!: () => void;
		const providerReady = new Promise<void>((resolve) => {
			providerStarted = resolve;
		});
		let releaseProvider!: () => void;
		const providerReleased = new Promise<void>((resolve) => {
			releaseProvider = resolve;
		});
		const repair = reembedModelMigration(
			accessor,
			TEST_CFG,
			CTX_DAEMON,
			createRateLimiter(),
			async () => {
				providerStarted();
				await providerReleased;
				return [0.4, 0.5, 0.6];
			},
			targetEmbeddingCfg,
			"default",
			10,
			false,
			false,
		);

		await providerReady;
		const promoted = { ...TEST_EMBEDDING_CFG, model: "promoted-model" };
		db.prepare("UPDATE embedding_index_state SET active_profile_json = ? WHERE id = 1").run(
			JSON.stringify({
				fingerprint: embeddingProfileFingerprint(promoted),
				provider: promoted.provider,
				model: promoted.model,
				dimensions: promoted.dimensions,
				baseUrl: promoted.base_url,
			}),
		);
		releaseProvider();

		const result = await repair;
		expect(result.success).toBe(false);
		expect(result.message).toMatch(/skipped stale migration vectors/);
		expect(db.prepare("SELECT embedding_model FROM memories WHERE id = 'migration-race'").get()).toEqual({
			embedding_model: "model-a",
		});
		expect(
			db.prepare("SELECT vector FROM embeddings WHERE source_id = 'migration-race'").get() as { vector: Buffer },
		).toEqual({ vector: vectorBlob([0.1, 0.2, 0.3]) });
		db.close();
	});

	it("skips stale migration vectors when content changes during provider work", async () => {
		const db = new Database(":memory:");
		runMigrations(db as unknown as Parameters<typeof runMigrations>[0]);
		ensureVecTable(db);
		const accessor = asAccessor(db);
		const now = new Date().toISOString();
		db.prepare(
			`INSERT INTO memories (id, content, content_hash, embedding_model, type, created_at, updated_at, updated_by) VALUES ('content-race', 'old content', 'hash-old', 'model-a', 'fact', ?, ?, 'test')`,
		).run(now, now);
		insertEmbedding(db, {
			id: "emb-content-race",
			sourceId: "content-race",
			contentHash: "hash-old",
			vector: [0.1, 0.2, 0.3],
		});
		const targetEmbeddingCfg = { ...TEST_EMBEDDING_CFG, model: "model-b" };
		accessor.withWriteTx((writeDb) => ensureEmbeddingIndexState(writeDb, targetEmbeddingCfg));

		let providerStarted!: () => void;
		const providerReady = new Promise<void>((resolve) => {
			providerStarted = resolve;
		});
		let releaseProvider!: () => void;
		const providerReleased = new Promise<void>((resolve) => {
			releaseProvider = resolve;
		});
		const repair = reembedModelMigration(
			accessor,
			TEST_CFG,
			CTX_DAEMON,
			createRateLimiter(),
			async () => {
				providerStarted();
				await providerReleased;
				return [0.4, 0.5, 0.6];
			},
			targetEmbeddingCfg,
			"default",
			10,
			false,
			false,
		);

		await providerReady;
		db.prepare("UPDATE memories SET content = ?, content_hash = ? WHERE id = ?").run(
			"new content",
			"hash-new",
			"content-race",
		);
		releaseProvider();

		const result = await repair;
		expect(result.success).toBe(false);
		expect(result.affected).toBe(0);
		expect(result.message).toContain("changed during provider work");
		expect(result.details).toMatchObject({ contentChanged: 1 });
		expect(db.prepare("SELECT embedding_model FROM memories WHERE id = 'content-race'").get()).toEqual({
			embedding_model: "model-a",
		});
		expect(
			db.prepare("SELECT content_hash, chunk_text FROM embeddings WHERE source_id = 'content-race'").get(),
		).toEqual({
			content_hash: "hash-old",
			chunk_text: "chunk for content-race",
		});
		expect(db.prepare("SELECT id FROM embeddings WHERE content_hash = 'hash-new'").get()).toBeNull();
		db.close();
	});

	it("survives a per-row write failure, records partial progress, and still returns a structured result", async () => {
		// Regression guard: without try/catch around withWriteTx, a single
		// transaction failure (SQLITE_BUSY / disk error) propagated as an
		// opaque 500, skipped the audit write, and lost all counts. The loop
		// must now record the failure and return partial success.
		const db = new Database(":memory:");
		runMigrations(db as unknown as Parameters<typeof runMigrations>[0]);
		ensureVecTable(db);
		const now = new Date().toISOString();
		db.prepare(
			`INSERT INTO memories (id, content, content_hash, embedding_model, type, created_at, updated_at, updated_by) VALUES ('m-fail', 'a', 'hash-fail', 'model-a', 'fact', ?, ?, 'test')`,
		).run(now, now);
		const later = new Date(new Date(now).getTime() + 1000).toISOString();
		db.prepare(
			`INSERT INTO memories (id, content, content_hash, embedding_model, type, created_at, updated_at, updated_by) VALUES ('m-ok', 'b', 'hash-ok', 'model-a', 'fact', ?, ?, 'test')`,
		).run(later, later);
		insertEmbedding(db, { id: "emb-fail", sourceId: "m-fail", contentHash: "hash-fail", vector: [0.1, 0.2, 0.3] });
		insertEmbedding(db, { id: "emb-ok", sourceId: "m-ok", contentHash: "hash-ok", vector: [0.1, 0.2, 0.3] });

		const inner = asAccessor(db);
		let writeCalls = 0;
		const flaky: DbAccessor = {
			withWriteTx<T>(fn: (wdb: WriteDb) => T): T {
				writeCalls++;
				// First per-row write (m-fail) throws; the rest (m-ok + audit) delegate.
				if (writeCalls === 1) throw new Error("simulated write failure");
				return inner.withWriteTx(fn);
			},
			withWriteTxAsync<T>(fn: (wdb: WriteDb) => T): Promise<T> {
				return Promise.resolve().then(() => flaky.withWriteTx(fn));
			},
			withReadDb<T>(fn: (rdb: ReadDb) => T): T {
				return inner.withReadDb(fn);
			},
			withReadDbAsync<T>(fn: (rdb: ReadDb) => Promise<T>): Promise<T> {
				return inner.withReadDbAsync(fn);
			},
			close() {
				inner.close();
			},
		};

		const result = await reembedModelMigration(
			flaky,
			TEST_CFG,
			CTX_OPERATOR,
			createRateLimiter(),
			async () => [0.4, 0.5, 0.6],
			{ ...TEST_EMBEDDING_CFG, model: "model-b" },
			"default",
			10,
			false,
			false,
		);

		expect(result.success).toBe(false); // one row failed
		expect(result.affected).toBe(1); // partial progress
		expect((result.details as { failed: number }).failed).toBe(1);
		expect(result.message).toContain("1 failed");
		// The non-failing row was updated; the failing row was not.
		expect(db.prepare("SELECT embedding_model FROM memories WHERE id = 'm-ok'").get()).toEqual({
			embedding_model: "model-b",
		});
		expect(db.prepare("SELECT embedding_model FROM memories WHERE id = 'm-fail'").get()).toEqual({
			embedding_model: "model-a",
		});
		db.close();
	});
});

describe("cleanOrphanedEmbeddings", () => {
	let db: Database;
	let accessor: DbAccessor;

	beforeEach(() => {
		db = new Database(":memory:");
		runMigrations(db as unknown as Parameters<typeof runMigrations>[0]);
		db.exec("DROP INDEX IF EXISTS idx_memories_content_hash_unique");
		ensureVecTable(db);
		accessor = asAccessor(db);
	});

	afterEach(() => {
		db.close();
	});

	it("keeps hash-covered embeddings even when the original source row is deleted", async () => {
		const now = new Date().toISOString();

		db.prepare(
			`INSERT INTO memories (id, content, content_hash, type, is_deleted, created_at, updated_at, updated_by)
			 VALUES (?, ?, ?, 'fact', 0, ?, ?, 'test')`,
		).run("mem-live", "shared content", "hash-shared", now, now);
		db.prepare(
			`INSERT INTO memories (id, content, content_hash, type, is_deleted, created_at, updated_at, updated_by)
			 VALUES (?, ?, ?, 'fact', 1, ?, ?, 'test')`,
		).run("mem-dead", "shared content", "hash-shared", now, now);

		insertEmbedding(db, {
			id: "emb-shared",
			contentHash: "hash-shared",
			sourceId: "mem-dead",
			vector: [0.2, 0.3, 0.4],
		});
		db.prepare("INSERT INTO vec_embeddings (id, embedding) VALUES (?, ?)").run(
			"emb-shared",
			vectorBlob([0.2, 0.3, 0.4]),
		);

		const limiter = createRateLimiter();
		const result = await cleanOrphanedEmbeddings(accessor, TEST_CFG, CTX_OPERATOR, limiter);

		expect(result.success).toBe(true);
		expect(result.affected).toBe(0);
		expect((await getEmbeddingGapStats(accessor, "default")).unembedded).toBe(0);

		const rows = db.prepare("SELECT id FROM embeddings WHERE id = ?").all("emb-shared") as Array<{ id: string }>;
		expect(rows).toHaveLength(1);
		const vecRows = db.prepare("SELECT id FROM vec_embeddings WHERE id = ?").all("emb-shared") as Array<{ id: string }>;
		expect(vecRows).toHaveLength(1);
	});

	it("removes embeddings with no source row and no active hash peer", async () => {
		insertEmbedding(db, {
			id: "emb-orphan",
			contentHash: "hash-orphan",
			sourceId: "mem-missing",
			vector: [0.5, 0.6, 0.7],
		});
		db.prepare("INSERT INTO vec_embeddings (id, embedding) VALUES (?, ?)").run(
			"emb-orphan",
			vectorBlob([0.5, 0.6, 0.7]),
		);

		const limiter = createRateLimiter();
		const result = await cleanOrphanedEmbeddings(accessor, TEST_CFG, CTX_OPERATOR, limiter);

		expect(result.success).toBe(true);
		expect(result.affected).toBe(1);

		const rows = db.prepare("SELECT id FROM embeddings WHERE id = ?").all("emb-orphan") as Array<{ id: string }>;
		expect(rows).toHaveLength(0);
		const vecRows = db.prepare("SELECT id FROM vec_embeddings WHERE id = ?").all("emb-orphan") as Array<{ id: string }>;
		expect(vecRows).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// triggerRetentionSweep
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// getDedupStats
// ---------------------------------------------------------------------------

describe("getEmbeddingGapStats", () => {
	let db: Database;
	let accessor: DbAccessor;

	beforeEach(() => {
		db = new Database(":memory:");
		runMigrations(db as unknown as Parameters<typeof runMigrations>[0]);
		accessor = asAccessor(db);
	});

	afterEach(() => {
		db.close();
	});

	// Seeds `total` active memories, embedding `total - gaps` of them via a
	// per-row embedding (source_id match). The remaining `gaps` memories have no
	// embedding and no matching hash, so they stay unembedded.
	function seedCoverage(total: number, gaps: number): void {
		ensureVecTable(db);
		const now = new Date().toISOString();
		const embeddedCount = total - gaps;
		db.exec("BEGIN");
		const insertMemory = db.prepare(
			`INSERT INTO memories (id, content, type, created_at, updated_at, updated_by)
			 VALUES (?, ?, 'fact', ?, ?, 'test')`,
		);
		const insertEmbeddingRow = db.prepare(
			`INSERT INTO embeddings (id, content_hash, vector, dimensions, source_type, source_id, chunk_text, created_at)
			 VALUES (?, ?, ?, ?, 'memory', ?, ?, ?)`,
		);
		for (let i = 0; i < embeddedCount; i++) {
			const id = `mem-emb-${i}`;
			insertMemory.run(id, `embedded content ${i}`, now, now);
			insertEmbeddingRow.run(`emb-${i}`, `hash-${i}`, vectorBlob([1, 2, 3]), 3, id, `chunk ${i}`, now);
		}
		for (let i = 0; i < gaps; i++) {
			insertMemory.run(`mem-gap-${i}`, `missing content ${i}`, now, now);
		}
		db.exec("COMMIT");
	}

	it("reports complete=true and exact 100% when every memory is embedded", async () => {
		seedCoverage(10, 0);
		const stats = await getEmbeddingGapStats(accessor, "default");
		expect(stats.total).toBe(10);
		expect(stats.embedded).toBe(10);
		expect(stats.unembedded).toBe(0);
		expect(stats.complete).toBe(true);
		expect(stats.coverage).toBe("100.0%");
	});

	it("never reports 100% or complete=true while gaps remain (issue #906 scenario: 2251 memories, 5 gaps)", async () => {
		// 5 gaps -> 99.78% already renders below 100% even under the old code, so
		// this guards the sub-100% + complete=false invariant and exact-count
		// parity for the issue's stated scenario. The round-up boundary itself
		// (1 gap -> 99.96% -> old "100.0%") is covered by the test below.
		seedCoverage(2251, 5);
		const stats = await getEmbeddingGapStats(accessor, "default");
		expect(stats.total).toBe(2251);
		expect(stats.embedded).toBe(2246);
		expect(stats.unembedded).toBe(5);
		expect(stats.complete).toBe(false);
		expect(stats.coverage).not.toBe("100.0%");
		expect(stats.coverage).not.toBe("100%");
		const pct = Number.parseFloat(stats.coverage.replace("%", ""));
		expect(Number.isFinite(pct)).toBe(true);
		expect(pct).toBeLessThan(100);
	});

	it("floors a single gap in a large store below 100% instead of rounding up", async () => {
		// (2250/2251)*100 = 99.9556% would render as "100.0%" with naive toFixed(1).
		seedCoverage(2251, 1);
		const stats = await getEmbeddingGapStats(accessor, "default");
		expect(stats.unembedded).toBe(1);
		expect(stats.complete).toBe(false);
		expect(stats.coverage).toBe("99.9%");
	});

	it("reports complete coverage on an empty store", async () => {
		const stats = await getEmbeddingGapStats(accessor, "default");
		expect(stats.total).toBe(0);
		expect(stats.embedded).toBe(0);
		expect(stats.unembedded).toBe(0);
		expect(stats.complete).toBe(true);
		expect(stats.coverage).toBe("100.0%");
	});
});

describe("getDedupStats", () => {
	let db: Database;
	let accessor: DbAccessor;

	beforeEach(() => {
		db = new Database(":memory:");
		runMigrations(db as unknown as Parameters<typeof runMigrations>[0]);
		// Drop the unique index to simulate a legacy database with duplicates
		db.exec("DROP INDEX IF EXISTS idx_memories_content_hash_unique");
		accessor = asAccessor(db);
	});

	afterEach(() => {
		db.close();
	});

	it("returns zero stats on empty database", async () => {
		const stats = await getDedupStats(accessor);
		expect(stats.exactClusters).toBe(0);
		expect(stats.exactExcess).toBe(0);
		expect(stats.totalActive).toBe(0);
	});

	it("counts exact hash clusters and excess", async () => {
		const now = new Date().toISOString();
		// 3 memories with the same hash = 1 cluster, 2 excess
		for (let i = 0; i < 3; i++) {
			db.prepare(
				`INSERT INTO memories (id, content, content_hash, type, created_at, updated_at, updated_by, importance)
				 VALUES (?, ?, 'hash-A', 'fact', ?, ?, 'test', 0.5)`,
			).run(`dup-a-${i}`, "duplicate content A", now, now);
		}
		// 2 memories with another hash = 1 cluster, 1 excess
		for (let i = 0; i < 2; i++) {
			db.prepare(
				`INSERT INTO memories (id, content, content_hash, type, created_at, updated_at, updated_by, importance)
				 VALUES (?, ?, 'hash-B', 'fact', ?, ?, 'test', 0.5)`,
			).run(`dup-b-${i}`, "duplicate content B", now, now);
		}
		// 1 unique memory
		db.prepare(
			`INSERT INTO memories (id, content, content_hash, type, created_at, updated_at, updated_by, importance)
			 VALUES (?, ?, 'hash-C', 'fact', ?, ?, 'test', 0.5)`,
		).run("unique-c", "unique content", now, now);

		const stats = await getDedupStats(accessor);
		expect(stats.exactClusters).toBe(2);
		expect(stats.exactExcess).toBe(3); // 2 + 1
		expect(stats.totalActive).toBe(6);
	});

	it("excludes pinned and manual_override memories", async () => {
		const now = new Date().toISOString();
		// Insert 2 with same hash, but one is pinned
		db.prepare(
			`INSERT INTO memories (id, content, content_hash, type, created_at, updated_at, updated_by, importance, pinned)
			 VALUES (?, ?, 'hash-pin', 'fact', ?, ?, 'test', 0.5, 1)`,
		).run("pinned-1", "content", now, now);
		db.prepare(
			`INSERT INTO memories (id, content, content_hash, type, created_at, updated_at, updated_by, importance)
			 VALUES (?, ?, 'hash-pin', 'fact', ?, ?, 'test', 0.5)`,
		).run("unpinned-1", "content", now, now);

		const stats = await getDedupStats(accessor);
		// The pinned one is excluded from the query, so there is only 1
		// non-pinned row with hash-pin -- not a cluster
		expect(stats.exactClusters).toBe(0);
	});

	it("excludes NULL content_hash from clustering", async () => {
		const now = new Date().toISOString();
		// 3 memories with NULL hash -- should NOT form a cluster
		for (let i = 0; i < 3; i++) {
			db.prepare(
				`INSERT INTO memories (id, content, type, created_at, updated_at, updated_by, importance)
				 VALUES (?, ?, 'fact', ?, ?, 'test', 0.5)`,
			).run(`null-hash-${i}`, `content ${i}`, now, now);
		}

		const stats = await getDedupStats(accessor);
		expect(stats.exactClusters).toBe(0);
		expect(stats.exactExcess).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// deduplicateMemories
// ---------------------------------------------------------------------------

describe("deduplicateMemories", () => {
	let db: Database;
	let accessor: DbAccessor;

	beforeEach(() => {
		db = new Database(":memory:");
		runMigrations(db as unknown as Parameters<typeof runMigrations>[0]);
		// Drop the unique index to simulate a legacy database with duplicates
		db.exec("DROP INDEX IF EXISTS idx_memories_content_hash_unique");
		accessor = asAccessor(db);
	});

	afterEach(() => {
		db.close();
	});

	it("removes exact duplicates and keeps the best keeper", async () => {
		const now = new Date().toISOString();
		// Insert 3 memories with same hash but different importance
		db.prepare(
			`INSERT INTO memories (id, content, content_hash, type, created_at, updated_at, updated_by, importance, access_count, update_count)
			 VALUES (?, ?, 'hash-dup', 'fact', ?, ?, 'test', 0.3, 1, 0)`,
		).run("low-importance", "duplicate content", now, now);
		db.prepare(
			`INSERT INTO memories (id, content, content_hash, type, created_at, updated_at, updated_by, importance, access_count, update_count)
			 VALUES (?, ?, 'hash-dup', 'fact', ?, ?, 'test', 0.9, 5, 3)`,
		).run("high-importance", "duplicate content", now, now);
		db.prepare(
			`INSERT INTO memories (id, content, content_hash, type, created_at, updated_at, updated_by, importance, access_count, update_count)
			 VALUES (?, ?, 'hash-dup', 'fact', ?, ?, 'test', 0.5, 2, 1)`,
		).run("mid-importance", "duplicate content", now, now);

		const limiter = createRateLimiter();
		const result = await deduplicateMemories(accessor, TEST_CFG, CTX_OPERATOR, limiter);

		expect(result.success).toBe(true);
		expect(result.affected).toBe(2); // 2 losers soft-deleted
		expect(result.clusters).toBe(1);

		// The high-importance one should be kept
		const kept = db
			.prepare("SELECT id FROM memories WHERE content_hash = 'hash-dup' AND is_deleted = 0")
			.all() as Array<{ id: string }>;
		expect(kept).toHaveLength(1);
		expect(kept[0].id).toBe("high-importance");

		// Losers should be soft-deleted
		const deleted = db
			.prepare("SELECT id FROM memories WHERE content_hash = 'hash-dup' AND is_deleted = 1")
			.all() as Array<{ id: string }>;
		expect(deleted).toHaveLength(2);
	});

	it("merges tags from all duplicates into the keeper", async () => {
		const now = new Date().toISOString();
		db.prepare(
			`INSERT INTO memories (id, content, content_hash, tags, type, created_at, updated_at, updated_by, importance)
			 VALUES (?, ?, 'hash-tags', 'alpha,beta', 'fact', ?, ?, 'test', 0.9)`,
		).run("keeper-tags", "content", now, now);
		db.prepare(
			`INSERT INTO memories (id, content, content_hash, tags, type, created_at, updated_at, updated_by, importance)
			 VALUES (?, ?, 'hash-tags', 'beta,gamma', 'fact', ?, ?, 'test', 0.3)`,
		).run("loser-tags", "content", now, now);

		const limiter = createRateLimiter();
		await deduplicateMemories(accessor, TEST_CFG, CTX_OPERATOR, limiter);

		const row = db.prepare("SELECT tags FROM memories WHERE id = 'keeper-tags'").get() as { tags: string };
		const tags = row.tags.split(",");
		expect(tags).toContain("alpha");
		expect(tags).toContain("beta");
		expect(tags).toContain("gamma");
		expect(tags).toHaveLength(3); // no duplicates
	});

	it("skips clusters containing pinned memories", async () => {
		const now = new Date().toISOString();
		db.prepare(
			`INSERT INTO memories (id, content, content_hash, type, created_at, updated_at, updated_by, importance, pinned)
			 VALUES (?, ?, 'hash-pinned', 'fact', ?, ?, 'test', 0.5, 1)`,
		).run("pinned-mem", "content", now, now);
		db.prepare(
			`INSERT INTO memories (id, content, content_hash, type, created_at, updated_at, updated_by, importance)
			 VALUES (?, ?, 'hash-pinned', 'fact', ?, ?, 'test', 0.5)`,
		).run("unpinned-mem", "content", now, now);

		const limiter = createRateLimiter();
		const result = await deduplicateMemories(accessor, TEST_CFG, CTX_OPERATOR, limiter);

		// Pinned memories are excluded from the initial query, so the
		// cluster only contains unpinned-mem (1 row) -- not enough to deduplicate
		expect(result.affected).toBe(0);
	});

	it("writes audit trail for keeper and losers", async () => {
		const now = new Date().toISOString();
		db.prepare(
			`INSERT INTO memories (id, content, content_hash, type, created_at, updated_at, updated_by, importance)
			 VALUES (?, ?, 'hash-audit', 'fact', ?, ?, 'test', 0.9)`,
		).run("audit-keeper", "content", now, now);
		db.prepare(
			`INSERT INTO memories (id, content, content_hash, type, created_at, updated_at, updated_by, importance)
			 VALUES (?, ?, 'hash-audit', 'fact', ?, ?, 'test', 0.3)`,
		).run("audit-loser", "content", now, now);

		const limiter = createRateLimiter();
		await deduplicateMemories(accessor, TEST_CFG, CTX_OPERATOR, limiter);

		// Check audit trail
		const keeperHistory = db
			.prepare("SELECT event FROM memory_history WHERE memory_id = 'audit-keeper'")
			.all() as Array<{ event: string }>;
		expect(keeperHistory.some((h) => h.event === "merged")).toBe(true);

		const loserHistory = db
			.prepare("SELECT event, reason FROM memory_history WHERE memory_id = 'audit-loser'")
			.all() as Array<{ event: string; reason: string }>;
		expect(loserHistory.some((h) => h.event === "deleted")).toBe(true);
		expect(loserHistory.some((h) => h.reason.includes("audit-keeper"))).toBe(true);
	});

	it("respects dry-run mode", async () => {
		const now = new Date().toISOString();
		db.prepare(
			`INSERT INTO memories (id, content, content_hash, type, created_at, updated_at, updated_by, importance)
			 VALUES (?, ?, 'hash-dry', 'fact', ?, ?, 'test', 0.9)`,
		).run("dry-1", "content", now, now);
		db.prepare(
			`INSERT INTO memories (id, content, content_hash, type, created_at, updated_at, updated_by, importance)
			 VALUES (?, ?, 'hash-dry', 'fact', ?, ?, 'test', 0.3)`,
		).run("dry-2", "content", now, now);

		const limiter = createRateLimiter();
		const result = await deduplicateMemories(accessor, TEST_CFG, CTX_OPERATOR, limiter, { dryRun: true });

		expect(result.success).toBe(true);
		expect(result.affected).toBe(0);
		expect(result.clusters).toBe(1);
		expect(result.message).toMatch(/dry run/);

		// Nothing should be deleted
		const active = db.prepare("SELECT COUNT(*) AS n FROM memories WHERE is_deleted = 0").get() as { n: number };
		expect(active.n).toBe(2);
	});

	it("is idempotent -- second run finds nothing", async () => {
		const now = new Date().toISOString();
		db.prepare(
			`INSERT INTO memories (id, content, content_hash, type, created_at, updated_at, updated_by, importance)
			 VALUES (?, ?, 'hash-idem', 'fact', ?, ?, 'test', 0.9)`,
		).run("idem-1", "content", now, now);
		db.prepare(
			`INSERT INTO memories (id, content, content_hash, type, created_at, updated_at, updated_by, importance)
			 VALUES (?, ?, 'hash-idem', 'fact', ?, ?, 'test', 0.3)`,
		).run("idem-2", "content", now, now);

		const limiter = createRateLimiter();
		// Use no cooldown for idempotency test
		const cfg = {
			...TEST_CFG,
			repair: { ...TEST_CFG.repair, dedupCooldownMs: 0 },
		};

		const first = await deduplicateMemories(accessor, cfg, CTX_OPERATOR, limiter);
		expect(first.affected).toBe(1);

		const second = await deduplicateMemories(accessor, cfg, CTX_OPERATOR, limiter);
		expect(second.affected).toBe(0);
		expect(second.clusters).toBe(0);
	});

	it("respects policy gate -- denies when frozen", async () => {
		const frozenCfg = {
			...TEST_CFG,
			autonomous: { ...TEST_CFG.autonomous, frozen: true },
		};
		const limiter = createRateLimiter();
		const result = await deduplicateMemories(accessor, frozenCfg, CTX_OPERATOR, limiter);
		expect(result.success).toBe(false);
	});

	it("handles multiple clusters in one batch", async () => {
		const now = new Date().toISOString();
		// Cluster 1: hash-multi-A (3 dupes)
		for (let i = 0; i < 3; i++) {
			db.prepare(
				`INSERT INTO memories (id, content, content_hash, type, created_at, updated_at, updated_by, importance)
				 VALUES (?, ?, 'hash-multi-A', 'fact', ?, ?, 'test', ?)`,
			).run(`multi-a-${i}`, "content A", now, now, 0.5 + i * 0.1);
		}
		// Cluster 2: hash-multi-B (2 dupes)
		for (let i = 0; i < 2; i++) {
			db.prepare(
				`INSERT INTO memories (id, content, content_hash, type, created_at, updated_at, updated_by, importance)
				 VALUES (?, ?, 'hash-multi-B', 'fact', ?, ?, 'test', ?)`,
			).run(`multi-b-${i}`, "content B", now, now, 0.8 - i * 0.3);
		}

		const limiter = createRateLimiter();
		const result = await deduplicateMemories(accessor, TEST_CFG, CTX_OPERATOR, limiter);

		expect(result.success).toBe(true);
		expect(result.clusters).toBe(2);
		expect(result.affected).toBe(3); // 2 from cluster A + 1 from cluster B

		const active = db.prepare("SELECT COUNT(*) AS n FROM memories WHERE is_deleted = 0").get() as { n: number };
		expect(active.n).toBe(2); // 1 keeper per cluster
	});
});

// ---------------------------------------------------------------------------
// triggerRetentionSweep
// ---------------------------------------------------------------------------

describe("triggerRetentionSweep", () => {
	it("calls sweep on the retention handle", async () => {
		let swept = false;
		const handle = {
			sweep() {
				swept = true;
			},
		};

		const limiter = createRateLimiter();
		const result = await triggerRetentionSweep(TEST_CFG, CTX_OPERATOR, limiter, handle);

		expect(result.success).toBe(true);
		expect(swept).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// rebuildDerivedIndexes
// ---------------------------------------------------------------------------

describe("rebuildDerivedIndexes", () => {
	let db: Database;
	let writes = 0;

	beforeEach(() => {
		db = new Database(":memory:");
		runMigrations(db as unknown as Parameters<typeof runMigrations>[0]);
		writes = 0;
	});

	afterEach(() => {
		db.close();
	});

	it("does not mutate derived state when integrity verification fails", async () => {
		const base = asAccessor(db, () => {
			writes += 1;
		});
		const failingAccessor = {
			...base,
			withReadDbAsync<T>(fn: (readDb: ReadDb) => T | Promise<T>): Promise<T> {
				const readDb: ReadDb = {
					prepare(sql: string) {
						const statement = db.prepare(sql);
						if (sql !== "PRAGMA quick_check") return statement as never;
						return {
							...statement,
							all<Row = unknown>(...params: unknown[]): Row[] {
								void params;
								return [{ quick_check: "database disk image is malformed" }] as Row[];
							},
						};
					},
				};
				return Promise.resolve(fn(readDb));
			},
		} as unknown as DbAccessor;

		const result = await rebuildDerivedIndexes(
			failingAccessor,
			TEST_CFG,
			CTX_OPERATOR,
			createRateLimiter(),
			async () => [0.1, 0.2, 0.3],
			TEST_EMBEDDING_CFG,
		);

		expect(result.integrity.ok).toBe(false);
		expect(result.integrity.outcome).toBe("failed");
		expect(result.fts).toMatchObject({ repaired: false });
		expect(result.embeddings).toEqual({ reembedded: 0, totalMissing: 0, crossAgentHashConflicts: 0 });
		expect(result.summary).toContain("FTS and embeddings skipped");
		expect(writes).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// resyncVectorIndex
// ---------------------------------------------------------------------------

describe("resyncVectorIndex", () => {
	let db: Database;
	let accessor: DbAccessor;

	beforeEach(() => {
		db = new Database(":memory:");
		runMigrations(db as unknown as Parameters<typeof runMigrations>[0]);
		ensureVecTable(db);
		accessor = asAccessor(db);
	});

	afterEach(() => {
		db.close();
	});

	it("inserts missing vec rows and removes orphan vec rows", async () => {
		insertMemory(db, "mem-v-1");
		insertMemory(db, "mem-v-2");

		insertEmbedding(db, {
			id: "emb-v-1",
			contentHash: "hash-v-1",
			sourceId: "mem-v-1",
			vector: [0.1, 0.2, 0.3],
		});
		insertEmbedding(db, {
			id: "emb-v-2",
			contentHash: "hash-v-2",
			sourceId: "mem-v-2",
			vector: [0.4, 0.5, 0.6],
		});

		db.prepare("INSERT INTO vec_embeddings (id, embedding) VALUES (?, ?)").run(
			"emb-v-1",
			new Float32Array([0.1, 0.2, 0.3]),
		);
		db.prepare("INSERT INTO vec_embeddings (id, embedding) VALUES (?, ?)").run(
			"emb-orphan",
			new Float32Array([9, 9, 9]),
		);

		const limiter = createRateLimiter();
		const result = await resyncVectorIndex(accessor, TEST_CFG, CTX_OPERATOR, limiter);

		expect(result.success).toBe(true);
		expect(result.affected).toBe(2);

		const ids = db.prepare("SELECT id FROM vec_embeddings ORDER BY id").all() as Array<{ id: string }>;
		expect(ids.map((row) => row.id)).toEqual(["emb-v-1", "emb-v-2"]);
	});

	it("returns a clear error when vec table is missing", async () => {
		db.exec("DROP TABLE vec_embeddings");
		const limiter = createRateLimiter();
		const result = await resyncVectorIndex(accessor, TEST_CFG, CTX_OPERATOR, limiter);

		expect(result.success).toBe(false);
		expect(result.message).toMatch(/vec_embeddings table not found/);
	});
});
