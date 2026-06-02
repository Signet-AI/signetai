//! Connector routes.
//!
//! Filesystem connector registry with CRUD and sync operations.

use std::sync::Arc;

use axum::{
    Json,
    extract::{Path, Query, State},
    http::StatusCode,
    response::IntoResponse,
};
use rusqlite::OptionalExtension;
use serde::Deserialize;

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
    status: String,
    last_sync_at: Option<String>,
    last_error: Option<String>,
}

fn connector_sync_record(
    conn: &rusqlite::Connection,
    id: &str,
) -> rusqlite::Result<Option<ConnectorSyncRecord>> {
    conn.query_row(
        "SELECT id, config_json, status, last_sync_at, last_error
         FROM connectors WHERE id = ?1",
        [id],
        |r| {
            Ok(ConnectorSyncRecord {
                id: r.get(0)?,
                config_json: r.get::<_, String>(1).unwrap_or_else(|_| "{}".into()),
                status: r.get(2)?,
                last_sync_at: r.get(3)?,
                last_error: r.get(4)?,
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

enum ConnectorSyncOutcome {
    Syncing,
    AlreadySyncing,
    Unsupported(String),
    Error(String),
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

fn connector_sync_transport(outcome: ConnectorSyncOutcome) -> serde_json::Value {
    let (status, Json(body)) = connector_sync_response(outcome);
    serde_json::json!({
        "statusCode": status.as_u16(),
        "body": body,
    })
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
) -> rusqlite::Result<ConnectorSyncOutcome> {
    let Some(record) = connector_sync_record(conn, id)? else {
        return Ok(ConnectorSyncOutcome::Error("Connector not found".into()));
    };

    if record.status == "syncing" {
        return Ok(ConnectorSyncOutcome::AlreadySyncing);
    }

    let provider = match connector_config_provider(&record) {
        Ok(provider) => provider,
        Err(error) => return Ok(ConnectorSyncOutcome::Error(error)),
    };

    if provider != "filesystem" {
        return Ok(ConnectorSyncOutcome::Unsupported(provider));
    }

    conn.execute(
        "UPDATE connectors
         SET status = 'syncing', last_error = NULL, updated_at = ?1
         WHERE id = ?2",
        rusqlite::params![chrono::Utc::now().to_rfc3339(), id],
    )?;
    Ok(ConnectorSyncOutcome::Syncing)
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
            conn.query_row(
                "SELECT id, provider, display_name, config_json, cursor_json, status, last_sync_at, last_error, created_at, updated_at, settings_json, enabled
                 FROM connectors WHERE id = ?1",
                [&id],
                connector_row_json,
            )
            .map_err(|_| signet_core::CoreError::NotFound("connector".into()))
        })
        .await;

    match result {
        Ok(val) => (StatusCode::OK, Json(val)),
        Err(_) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"error": "connector not found"})),
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
            if cascade {
                conn.execute("DELETE FROM documents WHERE connector_id = ?1", [&id])?;
            }
            let changed = conn.execute("DELETE FROM connectors WHERE id = ?1", [&id])?;
            Ok(serde_json::json!({"deleted": changed > 0}))
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

/// POST /api/connectors/:id/sync — trigger sync
pub async fn sync(State(state): State<Arc<AppState>>, Path(id): Path<String>) -> impl IntoResponse {
    let result = state.pool.write(signet_core::db::Priority::Low, {
        move |conn| Ok(connector_sync_transport(start_connector_sync(conn, &id)?))
    });

    match result.await {
        Ok(value) => connector_sync_transport_response(value),
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
        move |conn| Ok(connector_sync_transport(start_connector_sync(conn, &id)?))
    });

    match result.await {
        Ok(value) => connector_sync_transport_response(value),
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

            for id in &ids {
                match start_connector_sync(conn, id)? {
                    ConnectorSyncOutcome::Syncing => started += 1,
                    ConnectorSyncOutcome::AlreadySyncing => already_syncing += 1,
                    ConnectorSyncOutcome::Unsupported(_) => unsupported += 1,
                    ConnectorSyncOutcome::Error(_) => failed += 1,
                }
            }

            Ok(serde_json::json!({
                "status": "ok",
                "total": ids.len(),
                "started": started,
                "alreadySyncing": already_syncing,
                "unsupported": unsupported,
                "failed": failed,
            }))
        })
        .await;

    match result {
        Ok(val) => (StatusCode::OK, Json(val)),
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
