//! OS integration routes.

use axum::{
    Json,
    extract::{Path, Query, State},
    http::StatusCode,
    response::IntoResponse,
};
use serde::Deserialize;
use serde_json::json;
use std::sync::Arc;

use crate::{
    state::{AppState, OsAgentSession},
    workspace_paths,
};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventsQuery {
    r#type: Option<String>,
    limit: Option<usize>,
    window_ms: Option<u64>,
}

pub async fn events(Query(query): Query<EventsQuery>) -> Json<serde_json::Value> {
    let limit = query.limit.unwrap_or(50).clamp(1, 500);
    let window_ms = query.window_ms.unwrap_or(300_000).clamp(1_000, 1_800_000);
    Json(json!({
        "events": [],
        "count": 0,
        "query": {
            "type": query.r#type,
            "limit": limit,
            "windowMs": window_ms,
        },
    }))
}

pub async fn events_stream(Query(query): Query<EventsQuery>) -> impl IntoResponse {
    let subscribed_to = query.r#type.unwrap_or_else(|| "*".to_string());
    (
        [
            ("content-type", "text/event-stream"),
            ("cache-control", "no-cache"),
            ("connection", "keep-alive"),
        ],
        format!(
            "data: {}\n\n",
            json!({"type": "connected", "subscribedTo": subscribed_to})
        ),
    )
}

pub async fn context() -> Json<serde_json::Value> {
    Json(json!({
        "events": [],
        "count": 0,
        "windowMs": 300000,
    }))
}

pub async fn event_stats() -> Json<serde_json::Value> {
    Json(json!({
        "events": 0,
        "subscribers": 0,
        "types": {},
    }))
}

pub async fn agent_sessions(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    let mut sessions = state
        .os_agent_sessions
        .read()
        .await
        .values()
        .cloned()
        .collect::<Vec<_>>();
    sessions.sort_by(|left, right| left.id.cmp(&right.id));
    Json(json!({"sessions": sessions, "count": sessions.len()}))
}

pub async fn agent_events() -> impl IntoResponse {
    (
        [
            ("content-type", "text/event-stream"),
            ("cache-control", "no-cache"),
            ("connection", "keep-alive"),
        ],
        "data: {\"type\":\"connected\"}\n\n",
    )
}

pub async fn agent_execute(
    State(state): State<Arc<AppState>>,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    let server_id = body
        .get("serverId")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let task = body
        .get("task")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if server_id.is_none() || task.is_none() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "serverId and task are required"})),
        )
            .into_response();
    }
    let server_id = server_id.expect("validated serverId").to_string();
    let mut sessions = state.os_agent_sessions.write().await;
    if sessions
        .values()
        .any(|session| session.server_id == server_id && session.status == "running")
    {
        return (
            StatusCode::CONFLICT,
            Json(json!({"error": "An agent session is already running for this server"})),
        )
            .into_response();
    }

    let session_id = format!("agent-{}", uuid::Uuid::new_v4());
    sessions.insert(
        session_id.clone(),
        OsAgentSession {
            id: session_id.clone(),
            server_id: server_id.clone(),
            task: task.expect("validated task").to_string(),
            agent_id: body
                .get("agentId")
                .and_then(|value| value.as_str())
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned),
            task_class: body
                .get("taskClass")
                .and_then(|value| value.as_str())
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned),
            privacy: body
                .get("privacy")
                .and_then(|value| value.as_str())
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned),
            status: "running".to_string(),
            step: 0,
            max_steps: 20,
            result: None,
            error: None,
        },
    );
    (
        StatusCode::OK,
        Json(json!({"sessionId": session_id, "serverId": server_id})),
    )
        .into_response()
}

pub async fn agent_state(
    State(state): State<Arc<AppState>>,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    let session_id = body
        .get("sessionId")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if session_id.is_none() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "sessionId is required"})),
        )
            .into_response();
    }
    if state
        .os_agent_sessions
        .read()
        .await
        .contains_key(session_id.expect("validated sessionId"))
    {
        Json(json!({"success": true})).into_response()
    } else {
        (
            StatusCode::NOT_FOUND,
            Json(json!({"error": "Session not found"})),
        )
            .into_response()
    }
}

pub async fn chat(Json(body): Json<serde_json::Value>) -> impl IntoResponse {
    let message = body
        .get("message")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if message.is_none() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "Message is required"})),
        )
            .into_response();
    }
    Json(json!({
        "response": "No MCP servers are installed yet. Add some from the dock to get started.",
        "toolCalls": [],
    }))
    .into_response()
}

pub async fn tray() -> Json<serde_json::Value> {
    Json(json!({"entries": [], "count": 0}))
}

pub async fn tray_get(Path(_id): Path<String>) -> impl IntoResponse {
    (
        StatusCode::NOT_FOUND,
        Json(json!({"error": "App not found in tray"})),
    )
}

pub async fn tray_probe(Path(_id): Path<String>) -> impl IntoResponse {
    (
        StatusCode::NOT_FOUND,
        Json(json!({"error": "No probe result found"})),
    )
}

pub async fn tray_reprobe(Path(_id): Path<String>) -> impl IntoResponse {
    (
        StatusCode::NOT_FOUND,
        Json(json!({"error": "Server not found in installed servers"})),
    )
}

pub async fn tray_patch(
    Path(_id): Path<String>,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    if let Some(state) = body.get("state").and_then(|value| value.as_str())
        && !matches!(state, "tray" | "grid" | "dock")
    {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "state must be tray, grid, or dock"})),
        )
            .into_response();
    }
    (
        StatusCode::NOT_FOUND,
        Json(json!({"error": "App not found in tray"})),
    )
        .into_response()
}

pub async fn install(
    State(state): State<Arc<AppState>>,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    let url = body
        .get("url")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let Some(url) = url else {
        return (
            StatusCode::BAD_REQUEST,
            Json(
                json!({"ok": false, "widgetId": "", "manifest": null, "error": "url is required"}),
            ),
        )
            .into_response();
    };
    let parsed = match reqwest::Url::parse(url) {
        Ok(parsed) => parsed,
        Err(_) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({"ok": false, "widgetId": "", "manifest": null, "error": "Invalid URL format"})),
            )
                .into_response();
        }
    };
    if !matches!(parsed.scheme(), "http" | "https") {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"ok": false, "widgetId": "", "manifest": null, "error": "Only HTTP/HTTPS URLs are supported"})),
        )
            .into_response();
    }
    if parsed.host_str().map(is_private_hostname).unwrap_or(true) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"ok": false, "widgetId": "", "manifest": null, "error": "Private/loopback addresses are not allowed"})),
        )
            .into_response();
    }

    match install_direct_http(
        &state,
        url,
        body.get("name").and_then(|value| value.as_str()),
    ) {
        Ok(server_id) => (
            StatusCode::OK,
            Json(json!({"ok": true, "widgetId": server_id, "manifest": null})),
        )
            .into_response(),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"ok": false, "widgetId": "", "manifest": null, "error": error})),
        )
            .into_response(),
    }
}

pub async fn widget_generate(Json(body): Json<serde_json::Value>) -> impl IntoResponse {
    let server_id = body
        .get("serverId")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if server_id.is_none() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "serverId is required"})),
        )
            .into_response();
    }
    (StatusCode::ACCEPTED, Json(json!({"status": "generating"}))).into_response()
}

pub async fn widget_get(Path(_id): Path<String>) -> impl IntoResponse {
    (
        StatusCode::NOT_FOUND,
        Json(json!({"error": "Widget not found"})),
    )
}

pub async fn widget_delete(Path(_id): Path<String>) -> Json<serde_json::Value> {
    Json(json!({"success": true}))
}

fn marketplace_servers_path(state: &AppState) -> Result<std::path::PathBuf, String> {
    workspace_paths::child_file(
        &state.config.base_path,
        &["marketplace", "mcp-servers.json"],
    )
    .map_err(|error| error.to_string())
}

fn read_installed_servers(state: &AppState) -> Vec<serde_json::Value> {
    let Ok(path) = marketplace_servers_path(state) else {
        return Vec::new();
    };
    std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|value| value.as_array().cloned())
        .unwrap_or_default()
}

fn write_installed_servers(state: &AppState, servers: &[serde_json::Value]) -> Result<(), String> {
    let path = marketplace_servers_path(state)?;
    std::fs::write(
        path,
        serde_json::to_string_pretty(servers).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())
}

fn install_direct_http(
    state: &AppState,
    url: &str,
    name_override: Option<&str>,
) -> Result<String, String> {
    let mut servers = read_installed_servers(state);
    if let Some(pos) = servers.iter().position(|server| {
        server
            .get("config")
            .and_then(|config| config.get("url"))
            .and_then(serde_json::Value::as_str)
            == Some(url)
    }) {
        let mut should_write = false;
        if let Some(name) = name_override
            .map(str::trim)
            .filter(|value| !value.is_empty())
            && servers[pos].get("name").and_then(serde_json::Value::as_str) != Some(name)
        {
            servers[pos]["name"] = json!(name);
            servers[pos]["updatedAt"] = json!(chrono::Utc::now().to_rfc3339());
            should_write = true;
        }
        let id = servers[pos]
            .get("id")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| "installed server missing id".to_string())?;
        if should_write {
            write_installed_servers(state, &servers)?;
        }
        return Ok(id);
    }

    let name = name_override
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| infer_name_from_url(url));
    let id = unique_server_id(&sanitize_server_id(&name), &servers);
    let now = chrono::Utc::now().to_rfc3339();
    servers.push(json!({
        "id": id,
        "source": "manual",
        "name": name,
        "description": format!("{name} MCP server"),
        "category": infer_category(&name),
        "homepage": url,
        "official": false,
        "enabled": true,
        "scope": {"harnesses": [], "workspaces": [], "channels": []},
        "config": {
            "transport": "http",
            "url": url,
            "headers": {},
            "timeoutMs": 20000,
        },
        "installedAt": now,
        "updatedAt": now,
    }));
    write_installed_servers(state, &servers)?;
    Ok(id)
}

fn unique_server_id(base_id: &str, servers: &[serde_json::Value]) -> String {
    if !servers
        .iter()
        .any(|server| server.get("id").and_then(serde_json::Value::as_str) == Some(base_id))
    {
        return base_id.to_string();
    }
    let mut suffix = 2;
    loop {
        let candidate = format!("{base_id}-{suffix}");
        if !servers.iter().any(|server| {
            server.get("id").and_then(serde_json::Value::as_str) == Some(candidate.as_str())
        }) {
            return candidate;
        }
        suffix += 1;
    }
}

fn sanitize_server_id(value: &str) -> String {
    let mut out = String::new();
    let mut last_dash = false;
    for ch in value.trim().to_lowercase().chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
            out.push(ch);
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
    }
    let normalized = out.trim_matches('-').to_string();
    if normalized.is_empty() {
        "mcp-server".to_string()
    } else {
        normalized
    }
}

fn infer_name_from_url(url: &str) -> String {
    let Ok(parsed) = reqwest::Url::parse(url) else {
        return "MCP Server".to_string();
    };
    let mut name = parsed
        .host_str()
        .unwrap_or("mcp-server")
        .trim_start_matches("www.")
        .trim_start_matches("api.")
        .trim_start_matches("mcp.")
        .to_string();
    for suffix in [".com", ".org", ".io", ".dev", ".app", ".net"] {
        if let Some(stripped) = name.strip_suffix(suffix) {
            name = stripped.to_string();
            break;
        }
    }
    if let Some(path_hint) = parsed.path_segments().and_then(|mut segments| {
        segments.find(|part| !part.is_empty() && !matches!(*part, "mcp" | "sse" | "v1"))
    }) {
        name = format!("{name}-{path_hint}");
    }
    let words = name
        .replace(['-', '_'], " ")
        .split_whitespace()
        .map(|word| {
            let mut chars = word.chars();
            match chars.next() {
                Some(first) => format!("{}{}", first.to_uppercase(), chars.as_str()),
                None => String::new(),
            }
        })
        .filter(|word| !word.is_empty())
        .collect::<Vec<_>>();
    if words.is_empty() {
        "MCP Server".to_string()
    } else {
        words.join(" ")
    }
}

fn infer_category(text: &str) -> &'static str {
    let source = text.to_lowercase();
    if ["browser", "scrap", "crawl", "web"]
        .iter()
        .any(|term| source.contains(term))
    {
        return "Web";
    }
    if ["slack", "discord", "email", "sms", "message", "chat"]
        .iter()
        .any(|term| source.contains(term))
    {
        return "Communication";
    }
    if [
        "database", "sql", "postgres", "mysql", "sqlite", "redis", "vector",
    ]
    .iter()
    .any(|term| source.contains(term))
    {
        return "Database";
    }
    if ["github", "git", "ci", "deploy", "build", "code", "dev"]
        .iter()
        .any(|term| source.contains(term))
    {
        return "Development";
    }
    if ["cloud", "aws", "gcp", "azure", "vercel", "cloudflare"]
        .iter()
        .any(|term| source.contains(term))
    {
        return "Cloud";
    }
    if ["finance", "stock", "market", "crypto", "trading"]
        .iter()
        .any(|term| source.contains(term))
    {
        return "Finance";
    }
    if ["memory", "knowledge", "search", "docs", "rag"]
        .iter()
        .any(|term| source.contains(term))
    {
        return "Knowledge";
    }
    if ["file", "storage", "drive", "s3", "bucket"]
        .iter()
        .any(|term| source.contains(term))
    {
        return "Storage";
    }
    "Other"
}

fn is_private_hostname(hostname: &str) -> bool {
    let host = hostname
        .to_lowercase()
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_string();
    if host == "localhost" || host == "0.0.0.0" || host.starts_with("127.") {
        return true;
    }
    if host.starts_with("10.") || host.starts_with("192.168.") || host.starts_with("169.254.") {
        return true;
    }
    if let Some(second) = host
        .strip_prefix("172.")
        .and_then(|rest| rest.split('.').next())
        && second
            .parse::<u8>()
            .map(|value| (16..=31).contains(&value))
            .unwrap_or(false)
    {
        return true;
    }
    if let Some(second) = host
        .strip_prefix("100.")
        .and_then(|rest| rest.split('.').next())
        && second
            .parse::<u8>()
            .map(|value| (64..=127).contains(&value))
            .unwrap_or(false)
    {
        return true;
    }
    if host == "::1" || host == "0:0:0:0:0:0:0:1" || host.starts_with("fe80:") {
        return true;
    }
    if (host.starts_with("fc") || host.starts_with("fd")) && host.contains(':') {
        return true;
    }
    host.ends_with(".local") || host.ends_with(".internal") || host.ends_with(".localhost")
}
