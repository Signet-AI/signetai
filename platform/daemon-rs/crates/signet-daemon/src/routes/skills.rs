//! Skill library routes.
//!
//! Provides the filesystem-backed skill read/list/delete API that the TS daemon
//! exposes for dashboard and harness clients.

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::{
    Json,
    extract::{ConnectInfo, Path as AxumPath, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use serde::Deserialize;
use serde_json::json;

use crate::{
    auth::{
        middleware::{authenticate_headers, require_permission_guard},
        types::Permission,
    },
    state::AppState,
    workspace_paths,
};

#[derive(Debug, Deserialize)]
pub struct SearchQuery {
    q: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct InstallRequest {
    name: Option<String>,
    source: Option<String>,
}

pub async fn list(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    let skills = skills_dir(&state)
        .map(|dir| discover_skills(&dir))
        .unwrap_or_default();
    Json(json!({ "skills": skills, "count": skills.len() }))
}

pub async fn get(
    State(state): State<Arc<AppState>>,
    AxumPath(name): AxumPath<String>,
) -> impl IntoResponse {
    let Ok(name) = validate_skill_name(&name) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "Invalid skill name"})),
        )
            .into_response();
    };
    let skill_path = match skill_file(&state, &name) {
        Ok(path) => path,
        Err(err) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": err.to_string()})),
            )
                .into_response();
        }
    };
    // lgtm[rust/path-injection] skill_file is built from a validated skill name and canonical workspace root via workspace_paths::child_path.
    let Ok(content) = std::fs::read_to_string(&skill_path) else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({"error": format!("Skill not found: {name}")})),
        )
            .into_response();
    };
    let meta = parse_frontmatter(&content);
    Json(json!({
        "name": meta.name.unwrap_or(name),
        "description": meta.description.unwrap_or_default(),
        "version": meta.version.unwrap_or_default(),
        "content": content,
    }))
    .into_response()
}

pub async fn delete(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    AxumPath(name): AxumPath<String>,
) -> impl IntoResponse {
    if let Err(resp) = require_admin_mutation(&state, peer, &headers) {
        return resp;
    }
    let Ok(name) = validate_skill_name(&name) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "Invalid skill name"})),
        )
            .into_response();
    };
    let path = match skill_dir(&state, &name) {
        Ok(path) => path,
        Err(err) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": err.to_string()})),
            )
                .into_response();
        }
    };
    // lgtm[rust/path-injection] skill_dir is built from a validated skill name and canonical workspace root via workspace_paths::child_path.
    if !path.exists() {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({"error": format!("Skill not found: {name}")})),
        )
            .into_response();
    }
    // lgtm[rust/path-injection] skill_dir is built from a validated skill name and canonical workspace root via workspace_paths::child_path.
    if let Err(err) = std::fs::remove_dir_all(&path) {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": err.to_string()})),
        )
            .into_response();
    }
    Json(json!({"success": true, "name": name})).into_response()
}

pub async fn search(
    State(state): State<Arc<AppState>>,
    Query(query): Query<SearchQuery>,
) -> impl IntoResponse {
    let Some(q) = query
        .q
        .map(|q| q.trim().to_ascii_lowercase())
        .filter(|q| !q.is_empty())
    else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "Query parameter q is required"})),
        )
            .into_response();
    };
    let results: Vec<_> = skills_dir(&state)
        .map(|dir| discover_skills(&dir))
        .unwrap_or_default()
        .into_iter()
        .filter(|skill| skill.to_string().to_ascii_lowercase().contains(&q))
        .collect();
    Json(json!({"results": results, "count": results.len()})).into_response()
}

pub async fn browse(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    let results: Vec<_> = skills_dir(&state)
        .map(|dir| discover_skills(&dir))
        .unwrap_or_default()
        .into_iter()
        .map(|mut skill| {
            if let Some(obj) = skill.as_object_mut() {
                obj.insert("provider".to_string(), json!("local"));
                obj.insert("official".to_string(), json!(false));
                obj.insert("builtin".to_string(), json!(false));
                obj.insert("fullName".to_string(), json!("local"));
            }
            skill
        })
        .collect();
    Json(json!({"results": results, "count": results.len()}))
}

pub async fn install(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(req): Json<InstallRequest>,
) -> impl IntoResponse {
    if let Err(resp) = require_admin_mutation(&state, peer, &headers) {
        return resp;
    }
    let Some(name) = req.name.as_deref().map(str::trim).filter(|s| !s.is_empty()) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "name is required"})),
        )
            .into_response();
    };
    if validate_skill_name(name).is_err() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "Invalid skill name"})),
        )
            .into_response();
    }
    // Rust daemon parity: validate and acknowledge the install request without
    // shelling out from the daemon process. The TS tests assert that valid input
    // gets past validation; actual marketplace install remains an external CLI concern.
    (
        StatusCode::ACCEPTED,
        Json(json!({
            "success": false,
            "queued": false,
            "name": name,
            "source": req.source,
            "error": "skill installation is not executed by the Rust daemon"
        })),
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

fn skills_dir(state: &AppState) -> std::io::Result<PathBuf> {
    workspace_paths::child_dir(&state.config.base_path, &["skills"])
}

fn skill_dir(state: &AppState, name: &str) -> std::io::Result<PathBuf> {
    workspace_paths::child_path(&state.config.base_path, &["skills", name])
}

fn skill_file(state: &AppState, name: &str) -> std::io::Result<PathBuf> {
    workspace_paths::child_path(&state.config.base_path, &["skills", name, "SKILL.md"])
}

fn discover_skills(dir: &Path) -> Vec<serde_json::Value> {
    let mut out = vec![];
    let Ok(entries) = std::fs::read_dir(dir) else {
        return out;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Some(name) = path
            .file_name()
            .and_then(|s| s.to_str())
            .map(ToOwned::to_owned)
        else {
            continue;
        };
        let skill_md = path.join("SKILL.md");
        let content = std::fs::read_to_string(skill_md).unwrap_or_default();
        let meta = parse_frontmatter(&content);
        out.push(json!({
            "name": meta.name.unwrap_or(name),
            "description": meta.description.unwrap_or_default(),
            "version": meta.version.unwrap_or_default(),
            "path": path.to_string_lossy(),
        }));
    }
    out.sort_by_key(|v| v["name"].as_str().unwrap_or_default().to_string());
    out
}

#[derive(Default)]
struct SkillMeta {
    name: Option<String>,
    description: Option<String>,
    version: Option<String>,
}

fn parse_frontmatter(content: &str) -> SkillMeta {
    let mut meta = SkillMeta::default();
    let mut lines = content.lines();
    if lines.next() != Some("---") {
        return meta;
    }
    for line in lines {
        if line == "---" {
            break;
        }
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let value = value.trim().trim_matches('"').to_string();
        match key.trim() {
            "name" => meta.name = Some(value),
            "description" => meta.description = Some(value),
            "version" => meta.version = Some(value),
            _ => {}
        }
    }
    meta
}

fn validate_skill_name(name: &str) -> Result<String, ()> {
    if name.contains('/') || name.contains('\\') || name.contains("..") || name.trim().is_empty() {
        return Err(());
    }
    if !name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    {
        return Err(());
    }
    Ok(name.to_string())
}
