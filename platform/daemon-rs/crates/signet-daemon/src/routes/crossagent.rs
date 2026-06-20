//! Cross-agent communication routes.
//!
//! Agent presence, messaging, and SSE streaming.

use std::net::SocketAddr;
use std::sync::Arc;

use axum::{
    Json,
    extract::{ConnectInfo, Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use rusqlite::{OptionalExtension, ToSql};
use serde::Deserialize;
use serde_json::Value;

use crate::auth::middleware::{
    authenticate_headers, require_permission_guard, resolve_scoped_agent,
};
use crate::auth::types::{AuthMode, Permission};
use crate::state::AppState;

// ---------------------------------------------------------------------------
// Query params
// ---------------------------------------------------------------------------

#[derive(Debug, Default, Deserialize)]
pub struct PresenceQuery {
    #[serde(alias = "agentId")]
    pub agent_id: Option<String>,
    pub session_key: Option<String>,
    pub project: Option<String>,
    pub limit: Option<usize>,
    pub include_self: Option<bool>,
}

#[derive(Debug, Default, Deserialize)]
pub struct MessagesQuery {
    #[serde(alias = "agentId")]
    pub agent_id: Option<String>,
    pub session_key: Option<String>,
    pub since: Option<String>,
    pub limit: Option<usize>,
    pub include_sent: Option<bool>,
    pub include_broadcast: Option<bool>,
}

fn clean(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn read_body_string(body: &Value, key: &str) -> Option<String> {
    clean(body.get(key).and_then(Value::as_str))
}

fn session_agent_id(session_key: Option<&str>) -> Option<String> {
    let mut parts = session_key?.splitn(3, ':');
    match (parts.next(), parts.next()) {
        (Some("agent"), Some(agent_id)) if !agent_id.trim().is_empty() => {
            Some(agent_id.trim().to_string())
        }
        _ => None,
    }
}

fn requested_agent(explicit: Option<&str>, session_key: Option<&str>) -> Option<String> {
    clean(explicit).or_else(|| session_agent_id(session_key))
}

fn auth_scoped_agent(
    state: &AppState,
    peer: SocketAddr,
    headers: &HeaderMap,
    requested: Option<&str>,
    permission: Permission,
) -> Result<String, Response> {
    let is_local = peer.ip().is_loopback();
    let auth_runtime = state.auth_snapshot();
    let auth = authenticate_headers(
        auth_runtime.mode,
        auth_runtime.secret.as_deref(),
        headers,
        is_local,
    )
    .map_err(|resp| *resp)?;
    require_permission_guard(&auth, permission, auth_runtime.mode, is_local)
        .map_err(|resp| *resp)?;
    resolve_scoped_agent(&auth, auth_runtime.mode, is_local, requested).map_err(|reason| {
        (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({"error": reason})),
        )
            .into_response()
    })
}

fn table_exists(conn: &rusqlite::Connection, table: &str) -> rusqlite::Result<bool> {
    conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
        [table],
        |r| r.get::<_, i64>(0),
    )
    .map(|count| count > 0)
}

fn session_owner(
    conn: &rusqlite::Connection,
    session_key: &str,
) -> rusqlite::Result<Option<String>> {
    let prefixed = format!("session:{session_key}");
    conn.query_row(
        "SELECT agent_id FROM agent_presence
         WHERE (session_key = ?1 OR session_key = ?2 OR key = ?1 OR key = ?2)
         ORDER BY last_seen_at DESC LIMIT 1",
        rusqlite::params![session_key, prefixed],
        |row| row.get::<_, Option<String>>(0),
    )
    .optional()
    .map(|value| value.flatten())
}

fn validate_session_agent_binding(
    conn: &rusqlite::Connection,
    session_key: Option<&str>,
    agent_id: &str,
    require_existing: bool,
) -> rusqlite::Result<Result<(), String>> {
    let Some(session_key) = session_key.and_then(|key| clean(Some(key))) else {
        return Ok(Ok(()));
    };
    if let Some(encoded) = session_agent_id(Some(&session_key))
        && encoded != agent_id
    {
        return Ok(Err(
            "session_key does not belong to requested agent".to_string()
        ));
    }
    if !table_exists(conn, "agent_presence")? {
        return if require_existing {
            Ok(Err(
                "session_key is not active for requested agent".to_string()
            ))
        } else {
            Ok(Ok(()))
        };
    }
    match session_owner(conn, &session_key)? {
        Some(owner) if owner == agent_id => Ok(Ok(())),
        Some(_) => Ok(Err(
            "session_key does not belong to requested agent".to_string()
        )),
        None if require_existing => Ok(Err(
            "session_key is not active for requested agent".to_string()
        )),
        None => Ok(Ok(())),
    }
}

fn query_values(values: &[String]) -> Vec<&dyn ToSql> {
    values.iter().map(|value| value as &dyn ToSql).collect()
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

/// GET /api/cross-agent/presence — list active agent sessions
pub async fn list_presence(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Query(params): Query<PresenceQuery>,
) -> Response {
    let agent_id = match auth_scoped_agent(
        &state,
        peer,
        &headers,
        params.agent_id.as_deref(),
        Permission::Recall,
    ) {
        Ok(agent) => agent,
        Err(resp) => return resp,
    };
    let limit = params.limit.unwrap_or(50).clamp(1, 500);
    let session_key = clean(params.session_key.as_deref());
    let project = clean(params.project.as_deref());
    let include_self = params.include_self.unwrap_or(false);

    let result = state
        .pool
        .read(move |conn| {
            if let Err(error) = validate_session_agent_binding(conn, session_key.as_deref(), &agent_id, true)? {
                return Ok(serde_json::json!({"_code": 403, "error": error}));
            }
            if !table_exists(conn, "agent_presence")? {
                return Ok(serde_json::json!({"sessions": [], "count": 0}));
            }
            let mut sql = "SELECT key, session_key, agent_id, harness, project, runtime_path, provider, started_at, last_seen_at FROM agent_presence WHERE last_seen_at >= datetime('now', '-4 hours')".to_string();
            let mut args = Vec::<String>::new();
            if include_self {
                sql.push_str(" AND agent_id = ?");
                args.push(agent_id.clone());
            } else {
                sql.push_str(" AND agent_id != ?");
                args.push(agent_id.clone());
            }
            if let Some(session_key) = session_key {
                sql.push_str(" AND session_key = ?");
                args.push(session_key);
            }
            if let Some(project) = project {
                sql.push_str(" AND project = ?");
                args.push(project);
            }
            sql.push_str(&format!(" ORDER BY last_seen_at DESC LIMIT {limit}"));
            let params = query_values(&args);
            let mut stmt = conn.prepare(&sql)?;
            let rows: Vec<serde_json::Value> = stmt
                .query_map(params.as_slice(), |r| {
                    Ok(serde_json::json!({
                        "key": r.get::<_, String>(0)?,
                        "sessionKey": r.get::<_, Option<String>>(1)?,
                        "agentId": r.get::<_, Option<String>>(2)?,
                        "harness": r.get::<_, Option<String>>(3)?,
                        "project": r.get::<_, Option<String>>(4)?,
                        "runtimePath": r.get::<_, Option<String>>(5)?,
                        "provider": r.get::<_, Option<String>>(6)?,
                        "startedAt": r.get::<_, String>(7)?,
                        "lastSeenAt": r.get::<_, String>(8)?,
                    }))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(serde_json::json!({"sessions": rows, "count": rows.len()}))
        })
        .await;

    match result {
        Ok(val) if val.get("_code").and_then(Value::as_u64) == Some(403) => {
            (StatusCode::FORBIDDEN, Json(val)).into_response()
        }
        Ok(val) => (StatusCode::OK, Json(val)).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": format!("{e}")})),
        )
            .into_response(),
    }
}

/// GET /api/cross-agent/stream — SSE stream of cross-agent events.
pub async fn stream(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Query(params): Query<PresenceQuery>,
) -> Response {
    if let Err(resp) = auth_scoped_agent(
        &state,
        peer,
        &headers,
        params.agent_id.as_deref(),
        Permission::Recall,
    ) {
        return resp;
    }
    (
        [
            ("content-type", "text/event-stream"),
            ("cache-control", "no-cache"),
            ("connection", "keep-alive"),
        ],
        "data: {\"type\":\"connected\"}\n\n",
    )
        .into_response()
}

/// POST /api/cross-agent/presence — register/update presence
pub async fn upsert_presence(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<serde_json::Value>,
) -> Response {
    let harness = read_body_string(&body, "harness").unwrap_or_else(|| "unknown".to_string());
    let session_key =
        read_body_string(&body, "sessionKey").or_else(|| read_body_string(&body, "session_key"));
    let requested = requested_agent(
        read_body_string(&body, "agentId")
            .or_else(|| read_body_string(&body, "agent_id"))
            .as_deref(),
        session_key.as_deref(),
    );
    let agent_id = match auth_scoped_agent(
        &state,
        peer,
        &headers,
        requested.as_deref(),
        Permission::Modify,
    ) {
        Ok(agent) => agent,
        Err(resp) => return resp,
    };
    let project = read_body_string(&body, "project");
    let runtime_path = read_body_string(&body, "runtimePath")
        .or_else(|| read_body_string(&body, "runtime_path"))
        .filter(|value| value == "plugin" || value == "legacy");
    let provider = read_body_string(&body, "provider").or_else(|| Some(harness.clone()));

    let key = session_key
        .clone()
        .map(|key| format!("session:{key}"))
        .unwrap_or_else(|| format!("ephemeral:{}", uuid::Uuid::new_v4()));
    let now = chrono::Utc::now().to_rfc3339();

    let result = state
        .pool
        .write(signet_core::db::Priority::High, {
            let key = key.clone();
            move |conn| {
                if let Err(error) = validate_session_agent_binding(conn, session_key.as_deref(), &agent_id, false)? {
                    return Ok(serde_json::json!({"_code": 403, "error": error}));
                }
                conn.execute(
                    "INSERT INTO agent_presence (key, session_key, agent_id, harness, project, runtime_path, provider, started_at, last_seen_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
                     ON CONFLICT(key) DO UPDATE SET session_key = ?2, agent_id = ?3, last_seen_at = ?8, harness = ?4, project = ?5, runtime_path = ?6, provider = ?7",
                    rusqlite::params![key, session_key, agent_id, harness, project, runtime_path, provider, now],
                )?;
                Ok(serde_json::json!({
                    "presence": {
                        "key": key,
                        "sessionKey": session_key,
                        "agentId": agent_id,
                        "harness": harness,
                        "project": project,
                        "runtimePath": runtime_path,
                        "provider": provider,
                        "startedAt": now,
                        "lastSeenAt": now,
                    }
                }))
            }
        })
        .await;

    match result {
        Ok(val) if val.get("_code").and_then(Value::as_u64) == Some(403) => {
            (StatusCode::FORBIDDEN, Json(val)).into_response()
        }
        Ok(val) => (StatusCode::OK, Json(val)).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": format!("{e}")})),
        )
            .into_response(),
    }
}

/// DELETE /api/cross-agent/presence/:key — remove presence
pub async fn remove_presence(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(key): Path<String>,
) -> Response {
    let requested = requested_agent(None, Some(&key));
    let agent_id = match auth_scoped_agent(
        &state,
        peer,
        &headers,
        requested.as_deref(),
        Permission::Modify,
    ) {
        Ok(agent) => agent,
        Err(resp) => return resp,
    };
    let result = state
        .pool
        .write(signet_core::db::Priority::High, move |conn| {
            if let Err(error) = validate_session_agent_binding(conn, Some(&key), &agent_id, false)? {
                return Ok(serde_json::json!({"_code": 403, "error": error}));
            }
            let prefixed = format!("session:{key}");
            let changed = conn.execute(
                "DELETE FROM agent_presence WHERE (key = ?1 OR key = ?2 OR session_key = ?1 OR session_key = ?2) AND agent_id = ?3",
                rusqlite::params![key, prefixed, agent_id],
            )?;
            Ok(serde_json::json!({"removed": changed > 0}))
        })
        .await;

    match result {
        Ok(val) if val.get("_code").and_then(Value::as_u64) == Some(403) => {
            (StatusCode::FORBIDDEN, Json(val)).into_response()
        }
        Ok(val) => (StatusCode::OK, Json(val)).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": format!("{e}")})),
        )
            .into_response(),
    }
}

/// GET /api/cross-agent/messages — list messages
pub async fn list_messages(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Query(params): Query<MessagesQuery>,
) -> Response {
    let unscoped_local = state.auth_snapshot().mode == AuthMode::Local
        && params.agent_id.is_none()
        && params.session_key.is_none();
    let agent_id = match auth_scoped_agent(
        &state,
        peer,
        &headers,
        params.agent_id.as_deref(),
        Permission::Recall,
    ) {
        Ok(agent) => agent,
        Err(resp) => return resp,
    };
    let limit = params.limit.unwrap_or(100).clamp(1, 500);
    let session_key = clean(params.session_key.as_deref());
    let since = clean(params.since.as_deref());
    let include_sent = params.include_sent.unwrap_or(false);
    let include_broadcast = params.include_broadcast.unwrap_or(true);

    let result = state
        .pool
        .read(move |conn| {
            if let Err(error) = validate_session_agent_binding(conn, session_key.as_deref(), &agent_id, true)? {
                return Ok(serde_json::json!({"_code": 403, "error": error}));
            }
            if !table_exists(conn, "agent_messages")? {
                return Ok(serde_json::json!({"items": [], "count": 0}));
            }
            let mut sql = "SELECT m.id, m.created_at, m.from_agent_id, m.from_session_key, m.to_agent_id, m.to_session_key, m.content, m.type, m.broadcast FROM agent_messages m WHERE 1=1".to_string();
            let mut args = Vec::<String>::new();
            if let Some(since) = since {
                sql.push_str(" AND m.created_at >= ?");
                args.push(since);
            }
            if let Some(session_key) = session_key {
                sql.push_str(" AND (m.to_session_key = ? OR (? = '' AND 0))");
                args.push(session_key);
                args.push(String::new());
            }
            if !unscoped_local {
                sql.push_str(" AND (");
                sql.push_str("m.to_agent_id = ?");
                args.push(agent_id.clone());
                sql.push_str(" OR m.to_session_key IN (SELECT session_key FROM agent_presence WHERE agent_id = ? AND session_key IS NOT NULL)");
                args.push(agent_id.clone());
                if include_sent {
                    sql.push_str(" OR m.from_agent_id = ?");
                    args.push(agent_id.clone());
                }
                if include_broadcast {
                    sql.push_str(" OR m.broadcast = 1");
                }
                sql.push(')');
            }
            sql.push_str(&format!(" ORDER BY m.created_at DESC LIMIT {limit}"));
            let params = query_values(&args);
            let mut stmt = conn.prepare(&sql)?;
            let rows: Vec<serde_json::Value> = stmt
                .query_map(params.as_slice(), |r| {
                    Ok(serde_json::json!({
                        "id": r.get::<_, String>(0)?,
                        "createdAt": r.get::<_, String>(1)?,
                        "fromAgentId": r.get::<_, Option<String>>(2)?,
                        "fromSessionKey": r.get::<_, Option<String>>(3)?,
                        "toAgentId": r.get::<_, Option<String>>(4)?,
                        "toSessionKey": r.get::<_, Option<String>>(5)?,
                        "content": r.get::<_, String>(6)?,
                        "type": r.get::<_, String>(7)?,
                        "broadcast": r.get::<_, bool>(8)?,
                    }))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(serde_json::json!({"items": rows, "count": rows.len()}))
        })
        .await;

    match result {
        Ok(val) if val.get("_code").and_then(Value::as_u64) == Some(403) => {
            (StatusCode::FORBIDDEN, Json(val)).into_response()
        }
        Ok(val) => (StatusCode::OK, Json(val)).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": format!("{e}")})),
        )
            .into_response(),
    }
}

/// POST /api/cross-agent/messages — send a message
pub async fn send_message(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<serde_json::Value>,
) -> Response {
    let Some(content) = read_body_string(&body, "content") else {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "content is required"})),
        )
            .into_response();
    };
    if content.len() > 65_536 {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "content too large (max 65536 chars)"})),
        )
            .into_response();
    }
    let msg_type = read_body_string(&body, "type").unwrap_or_else(|| "info".to_string());
    if !matches!(
        msg_type.as_str(),
        "assist_request" | "decision_update" | "info" | "question"
    ) {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": format!("unsupported message type '{msg_type}'")})),
        )
            .into_response();
    }
    let broadcast = body
        .get("broadcast")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let from_session = read_body_string(&body, "fromSessionKey")
        .or_else(|| read_body_string(&body, "from_session_key"));
    let requested = requested_agent(
        read_body_string(&body, "fromAgentId")
            .or_else(|| read_body_string(&body, "from_agent_id"))
            .as_deref(),
        from_session.as_deref(),
    );
    let from_agent = match auth_scoped_agent(
        &state,
        peer,
        &headers,
        requested.as_deref(),
        Permission::Modify,
    ) {
        Ok(agent) => agent,
        Err(resp) => return resp,
    };
    let to_agent =
        read_body_string(&body, "toAgentId").or_else(|| read_body_string(&body, "to_agent_id"));
    let to_session = read_body_string(&body, "toSessionKey")
        .or_else(|| read_body_string(&body, "to_session_key"));
    if !broadcast && to_agent.is_none() && to_session.is_none() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "local target required (toAgentId, toSessionKey, or broadcast=true)"})),
        )
            .into_response();
    }

    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();

    let result = state
        .pool
        .write(signet_core::db::Priority::High, {
            let id = id.clone();
            let now = now.clone();
            move |conn| {
                if let Err(error) = validate_session_agent_binding(conn, from_session.as_deref(), &from_agent, true)? {
                    return Ok(serde_json::json!({"_code": 403, "error": error}));
                }
                let resolved_to_agent = if let Some(ref to_session) = to_session {
                    match session_owner(conn, to_session)? {
                        Some(owner) => {
                            if let Some(ref explicit) = to_agent
                                && explicit != &owner
                            {
                                return Ok(serde_json::json!({"_code": 403, "error": "toSessionKey does not belong to toAgentId"}));
                            }
                            Some(owner)
                        }
                        None => to_agent.clone(),
                    }
                } else {
                    to_agent.clone()
                };
                conn.execute(
                    "INSERT INTO agent_messages (id, created_at, from_agent_id, from_session_key, to_agent_id, to_session_key, content, type, broadcast)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                    rusqlite::params![id, now, from_agent, from_session, resolved_to_agent, to_session, content, msg_type, broadcast],
                )?;
                Ok(serde_json::json!({
                    "message": {
                        "id": id,
                        "createdAt": now,
                        "fromAgentId": from_agent,
                        "fromSessionKey": from_session,
                        "toAgentId": resolved_to_agent,
                        "toSessionKey": to_session,
                        "content": content,
                        "type": msg_type,
                        "broadcast": broadcast,
                        "deliveryPath": "local",
                        "deliveryStatus": "delivered"
                    }
                }))
            }
        })
        .await;

    match result {
        Ok(val) if val.get("_code").and_then(Value::as_u64) == Some(403) => {
            (StatusCode::FORBIDDEN, Json(val)).into_response()
        }
        Ok(val) => (StatusCode::CREATED, Json(val)).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": format!("{e}")})),
        )
            .into_response(),
    }
}
