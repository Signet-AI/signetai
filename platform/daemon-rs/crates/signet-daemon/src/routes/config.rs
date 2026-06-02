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

fn provider_transitions_path(base_path: &std::path::Path) -> std::path::PathBuf {
    base_path.join(".daemon").join("provider-transitions.json")
}

const CONFIG_FILE_CANDIDATES: &[&str] = &["agent.yaml", "AGENT.yaml", "config.yaml"];

fn read_provider_transitions(
    base_path: &std::path::Path,
) -> (Vec<serde_json::Value>, Option<String>) {
    let path = provider_transitions_path(base_path);
    let content = match std::fs::read_to_string(path) {
        Ok(content) => content,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return (Vec::new(), None),
        Err(e) => return (Vec::new(), Some(e.to_string())),
    };
    match serde_json::from_str::<serde_json::Value>(&content) {
        Ok(serde_json::Value::Array(rows)) => (rows, None),
        Ok(_) => (
            Vec::new(),
            Some("Provider transition audit must be an array".into()),
        ),
        Err(e) => (Vec::new(), Some(e.to_string())),
    }
}

fn strip_actor(mut value: serde_json::Value) -> serde_json::Value {
    if let Some(obj) = value.as_object_mut() {
        obj.remove("actor");
    }
    value
}

fn provider_safety_snapshot(state: &AppState) -> serde_json::Value {
    let memory = state.config.manifest.memory.as_ref();
    let pipeline = memory.and_then(|memory| memory.pipeline_v2.as_ref());
    let extraction = pipeline.map(|pipeline| &pipeline.extraction);
    let synthesis = pipeline.map(|pipeline| &pipeline.synthesis);
    serde_json::json!({
        "extractionProvider": extraction.map(|config| config.provider.clone()),
        "extractionEndpoint": extraction.and_then(|config| config.endpoint.clone()),
        "synthesisProvider": synthesis.map(|config| config.provider.clone()),
        "synthesisEndpoint": synthesis.and_then(|config| config.endpoint.clone()),
        "allowRemoteProviders": true,
    })
}

/// GET /api/config/provider-safety
pub async fn provider_safety(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let (transitions, audit_error) = read_provider_transitions(&state.config.base_path);
    let public_transitions: Vec<serde_json::Value> =
        transitions.iter().cloned().map(strip_actor).collect();
    let latest_risky_transition = transitions
        .iter()
        .rev()
        .find(|entry| entry.get("risky").and_then(|value| value.as_bool()) == Some(true))
        .cloned()
        .map(strip_actor);

    (
        StatusCode::OK,
        Json(serde_json::json!({
            "snapshot": provider_safety_snapshot(&state),
            "snapshotError": serde_json::Value::Null,
            "transitions": public_transitions,
            "latestRiskyTransition": latest_risky_transition,
            "auditError": audit_error,
        })),
    )
}

fn rollback_role(body: &serde_json::Value) -> Result<Option<&str>, &'static str> {
    let Some(role) = body.get("role") else {
        return Ok(None);
    };
    match role.as_str() {
        Some("extraction") => Ok(Some("extraction")),
        Some("synthesis") => Ok(Some("synthesis")),
        _ => Err("role must be 'extraction' or 'synthesis'"),
    }
}

fn rollback_eligible(entry: &serde_json::Value, requested_role: Option<&str>) -> bool {
    let Some(obj) = entry.as_object() else {
        return false;
    };
    let role_ok = requested_role
        .map(|role| obj.get("role").and_then(|value| value.as_str()) == Some(role))
        .unwrap_or(true);
    role_ok
        && obj.get("from").and_then(|value| value.as_str()).is_some()
        && obj.get("rolledBack").and_then(|value| value.as_bool()) != Some(true)
        && obj.get("source").and_then(|value| value.as_str())
            != Some("api/config/provider-safety/rollback")
}

fn rollback_target_index(
    transitions: &[serde_json::Value],
    requested_role: Option<&str>,
) -> Option<usize> {
    transitions
        .iter()
        .enumerate()
        .rev()
        .find_map(|(index, entry)| rollback_eligible(entry, requested_role).then_some(index))
}

fn transition_string<'a>(entry: &'a serde_json::Value, key: &str) -> Option<&'a str> {
    entry.get(key).and_then(|value| value.as_str())
}

fn rollback_file_path(
    base_path: &std::path::Path,
    entry: &serde_json::Value,
) -> Result<std::path::PathBuf, (StatusCode, String)> {
    let source = transition_string(entry, "source").unwrap_or_default();
    let source_lower = source.to_lowercase();
    for candidate in CONFIG_FILE_CANDIDATES {
        if source_lower.ends_with(&candidate.to_lowercase()) {
            let actual_name = &source[source.len() - candidate.len()..];
            let path = base_path.join(actual_name);
            if path.exists() {
                return Ok(path);
            }
            return Err((
                StatusCode::NOT_FOUND,
                format!(
                    "Source config file '{actual_name}' not found; it may have been renamed or deleted since the transition was recorded"
                ),
            ));
        }
    }
    Err((
        StatusCode::NOT_FOUND,
        format!(
            "Transition source '{source}' does not match any known config file; cannot determine which file to roll back"
        ),
    ))
}

fn yaml_key(key: &str) -> serde_yml::Value {
    serde_yml::Value::String(key.to_string())
}

fn yaml_mapping_mut(value: &mut serde_yml::Value) -> Option<&mut serde_yml::Mapping> {
    match value {
        serde_yml::Value::Mapping(map) => Some(map),
        _ => None,
    }
}

fn remove_yaml_key(map: &mut serde_yml::Mapping, key: &str) {
    map.remove(yaml_key(key));
}

fn set_yaml_string(map: &mut serde_yml::Mapping, key: &str, value: &str) {
    map.insert(yaml_key(key), serde_yml::Value::String(value.to_string()));
}

fn apply_provider_rollback_yaml(
    content: &str,
    entry: &serde_json::Value,
) -> Result<String, (StatusCode, String)> {
    let previous = transition_string(entry, "from").ok_or_else(|| {
        (
            StatusCode::BAD_REQUEST,
            "No previous provider recorded for rollback".to_string(),
        )
    })?;
    let role = transition_string(entry, "role").ok_or_else(|| {
        (
            StatusCode::BAD_REQUEST,
            "Provider transition is missing role".to_string(),
        )
    })?;
    let mut root: serde_yml::Value = serde_yml::from_str(content).map_err(|err| {
        (
            StatusCode::BAD_REQUEST,
            format!("Invalid YAML config: {err}"),
        )
    })?;

    let Some(root_map) = yaml_mapping_mut(&mut root) else {
        return Err((StatusCode::BAD_REQUEST, "Invalid YAML config".to_string()));
    };
    let Some(memory) = root_map.get_mut(yaml_key("memory")) else {
        return Err((
            StatusCode::BAD_REQUEST,
            "No pipelineV2 section found in config".to_string(),
        ));
    };
    let Some(memory_map) = yaml_mapping_mut(memory) else {
        return Err((
            StatusCode::BAD_REQUEST,
            "No pipelineV2 section found in config".to_string(),
        ));
    };
    let Some(pipeline) = memory_map.get_mut(yaml_key("pipelineV2")) else {
        return Err((
            StatusCode::BAD_REQUEST,
            "No pipelineV2 section found in config".to_string(),
        ));
    };
    let Some(pipeline_map) = yaml_mapping_mut(pipeline) else {
        return Err((
            StatusCode::BAD_REQUEST,
            "No pipelineV2 section found in config".to_string(),
        ));
    };

    if role == "extraction" {
        set_yaml_string(pipeline_map, "extractionProvider", previous);
        if let Some(extraction) = pipeline_map.get_mut(yaml_key("extraction"))
            && let Some(extraction_map) = yaml_mapping_mut(extraction)
        {
            set_yaml_string(extraction_map, "provider", previous);
            remove_yaml_key(extraction_map, "model");
            remove_yaml_key(extraction_map, "endpoint");
            remove_yaml_key(extraction_map, "base_url");
        }
        remove_yaml_key(pipeline_map, "extractionModel");
        remove_yaml_key(pipeline_map, "extractionEndpoint");
        remove_yaml_key(pipeline_map, "extractionBaseUrl");
    } else if let Some(synthesis) = pipeline_map.get_mut(yaml_key("synthesis")) {
        let Some(synthesis_map) = yaml_mapping_mut(synthesis) else {
            return Err((
                StatusCode::BAD_REQUEST,
                "No synthesis configuration found to roll back".to_string(),
            ));
        };
        set_yaml_string(synthesis_map, "provider", previous);
        remove_yaml_key(synthesis_map, "model");
        remove_yaml_key(synthesis_map, "endpoint");
        remove_yaml_key(synthesis_map, "base_url");
    } else {
        return Err((
            StatusCode::BAD_REQUEST,
            "No synthesis configuration found to roll back".to_string(),
        ));
    }

    serde_yml::to_string(&root).map_err(|err| (StatusCode::INTERNAL_SERVER_ERROR, err.to_string()))
}

fn mark_provider_transition_rolled_back(entry: &mut serde_json::Value) {
    if let Some(obj) = entry.as_object_mut() {
        obj.insert("rolledBack".to_string(), serde_json::Value::Bool(true));
    }
}

/// POST /api/config/provider-safety/rollback
pub async fn provider_safety_rollback(
    State(state): State<Arc<AppState>>,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    let role = match rollback_role(&body) {
        Ok(role) => role,
        Err(error) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"error": error})),
            );
        }
    };
    let (transitions, audit_error) = read_provider_transitions(&state.config.base_path);
    if let Some(error) = audit_error {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": error})),
        );
    }
    let Some(target_index) = rollback_target_index(&transitions, role) else {
        return (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"error": "No provider transition with rollback target found"})),
        );
    };

    let target = transitions[target_index].clone();
    let file_path = match rollback_file_path(&state.config.base_path, &target) {
        Ok(path) => path,
        Err((status, error)) => return (status, Json(serde_json::json!({"error": error}))),
    };
    let before = match std::fs::read_to_string(&file_path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({"error": format!(
                    "Config file '{}' not found",
                    file_path
                        .file_name()
                        .and_then(|name| name.to_str())
                        .unwrap_or("agent.yaml")
                )})),
            );
        }
        Err(error) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": error.to_string()})),
            );
        }
    };
    let next = match apply_provider_rollback_yaml(&before, &target) {
        Ok(content) => content,
        Err((status, error)) => return (status, Json(serde_json::json!({"error": error}))),
    };
    if let Err(error) = std::fs::write(&file_path, next) {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": error.to_string()})),
        );
    }

    let mut updated_transitions = transitions.clone();
    mark_provider_transition_rolled_back(&mut updated_transitions[target_index]);
    let audit_path = provider_transitions_path(&state.config.base_path);
    if let Some(parent) = audit_path.parent()
        && let Err(error) = std::fs::create_dir_all(parent)
    {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": error.to_string()})),
        );
    }
    let audit_json = match serde_json::to_string_pretty(&updated_transitions) {
        Ok(json) => format!("{json}\n"),
        Err(error) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": error.to_string()})),
            );
        }
    };
    if let Err(error) = std::fs::write(&audit_path, audit_json) {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": error.to_string()})),
        );
    }

    let mut rolled_back = target;
    mark_provider_transition_rolled_back(&mut rolled_back);
    (
        StatusCode::OK,
        Json(serde_json::json!({
            "success": true,
            "file": file_path.file_name().and_then(|name| name.to_str()).unwrap_or("agent.yaml"),
            "rolledBack": strip_actor(rolled_back),
            "providerTransitions": [],
            "isRetry": false,
        })),
    )
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
