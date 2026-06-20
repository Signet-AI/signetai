//! Repair action routes: maintenance and recovery endpoints.

use std::collections::{HashMap, HashSet};
use std::convert::Infallible;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use axum::{
    body::{Body, Bytes},
    extract::{Query, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Json, Response},
};
use rusqlite::OptionalExtension;
use serde::Deserialize;
use signet_core::queries::embedding::{self, InsertEmbedding};
use signet_core::queries::memory;
use signet_services::normalize::normalize_and_hash;
use tokio::io::AsyncReadExt;
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;

use crate::routes::memory_embeddings::memory_embedding_hash;
use crate::state::AppState;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// Standard repair result shape.
fn repair_result(action: &str, success: bool, affected: usize, message: &str) -> serde_json::Value {
    serde_json::json!({
        "action": action,
        "success": success,
        "affected": affected,
        "message": message,
    })
}

fn lease_timeout_ms(state: &AppState) -> u64 {
    // Match the TypeScript repair endpoint's resolved fallback until the
    // Rust daemon shares the same config resolution path.
    state
        .config
        .manifest
        .memory
        .as_ref()
        .and_then(|cfg| cfg.pipeline_v2.as_ref())
        .map(|cfg| cfg.worker.lease_timeout_ms)
        .unwrap_or(300_000)
}

const TROUBLESHOOT_COMMANDS: &[(&str, &str, &[&str])] = &[
    ("status", "signet", &["status"]),
    ("daemon-status", "signet", &["daemon", "status"]),
    (
        "daemon-logs",
        "signet",
        &["daemon", "logs", "--lines", "50"],
    ),
    ("embed-audit", "signet", &["embed", "audit"]),
    ("embed-backfill", "signet", &["embed", "backfill"]),
    ("sync", "signet", &["sync"]),
    ("recall-test", "signet", &["recall", "test query"]),
    ("skill-list", "signet", &["skill", "list"]),
    ("secret-list", "signet", &["secret", "list"]),
    ("daemon-stop", "signet", &["daemon", "stop"]),
    ("daemon-restart", "signet", &["daemon", "restart"]),
    ("update", "signet", &["update", "install"]),
];

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TroubleshootExecRequest {
    key: Option<String>,
}

fn executable_exists(path: &Path) -> bool {
    path.metadata()
        .map(|metadata| metadata.is_file())
        .unwrap_or(false)
}

fn resolve_binary(bin: &str) -> Option<PathBuf> {
    let path = Path::new(bin);
    if path.components().count() > 1 && executable_exists(path) {
        return Some(path.to_path_buf());
    }
    std::env::var_os("PATH").and_then(|path| {
        std::env::split_paths(&path)
            .map(|dir| dir.join(bin))
            .find(|candidate| executable_exists(candidate))
    })
}

fn sse_payload(event: serde_json::Value) -> Result<Bytes, Infallible> {
    Ok(Bytes::from(format!("data: {event}\n\n")))
}

async fn send_sse(tx: &mpsc::Sender<Result<Bytes, Infallible>>, event: serde_json::Value) -> bool {
    tx.send(sse_payload(event)).await.is_ok()
}

fn sse_response(rx: mpsc::Receiver<Result<Bytes, Infallible>>) -> Response {
    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "text/event-stream"),
            (header::CACHE_CONTROL, "no-cache"),
            (header::CONNECTION, "keep-alive"),
        ],
        Body::from_stream(ReceiverStream::new(rx)),
    )
        .into_response()
}

// ---------------------------------------------------------------------------
// Repair endpoints
// ---------------------------------------------------------------------------

/// GET /api/troubleshoot/commands — list dashboard troubleshooting commands.
pub async fn troubleshoot_commands() -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "commands": TROUBLESHOOT_COMMANDS
            .iter()
            .map(|(key, bin, args)| serde_json::json!({
                "key": key,
                "display": format!("{bin} {}", args.join(" ")),
            }))
            .collect::<Vec<_>>(),
    }))
}

/// POST /api/troubleshoot/exec — execute an allowlisted troubleshooting command.
pub async fn troubleshoot_exec(Json(req): Json<TroubleshootExecRequest>) -> impl IntoResponse {
    let key = req.key.unwrap_or_default();
    let Some((_key, bin, args)) = TROUBLESHOOT_COMMANDS
        .iter()
        .find(|(candidate, _, _)| candidate == &key)
    else {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": format!("Unknown command: {key}")})),
        )
            .into_response();
    };

    let command = format!("{bin} {}", args.join(" "));
    let Some(resolved) = resolve_binary(bin) else {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": format!("Binary not found: {bin}")})),
        )
            .into_response();
    };

    let (tx, rx) = mpsc::channel::<Result<Bytes, Infallible>>(32);
    if key == "daemon-stop" || key == "daemon-restart" {
        let action = if key == "daemon-stop" {
            "stop"
        } else {
            "restart"
        };
        let key = key.clone();
        tokio::spawn(async move {
            if !send_sse(
                &tx,
                serde_json::json!({"type": "started", "key": key, "command": command}),
            )
            .await
            {
                return;
            }
            if !send_sse(
                &tx,
                serde_json::json!({
                    "type": "stdout",
                    "data": format!("Daemon {action} initiated (PID {})\n", std::process::id())
                }),
            )
            .await
            {
                return;
            }
            if action == "stop"
                && !send_sse(
                    &tx,
                    serde_json::json!({"type": "stdout", "data": "Dashboard will lose connection.\n"}),
                )
                .await
            {
                return;
            }
            let _ = send_sse(&tx, serde_json::json!({"type": "exit", "code": 0})).await;

            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_secs(1)).await;
                if action == "restart" {
                    let _ = tokio::process::Command::new(resolved)
                        .args(["daemon", "start"])
                        .env_remove("CLAUDECODE")
                        .env("SIGNET_NO_HOOKS", "1")
                        .stdin(Stdio::null())
                        .stdout(Stdio::null())
                        .stderr(Stdio::null())
                        .spawn();
                }
                #[cfg(unix)]
                unsafe {
                    libc::kill(std::process::id() as i32, libc::SIGTERM);
                }
                #[cfg(not(unix))]
                std::process::exit(0);
            });
        });
        return sse_response(rx);
    }

    let key_for_task = key.clone();
    let args_for_task: Vec<String> = args.iter().map(|arg| (*arg).to_string()).collect();
    tokio::spawn(async move {
        if !send_sse(
            &tx,
            serde_json::json!({"type": "started", "key": key_for_task, "command": command}),
        )
        .await
        {
            return;
        }

        let mut child = match tokio::process::Command::new(resolved)
            .args(&args_for_task)
            .env_remove("CLAUDECODE")
            .env("SIGNET_NO_HOOKS", "1")
            .env("FORCE_COLOR", "0")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
        {
            Ok(child) => child,
            Err(error) => {
                let _ = send_sse(
                    &tx,
                    serde_json::json!({"type": "error", "message": error.to_string()}),
                )
                .await;
                return;
            }
        };

        if let Some(mut stdout) = child.stdout.take() {
            let stdout_tx = tx.clone();
            tokio::spawn(async move {
                let mut buffer = [0_u8; 8192];
                loop {
                    match stdout.read(&mut buffer).await {
                        Ok(0) => break,
                        Ok(size) => {
                            if !send_sse(
                                &stdout_tx,
                                serde_json::json!({
                                    "type": "stdout",
                                    "data": String::from_utf8_lossy(&buffer[..size]).to_string()
                                }),
                            )
                            .await
                            {
                                break;
                            }
                        }
                        Err(_) => break,
                    }
                }
            });
        }

        if let Some(mut stderr) = child.stderr.take() {
            let stderr_tx = tx.clone();
            tokio::spawn(async move {
                let mut buffer = [0_u8; 8192];
                loop {
                    match stderr.read(&mut buffer).await {
                        Ok(0) => break,
                        Ok(size) => {
                            if !send_sse(
                                &stderr_tx,
                                serde_json::json!({
                                    "type": "stderr",
                                    "data": String::from_utf8_lossy(&buffer[..size]).to_string()
                                }),
                            )
                            .await
                            {
                                break;
                            }
                        }
                        Err(_) => break,
                    }
                }
            });
        }

        match tokio::time::timeout(Duration::from_secs(60), child.wait()).await {
            Ok(Ok(status)) => {
                let _ = send_sse(
                    &tx,
                    serde_json::json!({"type": "exit", "code": status.code().unwrap_or(1)}),
                )
                .await;
            }
            Ok(Err(error)) => {
                let _ = send_sse(
                    &tx,
                    serde_json::json!({"type": "error", "message": error.to_string()}),
                )
                .await;
            }
            Err(_) => {
                let _ = child.kill().await;
                let _ = send_sse(&tx, serde_json::json!({"type": "exit", "code": 1})).await;
            }
        }
    });

    sse_response(rx)
}

/// POST /api/repair/requeue-dead — move dead jobs back to pending.
pub async fn requeue_dead(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let result = state
        .pool
        .write(signet_core::db::Priority::Low, |conn| {
            let count = conn.execute(
                "UPDATE memory_jobs SET status = 'pending', attempts = 0, error = NULL, updated_at = datetime('now')
                 WHERE status = 'dead'",
                [],
            )?;
            Ok(serde_json::json!(count))
        })
        .await;

    match result {
        Ok(count) => {
            let n = count.as_u64().unwrap_or(0) as usize;
            (
                StatusCode::OK,
                Json(repair_result(
                    "requeue_dead",
                    true,
                    n,
                    &format!("{n} dead jobs requeued"),
                )),
            )
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(repair_result("requeue_dead", false, 0, &e.to_string())),
        ),
    }
}

/// POST /api/repair/release-leases — release stale job leases.
pub async fn release_leases(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let lease_ms = lease_timeout_ms(&state).min(i64::MAX as u64) as i64;
    let now = chrono::Utc::now();
    let now_s = now.to_rfc3339();
    let cutoff = (now - chrono::Duration::milliseconds(lease_ms)).to_rfc3339();
    let result = state
        .pool
        .write(signet_core::db::Priority::Low, move |conn| {
            let dead = conn.execute(
                "UPDATE memory_jobs
                 SET status = 'dead',
                     leased_at = NULL,
                     failed_at = ?1,
                     error = COALESCE(error, 'lease expired before completion'),
                     updated_at = ?1
                 WHERE status = 'leased'
                   AND leased_at < ?2
                   AND attempts >= max_attempts",
                rusqlite::params![now_s, cutoff],
            )?;
            let pending = conn.execute(
                "UPDATE memory_jobs
                 SET status = 'pending',
                     leased_at = NULL,
                     updated_at = ?1
                 WHERE status = 'leased'
                   AND leased_at < ?2
                   AND attempts < max_attempts",
                rusqlite::params![now_s, cutoff],
            )?;
            Ok(serde_json::json!({
                "pending": pending,
                "dead": dead,
                "total": pending + dead,
            }))
        })
        .await;

    match result {
        Ok(count) => {
            let pending = count["pending"].as_u64().unwrap_or(0) as usize;
            let dead = count["dead"].as_u64().unwrap_or(0) as usize;
            let n = count["total"].as_u64().unwrap_or(0) as usize;
            let msg = if dead > 0 {
                format!(
                    "released {pending} stale lease(s) back to pending and dead-lettered {dead} exhausted job(s)"
                )
            } else {
                format!("released {pending} stale lease(s) back to pending")
            };
            (
                StatusCode::OK,
                Json(repair_result("release_leases", true, n, &msg)),
            )
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(repair_result("release_leases", false, 0, &e.to_string())),
        ),
    }
}

#[derive(Deserialize)]
pub struct CheckFtsBody {
    #[serde(default)]
    pub repair: bool,
}

/// POST /api/repair/check-fts — verify/repair FTS index consistency.
pub async fn check_fts(
    State(state): State<Arc<AppState>>,
    body: Option<Json<CheckFtsBody>>,
) -> impl IntoResponse {
    let do_repair = body.map(|Json(b)| b.repair).unwrap_or(false);

    let result = state
        .pool
        .write(signet_core::db::Priority::Low, move |conn| {
            let fts_count: i64 = conn
                .query_row("SELECT COUNT(*) FROM memories_fts", [], |r| r.get(0))
                .unwrap_or(0);
            let active_count: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM memories WHERE deleted = 0",
                    [],
                    |r| r.get(0),
                )
                .unwrap_or(0);

            let mismatch = (fts_count - active_count).unsigned_abs();

            if do_repair && mismatch > 0 {
                // Rebuild FTS
                conn.execute("DELETE FROM memories_fts", [])?;
                conn.execute(
                    "INSERT INTO memories_fts(rowid, content) SELECT rowid, content FROM memories WHERE deleted = 0",
                    [],
                )?;
            }

            Ok(serde_json::json!({
                "fts_count": fts_count,
                "active_count": active_count,
                "mismatch": mismatch,
                "repaired": do_repair && mismatch > 0,
            }))
        })
        .await;

    match result {
        Ok(info) => {
            let repaired = info["repaired"].as_bool().unwrap_or(false);
            let mismatch = info["mismatch"].as_u64().unwrap_or(0) as usize;
            let msg = if repaired {
                format!("FTS index rebuilt, {mismatch} entries corrected")
            } else if mismatch > 0 {
                format!("FTS mismatch detected: {mismatch} entries differ")
            } else {
                "FTS index consistent".into()
            };
            (
                StatusCode::OK,
                Json(repair_result("check_fts", true, mismatch, &msg)),
            )
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(repair_result("check_fts", false, 0, &e.to_string())),
        ),
    }
}

fn sqlite_table_exists(conn: &rusqlite::Connection, table: &str) -> rusqlite::Result<bool> {
    conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
        [table],
        |row| row.get::<_, i64>(0),
    )
    .map(|count| count > 0)
}

/// POST /api/repair/retention-sweep — trigger a bounded retention sweep.
pub async fn retention_sweep(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let result = state
        .pool
        .write_tx(signet_core::db::Priority::Low, |conn| {
            let graph_links = conn.execute(
                "DELETE FROM memory_entity_mentions
                 WHERE memory_id IN (SELECT id FROM memories WHERE is_deleted = 1)",
                [],
            )?;

            let orphan_embeddings = if sqlite_table_exists(conn, "embeddings")? {
                conn.execute(
                    "DELETE FROM embeddings
                     WHERE source_type = 'memory'
                       AND source_id NOT IN (SELECT id FROM memories WHERE is_deleted = 0)",
                    [],
                )?
            } else {
                0
            };

            let tombstones = conn.execute(
                "DELETE FROM memories
                 WHERE id IN (
                    SELECT id FROM memories
                    WHERE is_deleted = 1
                      AND deleted_at IS NOT NULL
                      AND deleted_at < datetime('now', '-30 days')
                    LIMIT 500
                 )",
                [],
            )?;

            let history = conn.execute(
                "DELETE FROM memory_history
                 WHERE id IN (
                    SELECT id FROM memory_history
                    WHERE created_at < datetime('now', '-180 days')
                    LIMIT 500
                 )",
                [],
            )?;

            let completed_jobs = conn.execute(
                "DELETE FROM memory_jobs
                 WHERE id IN (
                    SELECT id FROM memory_jobs
                    WHERE status = 'completed'
                      AND completed_at IS NOT NULL
                      AND completed_at < datetime('now', '-14 days')
                    LIMIT 500
                 )",
                [],
            )?;

            let dead_jobs = conn.execute(
                "DELETE FROM memory_jobs
                 WHERE id IN (
                    SELECT id FROM memory_jobs
                    WHERE status = 'dead'
                      AND updated_at < datetime('now', '-30 days')
                    LIMIT 500
                 )",
                [],
            )?;

            let training_pairs = if sqlite_table_exists(conn, "predictor_training_pairs")? {
                conn.execute(
                    "DELETE FROM predictor_training_pairs
                     WHERE id IN (
                        SELECT id FROM predictor_training_pairs
                        WHERE created_at < datetime('now', '-90 days')
                        LIMIT 500
                     )",
                    [],
                )?
            } else {
                0
            };

            Ok(serde_json::json!({
                "graphLinks": graph_links,
                "orphanEmbeddings": orphan_embeddings,
                "tombstones": tombstones,
                "history": history,
                "completedJobs": completed_jobs,
                "deadJobs": dead_jobs,
                "trainingPairs": training_pairs,
                "total": graph_links
                    + orphan_embeddings
                    + tombstones
                    + history
                    + completed_jobs
                    + dead_jobs
                    + training_pairs,
            }))
        })
        .await;

    match result {
        Ok(details) => {
            let affected = details["total"].as_u64().unwrap_or(0) as usize;
            (
                StatusCode::OK,
                Json(serde_json::json!({
                    "action": "retention_sweep",
                    "success": true,
                    "affected": affected,
                    "message": format!("retention sweep completed; {affected} row(s) purged"),
                    "details": details,
                })),
            )
        }
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(repair_result(
                "retention_sweep",
                false,
                0,
                &error.to_string(),
            )),
        ),
    }
}

/// GET /api/repair/embedding-gaps — audit embedding coverage.
pub async fn embedding_gaps(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    let result = state
        .pool
        .read(|conn| {
            let total = count_active_memories(conn)?;
            let unembedded = count_unembedded_memories(conn)?;
            let pct = if total > 0 {
                ((total - unembedded) as f64 / total as f64) * 100.0
            } else {
                100.0
            };

            Ok(serde_json::json!({
                "unembedded": unembedded,
                "total": total,
                "coverage": format!("{pct:.1}%"),
            }))
        })
        .await
        .unwrap_or_else(|_| serde_json::json!({"error": "db unavailable"}));

    Json(result)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReEmbedBody {
    #[serde(default = "default_batch")]
    pub batch_size: usize,
    #[serde(default)]
    pub dry_run: bool,
    #[serde(default)]
    pub full_sweep: bool,
}

fn default_batch() -> usize {
    50
}

#[derive(Debug)]
struct UnembeddedMemory {
    id: String,
    content: String,
    content_hash: Option<String>,
}

struct FreshMemoryForEmbedding {
    content: String,
    normalized_content: String,
    content_hash: String,
    agent_id: String,
}

fn count_active_memories(conn: &rusqlite::Connection) -> rusqlite::Result<i64> {
    conn.query_row(
        "SELECT COUNT(*) FROM memories WHERE COALESCE(is_deleted, 0) = 0",
        [],
        |row| row.get(0),
    )
}

fn count_unembedded_memories(conn: &rusqlite::Connection) -> rusqlite::Result<i64> {
    conn.query_row(
        "SELECT COUNT(*) FROM memories m
         WHERE COALESCE(m.is_deleted, 0) = 0
           AND NOT EXISTS (
             SELECT 1 FROM embeddings e
             WHERE e.source_type = 'memory' AND e.source_id = m.id
           )",
        [],
        |row| row.get(0),
    )
}

fn list_unembedded_memories(
    conn: &rusqlite::Connection,
    limit: i64,
) -> rusqlite::Result<Vec<UnembeddedMemory>> {
    let mut stmt = conn.prepare_cached(
        "SELECT m.id, m.content, m.content_hash
         FROM memories m
         WHERE COALESCE(m.is_deleted, 0) = 0
           AND NOT EXISTS (
             SELECT 1 FROM embeddings e
             WHERE e.source_type = 'memory' AND e.source_id = m.id
           )
         ORDER BY m.created_at ASC
         LIMIT ?1",
    )?;
    stmt.query_map([limit], |row| {
        Ok(UnembeddedMemory {
            id: row.get(0)?,
            content: row.get(1)?,
            content_hash: row.get(2)?,
        })
    })?
    .collect()
}

fn fresh_memory_for_embedding(
    conn: &rusqlite::Connection,
    memory: &UnembeddedMemory,
) -> Result<Option<FreshMemoryForEmbedding>, signet_core::CoreError> {
    let candidate_normalized = normalize_and_hash(&memory.content);
    let candidate_hash = memory
        .content_hash
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(&candidate_normalized.hash);
    let row = conn
        .query_row(
            "SELECT content,
                    content_hash,
                    COALESCE(NULLIF(agent_id, ''), 'default') AS agent_id
             FROM memories
             WHERE id = ?1
               AND COALESCE(is_deleted, 0) = 0",
            rusqlite::params![memory.id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .optional()?;

    let Some((content, content_hash, agent_id)) = row else {
        return Ok(None);
    };
    let current_normalized = normalize_and_hash(&content);
    let current_hash = content_hash
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(&current_normalized.hash);
    if current_hash != candidate_hash {
        return Ok(None);
    }
    let content_hash = current_hash.to_string();

    Ok(Some(FreshMemoryForEmbedding {
        content,
        normalized_content: current_normalized.normalized,
        content_hash,
        agent_id,
    }))
}

fn write_embedding_batch(
    conn: &rusqlite::Connection,
    results: &[(UnembeddedMemory, Vec<f32>)],
    embedding_model: Option<&str>,
) -> Result<usize, signet_core::CoreError> {
    let now = chrono::Utc::now().to_rfc3339();
    let mut written = 0;
    for (memory, vector) in results {
        let Some(fresh) = fresh_memory_for_embedding(conn, memory)? else {
            continue;
        };

        if memory
            .content_hash
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .is_none()
        {
            let collision = conn
                .query_row(
                    "SELECT id FROM memories
                     WHERE content_hash = ?1
                       AND COALESCE(is_deleted, 0) = 0
                       AND id <> ?2
                     LIMIT 1",
                    rusqlite::params![fresh.content_hash, memory.id],
                    |row| row.get::<_, String>(0),
                )
                .ok();
            if collision.is_none() {
                conn.execute(
                    "UPDATE memories
                     SET content_hash = ?1,
                         normalized_content = COALESCE(normalized_content, ?2)
                     WHERE id = ?3 AND content_hash IS NULL",
                    rusqlite::params![fresh.content_hash, fresh.normalized_content, memory.id],
                )?;
            }
        }

        let embedding_hash =
            memory_embedding_hash(&fresh.agent_id, &memory.id, &fresh.content_hash);
        embedding::delete_by_source(conn, "memory", &memory.id, Some(&embedding_hash))?;
        embedding::upsert(
            conn,
            &InsertEmbedding {
                id: &uuid::Uuid::new_v4().to_string(),
                content_hash: &embedding_hash,
                vector,
                source_type: "memory",
                source_id: &memory.id,
                chunk_text: &fresh.content,
                now: &now,
                agent_id: Some(&fresh.agent_id),
            },
        )?;
        if let Some(model) = embedding_model {
            conn.execute(
                "UPDATE memories SET embedding_model = ?1, updated_at = ?2 WHERE id = ?3",
                rusqlite::params![model, now, memory.id],
            )?;
        }
        written += 1;
    }
    Ok(written)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepairBatchBody {
    #[serde(default = "default_batch")]
    pub batch_size: usize,
    #[serde(default)]
    pub dry_run: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeduplicateBody {
    #[serde(default = "default_batch")]
    pub batch_size: usize,
    #[serde(default)]
    pub dry_run: bool,
    #[serde(default)]
    pub semantic_enabled: bool,
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ScopedRepairBody {
    pub batch_size: Option<usize>,
    pub dry_run: Option<bool>,
    #[serde(alias = "agent_id")]
    pub agent_id: Option<String>,
    pub visibility: Option<String>,
    pub scope: Option<String>,
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct RepairAgentBody {
    #[serde(alias = "agent_id")]
    pub agent_id: Option<String>,
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct RelinkBody {
    pub batch_size: Option<usize>,
    #[serde(alias = "agent_id")]
    pub agent_id: Option<String>,
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct BackfillHintsBody {
    pub batch_size: Option<usize>,
    #[serde(alias = "agent_id")]
    pub agent_id: Option<String>,
}

#[derive(Debug)]
struct DedupCluster {
    content_hash: String,
    agent_id: String,
    scope_key: String,
    visibility: String,
    count: i64,
}

#[derive(Debug)]
struct DedupCandidate {
    id: String,
    content: String,
    tags: Option<String>,
    importance: f64,
    access_count: i64,
    update_count: i64,
    updated_at: String,
}

fn score_dedup_candidate(candidate: &DedupCandidate) -> f64 {
    let mut score = candidate.importance * 3.0;
    score += candidate.access_count.min(50) as f64 / 50.0;
    score += candidate.update_count.min(20) as f64 / 20.0;
    if let Ok(updated) = chrono::DateTime::parse_from_rfc3339(&candidate.updated_at) {
        score += updated.timestamp_millis() as f64 / 1e15;
    }
    score
}

fn merge_tags(existing: Option<&str>, incoming: Option<&str>) -> Option<String> {
    let mut tags = Vec::<String>::new();
    for raw in existing.into_iter().chain(incoming) {
        for tag in raw.split(',').map(str::trim).filter(|tag| !tag.is_empty()) {
            if !tags.iter().any(|stored| stored == tag) {
                tags.push(tag.to_string());
            }
        }
    }
    (!tags.is_empty()).then(|| tags.join(","))
}

fn process_exact_dedup_cluster(
    conn: &rusqlite::Connection,
    cluster: &DedupCluster,
) -> Result<usize, signet_core::CoreError> {
    let candidates = if cluster.scope_key == "__NULL__" {
        let mut stmt = conn.prepare(
            "SELECT id, content, tags, importance, access_count, update_count, updated_at
             FROM memories
             WHERE content_hash = ?1 AND is_deleted = 0
               AND pinned = 0 AND manual_override = 0 AND scope IS NULL
               AND COALESCE(agent_id, 'default') = ?2
               AND COALESCE(visibility, 'global') = ?3
             ORDER BY importance DESC",
        )?;
        stmt.query_map(
            rusqlite::params![cluster.content_hash, cluster.agent_id, cluster.visibility],
            |row| {
                Ok(DedupCandidate {
                    id: row.get(0)?,
                    content: row.get(1)?,
                    tags: row.get(2)?,
                    importance: row.get(3)?,
                    access_count: row.get(4)?,
                    update_count: row.get(5)?,
                    updated_at: row.get(6)?,
                })
            },
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?
    } else {
        let mut stmt = conn.prepare(
            "SELECT id, content, tags, importance, access_count, update_count, updated_at
             FROM memories
             WHERE content_hash = ?1 AND is_deleted = 0
               AND pinned = 0 AND manual_override = 0 AND scope = ?2
               AND COALESCE(agent_id, 'default') = ?3
               AND COALESCE(visibility, 'global') = ?4
             ORDER BY importance DESC",
        )?;
        stmt.query_map(
            rusqlite::params![
                cluster.content_hash,
                cluster.scope_key,
                cluster.agent_id,
                cluster.visibility,
            ],
            |row| {
                Ok(DedupCandidate {
                    id: row.get(0)?,
                    content: row.get(1)?,
                    tags: row.get(2)?,
                    importance: row.get(3)?,
                    access_count: row.get(4)?,
                    update_count: row.get(5)?,
                    updated_at: row.get(6)?,
                })
            },
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?
    };

    if candidates.len() < 2 {
        return Ok(0);
    }

    let keeper_index = candidates
        .iter()
        .enumerate()
        .max_by(|(_, left), (_, right)| {
            score_dedup_candidate(left)
                .partial_cmp(&score_dedup_candidate(right))
                .unwrap_or(std::cmp::Ordering::Equal)
        })
        .map(|(index, _)| index)
        .unwrap_or(0);
    let keeper = &candidates[keeper_index];
    let now = chrono::Utc::now().to_rfc3339();
    let mut merged_tags = keeper.tags.clone();
    for loser in candidates
        .iter()
        .enumerate()
        .filter_map(|(index, candidate)| (index != keeper_index).then_some(candidate))
    {
        merged_tags = merge_tags(merged_tags.as_deref(), loser.tags.as_deref());
    }

    if merged_tags != keeper.tags {
        conn.execute(
            "UPDATE memories SET tags = ?1, updated_at = ?2 WHERE id = ?3",
            rusqlite::params![merged_tags, now, keeper.id],
        )?;
    }

    let losers = candidates
        .iter()
        .enumerate()
        .filter_map(|(index, candidate)| (index != keeper_index).then_some(candidate))
        .collect::<Vec<_>>();
    let merged_from = losers
        .iter()
        .map(|candidate| candidate.id.clone())
        .collect::<Vec<_>>();
    let metadata = serde_json::json!({
        "mergedFrom": merged_from,
        "mergedTags": merged_tags,
    })
    .to_string();
    memory::insert_history(
        conn,
        &memory::InsertHistory {
            id: &uuid::Uuid::new_v4().to_string(),
            memory_id: &keeper.id,
            event: "merged",
            old_content: None,
            new_content: None,
            changed_by: "repair",
            reason: Some(&format!("dedup: merged {} duplicate(s)", losers.len())),
            metadata: Some(&metadata),
            now: &now,
            actor_type: Some("operator"),
            session_id: None,
            request_id: None,
        },
    )?;

    for loser in &losers {
        conn.execute(
            "UPDATE memories
             SET is_deleted = 1, deleted_at = ?1, updated_at = ?1
             WHERE id = ?2",
            rusqlite::params![now, loser.id],
        )?;
        memory::insert_history(
            conn,
            &memory::InsertHistory {
                id: &uuid::Uuid::new_v4().to_string(),
                memory_id: &loser.id,
                event: "deleted",
                old_content: Some(&loser.content),
                new_content: None,
                changed_by: "repair",
                reason: Some(&format!("dedup: duplicate of {}", keeper.id)),
                metadata: None,
                now: &now,
                actor_type: Some("operator"),
                session_id: None,
                request_id: None,
            },
        )?;
    }

    Ok(losers.len())
}

/// POST /api/repair/re-embed — re-compute embeddings for gaps.
pub async fn re_embed(
    State(state): State<Arc<AppState>>,
    Json(body): Json<Option<ReEmbedBody>>,
) -> impl IntoResponse {
    let body = body.unwrap_or(ReEmbedBody {
        batch_size: default_batch(),
        dry_run: false,
        full_sweep: false,
    });
    let batch_size = body.batch_size.clamp(1, 500) as i64;
    let unembedded = match state
        .pool
        .read(|conn| Ok(serde_json::json!(count_unembedded_memories(conn)?)))
        .await
    {
        Ok(value) => value.as_i64().unwrap_or(0),
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(repair_result(
                    "reembedMissingMemories",
                    false,
                    0,
                    &e.to_string(),
                )),
            );
        }
    };

    if unembedded == 0 {
        return (
            StatusCode::OK,
            Json(repair_result(
                "reembedMissingMemories",
                true,
                0,
                "no unembedded memories found",
            )),
        );
    }

    if body.dry_run {
        return (
            StatusCode::OK,
            Json(repair_result(
                "reembedMissingMemories",
                true,
                0,
                &format!(
                    "dry run: {} memories in this batch, {unembedded} total unembedded",
                    batch_size.min(unembedded)
                ),
            )),
        );
    }

    let Some(provider) = state.embedding.read().await.clone() else {
        return (
            StatusCode::OK,
            Json(repair_result(
                "reembedMissingMemories",
                false,
                0,
                "embedding provider returned no vectors for 0 memories",
            )),
        );
    };
    let embedding_model = state
        .config
        .manifest
        .embedding
        .as_ref()
        .map(|embedding| embedding.model.clone());

    let mut attempted = 0usize;
    let mut written = 0usize;
    let mut failed = 0usize;
    let mut batches = 0usize;
    loop {
        let rows = match state
            .pool
            .read(move |conn| {
                let rows = list_unembedded_memories(conn, batch_size)?;
                Ok(serde_json::Value::Array(
                    rows.into_iter()
                        .map(|row| {
                            serde_json::json!({
                                "id": row.id,
                                "content": row.content,
                                "contentHash": row.content_hash,
                            })
                        })
                        .collect::<Vec<_>>(),
                ))
            })
            .await
        {
            Ok(value) => value
                .as_array()
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .filter_map(|value| {
                    Some(UnembeddedMemory {
                        id: value.get("id")?.as_str()?.to_string(),
                        content: value.get("content")?.as_str()?.to_string(),
                        content_hash: value
                            .get("contentHash")
                            .and_then(serde_json::Value::as_str)
                            .map(ToOwned::to_owned),
                    })
                })
                .collect::<Vec<_>>(),
            Err(e) => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(repair_result(
                        "reembedMissingMemories",
                        false,
                        0,
                        &e.to_string(),
                    )),
                );
            }
        };

        if rows.is_empty() {
            break;
        }

        let selected = rows.len();
        let mut vectors = Vec::new();
        for row in rows {
            match provider.embed(&row.content).await {
                Some(vector) if vector.len() == provider.dimensions() => {
                    vectors.push((row, vector))
                }
                Some(_) | None => failed += 1,
            }
        }

        let model = embedding_model.clone();
        let batch_written = if vectors.is_empty() {
            0
        } else {
            match state
                .pool
                .write(signet_core::db::Priority::Low, move |conn| {
                    Ok(serde_json::json!(write_embedding_batch(
                        conn,
                        &vectors,
                        model.as_deref(),
                    )?))
                })
                .await
            {
                Ok(value) => value.as_u64().unwrap_or(0) as usize,
                Err(e) => {
                    return (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        Json(repair_result(
                            "reembedMissingMemories",
                            false,
                            written,
                            &e.to_string(),
                        )),
                    );
                }
            }
        };

        attempted += selected;
        written += batch_written;
        batches += 1;
        if !body.full_sweep || selected < batch_size as usize || batch_written == 0 {
            break;
        }
    }

    if attempted == 0 {
        return (
            StatusCode::OK,
            Json(repair_result(
                "reembedMissingMemories",
                true,
                0,
                "no unembedded memories found",
            )),
        );
    }

    if written == 0 {
        return (
            StatusCode::OK,
            Json(repair_result(
                "reembedMissingMemories",
                false,
                0,
                &format!("embedding provider returned no vectors for {attempted} memories"),
            )),
        );
    }

    let remaining = state
        .pool
        .read(|conn| Ok(serde_json::json!(count_unembedded_memories(conn)?)))
        .await
        .ok()
        .and_then(|value| value.as_i64())
        .unwrap_or(0);
    let scope = if body.full_sweep {
        format!("across {batches} batch(es)")
    } else {
        "in one batch".to_string()
    };
    let message = if failed > 0 {
        format!(
            "re-embedded {written} of {attempted} memories {scope} ({failed} failed, {remaining} still missing)"
        )
    } else {
        format!("re-embedded {written} of {attempted} memories {scope} ({remaining} still missing)")
    };
    (
        StatusCode::OK,
        Json(repair_result(
            "reembedMissingMemories",
            true,
            written,
            &message,
        )),
    )
}

/// POST /api/repair/resync-vec — rebuild vector index.
pub async fn resync_vec(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let result = state
        .pool
        .write(signet_core::db::Priority::Low, |conn| {
            let vec_exists = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE name = 'vec_embeddings'",
                    [],
                    |r| r.get::<_, i64>(0),
                )
                .map(|count| count > 0)
                .unwrap_or(false);
            if !vec_exists {
                return Ok(serde_json::json!(0));
            }

            conn.execute("DELETE FROM vec_embeddings", [])?;
            let count = conn.execute(
                "INSERT INTO vec_embeddings(id, embedding)
                 SELECT e.id, e.vector FROM embeddings e",
                [],
            )?;
            Ok(serde_json::json!(count))
        })
        .await;

    match result {
        Ok(count) => {
            let n = count.as_u64().unwrap_or(0) as usize;
            (
                StatusCode::OK,
                Json(repair_result(
                    "resync_vec",
                    true,
                    n,
                    &format!("{n} vectors resynced"),
                )),
            )
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(repair_result("resync_vec", false, 0, &e.to_string())),
        ),
    }
}

/// POST /api/repair/clean-orphans — remove orphan embedding entries.
pub async fn clean_orphans(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let result = state
        .pool
        .write(signet_core::db::Priority::Low, |conn| {
            let count = conn.execute(
                "DELETE FROM embeddings
                 WHERE source_type = 'memory'
                   AND source_id NOT IN (SELECT id FROM memories WHERE is_deleted = 0)",
                [],
            )?;
            Ok(serde_json::json!(count))
        })
        .await;

    match result {
        Ok(count) => {
            let n = count.as_u64().unwrap_or(0) as usize;
            (
                StatusCode::OK,
                Json(repair_result(
                    "clean_orphans",
                    true,
                    n,
                    &format!("{n} orphan embeddings removed"),
                )),
            )
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(repair_result("clean_orphans", false, 0, &e.to_string())),
        ),
    }
}

/// GET /api/repair/dedup-stats — audit duplicate memories.
pub async fn dedup_stats(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    let result = state
        .pool
        .read(|conn| {
            // Exact duplicates by content hash
            let exact_clusters: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM (SELECT content_hash, COUNT(*) as cnt FROM memories WHERE is_deleted = 0 AND content_hash IS NOT NULL GROUP BY content_hash HAVING cnt > 1)",
                    [],
                    |r| r.get(0),
                )
                .unwrap_or(0);

            let exact_memories: i64 = conn
                .query_row(
                    "SELECT COALESCE(SUM(cnt), 0) FROM (SELECT content_hash, COUNT(*) as cnt FROM memories WHERE is_deleted = 0 AND content_hash IS NOT NULL GROUP BY content_hash HAVING cnt > 1)",
                    [],
                    |r| r.get(0),
                )
                .unwrap_or(0);

            Ok(serde_json::json!({
                "exact_duplicates": {
                    "cluster_count": exact_clusters,
                    "memory_count": exact_memories,
                },
                "semantic_duplicates": {
                    "cluster_count": 0,
                    "memory_count": 0,
                    "threshold": 0.9,
                }
            }))
        })
        .await
        .unwrap_or_else(|_| serde_json::json!({"error": "db unavailable"}));

    Json(result)
}

/// POST /api/repair/deduplicate — merge duplicate memories.
pub async fn deduplicate(
    State(state): State<Arc<AppState>>,
    Json(body): Json<Option<DeduplicateBody>>,
) -> impl IntoResponse {
    let body = body.unwrap_or(DeduplicateBody {
        batch_size: default_batch(),
        dry_run: false,
        semantic_enabled: false,
    });
    if body.semantic_enabled {
        return (
            StatusCode::BAD_REQUEST,
            Json(repair_result(
                "deduplicateMemories",
                false,
                0,
                "semantic deduplication requires vector search integration in daemon-rs",
            )),
        );
    }

    let batch_size = body.batch_size.clamp(1, 500) as i64;
    let result = state
        .pool
        .write_tx(signet_core::db::Priority::Low, move |conn| {
            let mut stmt = conn.prepare(
                "SELECT content_hash,
                        COALESCE(agent_id, 'default') AS agent_key,
                        COALESCE(scope, '__NULL__') AS scope_key,
                        COALESCE(visibility, 'global') AS visibility_key,
                        COUNT(*) AS cnt
                 FROM memories
                 WHERE is_deleted = 0 AND pinned = 0 AND manual_override = 0
                   AND content_hash IS NOT NULL
                 GROUP BY content_hash, agent_key, scope_key, visibility_key
                 HAVING COUNT(*) > 1
                 ORDER BY cnt DESC
                 LIMIT ?1",
            )?;
            let clusters = stmt
                .query_map([batch_size], |row| {
                    Ok(DedupCluster {
                        content_hash: row.get(0)?,
                        agent_id: row.get(1)?,
                        scope_key: row.get(2)?,
                        visibility: row.get(3)?,
                        count: row.get(4)?,
                    })
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;

            if body.dry_run {
                let excess = clusters.iter().map(|cluster| cluster.count - 1).sum::<i64>();
                return Ok(serde_json::json!({
                    "action": "deduplicateMemories",
                    "success": true,
                    "affected": 0,
                    "clusters": clusters.len(),
                    "message": format!("dry run: {} exact cluster(s), {excess} excess duplicate(s)", clusters.len()),
                }));
            }

            let mut total_removed = 0_usize;
            let mut total_clusters = 0_usize;
            for cluster in clusters {
                let removed = process_exact_dedup_cluster(conn, &cluster)?;
                if removed > 0 {
                    total_removed += removed;
                    total_clusters += 1;
                }
            }

            Ok(serde_json::json!({
                "action": "deduplicateMemories",
                "success": true,
                "affected": total_removed,
                "clusters": total_clusters,
                "message": format!("deduplicated {total_removed} memory/memories across {total_clusters} cluster(s)"),
            }))
        })
        .await;

    match result {
        Ok(body) => (StatusCode::OK, Json(body)),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(repair_result(
                "deduplicateMemories",
                false,
                0,
                &e.to_string(),
            )),
        ),
    }
}

/// POST /api/repair/backfill-skipped — retry skipped sessions.
pub async fn backfill_skipped(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let result = state
        .pool
        .read(|conn| {
            // Check if session_summaries table exists
            let exists: bool = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='session_summaries'",
                    [],
                    |r| r.get::<_, i64>(0),
                )
                .map(|c| c > 0)
                .unwrap_or(false);

            if !exists {
                return Ok(serde_json::json!(0));
            }

            let count: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM session_summaries WHERE status = 'skipped'",
                    [],
                    |r| r.get(0),
                )
                .unwrap_or(0);
            Ok(serde_json::json!(count))
        })
        .await;

    match result {
        Ok(count) => {
            let n = count.as_u64().unwrap_or(0) as usize;
            (
                StatusCode::OK,
                Json(repair_result(
                    "backfill_skipped",
                    true,
                    n,
                    &format!("{n} skipped sessions found"),
                )),
            )
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(repair_result("backfill_skipped", false, 0, &e.to_string())),
        ),
    }
}

/// POST /api/repair/reclassify-entities — re-run entity classification.
pub async fn reclassify_entities(
    State(state): State<Arc<AppState>>,
    Json(body): Json<Option<RepairBatchBody>>,
) -> impl IntoResponse {
    let body = body.unwrap_or(RepairBatchBody {
        batch_size: default_batch(),
        dry_run: false,
    });
    let batch_size = body.batch_size.clamp(1, 500) as i64;
    let result = state
        .pool
        .read(move |conn| {
            let count = conn
                .query_row(
                    "SELECT COUNT(*) FROM entities WHERE entity_type = 'extracted'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap_or(0);
            let affected = count.min(batch_size).max(0) as usize;
            let (success, message) = if affected == 0 {
                (true, "no entities with type 'extracted' found".to_string())
            } else if body.dry_run {
                (
                    true,
                    format!("dry-run: would reclassify {affected} extracted entities"),
                )
            } else {
                (
                    false,
                    "no LLM provider available for native Rust reclassification".to_string(),
                )
            };
            Ok(repair_result(
                "reclassify_entities",
                success,
                affected,
                &message,
            ))
        })
        .await;

    match result {
        Ok(body) => (StatusCode::OK, Json(body)),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(repair_result(
                "reclassify_entities",
                false,
                0,
                &e.to_string(),
            )),
        ),
    }
}

/// POST /api/repair/prune-chunk-groups — remove empty chunk group entities.
pub async fn prune_chunk_groups(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let result = state
        .pool
        .write(signet_core::db::Priority::Low, |conn| {
            let count = conn.execute(
                "DELETE FROM entities WHERE entity_type = 'chunk_group' AND id NOT IN (
                    SELECT DISTINCT entity_id FROM memory_entity_mentions
                )",
                [],
            )?;
            Ok(serde_json::json!(count))
        })
        .await;

    match result {
        Ok(count) => {
            let n = count.as_u64().unwrap_or(0) as usize;
            (
                StatusCode::OK,
                Json(repair_result(
                    "prune_chunk_groups",
                    true,
                    n,
                    &format!("{n} chunk groups pruned"),
                )),
            )
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(repair_result(
                "prune_chunk_groups",
                false,
                0,
                &e.to_string(),
            )),
        ),
    }
}

/// POST /api/repair/prune-singleton-entities — remove low-mention entities.
pub async fn prune_singletons(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let result = state
        .pool
        .write(signet_core::db::Priority::Low, |conn| {
            let count = conn.execute(
                "DELETE FROM entities WHERE pinned = 0 AND id IN (
                    SELECT e.id FROM entities e
                    LEFT JOIN memory_entity_mentions m ON m.entity_id = e.id
                    GROUP BY e.id HAVING COUNT(m.entity_id) <= 1
                )",
                [],
            )?;
            Ok(serde_json::json!(count))
        })
        .await;

    match result {
        Ok(count) => {
            let n = count.as_u64().unwrap_or(0) as usize;
            (
                StatusCode::OK,
                Json(repair_result(
                    "prune_singletons",
                    true,
                    n,
                    &format!("{n} singleton entities pruned"),
                )),
            )
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(repair_result("prune_singletons", false, 0, &e.to_string())),
        ),
    }
}

/// POST /api/repair/structural-backfill — re-extract structural features.
pub async fn structural_backfill(
    State(state): State<Arc<AppState>>,
    Json(body): Json<Option<RepairBatchBody>>,
) -> impl IntoResponse {
    let body = body.unwrap_or(RepairBatchBody {
        batch_size: 100,
        dry_run: false,
    });
    let batch_size = body.batch_size.clamp(1, 500) as i64;
    let result = state
        .pool
        .write_tx(signet_core::db::Priority::Low, move |conn| {
            let rows = {
                let mut stmt = conn.prepare(
                    "SELECT m.id, m.content, e.id, e.entity_type, e.canonical_name, e.agent_id
                     FROM memories m
                     JOIN memory_entity_mentions mem ON mem.memory_id = m.id
                     JOIN entities e ON e.id = mem.entity_id
                     WHERE COALESCE(m.is_deleted, 0) = 0
                       AND e.entity_type != 'chunk_group'
                       AND NOT EXISTS (
                         SELECT 1 FROM entity_attributes attr
                         WHERE attr.memory_id = m.id
                         LIMIT 1
                       )
                     GROUP BY m.id
                     LIMIT ?1",
                )?;
                stmt.query_map([batch_size], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, String>(5)?,
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?
            };

            if body.dry_run || rows.is_empty() {
                let message = if body.dry_run {
                    format!("dry-run: would process {} unassigned memories", rows.len())
                } else {
                    "no unassigned memories with entity links found".to_string()
                };
                return Ok(repair_result(
                    "structural_backfill",
                    true,
                    rows.len(),
                    &message,
                ));
            }

            let now = chrono::Utc::now().to_rfc3339();
            let mut attributes_created = 0usize;
            let mut classify_enqueued = 0usize;
            for (memory_id, content, entity_id, entity_type, entity_name, agent_id) in rows {
                let attr_id = uuid::Uuid::new_v4().to_string();
                conn.execute(
                    "INSERT INTO entity_attributes
                     (id, aspect_id, agent_id, memory_id, kind, content, normalized_content,
                      confidence, importance, status, created_at, updated_at)
                     VALUES (?1, NULL, ?2, ?3, 'attribute', ?4, ?5, 0.5, 0.5,
                             'active', ?6, ?6)",
                    rusqlite::params![attr_id, agent_id, memory_id, content, content, now],
                )?;
                attributes_created += 1;
                let payload = serde_json::json!({
                    "memory_id": memory_id,
                    "entity_id": entity_id,
                    "entity_name": entity_name,
                    "entity_type": entity_type,
                    "fact_content": content,
                    "attribute_id": attr_id,
                    "agent_id": agent_id,
                })
                .to_string();
                conn.execute(
                    "INSERT INTO memory_jobs
                     (id, memory_id, job_type, status, payload, attempts, max_attempts,
                      created_at, updated_at)
                     VALUES (?1, ?2, 'structural_classify', 'pending', ?3, 0, 3, ?4, ?4)",
                    rusqlite::params![uuid::Uuid::new_v4().to_string(), memory_id, payload, now],
                )?;
                classify_enqueued += 1;
            }
            Ok(repair_result(
                "structural_backfill",
                true,
                attributes_created,
                &format!(
                    "created {attributes_created} stubs, enqueued {classify_enqueued} classify jobs"
                ),
            ))
        })
        .await;

    match result {
        Ok(body) => (StatusCode::OK, Json(body)),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(repair_result(
                "structural_backfill",
                false,
                0,
                &e.to_string(),
            )),
        ),
    }
}

fn header_text(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn query_text(query: &HashMap<String, String>, camel: &str, snake: &str) -> Option<String> {
    query
        .get(camel)
        .or_else(|| query.get(snake))
        .map(String::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn normalize_scope_value(value: Option<String>) -> Option<String> {
    value
        .map(|raw| raw.trim().to_string())
        .filter(|raw| !raw.is_empty())
}

fn resolve_repair_agent_id(
    headers: &HeaderMap,
    query: &HashMap<String, String>,
    body_agent_id: Option<&str>,
) -> String {
    body_agent_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .or_else(|| query_text(query, "agentId", "agent_id"))
        .or_else(|| header_text(headers, "x-signet-agent-id"))
        .unwrap_or_else(resolve_daemon_agent_id)
}

fn resolve_daemon_agent_id() -> String {
    std::env::var("SIGNET_AGENT_ID")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "default".to_string())
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum RepairActorType {
    Operator,
    Agent,
    Daemon,
}

impl RepairActorType {
    fn from_header(value: Option<String>) -> Self {
        match value
            .as_deref()
            .unwrap_or("operator")
            .trim()
            .to_ascii_lowercase()
            .as_str()
        {
            "agent" => Self::Agent,
            "daemon" => Self::Daemon,
            _ => Self::Operator,
        }
    }
}

struct RepairContextHeaders {
    actor: String,
    actor_type: RepairActorType,
    reason: String,
    request_id: Option<String>,
}

fn resolve_repair_context(headers: &HeaderMap) -> RepairContextHeaders {
    RepairContextHeaders {
        actor: header_text(headers, "x-signet-actor").unwrap_or_else(|| "operator".to_string()),
        actor_type: RepairActorType::from_header(header_text(headers, "x-signet-actor-type")),
        reason: header_text(headers, "x-signet-reason")
            .unwrap_or_else(|| "manual repair".to_string()),
        request_id: header_text(headers, "x-signet-request-id"),
    }
}

#[derive(Clone, Copy)]
struct RepairLimiterEntry {
    last_run_at: Instant,
    hourly_count: u64,
    hour_reset_at: Instant,
}

static REPAIR_LIMITER: OnceLock<Mutex<HashMap<String, RepairLimiterEntry>>> = OnceLock::new();

fn check_rate_limit(action: &str, cooldown_ms: u64, hourly_budget: u64) -> Result<(), String> {
    let now = Instant::now();
    let state = REPAIR_LIMITER.get_or_init(|| Mutex::new(HashMap::new()));
    let mut guard = state
        .lock()
        .map_err(|_| "repair limiter lock poisoned".to_string())?;
    let Some(entry) = guard.get_mut(action) else {
        return Ok(());
    };
    let cooldown = Duration::from_millis(cooldown_ms);
    let elapsed = now.saturating_duration_since(entry.last_run_at);
    if elapsed < cooldown {
        return Err(format!(
            "cooldown active, {}ms remaining",
            (cooldown - elapsed).as_millis()
        ));
    }
    if now >= entry.hour_reset_at {
        entry.hourly_count = 0;
        entry.hour_reset_at = now + Duration::from_secs(60 * 60);
    }
    if entry.hourly_count >= hourly_budget {
        return Err(format!("hourly budget exhausted ({hourly_budget} runs/hr)"));
    }
    Ok(())
}

fn record_rate_limit(action: &str) -> Result<(), String> {
    let now = Instant::now();
    let state = REPAIR_LIMITER.get_or_init(|| Mutex::new(HashMap::new()));
    let mut guard = state
        .lock()
        .map_err(|_| "repair limiter lock poisoned".to_string())?;
    guard
        .entry(action.to_string())
        .and_modify(|entry| {
            if now >= entry.hour_reset_at {
                entry.hourly_count = 1;
                entry.hour_reset_at = now + Duration::from_secs(60 * 60);
            } else {
                entry.hourly_count += 1;
            }
            entry.last_run_at = now;
        })
        .or_insert(RepairLimiterEntry {
            last_run_at: now,
            hourly_count: 1,
            hour_reset_at: now + Duration::from_secs(60 * 60),
        });
    Ok(())
}

fn pipeline_config(state: &AppState) -> signet_core::config::PipelineV2Config {
    state
        .config
        .manifest
        .memory
        .as_ref()
        .and_then(|memory| memory.pipeline_v2.clone())
        .unwrap_or_default()
}

fn check_repair_gate(
    state: &AppState,
    ctx: &RepairContextHeaders,
    action: &str,
    cooldown_ms: u64,
    hourly_budget: u64,
) -> Result<(), String> {
    let cfg = pipeline_config(state);
    if cfg.autonomous.frozen {
        return Err("autonomous.frozen is set".to_string());
    }
    if ctx.actor_type == RepairActorType::Agent && !cfg.autonomous.enabled {
        return Err("autonomous.enabled is false; agents cannot trigger repairs".to_string());
    }
    if matches!(
        ctx.actor_type,
        RepairActorType::Operator | RepairActorType::Daemon
    ) {
        return Ok(());
    }
    check_rate_limit(action, cooldown_ms, hourly_budget)
}

fn repair_status_for_error(message: &str) -> StatusCode {
    if message.contains("cooldown active")
        || message.contains("hourly budget exhausted")
        || message.contains("autonomous.")
        || message.contains("agents cannot trigger repairs")
    {
        StatusCode::TOO_MANY_REQUESTS
    } else {
        StatusCode::INTERNAL_SERVER_ERROR
    }
}

fn write_repair_audit(
    conn: &rusqlite::Connection,
    action: &str,
    ctx: &RepairContextHeaders,
    affected: usize,
    message: &str,
) -> rusqlite::Result<()> {
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT OR IGNORE INTO memories
         (id, type, content, confidence, importance, created_at, updated_at,
          updated_by, is_deleted, deleted_at, agent_id, visibility)
         VALUES ('system', 'fact', 'Repair audit system record', 1.0, 0.0,
                 ?1, ?1, 'system', 1, ?1, 'default', 'global')",
        [&now],
    )?;
    conn.execute(
        "INSERT INTO memory_history
         (id, memory_id, event, old_content, new_content, changed_by, reason,
          metadata, created_at, actor_type, request_id)
         VALUES (?1, 'system', 'none', NULL, NULL, ?2, ?3, ?4, ?5, ?6, ?7)",
        rusqlite::params![
            uuid::Uuid::new_v4().to_string(),
            ctx.actor,
            ctx.reason,
            serde_json::json!({"repairAction": action, "affected": affected, "message": message})
                .to_string(),
            now,
            match ctx.actor_type {
                RepairActorType::Operator => "operator",
                RepairActorType::Agent => "agent",
                RepairActorType::Daemon => "daemon",
            },
            ctx.request_id,
        ],
    )?;
    Ok(())
}

fn normalize_entity_name(value: &str) -> String {
    value
        .trim()
        .replace(['“', '”'], "\"")
        .replace(['‘', '’'], "'")
        .trim_matches(|ch| ch == '\'' || ch == '"' || ch == '`')
        .to_ascii_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn normalize_entity_type(value: &str) -> String {
    value.trim().to_ascii_lowercase().replace([' ', '-'], "_")
}

fn classify_entity_quality(name: &str, entity_type: &str) -> Result<(), &'static str> {
    const CONCRETE: &[&str] = &[
        "person",
        "organization",
        "project",
        "product",
        "system",
        "tool",
        "artifact",
        "document",
        "source",
        "place",
        "event",
    ];
    const ABSTRACT: &[&str] = &[
        "concept",
        "task",
        "skill",
        "agent",
        "policy",
        "action",
        "workflow",
        "object_type",
        "interface",
        "observation",
        "claim_slot",
        "claim_value",
        "chunk_group",
    ];
    const GENERIC: &[&str] = &[
        "a",
        "an",
        "and",
        "are",
        "author",
        "because",
        "being",
        "but",
        "can",
        "current work",
        "did",
        "do",
        "does",
        "for",
        "from",
        "had",
        "has",
        "have",
        "he",
        "her",
        "him",
        "his",
        "i",
        "in",
        "intent",
        "is",
        "it",
        "its",
        "let",
        "of",
        "on",
        "or",
        "pending tasks",
        "primary request",
        "read",
        "recipient",
        "sender",
        "she",
        "someone",
        "summary",
        "that",
        "the",
        "their",
        "them",
        "they",
        "this",
        "to",
        "understand",
        "want",
        "was",
        "we",
        "we're",
        "were",
        "with",
        "write",
        "you",
        "your",
    ];
    const METADATA: &[&str] = &[
        "assistant",
        "author",
        "current work",
        "intent",
        "pending tasks",
        "primary request",
        "recipient",
        "sender",
        "system",
        "user",
    ];
    const DISCOURSE: &[&str] = &[
        "because",
        "despite",
        "however",
        "let",
        "once",
        "read",
        "summary",
        "understand",
        "want",
        "write",
    ];

    let canonical = normalize_entity_name(name);
    let normalized_type = normalize_entity_type(entity_type);
    let has_concrete_type = CONCRETE.contains(&normalized_type.as_str());
    if canonical.chars().all(|ch| ch.is_ascii_digit()) {
        return Err("numeric_only");
    }
    if GENERIC.contains(&canonical.as_str()) {
        return Err("generic_or_scaffolding_name");
    }
    if METADATA.contains(&canonical.as_str()) {
        return Err("metadata_role");
    }
    if DISCOURSE.contains(&canonical.as_str()) {
        return Err("discourse_fragment");
    }
    let lowered = name.trim().to_ascii_lowercase();
    if [
        "user",
        "assistant",
        "system",
        "sender",
        "recipient",
        "author",
    ]
    .iter()
    .any(|prefix| {
        lowered.starts_with(&format!("{prefix}:"))
            || lowered.starts_with(&format!("{prefix} "))
            || lowered.starts_with(&format!("{prefix}-"))
    }) {
        return Err("role_prefixed_scaffolding");
    }
    if canonical.starts_with("current ")
        || canonical.starts_with("pending ")
        || canonical.starts_with("primary ")
    {
        return Err("section_heading");
    }
    if canonical.len() < 4 && !has_concrete_type {
        return Err("too_short");
    }
    if normalized_type != "extracted" && normalized_type != "unknown" && !has_concrete_type {
        return Err(if ABSTRACT.contains(&normalized_type.as_str()) {
            "non_concrete_entity_type"
        } else {
            "unknown_entity_type"
        });
    }
    if normalized_type == "event" {
        let has_event_signal = [
            "announced",
            "announcement",
            "created",
            "decided",
            "deployed",
            "digest",
            "installed",
            "launched",
            "meeting",
            "merged",
            "published",
            "released",
            "started",
            "stopped",
            "updated",
            "today",
            "yesterday",
            "last ",
            "202",
            "jan",
            "feb",
            "mar",
            "apr",
            "may",
            "jun",
            "jul",
            "aug",
            "sep",
            "oct",
            "nov",
            "dec",
        ]
        .iter()
        .any(|needle| canonical.contains(needle));
        if !has_event_signal {
            return Err("event_without_time_or_event_signal");
        }
    }
    Ok(())
}

fn delete_entity_graph_rows(conn: &rusqlite::Connection, ids: &[String]) -> rusqlite::Result<()> {
    if ids.is_empty() {
        return Ok(());
    }
    let placeholders = ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
    let aspects = conn
        .prepare(&format!(
            "SELECT id FROM entity_aspects WHERE entity_id IN ({placeholders})"
        ))?
        .query_map(rusqlite::params_from_iter(ids.iter()), |row| {
            row.get::<_, String>(0)
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if !aspects.is_empty() {
        let aspect_placeholders = aspects.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        conn.execute(
            &format!("DELETE FROM entity_attributes WHERE aspect_id IN ({aspect_placeholders})"),
            rusqlite::params_from_iter(aspects.iter()),
        )?;
    }
    conn.execute(
        &format!("DELETE FROM memory_entity_mentions WHERE entity_id IN ({placeholders})"),
        rusqlite::params_from_iter(ids.iter()),
    )?;
    conn.execute(
        &format!(
            "DELETE FROM relations WHERE source_entity_id IN ({placeholders}) OR target_entity_id IN ({placeholders})"
        ),
        rusqlite::params_from_iter(ids.iter().chain(ids.iter())),
    )?;
    if sqlite_table_exists(conn, "entity_dependencies")? {
        conn.execute(
            &format!(
                "DELETE FROM entity_dependencies WHERE source_entity_id IN ({placeholders}) OR target_entity_id IN ({placeholders})"
            ),
            rusqlite::params_from_iter(ids.iter().chain(ids.iter())),
        )?;
    }
    conn.execute(
        &format!("DELETE FROM entity_aspects WHERE entity_id IN ({placeholders})"),
        rusqlite::params_from_iter(ids.iter()),
    )?;
    conn.execute(
        &format!("DELETE FROM entities WHERE id IN ({placeholders})"),
        rusqlite::params_from_iter(ids.iter()),
    )?;
    Ok(())
}

/// POST /api/repair/prune-generic-entities — prune low-value generated graph nodes.
pub async fn prune_generic_entities(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
    body: Option<Json<ScopedRepairBody>>,
) -> impl IntoResponse {
    let body = body.map(|Json(body)| body).unwrap_or_default();
    let ctx = resolve_repair_context(&headers);
    let action = "pruneGenericEntities";
    if let Err(message) = check_repair_gate(&state, &ctx, action, 60_000, 10) {
        let status = repair_status_for_error(&message);
        return (status, Json(repair_result(action, false, 0, &message))).into_response();
    }

    let batch_size = body.batch_size.unwrap_or(100).clamp(1, 500) as i64;
    let dry_run = body.dry_run.unwrap_or(true);
    let agent_id = resolve_repair_agent_id(&headers, &query, body.agent_id.as_deref());
    let result = state
        .pool
        .write_tx(signet_core::db::Priority::Low, move |conn| {
            let page_size = (batch_size * 10).max(500);
            let mut offset = 0_i64;
            let mut candidates: Vec<(String, String, String)> = Vec::new();
            loop {
                let page = {
                    let mut stmt = conn.prepare(
                        "SELECT e.id, e.name, e.entity_type
                         FROM entities e
                         WHERE COALESCE(NULLIF(e.agent_id, ''), 'default') = ?1
                           AND COALESCE(e.pinned, 0) = 0
                           AND e.entity_type NOT IN ('skill')
                           AND NOT EXISTS (SELECT 1 FROM skill_meta sm WHERE sm.entity_id = e.id)
                         ORDER BY e.updated_at DESC
                         LIMIT ?2 OFFSET ?3",
                    )?;
                    stmt.query_map(rusqlite::params![agent_id, page_size, offset], |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                        ))
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()?
                };
                if page.is_empty() {
                    break;
                }
                let page_len = page.len() as i64;
                for (id, name, entity_type) in page {
                    if let Err(reason) = classify_entity_quality(&name, &entity_type) {
                        candidates.push((id, name, reason.to_string()));
                        if candidates.len() >= batch_size as usize {
                            break;
                        }
                    }
                }
                if candidates.len() >= batch_size as usize {
                    break;
                }
                offset += page_len;
            }

            if dry_run {
                let preview = candidates
                    .iter()
                    .take(10)
                    .map(|(_, name, reason)| format!("{name} ({reason})"))
                    .collect::<Vec<_>>()
                    .join(", ");
                let suffix = if preview.is_empty() {
                    String::new()
                } else {
                    format!(": {preview}")
                };
                return Ok(repair_result(
                    action,
                    true,
                    candidates.len(),
                    &format!(
                        "dry-run: would delete {} generic/non-concrete entities{suffix}",
                        candidates.len()
                    ),
                ));
            }

            if candidates.is_empty() {
                return Ok(repair_result(
                    action,
                    true,
                    0,
                    "no generic/non-concrete entities found",
                ));
            }

            let ids = candidates
                .into_iter()
                .map(|(id, _, _)| id)
                .collect::<Vec<_>>();
            delete_entity_graph_rows(conn, &ids)?;
            let message = format!("deleted {} generic/non-concrete entities", ids.len());
            write_repair_audit(conn, action, &ctx, ids.len(), &message)?;
            record_rate_limit(action).map_err(|err| rusqlite::Error::InvalidParameterName(err))?;
            Ok(repair_result(action, true, ids.len(), &message))
        })
        .await;

    match result {
        Ok(body) => (StatusCode::OK, Json(body)).into_response(),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(repair_result(action, false, 0, &error.to_string())),
        )
            .into_response(),
    }
}

#[derive(Clone)]
struct ClusterEntityRow {
    id: String,
    name: String,
    mentions: i64,
}

#[derive(Clone)]
struct ClusterEdge {
    left: String,
    right: String,
    weight: f64,
}

fn ordered_edge(left: &str, right: &str) -> (String, String) {
    if left <= right {
        (left.to_string(), right.to_string())
    } else {
        (right.to_string(), left.to_string())
    }
}

fn compute_component_cohesion(component: &[String], edges: &HashSet<(String, String)>) -> f64 {
    if component.len() < 2 {
        return 0.0;
    }
    let set = component.iter().collect::<HashSet<_>>();
    let internal = edges
        .iter()
        .filter(|(left, right)| set.contains(left) && set.contains(right))
        .count();
    let max_edges = component.len() * (component.len() - 1) / 2;
    if max_edges == 0 {
        0.0
    } else {
        internal as f64 / max_edges as f64
    }
}

fn compute_modularity(
    communities: &HashMap<String, usize>,
    degrees: &HashMap<String, f64>,
    edges: &[ClusterEdge],
    total_edge_weight: f64,
) -> f64 {
    if total_edge_weight <= f64::EPSILON {
        return 0.0;
    }

    let mut degree_by_community: HashMap<usize, f64> = HashMap::new();
    for (node_id, community) in communities {
        *degree_by_community.entry(*community).or_insert(0.0) +=
            degrees.get(node_id).copied().unwrap_or(0.0);
    }

    let mut internal_weight_by_community: HashMap<usize, f64> = HashMap::new();
    for edge in edges {
        let Some(left_community) = communities.get(&edge.left) else {
            continue;
        };
        if Some(left_community) == communities.get(&edge.right) {
            *internal_weight_by_community
                .entry(*left_community)
                .or_insert(0.0) += edge.weight;
        }
    }

    degree_by_community
        .iter()
        .map(|(community, degree_sum)| {
            let internal_weight = internal_weight_by_community
                .get(community)
                .copied()
                .unwrap_or(0.0);
            let expected = degree_sum / (2.0 * total_edge_weight);
            internal_weight / total_edge_weight - expected * expected
        })
        .sum()
}

fn compact_community_ids(
    node_ids: &[String],
    communities: HashMap<String, usize>,
) -> HashMap<String, usize> {
    let mut old_to_new: HashMap<usize, usize> = HashMap::new();
    let mut next = 0_usize;
    let mut compacted = HashMap::new();
    for node_id in node_ids {
        let old = communities.get(node_id).copied().unwrap_or(next);
        let new = *old_to_new.entry(old).or_insert_with(|| {
            let assigned = next;
            next += 1;
            assigned
        });
        compacted.insert(node_id.clone(), new);
    }
    compacted
}

fn detect_weighted_louvain_communities(
    node_ids: &[String],
    edges: &[ClusterEdge],
) -> (HashMap<String, usize>, f64) {
    let mut communities = node_ids
        .iter()
        .enumerate()
        .map(|(index, node_id)| (node_id.clone(), index))
        .collect::<HashMap<_, _>>();

    if node_ids.is_empty() || edges.is_empty() {
        return (communities, 0.0);
    }

    let mut degrees = node_ids
        .iter()
        .map(|node_id| (node_id.clone(), 0.0))
        .collect::<HashMap<_, _>>();
    let mut neighbor_communities_by_node: HashMap<String, HashSet<usize>> = node_ids
        .iter()
        .map(|node_id| (node_id.clone(), HashSet::new()))
        .collect();
    let mut total_edge_weight = 0.0;
    for edge in edges {
        total_edge_weight += edge.weight;
        *degrees.entry(edge.left.clone()).or_insert(0.0) += edge.weight;
        *degrees.entry(edge.right.clone()).or_insert(0.0) += edge.weight;
    }

    let mut modularity = compute_modularity(&communities, &degrees, edges, total_edge_weight);
    let mut next_community = node_ids.len();
    const EPSILON: f64 = 1.0e-12;

    // Mirrors the TS route's use of graphology-communities-louvain.detailed()
    // with getEdgeWeight="weight" (platform/daemon/src/pipeline/community-detection.ts:101-115):
    // start with one community per node, repeatedly move each node to the
    // neighboring community with the best positive weighted-modularity gain,
    // and stop at a local optimum for the current graph level.
    for _ in 0..100 {
        for communities_set in neighbor_communities_by_node.values_mut() {
            communities_set.clear();
        }
        for edge in edges {
            if let Some(community) = communities.get(&edge.right).copied() {
                neighbor_communities_by_node
                    .entry(edge.left.clone())
                    .or_default()
                    .insert(community);
            }
            if let Some(community) = communities.get(&edge.left).copied() {
                neighbor_communities_by_node
                    .entry(edge.right.clone())
                    .or_default()
                    .insert(community);
            }
        }

        let mut moved = false;
        for node_id in node_ids {
            let original_community = communities[node_id];
            let mut candidates = neighbor_communities_by_node
                .get(node_id)
                .cloned()
                .unwrap_or_default();
            candidates.insert(original_community);

            let original_size = communities
                .values()
                .filter(|community| **community == original_community)
                .count();
            if original_size > 1 {
                candidates.insert(next_community);
            }

            let mut ordered_candidates = candidates.into_iter().collect::<Vec<_>>();
            ordered_candidates.sort_unstable();

            let mut best_community = original_community;
            let mut best_modularity = modularity;
            for candidate in ordered_candidates {
                if candidate == original_community {
                    continue;
                }
                communities.insert(node_id.clone(), candidate);
                let candidate_modularity =
                    compute_modularity(&communities, &degrees, edges, total_edge_weight);
                if candidate_modularity > best_modularity + EPSILON {
                    best_community = candidate;
                    best_modularity = candidate_modularity;
                }
            }

            communities.insert(node_id.clone(), best_community);
            if best_community != original_community {
                moved = true;
                modularity = best_modularity;
                if best_community == next_community {
                    next_community += 1;
                }
            }
        }

        if !moved {
            break;
        }
    }

    let compacted = compact_community_ids(node_ids, communities);
    let modularity = compute_modularity(&compacted, &degrees, edges, total_edge_weight);
    (compacted, modularity)
}

fn cluster_entities_native(
    conn: &rusqlite::Connection,
    agent_id: &str,
) -> rusqlite::Result<serde_json::Value> {
    let mut entities = conn
        .prepare(
            "SELECT id, name, COALESCE(mentions, 0)
             FROM entities
             WHERE COALESCE(NULLIF(agent_id, ''), 'default') = ?1",
        )?
        .query_map([agent_id], |row| {
            Ok(ClusterEntityRow {
                id: row.get(0)?,
                name: row.get(1)?,
                mentions: row.get(2)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    entities.sort_by(|left, right| left.id.cmp(&right.id));

    if entities.is_empty() {
        return Ok(serde_json::json!({
            "communities": 0,
            "modularity": 0,
            "quality": "fragmented",
            "members": [],
        }));
    }

    let entity_by_id = entities
        .iter()
        .cloned()
        .map(|entity| (entity.id.clone(), entity))
        .collect::<HashMap<_, _>>();
    let mut edge_by_pair: HashMap<(String, String), f64> = HashMap::new();
    if sqlite_table_exists(conn, "entity_dependencies")? {
        let deps = conn
            .prepare(
                "SELECT source_entity_id, target_entity_id, strength, COALESCE(confidence, 0.7)
                 FROM entity_dependencies
                 WHERE COALESCE(NULLIF(agent_id, ''), 'default') = ?1",
            )?
            .query_map([agent_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, f64>(2)?,
                    row.get::<_, f64>(3)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for (left, right, strength, confidence) in deps {
            if left == right
                || !entity_by_id.contains_key(&left)
                || !entity_by_id.contains_key(&right)
            {
                continue;
            }
            let weight = strength * confidence;
            if !weight.is_finite() || weight <= 0.0 {
                continue;
            }
            let edge = ordered_edge(&left, &right);
            edge_by_pair
                .entry(edge)
                .and_modify(|existing| {
                    if weight > *existing {
                        *existing = weight;
                    }
                })
                .or_insert(weight);
        }
    }

    let mut edges = edge_by_pair
        .iter()
        .map(|((left, right), weight)| ClusterEdge {
            left: left.clone(),
            right: right.clone(),
            weight: *weight,
        })
        .collect::<Vec<_>>();
    edges.sort_by(|left, right| {
        left.left
            .cmp(&right.left)
            .then(left.right.cmp(&right.right))
    });
    let edge_pairs = edge_by_pair.keys().cloned().collect::<HashSet<_>>();
    let node_ids = entities
        .iter()
        .map(|entity| entity.id.clone())
        .collect::<Vec<_>>();
    let (communities_by_node, modularity) = detect_weighted_louvain_communities(&node_ids, &edges);

    let mut components_by_community: HashMap<usize, Vec<String>> = HashMap::new();
    for node_id in &node_ids {
        let community = communities_by_node.get(node_id).copied().unwrap_or(0);
        components_by_community
            .entry(community)
            .or_default()
            .push(node_id.clone());
    }
    let mut components = components_by_community.into_iter().collect::<Vec<_>>();
    components.sort_by_key(|(community, _)| *community);

    conn.execute(
        "DELETE FROM entity_communities WHERE agent_id = ?1",
        [agent_id],
    )?;
    conn.execute(
        "UPDATE entities SET community_id = NULL WHERE COALESCE(NULLIF(agent_id, ''), 'default') = ?1",
        [agent_id],
    )?;

    let now = chrono::Utc::now().to_rfc3339();
    let mut members = Vec::new();
    for (community, component) in components {
        let community_id = format!("community_{agent_id}_{community}");
        let best = component
            .iter()
            .filter_map(|id| entity_by_id.get(id))
            .max_by_key(|entity| entity.mentions);
        let name = best.map(|entity| entity.name.clone());
        let cohesion = compute_component_cohesion(&component, &edge_pairs);
        conn.execute(
            "INSERT INTO entity_communities (id, agent_id, name, cohesion, member_count, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
            rusqlite::params![community_id, agent_id, name, cohesion, component.len() as i64, now],
        )?;
        for entity_id in &component {
            conn.execute(
                "UPDATE entities SET community_id = ?1 WHERE id = ?2 AND COALESCE(NULLIF(agent_id, ''), 'default') = ?3",
                rusqlite::params![community_id, entity_id, agent_id],
            )?;
        }
        members.push(serde_json::json!({
            "id": community_id,
            "name": name,
            "count": component.len(),
            "cohesion": cohesion,
        }));
    }

    let quality = if modularity > 0.6 {
        "strong"
    } else if modularity >= 0.3 {
        "moderate"
    } else {
        "fragmented"
    };
    Ok(serde_json::json!({
        "communities": members.len(),
        "modularity": modularity,
        "quality": quality,
        "members": members,
    }))
}

/// POST /api/repair/cluster-entities — cluster likely duplicate entities.
pub async fn cluster_entities(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
    body: Option<Json<RepairAgentBody>>,
) -> impl IntoResponse {
    let body = body.map(|Json(body)| body).unwrap_or_default();
    let agent_id = resolve_repair_agent_id(&headers, &query, body.agent_id.as_deref());
    let result = state
        .pool
        .write_tx(signet_core::db::Priority::Low, move |conn| {
            Ok(cluster_entities_native(conn, &agent_id)?)
        })
        .await;
    match result {
        Ok(body) => (StatusCode::OK, Json(body)).into_response(),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": error.to_string()})),
        )
            .into_response(),
    }
}

fn extract_candidate_names(text: &str) -> Vec<String> {
    const SKIP: &[&str] = &[
        "the",
        "this",
        "that",
        "these",
        "those",
        "there",
        "then",
        "what",
        "when",
        "where",
        "which",
        "while",
        "who",
        "how",
        "here",
        "have",
        "has",
        "had",
        "our",
        "your",
        "their",
        "some",
        "any",
        "all",
        "each",
        "every",
        "both",
        "few",
        "more",
        "most",
        "many",
        "much",
        "other",
        "another",
        "such",
        "like",
        "just",
        "also",
        "only",
        "very",
        "new",
        "old",
        "good",
        "great",
        "best",
        "well",
        "long",
        "high",
        "low",
        "big",
        "small",
        "large",
        "little",
        "same",
        "different",
        "important",
        "sure",
        "true",
        "right",
        "left",
        "yes",
        "not",
        "but",
        "and",
        "for",
        "nor",
        "yet",
        "can",
        "may",
        "will",
        "shall",
        "should",
        "would",
        "could",
        "might",
        "must",
        "does",
        "did",
        "been",
        "being",
        "are",
        "was",
        "were",
        "note",
        "however",
        "therefore",
        "thus",
        "key",
        "facts",
        "preferences",
        "events",
        "relationships",
    ];
    let mut names = Vec::new();
    for sentence in text
        .split(|ch| ['.', '!', '?', '\n'].contains(&ch))
        .filter(|s| !s.trim().is_empty())
    {
        let mut run: Vec<String> = Vec::new();
        for word in sentence.split_whitespace() {
            let clean = word
                .trim_matches(|ch: char| ",;:'\"()[]{}".contains(ch))
                .to_string();
            if clean.is_empty() {
                continue;
            }
            let is_capitalized = clean
                .chars()
                .next()
                .is_some_and(|ch| ch.is_ascii_uppercase())
                && clean
                    .chars()
                    .nth(1)
                    .is_some_and(|ch| ch.is_ascii_lowercase());
            let is_all_caps = clean.len() <= 6
                && clean.len() >= 2
                && clean.chars().all(|ch| ch.is_ascii_uppercase());
            if (is_capitalized || is_all_caps)
                && !SKIP.contains(&clean.to_ascii_lowercase().as_str())
            {
                run.push(clean);
            } else if !run.is_empty() {
                let name = run.join(" ");
                if name.len() >= 3 && !names.contains(&name) {
                    names.push(name);
                }
                run.clear();
            }
        }
        if !run.is_empty() {
            let name = run.join(" ");
            if name.len() >= 3 && !names.contains(&name) {
                names.push(name);
            }
        }
    }
    names
}

fn link_memory_to_entities_native(
    conn: &rusqlite::Connection,
    memory_id: &str,
    content: &str,
    agent_id: &str,
) -> rusqlite::Result<(usize, Vec<String>)> {
    let names = extract_candidate_names(content);
    if names.is_empty() {
        return Ok((0, Vec::new()));
    }
    let now = chrono::Utc::now().to_rfc3339();
    let mut linked = 0_usize;
    let mut entity_ids = Vec::new();
    for name in names {
        let canonical = normalize_entity_name(&name);
        if canonical.len() < 3 {
            continue;
        }
        let entity_id = conn
            .query_row(
                "SELECT id FROM entities
                 WHERE (canonical_name = ?1 OR name = ?2)
                   AND COALESCE(NULLIF(agent_id, ''), 'default') = ?3
                 LIMIT 1",
                rusqlite::params![canonical, name, agent_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        let Some(entity_id) = entity_id else {
            continue;
        };
        conn.execute(
            "UPDATE entities SET mentions = COALESCE(mentions, 0) + 1, updated_at = ?1 WHERE id = ?2",
            rusqlite::params![now, entity_id],
        )?;
        let changes = conn.execute(
            "INSERT OR IGNORE INTO memory_entity_mentions
             (memory_id, entity_id, mention_text, confidence, created_at)
             VALUES (?1, ?2, ?3, 0.8, ?4)",
            rusqlite::params![memory_id, entity_id, name, now],
        )?;
        if changes > 0 {
            linked += 1;
        }
        entity_ids.push(entity_id);
    }
    Ok((linked, entity_ids))
}

/// POST /api/repair/relink-entities — link unlinked memories to ontology entities.
pub async fn relink_entities(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
    body: Option<Json<RelinkBody>>,
) -> impl IntoResponse {
    let body = body.map(|Json(body)| body).unwrap_or_default();
    let batch_size = body.batch_size.unwrap_or(500).clamp(1, 5000) as i64;
    let agent_id = resolve_repair_agent_id(&headers, &query, body.agent_id.as_deref());
    let result = state
        .pool
        .write_tx(signet_core::db::Priority::Low, move |conn| {
            let rows = conn
                .prepare(
                    "SELECT id, content FROM memories
                     WHERE COALESCE(is_deleted, 0) = 0
                       AND COALESCE(NULLIF(agent_id, ''), 'default') = ?1
                       AND id NOT IN (SELECT DISTINCT memory_id FROM memory_entity_mentions)
                     LIMIT ?2",
                )?
                .query_map(rusqlite::params![agent_id, batch_size], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            if rows.is_empty() {
                return Ok(serde_json::json!({
                    "action": "relink-entities",
                    "linked": 0,
                    "remaining": 0,
                    "message": "all memories linked",
                }));
            }
            let mut linked = 0_usize;
            let mut entities = 0_usize;
            for (id, content) in &rows {
                let (count, entity_ids) =
                    link_memory_to_entities_native(conn, id, content, &agent_id)?;
                linked += count;
                entities += entity_ids.len();
            }
            let remaining: i64 = conn.query_row(
                "SELECT COUNT(*) FROM memories
                 WHERE COALESCE(is_deleted, 0) = 0
                   AND COALESCE(NULLIF(agent_id, ''), 'default') = ?1
                   AND id NOT IN (SELECT DISTINCT memory_id FROM memory_entity_mentions)",
                [agent_id],
                |row| row.get(0),
            )?;
            Ok(serde_json::json!({
                "action": "relink-entities",
                "processed": rows.len(),
                "linked": linked,
                "entities": entities,
                "aspects": 0,
                "attributes": 0,
                "remaining": remaining,
                "message": if remaining > 0 {
                    format!("{remaining} memories still need linking — call again")
                } else {
                    "all memories linked".to_string()
                },
            }))
        })
        .await;
    match result {
        Ok(body) => (StatusCode::OK, Json(body)).into_response(),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": error.to_string()})),
        )
            .into_response(),
    }
}

/// POST /api/repair/backfill-hints — enqueue prospective hint jobs for unhinted rows.
pub async fn backfill_hints(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
    body: Option<Json<BackfillHintsBody>>,
) -> impl IntoResponse {
    let cfg = pipeline_config(&state);
    if !cfg.hints.enabled {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "Hints disabled in pipeline config"})),
        )
            .into_response();
    }

    let body = body.map(|Json(body)| body).unwrap_or_default();
    let batch_size = body.batch_size.unwrap_or(50).clamp(1, 200) as i64;
    let agent_id = resolve_repair_agent_id(&headers, &query, body.agent_id.as_deref());
    let result = state
        .pool
        .write_tx(signet_core::db::Priority::Low, move |conn| {
            let rows = conn
                .prepare(
                    "SELECT m.id, m.content FROM memories m
                     WHERE COALESCE(m.is_deleted, 0) = 0
                       AND m.scope IS NULL
                       AND COALESCE(NULLIF(m.agent_id, ''), 'default') = ?1
                       AND m.id NOT IN (SELECT DISTINCT memory_id FROM memory_hints)
                     ORDER BY m.created_at DESC
                     LIMIT ?2",
                )?
                .query_map(rusqlite::params![agent_id, batch_size], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            if rows.is_empty() {
                return Ok(serde_json::json!({
                    "action": "backfill-hints",
                    "enqueued": 0,
                    "remaining": 0,
                    "message": "all unscoped memories have hints",
                }));
            }
            let now = chrono::Utc::now().to_rfc3339();
            let mut enqueued = 0_usize;
            for (memory_id, content) in rows {
                let payload = serde_json::json!({"memoryId": memory_id, "content": content}).to_string();
                conn.execute(
                    "INSERT INTO memory_jobs
                     (id, memory_id, job_type, status, payload, attempts, max_attempts, created_at, updated_at)
                     VALUES (?1, ?2, 'prospective_index', 'pending', ?3, 0, 3, ?4, ?4)",
                    rusqlite::params![uuid::Uuid::new_v4().to_string(), memory_id, payload, now],
                )?;
                enqueued += 1;
            }
            let remaining: i64 = conn.query_row(
                "SELECT COUNT(*) FROM memories
                 WHERE COALESCE(is_deleted, 0) = 0
                   AND scope IS NULL
                   AND COALESCE(NULLIF(agent_id, ''), 'default') = ?1
                   AND id NOT IN (SELECT DISTINCT memory_id FROM memory_hints)",
                [agent_id],
                |row| row.get(0),
            )?;
            Ok(serde_json::json!({
                "action": "backfill-hints",
                "enqueued": enqueued,
                "remaining": remaining,
                "message": if remaining > 0 {
                    format!("{remaining} unscoped memories still need hints — call again")
                } else {
                    "all unscoped memories have hints".to_string()
                },
            }))
        })
        .await;
    match result {
        Ok(body) => (StatusCode::OK, Json(body)).into_response(),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": error.to_string()})),
        )
            .into_response(),
    }
}

/// GET /api/repair/dead-memories — review low-confidence stale memories.
pub async fn dead_memories(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
) -> impl IntoResponse {
    let max_confidence = query
        .get("maxConfidence")
        .and_then(|value| value.parse::<f64>().ok())
        .unwrap_or(0.1);
    let max_access_days = query
        .get("maxAccessDays")
        .and_then(|value| value.parse::<f64>().ok())
        .unwrap_or(90.0);
    let limit = query
        .get("limit")
        .and_then(|value| value.parse::<f64>().ok())
        .unwrap_or(200.0);

    if !(0.0..=1.0).contains(&max_confidence)
        || !max_access_days.is_finite()
        || !limit.is_finite()
        || max_access_days < 0.0
        || limit < 0.0
    {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": "maxConfidence must be 0–1, maxAccessDays and limit must be non-negative"
            })),
        )
            .into_response();
    }

    let agent_id = resolve_repair_agent_id(&headers, &query, None);
    let visibility = query_text(&query, "visibility", "visibility");
    let scope = normalize_scope_value(query_text(&query, "scope", "scope"));
    let limit = limit.min(500.0).floor() as i64;
    let result = state
        .pool
        .read(move |conn| {
            let mut sql = String::from(
                "SELECT id, content, confidence, last_accessed, importance,
                        CASE
                          WHEN confidence < ?1 THEN 'low_confidence'
                          WHEN last_accessed IS NULL THEN 'never_accessed'
                          ELSE 'stale'
                        END AS reason
                 FROM memories
                 WHERE COALESCE(is_deleted, 0) = 0
                   AND COALESCE(NULLIF(agent_id, ''), 'default') = ?4
                   AND COALESCE(importance, 0.5) <= 0.8
                   AND (
                     confidence < ?1
                     OR (last_accessed IS NULL AND julianday('now') - julianday(created_at) > ?2)
                     OR (last_accessed IS NOT NULL AND julianday('now') - julianday(last_accessed) > ?3)
                   )",
            );
            let mut params: Vec<rusqlite::types::Value> = vec![
                max_confidence.into(),
                max_access_days.into(),
                max_access_days.into(),
                agent_id.into(),
            ];
            if let Some(visibility) = visibility {
                sql.push_str(" AND COALESCE(visibility, 'global') = ?");
                params.push(visibility.into());
            }
            if let Some(scope) = scope {
                sql.push_str(" AND COALESCE(scope, '__NULL__') = ?");
                params.push(scope.into());
            }
            sql.push_str(" ORDER BY confidence ASC, last_accessed ASC NULLS FIRST LIMIT ?");
            params.push(limit.into());
            let memories = conn
                .prepare(&sql)?
                .query_map(rusqlite::params_from_iter(params.iter()), |row| {
                    Ok(serde_json::json!({
                        "id": row.get::<_, String>(0)?,
                        "content": row.get::<_, String>(1)?,
                        "confidence": row.get::<_, f64>(2)?,
                        "last_accessed": row.get::<_, Option<String>>(3)?,
                        "importance": row.get::<_, f64>(4)?,
                        "reason": row.get::<_, String>(5)?,
                    }))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(serde_json::json!({
                "count": memories.len(),
                "memories": memories,
            }))
        })
        .await;

    match result {
        Ok(body) => (StatusCode::OK, Json(body)).into_response(),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": error.to_string()})),
        )
            .into_response(),
    }
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ForgetDeadMemoriesBody {
    ids: Vec<serde_json::Value>,
    #[serde(alias = "agent_id")]
    agent_id: Option<String>,
    visibility: Option<String>,
    scope: Option<String>,
}

/// POST /api/repair/dead-memories/forget — forget reviewed dead memories.
pub async fn forget_dead_memories(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
    Json(body): Json<ForgetDeadMemoriesBody>,
) -> impl IntoResponse {
    if body.ids.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "ids must be a non-empty array" })),
        )
            .into_response();
    }
    if body.ids.len() > 500 {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "Maximum 500 ids per batch" })),
        )
            .into_response();
    }
    let mut ids = Vec::with_capacity(body.ids.len());
    for id in &body.ids {
        let Some(id) = id.as_str().filter(|value| !value.is_empty()) else {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": "All ids must be non-empty strings" })),
            )
                .into_response();
        };
        ids.push(id.to_string());
    }
    let agent_id = resolve_repair_agent_id(&headers, &query, body.agent_id.as_deref());
    let visibility = normalize_scope_value(body.visibility)
        .or_else(|| query_text(&query, "visibility", "visibility"));
    let scope = normalize_scope_value(body.scope).or_else(|| query_text(&query, "scope", "scope"));
    let ctx = resolve_repair_context(&headers);
    let result = state
        .pool
        .write_tx(signet_core::db::Priority::Low, move |conn| {
            let now = chrono::Utc::now().to_rfc3339();
            let mut forgotten = 0_usize;
            for id in &ids {
                let mut sql = String::from(
                    "UPDATE memories SET is_deleted = 1, deleted_at = ?1, updated_at = ?1
                     WHERE id = ?2
                       AND COALESCE(is_deleted, 0) = 0
                       AND COALESCE(NULLIF(agent_id, ''), 'default') = ?3",
                );
                let mut params: Vec<rusqlite::types::Value> = vec![
                    now.clone().into(),
                    id.clone().into(),
                    agent_id.clone().into(),
                ];
                if let Some(visibility) = visibility.as_ref() {
                    sql.push_str(" AND COALESCE(visibility, 'global') = ?");
                    params.push(visibility.clone().into());
                }
                if let Some(scope) = scope.as_ref() {
                    sql.push_str(" AND COALESCE(scope, '__NULL__') = ?");
                    params.push(scope.clone().into());
                }
                forgotten += conn.execute(&sql, rusqlite::params_from_iter(params.iter()))?;
            }
            write_repair_audit(
                conn,
                "forget-dead-memories",
                &ctx,
                forgotten,
                &format!("soft-deleted {forgotten} dead memories"),
            )?;
            Ok(serde_json::json!({ "forgotten": forgotten }))
        })
        .await;
    match result {
        Ok(body) => (StatusCode::OK, Json(body)).into_response(),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": error.to_string()})),
        )
            .into_response(),
    }
}

/// GET /api/repair/cold-stats — audit cold storage.
pub async fn cold_stats(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    let result = state
        .pool
        .read(|conn| {
            let count: i64 = conn
                .query_row("SELECT COUNT(*) FROM memories_cold", [], |r| r.get(0))
                .unwrap_or(0);

            let oldest: Option<String> = conn
                .query_row("SELECT MIN(created_at) FROM memories_cold", [], |r| {
                    r.get(0)
                })
                .ok();

            let newest: Option<String> = conn
                .query_row("SELECT MAX(archived_at) FROM memories_cold", [], |r| {
                    r.get(0)
                })
                .ok();

            Ok(serde_json::json!({
                "count": count,
                "oldest": oldest,
                "newest": newest,
            }))
        })
        .await
        .unwrap_or_else(|_| serde_json::json!({"count": 0}));

    Json(result)
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use axum::Router;
    use axum::body::{Body, to_bytes};
    use axum::http::{Request, StatusCode};
    use axum::routing::post;
    use signet_core::config::{AgentIdentity, AgentManifest, DaemonConfig, EmbeddingConfig};
    use signet_core::db::DbPool;
    use signet_pipeline::embedding::EmbeddingProvider;
    use tempfile::tempdir;
    use tower::ServiceExt;

    use crate::auth::rate_limiter::{AuthRateLimiter, default_limits};
    use crate::auth::types::AuthMode;
    use crate::state::{AppState, AuthRuntimeState};

    use super::*;

    fn test_state_with_embedding(
        embedding: Option<Arc<dyn EmbeddingProvider>>,
    ) -> (Arc<AppState>, tokio::task::JoinHandle<()>) {
        let dir = tempdir().expect("tempdir").keep();
        let db = dir.join("memory").join("memories.db");
        let (pool, writer) = DbPool::open(&db).expect("open db");
        let rules = default_limits();

        (
            Arc::new(AppState::new(
                DaemonConfig {
                    base_path: dir,
                    db_path: db,
                    port: 3850,
                    host: "127.0.0.1".to_string(),
                    bind: Some("127.0.0.1".to_string()),
                    manifest: AgentManifest {
                        agent: AgentIdentity {
                            name: "test-agent".to_string(),
                            description: None,
                            created: None,
                            updated: None,
                        },
                        embedding: Some(EmbeddingConfig {
                            provider: "fake".to_string(),
                            model: "fake-embedding".to_string(),
                            dimensions: 768,
                            base_url: None,
                            api_key: None,
                        }),
                        ..Default::default()
                    },
                },
                pool,
                embedding,
                None,
                None,
                AuthRuntimeState {
                    mode: AuthMode::Local,
                    secret: None,
                    admin_limiter: AuthRateLimiter::from_rules(&rules),
                    recall_llm_limiter: AuthRateLimiter::from_rules(&rules),
                },
            )),
            writer,
        )
    }

    fn test_state() -> Arc<AppState> {
        let (state, _writer) = test_state_with_embedding(None);
        state
    }

    #[tokio::test]
    async fn check_fts_accepts_empty_post_without_json_content_type() {
        let app = Router::new()
            .route("/api/repair/check-fts", post(check_fts))
            .with_state(test_state());

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/repair/check-fts")
                    .body(Body::empty())
                    .expect("build request"),
            )
            .await
            .expect("send request");

        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("read body");
        let json: serde_json::Value = serde_json::from_slice(&body).expect("json body");

        assert_eq!(json["action"], "check_fts");
        assert_eq!(json["success"], true);
    }

    #[tokio::test]
    async fn embedding_gap_helpers_backfill_hashes_embeddings_and_vec_rows() {
        let (state, writer) = test_state_with_embedding(None);
        let now = chrono::Utc::now().to_rfc3339();
        state
            .pool
            .write(signet_core::db::Priority::High, move |conn| {
                conn.execute(
                    "INSERT INTO memories
                     (id, type, content, confidence, importance, created_at, updated_at,
                      updated_by, is_deleted, agent_id, visibility)
                     VALUES
                     ('mem-gap-a', 'fact', 'Needs an embedding.', 1.0, 0.5, ?1, ?1,
                      'test', 0, 'default', 'private')",
                    rusqlite::params![now],
                )?;
                conn.execute(
                    "INSERT INTO memories
                     (id, type, content, content_hash, confidence, importance, created_at,
                      updated_at, updated_by, is_deleted, agent_id, visibility)
                     VALUES
                     ('mem-gap-b', 'fact', 'Already hashed.', 'hash-gap-b', 1.0, 0.5,
                      ?1, ?1, 'test', 0, 'default', 'private')",
                    rusqlite::params![now],
                )?;
                Ok(serde_json::Value::Null)
            })
            .await
            .expect("seed memories");

        let selected = state
            .pool
            .read(|conn| {
                assert_eq!(count_active_memories(conn)?, 2);
                assert_eq!(count_unembedded_memories(conn)?, 2);
                let rows = list_unembedded_memories(conn, 1)?;
                Ok(serde_json::json!({
                    "id": rows[0].id,
                    "content": rows[0].content,
                    "hash": rows[0].content_hash,
                }))
            })
            .await
            .expect("list gaps");
        let row = UnembeddedMemory {
            id: selected["id"].as_str().unwrap().to_string(),
            content: selected["content"].as_str().unwrap().to_string(),
            content_hash: selected["hash"].as_str().map(ToOwned::to_owned),
        };
        let selected_id = row.id.clone();

        state
            .pool
            .write(signet_core::db::Priority::High, move |conn| {
                let written = write_embedding_batch(
                    conn,
                    &[(row, vec![0.25_f32; 768])],
                    Some("fake-embedding"),
                )?;
                Ok(serde_json::json!(written))
            })
            .await
            .expect("write embedding batch");

        let counts = state
            .pool
            .read(move |conn| {
                Ok(serde_json::json!({
                    "missing": count_unembedded_memories(conn)?,
                    "embeddings": conn.query_row("SELECT COUNT(*) FROM embeddings", [], |row| row.get::<_, i64>(0))?,
                    "vec": conn.query_row("SELECT COUNT(*) FROM vec_embeddings", [], |row| row.get::<_, i64>(0)).unwrap_or(0),
                    "model": conn.query_row("SELECT embedding_model FROM memories WHERE id = ?1", [&selected_id], |row| row.get::<_, Option<String>>(0))?,
                    "hash": conn.query_row("SELECT content_hash FROM memories WHERE id = ?1", [&selected_id], |row| row.get::<_, Option<String>>(0))?,
                }))
            })
            .await
            .expect("read backfill results");
        assert_eq!(counts["missing"], 1);
        assert_eq!(counts["embeddings"], 1);
        assert_eq!(counts["vec"], 1);
        assert_eq!(counts["model"], "fake-embedding");
        assert!(counts["hash"].as_str().is_some_and(|hash| !hash.is_empty()));

        drop(state);
        writer.abort();
    }

    #[tokio::test]
    async fn re_embed_route_calls_provider_and_writes_embedding() {
        let (state, writer) = test_state_with_embedding(Some(Arc::new(FakeEmbeddingProvider)));
        let now = chrono::Utc::now().to_rfc3339();
        state
            .pool
            .write(signet_core::db::Priority::High, move |conn| {
                conn.execute(
                    "INSERT INTO memories
                     (id, type, content, confidence, importance, created_at, updated_at,
                      updated_by, is_deleted, agent_id, visibility)
                     VALUES
                     ('mem-route-gap', 'fact', 'Route should backfill me.', 1.0, 0.5,
                      ?1, ?1, 'test', 0, 'default', 'private')",
                    rusqlite::params![now],
                )?;
                Ok(serde_json::Value::Null)
            })
            .await
            .expect("seed route memory");

        let app = Router::new()
            .route("/api/repair/re-embed", post(re_embed))
            .with_state(state.clone());
        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/repair/re-embed")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"batchSize":1}"#))
                    .expect("build request"),
            )
            .await
            .expect("send request");
        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("read body");
        let json: serde_json::Value = serde_json::from_slice(&body).expect("json body");
        assert_eq!(json["action"], "reembedMissingMemories");
        assert_eq!(json["success"], true);
        assert_eq!(json["affected"], 1);

        let embeddings = state
            .pool
            .read(|conn| {
                Ok(conn.query_row(
                    "SELECT COUNT(*) FROM embeddings WHERE source_id = 'mem-route-gap'",
                    [],
                    |row| Ok(serde_json::json!(row.get::<_, i64>(0)?)),
                )?)
            })
            .await
            .expect("count route embeddings");
        assert_eq!(embeddings, 1);

        drop(state);
        writer.abort();
    }

    #[tokio::test]
    async fn re_embed_skips_stale_candidates_after_modify_or_delete() {
        let (state, writer) = test_state_with_embedding(None);
        let old_a = normalize_and_hash("Old modified content");
        let old_b = normalize_and_hash("Old deleted content");
        let new_a = normalize_and_hash("New modified content");
        state
            .pool
            .write(signet_core::db::Priority::High, move |conn| {
                conn.execute(
                    "INSERT INTO memories
                     (id, type, content, content_hash, confidence, importance, created_at,
                      updated_at, updated_by, is_deleted, agent_id, visibility)
                     VALUES
                     ('mem-stale-modified', 'fact', 'Old modified content', ?1, 1.0, 0.5,
                      '2026-06-01T00:00:00Z', '2026-06-01T00:00:00Z', 'test', 0, 'agent-a', 'private'),
                     ('mem-stale-deleted', 'fact', 'Old deleted content', ?2, 1.0, 0.5,
                      '2026-06-01T00:00:00Z', '2026-06-01T00:00:00Z', 'test', 0, 'agent-a', 'private')",
                    rusqlite::params![old_a.hash, old_b.hash],
                )?;
                Ok(serde_json::Value::Null)
            })
            .await
            .expect("seed stale memories");

        let candidates = state
            .pool
            .read(|conn| Ok(list_unembedded_memories(conn, 10)?))
            .await
            .expect("list candidates");
        assert_eq!(candidates.len(), 2);

        state
            .pool
            .write(signet_core::db::Priority::High, move |conn| {
                conn.execute(
                    "UPDATE memories
                     SET content = ?1,
                         normalized_content = ?2,
                         content_hash = ?3
                     WHERE id = 'mem-stale-modified'",
                    rusqlite::params![new_a.storage, new_a.normalized, new_a.hash],
                )?;
                conn.execute(
                    "UPDATE memories SET is_deleted = 1 WHERE id = 'mem-stale-deleted'",
                    [],
                )?;
                Ok(serde_json::Value::Null)
            })
            .await
            .expect("make candidates stale");

        state
            .pool
            .write(signet_core::db::Priority::High, move |conn| {
                let vectors = candidates
                    .into_iter()
                    .map(|candidate| (candidate, vec![0.5; 768]))
                    .collect::<Vec<_>>();
                Ok(serde_json::json!(write_embedding_batch(
                    conn,
                    &vectors,
                    Some("fake-embedding")
                )?))
            })
            .await
            .expect("write stale candidates");

        let embeddings = state
            .pool
            .read(|conn| {
                Ok(
                    conn.query_row("SELECT COUNT(*) FROM embeddings", [], |row| {
                        row.get::<_, i64>(0)
                    })?,
                )
            })
            .await
            .expect("count embeddings");
        assert_eq!(embeddings, 0);

        drop(state);
        writer.abort();
    }

    #[tokio::test]
    async fn re_embed_scopes_embedding_hash_by_agent_and_memory() {
        let (state, writer) = test_state_with_embedding(None);
        let normalized = normalize_and_hash("Shared normalized content");
        let expected_hash = normalized.hash.clone();
        let normalized_content = normalized.normalized.clone();
        let memory_hash = normalized.hash.clone();
        state
            .pool
            .write(signet_core::db::Priority::High, move |conn| {
                conn.execute(
                    "INSERT INTO memories
                     (id, type, content, normalized_content, content_hash, confidence, importance,
                      created_at, updated_at, updated_by, is_deleted, agent_id, visibility)
                     VALUES
                     ('mem-scope-a', 'fact', 'Shared normalized content', ?1, ?2, 1.0, 0.5,
                      '2026-06-01T00:00:00Z', '2026-06-01T00:00:00Z', 'test', 0, 'agent-a', 'private'),
                     ('mem-scope-b', 'fact', 'Shared normalized content', ?1, ?2, 1.0, 0.5,
                      '2026-06-01T00:00:00Z', '2026-06-01T00:00:00Z', 'test', 0, 'agent-b', 'private')",
                    rusqlite::params![normalized_content, memory_hash],
                )?;
                Ok(serde_json::Value::Null)
            })
            .await
            .expect("seed scoped memories");

        let candidates = state
            .pool
            .read(|conn| Ok(list_unembedded_memories(conn, 10)?))
            .await
            .expect("list scoped candidates");
        assert_eq!(candidates.len(), 2);

        state
            .pool
            .write(signet_core::db::Priority::High, move |conn| {
                let vectors = candidates
                    .into_iter()
                    .map(|candidate| (candidate, vec![0.5; 768]))
                    .collect::<Vec<_>>();
                Ok(serde_json::json!(write_embedding_batch(
                    conn,
                    &vectors,
                    Some("fake-embedding")
                )?))
            })
            .await
            .expect("write scoped embeddings");

        let query_hash = expected_hash.clone();
        let embeddings = state
            .pool
            .read(move |conn| {
                Ok(serde_json::json!({
                    "count": conn.query_row("SELECT COUNT(*) FROM embeddings", [], |row| row.get::<_, i64>(0))?,
                    "agentA": conn.query_row(
                        "SELECT content_hash FROM embeddings
                         WHERE source_type = 'memory' AND source_id = 'mem-scope-a'",
                        [],
                        |row| row.get::<_, String>(0),
                    )?,
                    "agentB": conn.query_row(
                        "SELECT content_hash FROM embeddings
                         WHERE source_type = 'memory' AND source_id = 'mem-scope-b'",
                        [],
                        |row| row.get::<_, String>(0),
                    )?,
                    "rawHashRows": conn.query_row(
                        "SELECT COUNT(*) FROM embeddings WHERE content_hash = ?1",
                        [&query_hash],
                        |row| row.get::<_, i64>(0),
                    )?,
                }))
            })
            .await
            .expect("read scoped embeddings");

        assert_eq!(embeddings["count"], 2);
        assert_eq!(
            embeddings["agentA"],
            format!("memory:agent-a:mem-scope-a:{expected_hash}")
        );
        assert_eq!(
            embeddings["agentB"],
            format!("memory:agent-b:mem-scope-b:{expected_hash}")
        );
        assert_eq!(embeddings["rawHashRows"], 0);

        drop(state);
        writer.abort();
    }

    #[tokio::test]
    async fn re_embed_gap_detection_ignores_legacy_raw_hash_for_other_memories() {
        let (state, writer) = test_state_with_embedding(None);
        let normalized = normalize_and_hash("Legacy shared content");
        state
            .pool
            .write(signet_core::db::Priority::High, move |conn| {
                let vector = signet_core::queries::embedding::vector_to_blob(&vec![0.25; 768]);
                conn.execute(
                    "INSERT INTO memories
                     (id, type, content, normalized_content, content_hash, confidence, importance,
                      created_at, updated_at, updated_by, is_deleted, agent_id, visibility)
                     VALUES
                     ('mem-legacy-a', 'fact', 'Legacy shared content', ?1, ?2, 1.0, 0.5,
                      '2026-06-01T00:00:00Z', '2026-06-01T00:00:00Z', 'test', 0, 'agent-a', 'private'),
                     ('mem-legacy-b', 'fact', 'Legacy shared content', ?1, ?2, 1.0, 0.5,
                      '2026-06-01T00:00:01Z', '2026-06-01T00:00:01Z', 'test', 0, 'agent-b', 'private')",
                    rusqlite::params![normalized.normalized, normalized.hash],
                )?;
                conn.execute(
                    "INSERT INTO embeddings
                     (id, content_hash, vector, dimensions, source_type, source_id, chunk_text, created_at, agent_id)
                     VALUES ('emb-legacy-a', ?1, ?2, 768, 'memory', 'mem-legacy-a',
                             'Legacy shared content', '2026-06-01T00:00:00Z', 'agent-a')",
                    rusqlite::params![normalized.hash, vector],
                )?;
                Ok(serde_json::Value::Null)
            })
            .await
            .expect("seed legacy raw embedding");

        let gaps = state
            .pool
            .read(|conn| {
                let rows = list_unembedded_memories(conn, 10)?;
                Ok(serde_json::json!({
                    "count": count_unembedded_memories(conn)?,
                    "ids": rows.into_iter().map(|row| row.id).collect::<Vec<_>>(),
                }))
            })
            .await
            .expect("read embedding gaps");

        assert_eq!(gaps["count"], 1);
        assert_eq!(gaps["ids"], serde_json::json!(["mem-legacy-b"]));

        drop(state);
        writer.abort();
    }

    #[tokio::test]
    async fn resync_vec_preserves_non_memory_embeddings() {
        let state = test_state();
        state
            .pool
            .write(signet_core::db::Priority::High, |conn| {
                let memory_vector =
                    signet_core::queries::embedding::vector_to_blob(&vec![0.25; 768]);
                let document_vector =
                    signet_core::queries::embedding::vector_to_blob(&vec![0.5; 768]);
                conn.execute(
                    "INSERT INTO memories
                     (id, content, normalized_content, content_hash, type, agent_id, created_at, updated_at, updated_by, importance)
                     VALUES (?1, ?2, ?2, ?3, 'fact', ?4, ?5, ?5, 'test', 0.5)",
                    rusqlite::params![
                        "mem-resync",
                        "Memory vector row",
                        "mem-resync-hash",
                        "agent-a",
                        "2026-06-01T00:00:00Z"
                    ],
                )?;
                conn.execute(
                    "INSERT INTO embeddings
                     (id, content_hash, vector, dimensions, source_type, source_id, chunk_text, created_at, agent_id)
                     VALUES (?1, ?2, ?3, 768, 'memory', ?4, ?5, ?6, ?7)",
                    rusqlite::params![
                        "emb-memory-resync",
                        "emb-memory-hash",
                        memory_vector,
                        "mem-resync",
                        "Memory vector row",
                        "2026-06-01T00:00:00Z",
                        "agent-a"
                    ],
                )?;
                conn.execute(
                    "INSERT INTO embeddings
                     (id, content_hash, vector, dimensions, source_type, source_id, chunk_text, created_at, agent_id)
                     VALUES (?1, ?2, ?3, 768, 'document', ?4, ?5, ?6, ?7)",
                    rusqlite::params![
                        "emb-document-resync",
                        "emb-document-hash",
                        document_vector,
                        "doc-resync",
                        "Document vector row",
                        "2026-06-01T00:00:00Z",
                        "agent-a"
                    ],
                )?;
                Ok(serde_json::Value::Null)
            })
            .await
            .expect("seed embeddings");

        let app = Router::new()
            .route("/api/repair/resync-vec", post(resync_vec))
            .with_state(state.clone());
        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/repair/resync-vec")
                    .body(Body::empty())
                    .expect("build request"),
            )
            .await
            .expect("send request");

        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("read body");
        let json: serde_json::Value = serde_json::from_slice(&body).expect("json body");
        assert_eq!(json["success"], true);
        assert_eq!(json["affected"], 2);

        let document_vec_count = state
            .pool
            .read(|conn| {
                Ok(conn.query_row(
                    "SELECT COUNT(*) FROM vec_embeddings WHERE id = 'emb-document-resync'",
                    [],
                    |row| row.get::<_, i64>(0),
                )?)
            })
            .await
            .expect("read document vec count");

        assert_eq!(document_vec_count, 1);
    }

    struct FakeEmbeddingProvider;

    impl EmbeddingProvider for FakeEmbeddingProvider {
        fn embed(
            &self,
            _text: &str,
        ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Option<Vec<f32>>> + Send + '_>>
        {
            Box::pin(async { Some(vec![0.5; 768]) })
        }

        fn name(&self) -> &str {
            "fake"
        }

        fn dimensions(&self) -> usize {
            768
        }
    }
}
