/**
 * Migration runner for Signet's SQLite database
 *
 * Reads the current schema version from `schema_migrations`, runs
 * any pending migrations in order (each inside a transaction), and
 * records execution in `schema_migrations_audit`.
 */

import { up as baseline } from "./001-baseline";
import { up as pipelineV2 } from "./002-pipeline-v2";
import { up as uniqueContentHash } from "./003-unique-content-hash";
import { up as historyActorAndRetention } from "./004-history-actor-and-retention";
import { up as graphExtended } from "./005-graph-extended";
import { up as idempotencyKey } from "./006-idempotency-key";
import { up as documentsAndConnectors } from "./007-documents-and-connectors";
import { up as embeddingsUniqueHash } from "./008-embeddings-unique-hash";
import { up as summaryJobs } from "./009-summary-jobs";
import { up as umapCache } from "./010-umap-cache";
import { up as sessionScores } from "./011-session-scores";
import { up as scheduledTasks } from "./012-scheduled-tasks";
import { up as ingestionTracking } from "./013-ingestion-tracking";
import { up as telemetry } from "./014-telemetry";
import { up as sessionMemories } from "./015-session-memories";
import { up as sessionCheckpoints } from "./016-session-checkpoints";
import { up as taskSkills } from "./017-task-skills";
import { up as skillMeta } from "./018-skill-meta";
import { up as knowledgeStructure } from "./019-knowledge-structure";
import { up as predictorComparisons } from "./020-predictor-comparisons";
import { up as checkpointStructural } from "./021-checkpoint-structural";
import { up as entityPinning } from "./022-entity-pinning";
import { up as predictorColumns } from "./023-predictor-columns";
import { up as predictorComparisonColumns } from "./024-predictor-comparison-columns";
import { up as agentFeedback } from "./025-agent-feedback";
import { up as predictorTrainingPairs } from "./026-predictor-training-pairs";
import { up as backfillCanonicalNames } from "./027-backfill-canonical-names";
import { up as losslessRetention } from "./028-lossless-retention";
import { up as sessionSummaryDag } from "./029-session-summary-dag";

// -- Public interface consumed by Database.init() --

export interface MigrationDb {
	exec(sql: string): void;
	prepare(sql: string): {
		run(...args: unknown[]): void;
		get(...args: unknown[]): Record<string, unknown> | undefined;
		all(...args: unknown[]): Record<string, unknown>[];
	};
}

export interface MigrationArtifacts {
	readonly tables?: readonly string[];
	readonly columns?: readonly { readonly table: string; readonly column: string }[];
}

export interface Migration {
	readonly version: number;
	readonly name: string;
	readonly up: (db: MigrationDb) => void;
	readonly artifacts?: MigrationArtifacts;
}

/** Ordered list of all migrations. New migrations go at the end. */
export const MIGRATIONS: readonly Migration[] = [
	{
		version: 1,
		name: "baseline",
		up: baseline,
		artifacts: { tables: ["memories", "conversations", "embeddings"] },
	},
	{
		version: 2,
		name: "pipeline-v2",
		up: pipelineV2,
		artifacts: {
			tables: [
				"memory_history",
				"memory_jobs",
				"entities",
				"relations",
				"memory_entity_mentions",
			],
		},
	},
	{
		version: 3,
		name: "unique-content-hash",
		up: uniqueContentHash,
		artifacts: {
			columns: [
				{ table: "memories", column: "why" },
				{ table: "memories", column: "project" },
			],
		},
	},
	{
		version: 4,
		name: "history-actor-and-retention",
		up: historyActorAndRetention,
		artifacts: {
			columns: [{ table: "memory_history", column: "actor_type" }],
		},
	},
	{
		version: 5,
		name: "graph-extended",
		up: graphExtended,
		artifacts: {
			columns: [{ table: "entities", column: "canonical_name" }],
		},
	},
	{
		version: 6,
		name: "idempotency-key",
		up: idempotencyKey,
		artifacts: {
			columns: [{ table: "memories", column: "idempotency_key" }],
		},
	},
	{
		version: 7,
		name: "documents-and-connectors",
		up: documentsAndConnectors,
		artifacts: { tables: ["documents", "document_memories", "connectors"] },
	},
	{
		version: 8,
		name: "embeddings-unique-hash",
		up: embeddingsUniqueHash,
	},
	{
		version: 9,
		name: "summary-jobs",
		up: summaryJobs,
		artifacts: { tables: ["summary_jobs"] },
	},
	{
		version: 10,
		name: "umap-cache",
		up: umapCache,
		artifacts: { tables: ["umap_cache"] },
	},
	{
		version: 11,
		name: "session-scores",
		up: sessionScores,
		artifacts: { tables: ["session_scores"] },
	},
	{
		version: 12,
		name: "scheduled-tasks",
		up: scheduledTasks,
		artifacts: { tables: ["scheduled_tasks", "task_runs"] },
	},
	{
		version: 13,
		name: "ingestion-tracking",
		up: ingestionTracking,
		artifacts: { tables: ["ingestion_jobs"] },
	},
	{
		version: 14,
		name: "telemetry",
		up: telemetry,
		artifacts: { tables: ["telemetry_events"] },
	},
	{
		version: 15,
		name: "session-memories",
		up: sessionMemories,
		artifacts: { tables: ["session_memories"] },
	},
	{
		version: 16,
		name: "session-checkpoints",
		up: sessionCheckpoints,
		artifacts: { tables: ["session_checkpoints"] },
	},
	{
		version: 17,
		name: "task-skills",
		up: taskSkills,
		artifacts: {
			columns: [{ table: "scheduled_tasks", column: "skill_name" }],
		},
	},
	{
		version: 18,
		name: "skill-meta",
		up: skillMeta,
		artifacts: { tables: ["skill_meta"] },
	},
	{
		version: 19,
		name: "knowledge-structure",
		up: knowledgeStructure,
		artifacts: {
			tables: [
				"entity_aspects",
				"entity_attributes",
				"entity_dependencies",
				"task_meta",
			],
			columns: [{ table: "entities", column: "agent_id" }],
		},
	},
	{
		version: 20,
		name: "predictor-comparisons",
		up: predictorComparisons,
		artifacts: {
			tables: ["predictor_comparisons", "predictor_training_log"],
		},
	},
	{
		version: 21,
		name: "checkpoint-structural",
		up: checkpointStructural,
		artifacts: {
			columns: [
				{ table: "session_checkpoints", column: "focal_entity_ids" },
			],
		},
	},
	{
		version: 22,
		name: "entity-pinning",
		up: entityPinning,
		artifacts: {
			columns: [{ table: "entities", column: "pinned" }],
		},
	},
	{
		version: 23,
		name: "predictor-columns",
		up: predictorColumns,
		artifacts: {
			columns: [{ table: "session_memories", column: "predictor_rank" }],
		},
	},
	{
		version: 24,
		name: "predictor-comparison-columns",
		up: predictorComparisonColumns,
		artifacts: {
			columns: [
				{ table: "predictor_comparisons", column: "scorer_confidence" },
			],
		},
	},
	{
		version: 25,
		name: "agent-feedback",
		up: agentFeedback,
		artifacts: {
			columns: [
				{ table: "session_memories", column: "agent_relevance_score" },
			],
		},
	},
	{
		version: 26,
		name: "predictor-training-pairs",
		up: predictorTrainingPairs,
		artifacts: { tables: ["predictor_training_pairs"] },
	},
	{
		version: 27,
		name: "backfill-canonical-names",
		up: backfillCanonicalNames,
	},
	{
		version: 28,
		name: "lossless-retention",
		up: losslessRetention,
	},
	{
		version: 29,
		name: "session-summary-dag",
		up: sessionSummaryDag,
	},
];

/** Simple checksum for audit trail (hash of migration name + version). */
function checksum(m: Migration): string {
	let h = 0;
	const s = `${m.version}:${m.name}`;
	for (let i = 0; i < s.length; i++) {
		h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
	}
	return h.toString(16);
}

/**
 * Ensure schema_migrations and schema_migrations_audit tables exist.
 * Called before reading current version so the queries don't fail
 * on a brand-new database.
 */
function ensureMetaTables(db: MigrationDb): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS schema_migrations (
			version INTEGER PRIMARY KEY,
			applied_at TEXT NOT NULL,
			checksum TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS schema_migrations_audit (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			version INTEGER NOT NULL,
			applied_at TEXT NOT NULL,
			duration_ms INTEGER,
			checksum TEXT
		);
	`);
}

/** Read the highest applied version, or 0 if none. */
function currentVersion(db: MigrationDb): number {
	const row = db.prepare("SELECT MAX(version) as version FROM schema_migrations").get();
	if (row === undefined) return 0;
	const v = row.version;
	return typeof v === "number" ? v : 0;
}

/**
 * Detect and repair the v0.1.65 CLI bug where schema_migrations was
 * stamped at version 2 without actually running migration 002.
 *
 * If version >= 2 but the memories table lacks the `content_hash`
 * column (added by 002), the version rows are bogus. Delete them
 * so all migrations re-run. This is safe because every migration
 * uses CREATE IF NOT EXISTS / addColumnIfMissing.
 */
function repairBogusVersion(db: MigrationDb): void {
	const current = currentVersion(db);
	if (current < 2) return;
	const cols = db
		.prepare("PRAGMA table_info(memories)")
		.all() as ReadonlyArray<Record<string, unknown>>;
	const hasContentHash = cols.some((r) => r.name === "content_hash");
	if (hasContentHash) return;
	db.exec("DELETE FROM schema_migrations WHERE version > 0");
}

/** Type guard: narrows a query row to one with a string `name` field. */
function hasStringName(row: Record<string, unknown>): row is { name: string } {
	return typeof row.name === "string";
}

/** Type guard: narrows a query row to one with a numeric `version` field. */
function hasNumericVersion(
	row: Record<string, unknown>,
): row is { version: number } {
	return typeof row.version === "number";
}

/** Get the set of table names in the database (single query). */
function existingTables(db: MigrationDb): Set<string> {
	const rows = db
		.prepare("SELECT name FROM sqlite_master WHERE type='table'")
		.all();
	return new Set(rows.filter(hasStringName).map((r) => r.name));
}

/** Get column names for a table, with per-call caching. */
function tableColumns(
	db: MigrationDb,
	table: string,
	cache: Map<string, Set<string>>,
): Set<string> {
	let cols = cache.get(table);
	if (cols) return cols;
	const rows = db.prepare(`PRAGMA table_info("${table}")`).all();
	cols = new Set(rows.filter(hasStringName).map((r) => r.name));
	cache.set(table, cols);
	return cols;
}

/**
 * Detect "phantom" migrations — recorded as applied in schema_migrations
 * but whose expected artifacts (tables/columns) don't actually exist.
 * Deletes the phantom rows so the migration re-runs on the next pass.
 */
function repairPhantomMigrations(db: MigrationDb): void {
	const tables = existingTables(db);
	const colCache = new Map<string, Set<string>>();

	for (const migration of MIGRATIONS) {
		if (!migration.artifacts) continue;

		// Skip v1/v2 — legacy CLI partial schemas are handled by
		// repairBogusVersion, not phantom repair
		if (migration.version <= 2) continue;

		const row = db
			.prepare("SELECT version FROM schema_migrations WHERE version = ?")
			.get(migration.version);
		if (!row) continue;

		let missing = false;

		if (migration.artifacts.tables) {
			for (const t of migration.artifacts.tables) {
				if (!tables.has(t)) {
					console.error(
						`[signet] phantom migration v${migration.version} (${migration.name}): table "${t}" missing — will re-run`,
					);
					missing = true;
					break;
				}
			}
		}

		if (!missing && migration.artifacts.columns) {
			for (const col of migration.artifacts.columns) {
				if (!tables.has(col.table)) {
					console.error(
						`[signet] phantom migration v${migration.version} (${migration.name}): table "${col.table}" missing — will re-run`,
					);
					missing = true;
					break;
				}
				const cols = tableColumns(db, col.table, colCache);
				if (!cols.has(col.column)) {
					console.error(
						`[signet] phantom migration v${migration.version} (${migration.name}): column "${col.table}.${col.column}" missing — will re-run`,
					);
					missing = true;
					break;
				}
			}
		}

		if (missing) {
			db.prepare(
				"DELETE FROM schema_migrations WHERE version = ?",
			).run(migration.version);
			db.prepare(
				"DELETE FROM schema_migrations_audit WHERE version = ?",
			).run(migration.version);
		}
	}
}

/** Get the set of applied migration versions. */
function appliedVersions(db: MigrationDb): Set<number> {
	const rows = db.prepare("SELECT version FROM schema_migrations").all();
	return new Set(rows.filter(hasNumericVersion).map((r) => r.version));
}

/**
 * Verify that a migration's declared artifacts exist after running.
 * Throws if any artifact is missing (SAVEPOINT catches it).
 */
function verifyArtifacts(db: MigrationDb, migration: Migration): void {
	if (!migration.artifacts) return;

	const tables = existingTables(db);

	if (migration.artifacts.tables) {
		for (const t of migration.artifacts.tables) {
			if (!tables.has(t)) {
				throw new Error(
					`Post-DDL verification failed: migration ${migration.version} (${migration.name}) ` +
						`declares table "${t}" but it was not created`,
				);
			}
		}
	}

	if (migration.artifacts.columns) {
		const colCache = new Map<string, Set<string>>();
		for (const col of migration.artifacts.columns) {
			if (!tables.has(col.table)) {
				throw new Error(
					`Post-DDL verification failed: migration ${migration.version} (${migration.name}) ` +
						`declares column "${col.table}.${col.column}" but table does not exist`,
				);
			}
			const colNames = tableColumns(db, col.table, colCache);
			if (!colNames.has(col.column)) {
				throw new Error(
					`Post-DDL verification failed: migration ${migration.version} (${migration.name}) ` +
						`declares column "${col.table}.${col.column}" but it was not created`,
				);
			}
		}
	}
}

/**
 * Check whether there are unapplied migrations without running them.
 * Useful for backup-before-migrate logic in the daemon.
 */
export function hasPendingMigrations(db: MigrationDb): boolean {
	ensureMetaTables(db);
	repairBogusVersion(db);
	repairPhantomMigrations(db);
	const applied = appliedVersions(db);
	return MIGRATIONS.some((m) => !applied.has(m.version));
}

/** The highest migration version defined. */
export const LATEST_SCHEMA_VERSION =
	MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;

/**
 * Run all pending migrations against `db`.
 *
 * Idempotent — safe to call on every startup. Migrations that have
 * already been applied (tracked in `schema_migrations`) are skipped.
 * Set-based skip logic handles gaps from phantom repair correctly.
 * Each migration runs inside a SAVEPOINT so a failure rolls back
 * only that migration.
 */
export function runMigrations(db: MigrationDb): void {
	ensureMetaTables(db);

	// Repair v0.1.65 CLI bug (stamps version without running migrations)
	repairBogusVersion(db);

	// Repair phantom migrations (recorded but artifacts missing)
	repairPhantomMigrations(db);

	// Set-based: handles gaps from phantom repair (MAX-based would skip them)
	const applied = appliedVersions(db);

	for (const migration of MIGRATIONS) {
		if (applied.has(migration.version)) continue;

		const start = Date.now();
		const cs = checksum(migration);

		// Use SAVEPOINT for nested-transaction safety
		db.exec(`SAVEPOINT migration_${migration.version}`);
		try {
			migration.up(db);

			// Post-DDL verification: confirm declared artifacts were created
			verifyArtifacts(db, migration);

			db.prepare(
				`INSERT OR REPLACE INTO schema_migrations
				 (version, applied_at, checksum)
				 VALUES (?, ?, ?)`,
			).run(migration.version, new Date().toISOString(), cs);

			db.prepare(
				`INSERT INTO schema_migrations_audit
				 (version, applied_at, duration_ms, checksum)
				 VALUES (?, ?, ?, ?)`,
			).run(
				migration.version,
				new Date().toISOString(),
				Date.now() - start,
				cs,
			);

			db.exec(`RELEASE migration_${migration.version}`);
		} catch (err) {
			db.exec(`ROLLBACK TO SAVEPOINT migration_${migration.version}`);
			db.exec(`RELEASE migration_${migration.version}`);
			const detail = err instanceof Error ? err.message : String(err);
			throw new Error(
				`Migration ${migration.version} (${migration.name}) failed: ${detail}\n\n` +
					"Your data is safe — the failed migration was rolled back.\n" +
					"Please report this at https://github.com/Signet-AI/signetai/issues\n" +
					"with the error message above and your signetai version.",
			);
		}
	}
}
