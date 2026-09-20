use super::auth;
use crate::{execute, non_empty, workspace_id, ApiError, AppState};
use axum::{
    extract::{Query, State},
    http::{HeaderMap, StatusCode},
    routing::get,
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Debug, Deserialize, Default)]
struct QueryParams {
    event: Option<String>,
    since: Option<String>,
    until: Option<String>,
    cursor: Option<i64>,
    limit: Option<usize>,
    #[serde(alias = "agent_id")]
    agent: Option<String>,
    workspace: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
struct HealthParams {
    workspace: Option<String>,
}

async fn authority(state: &AppState, headers: &HeaderMap) -> Result<Value, ApiError> {
    auth::gate(state, headers).await
}

fn check(authority: &Value, agent: &str, workspace: &str) -> Result<(), ApiError> {
    let role = authority.get("role").and_then(Value::as_str).unwrap_or("");
    let allowed = role == "admin"
        || authority
            .get("permissions")
            .and_then(Value::as_array)
            .is_some_and(|p| p.iter().any(|v| v.as_str() == Some("analytics")));
    if !allowed {
        return Err(ApiError {
            status: StatusCode::FORBIDDEN,
            code: "insufficient_capability",
            message: "analytics capability is required".into(),
        });
    }
    if let Some(scope) = authority.get("scope").and_then(Value::as_object) {
        for (key, requested) in [("agent", agent), ("workspace", workspace)] {
            if let Some(value) = scope.get(key).and_then(Value::as_str) {
                if value != requested {
                    return Err(ApiError {
                        status: StatusCode::FORBIDDEN,
                        code: "scope_forbidden",
                        message: "telemetry scope does not permit this request".into(),
                    });
                }
            }
        }
    }
    Ok(())
}

fn telemetry_workspace(headers: &HeaderMap, requested: Option<&str>) -> Result<String, ApiError> {
    let signed_header = headers
        .get("x-signet-workspace-id")
        .and_then(|value| value.to_str().ok())
        .and_then(non_empty);
    let compatibility_header = headers
        .get("x-workspace-id")
        .and_then(|value| value.to_str().ok())
        .and_then(non_empty);
    if signed_header.is_some()
        && compatibility_header.is_some()
        && signed_header != compatibility_header
    {
        return Err(ApiError::bad_request("workspace headers disagree"));
    }
    let header = signed_header.or(compatibility_header);
    let requested = requested.and_then(non_empty);
    if header.is_some() && requested.is_some() && header != requested {
        return Err(ApiError::bad_request(
            "workspace header and query parameter disagree",
        ));
    }
    Ok(workspace_id(headers, requested.as_deref()))
}

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/api/telemetry/events", get(events))
        .route("/api/telemetry/health", get(health))
        .route("/api/telemetry/stats", get(unsupported))
        .route("/api/telemetry/export", get(unsupported))
        .route("/api/telemetry/memory-search", get(unsupported))
        .route("/api/telemetry/memory-search/export", get(unsupported))
}

async fn events(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<QueryParams>,
) -> Result<Json<Value>, ApiError> {
    let authority = authority(&state, &headers).await?;
    let agent = q
        .agent
        .or_else(|| {
            authority
                .get("agentId")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .ok_or_else(|| ApiError::bad_request("agent is required"))?;
    let workspace = telemetry_workspace(&headers, q.workspace.as_deref())?;
    check(&authority, &agent, &workspace)?;
    let limit = q.limit.unwrap_or(100);
    if !(1..=10_000).contains(&limit) {
        return Err(ApiError::bad_request(
            "limit must be an integer from 1 to 10000",
        ));
    }
    let result = execute(
        &state,
        signet_core_native::Operation::TelemetryList {
            agent_id: agent,
            workspace_id: workspace,
            event: q.event,
            since: q.since,
            until: q.until,
            cursor: q.cursor,
            limit,
        },
    )
    .await?;
    let mut response = result;
    response["enabled"] = json!(true);
    Ok(Json(response))
}

async fn health(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<HealthParams>,
) -> Result<Json<Value>, ApiError> {
    let authority = authority(&state, &headers).await?;
    let agent = authority
        .get("agentId")
        .and_then(Value::as_str)
        .unwrap_or("default");
    let workspace = telemetry_workspace(&headers, q.workspace.as_deref())?;
    check(&authority, agent, &workspace)?;
    let db = execute(&state, signet_core_native::Operation::Health).await?;
    Ok(Json(
        json!({"status":"healthy","enabled":true,"workspace":workspace,"events":{"enabled":true,"delivery":"unsupported","aggregation":"unsupported","export":"unsupported","memorySearch":"unsupported"},"database":db}),
    ))
}

async fn unsupported() -> Result<(StatusCode, Json<Value>), ApiError> {
    Err(ApiError::not_implemented("telemetry capability is not implemented in fresh Rust; unsupported_marker=telemetry_provider_boundary"))
}
