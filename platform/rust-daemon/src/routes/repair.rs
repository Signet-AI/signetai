use crate::{agent, execute, ApiError, AppState};
use axum::{extract::State, http::HeaderMap, Json, Router};
use serde::Deserialize;
use serde_json::Value;
use signet_core_native::Operation;

#[derive(Deserialize)]
struct RepairRequest {
    workspace_id: Option<String>,
}

async fn requeue_running(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Result<Json<RepairRequest>, axum::extract::rejection::JsonRejection>,
) -> Result<Json<Value>, ApiError> {
    let agent_id = agent(&headers, None, None)?;
    let workspace_id = headers
        .get("x-workspace-id")
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_owned)
        .or_else(|| {
            body.ok()
                .and_then(|Json(v)| v.workspace_id)
                .filter(|v| !v.trim().is_empty())
        })
        .ok_or_else(|| ApiError::bad_request("workspaceId is required"))?;
    if workspace_id.len() > 256 {
        return Err(ApiError::bad_request("workspaceId must be 1-256 bytes"));
    }
    Ok(Json(
        execute(
            &state,
            Operation::RepairRequeueRunning {
                agent_id,
                workspace_id,
            },
        )
        .await?,
    ))
}

pub(crate) fn router() -> Router<AppState> {
    Router::new().route(
        "/api/repair/requeue-running",
        axum::routing::post(requeue_running),
    )
}
