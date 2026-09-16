import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { findSqliteVecExtension } from "@signet/core";
import type { WriteDb } from "./db-accessor";
import { createVecMutationBatch, syncVecDeleteByEmbeddingIds, tableExists } from "./db-helpers";

function createDb(): Database {
	const db = new Database(":memory:");
	db.exec(`
		CREATE TABLE umap_cache (
			id INTEGER PRIMARY KEY,
			dimensions INTEGER NOT NULL,
			embedding_count INTEGER NOT NULL,
			payload TEXT NOT NULL,
			created_at TEXT NOT NULL
		);
		CREATE TABLE embeddings (
			id TEXT PRIMARY KEY,
			source_type TEXT NOT NULL,
			source_id TEXT NOT NULL,
			content_hash TEXT NOT NULL
		);
		CREATE INDEX idx_embeddings_source ON embeddings(source_type, source_id);
		CREATE TABLE vec_embeddings (id TEXT PRIMARY KEY, embedding BLOB NOT NULL);
	`);
	return db;
}

function instrumentDeleteRuns(db: Database): { readonly db: WriteDb; readonly count: () => number } {
	let count = 0;
	const instrumented = {
		exec(sql: string): void {
			db.exec(sql);
		},
		prepare(sql: string) {
			const statement = db.prepare(sql);
			return {
				run(...params: never[]) {
					if (sql.startsWith("DELETE FROM vec_embeddings")) count++;
					return statement.run(...params);
				},
				get(...params: never[]) {
					return statement.get(...params);
				},
				all(...params: never[]) {
					return statement.all(...params);
				},
			};
		},
	};
	return { db: instrumented as unknown as WriteDb, count: () => count };
}

test("tableExists returns false for a missing Bun SQLite table", () => {
	const db = new Database(":memory:");
	try {
		expect(tableExists(db, "missing_table")).toBeFalse();
	} finally {
		db.close();
	}
});

test("syncVecDeleteByEmbeddingIds deletes a large ID batch with bounded set-based statements", () => {
	const db = createDb();
	try {
		const ids = Array.from({ length: 501 }, (_, index) => `embedding-${index}`);
		const insertEmbedding = db.prepare("INSERT INTO embeddings VALUES (?, 'memory', 'memory-1', ?)");
		const insertVector = db.prepare("INSERT INTO vec_embeddings VALUES (?, ?)");
		for (const [index, id] of ids.entries()) {
			insertEmbedding.run(id, `hash-${index}`);
			insertVector.run(id, new Float32Array([1, 0]));
		}
		const instrumented = instrumentDeleteRuns(db);

		expect(syncVecDeleteByEmbeddingIds(instrumented.db, ids)).toBeTrue();
		expect(instrumented.count()).toBe(2);
		expect((db.prepare("SELECT COUNT(*) AS count FROM vec_embeddings").get() as { count: number }).count).toBe(0);
	} finally {
		db.close();
	}
});

test("source cleanup uses set-based vec deletes and preserves the requested hash", () => {
	const db = createDb();
	try {
		db.exec(`
			INSERT INTO embeddings VALUES ('old-a', 'memory', 'memory-1', 'hash-a');
			INSERT INTO embeddings VALUES ('old-b', 'memory', 'memory-1', 'hash-b');
			INSERT INTO embeddings VALUES ('keep', 'memory', 'memory-1', 'hash-keep');
			INSERT INTO vec_embeddings VALUES ('old-a', zeroblob(8));
			INSERT INTO vec_embeddings VALUES ('old-b', zeroblob(8));
			INSERT INTO vec_embeddings VALUES ('keep', zeroblob(8));
		`);
		const instrumented = instrumentDeleteRuns(db);
		const batch = createVecMutationBatch(instrumented.db);

		batch.deleteBySourceExceptHash("memory", "memory-1", "hash-keep");

		expect(instrumented.count()).toBe(1);
		expect(db.prepare("SELECT id FROM vec_embeddings ORDER BY id").all()).toEqual([{ id: "keep" }]);
		batch.deleteBySourceId("memory", "memory-1");

		expect(instrumented.count()).toBe(2);
		expect(db.prepare("SELECT id FROM vec_embeddings ORDER BY id").all()).toEqual([]);
	} finally {
		db.close();
	}
});

test("source range cleanup keeps vec deletes inside the requested agent scope", () => {
	const db = createDb();
	try {
		db.exec("ALTER TABLE embeddings ADD COLUMN agent_id TEXT");
		db.exec(`
			INSERT INTO embeddings (id, source_type, source_id, content_hash, agent_id)
			VALUES ('owned-a', 'source_chunk', 'source-1:file#1', 'hash-a', 'agent-a');
			INSERT INTO embeddings (id, source_type, source_id, content_hash, agent_id)
			VALUES ('owned-b', 'source_chunk', 'source-1:file#2', 'hash-b', 'agent-a');
			INSERT INTO embeddings (id, source_type, source_id, content_hash, agent_id)
			VALUES ('other-agent', 'source_chunk', 'source-1:file#3', 'hash-other', 'agent-b');
			INSERT INTO embeddings (id, source_type, source_id, content_hash, agent_id)
			VALUES ('other-source', 'source_chunk', 'source-2:file#1', 'hash-other-source', 'agent-a');
			INSERT INTO vec_embeddings VALUES ('owned-a', zeroblob(8));
			INSERT INTO vec_embeddings VALUES ('owned-b', zeroblob(8));
			INSERT INTO vec_embeddings VALUES ('other-agent', zeroblob(8));
			INSERT INTO vec_embeddings VALUES ('other-source', zeroblob(8));
		`);
		const instrumented = instrumentDeleteRuns(db);
		const batch = createVecMutationBatch(instrumented.db);

		expect(batch.deleteBySourceIdRange("source_chunk", "source-1:", "source-1:\uffff", "agent-a")).toBeTrue();
		expect(instrumented.count()).toBe(1);
		expect(db.prepare("SELECT id FROM vec_embeddings ORDER BY id").all()).toEqual([
			{ id: "other-agent" },
			{ id: "other-source" },
		]);
	} finally {
		db.close();
	}
});

test("source range cleanup bounds each vector delete statement", () => {
	const db = createDb();
	try {
		const insertEmbedding = db.prepare("INSERT INTO embeddings VALUES (?, 'source_chunk', ?, ?)");
		const insertVector = db.prepare("INSERT INTO vec_embeddings VALUES (?, ?)");
		for (let index = 0; index < 501; index++) {
			const id = `range-${index}`;
			insertEmbedding.run(id, `source-1:file#${index}`, `hash-${index}`);
			insertVector.run(id, new Float32Array([1, 0]));
		}
		const instrumented = instrumentDeleteRuns(db);
		const batch = createVecMutationBatch(instrumented.db);

		expect(batch.deleteBySourceIdRange("source_chunk", "source-1:", "source-1:\uffff")).toBeTrue();
		expect(instrumented.count()).toBe(2);
		expect(db.prepare("SELECT COUNT(*) AS count FROM vec_embeddings").get()).toEqual({ count: 0 });
	} finally {
		db.close();
	}
});

test("a mutation batch invalidates the UMAP cache and probes vec schema once", () => {
	const db = createDb();
	try {
		db.prepare("INSERT INTO umap_cache VALUES (1, 2, 1, '{}', '2026-01-01')").run();
		const prepareSql: string[] = [];
		const instrumented = {
			exec(sql: string): void {
				db.exec(sql);
			},
			prepare(sql: string) {
				prepareSql.push(sql);
				return db.prepare(sql);
			},
		} as unknown as WriteDb;
		const batch = createVecMutationBatch(instrumented);

		batch.insert("new-a", [1, 0]);
		batch.insert("new-b", [0, 1]);

		expect(db.prepare("SELECT COUNT(*) AS count FROM umap_cache").get()).toEqual({ count: 0 });
		expect(prepareSql.filter((sql) => sql.includes("sqlite_master")).length).toBe(1);
	} finally {
		db.close();
	}
});

test("set-based deletes work with the sqlite-vec virtual table", () => {
	const extension = findSqliteVecExtension();
	if (!extension) return;

	const db = createDb();
	try {
		db.loadExtension(extension);
		db.exec("ALTER TABLE embeddings ADD COLUMN agent_id TEXT");
		db.exec(`
			DROP TABLE vec_embeddings;
			CREATE VIRTUAL TABLE vec_embeddings USING vec0(
				id TEXT PRIMARY KEY,
				embedding FLOAT[2] distance_metric=cosine
			);
			INSERT INTO embeddings (id, source_type, source_id, content_hash, agent_id)
			VALUES ('old-a', 'memory', 'memory-1', 'hash-a', 'agent-a');
			INSERT INTO embeddings (id, source_type, source_id, content_hash, agent_id)
			VALUES ('old-b', 'memory', 'memory-1:chunk', 'hash-b', 'agent-a');
			INSERT INTO vec_embeddings VALUES ('old-a', zeroblob(8));
			INSERT INTO vec_embeddings VALUES ('old-b', zeroblob(8));
		`);

		const batch = createVecMutationBatch(db as unknown as WriteDb);
		expect(batch.deleteBySourceIdRange("memory", "memory-1:", "memory-1:\uffff", "agent-a")).toBeTrue();
		expect(batch.deleteByEmbeddingIds(["old-a"])).toBeTrue();
		expect(db.prepare("SELECT COUNT(*) AS count FROM vec_embeddings").get()).toEqual({ count: 0 });
	} finally {
		db.close();
	}
});
