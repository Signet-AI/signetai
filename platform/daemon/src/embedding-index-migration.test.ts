import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { findSqliteVecExtension } from "@signet/core";
import {
	promoteStagingIndex,
	stageEmbeddingBatch,
	stagingCoverage,
	startEmbeddingIndexMigration,
} from "./embedding-index-migration";
import { beginEmbeddingIndexBuild, ensureEmbeddingIndexState } from "./embedding-index-state";
import { up as embeddingIndexGenerations } from "../../core/src/migrations/091-embedding-index-generations";
import type { DbAccessor, ReadDb, WriteDb } from "./db-accessor";

const VEC_EXTENSION = findSqliteVecExtension();

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
		expect(stagingCoverage(db, 1024)).toEqual({ active: 2, staged: 1, missing: 1, wrongDimensions: 0, ready: false });

		raw.exec("INSERT INTO embeddings_staging VALUES ('s2', 'source-hash', 768)");
		expect(stagingCoverage(db, 1024)).toEqual({ active: 2, staged: 2, missing: 0, wrongDimensions: 1, ready: false });

		raw.exec("UPDATE embeddings_staging SET dimensions = 1024 WHERE id = 's2'");
		expect(stagingCoverage(db, 1024)).toEqual({ active: 2, staged: 2, missing: 0, wrongDimensions: 0, ready: true });
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
		const accessor: DbAccessor = {
			withWriteTx: (fn) => fn(db),
			withReadDb: (fn) => fn(raw as unknown as ReadDb),
			close: () => undefined,
		};

		const first = await stageEmbeddingBatch({
			accessor,
			configured: { ...config, model: "qwen3-embedding:0.6b", dimensions: 4 },
			fetchEmbedding: async (text) => [text.length, 0, 0, 1],
			batchSize: 10,
		});
		expect(first.coverage).toEqual({ active: 2, staged: 2, missing: 0, wrongDimensions: 0, ready: true });
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
		expect(second.coverage).toEqual({ active: 1, staged: 1, missing: 0, wrongDimensions: 0, ready: true });
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
		const accessor: DbAccessor = {
			withWriteTx: (fn) => fn(db),
			withReadDb: (fn) => fn(raw as unknown as ReadDb),
			close: () => undefined,
		};

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
});

describe("staging promotion", () => {
	it("swaps full index slots while retaining the previous active slot", () => {
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
		const accessor: DbAccessor = {
			withWriteTx: (fn) => fn(db),
			withReadDb: (fn) => fn(raw as unknown as ReadDb),
			close: () => undefined,
		};

		expect(promoteStagingIndex(accessor)).toBe(true);
		expect(raw.prepare("SELECT id, dimensions FROM embeddings").get()).toEqual({ id: "new", dimensions: 1024 });
		expect(raw.prepare("SELECT id, dimensions FROM embeddings_staging").get()).toEqual({ id: "old", dimensions: 768 });
		expect(raw.prepare("SELECT id FROM vec_embeddings").get()).toEqual({ id: "new" });
		expect(raw.prepare("SELECT id FROM vec_embeddings_staging").get()).toEqual({ id: "old" });
	});

	it("keeps the promoted sqlite-vec virtual table queryable", () => {
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
			withWriteTx: (fn) => {
				raw.exec("BEGIN IMMEDIATE");
				try {
					const result = fn(db);
					raw.exec("COMMIT");
					return result;
				} catch (error) {
					raw.exec("ROLLBACK");
					throw error;
				}
			},
			withReadDb: (fn) => fn(raw as unknown as ReadDb),
			close: () => undefined,
		};

		expect(promoteStagingIndex(accessor)).toBe(true);
		const nearest = raw
			.prepare("SELECT id FROM vec_embeddings WHERE embedding MATCH ? AND k = 1")
			.get(new Float32Array([0, 1, 0]));
		expect(nearest).toEqual({ id: "new" });
	});
});

describe("staging migration lifecycle", () => {
	it("resumes an interrupted build without clearing its inactive vector slot", async () => {
		const raw = new Database(":memory:");
		embeddingIndexGenerations(raw as unknown as Parameters<typeof embeddingIndexGenerations>[0]);
		raw.exec(`
			CREATE TABLE embeddings (id TEXT, content_hash TEXT UNIQUE, vector BLOB, dimensions INTEGER, source_type TEXT, source_id TEXT, chunk_text TEXT, created_at TEXT, agent_id TEXT);
			CREATE TABLE embeddings_staging (id TEXT, content_hash TEXT UNIQUE, vector BLOB, dimensions INTEGER, source_type TEXT, source_id TEXT, chunk_text TEXT, created_at TEXT, agent_id TEXT);
			CREATE TABLE vec_embeddings (id TEXT PRIMARY KEY, embedding BLOB);
			CREATE TABLE vec_embeddings_staging (id TEXT PRIMARY KEY, embedding BLOB);
			INSERT INTO vec_embeddings_staging VALUES ('preserved', X'01');
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
		const accessor: DbAccessor = {
			withWriteTx: (fn) => fn(db),
			withReadDb: (fn) => fn(raw as unknown as ReadDb),
			close: () => undefined,
		};

		const handle = startEmbeddingIndexMigration({
			accessor,
			configured: desired,
			fetchEmbedding: async () => [0, 0, 0],
			checkProvider: async () => ({ available: false }),
			pollMs: 60_000,
			batchSize: 10,
		});
		expect(handle).not.toBeNull();
		await Promise.resolve();
		expect(raw.prepare("SELECT id FROM vec_embeddings_staging").get()).toEqual({ id: "preserved" });
		await handle?.stop();
	});
});
