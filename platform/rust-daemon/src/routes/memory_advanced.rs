use crate::{agent, execute, ApiError, AppState};
use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    routing::{get, post},
    Json, Router,
};
use serde_json::{json, Value};
use signet_core_native::Operation;
use std::collections::HashMap;

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/api/memory/feedback", post(feedback_body))
        .route("/api/memory/forget", post(forget_body))
        .route("/api/memory/modify", post(modify_body))
        .route("/api/memories/{id}/tombstone", post(tombstone))
        .route("/api/memories/{id}/supersede", post(supersede))
        .route("/api/memory/timeline", get(timeline_collection))
        .route("/api/memory/review-queue", get(review_queue))
        .route("/api/memory/{id}/lineage", get(lineage))
        .route("/api/memory/feedback/{id}", post(feedback))
        .route("/api/memory/forget/{id}", post(forget))
        .route("/api/memory/modify/{id}", post(modify))
        .route("/api/memory/tombstone/{id}", post(tombstone))
        .route("/api/memory/supersede/{id}", post(supersede))
        .route("/api/memory/timeline/{id}", get(timeline))
        .route("/api/memory/lineage/{id}", get(lineage))
        .route("/api/memory/review/{id}", get(review))
        .route("/api/memory/native-note", post(native_note))
        .route("/api/memory/semantic-search", post(semantic_search))
}
async fn dispatch(
    state: State<AppState>,
    headers: HeaderMap,
    action: &'static str,
    id: Option<String>,
    payload: Value,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let agent_id = agent(&headers, None, None)?;
    Ok((
        StatusCode::OK,
        Json(
            execute(
                &state,
                Operation::MemoryAdvanced {
                    agent_id,
                    action: action.into(),
                    id,
                    payload,
                },
            )
            .await?,
        ),
    ))
}
async fn feedback(
    State(s): State<AppState>,
    h: HeaderMap,
    Path(id): Path<String>,
    Json(p): Json<Value>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    dispatch(State(s), h, "feedback", Some(id), p).await
}
async fn forget(
    State(s): State<AppState>,
    h: HeaderMap,
    Path(id): Path<String>,
    Json(p): Json<Value>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    dispatch(State(s), h, "forget", Some(id), p).await
}
async fn modify(
    State(s): State<AppState>,
    h: HeaderMap,
    Path(id): Path<String>,
    Json(p): Json<Value>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    dispatch(State(s), h, "modify", Some(id), p).await
}
async fn tombstone(
    State(s): State<AppState>,
    h: HeaderMap,
    Path(id): Path<String>,
    Json(p): Json<Value>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    dispatch(State(s), h, "tombstone", Some(id), p).await
}
async fn supersede(
    State(s): State<AppState>,
    h: HeaderMap,
    Path(id): Path<String>,
    Json(p): Json<Value>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    dispatch(State(s), h, "supersede", Some(id), p).await
}
async fn feedback_body(
    State(s): State<AppState>,
    h: HeaderMap,
    Json(p): Json<Value>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let id = p
        .get("memoryId")
        .or_else(|| p.get("id"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    dispatch(State(s), h, "feedback", id, p).await
}
async fn forget_body(
    State(s): State<AppState>,
    h: HeaderMap,
    Json(p): Json<Value>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let id = p
        .get("memoryId")
        .or_else(|| p.get("id"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    dispatch(State(s), h, "forget", id, p).await
}
async fn modify_body(
    State(s): State<AppState>,
    h: HeaderMap,
    Json(p): Json<Value>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let id = p
        .get("memoryId")
        .or_else(|| p.get("id"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    dispatch(State(s), h, "modify", id, p).await
}
async fn timeline(
    State(s): State<AppState>,
    h: HeaderMap,
    Path(id): Path<String>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    dispatch(State(s), h, "timeline", Some(id), json!({})).await
}
async fn lineage(
    State(s): State<AppState>,
    h: HeaderMap,
    Path(id): Path<String>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    dispatch(State(s), h, "lineage", Some(id), json!({})).await
}
async fn review(
    State(s): State<AppState>,
    h: HeaderMap,
    Path(id): Path<String>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    dispatch(State(s), h, "review", Some(id), json!({})).await
}
async fn timeline_collection(
    State(s): State<AppState>,
    h: HeaderMap,
    Query(q): Query<HashMap<String, String>>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    dispatch(
        State(s),
        h,
        "timeline",
        q.get("memoryId").or_else(|| q.get("id")).cloned(),
        json!({}),
    )
    .await
}
async fn review_queue(
    State(s): State<AppState>,
    h: HeaderMap,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    dispatch(State(s), h, "review-queue", None, json!({})).await
}
async fn native_note(
    State(s): State<AppState>,
    h: HeaderMap,
    Json(p): Json<Value>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    dispatch(State(s), h, "native-note", None, p).await
}

async fn semantic_search(
    State(s): State<AppState>,
    h: HeaderMap,
    Json(p): Json<Value>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let query = p
        .get("query")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| ApiError::bad_request("query must not be empty"))?;
    if query.len() > 512 {
        return Err(ApiError::bad_request(
            "query must be at most 512 characters",
        ));
    }
    let limit = match p.get("limit") {
        None => 10,
        Some(value) => value
            .as_u64()
            .filter(|value| (1..=100).contains(value))
            .map(|value| value as usize)
            .ok_or_else(|| ApiError::bad_request("limit must be an integer from 1 to 100"))?,
    };
    let agent_id = agent(&h, None, None)?;
    let result = execute(
        &s,
        Operation::MemorySearch {
            agent_id,
            query: query.to_owned(),
            limit,
        },
    )
    .await?;
    Ok((StatusCode::OK, Json(result)))
}
