/**
 * Tests for startup recovery — automatic crash-loop damage cleanup.
 *
 * Proves: dead jobs purged, redundant staging rows cleaned, genuinely new
 * staging rows preserved, orphaned passes swept, clean workspace untouched.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DreamingConfig } from "@signet/core";
import type { WriteDb } from "./db-accessor";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "./db-accessor";
import { startDreamingWorker } from "./pipeline/dreaming-worker";
import { getStartupRecoveryCompletion, runStartupRecovery, runStartupRecoveryAsync } from "./startup-recovery";

const dbFiles = ["memories.db", "memories.db-shm", "memories.db-wal"];
let agentsDir = "";

function resetDbFiles(): void {
	for (const file of dbFiles) rmSync(join(agentsDir, "memory", file), { force: true });
}

function seedTables(db: WriteDb): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS memory_jobs (
			id TEXT PRIMARY KEY, job_type TEXT, status TEXT,
			memory_id TEXT, document_id TEXT, created_at TEXT, updated_at TEXT,
			attempts INTEGER DEFAULT 0, max_attempts INTEGER DEFAULT 5,
			leased_at TEXT, failed_at TEXT, error TEXT
		);
		CREATE TABLE IF NOT EXISTS documents (
			id TEXT PRIMARY KEY, status TEXT, error TEXT, updated_at TEXT
		);
		CREATE TABLE IF NOT EXISTS embeddings (
			id TEXT PRIMARY KEY, source_type TEXT, source_id TEXT,
			content_hash TEXT, vector BLOB, dimensions INTEGER,
			chunk_text TEXT, created_at TEXT
		);
		CREATE TABLE IF NOT EXISTS embeddings_staging (
			id TEXT PRIMARY KEY, content_hash TEXT, vector BLOB,
			dimensions INTEGER, source_type TEXT, source_id TEXT,
			chunk_text TEXT, created_at TEXT
		);
		CREATE TABLE IF NOT EXISTS dreaming_passes (
			id TEXT PRIMARY KEY, agent_id TEXT, status TEXT,
			started_at TEXT, completed_at TEXT, error TEXT
		);
	`);
}

function insertJob(db: WriteDb, id: string, status: string, createdAt: string): void {
	db.prepare(
		"INSERT INTO memory_jobs (id, job_type, status, memory_id, created_at, updated_at) VALUES (?, 'extract', ?, ?, ?, ?)",
	).run(id, status, id, createdAt, createdAt);
}

function insertEmbedding(db: WriteDb, id: string, hash: string, table: "embeddings" | "embeddings_staging"): void {
	db.prepare(
		`INSERT INTO ${table} (id, source_type, source_id, content_hash, vector, dimensions, chunk_text, created_at)
		 VALUES (?, 'memory', ?, ?, x'00', 768, 'test', datetime('now'))`,
	).run(id, id, hash);
}

function insertPass(db: WriteDb, id: string, status: string, startedAt = "datetime('now', '-1 minute')"): void {
	db.prepare(
		`INSERT INTO dreaming_passes (id, agent_id, status, started_at) VALUES (?, 'default', ?, ${startedAt})`,
	).run(id, status);
}

function dreamingConfig(): DreamingConfig {
	return {
		enabled: true,
		tokenThreshold: 100_000,
		maxInterval: 6 * 60 * 60 * 1_000,
		maxInputTokens: 32_000,
		maxOutputTokens: 16_000,
		timeout: 300_000,
		backfillOnFirstRun: false,
	};
}

function countRows(table: string): number {
	return getDbAccessor().withReadDb(
		(db) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n,
	);
}

describe("runStartupRecovery", () => {
	beforeEach(() => {
		agentsDir = mkdtempSync(join(tmpdir(), "recovery-test-"));
		mkdirSync(join(agentsDir, "memory"), { recursive: true });
		resetDbFiles();
		initDbAccessor(join(agentsDir, "memory", "memories.db"));
		getDbAccessor().withWriteTx(seedTables);
	});

	afterEach(() => {
		closeDbAccessor();
		rmSync(agentsDir, { recursive: true, force: true });
	});

	it("purges dead jobs older than 7 days but keeps recent ones", async () => {
		const old = new Date(Date.now() - 10 * 86_400_000).toISOString();
		const recent = new Date(Date.now() - 1 * 86_400_000).toISOString();

		getDbAccessor().withWriteTx((db) => {
			insertJob(db, "dead-old-1", "dead", old);
			insertJob(db, "dead-old-2", "dead", old);
			insertJob(db, "dead-recent", "dead", recent);
			insertJob(db, "pending-1", "pending", recent);
		});

		const report = await runStartupRecoveryAsync(getDbAccessor());

		expect(report.deadJobsPurged).toBe(2);
		expect(countRows("memory_jobs")).toBe(2); // dead-recent + pending-1
	});

	it("recovers every document lease during startup without touching other job types", async () => {
		const now = Date.now();
		const createdAt = new Date(now - 20 * 60 * 1000).toISOString();
		const staleAt = new Date(now - 10 * 60 * 1000).toISOString();
		const freshAt = new Date(now - 60 * 1000).toISOString();

		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				"INSERT INTO documents (id, source_type, status, created_at, updated_at) VALUES (?, 'test', 'extracting', ?, ?)",
			).run("doc-stale", createdAt, createdAt);
			db.prepare(
				"INSERT INTO documents (id, source_type, status, created_at, updated_at) VALUES (?, 'test', 'extracting', ?, ?)",
			).run("doc-exhausted", createdAt, createdAt);
			db.prepare(
				"INSERT INTO documents (id, source_type, status, created_at, updated_at) VALUES (?, 'test', 'extracting', ?, ?)",
			).run("doc-fresh", createdAt, createdAt);
			db.prepare(
				`INSERT INTO memory_jobs
				 (id, job_type, status, document_id, attempts, max_attempts, leased_at, created_at, updated_at)
				 VALUES (?, 'document_ingest', 'leased', ?, 1, 3, ?, ?, ?)`,
			).run("document-stale", "doc-stale", staleAt, createdAt, staleAt);
			db.prepare(
				`INSERT INTO memory_jobs
				 (id, job_type, status, document_id, attempts, max_attempts, leased_at, created_at, updated_at)
				 VALUES (?, 'document_ingest', 'leased', ?, 3, 3, ?, ?, ?)`,
			).run("document-exhausted", "doc-exhausted", staleAt, createdAt, staleAt);
			db.prepare(
				`INSERT INTO memory_jobs
				 (id, job_type, status, document_id, attempts, max_attempts, leased_at, created_at, updated_at)
				 VALUES (?, 'document_ingest', 'leased', ?, 1, 3, ?, ?, ?)`,
			).run("document-fresh", "doc-fresh", freshAt, createdAt, freshAt);
			db.prepare(
				`INSERT INTO memory_jobs
				 (id, job_type, status, memory_id, attempts, max_attempts, leased_at, created_at, updated_at)
				 VALUES (?, 'prospective_index', 'leased', NULL, 1, 3, ?, ?, ?)`,
			).run("other-stale", staleAt, createdAt, staleAt);
		});

		const report = await runStartupRecoveryAsync(getDbAccessor());

		expect(report.documentLeasesRecovered).toBe(3);
		const statuses = getDbAccessor().withReadDb(
			(db) =>
				db.prepare("SELECT id, status, leased_at FROM memory_jobs ORDER BY id").all() as Array<{
					id: string;
					status: string;
					leased_at: string | null;
				}>,
		);
		expect(statuses).toEqual([
			{ id: "document-exhausted", status: "dead", leased_at: null },
			{ id: "document-fresh", status: "pending", leased_at: null },
			{ id: "document-stale", status: "pending", leased_at: null },
			{ id: "other-stale", status: "leased", leased_at: staleAt },
		]);
		const documents = getDbAccessor().withReadDb(
			(db) =>
				db.prepare("SELECT id, status, error FROM documents ORDER BY id").all() as Array<{
					id: string;
					status: string;
					error: string | null;
				}>,
		);
		expect(documents).toEqual([
			{ id: "doc-exhausted", status: "failed", error: "Document ingest lease expired before completion" },
			{ id: "doc-fresh", status: "extracting", error: null },
			{ id: "doc-stale", status: "extracting", error: null },
		]);
	});

	it("deletes redundant staging rows but keeps genuinely new ones", async () => {
		getDbAccessor().withWriteTx((db) => {
			// Row promoted to embeddings AND still in staging (redundant)
			insertEmbedding(db, "emb-1", "hash-A", "embeddings");
			insertEmbedding(db, "stage-1", "hash-A", "embeddings_staging");
			// Row only in staging (genuinely new — keep)
			insertEmbedding(db, "stage-2", "hash-B", "embeddings_staging");
		});

		const report = await runStartupRecoveryAsync(getDbAccessor());

		expect(report.stagingRowsCleaned).toBe(1);
		expect(countRows("embeddings_staging")).toBe(1); // only the new row remains
	});

	it("sweeps orphaned dreaming passes left by a crash", async () => {
		getDbAccessor().withWriteTx((db) => {
			insertPass(db, "running-1", "running");
			insertPass(db, "running-2", "running");
			insertPass(db, "completed-1", "completed");
		});

		const report = await runStartupRecoveryAsync(getDbAccessor());

		expect(report.orphanedPassesSwept).toBe(2);
		const failedCount = getDbAccessor().withReadDb(
			(db) =>
				(db.prepare("SELECT COUNT(*) AS n FROM dreaming_passes WHERE status = 'failed'").get() as { n: number }).n,
		);
		expect(failedCount).toBe(2);
	});

	it("keeps the immediate report in draining state until orphan telemetry is countable", async () => {
		getDbAccessor().withWriteTx((db) => {
			insertPass(db, "running-draining", "running");
		});

		const immediate = runStartupRecovery(getDbAccessor());
		expect(immediate.recoveryPhase).toBe("draining");
		expect(immediate.orphanedPassesSwept).toBe(0);

		const completed = await getStartupRecoveryCompletion();
		expect(completed.recoveryPhase).toBe("complete");
		expect(completed.orphanedPassesSwept).toBe(1);
	});

	it("keeps orphan telemetry countable when the dreaming worker starts during recovery", async () => {
		getDbAccessor().withWriteTx((db) => {
			insertPass(db, "running-worker-start", "running");
		});

		const immediate = runStartupRecovery(getDbAccessor());
		const worker = startDreamingWorker(getDbAccessor(), dreamingConfig(), agentsDir, "default");
		try {
			expect(immediate.recoveryPhase).toBe("draining");
			const completed = await getStartupRecoveryCompletion();
			expect(completed.recoveryPhase).toBe("complete");
			expect(completed.orphanedPassesSwept).toBe(1);
		} finally {
			worker.stop();
		}
	});

	it("does not fail a live pass created in the recovery cutoff second", async () => {
		getDbAccessor().withWriteTx((db) => {
			insertPass(db, "abandoned-before-recovery", "running");
			for (let index = 0; index < 1_000; index++) {
				const hash = `recovery-race-${index}`;
				insertEmbedding(db, `recovery-emb-${index}`, hash, "embeddings");
				insertEmbedding(db, `recovery-stage-${index}`, hash, "embeddings_staging");
			}
		});

		let livePassInserted = false;
		setTimeout(() => {
			getDbAccessor().withWriteTx((db) => {
				insertPass(db, "live-during-recovery", "running", "datetime('now')");
			});
			livePassInserted = true;
		}, 0);

		const report = await runStartupRecoveryAsync(getDbAccessor());

		expect(livePassInserted).toBe(true);
		expect(report.orphanedPassesSwept).toBe(1);
		const livePass = getDbAccessor().withReadDb(
			(db) =>
				db.prepare("SELECT status FROM dreaming_passes WHERE id = ?").get("live-during-recovery") as { status: string },
		);
		expect(livePass.status).toBe("running");
	});

	it("is idempotent — a clean workspace cleans nothing", async () => {
		// Run recovery on a fresh workspace with no damage.
		const report1 = await runStartupRecoveryAsync(getDbAccessor());
		expect(report1.deadJobsPurged).toBe(0);
		expect(report1.documentLeasesRecovered).toBe(0);
		expect(report1.stagingRowsCleaned).toBe(0);
		expect(report1.orphanedPassesSwept).toBe(0);
		expect(report1.databaseIntegrity.phase).toBe("pending");
		expect(report1.databaseIntegrity.quickCheck.messages).toEqual(["not checked"]);

		// Run again — still nothing.
		const report2 = await runStartupRecoveryAsync(getDbAccessor());
		expect(report2.deadJobsPurged).toBe(0);
		expect(report2.stagingRowsCleaned).toBe(0);
	});

	it("returns before a large staging drain finishes and yields to liveness work", async () => {
		getDbAccessor().withWriteTx((db) => {
			for (let index = 0; index < 1_000; index++) {
				const hash = `backlog-hash-${index}`;
				insertEmbedding(db, `emb-backlog-${index}`, hash, "embeddings");
				insertEmbedding(db, `stage-backlog-${index}`, hash, "embeddings_staging");
			}
		});

		let livenessAnswered = false;
		setTimeout(() => {
			livenessAnswered = true;
		}, 0);
		const immediate = runStartupRecovery(getDbAccessor());

		expect(immediate.databaseIntegrity.phase).toBe("pending");
		const report = await runStartupRecoveryAsync(getDbAccessor());

		expect(livenessAnswered).toBe(true);
		expect(report.stagingRowsCleaned).toBe(1_000);
		expect(countRows("embeddings_staging")).toBe(0);
	});
});
