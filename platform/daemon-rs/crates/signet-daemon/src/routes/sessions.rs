//! Session and checkpoint route handlers.

use std::net::SocketAddr;
use std::sync::Arc;

use axum::Json;
use axum::body::Bytes;
use axum::extract::{ConnectInfo, Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use serde::Deserialize;
use serde_json::Value;

use crate::auth::middleware::{AuthState, authenticate_headers, resolve_scoped_agent};
use crate::auth::policy::check_scope;
use crate::auth::types::{AuthMode, TokenScope};
use crate::state::AppState;

// ---------------------------------------------------------------------------
// GET /api/sessions
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct SessionListParams {
    pub agent_id: Option<String>,
}

/// Merge tracker claims with cross-agent presence records, mirroring the TS
/// `listLiveSessions()` behavior. Presence-only sessions (not in the tracker)
/// appear with `expiresAt: null`.
pub async fn list(
    State(state): State<Arc<AppState>>,
    Query(params): Query<SessionListParams>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> axum::response::Response {
    let is_local = peer.ip().is_loopback();
    let auth_runtime = state.auth_snapshot();
    let auth = match authenticate_headers(
        auth_runtime.mode,
        auth_runtime.secret.as_deref(),
        &headers,
        is_local,
    ) {
        Ok(a) => a,
        Err(e) => return *e,
    };
    let agent_id = match resolve_scoped_agent(
        &auth,
        auth_runtime.mode,
        is_local,
        params.agent_id.as_deref(),
    ) {
        Ok(id) => id,
        Err(reason) => {
            return (
                StatusCode::FORBIDDEN,
                Json(serde_json::json!({"error": reason})),
            )
                .into_response();
        }
    };

    let tracker_sessions = state.sessions.list_sessions(Some(&agent_id));
    let tracker_keys: std::collections::HashSet<String> =
        tracker_sessions.iter().map(|s| s.key.clone()).collect();

    // Fetch presence-only sessions from DB (those not already in the tracker).
    let presence_result = state
        .pool
        .read(move |conn| {
            let exists: bool = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='agent_presence'",
                    [],
                    |r| r.get::<_, i64>(0),
                )
                .map(|c| c > 0)
                .unwrap_or(false);

            if !exists {
                return Ok(serde_json::json!([]));
            }

            // agent_id is always resolved (defaults to "default"); always filter.
            // Only return rows seen within the last 4 hours (matching STALE_SESSION_MS)
            // to exclude stale presence records from disconnected agents.
            let sql =
                "SELECT session_key, runtime_path, started_at FROM agent_presence \
                 WHERE session_key IS NOT NULL AND agent_id = ? \
                   AND last_seen_at >= datetime('now', '-4 hours') \
                 ORDER BY last_seen_at DESC";
            let params: &[&dyn rusqlite::types::ToSql] = &[&agent_id];
            let mut stmt = conn.prepare(sql)?;
            // Return raw tuples as a JSON array; bypass state is checked
            // after the DB read using the in-memory session tracker.
            let rows: Vec<serde_json::Value> = stmt
                .query_map(params, |r| {
                    Ok(serde_json::json!({
                        "key": r.get::<_, String>(0)?,
                        "runtimePath": r.get::<_, Option<String>>(1)?
                            .unwrap_or_else(|| "unknown".into()),
                        "claimedAt": r.get::<_, String>(2)?,
                        "expiresAt": serde_json::Value::Null,
                    }))
                })?
                .filter_map(|r| r.ok())
                .collect();
            Ok(serde_json::json!(rows))
        })
        .await;

    let presence_only: Vec<serde_json::Value> = presence_result
        .ok()
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default();

    // Tracker sessions serialized with expiresAt present.
    let mut all: Vec<serde_json::Value> = tracker_sessions
        .into_iter()
        .map(|s| serde_json::to_value(&s).unwrap_or_default())
        .collect();

    // Append presence-only sessions not already covered by the tracker.
    // Normalize the DB key (strip session: prefix) before the dedup check AND
    // update the key field in the output row so clients always see the bare key.
    // Tracker keys are always normalized; DB rows may still carry the prefix.
    // Annotate with live bypass state from the in-memory tracker.
    for mut p in presence_only {
        let raw_sk = p
            .get("key")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let sk = raw_sk
            .strip_prefix("session:")
            .unwrap_or(&raw_sk)
            .to_string();
        if !tracker_keys.contains(&sk) {
            if let Some(obj) = p.as_object_mut() {
                // Write normalized key back so output is consistent.
                obj.insert("key".into(), sk.clone().into());
                obj.insert("bypassed".into(), state.sessions.is_bypassed(&sk).into());
            }
            all.push(p);
        }
    }

    let count = all.len();
    (
        StatusCode::OK,
        Json(serde_json::json!({ "sessions": all, "count": count })),
    )
        .into_response()
}

// ---------------------------------------------------------------------------
// Shared query param for agent scoping on single-session routes
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct AgentScopeParams {
    #[serde(alias = "agentId")]
    pub agent_id: Option<String>,
}

fn blackbox_not_implemented() -> axum::response::Response {
    (
        StatusCode::NOT_IMPLEMENTED,
        Json(serde_json::json!({
            "error": "Black Box replay is not available in the Rust shadow daemon yet"
        })),
    )
        .into_response()
}

// ---------------------------------------------------------------------------
// GET /api/sessions/blackbox
// ---------------------------------------------------------------------------

pub async fn blackbox_list(
    State(state): State<Arc<AppState>>,
    Query(params): Query<AgentScopeParams>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> axum::response::Response {
    let is_local = peer.ip().is_loopback();
    let auth_runtime = state.auth_snapshot();
    let auth = match authenticate_headers(
        auth_runtime.mode,
        auth_runtime.secret.as_deref(),
        &headers,
        is_local,
    ) {
        Ok(a) => a,
        Err(e) => return *e,
    };
    if let Err(reason) = resolve_scoped_agent(
        &auth,
        auth_runtime.mode,
        is_local,
        params.agent_id.as_deref(),
    ) {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({"error": reason})),
        )
            .into_response();
    }

    blackbox_not_implemented()
}

// ---------------------------------------------------------------------------
// GET /api/sessions/:key/blackbox
// ---------------------------------------------------------------------------

pub async fn blackbox_get(
    State(state): State<Arc<AppState>>,
    Path(_key): Path<String>,
    Query(params): Query<AgentScopeParams>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> axum::response::Response {
    let is_local = peer.ip().is_loopback();
    let auth_runtime = state.auth_snapshot();
    let auth = match authenticate_headers(
        auth_runtime.mode,
        auth_runtime.secret.as_deref(),
        &headers,
        is_local,
    ) {
        Ok(a) => a,
        Err(e) => return *e,
    };
    if let Err(reason) = resolve_scoped_agent(
        &auth,
        auth_runtime.mode,
        is_local,
        params.agent_id.as_deref(),
    ) {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({"error": reason})),
        )
            .into_response();
    }

    blackbox_not_implemented()
}

/// Look up a session for the given agent — tracker first, then presence DB.
/// Mirrors TS `listLiveSessions(agentId).find(s => s.key === key)`.
///
/// Returns:
/// - `None` if not found anywhere (or table doesn't exist)
/// - `Some(None)` if found in tracker (caller has the full SessionInfo)
/// - `Some(Some(json))` if found only in presence DB (presence-only row)
async fn find_live_session(
    state: &AppState,
    key: &str,
    agent_id: &str,
) -> Option<Option<serde_json::Value>> {
    // Check tracker first (fast in-memory path).
    if state
        .sessions
        .list_sessions(Some(agent_id))
        .iter()
        .any(|s| s.key == key)
    {
        return Some(None);
    }

    // Fall back to presence DB for sessions not in tracker.
    // Query both normalized and prefixed forms since DB rows may carry either.
    // Only consider rows seen within the last 4 hours (STALE_SESSION_MS).
    let key_norm = key.to_string();
    let key_prefixed = format!("session:{key_norm}");
    let aid = agent_id.to_string();
    state
        .pool
        .read(move |conn| {
            let exists: bool = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='agent_presence'",
                    [],
                    |r| r.get::<_, i64>(0),
                )
                .map(|c| c > 0)
                .unwrap_or(false);
            if !exists {
                return Ok(None);
            }
            let row: Option<(Option<String>, String)> = conn
                .query_row(
                    "SELECT runtime_path, started_at FROM agent_presence \
                     WHERE (session_key = ?1 OR session_key = ?2) AND agent_id = ?3 \
                       AND last_seen_at >= datetime('now', '-4 hours') \
                     LIMIT 1",
                    rusqlite::params![key_norm, key_prefixed, aid],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .ok();
            Ok(row.map(|(runtime_path, started_at)| {
                serde_json::json!({
                    "runtimePath": runtime_path.unwrap_or_else(|| "unknown".into()),
                    "claimedAt": started_at,
                })
            }))
        })
        .await
        .ok()
        .flatten()
        .map(Some)
}

// ---------------------------------------------------------------------------
// GET /api/sessions/:key
// ---------------------------------------------------------------------------

pub async fn get(
    State(state): State<Arc<AppState>>,
    Path(key): Path<String>,
    Query(params): Query<AgentScopeParams>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> axum::response::Response {
    let is_local = peer.ip().is_loopback();
    let auth_runtime = state.auth_snapshot();
    let auth = match authenticate_headers(
        auth_runtime.mode,
        auth_runtime.secret.as_deref(),
        &headers,
        is_local,
    ) {
        Ok(a) => a,
        Err(e) => return *e,
    };
    let agent_id = match resolve_scoped_agent(
        &auth,
        auth_runtime.mode,
        is_local,
        params.agent_id.as_deref(),
    ) {
        Ok(id) => id,
        Err(reason) => {
            return (
                StatusCode::FORBIDDEN,
                Json(serde_json::json!({"error": reason})),
            )
                .into_response();
        }
    };
    // Normalize session: prefix so raw and prefixed keys both resolve.
    let key = key.strip_prefix("session:").unwrap_or(&key).to_string();

    // Try tracker first; if not found, check presence for presence-only sessions.
    let tracker_sessions = state.sessions.list_sessions(Some(&agent_id));
    if let Some(s) = tracker_sessions.into_iter().find(|s| s.key == key) {
        return (StatusCode::OK, Json(serde_json::to_value(s).unwrap())).into_response();
    }

    // Presence-only session fallback — include runtimePath and claimedAt from
    // the DB row, matching the TS listLiveSessions() presence-only shape.
    match find_live_session(&state, &key, &agent_id).await {
        Some(Some(row)) => {
            let mut obj = serde_json::json!({
                "key": key,
                "expiresAt": serde_json::Value::Null,
                "bypassed": state.sessions.is_bypassed(&key),
            });
            if let (Some(map), Some(row_map)) = (obj.as_object_mut(), row.as_object()) {
                for (k, v) in row_map {
                    map.insert(k.clone(), v.clone());
                }
            }
            (StatusCode::OK, Json(obj)).into_response()
        }
        _ => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"error": "Session not found"})),
        )
            .into_response(),
    }
}

// ---------------------------------------------------------------------------
// GET /api/sessions/:key/transcript
// ---------------------------------------------------------------------------

pub async fn transcript(
    State(state): State<Arc<AppState>>,
    Path(key): Path<String>,
    Query(params): Query<AgentScopeParams>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> axum::response::Response {
    let is_local = peer.ip().is_loopback();
    let auth_runtime = state.auth_snapshot();
    let auth = match authenticate_headers(
        auth_runtime.mode,
        auth_runtime.secret.as_deref(),
        &headers,
        is_local,
    ) {
        Ok(a) => a,
        Err(e) => return *e,
    };
    let key = key.strip_prefix("session:").unwrap_or(&key).to_string();
    let agent_id = match resolve_scoped_agent(
        &auth,
        auth_runtime.mode,
        is_local,
        params.agent_id.as_deref(),
    ) {
        Ok(id) => id,
        Err(reason) => {
            return (
                StatusCode::FORBIDDEN,
                Json(serde_json::json!({"error": reason})),
            )
                .into_response();
        }
    };
    let key_for_db = key.clone();
    let agent_for_db = agent_id.clone();
    let result = state
        .pool
        .read(move |conn| {
            let prefixed_key = format!("session:{key_for_db}");
            Ok(conn
                .query_row(
                    "SELECT content FROM session_transcripts
                     WHERE (session_key = ?1 OR session_key = ?2) AND agent_id = ?3
                     LIMIT 1",
                    rusqlite::params![key_for_db, prefixed_key, agent_for_db],
                    |row| row.get::<_, String>(0),
                )
                .ok())
        })
        .await;

    match result {
        Ok(Some(content)) => (
            StatusCode::OK,
            Json(serde_json::json!({
                "sessionKey": key,
                "agentId": agent_id,
                "content": content,
            })),
        )
            .into_response(),
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"error": "Transcript not found"})),
        )
            .into_response(),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": error.to_string()})),
        )
            .into_response(),
    }
}

// ---------------------------------------------------------------------------
// POST /api/sessions/:key/bypass
// ---------------------------------------------------------------------------

pub async fn bypass(
    State(state): State<Arc<AppState>>,
    Path(key): Path<String>,
    Query(params): Query<AgentScopeParams>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    bytes: Bytes,
) -> axum::response::Response {
    let is_local = peer.ip().is_loopback();
    let auth_runtime = state.auth_snapshot();
    let auth = match authenticate_headers(
        auth_runtime.mode,
        auth_runtime.secret.as_deref(),
        &headers,
        is_local,
    ) {
        Ok(a) => a,
        Err(e) => return *e,
    };
    let agent_id = match resolve_scoped_agent(
        &auth,
        auth_runtime.mode,
        is_local,
        params.agent_id.as_deref(),
    ) {
        Ok(id) => id,
        Err(reason) => {
            return (
                StatusCode::FORBIDDEN,
                Json(serde_json::json!({"error": reason})),
            )
                .into_response();
        }
    };
    let key = key.strip_prefix("session:").unwrap_or(&key).to_string();

    // Verify the session exists for this agent (tracker or presence-only).
    if find_live_session(&state, &key, &agent_id).await.is_none() {
        return (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"error": "Session not found"})),
        )
            .into_response();
    }

    let enabled = match parse_bypass_enabled(&bytes) {
        Some(enabled) => enabled,
        None => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"error": "enabled (boolean) is required"})),
            )
                .into_response();
        }
    };
    if enabled {
        state.sessions.bypass(&key);
    } else {
        state.sessions.unbypass(&key);
    }

    (
        StatusCode::OK,
        Json(serde_json::json!({
            "key": key,
            "bypassed": enabled,
        })),
    )
        .into_response()
}

fn parse_bypass_enabled(bytes: &Bytes) -> Option<bool> {
    if bytes.iter().all(|byte| byte.is_ascii_whitespace()) {
        return None;
    }
    let Ok(value) = serde_json::from_slice::<Value>(bytes) else {
        return None;
    };
    value.get("enabled").and_then(Value::as_bool)
}

// ---------------------------------------------------------------------------
// POST /api/sessions/:key/renew
// ---------------------------------------------------------------------------

pub async fn renew(
    State(state): State<Arc<AppState>>,
    Path(key): Path<String>,
    Query(params): Query<AgentScopeParams>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> axum::response::Response {
    let is_local = peer.ip().is_loopback();
    let auth_runtime = state.auth_snapshot();
    let auth = match authenticate_headers(
        auth_runtime.mode,
        auth_runtime.secret.as_deref(),
        &headers,
        is_local,
    ) {
        Ok(a) => a,
        Err(e) => return *e,
    };
    let agent_id = match resolve_scoped_agent(
        &auth,
        auth_runtime.mode,
        is_local,
        params.agent_id.as_deref(),
    ) {
        Ok(id) => id,
        Err(reason) => {
            return (
                StatusCode::FORBIDDEN,
                Json(serde_json::json!({"error": reason})),
            )
                .into_response();
        }
    };
    let key = key.strip_prefix("session:").unwrap_or(&key).to_string();

    match find_live_session(&state, &key, &agent_id).await {
        None => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"error": "Session not found"})),
        )
            .into_response(),
        Some(Some(_presence_row)) => (
            StatusCode::OK,
            Json(serde_json::json!({
                "key": key,
                "renewed": true,
            })),
        )
            .into_response(),
        Some(None) => {
            if !state.sessions.renew(&key) {
                return (
                    StatusCode::NOT_FOUND,
                    Json(serde_json::json!({"error": "Session not found or expired"})),
                )
                    .into_response();
            }

            let expires_at = state
                .sessions
                .list_sessions(Some(&agent_id))
                .into_iter()
                .find(|session| session.key == key)
                .map(|session| session.expires_at);
            let mut body = serde_json::json!({
                "key": key,
                "renewed": true,
            });
            if let (Some(expires_at), Some(object)) = (expires_at, body.as_object_mut()) {
                object.insert("expiresAt".to_string(), expires_at.into());
            }
            (StatusCode::OK, Json(body)).into_response()
        }
    }
}

// ---------------------------------------------------------------------------
// GET /api/sessions/summaries
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct SummaryParams {
    pub project: Option<String>,
    pub depth: Option<i64>,
    pub limit: Option<usize>,
    pub offset: Option<usize>,
    #[serde(alias = "agentId")]
    pub agent_id: Option<String>,
    #[serde(alias = "sessionKey")]
    pub session_key: Option<String>,
}

fn optional_text(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn header_text(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| optional_text(Some(value)))
}

fn session_agent_id(session_key: &str) -> Option<String> {
    let mut parts = session_key.splitn(3, ':');
    match (parts.next(), parts.next()) {
        (Some("agent"), Some(agent_id)) if !agent_id.trim().is_empty() => {
            Some(agent_id.trim().to_string())
        }
        _ => None,
    }
}

fn requested_agent_id(explicit: Option<String>, session_key: Option<String>) -> String {
    explicit
        .or_else(|| session_key.and_then(|key| session_agent_id(&key)))
        .unwrap_or_else(|| "default".to_string())
}

fn resolve_scoped_project(
    auth_state: &AuthState,
    mode: AuthMode,
    is_local: bool,
    requested: Option<&str>,
) -> Result<Option<String>, String> {
    let scoped = auth_state
        .result
        .claims
        .as_ref()
        .and_then(|claims| claims.scope.project.as_deref())
        .and_then(|project| optional_text(Some(project)));
    let project = optional_text(requested).or(scoped);

    if mode == AuthMode::Local
        || (mode == AuthMode::Hybrid && is_local && !auth_state.result.authenticated)
    {
        return Ok(project);
    }

    let Some(project) = project else {
        return Ok(None);
    };
    let target = TokenScope {
        project: Some(project.clone()),
        agent: None,
        user: None,
    };
    let decision = check_scope(auth_state.result.claims.as_ref(), &target, mode);
    if decision.allowed {
        Ok(Some(project))
    } else {
        Err(decision.reason.unwrap_or_else(|| "scope violation".into()))
    }
}

#[derive(Default, Deserialize)]
#[serde(default)]
pub struct SessionSearchBody {
    query: Option<String>,
    limit: Option<i64>,
}

pub async fn search(
    State(state): State<Arc<AppState>>,
    Json(body): Json<SessionSearchBody>,
) -> axum::response::Response {
    let query = body.query.unwrap_or_default().trim().to_string();
    if query.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "query is required" })),
        )
            .into_response();
    }
    let limit = body.limit.unwrap_or(10).clamp(1, 20);
    let query_for_db = query.clone();
    let result = state
        .pool
        .read(move |conn| {
            let like = format!("%{}%", query_for_db.replace('%', "\\%"));
            let mut stmt = conn.prepare(
                "SELECT session_key, project, harness, created_at, substr(content, 1, 500)
                 FROM session_transcripts
                 WHERE content LIKE ?1
                 ORDER BY created_at DESC
                 LIMIT ?2",
            )?;
            let rows = stmt.query_map(rusqlite::params![like, limit], |row| {
                Ok(serde_json::json!({
                    "sessionKey": row.get::<_, Option<String>>(0)?,
                    "project": row.get::<_, Option<String>>(1)?,
                    "harness": row.get::<_, Option<String>>(2)?,
                    "capturedAt": row.get::<_, String>(3)?,
                    "snippet": row.get::<_, String>(4)?,
                }))
            })?;
            Ok(rows.filter_map(Result::ok).collect::<Vec<_>>())
        })
        .await;

    match result {
        Ok(hits) => {
            let count = hits.len();
            (
                StatusCode::OK,
                Json(serde_json::json!({
                    "query": query,
                    "hits": hits,
                    "count": count,
                })),
            )
                .into_response()
        }
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": error.to_string() })),
        )
            .into_response(),
    }
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SummaryExpandBody {
    id: Option<String>,
    include_transcript: Option<bool>,
    transcript_char_limit: Option<i64>,
    #[serde(alias = "agent_id")]
    agent_id: Option<String>,
    #[serde(alias = "session_key")]
    session_key: Option<String>,
}

pub async fn summary_expand(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<SummaryExpandBody>,
) -> axum::response::Response {
    let id = body.id.unwrap_or_default().trim().to_string();
    if id.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "id is required" })),
        )
            .into_response();
    }
    let include_transcript = body.include_transcript.unwrap_or(true);
    let transcript_limit = body
        .transcript_char_limit
        .unwrap_or(2_000)
        .clamp(200, 12_000);
    let requested = requested_agent_id(
        optional_text(body.agent_id.as_deref())
            .or_else(|| header_text(&headers, "x-signet-agent-id")),
        optional_text(body.session_key.as_deref())
            .or_else(|| header_text(&headers, "x-signet-session-key")),
    );
    let is_local = peer.ip().is_loopback();
    let auth_runtime = state.auth_snapshot();
    let auth = match authenticate_headers(
        auth_runtime.mode,
        auth_runtime.secret.as_deref(),
        &headers,
        is_local,
    ) {
        Ok(a) => a,
        Err(e) => return *e,
    };
    let agent_id =
        match resolve_scoped_agent(&auth, auth_runtime.mode, is_local, Some(requested.as_str())) {
            Ok(id) => id,
            Err(reason) => {
                return (
                    StatusCode::FORBIDDEN,
                    Json(serde_json::json!({"error": reason})),
                )
                    .into_response();
            }
        };
    let project = match resolve_scoped_project(&auth, auth_runtime.mode, is_local, None) {
        Ok(project) => project,
        Err(reason) => {
            return (
                StatusCode::FORBIDDEN,
                Json(serde_json::json!({"error": reason})),
            )
                .into_response();
        }
    };
    let result = state
        .pool
        .read(move |conn| {
            let summary = conn
                .query_row(
                    "SELECT id, project, depth, kind, content, token_count,
                            earliest_at, latest_at, session_key, harness, agent_id, created_at
                     FROM session_summaries
                     WHERE id = ?1 AND agent_id = ?2 AND (?3 IS NULL OR project = ?3)
                     LIMIT 1",
                    rusqlite::params![id, agent_id, project],
                    |row| {
                        Ok(serde_json::json!({
                            "id": row.get::<_, String>(0)?,
                            "project": row.get::<_, Option<String>>(1)?,
                            "depth": row.get::<_, i64>(2)?,
                            "kind": row.get::<_, String>(3)?,
                            "content": row.get::<_, String>(4)?,
                            "tokenCount": row.get::<_, Option<i64>>(5)?,
                            "earliestAt": row.get::<_, String>(6)?,
                            "latestAt": row.get::<_, String>(7)?,
                            "sessionKey": row.get::<_, Option<String>>(8)?,
                            "harness": row.get::<_, Option<String>>(9)?,
                            "agentId": row.get::<_, String>(10)?,
                            "createdAt": row.get::<_, String>(11)?,
                        }))
                    },
                )
                .ok();
            let Some(summary) = summary else {
                return Ok(None);
            };
            let transcript = if include_transcript {
                summary
                    .get("sessionKey")
                    .and_then(|value| value.as_str())
                    .and_then(|session_key| {
                        conn.query_row(
                            "SELECT substr(content, 1, ?1)
                             FROM session_transcripts
                             WHERE session_key = ?2 AND agent_id = ?3 AND (?4 IS NULL OR project = ?4)
                             LIMIT 1",
                            rusqlite::params![transcript_limit, session_key, agent_id, project],
                            |row| row.get::<_, String>(0),
                        )
                        .ok()
                    })
            } else {
                None
            };
            Ok(Some(serde_json::json!({
                "summary": summary,
                "parents": [],
                "children": [],
                "transcript": transcript,
            })))
        })
        .await;

    match result {
        Ok(Some(body)) => (StatusCode::OK, Json(body)).into_response(),
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "summary node not found" })),
        )
            .into_response(),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": error.to_string() })),
        )
            .into_response(),
    }
}

pub async fn summaries(
    State(state): State<Arc<AppState>>,
    axum::extract::Query(params): axum::extract::Query<SummaryParams>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> axum::response::Response {
    let limit = params.limit.unwrap_or(50).min(200);
    let offset = params.offset.unwrap_or(0);
    let requested = requested_agent_id(
        optional_text(params.agent_id.as_deref())
            .or_else(|| header_text(&headers, "x-signet-agent-id")),
        optional_text(params.session_key.as_deref())
            .or_else(|| header_text(&headers, "x-signet-session-key")),
    );
    let is_local = peer.ip().is_loopback();
    let auth_runtime = state.auth_snapshot();
    let auth = match authenticate_headers(
        auth_runtime.mode,
        auth_runtime.secret.as_deref(),
        &headers,
        is_local,
    ) {
        Ok(a) => a,
        Err(e) => return *e,
    };
    let agent_id =
        match resolve_scoped_agent(&auth, auth_runtime.mode, is_local, Some(requested.as_str())) {
            Ok(id) => id,
            Err(reason) => {
                return (
                    StatusCode::FORBIDDEN,
                    Json(serde_json::json!({"error": reason})),
                )
                    .into_response();
            }
        };
    let project = match resolve_scoped_project(
        &auth,
        auth_runtime.mode,
        is_local,
        params.project.as_deref(),
    ) {
        Ok(project) => project,
        Err(reason) => {
            return (
                StatusCode::FORBIDDEN,
                Json(serde_json::json!({"error": reason})),
            )
                .into_response();
        }
    };

    let result = state
        .pool
        .read(move |conn| {
            let mut sql = String::from(
                "SELECT s.*, \
                 (SELECT COUNT(*) FROM session_summary_children c WHERE c.parent_id = s.id) AS child_count \
                 FROM session_summaries s WHERE s.agent_id = ?",
            );
            let mut params_vec: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
            params_vec.push(Box::new(agent_id.clone()));

            if let Some(ref project) = project {
                sql.push_str(" AND s.project = ?");
                params_vec.push(Box::new(project.clone()));
            }

            if let Some(depth) = params.depth {
                sql.push_str(" AND s.depth = ?");
                params_vec.push(Box::new(depth));
            }

            sql.push_str(" ORDER BY s.latest_at DESC LIMIT ? OFFSET ?");
            params_vec.push(Box::new(limit as i64));
            params_vec.push(Box::new(offset as i64));

            let param_refs: Vec<&dyn rusqlite::types::ToSql> =
                params_vec.iter().map(|p| p.as_ref()).collect();

            // Query total count
            let mut count_sql =
                String::from("SELECT COUNT(*) FROM session_summaries WHERE agent_id = ?");
            let mut count_params: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
            count_params.push(Box::new(agent_id));

            if let Some(ref project) = project {
                count_sql.push_str(" AND project = ?");
                count_params.push(Box::new(project.clone()));
            }
            if let Some(depth) = params.depth {
                count_sql.push_str(" AND depth = ?");
                count_params.push(Box::new(depth));
            }

            let count_refs: Vec<&dyn rusqlite::types::ToSql> =
                count_params.iter().map(|p| p.as_ref()).collect();

            let total: i64 = conn
                .query_row(&count_sql, count_refs.as_slice(), |r| r.get(0))
                .unwrap_or(0);

            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt.query_map(param_refs.as_slice(), |row| {
                Ok(serde_json::json!({
                    "id": row.get::<_, String>("id")?,
                    "project": row.get::<_, Option<String>>("project")?,
                    "depth": row.get::<_, i64>("depth")?,
                    "kind": row.get::<_, String>("kind")?,
                    "content": row.get::<_, String>("content")?,
                    "tokenCount": row.get::<_, Option<i64>>("token_count")?,
                    "earliestAt": row.get::<_, String>("earliest_at")?,
                    "latestAt": row.get::<_, String>("latest_at")?,
                    "sessionKey": row.get::<_, Option<String>>("session_key")?,
                    "harness": row.get::<_, Option<String>>("harness")?,
                    "agentId": row.get::<_, String>("agent_id")?,
                    "createdAt": row.get::<_, String>("created_at")?,
                    "childCount": row.get::<_, i64>("child_count")?,
                }))
            })?;

            let summaries: Vec<serde_json::Value> = rows.filter_map(|r| r.ok()).collect();

            Ok(serde_json::json!({
                "summaries": summaries,
                "total": total,
            }))
        })
        .await;

    match result {
        Ok(val) => (StatusCode::OK, Json(val)).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e.to_string()})),
        )
            .into_response(),
    }
}

// ---------------------------------------------------------------------------
// GET /api/sessions/checkpoints
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct CheckpointParams {
    pub session_key: Option<String>,
    pub project: Option<String>,
    pub limit: Option<usize>,
}

pub async fn checkpoints(
    State(state): State<Arc<AppState>>,
    axum::extract::Query(params): axum::extract::Query<CheckpointParams>,
) -> axum::response::Response {
    let result = state
        .pool
        .read(move |conn| {
            let items = if let Some(ref key) = params.session_key {
                signet_services::session::get_checkpoints_for_session(conn, key)?
            } else if let Some(ref project) = params.project {
                let limit = params.limit.unwrap_or(20);
                signet_services::session::get_checkpoints_for_project(conn, project, limit)?
            } else {
                vec![]
            };

            Ok(serde_json::json!({
                "items": items,
                "count": items.len(),
            }))
        })
        .await;

    match result {
        Ok(val) => (StatusCode::OK, Json(val)).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e.to_string()})),
        )
            .into_response(),
    }
}

// ---------------------------------------------------------------------------
// GET /api/sessions/checkpoints/latest
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct LatestCheckpointParams {
    pub project: Option<String>,
}

pub async fn checkpoint_latest(
    State(state): State<Arc<AppState>>,
    axum::extract::Query(params): axum::extract::Query<LatestCheckpointParams>,
) -> axum::response::Response {
    let Some(project) = params.project else {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "project is required"})),
        )
            .into_response();
    };

    let result = state
        .pool
        .read(move |conn| {
            let checkpoint = signet_services::session::get_latest_checkpoint(conn, &project)?;
            Ok(serde_json::json!({ "checkpoint": checkpoint }))
        })
        .await;

    match result {
        Ok(val) => (StatusCode::OK, Json(val)).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e.to_string()})),
        )
            .into_response(),
    }
}
