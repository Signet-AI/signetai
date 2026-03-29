//! Database migration runner for Signet's SQLite schema.
//!
//! Embeds all 30 migrations as SQL strings. Each migration runs inside a
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

/// Simple checksum matching the TS implementation (hash of "version:name").
fn checksum(version: u32, name: &str) -> String {
    let s = format!("{version}:{name}");
    let mut h: i32 = 0;
    for b in s.bytes() {
        h = h.wrapping_mul(31).wrapping_add(b as i32);
    }
    format!("{:x}", h as u32)
}

/// Helper: add a column only if it doesn't already exist.
fn add_column_if_missing(conn: &Connection, table: &str, column: &str, typedef: &str) {
    let has_col: bool = conn
        .prepare(&format!("PRAGMA table_info(\"{table}\")"))
        .and_then(|mut stmt| {
            let rows = stmt.query_map([], |row| row.get::<_, String>(1))?;
            let names: Vec<String> = rows.filter_map(|r| r.ok()).collect();
            Ok(names.iter().any(|n| n == column))
        })
        .unwrap_or(false);

    if !has_col {
        let sql = format!("ALTER TABLE \"{table}\" ADD COLUMN \"{column}\" {typedef}");
        if let Err(e) = conn.execute_batch(&sql) {
            warn!(%table, %column, err = %e, "failed to add column");
        }
    }
}

/// All 30 migrations in order. SQL is idempotent (IF NOT EXISTS / IF MISSING).
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
];

pub const LATEST_SCHEMA_VERSION: u32 = 37;

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
                add_column_if_missing(conn, col.0, col.1, col.2);
            }
            // Indexes on programmatically-added columns
            conn.execute_batch(
                "CREATE INDEX IF NOT EXISTS idx_memories_content_hash ON memories(content_hash);
                 CREATE INDEX IF NOT EXISTS idx_memories_is_deleted ON memories(is_deleted);
                 CREATE INDEX IF NOT EXISTS idx_memories_extraction_status ON memories(extraction_status);",
            )?;
        }
        4 => {
            add_column_if_missing(conn, "memory_history", "actor_type", "TEXT");
            add_column_if_missing(conn, "memory_history", "session_id", "TEXT");
            add_column_if_missing(conn, "memory_history", "request_id", "TEXT");
        }
        5 => {
            add_column_if_missing(conn, "entities", "canonical_name", "TEXT");
            add_column_if_missing(conn, "relations", "mentions", "INTEGER DEFAULT 1");
            add_column_if_missing(conn, "relations", "confidence", "REAL DEFAULT 0.5");
            add_column_if_missing(conn, "relations", "updated_at", "TEXT");
            add_column_if_missing(conn, "memory_entity_mentions", "mention_text", "TEXT");
            add_column_if_missing(conn, "memory_entity_mentions", "confidence", "REAL");
            add_column_if_missing(conn, "memory_entity_mentions", "created_at", "TEXT");
            conn.execute_batch(
                "CREATE INDEX IF NOT EXISTS idx_entities_canonical_name ON entities(canonical_name);",
            )?;
        }
        6 => {
            add_column_if_missing(conn, "memories", "idempotency_key", "TEXT");
            conn.execute_batch(
                "CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_idempotency_key
                     ON memories(idempotency_key) WHERE idempotency_key IS NOT NULL;",
            )?;
        }
        7 => {
            add_column_if_missing(conn, "memory_jobs", "document_id", "TEXT");
        }
        13 => {
            add_column_if_missing(conn, "memories", "source_path", "TEXT");
            add_column_if_missing(conn, "memories", "source_section", "TEXT");
        }
        15 => {
            add_column_if_missing(conn, "session_scores", "confidence", "REAL");
            add_column_if_missing(conn, "session_scores", "continuity_reasoning", "TEXT");
        }
        17 => {
            add_column_if_missing(conn, "scheduled_tasks", "skill_name", "TEXT");
            add_column_if_missing(
                conn,
                "scheduled_tasks",
                "skill_mode",
                "TEXT CHECK (skill_mode IN ('inject', 'slash') OR skill_mode IS NULL)",
            );
        }
        19 => {
            add_column_if_missing(
                conn,
                "entities",
                "agent_id",
                "TEXT NOT NULL DEFAULT 'default'",
            );
            add_column_if_missing(conn, "entities", "pinned", "INTEGER NOT NULL DEFAULT 0");
            add_column_if_missing(conn, "entities", "pinned_at", "TEXT");
            add_column_if_missing(conn, "entities", "embedding", "BLOB");
            conn.execute_batch(
                "CREATE INDEX IF NOT EXISTS idx_entities_agent ON entities(agent_id);",
            )?;
        }
        20 => {
            add_column_if_missing(conn, "session_memories", "entity_slot", "INTEGER");
            add_column_if_missing(conn, "session_memories", "aspect_slot", "INTEGER");
            add_column_if_missing(
                conn,
                "session_memories",
                "is_constraint",
                "INTEGER NOT NULL DEFAULT 0",
            );
            add_column_if_missing(conn, "session_memories", "structural_density", "INTEGER");
        }
        21 => {
            add_column_if_missing(conn, "session_checkpoints", "focal_entity_ids", "TEXT");
            add_column_if_missing(conn, "session_checkpoints", "focal_entity_names", "TEXT");
            add_column_if_missing(conn, "session_checkpoints", "active_aspect_ids", "TEXT");
            add_column_if_missing(
                conn,
                "session_checkpoints",
                "surfaced_constraint_count",
                "INTEGER",
            );
            add_column_if_missing(
                conn,
                "session_checkpoints",
                "traversal_memory_count",
                "INTEGER",
            );
        }
        22 => {
            add_column_if_missing(conn, "entities", "pinned", "INTEGER NOT NULL DEFAULT 0");
            add_column_if_missing(conn, "entities", "pinned_at", "TEXT");
        }
        23 => {
            add_column_if_missing(conn, "session_memories", "predictor_rank", "INTEGER");
        }
        24 => {
            add_column_if_missing(
                conn,
                "predictor_comparisons",
                "scorer_confidence",
                "REAL NOT NULL DEFAULT 0",
            );
            add_column_if_missing(
                conn,
                "predictor_comparisons",
                "success_rate",
                "REAL NOT NULL DEFAULT 0.5",
            );
            add_column_if_missing(
                conn,
                "predictor_comparisons",
                "predictor_top_ids",
                "TEXT NOT NULL DEFAULT '[]'",
            );
            add_column_if_missing(
                conn,
                "predictor_comparisons",
                "baseline_top_ids",
                "TEXT NOT NULL DEFAULT '[]'",
            );
            add_column_if_missing(
                conn,
                "predictor_comparisons",
                "relevance_scores",
                "TEXT NOT NULL DEFAULT '{}'",
            );
            add_column_if_missing(conn, "predictor_comparisons", "fts_overlap_score", "REAL");
        }
        25 => {
            add_column_if_missing(conn, "session_memories", "agent_relevance_score", "REAL");
            add_column_if_missing(
                conn,
                "session_memories",
                "agent_feedback_count",
                "INTEGER DEFAULT 0",
            );
        }
        30 => {
            add_column_if_missing(conn, "memory_jobs", "document_id", "TEXT");
        }
        31 => {
            add_column_if_missing(conn, "entity_dependencies", "reason", "TEXT");
            add_column_if_missing(conn, "entities", "last_synthesized_at", "TEXT");
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
            add_column_if_missing(conn, "session_summaries", "source_type", "TEXT");
            add_column_if_missing(conn, "session_summaries", "source_ref", "TEXT");
            add_column_if_missing(conn, "session_summaries", "meta_json", "TEXT");
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
                add_column_if_missing(conn, col.0, col.1, col.2);
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
        add_column_if_missing(
            conn,
            "memories",
            "agent_id",
            "TEXT NOT NULL DEFAULT 'default'",
        );
        add_column_if_missing(
            conn,
            "memories",
            "visibility",
            "TEXT NOT NULL DEFAULT 'global'",
        );
        add_column_if_missing(conn, "memories", "scope", "TEXT");
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
