//! Memory CRUD route handlers.

use std::sync::Arc;

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use signet_core::db::Priority;

use crate::feedback::parse_scores;
use crate::state::AppState;

// ---------------------------------------------------------------------------
// GET /api/memories
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct ListParams {
    limit: Option<usize>,
    offset: Option<usize>,
}

#[derive(Deserialize)]
pub struct MostUsedParams {
    limit: Option<usize>,
}

#[derive(Serialize)]
pub struct ListResponse {
    memories: Vec<serde_json::Value>,
    total: i64,
    stats: MemoryStats,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryStats {
    total: i64,
    with_embeddings: i64,
    critical: i64,
}

pub async fn list(
    State(state): State<Arc<AppState>>,
    Query(params): Query<ListParams>,
) -> Json<ListResponse> {
    let limit = params.limit.unwrap_or(100);
    let offset = params.offset.unwrap_or(0);

    let result = state
        .pool
        .read(move |conn| {
            let mut stmt = conn.prepare_cached(
                "SELECT id, content, created_at, who, importance, tags, source_type, pinned, type
                 FROM memories
                 ORDER BY created_at DESC
                 LIMIT ?1 OFFSET ?2",
            )?;
            let memories: Vec<serde_json::Value> = stmt
                .query_map(rusqlite::params![limit, offset], |row| {
                    Ok(serde_json::json!({
                        "id": row.get::<_, String>(0)?,
                        "content": row.get::<_, String>(1)?,
                        "created_at": row.get::<_, String>(2)?,
                        "who": row.get::<_, Option<String>>(3)?,
                        "importance": row.get::<_, f64>(4)?,
                        "tags": row.get::<_, Option<String>>(5)?,
                        "source_type": row.get::<_, Option<String>>(6)?,
                        "pinned": row.get::<_, i64>(7)? != 0,
                        "type": row.get::<_, String>(8)?,
                    }))
                })?
                .filter_map(|r| r.ok())
                .collect();

            let total: i64 = conn.query_row("SELECT COUNT(*) FROM memories", [], |r| r.get(0))?;
            let embeddings: i64 = conn
                .query_row("SELECT COUNT(*) FROM embeddings", [], |r| r.get(0))
                .unwrap_or(0);
            let critical: i64 = conn.query_row(
                "SELECT COUNT(*) FROM memories WHERE importance >= 0.9",
                [],
                |r| r.get(0),
            )?;

            Ok(ListResponse {
                memories,
                total,
                stats: MemoryStats {
                    total,
                    with_embeddings: embeddings,
                    critical,
                },
            })
        })
        .await
        .unwrap_or_else(|_| ListResponse {
            memories: vec![],
            total: 0,
            stats: MemoryStats {
                total: 0,
                with_embeddings: 0,
                critical: 0,
            },
        });

    Json(result)
}

// ---------------------------------------------------------------------------
// GET /api/memories/most-used
// ---------------------------------------------------------------------------

pub async fn most_used(
    State(state): State<Arc<AppState>>,
    Query(params): Query<MostUsedParams>,
) -> Json<serde_json::Value> {
    let limit = params.limit.unwrap_or(6).clamp(1, 200);
    let memories = state
        .pool
        .read(move |conn| {
            let mut stmt = conn.prepare_cached(
                "SELECT id, content, access_count, importance, type, tags
                 FROM memories
                 WHERE access_count > 0
                   AND (is_deleted = 0 OR is_deleted IS NULL)
                 ORDER BY access_count DESC, importance DESC
                 LIMIT ?1",
            )?;
            let rows: Vec<serde_json::Value> = stmt
                .query_map(rusqlite::params![limit], |row| {
                    Ok(serde_json::json!({
                        "id": row.get::<_, String>(0)?,
                        "content": row.get::<_, String>(1)?,
                        "access_count": row.get::<_, i64>(2)?,
                        "importance": row.get::<_, f64>(3)?,
                        "type": row.get::<_, String>(4)?,
                        "tags": row.get::<_, Option<String>>(5)?,
                    }))
                })?
                .filter_map(|row| row.ok())
                .collect();
            Ok(rows)
        })
        .await
        .unwrap_or_default();

    Json(serde_json::json!({ "memories": memories }))
}

// ---------------------------------------------------------------------------
// GET /api/memory/:id
// ---------------------------------------------------------------------------

pub async fn get(State(state): State<Arc<AppState>>, Path(id): Path<String>) -> impl IntoResponse {
    let row = state
        .pool
        .read(move |conn| {
            let mut stmt = conn.prepare_cached(
                "SELECT id, content, type, importance, tags, pinned, who,
                        source_id, source_type, project, session_id, confidence,
                        access_count, last_accessed, is_deleted, deleted_at,
                        extraction_status, embedding_model, version,
                        created_at, updated_at, updated_by
                 FROM memories WHERE id = ?1 AND (is_deleted = 0 OR is_deleted IS NULL)",
            )?;

            let result = stmt
                .query_row(rusqlite::params![id], |row| {
                    Ok(serde_json::json!({
                        "id": row.get::<_, String>(0)?,
                        "content": row.get::<_, String>(1)?,
                        "type": row.get::<_, String>(2)?,
                        "importance": row.get::<_, f64>(3)?,
                        "tags": row.get::<_, Option<String>>(4)?,
                        "pinned": row.get::<_, i64>(5)? != 0,
                        "who": row.get::<_, Option<String>>(6)?,
                        "source_id": row.get::<_, Option<String>>(7)?,
                        "source_type": row.get::<_, Option<String>>(8)?,
                        "project": row.get::<_, Option<String>>(9)?,
                        "sessionId": row.get::<_, Option<String>>(10)?,
                        "confidence": row.get::<_, f64>(11)?,
                        "access_count": row.get::<_, i64>(12)?,
                        "last_accessed": row.get::<_, Option<String>>(13)?,
                        "is_deleted": row.get::<_, i64>(14)? != 0,
                        "deleted_at": row.get::<_, Option<String>>(15)?,
                        "extraction_status": row.get::<_, Option<String>>(16)?,
                        "embedding_model": row.get::<_, Option<String>>(17)?,
                        "version": row.get::<_, i64>(18)?,
                        "created_at": row.get::<_, String>(19)?,
                        "updated_at": row.get::<_, String>(20)?,
                        "updated_by": row.get::<_, String>(21)?,
                    }))
                })
                .ok();

            Ok(result)
        })
        .await
        .unwrap_or(None);

    match row {
        Some(val) => (StatusCode::OK, Json(val)).into_response(),
        None => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"error": "not found"})),
        )
            .into_response(),
    }
}

// ---------------------------------------------------------------------------
// GET /api/memory/:id/history
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct HistoryParams {
    limit: Option<usize>,
}

pub async fn history(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Query(params): Query<HistoryParams>,
) -> impl IntoResponse {
    let limit = params.limit.unwrap_or(200).min(1000);

    let result = state
        .pool
        .read(move |conn| {
            // Check existence
            let exists: bool = conn
                .prepare_cached("SELECT id FROM memories WHERE id = ?1")?
                .exists(rusqlite::params![id])?;
            if !exists {
                return Ok(None);
            }

            let mut stmt = conn.prepare_cached(
                "SELECT id, event, old_content, new_content, changed_by, reason,
                        metadata, created_at, actor_type, session_id, request_id
                 FROM memory_history
                 WHERE memory_id = ?1
                 ORDER BY created_at DESC
                 LIMIT ?2",
            )?;
            let rows: Vec<serde_json::Value> = stmt
                .query_map(rusqlite::params![id, limit], |row| {
                    Ok(serde_json::json!({
                        "id": row.get::<_, String>(0)?,
                        "event": row.get::<_, String>(1)?,
                        "old_content": row.get::<_, Option<String>>(2)?,
                        "new_content": row.get::<_, Option<String>>(3)?,
                        "changed_by": row.get::<_, String>(4)?,
                        "reason": row.get::<_, Option<String>>(5)?,
                        "metadata": row.get::<_, Option<String>>(6)?,
                        "created_at": row.get::<_, String>(7)?,
                        "actor_type": row.get::<_, Option<String>>(8)?,
                        "session_id": row.get::<_, Option<String>>(9)?,
                        "request_id": row.get::<_, Option<String>>(10)?,
                    }))
                })?
                .filter_map(|r| r.ok())
                .collect();

            Ok(Some(serde_json::json!({
                "memoryId": id,
                "history": rows,
                "total": rows.len(),
            })))
        })
        .await
        .unwrap_or(None);

    match result {
        Some(val) => (StatusCode::OK, Json(val)).into_response(),
        None => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"error": "Not found"})),
        )
            .into_response(),
    }
}

// ---------------------------------------------------------------------------
// POST /api/memory/feedback
// ---------------------------------------------------------------------------

pub async fn feedback(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<Value>,
) -> impl IntoResponse {
    let Some(obj) = payload.as_object() else {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "Invalid JSON body"})),
        )
            .into_response();
    };

    let session = obj
        .get("sessionKey")
        .and_then(Value::as_str)
        .or_else(|| obj.get("session_key").and_then(Value::as_str));
    let raw = obj.get("feedback").or_else(|| obj.get("ratings"));

    let Some(session) = session else {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "sessionKey required"})),
        )
            .into_response();
    };
    let Some(raw) = raw else {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "feedback required"})),
        )
            .into_response();
    };

    let Some(feedback) = parse_scores(Some(raw)) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "Invalid feedback format — expected map of ID to number (-1 to 1)"})),
        )
            .into_response();
    };

    let session = session.to_string();
    let recorded = feedback.len() as i64;
    let updated = state
        .pool
        .write(Priority::High, move |conn| {
            let mut stmt = conn.prepare_cached(
                "UPDATE session_memories
                 SET agent_relevance_score = CASE
                         WHEN agent_relevance_score IS NULL THEN ?1
                         ELSE (agent_relevance_score * agent_feedback_count + ?1) / (agent_feedback_count + 1)
                     END,
                     agent_feedback_count = COALESCE(agent_feedback_count, 0) + 1
                 WHERE session_key = ?2 AND memory_id = ?3",
            )?;
            let mut accepted = 0_i64;
            for (memory_id, score) in feedback {
                let changed = stmt.execute(rusqlite::params![score, session, memory_id])?;
                accepted += changed as i64;
            }
            Ok(serde_json::json!({ "accepted": accepted }))
        })
        .await;

    match updated {
        Ok(val) => {
            let accepted = val.get("accepted").and_then(Value::as_i64).unwrap_or(0);
            (
                StatusCode::OK,
                Json(serde_json::json!({
                    "ok": true,
                    "recorded": recorded,
                    "accepted": accepted,
                    "propagated": 0,
                    "cooccurrenceUpdated": 0,
                    "dependenciesUpdated": 0
                })),
            )
                .into_response()
        }
        Err(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": "Failed to record feedback"})),
        )
            .into_response(),
    }
}
