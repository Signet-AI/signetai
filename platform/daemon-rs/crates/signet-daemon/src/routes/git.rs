//! Git sync routes.
//!
//! Status, push, pull, sync, and remote config endpoints.

use std::sync::Arc;

use axum::{Json, extract::State, http::StatusCode, response::IntoResponse};

use crate::state::AppState;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn agents_dir(state: &AppState) -> std::path::PathBuf {
    state.config.base_path.clone()
}

async fn git_cmd(state: &AppState, args: &[&str]) -> Result<String, String> {
    let cwd = agents_dir(state);
    let output = tokio::process::Command::new("git")
        .args(args)
        .current_dir(&cwd)
        .output()
        .await
        .map_err(|e| format!("git exec: {e}"))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(format!("git error: {stderr}"))
    }
}

async fn is_git_repo(state: &AppState) -> bool {
    git_cmd(state, &["rev-parse", "--is-inside-work-tree"])
        .await
        .map(|output| output == "true")
        .unwrap_or(false)
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

/// GET /api/git/status
pub async fn status(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let branch = git_cmd(&state, &["rev-parse", "--abbrev-ref", "HEAD"])
        .await
        .unwrap_or_else(|_| "unknown".into());
    let clean = git_cmd(&state, &["status", "--porcelain"])
        .await
        .map(|s| s.is_empty())
        .unwrap_or(false);
    let remote = git_cmd(&state, &["remote", "get-url", "origin"])
        .await
        .unwrap_or_default();
    let last_commit = git_cmd(&state, &["log", "-1", "--format=%H %s"])
        .await
        .unwrap_or_default();

    (
        StatusCode::OK,
        Json(serde_json::json!({
            "branch": branch,
            "clean": clean,
            "remote": remote,
            "lastCommit": last_commit,
            "initialized": !branch.is_empty() && branch != "unknown",
        })),
    )
}

/// POST /api/git/pull
pub async fn pull(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    if !is_git_repo(&state).await {
        return (
            StatusCode::OK,
            Json(serde_json::json!({"success": false, "message": "Not a git repository"})),
        );
    }

    match git_cmd(&state, &["pull", "--rebase"]).await {
        Ok(output) => (
            StatusCode::OK,
            Json(serde_json::json!({"success": true, "message": output})),
        ),
        Err(e) => (
            StatusCode::OK,
            Json(
                serde_json::json!({"success": false, "message": format!("Git pull unavailable: {e}")}),
            ),
        ),
    }
}

/// POST /api/git/push
pub async fn push(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    if !is_git_repo(&state).await {
        return (
            StatusCode::OK,
            Json(serde_json::json!({"success": false, "message": "Not a git repository"})),
        );
    }

    match git_cmd(&state, &["push"]).await {
        Ok(output) => (
            StatusCode::OK,
            Json(serde_json::json!({"success": true, "message": output})),
        ),
        Err(e) => (
            StatusCode::OK,
            Json(
                serde_json::json!({"success": false, "message": format!("Git push unavailable: {e}")}),
            ),
        ),
    }
}

/// POST /api/git/sync — pull then push
pub async fn sync(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let pull_result = git_cmd(&state, &["pull", "--rebase"]).await;
    let push_result = git_cmd(&state, &["push"]).await;

    (
        StatusCode::OK,
        Json(serde_json::json!({
            "pull": match &pull_result {
                Ok(o) => serde_json::json!({"success": true, "output": o}),
                Err(e) => serde_json::json!({"success": false, "error": e}),
            },
            "push": match &push_result {
                Ok(o) => serde_json::json!({"success": true, "output": o}),
                Err(e) => serde_json::json!({"success": false, "error": e}),
            },
        })),
    )
}

/// GET /api/git/config
pub async fn get_config(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    Json(
        serde_json::to_value(state.git_config.read().await.clone()).unwrap_or_else(|_| {
            serde_json::json!({
                "enabled": true,
                "autoCommit": false,
                "autoSync": false,
                "syncInterval": 300,
                "remote": "origin",
                "branch": "main",
            })
        }),
    )
}

/// POST /api/git/config — update git config
pub async fn set_config(
    State(state): State<Arc<AppState>>,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    let mut config = state.git_config.write().await;
    config.apply_patch(&body);
    let body = serde_json::to_value(config.clone()).unwrap_or_else(|_| serde_json::json!({}));
    (
        StatusCode::OK,
        Json(serde_json::json!({"success": true, "config": body})),
    )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    #[test]
    fn default_git_config() {
        let config = crate::state::GitRuntimeConfig::default();
        assert!(!config.auto_sync);
        assert_eq!(config.remote, "origin");
    }
}
