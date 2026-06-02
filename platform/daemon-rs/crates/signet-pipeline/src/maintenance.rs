//! Maintenance worker: health monitoring and autonomous repair.
//!
//! Runs periodic diagnostics, detects degraded health conditions,
//! and orchestrates repair actions when thresholds are exceeded.

use std::time::Duration;

use serde::Serialize;
use tokio::sync::watch;
use tracing::{info, warn};

use signet_core::db::DbPool;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/// Configuration for the maintenance worker.
#[derive(Debug, Clone)]
pub struct MaintenanceConfig {
    pub interval_secs: u64,
    pub auto_repair: bool,
    pub max_repair_failures: u32,
    pub dead_job_threshold_pct: f64,
    pub tombstone_threshold_pct: f64,
    pub duplicate_threshold_pct: f64,
    pub stale_lease_timeout_secs: u64,
}

impl Default for MaintenanceConfig {
    fn default() -> Self {
        Self {
            interval_secs: 1800, // 30 minutes
            auto_repair: false,
            max_repair_failures: 3,
            dead_job_threshold_pct: 1.0,
            tombstone_threshold_pct: 30.0,
            duplicate_threshold_pct: 5.0,
            stale_lease_timeout_secs: 300,
        }
    }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// Health diagnostics snapshot.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostics {
    pub total_memories: usize,
    pub deleted_memories: usize,
    pub tombstone_ratio: f64,
    pub total_jobs: usize,
    pub pending_jobs: usize,
    pub leased_jobs: usize,
    pub dead_jobs: usize,
    pub dead_ratio: f64,
    pub stale_leases: usize,
    pub total_entities: usize,
    pub orphan_entities: usize,
    pub fts_mismatch: bool,
    pub embedding_gaps: usize,
    pub recommendations: Vec<RepairRecommendation>,
}

/// A recommended repair action.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepairRecommendation {
    pub action: String,
    pub reason: String,
    pub severity: String,
}

/// Result of a maintenance cycle.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MaintenanceResult {
    pub diagnostics: Diagnostics,
    pub repairs_attempted: usize,
    pub repairs_succeeded: usize,
}

// ---------------------------------------------------------------------------
// Worker handle
// ---------------------------------------------------------------------------

pub struct MaintenanceHandle {
    shutdown: watch::Sender<bool>,
    handle: tokio::task::JoinHandle<()>,
}

impl MaintenanceHandle {
    pub async fn stop(self) {
        let _ = self.shutdown.send(true);
        let _ = self.handle.await;
    }
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

pub fn start(pool: DbPool, config: MaintenanceConfig) -> MaintenanceHandle {
    let (tx, rx) = watch::channel(false);
    let handle = tokio::spawn(worker_loop(pool, config, rx));
    MaintenanceHandle {
        shutdown: tx,
        handle,
    }
}

async fn worker_loop(pool: DbPool, config: MaintenanceConfig, mut shutdown: watch::Receiver<bool>) {
    let interval = Duration::from_secs(config.interval_secs);

    info!(
        interval_secs = config.interval_secs,
        auto_repair = config.auto_repair,
        "maintenance worker started"
    );

    loop {
        tokio::select! {
            _ = tokio::time::sleep(interval) => {}
            _ = shutdown.changed() => {
                info!("maintenance worker shutting down");
                break;
            }
        }

        if *shutdown.borrow() {
            break;
        }

        match run_diagnostics(&pool, &config).await {
            Ok(diag) => {
                let recs = diag.recommendations.len();
                if recs > 0 {
                    info!(
                        recommendations = recs,
                        tombstone_ratio = format!("{:.1}%", diag.tombstone_ratio),
                        dead_ratio = format!("{:.1}%", diag.dead_ratio),
                        stale_leases = diag.stale_leases,
                        "maintenance diagnostics collected"
                    );

                    if config.auto_repair {
                        match run_recommended_repairs(&pool, &diag, &config).await {
                            Ok((attempted, succeeded)) => {
                                info!(attempted, succeeded, "maintenance repairs completed");
                            }
                            Err(error) => {
                                warn!(err = %error, "maintenance repairs failed");
                            }
                        }
                    }
                }
            }
            Err(e) => {
                warn!(err = %e, "maintenance diagnostics failed");
            }
        }
    }
}

pub async fn run_recommended_repairs(
    pool: &DbPool,
    diagnostics: &Diagnostics,
    config: &MaintenanceConfig,
) -> Result<(usize, usize), String> {
    let stale_timeout = config.stale_lease_timeout_secs;
    let max_repairs = config.max_repair_failures.max(1) as usize;
    let actions = diagnostics
        .recommendations
        .iter()
        .map(|recommendation| recommendation.action.clone())
        .filter(|action| matches!(action.as_str(), "release_leases" | "requeue_dead"))
        .take(max_repairs)
        .collect::<Vec<_>>();
    let attempted = actions.len();
    if actions.is_empty() {
        return Ok((0, 0));
    }
    let succeeded = pool
        .write(signet_core::db::Priority::Low, move |conn| {
            let mut succeeded = 0usize;
            for action in actions {
                let ts = chrono::Utc::now().to_rfc3339();
                let changed = match action.as_str() {
                    "release_leases" => conn.execute(
                        "UPDATE memory_jobs
                         SET status = 'pending',
                             leased_at = NULL,
                             updated_at = ?1
                         WHERE status = 'leased'
                           AND leased_at < datetime('now', ?2)",
                        rusqlite::params![ts, format!("-{stale_timeout} seconds")],
                    )?,
                    "requeue_dead" => conn.execute(
                        "UPDATE memory_jobs
                         SET status = 'pending',
                             error = NULL,
                             failed_at = NULL,
                             updated_at = ?1
                         WHERE status = 'dead'",
                        rusqlite::params![ts],
                    )?,
                    _ => 0,
                };
                if changed > 0 {
                    succeeded += 1;
                }
            }
            Ok(serde_json::json!({ "succeeded": succeeded }))
        })
        .await
        .map_err(|error| error.to_string())?
        .get("succeeded")
        .and_then(|value| value.as_u64())
        .unwrap_or(0) as usize;
    Ok((attempted, succeeded))
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

/// Collect health diagnostics from the database.
pub async fn run_diagnostics(
    pool: &DbPool,
    config: &MaintenanceConfig,
) -> Result<Diagnostics, String> {
    let stale_timeout = config.stale_lease_timeout_secs;
    let dead_thresh = config.dead_job_threshold_pct;
    let tombstone_thresh = config.tombstone_threshold_pct;

    pool.read(move |conn| {
        // Memory stats
        let total_memories: usize = conn
            .query_row("SELECT COUNT(*) FROM memories", [], |r| r.get(0))
            .unwrap_or(0);
        let deleted_memories: usize = conn
            .query_row(
                "SELECT COUNT(*) FROM memories WHERE COALESCE(is_deleted, 0) = 1",
                [],
                |r| r.get(0),
            )
            .unwrap_or(0);
        let tombstone_ratio = if total_memories > 0 {
            (deleted_memories as f64 / total_memories as f64) * 100.0
        } else {
            0.0
        };

        // Job stats
        let total_jobs: usize = conn
            .query_row("SELECT COUNT(*) FROM memory_jobs", [], |r| r.get(0))
            .unwrap_or(0);
        let pending_jobs: usize = conn
            .query_row(
                "SELECT COUNT(*) FROM memory_jobs WHERE status = 'pending'",
                [],
                |r| r.get(0),
            )
            .unwrap_or(0);
        let leased_jobs: usize = conn
            .query_row(
                "SELECT COUNT(*) FROM memory_jobs WHERE status = 'leased'",
                [],
                |r| r.get(0),
            )
            .unwrap_or(0);
        let dead_jobs: usize = conn
            .query_row(
                "SELECT COUNT(*) FROM memory_jobs WHERE status = 'dead'",
                [],
                |r| r.get(0),
            )
            .unwrap_or(0);
        let dead_ratio = if total_jobs > 0 {
            (dead_jobs as f64 / total_jobs as f64) * 100.0
        } else {
            0.0
        };

        // Stale leases
        let stale_leases: usize = conn
            .query_row(
                "SELECT COUNT(*) FROM memory_jobs WHERE status = 'leased' AND leased_at < datetime('now', ?1)",
                rusqlite::params![format!("-{stale_timeout} seconds")],
                |r| r.get(0),
            )
            .unwrap_or(0);

        // Entity stats
        let total_entities: usize = conn
            .query_row("SELECT COUNT(*) FROM entities", [], |r| r.get(0))
            .unwrap_or(0);
        let orphan_entities: usize = conn
            .query_row(
                "SELECT COUNT(*) FROM entities e LEFT JOIN memory_entity_mentions m ON m.entity_id = e.id WHERE m.entity_id IS NULL AND e.pinned = 0",
                [],
                |r| r.get(0),
            )
            .unwrap_or(0);

        // FTS consistency check (sample)
        let fts_count: usize = conn
            .query_row("SELECT COUNT(*) FROM memories_fts", [], |r| r.get(0))
            .unwrap_or(0);
        let active_count: usize = conn
            .query_row(
                "SELECT COUNT(*) FROM memories WHERE COALESCE(is_deleted, 0) = 0",
                [],
                |r| r.get(0),
            )
            .unwrap_or(0);
        let fts_mismatch = (fts_count as i64 - active_count as i64).unsigned_abs() > 10;

        // Embedding gaps
        let embedding_gaps: usize = conn
            .query_row(
                "SELECT COUNT(*) FROM memories m
                 LEFT JOIN embeddings e ON e.source_type = 'memory' AND e.source_id = m.id
                 WHERE COALESCE(m.is_deleted, 0) = 0 AND e.id IS NULL",
                [],
                |r| r.get(0),
            )
            .unwrap_or(0);

        // Build recommendations
        let mut recommendations = Vec::new();

        if dead_ratio > dead_thresh {
            recommendations.push(RepairRecommendation {
                action: "requeue_dead".into(),
                reason: format!("dead job ratio {dead_ratio:.1}% exceeds {dead_thresh:.1}%"),
                severity: "warning".into(),
            });
        }

        if tombstone_ratio > tombstone_thresh {
            recommendations.push(RepairRecommendation {
                action: "retention_sweep".into(),
                reason: format!(
                    "tombstone ratio {tombstone_ratio:.1}% exceeds {tombstone_thresh:.1}%"
                ),
                severity: "warning".into(),
            });
        }

        if stale_leases > 0 {
            recommendations.push(RepairRecommendation {
                action: "release_leases".into(),
                reason: format!("{stale_leases} stale leases detected"),
                severity: "info".into(),
            });
        }

        if fts_mismatch {
            recommendations.push(RepairRecommendation {
                action: "check_fts".into(),
                reason: format!("FTS count ({fts_count}) != active memory count ({active_count})"),
                severity: "warning".into(),
            });
        }

        if embedding_gaps > 0 {
            recommendations.push(RepairRecommendation {
                action: "re_embed".into(),
                reason: format!("{embedding_gaps} memories missing embeddings"),
                severity: "info".into(),
            });
        }

        if orphan_entities > 0 {
            recommendations.push(RepairRecommendation {
                action: "clean_orphans".into(),
                reason: format!("{orphan_entities} orphan entities"),
                severity: "info".into(),
            });
        }

        Ok(Diagnostics {
            total_memories,
            deleted_memories,
            tombstone_ratio,
            total_jobs,
            pending_jobs,
            leased_jobs,
            dead_jobs,
            dead_ratio,
            stale_leases,
            total_entities,
            orphan_entities,
            fts_mismatch,
            embedding_gaps,
            recommendations,
        })
    })
    .await
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use signet_core::db::Priority;

    fn open_test_pool() -> (DbPool, tokio::task::JoinHandle<()>) {
        let path =
            std::env::temp_dir().join(format!("signet-maintenance-{}.db", uuid::Uuid::new_v4()));
        DbPool::open(&path).expect("open maintenance test db")
    }

    #[tokio::test]
    async fn recommended_repairs_release_leases_and_requeue_dead_jobs() {
        let (pool, handle) = open_test_pool();
        pool.write(Priority::High, |conn| {
            let now = chrono::Utc::now().to_rfc3339();
            let old_lease: String =
                conn.query_row("SELECT datetime('now', '-600 seconds')", [], |row| {
                    row.get(0)
                })?;
            conn.execute(
                "INSERT INTO memories
                 (id, type, content, created_at, updated_at, updated_by, vector_clock,
                  is_deleted)
                 VALUES ('memory-maintenance', 'fact', 'maintenance fixture', ?1, ?1,
                         'test', '{}', 0)",
                rusqlite::params![now],
            )?;
            conn.execute(
                "INSERT INTO memory_jobs
                 (id, memory_id, job_type, status, attempts, leased_at, created_at, updated_at)
                 VALUES ('job-stale', 'memory-maintenance', 'extract', 'leased', 1,
                         ?1, ?2, ?2)",
                rusqlite::params![old_lease, now],
            )?;
            conn.execute(
                "INSERT INTO memory_jobs
                 (id, memory_id, job_type, status, attempts, error, failed_at, created_at, updated_at)
                 VALUES ('job-dead', 'memory-maintenance', 'extract', 'dead', 3,
                         'failed', ?1, ?1, ?1)",
                rusqlite::params![now],
            )?;
            Ok(serde_json::Value::Null)
        })
        .await
        .expect("seed maintenance rows");

        let config = MaintenanceConfig {
            auto_repair: true,
            dead_job_threshold_pct: 1.0,
            stale_lease_timeout_secs: 300,
            ..MaintenanceConfig::default()
        };
        let diagnostics = run_diagnostics(&pool, &config)
            .await
            .expect("run diagnostics");
        assert!(
            diagnostics
                .recommendations
                .iter()
                .any(|recommendation| recommendation.action == "release_leases")
        );
        assert!(
            diagnostics
                .recommendations
                .iter()
                .any(|recommendation| recommendation.action == "requeue_dead")
        );

        let (attempted, succeeded) = run_recommended_repairs(&pool, &diagnostics, &config)
            .await
            .expect("run repairs");
        assert_eq!(attempted, 2);
        assert_eq!(succeeded, 2);

        let statuses = pool
            .read(|conn| {
                let stale: String = conn.query_row(
                    "SELECT status FROM memory_jobs WHERE id = 'job-stale'",
                    [],
                    |row| row.get(0),
                )?;
                let dead: String = conn.query_row(
                    "SELECT status FROM memory_jobs WHERE id = 'job-dead'",
                    [],
                    |row| row.get(0),
                )?;
                let stale_lease: Option<String> = conn.query_row(
                    "SELECT leased_at FROM memory_jobs WHERE id = 'job-stale'",
                    [],
                    |row| row.get(0),
                )?;
                Ok(serde_json::json!({
                    "stale": stale,
                    "dead": dead,
                    "staleLease": stale_lease,
                }))
            })
            .await
            .expect("read repaired jobs");
        assert_eq!(statuses["stale"], "pending");
        assert_eq!(statuses["dead"], "pending");
        assert!(statuses["staleLease"].is_null());

        drop(pool);
        handle.abort();
    }
}
