//! Source configuration routes.
//!
//! Mirrors the TypeScript daemon's lightweight `sources.json` contract for
//! configured provenance-preserving external sources. Indexing itself remains
//! handled by the source bridge/pipeline; these routes provide the same CRUD
//! surface so clients do not care which daemon runtime is serving them.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use axum::{
    Json,
    extract::{ConnectInfo, Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};

use crate::{
    auth::{
        middleware::{authenticate_headers, require_permission_guard},
        types::Permission,
    },
    state::AppState,
    workspace_paths,
};

const DEFAULT_OBSIDIAN_EXCLUDE_GLOBS: &[&str] = &[
    "**/.obsidian/**",
    "**/.trash/**",
    "**/.hermes/**",
    "**/.*/**",
    "**/.*",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SourcesConfig {
    version: u8,
    sources: Vec<SourceEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SourceEntry {
    id: String,
    kind: String,
    name: String,
    root: String,
    enabled: bool,
    mode: String,
    created_at: String,
    updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_indexed_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    exclude_globs: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    index_job: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddObsidianSourceRequest {
    path: Option<String>,
    root: Option<String>,
    name: Option<String>,
    exclude_globs: Option<Vec<String>>,
}

pub async fn list(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    let cfg = load_sources_config(&state);
    Json(json!({ "version": 1, "sources": cfg.sources }))
}

pub async fn add_obsidian(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(req): Json<AddObsidianSourceRequest>,
) -> impl IntoResponse {
    if let Err(resp) = require_admin_mutation(&state, peer, &headers) {
        return resp;
    }
    let Some(raw_root) = req.root.or(req.path).map(|s| s.trim().to_string()) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "Obsidian vault path is required"})),
        )
            .into_response();
    };
    if raw_root.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "Obsidian vault path is required"})),
        )
            .into_response();
    }

    let root_path = match std::fs::canonicalize(&raw_root) {
        Ok(path) => path,
        Err(_) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({"error": format!("Obsidian vault path does not exist: {raw_root}")})),
            )
                .into_response();
        }
    };
    if !root_path.is_dir() {
        return (StatusCode::BAD_REQUEST, Json(json!({"error": format!("Obsidian vault path must be a directory: {}", root_path.display())}))).into_response();
    }

    let root = root_path.to_string_lossy().to_string();
    let now = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
    let mut cfg = load_sources_config(&state);
    let mut created = true;
    let source = if let Some(existing) = cfg
        .sources
        .iter_mut()
        .find(|source| source.kind == "obsidian" && source.root == root)
    {
        existing.name = clean_name(req.name.as_deref()).unwrap_or_else(|| existing.name.clone());
        existing.exclude_globs = Some(merge_default_excludes(req.exclude_globs));
        existing.enabled = true;
        existing.updated_at = now.clone();
        created = false;
        existing.clone()
    } else {
        let source = SourceEntry {
            id: format!("obsidian:{}", sha256_prefix(&root, 16)),
            kind: "obsidian".to_string(),
            name: clean_name(req.name.as_deref()).unwrap_or_else(|| "Obsidian Vault".to_string()),
            root: root.clone(),
            enabled: true,
            mode: "read-only".to_string(),
            created_at: now.clone(),
            updated_at: now.clone(),
            last_indexed_at: Some(now.clone()),
            exclude_globs: Some(merge_default_excludes(req.exclude_globs)),
            index_job: Some(json!({"status": "complete", "indexed": 0, "queued": false})),
        };
        cfg.sources.push(source.clone());
        source
    };

    if let Err(err) = save_sources_config(&state, &cfg) {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": err.to_string()})),
        )
            .into_response();
    }

    (
        StatusCode::ACCEPTED,
        Json(json!({
            "created": created,
            "indexed": 0,
            "queued": true,
            "source": source,
        })),
    )
        .into_response()
}

pub async fn delete_source(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> impl IntoResponse {
    if let Err(resp) = require_admin_mutation(&state, peer, &headers) {
        return resp;
    }
    if id.trim().is_empty() || id.contains("../") || id.contains('/') || id.contains('\\') {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "Invalid source id"})),
        )
            .into_response();
    }
    let mut cfg = load_sources_config(&state);
    let Some(pos) = cfg.sources.iter().position(|source| source.id == id) else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({"error": format!("Source not found: {id}")})),
        )
            .into_response();
    };
    let source = cfg.sources.remove(pos);
    if let Err(err) = save_sources_config(&state, &cfg) {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": err.to_string()})),
        )
            .into_response();
    }
    Json(json!({"success": true, "source": source})).into_response()
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

fn sources_path(state: &AppState) -> std::io::Result<PathBuf> {
    workspace_paths::config_file(&state.config.base_path, "sources.json")
}

fn load_sources_config(state: &AppState) -> SourcesConfig {
    let Ok(path) = sources_path(state) else {
        return SourcesConfig {
            version: 1,
            sources: vec![],
        };
    };
    // lgtm[rust/path-injection] sources_path resolves the fixed sources.json file under the canonical Signet workspace root via workspace_paths::config_file.
    let Ok(raw) = std::fs::read_to_string(path) else {
        return SourcesConfig {
            version: 1,
            sources: vec![],
        };
    };
    serde_json::from_str::<SourcesConfig>(&raw).unwrap_or(SourcesConfig {
        version: 1,
        sources: vec![],
    })
}

fn save_sources_config(state: &AppState, cfg: &SourcesConfig) -> std::io::Result<()> {
    let path = sources_path(state)?;
    let tmp = path.with_extension(format!("json.tmp-{}", std::process::id()));
    // lgtm[rust/path-injection] sources_path resolves the fixed sources.json file under the canonical Signet workspace root; tmp is the same basename with a process-local extension.
    std::fs::write(
        &tmp,
        format!("{}\n", serde_json::to_string_pretty(cfg).unwrap()),
    )?;
    // lgtm[rust/path-injection] path and tmp are derived from the fixed sources.json file under the canonical Signet workspace root.
    std::fs::rename(tmp, path)
}

fn clean_name(name: Option<&str>) -> Option<String> {
    name.map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToOwned::to_owned)
}

fn merge_default_excludes(extra: Option<Vec<String>>) -> Vec<String> {
    let mut merged: Vec<String> = DEFAULT_OBSIDIAN_EXCLUDE_GLOBS
        .iter()
        .map(|s| (*s).to_string())
        .collect();
    if let Some(extra) = extra {
        for item in extra {
            if !merged.iter().any(|existing| existing == &item) {
                merged.push(item);
            }
        }
    }
    merged
}

fn sha256_prefix(input: &str, len: usize) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    let hex = format!("{:x}", hasher.finalize());
    hex.chars().take(len).collect()
}
