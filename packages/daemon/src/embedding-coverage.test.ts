import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { runMigrations } from "@signet/core";
import { countUnembeddedMemories, listStaleEmbeddingRows, listUnembeddedMemories } from "./embedding-coverage";

function insertEmbedding(db: Database, args: { id: string; sourceId: string; contentHash: string }): void {
	db.prepare(
		`INSERT INTO embeddings
		 (id, content_hash, vector, dimensions, source_type, source_id, chunk_text, created_at)
		 VALUES (?, ?, ?, 3, 'memory', ?, 'chunk', datetime('now'))`,
	).run(args.id, args.contentHash, Buffer.from(new Float32Array([0.1, 0.2, 0.3]).buffer), args.sourceId);
}

describe("embedding coverage queries", () => {
	let db: Database;

	beforeEach(() => {
		db = new Database(":memory:");
		runMigrations(db as unknown as Parameters<typeof runMigrations>[0]);
	});

	afterEach(() => {
		db.close();
	});

	it("treats duplicate-hash memories as already covered", () => {
		const now = new Date().toISOString();
		db.prepare(
			`INSERT INTO memories (id, content, content_hash, scope, type, created_at, updated_at, updated_by)
			 VALUES ('mem-a', 'same', 'hash-same', 'scope-a', 'fact', ?, ?, 'test')`,
		).run(now, now);
		db.prepare(
			`INSERT INTO memories (id, content, content_hash, scope, type, created_at, updated_at, updated_by)
			 VALUES ('mem-b', 'same', 'hash-same', 'scope-b', 'fact', ?, ?, 'test')`,
		).run(now, now);
		insertEmbedding(db, { id: "emb-a", sourceId: "mem-a", contentHash: "hash-same" });

		expect(countUnembeddedMemories(db)).toBe(0);
		expect(listUnembeddedMemories(db, 10)).toHaveLength(0);
	});

	it("still flags stale source-linked embeddings when the content hash changed", () => {
		const now = new Date().toISOString();
		db.prepare(
			`INSERT INTO memories (id, content, content_hash, embedding_model, type, created_at, updated_at, updated_by)
			 VALUES ('mem-stale', 'new content', 'hash-new', 'text-embedding-3-small', 'fact', ?, ?, 'test')`,
		).run(now, now);
		insertEmbedding(db, { id: "emb-stale", sourceId: "mem-stale", contentHash: "hash-old" });

		const rows = listStaleEmbeddingRows(db, "text-embedding-3-small", 10);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.id).toBe("mem-stale");
	});
});
