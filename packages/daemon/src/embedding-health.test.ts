import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { buildEmbeddingHealth } from "./embedding-health";

describe("buildEmbeddingHealth", () => {
	test("reports macOS SQLite guidance when vec table is missing", () => {
		const db = new Database(":memory:");
		db.exec(`
			CREATE TABLE memories (
				id TEXT PRIMARY KEY,
				content TEXT NOT NULL,
				is_deleted INTEGER NOT NULL DEFAULT 0,
				embedding_model TEXT
			);
			CREATE TABLE embeddings (
				id TEXT PRIMARY KEY,
				source_type TEXT NOT NULL,
				source_id TEXT NOT NULL,
				dimensions INTEGER NOT NULL,
				vector BLOB
			);
		`);

		const report = buildEmbeddingHealth(
			db,
			{
				provider: "ollama",
				model: "nomic-embed-text",
				dimensions: 768,
				baseUrl: "http://127.0.0.1:11434",
			},
			{
				provider: "ollama",
				model: "nomic-embed-text",
				available: true,
				base_url: "http://127.0.0.1:11434",
				checkedAt: new Date().toISOString(),
			},
			{
				sqlite: null,
				sqliteAttempt: "/tmp/bad-sqlite.dylib",
				sqliteWarning: "custom sqlite not configured",
				extensionPath: "/tmp/vec0.dylib",
				extensionLoaded: false,
				extensionLoadError: "loadExtension blocked",
			},
		);

		const vec = report.checks.find((check) => check.name === "vec-table-sync");
		expect(vec?.status).toBe("warn");
		expect(vec?.fix).toContain("macOS");
		expect(vec?.detail).toEqual({
			sqlite: null,
			sqliteAttempt: "/tmp/bad-sqlite.dylib",
			sqliteWarning: "custom sqlite not configured",
			extensionPath: "/tmp/vec0.dylib",
			extensionLoaded: false,
			extensionLoadError: "loadExtension blocked",
		});

		db.close();
	});
});
