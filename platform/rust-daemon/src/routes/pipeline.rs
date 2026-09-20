use crate::{agent, execute, ApiError, AppState};
use axum::{
    extract::State,
    http::HeaderMap,
    routing::{get, post},
    Json, Router,
};
use serde_json::{json, Value};
use signet_core_native::Operation;

pub(crate) async fn pipeline_status(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(
        execute(
            &state,
            Operation::PipelineStatus {
                agent_id: agent(&headers, None, None)?,
            },
        )
        .await?,
    ))
}
pub(crate) async fn dream_status(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(
        execute(
            &state,
            Operation::DreamStatus {
                agent_id: agent(&headers, None, None)?,
            },
        )
        .await?,
    ))
}
pub(crate) async fn active_passes(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(
        execute(
            &state,
            Operation::DreamActivePasses {
                agent_id: agent(&headers, None, None)?,
            },
        )
        .await?,
    ))
}
pub(crate) async fn pause(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(
        execute(
            &state,
            Operation::PipelineSetPaused {
                agent_id: agent(&headers, None, None)?,
                paused: true,
            },
        )
        .await?,
    ))
}
pub(crate) async fn resume(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(
        execute(
            &state,
            Operation::PipelineSetPaused {
                agent_id: agent(&headers, None, None)?,
                paused: false,
            },
        )
        .await?,
    ))
}
pub(crate) async fn trigger(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Option<Json<Value>>,
) -> Result<Json<Value>, ApiError> {
    let payload = body.map(|Json(value)| value).unwrap_or_else(|| json!({}));
    let workspace_id = headers
        .get("x-workspace-id")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("default")
        .to_owned();
    if serde_json::to_vec(&payload)
        .map_err(|_| ApiError::bad_request("invalid payload"))?
        .len()
        > 65_536
    {
        return Err(ApiError::bad_request("payload exceeds 64 KiB"));
    }
    Ok(Json(
        execute(
            &state,
            Operation::DreamTrigger {
                agent_id: agent(&headers, None, None)?,
                workspace_id,
                payload,
            },
        )
        .await?,
    ))
}
async fn unsupported_models() -> Result<Json<Value>, ApiError> {
    Err(ApiError::not_implemented(
        "pipeline model registry is unsupported by the fresh native operation boundary",
    ))
}

async fn unsupported_dreaming() -> Result<Json<Value>, ApiError> {
    Err(ApiError::not_implemented(
        "Dreaming orchestration is unsupported by the fresh native operation boundary",
    ))
}

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/api/pipeline/status", get(pipeline_status))
        .route("/api/pipeline/pause", post(pause))
        .route("/api/pipeline/resume", post(resume))
        .route("/api/pipeline/models", get(unsupported_models))
        .route("/api/pipeline/models/by-provider", get(unsupported_models))
        .route("/api/pipeline/models/refresh", post(unsupported_models))
        .route("/api/dream/status", get(dream_status))
        .route("/api/dream/passes/active", get(active_passes))
        .route(
            "/api/dream/passes/{pass_id}/events",
            get(unsupported_dreaming),
        )
        .route(
            "/api/dream/passes/{pass_id}/tools",
            get(unsupported_dreaming),
        )
        .route("/api/dream/quality", get(unsupported_dreaming))
        .route("/api/dream/exclusions/requeue", post(unsupported_dreaming))
        .route("/api/dream/operations", post(unsupported_dreaming))
        .route("/api/dream/tools", get(unsupported_dreaming))
        .route("/api/dream/tools/{capability}", post(unsupported_dreaming))
        .route("/api/dream/trigger", post(trigger))
}
