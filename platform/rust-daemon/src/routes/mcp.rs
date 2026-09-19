use crate::{ApiError, AppState};
use axum::{extract::State, routing::get, Json, Router};
use serde_json::{json, Value};
use std::env;

/// Bounded native MCP boundary: reports readiness and never starts a JS or
/// legacy process. Native stdio transport is intentionally not implied here.
pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/api/mcp/status", get(status))
        .route("/api/mcp/ready", get(ready))
}

async fn status() -> Json<Value> {
    let configured = env::var("SIGNET_MCP_BRIDGE_URL")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .is_some();
    Json(
        json!({"transport":"http-probe", "configured":configured, "native":true, "supported":configured, "js_runtime_required":false}),
    )
}

async fn ready(State(_state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let configured = env::var("SIGNET_MCP_BRIDGE_URL")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .is_some();
    if !configured {
        return Err(ApiError::bad_request("MCP bridge is not configured"));
    }
    Ok(Json(
        json!({"ready":true, "transport":"http-probe", "js_runtime_required":false}),
    ))
}
