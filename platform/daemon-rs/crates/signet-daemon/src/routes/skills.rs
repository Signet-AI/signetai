//! Skill library routes.
//!
//! Provides the filesystem-backed skill read/list/delete API that the TS daemon
//! exposes for dashboard and harness clients.

use std::collections::HashMap;
use std::fs::{self, File};
use std::io;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use axum::{
    Json,
    extract::{ConnectInfo, Path as AxumPath, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use chrono::Utc;
use rusqlite::{OptionalExtension, params};
use serde::Deserialize;
use serde_json::json;
use signet_core::{config::ProceduralConfig, db::Priority, error::CoreError, queries::embedding};
use tokio::process::Command;
use uuid::Uuid;
use zip::ZipArchive;

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

const CLAWHUB_DOWNLOAD_BASE_DEFAULT: &str = "https://clawhub.ai/api/v1/download";
const MAX_CLAWHUB_ZIP_BYTES: u64 = 50 * 1024 * 1024;
const MAX_CLAWHUB_ZIP_ENTRIES: usize = 500;
const MAX_CLAWHUB_ENTRY_BYTES: u64 = 25 * 1024 * 1024;
const MAX_CLAWHUB_UNCOMPRESSED_BYTES: u64 = 100 * 1024 * 1024;
const DEFAULT_AGENT_ID: &str = "default";
static CLAWHUB_INSTALL_LOCKS: OnceLock<
    tokio::sync::Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
> = OnceLock::new();

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
    let _ = uninstall_skill_graph_node(state.clone(), name.clone()).await;
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

    match clawhub_install_slug(name, req.source.as_deref()) {
        Ok(Some(slug)) => {
            return match install_clawhub_skill(&state, &slug).await {
                Ok(output) => {
                    schedule_skill_graph_install(state.clone(), slug.clone());
                    Json(json!({
                        "success": true,
                        "name": slug,
                        "output": output
                    }))
                    .into_response()
                }
                Err(error) => (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(json!({
                        "success": false,
                        "error": error
                    })),
                )
                    .into_response(),
            };
        }
        Ok(None) => {}
        Err(error) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({
                    "success": false,
                    "error": error
                })),
            )
                .into_response();
        }
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
        Ok(output) => {
            schedule_skill_graph_install(state.clone(), name.to_string());
            Json(json!({
                "success": true,
                "name": name,
                "output": output
            }))
            .into_response()
        }
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

fn schedule_skill_graph_install(state: Arc<AppState>, name: String) {
    tokio::spawn(async move {
        let _ = install_skill_graph_node(state, name).await;
    });
}

fn clawhub_install_slug(name: &str, source: Option<&str>) -> Result<Option<String>, String> {
    let Some(source) = source.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    if !source.starts_with("clawhub@") {
        return Ok(None);
    }
    let slug = source
        .strip_prefix("clawhub@")
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(name.trim());
    validate_clawhub_slug(slug)
        .then(|| Some(slug.to_string()))
        .ok_or_else(|| "Invalid ClawHub skill slug".to_string())
}

fn validate_clawhub_slug(slug: &str) -> bool {
    !slug.is_empty()
        && slug
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        && !slug.contains("..")
}

async fn install_clawhub_skill(state: &AppState, slug: &str) -> Result<String, String> {
    let base = std::env::var("CLAWHUB_DOWNLOAD_BASE")
        .unwrap_or_else(|_| CLAWHUB_DOWNLOAD_BASE_DEFAULT.to_string());
    let mut url = reqwest::Url::parse(&base).map_err(|err| err.to_string())?;
    url.query_pairs_mut().append_pair("slug", slug);

    let response = reqwest::Client::new()
        .get(url)
        .header("User-Agent", "signet-daemon")
        .send()
        .await
        .map_err(|err| err.to_string())?;
    if !response.status().is_success() {
        return Err(format!(
            "ClawHub download failed with HTTP {}",
            response.status()
        ));
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_CLAWHUB_ZIP_BYTES)
    {
        return Err("ClawHub zip is too large".to_string());
    }
    let bytes = response.bytes().await.map_err(|err| err.to_string())?;
    if bytes.len() as u64 > MAX_CLAWHUB_ZIP_BYTES {
        return Err("ClawHub zip is too large".to_string());
    }

    let temp_root = std::env::temp_dir().join(format!(
        "signet-clawhub-skill-{}-{}",
        std::process::id(),
        Uuid::new_v4()
    ));
    let result = (|| {
        fs::create_dir_all(&temp_root).map_err(|err| err.to_string())?;
        let zip_path = temp_root.join("skill.zip");
        fs::write(&zip_path, &bytes).map_err(|err| err.to_string())?;
        let extract_dir = temp_root.join("extract");
        fs::create_dir_all(&extract_dir).map_err(|err| err.to_string())?;
        extract_clawhub_zip(&zip_path, &extract_dir)?;
        validate_extracted_skill_tree(&extract_dir)?;
        let target_dir = skill_dir(state, slug).map_err(|err| err.to_string())?;
        Ok((extract_dir, target_dir))
    })();
    let result = match result {
        Ok((extract_dir, target_dir)) => with_clawhub_install_lock(slug, || {
            replace_skill_directory_atomically(&extract_dir, &target_dir)
        })
        .await
        .map(|()| format!("Installed ClawHub skill {slug}")),
        Err(error) => Err(error),
    };
    let _ = fs::remove_dir_all(&temp_root);
    result
}

async fn with_clawhub_install_lock<F, T>(slug: &str, action: F) -> T
where
    F: FnOnce() -> T,
{
    let lock = {
        let locks = CLAWHUB_INSTALL_LOCKS.get_or_init(|| tokio::sync::Mutex::new(HashMap::new()));
        let mut locks = locks.lock().await;
        locks
            .entry(slug.to_string())
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
            .clone()
    };
    let _guard = lock.lock().await;
    action()
}

fn extract_clawhub_zip(zip_path: &Path, extract_dir: &Path) -> Result<(), String> {
    let file = File::open(zip_path).map_err(|err| err.to_string())?;
    let mut archive = ZipArchive::new(file).map_err(|err| err.to_string())?;
    if archive.len() > MAX_CLAWHUB_ZIP_ENTRIES {
        return Err("ClawHub zip contains too many entries".to_string());
    }

    let mut total_uncompressed = 0_u64;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|err| err.to_string())?;
        let relative = validate_clawhub_entry_path(entry.name())?;
        if entry.size() > MAX_CLAWHUB_ENTRY_BYTES {
            return Err("ClawHub zip entry is too large".to_string());
        }
        total_uncompressed = total_uncompressed.saturating_add(entry.size());
        if total_uncompressed > MAX_CLAWHUB_UNCOMPRESSED_BYTES {
            return Err("ClawHub zip expands to too much data".to_string());
        }
        validate_clawhub_entry_type(entry.unix_mode(), entry.is_dir())?;

        let destination = extract_dir.join(relative);
        if entry.is_dir() {
            fs::create_dir_all(&destination).map_err(|err| err.to_string())?;
            continue;
        }
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent).map_err(|err| err.to_string())?;
        }
        let mut out = File::create(&destination).map_err(|err| err.to_string())?;
        io::copy(&mut entry, &mut out).map_err(|err| err.to_string())?;
    }

    Ok(())
}

fn validate_clawhub_entry_path(name: &str) -> Result<PathBuf, String> {
    let normalized = name.replace('\\', "/");
    let trimmed = normalized.trim_end_matches('/');
    if trimmed.is_empty()
        || trimmed.starts_with('/')
        || trimmed.contains('\0')
        || trimmed.as_bytes().get(1).is_some_and(|byte| *byte == b':')
    {
        return Err("ClawHub zip contains invalid paths".to_string());
    }

    let mut relative = PathBuf::new();
    for part in trimmed.split('/') {
        if part.is_empty() || part == "." || part == ".." {
            return Err("ClawHub zip contains invalid paths".to_string());
        }
        relative.push(part);
    }
    Ok(relative)
}

fn validate_clawhub_entry_type(mode: Option<u32>, is_dir: bool) -> Result<(), String> {
    let Some(mode) = mode else {
        return Ok(());
    };
    let file_type = mode & 0o170000;
    if is_dir || file_type == 0o040000 || file_type == 0o100000 || file_type == 0 {
        return Ok(());
    }
    Err("ClawHub zip contains unsupported entry types".to_string())
}

fn validate_extracted_skill_tree(root: &Path) -> Result<(), String> {
    let skill_file = root.join("SKILL.md");
    let metadata = fs::symlink_metadata(&skill_file)
        .map_err(|_| "ClawHub package is missing root SKILL.md".to_string())?;
    if !metadata.file_type().is_file() {
        return Err("ClawHub package is missing root SKILL.md".to_string());
    }

    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in fs::read_dir(&dir).map_err(|err| err.to_string())? {
            let entry = entry.map_err(|err| err.to_string())?;
            let file_type = entry.file_type().map_err(|err| err.to_string())?;
            if file_type.is_symlink() {
                return Err("ClawHub package contains symbolic links".to_string());
            }
            if file_type.is_dir() {
                stack.push(entry.path());
            } else if !file_type.is_file() {
                return Err("ClawHub package contains non-regular files".to_string());
            }
        }
    }
    Ok(())
}

fn replace_skill_directory_atomically(source: &Path, target: &Path) -> Result<(), String> {
    let parent = target
        .parent()
        .ok_or_else(|| "Invalid skill target path".to_string())?;
    fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    let suffix = Uuid::new_v4();
    let staging = parent.join(format!(".install-{}-{suffix}", std::process::id()));
    let backup = parent.join(format!(".backup-{}-{suffix}", std::process::id()));

    copy_dir_recursive(source, &staging).map_err(|err| err.to_string())?;
    let had_target = target.exists();
    if had_target {
        fs::rename(target, &backup).map_err(|err| err.to_string())?;
    }
    match fs::rename(&staging, target) {
        Ok(()) => {
            if had_target {
                let _ = fs::remove_dir_all(&backup);
            }
            Ok(())
        }
        Err(err) => {
            let _ = fs::remove_dir_all(&staging);
            if had_target {
                let _ = fs::rename(&backup, target);
            }
            Err(err.to_string())
        }
    }
}

fn copy_dir_recursive(source: &Path, target: &Path) -> io::Result<()> {
    fs::create_dir_all(target)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let destination = target.join(entry.file_name());
        if file_type.is_dir() {
            copy_dir_recursive(&entry.path(), &destination)?;
        } else if file_type.is_file() {
            fs::copy(entry.path(), destination)?;
        } else {
            return Err(io::Error::other("unsupported ClawHub package entry"));
        }
    }
    Ok(())
}

async fn install_skill_graph_node(state: Arc<AppState>, name: String) -> Result<(), String> {
    let skill_path = skill_file(&state, &name).map_err(|err| err.to_string())?;
    let content = fs::read_to_string(&skill_path).map_err(|err| err.to_string())?;
    let meta = parse_frontmatter(&content);
    let skill_name = meta
        .name
        .clone()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(name);
    let procedural = procedural_config(&state);
    if !procedural.enabled {
        return Ok(());
    }

    let fs_path = skill_path.to_string_lossy().to_string();
    state
        .pool
        .write_tx(Priority::Low, move |conn| {
            let now = Utc::now().to_rfc3339();
            let mut entity_id = format!("skill:{DEFAULT_AGENT_ID}:{skill_name}");
            let existing: Option<String> = conn
                .query_row(
                    "SELECT id FROM entities WHERE id = ?1 OR (name = ?2 AND agent_id = ?3) LIMIT 1",
                    params![entity_id, skill_name, DEFAULT_AGENT_ID],
                    |row| row.get(0),
                )
                .optional()?;
            let description = meta.description.unwrap_or_default();

            if let Some(existing_id) = existing {
                entity_id = existing_id;
                conn.execute(
                    "UPDATE entities SET entity_type = 'skill', description = ?1, updated_at = ?2
                     WHERE id = ?3",
                    params![description, now, entity_id],
                )?;
            } else if conn
                .execute(
                    "INSERT INTO entities
                     (id, name, canonical_name, entity_type, agent_id, description, mentions, created_at, updated_at)
                     VALUES (?1, ?2, ?3, 'skill', ?4, ?5, 0, ?6, ?6)
                     ON CONFLICT(name) DO NOTHING",
                    params![
                        entity_id,
                        skill_name,
                        skill_name.to_ascii_lowercase(),
                        DEFAULT_AGENT_ID,
                        description,
                        now
                    ],
                )?
                == 0
            {
                entity_id = conn.query_row(
                    "SELECT id FROM entities WHERE name = ?1 AND agent_id = ?2 LIMIT 1",
                    params![skill_name, DEFAULT_AGENT_ID],
                    |row| row.get(0),
                )?;
                conn.execute(
                    "UPDATE entities SET entity_type = 'skill', description = ?1, updated_at = ?2
                     WHERE id = ?3",
                    params![description, now, entity_id],
                )?;
            }

            let actual_entity_id: String = conn.query_row(
                "SELECT id FROM entities WHERE id = ?1 OR (name = ?2 AND agent_id = ?3) LIMIT 1",
                params![entity_id, skill_name, DEFAULT_AGENT_ID],
                |row| row.get(0),
            )?;

            conn.execute(
                "INSERT INTO skill_meta
                 (entity_id, agent_id, version, author, license, source,
                  role, triggers, tags, permissions, enriched,
                  installed_at, importance, decay_rate, fs_path)
                 VALUES (?1, ?2, ?3, ?4, ?5, 'installed', ?6, ?7, ?8, ?9, 0, ?10, ?11, ?12, ?13)
                 ON CONFLICT(entity_id) DO UPDATE SET
                    version = excluded.version,
                    author = excluded.author,
                    license = excluded.license,
                    source = excluded.source,
                    role = excluded.role,
                    triggers = excluded.triggers,
                    tags = excluded.tags,
                    permissions = excluded.permissions,
                    enriched = excluded.enriched,
                    fs_path = excluded.fs_path,
                    uninstalled_at = NULL,
                    updated_at = ?10",
                params![
                    actual_entity_id,
                    DEFAULT_AGENT_ID,
                    meta.version,
                    meta.author,
                    meta.license,
                    meta.role.unwrap_or_else(|| "utility".to_string()),
                    json_string(meta.triggers)?,
                    json_string(meta.tags)?,
                    json_string(meta.permissions)?,
                    now,
                    procedural.importance_on_install,
                    procedural.decay_rate,
                    fs_path,
                ],
            )?;

            Ok(json!({"entityId": actual_entity_id}))
        })
        .await
        .map(|_| ())
        .map_err(|err| err.to_string())
}

async fn uninstall_skill_graph_node(state: Arc<AppState>, name: String) -> Result<(), String> {
    state
        .pool
        .write_tx(Priority::Low, move |conn| {
            let entity_id = format!("skill:{DEFAULT_AGENT_ID}:{name}");
            let exists = conn
                .query_row(
                    "SELECT id FROM entities WHERE id = ?1",
                    params![entity_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()?;
            let Some(entity_id) = exists else {
                return Ok(json!({"removed": false}));
            };

            conn.execute(
                "DELETE FROM relations WHERE source_entity_id = ?1 OR target_entity_id = ?1",
                params![entity_id],
            )?;
            conn.execute(
                "DELETE FROM memory_entity_mentions WHERE entity_id = ?1",
                params![entity_id],
            )?;
            embedding::delete_by_source(conn, "skill", &entity_id, None)?;
            conn.execute(
                "DELETE FROM skill_meta WHERE entity_id = ?1",
                params![entity_id],
            )?;
            conn.execute("DELETE FROM entities WHERE id = ?1", params![entity_id])?;

            Ok(json!({"removed": true}))
        })
        .await
        .map(|_| ())
        .map_err(|err| err.to_string())
}

fn procedural_config(state: &AppState) -> ProceduralConfig {
    state
        .config
        .manifest
        .memory
        .as_ref()
        .and_then(|memory| memory.pipeline_v2.as_ref())
        .map(|pipeline| pipeline.procedural.clone())
        .unwrap_or_default()
}

fn json_string(value: Option<Vec<String>>) -> Result<Option<String>, CoreError> {
    value
        .map(|value| serde_json::to_string(&value))
        .transpose()
        .map_err(CoreError::from)
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
    author: Option<String>,
    license: Option<String>,
    role: Option<String>,
    triggers: Option<Vec<String>>,
    tags: Option<Vec<String>>,
    permissions: Option<Vec<String>>,
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
            "author" => meta.author = Some(value),
            "license" => meta.license = Some(value),
            "role" => meta.role = Some(value),
            "triggers" => meta.triggers = parse_frontmatter_list(&value),
            "tags" => meta.tags = parse_frontmatter_list(&value),
            "permissions" => meta.permissions = parse_frontmatter_list(&value),
            _ => {}
        }
    }
    meta
}

fn parse_frontmatter_list(value: &str) -> Option<Vec<String>> {
    let trimmed = value.trim();
    let content = trimmed
        .strip_prefix('[')
        .and_then(|value| value.strip_suffix(']'))
        .unwrap_or(trimmed);
    let values = content
        .split(',')
        .map(|value| {
            value
                .trim()
                .trim_matches('"')
                .trim_matches('\'')
                .to_string()
        })
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>();
    (!values.is_empty()).then_some(values)
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

    #[test]
    fn clawhub_slug_allows_simple_slug_only() {
        assert_eq!(
            clawhub_install_slug("ignored", Some("clawhub@web-search")).unwrap(),
            Some("web-search".to_string())
        );
        assert!(clawhub_install_slug("ignored", Some("clawhub@../bad")).is_err());
        assert!(clawhub_install_slug("ignored", Some("clawhub@owner/repo")).is_err());
    }

    #[test]
    fn clawhub_entry_paths_reject_traversal_and_absolute_paths() {
        assert_eq!(
            validate_clawhub_entry_path("nested/SKILL.md").unwrap(),
            PathBuf::from("nested").join("SKILL.md")
        );
        assert!(validate_clawhub_entry_path("../SKILL.md").is_err());
        assert!(validate_clawhub_entry_path("/tmp/SKILL.md").is_err());
        assert!(validate_clawhub_entry_path("C:/tmp/SKILL.md").is_err());
    }
}
