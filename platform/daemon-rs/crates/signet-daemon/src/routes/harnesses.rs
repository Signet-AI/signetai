use std::path::PathBuf;
use std::sync::Arc;

use axum::{Json, extract::State};
use serde_json::json;

use crate::state::AppState;

fn home_dir() -> std::path::PathBuf {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| std::path::PathBuf::from("."))
}

fn resolve_safe_agents_dir(base_path: &std::path::Path) -> Option<PathBuf> {
    base_path.canonicalize().ok()
}

pub async fn list(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    let home = home_dir();
    let safe_agents_dir = resolve_safe_agents_dir(&state.config.base_path);
    let openclaw_path = safe_agents_dir
        .as_ref()
        .map(|dir| dir.join("AGENTS.md"))
        .unwrap_or_else(|| state.config.base_path.join("AGENTS.md"));
    let openclaw_exists = safe_agents_dir
        .as_ref()
        .map(|dir| dir.join("AGENTS.md").exists())
        .unwrap_or(false);
    let claude_last_seen = state.harness_last_seen("claude-code").await;
    let opencode_last_seen = state.harness_last_seen("opencode").await;
    let openclaw_last_seen = state.harness_last_seen("openclaw").await;

    let harnesses = vec![
        json!({
            "name": "Claude Code",
            "id": "claude-code",
            "path": home.join(".claude").join("settings.json"),
            "exists": home.join(".claude").join("settings.json").exists(),
            "lastSeen": claude_last_seen,
        }),
        json!({
            "name": "OpenCode",
            "id": "opencode",
            "path": home.join(".config").join("opencode").join("AGENTS.md"),
            "exists": home.join(".config").join("opencode").join("AGENTS.md").exists(),
            "lastSeen": opencode_last_seen,
        }),
        json!({
            "name": "OpenClaw",
            "id": "openclaw",
            "path": openclaw_path,
            "exists": openclaw_exists,
            "lastSeen": openclaw_last_seen,
        }),
    ];

    Json(json!({ "harnesses": harnesses }))
}
