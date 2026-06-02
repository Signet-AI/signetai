//! GraphIQ management routes.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use axum::{
    Json,
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde::Deserialize;
use serde_json::json;

use crate::state::AppState;
use crate::workspace_paths;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexRequest {
    path: Option<String>,
}

pub async fn status(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    let graphiq_state = read_graphiq_state(&state);
    let active_project = graphiq_state
        .get("activeProject")
        .cloned()
        .or_else(|| {
            graphiq_state
                .get("indexedProjects")
                .and_then(serde_json::Value::as_array)
                .and_then(|projects| projects.first())
                .and_then(|project| project.get("path"))
                .cloned()
        })
        .unwrap_or(serde_json::Value::Null);
    let indexed_projects = graphiq_state
        .get("indexedProjects")
        .cloned()
        .unwrap_or_else(|| json!([]));
    let install_source = graphiq_state
        .get("installSource")
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    let plugin_enabled = graphiq_state
        .get("enabled")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);

    Json(json!({
        "installed": graphiq_binary().is_some(),
        "pluginEnabled": plugin_enabled,
        "pluginState": if plugin_enabled { "active" } else { "not-registered" },
        "activeProject": active_project,
        "indexedProjects": indexed_projects,
        "installSource": install_source,
    }))
}

pub async fn install(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    if graphiq_binary().is_some() {
        if let Err(error) = enable_graphiq_state(&state, Some("existing"), None) {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"success": false, "error": error})),
            );
        }
        return (
            StatusCode::OK,
            Json(json!({"success": true, "message": "GraphIQ already installed, plugin enabled"})),
        );
    }

    match run_install_script("install", Duration::from_secs(120)).await {
        Ok(output) if output.status.success() && graphiq_binary().is_some() => {
            if let Err(error) = enable_graphiq_state(&state, Some("script"), None) {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(json!({"success": false, "error": error})),
                );
            }
            (
                StatusCode::OK,
                Json(
                    json!({"success": true, "message": "GraphIQ installed via script", "source": "script"}),
                ),
            )
        }
        Ok(output) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(
                json!({"success": false, "error": command_error(&output, "install script failed")}),
            ),
        ),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"success": false, "error": error})),
        ),
    }
}

pub async fn update() -> impl IntoResponse {
    match run_install_script("update", Duration::from_secs(120)).await {
        Ok(output) if output.status.success() => (
            StatusCode::OK,
            Json(json!({"success": true, "message": "GraphIQ updated via script"})),
        ),
        Ok(output) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(
                json!({"success": false, "error": command_error(&output, "update script failed")}),
            ),
        ),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"success": false, "error": error})),
        ),
    }
}

pub async fn uninstall(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    let _ = disable_graphiq_state(&state);
    Json(json!({"success": true, "message": "GraphIQ plugin disabled"}))
}

pub async fn index(State(state): State<Arc<AppState>>, Json(req): Json<IndexRequest>) -> Response {
    let Some(raw_path) = req.path.map(|path| path.trim().to_string()) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"success": false, "error": "path is required"})),
        )
            .into_response();
    };
    if raw_path.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"success": false, "error": "path is required"})),
        )
            .into_response();
    }

    let requested = PathBuf::from(raw_path);
    let resolved = if requested.is_absolute() {
        requested
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(requested)
    };
    if !resolved.exists() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "success": false,
                "error": format!("Project path does not exist: {}", resolved.display()),
            })),
        )
            .into_response();
    }
    if !resolved.is_dir() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "success": false,
                "error": format!("Project path must be a directory: {}", resolved.display()),
            })),
        )
            .into_response();
    }
    if graphiq_binary().is_none() {
        match run_install_script("install", Duration::from_secs(120)).await {
            Ok(output) if output.status.success() && graphiq_binary().is_some() => {
                let _ = enable_graphiq_state(&state, Some("script"), None);
            }
            Ok(output) => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(json!({
                        "success": false,
                        "error": format!("GraphIQ not installed: {}", command_error(&output, "install script failed")),
                    })),
                )
                    .into_response();
            }
            Err(error) => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(json!({"success": false, "error": format!("GraphIQ not installed: {error}")})),
                )
                    .into_response();
            }
        }
    }
    let Some(binary) = graphiq_binary() else {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"success": false, "error": "GraphIQ binary not found after install"})),
        )
            .into_response();
    };

    let db_dir = resolved.join(".graphiq");
    let db_path = db_dir.join("graphiq.db");
    let output = match tokio::time::timeout(
        Duration::from_secs(300),
        tokio::process::Command::new(binary)
            .arg("index")
            .arg(&resolved)
            .arg("--db")
            .arg(&db_path)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output(),
    )
    .await
    {
        Ok(Ok(output)) => output,
        Ok(Err(error)) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"success": false, "error": error.to_string()})),
            )
                .into_response();
        }
        Err(_) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"success": false, "error": "Timed out after 300000ms"})),
            )
                .into_response();
        }
    };
    if !output.status.success() {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(
                json!({"success": false, "error": command_error(&output, "graphiq index failed")}),
            ),
        )
            .into_response();
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stats = parse_index_stats(&stdout);
    if let Err(error) = enable_graphiq_state(&state, None, Some((&resolved, &db_path, &stats))) {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"success": false, "error": error})),
        )
            .into_response();
    }
    (
        StatusCode::OK,
        Json(json!({"success": true, "project": resolved, "stats": stats})),
    )
        .into_response()
}

fn graphiq_binary() -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_var) {
        let candidate = dir.join("graphiq");
        if is_executable(&candidate) {
            return Some(candidate);
        }
    }
    let candidate = PathBuf::from(std::env::var_os("HOME")?)
        .join(".local")
        .join("bin")
        .join("graphiq");
    is_executable(&candidate).then_some(candidate)
}

fn is_executable(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        path.metadata()
            .map(|metadata| metadata.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        true
    }
}

fn install_script_path() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("SIGNET_GRAPHIQ_INSTALL_SCRIPT").map(PathBuf::from)
        && path.is_file()
    {
        return Some(path);
    }
    let mut candidates = Vec::new();
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("scripts/install-graphiq.sh"));
        candidates.push(cwd.join("../../scripts/install-graphiq.sh"));
    }
    if let Ok(exe) = std::env::current_exe()
        && let Some(dir) = exe.parent()
    {
        candidates.push(dir.join("../scripts/install-graphiq.sh"));
        candidates.push(dir.join("../../scripts/install-graphiq.sh"));
    }
    candidates.into_iter().find(|path| path.is_file())
}

async fn run_install_script(
    action: &str,
    timeout: Duration,
) -> Result<std::process::Output, String> {
    let script = install_script_path()
        .ok_or_else(|| "Install script not found: scripts/install-graphiq.sh".to_string())?;
    tokio::time::timeout(
        timeout,
        tokio::process::Command::new("bash")
            .arg(script)
            .arg(action)
            .env("GRAPHIQ_ALLOW_LATEST", "1")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output(),
    )
    .await
    .map_err(|_| format!("Timed out after {}ms", timeout.as_millis()))?
    .map_err(|error| error.to_string())
}

fn command_error(output: &std::process::Output, fallback: &str) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if !stderr.is_empty() {
        return stderr;
    }
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !stdout.is_empty() {
        return stdout;
    }
    output
        .status
        .code()
        .map(|code| format!("{fallback}: exited with code {code}"))
        .unwrap_or_else(|| fallback.to_string())
}

fn parse_index_stats(output: &str) -> serde_json::Value {
    let tokens = output.split_whitespace().collect::<Vec<_>>();
    let read_after = |label: &str| {
        tokens
            .iter()
            .position(|token| token.trim_end_matches(':') == label)
            .and_then(|index| tokens.get(index + 1))
            .and_then(|value| value.parse::<u64>().ok())
    };
    let mut stats = serde_json::Map::new();
    if let Some(files) = read_after("Files") {
        stats.insert("files".to_string(), json!(files));
    }
    if let Some(symbols) = read_after("Symbols") {
        stats.insert("symbols".to_string(), json!(symbols));
    }
    if let Some(edges) = read_after("Edges") {
        stats.insert("edges".to_string(), json!(edges));
    }
    serde_json::Value::Object(stats)
}

fn read_graphiq_state(state: &AppState) -> serde_json::Value {
    let Ok(path) = workspace_paths::child_file(
        &state.config.base_path,
        &[".daemon", "graphiq", "state.json"],
    ) else {
        return empty_graphiq_state();
    };
    std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .unwrap_or_else(empty_graphiq_state)
}

fn empty_graphiq_state() -> serde_json::Value {
    json!({
        "pluginId": "signet.graphiq",
        "enabled": false,
        "managedBy": "signet",
        "indexedProjects": [],
        "updatedAt": chrono::Utc::now().to_rfc3339(),
    })
}

fn write_graphiq_state(state: &AppState, body: serde_json::Value) -> Result<(), String> {
    let path = workspace_paths::child_file(
        &state.config.base_path,
        &[".daemon", "graphiq", "state.json"],
    )
    .map_err(|error| error.to_string())?;
    std::fs::write(
        path,
        format!(
            "{}\n",
            serde_json::to_string_pretty(&body).map_err(|error| error.to_string())?
        ),
    )
    .map_err(|error| error.to_string())
}

fn enable_graphiq_state(
    state: &AppState,
    install_source: Option<&str>,
    project: Option<(&Path, &Path, &serde_json::Value)>,
) -> Result<(), String> {
    let now = chrono::Utc::now().to_rfc3339();
    let mut body = read_graphiq_state(state);
    body["pluginId"] = json!("signet.graphiq");
    body["enabled"] = json!(true);
    body["managedBy"] = json!("signet");
    body["updatedAt"] = json!(now.clone());
    if let Some(install_source) = install_source {
        body["installSource"] = json!(install_source);
    }
    if let Some((project_path, db_path, stats)) = project {
        let project_path = project_path.display().to_string();
        let mut project = serde_json::Map::new();
        project.insert("path".to_string(), json!(project_path));
        project.insert("dbPath".to_string(), json!(db_path.display().to_string()));
        project.insert("lastIndexedAt".to_string(), json!(now));
        if let Some(files) = stats.get("files") {
            project.insert("files".to_string(), files.clone());
        }
        if let Some(symbols) = stats.get("symbols") {
            project.insert("symbols".to_string(), symbols.clone());
        }
        if let Some(edges) = stats.get("edges") {
            project.insert("edges".to_string(), edges.clone());
        }
        body["activeProject"] = project
            .get("path")
            .cloned()
            .unwrap_or(serde_json::Value::Null);
        body["indexedProjects"] = json!([serde_json::Value::Object(project)]);
    }
    write_graphiq_state(state, body)
}

fn disable_graphiq_state(state: &AppState) -> Result<(), String> {
    let mut body = read_graphiq_state(state);
    body["pluginId"] = json!("signet.graphiq");
    body["enabled"] = json!(false);
    body["managedBy"] = json!("signet");
    body["updatedAt"] = json!(chrono::Utc::now().to_rfc3339());
    write_graphiq_state(state, body)
}
