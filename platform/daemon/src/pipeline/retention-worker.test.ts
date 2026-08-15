import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { runMigrations } from "../../../core/src/migrations";
import type { DbAccessor, ReadDb, SqliteStatement, WriteDb } from "../db-accessor";
import { vectorToBlob } from "../db-helpers";
import { type RetentionConfig, startRetentionWorker } from "./retention-worker";

function makeAccessor(db: Database, writeDb: WriteDb = db as unknown as WriteDb): DbAccessor {
	return {
		withWriteTx<T>(fn: (db: WriteDb) => T): T {
			db.exec("BEGIN IMMEDIATE");
			try {
				const result = fn(writeDb);
				db.exec("COMMIT");
				return result;
			} catch (err) {
				db.exec("ROLLBACK");
				throw err;
			}
		},
		withWriteTxAsync<T>(fn: (db: WriteDb) => T): Promise<T> {
			return Promise.resolve().then(() => {
				db.exec("BEGIN IMMEDIATE");
				try {
					const result = fn(writeDb);
					db.exec("COMMIT");
					return result;
				} catch (error) {
					db.exec("ROLLBACK");
					throw error;
				}
			});
		},
		withReadDb<T>(fn: (db: ReadDb) => T): T {
			return fn(db as unknown as ReadDb);
		},
		withReadDbAsync<T>(fn: (db: ReadDb) => Promise<T>): Promise<T> {
			return fn(db as unknown as ReadDb);
		},
		close() {
			db.close();
		},
	};
}

function failVectorDeleteOnce(db: Database): WriteDb {
	let failed = false;
	return {
		exec(sql: string): void {
			db.exec(sql);
		},
		prepare(sql: string): SqliteStatement {
			const statement = db.prepare(sql) as unknown as SqliteStatement;
			if (sql !== "DELETE FROM vec_embeddings WHERE id = ?") return statement;
			return {
				run(...params: unknown[]) {
					if (!failed) {
						failed = true;
						throw new Error("simulated vec delete failure");
					}
					return statement.run(...params);
				},
				get(...params: unknown[]) {
					return statement.get(...params);
				},
				all<Row = unknown>(...params: unknown[]) {
					return statement.all<Row>(...params);
				},
			};
		},
	};
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function testRetentionConfig(overrides: Partial<RetentionConfig> = {}): RetentionConfig {
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

	it("purges tombstoned memories past retention window", async () => {
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
		const result = await handle.sweep();
		handle.stop();

		expect(result.tombstonesPurged).toBe(1);

		// Recent deletion still exists
		const recent = db.prepare("SELECT id FROM memories WHERE id = ?").get("recent-del");
		expect(recent).toBeTruthy();

		// Old deletion was hard-purged
		const old = db.prepare("SELECT id FROM memories WHERE id = ?").get("old-del");
		expect(old).toBeNull();
	});

	it("purges old history events past retention window", async () => {
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
		const result = await handle.sweep();
		handle.stop();

		expect(result.historyPurged).toBe(1);
		expect(db.prepare("SELECT id FROM memory_history WHERE id = ?").get("hist-recent")).toBeTruthy();
		expect(db.prepare("SELECT id FROM memory_history WHERE id = ?").get("hist-old")).toBeNull();
	});

	it("purges completed and dead jobs past retention windows", async () => {
		const now = new Date().toISOString();
		db.prepare(
			`INSERT INTO memories (id, content, type, created_at, updated_at, updated_by)
			 VALUES (?, ?, ?, ?, ?, ?)`,
		).run("mem-jobs", "content", "fact", now, now, "test");

		// Recent completed job (within 14 days)
		db.prepare(
			`INSERT INTO memory_jobs (id, memory_id, job_type, status, completed_at, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		).run("job-recent", "mem-jobs", "extract", "completed", daysAgo(5), now, now);

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
		).run("job-dead-recent", "mem-jobs", "extract", "dead", daysAgo(10), now, now);

		const handle = startRetentionWorker(accessor, testRetentionConfig());
		const result = await handle.sweep();
		handle.stop();

		expect(result.completedJobsPurged).toBe(1);
		expect(result.deadJobsPurged).toBe(1);

		expect(db.prepare("SELECT id FROM memory_jobs WHERE id = ?").get("job-recent")).toBeTruthy();
		expect(db.prepare("SELECT id FROM memory_jobs WHERE id = ?").get("job-old")).toBeNull();
		expect(db.prepare("SELECT id FROM memory_jobs WHERE id = ?").get("job-dead")).toBeNull();
		expect(db.prepare("SELECT id FROM memory_jobs WHERE id = ?").get("job-dead-recent")).toBeTruthy();
	});

	it("purges old transcript capture jobs past retention windows", async () => {
		const insertCompleted = db.prepare(
			`INSERT INTO transcript_capture_jobs (
				id, agent_id, harness, session_id, transcript, captured_at, status, attempts, max_attempts,
				created_at, updated_at, completed_at
			) VALUES (?, 'default', 'test', ?, 'User: hi', ?, 'completed', 1, 5, ?, ?, ?)`,
		);
		insertCompleted.run("tc-recent", "tc-recent", daysAgo(5), daysAgo(5), daysAgo(5), daysAgo(5));
		insertCompleted.run("tc-old", "tc-old", daysAgo(20), daysAgo(20), daysAgo(20), daysAgo(20));
		db.prepare(
			`INSERT INTO transcript_capture_jobs (
				id, agent_id, harness, session_id, transcript, captured_at, status, attempts, max_attempts,
				created_at, updated_at
			) VALUES (?, 'default', 'test', ?, 'User: hi', ?, 'dead', 5, 5, ?, ?)`,
		).run("tc-dead", "tc-dead", daysAgo(35), daysAgo(35), daysAgo(35));

		const handle = startRetentionWorker(accessor, testRetentionConfig());
		const result = await handle.sweep();
		handle.stop();

		expect(result.completedTranscriptCaptureJobsPurged).toBe(1);
		expect(result.deadTranscriptCaptureJobsPurged).toBe(1);
		expect(db.prepare("SELECT id FROM transcript_capture_jobs WHERE id = ?").get("tc-recent")).toBeTruthy();
		expect(db.prepare("SELECT id FROM transcript_capture_jobs WHERE id = ?").get("tc-old")).toBeNull();
		expect(db.prepare("SELECT id FROM transcript_capture_jobs WHERE id = ?").get("tc-dead")).toBeNull();
	});

	it("purges graph links before tombstones and cleans orphaned entities", async () => {
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
		const result = await handle.sweep();
		handle.stop();

		expect(result.graphLinksPurged).toBe(1);
		expect(result.entitiesOrphaned).toBe(1);
		expect(result.tombstonesPurged).toBe(1);

		// Graph link removed
		expect(db.prepare("SELECT * FROM memory_entity_mentions WHERE memory_id = ?").get("mem-graph")).toBeNull();
		// Entity orphaned and cleaned up
		expect(db.prepare("SELECT id FROM entities WHERE id = ?").get("ent-1")).toBeNull();
		// Memory row hard-purged
		expect(db.prepare("SELECT id FROM memories WHERE id = ?").get("mem-graph")).toBeNull();
	});

	it("decrements entity mentions and orphans during graph link purge", async () => {
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
		const result = await handle.sweep();
		handle.stop();

		expect(result.graphLinksPurged).toBe(2);
		expect(result.entitiesOrphaned).toBe(1);

		// Orphan entity deleted
		expect(db.prepare("SELECT id FROM entities WHERE id = ?").get("ent-orphan")).toBeNull();
		// Survivor still exists with decremented mentions
		const survivor = db.prepare("SELECT mentions FROM entities WHERE id = ?").get("ent-survive") as {
			mentions: number;
		};
		expect(survivor.mentions).toBe(2);
	});

	it("keeps tombstones and canonical embeddings when vec deletion fails, then retries atomically", async () => {
		const now = new Date().toISOString();
		db.exec("CREATE TABLE vec_embeddings (id TEXT PRIMARY KEY, embedding BLOB NOT NULL)");
		db.prepare(
			`INSERT INTO memories
				(id, content, content_hash, type, agent_id, is_deleted, deleted_at, created_at, updated_at, updated_by)
			 VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
		).run("mem-expired", "expired", "hash-expired", "fact", "agent-a", daysAgo(35), now, now, "test");
		db.prepare(
			`INSERT INTO memories
				(id, content, content_hash, type, agent_id, created_at, updated_at, updated_by)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		).run("mem-survivor", "survivor", "hash-survivor", "fact", "agent-b", now, now, "test");
		db.prepare(
			`INSERT INTO embeddings
				(id, content_hash, vector, dimensions, source_type, source_id, chunk_text, created_at, agent_id)
			 VALUES (?, ?, ?, ?, 'memory', ?, ?, ?, ?)`,
		).run("emb-expired", "hash-expired", vectorToBlob([1, 2, 3]), 3, "mem-expired", "expired", now, "agent-a");
		db.prepare(
			`INSERT INTO embeddings
				(id, content_hash, vector, dimensions, source_type, source_id, chunk_text, created_at, agent_id)
			 VALUES (?, ?, ?, ?, 'memory', ?, ?, ?, ?)`,
		).run("emb-survivor", "hash-survivor", vectorToBlob([4, 5, 6]), 3, "mem-survivor", "survivor", now, "agent-b");
		db.prepare("INSERT INTO vec_embeddings (id, embedding) VALUES (?, ?)").run("emb-expired", vectorToBlob([1, 2, 3]));
		db.prepare("INSERT INTO vec_embeddings (id, embedding) VALUES (?, ?)").run("emb-survivor", vectorToBlob([4, 5, 6]));
		db.prepare(
			`INSERT INTO entities (id, agent_id, name, canonical_name, entity_type, mentions, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
		).run("entity-expired", "agent-a", "Expired", "expired", "concept", now, now);
		db.prepare("INSERT INTO memory_entity_mentions (memory_id, entity_id) VALUES (?, ?)").run(
			"mem-expired",
			"entity-expired",
		);

		const failingAccessor = makeAccessor(db, failVectorDeleteOnce(db));
		const failingHandle = startRetentionWorker(failingAccessor, testRetentionConfig());
		await expect(failingHandle.sweep()).rejects.toThrow("failed to reconcile vec_embeddings");
		failingHandle.stop();

		// The failed derived-index step rolls back graph/provenance cleanup,
		// canonical deletion, tombstoning, and cold archival as one retryable unit.
		expect(db.prepare("SELECT id FROM memories WHERE id = ?").get("mem-expired")).toBeTruthy();
		expect(db.prepare("SELECT id FROM embeddings WHERE id = ?").get("emb-expired")).toBeTruthy();
		expect(db.prepare("SELECT id FROM vec_embeddings WHERE id = ?").get("emb-expired")).toBeTruthy();
		expect(
			db.prepare("SELECT memory_id, entity_id FROM memory_entity_mentions WHERE memory_id = ?").get("mem-expired"),
		).toEqual({
			memory_id: "mem-expired",
			entity_id: "entity-expired",
		});
		expect(db.prepare("SELECT id, mentions FROM entities WHERE id = ?").get("entity-expired")).toEqual({
			id: "entity-expired",
			mentions: 1,
		});
		expect(db.prepare("SELECT memory_id FROM memories_cold WHERE memory_id = ?").get("mem-expired")).toBeNull();

		const retryHandle = startRetentionWorker(failingAccessor, testRetentionConfig());
		const retry = await retryHandle.sweep();
		const repeat = await retryHandle.sweep();
		retryHandle.stop();

		expect(retry.embeddingsPurged).toBe(1);
		expect(retry.tombstonesPurged).toBe(1);
		expect(repeat.embeddingsPurged).toBe(0);
		expect(repeat.tombstonesPurged).toBe(0);
		expect(db.prepare("SELECT id FROM memories WHERE id = ?").get("mem-expired")).toBeNull();
		expect(db.prepare("SELECT id FROM embeddings WHERE id = ?").get("emb-expired")).toBeNull();
		expect(db.prepare("SELECT id FROM vec_embeddings WHERE id = ?").get("emb-expired")).toBeNull();
		expect(
			db.prepare("SELECT memory_id FROM memory_entity_mentions WHERE memory_id = ?").get("mem-expired"),
		).toBeNull();
		expect(db.prepare("SELECT id FROM entities WHERE id = ?").get("entity-expired")).toBeNull();
		expect(db.prepare("SELECT id, agent_id FROM memories WHERE id = ?").get("mem-survivor")).toEqual({
			id: "mem-survivor",
			agent_id: "agent-b",
		});
		expect(db.prepare("SELECT id, agent_id FROM embeddings WHERE id = ?").get("emb-survivor")).toEqual({
			id: "emb-survivor",
			agent_id: "agent-b",
		});
		expect(db.prepare("SELECT id FROM vec_embeddings WHERE id = ?").get("emb-survivor")).toBeTruthy();
		const cold = db
			.prepare("SELECT memory_id, agent_id, archived_reason FROM memories_cold WHERE memory_id = ?")
			.get("mem-expired");
		expect(cold).toMatchObject({ memory_id: "mem-expired", agent_id: "agent-a", archived_reason: "retention_decay" });
	});

	it("returns zero counts when nothing to purge", async () => {
		const handle = startRetentionWorker(accessor, testRetentionConfig());
		const result = await handle.sweep();
		handle.stop();

		expect(result.tombstonesPurged).toBe(0);
		expect(result.historyPurged).toBe(0);
		expect(result.completedJobsPurged).toBe(0);
		expect(result.deadJobsPurged).toBe(0);
		expect(result.graphLinksPurged).toBe(0);
	});
});
