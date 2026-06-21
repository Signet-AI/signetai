//! Database migration runner for Signet's SQLite schema.
//!
//! Embeds schema migrations as SQL strings. Each migration runs inside a
//! SAVEPOINT for safe rollback on failure. Idempotent — safe to run on
//! every startup.

use rusqlite::Connection;
use tracing::{error, info, warn};

use crate::error::CoreError;

struct Migration {
    version: u32,
    name: &'static str,
    sql: &'static str,
}

const TS_MEMORY_SEARCH_TELEMETRY_VERSION: u32 = 66;
const TS_MEMORY_SEARCH_TELEMETRY_NAME: &str = "memory-search-telemetry";
const TS_ONTOLOGY_PROPOSALS_VERSION: u32 = 67;
const TS_ONTOLOGY_PROPOSALS_NAME: &str = "ontology-proposals";
const TS_AGENTS_TABLE_VERSION: u32 = 43;
const TS_AGENTS_TABLE_NAME: &str = "agents-table";
const TS_MCP_INVOCATIONS_VERSION: u32 = 52;
const TS_MCP_INVOCATIONS_NAME: &str = "mcp-invocations";
const TS_PATH_FEEDBACK_VERSION: u32 = 41;
const TS_PATH_FEEDBACK_NAME: &str = "path-feedback";
const TS_DREAMING_STATE_VERSION: u32 = 55;
const TS_DREAMING_STATE_NAME: &str = "dreaming-state";
const TS_AGENT_SCOPED_IDEMPOTENCY_VERSION: u32 = 72;
const TS_AGENT_SCOPED_IDEMPOTENCY_NAME: &str = "agent-scoped-idempotency-key";
const TS_ENTITY_ALIASES_VERSION: u32 = 77;
const TS_ENTITY_ALIASES_NAME: &str = "entity-aliases";
const TS_DAILY_REFLECTIONS_VERSION: u32 = 68;
const TS_DAILY_REFLECTIONS_NAME: &str = "daily-reflections";
const TS_DAILY_REFLECTIONS_MULTI_VERSION: u32 = 69;
const TS_DAILY_REFLECTIONS_MULTI_NAME: &str = "daily-reflections-multiple-insights";
const TS_EMBEDDINGS_VECTOR_VERSION: u32 = 32;
const TS_EMBEDDINGS_VECTOR_NAME: &str = "embeddings-vector-column";
const TS_SCOPE_VERSION: u32 = 33;
const TS_SCOPE_NAME: &str = "scope";
const TS_SCOPE_AWARE_DEDUP_VERSION: u32 = 34;
const TS_SCOPE_AWARE_DEDUP_NAME: &str = "scope-aware-dedup";
const TS_ENTITY_FTS_VERSION: u32 = 35;
const TS_ENTITY_FTS_NAME: &str = "entity-fts";
const TS_DEPENDENCY_CONFIDENCE_VERSION: u32 = 36;
const TS_DEPENDENCY_CONFIDENCE_NAME: &str = "dependency-confidence";
const TS_ENTITY_COMMUNITIES_VERSION: u32 = 37;
const TS_ENTITY_COMMUNITIES_NAME: &str = "entity-communities";
const TS_MEMORY_HINTS_VERSION: u32 = 38;
const TS_MEMORY_HINTS_NAME: &str = "memory-hints";
const TS_DEDUP_ENTITY_DEPS_VERSION: u32 = 39;
const TS_DEDUP_ENTITY_DEPS_NAME: &str = "dedup-entity-dependencies";
const TS_SESSION_TRANSCRIPTS_VERSION: u32 = 40;
const TS_SESSION_TRANSCRIPTS_NAME: &str = "session-transcripts";
const TS_SESSION_MEMORIES_AGENT_VERSION: u32 = 42;
const TS_SESSION_MEMORIES_AGENT_NAME: &str = "session-memories-agent-id";
const TS_MEMORY_MD_TEMPORAL_HEAD_VERSION: u32 = 44;
const TS_MEMORY_MD_TEMPORAL_HEAD_NAME: &str = "memory-md-temporal-head";
const TS_LOSSLESS_HARDENING_VERSION: u32 = 45;
const TS_LOSSLESS_HARDENING_NAME: &str = "lossless-working-memory-hardening";
const TS_SESSION_SUMMARY_UNIQUENESS_VERSION: u32 = 46;
const TS_SESSION_SUMMARY_UNIQUENESS_NAME: &str = "session-summary-uniqueness";
const TS_AGENT_TEMPORAL_UNIQUENESS_VERSION: u32 = 47;
const TS_AGENT_TEMPORAL_UNIQUENESS_NAME: &str = "agent-scoped-temporal-uniqueness";
const TS_THREAD_HEADS_VERSION: u32 = 48;
const TS_THREAD_HEADS_NAME: &str = "thread-heads";
const TS_SESSION_EXTRACT_CURSORS_VERSION: u32 = 49;
const TS_SESSION_EXTRACT_CURSORS_NAME: &str = "session-extract-cursors";
const TS_RELATED_TO_AUDIT_VERSION: u32 = 50;
const TS_RELATED_TO_AUDIT_NAME: &str = "related-to-audit";
const TS_MEMORY_MD_LINEAGE_VERSION: u32 = 51;
const TS_MEMORY_MD_LINEAGE_NAME: &str = "memory-md-rolling-window-lineage";
const TS_SKILL_INVOCATIONS_VERSION: u32 = 53;
const TS_SKILL_INVOCATIONS_NAME: &str = "skill-invocations";
const TS_TASK_AGENT_SCOPE_VERSION: u32 = 54;
const TS_TASK_AGENT_SCOPE_NAME: &str = "task-agent-scope";
const TS_AGENT_CONTENT_HASH_VERSION: u32 = 56;
const TS_AGENT_CONTENT_HASH_NAME: &str = "agent-scoped-content-hash";
const TS_FTS_TOKENIZER_REPAIR_VERSION: u32 = 57;
const TS_FTS_TOKENIZER_REPAIR_NAME: &str = "memories-fts-tokenizer-repair";
const TS_KG_INDICES_VERSION: u32 = 58;
const TS_KG_INDICES_NAME: &str = "knowledge-graph-indices";
const TS_ATTR_CLAIM_KEY_VERSION: u32 = 59;
const TS_ATTR_CLAIM_KEY_NAME: &str = "entity-attribute-claim-key";
const TS_ATTR_GROUP_KEY_VERSION: u32 = 60;
const TS_ATTR_GROUP_KEY_NAME: &str = "entity-attribute-group-key";
const TS_ARTIFACT_SOURCE_MTIME_VERSION: u32 = 61;
const TS_ARTIFACT_SOURCE_MTIME_NAME: &str = "memory-artifact-source-mtime";
const TS_ARTIFACT_SOFT_DELETE_VERSION: u32 = 62;
const TS_ARTIFACT_SOFT_DELETE_NAME: &str = "memory-artifact-soft-delete";
const TS_FTS_CONTENT_UPDATE_VERSION: u32 = 63;
const TS_FTS_CONTENT_UPDATE_NAME: &str = "content-only-memories-fts-update";
const TS_SOURCE_GRAPH_PROVENANCE_VERSION: u32 = 64;
const TS_SOURCE_GRAPH_PROVENANCE_NAME: &str = "source-graph-provenance";
const TS_SOURCE_EMBEDDING_SCOPE_VERSION: u32 = 65;
const TS_SOURCE_EMBEDDING_SCOPE_NAME: &str = "source-embedding-agent-scope";
const TS_ONTOLOGY_CP_STATE_VERSION: u32 = 70;
const TS_ONTOLOGY_CP_STATE_NAME: &str = "ontology-control-plane-state";
const TS_EPISTEMIC_ASSERTIONS_VERSION: u32 = 71;
const TS_EPISTEMIC_ASSERTIONS_NAME: &str = "epistemic-assertions";
const TS_RECALL_DEDUPE_VERSION: u32 = 73;
const TS_RECALL_DEDUPE_NAME: &str = "recall-context-dedupe";
const TS_AGGREGATE_LINKS_VERSION: u32 = 74;
const TS_AGGREGATE_LINKS_NAME: &str = "aggregate-memory-links";
const TS_ARTIFACT_SOURCE_PROVENANCE_VERSION: u32 = 75;
const TS_ARTIFACT_SOURCE_PROVENANCE_NAME: &str = "memory-artifact-source-provenance";
const TS_TEMPORAL_EDGES_VERSION: u32 = 76;
const TS_TEMPORAL_EDGES_NAME: &str = "temporal-edges";
const TS_DOCUMENT_SCOPE_COLUMNS_VERSION: u32 = 80;
const TS_DOCUMENT_SCOPE_COLUMNS_NAME: &str = "document-scope-columns";

/// Simple checksum matching the TS implementation (hash of "version:name").
fn checksum(version: u32, name: &str) -> String {
    let s = format!("{version}:{name}");
    let mut h: i32 = 0;
    for b in s.bytes() {
        h = h.wrapping_mul(31).wrapping_add(b as i32);
    }
    format!("{:x}", h as u32)
}

/// Helper: add a required column only if it doesn't already exist.
fn add_column_if_missing(
    conn: &Connection,
    table: &str,
    column: &str,
    typedef: &str,
) -> Result<(), CoreError> {
    let has_col: bool = conn
        .prepare(&format!("PRAGMA table_info(\"{table}\")"))
        .and_then(|mut stmt| {
            let rows = stmt.query_map([], |row| row.get::<_, String>(1))?;
            let names: Vec<String> = rows.filter_map(|r| r.ok()).collect();
            Ok(names.iter().any(|n| n == column))
        })?;

    if !has_col {
        let sql = format!("ALTER TABLE \"{table}\" ADD COLUMN \"{column}\" {typedef}");
        conn.execute_batch(&sql).map_err(|err| {
            error!(%table, %column, %typedef, err = %err, "failed to add required migration column");
            CoreError::from(err)
        })?;
    }

    Ok(())
}

fn table_exists(conn: &Connection, table: &str) -> Result<bool, CoreError> {
    Ok(conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
        [table],
        |row| row.get::<_, i64>(0),
    )? != 0)
}

/// Historical per-migration compatibility shims are best-effort because some
/// older SQL files can legitimately skip the target table. Required runtime
/// parity repair uses `add_column_if_missing` directly and fails startup.
fn add_column_if_missing_best_effort(conn: &Connection, table: &str, column: &str, typedef: &str) {
    match table_exists(conn, table) {
        Ok(true) => {}
        Ok(false) => {
            warn!(%table, %column, %typedef, "skipping optional migration column repair for missing table");
            return;
        }
        Err(err) => {
            warn!(%table, %column, %typedef, err = %err, "skipping optional migration column repair after table lookup failed");
            return;
        }
    }
    if let Err(err) = add_column_if_missing(conn, table, column, typedef) {
        warn!(%table, %column, %typedef, err = %err, "skipping optional migration column repair");
    }
}

/// All schema migrations in order. SQL is idempotent (IF NOT EXISTS / IF MISSING).
static MIGRATIONS: &[Migration] = &[
    Migration {
        version: 1,
        name: "baseline",
        sql: include_str!("sql/001-baseline.sql"),
    },
    Migration {
        version: 2,
        name: "pipeline-v2",
        sql: include_str!("sql/002-pipeline-v2.sql"),
    },
    Migration {
        version: 3,
        name: "unique-content-hash",
        sql: include_str!("sql/003-unique-content-hash.sql"),
    },
    Migration {
        version: 4,
        name: "history-actor-and-retention",
        sql: include_str!("sql/004-history-actor-and-retention.sql"),
    },
    Migration {
        version: 5,
        name: "graph-extended",
        sql: include_str!("sql/005-graph-extended.sql"),
    },
    Migration {
        version: 6,
        name: "idempotency-key",
        sql: include_str!("sql/006-idempotency-key.sql"),
    },
    Migration {
        version: 7,
        name: "documents-and-connectors",
        sql: include_str!("sql/007-documents-and-connectors.sql"),
    },
    Migration {
        version: 8,
        name: "embeddings-unique-hash",
        sql: include_str!("sql/008-embeddings-unique-hash.sql"),
    },
    Migration {
        version: 9,
        name: "summary-jobs",
        sql: include_str!("sql/009-summary-jobs.sql"),
    },
    Migration {
        version: 10,
        name: "umap-cache",
        sql: include_str!("sql/010-umap-cache.sql"),
    },
    Migration {
        version: 11,
        name: "session-scores",
        sql: include_str!("sql/011-session-scores.sql"),
    },
    Migration {
        version: 12,
        name: "scheduled-tasks",
        sql: include_str!("sql/012-scheduled-tasks.sql"),
    },
    Migration {
        version: 13,
        name: "ingestion-tracking",
        sql: include_str!("sql/013-ingestion-tracking.sql"),
    },
    Migration {
        version: 14,
        name: "telemetry",
        sql: include_str!("sql/014-telemetry.sql"),
    },
    Migration {
        version: 15,
        name: "session-memories",
        sql: include_str!("sql/015-session-memories.sql"),
    },
    Migration {
        version: 16,
        name: "session-checkpoints",
        sql: include_str!("sql/016-session-checkpoints.sql"),
    },
    Migration {
        version: 17,
        name: "task-skills",
        sql: include_str!("sql/017-task-skills.sql"),
    },
    Migration {
        version: 18,
        name: "skill-meta",
        sql: include_str!("sql/018-skill-meta.sql"),
    },
    Migration {
        version: 19,
        name: "knowledge-structure",
        sql: include_str!("sql/019-knowledge-structure.sql"),
    },
    Migration {
        version: 20,
        name: "predictor-comparisons",
        sql: include_str!("sql/020-predictor-comparisons.sql"),
    },
    Migration {
        version: 21,
        name: "checkpoint-structural",
        sql: include_str!("sql/021-checkpoint-structural.sql"),
    },
    Migration {
        version: 22,
        name: "entity-pinning",
        sql: include_str!("sql/022-entity-pinning.sql"),
    },
    Migration {
        version: 23,
        name: "predictor-columns",
        sql: include_str!("sql/023-predictor-columns.sql"),
    },
    Migration {
        version: 24,
        name: "predictor-comparison-columns",
        sql: include_str!("sql/024-predictor-comparison-columns.sql"),
    },
    Migration {
        version: 25,
        name: "agent-feedback",
        sql: include_str!("sql/025-agent-feedback.sql"),
    },
    Migration {
        version: 26,
        name: "predictor-training-pairs",
        sql: include_str!("sql/026-predictor-training-pairs.sql"),
    },
    Migration {
        version: 27,
        name: "backfill-canonical-names",
        sql: include_str!("sql/027-backfill-canonical-names.sql"),
    },
    Migration {
        version: 28,
        name: "lossless-retention",
        sql: include_str!("sql/028-lossless-retention.sql"),
    },
    Migration {
        version: 29,
        name: "session-summary-dag",
        sql: include_str!("sql/029-session-summary-dag.sql"),
    },
    Migration {
        version: 30,
        name: "nullable-memory-job-memory-id",
        sql: include_str!("sql/030-nullable-memory-job-memory-id.sql"),
    },
    Migration {
        version: 31,
        name: "dependency-reason",
        sql: include_str!("sql/031-dependency-reason.sql"),
    },
    Migration {
        version: 32,
        name: "session-transcripts",
        sql: include_str!("sql/032-session-transcripts.sql"),
    },
    Migration {
        version: 33,
        name: "session-extract-cursors",
        sql: include_str!("sql/033-session-extract-cursors.sql"),
    },
    Migration {
        version: 34,
        name: "session-transcripts-compound-pk",
        sql: include_str!("sql/034-session-transcripts-compound-pk.sql"),
    },
    Migration {
        version: 35,
        name: "dependency-audit-history",
        sql: include_str!("sql/035-dependency-audit-history.sql"),
    },
    Migration {
        version: 36,
        name: "temporal-heads",
        sql: include_str!("sql/036-temporal-heads.sql"),
    },
    Migration {
        version: 37,
        name: "memory-md-rolling-window-lineage",
        sql: include_str!("sql/037-memory-md-rolling-window-lineage.sql"),
    },
    Migration {
        version: 38,
        name: "skill-invocations",
        sql: include_str!("sql/038-skill-invocations.sql"),
    },
    Migration {
        version: 39,
        name: "task-agent-scope",
        sql: include_str!("sql/039-task-agent-scope.sql"),
    },
];

pub const LATEST_SCHEMA_VERSION: u32 = 39;

/// Ensure meta tables exist (safe on fresh DB).
fn ensure_meta(conn: &Connection) -> Result<(), CoreError> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_migrations (
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
        );",
    )?;
    Ok(())
}

/// Get applied versions as a set.
fn applied(conn: &Connection) -> Result<std::collections::HashSet<u32>, CoreError> {
    let mut stmt = conn.prepare("SELECT version FROM schema_migrations")?;
    let versions = stmt
        .query_map([], |row| row.get::<_, u32>(0))?
        .filter_map(|r| r.ok())
        .collect();
    Ok(versions)
}

/// Run all pending migrations.
pub fn run(conn: &Connection) -> Result<(), CoreError> {
    // Verify contiguous versions
    for (i, pair) in MIGRATIONS.windows(2).enumerate() {
        if pair[1].version != pair[0].version + 1 {
            return Err(CoreError::Migration(format!(
                "migration version gap at index {}: {} -> {}",
                i, pair[0].version, pair[1].version
            )));
        }
    }

    ensure_meta(conn)?;

    // Repair v0.1.65 CLI bug: versions stamped without actual DDL
    repair_bogus_version(conn)?;

    let mut done = applied(conn)?;
    let mut count = 0;

    for m in MIGRATIONS {
        if done.contains(&m.version) {
            continue;
        }

        let start = std::time::Instant::now();
        let cs = checksum(m.version, m.name);
        let sp = format!("migration_{}", m.version);

        conn.execute_batch(&format!("SAVEPOINT {sp}"))?;

        match run_migration_sql(conn, m) {
            Ok(()) => {
                let now = chrono::Utc::now().to_rfc3339();
                let elapsed = start.elapsed().as_millis() as i64;

                conn.execute(
                    "INSERT OR REPLACE INTO schema_migrations (version, applied_at, checksum)
                     VALUES (?1, ?2, ?3)",
                    rusqlite::params![m.version, now, cs],
                )?;

                conn.execute(
                    "INSERT INTO schema_migrations_audit (version, applied_at, duration_ms, checksum)
                     VALUES (?1, ?2, ?3, ?4)",
                    rusqlite::params![m.version, now, elapsed, cs],
                )?;

                conn.execute_batch(&format!("RELEASE {sp}"))?;
                done.insert(m.version);
                count += 1;
                info!(
                    version = m.version,
                    name = m.name,
                    elapsed_ms = elapsed,
                    "migration applied"
                );
            }
            Err(e) => {
                let _ = conn.execute_batch(&format!("ROLLBACK TO SAVEPOINT {sp}"));
                let _ = conn.execute_batch(&format!("RELEASE {sp}"));
                error!(version = m.version, name = m.name, err = %e, "migration failed");
                return Err(CoreError::Migration(format!(
                    "migration {} ({}) failed: {}",
                    m.version, m.name, e
                )));
            }
        }
    }

    if count > 0 {
        info!(count, "migrations applied");
    }

    ensure_cross_daemon_parity_tables(conn)?;
    ensure_cross_daemon_parity_columns(conn)?;

    Ok(())
}

/// Reconcile schema drift between the TypeScript and Rust daemons.
///
/// Some parity columns are required by current Rust route/query code but may be
/// absent in fresh or TS-created databases whose historical migrations stamped
/// versions before Rust learned about the extra columns.
fn ensure_cross_daemon_parity_tables(conn: &Connection) -> Result<(), CoreError> {
    // Existing parity SQL files (040-047)
    conn.execute_batch(include_str!("sql/040-memory-search-telemetry.sql"))?;
    conn.execute_batch(include_str!("sql/041-ontology-proposals.sql"))?;
    conn.execute_batch(include_str!("sql/042-entity-aliases.sql"))?;
    conn.execute_batch(include_str!("sql/043-mcp-invocations.sql"))?;
    conn.execute_batch(include_str!("sql/044-dreaming-state.sql"))?;
    conn.execute_batch(include_str!("sql/045-agents-table.sql"))?;
    conn.execute_batch(include_str!("sql/046-cross-agent-runtime.sql"))?;
    conn.execute_batch(include_str!("sql/047-daily-reflections.sql"))?;
    // New parity SQL files (048-057) covering missing TS migrations
    conn.execute_batch(include_str!("sql/048-entity-communities.sql"))?;
    conn.execute_batch(include_str!("sql/049-memory-hints.sql"))?;
    conn.execute_batch(include_str!("sql/050-path-feedback.sql"))?;
    conn.execute_batch(include_str!("sql/051-epistemic-assertions.sql"))?;
    conn.execute_batch(include_str!("sql/052-session-context-dedupe.sql"))?;
    conn.execute_batch(include_str!("sql/053-aggregate-memory-links.sql"))?;
    conn.execute_batch(include_str!("sql/054-temporal-edges.sql"))?;
    conn.execute_batch(include_str!("sql/055-thread-heads.sql"))?;
    conn.execute_batch(include_str!("sql/056-entity-fts.sql"))?;
    conn.execute_batch(include_str!("sql/057-session-summary-uniqueness.sql"))?;

    // Stamp all TS migration versions whose artifacts are already present in a
    // Rust-created database. The TS migration runner skips by version and then
    // uses phantom-artifact detection before applying anything; compatibility
    // depends on the artifact contract below, not on matching Rust migration
    // names/checksums for version slots that predate TS/Rust divergence.
    stamp_typescript_parity_migration(conn, TS_AGENTS_TABLE_VERSION, TS_AGENTS_TABLE_NAME)?;
    stamp_typescript_parity_migration(
        conn,
        TS_MEMORY_SEARCH_TELEMETRY_VERSION,
        TS_MEMORY_SEARCH_TELEMETRY_NAME,
    )?;
    stamp_typescript_parity_migration(conn, TS_MCP_INVOCATIONS_VERSION, TS_MCP_INVOCATIONS_NAME)?;
    stamp_typescript_parity_migration(conn, TS_DREAMING_STATE_VERSION, TS_DREAMING_STATE_NAME)?;
    stamp_typescript_parity_migration(
        conn,
        TS_DAILY_REFLECTIONS_VERSION,
        TS_DAILY_REFLECTIONS_NAME,
    )?;
    stamp_typescript_parity_migration(
        conn,
        TS_DAILY_REFLECTIONS_MULTI_VERSION,
        TS_DAILY_REFLECTIONS_MULTI_NAME,
    )?;
    stamp_typescript_parity_migration(conn, TS_ENTITY_ALIASES_VERSION, TS_ENTITY_ALIASES_NAME)?;
    // TS 32-39 share version slots with Rust 32-39. Do not overwrite Rust's
    // local rows; the compatibility invariant is that the TS-declared
    // artifacts for those versions exist before the TS daemon opens the DB.
    stamp_typescript_parity_migration(
        conn,
        TS_EMBEDDINGS_VECTOR_VERSION,
        TS_EMBEDDINGS_VECTOR_NAME,
    )?;
    stamp_typescript_parity_migration(conn, TS_SCOPE_VERSION, TS_SCOPE_NAME)?;
    stamp_typescript_parity_migration(
        conn,
        TS_SCOPE_AWARE_DEDUP_VERSION,
        TS_SCOPE_AWARE_DEDUP_NAME,
    )?;
    stamp_typescript_parity_migration(conn, TS_ENTITY_FTS_VERSION, TS_ENTITY_FTS_NAME)?;
    stamp_typescript_parity_migration(
        conn,
        TS_DEPENDENCY_CONFIDENCE_VERSION,
        TS_DEPENDENCY_CONFIDENCE_NAME,
    )?;
    stamp_typescript_parity_migration(
        conn,
        TS_ENTITY_COMMUNITIES_VERSION,
        TS_ENTITY_COMMUNITIES_NAME,
    )?;
    stamp_typescript_parity_migration(conn, TS_MEMORY_HINTS_VERSION, TS_MEMORY_HINTS_NAME)?;
    stamp_typescript_parity_migration(
        conn,
        TS_DEDUP_ENTITY_DEPS_VERSION,
        TS_DEDUP_ENTITY_DEPS_NAME,
    )?;
    // TS 40-42, 44-51, 53-54, 56-65, 70-76
    stamp_typescript_parity_migration(
        conn,
        TS_SESSION_TRANSCRIPTS_VERSION,
        TS_SESSION_TRANSCRIPTS_NAME,
    )?;
    stamp_typescript_parity_migration(conn, TS_PATH_FEEDBACK_VERSION, TS_PATH_FEEDBACK_NAME)?;
    stamp_typescript_parity_migration(
        conn,
        TS_SESSION_MEMORIES_AGENT_VERSION,
        TS_SESSION_MEMORIES_AGENT_NAME,
    )?;
    stamp_typescript_parity_migration(
        conn,
        TS_MEMORY_MD_TEMPORAL_HEAD_VERSION,
        TS_MEMORY_MD_TEMPORAL_HEAD_NAME,
    )?;
    stamp_typescript_parity_migration(
        conn,
        TS_LOSSLESS_HARDENING_VERSION,
        TS_LOSSLESS_HARDENING_NAME,
    )?;
    stamp_typescript_parity_migration(
        conn,
        TS_SESSION_SUMMARY_UNIQUENESS_VERSION,
        TS_SESSION_SUMMARY_UNIQUENESS_NAME,
    )?;
    stamp_typescript_parity_migration(
        conn,
        TS_AGENT_TEMPORAL_UNIQUENESS_VERSION,
        TS_AGENT_TEMPORAL_UNIQUENESS_NAME,
    )?;
    stamp_typescript_parity_migration(conn, TS_THREAD_HEADS_VERSION, TS_THREAD_HEADS_NAME)?;
    stamp_typescript_parity_migration(
        conn,
        TS_SESSION_EXTRACT_CURSORS_VERSION,
        TS_SESSION_EXTRACT_CURSORS_NAME,
    )?;
    stamp_typescript_parity_migration(conn, TS_RELATED_TO_AUDIT_VERSION, TS_RELATED_TO_AUDIT_NAME)?;
    stamp_typescript_parity_migration(
        conn,
        TS_MEMORY_MD_LINEAGE_VERSION,
        TS_MEMORY_MD_LINEAGE_NAME,
    )?;
    stamp_typescript_parity_migration(
        conn,
        TS_SKILL_INVOCATIONS_VERSION,
        TS_SKILL_INVOCATIONS_NAME,
    )?;
    stamp_typescript_parity_migration(conn, TS_TASK_AGENT_SCOPE_VERSION, TS_TASK_AGENT_SCOPE_NAME)?;
    stamp_typescript_parity_migration(
        conn,
        TS_AGENT_CONTENT_HASH_VERSION,
        TS_AGENT_CONTENT_HASH_NAME,
    )?;
    stamp_typescript_parity_migration(
        conn,
        TS_FTS_TOKENIZER_REPAIR_VERSION,
        TS_FTS_TOKENIZER_REPAIR_NAME,
    )?;
    stamp_typescript_parity_migration(conn, TS_KG_INDICES_VERSION, TS_KG_INDICES_NAME)?;
    stamp_typescript_parity_migration(conn, TS_ATTR_CLAIM_KEY_VERSION, TS_ATTR_CLAIM_KEY_NAME)?;
    stamp_typescript_parity_migration(conn, TS_ATTR_GROUP_KEY_VERSION, TS_ATTR_GROUP_KEY_NAME)?;
    stamp_typescript_parity_migration(
        conn,
        TS_ARTIFACT_SOURCE_MTIME_VERSION,
        TS_ARTIFACT_SOURCE_MTIME_NAME,
    )?;
    stamp_typescript_parity_migration(
        conn,
        TS_ARTIFACT_SOFT_DELETE_VERSION,
        TS_ARTIFACT_SOFT_DELETE_NAME,
    )?;
    stamp_typescript_parity_migration(
        conn,
        TS_FTS_CONTENT_UPDATE_VERSION,
        TS_FTS_CONTENT_UPDATE_NAME,
    )?;
    stamp_typescript_parity_migration(
        conn,
        TS_SOURCE_GRAPH_PROVENANCE_VERSION,
        TS_SOURCE_GRAPH_PROVENANCE_NAME,
    )?;
    stamp_typescript_parity_migration(
        conn,
        TS_SOURCE_EMBEDDING_SCOPE_VERSION,
        TS_SOURCE_EMBEDDING_SCOPE_NAME,
    )?;
    stamp_typescript_parity_migration(
        conn,
        TS_ONTOLOGY_CP_STATE_VERSION,
        TS_ONTOLOGY_CP_STATE_NAME,
    )?;
    stamp_typescript_parity_migration(
        conn,
        TS_EPISTEMIC_ASSERTIONS_VERSION,
        TS_EPISTEMIC_ASSERTIONS_NAME,
    )?;
    stamp_typescript_parity_migration(conn, TS_RECALL_DEDUPE_VERSION, TS_RECALL_DEDUPE_NAME)?;
    stamp_typescript_parity_migration(conn, TS_AGGREGATE_LINKS_VERSION, TS_AGGREGATE_LINKS_NAME)?;
    stamp_typescript_parity_migration(
        conn,
        TS_ARTIFACT_SOURCE_PROVENANCE_VERSION,
        TS_ARTIFACT_SOURCE_PROVENANCE_NAME,
    )?;
    stamp_typescript_parity_migration(conn, TS_TEMPORAL_EDGES_VERSION, TS_TEMPORAL_EDGES_NAME)?;
    Ok(())
}

fn ensure_cross_daemon_parity_columns(conn: &Connection) -> Result<(), CoreError> {
    ensure_summary_jobs_required_columns(conn)?;

    add_column_if_missing(conn, "entities", "mentions", "INTEGER NOT NULL DEFAULT 0")?;
    add_column_if_missing(conn, "entities", "pinned", "INTEGER NOT NULL DEFAULT 0")?;
    add_column_if_missing(conn, "entities", "pinned_at", "TEXT")?;
    add_column_if_missing(conn, "entities", "status", "TEXT NOT NULL DEFAULT 'active'")?;
    add_column_if_missing(conn, "entities", "updated_at", "TEXT")?;

    add_column_if_missing(conn, "memories", "agent_id", "TEXT DEFAULT 'default'")?;
    add_column_if_missing(conn, "memories", "visibility", "TEXT DEFAULT 'global'")?;
    add_column_if_missing(conn, "memories", "scope", "TEXT")?;
    add_column_if_missing(conn, "memories", "idempotency_key", "TEXT")?;
    add_column_if_missing(conn, "memories", "runtime_path", "TEXT")?;
    add_column_if_missing(conn, "embeddings", "agent_id", "TEXT")?;
    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_embeddings_agent_source
            ON embeddings(agent_id, source_type, source_id);",
    )?;

    add_column_if_missing(
        conn,
        "connectors",
        "settings_json",
        "TEXT NOT NULL DEFAULT '{}'",
    )?;
    add_column_if_missing(conn, "connectors", "enabled", "INTEGER NOT NULL DEFAULT 1")?;

    let should_backfill_document_scope =
        !typescript_parity_migration_stamped(conn, TS_DOCUMENT_SCOPE_COLUMNS_VERSION)?;
    add_column_if_missing(
        conn,
        "documents",
        "agent_id",
        "TEXT NOT NULL DEFAULT 'default'",
    )?;
    add_column_if_missing(conn, "documents", "project", "TEXT")?;
    if should_backfill_document_scope {
        conn.execute_batch(
            "UPDATE documents
                SET agent_id = NULLIF(TRIM(json_extract(metadata_json, '$.signet.agentId')), '')
              WHERE metadata_json IS NOT NULL
                AND json_valid(metadata_json)
                AND json_type(metadata_json, '$.signet.agentId') = 'text'
                AND NULLIF(TRIM(json_extract(metadata_json, '$.signet.agentId')), '') IS NOT NULL;
             UPDATE documents
                SET project = NULLIF(TRIM(json_extract(metadata_json, '$.signet.project')), '')
              WHERE metadata_json IS NOT NULL
                AND json_valid(metadata_json)
                AND json_type(metadata_json, '$.signet.project') = 'text';
             WITH linked_scope AS (
                SELECT
                    dm.document_id,
                    m.agent_id,
                    m.project,
                    ROW_NUMBER() OVER (
                        PARTITION BY dm.document_id
                        ORDER BY COUNT(*) DESC, m.agent_id, COALESCE(m.project, '')
                    ) AS rank
                FROM document_memories dm
                JOIN memories m ON m.id = dm.memory_id
                WHERE m.agent_id IS NOT NULL
                  AND NULLIF(TRIM(m.agent_id), '') IS NOT NULL
                GROUP BY dm.document_id, m.agent_id, m.project
             )
             UPDATE documents
                SET agent_id = COALESCE((
                        SELECT agent_id FROM linked_scope
                        WHERE linked_scope.document_id = documents.id AND rank = 1
                    ), agent_id),
                    project = (
                        SELECT project FROM linked_scope
                        WHERE linked_scope.document_id = documents.id AND rank = 1
                    )
              WHERE EXISTS (
                    SELECT 1 FROM linked_scope
                    WHERE linked_scope.document_id = documents.id AND rank = 1
                )
                AND NOT (
                    metadata_json IS NOT NULL
                    AND json_valid(metadata_json)
                    AND json_type(metadata_json, '$.signet.agentId') = 'text'
                    AND NULLIF(TRIM(json_extract(metadata_json, '$.signet.agentId')), '') IS NOT NULL
                );
             UPDATE memories
                SET visibility = 'private'
              WHERE id IN (SELECT memory_id FROM document_memories)
                AND type = 'document_chunk'
                AND source_type = 'document'
                AND (visibility IS NULL OR visibility = 'global');",
        )?;
    }
    conn.execute_batch(
        "DROP INDEX IF EXISTS idx_memories_content_hash_unique;
         CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_content_hash_unique
            ON memories(
                content_hash,
                COALESCE(NULLIF(agent_id, ''), 'default'),
                COALESCE(project, ''),
                COALESCE(scope, '__NULL__'),
                COALESCE(visibility, 'global')
            )
            WHERE content_hash IS NOT NULL AND is_deleted = 0;
         CREATE INDEX IF NOT EXISTS idx_documents_agent_project
            ON documents(agent_id, project);
         CREATE INDEX IF NOT EXISTS idx_documents_source_scope
            ON documents(source_url, agent_id, project);",
    )?;
    stamp_typescript_parity_migration(
        conn,
        TS_DOCUMENT_SCOPE_COLUMNS_VERSION,
        TS_DOCUMENT_SCOPE_COLUMNS_NAME,
    )?;

    add_column_if_missing(
        conn,
        "entity_aspects",
        "status",
        "TEXT NOT NULL DEFAULT 'active'",
    )?;

    add_column_if_missing(conn, "entity_attributes", "proposal_id", "TEXT")?;
    add_column_if_missing(conn, "entity_attributes", "group_key", "TEXT")?;
    add_column_if_missing(conn, "entity_attributes", "claim_key", "TEXT")?;
    add_column_if_missing(conn, "entity_attributes", "source_id", "TEXT")?;
    add_column_if_missing(conn, "entity_attributes", "source_kind", "TEXT")?;
    add_column_if_missing(conn, "entity_attributes", "source_path", "TEXT")?;
    add_column_if_missing(conn, "entity_attributes", "source_root", "TEXT")?;
    add_column_if_missing(
        conn,
        "entity_attributes",
        "proposal_evidence",
        "TEXT NOT NULL DEFAULT '[]'",
    )?;
    add_column_if_missing(
        conn,
        "entity_attributes",
        "version",
        "INTEGER NOT NULL DEFAULT 1",
    )?;
    add_column_if_missing(conn, "entity_dependencies", "proposal_id", "TEXT")?;
    add_column_if_missing(conn, "entity_dependencies", "confidence", "REAL")?;
    add_column_if_missing(conn, "entity_dependencies", "reason", "TEXT")?;
    add_column_if_missing(conn, "entity_dependencies", "source_id", "TEXT")?;
    add_column_if_missing(conn, "entity_dependencies", "source_kind", "TEXT")?;
    add_column_if_missing(conn, "entity_dependencies", "source_path", "TEXT")?;
    add_column_if_missing(conn, "entity_dependencies", "source_root", "TEXT")?;
    add_column_if_missing(
        conn,
        "entity_dependencies",
        "proposal_evidence",
        "TEXT NOT NULL DEFAULT '[]'",
    )?;
    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_entity_attributes_proposal
            ON entity_attributes(agent_id, proposal_id);
         CREATE INDEX IF NOT EXISTS idx_entity_dependencies_proposal
            ON entity_dependencies(agent_id, proposal_id);",
    )?;

    conn.execute_batch(
        "DROP INDEX IF EXISTS idx_memories_idempotency_key;
         CREATE UNIQUE INDEX idx_memories_idempotency_key
            ON memories(
                idempotency_key,
                COALESCE(NULLIF(agent_id, ''), 'default'),
                COALESCE(visibility, 'global'),
                COALESCE(scope, '__NULL__')
            )
            WHERE idempotency_key IS NOT NULL AND is_deleted = 0;",
    )?;

    conn.execute_batch(
        "UPDATE connectors
            SET settings_json = CASE
                WHEN json_valid(config_json)
                     AND json_type(config_json, '$.settings') IS NOT NULL
                THEN json_extract(config_json, '$.settings')
                ELSE NULLIF(config_json, '')
            END
          WHERE NULLIF(config_json, '') IS NOT NULL
            AND (
                settings_json IS NULL
                OR settings_json = ''
                OR (
                    settings_json = '{}'
                    AND COALESCE(updated_at, '') = COALESCE(created_at, '')
                    AND COALESCE(
                        CASE
                            WHEN json_valid(config_json)
                            THEN json_extract(config_json, '$.settings')
                        END,
                        '__missing__'
                    ) != '{}'
                )
            );",
    )?;

    stamp_typescript_parity_migration(
        conn,
        TS_ONTOLOGY_PROPOSALS_VERSION,
        TS_ONTOLOGY_PROPOSALS_NAME,
    )?;
    stamp_typescript_parity_migration(
        conn,
        TS_AGENT_SCOPED_IDEMPOTENCY_VERSION,
        TS_AGENT_SCOPED_IDEMPOTENCY_NAME,
    )?;

    // --- Columns from TS migrations 32-76 not yet covered above ---
    // TS 032: embeddings.vector
    add_column_if_missing(conn, "embeddings", "vector", "BLOB")?;
    // TS 033: memories.scope index
    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_memories_scope
            ON memories(scope) WHERE scope IS NOT NULL;",
    )?;
    // TS 037: entities.community_id
    add_column_if_missing(conn, "entities", "community_id", "TEXT")?;
    // TS 041: session_memories.path_json
    add_column_if_missing(conn, "session_memories", "path_json", "TEXT")?;
    // TS 042: session_memories.agent_id
    add_column_if_missing(
        conn,
        "session_memories",
        "agent_id",
        "TEXT NOT NULL DEFAULT 'default'",
    )?;
    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_session_memories_agent_session
            ON session_memories(agent_id, session_key);",
    )?;
    // TS 045: session_transcripts.updated_at, session_scores.agent_id
    add_column_if_missing(conn, "session_transcripts", "updated_at", "TEXT")?;
    add_column_if_missing(
        conn,
        "session_scores",
        "agent_id",
        "TEXT NOT NULL DEFAULT 'default'",
    )?;
    conn.execute_batch(
        "UPDATE session_transcripts
            SET updated_at = COALESCE(updated_at, created_at)
          WHERE updated_at IS NULL;
         UPDATE session_scores
            SET agent_id = COALESCE(agent_id, 'default')
          WHERE agent_id IS NULL OR agent_id = '';
         CREATE INDEX IF NOT EXISTS idx_st_agent_updated
            ON session_transcripts(agent_id, updated_at);
         CREATE INDEX IF NOT EXISTS idx_session_scores_agent_session
            ON session_scores(agent_id, session_key, created_at);",
    )?;
    // TS 058: knowledge graph indices
    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_entities_order
            ON entities(agent_id, pinned DESC, pinned_at DESC, mentions DESC, updated_at DESC, name);
         CREATE INDEX IF NOT EXISTS idx_entities_extracted_mentions
            ON entities(entity_type, mentions)
            WHERE entity_type = 'extracted';",
    )?;
    // TS 059-060: claim_key/group_key indexes
    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_entity_attributes_claim_key
            ON entity_attributes(agent_id, aspect_id, claim_key, status)
            WHERE claim_key IS NOT NULL;
         CREATE INDEX IF NOT EXISTS idx_entity_attributes_group_key
            ON entity_attributes(agent_id, aspect_id, group_key, status)
            WHERE group_key IS NOT NULL;
         CREATE INDEX IF NOT EXISTS idx_entity_attributes_group_claim
            ON entity_attributes(agent_id, aspect_id, group_key, claim_key, status)
            WHERE claim_key IS NOT NULL;",
    )?;
    // TS 061-062: memory_artifacts columns
    add_column_if_missing(conn, "memory_artifacts", "source_mtime_ms", "REAL")?;
    add_column_if_missing(
        conn,
        "memory_artifacts",
        "is_deleted",
        "INTEGER NOT NULL DEFAULT 0",
    )?;
    add_column_if_missing(conn, "memory_artifacts", "deleted_at", "TEXT")?;
    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_memory_artifacts_agent_deleted
            ON memory_artifacts(agent_id, is_deleted, deleted_at);",
    )?;
    // TS 063: content-only FTS trigger
    conn.execute_batch(
        "DROP TRIGGER IF EXISTS memories_au;
         CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE OF content ON memories BEGIN
            INSERT INTO memories_fts(memories_fts, rowid, content)
            VALUES('delete', old.rowid, old.content);
            INSERT INTO memories_fts(rowid, content)
            VALUES (new.rowid, new.content);
         END;",
    )?;
    // TS 064: source graph provenance columns on entities
    add_column_if_missing(conn, "entities", "source_id", "TEXT")?;
    add_column_if_missing(conn, "entities", "source_kind", "TEXT")?;
    add_column_if_missing(conn, "entities", "source_path", "TEXT")?;
    add_column_if_missing(conn, "entities", "source_root", "TEXT")?;
    add_column_if_missing(conn, "entity_communities", "source_id", "TEXT")?;
    add_column_if_missing(conn, "entity_communities", "source_kind", "TEXT")?;
    add_column_if_missing(conn, "entity_communities", "source_path", "TEXT")?;
    add_column_if_missing(conn, "entity_communities", "source_root", "TEXT")?;
    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_entities_source
            ON entities(agent_id, source_id, source_path);
         CREATE INDEX IF NOT EXISTS idx_entity_communities_source
            ON entity_communities(agent_id, source_id, source_path);
         CREATE INDEX IF NOT EXISTS idx_entity_attributes_source
            ON entity_attributes(agent_id, source_id, source_path);
         CREATE INDEX IF NOT EXISTS idx_entity_dependencies_source_origin
            ON entity_dependencies(agent_id, source_id, source_path);",
    )?;
    // TS 069: daily_reflections.content_key
    add_column_if_missing(conn, "daily_reflections", "content_key", "TEXT")?;
    conn.execute_batch(
        "DROP INDEX IF EXISTS idx_daily_reflections_agent_date;
         CREATE INDEX IF NOT EXISTS idx_daily_reflections_agent_created
            ON daily_reflections(agent_id, created_at DESC);
         CREATE INDEX IF NOT EXISTS idx_daily_reflections_agent_date
            ON daily_reflections(agent_id, date, created_at DESC);
         CREATE UNIQUE INDEX IF NOT EXISTS idx_daily_reflections_agent_content_key
            ON daily_reflections(agent_id, date, content_key)
            WHERE content_key IS NOT NULL;",
    )?;
    // TS 070: ontology control plane state columns
    add_column_if_missing(conn, "entities", "archived_at", "TEXT")?;
    add_column_if_missing(conn, "entities", "archived_by", "TEXT")?;
    add_column_if_missing(conn, "entities", "archive_reason", "TEXT")?;
    add_column_if_missing(conn, "entities", "proposal_id", "TEXT")?;
    add_column_if_missing(
        conn,
        "entities",
        "proposal_evidence",
        "TEXT NOT NULL DEFAULT '[]'",
    )?;
    add_column_if_missing(conn, "entity_aspects", "archived_at", "TEXT")?;
    add_column_if_missing(conn, "entity_aspects", "archived_by", "TEXT")?;
    add_column_if_missing(conn, "entity_aspects", "archive_reason", "TEXT")?;
    add_column_if_missing(conn, "entity_aspects", "proposal_id", "TEXT")?;
    add_column_if_missing(
        conn,
        "entity_aspects",
        "proposal_evidence",
        "TEXT NOT NULL DEFAULT '[]'",
    )?;
    add_column_if_missing(
        conn,
        "entity_dependencies",
        "status",
        "TEXT NOT NULL DEFAULT 'active'",
    )?;
    add_column_if_missing(conn, "entity_dependencies", "archived_at", "TEXT")?;
    add_column_if_missing(conn, "entity_dependencies", "archived_by", "TEXT")?;
    add_column_if_missing(conn, "entity_dependencies", "archive_reason", "TEXT")?;
    add_column_if_missing(conn, "entity_attributes", "version_root_id", "TEXT")?;
    add_column_if_missing(conn, "entity_attributes", "previous_attribute_id", "TEXT")?;
    add_column_if_missing(conn, "entity_attributes", "archived_at", "TEXT")?;
    add_column_if_missing(conn, "entity_attributes", "archived_by", "TEXT")?;
    add_column_if_missing(conn, "entity_attributes", "archive_reason", "TEXT")?;
    conn.execute_batch(
        "UPDATE entity_attributes
            SET version_root_id = id
          WHERE version_root_id IS NULL;
         CREATE INDEX IF NOT EXISTS idx_entities_status
            ON entities(agent_id, status, updated_at DESC);
         CREATE INDEX IF NOT EXISTS idx_entity_aspects_status
            ON entity_aspects(agent_id, entity_id, status);
         CREATE INDEX IF NOT EXISTS idx_entity_attributes_version_root
            ON entity_attributes(agent_id, version_root_id, version DESC);
         CREATE INDEX IF NOT EXISTS idx_entity_attributes_claim_version
            ON entity_attributes(agent_id, aspect_id, group_key, claim_key, version DESC);
         CREATE INDEX IF NOT EXISTS idx_entity_dependencies_status
            ON entity_dependencies(agent_id, status, updated_at DESC);
         CREATE INDEX IF NOT EXISTS idx_entities_proposal
            ON entities(agent_id, proposal_id);
         CREATE INDEX IF NOT EXISTS idx_entity_aspects_proposal
            ON entity_aspects(agent_id, proposal_id);",
    )?;
    // TS 075: memory_artifacts source provenance
    add_column_if_missing(conn, "memory_artifacts", "source_id", "TEXT")?;
    add_column_if_missing(conn, "memory_artifacts", "source_root", "TEXT")?;
    add_column_if_missing(conn, "memory_artifacts", "source_external_id", "TEXT")?;
    add_column_if_missing(conn, "memory_artifacts", "source_parent_path", "TEXT")?;
    add_column_if_missing(conn, "memory_artifacts", "source_meta_json", "TEXT")?;
    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_memory_artifacts_agent_source
            ON memory_artifacts(agent_id, source_id, source_external_id);
         CREATE INDEX IF NOT EXISTS idx_memory_artifacts_agent_source_root
            ON memory_artifacts(agent_id, source_id, source_root);",
    )?;

    Ok(())
}

fn ensure_summary_jobs_required_columns(conn: &Connection) -> Result<(), CoreError> {
    for (column, typedef) in [
        ("session_id", "TEXT"),
        ("trigger", "TEXT NOT NULL DEFAULT 'session_end'"),
        ("captured_at", "TEXT"),
        ("started_at", "TEXT"),
        ("ended_at", "TEXT"),
        ("leased_at", "TEXT"),
        ("updated_at", "TEXT"),
        ("failed_at", "TEXT"),
        ("agent_id", "TEXT NOT NULL DEFAULT 'default'"),
    ] {
        add_column_if_missing(conn, "summary_jobs", column, typedef)?;
    }

    conn.execute_batch(
        "UPDATE summary_jobs
            SET session_id = COALESCE(session_id, session_key, id),
                trigger = COALESCE(NULLIF(trigger, ''), 'session_end'),
                captured_at = COALESCE(captured_at, completed_at, created_at),
                ended_at = COALESCE(ended_at, completed_at),
                updated_at = COALESCE(updated_at, completed_at, created_at),
                agent_id = COALESCE(NULLIF(agent_id, ''), 'default')
          WHERE 1 = 1;
         CREATE INDEX IF NOT EXISTS idx_summary_jobs_agent_trigger
            ON summary_jobs(agent_id, trigger, created_at);
         CREATE INDEX IF NOT EXISTS idx_summary_jobs_agent_session
            ON summary_jobs(agent_id, session_key, created_at);",
    )?;

    Ok(())
}

fn typescript_parity_migration_stamped(conn: &Connection, version: u32) -> Result<bool, CoreError> {
    conn.query_row(
        "SELECT COUNT(*) FROM schema_migrations WHERE version = ?1",
        [version],
        |row| row.get::<_, i64>(0),
    )
    .map(|count| count > 0)
    .map_err(CoreError::from)
}

fn stamp_typescript_parity_migration(
    conn: &Connection,
    version: u32,
    name: &str,
) -> Result<(), CoreError> {
    let already_stamped = typescript_parity_migration_stamped(conn, version)?;
    if already_stamped {
        return Ok(());
    }

    let now = chrono::Utc::now().to_rfc3339();
    let cs = checksum(version, name);
    conn.execute(
        "INSERT INTO schema_migrations (version, applied_at, checksum)
         VALUES (?1, ?2, ?3)",
        rusqlite::params![version, now, cs],
    )?;
    conn.execute(
        "INSERT INTO schema_migrations_audit (version, applied_at, duration_ms, checksum)
         VALUES (?1, ?2, 0, ?3)",
        rusqlite::params![version, now, cs],
    )?;
    Ok(())
}

/// Execute a single migration's SQL. Migrations that need programmatic
/// logic (ADD COLUMN IF MISSING) use the helper.
fn run_migration_sql(conn: &Connection, m: &Migration) -> Result<(), CoreError> {
    // Most migrations are pure SQL with IF NOT EXISTS guards
    conn.execute_batch(m.sql)?;

    // Some migrations need programmatic column adds (SQLite lacks IF NOT EXISTS for ALTER TABLE).
    // The SQL files handle the pure DDL; we handle column adds here.
    match m.version {
        2 => {
            // pipeline-v2: add columns to memories
            for col in &[
                ("memories", "content_hash", "TEXT"),
                ("memories", "normalized_content", "TEXT"),
                ("memories", "is_deleted", "INTEGER DEFAULT 0"),
                ("memories", "deleted_at", "TEXT"),
                ("memories", "extraction_status", "TEXT DEFAULT 'none'"),
                ("memories", "embedding_model", "TEXT"),
                ("memories", "extraction_model", "TEXT"),
                ("memories", "update_count", "INTEGER DEFAULT 0"),
                ("memories", "runtime_path", "TEXT"),
            ] {
                add_column_if_missing_best_effort(conn, col.0, col.1, col.2);
            }
            // Indexes on programmatically-added columns
            conn.execute_batch(
                "CREATE INDEX IF NOT EXISTS idx_memories_content_hash ON memories(content_hash);
                 CREATE INDEX IF NOT EXISTS idx_memories_is_deleted ON memories(is_deleted);
                 CREATE INDEX IF NOT EXISTS idx_memories_extraction_status ON memories(extraction_status);",
            )?;
        }
        4 => {
            add_column_if_missing_best_effort(conn, "memory_history", "actor_type", "TEXT");
            add_column_if_missing_best_effort(conn, "memory_history", "session_id", "TEXT");
            add_column_if_missing_best_effort(conn, "memory_history", "request_id", "TEXT");
        }
        5 => {
            add_column_if_missing_best_effort(conn, "entities", "canonical_name", "TEXT");
            add_column_if_missing_best_effort(conn, "relations", "mentions", "INTEGER DEFAULT 1");
            add_column_if_missing_best_effort(conn, "relations", "confidence", "REAL DEFAULT 0.5");
            add_column_if_missing_best_effort(conn, "relations", "updated_at", "TEXT");
            add_column_if_missing_best_effort(
                conn,
                "memory_entity_mentions",
                "mention_text",
                "TEXT",
            );
            add_column_if_missing_best_effort(conn, "memory_entity_mentions", "confidence", "REAL");
            add_column_if_missing_best_effort(conn, "memory_entity_mentions", "created_at", "TEXT");
            conn.execute_batch(
                "CREATE INDEX IF NOT EXISTS idx_entities_canonical_name ON entities(canonical_name);",
            )?;
        }
        6 => {
            add_column_if_missing_best_effort(conn, "memories", "idempotency_key", "TEXT");
            conn.execute_batch(
                "CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_idempotency_key
                     ON memories(idempotency_key) WHERE idempotency_key IS NOT NULL;",
            )?;
        }
        7 => {
            add_column_if_missing_best_effort(conn, "memory_jobs", "document_id", "TEXT");
        }
        13 => {
            add_column_if_missing_best_effort(conn, "memories", "source_path", "TEXT");
            add_column_if_missing_best_effort(conn, "memories", "source_section", "TEXT");
        }
        15 => {
            add_column_if_missing_best_effort(conn, "session_scores", "confidence", "REAL");
            add_column_if_missing_best_effort(
                conn,
                "session_scores",
                "continuity_reasoning",
                "TEXT",
            );
        }
        17 => {
            add_column_if_missing_best_effort(conn, "scheduled_tasks", "skill_name", "TEXT");
            add_column_if_missing_best_effort(
                conn,
                "scheduled_tasks",
                "skill_mode",
                "TEXT CHECK (skill_mode IN ('inject', 'slash') OR skill_mode IS NULL)",
            );
        }
        19 => {
            add_column_if_missing_best_effort(
                conn,
                "entities",
                "agent_id",
                "TEXT NOT NULL DEFAULT 'default'",
            );
            add_column_if_missing_best_effort(
                conn,
                "entities",
                "pinned",
                "INTEGER NOT NULL DEFAULT 0",
            );
            add_column_if_missing_best_effort(conn, "entities", "pinned_at", "TEXT");
            add_column_if_missing_best_effort(conn, "entities", "embedding", "BLOB");
            conn.execute_batch(
                "CREATE INDEX IF NOT EXISTS idx_entities_agent ON entities(agent_id);",
            )?;
        }
        20 => {
            add_column_if_missing_best_effort(conn, "session_memories", "entity_slot", "INTEGER");
            add_column_if_missing_best_effort(conn, "session_memories", "aspect_slot", "INTEGER");
            add_column_if_missing_best_effort(
                conn,
                "session_memories",
                "is_constraint",
                "INTEGER NOT NULL DEFAULT 0",
            );
            add_column_if_missing_best_effort(
                conn,
                "session_memories",
                "structural_density",
                "INTEGER",
            );
        }
        21 => {
            add_column_if_missing_best_effort(
                conn,
                "session_checkpoints",
                "focal_entity_ids",
                "TEXT",
            );
            add_column_if_missing_best_effort(
                conn,
                "session_checkpoints",
                "focal_entity_names",
                "TEXT",
            );
            add_column_if_missing_best_effort(
                conn,
                "session_checkpoints",
                "active_aspect_ids",
                "TEXT",
            );
            add_column_if_missing_best_effort(
                conn,
                "session_checkpoints",
                "surfaced_constraint_count",
                "INTEGER",
            );
            add_column_if_missing_best_effort(
                conn,
                "session_checkpoints",
                "traversal_memory_count",
                "INTEGER",
            );
        }
        22 => {
            add_column_if_missing_best_effort(
                conn,
                "entities",
                "pinned",
                "INTEGER NOT NULL DEFAULT 0",
            );
            add_column_if_missing_best_effort(conn, "entities", "pinned_at", "TEXT");
        }
        23 => {
            add_column_if_missing_best_effort(
                conn,
                "session_memories",
                "predictor_rank",
                "INTEGER",
            );
        }
        24 => {
            add_column_if_missing_best_effort(
                conn,
                "predictor_comparisons",
                "scorer_confidence",
                "REAL NOT NULL DEFAULT 0",
            );
            add_column_if_missing_best_effort(
                conn,
                "predictor_comparisons",
                "success_rate",
                "REAL NOT NULL DEFAULT 0.5",
            );
            add_column_if_missing_best_effort(
                conn,
                "predictor_comparisons",
                "predictor_top_ids",
                "TEXT NOT NULL DEFAULT '[]'",
            );
            add_column_if_missing_best_effort(
                conn,
                "predictor_comparisons",
                "baseline_top_ids",
                "TEXT NOT NULL DEFAULT '[]'",
            );
            add_column_if_missing_best_effort(
                conn,
                "predictor_comparisons",
                "relevance_scores",
                "TEXT NOT NULL DEFAULT '{}'",
            );
            add_column_if_missing_best_effort(
                conn,
                "predictor_comparisons",
                "fts_overlap_score",
                "REAL",
            );
        }
        25 => {
            add_column_if_missing_best_effort(
                conn,
                "session_memories",
                "agent_relevance_score",
                "REAL",
            );
            add_column_if_missing_best_effort(
                conn,
                "session_memories",
                "agent_feedback_count",
                "INTEGER DEFAULT 0",
            );
        }
        30 => {
            add_column_if_missing_best_effort(conn, "memory_jobs", "document_id", "TEXT");
        }
        31 => {
            add_column_if_missing_best_effort(conn, "entity_dependencies", "reason", "TEXT");
            add_column_if_missing_best_effort(conn, "entities", "last_synthesized_at", "TEXT");
        }
        34 => {
            // Rebuild session_transcripts with compound (session_key, agent_id) PK.
            // Skip only when agent_id is already a PRIMARY KEY member (PRAGMA
            // table_info column 5 = pk, nonzero = part of the PK). Checking just
            // for column existence would incorrectly skip when agent_id was added
            // by a different migration as a regular column without PK membership.
            //
            // Two scenarios for the old table when this migration runs:
            // (a) Fresh Rust install: migration 032 created session_transcripts
            //     without agent_id → SELECT must use literal 'default'
            // (b) Cross-daemon: TS daemon ran first and added agent_id as a
            //     regular (non-PK) column → SELECT must use COALESCE(agent_id, 'default')
            let cols: Vec<(String, i64)> = conn
                .prepare("PRAGMA table_info(session_transcripts)")?
                .query_map([], |row| {
                    let name: String = row.get(1)?;
                    let pk: i64 = row.get(5)?;
                    Ok((name, pk))
                })?
                .filter_map(|r| r.ok())
                .collect();

            let agent_id_in_pk = cols.iter().any(|(name, pk)| name == "agent_id" && *pk > 0);
            let agent_id_col_exists = cols.iter().any(|(name, _)| name == "agent_id");

            if !agent_id_in_pk {
                // Build the agent_id expression for the SELECT based on whether
                // the column already exists in the source table.
                let agent_id_expr = if agent_id_col_exists {
                    "COALESCE(agent_id, 'default')"
                } else {
                    "'default'"
                };
                let sql = format!(
                    "CREATE TABLE session_transcripts_new (
                        session_key TEXT NOT NULL,
                        agent_id    TEXT NOT NULL DEFAULT 'default',
                        content     TEXT NOT NULL,
                        harness     TEXT,
                        project     TEXT,
                        created_at  TEXT NOT NULL,
                        PRIMARY KEY (session_key, agent_id)
                    );
                    INSERT OR IGNORE INTO session_transcripts_new
                        (session_key, agent_id, content, harness, project, created_at)
                    SELECT session_key, {agent_id_expr}, content, harness, project, created_at
                    FROM session_transcripts;
                    DROP TABLE session_transcripts;
                    ALTER TABLE session_transcripts_new RENAME TO session_transcripts;
                    CREATE INDEX IF NOT EXISTS idx_st_project
                        ON session_transcripts(project);
                    CREATE INDEX IF NOT EXISTS idx_st_created
                        ON session_transcripts(created_at);"
                );
                conn.execute_batch(&sql)?;
            }
        }

        // Migration 35 (dependency-audit-history) — merged from main branch.
        // This arm runs only when migration 35 is first applied. Installs
        // already at v35 upgrading to this branch (which adds 36 + 37) will
        // NOT re-execute this arm — the session_summaries work was applied
        // when they upgraded to v35 and is idempotent via IF NOT EXISTS guards.
        35 => {
            add_column_if_missing_best_effort(conn, "session_summaries", "source_type", "TEXT");
            add_column_if_missing_best_effort(conn, "session_summaries", "source_ref", "TEXT");
            add_column_if_missing_best_effort(conn, "session_summaries", "meta_json", "TEXT");
            conn.execute_batch(
                "UPDATE session_summaries
                    SET source_type = CASE
                        WHEN source_type IS NOT NULL AND TRIM(source_type) != '' THEN source_type
                        WHEN kind = 'session' THEN 'summary'
                        WHEN kind = 'arc' THEN 'arc'
                        WHEN kind = 'epoch' THEN 'epoch'
                        ELSE 'summary'
                    END
                  WHERE source_type IS NULL OR TRIM(source_type) = '';
                 CREATE INDEX IF NOT EXISTS idx_summaries_source_type
                    ON session_summaries(source_type);
                 CREATE INDEX IF NOT EXISTS idx_summaries_source_ref
                    ON session_summaries(source_ref);
                 DROP INDEX IF EXISTS idx_summaries_session_depth;
                 DROP INDEX IF EXISTS idx_summaries_session_agent_depth;
                 CREATE UNIQUE INDEX IF NOT EXISTS idx_summaries_session_agent_depth
                    ON session_summaries(agent_id, session_key, depth)
                    WHERE session_key IS NOT NULL
                      AND COALESCE(source_type, 'summary') = 'summary';",
            )?;
        }
        37 => {
            for col in &[
                ("summary_jobs", "session_id", "TEXT"),
                (
                    "summary_jobs",
                    "trigger",
                    "TEXT NOT NULL DEFAULT 'session_end'",
                ),
                ("summary_jobs", "captured_at", "TEXT"),
                ("summary_jobs", "started_at", "TEXT"),
                ("summary_jobs", "ended_at", "TEXT"),
                ("summary_jobs", "leased_at", "TEXT"),
                ("summary_jobs", "updated_at", "TEXT"),
                ("summary_jobs", "failed_at", "TEXT"),
                (
                    "summary_jobs",
                    "agent_id",
                    "TEXT NOT NULL DEFAULT 'default'",
                ),
            ] {
                add_column_if_missing_best_effort(conn, col.0, col.1, col.2);
            }
            conn.execute_batch(
                "UPDATE summary_jobs
                    SET session_id = COALESCE(session_id, session_key, id),
                        trigger = COALESCE(NULLIF(trigger, ''), 'session_end'),
                        captured_at = COALESCE(captured_at, completed_at, created_at),
                        ended_at = COALESCE(ended_at, completed_at),
                        updated_at = COALESCE(updated_at, completed_at, created_at),
                        agent_id = COALESCE(NULLIF(agent_id, ''), 'default')
                  WHERE 1 = 1;
                 CREATE INDEX IF NOT EXISTS idx_summary_jobs_agent_trigger
                    ON summary_jobs(agent_id, trigger, created_at);
                 CREATE INDEX IF NOT EXISTS idx_summary_jobs_agent_session
                    ON summary_jobs(agent_id, session_key, created_at);
                 INSERT INTO memory_artifacts_fts(memory_artifacts_fts)
                 VALUES ('rebuild');",
            )?;
        }
        _ => {}
    }

    // Cross-daemon parity: keep scoped memory columns/indexes aligned.
    if m.version >= 2 {
        add_column_if_missing_best_effort(
            conn,
            "memories",
            "agent_id",
            "TEXT NOT NULL DEFAULT 'default'",
        );
        add_column_if_missing_best_effort(
            conn,
            "memories",
            "visibility",
            "TEXT NOT NULL DEFAULT 'global'",
        );
        add_column_if_missing_best_effort(conn, "memories", "scope", "TEXT");
        conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_memories_agent_visibility_scope
                ON memories(agent_id, visibility, scope);
             DROP INDEX IF EXISTS idx_memories_content_hash_unique;
             DROP INDEX IF EXISTS idx_memories_content_hash;
             CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_content_hash_unique
                ON memories(content_hash, agent_id, IFNULL(scope, ''), visibility)
                WHERE content_hash IS NOT NULL AND is_deleted = 0;",
        )?;
    }

    Ok(())
}

/// Detect and repair v0.1.65 CLI bug (versions stamped without DDL).
fn repair_bogus_version(conn: &Connection) -> Result<(), CoreError> {
    let max_version: Option<u32> = conn
        .query_row("SELECT MAX(version) FROM schema_migrations", [], |r| {
            r.get(0)
        })
        .ok();

    if max_version.unwrap_or(0) < 2 {
        return Ok(());
    }

    // Check if content_hash column exists on memories
    let has_content_hash: bool = conn
        .prepare("PRAGMA table_info(memories)")?
        .query_map([], |row| row.get::<_, String>(1))?
        .filter_map(|r| r.ok())
        .any(|name| name == "content_hash");

    if !has_content_hash {
        warn!("detected v0.1.65 CLI bug — clearing bogus schema_migrations");
        conn.execute("DELETE FROM schema_migrations WHERE version > 0", [])?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_table_exists(conn: &Connection, table: &str) {
        let exists: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                [table],
                |row| row.get(0),
            )
            .expect("query sqlite_master");
        assert_eq!(exists, 1, "{table} should exist");
    }

    fn assert_column_exists(conn: &Connection, table: &str, column: &str) {
        let exists = conn
            .prepare(&format!("PRAGMA table_info(\"{table}\")"))
            .expect("prepare table_info")
            .query_map([], |row| row.get::<_, String>(1))
            .expect("query table_info")
            .filter_map(Result::ok)
            .any(|name| name == column);
        assert!(exists, "{table}.{column} should exist");
    }

    fn assert_migration_stamped(conn: &Connection, version: i64) {
        let stamped: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM schema_migrations WHERE version = ?1",
                [version],
                |row| row.get(0),
            )
            .expect("query schema_migrations");
        assert_eq!(
            stamped, 1,
            "TS migration {version} should be recorded in schema_migrations"
        );
    }

    #[test]
    fn backfills_connector_settings_from_config_json_when_default_empty_object_exists() {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        run(&conn).expect("initial migrations run");
        conn.execute(
            r#"INSERT INTO connectors (id, provider, display_name, config_json, created_at, updated_at)
             VALUES ('obsidian-main', 'obsidian', 'Obsidian', '{"vault":"/tmp/vault"}', datetime('now'), datetime('now'))"#,
            [],
        )
        .expect("insert TS-style connector");

        let before: String = conn
            .query_row(
                "SELECT settings_json FROM connectors WHERE id = 'obsidian-main'",
                [],
                |row| row.get(0),
            )
            .expect("read default settings_json");
        assert_eq!(before, "{}");

        run(&conn).expect("rerun migrations backfills settings_json");

        let after: String = conn
            .query_row(
                "SELECT settings_json FROM connectors WHERE id = 'obsidian-main'",
                [],
                |row| row.get(0),
            )
            .expect("read backfilled settings_json");
        assert_eq!(after, r#"{"vault":"/tmp/vault"}"#);

        conn.execute(
            r#"UPDATE connectors
               SET settings_json = '{}', updated_at = datetime('now', '+1 second')
               WHERE id = 'obsidian-main'"#,
            [],
        )
        .expect("simulate intentional empty settings payload");

        run(&conn).expect("rerun migrations preserves intentional empty settings");

        let intentional_empty: String = conn
            .query_row(
                "SELECT settings_json FROM connectors WHERE id = 'obsidian-main'",
                [],
                |row| row.get(0),
            )
            .expect("read intentionally empty settings_json");
        assert_eq!(intentional_empty, "{}");
    }

    #[test]
    fn connector_settings_repair_preserves_rust_wrapper_with_empty_settings() {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        run(&conn).expect("initial migrations run");
        conn.execute(
            r#"INSERT INTO connectors
               (id, provider, display_name, config_json, settings_json, created_at, updated_at)
               VALUES
               (
                 'local-empty',
                 'obsidian',
                 'Obsidian',
                 '{"id":"local-empty","provider":"obsidian","displayName":"Obsidian","settings":{},"enabled":true}',
                 '{}',
                 datetime('now'),
                 datetime('now')
               )"#,
            [],
        )
        .expect("insert Rust-style connector with intentionally empty settings");

        run(&conn).expect("rerun migrations preserves intentionally empty wrapper settings");

        let settings: String = conn
            .query_row(
                "SELECT settings_json FROM connectors WHERE id = 'local-empty'",
                [],
                |row| row.get(0),
            )
            .expect("read settings_json");
        assert_eq!(settings, "{}");
    }

    #[test]
    fn connector_settings_repair_backfills_from_rust_wrapper_inner_settings() {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        run(&conn).expect("initial migrations run");
        conn.execute(
            r#"INSERT INTO connectors
               (id, provider, display_name, config_json, settings_json, created_at, updated_at)
               VALUES
               (
                 'local-configured',
                 'obsidian',
                 'Obsidian',
                 '{"id":"local-configured","provider":"obsidian","displayName":"Obsidian","settings":{"vault":"/tmp/vault"},"enabled":true}',
                 '{}',
                 datetime('now'),
                 datetime('now')
               )"#,
            [],
        )
        .expect("insert Rust-style connector with default settings_json");

        run(&conn).expect("rerun migrations backfills inner wrapper settings");

        let settings: String = conn
            .query_row(
                "SELECT settings_json FROM connectors WHERE id = 'local-configured'",
                [],
                |row| row.get(0),
            )
            .expect("read settings_json");
        assert_eq!(settings, r#"{"vault":"/tmp/vault"}"#);
    }

    #[test]
    fn records_ts_parity_migrations_with_artifact_backing() {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        run(&conn).expect("initial migrations run");

        for (version, table) in [
            (43_i64, "agents"),
            (52_i64, "mcp_invocations"),
            (55_i64, "dreaming_state"),
            (66_i64, "memory_search_telemetry"),
            (67_i64, "ontology_proposals"),
            (68_i64, "daily_reflections"),
            (69_i64, "daily_reflections"),
            (77_i64, "entity_aliases"),
        ] {
            assert_table_exists(&conn, table);
            assert_migration_stamped(&conn, version);
        }

        assert_migration_stamped(&conn, 72);

        // Rust-created databases should present a complete TS migration ledger
        // through the current TS schema when every TS-declared artifact exists.
        for version in 32_i64..=77_i64 {
            assert_migration_stamped(&conn, version);
        }
    }

    #[test]
    fn rust_created_schema_satisfies_typescript_migration_artifacts() {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        run(&conn).expect("initial migrations run");

        for table in [
            "entity_communities",
            "memory_hints",
            "session_transcripts",
            "path_feedback_events",
            "path_feedback_stats",
            "entity_retrieval_stats",
            "entity_cooccurrence",
            "path_feedback_sessions",
            "agents",
            "memory_thread_heads",
            "session_extract_cursors",
            "entity_dependency_history",
            "memory_artifacts",
            "memory_artifact_tombstones",
            "memory_artifacts_fts",
            "mcp_invocations",
            "skill_invocations",
            "task_scope_hints",
            "dreaming_state",
            "dreaming_passes",
            "memory_search_telemetry",
            "ontology_proposals",
            "daily_reflections",
            "epistemic_assertions",
            "session_context_epochs",
            "session_recall_events",
            "aggregate_memory_sources",
            "temporal_edges",
            "entity_aliases",
        ] {
            assert_table_exists(&conn, table);
        }

        for (table, column) in [
            ("embeddings", "vector"),
            ("memories", "scope"),
            ("entity_dependencies", "confidence"),
            ("entities", "community_id"),
            ("session_memories", "path_json"),
            ("session_memories", "agent_id"),
            ("memories", "agent_id"),
            ("memories", "visibility"),
            ("session_summaries", "source_type"),
            ("session_summaries", "source_ref"),
            ("session_summaries", "meta_json"),
            ("session_transcripts", "updated_at"),
            ("summary_jobs", "agent_id"),
            ("session_scores", "agent_id"),
            ("summary_jobs", "session_id"),
            ("summary_jobs", "trigger"),
            ("summary_jobs", "captured_at"),
            ("summary_jobs", "started_at"),
            ("summary_jobs", "ended_at"),
            ("entity_attributes", "claim_key"),
            ("entity_attributes", "group_key"),
            ("memory_artifacts", "source_mtime_ms"),
            ("memory_artifacts", "is_deleted"),
            ("memory_artifacts", "deleted_at"),
            ("entities", "source_path"),
            ("entity_communities", "source_path"),
            ("entity_attributes", "source_path"),
            ("entity_dependencies", "source_path"),
            ("embeddings", "agent_id"),
            ("entity_attributes", "proposal_id"),
            ("entity_attributes", "proposal_evidence"),
            ("entity_dependencies", "proposal_id"),
            ("entity_dependencies", "proposal_evidence"),
            ("entities", "status"),
            ("entity_aspects", "status"),
            ("entity_attributes", "version"),
            ("entity_attributes", "version_root_id"),
            ("entity_attributes", "previous_attribute_id"),
            ("entity_dependencies", "status"),
            ("memories", "idempotency_key"),
            ("memories", "runtime_path"),
            ("memory_artifacts", "source_id"),
            ("memory_artifacts", "source_root"),
            ("memory_artifacts", "source_external_id"),
            ("memory_artifacts", "source_parent_path"),
            ("memory_artifacts", "source_meta_json"),
        ] {
            assert_column_exists(&conn, table, column);
        }

        for version in 32_i64..=77_i64 {
            assert_migration_stamped(&conn, version);
        }
    }

    #[test]
    fn repairs_idempotency_index_to_match_ts_scoped_contract() {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        run(&conn).expect("initial migrations run");

        conn.execute(
            "INSERT INTO memories
             (id, content, type, idempotency_key, agent_id, visibility, scope, created_at, updated_at, updated_by)
             VALUES ('mem-global', 'global memory', 'fact', 'shared-key', 'default', 'global', NULL, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 'test')",
            [],
        )
        .expect("insert global idempotency row");
        conn.execute(
            "INSERT INTO memories
             (id, content, type, idempotency_key, agent_id, visibility, scope, created_at, updated_at, updated_by)
             VALUES ('mem-private', 'private memory', 'fact', 'shared-key', 'default', 'private', NULL, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 'test')",
            [],
        )
        .expect("same idempotency key should be allowed across visibility scopes");

        let duplicate = conn.execute(
            "INSERT INTO memories
             (id, content, type, idempotency_key, agent_id, visibility, scope, created_at, updated_at, updated_by)
             VALUES ('mem-duplicate', 'duplicate memory', 'fact', 'shared-key', 'default', 'global', NULL, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 'test')",
            [],
        );
        assert!(
            duplicate.is_err(),
            "same idempotency key should remain unique within owner, visibility, and scope"
        );
    }

    #[test]
    fn repairs_ts_parity_tables_when_ledger_versions_are_already_stamped() {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        run(&conn).expect("initial migrations run");
        conn.execute_batch(
            "DROP TABLE memory_search_telemetry;
             DROP TABLE ontology_proposals;",
        )
        .expect("simulate TS-created ledger with missing Rust parity tables");

        run(&conn).expect("run migrations with TS parity versions already stamped");

        for table in ["memory_search_telemetry", "ontology_proposals"] {
            let exists: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                    [table],
                    |row| row.get(0),
                )
                .expect("query sqlite_master");
            assert_eq!(
                exists, 1,
                "{table} should be repaired even when Rust migration versions are pre-stamped"
            );
        }
    }
}
