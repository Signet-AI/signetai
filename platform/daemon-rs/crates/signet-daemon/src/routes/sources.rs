//! Source configuration routes.
//!
//! Mirrors the TypeScript daemon's lightweight `sources.json` contract for
//! configured provenance-preserving external sources. Indexing itself remains
//! handled by the source bridge/pipeline; these routes provide the same CRUD
//! surface so clients do not care which daemon runtime is serving them.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use axum::{
    Json,
    extract::{ConnectInfo, Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
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
    #[serde(skip_serializing_if = "Option::is_none")]
    provider_settings: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddObsidianSourceRequest {
    path: Option<String>,
    root: Option<String>,
    name: Option<String>,
    exclude_globs: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PickDirectoryRequest {
    title: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddDiscordSourceRequest {
    guild_ids: Option<Vec<String>>,
    guild_id: Option<String>,
    token_ref: Option<String>,
    name: Option<String>,
    channel_filter: Option<Vec<String>>,
    channels: Option<Vec<String>>,
    desktop_cache_path: Option<String>,
    desktop_cache_full_scan: Option<bool>,
    max_messages_per_channel: Option<u64>,
    include_threads: Option<bool>,
    include_archived_threads: Option<bool>,
    include_private_archived_threads: Option<bool>,
    include_members: Option<bool>,
    include_attachments: Option<bool>,
    include_attachment_text: Option<bool>,
    max_attachment_text_bytes: Option<u64>,
    include_embeds: Option<bool>,
    include_polls: Option<bool>,
    include_thread_members: Option<bool>,
    since: Option<String>,
    sync_mode: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddGitHubSourceRequest {
    repos: Option<Vec<String>>,
    repo: Option<String>,
    token_ref: Option<String>,
    name: Option<String>,
    resource_types: Option<Vec<String>>,
    state: Option<String>,
    include_comments: Option<bool>,
    labels: Option<Vec<String>>,
    doc_paths: Option<Vec<String>>,
    max_items_per_repo: Option<u64>,
}

pub async fn list(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    let cfg = load_sources_config(&state);
    Json(json!({
        "version": cfg.version,
        "sources": cfg.sources.iter().map(source_list_payload).collect::<Vec<_>>(),
    }))
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
    let id = format!("obsidian:{}", sha256_prefix(&root, 16));
    let job = source_index_job(&id, &now);
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
        existing.index_job = Some(job.clone());
        created = false;
        existing.clone()
    } else {
        let source = SourceEntry {
            id,
            kind: "obsidian".to_string(),
            name: clean_name(req.name.as_deref()).unwrap_or_else(|| "Obsidian Vault".to_string()),
            root: root.clone(),
            enabled: true,
            mode: "read-only".to_string(),
            created_at: now.clone(),
            updated_at: now.clone(),
            last_indexed_at: Some(now.clone()),
            exclude_globs: Some(merge_default_excludes(req.exclude_globs)),
            index_job: Some(job.clone()),
            provider_settings: None,
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
            "job": job,
            "queued": true,
            "source": source_payload(&source),
        })),
    )
        .into_response()
}

pub async fn pick_directory(
    body: Option<Json<PickDirectoryRequest>>,
) -> (StatusCode, Json<serde_json::Value>) {
    let title = body
        .and_then(|Json(req)| req.title)
        .unwrap_or_else(|| "Choose folder".to_string());
    let title = title.trim();
    let title = if title.is_empty() {
        "Choose folder"
    } else {
        title
    };
    let mut errors = Vec::new();
    for (command, args) in picker_commands(title) {
        match tokio::time::timeout(
            Duration::from_secs(120),
            tokio::process::Command::new(&command)
                .args(&args)
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .output(),
        )
        .await
        {
            Ok(Ok(output)) if output.status.success() => {
                let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if !path.is_empty() {
                    return (StatusCode::OK, Json(json!({"path": path})));
                }
                errors.push(format!("{command}: empty selection"));
            }
            Ok(Ok(output)) => {
                let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
                let detail = if stderr.is_empty() {
                    output
                        .status
                        .code()
                        .map(|code| format!("exited with code {code}"))
                        .unwrap_or_else(|| "exited without status".to_string())
                } else {
                    stderr
                };
                errors.push(format!("{command}: {detail}"));
            }
            Ok(Err(error)) => errors.push(format!("{command}: {error}")),
            Err(_) => errors.push(format!("{command}: timed out after 120000ms")),
        }
    }

    (
        StatusCode::NOT_IMPLEMENTED,
        Json(json!({
            "error": format!(
                "No native folder picker is available for this daemon environment. Tried: {}",
                errors.join("; ")
            )
        })),
    )
}

fn picker_commands(title: &str) -> Vec<(String, Vec<String>)> {
    if let Ok(command) = std::env::var("SIGNET_DIRECTORY_PICKER")
        && !command.trim().is_empty()
    {
        return vec![(command, Vec::new())];
    }
    if cfg!(target_os = "macos") {
        return vec![(
            "osascript".to_string(),
            vec![
                "-e".to_string(),
                format!("POSIX path of (choose folder with prompt {title:?})"),
            ],
        )];
    }
    if cfg!(target_os = "windows") {
        return vec![(
            "powershell.exe".to_string(),
            vec![
                "-NoProfile".to_string(),
                "-Command".to_string(),
                format!(
                    "Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = {title:?}; if ($d.ShowDialog() -eq 'OK') {{ $d.SelectedPath }}"
                ),
            ],
        )];
    }
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    vec![
        (
            "zenity".to_string(),
            vec![
                "--file-selection".to_string(),
                "--directory".to_string(),
                "--title".to_string(),
                title.to_string(),
            ],
        ),
        (
            "kdialog".to_string(),
            vec![
                "--title".to_string(),
                title.to_string(),
                "--getexistingdirectory".to_string(),
                home,
            ],
        ),
    ]
}

pub async fn add_discord(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(req): Json<AddDiscordSourceRequest>,
) -> impl IntoResponse {
    if let Err(resp) = require_admin_mutation(&state, peer, &headers) {
        return resp;
    }
    let guild_ids = filtered_strings(req.guild_ids)
        .or_else(|| clean_name(req.guild_id.as_deref()).map(|guild_id| vec![guild_id]))
        .unwrap_or_default();
    if guild_ids.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "At least one Discord guild ID is required"})),
        )
            .into_response();
    }
    if let Some(invalid) = guild_ids
        .iter()
        .find(|guild_id| !is_discord_snowflake(guild_id))
    {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": format!("Invalid Discord guild ID: {invalid}")})),
        )
            .into_response();
    }
    if let Some(token_ref) = clean_name(req.token_ref.as_deref()) {
        if looks_like_raw_discord_token(&token_ref) {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({"error": "Discord tokenRef must be a secret reference, not a raw token"})),
            )
                .into_response();
        }
    }

    let mut sorted_guild_ids = guild_ids;
    sorted_guild_ids.sort();
    sorted_guild_ids.dedup();
    let root = format!("discord://guilds/{}", sorted_guild_ids.join(","));
    let id = format!("discord:{}", sha256_prefix(&sorted_guild_ids.join(","), 16));
    let now = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
    let job = source_index_job(&id, &now);
    let settings = json!({
        "guildIds": sorted_guild_ids,
        "tokenRef": clean_name(req.token_ref.as_deref()).unwrap_or_default(),
        "desktopCachePath": clean_name(req.desktop_cache_path.as_deref()),
        "desktopCacheFullScan": req.desktop_cache_full_scan.unwrap_or(false),
        "channelFilter": filtered_strings(req.channel_filter.or(req.channels)),
        "maxMessagesPerChannel": req.max_messages_per_channel.unwrap_or(1000),
        "includeThreads": req.include_threads.unwrap_or(true),
        "includeArchivedThreads": req.include_archived_threads.unwrap_or(false),
        "includePrivateArchivedThreads": req.include_private_archived_threads.unwrap_or(false),
        "includeMembers": req.include_members.unwrap_or(false),
        "includeAttachments": req.include_attachments.unwrap_or(true),
        "includeAttachmentText": req.include_attachment_text.unwrap_or(false),
        "maxAttachmentTextBytes": req.max_attachment_text_bytes.unwrap_or(262_144),
        "includeEmbeds": req.include_embeds.unwrap_or(true),
        "includePolls": req.include_polls.unwrap_or(true),
        "includeThreadMembers": req.include_thread_members.unwrap_or(false),
        "since": clean_name(req.since.as_deref()),
        "syncMode": clean_name(req.sync_mode.as_deref()).unwrap_or_else(|| "rest".to_string()),
    });
    add_configured_source(
        &state,
        SourceEntry {
            id,
            kind: "discord".to_string(),
            name: clean_name(req.name.as_deref()).unwrap_or_else(|| "Discord Source".to_string()),
            root,
            enabled: true,
            mode: "read-only".to_string(),
            created_at: now.clone(),
            updated_at: now,
            last_indexed_at: None,
            exclude_globs: None,
            index_job: Some(job),
            provider_settings: Some(settings),
        },
    )
}

pub async fn add_github(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(req): Json<AddGitHubSourceRequest>,
) -> impl IntoResponse {
    if let Err(resp) = require_admin_mutation(&state, peer, &headers) {
        return resp;
    }
    let repos = filtered_strings(req.repos)
        .or_else(|| clean_name(req.repo.as_deref()).map(|repo| vec![repo]))
        .unwrap_or_default();
    if repos.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "At least one GitHub repo pattern is required"})),
        )
            .into_response();
    }
    if let Some(invalid) = repos.iter().find(|repo| !is_github_repo_pattern(repo)) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": format!("Invalid GitHub repo pattern: {invalid}. Expected owner/repo or owner/*")})),
        )
            .into_response();
    }
    if let Some(token_ref) = clean_name(req.token_ref.as_deref()) {
        if looks_like_raw_github_token(&token_ref) {
            return (
                StatusCode::BAD_REQUEST,
                Json(
                    json!({"error": "GitHub tokenRef must be a secret reference, not a raw token"}),
                ),
            )
                .into_response();
        }
    }

    let mut sorted_repos = repos;
    sorted_repos.sort();
    sorted_repos.dedup();
    let root = format!("github://repos/{}", sorted_repos.join(","));
    let id = format!("github:{}", sha256_prefix(&sorted_repos.join(","), 16));
    let name = clean_name(req.name.as_deref()).unwrap_or_else(|| sorted_repos[0].clone());
    let now = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
    let job = source_index_job(&id, &now);
    let settings = json!({
        "repos": sorted_repos,
        "tokenRef": clean_name(req.token_ref.as_deref()),
        "resourceTypes": filtered_strings(req.resource_types)
            .unwrap_or_else(|| vec!["issues".to_string(), "pulls".to_string(), "docs".to_string()]),
        "state": clean_name(req.state.as_deref()).unwrap_or_else(|| "all".to_string()),
        "includeComments": req.include_comments.unwrap_or(true),
        "labels": filtered_strings(req.labels),
        "docPaths": filtered_strings(req.doc_paths)
            .unwrap_or_else(|| vec!["README.md".to_string(), "CHANGELOG.md".to_string()]),
        "maxItemsPerRepo": req.max_items_per_repo.unwrap_or(500),
    });
    add_configured_source(
        &state,
        SourceEntry {
            id,
            kind: "github".to_string(),
            name,
            root,
            enabled: true,
            mode: "read-only".to_string(),
            created_at: now.clone(),
            updated_at: now,
            last_indexed_at: None,
            exclude_globs: None,
            index_job: Some(job),
            provider_settings: Some(settings),
        },
    )
}

pub async fn snapshot(
    State(state): State<Arc<AppState>>,
    Path(source_id): Path<String>,
) -> impl IntoResponse {
    let Some(source) = find_source(&state, &source_id) else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({"error": "Source not found"})),
        )
            .into_response();
    };

    Json(json!({
        "version": 1,
        "exportedAt": Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
        "source": {
            "id": source.id,
            "kind": source.kind,
            "name": source.name,
            "root": source.root,
        },
        "agentId": "default",
        "artifacts": [],
        "skipped": { "localDiscordArtifacts": 0 },
    }))
    .into_response()
}

pub async fn health(
    State(state): State<Arc<AppState>>,
    Path(source_id): Path<String>,
) -> impl IntoResponse {
    let Some(source) = find_source(&state, &source_id) else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({"error": "Source not found"})),
        )
            .into_response();
    };
    let stats = json!({"artifacts": 0, "chunks": 0, "indexed": 0});
    Json(json!({
        "source": source_payload(&source),
        "stats": stats,
        "health": source_health_payload(),
    }))
    .into_response()
}

pub async fn import_snapshot(
    State(state): State<Arc<AppState>>,
    Path(source_id): Path<String>,
    body: Option<Json<serde_json::Value>>,
) -> impl IntoResponse {
    let Some(source) = find_source(&state, &source_id) else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({"error": "Source not found"})),
        )
            .into_response();
    };
    let Some(Json(snapshot)) = body else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "Invalid JSON body"})),
        )
            .into_response();
    };
    let Some(snapshot_source_id) = snapshot
        .get("source")
        .and_then(|source| source.get("id"))
        .and_then(serde_json::Value::as_str)
    else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "Invalid source snapshot"})),
        )
            .into_response();
    };
    if snapshot_source_id != source.id {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": format!("Snapshot source id {snapshot_source_id} does not match {}", source.id)})),
        )
            .into_response();
    }
    Json(json!({
        "ok": true,
        "imported": 0,
        "skipped": { "localDiscordArtifacts": 0 },
    }))
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

fn add_configured_source(state: &AppState, source: SourceEntry) -> Response {
    let mut cfg = load_sources_config(state);
    let mut created = true;
    let source = if let Some(existing) = cfg
        .sources
        .iter_mut()
        .find(|existing| existing.id == source.id)
    {
        existing.name = source.name;
        existing.root = source.root;
        existing.enabled = true;
        existing.updated_at = source.updated_at;
        existing.provider_settings = source.provider_settings;
        existing.index_job = source.index_job;
        created = false;
        existing.clone()
    } else {
        cfg.sources.push(source.clone());
        source
    };

    if let Err(err) = save_sources_config(state, &cfg) {
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
            "source": source_payload(&source),
            "job": source.index_job.clone().unwrap_or_else(|| {
                source_index_job(&source.id, &Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true))
            }),
        })),
    )
        .into_response()
}

fn source_payload(source: &SourceEntry) -> Value {
    let mut value = serde_json::to_value(source).unwrap_or_else(|_| json!({}));
    if let Some(object) = value.as_object_mut() {
        object.remove("indexJob");
    }
    value
}

fn source_list_payload(source: &SourceEntry) -> Value {
    let mut value = source_payload(source);
    if let Some(object) = value.as_object_mut() {
        object.insert("stats".to_string(), source_stats_payload());
        object.insert("health".to_string(), source_health_payload());
        if let Some(job) = source.index_job.clone() {
            object.insert("indexJob".to_string(), job);
        }
    }
    value
}

fn source_stats_payload() -> Value {
    json!({"artifacts": 0, "chunks": 0, "indexed": 0})
}

fn source_health_payload() -> Value {
    json!({
        "status": "empty",
        "generatedAt": Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
        "latestArtifactAt": null,
        "latestCheckpointAt": null,
        "chunkCoverage": 0,
        "failures": { "total": 0, "recoverable": 0 },
        "checkpoints": { "total": 0, "partial": 0, "stale": 0 },
        "purge": { "deletedArtifacts": 0, "orphanChunks": 0 },
        "semantic": { "entities": 0, "attributes": 0, "dependencies": 0, "communities": 0, "total": 0 },
    })
}

fn source_index_job(source_id: &str, queued_at: &str) -> Value {
    json!({
        "id": format!("source-index:{source_id}:{}", Utc::now().timestamp_millis()),
        "sourceId": source_id,
        "status": "queued",
        "queuedAt": queued_at,
    })
}

fn find_source(state: &AppState, source_id: &str) -> Option<SourceEntry> {
    load_sources_config(state)
        .sources
        .into_iter()
        .find(|source| source.id == source_id)
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

fn filtered_strings(input: Option<Vec<String>>) -> Option<Vec<String>> {
    input.map(|items| {
        items
            .into_iter()
            .map(|item| item.trim().to_string())
            .filter(|item| !item.is_empty())
            .collect()
    })
}

fn is_discord_snowflake(input: &str) -> bool {
    let len = input.len();
    (17..=20).contains(&len) && input.bytes().all(|byte| byte.is_ascii_digit())
}

fn is_github_repo_pattern(input: &str) -> bool {
    let Some((owner, repo)) = input.split_once('/') else {
        return false;
    };
    is_github_path_part(owner) && (repo == "*" || is_github_path_part(repo))
}

fn is_github_path_part(input: &str) -> bool {
    !input.is_empty()
        && input.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || byte == b'.' || byte == b'_' || byte == b'-'
        })
}

fn looks_like_raw_discord_token(input: &str) -> bool {
    input.contains('.')
        && input.len() > 40
        && input.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || byte == b'.' || byte == b'_' || byte == b'-'
        })
}

fn looks_like_raw_github_token(input: &str) -> bool {
    let trimmed = input.trim();
    trimmed.starts_with("ghp_")
        || trimmed.starts_with("github_pat_")
        || trimmed.starts_with("Bearer ghp_")
        || trimmed.starts_with("Authorization: token ghp_")
}

fn sha256_prefix(input: &str, len: usize) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    let hex = format!("{:x}", hasher.finalize());
    hex.chars().take(len).collect()
}
