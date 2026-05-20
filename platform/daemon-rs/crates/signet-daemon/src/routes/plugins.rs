//! Native plugin registry routes.
//!
//! Implements the TypeScript daemon's bundled plugin host contract for the
//! built-in `signet.secrets` plugin: registry listing, diagnostics,
//! enable/disable state, prompt contributions, and durable audit querying.

use std::{net::SocketAddr, path::PathBuf, sync::Arc};

use axum::{
    Json,
    extract::{ConnectInfo, Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use serde::Deserialize;

use crate::{
    auth::{
        middleware::{authenticate_headers, require_permission_guard},
        types::Permission,
    },
    state::AppState,
    workspace_paths,
};

const SIGNET_SECRETS_PLUGIN_ID: &str = "signet.secrets";
const AUDIT_FILE: &str = "audit-v1.ndjson";
const REGISTRY_FILE: &str = "registry-v1.json";

#[derive(Debug, Deserialize)]
pub struct AuditQuery {
    #[serde(rename = "pluginId")]
    plugin_id: Option<String>,
    event: Option<String>,
    since: Option<String>,
    until: Option<String>,
    limit: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct PatchPluginBody {
    enabled: Option<serde_json::Value>,
}

fn plugin_dir(state: &AppState) -> std::io::Result<PathBuf> {
    workspace_paths::child_dir(&state.config.base_path, &[".daemon", "plugins"])
}

fn registry_path(state: &AppState) -> std::io::Result<PathBuf> {
    workspace_paths::child_file(
        &state.config.base_path,
        &[".daemon", "plugins", REGISTRY_FILE],
    )
}

fn audit_path(state: &AppState) -> std::io::Result<PathBuf> {
    workspace_paths::child_file(&state.config.base_path, &[".daemon", "plugins", AUDIT_FILE])
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn parse_enabled(value: &serde_json::Value) -> Option<bool> {
    match value {
        serde_json::Value::Bool(v) => Some(*v),
        serde_json::Value::Number(n) => match n.as_i64() {
            Some(1) => Some(true),
            Some(0) => Some(false),
            _ => None,
        },
        serde_json::Value::String(s) => match s.trim().to_ascii_lowercase().as_str() {
            "1" | "true" => Some(true),
            "0" | "false" => Some(false),
            _ => None,
        },
        _ => None,
    }
}

fn read_enabled(state: &AppState) -> bool {
    let Ok(path) = registry_path(state) else {
        return true;
    };
    // lgtm[rust/path-injection] registry_path resolves a constant file under the canonical Signet workspace root via workspace_paths::child_file.
    let Ok(raw) = std::fs::read_to_string(path) else {
        return true;
    };
    serde_json::from_str::<serde_json::Value>(&raw)
        .ok()
        .and_then(|json| {
            json.pointer("/plugins/signet.secrets/enabled")
                .and_then(|v| v.as_bool())
        })
        .unwrap_or(true)
}

fn write_enabled(state: &AppState, enabled: bool) -> Result<(), String> {
    let path = registry_path(state).map_err(|e| e.to_string())?;
    let timestamp = now_iso();
    let json = serde_json::json!({
        "version": 1,
        "plugins": {
            SIGNET_SECRETS_PLUGIN_ID: {
                "enabled": enabled,
                "grantedCapabilities": secret_capabilities(),
                "installedAt": timestamp,
                "updatedAt": timestamp,
            }
        }
    });
    std::fs::write(
        path,
        serde_json::to_string_pretty(&json).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}

fn secret_capabilities() -> Vec<&'static str> {
    vec![
        "secrets:list",
        "secrets:write",
        "secrets:delete",
        "secrets:exec",
        "secrets:providers:list",
        "secrets:providers:configure",
        "prompt:contribute:user-prompt-submit",
        "mcp:tool",
        "cli:command",
        "dashboard:panel",
        "sdk:client",
        "connector:capability",
    ]
}

fn secret_surfaces() -> serde_json::Value {
    serde_json::json!({
        "daemonRoutes": [
            {"method": "GET", "path": "/api/secrets", "summary": "List stored local secret names", "requiredCapabilities": ["secrets:list"]},
            {"method": "POST", "path": "/api/secrets/:name", "summary": "Store a local secret", "requiredCapabilities": ["secrets:write"]},
            {"method": "DELETE", "path": "/api/secrets/:name", "summary": "Delete a local secret", "requiredCapabilities": ["secrets:delete"]},
            {"method": "POST", "path": "/api/secrets/exec", "summary": "Run a command with injected secrets", "requiredCapabilities": ["secrets:exec"]},
            {"method": "GET", "path": "/api/secrets/1password/status", "summary": "Inspect 1Password compatibility provider status", "requiredCapabilities": ["secrets:providers:list"]}
        ],
        "cliCommands": [
            {"path": ["secret", "list"], "summary": "List secret names", "requiredCapabilities": ["cli:command", "secrets:list"]},
            {"path": ["secret", "put"], "summary": "Store a secret", "requiredCapabilities": ["cli:command", "secrets:write"]},
            {"path": ["secret", "delete"], "summary": "Delete a secret", "requiredCapabilities": ["cli:command", "secrets:delete"]},
            {"path": ["secret", "exec"], "summary": "Run a command with injected secrets", "requiredCapabilities": ["cli:command", "secrets:exec"]}
        ],
        "mcpTools": [
            {"name": "secret_list", "title": "List Secrets", "summary": "List available secret names without values", "requiredCapabilities": ["mcp:tool", "secrets:list"]},
            {"name": "secret_exec", "title": "Execute with Secrets", "summary": "Run a command with secret values injected and redacted", "requiredCapabilities": ["mcp:tool", "secrets:exec"]}
        ],
        "dashboardPanels": [
            {"id": "settings.secrets", "title": "Secrets", "summary": "Manage local encrypted Signet secrets and 1Password compatibility", "requiredCapabilities": ["dashboard:panel", "secrets:list"]}
        ],
        "sdkClients": [
            {"name": "listSecrets", "summary": "List stored secret names", "requiredCapabilities": ["sdk:client", "secrets:list"]},
            {"name": "storeSecret", "summary": "Store a secret", "requiredCapabilities": ["sdk:client", "secrets:write"]},
            {"name": "deleteSecret", "summary": "Delete a secret", "requiredCapabilities": ["sdk:client", "secrets:delete"]},
            {"name": "execWithSecrets", "summary": "Run a command with injected secrets", "requiredCapabilities": ["sdk:client", "secrets:exec"]},
            {"name": "getOnePasswordStatus", "summary": "Inspect 1Password compatibility status", "requiredCapabilities": ["sdk:client", "secrets:providers:list"]}
        ],
        "connectorCapabilities": [
            {"id": "secrets.list", "title": "Secret Listing", "summary": "Connector may advertise secret name listing", "requiredCapabilities": ["connector:capability", "secrets:list"]},
            {"id": "secrets.exec", "title": "Secret Execution", "summary": "Connector may advertise secret command execution", "requiredCapabilities": ["connector:capability", "secrets:exec"]}
        ],
        "promptContributions": [prompt_contribution_manifest()]
    })
}

fn empty_surfaces() -> serde_json::Value {
    serde_json::json!({
        "daemonRoutes": [],
        "cliCommands": [],
        "mcpTools": [],
        "dashboardPanels": [],
        "sdkClients": [],
        "connectorCapabilities": [],
        "promptContributions": []
    })
}

fn prompt_contribution_manifest() -> serde_json::Value {
    serde_json::json!({
        "id": "signet.secrets.credential-guidance",
        "target": "user-prompt-submit",
        "mode": "context",
        "priority": 420,
        "maxTokens": 80,
        "summary": "Advise agents to keep reusable credentials in Signet Secrets",
        "requiredCapabilities": ["prompt:contribute:user-prompt-submit"]
    })
}

fn prompt_contribution() -> serde_json::Value {
    let mut value = prompt_contribution_manifest();
    if let Some(obj) = value.as_object_mut() {
        obj.insert(
            "pluginId".to_string(),
            serde_json::json!(SIGNET_SECRETS_PLUGIN_ID),
        );
        obj.insert(
            "content".to_string(),
            serde_json::json!("When the user provides credentials or a task requires reusable credentials, prefer storing them in Signet Secrets rather than chat, memory, logs, or source files. Use secret_exec or provider-backed secret references when commands need credentials."),
        );
    }
    value
}

fn plugin_record(state: &AppState) -> serde_json::Value {
    let enabled = read_enabled(state);
    let state_name = if enabled { "active" } else { "disabled" };
    serde_json::json!({
        "id": SIGNET_SECRETS_PLUGIN_ID,
        "name": "Signet Secrets",
        "version": "1.0.0",
        "publisher": "signetai",
        "source": "bundled",
        "trustTier": "core",
        "enabled": enabled,
        "state": state_name,
        "stateReason": if enabled { serde_json::Value::Null } else { serde_json::json!("Plugin disabled") },
        "declaredCapabilities": secret_capabilities(),
        "grantedCapabilities": if enabled { serde_json::json!(secret_capabilities()) } else { serde_json::json!([]) },
        "pendingCapabilities": [],
        "surfaces": if enabled { secret_surfaces() } else { empty_surfaces() },
        "installedAt": serde_json::Value::Null,
        "updatedAt": serde_json::Value::Null,
    })
}

fn plugin_manifest() -> serde_json::Value {
    serde_json::json!({
        "id": SIGNET_SECRETS_PLUGIN_ID,
        "name": "Signet Secrets",
        "version": "1.0.0",
        "publisher": "signetai",
        "description": "Privileged core plugin for encrypted local secrets, compatibility providers, and secret injection.",
        "runtime": {"language": "typescript", "kind": "bundled-module", "entry": "@signet/daemon/plugins/bundled/secrets"},
        "compatibility": {"signet": ">=0.99.0 <1.0.0", "pluginApi": "1.x"},
        "trustTier": "core",
        "capabilities": secret_capabilities(),
        "surfaces": secret_surfaces(),
        "promptContributions": [prompt_contribution()],
    })
}

fn plugin_diagnostics(state: &AppState) -> serde_json::Value {
    let record = plugin_record(state);
    serde_json::json!({
        "record": record,
        "manifest": plugin_manifest(),
        "activeSurfaces": record.get("surfaces").cloned().unwrap_or_else(empty_surfaces),
        "plannedSurfaces": secret_surfaces(),
        "promptContributions": [prompt_contribution()],
        "promptContributionDiagnostics": [{"id": "signet.secrets.credential-guidance", "pluginId": SIGNET_SECRETS_PLUGIN_ID, "included": read_enabled(state), "reason": if read_enabled(state) { "active" } else { "plugin-disabled" }}],
        "validationErrors": []
    })
}

fn parse_limit(raw: Option<&str>) -> usize {
    raw.and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(100)
        .clamp(1, 500)
}

fn parse_time(raw: Option<&str>) -> Option<String> {
    raw.map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_string)
}

fn is_sensitive_key(key: &str) -> bool {
    let normalized = key
        .chars()
        .flat_map(|ch| {
            if ch.is_uppercase() {
                vec!['-', ch.to_ascii_lowercase()]
            } else {
                vec![ch]
            }
        })
        .collect::<String>()
        .replace('_', "-");
    normalized.contains("secret")
        || normalized.contains("token")
        || normalized.contains("password")
        || normalized.contains("credential")
        || normalized.contains("api-key")
        || normalized == "value"
}

fn sanitize_value(value: serde_json::Value) -> serde_json::Value {
    match value {
        serde_json::Value::Object(map) => serde_json::Value::Object(
            map.into_iter()
                .map(|(k, v)| {
                    if is_sensitive_key(&k) {
                        (k, serde_json::json!("[REDACTED]"))
                    } else {
                        (k, sanitize_value(v))
                    }
                })
                .collect(),
        ),
        serde_json::Value::Array(items) => {
            serde_json::Value::Array(items.into_iter().map(sanitize_value).collect())
        }
        serde_json::Value::String(s) => serde_json::json!(sanitize_string(&s)),
        other => other,
    }
}

fn sanitize_string(value: &str) -> String {
    let mut out = value.to_string();
    for marker in [
        "api_key=",
        "apikey=",
        "token=",
        "secret=",
        "password=",
        "client_secret=",
    ] {
        if let Some(idx) = out.to_ascii_lowercase().find(marker) {
            let end = out[idx + marker.len()..]
                .find(|ch: char| ch.is_whitespace() || ch == ',' || ch == ';' || ch == '&')
                .map(|rel| idx + marker.len() + rel)
                .unwrap_or(out.len());
            out.replace_range(idx + marker.len()..end, "[REDACTED]");
        }
    }
    out
}

fn parse_audit_event(line: &str) -> Option<serde_json::Value> {
    let mut value = serde_json::from_str::<serde_json::Value>(line).ok()?;
    if !value.is_object() {
        return None;
    }
    if let Some(data) = value.get_mut("data") {
        *data = sanitize_value(std::mem::take(data));
    }
    Some(value)
}

/// GET /api/plugins
pub async fn list(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    Json(serde_json::json!({"plugins": [plugin_record(&state)]}))
}

/// GET /api/plugins/prompt-contributions
pub async fn prompt_contributions(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    let contributions = if read_enabled(&state) {
        vec![prompt_contribution()]
    } else {
        Vec::new()
    };
    Json(serde_json::json!({"activeCount": contributions.len(), "contributions": contributions}))
}

/// GET /api/plugins/audit
pub async fn audit(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Query(query): Query<AuditQuery>,
) -> Response {
    if let Err(resp) = require_audit_read(&state, peer, &headers) {
        return resp;
    }
    let limit = parse_limit(query.limit.as_deref());
    let since = parse_time(query.since.as_deref());
    let until = parse_time(query.until.as_deref());
    let path = audit_path(&state).ok();
    let mut events = Vec::new();

    if let Some(path) = path {
        // lgtm[rust/path-injection] audit_path resolves a constant audit file under the canonical Signet workspace root via workspace_paths::child_file.
        if let Ok(raw) = std::fs::read_to_string(path) {
            for line in raw.lines().filter(|line| !line.trim().is_empty()) {
                let Some(event) = parse_audit_event(line) else {
                    continue;
                };
                if query.plugin_id.as_ref().is_some_and(|id| {
                    event.get("pluginId").and_then(|v| v.as_str()) != Some(id.as_str())
                }) {
                    continue;
                }
                if query.event.as_ref().is_some_and(|name| {
                    event.get("event").and_then(|v| v.as_str()) != Some(name.as_str())
                }) {
                    continue;
                }
                if since.as_ref().is_some_and(|since| {
                    event
                        .get("timestamp")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default()
                        < since.as_str()
                }) {
                    continue;
                }
                if until.as_ref().is_some_and(|until| {
                    event
                        .get("timestamp")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default()
                        > until.as_str()
                }) {
                    continue;
                }
                events.push(event);
            }
        }
    }

    events.sort_by(|a, b| {
        b.get("timestamp")
            .and_then(|v| v.as_str())
            .cmp(&a.get("timestamp").and_then(|v| v.as_str()))
    });
    events.truncate(limit);
    Json(serde_json::json!({"count": events.len(), "events": events})).into_response()
}

/// GET /api/plugins/:id/diagnostics
pub async fn diagnostics(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    if id != SIGNET_SECRETS_PLUGIN_ID {
        return (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"error": "Plugin not found"})),
        )
            .into_response();
    }
    (
        StatusCode::OK,
        Json(serde_json::json!({"plugin": plugin_diagnostics(&state)})),
    )
        .into_response()
}

/// GET /api/plugins/:id
pub async fn get(State(state): State<Arc<AppState>>, Path(id): Path<String>) -> impl IntoResponse {
    if id != SIGNET_SECRETS_PLUGIN_ID {
        return (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"error": "Plugin not found"})),
        )
            .into_response();
    }
    (StatusCode::OK, Json(plugin_record(&state))).into_response()
}

/// PATCH /api/plugins/:id
pub async fn patch(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<PatchPluginBody>,
) -> impl IntoResponse {
    if let Err(resp) = require_admin_mutation(&state, peer, &headers) {
        return resp;
    }
    if id != SIGNET_SECRETS_PLUGIN_ID {
        return (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"error": "Plugin not found"})),
        )
            .into_response();
    }
    let Some(enabled) = body.enabled.as_ref().and_then(parse_enabled) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "enabled is required"})),
        )
            .into_response();
    };
    if let Err(error) = write_enabled(&state, enabled) {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": error})),
        )
            .into_response();
    }
    // Ensure plugin directory exists even if registry write used a preexisting parent.
    let _ = plugin_dir(&state);
    (
        StatusCode::OK,
        Json(serde_json::json!({"plugin": plugin_record(&state)})),
    )
        .into_response()
}

fn require_admin_mutation(
    state: &AppState,
    peer: SocketAddr,
    headers: &HeaderMap,
) -> Result<(), Response> {
    let is_local = peer.ip().is_loopback();
    let auth = authenticate_headers(
        state.auth_mode,
        state.auth_secret.as_deref(),
        headers,
        is_local,
    )
    .map_err(|resp| *resp)?;
    require_permission_guard(&auth, Permission::Admin, state.auth_mode, is_local)
        .map_err(|resp| *resp)
}

fn require_audit_read(
    state: &AppState,
    peer: SocketAddr,
    headers: &HeaderMap,
) -> Result<(), Response> {
    let is_local = peer.ip().is_loopback();
    let auth = authenticate_headers(
        state.auth_mode,
        state.auth_secret.as_deref(),
        headers,
        is_local,
    )
    .map_err(|resp| *resp)?;
    require_permission_guard(&auth, Permission::Analytics, state.auth_mode, is_local)
        .map_err(|resp| *resp)
}
