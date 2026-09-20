use crate::{agent, execute, ApiError, AppState};
use axum::{extract::State, http::HeaderMap, Json, Router};
use serde::Deserialize;
use serde_json::Value;
use signet_core_native::Operation;

#[derive(Deserialize)]
struct IntegrityRequest {
    #[serde(alias = "workspaceId")]
    workspace_id: Option<String>,
    #[serde(alias = "projectId")]
    project_id: Option<String>,
    visibility: Option<String>,
    budget: Option<usize>,
}

async fn verify_integrity(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Result<Json<IntegrityRequest>, axum::extract::rejection::JsonRejection>,
) -> Result<Json<Value>, ApiError> {
    let agent_id = agent(&headers, None, None)?;
    let Json(body) = body.map_err(|_| ApiError::bad_request("invalid integrity request"))?;
    let workspace_id = body
        .workspace_id
        .filter(|v| !v.trim().is_empty())
        .ok_or_else(|| ApiError::bad_request("workspaceId is required"))?;
    let visibility = body.visibility.unwrap_or_else(|| "private".into());
    if visibility != "private" && visibility != "shared" {
        return Err(ApiError::bad_request(
            "visibility must be private or shared",
        ));
    }
    if let Some(project) = &body.project_id {
        if project.len() > 256 {
            return Err(ApiError::bad_request("projectId is too long"));
        }
    }
    Ok(Json(
        execute(
            &state,
            Operation::IntegrityVerify {
                agent_id,
                workspace_id,
                project_id: body.project_id,
                visibility,
                budget: body.budget.unwrap_or(8),
            },
        )
        .await?,
    ))
}

#[derive(Deserialize)]
struct RepairRequest {
    #[serde(alias = "workspaceId")]
    workspace_id: Option<String>,
}

fn workspace_id(
    headers: &HeaderMap,
    body: Result<Json<RepairRequest>, axum::extract::rejection::JsonRejection>,
) -> Result<String, ApiError> {
    let header_values = ["x-workspace-id", "x-signet-workspace-id"]
        .iter()
        .filter_map(|name| headers.get(*name))
        .map(|value| value.to_str().map(str::trim))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| ApiError::bad_request("workspace header must be valid UTF-8"))?;
    if header_values.windows(2).any(|pair| pair[0] != pair[1]) {
        return Err(ApiError::bad_request("conflicting workspace aliases"));
    }
    let header = header_values
        .first()
        .copied()
        .filter(|value| !value.is_empty());
    let body = body
        .ok()
        .and_then(|Json(value)| value.workspace_id)
        .filter(|value| !value.trim().is_empty());
    if header.is_some() && body.is_some() && header != body.as_deref().map(str::trim) {
        return Err(ApiError::bad_request("conflicting workspace scope"));
    }
    header
        .map(str::to_owned)
        .or_else(|| body.map(|value| value.trim().to_owned()))
        .ok_or_else(|| ApiError::bad_request("workspaceId is required"))
}

async fn requeue_running(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Result<Json<RepairRequest>, axum::extract::rejection::JsonRejection>,
) -> Result<Json<Value>, ApiError> {
    let agent_id = agent(&headers, None, None)?;
    let workspace_id = workspace_id(&headers, body)?;
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
    Router::new()
        .route(
            "/api/repair/verify-integrity",
            axum::routing::post(verify_integrity),
        )
        .route(
            "/api/repair/requeue-running",
            axum::routing::post(requeue_running),
        )
}
