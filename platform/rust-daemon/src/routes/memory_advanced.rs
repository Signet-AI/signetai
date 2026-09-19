use crate::{agent, execute, ApiError, AppState};
use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    routing::{get, post},
    Json, Router,
};
use serde_json::{json, Value};
use signet_core_native::Operation;

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/api/memory/feedback/{id}", post(feedback))
        .route("/api/memory/forget/{id}", post(forget))
        .route("/api/memory/modify/{id}", post(modify))
        .route("/api/memory/tombstone/{id}", post(tombstone))
        .route("/api/memory/supersede/{id}", post(supersede))
        .route("/api/memory/timeline/{id}", get(timeline))
        .route("/api/memory/lineage/{id}", get(lineage))
        .route("/api/memory/review/{id}", get(review))
        .route("/api/memory/native-note", post(native_note))
}

async fn dispatch(
    state: State<AppState>,
    headers: HeaderMap,
    action: &'static str,
    id: Option<String>,
    payload: Value,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let agent_id = agent(&headers, None, None)?;
    let result = execute(
        &state,
        Operation::MemoryAdvanced {
            agent_id,
            action: action.into(),
            id,
            payload,
        },
    )
    .await?;
    Ok((StatusCode::OK, Json(result)))
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
async fn native_note(
    State(s): State<AppState>,
    h: HeaderMap,
    Json(p): Json<Value>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    dispatch(State(s), h, "native-note", None, p).await
}
