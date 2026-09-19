use crate::{agent, execute, ApiError, AppState};
use axum::{
    extract::{Path, Query, State},
    http::HeaderMap,
    response::sse::{Event, Sse},
    routing::{get as route_get, post},
    Json, Router,
};
use futures_util::stream::{self, Stream};
use serde::Deserialize;
use serde_json::Value;
use signet_core_native::Operation;
use std::{convert::Infallible, time::Duration};

const MAX_JOB_KIND_BYTES: usize = 64;
const MAX_JOB_PAYLOAD_BYTES: usize = 1_048_576;

#[derive(Deserialize)]
pub struct JobRequest {
    pub kind: String,
    #[serde(default)]
    pub payload: Value,
    pub deadline_at: Option<String>,
}
#[derive(Deserialize)]
pub struct ListQuery {
    pub limit: Option<usize>,
}

pub async fn submit(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<JobRequest>,
) -> Result<Json<Value>, ApiError> {
    let agent_id = agent(&headers, None, None)?;
    if body.kind.trim().is_empty() || body.kind.len() > MAX_JOB_KIND_BYTES {
        return Err(ApiError::bad_request("job kind must be 1-64 bytes"));
    }
    if serde_json::to_vec(&body.payload).map_err(|_| ApiError::bad_request("invalid job payload"))?.len() > MAX_JOB_PAYLOAD_BYTES {
        return Err(ApiError::bad_request("job payload exceeds 1 MiB"));
    }
    Ok(Json(execute(
        &state,
        Operation::JobSubmit {
            agent_id,
            kind: body.kind,
            payload: body.payload,
            deadline_at: body.deadline_at,
        },
    ).await?))
}
pub async fn get(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let agent_id = agent(&headers, None, None)?;
    Ok(Json(
        execute(&state, Operation::JobGet { agent_id, id }).await?,
    ))
}
pub async fn cancel(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let agent_id = agent(&headers, None, None)?;
    Ok(Json(
        execute(&state, Operation::JobCancel { agent_id, id }).await?,
    ))
}
pub async fn list(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<ListQuery>,
) -> Result<Json<Value>, ApiError> {
    let agent_id = agent(&headers, None, None)?;
    Ok(Json(
        execute(
            &state,
            Operation::JobList {
                agent_id,
                limit: query.limit.unwrap_or(50).min(100),
            },
        )
        .await?,
    ))
}
pub async fn events(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Sse<impl Stream<Item = Result<Event, Infallible>>>, ApiError> {
    let agent_id = agent(&headers, None, None)?;
    let value = execute(&state, Operation::JobEvents { agent_id, id }).await?;
    let event = Event::default()
        .event("snapshot")
        .json_data(value)
        .map_err(|e| ApiError::internal(e.to_string()))?;
    Ok(Sse::new(stream::once(async move { Ok(event) }))
        .keep_alive(axum::response::sse::KeepAlive::new().interval(Duration::from_secs(15))))
}

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/api/jobs", post(submit).get(list))
        .route("/api/jobs/{id}", route_get(get).delete(cancel))
        .route("/api/jobs/{id}/events", route_get(events))
}

// The router above is mounted by the daemon's shared route assembly.
