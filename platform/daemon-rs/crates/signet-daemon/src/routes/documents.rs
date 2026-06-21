//! Document ingestion routes.
//!
//! Ingest, list, get, chunks, and delete endpoints.

use std::{net::SocketAddr, sync::Arc};

use axum::{
    Json,
    extract::{ConnectInfo, Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use rusqlite::OptionalExtension;
use serde::Deserialize;

use crate::{
    auth::{
        middleware::{authenticate_headers, require_permission_guard, resolve_scoped_agent},
        types::{AuthMode, Permission, TokenRole},
    },
    state::AppState,
};

#[derive(Debug, Deserialize)]
pub struct ListQuery {
    pub status: Option<String>,
    pub limit: Option<usize>,
    pub offset: Option<usize>,
}

#[derive(Debug, Deserialize)]
pub struct AgentSelectorQuery {
    #[serde(rename = "agentId")]
    pub agent_id_camel: Option<String>,
    pub agent_id: Option<String>,
}

impl AgentSelectorQuery {
    fn requested_agent<'a>(&'a self, headers: &'a HeaderMap) -> Option<&'a str> {
        self.agent_id_camel
            .as_deref()
            .or(self.agent_id.as_deref())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .or_else(|| {
                headers
                    .get("x-signet-agent-id")
                    .and_then(|value| value.to_str().ok())
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
            })
    }
}

#[derive(Clone)]
struct DocumentAccess {
    agent_id: String,
    agent_filter: Option<String>,
    project_filter: Option<String>,
    scoped: bool,
}

fn json_string_field<'a>(body: &'a serde_json::Value, key: &str) -> Option<&'a str> {
    body.get(key)
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

fn metadata_project(body: &serde_json::Value) -> Option<&str> {
    body.get("metadata")
        .and_then(|metadata| metadata.get("project"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

fn document_access_or_response(
    state: &AppState,
    peer: SocketAddr,
    headers: &HeaderMap,
    requested_agent: Option<&str>,
    requested_project: Option<&str>,
) -> Result<DocumentAccess, Response> {
    let is_local = peer.ip().is_loopback();
    let auth_runtime = state.auth_snapshot();
    let auth = authenticate_headers(
        auth_runtime.mode,
        auth_runtime.secret.as_deref(),
        headers,
        is_local,
    )
    .map_err(|error| *error)?;
    require_permission_guard(&auth, Permission::Documents, auth_runtime.mode, is_local)
        .map_err(|error| *error)?;

    let agent_id = resolve_scoped_agent(&auth, auth_runtime.mode, is_local, requested_agent)
        .map_err(|reason| {
            (
                StatusCode::FORBIDDEN,
                Json(serde_json::json!({"error": reason})),
            )
                .into_response()
        })?;
    let token_scope = auth.result.claims.as_ref().map(|claims| &claims.scope);
    let token_project = token_scope.and_then(|scope| scope.project.as_deref());
    let enforce_scope = auth_runtime.mode != AuthMode::Local
        && !(auth_runtime.mode == AuthMode::Hybrid && is_local && !auth.result.authenticated);
    let is_admin = auth
        .result
        .claims
        .as_ref()
        .is_some_and(|claims| claims.role == TokenRole::Admin);
    if enforce_scope && !is_admin {
        if let (Some(token_project), Some(requested_project)) = (token_project, requested_project) {
            if token_project != requested_project {
                return Err((
                    StatusCode::FORBIDDEN,
                    Json(serde_json::json!({"error": format!(
                        "scope restricted to project '{token_project}'"
                    )})),
                )
                    .into_response());
            }
        }
    }

    let scoped = enforce_scope;
    let agent_filter = if scoped { Some(agent_id.clone()) } else { None };
    let project_filter = if scoped && is_admin {
        requested_project
            .or(token_project)
            .map(|value| value.to_string())
    } else if scoped {
        token_project
            .or(requested_project)
            .map(|value| value.to_string())
    } else {
        requested_project.map(|value| value.to_string())
    };

    Ok(DocumentAccess {
        agent_id,
        agent_filter,
        project_filter,
        scoped,
    })
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

/// GET /api/documents — list documents
pub async fn list(
    State(state): State<Arc<AppState>>,
    Query(params): Query<ListQuery>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Response {
    let access = match document_access_or_response(&state, peer, &headers, None, None) {
        Ok(access) => access,
        Err(response) => return response,
    };
    if access.scoped {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({"error": "documents list requires unscoped credentials"})),
        )
            .into_response();
    }

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
                stmt.query_map(rusqlite::params![status, limit, offset], |r| Ok(doc_from_row(r)))?
                    .filter_map(|r| r.ok())
                    .collect()
            } else {
                let mut stmt = conn.prepare(sql)?;
                stmt.query_map(rusqlite::params![limit, offset], |r| Ok(doc_from_row(r)))?
                    .filter_map(|r| r.ok())
                    .collect()
            };
            Ok(serde_json::json!({"documents": rows, "total": total, "limit": limit, "offset": offset}))
        })
        .await;

    match result {
        Ok(val) => (StatusCode::OK, Json(val)).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": format!("{e}")})),
        )
            .into_response(),
    }
}

/// POST /api/documents — ingest a document
pub async fn ingest(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<serde_json::Value>,
) -> Response {
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
        .map(str::to_string);
    let url = body.get("url").and_then(|v| v.as_str()).map(str::to_string);
    let connector_id = body
        .get("connector_id")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let metadata_json = body.get("metadata").map(|metadata| metadata.to_string());
    let header_agent = headers
        .get("x-signet-agent-id")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let requested_agent = json_string_field(&body, "agentId")
        .or_else(|| json_string_field(&body, "agent_id"))
        .or(header_agent);
    let requested_project = json_string_field(&body, "project").or_else(|| metadata_project(&body));
    let access = match document_access_or_response(
        &state,
        peer,
        &headers,
        requested_agent,
        requested_project,
    ) {
        Ok(access) => access,
        Err(response) => return response,
    };
    let agent_id = access.agent_id;
    let project = access.project_filter;
    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();

    let result = state
        .pool
        .write(signet_core::db::Priority::Low, {
            let id = id.clone();
            move |conn| {
                if let Some(source_url) = url.as_ref() {
                    let existing = conn
                        .query_row(
                            "SELECT id, status FROM documents
                             WHERE source_url = ?1
                               AND status NOT IN ('failed', 'deleted')
                               AND agent_id = ?2
                               AND ((?3 IS NULL AND project IS NULL) OR project = ?3)
                             LIMIT 1",
                            rusqlite::params![source_url, agent_id, project],
                            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
                        )
                        .optional()?;
                    if let Some((existing_id, status)) = existing {
                        return Ok(serde_json::json!({
                            "id": existing_id,
                            "status": status,
                            "deduplicated": true,
                        }));
                    }
                }
                conn.execute(
                    "INSERT INTO documents (id, source_url, source_type, content_type, title, raw_content, status, connector_id, chunk_count, metadata_json, agent_id, project, created_at, updated_at)
                     VALUES (?1, ?2, ?3, 'text/plain', ?4, ?5, 'queued', ?6, 0, ?7, ?8, ?9, ?10, ?10)",
                    rusqlite::params![id, url, source_type, title, content, connector_id, metadata_json, agent_id, project, now],
                )?;
                conn.execute(
                    "INSERT INTO memory_jobs
                     (id, memory_id, document_id, job_type, status, payload, created_at, updated_at)
                     VALUES (?1, NULL, ?2, 'document_ingest', 'pending', ?3, ?4, ?4)",
                    rusqlite::params![
                        uuid::Uuid::new_v4().to_string(),
                        id,
                        serde_json::json!({"documentId": id, "content": content, "agentId": agent_id, "project": project}).to_string(),
                        now
                    ],
                )?;
                Ok(serde_json::json!({"id": id, "status": "queued"}))
            }
        })
        .await;

    match result {
        Ok(val) if val.get("deduplicated").and_then(|v| v.as_bool()) == Some(true) => {
            (StatusCode::OK, Json(val)).into_response()
        }
        Ok(val) => (StatusCode::CREATED, Json(val)).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": format!("{e}")})),
        )
            .into_response(),
    }
}

/// GET /api/documents/:id — get single document
pub async fn get(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Response {
    let access = match document_access_or_response(&state, peer, &headers, None, None) {
        Ok(access) => access,
        Err(response) => return response,
    };
    if access.scoped {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({"error": "document access requires unscoped credentials"})),
        )
            .into_response();
    }
    let result = state
        .pool
        .read(move |conn| {
            conn.query_row(
                "SELECT id, source_url, source_type, content_type, title, status, connector_id, chunk_count, created_at, updated_at
                 FROM documents
                 WHERE id = ?1
                   AND (?2 IS NULL OR agent_id = ?2)
                   AND (?3 IS NULL OR project = ?3)",
                rusqlite::params![id, access.agent_filter, access.project_filter],
                |r| Ok(doc_from_row(r)),
            )
            .map_err(|_| signet_core::CoreError::NotFound("document".into()))
        })
        .await;
    match result {
        Ok(val) => (StatusCode::OK, Json(val)).into_response(),
        Err(_) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"error": "Document not found"})),
        )
            .into_response(),
    }
}

/// GET /api/documents/:id/chunks — get document chunks
pub async fn chunks(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Query(params): Query<AgentSelectorQuery>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Response {
    let requested_agent = params.requested_agent(&headers);
    let access = match document_access_or_response(&state, peer, &headers, requested_agent, None) {
        Ok(access) => access,
        Err(response) => return response,
    };
    let result = state
        .pool
        .read(move |conn| {
            let mut stmt = conn.prepare_cached(
                "SELECT m.id, m.content, m.type, m.created_at, dm.chunk_index
                 FROM document_memories dm
                 JOIN memories m ON m.id = dm.memory_id
                 JOIN documents d ON d.id = dm.document_id
                 WHERE dm.document_id = ?1 AND d.status != 'deleted' AND m.is_deleted = 0
                   AND (?2 IS NULL OR d.agent_id = ?2)
                   AND (?2 IS NULL OR m.agent_id = ?2)
                   AND (?3 IS NULL OR d.project = ?3)
                   AND (?3 IS NULL OR m.project = ?3)
                 ORDER BY dm.chunk_index ASC",
            )?;
            let rows: Vec<serde_json::Value> = stmt
                .query_map(
                    rusqlite::params![id, access.agent_filter, access.project_filter],
                    |r| {
                        Ok(serde_json::json!({
                            "id": r.get::<_, String>(0)?,
                            "content": r.get::<_, String>(1)?,
                            "type": r.get::<_, String>(2)?,
                            "createdAt": r.get::<_, String>(3)?,
                            "chunkIndex": r.get::<_, Option<i32>>(4)?,
                        }))
                    },
                )?
                .filter_map(|r| r.ok())
                .collect();
            Ok(serde_json::json!({"count": rows.len(), "chunks": rows}))
        })
        .await;
    match result {
        Ok(val) => (StatusCode::OK, Json(val)).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": format!("{e}")})),
        )
            .into_response(),
    }
}

#[derive(Debug, Deserialize)]
pub struct DeleteQuery {
    pub reason: Option<String>,
    #[serde(rename = "agentId")]
    pub agent_id_camel: Option<String>,
    pub agent_id: Option<String>,
}

impl DeleteQuery {
    fn requested_agent<'a>(&'a self, headers: &'a HeaderMap) -> Option<&'a str> {
        self.agent_id_camel
            .as_deref()
            .or(self.agent_id.as_deref())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .or_else(|| {
                headers
                    .get("x-signet-agent-id")
                    .and_then(|value| value.to_str().ok())
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
            })
    }
}

/// DELETE /api/documents/:id
pub async fn delete(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Query(params): Query<DeleteQuery>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Response {
    if params.reason.is_none() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "reason query parameter is required"})),
        )
            .into_response();
    }
    let requested_agent = params.requested_agent(&headers);
    let access = match document_access_or_response(&state, peer, &headers, requested_agent, None) {
        Ok(access) => access,
        Err(response) => return response,
    };
    let reason = params.reason.unwrap_or_default();
    let result = state
        .pool
        .write(signet_core::db::Priority::Low, move |conn| {
            let exists = conn
                .prepare_cached(
                    "SELECT id FROM documents
                     WHERE id = ?1
                       AND (?2 IS NULL OR agent_id = ?2)
                       AND (?3 IS NULL OR project = ?3)",
                )?
                .exists(rusqlite::params![id, access.agent_filter, access.project_filter])?;
            if !exists {
                return Ok(serde_json::json!({"__notFound": true}));
            }
            let now = chrono::Utc::now().to_rfc3339();
            conn.execute(
                "UPDATE documents SET status = 'deleted', error = ?1, updated_at = ?2 WHERE id = ?3",
                rusqlite::params![reason, now, id],
            )?;
            conn.execute(
                "UPDATE memory_jobs
                 SET status = 'completed', error = ?1, completed_at = ?2, updated_at = ?2
                 WHERE job_type = 'document_ingest'
                   AND memory_id IS NULL
                   AND document_id = ?3
                   AND status IN ('pending', 'leased')",
                rusqlite::params![format!("Document deleted: {reason}"), now, id],
            )?;
            let mut stmt = conn.prepare_cached(
                "SELECT dm.memory_id FROM document_memories dm
                 JOIN memories m ON m.id = dm.memory_id
                 WHERE dm.document_id = ?1
                   AND m.is_deleted = 0
                   AND (?2 IS NULL OR m.agent_id = ?2)
                   AND (?3 IS NULL OR m.project = ?3)",
            )?;
            let linked_memories: Vec<String> = stmt
                .query_map(rusqlite::params![id, access.agent_filter, access.project_filter], |row| {
                    row.get::<_, String>(0)
                })?
                .filter_map(|row| row.ok())
                .collect();
            drop(stmt);
            let mut removed = 0_i64;
            for memory_id in linked_memories {
                let active_references: i64 = conn.query_row(
                    "SELECT COUNT(*)
                     FROM document_memories dm
                     JOIN documents d ON d.id = dm.document_id
                     WHERE dm.memory_id = ?1
                       AND dm.document_id != ?2
                       AND d.status != 'deleted'",
                    rusqlite::params![memory_id, id],
                    |row| row.get(0),
                )?;
                if active_references > 0 {
                    continue;
                }
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
            Ok(serde_json::json!({"deleted": true, "memoriesRemoved": removed}))
        })
        .await;
    match result {
        Ok(val) if val.get("__notFound").and_then(|v| v.as_bool()) == Some(true) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"error": "Document not found"})),
        )
            .into_response(),
        Ok(val) => (StatusCode::OK, Json(val)).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": format!("{e}")})),
        )
            .into_response(),
    }
}
