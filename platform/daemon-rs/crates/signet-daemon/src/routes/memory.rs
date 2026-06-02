//! Memory CRUD route handlers.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::sync::Arc;

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha1::{Digest, Sha1};

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

#[derive(Deserialize)]
pub struct SimilarParams {
    id: Option<String>,
    k: Option<usize>,
    #[allow(dead_code)]
    r#type: Option<String>,
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
// GET /memory/similar
// ---------------------------------------------------------------------------

pub async fn similar(
    State(state): State<Arc<AppState>>,
    Query(params): Query<SimilarParams>,
) -> impl IntoResponse {
    let Some(id) = params.id.map(|id| id.trim().to_string()) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "id is required", "results": []})),
        )
            .into_response();
    };
    if id.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "id is required", "results": []})),
        )
            .into_response();
    }
    let _limit = params.k.unwrap_or(10).clamp(1, 100);

    let has_embedding = state
        .pool
        .read(move |conn| {
            Ok(conn
                .prepare_cached(
                    "SELECT 1
                   FROM embeddings
                  WHERE source_type = 'memory'
                    AND source_id = ?1
                  LIMIT 1",
                )?
                .exists(rusqlite::params![id])?)
        })
        .await;

    match has_embedding {
        Ok(true) => Json(serde_json::json!({"results": []})).into_response(),
        Ok(false) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({
                "error": "No embedding found for this memory",
                "results": [],
            })),
        )
            .into_response(),
        Err(err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({
                "error": format!("Similarity search failed: {err}"),
                "results": [],
            })),
        )
            .into_response(),
    }
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
    let memory_id = id.trim().to_string();
    if memory_id.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "memory id is required"})),
        )
            .into_response();
    }
    let limit = params.limit.unwrap_or(200).min(1000);
    let missing_memory_id = memory_id.clone();

    let result = state
        .pool
        .read(move |conn| {
            // Check existence
            let exists: bool = conn
                .prepare_cached("SELECT id FROM memories WHERE id = ?1")?
                .exists(rusqlite::params![memory_id])?;
            if !exists {
                return Ok(None);
            }

            let mut stmt = conn.prepare_cached(
                "SELECT id, event, old_content, new_content, changed_by, reason,
                        metadata, created_at, actor_type, session_id, request_id
                 FROM memory_history
                 WHERE memory_id = ?1
                 ORDER BY created_at ASC
                 LIMIT ?2",
            )?;
            let rows: Vec<serde_json::Value> = stmt
                .query_map(rusqlite::params![memory_id, limit], |row| {
                    let metadata_raw = row.get::<_, Option<String>>(6)?;
                    let metadata = metadata_raw
                        .as_deref()
                        .map(|raw| {
                            serde_json::from_str::<Value>(raw)
                                .unwrap_or_else(|_| Value::String(raw.to_string()))
                        })
                        .unwrap_or(Value::Null);
                    let mut item = serde_json::Map::new();
                    item.insert(
                        "id".to_string(),
                        serde_json::json!(row.get::<_, String>(0)?),
                    );
                    item.insert(
                        "event".to_string(),
                        serde_json::json!(row.get::<_, String>(1)?),
                    );
                    item.insert(
                        "oldContent".to_string(),
                        serde_json::json!(row.get::<_, Option<String>>(2)?),
                    );
                    item.insert(
                        "newContent".to_string(),
                        serde_json::json!(row.get::<_, Option<String>>(3)?),
                    );
                    item.insert(
                        "changedBy".to_string(),
                        serde_json::json!(row.get::<_, String>(4)?),
                    );
                    item.insert(
                        "reason".to_string(),
                        serde_json::json!(row.get::<_, Option<String>>(5)?),
                    );
                    item.insert("metadata".to_string(), metadata);
                    item.insert(
                        "createdAt".to_string(),
                        serde_json::json!(row.get::<_, String>(7)?),
                    );
                    if let Some(actor_type) = row.get::<_, Option<String>>(8)? {
                        item.insert("actorType".to_string(), serde_json::json!(actor_type));
                    }
                    if let Some(session_id) = row.get::<_, Option<String>>(9)? {
                        item.insert("sessionId".to_string(), serde_json::json!(session_id));
                    }
                    if let Some(request_id) = row.get::<_, Option<String>>(10)? {
                        item.insert("requestId".to_string(), serde_json::json!(request_id));
                    }
                    Ok(Value::Object(item))
                })?
                .filter_map(|r| r.ok())
                .collect();
            let count = rows.len();

            Ok(Some(serde_json::json!({
                "memoryId": memory_id,
                "count": count,
                "history": rows,
            })))
        })
        .await
        .unwrap_or(None);

    match result {
        Some(val) => (StatusCode::OK, Json(val)).into_response(),
        None => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"error": "Not found", "memoryId": missing_memory_id})),
        )
            .into_response(),
    }
}

/// GET /api/memory/review-queue
pub async fn review_queue(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let result = state
        .pool
        .read(|conn| {
            let mut stmt = conn.prepare_cached(
                "SELECT h.id, h.memory_id, h.event, h.old_content, h.new_content,
                        h.reason, h.metadata, h.created_at, h.session_id,
                        m.content AS current_content, m.type AS memory_type,
                        m.importance
                 FROM memory_history h
                 LEFT JOIN memories m ON m.id = h.memory_id
                 WHERE h.event IN ('DEDUP', 'REVIEW_NEEDED', 'BLOCKED_DESTRUCTIVE')
                   AND h.created_at > datetime('now', '-30 days')
                 ORDER BY h.created_at DESC
                 LIMIT 200",
            )?;
            let items = stmt
                .query_map([], |row| {
                    Ok(serde_json::json!({
                        "id": row.get::<_, String>(0)?,
                        "memory_id": row.get::<_, String>(1)?,
                        "event": row.get::<_, String>(2)?,
                        "old_content": row.get::<_, Option<String>>(3)?,
                        "new_content": row.get::<_, Option<String>>(4)?,
                        "reason": row.get::<_, Option<String>>(5)?,
                        "metadata": row.get::<_, Option<String>>(6)?,
                        "created_at": row.get::<_, String>(7)?,
                        "session_id": row.get::<_, Option<String>>(8)?,
                        "current_content": row.get::<_, Option<String>>(9)?,
                        "memory_type": row.get::<_, Option<String>>(10)?,
                        "importance": row.get::<_, Option<f64>>(11)?,
                    }))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(serde_json::json!({"items": items}))
        })
        .await;

    match result {
        Ok(body) => (StatusCode::OK, Json(body)),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": format!("{e}"), "items": []})),
        ),
    }
}

/// GET /api/memory/jobs/:id
pub async fn job(State(state): State<Arc<AppState>>, Path(id): Path<String>) -> impl IntoResponse {
    let id = id.trim().to_string();
    if id.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "job id is required"})),
        );
    }

    let result = state
        .pool
        .read(move |conn| {
            conn.query_row(
                "SELECT id, memory_id, document_id, job_type, status,
                        attempts, max_attempts, leased_at, completed_at,
                        failed_at, error, created_at, updated_at
                 FROM memory_jobs
                 WHERE id = ?1
                 LIMIT 1",
                rusqlite::params![id],
                |row| {
                    Ok(serde_json::json!({
                        "id": row.get::<_, String>(0)?,
                        "memory_id": row.get::<_, Option<String>>(1)?,
                        "document_id": row.get::<_, Option<String>>(2)?,
                        "job_type": row.get::<_, String>(3)?,
                        "status": row.get::<_, String>(4)?,
                        "attempt_count": row.get::<_, i64>(5)?,
                        "attempts": row.get::<_, i64>(5)?,
                        "max_attempts": row.get::<_, i64>(6)?,
                        "next_attempt_at": serde_json::Value::Null,
                        "last_error": row.get::<_, Option<String>>(10)?,
                        "last_error_code": serde_json::Value::Null,
                        "error": row.get::<_, Option<String>>(10)?,
                        "leased_at": row.get::<_, Option<String>>(7)?,
                        "completed_at": row.get::<_, Option<String>>(8)?,
                        "failed_at": row.get::<_, Option<String>>(9)?,
                        "created_at": row.get::<_, String>(11)?,
                        "updated_at": row.get::<_, String>(12)?,
                    }))
                },
            )
            .map_err(signet_core::CoreError::from)
        })
        .await;

    match result {
        Ok(body) => (StatusCode::OK, Json(body)),
        Err(signet_core::CoreError::Db(rusqlite::Error::QueryReturnedNoRows)) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"error": "Job not found"})),
        ),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": format!("{e}")})),
        ),
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

    let Some(feedback_vec) = parse_scores(Some(raw)) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "Invalid feedback format — expected map of ID to number (-1 to 1)"})),
        )
            .into_response();
    };

    let feedback = feedback_vec.into_iter().collect::<HashMap<_, _>>();
    let session = session.to_string();
    let agent_id = obj
        .get("agentId")
        .and_then(Value::as_str)
        .or_else(|| obj.get("agent_id").and_then(Value::as_str))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("default")
        .to_string();
    let path_by_id = parse_feedback_path_map(obj.get("paths"));
    let reward_by_id = parse_feedback_reward_map(obj.get("rewards"));
    let recorded = feedback.len() as i64;
    let updated = state
        .pool
        .write(Priority::High, move |conn| {
            Ok(record_path_feedback(
                conn,
                &session,
                &agent_id,
                &feedback,
                &path_by_id,
                &reward_by_id,
            )?)
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
                    "rejected": (recorded - accepted).max(0),
                    "propagated": val.get("propagated").and_then(Value::as_i64).unwrap_or(0),
                    "cooccurrenceUpdated": val.get("cooccurrenceUpdated").and_then(Value::as_i64).unwrap_or(0),
                    "dependenciesUpdated": val.get("dependenciesUpdated").and_then(Value::as_i64).unwrap_or(0),
                    "acceptanceRule": "accepted means the memory id was recorded for this session and agent"
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

#[derive(Clone, Debug)]
struct FeedbackPath {
    entity_ids: Vec<String>,
    aspect_ids: Vec<String>,
    dependency_ids: Vec<String>,
}

#[derive(Clone, Debug, Default)]
struct FeedbackReward {
    forward_citation: f64,
    update_after_retrieval: f64,
    downstream_creation: f64,
    dead_end: f64,
}

struct PathFeedbackConfig {
    aspect_delta: f64,
    edge_delta: f64,
    confidence_delta: f64,
    q_alpha: f64,
    min_edge_strength: f64,
    min_confidence: f64,
    npmi_threshold: f64,
    min_co_sessions: i64,
    auto_edge_cap: i64,
    max_aspect_weight: f64,
    min_aspect_weight: f64,
}

impl Default for PathFeedbackConfig {
    fn default() -> Self {
        Self {
            aspect_delta: 0.02,
            edge_delta: 0.04,
            confidence_delta: 0.05,
            q_alpha: 0.1,
            min_edge_strength: 0.1,
            min_confidence: 0.2,
            npmi_threshold: 0.15,
            min_co_sessions: 3,
            auto_edge_cap: 20,
            max_aspect_weight: 1.0,
            min_aspect_weight: 0.1,
        }
    }
}

fn parse_feedback_path_map(raw: Option<&Value>) -> HashMap<String, FeedbackPath> {
    let Some(obj) = raw.and_then(Value::as_object) else {
        return HashMap::new();
    };
    obj.iter()
        .filter_map(|(id, value)| normalize_feedback_path(value).map(|path| (id.clone(), path)))
        .collect()
}

fn parse_feedback_reward_map(raw: Option<&Value>) -> HashMap<String, FeedbackReward> {
    let Some(obj) = raw.and_then(Value::as_object) else {
        return HashMap::new();
    };
    obj.iter()
        .map(|(id, value)| (id.clone(), normalize_feedback_reward(Some(value))))
        .collect()
}

fn normalize_feedback_path(value: &Value) -> Option<FeedbackPath> {
    let obj = value.as_object()?;
    let entity_ids = unique_string_ids(
        obj.get("entity_ids")
            .or_else(|| obj.get("entityIds"))
            .unwrap_or(&Value::Null),
    );
    let aspect_ids = unique_string_ids(
        obj.get("aspect_ids")
            .or_else(|| obj.get("aspectIds"))
            .unwrap_or(&Value::Null),
    );
    let dependency_ids = unique_string_ids(
        obj.get("dependency_ids")
            .or_else(|| obj.get("dependencyIds"))
            .unwrap_or(&Value::Null),
    );
    if entity_ids.is_empty() && aspect_ids.is_empty() && dependency_ids.is_empty() {
        return None;
    }
    Some(FeedbackPath {
        entity_ids,
        aspect_ids,
        dependency_ids,
    })
}

fn unique_string_ids(value: &Value) -> Vec<String> {
    let Some(items) = value.as_array() else {
        return Vec::new();
    };
    let mut seen = HashSet::new();
    let mut output = Vec::new();
    for item in items {
        if let Some(id) = item.as_str().filter(|id| !id.is_empty()) {
            let id = id.to_string();
            if seen.insert(id.clone()) {
                output.push(id);
            }
        }
    }
    output
}

fn normalize_feedback_reward(value: Option<&Value>) -> FeedbackReward {
    let Some(obj) = value.and_then(Value::as_object) else {
        return FeedbackReward::default();
    };
    FeedbackReward {
        forward_citation: reward_fraction(
            obj.get("forward_citation")
                .or_else(|| obj.get("forwardCitation")),
        ),
        update_after_retrieval: reward_fraction(
            obj.get("update_after_retrieval")
                .or_else(|| obj.get("updateAfterRetrieval")),
        ),
        downstream_creation: reward_fraction(
            obj.get("downstream_creation")
                .or_else(|| obj.get("downstreamCreation")),
        ),
        dead_end: reward_fraction(obj.get("dead_end").or_else(|| obj.get("deadEnd"))),
    }
}

fn reward_fraction(value: Option<&Value>) -> f64 {
    match value {
        Some(Value::Bool(true)) => 1.0,
        Some(Value::Bool(false)) => 0.0,
        Some(Value::Number(value)) => value.as_f64().unwrap_or(0.0).clamp(0.0, 1.0),
        _ => 0.0,
    }
}

fn reward_score(reward: &FeedbackReward) -> f64 {
    reward.forward_citation + reward.update_after_retrieval * 0.5 + reward.downstream_creation * 0.6
        - reward.dead_end * 0.15
}

fn path_json(path: &FeedbackPath) -> String {
    serde_json::to_string(&serde_json::json!({
        "entity_ids": path.entity_ids,
        "aspect_ids": path.aspect_ids,
        "dependency_ids": path.dependency_ids,
    }))
    .unwrap_or_else(|_| "{}".to_string())
}

fn path_hash(path: &FeedbackPath) -> String {
    let mut digest = Sha1::new();
    digest.update(path_json(path).as_bytes());
    format!("{:x}", digest.finalize())
}

fn record_path_feedback(
    conn: &rusqlite::Connection,
    session_key: &str,
    agent_id: &str,
    ratings: &HashMap<String, f64>,
    path_by_id: &HashMap<String, FeedbackPath>,
    reward_by_id: &HashMap<String, FeedbackReward>,
) -> rusqlite::Result<Value> {
    let cfg = PathFeedbackConfig::default();
    let ts = chrono::Utc::now().to_rfc3339();
    record_session_feedback(conn, session_key, agent_id, ratings)?;
    let session_data = load_feedback_session_data(conn, session_key, agent_id, ratings.keys())?;
    conn.execute(
        "INSERT OR IGNORE INTO path_feedback_sessions (agent_id, session_key, created_at)
         VALUES (?1, ?2, ?3)",
        rusqlite::params![agent_id, session_key, ts],
    )?;

    let mut accepted = 0_i64;
    let mut propagated = 0_i64;
    let mut dependencies_updated = 0_i64;
    let mut entity_set = BTreeSet::new();

    for (memory_id, rating_raw) in ratings {
        if !session_data.session_ids.contains(memory_id) {
            continue;
        }
        accepted += 1;
        let rating = rating_raw.clamp(-1.0, 1.0);
        let Some(path) = path_by_id
            .get(memory_id)
            .cloned()
            .or_else(|| session_data.paths.get(memory_id).cloned())
            .or_else(|| {
                infer_feedback_path(conn, memory_id, agent_id)
                    .ok()
                    .flatten()
            })
        else {
            continue;
        };
        let reward = reward_by_id.get(memory_id).cloned().unwrap_or_default();
        let score = reward_score(&reward);
        let hash = path_hash(&path);
        let path_json = path_json(&path);
        conn.execute(
            "INSERT INTO path_feedback_events
             (id, agent_id, session_key, memory_id, path_hash, path_json, rating,
              reward, reward_forward, reward_update, reward_downstream, reward_dead_end, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            rusqlite::params![
                uuid::Uuid::new_v4().to_string(),
                agent_id,
                session_key,
                memory_id,
                hash,
                path_json,
                rating,
                score,
                reward.forward_citation,
                reward.update_after_retrieval,
                reward.downstream_creation,
                reward.dead_end,
                ts,
            ],
        )?;
        upsert_path_feedback_stats(conn, agent_id, &hash, &path, rating, score, &cfg, &ts)?;
        update_feedback_aspects(conn, agent_id, &path, rating, &cfg, &ts)?;
        dependencies_updated +=
            update_feedback_dependencies(conn, agent_id, &path, rating, &cfg, &ts)?;
        propagated += 1;
        if rating > 0.0 {
            entity_set.extend(path.entity_ids.iter().cloned());
        }
    }

    let entities = entity_set.into_iter().collect::<Vec<_>>();
    if !entities.is_empty() {
        update_entity_retrieval_stats(conn, agent_id, session_key, &entities, &ts)?;
    }
    let pairs = entity_pairs(&entities);
    if !pairs.is_empty() {
        update_entity_pair_stats(conn, agent_id, session_key, &pairs, &ts)?;
    }
    let total_sessions = feedback_session_count(conn, agent_id)?;
    let mut cooccurrence_updated = 0_i64;
    for (source, target) in pairs {
        let promoted = maybe_promote_feedback_pair(
            conn,
            agent_id,
            &source,
            &target,
            total_sessions,
            &cfg,
            &ts,
        )?;
        if promoted > 0 {
            cooccurrence_updated += 1;
            dependencies_updated += promoted;
        }
    }

    Ok(serde_json::json!({
        "accepted": accepted,
        "propagated": propagated,
        "cooccurrenceUpdated": cooccurrence_updated,
        "dependenciesUpdated": dependencies_updated,
    }))
}

fn record_session_feedback(
    conn: &rusqlite::Connection,
    session_key: &str,
    agent_id: &str,
    ratings: &HashMap<String, f64>,
) -> rusqlite::Result<()> {
    let mut stmt = conn.prepare_cached(
        "UPDATE session_memories
         SET agent_relevance_score = CASE
                 WHEN agent_relevance_score IS NULL THEN ?1
                 ELSE (agent_relevance_score * agent_feedback_count + ?1) / (agent_feedback_count + 1)
             END,
             agent_feedback_count = COALESCE(agent_feedback_count, 0) + 1
         WHERE session_key = ?2 AND memory_id = ?3 AND COALESCE(agent_id, 'default') = ?4",
    )?;
    for (memory_id, score) in ratings {
        stmt.execute(rusqlite::params![score, session_key, memory_id, agent_id])?;
    }
    Ok(())
}

struct FeedbackSessionData {
    session_ids: HashSet<String>,
    paths: HashMap<String, FeedbackPath>,
}

fn load_feedback_session_data<'a>(
    conn: &rusqlite::Connection,
    session_key: &str,
    agent_id: &str,
    memory_ids: impl Iterator<Item = &'a String>,
) -> rusqlite::Result<FeedbackSessionData> {
    let ids = memory_ids.cloned().collect::<Vec<_>>();
    if ids.is_empty() {
        return Ok(FeedbackSessionData {
            session_ids: HashSet::new(),
            paths: HashMap::new(),
        });
    }
    let placeholders = std::iter::repeat_n("?", ids.len())
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "SELECT memory_id, path_json
         FROM session_memories
         WHERE session_key = ?
           AND COALESCE(agent_id, 'default') = ?
           AND memory_id IN ({placeholders})"
    );
    let mut params = vec![
        rusqlite::types::Value::Text(session_key.to_string()),
        rusqlite::types::Value::Text(agent_id.to_string()),
    ];
    params.extend(ids.iter().cloned().map(rusqlite::types::Value::Text));
    let mut stmt = conn.prepare(&sql)?;
    let mut rows = stmt.query(rusqlite::params_from_iter(params))?;
    let mut session_ids = HashSet::new();
    let mut paths = HashMap::new();
    while let Some(row) = rows.next()? {
        let memory_id: String = row.get(0)?;
        let path_json: Option<String> = row.get(1)?;
        session_ids.insert(memory_id.clone());
        if let Some(path) = path_json
            .as_deref()
            .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
            .and_then(|value| normalize_feedback_path(&value))
        {
            paths.insert(memory_id, path);
        }
    }
    Ok(FeedbackSessionData { session_ids, paths })
}

fn infer_feedback_path(
    conn: &rusqlite::Connection,
    memory_id: &str,
    agent_id: &str,
) -> rusqlite::Result<Option<FeedbackPath>> {
    let mut stmt = conn.prepare_cached(
        "SELECT asp.entity_id, ea.aspect_id
         FROM entity_attributes ea
         JOIN entity_aspects asp ON asp.id = ea.aspect_id
         WHERE ea.memory_id = ?1
           AND ea.agent_id = ?2
           AND ea.status = 'active'
         ORDER BY ea.importance DESC
         LIMIT 5",
    )?;
    let rows = stmt
        .query_map(rusqlite::params![memory_id, agent_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if rows.is_empty() {
        return Ok(None);
    }
    let entity_ids = rows
        .iter()
        .map(|(entity_id, _)| entity_id.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    let aspect_ids = rows
        .iter()
        .map(|(_, aspect_id)| aspect_id.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    Ok(Some(FeedbackPath {
        entity_ids,
        aspect_ids,
        dependency_ids: Vec::new(),
    }))
}

fn upsert_path_feedback_stats(
    conn: &rusqlite::Connection,
    agent_id: &str,
    hash: &str,
    path: &FeedbackPath,
    rating: f64,
    reward: f64,
    cfg: &PathFeedbackConfig,
    ts: &str,
) -> rusqlite::Result<()> {
    let positive = i64::from(rating > 0.0);
    let negative = i64::from(rating < 0.0);
    let neutral = i64::from(rating == 0.0);
    conn.execute(
        "INSERT INTO path_feedback_stats
         (agent_id, path_hash, path_json, q_value, sample_count,
          positive_count, negative_count, neutral_count, updated_at, created_at)
         VALUES (?1, ?2, ?3, ?4, 1, ?5, ?6, ?7, ?8, ?8)
         ON CONFLICT(agent_id, path_hash) DO UPDATE SET
          path_json = excluded.path_json,
          q_value = path_feedback_stats.q_value + (?4 - path_feedback_stats.q_value) * ?9,
          sample_count = path_feedback_stats.sample_count + 1,
          positive_count = path_feedback_stats.positive_count + ?5,
          negative_count = path_feedback_stats.negative_count + ?6,
          neutral_count = path_feedback_stats.neutral_count + ?7,
          updated_at = excluded.updated_at",
        rusqlite::params![
            agent_id,
            hash,
            path_json(path),
            reward,
            positive,
            negative,
            neutral,
            ts,
            cfg.q_alpha,
        ],
    )?;
    Ok(())
}

fn update_feedback_aspects(
    conn: &rusqlite::Connection,
    agent_id: &str,
    path: &FeedbackPath,
    rating: f64,
    cfg: &PathFeedbackConfig,
    ts: &str,
) -> rusqlite::Result<()> {
    if rating == 0.0 || path.aspect_ids.is_empty() {
        return Ok(());
    }
    let delta = cfg.aspect_delta * rating.abs() * if rating > 0.0 { 1.0 } else { -1.0 };
    let mut stmt = conn.prepare_cached(
        "UPDATE entity_aspects
         SET weight = MIN(?1, MAX(?2, weight + ?3)),
             updated_at = ?4
         WHERE id = ?5 AND agent_id = ?6",
    )?;
    for aspect_id in &path.aspect_ids {
        stmt.execute(rusqlite::params![
            cfg.max_aspect_weight,
            cfg.min_aspect_weight,
            delta,
            ts,
            aspect_id,
            agent_id,
        ])?;
    }
    Ok(())
}

fn update_feedback_dependencies(
    conn: &rusqlite::Connection,
    agent_id: &str,
    path: &FeedbackPath,
    rating: f64,
    cfg: &PathFeedbackConfig,
    ts: &str,
) -> rusqlite::Result<i64> {
    if rating == 0.0 || path.dependency_ids.is_empty() {
        return Ok(0);
    }
    let mut count = 0_i64;
    let mut select = conn.prepare_cached(
        "SELECT strength, confidence, reason
         FROM entity_dependencies
         WHERE id = ?1 AND agent_id = ?2
         LIMIT 1",
    )?;
    let mut update = conn.prepare_cached(
        "UPDATE entity_dependencies
         SET strength = ?1,
             confidence = ?2,
             reason = ?3,
             updated_at = ?4
         WHERE id = ?5 AND agent_id = ?6",
    )?;
    for dependency_id in &path.dependency_ids {
        let row = select
            .query_row(rusqlite::params![dependency_id, agent_id], |row| {
                Ok((
                    row.get::<_, f64>(0)?,
                    row.get::<_, Option<f64>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            })
            .optional()?;
        let Some((strength, confidence, reason)) = row else {
            continue;
        };
        let mag = rating.abs();
        let next_reason = next_dependency_reason(reason.as_deref(), rating);
        let base_confidence = reason_confidence(next_reason.as_deref());
        let next_strength = if rating > 0.0 {
            (strength + cfg.edge_delta * mag).clamp(cfg.min_edge_strength, 1.0)
        } else {
            (strength - cfg.edge_delta * mag).clamp(cfg.min_edge_strength, 1.0)
        };
        let current_confidence = confidence.unwrap_or(0.5);
        let next_confidence = if rating > 0.0 {
            (current_confidence + cfg.confidence_delta * mag)
                .max(base_confidence)
                .clamp(cfg.min_confidence, 1.0)
        } else {
            (current_confidence - cfg.confidence_delta * mag)
                .min(base_confidence)
                .clamp(cfg.min_confidence, 1.0)
        };
        update.execute(rusqlite::params![
            next_strength,
            next_confidence,
            next_reason,
            ts,
            dependency_id,
            agent_id,
        ])?;
        count += 1;
    }
    Ok(count)
}

fn reason_confidence(reason: Option<&str>) -> f64 {
    match reason {
        Some("user-asserted") => 1.0,
        Some("multi-memory") => 0.9,
        Some("single-memory") => 0.7,
        Some("pattern-matched") => 0.5,
        Some("inferred") => 0.4,
        Some("llm-uncertain") => 0.3,
        _ => 0.7,
    }
}

fn next_dependency_reason(reason: Option<&str>, rating: f64) -> Option<String> {
    if rating > 0.0 {
        return Some(
            match reason {
                None | Some("llm-uncertain") => "single-memory",
                Some("single-memory") => "pattern-matched",
                Some("pattern-matched") => "multi-memory",
                Some(other) => other,
            }
            .to_string(),
        );
    }
    if rating < 0.0 {
        return Some(
            match reason {
                None => "llm-uncertain",
                Some("multi-memory") => "pattern-matched",
                Some("pattern-matched") => "single-memory",
                Some("single-memory") => "llm-uncertain",
                Some(other) => other,
            }
            .to_string(),
        );
    }
    reason.map(ToOwned::to_owned)
}

fn update_entity_retrieval_stats(
    conn: &rusqlite::Connection,
    agent_id: &str,
    session_key: &str,
    entity_ids: &[String],
    ts: &str,
) -> rusqlite::Result<()> {
    let mut stmt = conn.prepare_cached(
        "INSERT INTO entity_retrieval_stats
         (agent_id, entity_id, session_count, last_session_key, updated_at, created_at)
         VALUES (?1, ?2, 1, ?3, ?4, ?4)
         ON CONFLICT(agent_id, entity_id) DO UPDATE SET
          session_count = CASE
            WHEN entity_retrieval_stats.last_session_key = excluded.last_session_key
              THEN entity_retrieval_stats.session_count
            ELSE entity_retrieval_stats.session_count + 1
          END,
          last_session_key = excluded.last_session_key,
          updated_at = excluded.updated_at",
    )?;
    for entity_id in entity_ids {
        stmt.execute(rusqlite::params![agent_id, entity_id, session_key, ts])?;
    }
    Ok(())
}

fn entity_pairs(entities: &[String]) -> Vec<(String, String)> {
    let mut pairs = Vec::new();
    for (index, source) in entities.iter().enumerate() {
        for target in entities.iter().skip(index + 1) {
            if source < target {
                pairs.push((source.clone(), target.clone()));
            } else {
                pairs.push((target.clone(), source.clone()));
            }
        }
    }
    pairs.sort();
    pairs.dedup();
    pairs
}

fn update_entity_pair_stats(
    conn: &rusqlite::Connection,
    agent_id: &str,
    session_key: &str,
    pairs: &[(String, String)],
    ts: &str,
) -> rusqlite::Result<()> {
    let mut stmt = conn.prepare_cached(
        "INSERT INTO entity_cooccurrence
         (agent_id, source_entity_id, target_entity_id, session_count, last_session_key, updated_at, created_at)
         VALUES (?1, ?2, ?3, 1, ?4, ?5, ?5)
         ON CONFLICT(agent_id, source_entity_id, target_entity_id) DO UPDATE SET
          session_count = CASE
            WHEN entity_cooccurrence.last_session_key = excluded.last_session_key
              THEN entity_cooccurrence.session_count
            ELSE entity_cooccurrence.session_count + 1
          END,
          last_session_key = excluded.last_session_key,
          updated_at = excluded.updated_at",
    )?;
    for (source, target) in pairs {
        stmt.execute(rusqlite::params![agent_id, source, target, session_key, ts])?;
    }
    Ok(())
}

fn feedback_session_count(conn: &rusqlite::Connection, agent_id: &str) -> rusqlite::Result<i64> {
    conn.query_row(
        "SELECT COUNT(*) FROM path_feedback_sessions WHERE agent_id = ?1",
        [agent_id],
        |row| row.get::<_, i64>(0),
    )
}

fn maybe_promote_feedback_pair(
    conn: &rusqlite::Connection,
    agent_id: &str,
    source: &str,
    target: &str,
    total_sessions: i64,
    cfg: &PathFeedbackConfig,
    ts: &str,
) -> rusqlite::Result<i64> {
    Ok(i64::from(maybe_promote_feedback_directed(
        conn,
        agent_id,
        source,
        target,
        source,
        target,
        total_sessions,
        cfg,
        ts,
    )?) + i64::from(maybe_promote_feedback_directed(
        conn,
        agent_id,
        source,
        target,
        target,
        source,
        total_sessions,
        cfg,
        ts,
    )?))
}

#[allow(clippy::too_many_arguments)]
fn maybe_promote_feedback_directed(
    conn: &rusqlite::Connection,
    agent_id: &str,
    pair_source: &str,
    pair_target: &str,
    edge_source: &str,
    edge_target: &str,
    total_sessions: i64,
    cfg: &PathFeedbackConfig,
    ts: &str,
) -> rusqlite::Result<bool> {
    if total_sessions <= 1 {
        return Ok(false);
    }
    let co = conn
        .query_row(
            "SELECT session_count
             FROM entity_cooccurrence
             WHERE agent_id = ?1 AND source_entity_id = ?2 AND target_entity_id = ?3",
            rusqlite::params![agent_id, pair_source, pair_target],
            |row| row.get::<_, i64>(0),
        )
        .optional()?
        .unwrap_or(0);
    let source_count = retrieval_count(conn, agent_id, edge_source)?;
    let target_count = retrieval_count(conn, agent_id, edge_target)?;
    if co < cfg.min_co_sessions || source_count == 0 || target_count == 0 {
        return Ok(false);
    }
    let pxy = co as f64 / total_sessions as f64;
    let px = source_count as f64 / total_sessions as f64;
    let py = target_count as f64 / total_sessions as f64;
    if pxy <= 0.0 || px <= 0.0 || py <= 0.0 {
        return Ok(false);
    }
    let npmi = if pxy >= 1.0 {
        1.0
    } else {
        (pxy / (px * py)).ln() / -pxy.ln()
    };
    if !npmi.is_finite() || npmi < cfg.npmi_threshold {
        return Ok(false);
    }
    let strength = (0.3 + npmi * 0.5).clamp(0.3, 0.9);
    let existing = conn
        .query_row(
            "SELECT id, strength, confidence
             FROM entity_dependencies
             WHERE agent_id = ?1
               AND source_entity_id = ?2
               AND target_entity_id = ?3
               AND dependency_type = 'related_to'
             LIMIT 1",
            rusqlite::params![agent_id, edge_source, edge_target],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, f64>(1)?,
                    row.get::<_, Option<f64>>(2)?.unwrap_or(0.5),
                ))
            },
        )
        .optional()?;
    if let Some((id, existing_strength, existing_confidence)) = existing {
        conn.execute(
            "UPDATE entity_dependencies
             SET strength = ?1,
                 confidence = ?2,
                 reason = 'pattern-matched',
                 updated_at = ?3
             WHERE id = ?4 AND agent_id = ?5",
            rusqlite::params![
                existing_strength.max(strength),
                existing_confidence.max(0.5),
                ts,
                id,
                agent_id,
            ],
        )?;
        return Ok(true);
    }
    if count_auto_feedback_edges(conn, agent_id, edge_source)? >= cfg.auto_edge_cap {
        return Ok(false);
    }
    conn.execute(
        "INSERT INTO entity_dependencies
         (id, source_entity_id, target_entity_id, agent_id, aspect_id,
          dependency_type, strength, confidence, reason, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, NULL, 'related_to', ?5, 0.5, 'pattern-matched', ?6, ?6)",
        rusqlite::params![
            uuid::Uuid::new_v4().to_string(),
            edge_source,
            edge_target,
            agent_id,
            strength,
            ts,
        ],
    )?;
    Ok(true)
}

fn retrieval_count(
    conn: &rusqlite::Connection,
    agent_id: &str,
    entity_id: &str,
) -> rusqlite::Result<i64> {
    Ok(conn
        .query_row(
            "SELECT session_count
             FROM entity_retrieval_stats
             WHERE agent_id = ?1 AND entity_id = ?2",
            rusqlite::params![agent_id, entity_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()?
        .unwrap_or(0))
}

fn count_auto_feedback_edges(
    conn: &rusqlite::Connection,
    agent_id: &str,
    source: &str,
) -> rusqlite::Result<i64> {
    conn.query_row(
        "SELECT COUNT(*)
         FROM entity_dependencies
         WHERE agent_id = ?1
           AND source_entity_id = ?2
           AND dependency_type = 'related_to'
           AND reason = 'pattern-matched'",
        rusqlite::params![agent_id, source],
        |row| row.get::<_, i64>(0),
    )
}
