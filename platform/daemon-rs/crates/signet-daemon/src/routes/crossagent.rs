//! Cross-agent communication routes.
//!
//! Agent presence, messaging, and SSE streaming.

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
// Query params
// ---------------------------------------------------------------------------

#[derive(Debug, Default, Deserialize)]
pub struct PresenceQuery {
    pub agent_id: Option<String>,
    pub session_key: Option<String>,
    pub project: Option<String>,
    pub limit: Option<usize>,
}

#[derive(Debug, Default, Deserialize)]
#[allow(dead_code)] // session_key filtering planned
pub struct MessagesQuery {
    pub agent_id: Option<String>,
    pub session_key: Option<String>,
    pub since: Option<String>,
    pub limit: Option<usize>,
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

/// GET /api/cross-agent/presence — list active agent sessions
pub async fn list_presence(
    State(state): State<Arc<AppState>>,
    Query(params): Query<PresenceQuery>,
) -> impl IntoResponse {
    let limit = params.limit.unwrap_or(50);

    let result = state
        .pool
        .read(move |conn| {
            // Check if table exists
            let exists: bool = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='agent_presence'",
                    [],
                    |r| r.get::<_, i64>(0),
                )
                .map(|c| c > 0)
                .unwrap_or(false);

            if !exists {
                return Ok(serde_json::json!({"sessions": [], "count": 0}));
            }

            let mut sql =
                "SELECT key, session_key, agent_id, harness, project, runtime_path, provider, started_at, last_seen_at FROM agent_presence WHERE 1=1"
                    .to_string();
            let mut conds = Vec::new();

            if let Some(ref aid) = params.agent_id {
                conds.push(format!("agent_id = '{aid}'"));
            }
            if let Some(ref sk) = params.session_key {
                conds.push(format!("session_key = '{sk}'"));
            }
            if let Some(ref p) = params.project {
                conds.push(format!("project = '{p}'"));
            }

            for c in &conds {
                sql.push_str(&format!(" AND {c}"));
            }
            sql.push_str(&format!(" ORDER BY last_seen_at DESC LIMIT {limit}"));

            let mut stmt = conn.prepare(&sql)?;
            let rows: Vec<serde_json::Value> = stmt
                .query_map([], |r| {
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
                .filter_map(|r| r.ok())
                .collect();

            let count = rows.len();
            Ok(serde_json::json!({"sessions": rows, "count": count}))
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

/// GET /api/cross-agent/stream — SSE stream of cross-agent events.
pub async fn stream() -> impl IntoResponse {
    (
        [
            ("content-type", "text/event-stream"),
            ("cache-control", "no-cache"),
            ("connection", "keep-alive"),
        ],
        "data: {\"type\":\"connected\"}\n\n",
    )
}

/// POST /api/cross-agent/presence — register/update presence
pub async fn upsert_presence(
    State(state): State<Arc<AppState>>,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    let harness = body
        .get("harness")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown")
        .to_string();
    let session_key = body
        .get("sessionKey")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    // Resolve agent_id: body field takes precedence; fall back to the agent
    // scope encoded in the session key (agent:<id>:<uuid>) so tracker claims
    // and presence rows share the same agent_id even when the connector omits
    // the explicit field. Mirrors the TS resolve_remember_agent pattern.
    let agent_id = body
        .get("agentId")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.to_string())
        .or_else(|| {
            session_key.as_deref().and_then(|k| {
                let mut parts = k.splitn(3, ':');
                if parts.next() != Some("agent") {
                    return None;
                }
                let id = parts.next().unwrap_or("").trim();
                if id.is_empty() {
                    None
                } else {
                    Some(id.to_string())
                }
            })
        });
    let project = body
        .get("project")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let runtime_path = body
        .get("runtimePath")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let provider = body
        .get("provider")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let key = session_key
        .clone()
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let now = chrono::Utc::now().to_rfc3339();

    let result = state
        .pool
        .write(signet_core::db::Priority::High, {
            let key = key.clone();
            move |conn| {
                conn.execute(
                    "INSERT INTO agent_presence (key, session_key, agent_id, harness, project, runtime_path, provider, started_at, last_seen_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
                     ON CONFLICT(key) DO UPDATE SET last_seen_at = ?8, harness = ?4, project = ?5",
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
        Ok(val) => (StatusCode::OK, Json(val)),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": format!("{e}")})),
        ),
    }
}

/// DELETE /api/cross-agent/presence/:key — remove presence
pub async fn remove_presence(
    State(state): State<Arc<AppState>>,
    Path(key): Path<String>,
) -> impl IntoResponse {
    let result = state
        .pool
        .write(signet_core::db::Priority::High, move |conn| {
            let changed = conn.execute("DELETE FROM agent_presence WHERE key = ?1", [&key])?;
            Ok(serde_json::json!({"removed": changed > 0}))
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

/// GET /api/cross-agent/messages — list messages
pub async fn list_messages(
    State(state): State<Arc<AppState>>,
    Query(params): Query<MessagesQuery>,
) -> impl IntoResponse {
    let limit = params.limit.unwrap_or(100);

    let result = state
        .pool
        .read(move |conn| {
            let exists: bool = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='agent_messages'",
                    [],
                    |r| r.get::<_, i64>(0),
                )
                .map(|c| c > 0)
                .unwrap_or(false);

            if !exists {
                return Ok(serde_json::json!({"items": [], "count": 0}));
            }

            let mut sql = "SELECT id, created_at, from_agent_id, from_session_key, to_agent_id, to_session_key, content, type, broadcast FROM agent_messages WHERE 1=1".to_string();

            if let Some(ref since) = params.since {
                sql.push_str(&format!(" AND created_at > '{since}'"));
            }
            if let Some(ref aid) = params.agent_id {
                sql.push_str(&format!(" AND (to_agent_id = '{aid}' OR from_agent_id = '{aid}')"));
            }
            sql.push_str(&format!(" ORDER BY created_at DESC LIMIT {limit}"));

            let mut stmt = conn.prepare(&sql)?;
            let rows: Vec<serde_json::Value> = stmt
                .query_map([], |r| {
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
                .filter_map(|r| r.ok())
                .collect();

            let count = rows.len();
            Ok(serde_json::json!({"items": rows, "count": count}))
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

/// POST /api/cross-agent/messages — send a message
pub async fn send_message(
    State(state): State<Arc<AppState>>,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    let content = match body.get("content").and_then(|v| v.as_str()) {
        Some(c) => c.to_string(),
        None => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"error": "missing content"})),
            );
        }
    };

    let msg_type = body
        .get("type")
        .and_then(|v| v.as_str())
        .unwrap_or("info")
        .to_string();
    let broadcast = body
        .get("broadcast")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let from_agent = body
        .get("fromAgentId")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let to_agent = body
        .get("toAgentId")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let to_session = body
        .get("toSessionKey")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();

    let result = state
        .pool
        .write(signet_core::db::Priority::High, {
            let id = id.clone();
            let now = now.clone();
            move |conn| {
                conn.execute(
                    "INSERT INTO agent_messages (id, created_at, from_agent_id, to_agent_id, to_session_key, content, type, broadcast)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                    rusqlite::params![id, now, from_agent, to_agent, to_session, content, msg_type, broadcast],
                )?;
                Ok(serde_json::json!({
                    "id": id,
                    "createdAt": now,
                    "content": content,
                    "type": msg_type,
                    "broadcast": broadcast,
                }))
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
