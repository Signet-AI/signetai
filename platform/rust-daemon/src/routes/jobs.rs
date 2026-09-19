use axum::{extract::{Path, Query, State}, http::HeaderMap, response::sse::{Event, Sse}, Json};
use futures_util::stream::{self, Stream};
use serde::Deserialize;
use serde_json::{json, Value};
use signet_core_native::Operation;
use std::{convert::Infallible, time::Duration};
use crate::{agent, execute, ApiError, AppState};

#[derive(Deserialize)] pub struct JobRequest { pub kind: String, #[serde(default)] pub payload: Value, pub deadline_at: Option<String> }
#[derive(Deserialize)] pub struct ListQuery { pub limit: Option<usize> }

pub async fn submit(State(state): State<AppState>, headers: HeaderMap, Json(body): Json<JobRequest>) -> Result<Json<Value>, ApiError> {
    let agent_id = agent(&headers, None, None)?;
    Ok(Json(execute(&state, Operation::JobSubmit { agent_id, kind: body.kind, payload: body.payload, deadline_at: body.deadline_at }).await?))
}
pub async fn get(State(state): State<AppState>, headers: HeaderMap, Path(id): Path<String>) -> Result<Json<Value>, ApiError> {
    let agent_id = agent(&headers, None, None)?;
    Ok(Json(execute(&state, Operation::JobGet { agent_id, id }).await?))
}
pub async fn cancel(State(state): State<AppState>, headers: HeaderMap, Path(id): Path<String>) -> Result<Json<Value>, ApiError> {
    let agent_id = agent(&headers, None, None)?;
    Ok(Json(execute(&state, Operation::JobCancel { agent_id, id }).await?))
}
pub async fn list(State(state): State<AppState>, headers: HeaderMap, Query(query): Query<ListQuery>) -> Result<Json<Value>, ApiError> {
    let agent_id = agent(&headers, None, None)?;
    Ok(Json(execute(&state, Operation::JobList { agent_id, limit: query.limit.unwrap_or(50).min(100) }).await?))
}
pub async fn events(State(state): State<AppState>, headers: HeaderMap, Path(id): Path<String>) -> Result<Sse<impl Stream<Item=Result<Event, Infallible>>>, ApiError> {
    let agent_id = agent(&headers, None, None)?;
    let value = execute(&state, Operation::JobEvents { agent_id, id }).await?;
    let event = Event::default().event("snapshot").json_data(value).map_err(|e| ApiError::internal(e.to_string()))?;
    Ok(Sse::new(stream::once(async move { Ok(event) })).keep_alive(axum::response::sse::KeepAlive::new().interval(Duration::from_secs(15))))
}

// Registration (intentionally not wired into main):
// Router::new().route("/api/jobs", post(jobs::submit).get(jobs::list))
//   .route("/api/jobs/:id", get(jobs::get).delete(jobs::cancel))
//   .route("/api/jobs/:id/events", get(jobs::events))
