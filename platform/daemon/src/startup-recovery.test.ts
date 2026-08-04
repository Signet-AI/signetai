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
import type { ReadDb, WriteDb } from "./db-accessor";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "./db-accessor";
import { runStartupRecovery } from "./startup-recovery";

const dbFiles = ["memories.db", "memories.db-shm", "memories.db-wal"];
let agentsDir = "";

function resetDbFiles(): void {
	for (const file of dbFiles) rmSync(join(agentsDir, "memory", file), { force: true });
}

function seedTables(db: WriteDb): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS memory_jobs (
			id TEXT PRIMARY KEY, job_type TEXT, status TEXT,
			memory_id TEXT, created_at TEXT, updated_at TEXT,
			attempts INTEGER DEFAULT 0, max_attempts INTEGER DEFAULT 5
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

function insertPass(db: WriteDb, id: string, status: string): void {
	db.prepare(
		"INSERT INTO dreaming_passes (id, agent_id, status, started_at) VALUES (?, 'default', ?, datetime('now'))",
	).run(id, status);
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

		const report = runStartupRecovery(getDbAccessor());

		expect(report.deadJobsPurged).toBe(2);
		expect(countRows("memory_jobs")).toBe(2); // dead-recent + pending-1
	});

	it("deletes redundant staging rows but keeps genuinely new ones", async () => {
		getDbAccessor().withWriteTx((db) => {
			// Row promoted to embeddings AND still in staging (redundant)
			insertEmbedding(db, "emb-1", "hash-A", "embeddings");
			insertEmbedding(db, "stage-1", "hash-A", "embeddings_staging");
			// Row only in staging (genuinely new — keep)
			insertEmbedding(db, "stage-2", "hash-B", "embeddings_staging");
		});

		const report = runStartupRecovery(getDbAccessor());

		expect(report.stagingRowsCleaned).toBe(1);
		expect(countRows("embeddings_staging")).toBe(1); // only the new row remains
	});

	it("sweeps orphaned dreaming passes left by a crash", async () => {
		getDbAccessor().withWriteTx((db) => {
			insertPass(db, "running-1", "running");
			insertPass(db, "running-2", "running");
			insertPass(db, "completed-1", "completed");
		});

		const report = runStartupRecovery(getDbAccessor());

		expect(report.orphanedPassesSwept).toBe(2);
		const failedCount = getDbAccessor().withReadDb(
			(db) =>
				(db.prepare("SELECT COUNT(*) AS n FROM dreaming_passes WHERE status = 'failed'").get() as { n: number }).n,
		);
		expect(failedCount).toBe(2);
	});

	it("is idempotent — a clean workspace cleans nothing", async () => {
		// Run recovery on a fresh workspace with no damage.
		const report1 = runStartupRecovery(getDbAccessor());
		expect(report1.deadJobsPurged).toBe(0);
		expect(report1.stagingRowsCleaned).toBe(0);
		expect(report1.orphanedPassesSwept).toBe(0);

		// Run again — still nothing.
		const report2 = runStartupRecovery(getDbAccessor());
		expect(report2.deadJobsPurged).toBe(0);
		expect(report2.stagingRowsCleaned).toBe(0);
	});
});
