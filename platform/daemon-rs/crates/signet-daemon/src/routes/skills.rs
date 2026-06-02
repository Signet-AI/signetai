//! Skill library routes.
//!
//! Provides the filesystem-backed skill read/list/delete API that the TS daemon
//! exposes for dashboard and harness clients.

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use axum::{
    Json,
    extract::{ConnectInfo, Path as AxumPath, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use serde::Deserialize;
use serde_json::json;
use tokio::process::Command;

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

#[derive(Debug, Clone, PartialEq, Eq)]
struct SkillInstallCommand {
    command: String,
    args: Vec<String>,
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
    if validate_install_name(name).is_err() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "Invalid skill name"})),
        )
            .into_response();
    }

    let Some(command) = build_skill_install_command(name, req.source.as_deref()) else {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({
                "success": false,
                "error": "ClawHub skill installation is not yet implemented by the Rust daemon"
            })),
        )
            .into_response();
    };

    match run_skill_install_command(command).await {
        Ok(output) => Json(json!({
            "success": true,
            "name": name,
            "output": output
        }))
        .into_response(),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({
                "success": false,
                "error": error
            })),
        )
            .into_response(),
    }
}

fn build_skill_install_command(name: &str, source: Option<&str>) -> Option<SkillInstallCommand> {
    build_skill_install_command_for_family(name, source, &preferred_package_manager())
}

fn build_skill_install_command_for_family(
    name: &str,
    source: Option<&str>,
    family: &str,
) -> Option<SkillInstallCommand> {
    if source.is_some_and(|value| value.starts_with("clawhub@")) {
        return None;
    }

    let pkg = source
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(name);
    let mut skills_args = vec![
        "add".to_string(),
        pkg.to_string(),
        "--global".to_string(),
        "--yes".to_string(),
    ];
    if source.is_some_and(|value| value != name && is_simple_owner_repo(value)) {
        skills_args.push("--skill".to_string());
        skills_args.push(name.to_string());
    }

    let (command, args) = match family {
        "bun" => {
            let mut args = vec!["skills".to_string()];
            args.extend(skills_args);
            ("bunx".to_string(), args)
        }
        "pnpm" => {
            let mut args = vec!["dlx".to_string(), "skills".to_string()];
            args.extend(skills_args);
            ("pnpm".to_string(), args)
        }
        "yarn" => {
            let mut args = vec!["dlx".to_string(), "skills".to_string()];
            args.extend(skills_args);
            ("yarn".to_string(), args)
        }
        _ => {
            let mut args = vec![
                "exec".to_string(),
                "--yes".to_string(),
                "--".to_string(),
                "skills".to_string(),
            ];
            args.extend(skills_args);
            ("npm".to_string(), args)
        }
    };

    Some(SkillInstallCommand { command, args })
}

fn preferred_package_manager() -> String {
    if let Ok(user_agent) = std::env::var("npm_config_user_agent") {
        for family in ["bun", "pnpm", "yarn", "npm"] {
            if user_agent.starts_with(family) && command_exists(command_for_family(family)) {
                return family.to_string();
            }
        }
    }
    for family in ["bun", "pnpm", "yarn", "npm"] {
        if command_exists(command_for_family(family)) {
            return family.to_string();
        }
    }
    "npm".to_string()
}

fn command_for_family(family: &str) -> &str {
    match family {
        "bun" => "bunx",
        "pnpm" => "pnpm",
        "yarn" => "yarn",
        _ => "npm",
    }
}

fn command_exists(command: &str) -> bool {
    let Some(path) = std::env::var_os("PATH") else {
        return false;
    };
    std::env::split_paths(&path).any(|dir| dir.join(command).is_file())
}

async fn run_skill_install_command(command: SkillInstallCommand) -> Result<String, String> {
    let child = Command::new(&command.command)
        .args(&command.args)
        .kill_on_drop(true)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|err| err.to_string())?;

    let output = match tokio::time::timeout(Duration::from_secs(60), child.wait_with_output()).await
    {
        Ok(result) => result.map_err(|err| err.to_string())?,
        Err(_) => return Err("Install timed out".to_string()),
    };

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    if output.status.success() {
        Ok(stdout)
    } else {
        let message = if !stderr.trim().is_empty() {
            stderr
        } else if !stdout.trim().is_empty() {
            stdout
        } else {
            format!(
                "Install exited with code {}",
                output
                    .status
                    .code()
                    .map_or_else(|| "unknown".to_string(), |code| code.to_string())
            )
        };
        Err(message)
    }
}

fn require_admin_mutation(
    state: &AppState,
    peer: SocketAddr,
    headers: &HeaderMap,
) -> Result<(), Response> {
    let is_local = peer.ip().is_loopback();
    let auth_runtime = state.auth_snapshot();
    let auth = authenticate_headers(
        auth_runtime.mode,
        auth_runtime.secret.as_deref(),
        headers,
        is_local,
    )
    .map_err(|resp| *resp)?;
    require_permission_guard(&auth, Permission::Admin, auth_runtime.mode, is_local)
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

fn validate_install_name(name: &str) -> Result<(), ()> {
    if name.contains('\\') || name.contains("..") || name.trim().is_empty() {
        return Err(());
    }
    if !name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '/'))
    {
        return Err(());
    }
    Ok(())
}

fn is_simple_owner_repo(value: &str) -> bool {
    let mut parts = value.split('/');
    let Some(owner) = parts.next() else {
        return false;
    };
    let Some(repo) = parts.next() else {
        return false;
    };
    parts.next().is_none()
        && !owner.is_empty()
        && !repo.is_empty()
        && owner
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
        && repo
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skill_install_command_matches_ts_bun_skills_cli_plan() {
        let cmd =
            build_skill_install_command_for_family("web-search", Some("Signet-AI/signetai"), "bun")
                .unwrap();
        assert_eq!(cmd.command, "bunx");
        assert_eq!(
            cmd.args,
            vec![
                "skills",
                "add",
                "Signet-AI/signetai",
                "--global",
                "--yes",
                "--skill",
                "web-search"
            ]
        );
    }

    #[test]
    fn skill_install_command_keeps_skills_sh_sources_on_package_arg() {
        let cmd = build_skill_install_command_for_family(
            "web-search",
            Some("inference-skills/skills@web-search"),
            "bun",
        )
        .unwrap();
        assert_eq!(
            cmd.args,
            vec![
                "skills",
                "add",
                "inference-skills/skills@web-search",
                "--global",
                "--yes"
            ]
        );
    }

    #[test]
    fn install_name_allows_repo_form_but_blocks_traversal() {
        assert!(validate_install_name("owner/repo").is_ok());
        assert!(validate_install_name("../repo").is_err());
        assert!(validate_install_name("bad\\repo").is_err());
    }
}
