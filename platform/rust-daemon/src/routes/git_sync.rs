//! Current git configuration boundary. Git mutation is intentionally unsupported here.
use crate::{routes::auth, ApiError, AppState};
use axum::{extract::State, http::HeaderMap, routing::get, Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{fs, path::Path};

const MAX_CONFIG_BYTES: u64 = 64 * 1024;

#[derive(Debug, Serialize)]
pub(crate) struct GitConfigResponse {
    pub enabled: bool,
    #[serde(rename = "autoCommit")]
    pub auto_commit: bool,
    #[serde(rename = "autoSync")]
    pub auto_sync: bool,
    #[serde(rename = "syncInterval")]
    pub sync_interval: u64,
    pub remote: String,
    pub branch: String,
}

#[derive(Debug, Deserialize)]
struct GitConfigPatch {
    enabled: Option<bool>,
    #[serde(rename = "autoCommit")]
    auto_commit: Option<bool>,
    #[serde(rename = "autoSync")]
    auto_sync: Option<bool>,
    #[serde(rename = "syncInterval")]
    sync_interval: Option<u64>,
    remote: Option<String>,
    branch: Option<String>,
}

pub(crate) fn router() -> Router<AppState> {
    Router::new().route("/api/git/config", get(config).post(update_config))
}

async fn authorize(state: &AppState, headers: &HeaderMap) -> Result<(), ApiError> {
    let claims = auth::gate(state, headers).await?;
    let admin = claims.get("role").and_then(Value::as_str) == Some("admin");
    let permitted = claims
        .get("permissions")
        .and_then(Value::as_array)
        .is_some_and(|items| {
            items.iter().any(|item| {
                matches!(
                    item.as_str(),
                    Some("admin") | Some("git:read") | Some("git:write")
                )
            })
        });
    if !admin && !permitted {
        return Err(ApiError {
            status: axum::http::StatusCode::FORBIDDEN,
            code: "forbidden",
            message: "git administration capability is required".into(),
        });
    }
    Ok(())
}

async fn config(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<GitConfigResponse>, ApiError> {
    authorize(&state, &headers).await?;
    let mut result = GitConfigResponse {
        enabled: true,
        auto_commit: false,
        auto_sync: false,
        sync_interval: 300,
        remote: "origin".into(),
        branch: "main".into(),
    };
    let path = state.workspace.join("agent.yaml");
    if let Ok(meta) = fs::symlink_metadata(&path) {
        if meta.file_type().is_symlink() || !meta.is_file() {
            return Err(ApiError::bad_request(
                "git configuration path must be a regular file",
            ));
        }
        if meta.len() > MAX_CONFIG_BYTES {
            return Err(ApiError::bad_request(
                "git configuration exceeds the size limit",
            ));
        }
        let content = fs::read_to_string(&path)
            .map_err(|_| ApiError::unavailable("git configuration could not be read"))?;
        parse_config(&content, &mut result);
    }
    Ok(Json(result))
}

async fn update_config(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(patch): Json<GitConfigPatch>,
) -> Result<Json<Value>, ApiError> {
    authorize(&state, &headers).await?;
    let _ = (state, patch);
    Err(ApiError::not_implemented("git-config-update: runtime git configuration persistence and timer lifecycle are not implemented natively"))
}

fn parse_config(content: &str, result: &mut GitConfigResponse) {
    let mut in_git = false;
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed == "git:" {
            in_git = true;
            continue;
        }
        if in_git && !line.starts_with(' ') && !line.starts_with('\t') {
            in_git = false;
        }
        if !in_git {
            continue;
        }
        let Some((key, raw)) = trimmed.split_once(':') else {
            continue;
        };
        let value = raw.trim().trim_matches(['"', '\'']);
        match key {
            "enabled" => result.enabled = value == "true",
            "autoCommit" => result.auto_commit = value == "true",
            "autoSync" => result.auto_sync = value == "true",
            "syncInterval" => {
                if let Ok(v) = value.parse::<u64>() {
                    result.sync_interval = v.clamp(60, 86400);
                }
            }
            "remote" if !value.is_empty() => result.remote = value.into(),
            "branch" if !value.is_empty() => result.branch = value.into(),
            _ => {}
        }
    }
}

#[allow(dead_code)]
fn _path_is_workspace_relative(workspace: &Path, path: &Path) -> bool {
    path.strip_prefix(workspace).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn config_parser_clamps_interval_and_keeps_defaults() {
        let mut c = GitConfigResponse {
            enabled: true,
            auto_commit: false,
            auto_sync: false,
            sync_interval: 300,
            remote: "origin".into(),
            branch: "main".into(),
        };
        parse_config("git:\n  syncInterval: 1\n  autoSync: true\n", &mut c);
        assert_eq!(c.sync_interval, 60);
        assert!(c.auto_sync);
    }
}
