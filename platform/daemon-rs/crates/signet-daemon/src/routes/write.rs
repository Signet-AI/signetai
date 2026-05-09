//! Memory write route handlers (remember, modify, forget, recover).

use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;

use axum::Json;
use axum::extract::{ConnectInfo, Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use tracing::warn;

use signet_core::db::Priority;
use signet_services::session::SessionTracker;
use signet_services::transactions;

use crate::auth::middleware::{authenticate_headers, require_permission_guard, require_scope_guard};
use crate::auth::types::{Permission, TokenScope};
use crate::state::AppState;

// ---------------------------------------------------------------------------
// Mutations-frozen guard
// ---------------------------------------------------------------------------

fn check_mutations_frozen(state: &AppState) -> Option<axum::response::Response> {
    let frozen = state
        .config
        .manifest
        .memory
        .as_ref()
        .and_then(|m| m.pipeline_v2.as_ref())
        .map(|p| p.mutations_frozen)
        .unwrap_or(false);

    if frozen {
        Some(
            (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(serde_json::json!({"error": "Mutations are frozen (kill switch active)"})),
            )
                .into_response(),
        )
    } else {
        None
    }
}

// ---------------------------------------------------------------------------
// POST /api/memory/remember
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RememberBody {
    pub content: Option<String>,
    pub who: Option<String>,
    pub project: Option<String>,
    pub importance: Option<f64>,
    pub tags: Option<Value>,
    pub pinned: Option<bool>,
    pub source_type: Option<String>,
    pub source_id: Option<String>,
    #[serde(rename = "type")]
    pub memory_type: Option<String>,
    pub agent_id: Option<String>,
    pub visibility: Option<String>,
    pub scope: Option<String>,
    pub session_key: Option<String>,
}

fn parse_remember_tags(value: Option<Value>) -> Result<Vec<String>, &'static str> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };

    match value {
        Value::Null => Ok(Vec::new()),
        Value::String(tags) => Ok(tags
            .split(',')
            .map(str::trim)
            .filter(|tag| !tag.is_empty())
            .map(str::to_string)
            .collect()),
        Value::Array(tags) => {
            if tags.iter().any(|tag| !matches!(tag, Value::String(_))) {
                return Err("tags must be a string, string array, or null");
            }

            Ok(tags
                .into_iter()
                .filter_map(|tag| match tag {
                    Value::String(tag) => Some(tag.trim().to_string()),
                    _ => None,
                })
                .filter(|tag| !tag.is_empty())
                .collect())
        }
        _ => Err("tags must be a string, string array, or null"),
    }
}

fn normalize_scope(value: Option<String>) -> Option<String> {
    value
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn parse_visibility(value: Option<&str>) -> Result<String, &'static str> {
    let Some(raw) = value else {
        return Ok("global".to_string());
    };
    let v = raw.trim().to_lowercase();
    if v == "global" || v == "private" || v == "archived" {
        return Ok(v);
    }
    Err("visibility must be one of: global, private, archived")
}

fn session_agent_id(session_key: Option<&str>) -> Option<String> {
    let key = session_key?;
    let mut parts = key.splitn(3, ':');
    if parts.next() != Some("agent") {
        return None;
    }
    let id = parts.next().unwrap_or("").trim();
    if id.is_empty() {
        return None;
    }
    Some(id.to_string())
}

fn resolve_remember_agent(
    explicit: Option<&str>,
    session_key: Option<&str>,
) -> Result<String, &'static str> {
    let explicit = explicit.map(str::trim).filter(|s| !s.is_empty());
    let bound = session_agent_id(session_key);
    if let Some(agent) = explicit {
        if let Some(bound) = bound.as_deref()
            && agent != bound
        {
            return Err("agent_id does not match session scope");
        }
        return Ok(agent.to_string());
    }
    if let Some(bound) = bound {
        return Ok(bound);
    }
    Ok("default".to_string())
}

fn require_session_scope_for_write(
    sessions: &SessionTracker,
    agent_id: &str,
    visibility: &str,
    scope: Option<&str>,
    session_key: Option<&str>,
) -> Result<(), &'static str> {
    let scoped = agent_id != "default" || visibility != "global" || scope.is_some();
    if !scoped {
        return Ok(());
    }
    let Some(key) = session_key else {
        if agent_id != "default" {
            return Err("non-default agent_id requires session_key with agent scope");
        }
        return Err("non-default visibility/scope requires session_key with agent scope");
    };
    let Some(bound) = session_agent_id(Some(key)) else {
        return Err("session_key must be agent scoped");
    };
    if sessions.get_path(key).is_none() {
        return Err("session_key is not active");
    }
    if agent_id != "default" && agent_id != bound {
        return Err("agent_id does not match session scope");
    }
    Ok(())
}

fn is_loopback(addr: &SocketAddr) -> bool {
    match addr.ip() {
        IpAddr::V4(ip) => ip.is_loopback(),
        IpAddr::V6(ip) => ip.is_loopback(),
    }
}

fn guard_write_scope(
    state: &AppState,
    headers: &HeaderMap,
    peer: &SocketAddr,
    agent_id: &str,
) -> Result<(), Box<axum::response::Response>> {
    let auth = authenticate_headers(
        state.auth_mode,
        state.auth_secret.as_deref(),
        headers,
        is_loopback(peer),
    )?;
    let target = TokenScope {
        project: None,
        agent: Some(agent_id.to_string()),
        user: None,
    };
    require_scope_guard(&auth, &target, state.auth_mode, is_loopback(peer))
}

fn guard_forget_scope(
    state: &AppState,
    headers: &HeaderMap,
    peer: &SocketAddr,
    agent_ids: &[String],
) -> Result<(), Box<axum::response::Response>> {
    let is_local = is_loopback(peer);
    let auth = authenticate_headers(
        state.auth_mode,
        state.auth_secret.as_deref(),
        headers,
        is_local,
    )?;
    require_permission_guard(&auth, Permission::Forget, state.auth_mode, is_local)?;

    let targets = if agent_ids.is_empty() {
        vec!["default".to_string()]
    } else {
        agent_ids
            .iter()
            .fold(Vec::new(), |mut acc, agent| {
                if !acc.contains(agent) {
                    acc.push(agent.clone());
                }
                acc
            })
    };
    for agent_id in targets {
        let target = TokenScope {
            project: None,
            agent: Some(agent_id),
            user: None,
        };
        require_scope_guard(&auth, &target, state.auth_mode, is_local)?;
    }
    Ok(())
}

fn dead_letter_blocked_extraction_memory(
    conn: &rusqlite::Connection,
    memory_id: &str,
    reason: &str,
    max_attempts: i64,
) -> Result<(), rusqlite::Error> {
    let now = chrono::Utc::now().to_rfc3339();
    let updated = conn.execute(
        "UPDATE memory_jobs
         SET status = 'dead',
             error = ?1,
             max_attempts = ?2,
             failed_at = ?3,
             updated_at = ?3
         WHERE memory_id = ?4
           AND job_type IN ('extract', 'extraction')
           AND status = 'pending'",
        rusqlite::params![reason, max_attempts, now, memory_id],
    )?;

    let leased_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM memory_jobs
         WHERE memory_id = ?1
           AND job_type IN ('extract', 'extraction')
           AND status = 'leased'",
        rusqlite::params![memory_id],
        |row| row.get(0),
    )?;
    let completed_jobs_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM memory_jobs
         WHERE memory_id = ?1
           AND job_type IN ('extract', 'extraction')
           AND status = 'completed'",
        rusqlite::params![memory_id],
        |row| row.get(0),
    )?;
    let completed_memory_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM memories
         WHERE id = ?1
           AND extraction_status IN ('complete', 'completed')",
        rusqlite::params![memory_id],
        |row| row.get(0),
    )?;

    if updated == 0 {
        if leased_count == 0 {
            conn.execute(
                "INSERT INTO memory_jobs
                 (id, memory_id, job_type, status, error, attempts, max_attempts, failed_at, created_at, updated_at)
                 VALUES (?1, ?2, 'extract', 'dead', ?3, 0, ?4, ?5, ?5, ?5)",
                rusqlite::params![
                    uuid::Uuid::new_v4().to_string(),
                    memory_id,
                    reason,
                    max_attempts,
                    now
                ],
            )?;
        }
    }

    if leased_count == 0 && completed_jobs_count == 0 && completed_memory_count == 0 {
        conn.execute(
            "UPDATE memories SET extraction_status = 'failed' WHERE id = ?1",
            rusqlite::params![memory_id],
        )?;
    }
    Ok(())
}

fn blocked_extraction_reason_blocking(state: &AppState) -> Option<String> {
    let guard = state.extraction_state.blocking_read();
    guard.as_ref().and_then(|es| {
        if es.status == "blocked" {
            Some(
                es.reason
                    .clone()
                    .unwrap_or_else(|| "Extraction provider unavailable".to_string()),
            )
        } else {
            None
        }
    })
}

fn ingest_remember_with_blocked_guard(
    conn: &rusqlite::Connection,
    input: &transactions::IngestInput<'_>,
    blocked_reason: Option<&str>,
    extraction_max_attempts: i64,
) -> Result<transactions::IngestResult, signet_core::error::CoreError> {
    let result = transactions::ingest(conn, input)?;
    if result.duplicate_of.is_none() && let Some(reason) = blocked_reason {
        dead_letter_blocked_extraction_memory(conn, &result.id, reason, extraction_max_attempts)?;
    }
    Ok(result)
}

pub async fn remember(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<RememberBody>,
) -> axum::response::Response {
    if let Some(resp) = check_mutations_frozen(&state) {
        return resp;
    }

    let content = body.content.unwrap_or_default();
    let content = content.trim().to_string();
    if content.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "content is required"})),
        )
            .into_response();
    }

    let tags = match parse_remember_tags(body.tags) {
        Ok(tags) => tags,
        Err(error) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": error })),
            )
                .into_response();
        }
    };

    let who = body.who;
    let project = body.project;
    let importance = body.importance.unwrap_or(0.5);
    let pinned = body.pinned.unwrap_or(false);
    let source_type = body.source_type;
    let source_id = body.source_id;
    let memory_type = body.memory_type.unwrap_or_else(|| "fact".into());
    let session_key = body
        .session_key
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let agent_id = match resolve_remember_agent(body.agent_id.as_deref(), session_key.as_deref()) {
        Ok(id) => id,
        Err(err) => {
            return (
                StatusCode::FORBIDDEN,
                Json(serde_json::json!({ "error": err })),
            )
                .into_response();
        }
    };
    let scope = normalize_scope(body.scope);
    let visibility = match parse_visibility(body.visibility.as_deref()) {
        Ok(v) => v,
        Err(err) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": err })),
            )
                .into_response();
        }
    };
    if let Err(err) = require_session_scope_for_write(
        &state.sessions,
        &agent_id,
        &visibility,
        scope.as_deref(),
        session_key.as_deref(),
    ) {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": err })),
        )
            .into_response();
    }
    if let Err(resp) = guard_write_scope(state.as_ref(), &headers, &peer, &agent_id) {
        return *resp;
    }
    let extraction_max_attempts = state
        .config
        .manifest
        .memory
        .as_ref()
        .and_then(|memory| memory.pipeline_v2.as_ref())
        .map(|pipeline| i64::from(pipeline.worker.max_retries.max(1)))
        .unwrap_or(3);

    let result = state
        .pool
        .write_tx(Priority::High, {
            let state = state.clone();
            move |conn| {
                let blocked_reason = blocked_extraction_reason_blocking(&state);
                let r = ingest_remember_with_blocked_guard(
                    conn,
                    &transactions::IngestInput {
                        content: &content,
                        memory_type: &memory_type,
                        tags,
                        who: who.as_deref(),
                        why: None,
                        project: project.as_deref(),
                        importance,
                        pinned,
                        source_type: source_type.as_deref(),
                        source_id: source_id.as_deref(),
                        idempotency_key: None,
                        runtime_path: None,
                        actor: "api",
                        agent_id: &agent_id,
                        visibility: &visibility,
                        scope: scope.as_deref(),
                    },
                    blocked_reason.as_deref(),
                    extraction_max_attempts,
                )?;
                let status = if r.duplicate_of.is_some() {
                    "duplicate"
                } else {
                    "created"
                };
                Ok(serde_json::json!({
                    "id": r.id,
                    "status": status,
                    "hash": r.hash,
                    "duplicateOf": r.duplicate_of,
                }))
            }
        })
        .await;

    match result {
        Ok(val) => (StatusCode::OK, Json(val)).into_response(),
        Err(e) => {
            warn!(err = %e, "remember failed");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": "Failed to save memory"})),
            )
                .into_response()
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::net::SocketAddr;
    use std::sync::Arc;

    use axum::Json;
    use axum::body::to_bytes;
    use axum::extract::{ConnectInfo, State};
    use axum::http::{HeaderMap, StatusCode};
    use rusqlite::Connection;
    use serde_json::json;
    use tempfile::tempdir;

    use signet_core::config::{
        AgentIdentity, AuthConfig, DaemonConfig, EmbeddingConfig, MemoryManifestConfig,
        PipelineV2Config,
    };
    use signet_core::db::{DbPool, Priority};
    use signet_services::session::{RuntimePath, SessionTracker};

    use crate::auth::rate_limiter::{AuthRateLimiter, default_limits};
    use crate::auth::types::AuthMode;
    use crate::state::ExtractionRuntimeState;

    use super::{
        ForgetBatchBody, RememberBody, dead_letter_blocked_extraction_memory, guard_forget_scope,
        normalize_scope, parse_remember_tags, parse_visibility, remember, resolve_remember_agent,
        require_session_scope_for_write,
    };

    #[test]
    fn forget_batch_body_accepts_camel_case_confirm_token() {
        let body: ForgetBatchBody = serde_json::from_value(json!({
            "mode": "execute",
            "ids": ["mem-1"],
            "reason": "operator request",
            "confirmToken": "preview-token",
            "ifVersion": 7,
        }))
        .unwrap();

        assert_eq!(body.confirm_token.as_deref(), Some("preview-token"));
        assert_eq!(body.if_version, Some(json!(7)));
    }

    #[test]
    fn remember_tags_accepts_comma_separated_strings() {
        let tags = parse_remember_tags(Some(json!("alpha, beta"))).unwrap();
        assert_eq!(tags, vec!["alpha".to_string(), "beta".to_string()]);
    }

    #[test]
    fn remember_tags_accepts_string_arrays() {
        let tags = parse_remember_tags(Some(json!(["alpha", "beta"]))).unwrap();
        assert_eq!(tags, vec!["alpha".to_string(), "beta".to_string()]);
    }

    #[test]
    fn remember_tags_rejects_invalid_payloads() {
        let err = parse_remember_tags(Some(json!(42))).unwrap_err();
        assert_eq!(err, "tags must be a string, string array, or null");

        let err = parse_remember_tags(Some(json!(["alpha", 42]))).unwrap_err();
        assert_eq!(err, "tags must be a string, string array, or null");
    }

    #[test]
    fn normalize_scope_trims_and_coalesces_empty_to_none() {
        assert_eq!(normalize_scope(None), None);
        assert_eq!(normalize_scope(Some("".to_string())), None);
        assert_eq!(normalize_scope(Some("   ".to_string())), None);
        assert_eq!(
            normalize_scope(Some("  project:alpha  ".to_string())),
            Some("project:alpha".to_string())
        );
    }

    #[test]
    fn parse_visibility_rejects_invalid_values() {
        assert_eq!(parse_visibility(None).unwrap(), "global");
        assert_eq!(parse_visibility(Some("private")).unwrap(), "private");
        assert!(parse_visibility(Some("bogus")).is_err());
    }

    #[test]
    fn resolve_remember_agent_inherits_session_scope_when_missing() {
        let agent = resolve_remember_agent(None, Some("agent:agent-a:sess-1")).unwrap();
        assert_eq!(agent, "agent-a");
    }

    #[tokio::test]
    async fn batch_forget_guard_requires_authentication_in_team_mode() {
        let (state, _dir) = build_test_state_with_auth(AuthMode::Team, Some(vec![7; 32])).await;
        let err = guard_forget_scope(
            state.as_ref(),
            &HeaderMap::new(),
            &SocketAddr::from(([203, 0, 113, 10], 3850)),
            &["default".to_string()],
        )
        .unwrap_err();
        assert_eq!(err.status(), StatusCode::UNAUTHORIZED);
    }

    #[test]
    fn require_session_scope_for_write_requires_active_session_for_scoped_writes() {
        let sessions = SessionTracker::new();
        let err = require_session_scope_for_write(
            &sessions,
            "agent-a",
            "private",
            None,
            Some("agent:agent-a:sess-1"),
        )
        .unwrap_err();
        assert_eq!(err, "session_key is not active");

        assert!(matches!(
            sessions.claim("agent:agent-a:sess-1", RuntimePath::Plugin, "agent-a"),
            signet_services::session::ClaimResult::Ok
        ));
        assert!(
            require_session_scope_for_write(
                &sessions,
                "agent-a",
                "private",
                None,
                Some("agent:agent-a:sess-1"),
            )
            .is_ok()
        );
    }

    #[test]
    fn dead_letter_blocked_extraction_marks_memory_failed_and_uses_configured_attempts() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            r#"
            CREATE TABLE memories (
              id TEXT PRIMARY KEY,
              extraction_status TEXT
            );
            CREATE TABLE memory_jobs (
              id TEXT PRIMARY KEY,
              memory_id TEXT,
              job_type TEXT,
              status TEXT,
              error TEXT,
              attempts INTEGER,
              max_attempts INTEGER,
              failed_at TEXT,
              created_at TEXT,
              updated_at TEXT
            );
            "#,
        )
        .unwrap();
        conn.execute(
            "INSERT INTO memories (id, extraction_status) VALUES (?1, 'queued')",
            rusqlite::params!["mem-1"],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO memory_jobs
             (id, memory_id, job_type, status, error, attempts, max_attempts, failed_at, created_at, updated_at)
             VALUES (?1, ?2, 'extract', 'pending', NULL, 0, 3, NULL, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
            rusqlite::params!["job-1", "mem-1"],
        )
        .unwrap();

        dead_letter_blocked_extraction_memory(
            &conn,
            "mem-1",
            "Configured extraction provider unavailable",
            7,
        )
        .unwrap();

        let extraction_status: String = conn
            .query_row(
                "SELECT extraction_status FROM memories WHERE id = ?1",
                rusqlite::params!["mem-1"],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(extraction_status, "failed");

        let (status, max_attempts, error): (String, i64, Option<String>) = conn
            .query_row(
                "SELECT status, max_attempts, error FROM memory_jobs WHERE memory_id = ?1",
                rusqlite::params!["mem-1"],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(status, "dead");
        assert_eq!(max_attempts, 7);
        assert_eq!(
            error.as_deref(),
            Some("Configured extraction provider unavailable")
        );

        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM memory_jobs WHERE memory_id = ?1",
                rusqlite::params!["mem-1"],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn dead_letter_blocked_extraction_inserts_dead_job_when_none_exists() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            r#"
            CREATE TABLE memories (
              id TEXT PRIMARY KEY,
              extraction_status TEXT
            );
            CREATE TABLE memory_jobs (
              id TEXT PRIMARY KEY,
              memory_id TEXT,
              job_type TEXT,
              status TEXT,
              error TEXT,
              attempts INTEGER,
              max_attempts INTEGER,
              failed_at TEXT,
              created_at TEXT,
              updated_at TEXT
            );
            "#,
        )
        .unwrap();
        conn.execute(
            "INSERT INTO memories (id, extraction_status) VALUES (?1, 'queued')",
            rusqlite::params!["mem-2"],
        )
        .unwrap();

        dead_letter_blocked_extraction_memory(&conn, "mem-2", "Extraction unavailable", 9).unwrap();

        let extraction_status: String = conn
            .query_row(
                "SELECT extraction_status FROM memories WHERE id = ?1",
                rusqlite::params!["mem-2"],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(extraction_status, "failed");

        let (status, max_attempts, error): (String, i64, Option<String>) = conn
            .query_row(
                "SELECT status, max_attempts, error FROM memory_jobs WHERE memory_id = ?1",
                rusqlite::params!["mem-2"],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(status, "dead");
        assert_eq!(max_attempts, 9);
        assert_eq!(error.as_deref(), Some("Extraction unavailable"));
    }

    #[test]
    fn dead_letter_blocked_extraction_preserves_leased_jobs_and_memory_status() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            r#"
            CREATE TABLE memories (
              id TEXT PRIMARY KEY,
              extraction_status TEXT
            );
            CREATE TABLE memory_jobs (
              id TEXT PRIMARY KEY,
              memory_id TEXT,
              job_type TEXT,
              status TEXT,
              error TEXT,
              attempts INTEGER,
              max_attempts INTEGER,
              failed_at TEXT,
              created_at TEXT,
              updated_at TEXT
            );
            "#,
        )
        .unwrap();
        conn.execute(
            "INSERT INTO memories (id, extraction_status) VALUES (?1, 'queued')",
            rusqlite::params!["mem-3"],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO memory_jobs
             (id, memory_id, job_type, status, error, attempts, max_attempts, failed_at, created_at, updated_at)
             VALUES (?1, ?2, 'extract', 'leased', NULL, 0, 3, NULL, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
            rusqlite::params!["job-leased", "mem-3"],
        )
        .unwrap();

        dead_letter_blocked_extraction_memory(&conn, "mem-3", "Extraction unavailable", 9).unwrap();

        let extraction_status: String = conn
            .query_row(
                "SELECT extraction_status FROM memories WHERE id = ?1",
                rusqlite::params!["mem-3"],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(extraction_status, "queued");

        let (status, error): (String, Option<String>) = conn
            .query_row(
                "SELECT status, error FROM memory_jobs WHERE id = ?1",
                rusqlite::params!["job-leased"],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(status, "leased");
        assert_eq!(error, None);
    }

    #[test]
    fn dead_letter_blocked_extraction_preserves_completed_memory_status() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            r#"
            CREATE TABLE memories (
              id TEXT PRIMARY KEY,
              extraction_status TEXT
            );
            CREATE TABLE memory_jobs (
              id TEXT PRIMARY KEY,
              memory_id TEXT,
              job_type TEXT,
              status TEXT,
              error TEXT,
              attempts INTEGER,
              max_attempts INTEGER,
              failed_at TEXT,
              created_at TEXT,
              updated_at TEXT
            );
            "#,
        )
        .unwrap();
        conn.execute(
            "INSERT INTO memories (id, extraction_status) VALUES (?1, 'completed')",
            rusqlite::params!["mem-4"],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO memory_jobs
             (id, memory_id, job_type, status, error, attempts, max_attempts, failed_at, created_at, updated_at)
             VALUES (?1, ?2, 'extract', 'completed', NULL, 1, 3, NULL, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
            rusqlite::params!["job-completed", "mem-4"],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO memory_jobs
             (id, memory_id, job_type, status, error, attempts, max_attempts, failed_at, created_at, updated_at)
             VALUES (?1, ?2, 'extract', 'pending', NULL, 0, 3, NULL, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
            rusqlite::params!["job-pending", "mem-4"],
        )
        .unwrap();

        dead_letter_blocked_extraction_memory(&conn, "mem-4", "Extraction unavailable", 9).unwrap();

        let extraction_status: String = conn
            .query_row(
                "SELECT extraction_status FROM memories WHERE id = ?1",
                rusqlite::params!["mem-4"],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(extraction_status, "completed");

        let dead_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM memory_jobs WHERE memory_id = ?1 AND status = 'dead'",
                rusqlite::params!["mem-4"],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(dead_count, 1);
    }

    async fn build_test_state() -> (Arc<crate::state::AppState>, tempfile::TempDir) {
        build_test_state_with_auth(AuthMode::Local, None).await
    }

    async fn build_test_state_with_auth(
        auth_mode: AuthMode,
        auth_secret: Option<Vec<u8>>,
    ) -> (Arc<crate::state::AppState>, tempfile::TempDir) {
        let dir = tempdir().expect("tempdir");
        let db = dir.path().join("memory").join("memories.db");
        std::fs::create_dir_all(db.parent().expect("db parent")).expect("create memory dir");
        std::fs::write(
            dir.path().join("agent.yaml"),
            "memory:\n  pipelineV2:\n    enabled: true\n",
        )
        .expect("write config");

        let (pool, _writer) = DbPool::open(&db).expect("open db");
        pool.write(Priority::High, |conn| {
            let mut stmt = conn.prepare("PRAGMA table_info(memories)")?;
            let columns = stmt
                .query_map([], |row| row.get::<_, String>(1))?
                .collect::<Result<Vec<_>, _>>()?;
            if !columns.iter().any(|column| column == "agent_id") {
                conn.execute_batch("ALTER TABLE memories ADD COLUMN agent_id TEXT DEFAULT 'default'")?;
            }
            if !columns.iter().any(|column| column == "visibility") {
                conn.execute_batch("ALTER TABLE memories ADD COLUMN visibility TEXT DEFAULT 'global'")?;
            }
            Ok(serde_json::json!({"ok": true}))
        })
        .await
        .expect("memory column patch");
        let rules = default_limits();
        let manifest = signet_core::config::AgentManifest {
            agent: AgentIdentity {
                name: "test-agent".to_string(),
                description: None,
                created: None,
                updated: None,
            },
            embedding: Some(EmbeddingConfig::default()),
            memory: Some(MemoryManifestConfig {
                database: None,
                vectors: None,
                session_budget: None,
                decay_rate: None,
                pipeline_v2: Some(PipelineV2Config {
                    enabled: true,
                    ..Default::default()
                }),
            }),
            auth: Some(AuthConfig {
                method: "token".to_string(),
                chain_id: None,
                mode: Some("local".to_string()),
                rate_limits: Some(HashMap::new()),
            }),
            ..Default::default()
        };

        (
            Arc::new(crate::state::AppState::new(
                DaemonConfig {
                    base_path: dir.path().to_path_buf(),
                    db_path: db,
                    port: 3850,
                    host: "127.0.0.1".to_string(),
                    bind: Some("127.0.0.1".to_string()),
                    manifest,
                },
                pool,
                None,
                None, // llm provider
                None,
                auth_mode,
                auth_secret,
                AuthRateLimiter::from_rules(&rules),
                AuthRateLimiter::from_rules(&rules),
            )),
            dir,
        )
    }

    async fn read_json_body(response: axum::response::Response) -> serde_json::Value {
        let bytes = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body bytes");
        serde_json::from_slice(&bytes).expect("json body")
    }

    #[tokio::test]
    async fn remember_atomically_dead_letters_blocked_extraction() {
        let (state, _dir) = build_test_state().await;
        {
            let mut extraction = state.extraction_state.write().await;
            *extraction = Some(ExtractionRuntimeState {
                configured: Some("claude-code".to_string()),
                resolved: "claude-code".to_string(),
                effective: "none".to_string(),
                fallback_provider: "none".to_string(),
                status: "blocked".to_string(),
                degraded: true,
                fallback_applied: false,
                reason: Some("Extraction blocked for test".to_string()),
                since: Some("2026-03-27T00:00:00Z".to_string()),
            });
        }

        let response = remember(
            State(state.clone()),
            ConnectInfo(SocketAddr::from(([127, 0, 0, 1], 3850))),
            HeaderMap::new(),
            Json(RememberBody {
                content: Some("Atomic blocked remember".to_string()),
                who: None,
                project: None,
                importance: None,
                tags: None,
                pinned: None,
                source_type: None,
                source_id: None,
                memory_type: None,
                agent_id: None,
                visibility: None,
                scope: None,
                session_key: None,
            }),
        )
        .await;

        assert_eq!(response.status(), StatusCode::OK);
        let body = read_json_body(response).await;
        assert_eq!(body["status"], "created");
        assert!(body.get("warning").is_none());

        let memory_id = body["id"].as_str().expect("memory id").to_string();
        let memory = state
            .pool
            .read(move |conn| {
                let row = conn.query_row(
                    "SELECT extraction_status FROM memories WHERE id = ?1",
                    rusqlite::params![memory_id],
                    |row| row.get::<_, String>(0),
                )?;
                Ok(row)
            })
            .await
            .expect("read memory");
        assert_eq!(memory, "failed");

        let jobs = state
            .pool
            .read(|conn| {
                let row = conn.query_row(
                    "SELECT COUNT(*) FROM memory_jobs WHERE job_type = 'extract' AND status = 'dead'",
                    [],
                    |row| row.get::<_, i64>(0),
                )?;
                Ok(row)
            })
            .await
            .expect("read jobs");
        assert_eq!(jobs, 1);
    }

    #[tokio::test]
    async fn remember_rolls_back_when_blocked_dead_letter_fails() {
        let (state, _dir) = build_test_state().await;
        {
            let mut extraction = state.extraction_state.write().await;
            *extraction = Some(ExtractionRuntimeState {
                configured: Some("claude-code".to_string()),
                resolved: "claude-code".to_string(),
                effective: "none".to_string(),
                fallback_provider: "none".to_string(),
                status: "blocked".to_string(),
                degraded: true,
                fallback_applied: false,
                reason: Some("Extraction blocked for test".to_string()),
                since: Some("2026-03-27T00:00:00Z".to_string()),
            });
        }

        state
            .pool
            .write(Priority::High, |conn| {
                conn.execute_batch("DROP TABLE memory_jobs")?;
                Ok(serde_json::json!({"ok": true}))
            })
            .await
            .expect("drop memory_jobs");

        let response = remember(
            State(state.clone()),
            ConnectInfo(SocketAddr::from(([127, 0, 0, 1], 3850))),
            HeaderMap::new(),
            Json(RememberBody {
                content: Some("Should roll back".to_string()),
                who: None,
                project: None,
                importance: None,
                tags: None,
                pinned: None,
                source_type: None,
                source_id: None,
                memory_type: None,
                agent_id: None,
                visibility: None,
                scope: None,
                session_key: None,
            }),
        )
        .await;

        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
        let body = read_json_body(response).await;
        assert_eq!(body["error"], "Failed to save memory");

        let memories = state
            .pool
            .read(|conn| {
                let row = conn.query_row("SELECT COUNT(*) FROM memories", [], |row| row.get::<_, i64>(0))?;
                Ok(row)
            })
            .await
            .expect("read memories");
        assert_eq!(memories, 0);
    }

    #[tokio::test]
    async fn remember_duplicate_does_not_create_dead_job_when_blocked() {
        let (state, _dir) = build_test_state().await;
        state
            .pool
            .write_tx(Priority::High, |conn| {
                let _ = signet_services::transactions::ingest(
                    conn,
                    &signet_services::transactions::IngestInput {
                        content: "Duplicate content",
                        memory_type: "fact",
                        tags: Vec::new(),
                        who: None,
                        why: None,
                        project: None,
                        importance: 0.5,
                        pinned: false,
                        source_type: None,
                        source_id: None,
                        idempotency_key: None,
                        runtime_path: None,
                        actor: "test",
                        agent_id: "default",
                        visibility: "global",
                        scope: None,
                    },
                )?;
                Ok(serde_json::json!({"ok": true}))
            })
            .await
            .expect("seed memory");

        {
            let mut extraction = state.extraction_state.write().await;
            *extraction = Some(ExtractionRuntimeState {
                configured: Some("claude-code".to_string()),
                resolved: "claude-code".to_string(),
                effective: "none".to_string(),
                fallback_provider: "none".to_string(),
                status: "blocked".to_string(),
                degraded: true,
                fallback_applied: false,
                reason: Some("Extraction blocked for test".to_string()),
                since: Some("2026-03-27T00:00:00Z".to_string()),
            });
        }

        let response = remember(
            State(state.clone()),
            ConnectInfo(SocketAddr::from(([127, 0, 0, 1], 3850))),
            HeaderMap::new(),
            Json(RememberBody {
                content: Some("Duplicate content".to_string()),
                who: None,
                project: None,
                importance: None,
                tags: None,
                pinned: None,
                source_type: None,
                source_id: None,
                memory_type: None,
                agent_id: None,
                visibility: None,
                scope: None,
                session_key: None,
            }),
        )
        .await;

        assert_eq!(response.status(), StatusCode::OK);
        let body = read_json_body(response).await;
        assert_eq!(body["status"], "duplicate");

        let dead_jobs = state
            .pool
            .read(|conn| {
                let row = conn.query_row(
                    "SELECT COUNT(*) FROM memory_jobs WHERE job_type = 'extract' AND status = 'dead'",
                    [],
                    |row| row.get::<_, i64>(0),
                )?;
                Ok(row)
            })
            .await
            .expect("read dead jobs");
        assert_eq!(dead_jobs, 0);
    }
}

// ---------------------------------------------------------------------------
// DELETE /api/memory/:id
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct DeleteParams {
    pub reason: Option<String>,
    pub force: Option<String>,
    pub if_version: Option<i64>,
}

pub async fn delete(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    axum::extract::Query(params): axum::extract::Query<DeleteParams>,
) -> axum::response::Response {
    if let Some(resp) = check_mutations_frozen(&state) {
        return resp;
    }

    let force = params
        .force
        .as_deref()
        .map(|f| f == "1" || f == "true")
        .unwrap_or(false);
    let reason = params.reason;
    let if_version = params.if_version;

    let result = state
        .pool
        .write(Priority::High, move |conn| {
            let r = transactions::forget(
                conn,
                &transactions::ForgetInput {
                    id: &id,
                    force,
                    if_version,
                    actor: "api",
                    reason: reason.as_deref(),
                    actor_type: None,
                },
            )?;

            match r {
                transactions::ForgetResult::Deleted { new_version } => Ok(serde_json::json!({
                    "status": "deleted",
                    "newVersion": new_version,
                })),
                transactions::ForgetResult::NotFound => {
                    Ok(serde_json::json!({"status": "not_found", "_code": 404}))
                }
                transactions::ForgetResult::AlreadyDeleted => {
                    Ok(serde_json::json!({"status": "already_deleted"}))
                }
                transactions::ForgetResult::VersionConflict { current } => Ok(serde_json::json!({
                    "status": "version_mismatch",
                    "currentVersion": current,
                    "_code": 409,
                })),
                transactions::ForgetResult::PinnedRequiresForce => {
                    Ok(serde_json::json!({"status": "pinned", "_code": 409}))
                }
                transactions::ForgetResult::AutonomousForceDenied => {
                    Ok(serde_json::json!({"status": "autonomous_force_denied", "_code": 403}))
                }
            }
        })
        .await;

    match result {
        Ok(val) => {
            let code = val
                .get("_code")
                .and_then(|c| c.as_u64())
                .and_then(|c| StatusCode::from_u16(c as u16).ok())
                .unwrap_or(StatusCode::OK);
            (code, Json(val)).into_response()
        }
        Err(e) => {
            warn!(err = %e, "delete failed");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": "Delete failed"})),
            )
                .into_response()
        }
    }
}

// ---------------------------------------------------------------------------
// POST /api/memory/:id/recover
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct RecoverBody {
    pub reason: Option<String>,
    pub if_version: Option<i64>,
}

pub async fn recover(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    body: Option<Json<RecoverBody>>,
) -> axum::response::Response {
    if let Some(resp) = check_mutations_frozen(&state) {
        return resp;
    }

    let body = body.map(|Json(b)| b);
    let reason = body.as_ref().and_then(|b| b.reason.clone());
    let if_version = body.as_ref().and_then(|b| b.if_version);

    let result = state
        .pool
        .write(Priority::High, move |conn| {
            let r = transactions::recover(
                conn,
                &transactions::RecoverInput {
                    id: &id,
                    if_version,
                    actor: "api",
                    reason: reason.as_deref(),
                },
            )?;

            match r {
                transactions::RecoverResult::Recovered { new_version } => Ok(serde_json::json!({
                    "status": "recovered",
                    "newVersion": new_version,
                })),
                transactions::RecoverResult::NotFound => {
                    Ok(serde_json::json!({"status": "not_found", "_code": 404}))
                }
                transactions::RecoverResult::NotDeleted => {
                    Ok(serde_json::json!({"status": "not_deleted"}))
                }
                transactions::RecoverResult::VersionConflict { current } => Ok(serde_json::json!({
                    "status": "version_mismatch",
                    "currentVersion": current,
                    "_code": 409,
                })),
                transactions::RecoverResult::RetentionExpired => {
                    Ok(serde_json::json!({"status": "expired", "_code": 410}))
                }
            }
        })
        .await;

    match result {
        Ok(val) => {
            let code = val
                .get("_code")
                .and_then(|c| c.as_u64())
                .and_then(|c| StatusCode::from_u16(c as u16).ok())
                .unwrap_or(StatusCode::OK);
            (code, Json(val)).into_response()
        }
        Err(e) => {
            warn!(err = %e, "recover failed");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": "Recover failed"})),
            )
                .into_response()
        }
    }
}

// ---------------------------------------------------------------------------
// POST /api/memory/modify (batch update)
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct ModifyBody {
    pub patches: Vec<PatchItem>,
    pub reason: Option<String>,
}

#[derive(Deserialize)]
pub struct PatchItem {
    pub id: String,
    pub patch: PatchFields,
    pub if_version: Option<i64>,
}

#[derive(Deserialize)]
pub struct PatchFields {
    pub content: Option<String>,
    pub importance: Option<f64>,
    pub tags: Option<String>,
    #[serde(rename = "type")]
    pub memory_type: Option<String>,
    pub pinned: Option<bool>,
}

const MAX_MUTATION_BATCH: usize = 100;

const FORGET_CONFIRM_THRESHOLD: usize = 25;

#[derive(Deserialize)]
pub struct ForgetBatchBody {
    pub mode: Option<String>,
    pub ids: Option<Value>,
    pub limit: Option<Value>,
    pub reason: Option<String>,
    pub force: Option<Value>,
    #[serde(alias = "confirmToken")]
    pub confirm_token: Option<String>,
    #[serde(alias = "ifVersion")]
    pub if_version: Option<Value>,
}

#[derive(Clone)]
struct ForgetCandidate {
    id: String,
    pinned: bool,
    version: i64,
    score: f64,
}

fn parse_positive_limit(value: Option<&Value>) -> Result<usize, &'static str> {
    let Some(value) = value else {
        return Ok(20);
    };
    let Some(raw) = value.as_u64() else {
        return Err("limit must be a positive integer");
    };
    if raw == 0 {
        return Err("limit must be a positive integer");
    }
    Ok((raw as usize).clamp(1, MAX_MUTATION_BATCH))
}

fn parse_forget_ids(value: Option<&Value>) -> Result<Vec<String>, &'static str> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    let Some(values) = value.as_array() else {
        return Err("ids must be an array of strings");
    };
    values
        .iter()
        .map(|value| {
            value
                .as_str()
                .map(str::trim)
                .filter(|id| !id.is_empty())
                .map(str::to_string)
                .ok_or("ids must contain non-empty strings")
        })
        .collect()
}

fn parse_optional_bool(value: Option<&Value>) -> Result<bool, &'static str> {
    let Some(value) = value else {
        return Ok(false);
    };
    value.as_bool().ok_or("force must be a boolean")
}

fn dedupe_forget_ids(ids: Vec<String>, limit: usize) -> Vec<String> {
    ids.into_iter()
        .fold(Vec::new(), |mut acc, id| {
            if !acc.contains(&id) {
                acc.push(id);
            }
            acc
        })
        .into_iter()
        .take(limit)
        .collect()
}

fn build_forget_confirm_token(ids: &[String]) -> String {
    let mut deduped = ids.to_vec();
    deduped.sort();
    deduped.dedup();
    let canonical = deduped.join("|");
    let digest = Sha256::digest(canonical.as_bytes());
    format!("{digest:x}").chars().take(32).collect()
}

fn forget_result_json(id: String, result: transactions::ForgetResult) -> serde_json::Value {
    match result {
        transactions::ForgetResult::Deleted { new_version } => serde_json::json!({
            "id": id,
            "status": "deleted",
            "newVersion": new_version,
        }),
        transactions::ForgetResult::NotFound => {
            serde_json::json!({"id": id, "status": "not_found"})
        }
        transactions::ForgetResult::AlreadyDeleted => {
            serde_json::json!({"id": id, "status": "already_deleted"})
        }
        transactions::ForgetResult::VersionConflict { current } => serde_json::json!({
            "id": id,
            "status": "version_mismatch",
            "currentVersion": current,
        }),
        transactions::ForgetResult::PinnedRequiresForce => {
            serde_json::json!({"id": id, "status": "pinned"})
        }
        transactions::ForgetResult::AutonomousForceDenied => {
            serde_json::json!({"id": id, "status": "autonomous_force_denied"})
        }
    }
}

pub async fn forget_batch(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    body: Result<Json<ForgetBatchBody>, axum::extract::rejection::JsonRejection>,
) -> axum::response::Response {
    let Json(body) = match body {
        Ok(body) => body,
        Err(_) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"error": "Invalid JSON body"})),
            )
                .into_response();
        }
    };

    let mode = body.mode.as_deref().unwrap_or("preview");
    if mode != "preview" && mode != "execute" {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "mode must be preview or execute"})),
        )
            .into_response();
    }

    let limit = match parse_positive_limit(body.limit.as_ref()) {
        Ok(limit) => limit,
        Err(error) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"error": error})),
            )
                .into_response();
        }
    };
    let ids = match parse_forget_ids(body.ids.as_ref()) {
        Ok(ids) => ids,
        Err(error) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"error": error})),
            )
                .into_response();
        }
    };
    if ids.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": "query, ids, or at least one filter (type/tags/who/source_type/since/until) is required",
            })),
        )
            .into_response();
    }

    let requested_ids = dedupe_forget_ids(ids, limit);
    let candidates_result = state
        .pool
        .read({
            let ids = requested_ids.clone();
            move |conn| {
                if ids.is_empty() {
                    return Ok((Vec::new(), Vec::new()));
                }

                let placeholders = std::iter::repeat_n("?", ids.len())
                    .collect::<Vec<_>>()
                    .join(", ");
                let sql = format!(
                    "SELECT id, pinned, version FROM memories WHERE is_deleted = 0 AND id IN ({placeholders})"
                );
                let mut stmt = conn.prepare(&sql)?;
                let rows = stmt
                    .query_map(rusqlite::params_from_iter(ids.iter()), |row| {
                        Ok(ForgetCandidate {
                            id: row.get(0)?,
                            pinned: row.get::<_, i64>(1)? != 0,
                            version: row.get(2)?,
                            score: 0.0,
                        })
                    })?
                    .collect::<Result<Vec<_>, _>>()?;
                let agent_sql = format!(
                    "SELECT DISTINCT COALESCE(NULLIF(agent_id, ''), 'default') FROM memories WHERE id IN ({placeholders})"
                );
                let mut agent_stmt = conn.prepare(&agent_sql)?;
                let agent_ids = agent_stmt
                    .query_map(rusqlite::params_from_iter(ids.iter()), |row| row.get(0))?
                    .collect::<Result<Vec<String>, _>>()?;
                let candidates = ids
                    .into_iter()
                    .filter_map(|id| rows.iter().find(|row| row.id == id).cloned())
                    .collect();
                Ok((candidates, agent_ids))
            }
        })
        .await;

    let (candidates, agent_ids) = match candidates_result {
        Ok(lookup) => lookup,
        Err(err) => {
            warn!(err = %err, "forget preview failed");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": "Forget preview failed"})),
            )
                .into_response();
        }
    };
    if let Err(resp) = guard_forget_scope(state.as_ref(), &headers, &peer, &agent_ids) {
        return *resp;
    }
    let candidate_ids = candidates
        .iter()
        .map(|candidate| candidate.id.clone())
        .collect::<Vec<_>>();
    let confirm_token = build_forget_confirm_token(&candidate_ids);
    let requires_confirm = candidate_ids.len() > FORGET_CONFIRM_THRESHOLD;

    if mode == "preview" {
        return Json(serde_json::json!({
            "mode": "preview",
            "count": candidates.len(),
            "requiresConfirm": requires_confirm,
            "confirmToken": confirm_token,
            "candidates": candidates.iter().map(|candidate| serde_json::json!({
                "id": candidate.id,
                "score": candidate.score,
                "pinned": candidate.pinned,
                "version": candidate.version,
            })).collect::<Vec<_>>(),
        }))
        .into_response();
    }

    let Some(reason) = body
        .reason
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    else {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "reason is required for execute mode"})),
        )
        .into_response();
    };
    let force = match parse_optional_bool(body.force.as_ref()) {
        Ok(force) => force,
        Err(error) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"error": error})),
            )
                .into_response();
        }
    };
    if body.if_version.is_some() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": "if_version is not supported for batch forget; use DELETE /api/memory/:id for version-guarded deletes",
            })),
        )
            .into_response();
    }
    if requires_confirm
        && body
            .confirm_token
            .as_deref()
            .map(str::trim)
            .filter(|token| *token == confirm_token)
            .is_none()
    {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": "confirmToken is required for large forget operations; run preview first",
                "requiresConfirm": true,
                "confirmToken": confirm_token,
                "count": candidates.len(),
            })),
        )
            .into_response();
    }
    if let Some(resp) = check_mutations_frozen(&state) {
        return resp;
    }

    let reason = reason.to_string();
    let result = state
        .pool
        .write(Priority::High, move |conn| {
            let results = requested_ids
                .into_iter()
                .map(|id| {
                    transactions::forget(
                        conn,
                        &transactions::ForgetInput {
                            id: &id,
                            force,
                            if_version: None,
                            actor: "api",
                            reason: Some(&reason),
                            actor_type: None,
                        },
                    )
                    .map(|result| forget_result_json(id, result))
                })
                .collect::<Result<Vec<_>, _>>()?;
            Ok(serde_json::json!({
                "mode": "execute",
                "requested": results.len(),
                "deleted": results.iter().filter(|result| result["status"] == "deleted").count(),
                "results": results,
            }))
        })
        .await;

    match result {
        Ok(body) => Json(body).into_response(),
        Err(err) => {
            warn!(err = %err, "forget batch failed");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": "Forget failed"})),
            )
                .into_response()
        }
    }
}

pub async fn modify_batch(
    State(state): State<Arc<AppState>>,
    Json(body): Json<ModifyBody>,
) -> axum::response::Response {
    if let Some(resp) = check_mutations_frozen(&state) {
        return resp;
    }

    if body.patches.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "patches is required"})),
        )
            .into_response();
    }

    if body.patches.len() > MAX_MUTATION_BATCH {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": format!("batch size exceeds limit of {MAX_MUTATION_BATCH}"),
            })),
        )
            .into_response();
    }

    let reason = body.reason;
    let patches = body.patches;

    let result = state
        .pool
        .write(Priority::High, move |conn| {
            let mut results = Vec::new();
            let mut updated = 0usize;

            for patch in &patches {
                let tags: Option<Vec<String>> = patch
                    .patch
                    .tags
                    .as_ref()
                    .map(|t| t.split(',').map(|s| s.trim().to_string()).collect());

                let r = transactions::modify(
                    conn,
                    &transactions::ModifyInput {
                        id: &patch.id,
                        content: patch.patch.content.as_deref(),
                        memory_type: patch.patch.memory_type.as_deref(),
                        tags,
                        importance: patch.patch.importance,
                        pinned: patch.patch.pinned,
                        if_version: patch.if_version,
                        actor: "api",
                        reason: reason.as_deref(),
                    },
                );

                match r {
                    Ok(transactions::ModifyResult::Updated { new_version }) => {
                        updated += 1;
                        results.push(serde_json::json!({
                            "id": patch.id,
                            "status": "updated",
                            "newVersion": new_version,
                            "contentChanged": patch.patch.content.is_some(),
                        }));
                    }
                    Ok(transactions::ModifyResult::NotFound) => {
                        results.push(serde_json::json!({
                            "id": patch.id,
                            "status": "not_found",
                        }));
                    }
                    Ok(transactions::ModifyResult::Deleted) => {
                        results.push(serde_json::json!({
                            "id": patch.id,
                            "status": "deleted",
                        }));
                    }
                    Ok(transactions::ModifyResult::VersionConflict { current }) => {
                        results.push(serde_json::json!({
                            "id": patch.id,
                            "status": "version_mismatch",
                            "currentVersion": current,
                        }));
                    }
                    Ok(transactions::ModifyResult::DuplicateHash { existing_id }) => {
                        results.push(serde_json::json!({
                            "id": patch.id,
                            "status": "duplicate_content_hash",
                            "duplicateMemoryId": existing_id,
                        }));
                    }
                    Ok(transactions::ModifyResult::NoChanges) => {
                        results.push(serde_json::json!({
                            "id": patch.id,
                            "status": "no_changes",
                        }));
                    }
                    Err(e) => {
                        results.push(serde_json::json!({
                            "id": patch.id,
                            "status": "error",
                            "error": e.to_string(),
                        }));
                    }
                }
            }

            Ok(serde_json::json!({
                "total": patches.len(),
                "updated": updated,
                "results": results,
            }))
        })
        .await;

    match result {
        Ok(val) => (StatusCode::OK, Json(val)).into_response(),
        Err(e) => {
            warn!(err = %e, "batch modify failed");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": "Modify failed"})),
            )
                .into_response()
        }
    }
}
