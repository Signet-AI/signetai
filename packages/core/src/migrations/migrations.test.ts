import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

/**
 * Tests for the migration framework.
 *
 * NOTE: The migration runner is being created concurrently by the schema-agent.
 * These tests document expected behavior. If the import fails, the migration
 * module hasn't been created yet — the integration pass will finalize.
 */
import { up as sessionSummaryUniqueness } from "./046-session-summary-uniqueness";
import { up as agentScopedTemporalUniqueness } from "./047-agent-scoped-temporal-uniqueness";
import { MIGRATIONS, runMigrations } from "./index";

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
		const migrations = db.query("SELECT version, applied_at FROM schema_migrations ORDER BY version").all() as Array<{
			version: number;
			applied_at: string;
		}>;
		expect(migrations.length).toBe(MIGRATIONS.length);
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
		expect(migrations[18].version).toBe(19);
		expect(migrations[21].version).toBe(22);
		expect(migrations[23].version).toBe(24);
	});

	test("re-running migrations is idempotent", () => {
		db = createFreshDb();
		runMigrations(db);
		// running again should not throw
		runMigrations(db);

		const migrations = db.query("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{
			version: number;
		}>;
		// same number of migration records (no duplicates)
		const uniqueVersions = new Set(migrations.map((m) => m.version));
		expect(uniqueVersions.size).toBe(migrations.length);
	});

	test("all expected tables exist after migration", () => {
		db = createFreshDb();
		runMigrations(db);

		const tables = db.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{
			name: string;
		}>;
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

		// v12 tables
		expect(tableNames).toContain("scheduled_tasks");
		expect(tableNames).toContain("task_runs");

		// v13 tables
		expect(tableNames).toContain("ingestion_jobs");

		// v14 tables
		expect(tableNames).toContain("telemetry_events");

		// v19 tables (knowledge architecture)
		expect(tableNames).toContain("entity_aspects");
		expect(tableNames).toContain("entity_attributes");
		expect(tableNames).toContain("entity_dependencies");
		expect(tableNames).toContain("task_meta");

		// v20 tables (predictor reporting)
		expect(tableNames).toContain("predictor_comparisons");
		expect(tableNames).toContain("predictor_training_log");
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

		const fts = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%fts%'").all() as Array<{
			name: string;
		}>;
		expect(fts.length).toBeGreaterThanOrEqual(1);
	});

	test("schema_migrations_audit records are created", () => {
		db = createFreshDb();
		runMigrations(db);

		const audits = db.query("SELECT version, applied_at FROM schema_migrations_audit").all() as Array<{
			version: number;
			applied_at: string;
		}>;
		expect(audits.length).toBe(MIGRATIONS.length);
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

	test("session_memories has structural feature columns after migration 020", () => {
		db = createFreshDb();
		runMigrations(db);

		const cols = db.query("PRAGMA table_info(session_memories)").all() as Array<{
			name: string;
		}>;
		const colNames = cols.map((c) => c.name);
		expect(colNames).toContain("entity_slot");
		expect(colNames).toContain("aspect_slot");
		expect(colNames).toContain("is_constraint");
		expect(colNames).toContain("structural_density");
	});

	test("path feedback tables and session path_json column exist after migration 041", () => {
		db = createFreshDb();
		runMigrations(db);

		const tableRows = db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
			name: string;
		}>;
		const tableNames = new Set(tableRows.map((row) => row.name));
		expect(tableNames.has("path_feedback_events")).toBe(true);
		expect(tableNames.has("path_feedback_stats")).toBe(true);
		expect(tableNames.has("entity_retrieval_stats")).toBe(true);
		expect(tableNames.has("entity_cooccurrence")).toBe(true);
		expect(tableNames.has("path_feedback_sessions")).toBe(true);

		const cols = db.query("PRAGMA table_info(session_memories)").all() as Array<{
			name: string;
		}>;
		expect(cols.map((col) => col.name)).toContain("path_json");
	});

	test("session_memories has agent_id and agent-scoped uniqueness after migration 042", () => {
		db = createFreshDb();
		runMigrations(db);

		const cols = db.query("PRAGMA table_info(session_memories)").all() as Array<{
			name: string;
		}>;
		expect(cols.map((col) => col.name)).toContain("agent_id");

		const now = new Date().toISOString();
		db.prepare(
			`INSERT INTO session_memories
			 (id, session_key, agent_id, memory_id, source, effective_score,
			  final_score, rank, was_injected, fts_hit_count, created_at)
			 VALUES (?, ?, ?, ?, 'effective', 0.9, 0.9, 0, 1, 0, ?)`,
		).run("sm-1", "session-x", "agent-a", "mem-x", now);

		expect(() =>
			db
				.prepare(
					`INSERT INTO session_memories
					 (id, session_key, agent_id, memory_id, source, effective_score,
					  final_score, rank, was_injected, fts_hit_count, created_at)
					 VALUES (?, ?, ?, ?, 'effective', 0.9, 0.9, 0, 1, 0, ?)`,
				)
				.run("sm-2", "session-x", "agent-a", "mem-x", now),
		).toThrow();

		db.prepare(
			`INSERT INTO session_memories
			 (id, session_key, agent_id, memory_id, source, effective_score,
			  final_score, rank, was_injected, fts_hit_count, created_at)
			 VALUES (?, ?, ?, ?, 'effective', 0.9, 0.9, 0, 1, 0, ?)`,
		).run("sm-3", "session-x", "agent-b", "mem-x", now);
	});

	test("migration 046 keeps multi-agent session summaries upgrade-safe", () => {
		db = createFreshDb();
		db.exec(`
			CREATE TABLE session_summaries (
				id TEXT PRIMARY KEY,
				project TEXT,
				depth INTEGER NOT NULL DEFAULT 0,
				kind TEXT NOT NULL,
				content TEXT NOT NULL,
				token_count INTEGER,
				earliest_at TEXT NOT NULL,
				latest_at TEXT NOT NULL,
				session_key TEXT,
				harness TEXT,
				agent_id TEXT NOT NULL DEFAULT 'default',
				source_type TEXT,
				source_ref TEXT,
				meta_json TEXT,
				created_at TEXT NOT NULL
			);
			CREATE TABLE session_summary_children (
				parent_id TEXT NOT NULL,
				child_id TEXT NOT NULL,
				ordinal INTEGER NOT NULL,
				PRIMARY KEY (parent_id, child_id)
			);
			CREATE TABLE session_summary_memories (
				summary_id TEXT NOT NULL,
				memory_id TEXT NOT NULL,
				PRIMARY KEY (summary_id, memory_id)
			);
		`);

		const now = new Date().toISOString();
		db.prepare(
			`INSERT INTO session_summaries (
				id, depth, kind, content, earliest_at, latest_at,
				session_key, harness, agent_id, source_type, created_at
			) VALUES (?, 0, 'session', ?, ?, ?, ?, 'codex', ?, 'summary', ?)`,
		).run("sum-a", "agent a summary", now, now, "sess-1", "agent-a", now);
		db.prepare(
			`INSERT INTO session_summaries (
				id, depth, kind, content, earliest_at, latest_at,
				session_key, harness, agent_id, source_type, created_at
			) VALUES (?, 0, 'session', ?, ?, ?, ?, 'codex', ?, 'summary', ?)`,
		).run("sum-b", "agent b summary", now, now, "sess-1", "agent-b", now);

		expect(() => sessionSummaryUniqueness(db)).not.toThrow();
	});

	test("migration 046 deduplicates same-agent retry rows before adding uniqueness", () => {
		db = createFreshDb();
		db.exec(`
			CREATE TABLE session_summaries (
				id TEXT PRIMARY KEY,
				project TEXT,
				depth INTEGER NOT NULL DEFAULT 0,
				kind TEXT NOT NULL,
				content TEXT NOT NULL,
				token_count INTEGER,
				earliest_at TEXT NOT NULL,
				latest_at TEXT NOT NULL,
				session_key TEXT,
				harness TEXT,
				agent_id TEXT NOT NULL DEFAULT 'default',
				source_type TEXT,
				source_ref TEXT,
				meta_json TEXT,
				created_at TEXT NOT NULL
			);
			CREATE TABLE session_summary_children (
				parent_id TEXT NOT NULL,
				child_id TEXT NOT NULL,
				ordinal INTEGER NOT NULL,
				PRIMARY KEY (parent_id, child_id)
			);
			CREATE TABLE session_summary_memories (
				summary_id TEXT NOT NULL,
				memory_id TEXT NOT NULL,
				PRIMARY KEY (summary_id, memory_id)
			);
		`);

		const now = new Date().toISOString();
		const later = new Date(Date.now() + 1000).toISOString();
		db.prepare(
			`INSERT INTO session_summaries (
				id, depth, kind, content, earliest_at, latest_at,
				session_key, harness, agent_id, source_type, created_at
			) VALUES (?, 0, 'session', ?, ?, ?, ?, 'codex', ?, 'summary', ?)`,
		).run("sum-older", "older summary", now, now, "sess-dup", "agent-a", now);
		db.prepare(
			`INSERT INTO session_summaries (
				id, depth, kind, content, earliest_at, latest_at,
				session_key, harness, agent_id, source_type, created_at
			) VALUES (?, 0, 'session', ?, ?, ?, ?, 'codex', ?, 'summary', ?)`,
		).run("sum-newer", "newer summary", now, later, "sess-dup", "agent-a", later);
		db.prepare(`INSERT INTO session_summary_memories (summary_id, memory_id) VALUES ('sum-older', 'mem-1')`).run();

		expect(() => sessionSummaryUniqueness(db)).not.toThrow();

		const rows = db
			.query<{ id: string }, []>(
				"SELECT id FROM session_summaries WHERE agent_id = 'agent-a' AND session_key = 'sess-dup'",
			)
			.all();
		expect(rows.map((row) => row.id)).toEqual(["sum-newer"]);

		const links = db
			.query<{ summary_id: string; memory_id: string }, []>(
				"SELECT summary_id, memory_id FROM session_summary_memories WHERE memory_id = 'mem-1'",
			)
			.all();
		expect(links).toEqual([{ summary_id: "sum-newer", memory_id: "mem-1" }]);
	});

	test("migration 047 deterministically keeps the newest transcript row per agent/session", () => {
		db = createFreshDb();
		db.exec(`
			CREATE TABLE session_transcripts (
				session_key TEXT NOT NULL,
				content TEXT NOT NULL,
				harness TEXT,
				project TEXT,
				agent_id TEXT,
				created_at TEXT NOT NULL,
				updated_at TEXT
			);
			CREATE TABLE session_summaries (
				id TEXT PRIMARY KEY,
				project TEXT,
				depth INTEGER NOT NULL DEFAULT 0,
				kind TEXT NOT NULL,
				content TEXT NOT NULL,
				token_count INTEGER,
				earliest_at TEXT NOT NULL,
				latest_at TEXT NOT NULL,
				session_key TEXT,
				harness TEXT,
				agent_id TEXT NOT NULL DEFAULT 'default',
				source_type TEXT,
				source_ref TEXT,
				meta_json TEXT,
				created_at TEXT NOT NULL
			);
		`);

		db.prepare(
			`INSERT INTO session_transcripts
			 (session_key, content, harness, project, agent_id, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		).run(
			"sess-1",
			"older transcript",
			"codex",
			"proj",
			"agent-a",
			"2026-03-25T10:00:00.000Z",
			"2026-03-25T10:01:00.000Z",
		);
		db.prepare(
			`INSERT INTO session_transcripts
			 (session_key, content, harness, project, agent_id, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		).run(
			"sess-1",
			"newer transcript with more detail",
			"codex",
			"proj",
			"agent-a",
			"2026-03-25T10:00:00.000Z",
			"2026-03-25T10:05:00.000Z",
		);

		expect(() => agentScopedTemporalUniqueness(db)).not.toThrow();

		const rows = db
			.query<{ content: string }, []>(
				"SELECT content FROM session_transcripts WHERE agent_id = 'agent-a' AND session_key = 'sess-1'",
			)
			.all();
		expect(rows).toEqual([{ content: "newer transcript with more detail" }]);
	});

	test("entities table has pinning columns after migration 022", () => {
		db = createFreshDb();
		runMigrations(db);

		const cols = db.query("PRAGMA table_info(entities)").all() as Array<{
			name: string;
		}>;
		const colNames = cols.map((c) => c.name);
		expect(colNames).toContain("pinned");
		expect(colNames).toContain("pinned_at");
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
		db.run("CREATE INDEX IF NOT EXISTS idx_memories_content_hash ON memories(content_hash)");

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
			.query("SELECT id, content_hash FROM memories WHERE id IN ('old1', 'new1') ORDER BY id")
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
		const cols = db.query("PRAGMA table_info(memories)").all() as Array<{ name: string }>;
		const colNames = cols.map((c) => c.name);
		expect(colNames).toContain("content_hash");
		expect(colNames).toContain("is_deleted");

		// Verify v2 tables exist
		const tables = db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
		const tableNames = tables.map((t) => t.name);
		expect(tableNames).toContain("memory_history");
		expect(tableNames).toContain("memory_jobs");
		expect(tableNames).toContain("entities");

		// All migrations should now be recorded
		const migrations = db.query("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{
			version: number;
		}>;
		expect(migrations.length).toBe(MIGRATIONS.length);
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

		const cols = db.query("PRAGMA table_info(memories)").all() as Array<{ name: string }>;
		const colNames = cols.map((c) => c.name);
		expect(colNames).toContain("content_hash");
		expect(colNames).toContain("is_deleted");

		const migrations = db.query("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{
			version: number;
		}>;
		expect(migrations.length).toBe(MIGRATIONS.length);
	});

	test("DB with existing v1 schema only gets v2 migration", () => {
		db = createFreshDb();

		// Apply migrations once to get full schema
		runMigrations(db);

		const countBefore = (db.query("SELECT COUNT(*) as count FROM schema_migrations_audit").get() as { count: number })
			.count;

		// Run again — should not add new audit records
		runMigrations(db);

		const countAfter = (db.query("SELECT COUNT(*) as count FROM schema_migrations_audit").get() as { count: number })
			.count;

		expect(countAfter).toBe(countBefore);
	});

	test("phantom migration repair: dropped table triggers re-run", () => {
		db = createFreshDb();
		runMigrations(db);

		// Record audit count before repair (v14 should have 1 entry)
		const auditBefore = db
			.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM schema_migrations_audit WHERE version = 14")
			.get();
		expect(auditBefore?.count).toBe(1);

		// Drop a table that v14 created, simulating a phantom migration
		db.run("DROP TABLE telemetry_events");

		// Verify it's gone
		const before = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='telemetry_events'").all();
		expect(before.length).toBe(0);

		// Re-run — phantom repair should detect the missing table,
		// remove the v14 record, and re-run it
		runMigrations(db);

		// Table should be recreated
		const after = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='telemetry_events'").all();
		expect(after.length).toBe(1);

		// All versions should be recorded
		const migrations = db
			.query<{ version: number }, []>("SELECT version FROM schema_migrations ORDER BY version")
			.all();
		expect(migrations.length).toBe(MIGRATIONS.length);

		// Audit history preserved: original entry plus new re-run entry
		const auditAfter = db
			.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM schema_migrations_audit WHERE version = 14")
			.get();
		expect(auditAfter?.count).toBe((auditBefore?.count ?? 0) + 1);
	});

	test("set-based skip handles gaps from phantom repair", () => {
		db = createFreshDb();
		runMigrations(db);

		// Simulate phantom state: keep schema_migrations rows but drop the
		// tables those migrations created. Dropping session_memories also
		// cascades to v20, v23, and v25 (they declare columns on that table),
		// so repairPhantomMigrations removes records for v14, v15, v16, v20,
		// v23, and v25. The set-based runner then re-executes all six in order;
		// v15 re-creates session_memories before v20's addColumnIfMissing runs.
		db.run("DROP TABLE IF EXISTS telemetry_events");
		db.run("DROP TABLE IF EXISTS session_memories");
		db.run("DROP TABLE IF EXISTS session_checkpoints");

		// Re-run — phantom repair removes stale records, set-based runner
		// fills all gaps in version order
		runMigrations(db);

		// All tables restored
		const tables = db
			.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
			.all();
		const tableNames = tables.map((t) => t.name);
		expect(tableNames).toContain("telemetry_events");
		expect(tableNames).toContain("session_memories");
		expect(tableNames).toContain("session_checkpoints");

		// All versions present
		const migrations = db
			.query<{ version: number }, []>("SELECT version FROM schema_migrations ORDER BY version")
			.all();
		expect(migrations.length).toBe(MIGRATIONS.length);
	});

	test("post-DDL verification: all declared artifacts exist after migration", () => {
		db = createFreshDb();

		// We can't easily inject a broken migration into the real list,
		// so we verify the mechanism by checking that after a successful
		// run, all declared artifacts actually exist
		runMigrations(db);

		const tables = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table'").all();
		const tableNames = new Set(tables.map((t) => t.name));

		for (const m of MIGRATIONS) {
			if (!m.artifacts) continue;
			if (m.artifacts.tables) {
				for (const t of m.artifacts.tables) {
					expect(tableNames.has(t)).toBe(true);
				}
			}
			if (m.artifacts.columns) {
				for (const col of m.artifacts.columns) {
					const cols = db.query<{ name: string }, []>(`PRAGMA table_info("${col.table}")`).all();
					const colNames = cols.map((c) => c.name);
					expect(colNames).toContain(col.column);
				}
			}
		}
	});
});
