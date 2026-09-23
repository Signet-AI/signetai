use crate::{agent, execute, source_workspace, ApiError, AppState};
use axum::{
    extract::{Path, State},
    http::HeaderMap,
    routing::{delete, get},
    Json, Router,
};
use serde_json::Value;
use signet_core_native::Operation;

async fn delete_source(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(source_id): Path<String>,
    payload: Option<Json<Value>>,
) -> Result<Json<Value>, ApiError> {
    let agent_id = agent(&headers, None, None)?;
    let workspace_id = source_workspace(
        &headers,
        payload
            .as_ref()
            .and_then(|Json(v)| v.get("workspaceId"))
            .and_then(Value::as_str),
    )?;
    Ok(Json(
        execute(
            &state,
            Operation::DeleteSourceWithGeneration {
                agent_id,
                workspace_id,
                source_id,
                generation: payload
                    .as_ref()
                    .and_then(|Json(v)| v.get("generation"))
                    .and_then(Value::as_i64),
            },
        )
        .await?,
    ))
}

async fn source_health(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(source_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let agent_id = agent(&headers, None, None)?;
    let workspace_id = source_workspace(&headers, None)?;
    Ok(Json(
        execute(
            &state,
            Operation::SourceHealth {
                agent_id,
                workspace_id,
                source_id,
            },
        )
        .await?,
    ))
}

async fn acquire_removal_lease(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(source_id): Path<String>,
    Json(v): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let agent_id = agent(&headers, None, None)?;
    let workspace_id = source_workspace(&headers, v.get("workspaceId").and_then(Value::as_str))?;
    Ok(Json(
        execute(
            &state,
            Operation::AcquireSourceRemovalLease {
                agent_id,
                workspace_id,
                source_id,
                generation: v.get("generation").and_then(Value::as_i64),
            },
        )
        .await?,
    ))
}

async fn finalize_removal(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(source_id): Path<String>,
    Json(v): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let agent_id = agent(&headers, None, None)?;
    let workspace_id = source_workspace(&headers, v.get("workspaceId").and_then(Value::as_str))?;
    Ok(Json(
        execute(
            &state,
            Operation::FinalizeSourceRemoval {
                agent_id,
                workspace_id,
                source_id,
                generation: v
                    .get("generation")
                    .and_then(Value::as_i64)
                    .ok_or_else(|| ApiError::bad_request("generation required"))?,
                lease_token: v
                    .get("leaseToken")
                    .and_then(Value::as_str)
                    .ok_or_else(|| ApiError::bad_request("leaseToken required"))?
                    .to_string(),
            },
        )
        .await?,
    ))
}

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/sources/{source_id}/removal-lease",
            axum::routing::post(acquire_removal_lease),
        )
        .route(
            "/api/sources/{source_id}/finalize-removal",
            axum::routing::post(finalize_removal),
        )
        .route("/api/sources/{source_id}", delete(delete_source))
        .route("/api/sources/{source_id}/health", get(source_health))
}
