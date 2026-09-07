import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { runMigrations } from "../../core/src/migrations";
import type { DbAccessor, ReadDb, WriteDb, WriteAdmissionOptions } from "./db-accessor";
import { DEFAULT_PIPELINE_V2 } from "./memory-config";
import {
	acquireRepairAdmissionInTx,
	finishRepairAdmissionInTx,
	repairScopeKey,
	type RepairAdmissionCompletion,
	type RepairAdmissionLease,
	type RepairAdmissionRequest,
	type RepairAdmissionResult,
} from "./repair-admission";
import { createRateLimiter, requeueDeadJobs } from "./repair-actions";

function asAccessor(db: Database): DbAccessor {
	return {
		withReadDb<T>(fn: (readDb: ReadDb) => T): T {
			return fn(db as unknown as ReadDb);
		},
		withReadDbAsync<T>(fn: (readDb: ReadDb) => T | Promise<T>): Promise<T> {
			return Promise.resolve(fn(db as unknown as ReadDb));
		},
		withWriteTx<T>(fn: (writeDb: WriteDb) => T): T {
			db.exec("BEGIN IMMEDIATE");
			try {
				const result = fn(db as unknown as WriteDb);
				db.exec("COMMIT");
				return result;
			} catch (error) {
				db.exec("ROLLBACK");
				throw error;
			}
		},
		withWriteTxAsync<T>(fn: (writeDb: WriteDb) => T): Promise<T> {
			return Promise.resolve(this.withWriteTx(fn));
		},
		close(): void {
			db.close();
		},
	};
}

async function acquire(accessor: DbAccessor, request: RepairAdmissionRequest): Promise<RepairAdmissionResult> {
	return await accessor.withWriteTxAsync((db) => acquireRepairAdmissionInTx(db, request));
}

async function finish(
	accessor: DbAccessor,
	lease: RepairAdmissionLease,
	completion: RepairAdmissionCompletion,
): Promise<boolean> {
	return await accessor.withWriteTxAsync((db) => finishRepairAdmissionInTx(db, lease, completion));
}

function freshDb(): { db: Database; accessor: DbAccessor } {
	const db = new Database(":memory:");
	runMigrations(db as unknown as Parameters<typeof runMigrations>[0]);
	return { db, accessor: asAccessor(db) };
}

const cfg = {
	...DEFAULT_PIPELINE_V2,
	autonomous: { ...DEFAULT_PIPELINE_V2.autonomous, enabled: true, frozen: false },
	repair: { ...DEFAULT_PIPELINE_V2.repair, requeueCooldownMs: 60_000, requeueHourlyBudget: 5 },
};

const operator = { reason: "operator repair", actor: "operator", actorType: "operator" as const };
const daemon = { reason: "maintenance", actor: "maintenance-worker", actorType: "daemon" as const };
const agent = { reason: "agent repair", actor: "agent-a", actorType: "agent" as const };

function seedDeadJob(db: Database): void {
	const now = new Date().toISOString();
	db.prepare(
		`INSERT INTO memories (id, content, type, created_at, updated_at, updated_by)
		 VALUES ('repair-memory', 'repair memory', 'fact', ?, ?, 'test')`,
	).run(now, now);
	db.prepare(
		`INSERT INTO memory_jobs
		 (id, memory_id, job_type, status, attempts, max_attempts, created_at, updated_at)
		 VALUES ('repair-job', 'repair-memory', 'document_ingest', 'dead', 3, 3, ?, ?)`,
	).run(now, now);
}

describe("durable repair admission", () => {
	it("enforces one shared cooldown for operator, daemon, and agent callers", async () => {
		const { db, accessor } = freshDb();
		try {
			seedDeadJob(db);
			const first = await requeueDeadJobs(accessor, cfg, operator, createRateLimiter({ durable: true }));
			expect(first.success).toBe(true);

			const disabledCfg = { ...cfg, autonomous: { ...cfg.autonomous, enabled: false } };
			const operatorRetry = await requeueDeadJobs(
				accessor,
				disabledCfg,
				operator,
				createRateLimiter({ durable: true }),
			);
			expect(operatorRetry.success).toBe(false);
			expect(operatorRetry.message).toMatch(/cooldown active/);

			const daemonRetry = await requeueDeadJobs(accessor, cfg, daemon, createRateLimiter({ durable: true }));
			const agentRetry = await requeueDeadJobs(accessor, cfg, agent, createRateLimiter({ durable: true }));
			for (const result of [daemonRetry, agentRetry]) {
				expect(result.success).toBe(false);
				expect(result.code).toBe("repair_admission_denied");
				expect(result.message).toMatch(/cooldown active/);
			}
		} finally {
			db.close();
		}
	});

	it("does not charge a dry run against durable admission", async () => {
		const { db, accessor } = freshDb();
		try {
			seedDeadJob(db);
			const limiter = createRateLimiter({ durable: true });
			const preview = await requeueDeadJobs(accessor, cfg, operator, limiter, { dryRun: true });
			expect(preview.success).toBe(true);
			expect(db.prepare("SELECT status FROM memory_jobs WHERE id = 'repair-job'").get()).toEqual({ status: "dead" });
			expect(db.prepare("SELECT COUNT(*) AS count FROM repair_admission").get()).toEqual({ count: 0 });
			const applied = await requeueDeadJobs(accessor, cfg, operator, limiter);
			expect(applied.success).toBe(true);
		} finally {
			db.close();
		}
	});

	it("rejects a concurrent action before its repair work starts", async () => {
		const { db, accessor } = freshDb();
		try {
			seedDeadJob(db);
			let writes = 0;
			let workReady!: () => void;
			let releaseWork!: () => void;
			const ready = new Promise<void>((resolve) => {
				workReady = resolve;
			});
			const release = new Promise<void>((resolve) => {
				releaseWork = resolve;
			});
			const slowAccessor: DbAccessor = {
				...accessor,
				withWriteTxAsync<T>(fn: (writeDb: WriteDb) => T, options?: WriteAdmissionOptions): Promise<T> {
					writes++;
					if (writes !== 2) return accessor.withWriteTxAsync(fn, options);
					workReady();
					return release.then(() => accessor.withWriteTxAsync(fn, options));
				},
			};

			const first = requeueDeadJobs(slowAccessor, cfg, operator, createRateLimiter({ durable: true }));
			await ready;
			const duplicate = await requeueDeadJobs(accessor, cfg, daemon, createRateLimiter({ durable: true }));
			expect(duplicate).toMatchObject({ success: false, code: "repair_admission_denied" });
			expect(duplicate.message).toMatch(/already in progress/);
			releaseWork();
			expect((await first).success).toBe(true);
		} finally {
			db.close();
		}
	});

	it("keys leases by action and scope and keeps an active lease across limiter instances", async () => {
		const { db, accessor } = freshDb();
		const now = Date.parse("2026-09-01T12:00:00.000Z");
		try {
			const scopeA = repairScopeKey({ agentId: "agent-a", project: "project-a" });
			const scopeB = repairScopeKey({ agentId: "agent-b", project: "project-a" });
			const first = await acquire(accessor, {
				action: "reembedMissingMemories",
				scope: scopeA,
				cooldownMs: 0,
				hourlyBudget: 2,
				actor: "agent-a",
				actorType: "agent",
				requestId: "request-a",
				now,
			});
			expect(first.allowed).toBe(true);
			if (first.lease === undefined) throw new Error("expected first lease");

			const duplicate = await acquire(accessor, {
				action: "reembedMissingMemories",
				scope: scopeA,
				cooldownMs: 0,
				hourlyBudget: 2,
				actor: "maintenance-worker",
				actorType: "daemon",
				requestId: "request-b",
				now: now + 1,
			});
			expect(duplicate.allowed).toBe(false);
			expect(duplicate.reason).toMatch(/already in progress/);

			expect(
				await acquire(accessor, {
					action: "reembedMissingMemories",
					scope: scopeB,
					cooldownMs: 0,
					hourlyBudget: 2,
					actor: "agent-b",
					actorType: "agent",
					requestId: "request-c",
					now: now + 1,
				}),
			).toMatchObject({ allowed: true });

			expect(
				await finish(accessor, first.lease, {
					success: true,
					affected: 1,
					actor: "agent-a",
					requestId: "request-a",
					now: now + 2,
				}),
			).toBe(true);

			const budgetLease = await acquire(accessor, {
				action: "resyncVectorIndex",
				scope: scopeA,
				cooldownMs: 0,
				hourlyBudget: 1,
				actor: "agent-a",
				actorType: "agent",
				now,
			});
			expect(budgetLease.lease).toBeDefined();
			if (budgetLease.lease === undefined) throw new Error("expected budget lease");
			expect(
				await finish(accessor, budgetLease.lease, {
					success: true,
					affected: 1,
					actor: "agent-a",
					now: now + 1,
				}),
			).toBe(true);
			const budgetDenied = await acquire(accessor, {
				action: "resyncVectorIndex",
				scope: scopeA,
				cooldownMs: 0,
				hourlyBudget: 1,
				actor: "agent-a",
				actorType: "agent",
				now: now + 2,
			});
			expect(budgetDenied.allowed).toBe(false);
			expect(budgetDenied.reason).toMatch(/hourly budget exhausted/);

			const restarted = await acquire(accessor, {
				action: "reembedMissingMemories",
				scope: scopeA,
				cooldownMs: 60_000,
				hourlyBudget: 2,
				actor: "operator",
				actorType: "operator",
				requestId: "request-restart",
				now: now + 3,
			});
			expect(restarted.allowed).toBe(false);
			expect(restarted.reason).toMatch(/cooldown active/);
		} finally {
			db.close();
		}
	});
});
