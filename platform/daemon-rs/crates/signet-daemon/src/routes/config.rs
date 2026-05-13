//! Config, identity, and features route handlers.

use std::sync::Arc;

use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use serde::Deserialize;

use crate::state::AppState;
use crate::workspace_paths;

// ---------------------------------------------------------------------------
// GET /api/config
// ---------------------------------------------------------------------------

/// Priority order for config files in response.
const FILE_PRIORITY: &[&str] = &[
    "agent.yaml",
    "AGENTS.md",
    "SOUL.md",
    "IDENTITY.md",
    "USER.md",
];

pub async fn get_config(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    let dir = state.config.base_path.clone();

    let result = tokio::task::spawn_blocking(move || {
        let mut files = Vec::new();

        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => return serde_json::json!({"files": [], "error": "cannot read directory"}),
        };

        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if !name.ends_with(".md") && !name.ends_with(".yaml") && !name.ends_with(".yml") {
                continue;
            }

            let content = match std::fs::read_to_string(entry.path()) {
                Ok(c) => c,
                Err(_) => continue,
            };
            let size = content.len();
            files.push(serde_json::json!({
                "name": name,
                "content": content,
                "size": size,
            }));
        }

        // Sort by priority
        files.sort_by(|a, b| {
            let an = a["name"].as_str().unwrap_or("");
            let bn = b["name"].as_str().unwrap_or("");
            let ai = FILE_PRIORITY
                .iter()
                .position(|&p| p == an)
                .unwrap_or(usize::MAX);
            let bi = FILE_PRIORITY
                .iter()
                .position(|&p| p == bn)
                .unwrap_or(usize::MAX);
            ai.cmp(&bi).then_with(|| an.cmp(bn))
        });

        serde_json::json!({"files": files})
    })
    .await
    .unwrap_or_else(|_| serde_json::json!({"files": [], "error": "read failed"}));

    Json(result)
}

// ---------------------------------------------------------------------------
// POST /api/config
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct SaveConfigBody {
    pub file: String,
    pub content: String,
}

pub async fn save_config(
    State(state): State<Arc<AppState>>,
    Json(body): Json<SaveConfigBody>,
) -> impl IntoResponse {
    // Path traversal protection
    if body.file.contains('/') || body.file.contains('\\') || body.file.contains("..") {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "invalid file name"})),
        )
            .into_response();
    }

    if !body.file.ends_with(".md") && !body.file.ends_with(".yaml") && !body.file.ends_with(".yml")
    {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "only .md and .yaml files are allowed"})),
        )
            .into_response();
    }

    let path = match workspace_paths::config_file(&state.config.base_path, &body.file) {
        Ok(path) => path,
        Err(err) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"error": err.to_string()})),
            )
                .into_response();
        }
    };
    let content = body.content;

    match tokio::fs::write(&path, &content).await {
        Ok(()) => (StatusCode::OK, Json(serde_json::json!({"success": true}))).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e.to_string()})),
        )
            .into_response(),
    }
}

// ---------------------------------------------------------------------------
// GET /api/identity
// ---------------------------------------------------------------------------

pub async fn identity(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    let path = state.config.base_path.join("IDENTITY.md");

    let result = tokio::task::spawn_blocking(move || {
        let content = match std::fs::read_to_string(&path) {
            Ok(c) => c,
            Err(_) => {
                return serde_json::json!({
                    "name": "Unknown",
                    "creature": "",
                    "vibe": "",
                });
            }
        };

        let mut name = "Unknown".to_string();
        let mut creature = String::new();
        let mut vibe = String::new();

        for line in content.lines() {
            let trimmed = line.trim().trim_start_matches('-').trim();
            if let Some(val) = trimmed.strip_prefix("name:") {
                name = val.trim().to_string();
            } else if let Some(val) = trimmed.strip_prefix("creature:") {
                creature = val.trim().to_string();
            } else if let Some(val) = trimmed.strip_prefix("vibe:") {
                vibe = val.trim().to_string();
            }
        }

        serde_json::json!({
            "name": name,
            "creature": creature,
            "vibe": vibe,
        })
    })
    .await
    .unwrap_or_else(|_| {
        serde_json::json!({
            "name": "Unknown",
            "creature": "",
            "vibe": "",
        })
    });

    Json(result)
}

// ---------------------------------------------------------------------------
// GET /api/features
// ---------------------------------------------------------------------------

pub async fn features(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    let flags = state
        .config
        .manifest
        .features
        .as_ref()
        .map(|features| {
            features
                .iter()
                .filter_map(|(key, value)| match value {
                    serde_json::Value::Bool(flag) => {
                        Some((key.clone(), serde_json::Value::Bool(*flag)))
                    }
                    serde_json::Value::String(value) if value == "true" => {
                        Some((key.clone(), serde_json::Value::Bool(true)))
                    }
                    serde_json::Value::String(value) if value == "false" => {
                        Some((key.clone(), serde_json::Value::Bool(false)))
                    }
                    _ => None,
                })
                .collect::<serde_json::Map<String, serde_json::Value>>()
        })
        .unwrap_or_default();

    Json(serde_json::Value::Object(flags))
}
