import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { findSqliteVecExtension } from "@signet/core";
import { vectorSearch } from "../../core/src/search";
import { up as embeddingIndexGenerations } from "../../core/src/migrations/091-embedding-index-generations";
import type { DbAccessor, ReadDb, SqliteStatement, WriteDb } from "./db-accessor";
import {
	promoteStagingIndex,
	stageEmbeddingBatch,
	stagingCoverage,
	startEmbeddingIndexMigration,
} from "./embedding-index-migration";
import { beginEmbeddingIndexBuild, ensureEmbeddingIndexState, readEmbeddingIndexState } from "./embedding-index-state";

const VEC_EXTENSION = findSqliteVecExtension();

function failIndexStateUpdateOnce(raw: Database): WriteDb {
	let failed = false;
	return {
		exec(sql: string): void {
			raw.exec(sql);
		},
		prepare(sql: string): SqliteStatement {
			const statement = raw.prepare(sql) as unknown as SqliteStatement;
			if (!sql.includes("UPDATE embedding_index_state")) return statement;
			return {
				run(...params: unknown[]) {
					if (!failed) {
						failed = true;
						throw new Error("simulated index-state update failure");
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

function testAccessor(raw: Database, db: WriteDb): DbAccessor {
	return {
		withWriteTx: (fn) => fn(db),
		withWriteTxAsync: async (fn) => fn(db),
		withReadDb: (fn) => fn(raw as unknown as ReadDb),
		withReadDbAsync: async (fn) => fn(raw as unknown as ReadDb),
		close: () => undefined,
		checkpointWal: () => undefined,
		incrementalVacuum: () => 0,
	};
}

function testTransaction<T>(raw: Database, db: WriteDb, fn: (writeDb: WriteDb) => T): T {
	raw.exec("BEGIN IMMEDIATE");
	try {
		const result = fn(db);
		raw.exec("COMMIT");
		return result;
	} catch (error) {
		raw.exec("ROLLBACK");
		throw error;
	}
}

describe("staging embedding coverage", () => {
	it("requires every active row, including source chunks, at the staged dimensions", () => {
		const raw = new Database(":memory:");
		raw.exec(`
			CREATE TABLE memories (id TEXT PRIMARY KEY, embedding_model TEXT);
			CREATE TABLE embeddings (id TEXT, content_hash TEXT, dimensions INTEGER, created_at TEXT);
			CREATE TABLE embeddings_staging (id TEXT, content_hash TEXT, dimensions INTEGER);
			INSERT INTO embeddings VALUES ('m1', 'memory-hash', 768, '2026-01-01');
			INSERT INTO embeddings VALUES ('s1', 'source-hash', 768, '2026-01-02');
			INSERT INTO embeddings_staging VALUES ('m2', 'memory-hash', 1024);
		`);
		const db = raw as unknown as ReadDb;
		expect(stagingCoverage(db, 1024)).toEqual({
			active: 2,
			staged: 1,
			missing: 1,
			wrongDimensions: 0,
			quarantined: 0,
			ready: false,
		});

		raw.exec("INSERT INTO embeddings_staging VALUES ('s2', 'source-hash', 768)");
		expect(stagingCoverage(db, 1024)).toEqual({
			active: 2,
			staged: 2,
			missing: 0,
			wrongDimensions: 1,
			quarantined: 0,
			ready: false,
		});

		raw.exec("UPDATE embeddings_staging SET dimensions = 1024 WHERE id = 's2'");
		expect(stagingCoverage(db, 1024)).toEqual({
			active: 2,
			staged: 2,
			missing: 0,
			wrongDimensions: 0,
			quarantined: 0,
			ready: true,
		});
	});

	it("does not promote an empty replacement when every active row is quarantined", () => {
		const raw = new Database(":memory:");
		raw.exec(`
			CREATE TABLE embeddings (id TEXT, content_hash TEXT, dimensions INTEGER);
			CREATE TABLE embeddings_staging (id TEXT, content_hash TEXT, dimensions INTEGER);
			CREATE TABLE embedding_index_failures (
				content_hash TEXT,
				target_fingerprint TEXT,
				retry_policy TEXT
			);
			INSERT INTO embeddings VALUES
				('active-a', 'hash-a', 768), ('active-b', 'hash-b', 768);
			INSERT INTO embedding_index_failures VALUES
				('hash-a', 'target-profile', 'quarantined'),
				('hash-b', 'target-profile', 'quarantined');
		`);

		expect(stagingCoverage(raw as unknown as ReadDb, 768, "target-profile")).toEqual({
			active: 2,
			staged: 0,
			missing: 2,
			wrongDimensions: 0,
			quarantined: 2,
			ready: false,
		});
	});

	it("prunes obsolete staged rows while active writes and purges continue", async () => {
		const raw = new Database(":memory:");
		embeddingIndexGenerations(raw as unknown as Parameters<typeof embeddingIndexGenerations>[0]);
		raw.exec(`
			CREATE TABLE embeddings (
				id TEXT PRIMARY KEY, content_hash TEXT UNIQUE, vector BLOB, dimensions INTEGER,
				source_type TEXT, source_id TEXT, chunk_text TEXT, created_at TEXT, agent_id TEXT
			);
			CREATE TABLE embeddings_staging (
				id TEXT PRIMARY KEY, content_hash TEXT UNIQUE, vector BLOB, dimensions INTEGER,
				source_type TEXT, source_id TEXT, chunk_text TEXT, created_at TEXT, agent_id TEXT
			);
			CREATE TABLE vec_embeddings_staging (id TEXT PRIMARY KEY, embedding BLOB);
			INSERT INTO embeddings VALUES
				('memory-embedding', 'memory-hash', X'00', 768, 'memory', 'memory-1', 'memory text', '2026-01-01', 'agent-a'),
				('source-embedding', 'source-hash', X'00', 768, 'source_chunk', 'chunk-1', 'source text', '2026-01-01', 'agent-a');
		`);
		const db = raw as unknown as WriteDb;
		const config = {
			provider: "ollama",
			model: "nomic-embed-text",
			dimensions: 768,
			base_url: "http://127.0.0.1:11434",
		} as const;
		ensureEmbeddingIndexState(db, config);
		beginEmbeddingIndexBuild(db, { ...config, model: "qwen3-embedding:0.6b", dimensions: 4 });
		const accessor = testAccessor(raw, db);

		const first = await stageEmbeddingBatch({
			accessor,
			configured: { ...config, model: "qwen3-embedding:0.6b", dimensions: 4 },
			fetchEmbedding: async (text) => [text.length, 0, 0, 1],
			batchSize: 10,
		});
		expect(first.coverage).toEqual({
			active: 2,
			staged: 2,
			missing: 0,
			wrongDimensions: 0,
			quarantined: 0,
			ready: true,
		});
		expect(raw.prepare("SELECT COUNT(*) AS count FROM vec_embeddings_staging").get()).toEqual({ count: 2 });

		// A source purge during an asynchronous build must not strand an orphan
		// in staging and indefinitely block the count-based promotion gate.
		raw.exec("DELETE FROM embeddings WHERE id = 'source-embedding'");
		const second = await stageEmbeddingBatch({
			accessor,
			configured: { ...config, model: "qwen3-embedding:0.6b", dimensions: 4 },
			fetchEmbedding: async () => [0, 0, 0, 0],
			batchSize: 10,
		});
		expect(second.coverage).toEqual({
			active: 1,
			staged: 1,
			missing: 0,
			wrongDimensions: 0,
			quarantined: 0,
			ready: true,
		});
		expect(raw.prepare("SELECT id FROM vec_embeddings_staging").all()).toHaveLength(1);
	});

	it("fails closed when the target provider returns the wrong vector dimension", async () => {
		const raw = new Database(":memory:");
		embeddingIndexGenerations(raw as unknown as Parameters<typeof embeddingIndexGenerations>[0]);
		raw.exec(`
			CREATE TABLE embeddings (id TEXT PRIMARY KEY, content_hash TEXT UNIQUE, vector BLOB, dimensions INTEGER, source_type TEXT, source_id TEXT, chunk_text TEXT, created_at TEXT, agent_id TEXT);
			CREATE TABLE embeddings_staging (id TEXT PRIMARY KEY, content_hash TEXT UNIQUE, vector BLOB, dimensions INTEGER, source_type TEXT, source_id TEXT, chunk_text TEXT, created_at TEXT, agent_id TEXT);
			CREATE TABLE vec_embeddings_staging (id TEXT PRIMARY KEY, embedding BLOB);
			INSERT INTO embeddings VALUES ('memory-embedding', 'memory-hash', X'00', 768, 'memory', 'memory-1', 'memory text', '2026-01-01', NULL);
		`);
		const db = raw as unknown as WriteDb;
		const config = {
			provider: "ollama",
			model: "nomic-embed-text",
			dimensions: 768,
			base_url: "http://127.0.0.1:11434",
		} as const;
		ensureEmbeddingIndexState(db, config);
		beginEmbeddingIndexBuild(db, { ...config, model: "qwen3-embedding:0.6b", dimensions: 4 });
		const accessor = testAccessor(raw, db);

		await expect(
			stageEmbeddingBatch({
				accessor,
				configured: { ...config, model: "qwen3-embedding:0.6b", dimensions: 4 },
				fetchEmbedding: async () => [1, 2, 3],
				batchSize: 10,
			}),
		).rejects.toThrow("expected 4");
		expect(stagingCoverage(raw as unknown as ReadDb, 4).ready).toBe(false);
	});

	it("quarantines a context-limit row and continues staging later rows", async () => {
		const raw = new Database(":memory:");
		embeddingIndexGenerations(raw as unknown as Parameters<typeof embeddingIndexGenerations>[0]);
		raw.exec(`
			CREATE TABLE embeddings (
				id TEXT PRIMARY KEY, content_hash TEXT UNIQUE, vector BLOB, dimensions INTEGER,
				source_type TEXT, source_id TEXT, chunk_text TEXT, created_at TEXT, agent_id TEXT
			);
			CREATE TABLE embeddings_staging (
				id TEXT PRIMARY KEY, content_hash TEXT UNIQUE, vector BLOB, dimensions INTEGER,
				source_type TEXT, source_id TEXT, chunk_text TEXT, created_at TEXT, agent_id TEXT
			);
			CREATE TABLE vec_embeddings_staging (id TEXT PRIMARY KEY, embedding BLOB);
			CREATE TABLE embedding_index_failures (
				id INTEGER PRIMARY KEY AUTOINCREMENT, content_hash TEXT NOT NULL,
				source_type TEXT NOT NULL, source_id TEXT NOT NULL, agent_id TEXT,
				target_fingerprint TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
				failure_class TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 1,
				retry_policy TEXT NOT NULL DEFAULT 'quarantined', first_failed_at TEXT NOT NULL,
				last_failed_at TEXT NOT NULL, UNIQUE(content_hash, target_fingerprint)
			);
			INSERT INTO embeddings VALUES
				('poison', 'poison-hash', X'00', 768, 'memory', 'memory-poison', 'poison', '2026-01-01', 'agent-a'),
				('later-a', 'later-hash-a', X'00', 768, 'memory', 'memory-a', 'later-a', '2026-01-02', 'agent-a'),
				('later-b', 'later-hash-b', X'00', 768, 'memory', 'memory-b', 'later-b', '2026-01-03', 'agent-a');
		`);
		const db = raw as unknown as WriteDb;
		const active = {
			provider: "ollama",
			model: "custom-a",
			dimensions: 768,
			base_url: "http://127.0.0.1:11434",
		} as const;
		const desired = { ...active, model: "custom-b", dimensions: 4 };
		ensureEmbeddingIndexState(db, active);
		beginEmbeddingIndexBuild(db, desired);
		const accessor = testAccessor(raw, db);
		let fetches = 0;
		const first = await stageEmbeddingBatch({
			accessor,
			configured: desired,
			fetchEmbedding: async (text, _cfg, _role, opts) => {
				fetches++;
				if (text === "poison") {
					opts?.onFailure?.("context_limit");
					return null;
				}
				return [1, 0, 0, 0];
			},
			batchSize: 10,
		});
		expect(first.coverage).toEqual({
			active: 3,
			staged: 2,
			missing: 1,
			wrongDimensions: 0,
			quarantined: 1,
			ready: true,
		});
		expect(raw.prepare("SELECT source_id, failure_class, retry_policy FROM embedding_index_failures").all()).toEqual([
			{ source_id: "memory-poison", failure_class: "context_limit", retry_policy: "quarantined" },
		]);
		expect(fetches).toBe(3);

		const second = await stageEmbeddingBatch({
			accessor,
			configured: desired,
			fetchEmbedding: async () => {
				fetches++;
				return [1, 0, 0, 0];
			},
			batchSize: 10,
		});
		expect(second.staged).toBe(0);
		expect(second.coverage?.ready).toBe(true);
		expect(fetches).toBe(3);

		raw.exec("DELETE FROM embeddings WHERE id = 'poison'");
		const afterPurge = await stageEmbeddingBatch({
			accessor,
			configured: desired,
			fetchEmbedding: async () => [1, 0, 0, 0],
			batchSize: 10,
		});
		expect(afterPurge.coverage).toEqual({
			active: 2,
			staged: 2,
			missing: 0,
			wrongDimensions: 0,
			quarantined: 0,
			ready: true,
		});
	});
});

describe("staging promotion", () => {
	it("swaps full index slots while retaining the previous active slot", async () => {
		const raw = new Database(":memory:");
		embeddingIndexGenerations(raw as unknown as Parameters<typeof embeddingIndexGenerations>[0]);
		raw.exec(`
				CREATE TABLE memories (id TEXT PRIMARY KEY, embedding_model TEXT);
				CREATE TABLE embeddings (id TEXT, content_hash TEXT, dimensions INTEGER, source_type TEXT, source_id TEXT, created_at TEXT);
			CREATE TABLE embeddings_staging (id TEXT, content_hash TEXT UNIQUE, dimensions INTEGER, source_type TEXT, source_id TEXT, created_at TEXT);
			CREATE TABLE vec_embeddings (id TEXT, embedding BLOB);
			CREATE TABLE vec_embeddings_staging (id TEXT, embedding BLOB);
			`);
		const db = raw as unknown as WriteDb;
		const config = {
			provider: "ollama",
			model: "nomic-embed-text",
			dimensions: 768,
			base_url: "http://127.0.0.1:11434",
		} as const;
		ensureEmbeddingIndexState(db, config);
		beginEmbeddingIndexBuild(db, { ...config, model: "qwen3-embedding:0.6b", dimensions: 1024 });
		raw.exec(`
				INSERT INTO memories VALUES ('memory-1', 'nomic-embed-text');
			INSERT INTO embeddings VALUES ('old', 'content', 768, 'memory', 'memory-1', '2026-01-01');
			INSERT INTO embeddings_staging VALUES ('new', 'content', 1024, 'memory', 'memory-1', '2026-01-01');
			INSERT INTO vec_embeddings VALUES ('old', X'00');
			INSERT INTO vec_embeddings_staging VALUES ('new', X'01');
		`);
		const accessor = testAccessor(raw, db);

		expect(await promoteStagingIndex(accessor)).toBe(true);
		expect(raw.prepare("SELECT id, dimensions FROM embeddings").get()).toEqual({ id: "new", dimensions: 1024 });
		expect(raw.prepare("SELECT id, dimensions FROM embeddings_staging").get()).toEqual({ id: "old", dimensions: 768 });
		expect(raw.prepare("SELECT id FROM vec_embeddings").get()).toEqual({ id: "new" });
		expect(raw.prepare("SELECT id FROM vec_embeddings_staging").get()).toEqual({ id: "old" });
	});

	it("keeps old recall through swap and rebuild initialization before publishing the new projection", async () => {
		if (!VEC_EXTENSION) return;
		const raw = new Database(":memory:");
		raw.loadExtension(VEC_EXTENSION);
		embeddingIndexGenerations(raw as unknown as Parameters<typeof embeddingIndexGenerations>[0]);
		raw.exec(`
			CREATE TABLE memories (id TEXT PRIMARY KEY, embedding_model TEXT, type TEXT);
			CREATE TABLE embeddings (id TEXT PRIMARY KEY, content_hash TEXT UNIQUE, vector BLOB, dimensions INTEGER, source_type TEXT, source_id TEXT, created_at TEXT, agent_id TEXT);
			CREATE TABLE embeddings_staging (id TEXT PRIMARY KEY, content_hash TEXT UNIQUE, vector BLOB, dimensions INTEGER, source_type TEXT, source_id TEXT, created_at TEXT, agent_id TEXT);
			CREATE VIRTUAL TABLE vec_embeddings USING vec0(id TEXT PRIMARY KEY, embedding FLOAT[3] distance_metric=cosine);
			CREATE VIRTUAL TABLE vec_embeddings_staging USING vec0(id TEXT PRIMARY KEY, embedding FLOAT[3] distance_metric=cosine);
		`);
		const db = raw as unknown as WriteDb;
		const active = {
			provider: "ollama",
			model: "custom-a",
			dimensions: 3,
			base_url: "http://127.0.0.1:11434",
		} as const;
		const desired = { ...active, model: "custom-b" };
		ensureEmbeddingIndexState(db, active);
		beginEmbeddingIndexBuild(db, desired);
		const vector = new Uint8Array(new Float32Array([1, 0, 0]).buffer);
		const newVector = new Uint8Array(new Float32Array([0, 1, 0]).buffer);
		raw.exec("INSERT INTO memories VALUES ('memory-old', 'custom-a', 'fact'), ('memory-new', 'custom-b', 'fact')");
		raw
			.prepare("INSERT INTO embeddings VALUES (?, ?, ?, 3, 'memory', ?, '2026-01-01', 'agent-a')")
			.run("old", "old-hash", vector, "memory-old");
		raw
			.prepare("INSERT INTO embeddings_staging VALUES (?, ?, ?, 3, 'memory', ?, '2026-01-01', 'agent-a')")
			.run("new", "old-hash", newVector, "memory-new");
		raw.prepare("INSERT INTO vec_embeddings (id, embedding) VALUES (?, ?)").run("old", new Float32Array([1, 0, 0]));
		raw
			.prepare("INSERT INTO vec_embeddings_staging (id, embedding) VALUES (?, ?)")
			.run("new", new Float32Array([0, 1, 0]));

		const searchDb = raw as unknown as Parameters<typeof vectorSearch>[0];
		const oldQuery = new Float32Array([1, 0, 0]);
		const newQuery = new Float32Array([0, 1, 0]);
		const interleavings: Array<Array<{ id: string; score: number }>> = [];
		let transactions = 0;
		const accessor: DbAccessor = {
			withWriteTxAsync: async (fn) => {
				transactions++;
				const result = testTransaction(raw, db, fn);
				if (transactions === 1 || transactions === 2)
					interleavings.push(vectorSearch(searchDb, oldQuery, { limit: 1 }));
				return result;
			},
			withReadDbAsync: async (fn) => fn(raw as unknown as ReadDb),
			close: () => undefined,
		};

		expect(await promoteStagingIndex(accessor)).toBe(true);
		expect(interleavings).toEqual([[{ id: "memory-old", score: 1 }], [{ id: "memory-old", score: 1 }]]);
		expect(vectorSearch(searchDb, newQuery, { limit: 1 })).toEqual([{ id: "memory-new", score: 1 }]);
	});

	it("chunks the virtual projection rebuild and preserves every agent-owned row", async () => {
		if (!VEC_EXTENSION) return;
		const raw = new Database(":memory:");
		raw.loadExtension(VEC_EXTENSION);
		embeddingIndexGenerations(raw as unknown as Parameters<typeof embeddingIndexGenerations>[0]);
		raw.exec(`
			CREATE TABLE memories (id TEXT PRIMARY KEY, embedding_model TEXT);
			CREATE TABLE embeddings (id TEXT PRIMARY KEY, content_hash TEXT UNIQUE, vector BLOB, dimensions INTEGER, source_type TEXT, source_id TEXT, created_at TEXT, agent_id TEXT);
			CREATE TABLE embeddings_staging (id TEXT PRIMARY KEY, content_hash TEXT UNIQUE, vector BLOB, dimensions INTEGER, source_type TEXT, source_id TEXT, created_at TEXT, agent_id TEXT);
			CREATE VIRTUAL TABLE vec_embeddings USING vec0(id TEXT PRIMARY KEY, embedding FLOAT[3] distance_metric=cosine);
			CREATE VIRTUAL TABLE vec_embeddings_staging USING vec0(id TEXT PRIMARY KEY, embedding FLOAT[3] distance_metric=cosine);
		`);
		const db = raw as unknown as WriteDb;
		const active = {
			provider: "ollama",
			model: "custom-a",
			dimensions: 3,
			base_url: "http://127.0.0.1:11434",
		} as const;
		const desired = { ...active, model: "custom-b" };
		ensureEmbeddingIndexState(db, active);
		beginEmbeddingIndexBuild(db, desired);
		const insertActive = raw.prepare("INSERT INTO embeddings VALUES (?, ?, ?, 3, 'memory', ?, ?, ?)");
		const insertStaging = raw.prepare("INSERT INTO embeddings_staging VALUES (?, ?, ?, 3, 'memory', ?, ?, ?)");
		for (let index = 0; index < 205; index++) {
			const id = `embedding-${String(index).padStart(3, "0")}`;
			const agentId = index % 2 === 0 ? "agent-a" : "agent-b";
			const vector = new Uint8Array(new Float32Array([1, 0, 0]).buffer);
			insertActive.run(id, `hash-${id}`, vector, `memory-${id}`, "2026-01-01", agentId);
			insertStaging.run(id, `hash-${id}`, vector, `memory-${id}`, "2026-01-01", agentId);
		}
		let transactions = 0;
		const insertsPerTransaction: number[] = [];
		const accessor: DbAccessor = {
			withWriteTx: (fn) => testTransaction(raw, db, fn),
			withWriteTxAsync: async (fn) => {
				transactions++;
				let inserts = 0;
				const tracked: WriteDb = {
					exec: (sql) => db.exec(sql),
					prepare: (sql) => {
						const statement = db.prepare(sql);
						return {
							run: (...params) => {
								if (sql.includes("INTO vec_embeddings")) inserts++;
								return statement.run(...params);
							},
							get: (...params) => statement.get(...params),
							all: (...params) => statement.all(...params),
						};
					},
				};
				const result = testTransaction(raw, tracked, fn);
				insertsPerTransaction.push(inserts);
				return result;
			},
			withReadDb: (fn) => fn(raw as unknown as ReadDb),
			withReadDbAsync: async (fn) => fn(raw as unknown as ReadDb),
			close: () => undefined,
			checkpointWal: () => undefined,
			incrementalVacuum: () => 0,
		};

		expect(await promoteStagingIndex(accessor)).toBe(true);
		expect(transactions).toBe(15);
		expect(Math.max(...insertsPerTransaction)).toBe(50);
		expect(raw.prepare("SELECT COUNT(*) AS count FROM vec_embeddings_staging").get()).toEqual({ count: 205 });
		expect(raw.prepare("SELECT agent_id FROM embeddings WHERE id = 'embedding-001'").get()).toEqual({
			agent_id: "agent-b",
		});
		expect(raw.prepare("SELECT agent_id FROM embeddings WHERE id = 'embedding-200'").get()).toEqual({
			agent_id: "agent-a",
		});
	});

	it("does not resurrect a canonical embedding purged after the rebuild read", async () => {
		if (!VEC_EXTENSION) return;
		const raw = new Database(":memory:");
		raw.loadExtension(VEC_EXTENSION);
		embeddingIndexGenerations(raw as unknown as Parameters<typeof embeddingIndexGenerations>[0]);
		raw.exec(`
			CREATE TABLE memories (id TEXT PRIMARY KEY, embedding_model TEXT);
			CREATE TABLE embeddings (id TEXT PRIMARY KEY, content_hash TEXT UNIQUE, vector BLOB, dimensions INTEGER, source_type TEXT, source_id TEXT, created_at TEXT, agent_id TEXT);
			CREATE TABLE embeddings_staging (id TEXT PRIMARY KEY, content_hash TEXT UNIQUE, vector BLOB, dimensions INTEGER, source_type TEXT, source_id TEXT, created_at TEXT, agent_id TEXT);
			CREATE VIRTUAL TABLE vec_embeddings USING vec0(id TEXT PRIMARY KEY, embedding FLOAT[3] distance_metric=cosine);
			CREATE VIRTUAL TABLE vec_embeddings_staging USING vec0(id TEXT PRIMARY KEY, embedding FLOAT[3] distance_metric=cosine);
		`);
		const db = raw as unknown as WriteDb;
		const active = {
			provider: "ollama",
			model: "custom-a",
			dimensions: 3,
			base_url: "http://127.0.0.1:11434",
		} as const;
		const desired = { ...active, model: "custom-b" };
		ensureEmbeddingIndexState(db, active);
		beginEmbeddingIndexBuild(db, desired);
		const vector = new Uint8Array(new Float32Array([1, 0, 0]).buffer);
		raw
			.prepare("INSERT INTO embeddings VALUES (?, ?, ?, 3, 'memory', ?, ?, ?)")
			.run("purged", "hash-purged", vector, "memory-purged", "2026-01-01", "agent-a");
		raw
			.prepare("INSERT INTO embeddings_staging VALUES (?, ?, ?, 3, 'memory', ?, ?, ?)")
			.run("staged", "hash-purged", vector, "memory-purged", "2026-01-01", "agent-a");

		let purged = false;
		const accessor: DbAccessor = {
			withWriteTxAsync: async (fn) => testTransaction(raw, db, fn),
			withReadDbAsync: async (fn) => {
				const result = await fn(raw as unknown as ReadDb);
				if (!purged) {
					raw.prepare("DELETE FROM vec_embeddings WHERE id = ?").run("staged");
					raw.prepare("DELETE FROM embeddings WHERE id = ?").run("staged");
					purged = true;
				}
				return result;
			},
			close: () => undefined,
		};

		expect(await promoteStagingIndex(accessor)).toBe(true);
		expect(purged).toBe(true);
		expect(raw.prepare("SELECT COUNT(*) AS count FROM embeddings").get()).toEqual({ count: 0 });
		expect(raw.prepare("SELECT COUNT(*) AS count FROM vec_embeddings").get()).toEqual({ count: 0 });
		expect(readEmbeddingIndexState(raw as unknown as ReadDb)?.state).toBe("ready");
	});

	it("skips a concurrent writer's vec row instead of failing promotion", async () => {
		if (!VEC_EXTENSION) return;
		const raw = new Database(":memory:");
		raw.loadExtension(VEC_EXTENSION);
		embeddingIndexGenerations(raw as unknown as Parameters<typeof embeddingIndexGenerations>[0]);
		raw.exec(`
			CREATE TABLE memories (id TEXT PRIMARY KEY, embedding_model TEXT);
			CREATE TABLE embeddings (id TEXT PRIMARY KEY, content_hash TEXT UNIQUE, vector BLOB, dimensions INTEGER, source_type TEXT, source_id TEXT, created_at TEXT, agent_id TEXT);
			CREATE TABLE embeddings_staging (id TEXT PRIMARY KEY, content_hash TEXT UNIQUE, vector BLOB, dimensions INTEGER, source_type TEXT, source_id TEXT, created_at TEXT, agent_id TEXT);
			CREATE VIRTUAL TABLE vec_embeddings USING vec0(id TEXT PRIMARY KEY, embedding FLOAT[3] distance_metric=cosine);
			CREATE VIRTUAL TABLE vec_embeddings_staging USING vec0(id TEXT PRIMARY KEY, embedding FLOAT[3] distance_metric=cosine);
		`);
		const db = raw as unknown as WriteDb;
		const active = {
			provider: "ollama",
			model: "custom-a",
			dimensions: 3,
			base_url: "http://127.0.0.1:11434",
		} as const;
		ensureEmbeddingIndexState(db, active);
		beginEmbeddingIndexBuild(db, { ...active, model: "custom-b" });
		const vector = new Uint8Array(new Float32Array([1, 0, 0]).buffer);
		raw
			.prepare("INSERT INTO embeddings VALUES (?, ?, ?, 3, 'memory', ?, ?, ?)")
			.run("embedding-a", "hash-a", vector, "memory-a", "2026-01-01", "agent-a");
		raw
			.prepare("INSERT INTO embeddings_staging VALUES (?, ?, ?, 3, 'memory', ?, ?, ?)")
			.run("embedding-a", "hash-a", vector, "memory-a", "2026-01-01", "agent-a");

		let injected = false;
		const accessor: DbAccessor = {
			withWriteTx: (fn) => testTransaction(raw, db, fn),
			withWriteTxAsync: async (fn) => testTransaction(raw, db, fn),
			withReadDb: (fn) => fn(raw as unknown as ReadDb),
			withReadDbAsync: async (fn) => {
				const result = await fn(raw as unknown as ReadDb);
				if (!injected) {
					raw
						.prepare("INSERT INTO vec_embeddings (id, embedding) VALUES (?, ?)")
						.run("embedding-a", new Float32Array([1, 0, 0]));
					injected = true;
				}
				return result;
			},
			close: () => undefined,
			checkpointWal: () => undefined,
			incrementalVacuum: () => 0,
		};

		expect(await promoteStagingIndex(accessor, { vectorBatchSize: 1 })).toBe(true);
		expect(injected).toBe(true);
		expect(readEmbeddingIndexState(raw as unknown as ReadDb)?.state).toBe("ready");
		expect(raw.prepare("SELECT COUNT(*) AS count FROM vec_embeddings").get()).toEqual({ count: 1 });
	});

	it("retries a failed projection chunk without leaving promotion terminally failed", async () => {
		if (!VEC_EXTENSION) return;
		const raw = new Database(":memory:");
		raw.loadExtension(VEC_EXTENSION);
		embeddingIndexGenerations(raw as unknown as Parameters<typeof embeddingIndexGenerations>[0]);
		raw.exec(`
			CREATE TABLE memories (id TEXT PRIMARY KEY, embedding_model TEXT);
			CREATE TABLE embeddings (id TEXT PRIMARY KEY, content_hash TEXT UNIQUE, vector BLOB, dimensions INTEGER, source_type TEXT, source_id TEXT, created_at TEXT, agent_id TEXT);
			CREATE TABLE embeddings_staging (id TEXT PRIMARY KEY, content_hash TEXT UNIQUE, vector BLOB, dimensions INTEGER, source_type TEXT, source_id TEXT, created_at TEXT, agent_id TEXT);
			CREATE VIRTUAL TABLE vec_embeddings USING vec0(id TEXT PRIMARY KEY, embedding FLOAT[3] distance_metric=cosine);
			CREATE VIRTUAL TABLE vec_embeddings_staging USING vec0(id TEXT PRIMARY KEY, embedding FLOAT[3] distance_metric=cosine);
		`);
		const db = raw as unknown as WriteDb;
		const active = {
			provider: "ollama",
			model: "custom-a",
			dimensions: 3,
			base_url: "http://127.0.0.1:11434",
		} as const;
		ensureEmbeddingIndexState(db, active);
		beginEmbeddingIndexBuild(db, { ...active, model: "custom-b" });
		const vector = new Uint8Array(new Float32Array([1, 0, 0]).buffer);
		const insert = raw.prepare("INSERT INTO embeddings VALUES (?, ?, ?, 3, 'memory', ?, ?, ?)");
		const insertStaging = raw.prepare("INSERT INTO embeddings_staging VALUES (?, ?, ?, 3, 'memory', ?, ?, ?)");
		for (const id of ["embedding-a", "embedding-b"]) {
			insert.run(id, `hash-${id}`, vector, `memory-${id}`, "2026-01-01", "agent-a");
			insertStaging.run(id, `hash-${id}`, vector, `memory-${id}`, "2026-01-01", "agent-a");
		}

		let writes = 0;
		let injectedFailure = false;
		const accessor: DbAccessor = {
			withWriteTx: (fn) => testTransaction(raw, db, fn),
			withWriteTxAsync: async (fn) => {
				writes++;
				if (writes === 3 && !injectedFailure) {
					injectedFailure = true;
					throw new Error("transient rebuild write failure");
				}
				return testTransaction(raw, db, fn);
			},
			withReadDb: (fn) => fn(raw as unknown as ReadDb),
			withReadDbAsync: async (fn) => fn(raw as unknown as ReadDb),
			close: () => undefined,
			checkpointWal: () => undefined,
			incrementalVacuum: () => 0,
		};

		expect(
			await promoteStagingIndex(accessor, {
				vectorBatchSize: 1,
				shouldContinue: () => true,
			}),
		).toBe(true);
		expect(injectedFailure).toBe(true);
		expect(readEmbeddingIndexState(raw as unknown as ReadDb)?.state).toBe("ready");
		expect(raw.prepare("SELECT COUNT(*) AS count FROM vec_embeddings_staging").get()).toEqual({ count: 2 });
	});

	it("retries an interrupted post-promotion projection on the next start", async () => {
		if (!VEC_EXTENSION) return;
		const raw = new Database(":memory:");
		raw.loadExtension(VEC_EXTENSION);
		embeddingIndexGenerations(raw as unknown as Parameters<typeof embeddingIndexGenerations>[0]);
		raw.exec(`
			CREATE TABLE memories (id TEXT PRIMARY KEY, embedding_model TEXT);
			CREATE TABLE embeddings (id TEXT PRIMARY KEY, content_hash TEXT UNIQUE, vector BLOB, dimensions INTEGER, source_type TEXT, source_id TEXT, created_at TEXT, agent_id TEXT);
			CREATE TABLE embeddings_staging (id TEXT PRIMARY KEY, content_hash TEXT UNIQUE, vector BLOB, dimensions INTEGER, source_type TEXT, source_id TEXT, created_at TEXT, agent_id TEXT);
			CREATE VIRTUAL TABLE vec_embeddings USING vec0(id TEXT PRIMARY KEY, embedding FLOAT[3] distance_metric=cosine);
			CREATE VIRTUAL TABLE vec_embeddings_staging USING vec0(id TEXT PRIMARY KEY, embedding FLOAT[3] distance_metric=cosine);
		`);
		const db = raw as unknown as WriteDb;
		const active = {
			provider: "ollama",
			model: "custom-a",
			dimensions: 3,
			base_url: "http://127.0.0.1:11434",
		} as const;
		const desired = { ...active, model: "custom-b" };
		ensureEmbeddingIndexState(db, active);
		beginEmbeddingIndexBuild(db, desired);
		raw.exec("INSERT INTO memories VALUES ('memory-1', 'custom-a')");
		const vector = new Uint8Array(new Float32Array([1, 0, 0]).buffer);
		raw
			.prepare("INSERT INTO embeddings VALUES (?, ?, ?, 3, 'memory', ?, '2026-01-01', ?)")
			.run("old", "hash", vector, "memory-1", "agent-a");
		raw
			.prepare("INSERT INTO embeddings_staging VALUES (?, ?, ?, 3, 'memory', ?, '2026-01-01', ?)")
			.run("new", "hash", vector, "memory-1", "agent-a");
		raw.prepare("INSERT INTO vec_embeddings VALUES (?, ?)").run("old", new Float32Array([1, 0, 0]));
		raw.prepare("INSERT INTO vec_embeddings_staging VALUES (?, ?)").run("new", new Float32Array([0, 1, 0]));
		const accessor: DbAccessor = {
			withWriteTx: (fn) => testTransaction(raw, db, fn),
			withWriteTxAsync: async (fn) => testTransaction(raw, db, fn),
			withReadDb: (fn) => fn(raw as unknown as ReadDb),
			withReadDbAsync: async (fn) => fn(raw as unknown as ReadDb),
			close: () => undefined,
			checkpointWal: () => undefined,
			incrementalVacuum: () => 0,
		};
		let promotions = 0;

		await expect(promoteStagingIndex(accessor, { shouldContinue: () => false })).rejects.toThrow(
			"Embedding vector rebuild stopped",
		);
		expect(readEmbeddingIndexState(raw as unknown as ReadDb)?.state).toBe("building");
		expect(readEmbeddingIndexState(raw as unknown as ReadDb)?.staging?.projectionRebuild).toBe(true);
		expect(raw.prepare("SELECT id FROM embeddings").get()).toEqual({ id: "new" });
		expect(raw.prepare("SELECT id FROM vec_embeddings").get()).toEqual({ id: "old" });

		await expect(
			startEmbeddingIndexMigration({
				accessor,
				configured: desired,
				fetchEmbedding: async () => [0, 0, 0],
				checkProvider: async () => ({ available: true }),
				pollMs: 10,
				batchSize: 10,
				onPromoted: () => {
					promotions++;
				},
			}),
		).rejects.toThrow("Embedding migration requires owner");
		expect(promotions).toBe(0);
		expect(readEmbeddingIndexState(raw as unknown as ReadDb)?.state).toBe("building");
	});
	it("keeps the promoted sqlite-vec virtual table queryable", async () => {
		if (!VEC_EXTENSION) return;
		const raw = new Database(":memory:");
		raw.loadExtension(VEC_EXTENSION);
		embeddingIndexGenerations(raw as unknown as Parameters<typeof embeddingIndexGenerations>[0]);
		raw.exec(`
			CREATE TABLE memories (id TEXT PRIMARY KEY, embedding_model TEXT);
			CREATE TABLE embeddings (id TEXT, content_hash TEXT, vector BLOB, dimensions INTEGER, source_type TEXT, source_id TEXT, created_at TEXT);
			CREATE TABLE embeddings_staging (id TEXT, content_hash TEXT UNIQUE, vector BLOB, dimensions INTEGER, source_type TEXT, source_id TEXT, created_at TEXT);
			CREATE VIRTUAL TABLE vec_embeddings USING vec0(id TEXT PRIMARY KEY, embedding FLOAT[3] distance_metric=cosine);
			CREATE VIRTUAL TABLE vec_embeddings_staging USING vec0(id TEXT PRIMARY KEY, embedding FLOAT[3] distance_metric=cosine);
		`);
		const db = raw as unknown as WriteDb;
		const config = {
			provider: "ollama",
			model: "nomic-embed-text",
			dimensions: 3,
			base_url: "http://127.0.0.1:11434",
		} as const;
		ensureEmbeddingIndexState(db, config);
		beginEmbeddingIndexBuild(db, { ...config, model: "qwen3-embedding:0.6b" });
		raw.exec(`
			INSERT INTO memories VALUES ('memory-1', 'nomic-embed-text');
			INSERT INTO embeddings VALUES ('old', 'content', X'0000803F0000000000000000', 3, 'memory', 'memory-1', '2026-01-01');
			INSERT INTO embeddings_staging VALUES ('new', 'content', X'000000000000803F00000000', 3, 'memory', 'memory-1', '2026-01-01');
		`);
		raw.prepare("INSERT INTO vec_embeddings (id, embedding) VALUES (?, ?)").run("old", new Float32Array([1, 0, 0]));
		raw
			.prepare("INSERT INTO vec_embeddings_staging (id, embedding) VALUES (?, ?)")
			.run("new", new Float32Array([0, 1, 0]));
		const accessor: DbAccessor = {
			withWriteTx: (fn) => testTransaction(raw, db, fn),
			withWriteTxAsync: async (fn) => testTransaction(raw, db, fn),
			withReadDb: (fn) => fn(raw as unknown as ReadDb),
			withReadDbAsync: async (fn) => fn(raw as unknown as ReadDb),
			close: () => undefined,
			checkpointWal: () => undefined,
			incrementalVacuum: () => 0,
		};

		expect(await promoteStagingIndex(accessor)).toBe(true);
		const nearest = raw
			.prepare("SELECT id FROM vec_embeddings_staging WHERE embedding MATCH ? AND k = 1")
			.get(new Float32Array([0, 1, 0]));
		expect(nearest).toEqual({ id: "new" });
	});

	it("rolls back vec rebuild when index state commit fails after vector insertion", async () => {
		if (!VEC_EXTENSION) return;
		const raw = new Database(":memory:");
		raw.loadExtension(VEC_EXTENSION);
		embeddingIndexGenerations(raw as unknown as Parameters<typeof embeddingIndexGenerations>[0]);
		raw.exec(`
			CREATE TABLE memories (id TEXT PRIMARY KEY, embedding_model TEXT);
			CREATE TABLE embeddings (id TEXT, content_hash TEXT UNIQUE, vector BLOB, dimensions INTEGER, source_type TEXT, source_id TEXT, created_at TEXT);
			CREATE TABLE embeddings_staging (id TEXT, content_hash TEXT UNIQUE, vector BLOB, dimensions INTEGER, source_type TEXT, source_id TEXT, created_at TEXT);
			CREATE VIRTUAL TABLE vec_embeddings USING vec0(id TEXT PRIMARY KEY, embedding FLOAT[3] distance_metric=cosine);
			CREATE VIRTUAL TABLE vec_embeddings_staging USING vec0(id TEXT PRIMARY KEY, embedding FLOAT[3] distance_metric=cosine);
		`);
		const db = raw as unknown as WriteDb;
		const active = {
			provider: "ollama",
			model: "nomic-embed-text",
			dimensions: 3,
			base_url: "http://127.0.0.1:11434",
		} as const;
		const staged = { ...active, model: "qwen3-embedding:0.6b" };
		ensureEmbeddingIndexState(db, active);
		beginEmbeddingIndexBuild(db, staged);
		raw.exec(`
			INSERT INTO memories VALUES ('memory-1', 'nomic-embed-text');
			INSERT INTO embeddings VALUES ('old', 'shared-content', X'0000803F0000000000000000', 3, 'memory', 'memory-1', '2026-01-01');
			INSERT INTO embeddings_staging VALUES ('new', 'shared-content', X'000000000000803F00000000', 3, 'memory', 'memory-1', '2026-01-01');
		`);
		raw.prepare("INSERT INTO vec_embeddings (id, embedding) VALUES (?, ?)").run("old", new Float32Array([1, 0, 0]));
		raw
			.prepare("INSERT INTO vec_embeddings_staging (id, embedding) VALUES (?, ?)")
			.run("new", new Float32Array([0, 1, 0]));

		const failingDb = failIndexStateUpdateOnce(raw);
		const accessor: DbAccessor = {
			withWriteTx: (fn) => testTransaction(raw, failingDb, fn),
			withWriteTxAsync: async (fn) => testTransaction(raw, failingDb, fn),
			withReadDb: (fn) => fn(raw as unknown as ReadDb),
			withReadDbAsync: async (fn) => fn(raw as unknown as ReadDb),
			close: () => undefined,
			checkpointWal: () => undefined,
			incrementalVacuum: () => 0,
		};

		await expect(promoteStagingIndex(accessor)).rejects.toThrow("simulated index-state update failure");
		expect(readEmbeddingIndexState(raw as unknown as ReadDb)?.state).toBe("building");
		expect(raw.prepare("SELECT id, content_hash FROM embeddings").get()).toEqual({
			id: "old",
			content_hash: "shared-content",
		});
		expect(raw.prepare("SELECT id, content_hash FROM embeddings_staging").get()).toEqual({
			id: "new",
			content_hash: "shared-content",
		});
		expect(raw.prepare("SELECT id FROM vec_embeddings").get()).toEqual({ id: "old" });
		expect(raw.prepare("SELECT id FROM vec_embeddings_staging").get()).toEqual({ id: "new" });
		expect(raw.prepare("SELECT embedding_model FROM memories WHERE id = 'memory-1'").get()).toEqual({
			embedding_model: "nomic-embed-text",
		});
	});
});

describe("staging migration lifecycle", () => {
	it("fails loudly when the killable owner is omitted", async () => {
		const accessor = {} as DbAccessor;
		await expect(
			startEmbeddingIndexMigration({
				accessor,
				configured: { provider: "ollama", model: "custom-embed", dimensions: 3, base_url: "http://127.0.0.1:11434" },
				fetchEmbedding: async () => [0, 0, 0],
				checkProvider: async () => ({ available: true }),
				pollMs: 1,
				batchSize: 1,
			}),
		).rejects.toThrow("Embedding migration requires owner");
	});
});
