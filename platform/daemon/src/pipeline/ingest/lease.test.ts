import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { runMigrations } from "../../../../core/src/migrations";
import type { WriteDb } from "../../db-accessor";
import {
	DEFAULT_PLANNING_CEILINGS,
	INGEST_JOB_TYPE,
	INGEST_PRIORITY_BACKFILL,
	INGEST_PRIORITY_LIVE,
	acquireIngestLease,
	completeIngestJob,
	failIngestJob,
	leaseForPlanning,
	reclaimStalePlanningJob,
	releaseIngestLease,
	verifyIngestLease,
} from "./lease";

function asWriteDb(db: Database): WriteDb {
	return db as unknown as WriteDb;
}

/** Enqueue a pending ingest job with the given lane + agent. */
function enqueue(db: WriteDb, id: string, agentId: string, priority = 0): void {
	const now = new Date().toISOString();
	db.prepare(
		`INSERT INTO memory_jobs
		 (id, memory_id, job_type, status, payload, attempts, max_attempts,
		  priority, agent_id, created_at, updated_at)
		 VALUES (?, NULL, ?, 'pending', '{}', 0, 5, ?, ?, ?, ?)`,
	).run(id, INGEST_JOB_TYPE, priority, agentId, now, now);
}

function statusOf(db: WriteDb, id: string): string {
	const row = db.prepare("SELECT status FROM memory_jobs WHERE id = ?").get(id) as { status: string };
	return row.status;
}

function attemptsOf(db: WriteDb, id: string): number {
	const row = db.prepare("SELECT attempts FROM memory_jobs WHERE id = ?").get(id) as { attempts: number };
	return row.attempts;
}

describe("ingest fenced lease", () => {
	let db: Database;
	let wdb: WriteDb;

	beforeEach(() => {
		db = new Database(":memory:");
		runMigrations(db as unknown as Parameters<typeof runMigrations>[0]);
		wdb = asWriteDb(db);
	});
	afterEach(() => db.close());

	test("acquire leases a pending job atomically and increments attempts", () => {
		enqueue(wdb, "j1", "default");
		const res = acquireIngestLease(wdb, { agentId: "default", owner: "daemon", leaseTimeoutMs: 60_000 });
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.job.id).toBe("j1");
		expect(res.job.status).toBe("leased");
		expect(res.job.attempts).toBe(1); // incremented at lease
		expect(statusOf(wdb, "j1")).toBe("leased");
		expect(res.leaseToken.length).toBeGreaterThan(0);
	});

	test("two sequential acquires lease different jobs (no double-lease)", () => {
		enqueue(wdb, "j1", "default");
		enqueue(wdb, "j2", "default");
		const a = acquireIngestLease(wdb, { agentId: "default", owner: "daemon", leaseTimeoutMs: 60_000 });
		const b = acquireIngestLease(wdb, { agentId: "default", owner: "cron", leaseTimeoutMs: 60_000 });
		expect(a.ok && b.ok).toBe(true);
		if (!a.ok || !b.ok) return;
		expect(a.job.id).not.toBe(b.job.id);
		expect(new Set([a.job.id, b.job.id])).toEqual(new Set(["j1", "j2"]));
	});

	test("acquire is agent-scoped: agent A cannot lease agent B's job", () => {
		enqueue(wdb, "j1", "agentB");
		const res = acquireIngestLease(wdb, { agentId: "agentA", owner: "daemon", leaseTimeoutMs: 60_000 });
		expect(res.ok).toBe(false);
	});

	test("priority lanes: live is leased before backfill", () => {
		enqueue(wdb, "backfill", "default", INGEST_PRIORITY_BACKFILL);
		enqueue(wdb, "live", "default", INGEST_PRIORITY_LIVE);
		const res = acquireIngestLease(wdb, { agentId: "default", owner: "daemon", leaseTimeoutMs: 60_000 });
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.job.id).toBe("live");
	});

	test("completeIngestJob CAS: valid token completes; wrong token is a no-op", () => {
		enqueue(wdb, "j1", "default");
		const res = acquireIngestLease(wdb, { agentId: "default", owner: "daemon", leaseTimeoutMs: 60_000 });
		if (!res.ok) throw new Error("lease failed");
		expect(completeIngestJob(wdb, "j1", res.leaseToken, "planhash_abc")).toBe(true);
		expect(statusOf(wdb, "j1")).toBe("completed");
		// Wrong token cannot complete (e.g. a second executor that lost the race).
		expect(completeIngestJob(wdb, "j1", "wrong-token")).toBe(false);
	});

	test("complete is idempotent under the same token (re-apply is a no-op)", () => {
		enqueue(wdb, "j1", "default");
		const res = acquireIngestLease(wdb, { agentId: "default", owner: "daemon", leaseTimeoutMs: 60_000 });
		if (!res.ok) throw new Error("lease failed");
		expect(completeIngestJob(wdb, "j1", res.leaseToken, "h1")).toBe(true);
		// The token is cleared on complete, so a second apply with the same token is a no-op.
		expect(completeIngestJob(wdb, "j1", res.leaseToken, "h1")).toBe(false);
	});

	test("failIngestJob CAS: valid token releases to pending; wrong token is noop", () => {
		enqueue(wdb, "j1", "default");
		const res = acquireIngestLease(wdb, { agentId: "default", owner: "daemon", leaseTimeoutMs: 60_000 });
		if (!res.ok) throw new Error("lease failed");
		expect(failIngestJob(wdb, "j1", res.leaseToken, "boom", 5)).toBe("retry");
		expect(statusOf(wdb, "j1")).toBe("pending");
		// Wrong token noop.
		expect(failIngestJob(wdb, "j1", "wrong-token", "x", 5)).toBe("noop");
	});

	test("failIngestJob dead-letters at the attempt ceiling", () => {
		enqueue(wdb, "j1", "default");
		// Place the job one attempt below the ceiling (failed_at NULL -> no backoff
		// gate), acquire to bump it onto the ceiling, then fail -> dead.
		wdb.prepare("UPDATE memory_jobs SET attempts = 4 WHERE id = 'j1'").run();
		const res = acquireIngestLease(wdb, { agentId: "default", owner: "daemon", leaseTimeoutMs: 60_000 });
		if (!res.ok) throw new Error("lease failed");
		expect(attemptsOf(wdb, "j1")).toBe(5);
		expect(failIngestJob(wdb, "j1", res.leaseToken, "boom", 5)).toBe("dead");
		expect(statusOf(wdb, "j1")).toBe("dead");
	});

	test("releaseIngestLease refunds the attempt (cancellation does not consume work)", () => {
		enqueue(wdb, "j1", "default");
		const res = acquireIngestLease(wdb, { agentId: "default", owner: "daemon", leaseTimeoutMs: 60_000 });
		if (!res.ok) throw new Error("lease failed");
		expect(attemptsOf(wdb, "j1")).toBe(1);
		expect(releaseIngestLease(wdb, "j1", res.leaseToken)).toBe(true);
		expect(statusOf(wdb, "j1")).toBe("pending");
		expect(attemptsOf(wdb, "j1")).toBe(0); // refunded
	});

	describe("agentic planning lifecycle", () => {
		test("leaseForPlanning moves to planning + increments planning_attempts", () => {
			enqueue(wdb, "j1", "default");
			const res = leaseForPlanning(wdb, {
				agentId: "default",
				owner: "cron",
				planningLeaseTimeoutMs: 10 * 60_000,
			});
			expect(res.ok).toBe(true);
			if (!res.ok) return;
			expect(res.job.status).toBe("planning");
			const row = wdb
				.prepare("SELECT planning_attempts, lease_token FROM memory_jobs WHERE id = 'j1'")
				.get() as { planning_attempts: number; lease_token: string };
			expect(row.planning_attempts).toBe(1);
			expect(row.lease_token).toBe(res.leaseToken);
		});

		test("reclaimStalePlanningJob returns to pending; a stale apply with the old token cannot double-apply", () => {
			enqueue(wdb, "j1", "default");
			const res = leaseForPlanning(wdb, {
				agentId: "default",
				owner: "cron",
				planningLeaseTimeoutMs: 10 * 60_000,
			});
			if (!res.ok) throw new Error("planning lease failed");
			const staleToken = res.leaseToken;

			// Simulate the harness never applying: the reaper reclaims.
			const outcome = reclaimStalePlanningJob(wdb, "j1");
			expect(outcome.outcome).toBe("reclaimed");
			expect(statusOf(wdb, "j1")).toBe("pending");

			// The stale token no longer owns the job — a late apply is rejected.
			expect(verifyIngestLease(wdb, "j1", staleToken)).toBeNull();
			expect(completeIngestJob(wdb, "j1", staleToken)).toBe(false);
		});

		test("reclaim dead-letters at the planning cycle ceiling (distinguished reason)", () => {
			enqueue(wdb, "j1", "default");
			const tiny = { ...DEFAULT_PLANNING_CEILINGS, maxPlanningAttempts: 2, planningCooldownMs: 0 };
			// Simulate two exhausted planning rounds: planning_attempts at the
			// ceiling, job still in planning. A reclaim must dead-letter, not
			// loop the harness on a hard item forever.
			wdb.prepare(
				"UPDATE memory_jobs SET status='planning', planning_attempts=2, lease_token=? WHERE id='j1'",
			).run("stale-tok");
			const outcome = reclaimStalePlanningJob(wdb, "j1", tiny);
			expect(outcome.outcome).toBe("dead-lettered");
			if (outcome.outcome === "dead-lettered") {
				expect(outcome.reason).toMatch(/cycle ceiling/);
			}
			expect(statusOf(wdb, "j1")).toBe("dead");
		});

		test("planning cooldown gates re-lease (a tight cron cannot burn cycles on one item)", () => {
			enqueue(wdb, "j1", "default");
			const ceilings = { ...DEFAULT_PLANNING_CEILINGS, planningCooldownMs: 10_000 };
			const first = leaseForPlanning(wdb, {
				agentId: "default",
				owner: "cron",
				planningLeaseTimeoutMs: 60_000,
				ceilings,
			});
			expect(first.ok).toBe(true);
			// Reclaim the first round, then try to re-lease immediately: the
			// 10s cooldown should block same-second re-lease.
			if (first.ok) reclaimStalePlanningJob(wdb, "j1", ceilings);
			const second = leaseForPlanning(wdb, {
				agentId: "default",
				owner: "cron",
				planningLeaseTimeoutMs: 60_000,
				ceilings,
			});
			expect(second.ok).toBe(false);
		});
	});
});
