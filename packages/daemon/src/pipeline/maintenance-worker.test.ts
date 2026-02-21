import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "@signet/core";
import type { DbAccessor } from "../db-accessor";
import type { PipelineV2Config } from "../memory-config";
import { createProviderTracker } from "../diagnostics";
import { startMaintenanceWorker } from "./maintenance-worker";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function freshDb(): Database {
	const db = new Database(":memory:");
	runMigrations(db);
	return db;
}

function asAccessor(db: Database): DbAccessor {
	return {
		withWriteTx<T>(fn: (wdb: unknown) => T): T {
			db.exec("BEGIN IMMEDIATE");
			try {
				const result = fn(db);
				db.exec("COMMIT");
				return result;
			} catch (err) {
				db.exec("ROLLBACK");
				throw err;
			}
		},
		withReadDb<T>(fn: (rdb: unknown) => T): T {
			return fn(db);
		},
		close() {
			db.close();
		},
	};
}

const BASE_CFG: PipelineV2Config = {
	enabled: true,
	shadowMode: false,
	allowUpdateDelete: true,
	graphEnabled: true,
	autonomousEnabled: true,
	mutationsFrozen: false,
	autonomousFrozen: false,
	extractionModel: "test",
	extractionTimeout: 45000,
	workerPollMs: 2000,
	workerMaxRetries: 3,
	leaseTimeoutMs: 300000,
	minFactConfidenceForWrite: 0.7,
	graphBoostWeight: 0.15,
	graphBoostTimeoutMs: 500,
	rerankerEnabled: false,
	rerankerModel: "",
	rerankerTopN: 20,
	rerankerTimeoutMs: 2000,
	maintenanceIntervalMs: 1800000,
	maintenanceMode: "execute",
	repairReembedCooldownMs: 300000,
	repairReembedHourlyBudget: 10,
	repairRequeueCooldownMs: 0, // no cooldown for tests
	repairRequeueHourlyBudget: 1000,
};

const now = new Date().toISOString();

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("maintenance-worker", () => {
	it("returns healthy report on empty database", () => {
		const db = freshDb();
		const accessor = asAccessor(db);
		const tracker = createProviderTracker();
		const handle = startMaintenanceWorker(
			accessor,
			BASE_CFG,
			tracker,
			null,
		);
		handle.stop();

		const result = handle.tick();
		expect(result.report.composite.status).toBe("healthy");
		expect(result.recommendations).toHaveLength(0);
		expect(result.executed).toHaveLength(0);
		db.close();
	});

	it("recommends requeueDeadJobs when dead rate is high", () => {
		const db = freshDb();
		const accessor = asAccessor(db);
		const tracker = createProviderTracker();

		// Insert 10 completed + 5 dead jobs -> dead rate = 33%
		for (let i = 0; i < 10; i++) {
			db.prepare(
				`INSERT INTO memory_jobs (id, memory_id, job_type, status, attempts, max_attempts, completed_at, created_at, updated_at)
				 VALUES (?, ?, 'extract', 'completed', 1, 3, ?, ?, ?)`,
			).run(`comp-${i}`, `mem-${i}`, now, now, now);
		}
		for (let i = 0; i < 5; i++) {
			db.prepare(
				`INSERT INTO memory_jobs (id, memory_id, job_type, status, attempts, max_attempts, failed_at, created_at, updated_at)
				 VALUES (?, ?, 'extract', 'dead', 3, 3, ?, ?, ?)`,
			).run(`dead-${i}`, `mem-dead-${i}`, now, now, now);
		}

		const handle = startMaintenanceWorker(
			accessor,
			BASE_CFG,
			tracker,
			null,
		);
		handle.stop();

		const result = handle.tick();
		const actions = result.recommendations.map((r) => r.action);
		expect(actions).toContain("requeueDeadJobs");
		db.close();
	});

	it("executes repairs in execute mode", () => {
		const db = freshDb();
		const accessor = asAccessor(db);
		const tracker = createProviderTracker();

		// Insert 2 dead jobs + 1 completed to get dead rate > 1%
		for (let i = 0; i < 2; i++) {
			db.prepare(
				`INSERT INTO memory_jobs (id, memory_id, job_type, status, attempts, max_attempts, failed_at, created_at, updated_at)
				 VALUES (?, ?, 'extract', 'dead', 3, 3, ?, ?, ?)`,
			).run(`dead-exec-${i}`, `mem-exec-${i}`, now, now, now);
		}
		db.prepare(
			`INSERT INTO memory_jobs (id, memory_id, job_type, status, attempts, max_attempts, completed_at, created_at, updated_at)
			 VALUES (?, ?, 'extract', 'completed', 1, 3, ?, ?, ?)`,
		).run("comp-exec-1", "mem-comp-1", now, now, now);

		const handle = startMaintenanceWorker(
			accessor,
			BASE_CFG,
			tracker,
			null,
		);
		handle.stop();

		const result = handle.tick();
		expect(result.executed.length).toBeGreaterThan(0);

		// Dead jobs should be requeued
		const deadCount = (
			db
				.prepare("SELECT COUNT(*) as n FROM memory_jobs WHERE status = 'dead'")
				.get() as { n: number }
		).n;
		expect(deadCount).toBe(0);
		db.close();
	});

	it("only logs recommendations in observe mode", () => {
		const db = freshDb();
		const accessor = asAccessor(db);
		const tracker = createProviderTracker();
		const observeCfg: PipelineV2Config = {
			...BASE_CFG,
			maintenanceMode: "observe",
		};

		// Insert dead jobs + 1 completed
		for (let i = 0; i < 3; i++) {
			db.prepare(
				`INSERT INTO memory_jobs (id, memory_id, job_type, status, attempts, max_attempts, failed_at, created_at, updated_at)
				 VALUES (?, ?, 'extract', 'dead', 3, 3, ?, ?, ?)`,
			).run(`dead-obs-${i}`, `mem-obs-${i}`, now, now, now);
		}
		db.prepare(
			`INSERT INTO memory_jobs (id, memory_id, job_type, status, attempts, max_attempts, completed_at, created_at, updated_at)
			 VALUES (?, ?, 'extract', 'completed', 1, 3, ?, ?, ?)`,
		).run("comp-obs", "mem-comp-obs", now, now, now);

		const handle = startMaintenanceWorker(
			accessor,
			observeCfg,
			tracker,
			null,
		);
		handle.stop();

		const result = handle.tick();
		expect(result.recommendations.length).toBeGreaterThan(0);
		expect(result.executed).toHaveLength(0);

		// Dead jobs still dead
		const deadCount = (
			db
				.prepare("SELECT COUNT(*) as n FROM memory_jobs WHERE status = 'dead'")
				.get() as { n: number }
		).n;
		expect(deadCount).toBe(3);
		db.close();
	});

	it("does not start interval when autonomous is disabled", () => {
		const db = freshDb();
		const accessor = asAccessor(db);
		const tracker = createProviderTracker();
		const disabledCfg: PipelineV2Config = {
			...BASE_CFG,
			autonomousEnabled: false,
		};

		const handle = startMaintenanceWorker(
			accessor,
			disabledCfg,
			tracker,
			null,
		);

		// tick() still works for manual invocation
		const result = handle.tick();
		expect(result.report.composite.status).toBe("healthy");

		handle.stop();
		db.close();
	});

	it("recommends releaseStaleLeases for stuck leased jobs", () => {
		const db = freshDb();
		const accessor = asAccessor(db);
		const tracker = createProviderTracker();

		// Job leased 20 minutes ago (past 10min anomaly threshold)
		const oldLease = new Date(Date.now() - 20 * 60 * 1000).toISOString();
		db.prepare(
			`INSERT INTO memory_jobs (id, memory_id, job_type, status, attempts, max_attempts, leased_at, created_at, updated_at)
			 VALUES (?, ?, 'extract', 'leased', 1, 3, ?, ?, ?)`,
		).run("stale-lease-1", "mem-stale-1", oldLease, oldLease, now);

		const handle = startMaintenanceWorker(
			accessor,
			BASE_CFG,
			tracker,
			null,
		);
		handle.stop();

		const result = handle.tick();
		const actions = result.recommendations.map((r) => r.action);
		expect(actions).toContain("releaseStaleLeases");
		db.close();
	});

	it("calls retention sweep when tombstone ratio is high", () => {
		const db = freshDb();
		const accessor = asAccessor(db);
		const tracker = createProviderTracker();

		// 10 memories, 5 deleted (50% ratio > 30% threshold)
		for (let i = 0; i < 10; i++) {
			const isDeleted = i < 5 ? 1 : 0;
			db.prepare(
				`INSERT INTO memories (id, type, content, confidence, tags, created_at, updated_at, updated_by, version, manual_override, is_deleted, deleted_at)
				 VALUES (?, 'fact', ?, 0.9, '[]', ?, ?, 'test', 1, 0, ?, ?)`,
			).run(
				`mem-tomb-${i}`,
				`content ${i}`,
				now,
				now,
				isDeleted,
				isDeleted ? now : null,
			);
		}

		let sweepCalled = false;
		const mockRetention = {
			sweep() {
				sweepCalled = true;
			},
		};

		const handle = startMaintenanceWorker(
			accessor,
			BASE_CFG,
			tracker,
			mockRetention,
		);
		handle.stop();

		const result = handle.tick();
		const actions = result.recommendations.map((r) => r.action);
		expect(actions).toContain("triggerRetentionSweep");
		expect(sweepCalled).toBe(true);
		db.close();
	});
});
