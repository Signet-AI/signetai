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
pub async fn sync(
    State(_state): State<Arc<AppState>>,
    Path(_id): Path<String>,
) -> impl IntoResponse {
    // Connector sync requires filesystem scanning — stub
    (
        StatusCode::NOT_IMPLEMENTED,
        Json(serde_json::json!({"error": "connector sync not yet implemented"})),
    )
}
