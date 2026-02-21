/**
 * Tests for the diagnostics module.
 *
 * Uses an in-memory SQLite DB with real migrations so we get the full
 * schema without hitting disk.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "@signet/core";
import {
	createProviderTracker,
	getDiagnostics,
	getIndexHealth,
	getMutationHealth,
	getProviderHealth,
	getQueueHealth,
	getStorageHealth,
} from "./diagnostics";
import type { ReadDb } from "./db-accessor";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDb(): Database {
	const db = new Database(":memory:");
	db.exec("PRAGMA journal_mode = WAL");
	runMigrations(db);
	return db;
}

let db: Database;

beforeEach(() => {
	db = makeDb();
});

afterEach(() => {
	db.close();
});

function asReadDb(raw: Database): ReadDb {
	return raw as unknown as ReadDb;
}

const now = new Date().toISOString();

function insertMemory(
	raw: Database,
	id: string,
	opts: { isDeleted?: number; embeddingModel?: string | null } = {},
): void {
	raw
		.prepare(
			`INSERT INTO memories
				(id, type, content, confidence, tags, created_at, updated_at,
				 updated_by, version, manual_override, is_deleted, embedding_model)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.run(
			id,
			"fact",
			`content for ${id}`,
			0.9,
			"[]",
			now,
			now,
			"test",
			1,
			0,
			opts.isDeleted ?? 0,
			opts.embeddingModel ?? null,
		);
}

function insertJob(
	raw: Database,
	id: string,
	memId: string,
	status: string,
	createdAt = now,
): void {
	raw
		.prepare(
			`INSERT INTO memory_jobs
				(id, memory_id, job_type, status, attempts, max_attempts,
				 created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.run(id, memId, "extract", status, 0, 3, createdAt, now);
}

function insertHistory(
	raw: Database,
	id: string,
	memId: string,
	event: string,
	createdAt = now,
): void {
	raw
		.prepare(
			`INSERT INTO memory_history
				(id, memory_id, event, changed_by, created_at)
			 VALUES (?, ?, ?, ?, ?)`,
		)
		.run(id, memId, event, "test", createdAt);
}

// ---------------------------------------------------------------------------
// Queue health
// ---------------------------------------------------------------------------

describe("getQueueHealth", () => {
	test("empty DB returns healthy score", () => {
		const result = getQueueHealth(asReadDb(db));
		expect(result.status).toBe("healthy");
		expect(result.score).toBe(1);
		expect(result.depth).toBe(0);
		expect(result.deadRate).toBe(0);
		expect(result.leaseAnomalies).toBe(0);
	});

	test("many pending jobs degrades queue health", () => {
		for (let i = 0; i < 51; i++) {
			const memId = `mem-q-${i}`;
			insertMemory(db, memId);
			insertJob(db, `job-${i}`, memId, "pending");
		}

		const result = getQueueHealth(asReadDb(db));
		expect(result.depth).toBe(51);
		expect(result.score).toBeLessThan(0.8);
		expect(result.status).not.toBe("healthy");
	});

	test("high dead rate degrades queue health", () => {
		for (let i = 0; i < 10; i++) {
			const memId = `mem-dr-${i}`;
			insertMemory(db, memId);
			// 5 completed, 5 dead => 50% dead rate
			const status = i < 5 ? "completed" : "dead";
			insertJob(db, `job-dr-${i}`, memId, status);
		}

		const result = getQueueHealth(asReadDb(db));
		expect(result.deadRate).toBeGreaterThan(0.01);
		expect(result.score).toBeLessThan(1);
	});
});

// ---------------------------------------------------------------------------
// Storage health
// ---------------------------------------------------------------------------

describe("getStorageHealth", () => {
	test("empty DB returns healthy score", () => {
		const result = getStorageHealth(asReadDb(db));
		expect(result.status).toBe("healthy");
		expect(result.totalMemories).toBe(0);
		expect(result.deletedTombstones).toBe(0);
		expect(result.dbSizeBytes).toBe(0);
	});

	test("high tombstone ratio degrades storage health", () => {
		// 3 active, 7 deleted => 70% tombstone ratio
		for (let i = 0; i < 3; i++) insertMemory(db, `mem-active-${i}`);
		for (let i = 0; i < 7; i++) insertMemory(db, `mem-del-${i}`, { isDeleted: 1 });

		const result = getStorageHealth(asReadDb(db));
		expect(result.totalMemories).toBe(10);
		expect(result.deletedTombstones).toBe(7);
		expect(result.score).toBeLessThan(0.8);
	});
});

// ---------------------------------------------------------------------------
// Index health
// ---------------------------------------------------------------------------

describe("getIndexHealth", () => {
	test("empty DB returns healthy score with no mismatch", () => {
		const result = getIndexHealth(asReadDb(db));
		expect(result.status).toBe("healthy");
		expect(result.ftsMismatch).toBe(false);
		// no memories => coverage defaults to 1 (nothing to embed)
		expect(result.embeddingCoverage).toBe(1);
	});

	test("FTS mismatch detected when tombstones exceed 10% of active count", () => {
		// memories_fts is a content table backed by memories.
		// COUNT(*) on it returns ALL memories (active + deleted).
		// Insert 5 active, 6 deleted => ftsRowCount=11, memoriesRowCount=5
		// 11 > 5 * 1.1 (5.5) => mismatch
		for (let i = 0; i < 5; i++) {
			insertMemory(db, `mem-active-fts-${i}`);
		}
		for (let i = 0; i < 6; i++) {
			insertMemory(db, `mem-del-fts-${i}`, { isDeleted: 1 });
		}

		const result = getIndexHealth(asReadDb(db));
		expect(result.memoriesRowCount).toBe(5);
		expect(result.ftsRowCount).toBe(11);
		expect(result.ftsMismatch).toBe(true);
		expect(result.score).toBeLessThanOrEqual(0.5);
	});

	test("low embedding coverage degrades index health", () => {
		// 2 with embeddings, 8 without => 20% coverage
		for (let i = 0; i < 2; i++) {
			insertMemory(db, `mem-emb-${i}`, { embeddingModel: "text-embedding-3" });
		}
		for (let i = 0; i < 8; i++) {
			insertMemory(db, `mem-noemb-${i}`);
		}

		const result = getIndexHealth(asReadDb(db));
		expect(result.embeddingCoverage).toBe(0.2);
		expect(result.score).toBeLessThan(0.8);
	});
});

// ---------------------------------------------------------------------------
// Provider tracker
// ---------------------------------------------------------------------------

describe("createProviderTracker", () => {
	test("starts empty with no stats", () => {
		const tracker = createProviderTracker();
		expect(tracker.stats.total).toBe(0);
		expect(tracker.stats.successes).toBe(0);
	});

	test("records outcomes correctly", () => {
		const tracker = createProviderTracker();
		tracker.record("success");
		tracker.record("success");
		tracker.record("failure");
		tracker.record("timeout");

		expect(tracker.stats.total).toBe(4);
		expect(tracker.stats.successes).toBe(2);
		expect(tracker.stats.failures).toBe(1);
		expect(tracker.stats.timeouts).toBe(1);
	});

	test("ring buffer wraps at capacity and evicts oldest", () => {
		const tracker = createProviderTracker(3);
		// Fill with failures
		tracker.record("failure");
		tracker.record("failure");
		tracker.record("failure");
		// Now overwrite with successes -- failures should drop out
		tracker.record("success");
		tracker.record("success");
		tracker.record("success");

		expect(tracker.stats.total).toBe(3);
		expect(tracker.stats.successes).toBe(3);
		expect(tracker.stats.failures).toBe(0);
	});

	test("getProviderHealth reflects tracker state", () => {
		const tracker = createProviderTracker();
		// 80% availability
		for (let i = 0; i < 8; i++) tracker.record("success");
		for (let i = 0; i < 2; i++) tracker.record("failure");

		const result = getProviderHealth(tracker);
		expect(result.availabilityRate).toBe(0.8);
		expect(result.score).toBe(0.8);
		expect(result.status).toBe("healthy");
	});

	test("empty tracker returns healthy (no data assumption)", () => {
		const tracker = createProviderTracker();
		const result = getProviderHealth(tracker);
		expect(result.status).toBe("healthy");
		expect(result.availabilityRate).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// Mutation health
// ---------------------------------------------------------------------------

describe("getMutationHealth", () => {
	test("empty DB returns healthy score", () => {
		const result = getMutationHealth(asReadDb(db));
		expect(result.status).toBe("healthy");
		expect(result.recentRecovers).toBe(0);
		expect(result.recentDeletes).toBe(0);
	});

	test("many recent recoveries degrade mutation health", () => {
		insertMemory(db, "mem-hist");
		for (let i = 0; i < 6; i++) {
			insertHistory(db, `hist-${i}`, "mem-hist", "recovered");
		}

		const result = getMutationHealth(asReadDb(db));
		expect(result.recentRecovers).toBe(6);
		expect(result.score).toBeLessThan(0.8);
	});

	test("old recoveries outside 7-day window are not counted", () => {
		insertMemory(db, "mem-old");
		const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
		for (let i = 0; i < 10; i++) {
			insertHistory(db, `hist-old-${i}`, "mem-old", "recovered", old);
		}

		const result = getMutationHealth(asReadDb(db));
		// Outside the 7-day window => not counted
		expect(result.recentRecovers).toBe(0);
		expect(result.status).toBe("healthy");
	});
});

// ---------------------------------------------------------------------------
// Composite score
// ---------------------------------------------------------------------------

describe("getDiagnostics", () => {
	test("composite score is weighted average of domain scores", () => {
		const tracker = createProviderTracker();
		const report = getDiagnostics(asReadDb(db), tracker);

		// All domains healthy => composite close to 1
		expect(report.composite.score).toBeCloseTo(1, 5);
		expect(report.composite.status).toBe("healthy");
		expect(typeof report.timestamp).toBe("string");
	});

	test("composite degrades when a domain degrades", () => {
		// Degrade queue health: insert 51 pending jobs
		for (let i = 0; i < 51; i++) {
			const memId = `mem-comp-${i}`;
			insertMemory(db, memId);
			insertJob(db, `job-comp-${i}`, memId, "pending");
		}

		const tracker = createProviderTracker();
		const report = getDiagnostics(asReadDb(db), tracker);

		// Queue degrades by 0.3 x weight 0.3 = -0.09 off the composite
		expect(report.composite.score).toBeLessThan(1);
		expect(report.queue.status).not.toBe("healthy");
	});
});
