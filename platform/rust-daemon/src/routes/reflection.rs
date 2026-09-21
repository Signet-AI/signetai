use crate::{agent, execute, ApiError, AppState};
use axum::{
    extract::{Path, Query, State},
    http::HeaderMap,
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::Value;
use signet_core_native::Operation;
use time::OffsetDateTime;
use uuid::Uuid;

#[derive(Debug, Deserialize)]
pub(crate) struct ReflectionQuery {
    pub limit: Option<usize>,
}

#[derive(Debug, Deserialize)]
struct AnswerBody { answer: Option<String> }

fn limit(query: &ReflectionQuery) -> usize {
    query.limit.unwrap_or(30).clamp(1, 100)
}

async fn list(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<ReflectionQuery>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(
        execute(
            &state,
            Operation::ReflectionList {
                agent_id: agent(&headers, None, None)?,
                limit: limit(&query),
            },
        )
        .await?,
    ))
}

async fn today(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<ReflectionQuery>,
) -> Result<Json<Value>, ApiError> {
    let now = OffsetDateTime::now_utc();
    let date = format!(
        "{:04}-{:02}-{:02}",
        now.year(),
        u8::from(now.month()),
        now.day()
    );
    Ok(Json(
        execute(
            &state,
            Operation::ReflectionToday {
                agent_id: agent(&headers, None, None)?,
                date,
                limit: limit(&query),
            },
        )
        .await?,
    ))
}

async fn generate(State(_state): State<AppState>, _headers: HeaderMap, Query(_query): Query<ReflectionQuery>) -> Result<Json<Value>, ApiError> {
    Err(ApiError::bad_request("Reflections are disabled in pipeline config"))
}

async fn answer(State(state): State<AppState>, headers: HeaderMap, Path(id): Path<String>, body: Result<Json<AnswerBody>, axum::extract::rejection::JsonRejection>) -> Result<Json<Value>, ApiError> {
    let Json(body) = body.map_err(|_| ApiError::bad_request("Invalid JSON body"))?;
    let answer = body.answer.ok_or_else(|| ApiError::bad_request("answer is required"))?;
    if answer.trim().is_empty() { return Err(ApiError::bad_request("answer is required")); }
    if answer.trim().chars().count() > 10_000 { return Err(ApiError::bad_request("answer exceeds 10000 characters")); }
    Ok(Json(execute(&state, Operation::ReflectionAnswer { agent_id: agent(&headers, None, None)?, id, answer, memory_id: Uuid::new_v4().to_string(), answered_at: OffsetDateTime::now_utc().format(&time::format_description::well_known::Rfc3339).unwrap_or_default() }).await?))
}

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/api/reflections", get(list))
        .route("/api/reflections/today", get(today))
        .route("/api/reflections/generate", post(generate))
        .route("/api/reflections/:id/answer", post(answer))
}
