use std::sync::Arc;

use axum::{Json, extract::State, http::StatusCode, response::IntoResponse};
use serde_json::json;
use tokio::process::Command;

use crate::state::AppState;

fn home_dir() -> std::path::PathBuf {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| std::path::PathBuf::from("."))
}

pub async fn list(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    let home = home_dir();
    let claude_path = home.join(".claude").join("settings.json");
    let opencode_path = home.join(".config").join("opencode").join("AGENTS.md");
    let openclaw_path = state.config.base_path.join("AGENTS.md");
    let gemini_path = home.join(".gemini").join("settings.json");
    let claude_exists = claude_path.exists();
    let opencode_exists = opencode_path.exists();
    let openclaw_exists = openclaw_path.exists();
    let gemini_exists = gemini_path.exists();
    let claude_last_seen = state.harness_last_seen("claude-code").await;
    let opencode_last_seen = state.harness_last_seen("opencode").await;
    let openclaw_last_seen = state.harness_last_seen("openclaw").await;
    let gemini_last_seen = state.harness_last_seen("gemini").await;

    let harnesses = vec![
        json!({
            "name": "Claude Code",
            "id": "claude-code",
            "path": claude_path,
            "exists": claude_exists,
            "lastSeen": claude_last_seen,
        }),
        json!({
            "name": "OpenCode",
            "id": "opencode",
            "path": opencode_path,
            "exists": opencode_exists,
            "lastSeen": opencode_last_seen,
        }),
        json!({
            "name": "OpenClaw",
            "id": "openclaw",
            "path": openclaw_path,
            "exists": openclaw_exists,
            "lastSeen": openclaw_last_seen,
        }),
        json!({
            "name": "Gemini CLI",
            "id": "gemini",
            "path": gemini_path,
            "exists": gemini_exists,
            "lastSeen": gemini_last_seen,
        }),
    ];

    Json(json!({ "harnesses": harnesses }))
}

pub async fn regenerate(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let script = state
        .config
        .base_path
        .join("scripts")
        .join("generate-harness-configs.py");

    if !script.exists() {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({"success": false, "error": "Regeneration script not found"})),
        );
    }

    let result = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        Command::new("python3")
            .arg(&script)
            .current_dir(&state.config.base_path)
            .output(),
    )
    .await;

    match result {
        Ok(Ok(output)) if output.status.success() => (
            StatusCode::OK,
            Json(json!({
                "success": true,
                "message": "Configs regenerated successfully",
                "output": String::from_utf8_lossy(&output.stdout).to_string(),
            })),
        ),
        Ok(Ok(output)) => {
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({
                    "success": false,
                    "error": if stderr.is_empty() {
                        format!("Script exited with code {}", output.status.code().unwrap_or(-1))
                    } else {
                        stderr
                    },
                })),
            )
        }
        Ok(Err(e)) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"success": false, "error": e.to_string()})),
        ),
        Err(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"success": false, "error": "Script exited with code -1"})),
        ),
    }
}
