//! Document ingestion routes.
//!
//! Ingest, list, get, chunks, and delete endpoints.

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

#[derive(Debug, Deserialize)]
pub struct ListQuery {
    pub status: Option<String>,
    pub limit: Option<usize>,
    pub offset: Option<usize>,
}

/// GET /api/documents — list documents
pub async fn list(
    State(state): State<Arc<AppState>>,
    Query(params): Query<ListQuery>,
) -> impl IntoResponse {
    let limit = params.limit.unwrap_or(50).min(500);
    let offset = params.offset.unwrap_or(0);

    let result = state
        .pool
        .read(move |conn| {
            let exists: bool = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='documents'",
                    [],
                    |r| r.get::<_, i64>(0),
                )
                .map(|c| c > 0)
                .unwrap_or(false);

            if !exists {
                return Ok(serde_json::json!({"documents": [], "total": 0, "limit": limit, "offset": offset}));
            }

            let total: i64 = conn
                .query_row("SELECT COUNT(*) FROM documents", [], |r| r.get(0))
                .unwrap_or(0);

            let sql = if params.status.is_some() {
                "SELECT id, source_url, source_type, content_type, title, status, connector_id, chunk_count, created_at, updated_at
                 FROM documents WHERE status = ?1 ORDER BY created_at DESC LIMIT ?2 OFFSET ?3"
            } else {
                "SELECT id, source_url, source_type, content_type, title, status, connector_id, chunk_count, created_at, updated_at
                 FROM documents ORDER BY created_at DESC LIMIT ?1 OFFSET ?2"
            };

            let rows: Vec<serde_json::Value> = if let Some(ref status) = params.status {
                let mut stmt = conn.prepare(sql)?;
                stmt.query_map(rusqlite::params![status, limit, offset], |r| {
                    Ok(doc_from_row(r))
                })?
                .filter_map(|r| r.ok())
                .collect()
            } else {
                let mut stmt = conn.prepare(sql)?;
                stmt.query_map(rusqlite::params![limit, offset], |r| {
                    Ok(doc_from_row(r))
                })?
                .filter_map(|r| r.ok())
                .collect()
            };

            Ok(serde_json::json!({
                "documents": rows,
                "total": total,
                "limit": limit,
                "offset": offset,
            }))
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

fn doc_from_row(r: &rusqlite::Row) -> serde_json::Value {
    serde_json::json!({
        "id": r.get::<_, String>(0).unwrap_or_default(),
        "sourceUrl": r.get::<_, Option<String>>(1).unwrap_or_default(),
        "sourceType": r.get::<_, Option<String>>(2).unwrap_or_default(),
        "contentType": r.get::<_, Option<String>>(3).unwrap_or_default(),
        "title": r.get::<_, Option<String>>(4).unwrap_or_default(),
        "status": r.get::<_, String>(5).unwrap_or_default(),
        "connectorId": r.get::<_, Option<String>>(6).unwrap_or_default(),
        "chunkCount": r.get::<_, Option<i64>>(7).unwrap_or_default(),
        "createdAt": r.get::<_, String>(8).unwrap_or_default(),
        "updatedAt": r.get::<_, String>(9).unwrap_or_default(),
    })
}

/// POST /api/documents — ingest a document
pub async fn ingest(
    State(state): State<Arc<AppState>>,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    let source_type = body
        .get("source_type")
        .and_then(|v| v.as_str())
        .unwrap_or("text")
        .to_string();
    let content = body
        .get("content")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let title = body
        .get("title")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let url = body
        .get("url")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let connector_id = body
        .get("connector_id")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();

    let result = state
        .pool
        .write(signet_core::db::Priority::Low, {
            let id = id.clone();
            move |conn| {
                conn.execute(
                    "INSERT INTO documents (id, source_url, source_type, content_type, title, raw_content, status, connector_id, chunk_count, created_at, updated_at)
                     VALUES (?1, ?2, ?3, 'text/plain', ?4, ?5, 'queued', ?6, 0, ?7, ?7)",
                    rusqlite::params![id, url, source_type, title, content, connector_id, now],
                )?;
                conn.execute(
                    "INSERT INTO memory_jobs
                     (id, memory_id, document_id, job_type, status, payload, created_at, updated_at)
                     VALUES (?1, NULL, ?2, 'document_ingest', 'pending', ?3, ?4, ?4)",
                    rusqlite::params![
                        uuid::Uuid::new_v4().to_string(),
                        id,
                        serde_json::json!({
                            "documentId": id,
                            "content": content,
                        })
                        .to_string(),
                        now
                    ],
                )?;
                Ok(serde_json::json!({"id": id, "status": "queued"}))
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

/// GET /api/documents/:id — get single document
pub async fn get(State(state): State<Arc<AppState>>, Path(id): Path<String>) -> impl IntoResponse {
    let result = state
        .pool
        .read(move |conn| {
            conn.query_row(
                "SELECT id, source_url, source_type, content_type, title, status, connector_id, chunk_count, created_at, updated_at
                 FROM documents WHERE id = ?1",
                [&id],
                |r| Ok(doc_from_row(r)),
            )
            .map_err(|_| signet_core::CoreError::NotFound("document".into()))
        })
        .await;

    match result {
        Ok(val) => (StatusCode::OK, Json(val)),
        Err(_) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"error": "Document not found"})),
        ),
    }
}

/// GET /api/documents/:id/chunks — get document chunks
pub async fn chunks(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let result = state
        .pool
        .read(move |conn| {
            let mut stmt = conn.prepare_cached(
                "SELECT m.id, m.content, m.type, m.created_at, dm.chunk_index
                 FROM document_memories dm
                 JOIN memories m ON m.id = dm.memory_id
                 WHERE dm.document_id = ?1 AND m.is_deleted = 0
                 ORDER BY dm.chunk_index ASC",
            )?;
            let rows: Vec<serde_json::Value> = stmt
                .query_map([&id], |r| {
                    Ok(serde_json::json!({
                        "id": r.get::<_, String>(0)?,
                        "content": r.get::<_, String>(1)?,
                        "type": r.get::<_, String>(2)?,
                        "createdAt": r.get::<_, String>(3)?,
                        "chunkIndex": r.get::<_, Option<i32>>(4)?,
                    }))
                })?
                .filter_map(|r| r.ok())
                .collect();
            let count = rows.len();
            Ok(serde_json::json!({"chunks": rows, "count": count}))
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

#[derive(Debug, Deserialize)]
pub struct DeleteQuery {
    pub reason: Option<String>,
}

/// DELETE /api/documents/:id
pub async fn delete(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Query(params): Query<DeleteQuery>,
) -> impl IntoResponse {
    if params.reason.is_none() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "reason query parameter is required"})),
        );
    }
    let reason = params.reason.unwrap_or_default();

    let result = state
        .pool
        .write(signet_core::db::Priority::Low, move |conn| {
            let exists = conn
                .prepare_cached("SELECT id FROM documents WHERE id = ?1")?
                .exists([&id])?;
            if !exists {
                return Ok(serde_json::json!({"__notFound": true}));
            }

            let now = chrono::Utc::now().to_rfc3339();
            let mut stmt =
                conn.prepare_cached("SELECT memory_id FROM document_memories WHERE document_id = ?1")?;
            let linked_memories: Vec<String> = stmt
                .query_map([&id], |row| row.get::<_, String>(0))?
                .filter_map(|row| row.ok())
                .collect();
            drop(stmt);

            let mut removed = 0_i64;
            for memory_id in linked_memories {
                let updated = conn.execute(
                    "UPDATE memories
                     SET is_deleted = 1, deleted_at = ?1, updated_at = ?1,
                         updated_by = 'document-api', version = version + 1
                     WHERE id = ?2 AND COALESCE(is_deleted, 0) = 0",
                    rusqlite::params![now, memory_id],
                )?;
                if updated > 0 {
                    conn.execute(
                        "INSERT INTO memory_history
                         (id, memory_id, event, old_content, new_content,
                          changed_by, reason, metadata, created_at)
                         VALUES (?1, ?2, 'deleted', NULL, NULL, 'document-api', ?3, NULL, ?4)",
                        rusqlite::params![
                            uuid::Uuid::new_v4().to_string(),
                            memory_id,
                            format!("Document deleted: {reason}"),
                            now,
                        ],
                    )?;
                    removed += 1;
                }
            }

            conn.execute(
                "UPDATE documents SET status = 'deleted', error = ?1, updated_at = ?2 WHERE id = ?3",
                rusqlite::params![reason, now, id],
            )?;
            Ok(serde_json::json!({"deleted": true, "memoriesRemoved": removed}))
        })
        .await;

    match result {
        Ok(val) if val.get("__notFound").and_then(|v| v.as_bool()) == Some(true) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"error": "Document not found"})),
        ),
        Ok(val) => (StatusCode::OK, Json(val)),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": format!("{e}")})),
        ),
    }
}
