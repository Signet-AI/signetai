import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { runMigrations } from "@signet/core";
import type { DbAccessor, WriteDb, ReadDb } from "../db-accessor";
import { startRetentionWorker, type RetentionConfig } from "./retention-worker";

function makeAccessor(db: Database): DbAccessor {
	return {
		withWriteTx<T>(fn: (db: WriteDb) => T): T {
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
		withReadDb<T>(fn: (db: ReadDb) => T): T {
			return fn(db as unknown as ReadDb);
		},
		close() {
			db.close();
		},
	};
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function testRetentionConfig(
	overrides: Partial<RetentionConfig> = {},
): RetentionConfig {
	return {
		intervalMs: 999999, // won't fire during tests
		tombstoneRetentionMs: 30 * ONE_DAY_MS,
		historyRetentionMs: 180 * ONE_DAY_MS,
		completedJobRetentionMs: 14 * ONE_DAY_MS,
		deadJobRetentionMs: 30 * ONE_DAY_MS,
		batchLimit: 500,
		...overrides,
	};
}

function daysAgo(days: number): string {
	return new Date(Date.now() - days * ONE_DAY_MS).toISOString();
}

describe("retention worker", () => {
	let db: Database;
	let accessor: DbAccessor;

	beforeEach(() => {
		db = new Database(":memory:");
		runMigrations(db as unknown as Parameters<typeof runMigrations>[0]);
		accessor = makeAccessor(db);
	});

	afterEach(() => {
		db.close();
	});

	it("purges tombstoned memories past retention window", () => {
		const now = new Date().toISOString();
		// Fresh soft-delete (within window)
		db.prepare(
			`INSERT INTO memories (id, content, type, is_deleted, deleted_at, created_at, updated_at, updated_by)
			 VALUES (?, ?, ?, 1, ?, ?, ?, ?)`,
		).run("recent-del", "recent", "fact", daysAgo(5), now, now, "test");

		// Old soft-delete (past 30-day window)
		db.prepare(
			`INSERT INTO memories (id, content, type, is_deleted, deleted_at, created_at, updated_at, updated_by)
			 VALUES (?, ?, ?, 1, ?, ?, ?, ?)`,
		).run("old-del", "old", "fact", daysAgo(35), now, now, "test");

		const handle = startRetentionWorker(accessor, testRetentionConfig());
		const result = handle.sweep();
		handle.stop();

		expect(result.tombstonesPurged).toBe(1);

		// Recent deletion still exists
		const recent = db
			.prepare("SELECT id FROM memories WHERE id = ?")
			.get("recent-del");
		expect(recent).toBeTruthy();

		// Old deletion was hard-purged
		const old = db
			.prepare("SELECT id FROM memories WHERE id = ?")
			.get("old-del");
		expect(old).toBeNull();
	});

	it("purges old history events past retention window", () => {
		// Insert a memory for FK reference
		const now = new Date().toISOString();
		db.prepare(
			`INSERT INTO memories (id, content, type, created_at, updated_at, updated_by)
			 VALUES (?, ?, ?, ?, ?, ?)`,
		).run("mem-hist", "content", "fact", now, now, "test");

		// Recent history
		db.prepare(
			`INSERT INTO memory_history (id, memory_id, event, changed_by, created_at)
			 VALUES (?, ?, ?, ?, ?)`,
		).run("hist-recent", "mem-hist", "updated", "test", daysAgo(30));

		// Old history (past 180 days)
		db.prepare(
			`INSERT INTO memory_history (id, memory_id, event, changed_by, created_at)
			 VALUES (?, ?, ?, ?, ?)`,
		).run("hist-old", "mem-hist", "updated", "test", daysAgo(200));

		const handle = startRetentionWorker(accessor, testRetentionConfig());
		const result = handle.sweep();
		handle.stop();

		expect(result.historyPurged).toBe(1);
		expect(
			db
				.prepare("SELECT id FROM memory_history WHERE id = ?")
				.get("hist-recent"),
		).toBeTruthy();
		expect(
			db.prepare("SELECT id FROM memory_history WHERE id = ?").get("hist-old"),
		).toBeNull();
	});

	it("purges completed and dead jobs past retention windows", () => {
		const now = new Date().toISOString();
		db.prepare(
			`INSERT INTO memories (id, content, type, created_at, updated_at, updated_by)
			 VALUES (?, ?, ?, ?, ?, ?)`,
		).run("mem-jobs", "content", "fact", now, now, "test");

		// Recent completed job (within 14 days)
		db.prepare(
			`INSERT INTO memory_jobs (id, memory_id, job_type, status, completed_at, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		).run(
			"job-recent",
			"mem-jobs",
			"extract",
			"completed",
			daysAgo(5),
			now,
			now,
		);

		// Old completed job (past 14 days)
		db.prepare(
			`INSERT INTO memory_jobs (id, memory_id, job_type, status, completed_at, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		).run("job-old", "mem-jobs", "extract", "completed", daysAgo(20), now, now);

		// Old dead job (past 30 days)
		db.prepare(
			`INSERT INTO memory_jobs (id, memory_id, job_type, status, failed_at, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		).run("job-dead", "mem-jobs", "extract", "dead", daysAgo(35), now, now);

		// Recent dead job (within 30 days)
		db.prepare(
			`INSERT INTO memory_jobs (id, memory_id, job_type, status, failed_at, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		).run(
			"job-dead-recent",
			"mem-jobs",
			"extract",
			"dead",
			daysAgo(10),
			now,
			now,
		);

		const handle = startRetentionWorker(accessor, testRetentionConfig());
		const result = handle.sweep();
		handle.stop();

		expect(result.completedJobsPurged).toBe(1);
		expect(result.deadJobsPurged).toBe(1);

		expect(
			db.prepare("SELECT id FROM memory_jobs WHERE id = ?").get("job-recent"),
		).toBeTruthy();
		expect(
			db.prepare("SELECT id FROM memory_jobs WHERE id = ?").get("job-old"),
		).toBeNull();
		expect(
			db.prepare("SELECT id FROM memory_jobs WHERE id = ?").get("job-dead"),
		).toBeNull();
		expect(
			db
				.prepare("SELECT id FROM memory_jobs WHERE id = ?")
				.get("job-dead-recent"),
		).toBeTruthy();
	});

	it("purges graph links before tombstones and cleans orphaned entities", () => {
		const now = new Date().toISOString();
		// Tombstoned memory
		db.prepare(
			`INSERT INTO memories (id, content, type, is_deleted, deleted_at, created_at, updated_at, updated_by)
			 VALUES (?, ?, ?, 1, ?, ?, ?, ?)`,
		).run("mem-graph", "graph test", "fact", daysAgo(35), now, now, "test");

		// Entity with mentions=1 (will become orphan after purge)
		db.prepare(
			`INSERT INTO entities (id, name, canonical_name, entity_type, mentions, created_at, updated_at)
			 VALUES (?, ?, ?, ?, 1, ?, ?)`,
		).run("ent-1", "TestEntity", "testentity", "concept", now, now);
		db.prepare(
			`INSERT INTO memory_entity_mentions (memory_id, entity_id)
			 VALUES (?, ?)`,
		).run("mem-graph", "ent-1");

		const handle = startRetentionWorker(accessor, testRetentionConfig());
		const result = handle.sweep();
		handle.stop();

		expect(result.graphLinksPurged).toBe(1);
		expect(result.entitiesOrphaned).toBe(1);
		expect(result.tombstonesPurged).toBe(1);

		// Graph link removed
		expect(
			db
				.prepare("SELECT * FROM memory_entity_mentions WHERE memory_id = ?")
				.get("mem-graph"),
		).toBeNull();
		// Entity orphaned and cleaned up
		expect(
			db.prepare("SELECT id FROM entities WHERE id = ?").get("ent-1"),
		).toBeNull();
		// Memory row hard-purged
		expect(
			db.prepare("SELECT id FROM memories WHERE id = ?").get("mem-graph"),
		).toBeNull();
	});

	it("decrements entity mentions and orphans during graph link purge", () => {
		const now = new Date().toISOString();
		// Tombstoned memory past retention
		db.prepare(
			`INSERT INTO memories (id, content, type, is_deleted, deleted_at, created_at, updated_at, updated_by)
			 VALUES (?, ?, ?, 1, ?, ?, ?, ?)`,
		).run("mem-orphan", "orphan test", "fact", daysAgo(35), now, now, "test");

		// Entity with mentions = 1 (will become orphan)
		db.prepare(
			`INSERT INTO entities (id, name, canonical_name, entity_type, mentions, created_at, updated_at)
			 VALUES (?, ?, ?, ?, 1, ?, ?)`,
		).run("ent-orphan", "Orphan", "orphan", "extracted", now, now);

		// Entity with mentions = 3 (will survive)
		db.prepare(
			`INSERT INTO entities (id, name, canonical_name, entity_type, mentions, created_at, updated_at)
			 VALUES (?, ?, ?, ?, 3, ?, ?)`,
		).run("ent-survive", "Survivor", "survivor", "extracted", now, now);

		// Mention links for both
		db.prepare(
			`INSERT INTO memory_entity_mentions (memory_id, entity_id)
			 VALUES (?, ?)`,
		).run("mem-orphan", "ent-orphan");
		db.prepare(
			`INSERT INTO memory_entity_mentions (memory_id, entity_id)
			 VALUES (?, ?)`,
		).run("mem-orphan", "ent-survive");

		const handle = startRetentionWorker(accessor, testRetentionConfig());
		const result = handle.sweep();
		handle.stop();

		expect(result.graphLinksPurged).toBe(2);
		expect(result.entitiesOrphaned).toBe(1);

		// Orphan entity deleted
		expect(
			db.prepare("SELECT id FROM entities WHERE id = ?").get("ent-orphan"),
		).toBeNull();
		// Survivor still exists with decremented mentions
		const survivor = db
			.prepare("SELECT mentions FROM entities WHERE id = ?")
			.get("ent-survive") as { mentions: number };
		expect(survivor.mentions).toBe(2);
	});

	it("returns zero counts when nothing to purge", () => {
		const handle = startRetentionWorker(accessor, testRetentionConfig());
		const result = handle.sweep();
		handle.stop();

		expect(result.tombstonesPurged).toBe(0);
		expect(result.historyPurged).toBe(0);
		expect(result.completedJobsPurged).toBe(0);
		expect(result.deadJobsPurged).toBe(0);
		expect(result.graphLinksPurged).toBe(0);
	});
});
