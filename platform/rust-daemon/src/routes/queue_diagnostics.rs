use crate::{routes::auth, ApiError, AppState};
use axum::{
    extract::{RawQuery, State},
    http::{HeaderMap, StatusCode},
    routing::get,
    Json, Router,
};
use serde_json::{json, Value};
use signet_core_native::Operation;

const MAX_LIMIT: usize = 100;

fn params(raw: Option<String>) -> Result<(String, String, Option<String>, usize), ApiError> {
    let mut agent = None;
    let mut workspace = None;
    let mut cursor = None;
    let mut limit = 25usize;
    for pair in raw.unwrap_or_default().split('&').filter(|p| !p.is_empty()) {
        let (k, v) = pair
            .split_once('=')
            .ok_or_else(|| ApiError::bad_request("malformed query parameter"))?;
        match k {
            "agentId" | "agent_id" => agent = Some(v.to_owned()),
            "workspaceId" | "workspace_id" => workspace = Some(v.to_owned()),
            "cursor" => cursor = Some(v.to_owned()),
            "limit" => {
                limit = v
                    .parse()
                    .map_err(|_| ApiError::bad_request("limit must be an integer from 1 to 100"))?
            }
            _ => return Err(ApiError::bad_request("unknown queue diagnostics filter")),
        }
    }
    if !(1..=MAX_LIMIT).contains(&limit) {
        return Err(ApiError::bad_request(
            "limit must be an integer from 1 to 100",
        ));
    }
    let agent = agent
        .filter(|v| !v.is_empty())
        .ok_or_else(|| ApiError::unauthorized("agent identity is required"))?;
    let workspace = workspace
        .filter(|v| !v.is_empty())
        .ok_or_else(|| ApiError::bad_request("workspaceId is required"))?;
    if agent.len() > 256 || workspace.len() > 256 || cursor.as_ref().is_some_and(|v| v.len() > 128)
    {
        return Err(ApiError::bad_request(
            "queue diagnostics filter is oversized",
        ));
    }
    Ok((agent, workspace, cursor, limit))
}

async fn diagnostics(
    State(state): State<AppState>,
    headers: HeaderMap,
    RawQuery(raw): RawQuery,
) -> Result<Json<Value>, ApiError> {
    let claims = auth::gate(&state, &headers).await?;
    let (agent, workspace, cursor, limit) = params(raw)?;
    let scope = json!({"agent": agent, "workspace": workspace});
    if !auth::authority_allows(&claims, "admin", &scope, &["diagnostics".to_owned()]) {
        return Err(ApiError {
            status: StatusCode::FORBIDDEN,
            code: "forbidden",
            message: "admin diagnostics capability required".into(),
        });
    }
    let mut value = crate::execute(
        &state,
        Operation::QueueDiagnostics {
            agent_id: scope["agent"].as_str().unwrap().into(),
            workspace_id: scope["workspace"].as_str().unwrap().into(),
            cursor,
            limit,
        },
    )
    .await?;
    if let Value::Object(ref mut o) = value {
        o.insert("metadata".into(), json!({"implementation":"fresh-rust","source":"native WorkspaceOwner rows","unsupported":{"memory":"unsupported","summary":"unsupported","oldestDead":"unsupported","repair":"unsupported"}}));
        if let Some(admission) = o.get_mut("admission").and_then(Value::as_object_mut) {
            admission.insert("capacity".into(), json!(256));
        }
    }
    Ok(Json(value))
}

async fn repair() -> Result<Json<Value>, ApiError> {
    Err(ApiError::not_implemented(
        "queue repair is unsupported by the fresh native daemon",
    ))
}

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/api/diagnostics/queue", get(diagnostics))
        .route("/api/diagnostics/queue/repair", axum::routing::post(repair))
}
