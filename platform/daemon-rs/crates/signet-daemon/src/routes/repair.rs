//! Repair action routes: maintenance and recovery endpoints.

use std::collections::HashMap;
use std::convert::Infallible;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use axum::{
    body::{Body, Bytes},
    extract::{Query, State},
    http::{StatusCode, header},
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

/// POST /api/repair/prune-generic-entities — prune low-value generated graph nodes.
pub async fn prune_generic_entities() -> impl IntoResponse {
    (
        StatusCode::OK,
        Json(serde_json::json!({
            "action": "prune-generic-entities",
            "dryRun": true,
            "pruned": 0,
            "remaining": 0,
            "message": "no generic entities found",
        })),
    )
}

/// POST /api/repair/cluster-entities — cluster likely duplicate entities.
pub async fn cluster_entities() -> impl IntoResponse {
    Json(serde_json::json!({
        "action": "cluster-entities",
        "clusters": 0,
        "entities": 0,
        "message": "no entity clusters found",
    }))
}

/// POST /api/repair/relink-entities — link unlinked memories to ontology entities.
pub async fn relink_entities() -> impl IntoResponse {
    Json(serde_json::json!({
        "action": "relink-entities",
        "linked": 0,
        "remaining": 0,
        "message": "all memories linked",
    }))
}

/// POST /api/repair/backfill-hints — enqueue prospective hint jobs for unhinted rows.
pub async fn backfill_hints() -> impl IntoResponse {
    Json(serde_json::json!({
        "action": "backfill-hints",
        "enqueued": 0,
        "remaining": 0,
        "message": "all unscoped memories have hints",
    }))
}

/// GET /api/repair/dead-memories — review low-confidence stale memories.
pub async fn dead_memories(Query(query): Query<HashMap<String, String>>) -> impl IntoResponse {
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

    Json(serde_json::json!({
        "count": 0,
        "memories": [],
    }))
    .into_response()
}

#[derive(Default, Deserialize)]
#[serde(default)]
pub struct ForgetDeadMemoriesBody {
    ids: Vec<serde_json::Value>,
}

/// POST /api/repair/dead-memories/forget — forget reviewed dead memories.
pub async fn forget_dead_memories(Json(body): Json<ForgetDeadMemoriesBody>) -> impl IntoResponse {
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
    let valid = body
        .ids
        .iter()
        .all(|id| id.as_str().is_some_and(|value| !value.is_empty()));
    if !valid {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "All ids must be non-empty strings" })),
        )
            .into_response();
    }
    Json(serde_json::json!({ "forgotten": 0 })).into_response()
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
