//! Connector routes.
//!
//! Filesystem connector registry with CRUD and sync operations.

use std::path::{Path as FsPath, PathBuf};
use std::sync::Arc;

use axum::{
    Json,
    extract::{Path, Query, State},
    http::StatusCode,
    response::IntoResponse,
};
use chrono::{DateTime, Utc};
use rusqlite::OptionalExtension;
use serde::Deserialize;
use signet_core::{CoreError, db::Priority, queries::job};
use tracing::{error, info};

use crate::state::AppState;

fn parse_connector_settings(settings_str: &str) -> serde_json::Value {
    let value: serde_json::Value =
        serde_json::from_str(settings_str).unwrap_or(serde_json::json!({}));
    value
        .get("settings")
        .and_then(|settings| settings.as_object().map(|_| settings.clone()))
        .unwrap_or(value)
}

fn escape_like_prefix(value: &str) -> String {
    format!(
        "{}%",
        value
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_")
    )
}

#[derive(Clone, Debug)]
struct ConnectorSyncRecord {
    id: String,
    config_json: String,
    cursor_json: Option<String>,
    status: String,
    last_sync_at: Option<String>,
    last_error: Option<String>,
}

fn connector_sync_record(
    conn: &rusqlite::Connection,
    id: &str,
) -> rusqlite::Result<Option<ConnectorSyncRecord>> {
    conn.query_row(
        "SELECT id, config_json, cursor_json, status, last_sync_at, last_error
         FROM connectors WHERE id = ?1",
        [id],
        |r| {
            Ok(ConnectorSyncRecord {
                id: r.get(0)?,
                config_json: r.get::<_, String>(1).unwrap_or_else(|_| "{}".into()),
                cursor_json: r.get(2)?,
                status: r.get(3)?,
                last_sync_at: r.get(4)?,
                last_error: r.get(5)?,
            })
        },
    )
    .optional()
}

fn connector_config(value: &str) -> Result<serde_json::Value, String> {
    let parsed: serde_json::Value =
        serde_json::from_str(value).map_err(|_| "Connector config is invalid JSON".to_string())?;
    if !parsed.is_object() {
        return Err("Invalid connector config".to_string());
    }
    Ok(parsed)
}

fn connector_config_provider(record: &ConnectorSyncRecord) -> Result<String, String> {
    let provider = connector_config(&record.config_json)?
        .get("provider")
        .and_then(|value| value.as_str())
        .ok_or_else(|| "Invalid connector config".to_string())?
        .to_string();
    match provider.as_str() {
        "filesystem" | "github-docs" | "gdrive" => Ok(provider),
        _ => Err("Invalid connector config".to_string()),
    }
}

fn connector_root_path(record: &ConnectorSyncRecord) -> Result<Option<String>, String> {
    Ok(connector_config(&record.config_json)?
        .get("settings")
        .and_then(|settings| settings.get("rootPath"))
        .and_then(|root_path| root_path.as_str())
        .map(ToString::to_string))
}

#[derive(Clone, Copy)]
enum ConnectorSyncMode {
    Incremental,
    Full,
}

impl ConnectorSyncMode {
    fn as_str(self) -> &'static str {
        match self {
            Self::Incremental => "incremental",
            Self::Full => "full",
        }
    }
}

enum ConnectorSyncOutcome {
    Syncing,
    AlreadySyncing,
    Unsupported(String),
    Error(String),
}

struct ConnectorSyncStart {
    outcome: ConnectorSyncOutcome,
    run: Option<FilesystemSyncRun>,
}

fn connector_sync_response(outcome: ConnectorSyncOutcome) -> (StatusCode, Json<serde_json::Value>) {
    match outcome {
        ConnectorSyncOutcome::Syncing => (
            StatusCode::OK,
            Json(serde_json::json!({"status": "syncing"})),
        ),
        ConnectorSyncOutcome::AlreadySyncing => (
            StatusCode::OK,
            Json(serde_json::json!({"status": "syncing", "message": "Already syncing"})),
        ),
        ConnectorSyncOutcome::Unsupported(provider) => (
            StatusCode::NOT_IMPLEMENTED,
            Json(serde_json::json!({"error": format!("Provider {provider} not yet supported")})),
        ),
        ConnectorSyncOutcome::Error(error) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"error": error})),
        ),
    }
}

fn connector_sync_transport(start: ConnectorSyncStart) -> serde_json::Value {
    let run = start.run.as_ref().map(FilesystemSyncRun::to_json);
    let (status, Json(body)) = connector_sync_response(start.outcome);
    let mut value = serde_json::json!({
        "statusCode": status.as_u16(),
        "body": body,
    });
    if let Some(run) = run {
        value["run"] = run;
    }
    value
}

fn connector_sync_transport_response(
    value: serde_json::Value,
) -> (StatusCode, Json<serde_json::Value>) {
    let status = value
        .get("statusCode")
        .and_then(|status| status.as_u64())
        .and_then(|status| StatusCode::from_u16(status as u16).ok())
        .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    let body = value
        .get("body")
        .cloned()
        .unwrap_or_else(|| serde_json::json!({"error": "invalid connector sync response"}));
    (status, Json(body))
}

fn start_connector_sync(
    conn: &rusqlite::Connection,
    id: &str,
) -> rusqlite::Result<ConnectorSyncStart> {
    start_connector_sync_with_mode(conn, id, ConnectorSyncMode::Incremental)
}

fn start_connector_sync_with_mode(
    conn: &rusqlite::Connection,
    id: &str,
    mode: ConnectorSyncMode,
) -> rusqlite::Result<ConnectorSyncStart> {
    let Some(record) = connector_sync_record(conn, id)? else {
        return Ok(ConnectorSyncStart {
            outcome: ConnectorSyncOutcome::Error("Connector not found".into()),
            run: None,
        });
    };

    if record.status == "syncing" {
        return Ok(ConnectorSyncStart {
            outcome: ConnectorSyncOutcome::AlreadySyncing,
            run: None,
        });
    }

    let provider = match connector_config_provider(&record) {
        Ok(provider) => provider,
        Err(error) => {
            return Ok(ConnectorSyncStart {
                outcome: ConnectorSyncOutcome::Error(error),
                run: None,
            });
        }
    };

    if provider != "filesystem" {
        return Ok(ConnectorSyncStart {
            outcome: ConnectorSyncOutcome::Unsupported(provider),
            run: None,
        });
    }

    conn.execute(
        "UPDATE connectors
         SET status = 'syncing', last_error = NULL, updated_at = ?1
         WHERE id = ?2",
        rusqlite::params![chrono::Utc::now().to_rfc3339(), id],
    )?;
    Ok(ConnectorSyncStart {
        outcome: ConnectorSyncOutcome::Syncing,
        run: Some(FilesystemSyncRun {
            connector_id: record.id.clone(),
            document_connector_id: connector_document_id(&record.config_json)
                .unwrap_or_else(|| record.id.clone()),
            config_json: record.config_json,
            cursor_json: record.cursor_json,
            mode,
        }),
    })
}

fn connector_document_id(config_json: &str) -> Option<String> {
    connector_config(config_json)
        .ok()?
        .get("id")
        .and_then(|value| value.as_str())
        .map(ToString::to_string)
}

#[derive(Clone)]
struct FilesystemSyncRun {
    connector_id: String,
    document_connector_id: String,
    config_json: String,
    cursor_json: Option<String>,
    mode: ConnectorSyncMode,
}

impl FilesystemSyncRun {
    fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "connectorId": self.connector_id,
            "documentConnectorId": self.document_connector_id,
            "configJson": self.config_json,
            "cursorJson": self.cursor_json,
            "mode": self.mode.as_str(),
        })
    }

    fn from_json(value: &serde_json::Value) -> Option<Self> {
        Some(Self {
            connector_id: value.get("connectorId")?.as_str()?.to_string(),
            document_connector_id: value.get("documentConnectorId")?.as_str()?.to_string(),
            config_json: value.get("configJson")?.as_str()?.to_string(),
            cursor_json: value
                .get("cursorJson")
                .and_then(|cursor| cursor.as_str())
                .map(ToString::to_string),
            mode: match value.get("mode")?.as_str()? {
                "incremental" => ConnectorSyncMode::Incremental,
                "full" => ConnectorSyncMode::Full,
                _ => return None,
            },
        })
    }
}

#[derive(Clone)]
struct FilesystemSettings {
    root_path: String,
    patterns: Vec<String>,
    ignore_patterns: Vec<String>,
    max_file_size: u64,
}

impl FilesystemSettings {
    fn parse(config_json: &str) -> Result<Self, String> {
        let config = connector_config(config_json)?;
        let settings = config
            .get("settings")
            .and_then(|settings| settings.as_object())
            .cloned()
            .unwrap_or_default();
        Ok(Self {
            root_path: settings
                .get("rootPath")
                .and_then(|value| value.as_str())
                .unwrap_or("")
                .to_string(),
            patterns: string_array_setting(
                settings.get("patterns"),
                &["**/*.md".to_string(), "**/*.txt".to_string()],
            ),
            ignore_patterns: string_array_setting(
                settings.get("ignorePatterns"),
                &[
                    ".git".to_string(),
                    "node_modules".to_string(),
                    ".DS_Store".to_string(),
                ],
            ),
            max_file_size: settings
                .get("maxFileSize")
                .and_then(|value| value.as_u64())
                .filter(|value| *value > 0)
                .unwrap_or(1_048_576),
        })
    }
}

fn string_array_setting(value: Option<&serde_json::Value>, default: &[String]) -> Vec<String> {
    value
        .and_then(|value| value.as_array())
        .and_then(|items| {
            items
                .iter()
                .map(|item| item.as_str().map(ToString::to_string))
                .collect::<Option<Vec<_>>>()
        })
        .unwrap_or_else(|| default.to_vec())
}

#[derive(Clone)]
struct DiscoveredFile {
    absolute_path: PathBuf,
    relative_path: String,
    name: String,
    modified_at: DateTime<Utc>,
    size: u64,
}

#[derive(Clone)]
struct PreparedFile {
    file: DiscoveredFile,
    content: Option<String>,
}

struct FilesystemSyncResult {
    files: Vec<PreparedFile>,
    errors: Vec<serde_json::Value>,
    cursor_at: String,
}

fn spawn_connector_sync_from_transport(state: Arc<AppState>, value: &serde_json::Value) {
    if let Some(run) = value.get("run").and_then(FilesystemSyncRun::from_json) {
        tokio::spawn(async move {
            run_filesystem_sync_task(state, run).await;
        });
    }
}

fn spawn_connector_sync_runs_from_transport(state: Arc<AppState>, value: &serde_json::Value) {
    if let Some(runs) = value.get("runs").and_then(|runs| runs.as_array()) {
        for run in runs.iter().filter_map(FilesystemSyncRun::from_json) {
            let state = state.clone();
            tokio::spawn(async move {
                run_filesystem_sync_task(state, run).await;
            });
        }
    }
}

async fn run_filesystem_sync_task(state: Arc<AppState>, run: FilesystemSyncRun) {
    let connector_id = run.connector_id.clone();
    let result = prepare_filesystem_sync(&run).await;
    let update_result = state
        .pool
        .write_tx(Priority::Low, move |conn| match result {
            Ok(sync_result) => apply_filesystem_sync_result(conn, &run, sync_result),
            Err(error) => {
                let now = Utc::now().to_rfc3339();
                conn.execute(
                    "UPDATE connectors
                         SET status = 'error', last_error = ?1, updated_at = ?2
                         WHERE id = ?3",
                    rusqlite::params![error, now, run.connector_id],
                )?;
                Ok(serde_json::json!({"status": "error"}))
            }
        })
        .await;
    match update_result {
        Ok(_) => info!(connector_id, "filesystem connector sync completed"),
        Err(error) => error!(connector_id, %error, "filesystem connector sync failed"),
    }
}

async fn prepare_filesystem_sync(run: &FilesystemSyncRun) -> Result<FilesystemSyncResult, String> {
    let settings = FilesystemSettings::parse(&run.config_json)?;
    let since = match run.mode {
        ConnectorSyncMode::Full => None,
        ConnectorSyncMode::Incremental => Some(sync_cursor_time(run.cursor_json.as_deref())),
    };
    let files = discover_files(&settings)
        .into_iter()
        .filter(|file| since.is_none_or(|since| file.modified_at > since))
        .map(|file| {
            let content = if file.size > settings.max_file_size {
                None
            } else {
                std::fs::read_to_string(&file.absolute_path).ok()
            };
            PreparedFile { file, content }
        })
        .collect();
    Ok(FilesystemSyncResult {
        files,
        errors: Vec::new(),
        cursor_at: Utc::now().to_rfc3339(),
    })
}

fn sync_cursor_time(cursor_json: Option<&str>) -> DateTime<Utc> {
    cursor_json
        .and_then(|cursor_json| serde_json::from_str::<serde_json::Value>(cursor_json).ok())
        .and_then(|cursor| {
            cursor
                .get("lastSyncAt")
                .and_then(|value| value.as_str())
                .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
        })
        .map(|value| value.with_timezone(&Utc))
        .unwrap_or(DateTime::<Utc>::UNIX_EPOCH)
}

fn discover_files(settings: &FilesystemSettings) -> Vec<DiscoveredFile> {
    let root = resolve_root(&settings.root_path);
    let wants_dot = settings
        .patterns
        .iter()
        .any(|pattern| pattern_allows_dot_segment(pattern));
    let mut results = Vec::new();
    walk_filesystem_connector_root(&root, &root, settings, wants_dot, &mut results);
    results.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));
    results.dedup_by(|a, b| a.relative_path == b.relative_path);
    results
}

fn resolve_root(root_path: &str) -> PathBuf {
    let path = if root_path.is_empty() {
        PathBuf::new()
    } else {
        PathBuf::from(root_path)
    };
    if path.is_absolute() {
        path
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(path)
    }
}

fn walk_filesystem_connector_root(
    root: &FsPath,
    dir: &FsPath,
    settings: &FilesystemSettings,
    wants_dot: bool,
    results: &mut Vec<DiscoveredFile>,
) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !wants_dot && name.starts_with('.') {
            continue;
        }
        let path = entry.path();
        let relative = match path.strip_prefix(root) {
            Ok(relative) => relative.to_string_lossy().replace('\\', "/"),
            Err(_) => continue,
        };
        if ignored_connector_path(&settings.ignore_patterns, &name, &relative) {
            continue;
        }
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if metadata.is_dir() {
            walk_filesystem_connector_root(root, &path, settings, wants_dot, results);
            continue;
        }
        if !metadata.is_file() {
            continue;
        }
        if !settings
            .patterns
            .iter()
            .any(|pattern| connector_pattern_matches(pattern, &relative))
        {
            continue;
        }
        let modified_at = metadata
            .modified()
            .map(DateTime::<Utc>::from)
            .unwrap_or_else(|_| Utc::now());
        results.push(DiscoveredFile {
            absolute_path: path,
            relative_path: relative,
            name,
            modified_at,
            size: metadata.len(),
        });
    }
}

fn ignored_connector_path(ignore_patterns: &[String], name: &str, relative: &str) -> bool {
    ignore_patterns.iter().any(|pattern| {
        name == pattern || relative == pattern || relative.starts_with(&format!("{pattern}/"))
    })
}

fn connector_pattern_matches(pattern: &str, path: &str) -> bool {
    if has_dot_segment(path) && !pattern_allows_dot_segment(pattern) {
        return false;
    }
    glob_components_match(
        &pattern.to_lowercase().split('/').collect::<Vec<_>>(),
        &path.to_lowercase().split('/').collect::<Vec<_>>(),
    )
}

fn glob_components_match(pattern: &[&str], path: &[&str]) -> bool {
    if pattern.is_empty() {
        return path.is_empty();
    }
    if pattern[0] == "**" {
        return glob_components_match(&pattern[1..], path)
            || (!path.is_empty() && glob_components_match(pattern, &path[1..]));
    }
    !path.is_empty()
        && glob_segment_match(pattern[0], path[0])
        && glob_components_match(&pattern[1..], &path[1..])
}

fn glob_segment_match(pattern: &str, segment: &str) -> bool {
    fn inner(pattern: &[char], segment: &[char]) -> bool {
        if pattern.is_empty() {
            return segment.is_empty();
        }
        match pattern[0] {
            '*' => {
                inner(&pattern[1..], segment)
                    || (!segment.is_empty() && inner(pattern, &segment[1..]))
            }
            '?' => !segment.is_empty() && inner(&pattern[1..], &segment[1..]),
            ch => !segment.is_empty() && ch == segment[0] && inner(&pattern[1..], &segment[1..]),
        }
    }
    inner(
        &pattern.chars().collect::<Vec<_>>(),
        &segment.chars().collect::<Vec<_>>(),
    )
}

fn has_dot_segment(path: &str) -> bool {
    path.split('/').any(|part| part.starts_with('.'))
}

fn pattern_allows_dot_segment(pattern: &str) -> bool {
    pattern.split('/').any(|part| part.starts_with('.'))
}

fn apply_filesystem_sync_result(
    conn: &rusqlite::Connection,
    run: &FilesystemSyncRun,
    mut result: FilesystemSyncResult,
) -> Result<serde_json::Value, CoreError> {
    let force_update = matches!(run.mode, ConnectorSyncMode::Full);
    let mut added = 0usize;
    let mut updated = 0usize;
    for prepared in result.files {
        let source_url = prepared.file.absolute_path.to_string_lossy().to_string();
        let Some(content) = prepared.content else {
            result.errors.push(serde_json::json!({
                "resourceId": prepared.file.relative_path,
                "message": "Failed to read file or file exceeds size limit",
                "retryable": false,
            }));
            continue;
        };
        let existing = conn
            .query_row(
                "SELECT id, updated_at FROM documents WHERE source_url = ?1 LIMIT 1",
                [&source_url],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()?;
        match existing {
            None => {
                let document_id = uuid::Uuid::new_v4().to_string();
                let now = Utc::now().to_rfc3339();
                conn.execute(
                    "INSERT INTO documents
                     (id, source_url, source_type, content_type, title,
                      raw_content, status, error, connector_id,
                      chunk_count, memory_count, metadata_json, created_at, updated_at, completed_at)
                     VALUES (?1, ?2, 'file', 'text/plain', ?3, ?4, 'queued', NULL, ?5,
                             0, 0, NULL, ?6, ?6, NULL)",
                    rusqlite::params![
                        document_id,
                        source_url,
                        prepared.file.name,
                        content,
                        run.document_connector_id,
                        now
                    ],
                )?;
                enqueue_document_ingest_job(conn, &document_id, &content, &now)?;
                added += 1;
            }
            Some((document_id, updated_at)) => {
                let document_updated_at = DateTime::parse_from_rfc3339(&updated_at)
                    .map(|value| value.with_timezone(&Utc))
                    .unwrap_or(DateTime::<Utc>::UNIX_EPOCH);
                if force_update || prepared.file.modified_at > document_updated_at {
                    let now = Utc::now().to_rfc3339();
                    conn.execute(
                        "UPDATE documents
                         SET raw_content = ?1, status = 'queued', error = NULL,
                             chunk_count = 0, memory_count = 0,
                             completed_at = NULL, updated_at = ?2
                         WHERE id = ?3",
                        rusqlite::params![content, now, document_id],
                    )?;
                    enqueue_document_ingest_job(conn, &document_id, &content, &now)?;
                    updated += 1;
                }
            }
        }
    }
    conn.execute(
        "UPDATE connectors
         SET cursor_json = ?1, last_sync_at = ?2, status = 'idle', last_error = NULL, updated_at = ?2
         WHERE id = ?3",
        rusqlite::params![
            serde_json::json!({"lastSyncAt": result.cursor_at}).to_string(),
            result.cursor_at,
            run.connector_id
        ],
    )?;
    Ok(serde_json::json!({
        "status": "idle",
        "documentsAdded": added,
        "documentsUpdated": updated,
        "errors": result.errors,
    }))
}

fn enqueue_document_ingest_job(
    conn: &rusqlite::Connection,
    document_id: &str,
    content: &str,
    now: &str,
) -> Result<(), CoreError> {
    job::enqueue(
        conn,
        &job::EnqueueJob {
            id: &uuid::Uuid::new_v4().to_string(),
            memory_id: None,
            job_type: "document_ingest",
            payload: Some(
                &serde_json::json!({
                    "documentId": document_id,
                    "content": content,
                })
                .to_string(),
            ),
            max_attempts: 3,
            now,
            document_id: Some(document_id),
        },
    )?;
    Ok(())
}

fn connector_row_json(r: &rusqlite::Row<'_>) -> rusqlite::Result<serde_json::Value> {
    let id: String = r.get(0)?;
    let provider: String = r.get(1)?;
    let display_name: Option<String> = r.get(2)?;
    let config_json: String = r.get::<_, String>(3).unwrap_or_else(|_| "{}".into());
    let cursor_json: Option<String> = r.get(4)?;
    let status: Option<String> = r.get(5)?;
    let last_sync_at: Option<String> = r.get(6)?;
    let last_error: Option<String> = r.get(7)?;
    let created_at: String = r.get(8)?;
    let updated_at: String = r.get(9)?;
    let settings_json: String = r
        .get::<_, String>(10)
        .unwrap_or_else(|_| config_json.clone());
    let enabled = r.get::<_, bool>(11).unwrap_or(true);
    let settings = parse_connector_settings(&settings_json);

    Ok(serde_json::json!({
        "id": id,
        "provider": provider,
        "display_name": display_name,
        "config_json": config_json,
        "cursor_json": cursor_json,
        "status": status,
        "last_sync_at": last_sync_at,
        "last_error": last_error,
        "created_at": created_at,
        "updated_at": updated_at,
        "settings_json": settings_json,
        "enabled": enabled,
        "displayName": display_name,
        "settings": settings,
        "createdAt": created_at,
        "updatedAt": updated_at,
    }))
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

/// GET /api/connectors — list registered connectors
pub async fn list(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let result = state
        .pool
        .read(|conn| {
            let exists: bool = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='connectors'",
                    [],
                    |r| r.get::<_, i64>(0),
                )
                .map(|c| c > 0)
                .unwrap_or(false);

            if !exists {
                return Ok(serde_json::json!({"connectors": [], "count": 0}));
            }

            let mut stmt = conn.prepare_cached(
                "SELECT id, provider, display_name, config_json, cursor_json, status, last_sync_at, last_error, created_at, updated_at, settings_json, enabled
                 FROM connectors ORDER BY created_at DESC",
            )?;
            let rows: Vec<serde_json::Value> = stmt
                .query_map([], connector_row_json)?
                .collect::<rusqlite::Result<Vec<_>>>()?;

            let count = rows.len();
            Ok(serde_json::json!({"connectors": rows, "count": count}))
        })
        .await;

    match result {
        Ok(val) => (StatusCode::OK, Json(val)),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": format!("{e}")})),
        ),
    }
}

/// POST /api/connectors — register a connector
pub async fn create(
    State(state): State<Arc<AppState>>,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    let provider = match body.get("provider").and_then(|v| v.as_str()) {
        Some(p) => p.to_string(),
        None => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"error": "missing provider"})),
            );
        }
    };

    let display = body
        .get("displayName")
        .and_then(|v| v.as_str())
        .unwrap_or(&provider)
        .to_string();
    let settings = body
        .get("settings")
        .cloned()
        .unwrap_or(serde_json::json!({}));
    let id = uuid::Uuid::new_v4().to_string();
    let config_json = serde_json::to_string(&serde_json::json!({
        "id": id,
        "provider": provider,
        "displayName": display,
        "settings": settings,
        "enabled": true,
    }))
    .unwrap_or_else(|_| "{}".into());
    let settings_json = serde_json::to_string(&settings).unwrap_or_else(|_| "{}".into());

    let now = chrono::Utc::now().to_rfc3339();

    let result = state
        .pool
        .write(signet_core::db::Priority::Low, {
            let id = id.clone();
            move |conn| {
                conn.execute(
                    "INSERT INTO connectors (id, provider, display_name, config_json, settings_json, enabled, status, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, 1, 'idle', ?6, ?6)",
                    rusqlite::params![id, provider, display, config_json, settings_json, now],
                )?;
                Ok(serde_json::json!({"id": id}))
            }
        })
        .await;

    match result {
        Ok(val) => (StatusCode::CREATED, Json(val)),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": format!("{e}")})),
        ),
    }
}

/// GET /api/connectors/:id — get single connector
pub async fn get(State(state): State<Arc<AppState>>, Path(id): Path<String>) -> impl IntoResponse {
    let result = state
        .pool
        .read(move |conn| {
            let connector = conn
                .query_row(
                "SELECT id, provider, display_name, config_json, cursor_json, status, last_sync_at, last_error, created_at, updated_at, settings_json, enabled
                 FROM connectors WHERE id = ?1",
                [&id],
                connector_row_json,
                )
                .optional()?;
            connector.ok_or_else(|| signet_core::CoreError::NotFound("connector".into()))
        })
        .await;

    match result {
        Ok(val) => (StatusCode::OK, Json(val)),
        Err(signet_core::CoreError::NotFound(_)) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"error": "Connector not found"})),
        ),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": format!("{e}")})),
        ),
    }
}

/// GET /api/connectors/:id/health
pub async fn health(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let result = state
        .pool
        .read(move |conn| {
            let Some(record) = connector_sync_record(conn, &id)? else {
                return Err(signet_core::CoreError::NotFound("connector".into()));
            };
            let document_count =
                match connector_root_path(&record).map_err(signet_core::CoreError::Invalid)? {
                    Some(root_path) => conn.query_row(
                        "SELECT COUNT(*) FROM documents
                     WHERE source_url LIKE ?1 ESCAPE '\\'",
                        [escape_like_prefix(&root_path)],
                        |r| r.get::<_, i64>(0),
                    )?,
                    None => 0,
                };
            Ok(serde_json::json!({
                "id": record.id,
                "status": record.status,
                "lastSyncAt": record.last_sync_at,
                "lastError": record.last_error,
                "documentCount": document_count,
            }))
        })
        .await;

    match result {
        Ok(val) => (StatusCode::OK, Json(val)),
        Err(signet_core::CoreError::NotFound(_)) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"error": "Connector not found"})),
        ),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": format!("{e}")})),
        ),
    }
}

#[derive(Debug, Deserialize)]
pub struct DeleteQuery {
    pub cascade: Option<String>,
}

/// DELETE /api/connectors/:id
pub async fn delete(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Query(params): Query<DeleteQuery>,
) -> impl IntoResponse {
    let cascade = params.cascade.as_deref() == Some("true");

    let result = state
        .pool
        .write(signet_core::db::Priority::Low, move |conn| {
            let Some(record) = connector_sync_record(conn, &id)? else {
                return Err(CoreError::NotFound("connector".into()));
            };
            if cascade {
                if let Some(root_path) =
                    connector_root_path(&record).map_err(signet_core::CoreError::Invalid)?
                {
                    let now = Utc::now().to_rfc3339();
                    conn.execute(
                        "UPDATE documents
                         SET status = 'deleted',
                             error = 'Connector removed',
                             updated_at = ?1
                         WHERE source_url LIKE ?2 ESCAPE '\\'",
                        rusqlite::params![now, escape_like_prefix(&root_path)],
                    )?;
                }
            }
            let changed = conn.execute("DELETE FROM connectors WHERE id = ?1", [&id])?;
            Ok(serde_json::json!({"deleted": changed > 0}))
        })
        .await;

    match result {
        Ok(val) => (StatusCode::OK, Json(val)),
        Err(signet_core::CoreError::NotFound(_)) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"error": "Connector not found"})),
        ),
        Err(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": "Failed to remove connector"})),
        ),
    }
}

/// POST /api/connectors/:id/sync — trigger sync
pub async fn sync(State(state): State<Arc<AppState>>, Path(id): Path<String>) -> impl IntoResponse {
    let result = state.pool.write(signet_core::db::Priority::Low, {
        move |conn| Ok(connector_sync_transport(start_connector_sync(conn, &id)?))
    });

    match result.await {
        Ok(value) => {
            spawn_connector_sync_from_transport(state, &value);
            connector_sync_transport_response(value)
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": format!("{e}")})),
        ),
    }
}

#[derive(Debug, Deserialize)]
pub struct FullSyncQuery {
    pub confirm: Option<String>,
}

/// POST /api/connectors/:id/sync/full — trigger a full sync after confirmation
pub async fn sync_full(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Query(params): Query<FullSyncQuery>,
) -> impl IntoResponse {
    if params.confirm.as_deref() != Some("true") {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "Full resync requires ?confirm=true"})),
        );
    }

    let result = state.pool.write(signet_core::db::Priority::Low, {
        move |conn| {
            Ok(connector_sync_transport(start_connector_sync_with_mode(
                conn,
                &id,
                ConnectorSyncMode::Full,
            )?))
        }
    });

    match result.await {
        Ok(value) => {
            spawn_connector_sync_from_transport(state, &value);
            connector_sync_transport_response(value)
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": format!("{e}")})),
        ),
    }
}

/// POST /api/connectors/resync — trigger incremental sync for all connectors
pub async fn resync(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let result = state
        .pool
        .write(signet_core::db::Priority::Low, |conn| {
            let ids = {
                let mut stmt =
                    conn.prepare("SELECT id FROM connectors ORDER BY created_at DESC")?;
                stmt.query_map([], |r| r.get::<_, String>(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()?
            };

            let mut started = 0;
            let mut already_syncing = 0;
            let mut unsupported = 0;
            let mut failed = 0;
            let mut runs = Vec::new();

            for id in &ids {
                match start_connector_sync(conn, id)? {
                    ConnectorSyncStart {
                        outcome: ConnectorSyncOutcome::Syncing,
                        run,
                    } => {
                        started += 1;
                        if let Some(run) = run {
                            runs.push(run.to_json());
                        }
                    }
                    ConnectorSyncStart {
                        outcome: ConnectorSyncOutcome::AlreadySyncing,
                        ..
                    } => already_syncing += 1,
                    ConnectorSyncStart {
                        outcome: ConnectorSyncOutcome::Unsupported(_),
                        ..
                    } => unsupported += 1,
                    ConnectorSyncStart {
                        outcome: ConnectorSyncOutcome::Error(_),
                        ..
                    } => failed += 1,
                }
            }

            Ok(serde_json::json!({
                "status": "ok",
                "total": ids.len(),
                "started": started,
                "alreadySyncing": already_syncing,
                "unsupported": unsupported,
                "failed": failed,
                "runs": runs,
            }))
        })
        .await;

    match result {
        Ok(mut val) => {
            spawn_connector_sync_runs_from_transport(state, &val);
            if let Some(object) = val.as_object_mut() {
                object.remove("runs");
            }
            (StatusCode::OK, Json(val))
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({
                "status": "error",
                "error": "Failed to trigger connector re-sync",
                "total": 0,
                "started": 0,
                "alreadySyncing": 0,
                "unsupported": 0,
                "failed": 0,
                "detail": format!("{e}"),
            })),
        ),
    }
}
