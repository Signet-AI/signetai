import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { runMigrations } from "../../../core/src/migrations";
import type { DbAccessor, ReadDb, WriteDb } from "../db-accessor";
import { createProviderTracker } from "../diagnostics";
import { DEFAULT_PIPELINE_V2 } from "../memory-config";
import type { PipelineV2Config } from "../memory-config";
import { startMaintenanceWorker } from "./maintenance-worker";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function freshDb(): Database {
	const db = new Database(":memory:");
	runMigrations(db as unknown as Parameters<typeof runMigrations>[0]);
	return db;
}

function asAccessor(db: Database): DbAccessor {
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
		withReadDb<T>(fn: (rdb: ReadDb) => T): T {
			return fn(db as unknown as ReadDb);
		},
		close() {
			db.close();
		},
	};
}

const BASE_CFG: PipelineV2Config = {
	...DEFAULT_PIPELINE_V2,
	shadowMode: false,
	mutationsFrozen: false,
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
		maintenanceMode: "execute",
	},
	repair: {
		...DEFAULT_PIPELINE_V2.repair,
		requeueCooldownMs: 0, // no cooldown for tests
		requeueHourlyBudget: 1000,
	},
};

const now = new Date().toISOString();

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("maintenance-worker", () => {
	it("returns healthy report on empty database", async () => {
		const db = freshDb();
		const accessor = asAccessor(db);
		const tracker = createProviderTracker();
		const handle = startMaintenanceWorker(accessor, BASE_CFG, tracker, null);
		handle.stop();

		const result = await handle.tick();
		expect(result.report.composite.status).toBe("healthy");
		expect(result.recommendations).toHaveLength(0);
		expect(result.executed).toHaveLength(0);
		db.close();
	});

	it("recommends requeueDeadJobs when dead rate is high", async () => {
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

		const handle = startMaintenanceWorker(accessor, BASE_CFG, tracker, null);
		handle.stop();

		const result = await handle.tick();
		const actions = result.recommendations.map((r) => r.action);
		expect(actions).toContain("requeueDeadJobs");
		db.close();
	});

	it("executes repairs in execute mode", async () => {
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

		const handle = startMaintenanceWorker(accessor, BASE_CFG, tracker, null);
		handle.stop();

		const result = await handle.tick();
		expect(result.executed.length).toBeGreaterThan(0);

		// Dead jobs should be requeued
		const deadCount = (db.prepare("SELECT COUNT(*) as n FROM memory_jobs WHERE status = 'dead'").get() as { n: number })
			.n;
		expect(deadCount).toBe(0);
		db.close();
	});

	it("only logs recommendations in observe mode", async () => {
		const db = freshDb();
		const accessor = asAccessor(db);
		const tracker = createProviderTracker();
		const observeCfg: PipelineV2Config = {
			...BASE_CFG,
			autonomous: { ...BASE_CFG.autonomous, maintenanceMode: "observe" },
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

		const handle = startMaintenanceWorker(accessor, observeCfg, tracker, null);
		handle.stop();

		const result = await handle.tick();
		expect(result.recommendations.length).toBeGreaterThan(0);
		expect(result.executed).toHaveLength(0);

		// Dead jobs still dead
		const deadCount = (db.prepare("SELECT COUNT(*) as n FROM memory_jobs WHERE status = 'dead'").get() as { n: number })
			.n;
		expect(deadCount).toBe(3);
		db.close();
	});

	it("does not start interval when autonomous is disabled", async () => {
		const db = freshDb();
		const accessor = asAccessor(db);
		const tracker = createProviderTracker();
		const disabledCfg: PipelineV2Config = {
			...BASE_CFG,
			autonomous: { ...BASE_CFG.autonomous, enabled: false },
		};

		const handle = startMaintenanceWorker(accessor, disabledCfg, tracker, null);

		// tick() still works for manual invocation
		const result = await handle.tick();
		expect(result.report.composite.status).toBe("healthy");

		handle.stop();
		db.close();
	});

	it("coalesces ticks while a maintenance cycle is still pending", async () => {
		const db = freshDb();
		const accessor = asAccessor(db);
		const tracker = createProviderTracker();

		// A recommendation makes doTick await the repair execution, leaving
		// the first cycle pending at the point where the second tick is called.
		for (let i = 0; i < 2; i++) {
			db.prepare(
				`INSERT INTO memory_jobs (id, memory_id, job_type, status, attempts, max_attempts, failed_at, created_at, updated_at)
				 VALUES (?, ?, 'repair', 'dead', 3, 3, ?, ?, ?)`,
			).run(`dead-single-flight-${i}`, `mem-single-flight-${i}`, now, now, now);
		}
		db.prepare(
			`INSERT INTO memory_jobs (id, memory_id, job_type, status, attempts, max_attempts, completed_at, created_at, updated_at)
			 VALUES (?, ?, 'extract', 'completed', 1, 3, ?, ?, ?)`,
		).run("comp-single-flight", "mem-comp-single-flight", now, now, now);

		const handle = startMaintenanceWorker(accessor, BASE_CFG, tracker, null);
		handle.stop();

		const first = handle.tick();
		const second = handle.tick();

		// The same promise proves the second dispatch coalesced rather than
		// entering a second maintenance cycle concurrently.
		expect(second).toBe(first);
		await first;
		db.close();
	});

	it("recommends releaseStaleLeases for stuck leased jobs", async () => {
		const db = freshDb();
		const accessor = asAccessor(db);
		const tracker = createProviderTracker();

		// Job leased 20 minutes ago (past 10min anomaly threshold)
		const oldLease = new Date(Date.now() - 20 * 60 * 1000).toISOString();
		db.prepare(
			`INSERT INTO memory_jobs (id, memory_id, job_type, status, attempts, max_attempts, leased_at, created_at, updated_at)
			 VALUES (?, ?, 'extract', 'leased', 1, 3, ?, ?, ?)`,
		).run("stale-lease-1", "mem-stale-1", oldLease, oldLease, now);

		const handle = startMaintenanceWorker(accessor, BASE_CFG, tracker, null);
		handle.stop();

		const result = await handle.tick();
		const actions = result.recommendations.map((r) => r.action);
		expect(actions).toContain("releaseStaleLeases");
		db.close();
	});

	it("calls retention sweep when tombstone ratio is high", async () => {
		const db = freshDb();
		const accessor = asAccessor(db);
		const tracker = createProviderTracker();

		// 10 memories, 5 deleted (50% ratio > 30% threshold)
		for (let i = 0; i < 10; i++) {
			const isDeleted = i < 5 ? 1 : 0;
			db.prepare(
				`INSERT INTO memories (id, type, content, confidence, tags, created_at, updated_at, updated_by, version, manual_override, is_deleted, deleted_at)
				 VALUES (?, 'fact', ?, 0.9, '[]', ?, ?, 'test', 1, 0, ?, ?)`,
			).run(`mem-tomb-${i}`, `content ${i}`, now, now, isDeleted, isDeleted ? now : null);
		}

		let sweepCalled = false;
		const mockRetention = {
			sweep() {
				sweepCalled = true;
			},
		};

		const handle = startMaintenanceWorker(accessor, BASE_CFG, tracker, mockRetention);
		handle.stop();

		const result = await handle.tick();
		const actions = result.recommendations.map((r) => r.action);
		expect(actions).toContain("triggerRetentionSweep");
		expect(sweepCalled).toBe(true);
		db.close();
	});

	it("does not abort the cycle when the inference provider is not initialised", async () => {
		// Regression: a maintenance execute-cycle must remain best-effort when
		// no LLM provider resolver is wired up (e.g. mid-boot). The summary-
		// condensation block in the execute path calls getLlmProvider()
		// unguarded; a thrown error there must be caught and never abort the
		// full cycle (retention, dedup, dead-memory scan, feedback telemetry).
		const db = freshDb();
		const accessor = asAccessor(db);
		const tracker = createProviderTracker();

		// Dead jobs → non-empty recommendations → exercises the execute branch
		// where the summary-condensation block runs after repairs.
		for (let i = 0; i < 2; i++) {
			db.prepare(
				`INSERT INTO memory_jobs (id, memory_id, job_type, status, attempts, max_attempts, failed_at, created_at, updated_at)
				 VALUES (?, ?, 'extract', 'dead', 3, 3, ?, ?, ?)`,
			).run(`dead-noprovider-${i}`, `mem-noprovider-${i}`, now, now, now);
		}

		const handle = startMaintenanceWorker(accessor, BASE_CFG, tracker, null);
		handle.stop();

		// No initInferenceProviderResolver() call — emulates a boot where the
		// provider is not yet wired up. tick() must resolve, not reject.
		const result = await handle.tick();
		expect(result.recommendations.length).toBeGreaterThan(0);
		expect(result.executed.length).toBeGreaterThan(0);
		db.close();
	});

	it("Dreaming-enabled maintenance cycle does not directly supersede semantic rows", async () => {
		// Regression (#946): the maintenance worker previously invoked a direct
		// retroactive supersession sweep that mutated entity_attributes status
		// outside the audited Dreaming apply path. After the cutover, semantic
		// supersession must flow through Dreaming's audited apply only. A
		// maintenance cycle — even with graph + feedback enabled (the branch
		// where the sweep used to run) — must leave contradicting sibling
		// attributes untouched.
		const db = freshDb();
		const accessor = asAccessor(db);
		const tracker = createProviderTracker();

		// Entity + aspect
		db.prepare(
			`INSERT INTO entities (id, name, entity_type, canonical_name, mentions, agent_id, created_at, updated_at)
			 VALUES ('entity-supersede', 'User', 'person', 'user', 2, 'default', ?, ?)`,
		).run(now, now);
		db.prepare(
			`INSERT INTO entity_aspects (id, entity_id, agent_id, name, canonical_name, weight, created_at, updated_at)
			 VALUES ('aspect-editor', 'entity-supersede', 'default', 'editor', 'editor', 0.5, ?, ?)`,
		).run(now, now);

		// Two contradicting siblings that the retired sweep *would* have
		// flagged (value conflict on shared verb "prefers").
		db.prepare(
			`INSERT INTO memories (id, content, type, updated_by, created_at, updated_at, is_deleted)
			 VALUES ('mem-vim', 'prefers vim', 'fact', 'test', ?, ?, 0)`,
		).run(now, now);
		db.prepare(
			`INSERT INTO memories (id, content, type, updated_by, created_at, updated_at, is_deleted)
			 VALUES ('mem-emacs', 'prefers emacs', 'fact', 'test', ?, ?, 0)`,
		).run(now, now);
		db.prepare(
			`INSERT INTO entity_attributes
			 (id, aspect_id, agent_id, memory_id, kind, content, normalized_content, confidence, importance, status, created_at, updated_at)
			 VALUES ('attr-vim', 'aspect-editor', 'default', 'mem-vim', 'attribute', 'user prefers vim', 'user prefers vim', 1, 0.5, 'active', ?, ?)`,
		).run(now, now);
		db.prepare(
			`INSERT INTO entity_attributes
			 (id, aspect_id, agent_id, memory_id, kind, content, normalized_content, confidence, importance, status, created_at, updated_at)
			 VALUES ('attr-emacs', 'aspect-editor', 'default', 'mem-emacs', 'attribute', 'user prefers emacs', 'user prefers emacs', 1, 0.5, 'active', ?, ?)`,
		).run(now, now);

		// Config mirroring the Dreaming-enabled defaults: graph + feedback on.
		// Empty recommendations forces the graph/feedback block (where the
		// sweep used to run) to execute.
		const dreamingCfg: PipelineV2Config = {
			...BASE_CFG,
		};

		const handle = startMaintenanceWorker(accessor, dreamingCfg, tracker, null);
		handle.stop();

		const result = await handle.tick();
		// Healthy (no recommendations) → the graph/feedback branch ran.
		expect(result.recommendations).toHaveLength(0);

		// Neither contradicting sibling may be superseded by the cycle.
		const statuses = db
			.prepare(`SELECT id, status, superseded_by FROM entity_attributes WHERE aspect_id = 'aspect-editor' ORDER BY id`)
			.all() as Array<{ id: string; status: string; superseded_by: string | null }>;
		for (const row of statuses) {
			expect(row.status).toBe("active");
			expect(row.superseded_by).toBeNull();
		}
		db.close();
	});
});
