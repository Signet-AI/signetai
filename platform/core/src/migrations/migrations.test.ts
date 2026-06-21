import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { readMemoriesFtsSql } from "../fts-schema";

/**
 * Tests for the migration framework.
 *
 * NOTE: The migration runner is being created concurrently by the schema-agent.
 * These tests document expected behavior. If the import fails, the migration
 * module hasn't been created yet — the integration pass will finalize.
 */
import { up as sessionSummaryUniqueness } from "./046-session-summary-uniqueness";
import { up as agentScopedTemporalUniqueness } from "./047-agent-scoped-temporal-uniqueness";
import { up as threadHeadsMigration } from "./048-thread-heads";
import { up as ontologyControlPlaneState } from "./070-ontology-control-plane-state";
import { up as documentScopeColumns } from "./080-document-scope-columns";
import { MIGRATIONS, hasPendingMigrations, runMigrations } from "./index";

function createFreshDb(): Database {
	return new Database(":memory:");
}

function installLegacyPorterMemoriesFts(db: Database): void {
	db.exec("DROP TRIGGER IF EXISTS memories_ai");
	db.exec("DROP TRIGGER IF EXISTS memories_ad");
	db.exec("DROP TRIGGER IF EXISTS memories_au");
	db.exec("DROP TABLE IF EXISTS memories_fts");
	db.exec(`
		CREATE VIRTUAL TABLE memories_fts USING fts5(
			content,
			content='memories',
			content_rowid='rowid',
			tokenize='porter unicode61'
		);
	`);
	db.exec(`
		CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
			INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
		END;
	`);
	db.exec(`
		CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
			INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', old.rowid, old.content);
		END;
	`);
	db.exec(`
		CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
			INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', old.rowid, old.content);
			INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
		END;
	`);
	db.exec("INSERT INTO memories_fts(rowid, content) SELECT rowid, content FROM memories");
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

	test("document scope columns backfill from metadata and linked memories", () => {
		db = createFreshDb();
		db.exec(`
			CREATE TABLE documents (
				id TEXT PRIMARY KEY,
				source_url TEXT,
				metadata_json TEXT
			);
			CREATE TABLE memories (
				id TEXT PRIMARY KEY,
				agent_id TEXT,
				project TEXT
			);
			CREATE TABLE document_memories (
				document_id TEXT NOT NULL,
				memory_id TEXT NOT NULL
			);
		`);
		db.query("INSERT INTO documents (id, metadata_json) VALUES (?, ?)").run(
			"doc-metadata",
			JSON.stringify({ signet: { agentId: "agent-meta", project: "/repo/meta" } }),
		);
		db.query("INSERT INTO documents (id, metadata_json) VALUES (?, ?)").run(
			"doc-metadata-authoritative",
			JSON.stringify({ signet: { agentId: "agent-meta", project: "/repo/meta" } }),
		);
		db.query("INSERT INTO documents (id, metadata_json) VALUES ('doc-linked', NULL)").run();
		db.query("INSERT INTO documents (id, metadata_json) VALUES ('doc-default', NULL)").run();
		db.query(
			"INSERT INTO memories (id, agent_id, project) VALUES ('mem-linked', 'agent-linked', '/repo/linked')",
		).run();
		db.query(
			"INSERT INTO memories (id, agent_id, project) VALUES ('mem-conflict', 'agent-conflict', '/repo/conflict')",
		).run();
		db.query("INSERT INTO document_memories (document_id, memory_id) VALUES ('doc-linked', 'mem-linked')").run();
		db.query(
			"INSERT INTO document_memories (document_id, memory_id) VALUES ('doc-metadata-authoritative', 'mem-conflict')",
		).run();

		documentScopeColumns(db);
		documentScopeColumns(db);

		const rows = db.query("SELECT id, agent_id, project FROM documents ORDER BY id").all() as Array<{
			id: string;
			agent_id: string;
			project: string | null;
		}>;
		expect(rows).toEqual([
			{ id: "doc-default", agent_id: "default", project: null },
			{ id: "doc-linked", agent_id: "agent-linked", project: "/repo/linked" },
			{ id: "doc-metadata", agent_id: "agent-meta", project: "/repo/meta" },
			{ id: "doc-metadata-authoritative", agent_id: "agent-meta", project: "/repo/meta" },
		]);
	});

	test("daily reflections allow multiple dashboard-open insights per agent and date", () => {
		db = createFreshDb();
		runMigrations(db);

		const insert = db.prepare(
			`INSERT INTO daily_reflections (id, agent_id, date, summary)
		 VALUES (?, ?, ?, ?)`,
		);

		insert.run("reflection-1", "agent-a", "2026-05-13", "First");
		expect(() => insert.run("reflection-2", "agent-a", "2026-05-13", "Another fresh insight")).not.toThrow();
		expect(() => insert.run("reflection-3", "agent-b", "2026-05-13", "Different agent")).not.toThrow();
		expect(() => insert.run("reflection-4", "agent-a", "2026-05-14", "Different date")).not.toThrow();
	});

	test("daily reflection content keys are unique only within one agent day", () => {
		db = createFreshDb();
		runMigrations(db);

		const insert = db.prepare(
			`INSERT INTO daily_reflections (id, agent_id, date, summary, content_key)
		 VALUES (?, ?, ?, ?, ?)`,
		);

		insert.run("reflection-1", "agent-a", "2026-05-13", "First", "same-question");
		expect(() => insert.run("reflection-2", "agent-a", "2026-05-13", "Duplicate today", "same-question")).toThrow();
		expect(() =>
			insert.run("reflection-3", "agent-a", "2026-05-14", "Legitimate later recurrence", "same-question"),
		).not.toThrow();
		expect(() => insert.run("reflection-4", "agent-b", "2026-05-13", "Different agent", "same-question")).not.toThrow();
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

		const attributeColumns = db.query("PRAGMA table_info(entity_attributes)").all() as Array<{ name: string }>;
		expect(attributeColumns.map((col) => col.name)).toContain("claim_key");
		expect(attributeColumns.map((col) => col.name)).toContain("group_key");

		// v50 tables (dependency audit)
		expect(tableNames).toContain("entity_dependency_history");

		// v66 tables (ontology proposal loop)
		expect(tableNames).toContain("ontology_proposals");

		// v77 tables (entity aliases)
		expect(tableNames).toContain("entity_aliases");
		const aliasIndexes = db.query("PRAGMA index_list(entity_aliases)").all() as Array<{ name: string }>;
		expect(aliasIndexes.map((index) => index.name)).toContain("idx_entity_aliases_active_unique");
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

	test("task_scope_hints exists after migration 054", () => {
		db = createFreshDb();
		runMigrations(db);

		const rows = db
			.query("SELECT name FROM sqlite_master WHERE type='table' AND name='task_scope_hints'")
			.all() as Array<{ name: string }>;
		expect(rows).toHaveLength(1);
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

	test("related_to dependencies require a reason after migration 050", () => {
		db = createFreshDb();
		runMigrations(db);

		const ts = new Date().toISOString();
		db.exec(
			`INSERT INTO entities
			 (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at)
			 VALUES ('ent-a', 'A', 'a', 'project', 'default', 1, '${ts}', '${ts}')`,
		);
		db.exec(
			`INSERT INTO entities
			 (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at)
			 VALUES ('ent-b', 'B', 'b', 'project', 'default', 1, '${ts}', '${ts}')`,
		);

		expect(() =>
			db.exec(
				`INSERT INTO entity_dependencies
				 (id, source_entity_id, target_entity_id, agent_id, dependency_type, strength, confidence, created_at, updated_at)
				 VALUES ('dep-missing', 'ent-a', 'ent-b', 'default', 'related_to', 0.3, 0.5, '${ts}', '${ts}')`,
			),
		).toThrow("related_to dependencies require a non-empty reason");
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

	test("recall context dedupe tables isolate sessions, agents, and epochs", () => {
		db = createFreshDb();
		runMigrations(db);

		const tables = db
			.query<{ name: string }, []>(
				"SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('session_context_epochs', 'session_recall_events')",
			)
			.all()
			.map((row) => row.name);
		expect(tables).toContain("session_context_epochs");
		expect(tables).toContain("session_recall_events");

		db.run(
			`INSERT INTO session_recall_events (
				session_key, agent_id, context_epoch, item_kind, item_id, surface, mode
			) VALUES ('sess-1', 'agent-a', 0, 'memory', 'mem-1', 'api', 'direct')`,
		);
		expect(() =>
			db.run(
				`INSERT INTO session_recall_events (
					session_key, agent_id, context_epoch, item_kind, item_id, surface, mode
				) VALUES ('sess-1', 'agent-a', 0, 'memory', 'mem-1', 'api', 'direct')`,
			),
		).toThrow();

		db.run(
			`INSERT INTO session_recall_events (
				session_key, agent_id, context_epoch, item_kind, item_id, surface, mode
			) VALUES ('sess-1', 'agent-b', 0, 'memory', 'mem-1', 'api', 'direct')`,
		);
		db.run(
			`INSERT INTO session_context_epochs (
				session_key, agent_id, context_epoch, reason
			) VALUES ('sess-1', 'agent-a', 1, 'compaction-complete')`,
		);
		db.run(
			`INSERT INTO session_recall_events (
				session_key, agent_id, context_epoch, item_kind, item_id, surface, mode
			) VALUES ('sess-1', 'agent-a', 1, 'memory', 'mem-1', 'api', 'direct')`,
		);

		const count = db
			.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM session_recall_events WHERE item_id = 'mem-1'")
			.get();
		expect(count?.count).toBe(3);
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

	test("migration 048 treats source_ref=session_key as session-scoped lane", () => {
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
		`);
		const now = new Date().toISOString();
		db.prepare(
			`INSERT INTO session_summaries (
				id, project, depth, kind, content, earliest_at, latest_at, session_key,
				harness, agent_id, source_type, source_ref, created_at
			) VALUES (?, ?, 0, 'session', ?, ?, ?, ?, ?, ?, 'summary', ?, ?)`,
		).run("sum-1", "/tmp/proj", "lane seed", now, now, "sess-1", "codex", "agent-a", "sess-1", now);

		expect(() => threadHeadsMigration(db)).not.toThrow();

		const row = db
			.query<{ thread_key: string; label: string }, []>(
				`SELECT thread_key, label FROM memory_thread_heads WHERE agent_id = 'agent-a'`,
			)
			.get();
		expect(row).toEqual({
			thread_key: "project:/tmp/proj|source:sess-1|harness:codex",
			label: "project:/tmp/proj#source:sess-1",
		});
	});

	test("migration 050 adds rolling-lineage artifact tables and summary job metadata", () => {
		db = createFreshDb();
		runMigrations(db);

		const summaryCols = db.query("PRAGMA table_info(summary_jobs)").all() as Array<{ name: string }>;
		const summaryNames = summaryCols.map((col) => col.name);
		expect(summaryNames).toContain("session_id");
		expect(summaryNames).toContain("trigger");
		expect(summaryNames).toContain("captured_at");
		expect(summaryNames).toContain("started_at");
		expect(summaryNames).toContain("ended_at");

		const tables = db
			.query(
				`SELECT name FROM sqlite_master
			 WHERE type IN ('table', 'view') AND name IN ('memory_artifacts', 'memory_artifact_tombstones', 'memory_artifacts_fts')
			 ORDER BY name`,
			)
			.all() as Array<{ name: string }>;
		expect(tables.map((row) => row.name)).toEqual([
			"memory_artifact_tombstones",
			"memory_artifacts",
			"memory_artifacts_fts",
		]);
	});

	test("migration 061 adds source_mtime_ms to memory_artifacts", () => {
		db = createFreshDb();
		runMigrations(db);

		const cols = db.query("PRAGMA table_info(memory_artifacts)").all() as Array<{ name: string }>;
		const colNames = cols.map((col) => col.name);
		expect(colNames).toContain("source_mtime_ms");
	});

	test("migration 062 adds soft-delete columns to memory_artifacts", () => {
		db = createFreshDb();
		runMigrations(db);

		const cols = db.query("PRAGMA table_info(memory_artifacts)").all() as Array<{ name: string }>;
		const colNames = cols.map((col) => col.name);
		expect(colNames).toContain("is_deleted");
		expect(colNames).toContain("deleted_at");

		const indexes = db.query("PRAGMA index_list(memory_artifacts)").all() as Array<{ name: string }>;
		expect(indexes.map((row) => row.name)).toContain("idx_memory_artifacts_agent_deleted");
	});

	test("migration 075 adds provider-neutral source provenance to memory_artifacts", () => {
		db = createFreshDb();
		runMigrations(db);

		const cols = db.query("PRAGMA table_info(memory_artifacts)").all() as Array<{ name: string }>;
		const colNames = cols.map((col) => col.name);
		expect(colNames).toContain("source_id");
		expect(colNames).toContain("source_root");
		expect(colNames).toContain("source_external_id");
		expect(colNames).toContain("source_parent_path");
		expect(colNames).toContain("source_meta_json");

		const indexes = db.query("PRAGMA index_list(memory_artifacts)").all() as Array<{ name: string }>;
		expect(indexes.map((row) => row.name)).toContain("idx_memory_artifacts_agent_source");
		expect(indexes.map((row) => row.name)).toContain("idx_memory_artifacts_agent_source_root");
	});

	test("migration 070 adds ontology control-plane status and version state safely", () => {
		db = createFreshDb();
		db.exec(`
			CREATE TABLE entities (
				id TEXT PRIMARY KEY,
				agent_id TEXT NOT NULL,
				updated_at TEXT NOT NULL
			);
			CREATE TABLE entity_aspects (
				id TEXT PRIMARY KEY,
				entity_id TEXT NOT NULL,
				agent_id TEXT NOT NULL,
				updated_at TEXT NOT NULL
			);
			CREATE TABLE entity_attributes (
				id TEXT PRIMARY KEY,
				aspect_id TEXT NOT NULL,
				agent_id TEXT NOT NULL,
				group_key TEXT,
				claim_key TEXT,
				status TEXT NOT NULL DEFAULT 'active',
				updated_at TEXT NOT NULL
			);
			CREATE TABLE entity_dependencies (
				id TEXT PRIMARY KEY,
				source_entity_id TEXT NOT NULL,
				target_entity_id TEXT NOT NULL,
				agent_id TEXT NOT NULL,
				updated_at TEXT NOT NULL
			);
			INSERT INTO entities (id, agent_id, updated_at) VALUES ('entity-1', 'ant', '2026-05-16T00:00:00.000Z');
			INSERT INTO entity_aspects (id, entity_id, agent_id, updated_at)
			VALUES ('aspect-1', 'entity-1', 'ant', '2026-05-16T00:00:00.000Z');
			INSERT INTO entity_attributes (id, aspect_id, agent_id, updated_at)
			VALUES ('attr-1', 'aspect-1', 'ant', '2026-05-16T00:00:00.000Z');
			INSERT INTO entity_dependencies (id, source_entity_id, target_entity_id, agent_id, updated_at)
			VALUES ('dep-1', 'entity-1', 'entity-1', 'ant', '2026-05-16T00:00:00.000Z');
		`);

		ontologyControlPlaneState(db);

		const entity = db.query("SELECT status, archived_at FROM entities WHERE id = 'entity-1'").get() as {
			status: string;
			archived_at: string | null;
		};
		const aspect = db.query("SELECT status, archive_reason FROM entity_aspects WHERE id = 'aspect-1'").get() as {
			status: string;
			archive_reason: string | null;
		};
		const attr = db
			.query(
				"SELECT version, version_root_id, previous_attribute_id, archived_at FROM entity_attributes WHERE id = 'attr-1'",
			)
			.get() as {
			version: number;
			version_root_id: string;
			previous_attribute_id: string | null;
			archived_at: string | null;
		};
		const dep = db.query("SELECT status, archived_by FROM entity_dependencies WHERE id = 'dep-1'").get() as {
			status: string;
			archived_by: string | null;
		};

		expect(entity).toEqual({ status: "active", archived_at: null });
		expect(aspect).toEqual({ status: "active", archive_reason: null });
		expect(attr).toEqual({
			version: 1,
			version_root_id: "attr-1",
			previous_attribute_id: null,
			archived_at: null,
		});
		expect(dep).toEqual({ status: "active", archived_by: null });
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

	test("unique partial index on content_hash is agent-, project-, and scope-aware", () => {
		db = createFreshDb();
		runMigrations(db);

		const now = new Date().toISOString();
		db.prepare(
			`INSERT INTO memories (id, content, content_hash, type, agent_id, scope, created_at, updated_at, updated_by)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run("a", "hello", "hash1", "fact", "default", null, now, now, "test");

		// Same content_hash in the same agent/scope tuple should fail.
		expect(() =>
			db
				.prepare(
					`INSERT INTO memories (id, content, content_hash, type, agent_id, scope, created_at, updated_at, updated_by)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.run("b", "hello again", "hash1", "fact", "default", null, now, now, "test"),
		).toThrow();

		// A different agent may persist the same content hash.
		db.prepare(
			`INSERT INTO memories (id, content, content_hash, type, agent_id, scope, created_at, updated_at, updated_by)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run("c", "hello from agent a", "hash1", "fact", "agent-a", null, now, now, "test");

		// A different project may also persist the same content hash.
		db.prepare(
			`INSERT INTO memories (id, content, content_hash, type, agent_id, project, scope, created_at, updated_at, updated_by)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run("d", "hello from project scope", "hash1", "fact", "default", "/repo/other", null, now, now, "test");

		// A different benchmark scope may also persist the same content hash.
		db.prepare(
			`INSERT INTO memories (id, content, content_hash, type, agent_id, scope, created_at, updated_at, updated_by)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run("g", "hello from bench scope", "hash1", "fact", "default", "bench:run-1", now, now, "test");

		// NULL content_hash should not conflict.
		db.prepare(
			`INSERT INTO memories (id, content, content_hash, type, created_at, updated_at, updated_by)
			 VALUES (?, ?, NULL, ?, ?, ?, ?)`,
		).run("e", "no hash", "fact", now, now, "test");

		// Soft-deleted row with the same hash should not conflict.
		db.prepare(
			`INSERT INTO memories (id, content, content_hash, is_deleted, type, agent_id, scope, created_at, updated_at, updated_by)
			 VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
		).run("f", "deleted", "hash1", "fact", "default", null, now, now, "test");
	});

	test("unique partial index on idempotency_key is agent-, visibility-, and scope-aware", () => {
		db = createFreshDb();
		runMigrations(db);

		const now = new Date().toISOString();
		db.prepare(
			`INSERT INTO memories
			 (id, content, idempotency_key, type, agent_id, visibility, scope, created_at, updated_at, updated_by)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run("a", "first import", "import-key", "fact", "default", "global", null, now, now, "test");

		expect(() =>
			db
				.prepare(
					`INSERT INTO memories
					 (id, content, idempotency_key, type, agent_id, visibility, scope, created_at, updated_at, updated_by)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.run("b", "same tuple import", "import-key", "fact", "default", "global", null, now, now, "test"),
		).toThrow();

		db.prepare(
			`INSERT INTO memories
			 (id, content, idempotency_key, type, agent_id, visibility, scope, created_at, updated_at, updated_by)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run("c", "other agent import", "import-key", "fact", "agent-a", "global", null, now, now, "test");

		db.prepare(
			`INSERT INTO memories
			 (id, content, idempotency_key, type, agent_id, visibility, scope, created_at, updated_at, updated_by)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run("d", "private import", "import-key", "fact", "default", "private", null, now, now, "test");

		db.prepare(
			`INSERT INTO memories
			 (id, content, idempotency_key, type, agent_id, visibility, scope, created_at, updated_at, updated_by)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run("e", "scoped import", "import-key", "fact", "default", "global", "bench:run-1", now, now, "test");

		db.prepare(
			`INSERT INTO memories
			 (id, content, idempotency_key, is_deleted, type, agent_id, visibility, scope, created_at, updated_at, updated_by)
			 VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`,
		).run("f", "deleted import", "import-key", "fact", "default", "global", null, now, now, "test");
	});

	test("migration 072 repairs missing runtime_path on partial provenance schemas", () => {
		db = createFreshDb();
		runMigrations(db);

		db.exec("ALTER TABLE memories DROP COLUMN runtime_path");
		db.prepare("DELETE FROM schema_migrations WHERE version = 72").run();
		runMigrations(db);

		const cols = db.query("PRAGMA table_info(memories)").all() as Array<{ name: string }>;
		const colNames = cols.map((c) => c.name);
		expect(colNames).toContain("idempotency_key");
		expect(colNames).toContain("runtime_path");
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

	test("mcp_invocations table exists with expected columns after migration 052", () => {
		db = createFreshDb();
		runMigrations(db);

		const tables = db
			.query("SELECT name FROM sqlite_master WHERE type='table' AND name='mcp_invocations'")
			.all() as Array<{
			name: string;
		}>;
		expect(tables.length).toBe(1);

		const cols = db.query("PRAGMA table_info(mcp_invocations)").all() as Array<{ name: string }>;
		const colNames = cols.map((c) => c.name);
		expect(colNames).toContain("id");
		expect(colNames).toContain("server_id");
		expect(colNames).toContain("tool_name");
		expect(colNames).toContain("agent_id");
		expect(colNames).toContain("source");
		expect(colNames).toContain("latency_ms");
		expect(colNames).toContain("success");
		expect(colNames).toContain("error_text");
		expect(colNames).toContain("created_at");
	});

	test("skill_invocations table exists with expected columns after migration 053", () => {
		db = createFreshDb();
		runMigrations(db);

		const tables = db
			.query("SELECT name FROM sqlite_master WHERE type='table' AND name='skill_invocations'")
			.all() as Array<{
			name: string;
		}>;
		expect(tables.length).toBe(1);

		const cols = db.query("PRAGMA table_info(skill_invocations)").all() as Array<{ name: string }>;
		const colNames = cols.map((c) => c.name);
		expect(colNames).toContain("id");
		expect(colNames).toContain("skill_name");
		expect(colNames).toContain("agent_id");
		expect(colNames).toContain("source");
		expect(colNames).toContain("latency_ms");
		expect(colNames).toContain("success");
		expect(colNames).toContain("error_text");
		expect(colNames).toContain("created_at");
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

	test("phantom migration detection honors optional artifacts when their table is absent", () => {
		db = createFreshDb();
		runMigrations(db);

		const auditBefore = db
			.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM schema_migrations_audit WHERE version = 65")
			.get();
		expect(auditBefore?.count).toBe(1);

		db.run("DROP TABLE embeddings");
		expect(hasPendingMigrations(db)).toBe(false);

		runMigrations(db);

		const auditAfter = db
			.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM schema_migrations_audit WHERE version = 65")
			.get();
		expect(auditAfter?.count).toBe(auditBefore?.count);
		const migration65 = db
			.query<{ version: number }, []>("SELECT version FROM schema_migrations WHERE version = 65")
			.get();
		expect(migration65?.version).toBe(65);
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

	test("migration 057 recreates legacy porter-tokenized memories_fts", () => {
		db = createFreshDb();
		runMigrations(db);

		db.exec(`
			INSERT INTO memories (id, content, type, confidence, created_at, updated_at, updated_by)
			VALUES
				('mem-celebrate', 'We celebrate wins together', 'fact', 0.9, datetime('now'), datetime('now'), 'test'),
				('mem-celebrity', 'Celebrity filter blocks face likenesses', 'fact', 0.9, datetime('now'), datetime('now'), 'test')
		`);

		installLegacyPorterMemoriesFts(db);
		const before = db
			.query<{ content: string }, [string]>(
				"SELECT content FROM memories_fts WHERE memories_fts MATCH ? ORDER BY rowid",
			)
			.all("celebrate")
			.map((row) => row.content);
		expect(before).toContain("Celebrity filter blocks face likenesses");

		db.prepare("DELETE FROM schema_migrations WHERE version = 57").run();
		runMigrations(db);

		const sql = readMemoriesFtsSql(db);
		expect(sql).toContain("tokenize='unicode61'");
		expect(sql).not.toContain("porter unicode61");

		const after = db
			.query<{ content: string }, [string]>(
				"SELECT content FROM memories_fts WHERE memories_fts MATCH ? ORDER BY rowid",
			)
			.all("celebrate")
			.map((row) => row.content);
		expect(after).toContain("We celebrate wins together");
		expect(after).not.toContain("Celebrity filter blocks face likenesses");
	});

	test("migration 063 limits memories_fts updates to content changes", () => {
		db = createFreshDb();
		runMigrations(db);

		const trigger = db
			.query<{ sql: string }, []>("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'memories_au'")
			.get();
		expect(trigger?.sql).toContain("AFTER UPDATE OF content ON memories");

		db.exec(`
			INSERT INTO memories (id, content, type, confidence, access_count, created_at, updated_at, updated_by)
			VALUES ('mem-fts-access', 'recall access tracking should stay searchable', 'fact', 0.9, 0, datetime('now'), datetime('now'), 'test')
		`);

		db.prepare("UPDATE memories SET access_count = access_count + 1 WHERE id = ?").run("mem-fts-access");
		expect(
			db
				.query<{ id: string }, [string]>(
					`SELECT m.id
					 FROM memories_fts
					 JOIN memories m ON memories_fts.rowid = m.rowid
					 WHERE memories_fts MATCH ?`,
				)
				.all("searchable")
				.map((row) => row.id),
		).toContain("mem-fts-access");

		db.prepare("UPDATE memories SET content = ? WHERE id = ?").run(
			"content updates still refresh searchable text",
			"mem-fts-access",
		);
		expect(
			db
				.query<{ id: string }, [string]>(
					`SELECT m.id
					 FROM memories_fts
					 JOIN memories m ON memories_fts.rowid = m.rowid
					 WHERE memories_fts MATCH ?`,
				)
				.all("refresh")
				.map((row) => row.id),
		).toContain("mem-fts-access");
	});
});
