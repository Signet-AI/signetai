//! MCP marketplace routes.
//!
//! Server management, tool listing/search, scope/policy endpoints.
//! Installed servers and policy stored as JSON in `~/.agents/marketplace/`.

use std::sync::Arc;

use axum::{
    Json,
    extract::{Path, Query, State},
    http::StatusCode,
    response::IntoResponse,
};
use serde::{Deserialize, Serialize};

use crate::state::AppState;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServer {
    pub id: String,
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub catalog_id: Option<String>,
    pub name: String,
    pub description: String,
    pub category: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub homepage: Option<String>,
    pub official: bool,
    pub enabled: bool,
    pub scope: McpScope,
    pub config: serde_json::Value,
    pub installed_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct McpScope {
    #[serde(default)]
    pub harnesses: Vec<String>,
    #[serde(default)]
    pub workspaces: Vec<String>,
    #[serde(default)]
    pub channels: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExposurePolicy {
    pub mode: String,
    pub max_expanded_tools: u32,
    pub max_search_results: u32,
    pub updated_at: String,
}

impl Default for ExposurePolicy {
    fn default() -> Self {
        Self {
            mode: "hybrid".into(),
            max_expanded_tools: 12,
            max_search_results: 8,
            updated_at: chrono::Utc::now().to_rfc3339(),
        }
    }
}

#[allow(dead_code)] // Used when tool discovery is implemented
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpTool {
    pub id: String,
    pub server_id: String,
    pub server_name: String,
    pub tool_name: String,
    pub description: String,
    pub read_only: bool,
    pub input_schema: serde_json::Value,
}

// ---------------------------------------------------------------------------
// File persistence helpers
// ---------------------------------------------------------------------------

fn marketplace_dir(state: &AppState) -> std::path::PathBuf {
    state.config.base_path.join("marketplace")
}

fn servers_path(state: &AppState) -> std::path::PathBuf {
    marketplace_dir(state).join("mcp-servers.json")
}

fn policy_path(state: &AppState) -> std::path::PathBuf {
    marketplace_dir(state).join("mcp-policy.json")
}

fn load_servers(state: &AppState) -> Vec<McpServer> {
    let path = servers_path(state);
    match std::fs::read_to_string(&path) {
        Ok(data) => serde_json::from_str(&data).unwrap_or_default(),
        Err(_) => Vec::new(),
    }
}

fn save_servers(state: &AppState, servers: &[McpServer]) -> Result<(), String> {
    let dir = marketplace_dir(state);
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir: {e}"))?;
    let json = serde_json::to_string_pretty(servers).map_err(|e| format!("serialize: {e}"))?;
    std::fs::write(servers_path(state), json).map_err(|e| format!("write: {e}"))
}

fn load_policy(state: &AppState) -> ExposurePolicy {
    let path = policy_path(state);
    match std::fs::read_to_string(&path) {
        Ok(data) => serde_json::from_str(&data).unwrap_or_default(),
        Err(_) => ExposurePolicy::default(),
    }
}

fn save_policy(state: &AppState, policy: &ExposurePolicy) -> Result<(), String> {
    let dir = marketplace_dir(state);
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir: {e}"))?;
    let json = serde_json::to_string_pretty(policy).map_err(|e| format!("serialize: {e}"))?;
    std::fs::write(policy_path(state), json).map_err(|e| format!("write: {e}"))
}

// ---------------------------------------------------------------------------
// Context extraction
// ---------------------------------------------------------------------------

#[derive(Debug, Default, Deserialize)]
pub struct ContextQuery {
    pub harness: Option<String>,
    pub workspace: Option<String>,
    pub channel: Option<String>,
}

fn scope_matches(scope: &McpScope, ctx: &ContextQuery) -> bool {
    let harness_ok = scope.harnesses.is_empty()
        || ctx
            .harness
            .as_ref()
            .map(|h| scope.harnesses.iter().any(|s| s.eq_ignore_ascii_case(h)))
            .unwrap_or(true);
    let workspace_ok = scope.workspaces.is_empty()
        || ctx
            .workspace
            .as_ref()
            .map(|w| {
                let wn = w.replace('\\', "/");
                scope.workspaces.iter().any(|s| {
                    let sn = s.replace('\\', "/");
                    if sn.ends_with('*') {
                        wn.starts_with(sn.trim_end_matches('*'))
                    } else {
                        wn.trim_end_matches('/') == sn.trim_end_matches('/')
                    }
                })
            })
            .unwrap_or(true);
    let channel_ok = scope.channels.is_empty()
        || ctx
            .channel
            .as_ref()
            .map(|c| scope.channels.iter().any(|s| s.eq_ignore_ascii_case(c)))
            .unwrap_or(true);
    harness_ok && workspace_ok && channel_ok
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

/// GET /api/marketplace/mcp — list installed servers
pub async fn list_servers(
    State(state): State<Arc<AppState>>,
    Query(ctx): Query<ContextQuery>,
) -> Json<serde_json::Value> {
    let all = load_servers(&state);
    let filtered: Vec<&McpServer> = all
        .iter()
        .filter(|s| scope_matches(&s.scope, &ctx))
        .collect();
    Json(serde_json::json!({
        "servers": filtered,
        "count": filtered.len(),
        "scoped": ctx.harness.is_some() || ctx.workspace.is_some() || ctx.channel.is_some(),
        "context": {
            "harness": ctx.harness,
            "workspace": ctx.workspace,
            "channel": ctx.channel,
        }
    }))
}

/// GET /api/marketplace/mcp/policy — get exposure policy
pub async fn get_policy(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    let policy = load_policy(&state);
    Json(serde_json::json!({ "policy": policy }))
}

/// PATCH /api/marketplace/mcp/policy — update exposure policy
pub async fn set_policy(
    State(state): State<Arc<AppState>>,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    let mut policy = load_policy(&state);

    if let Some(mode) = body.get("mode").and_then(|v| v.as_str()) {
        match mode {
            "compact" | "hybrid" | "expanded" => policy.mode = mode.into(),
            _ => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({"error": "invalid mode"})),
                );
            }
        }
    }
    if let Some(n) = body.get("maxExpandedTools").and_then(|v| v.as_u64()) {
        policy.max_expanded_tools = n as u32;
    }
    if let Some(n) = body.get("maxSearchResults").and_then(|v| v.as_u64()) {
        policy.max_search_results = n as u32;
    }
    policy.updated_at = chrono::Utc::now().to_rfc3339();

    if let Err(e) = save_policy(&state, &policy) {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e})),
        );
    }

    (
        StatusCode::OK,
        Json(serde_json::json!({ "policy": policy })),
    )
}

/// GET /api/marketplace/mcp/tools — list tools from enabled servers
pub async fn list_tools(
    State(state): State<Arc<AppState>>,
    Query(ctx): Query<ContextQuery>,
) -> Json<serde_json::Value> {
    let servers = load_servers(&state);
    let enabled: Vec<&McpServer> = servers
        .iter()
        .filter(|s| s.enabled && scope_matches(&s.scope, &ctx))
        .collect();
    let policy = load_policy(&state);

    // Tool discovery requires connecting to each server — return empty for now.
    // Real implementation would spawn subprocesses / HTTP clients.
    let server_status: Vec<serde_json::Value> = enabled
        .iter()
        .map(|s| {
            serde_json::json!({
                "serverId": s.id,
                "serverName": s.name,
                "ok": false,
                "toolCount": 0,
                "error": "tool discovery not yet implemented in Rust daemon"
            })
        })
        .collect();

    Json(serde_json::json!({
        "tools": [],
        "servers": server_status,
        "count": 0,
        "context": {
            "harness": ctx.harness,
            "workspace": ctx.workspace,
            "channel": ctx.channel,
        },
        "policy": policy
    }))
}

#[derive(Debug, Deserialize)]
pub struct SearchQuery {
    pub q: Option<String>,
    pub limit: Option<usize>,
}

/// GET /api/marketplace/mcp/search — search tools
pub async fn search_tools(
    State(state): State<Arc<AppState>>,
    Query(params): Query<SearchQuery>,
    Query(ctx): Query<ContextQuery>,
) -> Json<serde_json::Value> {
    let query = params.q.unwrap_or_default();
    let _limit = params.limit.unwrap_or(8);
    let _servers = load_servers(&state);

    // Tool search requires live connections — stub response
    Json(serde_json::json!({
        "query": query,
        "count": 0,
        "results": [],
        "context": {
            "harness": ctx.harness,
            "workspace": ctx.workspace,
            "channel": ctx.channel,
        }
    }))
}

/// POST /api/marketplace/mcp/call — execute a tool on a server
pub async fn call_tool(
    State(_state): State<Arc<AppState>>,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    let server_id = body.get("serverId").and_then(|v| v.as_str());
    let tool_name = body.get("toolName").and_then(|v| v.as_str());

    if server_id.is_none() || tool_name.is_none() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "missing serverId or toolName"})),
        );
    }

    // Tool execution requires subprocess/HTTP client — stub
    (
        StatusCode::NOT_IMPLEMENTED,
        Json(serde_json::json!({"error": "tool execution not yet implemented in Rust daemon"})),
    )
}

/// POST /api/marketplace/mcp/register — manual server registration
pub async fn register_server(
    State(state): State<Arc<AppState>>,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    let name = match body.get("name").and_then(|v| v.as_str()) {
        Some(n) => n.to_string(),
        None => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"error": "missing name"})),
            );
        }
    };

    let config = match body.get("config") {
        Some(c) => c.clone(),
        None => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"error": "missing config"})),
            );
        }
    };

    let id = name
        .to_lowercase()
        .replace(|c: char| !c.is_alphanumeric() && c != '-', "-");
    let now = chrono::Utc::now().to_rfc3339();

    let scope: McpScope = body
        .get("scope")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default();

    let server = McpServer {
        id: id.clone(),
        source: "manual".into(),
        catalog_id: None,
        name,
        description: body
            .get("description")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .into(),
        category: body
            .get("category")
            .and_then(|v| v.as_str())
            .unwrap_or("Other")
            .into(),
        homepage: None,
        official: false,
        enabled: true,
        scope,
        config,
        installed_at: now.clone(),
        updated_at: now,
    };

    let mut servers = load_servers(&state);

    // Check for existing server with same id
    if let Some(pos) = servers.iter().position(|s| s.id == id) {
        servers[pos] = server.clone();
    } else {
        servers.push(server.clone());
    }

    if let Err(e) = save_servers(&state, &servers) {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e})),
        );
    }

    (
        StatusCode::CREATED,
        Json(serde_json::json!({
            "success": true,
            "server": server
        })),
    )
}

/// GET /api/marketplace/mcp/:id — get single server
pub async fn get_server(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let servers = load_servers(&state);
    match servers.iter().find(|s| s.id == id) {
        Some(server) => (
            StatusCode::OK,
            Json(serde_json::json!({ "server": server })),
        ),
        None => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"error": format!("server not found: {id}")})),
        ),
    }
}

/// PATCH /api/marketplace/mcp/:id — update server
pub async fn update_server(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    let mut servers = load_servers(&state);
    let pos = match servers.iter().position(|s| s.id == id) {
        Some(p) => p,
        None => {
            return (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({"error": format!("server not found: {id}")})),
            );
        }
    };

    if let Some(enabled) = body.get("enabled").and_then(|v| v.as_bool()) {
        servers[pos].enabled = enabled;
    }
    if let Some(name) = body.get("name").and_then(|v| v.as_str()) {
        servers[pos].name = name.into();
    }
    if let Some(desc) = body.get("description").and_then(|v| v.as_str()) {
        servers[pos].description = desc.into();
    }
    if let Some(config) = body.get("config") {
        servers[pos].config = config.clone();
    }
    if let Some(scope) = body.get("scope")
        && let Ok(s) = serde_json::from_value::<McpScope>(scope.clone())
    {
        servers[pos].scope = s;
    }
    servers[pos].updated_at = chrono::Utc::now().to_rfc3339();

    let updated = servers[pos].clone();
    if let Err(e) = save_servers(&state, &servers) {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e})),
        );
    }

    (
        StatusCode::OK,
        Json(serde_json::json!({ "server": updated })),
    )
}

/// DELETE /api/marketplace/mcp/:id — remove server
pub async fn delete_server(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let mut servers = load_servers(&state);
    let before = servers.len();
    servers.retain(|s| s.id != id);

    if servers.len() == before {
        return (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"error": format!("server not found: {id}")})),
        );
    }

    if let Err(e) = save_servers(&state, &servers) {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e})),
        );
    }

    (
        StatusCode::OK,
        Json(serde_json::json!({"success": true, "id": id})),
    )
}

/// GET /api/marketplace/mcp/browse — browse catalog
pub async fn browse_catalog(State(_state): State<Arc<AppState>>) -> impl IntoResponse {
    // Catalog browsing requires fetching from mcpservers.org + GitHub — stub
    (
        StatusCode::OK,
        Json(serde_json::json!({
            "entries": [],
            "count": 0,
            "sources": ["mcpservers.org", "modelcontextprotocol/servers"],
            "note": "catalog browsing not yet implemented in Rust daemon"
        })),
    )
}

/// POST /api/marketplace/mcp/install — install from catalog
pub async fn install_from_catalog(
    State(_state): State<Arc<AppState>>,
    Json(_body): Json<serde_json::Value>,
) -> impl IntoResponse {
    // Catalog install requires fetching server details — stub
    (
        StatusCode::NOT_IMPLEMENTED,
        Json(serde_json::json!({"error": "catalog install not yet implemented in Rust daemon"})),
    )
}

/// POST /api/marketplace/mcp/test — test MCP config
pub async fn test_config(
    State(_state): State<Arc<AppState>>,
    Json(_body): Json<serde_json::Value>,
) -> impl IntoResponse {
    // Testing requires subprocess/HTTP client — stub
    (
        StatusCode::NOT_IMPLEMENTED,
        Json(serde_json::json!({"error": "config testing not yet implemented in Rust daemon"})),
    )
}

/// GET /api/marketplace/mcp/detail — get server installation details
pub async fn catalog_detail(State(_state): State<Arc<AppState>>) -> impl IntoResponse {
    (
        StatusCode::NOT_IMPLEMENTED,
        Json(serde_json::json!({"error": "catalog detail not yet implemented in Rust daemon"})),
    )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scope_empty_matches_all() {
        let scope = McpScope::default();
        let ctx = ContextQuery {
            harness: Some("claude-code".into()),
            workspace: Some("/home/user/project".into()),
            channel: None,
        };
        assert!(scope_matches(&scope, &ctx));
    }

    #[test]
    fn scope_harness_filter() {
        let scope = McpScope {
            harnesses: vec!["claude-code".into()],
            ..Default::default()
        };
        let matching = ContextQuery {
            harness: Some("claude-code".into()),
            ..Default::default()
        };
        let non_matching = ContextQuery {
            harness: Some("opencode".into()),
            ..Default::default()
        };
        assert!(scope_matches(&scope, &matching));
        assert!(!scope_matches(&scope, &non_matching));
    }

    #[test]
    fn scope_workspace_wildcard() {
        let scope = McpScope {
            workspaces: vec!["src/*".into()],
            ..Default::default()
        };
        let matching = ContextQuery {
            workspace: Some("src/foo/bar".into()),
            ..Default::default()
        };
        let non_matching = ContextQuery {
            workspace: Some("lib/foo".into()),
            ..Default::default()
        };
        assert!(scope_matches(&scope, &matching));
        assert!(!scope_matches(&scope, &non_matching));
    }

    #[test]
    fn default_policy() {
        let policy = ExposurePolicy::default();
        assert_eq!(policy.mode, "hybrid");
        assert_eq!(policy.max_expanded_tools, 12);
        assert_eq!(policy.max_search_results, 8);
    }

    #[test]
    fn scope_case_insensitive_harness() {
        let scope = McpScope {
            harnesses: vec!["Claude-Code".into()],
            ..Default::default()
        };
        let ctx = ContextQuery {
            harness: Some("claude-code".into()),
            ..Default::default()
        };
        assert!(scope_matches(&scope, &ctx));
    }
}
