//! Daily reflection dashboard routes.

use std::sync::Arc;

use axum::{
    Json,
    extract::{Path, Query, State},
    http::StatusCode,
    response::IntoResponse,
};
use serde::Deserialize;
use serde_json::Value as JsonValue;
use signet_core::db::Priority;
use signet_core::error::CoreError;
use signet_core::queries::memory;
use signet_services::normalize::normalize_and_hash;

use crate::state::AppState;

const DEFAULT_REFLECTION_LIMIT: i64 = 30;
const MAX_REFLECTION_LIMIT: i64 = 100;
const MAX_REFLECTION_ANSWER_CHARS: usize = 10_000;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReflectionQuery {
    pub agent_id: Option<String>,
    pub limit: Option<i64>,
    pub count: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct ReflectionAnswerBody {
    pub answer: Option<String>,
}

fn reflection_limit(limit: Option<i64>) -> i64 {
    match limit {
        Some(limit) if limit > 0 => limit.min(MAX_REFLECTION_LIMIT),
        _ => DEFAULT_REFLECTION_LIMIT,
    }
}

fn generate_count(count: Option<i64>) -> i64 {
    match count {
        Some(count) if count > 0 => count.min(6),
        _ => 1,
    }
}

fn table_missing(error: &signet_core::CoreError) -> bool {
    error
        .to_string()
        .contains("no such table: daily_reflections")
}

fn parse_json_array(raw: Option<String>) -> serde_json::Value {
    raw.and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .filter(|value| value.is_array())
        .unwrap_or_else(|| serde_json::json!([]))
}

fn reflection_from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<serde_json::Value> {
    let id: String = r.get(0)?;
    let date: String = r.get(1)?;
    let summary: String = r.get(2)?;
    let patterns: Option<String> = r.get(3)?;
    let question: Option<String> = r.get(4)?;
    let answer: Option<String> = r.get(5)?;
    let answer_memory_id: Option<String> = r.get(6)?;
    let created_at: String = r.get(7)?;
    let answered_at: Option<String> = r.get(8)?;

    Ok(serde_json::json!({
        "id": id,
        "date": date,
        "summary": summary,
        "patterns": parse_json_array(patterns),
        "question": question,
        "answer": answer,
        "answerMemoryId": answer_memory_id,
        "createdAt": created_at,
        "answeredAt": answered_at,
    }))
}

/// GET /api/reflections/today
pub async fn today(
    State(state): State<Arc<AppState>>,
    Query(query): Query<ReflectionQuery>,
) -> impl IntoResponse {
    let agent_id = query.agent_id.unwrap_or_else(|| "default".into());
    let limit = reflection_limit(query.limit);
    let date = chrono::Utc::now().format("%Y-%m-%d").to_string();
    let result = state
        .pool
        .read(move |conn| {
            let mut stmt = conn.prepare(
                "SELECT id, date, summary, patterns, question, answer,
                        answer_memory_id, created_at, answered_at
                 FROM daily_reflections
                 WHERE agent_id = ?1 AND date = ?2
                 ORDER BY created_at DESC
                 LIMIT ?3",
            )?;
            let reflections = stmt
                .query_map(
                    rusqlite::params![agent_id, date, limit],
                    reflection_from_row,
                )?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            let reflection = reflections
                .first()
                .cloned()
                .unwrap_or(serde_json::Value::Null);
            Ok(serde_json::json!({
                "reflection": reflection,
                "reflections": reflections,
            }))
        })
        .await;

    match result {
        Ok(body) => (StatusCode::OK, Json(body)),
        Err(e) if table_missing(&e) => (
            StatusCode::OK,
            Json(serde_json::json!({"reflection": null, "reflections": []})),
        ),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": format!("{e}")})),
        ),
    }
}

/// GET /api/reflections
pub async fn list(
    State(state): State<Arc<AppState>>,
    Query(query): Query<ReflectionQuery>,
) -> impl IntoResponse {
    let agent_id = query.agent_id.unwrap_or_else(|| "default".into());
    let limit = reflection_limit(query.limit);
    let result = state
        .pool
        .read(move |conn| {
            let mut stmt = conn.prepare(
                "SELECT id, date, summary, patterns, question, answer,
                        answer_memory_id, created_at, answered_at
                 FROM daily_reflections
                 WHERE agent_id = ?1
                 ORDER BY created_at DESC
                 LIMIT ?2",
            )?;
            let reflections = stmt
                .query_map(rusqlite::params![agent_id, limit], reflection_from_row)?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(serde_json::json!({"reflections": reflections}))
        })
        .await;

    match result {
        Ok(body) => (StatusCode::OK, Json(body)),
        Err(e) if table_missing(&e) => {
            (StatusCode::OK, Json(serde_json::json!({"reflections": []})))
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": format!("{e}")})),
        ),
    }
}

/// POST /api/reflections/generate
pub async fn generate(
    Query(query): Query<ReflectionQuery>,
) -> (StatusCode, Json<serde_json::Value>) {
    let _count = generate_count(query.count);
    (
        StatusCode::BAD_REQUEST,
        Json(serde_json::json!({"error": "Reflections are disabled in pipeline config"})),
    )
}

/// POST /api/reflections/:id/answer
pub async fn answer(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Query(query): Query<ReflectionQuery>,
    Json(body): Json<ReflectionAnswerBody>,
) -> impl IntoResponse {
    let Some(answer) = body.answer.map(|answer| answer.trim().to_string()) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "answer is required"})),
        );
    };
    if answer.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "answer is required"})),
        );
    }
    if answer.len() > MAX_REFLECTION_ANSWER_CHARS {
        return (
            StatusCode::PAYLOAD_TOO_LARGE,
            Json(serde_json::json!({"error": "answer exceeds 10000 characters"})),
        );
    }

    let agent_id = query.agent_id.unwrap_or_else(|| "default".into());
    let result = state
        .pool
        .write_tx(
            Priority::High,
            move |conn| -> Result<JsonValue, CoreError> {
                let existing = conn
                    .query_row(
                        "SELECT answer FROM daily_reflections WHERE id = ?1 AND agent_id = ?2",
                        rusqlite::params![id, agent_id],
                        |r| r.get::<_, Option<String>>(0),
                    )
                    .map_err(CoreError::from)?;
                if existing.is_some() {
                    return Err(CoreError::Conflict("Already answered".into()));
                }

                let now = chrono::Utc::now().to_rfc3339();
                let memory_id = uuid::Uuid::new_v4().to_string();
                let content_hash = format!("reflection-a-{id}");
                let normalized = normalize_and_hash(&answer);
                memory::insert(
                    conn,
                    &memory::InsertMemory {
                        id: &memory_id,
                        content: &normalized.storage,
                        normalized_content: &normalized.normalized,
                        content_hash: &content_hash,
                        memory_type: "reflection",
                        tags: "reflection,answered",
                        who: Some(&agent_id),
                        why: Some("daily-reflection-answer"),
                        project: None,
                        importance: 0.6,
                        pinned: false,
                        extraction_status: "none",
                        embedding_model: None,
                        extraction_model: None,
                        source_type: Some("reflection-answer"),
                        source_id: Some(&id),
                        source_path: None,
                        idempotency_key: None,
                        runtime_path: None,
                        now: &now,
                        updated_by: "reflections",
                        agent_id: &agent_id,
                        visibility: "global",
                        scope: None,
                    },
                )?;
                let history_id = uuid::Uuid::new_v4().to_string();
                memory::insert_history(
                    conn,
                    &memory::InsertHistory {
                        id: &history_id,
                        memory_id: &memory_id,
                        event: "created",
                        old_content: None,
                        new_content: Some(&normalized.storage),
                        changed_by: "reflections",
                        reason: Some("daily-reflection-answer"),
                        metadata: None,
                        now: &now,
                        actor_type: Some("reflection-answer"),
                        session_id: None,
                        request_id: None,
                    },
                )?;
                let changed = conn.execute(
                    "UPDATE daily_reflections
                 SET answer = ?1, answer_memory_id = ?2, answered_at = ?3
                 WHERE id = ?4 AND agent_id = ?5 AND answer IS NULL",
                    rusqlite::params![answer, memory_id, now, id, agent_id],
                )?;
                if changed == 0 {
                    return Err(CoreError::Conflict("Already answered".into()));
                }

                Ok(serde_json::json!({
                    "success": true,
                    "memoryId": memory_id,
                }))
            },
        )
        .await;

    match result {
        Ok(body) => (StatusCode::OK, Json(body)),
        Err(CoreError::Conflict(_)) => (
            StatusCode::CONFLICT,
            Json(serde_json::json!({"error": "Already answered"})),
        ),
        Err(e)
            if table_missing(&e)
                || matches!(e, CoreError::Db(rusqlite::Error::QueryReturnedNoRows)) =>
        {
            (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({"error": "Reflection not found"})),
            )
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": format!("{e}")})),
        ),
    }
}
