use crate::{agent, execute, ApiError, AppState};
use axum::{
    extract::{DefaultBodyLimit, State},
    http::{HeaderMap, StatusCode},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use signet_core_native::Operation;
use std::env;
use std::time::Duration;
use tokio::net::TcpStream;
use tokio::time::timeout;

/// Bounded native MCP boundary: reports readiness and never starts a JS or
/// legacy process. Native stdio transport is intentionally not implied here.
pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/api/mcp/status", get(status))
        .route("/api/mcp/ready", get(ready))
        .route("/api/mcp/capabilities", get(capabilities))
        .route("/api/mcp/servers", get(unsupported_management))
        .route("/api/mcp/servers/{server}", get(unsupported_management))
        .route("/api/mcp/search", get(unsupported_management))
        .route("/api/mcp/policy", get(unsupported_management))
        .route("/api/mcp/call", post(unsupported_management))
        .route("/api/mcp/analytics", get(analytics_unsupported))
        .route("/api/mcp/analytics/{server}", get(analytics_unsupported))
        .route("/api/mcp", post(rpc))
        .layer(DefaultBodyLimit::max(256 * 1024))
}

async fn analytics_unsupported(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    crate::routes::auth::gate(&state, &headers).await?;
    Ok(unsupported("analytics"))
}

async fn unsupported_management(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    crate::routes::auth::gate(&state, &headers).await?;
    Ok(unsupported("management"))
}

fn unsupported(surface: &str) -> (StatusCode, Json<Value>) {
    (
        StatusCode::NOT_IMPLEMENTED,
        Json(json!({
            "error": "unsupported",
            "operation": format!("mcp {surface}"),
            "supported": false,
            "reason": "not represented by native Operations",
        })),
    )
}

async fn capabilities() -> Json<Value> {
    Json(json!({
        "transport": "streamable-http",
        "native": true,
        "stdio": {"supported": false, "provider_execution": false},
        "management": {"supported": false, "reason": "not represented by native Operations"},
        "analytics": {"supported": false, "reason": "not represented by native Operations"},
    }))
}

#[derive(Debug, Deserialize)]
struct RpcRequest {
    jsonrpc: String,
    id: Option<Value>,
    method: String,
    #[serde(default)]
    params: Value,
}

fn rpc_error(id: Option<Value>, code: i64, message: &str) -> Json<Value> {
    Json(json!({"jsonrpc":"2.0", "id": id, "error": {"code": code, "message": message}}))
}

async fn rpc(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Result<Json<RpcRequest>, axum::extract::rejection::JsonRejection>,
) -> Json<Value> {
    let request = match body {
        Ok(Json(request)) => request,
        Err(_) => return rpc_error(None, -32700, "Parse error"),
    };
    if request.jsonrpc != "2.0" || request.id.is_none() {
        return rpc_error(request.id, -32600, "Invalid Request");
    }
    let id = request.id.clone();
    match request.method.as_str() {
        "initialize" => Json(
            json!({"jsonrpc":"2.0","id":id,"result":{"protocolVersion":"2024-11-05","capabilities":{"tools":{}},"serverInfo":{"name":"signet-native","version":env!("CARGO_PKG_VERSION")}}}),
        ),
        "tools/list" => Json(json!({
            "jsonrpc": "2.0", "id": id, "result": {"tools": [
                {"name":"remember", "description":"Store a memory", "inputSchema":{"type":"object","required":["content"],"properties":{"content":{"type":"string"},"metadata":{"type":"object"}}}},
                {"name":"recall", "description":"Recall memories", "inputSchema":{"type":"object","required":["query"],"properties":{"query":{"type":"string"}}}},
                {"name":"health", "description":"Check daemon health", "inputSchema":{"type":"object"}}
            ]}
        })),
        "tools/call" => call_tool(state, headers, id, request.params).await,
        _ => rpc_error(id, -32601, "Method not found"),
    }
}

async fn call_tool(
    state: AppState,
    headers: HeaderMap,
    id: Option<Value>,
    params: Value,
) -> Json<Value> {
    let Some(name) = params.get("name").and_then(Value::as_str) else {
        return rpc_error(id, -32602, "tool name is required");
    };
    let args = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let result = match name {
        "health" => execute(&state, Operation::Health).await,
        "remember" => {
            let Some(content) = args.get("content").and_then(Value::as_str) else {
                return rpc_error(id, -32602, "content is required");
            };
            if content.trim().is_empty() {
                return rpc_error(id, -32602, "content must not be empty");
            }
            let agent_id = match agent(&headers, None, None) {
                Ok(value) => value,
                Err(error) => return rpc_error(id, -32001, &error.message),
            };
            execute(
                &state,
                Operation::Remember {
                    agent_id,
                    content: content.to_owned(),
                    metadata: args.get("metadata").cloned().unwrap_or_else(|| json!({})),
                },
            )
            .await
        }
        "recall" => {
            let Some(query) = args.get("query").and_then(Value::as_str) else {
                return rpc_error(id, -32602, "query is required");
            };
            if query.trim().is_empty() {
                return rpc_error(id, -32602, "query must not be empty");
            }
            let agent_id = match agent(&headers, None, None) {
                Ok(value) => value,
                Err(error) => return rpc_error(id, -32001, &error.message),
            };
            execute(
                &state,
                Operation::Recall {
                    agent_id,
                    query: query.to_owned(),
                },
            )
            .await
        }
        _ => return rpc_error(id, -32602, "unknown tool"),
    };
    match result {
        Ok(value) => Json(
            json!({"jsonrpc":"2.0","id":id,"result":{"content":[{"type":"text","text":value.to_string()}],"structuredContent":value}}),
        ),
        Err(error) => rpc_error(id, -32000, &error.message),
    }
}

async fn status() -> Json<Value> {
    let bridge = bridge_url();
    let configured = bridge.is_some();
    let reachable = match bridge {
        Some(url) => bridge_reachable(&url).await,
        None => false,
    };
    Json(json!({
        "transport": "http-probe",
        "configured": configured,
        "reachable": reachable,
        "native": true,
        "supported": configured,
        "js_runtime_required": false
    }))
}

async fn ready(State(_state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let Some(url) = bridge_url() else {
        return Err(ApiError::bad_request("MCP bridge is not configured"));
    };
    if !bridge_reachable(&url).await {
        return Err(ApiError::unavailable("MCP bridge is not reachable"));
    }
    Ok(Json(json!({
        "ready": true,
        "transport": "http-probe",
        "js_runtime_required": false
    })))
}

fn bridge_url() -> Option<String> {
    env::var("SIGNET_MCP_BRIDGE_URL")
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

async fn bridge_reachable(url: &str) -> bool {
    let Some(authority) = url
        .strip_prefix("http://")
        .or_else(|| url.strip_prefix("https://"))
        .and_then(|value| value.split('/').next())
        .filter(|value| !value.is_empty())
    else {
        return false;
    };
    timeout(Duration::from_millis(500), TcpStream::connect(authority))
        .await
        .is_ok_and(|result| result.is_ok())
}
