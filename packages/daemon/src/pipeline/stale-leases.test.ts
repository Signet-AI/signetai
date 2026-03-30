import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { runMigrations } from "../../../core/src/migrations";
import type { WriteDb } from "../db-accessor";
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
});
