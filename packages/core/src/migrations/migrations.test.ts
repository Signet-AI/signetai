/**
 * Tests for the migration framework.
 *
 * NOTE: The migration runner is being created concurrently by the schema-agent.
 * These tests document expected behavior. If the import fails, the migration
 * module hasn't been created yet — the integration pass will finalize.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

// The migration runner should be importable from the migrations index
// If this import fails, the module hasn't been created yet
import { runMigrations } from "./index";

function createFreshDb(): Database {
	return new Database(":memory:");
}

describe("migration framework", () => {
	let db: Database;

	afterEach(() => {
		if (db) db.close();
	});

	test("fresh DB gets all migrations applied", () => {
		db = createFreshDb();
		runMigrations(db);

		// schema_migrations table should exist with version as PK
		const migrations = db
			.query(
				"SELECT version, applied_at FROM schema_migrations ORDER BY version",
			)
			.all() as Array<{ version: number; applied_at: string }>;
		expect(migrations.length).toBe(18);
		expect(migrations[0].version).toBe(1);
		expect(migrations[1].version).toBe(2);
		expect(migrations[2].version).toBe(3);
		expect(migrations[3].version).toBe(4);
		expect(migrations[4].version).toBe(5);
		expect(migrations[5].version).toBe(6);
		expect(migrations[6].version).toBe(7);
		expect(migrations[7].version).toBe(8);
		expect(migrations[8].version).toBe(9);
		expect(migrations[9].version).toBe(10);
		expect(migrations[10].version).toBe(11);
		expect(migrations[11].version).toBe(12);
		expect(migrations[12].version).toBe(13);
		expect(migrations[13].version).toBe(14);
		expect(migrations[14].version).toBe(15);
		expect(migrations[15].version).toBe(16);
		expect(migrations[16].version).toBe(17);
		expect(migrations[17].version).toBe(18);
	});

	test("re-running migrations is idempotent", () => {
		db = createFreshDb();
		runMigrations(db);
		// running again should not throw
		runMigrations(db);

		const migrations = db
			.query("SELECT version FROM schema_migrations ORDER BY version")
			.all() as Array<{ version: number }>;
		// same number of migration records (no duplicates)
		const uniqueVersions = new Set(migrations.map((m) => m.version));
		expect(uniqueVersions.size).toBe(migrations.length);
	});

	test("all expected tables exist after migration", () => {
		db = createFreshDb();
		runMigrations(db);

		const tables = db
			.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
			.all() as Array<{ name: string }>;
		const tableNames = tables.map((t) => t.name);

		// v1 tables
		expect(tableNames).toContain("memories");
		expect(tableNames).toContain("conversations");
		expect(tableNames).toContain("embeddings");
		expect(tableNames).toContain("schema_migrations");

		// v2 tables
		expect(tableNames).toContain("memory_history");
		expect(tableNames).toContain("memory_jobs");
		expect(tableNames).toContain("entities");
		expect(tableNames).toContain("relations");
		expect(tableNames).toContain("memory_entity_mentions");
		expect(tableNames).toContain("schema_migrations_audit");

		// v7 tables
		expect(tableNames).toContain("documents");
		expect(tableNames).toContain("document_memories");
		expect(tableNames).toContain("connectors");

		// v9 tables
		expect(tableNames).toContain("summary_jobs");

		// v10 tables
		expect(tableNames).toContain("umap_cache");

		// v11 tables
		expect(tableNames).toContain("session_scores");

		// v15 tables
		expect(tableNames).toContain("decisions");
		expect(tableNames).toContain("contradictions");

		// v16 tables
		expect(tableNames).toContain("session_metrics");
	});

	test("memories table has expected v2 columns", () => {
		db = createFreshDb();
		runMigrations(db);

		const columns = db.query("PRAGMA table_info(memories)").all() as Array<{
			name: string;
		}>;
		const colNames = columns.map((c) => c.name);

		// v1 columns
		expect(colNames).toContain("id");
		expect(colNames).toContain("content");
		expect(colNames).toContain("type");
		expect(colNames).toContain("confidence");

		// v2 columns
		expect(colNames).toContain("content_hash");
		expect(colNames).toContain("normalized_content");
		expect(colNames).toContain("is_deleted");
		expect(colNames).toContain("pinned");
		expect(colNames).toContain("importance");
		expect(colNames).toContain("extraction_status");
		expect(colNames).toContain("update_count");
		expect(colNames).toContain("access_count");
	});

	test("FTS5 table exists after migration", () => {
		db = createFreshDb();
		runMigrations(db);

		const fts = db
			.query(
				"SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%fts%'",
			)
			.all() as Array<{ name: string }>;
		expect(fts.length).toBeGreaterThanOrEqual(1);
	});

	test("schema_migrations_audit records are created", () => {
		db = createFreshDb();
		runMigrations(db);

		const audits = db
			.query("SELECT version, applied_at FROM schema_migrations_audit")
			.all() as Array<{ version: number; applied_at: string }>;
		expect(audits.length).toBe(18);
		for (const audit of audits) {
			expect(audit.applied_at).toBeTruthy();
		}
	});

	test("memories table has why and project columns", () => {
		db = createFreshDb();
		runMigrations(db);

		const columns = db.query("PRAGMA table_info(memories)").all() as Array<{
			name: string;
		}>;
		const colNames = columns.map((c) => c.name);

		expect(colNames).toContain("why");
		expect(colNames).toContain("project");
	});

	test("unique partial index on content_hash rejects duplicates", () => {
		db = createFreshDb();
		runMigrations(db);

		const now = new Date().toISOString();
		db.prepare(
			`INSERT INTO memories (id, content, content_hash, type, created_at, updated_at, updated_by)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		).run("a", "hello", "hash1", "fact", now, now, "test");

		// Same content_hash on a non-deleted row should fail
		expect(() =>
			db
				.prepare(
					`INSERT INTO memories (id, content, content_hash, type, created_at, updated_at, updated_by)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
				)
				.run("b", "hello again", "hash1", "fact", now, now, "test"),
		).toThrow();

		// NULL content_hash should not conflict
		db.prepare(
			`INSERT INTO memories (id, content, content_hash, type, created_at, updated_at, updated_by)
			 VALUES (?, ?, NULL, ?, ?, ?, ?)`,
		).run("c", "no hash", "fact", now, now, "test");

		// Soft-deleted row with same hash should not conflict
		db.prepare(
			`INSERT INTO memories (id, content, content_hash, is_deleted, type, created_at, updated_at, updated_by)
			 VALUES (?, ?, ?, 1, ?, ?, ?, ?)`,
		).run("d", "deleted", "hash1", "fact", now, now, "test");
	});

	test("migration 003 deduplicates existing content hashes", () => {
		db = createFreshDb();

		// Run all migrations to get full schema
		runMigrations(db);

		// Simulate pre-v3 state: remove v3+, drop unique index, add non-unique
		db.prepare("DELETE FROM schema_migrations WHERE version >= 3").run();
		db.run("DROP INDEX IF EXISTS idx_memories_content_hash_unique");
		db.run(
			"CREATE INDEX IF NOT EXISTS idx_memories_content_hash ON memories(content_hash)",
		);

		const now = new Date().toISOString();
		const older = "2020-01-01T00:00:00.000Z";
		db.prepare(
			`INSERT INTO memories (id, content, content_hash, type, is_deleted, created_at, updated_at, updated_by)
			 VALUES (?, ?, ?, ?, 0, ?, ?, ?)`,
		).run("old1", "old content", "duphash", "fact", older, older, "test");
		db.prepare(
			`INSERT INTO memories (id, content, content_hash, type, is_deleted, created_at, updated_at, updated_by)
			 VALUES (?, ?, ?, ?, 0, ?, ?, ?)`,
		).run("new1", "new content", "duphash", "fact", now, now, "test");

		// Re-run migrations — v3 should deduplicate and create unique index
		runMigrations(db);

		// The newer row should keep its hash, the older one should be nulled
		const rows = db
			.query(
				"SELECT id, content_hash FROM memories WHERE id IN ('old1', 'new1') ORDER BY id",
			)
			.all() as Array<{ id: string; content_hash: string | null }>;

		const newRow = rows.find((r) => r.id === "new1");
		const oldRow = rows.find((r) => r.id === "old1");
		expect(newRow?.content_hash).toBe("duphash");
		expect(oldRow?.content_hash).toBeNull();
	});

	test("entities table has graph-extended columns after migration", () => {
		db = createFreshDb();
		runMigrations(db);

		const entityCols = db.query("PRAGMA table_info(entities)").all() as Array<{ name: string }>;
		const entityColNames = entityCols.map((c) => c.name);
		expect(entityColNames).toContain("canonical_name");
		expect(entityColNames).toContain("mentions");
		expect(entityColNames).toContain("embedding");

		const relationCols = db.query("PRAGMA table_info(relations)").all() as Array<{ name: string }>;
		const relationColNames = relationCols.map((c) => c.name);
		expect(relationColNames).toContain("mentions");
		expect(relationColNames).toContain("confidence");

		const memCols = db.query("PRAGMA table_info(memory_entity_mentions)").all() as Array<{ name: string }>;
		const memColNames = memCols.map((c) => c.name);
		expect(memColNames).toContain("mention_text");
		expect(memColNames).toContain("confidence");
		expect(memColNames).toContain("created_at");
	});

	test("repairs version 2 stamped by CLI without running migrations", () => {
		db = createFreshDb();

		// Simulate v0.1.64-era schema: run only baseline migration
		// then stamp version 2 the way the buggy CLI did
		db.exec(`
			CREATE TABLE IF NOT EXISTS schema_migrations (
				version INTEGER PRIMARY KEY,
				applied_at TEXT NOT NULL,
				checksum TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS conversations (
				id TEXT PRIMARY KEY,
				session_id TEXT NOT NULL,
				harness TEXT NOT NULL,
				started_at TEXT NOT NULL,
				ended_at TEXT,
				summary TEXT,
				topics TEXT,
				decisions TEXT,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				updated_by TEXT NOT NULL,
				vector_clock TEXT NOT NULL DEFAULT '{}',
				version INTEGER DEFAULT 1,
				manual_override INTEGER DEFAULT 0
			);
			CREATE TABLE IF NOT EXISTS memories (
				id TEXT PRIMARY KEY,
				type TEXT NOT NULL DEFAULT 'fact',
				category TEXT,
				content TEXT NOT NULL,
				confidence REAL DEFAULT 1.0,
				importance REAL DEFAULT 0.5,
				source_id TEXT,
				source_type TEXT,
				tags TEXT,
				who TEXT,
				why TEXT,
				project TEXT,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				updated_by TEXT NOT NULL DEFAULT 'system',
				last_accessed TEXT,
				access_count INTEGER DEFAULT 0,
				vector_clock TEXT NOT NULL DEFAULT '{}',
				version INTEGER DEFAULT 1,
				manual_override INTEGER DEFAULT 0,
				pinned INTEGER DEFAULT 0
			);
			CREATE TABLE IF NOT EXISTS embeddings (
				id TEXT PRIMARY KEY,
				content_hash TEXT NOT NULL UNIQUE,
				vector BLOB NOT NULL,
				dimensions INTEGER NOT NULL,
				source_type TEXT NOT NULL,
				source_id TEXT NOT NULL,
				chunk_text TEXT NOT NULL,
				created_at TEXT NOT NULL
			);
			INSERT OR REPLACE INTO schema_migrations (version, applied_at, checksum)
			VALUES (2, '2025-01-01T00:00:00.000Z', 'quick-setup');
		`);

		// This is the crash scenario from issue #22
		runMigrations(db);

		// Verify v2 columns exist on memories
		const cols = db
			.query("PRAGMA table_info(memories)")
			.all() as Array<{ name: string }>;
		const colNames = cols.map((c) => c.name);
		expect(colNames).toContain("content_hash");
		expect(colNames).toContain("is_deleted");

		// Verify v2 tables exist
		const tables = db
			.query("SELECT name FROM sqlite_master WHERE type='table'")
			.all() as Array<{ name: string }>;
		const tableNames = tables.map((t) => t.name);
		expect(tableNames).toContain("memory_history");
		expect(tableNames).toContain("memory_jobs");
		expect(tableNames).toContain("entities");

		// All migrations should now be recorded
		const migrations = db
			.query("SELECT version FROM schema_migrations ORDER BY version")
			.all() as Array<{ version: number }>;
		expect(migrations.length).toBe(18);
	});

	test("version 1 stamped by old inline migrate upgrades cleanly", () => {
		db = createFreshDb();

		// Simulate v0.1.64 DB: baseline schema + version 1 stamped
		db.exec(`
			CREATE TABLE IF NOT EXISTS schema_migrations (
				version INTEGER PRIMARY KEY,
				applied_at TEXT NOT NULL,
				checksum TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS memories (
				id TEXT PRIMARY KEY,
				type TEXT NOT NULL DEFAULT 'fact',
				content TEXT NOT NULL,
				confidence REAL DEFAULT 1.0,
				importance REAL DEFAULT 0.5,
				tags TEXT,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				updated_by TEXT NOT NULL DEFAULT 'system',
				access_count INTEGER DEFAULT 0,
				pinned INTEGER DEFAULT 0
			);
			INSERT INTO schema_migrations (version, applied_at, checksum)
			VALUES (1, '2025-01-01T00:00:00.000Z', 'inline-migrate');
		`);

		// Should not crash — v1 is legitimate, runs 002+
		runMigrations(db);

		const cols = db
			.query("PRAGMA table_info(memories)")
			.all() as Array<{ name: string }>;
		const colNames = cols.map((c) => c.name);
		expect(colNames).toContain("content_hash");
		expect(colNames).toContain("is_deleted");

		const migrations = db
			.query("SELECT version FROM schema_migrations ORDER BY version")
			.all() as Array<{ version: number }>;
		expect(migrations.length).toBe(18);
	});

	test("DB with existing v1 schema only gets v2 migration", () => {
		db = createFreshDb();

		// Apply migrations once to get full schema
		runMigrations(db);

		const countBefore = (
			db
				.query("SELECT COUNT(*) as count FROM schema_migrations_audit")
				.get() as { count: number }
		).count;

		// Run again — should not add new audit records
		runMigrations(db);

		const countAfter = (
			db
				.query("SELECT COUNT(*) as count FROM schema_migrations_audit")
				.get() as { count: number }
		).count;

		expect(countAfter).toBe(countBefore);
	});
});
