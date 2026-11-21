import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeProjectionForQuery } from "./umap-projection";

const SCHEMA = `
	CREATE TABLE memories (id TEXT PRIMARY KEY, content TEXT, who TEXT, importance REAL,
		type TEXT, tags TEXT, pinned INTEGER, source_type TEXT, source_id TEXT,
		created_at TEXT, updated_at TEXT);
	CREATE TABLE embeddings (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		source_id TEXT NOT NULL REFERENCES memories(id),
		source_type TEXT NOT NULL,
		vector BLOB NOT NULL,
		dimensions INTEGER NOT NULL,
		created_at TEXT NOT NULL DEFAULT (datetime('now')));
	CREATE INDEX idx_embeddings_source ON embeddings(source_id, source_type);
`;

function setupDb(): { db: Database; dir: string } {
	const dir = mkdtempSync(join(tmpdir(), "signet-umap-test-"));
	const db = new Database(join(dir, "test.db"));
	db.exec(SCHEMA);
	return { db, dir };
}

describe("hasMore pagination regression", () => {
	it("returns hasMore=false when last page is not full (over-fetch by 1)", () => {
		const { db, dir } = setupDb();
		try {
			const fakeBlob = new Uint8Array(8);
			const now = new Date().toISOString();
			for (let i = 0; i < 5; i++) {
				db.prepare("INSERT INTO memories (id, content, created_at, updated_at) VALUES (?, ?, ?, ?)").run(
					`mem-${i}`,
					`memory ${i}`,
					now,
					now,
				);
				db.prepare(
					"INSERT INTO embeddings (source_id, source_type, vector, dimensions, created_at) VALUES (?, 'memory', ?, 4, ?)",
				).run(`mem-${i}`, fakeBlob, now);
			}

			const result = computeProjectionForQuery(db, 2, { limit: 3, offset: 0 });
			expect(result.count).toBe(3);
			expect(result.hasMore).toBe(true);

			const page2 = computeProjectionForQuery(db, 2, { limit: 3, offset: 3 });
			expect(page2.count).toBe(2);
			expect(page2.hasMore).toBe(false);

			const allAtOnce = computeProjectionForQuery(db, 2, { limit: 5, offset: 0 });
			expect(allAtOnce.count).toBe(5);
			expect(allAtOnce.hasMore).toBe(false);
		} finally {
			db.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("escapes LIKE metacharacters in projection query filter", () => {
		const { db, dir } = setupDb();
		try {
			const fakeBlob = new Uint8Array(8);
			const now = new Date().toISOString();
			db.prepare("INSERT INTO memories (id, content, type, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(
				"mem-percent",
				"contains percent sign",
				"fact",
				now,
				now,
			);
			db.prepare(
				"INSERT INTO embeddings (source_id, source_type, vector, dimensions, created_at) VALUES (?, 'memory', ?, ?, ?)",
			).run("mem-percent", fakeBlob, 4, now);

			const result = computeProjectionForQuery(db, 2, {
				limit: 10,
				filters: { query: "%" },
			});
			expect(result.count).toBe(0);
			expect(result.total).toBe(0);
		} finally {
			db.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("escapes LIKE metacharacters in projection tag filters", () => {
		const { db, dir } = setupDb();
		try {
			const fakeBlob = new Uint8Array(8);
			const now = new Date().toISOString();
			db.prepare("INSERT INTO memories (id, content, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(
				"mem-tagged",
				"tagged memory",
				"work,urgent",
				now,
				now,
			);
			db.prepare(
				"INSERT INTO embeddings (source_id, source_type, vector, dimensions, created_at) VALUES (?, 'memory', ?, ?, ?)",
			).run("mem-tagged", fakeBlob, 4, now);

			const result = computeProjectionForQuery(db, 2, {
				limit: 10,
				filters: { tags: ["%"] },
			});
			expect(result.count).toBe(0);
			expect(result.total).toBe(0);
		} finally {
			db.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("detects hasMore=true when toEmbeddingRow discards rows and more pages exist", () => {
		const { db, dir } = setupDb();
		try {
			const fakeBlob = new Uint8Array(8);
			const baseTime = new Date("2026-01-01T00:00:00Z");

			for (let i = 0; i < 6; i++) {
				const t = new Date(baseTime.getTime() + i * 1000).toISOString();
				db.prepare("INSERT INTO memories (id, content, created_at, updated_at) VALUES (?, ?, ?, ?)").run(
					`mem-${i}`,
					`memory ${i}`,
					t,
					t,
				);
			}

			for (let i = 0; i < 6; i++) {
				if (i === 3) {
					db.prepare(
						"INSERT INTO embeddings (source_id, source_type, vector, dimensions, created_at) VALUES (?, 'memory', ?, ?, ?)",
					).run("mem-3", "not-a-blob", 4, new Date(baseTime.getTime() + 3 * 1000).toISOString());
				} else {
					db.prepare(
						"INSERT INTO embeddings (source_id, source_type, vector, dimensions, created_at) VALUES (?, 'memory', ?, ?, ?)",
					).run(`mem-${i}`, fakeBlob, 4, new Date(baseTime.getTime() + i * 1000).toISOString());
				}
			}

			const page1 = computeProjectionForQuery(db, 2, { limit: 2, offset: 0 });
			expect(page1.total).toBe(5);
			expect(page1.count).toBe(2);
			expect(page1.hasMore).toBe(true);

			const page2 = computeProjectionForQuery(db, 2, { limit: 2, offset: 2 });
			expect(page2.total).toBe(5);
			expect(page2.count).toBe(2);
			expect(page2.hasMore).toBe(true);

			const allRows = computeProjectionForQuery(db, 2, { limit: 10, offset: 0 });
			expect(allRows.count).toBe(5);
			expect(allRows.hasMore).toBe(false);
		} finally {
			db.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
