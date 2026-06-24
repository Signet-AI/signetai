//! Retention worker: data lifecycle management.
//!
//! Runs on a configurable interval to purge expired data in the same ordered
//! sequence as the TypeScript daemon retention worker. Archives tombstoned
//! memories to cold storage before hard deletion.

use std::time::Duration;

use chrono::{SecondsFormat, Utc};
use rusqlite::{params, types::ValueRef};
use serde::Serialize;
use tokio::sync::watch;
use tracing::{info, warn};
use uuid::Uuid;

use signet_core::db::{DbPool, Priority};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/// Configuration for the retention worker.
#[derive(Debug, Clone)]
pub struct RetentionConfig {
    pub interval_secs: u64,
    pub batch_size: u32,
    pub tombstone_days: u32,
    pub history_days: u32,
    pub completed_job_days: u32,
    pub dead_job_days: u32,
}

impl Default for RetentionConfig {
    fn default() -> Self {
        Self {
            interval_secs: 6 * 3600, // 6 hours
            batch_size: 500,
            tombstone_days: 30,
            history_days: 180,
            completed_job_days: 14,
            dead_job_days: 30,
        }
    }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// Result of a retention sweep.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RetentionResult {
    pub graph_links_purged: usize,
    pub entities_orphaned: usize,
    pub embeddings_purged: usize,
    pub tombstones_purged: usize,
    pub history_purged: usize,
    pub completed_jobs_purged: usize,
    pub dead_jobs_purged: usize,
}

#[derive(Debug)]
struct ColdArchiveRow {
    memory_id: String,
    memory_type: Option<String>,
    category: Option<String>,
    content: String,
    confidence: Option<f64>,
    importance: Option<f64>,
    source_id: Option<String>,
    source_type: Option<String>,
    tags: Option<String>,
    who: Option<String>,
    why: Option<String>,
    project: Option<String>,
    content_hash: Option<String>,
    normalized_content: Option<String>,
    extraction_status: Option<String>,
    embedding_model: Option<String>,
    extraction_model: Option<String>,
    update_count: Option<i64>,
    original_created_at: String,
    agent_id: String,
    original_row_json: String,
}

// ---------------------------------------------------------------------------
// Worker handle
// ---------------------------------------------------------------------------

pub struct RetentionHandle {
    shutdown: watch::Sender<bool>,
    handle: tokio::task::JoinHandle<()>,
}

impl RetentionHandle {
    pub async fn stop(self) {
        let _ = self.shutdown.send(true);
        let _ = self.handle.await;
    }
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

pub fn start(pool: DbPool, config: RetentionConfig) -> RetentionHandle {
    let (tx, rx) = watch::channel(false);
    let handle = tokio::spawn(worker_loop(pool, config, rx));
    RetentionHandle {
        shutdown: tx,
        handle,
    }
}

async fn worker_loop(pool: DbPool, config: RetentionConfig, mut shutdown: watch::Receiver<bool>) {
    let interval = Duration::from_secs(config.interval_secs);

    info!(
        interval_secs = config.interval_secs,
        "retention worker started"
    );

    loop {
        // Wait for interval or shutdown
        tokio::select! {
            _ = tokio::time::sleep(interval) => {}
            _ = shutdown.changed() => {
                info!("retention worker shutting down");
                break;
            }
        }

        if *shutdown.borrow() {
            break;
        }

        info!("starting retention sweep");

        match run_sweep(&pool, &config).await {
            Ok(result) => {
                let total = result.graph_links_purged
                    + result.entities_orphaned
                    + result.embeddings_purged
                    + result.tombstones_purged
                    + result.history_purged
                    + result.completed_jobs_purged
                    + result.dead_jobs_purged;

                if total > 0 {
                    info!(
                        tombstones = result.tombstones_purged,
                        history = result.history_purged,
                        jobs = result.completed_jobs_purged + result.dead_jobs_purged,
                        total,
                        "retention sweep completed"
                    );
                }
            }
            Err(e) => {
                warn!(err = %e, "retention sweep failed");
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Sweep stages (ordered for referential integrity)
// ---------------------------------------------------------------------------

/// Run a full retention sweep. Each step is a separate short transaction.
pub async fn run_sweep(pool: &DbPool, config: &RetentionConfig) -> Result<RetentionResult, String> {
    let tombstone_cutoff = cutoff_iso(config.tombstone_days);
    let history_cutoff = cutoff_iso(config.history_days);
    let completed_job_cutoff = cutoff_iso(config.completed_job_days);
    let dead_job_cutoff = cutoff_iso(config.dead_job_days);

    // Step 1: Graph links for expired tombstones + entity mention decrement.
    let (graph_links_purged, entities_orphaned) =
        purge_graph_links(pool, tombstone_cutoff.clone(), config.batch_size).await?;

    // Step 2: Embeddings for expired tombstones, including vec_embeddings sync.
    let embeddings_purged =
        purge_embeddings(pool, tombstone_cutoff.clone(), config.batch_size).await?;

    // Step 3: Hard-delete tombstoned memories after cold archival.
    let tombstones_purged = purge_tombstones(pool, tombstone_cutoff, config.batch_size).await?;

    // Step 4: Old history events.
    let history_purged = purge_history(pool, history_cutoff, config.batch_size).await?;

    // Step 5: Completed jobs.
    let completed_jobs_purged =
        purge_completed_jobs(pool, completed_job_cutoff.clone(), config.batch_size).await?;

    // Step 6: Dead-letter jobs.
    let dead_jobs_purged =
        purge_dead_jobs(pool, dead_job_cutoff.clone(), config.batch_size).await?;

    // Step 7: transcript_capture_jobs (TS retention-worker.ts:309).
    // Try/catch for missing table — older DBs may not have it.
    let transcript_jobs_purged = purge_transcript_capture_jobs(
        pool,
        completed_job_cutoff,
        dead_job_cutoff,
        config.batch_size,
    )
    .await?;

    Ok(RetentionResult {
        graph_links_purged,
        entities_orphaned,
        embeddings_purged,
        tombstones_purged,
        history_purged,
        completed_jobs_purged,
        dead_jobs_purged,
    })
}

fn cutoff_iso(days: u32) -> String {
    (Utc::now() - chrono::Duration::days(days as i64)).to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn value_to_usize(value: &serde_json::Value) -> usize {
    value.as_u64().unwrap_or(0) as usize
}

fn row_value_to_json(value: ValueRef<'_>) -> serde_json::Value {
    match value {
        ValueRef::Null => serde_json::Value::Null,
        ValueRef::Integer(value) => serde_json::Value::from(value),
        ValueRef::Real(value) => serde_json::Value::from(value),
        ValueRef::Text(value) => {
            serde_json::Value::from(String::from_utf8_lossy(value).into_owned())
        }
        ValueRef::Blob(value) => serde_json::Value::Array(
            value
                .iter()
                .map(|byte| serde_json::Value::from(*byte))
                .collect(),
        ),
    }
}

fn collect_cold_archive_rows(
    conn: &rusqlite::Connection,
    cutoff: &str,
    batch: u32,
) -> rusqlite::Result<Vec<ColdArchiveRow>> {
    let mut stmt = conn.prepare(
        "SELECT * FROM memories
         WHERE is_deleted = 1 AND deleted_at IS NOT NULL AND deleted_at < ?1
         LIMIT ?2",
    )?;
    let column_names = stmt
        .column_names()
        .iter()
        .map(|name| (*name).to_string())
        .collect::<Vec<_>>();

    let rows = stmt.query_map(params![cutoff, batch], |row| {
        let mut original = serde_json::Map::new();
        for (idx, name) in column_names.iter().enumerate() {
            original.insert(name.clone(), row_value_to_json(row.get_ref(idx)?));
        }
        let original_row_json = serde_json::to_string(&original)
            .map_err(|err| rusqlite::Error::ToSqlConversionFailure(Box::new(err)))?;

        Ok(ColdArchiveRow {
            memory_id: row.get("id")?,
            memory_type: row.get("type")?,
            category: row.get("category")?,
            content: row.get("content")?,
            confidence: row.get("confidence")?,
            importance: row.get("importance")?,
            source_id: row.get("source_id")?,
            source_type: row.get("source_type")?,
            tags: row.get("tags")?,
            who: row.get("who")?,
            why: row.get("why")?,
            project: row.get("project")?,
            content_hash: row.get("content_hash")?,
            normalized_content: row.get("normalized_content")?,
            extraction_status: row.get("extraction_status")?,
            embedding_model: row.get("embedding_model")?,
            extraction_model: row.get("extraction_model")?,
            update_count: row.get("update_count")?,
            original_created_at: row.get("created_at")?,
            agent_id: row
                .get::<_, Option<String>>("agent_id")?
                .unwrap_or_else(|| "default".to_string()),
            original_row_json,
        })
    })?;

    rows.collect()
}

async fn purge_graph_links(
    pool: &DbPool,
    cutoff: String,
    batch: u32,
) -> Result<(usize, usize), String> {
    pool.write_tx(Priority::Low, move |conn| {
        let mut stmt = conn.prepare(
            "SELECT DISTINCT entity_id FROM memory_entity_mentions
             WHERE memory_id IN (
                 SELECT id FROM memories
                 WHERE is_deleted = 1 AND deleted_at IS NOT NULL AND deleted_at < ?1
                 LIMIT ?2
             )",
        )?;
        let entity_ids = stmt
            .query_map(params![cutoff, batch], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;

        let mentions_purged = conn.execute(
            "DELETE FROM memory_entity_mentions
             WHERE memory_id IN (
                 SELECT id FROM memories
                 WHERE is_deleted = 1 AND deleted_at IS NOT NULL AND deleted_at < ?1
                 LIMIT ?2
             )",
            params![cutoff, batch],
        )?;

        for entity_id in &entity_ids {
            conn.execute(
                "UPDATE entities SET mentions = MAX(0, mentions - 1) WHERE id = ?1",
                params![entity_id],
            )?;
        }

        let mut orphan_stmt = conn.prepare("SELECT id FROM entities WHERE mentions = 0")?;
        let orphaned = orphan_stmt
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;

        for entity_id in &orphaned {
            conn.execute(
                "DELETE FROM relations WHERE source_entity_id = ?1 OR target_entity_id = ?1",
                params![entity_id],
            )?;
            conn.execute(
                "DELETE FROM memory_entity_mentions WHERE entity_id = ?1",
                params![entity_id],
            )?;
            conn.execute("DELETE FROM entities WHERE id = ?1", params![entity_id])?;
        }

        Ok(serde_json::json!({
            "mentionsPurged": mentions_purged,
            "entitiesOrphaned": orphaned.len()
        }))
    })
    .await
    .map(|value| {
        (
            value["mentionsPurged"].as_u64().unwrap_or(0) as usize,
            value["entitiesOrphaned"].as_u64().unwrap_or(0) as usize,
        )
    })
    .map_err(|e| e.to_string())
}

async fn purge_embeddings(pool: &DbPool, cutoff: String, batch: u32) -> Result<usize, String> {
    pool.write_tx(Priority::Low, move |conn| {
        let mut stmt = conn.prepare(
            "SELECT id FROM embeddings
             WHERE source_type = 'memory'
               AND source_id IN (
                   SELECT id FROM memories
                   WHERE is_deleted = 1 AND deleted_at IS NOT NULL AND deleted_at < ?1
                   LIMIT ?2
               )",
        )?;
        let embedding_ids = stmt
            .query_map(params![cutoff, batch], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;

        for embedding_id in &embedding_ids {
            conn.execute(
                "DELETE FROM vec_embeddings WHERE id = ?1",
                params![embedding_id],
            )?;
        }

        let count = conn.execute(
            "DELETE FROM embeddings
             WHERE source_type = 'memory'
               AND source_id IN (
                   SELECT id FROM memories
                   WHERE is_deleted = 1 AND deleted_at IS NOT NULL AND deleted_at < ?1
                   LIMIT ?2
               )",
            params![cutoff, batch],
        )?;

        Ok(serde_json::json!(count))
    })
    .await
    .map(|value| value_to_usize(&value))
    .map_err(|e| e.to_string())
}

async fn purge_tombstones(pool: &DbPool, cutoff: String, batch: u32) -> Result<usize, String> {
    pool.write_tx(Priority::Low, move |conn| {
        let rows = collect_cold_archive_rows(conn, &cutoff, batch)?;
        if rows.is_empty() {
            return Ok(serde_json::json!(0));
        }

        // Guard: skip cold archival if memories_cold table doesn't exist
        // (older/stamped DBs). TS wraps in try/catch on 'no such table'.
        let cold_exists: bool = conn
            .query_row(
                "SELECT COUNT(*) > 0 FROM sqlite_master WHERE type='table' AND name='memories_cold'",
                [],
                |row| row.get(0),
            )
            .unwrap_or(false);
        if !cold_exists {
            // Still purge tombstones but skip archival.
            let count = conn.execute(
                "DELETE FROM memories WHERE is_deleted = 1 AND deleted_at < ?1
                 LIMIT ?2",
                params![cutoff, batch],
            )?;
            return Ok(serde_json::json!(count));
        }

        let archived_at = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
        for row in &rows {
            conn.execute(
                "INSERT OR IGNORE INTO memories_cold (
                    archive_id, memory_id, type, category, content, confidence, importance,
                    source_id, source_type, tags, who, why, project,
                    content_hash, normalized_content, extraction_status,
                    embedding_model, extraction_model, update_count,
                    original_created_at, archived_at, archived_reason,
                    cold_source_id, agent_id, original_row_json
                 )
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
                         ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25)",
                params![
                    Uuid::new_v4().to_string(),
                    row.memory_id,
                    row.memory_type,
                    row.category,
                    row.content,
                    row.confidence,
                    row.importance,
                    row.source_id,
                    row.source_type,
                    row.tags,
                    row.who,
                    row.why,
                    row.project,
                    row.content_hash,
                    row.normalized_content,
                    row.extraction_status,
                    row.embedding_model,
                    row.extraction_model,
                    row.update_count,
                    row.original_created_at,
                    archived_at,
                    "retention_decay",
                    Option::<String>::None,
                    row.agent_id,
                    row.original_row_json,
                ],
            )?;
        }

        for row in &rows {
            conn.execute("DELETE FROM memories WHERE id = ?1", params![row.memory_id])?;
        }

        Ok(serde_json::json!(rows.len()))
    })
    .await
    .map(|value| value_to_usize(&value))
    .map_err(|e| e.to_string())
}

async fn purge_history(pool: &DbPool, cutoff: String, batch: u32) -> Result<usize, String> {
    pool.write_tx(Priority::Low, move |conn| {
        let count = conn.execute(
            "DELETE FROM memory_history
             WHERE id IN (
                 SELECT id FROM memory_history WHERE created_at < ?1 LIMIT ?2
             )",
            params![cutoff, batch],
        )?;
        Ok(serde_json::json!(count))
    })
    .await
    .map(|value| value_to_usize(&value))
    .map_err(|e| e.to_string())
}

async fn purge_completed_jobs(pool: &DbPool, cutoff: String, batch: u32) -> Result<usize, String> {
    pool.write_tx(Priority::Low, move |conn| {
        let count = conn.execute(
            "DELETE FROM memory_jobs
             WHERE id IN (
                 SELECT id FROM memory_jobs
                 WHERE status = 'completed' AND completed_at IS NOT NULL AND completed_at < ?1
                 LIMIT ?2
             )",
            params![cutoff, batch],
        )?;
        Ok(serde_json::json!(count))
    })
    .await
    .map(|value| value_to_usize(&value))
    .map_err(|e| e.to_string())
}

async fn purge_dead_jobs(pool: &DbPool, cutoff: String, batch: u32) -> Result<usize, String> {
    pool.write_tx(Priority::Low, move |conn| {
        let count = conn.execute(
            "DELETE FROM memory_jobs
             WHERE id IN (
                 SELECT id FROM memory_jobs
                 WHERE status = 'dead' AND failed_at IS NOT NULL AND failed_at < ?1
                 LIMIT ?2
             )",
            params![cutoff, batch],
        )?;
        Ok(serde_json::json!(count))
    })
    .await
    .map(|value| value_to_usize(&value))
    .map_err(|e| e.to_string())
}

/// Step 7: purge old transcript_capture_jobs (TS retention-worker.ts:309).
/// Uses try/catch semantics — if the table doesn't exist (older DBs), returns 0.
async fn purge_transcript_capture_jobs(
    pool: &DbPool,
    completed_cutoff: String,
    dead_cutoff: String,
    batch: u32,
) -> Result<usize, String> {
    pool.write_tx(Priority::Low, move |conn| {
        // Guard: skip if table doesn't exist (older stamped DBs).
        let table_exists: bool = conn
            .query_row(
                "SELECT COUNT(*) > 0 FROM sqlite_master WHERE type='table' AND name='transcript_capture_jobs'",
                [],
                |row| row.get(0),
            )
            .unwrap_or(false);
        if !table_exists {
            return Ok(serde_json::json!(0));
        }
        let completed = conn.execute(
            "DELETE FROM transcript_capture_jobs
             WHERE id IN (
                 SELECT id FROM transcript_capture_jobs
                 WHERE status = 'completed' AND completed_at IS NOT NULL AND completed_at < ?1
                 LIMIT ?2
             )",
            params![completed_cutoff, batch],
        )?;
        let dead = conn.execute(
            "DELETE FROM transcript_capture_jobs
             WHERE id IN (
                 SELECT id FROM transcript_capture_jobs
                 WHERE status = 'dead' AND updated_at IS NOT NULL AND updated_at < ?1
                 LIMIT ?2
             )",
            params![dead_cutoff, batch],
        )?;
        Ok(serde_json::json!(completed + dead))
    })
    .await
    .map(|value| value_to_usize(&value))
    .map_err(|e| e.to_string())
}
