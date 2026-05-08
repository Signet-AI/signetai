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

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

fn list_connectors_value(
    conn: &rusqlite::Connection,
) -> Result<serde_json::Value, signet_core::CoreError> {
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
        "SELECT id, provider, display_name, config_json, cursor_json, status,
                last_sync_at, last_error, created_at, updated_at
         FROM connectors ORDER BY created_at DESC",
    )?;
    let rows: Vec<serde_json::Value> = stmt
        .query_map([], |r| {
            Ok(serde_json::json!({
                "id": r.get::<_, String>(0)?,
                "provider": r.get::<_, String>(1)?,
                "display_name": r.get::<_, Option<String>>(2)?,
                "config_json": r.get::<_, String>(3)?,
                "cursor_json": r.get::<_, Option<String>>(4)?,
                "status": r.get::<_, String>(5)?,
                "last_sync_at": r.get::<_, Option<String>>(6)?,
                "last_error": r.get::<_, Option<String>>(7)?,
                "created_at": r.get::<_, String>(8)?,
                "updated_at": r.get::<_, String>(9)?,
            }))
        })?
        .filter_map(|r| r.ok())
        .collect();

    let count = rows.len();
    Ok(serde_json::json!({"connectors": rows, "count": count}))
}

/// GET /api/connectors — list registered connectors
pub async fn list(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let result = state.pool.read(list_connectors_value).await;

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
    let settings_json = serde_json::to_string(&settings).unwrap_or_else(|_| "{}".into());

    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();

    let result = state
        .pool
        .write(signet_core::db::Priority::Low, {
            let id = id.clone();
            move |conn| {
                conn.execute(
                    "INSERT INTO connectors (id, provider, display_name, settings_json, enabled, status, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, 1, 'idle', ?5, ?5)",
                    rusqlite::params![id, provider, display, settings_json, now],
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
                "SELECT id, provider, display_name, settings_json, enabled, status, created_at, updated_at
                 FROM connectors WHERE id = ?1",
                [&id],
                |r| {
                    let settings_str: String = r.get::<_, String>(3).unwrap_or_else(|_| "{}".into());
                    let settings: serde_json::Value =
                        serde_json::from_str(&settings_str).unwrap_or(serde_json::json!({}));
                    Ok(serde_json::json!({
                        "id": r.get::<_, String>(0)?,
                        "provider": r.get::<_, String>(1)?,
                        "displayName": r.get::<_, Option<String>>(2)?,
                        "settings": settings,
                        "enabled": r.get::<_, bool>(4)?,
                        "status": r.get::<_, Option<String>>(5)?,
                        "createdAt": r.get::<_, String>(6)?,
                        "updatedAt": r.get::<_, String>(7)?,
                    }))
                },
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
    (
        StatusCode::NOT_IMPLEMENTED,
        Json(serde_json::json!({"error": "connector sync not yet implemented"})),
    )
}

#[cfg(test)]
mod tests {
    use rusqlite::Connection;

    #[test]
    fn list_uses_typescript_connector_schema() {
        let conn = Connection::open_in_memory().expect("open sqlite");
        conn.execute_batch(
            r#"
            CREATE TABLE connectors (
                id TEXT PRIMARY KEY,
                provider TEXT NOT NULL,
                display_name TEXT,
                config_json TEXT NOT NULL,
                cursor_json TEXT,
                status TEXT NOT NULL DEFAULT 'idle',
                last_sync_at TEXT,
                last_error TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            INSERT INTO connectors (
                id, provider, display_name, config_json, cursor_json,
                status, last_sync_at, last_error, created_at, updated_at
            ) VALUES (
                'connector-1', 'filesystem', 'Docs',
                '{"id":"connector-1","provider":"filesystem","displayName":"Docs","settings":{"path":"/tmp/docs"},"enabled":true}',
                '{"lastSyncAt":"2026-05-08T00:00:00.000Z"}',
                'idle', NULL, NULL,
                '2026-05-08T00:00:00.000Z',
                '2026-05-08T00:00:00.000Z'
            );
            "#,
        )
        .expect("create connector fixture");

        let body = super::list_connectors_value(&conn).expect("list connectors");

        assert_eq!(body["count"], 1);
        assert_eq!(body["connectors"][0]["id"], "connector-1");
        assert_eq!(
            body["connectors"][0]["config_json"],
            "{\"id\":\"connector-1\",\"provider\":\"filesystem\",\"displayName\":\"Docs\",\"settings\":{\"path\":\"/tmp/docs\"},\"enabled\":true}"
        );
        assert_eq!(
            body["connectors"][0]["cursor_json"],
            "{\"lastSyncAt\":\"2026-05-08T00:00:00.000Z\"}"
        );
        assert_eq!(body["connectors"][0]["status"], "idle");
        assert_eq!(body["connectors"][0]["last_error"], serde_json::Value::Null);
    }
}
