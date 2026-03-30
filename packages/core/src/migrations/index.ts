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
import { up as nullableMemoryJobMemoryId } from "./030-nullable-memory-job-memory-id";
import { up as dependencyReason } from "./031-dependency-reason";
import { up as embeddingsVectorColumn } from "./032-embeddings-vector-column";
import { up as scope } from "./033-scope";
import { up as scopeAwareDedup } from "./034-scope-aware-dedup";
import { up as entityFts } from "./035-entity-fts";
import { up as dependencyConfidence } from "./036-dependency-confidence";
import { up as entityCommunities } from "./037-entity-communities";
import { up as memoryHints } from "./038-memory-hints";
import { up as dedupEntityDependencies } from "./039-dedup-entity-dependencies";
import { up as sessionTranscripts } from "./040-session-transcripts";
import { up as pathFeedback } from "./041-path-feedback";
import { up as sessionMemoriesAgentId } from "./042-session-memories-agent-id";
import { up as agentsTable } from "./043-agents-table";
import { up as memoryMdTemporalHead } from "./044-memory-md-temporal-head";
import { up as losslessWorkingMemoryHardening } from "./045-lossless-working-memory-hardening";
import { up as sessionSummaryUniqueness } from "./046-session-summary-uniqueness";
import { up as agentScopedTemporalUniqueness } from "./047-agent-scoped-temporal-uniqueness";
import { up as threadHeads } from "./048-thread-heads";
import { up as sessionExtractCursors } from "./049-session-extract-cursors";
import { up as relatedToAudit } from "./050-related-to-audit";
import { up as memoryMdRollingWindowLineage } from "./051-memory-md-rolling-window-lineage";
import { up as mcpInvocations } from "./052-mcp-invocations";

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
	readonly columns?: readonly {
		readonly table: string;
		readonly column: string;
		/** Skip verification when the table itself doesn't exist (conditional/repair migrations). */
		readonly optional?: boolean;
	}[];
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
			tables: ["memory_history", "memory_jobs", "entities", "relations", "memory_entity_mentions"],
		},
	},
	{
		version: 3,
		name: "unique-content-hash",
		up: uniqueContentHash,
		// No artifact declarations: v3 creates idx_memories_content_hash_unique
		// (an index), but MigrationArtifacts has no `indexes` field. The columns
		// it touches (why, project) are part of the v1 baseline, not v3.
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
		artifacts: {
			tables: ["ingestion_jobs"],
			columns: [
				{ table: "memories", column: "source_path" },
				{ table: "memories", column: "source_section" },
			],
		},
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
		artifacts: {
			tables: ["session_memories"],
			columns: [
				{ table: "session_scores", column: "confidence" },
				{ table: "session_scores", column: "continuity_reasoning" },
			],
		},
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
			tables: ["entity_aspects", "entity_attributes", "entity_dependencies", "task_meta"],
			columns: [{ table: "entities", column: "agent_id" }],
		},
	},
	{
		version: 20,
		name: "predictor-comparisons",
		up: predictorComparisons,
		artifacts: {
			tables: ["predictor_comparisons", "predictor_training_log"],
			columns: [
				{ table: "session_memories", column: "entity_slot" },
				{ table: "session_memories", column: "aspect_slot" },
				{ table: "session_memories", column: "is_constraint" },
				{ table: "session_memories", column: "structural_density" },
			],
		},
	},
	{
		version: 21,
		name: "checkpoint-structural",
		up: checkpointStructural,
		artifacts: {
			columns: [{ table: "session_checkpoints", column: "focal_entity_ids" }],
		},
	},
	{
		version: 22,
		name: "entity-pinning",
		up: entityPinning,
		artifacts: {
			columns: [
				{ table: "entities", column: "pinned" },
				{ table: "entities", column: "pinned_at" },
			],
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
				{ table: "predictor_comparisons", column: "success_rate" },
				{ table: "predictor_comparisons", column: "predictor_top_ids" },
				{ table: "predictor_comparisons", column: "baseline_top_ids" },
				{ table: "predictor_comparisons", column: "relevance_scores" },
				{ table: "predictor_comparisons", column: "fts_overlap_score" },
			],
		},
	},
	{
		version: 25,
		name: "agent-feedback",
		up: agentFeedback,
		artifacts: {
			columns: [{ table: "session_memories", column: "agent_relevance_score" }],
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
	{
		version: 30,
		name: "nullable-memory-job-memory-id",
		up: nullableMemoryJobMemoryId,
	},
	{
		version: 31,
		name: "dependency-reason",
		up: dependencyReason,
		artifacts: {
			columns: [
				{ table: "entity_dependencies", column: "reason" },
				{ table: "entities", column: "last_synthesized_at" },
			],
		},
	},
	{
		version: 32,
		name: "embeddings-vector-column",
		up: embeddingsVectorColumn,
		artifacts: {
			columns: [{ table: "embeddings", column: "vector", optional: true }],
		},
	},
	{
		version: 33,
		name: "scope",
		up: scope,
		artifacts: {
			columns: [{ table: "memories", column: "scope" }],
		},
	},
	{
		version: 34,
		name: "scope-aware-dedup",
		up: scopeAwareDedup,
	},
	{
		version: 35,
		name: "entity-fts",
		up: entityFts,
	},
	{
		version: 36,
		name: "dependency-confidence",
		up: dependencyConfidence,
		artifacts: {
			columns: [{ table: "entity_dependencies", column: "confidence" }],
		},
	},
	{
		version: 37,
		name: "entity-communities",
		up: entityCommunities,
		artifacts: {
			tables: ["entity_communities"],
			columns: [{ table: "entities", column: "community_id" }],
		},
	},
	{
		version: 38,
		name: "memory-hints",
		up: memoryHints,
		artifacts: { tables: ["memory_hints"] },
	},
	{
		version: 39,
		name: "dedup-entity-dependencies",
		up: dedupEntityDependencies,
	},
	{
		version: 40,
		name: "session-transcripts",
		up: sessionTranscripts,
		artifacts: { tables: ["session_transcripts"] },
	},
	{
		version: 41,
		name: "path-feedback",
		up: pathFeedback,
		artifacts: {
			tables: [
				"path_feedback_events",
				"path_feedback_stats",
				"entity_retrieval_stats",
				"entity_cooccurrence",
				"path_feedback_sessions",
			],
			columns: [{ table: "session_memories", column: "path_json" }],
		},
	},
	{
		version: 42,
		name: "session-memories-agent-id",
		up: sessionMemoriesAgentId,
		artifacts: {
			columns: [{ table: "session_memories", column: "agent_id" }],
		},
	},
	{
		version: 43,
		name: "agents-table",
		up: agentsTable,
		artifacts: {
			tables: ["agents"],
			columns: [
				{ table: "memories", column: "agent_id" },
				{ table: "memories", column: "visibility" },
			],
		},
	},
	{
		version: 44,
		name: "memory-md-temporal-head",
		up: memoryMdTemporalHead,
		artifacts: {
			columns: [
				{ table: "session_summaries", column: "source_type" },
				{ table: "session_summaries", column: "source_ref" },
				{ table: "session_summaries", column: "meta_json" },
			],
		},
	},
	{
		version: 45,
		name: "lossless-working-memory-hardening",
		up: losslessWorkingMemoryHardening,
		artifacts: {
			tables: ["session_transcripts_fts", "memory_md_heads"],
			columns: [
				{ table: "session_transcripts", column: "updated_at" },
				{ table: "summary_jobs", column: "agent_id" },
				{ table: "session_scores", column: "agent_id" },
			],
		},
	},
	{
		version: 46,
		name: "session-summary-uniqueness",
		up: sessionSummaryUniqueness,
	},
	{
		version: 47,
		name: "agent-scoped-temporal-uniqueness",
		up: agentScopedTemporalUniqueness,
	},
	{
		version: 48,
		name: "thread-heads",
		up: threadHeads,
		artifacts: {
			tables: ["memory_thread_heads"],
		},
	},
	{
		version: 49,
		name: "session-extract-cursors",
		up: sessionExtractCursors,
		artifacts: {
			tables: ["session_extract_cursors"],
		},
	},
	{
		version: 50,
		name: "related-to-audit",
		up: relatedToAudit,
		artifacts: {
			tables: ["entity_dependency_history"],
		},
	},
	{
		version: 51,
		name: "memory-md-rolling-window-lineage",
		up: memoryMdRollingWindowLineage,
		artifacts: {
			tables: ["memory_artifacts", "memory_artifact_tombstones", "memory_artifacts_fts"],
			columns: [
				{ table: "summary_jobs", column: "session_id" },
				{ table: "summary_jobs", column: "trigger" },
				{ table: "summary_jobs", column: "captured_at" },
				{ table: "summary_jobs", column: "started_at" },
				{ table: "summary_jobs", column: "ended_at" },
			],
		},
	},
	{
		version: 52,
		name: "mcp-invocations",
		up: mcpInvocations,
		artifacts: {
			tables: ["mcp_invocations"],
		},
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
 * Read-only detector for the v0.1.65 CLI bug: version >= 2 stamped but
 * memories table lacks the `content_hash` column added by migration 002.
 */
function hasBogusVersion(db: MigrationDb): boolean {
	const current = currentVersion(db);
	if (current < 2) return false;
	const cols = db.prepare("PRAGMA table_info(memories)").all();
	return !cols.filter(hasStringName).some((r) => r.name === "content_hash");
}

/**
 * Repair the v0.1.65 CLI bug by deleting the bogus version records so all
 * migrations re-run. Safe because every migration uses CREATE IF NOT EXISTS
 * / addColumnIfMissing. Called only inside runMigrations.
 */
function repairBogusVersion(db: MigrationDb): void {
	if (!hasBogusVersion(db)) return;
	db.exec("DELETE FROM schema_migrations WHERE version > 0");
}

/** Type guard: narrows a query row to one with a string `name` field. */
function hasStringName(row: Record<string, unknown>): row is { name: string } {
	return typeof row.name === "string";
}

/** Type guard: narrows a query row to one with a numeric `version` field. */
function hasNumericVersion(row: Record<string, unknown>): row is { version: number } {
	return typeof row.version === "number";
}

/** Get the set of table names in the database (single query). */
function existingTables(db: MigrationDb): Set<string> {
	const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
	return new Set(rows.filter(hasStringName).map((r) => r.name));
}

/** Get column names for a table, with per-call caching. */
function tableColumns(db: MigrationDb, table: string, cache: Map<string, Set<string>>): Set<string> {
	let cols = cache.get(table);
	if (cols) return cols;
	const rows = db.prepare(`PRAGMA table_info("${table}")`).all();
	cols = new Set(rows.filter(hasStringName).map((r) => r.name));
	cache.set(table, cols);
	return cols;
}

/**
 * Detect phantom migrations — versions recorded in schema_migrations whose
 * expected artifacts (tables/columns) no longer exist. Read-only; does not
 * modify the database.
 *
 * Used by both hasPendingMigrations (detection only) and
 * repairPhantomMigrations (detection + deletion).
 */
function findPhantomVersions(
	db: MigrationDb,
	// Accepts a pre-fetched applied set to avoid a redundant query when
	// the caller already has one (e.g. hasPendingMigrations).
	precomputedApplied?: Set<number>,
): Set<number> {
	const tables = existingTables(db);
	const colCache = new Map<string, Set<string>>();
	const phantoms = new Set<number>();
	const applied = precomputedApplied ?? appliedVersions(db);

	for (const migration of MIGRATIONS) {
		if (!migration.artifacts) continue;

		// Skip v1 — legacy CLI partial schemas handled by repairBogusVersion
		if (migration.version === 1) continue;

		// Not recorded as applied — not a phantom
		if (!applied.has(migration.version)) continue;

		let missing = false;

		if (migration.artifacts.tables) {
			for (const t of migration.artifacts.tables) {
				if (!tables.has(t)) {
					missing = true;
					break;
				}
			}
		}

		if (!missing && migration.artifacts.columns) {
			for (const col of migration.artifacts.columns) {
				if (!tables.has(col.table)) {
					missing = true;
					break;
				}
				const cols = tableColumns(db, col.table, colCache);
				if (!cols.has(col.column)) {
					missing = true;
					break;
				}
			}
		}

		if (missing) phantoms.add(migration.version);
	}

	return phantoms;
}

/**
 * Detect phantom migrations and delete their schema_migrations records so
 * they re-run on the next pass. Logs each repair to stderr.
 *
 * Returns the post-repair applied set so the caller (runMigrations) can
 * use it directly without issuing a redundant appliedVersions() query.
 *
 * schema_migrations_audit rows are intentionally preserved — they are a
 * durable history record that helps diagnose why the phantom occurred.
 * A fresh audit row will be inserted when the migration re-runs.
 */
function repairPhantomMigrations(db: MigrationDb): Set<number> {
	const applied = appliedVersions(db);
	const phantoms = findPhantomVersions(db, applied);

	for (const version of phantoms) {
		const migration = MIGRATIONS.find((m) => m.version === version);
		if (migration) {
			console.error(
				`[signet] phantom migration v${migration.version} (${migration.name}): artifact missing — will re-run`,
			);
		}
		// Only remove from schema_migrations (re-run tracker); audit stays intact
		db.prepare("DELETE FROM schema_migrations WHERE version = ?").run(version);
		applied.delete(version);
	}

	return applied;
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
				// Optional columns skip verification when the table doesn't exist
				// (conditional/repair migrations that are no-ops on fresh schemas).
				if (col.optional) continue;
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
 *
 * Fully read-only: uses hasBogusVersion and findPhantomVersions for
 * detection only — no deletes. All repairs run exclusively inside
 * runMigrations so the daemon's backup version label stays accurate.
 */
export function hasPendingMigrations(db: MigrationDb): boolean {
	ensureMetaTables(db);
	// Single query for applied versions; reused by all three checks below.
	const applied = appliedVersions(db);
	// Derive the bogus-version signal from the already-fetched set rather than
	// calling hasBogusVersion(db) which issues a separate SELECT MAX(version).
	// v0.1.65 bug: version >= 2 stamped but content_hash column is absent.
	const isBogus =
		applied.has(2) &&
		!db
			.prepare("PRAGMA table_info(memories)")
			.all()
			.filter(hasStringName)
			.some((r) => r.name === "content_hash");
	const hasNew = MIGRATIONS.some((m) => !applied.has(m.version));
	const phantoms = findPhantomVersions(db, applied);
	return isBogus || hasNew || phantoms.size > 0;
}

/** The highest migration version defined. */
export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;

/**
 * Assert that MIGRATIONS versions are strictly contiguous (each version
 * equals the previous + 1). Called at the top of runMigrations rather
 * than at module scope to comply with the effect-free module scope rule.
 * Catches registration mistakes (wrong order, gaps, copy-paste version
 * numbers) before any migration runs.
 */
function assertMigrationsSequence(): void {
	for (let i = 1; i < MIGRATIONS.length; i++) {
		const prev = MIGRATIONS[i - 1];
		const curr = MIGRATIONS[i];
		if (prev !== undefined && curr !== undefined && curr.version !== prev.version + 1) {
			throw new Error(
				`MIGRATIONS invariant violated: version ${curr.version} (${curr.name}) ` +
					`must be exactly ${prev.version + 1} (prev: ${prev.name})`,
			);
		}
	}
}

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
	// Guard against mis-registered migrations (wrong order, gaps, duplicates)
	assertMigrationsSequence();

	ensureMetaTables(db);

	// Repair v0.1.65 CLI bug (stamps version without running migrations)
	repairBogusVersion(db);

	// Repair phantom migrations (recorded but artifacts missing).
	// Returns the post-repair applied set to avoid a redundant query.
	const applied = repairPhantomMigrations(db);

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
			).run(migration.version, new Date().toISOString(), Date.now() - start, cs);

			db.exec(`RELEASE migration_${migration.version}`);
		} catch (err) {
			db.exec(`ROLLBACK TO SAVEPOINT migration_${migration.version}`);
			db.exec(`RELEASE migration_${migration.version}`);
			const detail = err instanceof Error ? err.message : String(err);
			throw new Error(
				`Migration ${migration.version} (${migration.name}) failed: ${detail}\n\nYour data is safe — the failed migration was rolled back.\nPlease report this at https://github.com/Signet-AI/signetai/issues\nwith the error message above and your signetai version.`,
			);
		}
	}
}
