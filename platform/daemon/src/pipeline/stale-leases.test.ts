import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { runMigrations } from "../../../core/src/migrations";
import type { WriteDb } from "../db-accessor";
import { DEFAULT_PLANNING_CEILINGS } from "./ingest/lease";
import { recoverStaleLeases } from "./stale-leases";

function insertMemory(db: Database, id: string): void {
	const now = new Date().toISOString();
	db.prepare(
		`INSERT INTO memories
		 (id, type, content, confidence, importance, created_at, updated_at,
		  updated_by, vector_clock, is_deleted, extraction_status)
		 VALUES (?, 'fact', ?, 1.0, 0.5, ?, ?, 'test', '{}', 0, 'none')`,
	).run(id, `content for ${id}`, now, now);
}

describe("recoverStaleLeases", () => {
	let db: Database;

	beforeEach(() => {
		db = new Database(":memory:");
		db.exec("PRAGMA foreign_keys = ON");
		runMigrations(db as unknown as Parameters<typeof runMigrations>[0]);
	});

	afterEach(() => {
		db.close();
	});

	it("requeues stale leased jobs and dead-letters exhausted leases", () => {
		const createdAt = new Date("2026-03-25T00:00:00.000Z").toISOString();
		const staleAt = new Date("2026-03-25T00:05:00.000Z").toISOString();
		const freshAt = new Date("2026-03-25T00:14:30.000Z").toISOString();
		const now = new Date("2026-03-25T00:15:00.000Z").toISOString();
		const cutoff = new Date("2026-03-25T00:10:00.000Z").toISOString();

		insertMemory(db, "mem-1");
		insertMemory(db, "mem-2");
		insertMemory(db, "mem-3");

		db.prepare(
			`INSERT INTO memory_jobs
			 (id, memory_id, job_type, status, attempts, max_attempts, leased_at, created_at, updated_at)
			 VALUES (?, ?, 'prospective_index', 'leased', ?, ?, ?, ?, ?)`,
		).run("job-stale", "mem-1", 1, 3, staleAt, createdAt, staleAt);

		db.prepare(
			`INSERT INTO memory_jobs
			 (id, memory_id, job_type, status, attempts, max_attempts, leased_at, created_at, updated_at)
			 VALUES (?, ?, 'prospective_index', 'leased', ?, ?, ?, ?, ?)`,
		).run("job-dead", "mem-2", 3, 3, staleAt, createdAt, staleAt);

		db.prepare(
			`INSERT INTO memory_jobs
			 (id, memory_id, job_type, status, attempts, max_attempts, leased_at, created_at, updated_at)
			 VALUES (?, ?, 'prospective_index', 'leased', ?, ?, ?, ?, ?)`,
		).run("job-fresh", "mem-3", 1, 3, freshAt, createdAt, freshAt);

		const result = recoverStaleLeases(db as unknown as WriteDb, {
			cutoff,
			now,
		});

		expect(result).toEqual({
			pending: 1,
			dead: 1,
			total: 2,
		});

		const stale = db
			.prepare(
				`SELECT status, leased_at, failed_at, error
				 FROM memory_jobs WHERE id = 'job-stale'`,
			)
			.get() as
			| {
					status: string;
					leased_at: string | null;
					failed_at: string | null;
					error: string | null;
			  }
			| undefined;
		expect(stale?.status).toBe("pending");
		expect(stale?.leased_at).toBeNull();
		expect(stale?.failed_at).toBeNull();
		expect(stale?.error).toBeNull();

		const dead = db
			.prepare(
				`SELECT status, leased_at, failed_at, error
				 FROM memory_jobs WHERE id = 'job-dead'`,
			)
			.get() as
			| {
					status: string;
					leased_at: string | null;
					failed_at: string | null;
					error: string | null;
			  }
			| undefined;
		expect(dead?.status).toBe("dead");
		expect(dead?.leased_at).toBeNull();
		expect(dead?.failed_at).toBe(now);
		expect(dead?.error).toBe("lease expired before completion");

		const fresh = db
			.prepare(
				`SELECT status, leased_at
				 FROM memory_jobs WHERE id = 'job-fresh'`,
			)
			.get() as
			| {
					status: string;
					leased_at: string | null;
			  }
			| undefined;
		expect(fresh?.status).toBe("leased");
		expect(fresh?.leased_at).toBe(freshAt);
	});

	it("reclaims a stale planning job back to pending and clears the lease token (#913)", () => {
		// reclaimStalePlanningJob checks the cumulative wall-clock ceiling against
		// real Date.now(), so planning_started_at must be recent (not a fixed past
		// date) or the row dead-letters on the wall-clock ceiling instead of reclaiming.
		const startedAt = new Date(Date.now() - 120_000).toISOString(); // 2 min ago
		const realNow = new Date();
		const leaseExpiresAt = new Date(realNow.getTime() - 60_000).toISOString(); // 1 min ago

		db.prepare(
			`INSERT INTO memory_jobs
			 (id, memory_id, job_type, status, attempts, max_attempts,
			  planning_attempts, planning_started_at, lease_token, lease_expires_at,
			  created_at, updated_at)
			 VALUES (?, NULL, 'ingest', 'planning', 0, 5, 1, ?, 'stale-tok', ?, ?, ?)`,
		).run("plan-stale", startedAt, leaseExpiresAt, startedAt, startedAt);

		const result = recoverStaleLeases(db as unknown as WriteDb, {
			cutoff: new Date(realNow.getTime() - 30_000).toISOString(),
			now: realNow.toISOString(),
		});

		// One planning reclaim: counts toward pending, not dead.
		expect(result).toEqual({
			pending: 1,
			dead: 0,
			total: 1,
		});

		const row = db
			.prepare(
				`SELECT status, lease_token, lease_expires_at, planning_attempts
				 FROM memory_jobs WHERE id = 'plan-stale'`,
			)
			.get() as
			| {
					status: string;
					lease_token: string | null;
					lease_expires_at: string | null;
					planning_attempts: number;
			  }
			| undefined;
		expect(row?.status).toBe("pending");
		// Lease cleared so a late apply with the stale token cannot double-write.
		expect(row?.lease_token).toBeNull();
		expect(row?.lease_expires_at).toBeNull();
		// Lenient reclaim does not consume another planning attempt.
		expect(row?.planning_attempts).toBe(1);
	});

	it("dead-letters a stale planning job at the planning-cycle ceiling (#913)", () => {
		const realNow = new Date();
		const startedAt = new Date(realNow.getTime() - 120_000).toISOString();
		const leaseExpiresAt = new Date(realNow.getTime() - 60_000).toISOString();

		db.prepare(
			`INSERT INTO memory_jobs
			 (id, memory_id, job_type, status, attempts, max_attempts,
			  planning_attempts, planning_started_at, lease_token, lease_expires_at,
			  created_at, updated_at)
			 VALUES (?, NULL, 'ingest', 'planning', 0, 5, ?, ?, 'stale-tok', ?, ?, ?)`,
		).run(
			"plan-dead",
			DEFAULT_PLANNING_CEILINGS.maxPlanningAttempts, // at the cycle ceiling
			startedAt,
			leaseExpiresAt,
			startedAt,
			startedAt,
		);

		const result = recoverStaleLeases(db as unknown as WriteDb, {
			cutoff: new Date(realNow.getTime() - 30_000).toISOString(),
			now: realNow.toISOString(),
		});

		expect(result).toEqual({
			pending: 0,
			dead: 1,
			total: 1,
		});

		const row = db
			.prepare(
				`SELECT status, error, lease_token
				 FROM memory_jobs WHERE id = 'plan-dead'`,
			)
			.get() as
			| {
					status: string;
					error: string | null;
					lease_token: string | null;
			  }
			| undefined;
		expect(row?.status).toBe("dead");
		expect(row?.error).toMatch(/cycle ceiling/);
		expect(row?.lease_token).toBeNull();
	});
});
