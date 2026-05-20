//! Memory write route handlers (remember, modify, forget, recover).

use std::collections::HashSet;
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;

use axum::Json;
use axum::extract::{ConnectInfo, Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use rusqlite::{OptionalExtension, params};
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use tracing::warn;

use signet_core::CoreError;
use signet_core::config::GuardrailsConfig;
use signet_core::db::Priority;
use signet_services::normalize::normalize_and_hash;
use signet_services::session::SessionTracker;
use signet_services::transactions;

use crate::auth::middleware::{authenticate_headers, require_scope_guard};
use crate::auth::types::TokenScope;
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
    #[serde(alias = "source_path", alias = "source")]
    pub source_path: Option<String>,
    #[serde(alias = "runtime_path")]
    pub runtime_path: Option<String>,
    #[serde(alias = "idempotency_key")]
    pub idempotency_key: Option<String>,
    pub metadata: Option<Value>,
    #[serde(rename = "type")]
    pub memory_type: Option<String>,
    pub agent_id: Option<String>,
    pub visibility: Option<String>,
    pub scope: Option<String>,
    pub session_key: Option<String>,
    pub structured: Option<Value>,
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

fn normalize_optional_string(value: Option<String>) -> Option<String> {
    value
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn metadata_string(metadata: Option<&Value>, keys: &[&str]) -> Option<String> {
    let obj = metadata.and_then(Value::as_object)?;
    for key in keys {
        if let Some(value) = obj.get(*key).and_then(Value::as_str) {
            let value = value.trim();
            if !value.is_empty() {
                return Some(value.to_string());
            }
        }
    }
    None
}

fn tags_csv(tags: &[String]) -> String {
    tags.join(",")
}

fn stored_tags_to_csv(tags: Option<&str>) -> String {
    let Some(tags) = tags else {
        return String::new();
    };
    serde_json::from_str::<Vec<String>>(tags)
        .map(|items| items.join(","))
        .unwrap_or_else(|_| tags.to_string())
}

struct RememberDedupeRow {
    id: String,
    memory_type: String,
    tags: Option<String>,
    pinned: bool,
    importance: f64,
    content: String,
}

#[derive(Debug)]
struct ChunkRow {
    id: String,
    source_id: Option<String>,
    content_hash: String,
    idempotency_key: String,
}

#[derive(Debug)]
struct ChunkPlan {
    content: String,
    hash: String,
    idempotency_key: Option<String>,
}

fn chunk_by_sentence(text: &str, target_chars: usize) -> Vec<String> {
    let target = target_chars.max(1);
    let mut sentences = Vec::new();
    let mut start = 0usize;
    let mut chars = text.char_indices().peekable();
    while let Some((idx, ch)) = chars.next() {
        let split = matches!(ch, '.' | '!' | '?')
            && chars
                .peek()
                .map(|(_, next)| next.is_whitespace())
                .unwrap_or(true);
        if split {
            let end = idx + ch.len_utf8();
            let sentence = text[start..end].trim();
            if !sentence.is_empty() {
                sentences.push(sentence.to_string());
            }
            while let Some((next_idx, next)) = chars.peek().copied() {
                if !next.is_whitespace() {
                    start = next_idx;
                    break;
                }
                chars.next();
                start = next_idx + next.len_utf8();
            }
        }
    }
    if start < text.len() {
        let sentence = text[start..].trim();
        if !sentence.is_empty() {
            sentences.push(sentence.to_string());
        }
    }
    if sentences.is_empty() {
        sentences.push(text.trim().to_string());
    }

    let mut chunks = Vec::new();
    let mut current = String::new();
    for sentence in sentences {
        if sentence.len() > target * 2 {
            if !current.trim().is_empty() {
                chunks.push(current.trim().to_string());
                current.clear();
            }
            let mut offset = 0usize;
            while offset < sentence.len() {
                let mut end = (offset + target).min(sentence.len());
                while end < sentence.len() && !sentence.is_char_boundary(end) {
                    end += 1;
                }
                let chunk = sentence[offset..end].trim();
                if !chunk.is_empty() {
                    chunks.push(chunk.to_string());
                }
                offset = end;
            }
            continue;
        }

        let combined = if current.is_empty() {
            sentence.clone()
        } else {
            format!("{current} {sentence}")
        };
        if combined.len() > target && !current.is_empty() {
            chunks.push(current.trim().to_string());
            current = sentence;
        } else {
            current = combined;
        }
    }

    if !current.trim().is_empty() {
        chunks.push(current.trim().to_string());
    }
    chunks
}

fn chunk_idempotency_key(base: Option<&str>, index: usize) -> Option<String> {
    base.map(|key| format!("{key}:chunk:{}", index + 1))
}

fn chunk_idempotency_index(base: &str, key: &str) -> Option<usize> {
    let prefix = format!("{base}:chunk:");
    let suffix = key.strip_prefix(&prefix)?;
    let index = suffix.parse::<usize>().ok()?;
    index.checked_sub(1)
}

fn chunk_group_id(base: &str, agent_id: &str, visibility: &str, scope: Option<&str>) -> String {
    let mut hasher = Sha256::new();
    hasher.update(agent_id.as_bytes());
    hasher.update([0]);
    hasher.update(visibility.as_bytes());
    hasher.update([0]);
    hasher.update(scope.unwrap_or("__NULL__").as_bytes());
    hasher.update([0]);
    hasher.update(base.as_bytes());
    let hash = format!("{:x}", hasher.finalize());
    format!("chunk-group:{}", &hash[..32])
}

fn scoped_chunk_rows(
    conn: &rusqlite::Connection,
    base_key: &str,
    agent_id: &str,
    visibility: &str,
    scope: Option<&str>,
) -> Result<Vec<ChunkRow>, rusqlite::Error> {
    let prefix = format!("{base_key}:chunk:");
    let mut stmt = conn.prepare_cached(
        "SELECT id, source_id, content_hash, idempotency_key
         FROM memories
         WHERE instr(idempotency_key, ?1) = 1
           AND COALESCE(NULLIF(agent_id, ''), 'default') = ?2
           AND COALESCE(visibility, 'global') = ?3
           AND COALESCE(scope, '__NULL__') = ?4
           AND is_deleted = 0",
    )?;
    let mut rows = stmt
        .query_map(
            params![prefix, agent_id, visibility, scope.unwrap_or("__NULL__")],
            |row| {
                Ok(ChunkRow {
                    id: row.get(0)?,
                    source_id: row.get(1)?,
                    content_hash: row.get(2)?,
                    idempotency_key: row.get(3)?,
                })
            },
        )?
        .collect::<Result<Vec<_>, _>>()?;
    rows.sort_by_key(|row| chunk_idempotency_index(base_key, &row.idempotency_key));
    Ok(rows)
}

fn scoped_content_hash_row(
    conn: &rusqlite::Connection,
    hash: &str,
    agent_id: &str,
    scope: Option<&str>,
) -> Result<Option<String>, rusqlite::Error> {
    conn.query_row(
        "SELECT id
         FROM memories
         WHERE content_hash = ?1
           AND COALESCE(NULLIF(agent_id, ''), 'default') = ?2
           AND COALESCE(scope, '__NULL__') = ?3
           AND is_deleted = 0
         LIMIT 1",
        params![hash, agent_id, scope.unwrap_or("__NULL__")],
        |row| row.get(0),
    )
    .optional()
}

fn plan_chunks(
    content: &str,
    guardrails: &GuardrailsConfig,
    base_key: Option<&str>,
) -> Vec<ChunkPlan> {
    chunk_by_sentence(content, guardrails.chunk_target_chars)
        .into_iter()
        .enumerate()
        .filter_map(|(index, chunk)| {
            let normalized = normalize_and_hash(&chunk);
            if normalized.storage.is_empty() {
                return None;
            }
            Some(ChunkPlan {
                content: normalized.storage,
                hash: normalized.hash,
                idempotency_key: chunk_idempotency_key(base_key, index),
            })
        })
        .collect()
}

fn existing_chunks_match(base_key: &str, rows: &[ChunkRow], plans: &[ChunkPlan]) -> bool {
    let group_ids = rows
        .iter()
        .filter_map(|row| row.source_id.as_deref())
        .collect::<HashSet<_>>();
    group_ids.len() == 1
        && rows.len() == plans.len()
        && rows.iter().zip(plans.iter()).all(|(row, plan)| {
            chunk_idempotency_index(base_key, &row.idempotency_key).is_some()
                && plan.idempotency_key.as_deref() == Some(row.idempotency_key.as_str())
                && row.content_hash == plan.hash
        })
}

fn scoped_idempotency_dedupe_row(
    conn: &rusqlite::Connection,
    key: &str,
    agent_id: &str,
    visibility: &str,
    scope: Option<&str>,
) -> Result<Option<RememberDedupeRow>, rusqlite::Error> {
    conn.query_row(
        "SELECT id, type, tags, pinned, importance, content
         FROM memories
         WHERE idempotency_key = ?1
           AND COALESCE(NULLIF(agent_id, ''), 'default') = ?2
           AND COALESCE(visibility, 'global') = ?3
           AND COALESCE(scope, '__NULL__') = ?4
           AND is_deleted = 0
         LIMIT 1",
        params![key, agent_id, visibility, scope.unwrap_or("__NULL__")],
        |row| {
            Ok(RememberDedupeRow {
                id: row.get(0)?,
                memory_type: row.get(1)?,
                tags: row.get(2)?,
                pinned: row.get::<_, i64>(3)? != 0,
                importance: row.get(4)?,
                content: row.get(5)?,
            })
        },
    )
    .optional()
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
    if result.duplicate_of.is_none()
        && let Some(reason) = blocked_reason
    {
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

    let metadata = body.metadata.clone();
    let who = normalize_optional_string(body.who).or_else(|| Some("daemon".to_string()));
    let project = normalize_optional_string(body.project);
    let importance = body.importance.unwrap_or(0.5);
    let pinned = body.pinned.unwrap_or(false);
    let source_type =
        normalize_optional_string(body.source_type).or_else(|| Some("manual".to_string()));
    let source_id = normalize_optional_string(body.source_id);
    let source_path = normalize_optional_string(body.source_path)
        .or_else(|| metadata_string(metadata.as_ref(), &["sourcePath", "source_path", "source"]));
    let runtime_path = normalize_optional_string(body.runtime_path)
        .or_else(|| metadata_string(metadata.as_ref(), &["runtimePath", "runtime_path"]));
    let idempotency_key = normalize_optional_string(body.idempotency_key)
        .or_else(|| metadata_string(metadata.as_ref(), &["idempotencyKey", "idempotency_key"]));
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
    let tags_response = tags_csv(&tags);
    let guardrails = state
        .config
        .manifest
        .memory
        .as_ref()
        .and_then(|memory| memory.pipeline_v2.as_ref())
        .map(|pipeline| pipeline.guardrails.clone())
        .unwrap_or_default();
    let has_structured = body
        .structured
        .as_ref()
        .is_some_and(|value| !value.is_null());

    if !has_structured && content.chars().count() > guardrails.max_content_chars {
        let chunk_plans = plan_chunks(&content, &guardrails, idempotency_key.as_deref());
        if chunk_plans.is_empty() {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"error": "content produced no valid chunks"})),
            )
                .into_response();
        }

        let result = state
            .pool
            .write_tx(Priority::High, {
                let state = state.clone();
                let tags = tags.clone();
                let who = who.clone();
                let project = project.clone();
                let source_path = source_path.clone();
                let runtime_path = runtime_path.clone();
                let idempotency_key = idempotency_key.clone();
                let agent_id = agent_id.clone();
                let visibility = visibility.clone();
                let scope = scope.clone();
                move |conn| {
                    if let Some(key) = idempotency_key.as_deref() {
                        if scoped_idempotency_dedupe_row(
                            conn,
                            key,
                            &agent_id,
                            &visibility,
                            scope.as_deref(),
                        )?
                        .is_some()
                        {
                            return Ok(serde_json::json!({
                                "__status": 409,
                                "error": "idempotencyKey already used for non-chunk content"
                            }));
                        }

                        let existing = scoped_chunk_rows(
                            conn,
                            key,
                            &agent_id,
                            &visibility,
                            scope.as_deref(),
                        )?;
                        if !existing.is_empty() {
                            if !existing_chunks_match(key, &existing, &chunk_plans) {
                                return Ok(serde_json::json!({
                                    "__status": 409,
                                    "error": "idempotencyKey already used for different chunked content"
                                }));
                            }
                            let group_id = existing
                                .iter()
                                .find_map(|row| row.source_id.clone())
                                .unwrap_or_default();
                            return Ok(serde_json::json!({
                                "chunked": true,
                                "chunk_count": existing.len(),
                                "ids": existing.iter().map(|row| row.id.as_str()).collect::<Vec<_>>(),
                                "group_id": group_id,
                                "deduped": true
                            }));
                        }
                    }

                    let mut hashes = HashSet::new();
                    for plan in &chunk_plans {
                        if !hashes.insert(plan.hash.as_str()) {
                            return Ok(serde_json::json!({
                                "__status": 409,
                                "error": "chunked content contains duplicate chunks"
                            }));
                        }
                        if scoped_content_hash_row(conn, &plan.hash, &agent_id, scope.as_deref())?
                            .is_some()
                        {
                            return Ok(serde_json::json!({
                                "__status": 409,
                                "error": "chunk content already exists for this agent and scope"
                            }));
                        }
                    }

                    let group_id = idempotency_key
                        .as_deref()
                        .map(|key| chunk_group_id(key, &agent_id, &visibility, scope.as_deref()))
                        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
                    let now = chrono::Utc::now().to_rfc3339();
                    conn.execute(
                        "INSERT OR IGNORE INTO entities
                         (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at)
                         VALUES (?1, ?2, ?2, 'chunk_group', ?3, 0, ?4, ?4)",
                        params![
                            group_id,
                            format!("chunk-group:{group_id}"),
                            agent_id,
                            now
                        ],
                    )?;

                    let blocked_reason = blocked_extraction_reason_blocking(&state);
                    let mut ids = Vec::with_capacity(chunk_plans.len());
                    for plan in &chunk_plans {
                        let r = ingest_remember_with_blocked_guard(
                            conn,
                            &transactions::IngestInput {
                                content: &plan.content,
                                memory_type: memory_type.as_str(),
                                tags: tags.clone(),
                                who: who.as_deref(),
                                why: None,
                                project: project.as_deref(),
                                importance,
                                pinned,
                                source_type: Some("chunk"),
                                source_id: Some(&group_id),
                                source_path: source_path.as_deref(),
                                idempotency_key: plan.idempotency_key.as_deref(),
                                runtime_path: runtime_path.as_deref(),
                                actor: "api",
                                agent_id: &agent_id,
                                visibility: &visibility,
                                scope: scope.as_deref(),
                            },
                            blocked_reason.as_deref(),
                            extraction_max_attempts,
                        )?;
                        if r.duplicate_of.is_some() {
                            return Err(CoreError::Conflict(
                                "chunk content already exists for this agent and scope".to_string(),
                            ));
                        }
                        conn.execute(
                            "INSERT OR IGNORE INTO memory_entity_mentions
                             (memory_id, entity_id, mention_text, confidence, created_at)
                             VALUES (?1, ?2, 'chunk', 1.0, ?3)",
                            params![r.id, group_id, now],
                        )?;
                        ids.push(r.id);
                    }

                    Ok(serde_json::json!({
                        "chunked": true,
                        "chunk_count": ids.len(),
                        "ids": ids,
                        "group_id": group_id
                    }))
                }
            })
            .await;

        return match result {
            Ok(mut val) => {
                let status = val
                    .get("__status")
                    .and_then(Value::as_u64)
                    .and_then(|code| StatusCode::from_u16(code as u16).ok())
                    .unwrap_or(StatusCode::OK);
                if let Some(obj) = val.as_object_mut() {
                    obj.remove("__status");
                }
                (status, Json(val)).into_response()
            }
            Err(CoreError::Conflict(msg)) => (
                StatusCode::CONFLICT,
                Json(serde_json::json!({"error": msg})),
            )
                .into_response(),
            Err(e) => {
                warn!(err = %e, "remember chunked import failed");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(serde_json::json!({"error": "Failed to save chunks"})),
                )
                    .into_response()
            }
        };
    }

    let result = state
        .pool
        .write_tx(Priority::High, {
            let state = state.clone();
            move |conn| {
                if let Some(key) = idempotency_key.as_deref()
                    && !scoped_chunk_rows(conn, key, &agent_id, &visibility, scope.as_deref())?
                        .is_empty()
                {
                    return Ok(serde_json::json!({
                        "__status": 409,
                        "error": "idempotencyKey already used for chunked content"
                    }));
                }
                if let Some(key) = idempotency_key.as_deref()
                    && let Some(row) = scoped_idempotency_dedupe_row(
                        conn,
                        key,
                        &agent_id,
                        &visibility,
                        scope.as_deref(),
                    )?
                {
                    return Ok(serde_json::json!({
                        "id": row.id,
                        "type": row.memory_type,
                        "tags": stored_tags_to_csv(row.tags.as_deref()),
                        "pinned": row.pinned,
                        "importance": row.importance,
                        "content": row.content,
                        "embedded": true,
                        "deduped": true,
                    }));
                }

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
                        source_path: source_path.as_deref(),
                        idempotency_key: idempotency_key.as_deref(),
                        runtime_path: runtime_path.as_deref(),
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
                let mut response = serde_json::json!({
                    "id": r.id,
                    "status": status,
                    "hash": r.hash,
                    "duplicateOf": r.duplicate_of,
                    "tags": tags_response,
                });
                if r.duplicate_of.is_some()
                    && let Some(obj) = response.as_object_mut()
                {
                    obj.insert("deduped".to_string(), Value::Bool(true));
                }
                Ok(response)
            }
        })
        .await;

    match result {
        Ok(mut val) => {
            let status = val
                .get("__status")
                .and_then(Value::as_u64)
                .and_then(|code| StatusCode::from_u16(code as u16).ok())
                .unwrap_or(StatusCode::OK);
            if let Some(obj) = val.as_object_mut() {
                obj.remove("__status");
            }
            (status, Json(val)).into_response()
        }
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
        RememberBody, dead_letter_blocked_extraction_memory, normalize_scope, parse_remember_tags,
        parse_visibility, remember, require_session_scope_for_write, resolve_remember_agent,
    };

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
                conn.execute_batch(
                    "ALTER TABLE memories ADD COLUMN agent_id TEXT DEFAULT 'default'",
                )?;
            }
            if !columns.iter().any(|column| column == "visibility") {
                conn.execute_batch(
                    "ALTER TABLE memories ADD COLUMN visibility TEXT DEFAULT 'global'",
                )?;
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
                AuthMode::Local,
                None,
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
                source_path: None,
                runtime_path: None,
                idempotency_key: None,
                metadata: None,
                memory_type: None,
                agent_id: None,
                visibility: None,
                scope: None,
                session_key: None,
                structured: None,
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
                source_path: None,
                runtime_path: None,
                idempotency_key: None,
                metadata: None,
                memory_type: None,
                agent_id: None,
                visibility: None,
                scope: None,
                session_key: None,
                structured: None,
            }),
        )
        .await;

        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
        let body = read_json_body(response).await;
        assert_eq!(body["error"], "Failed to save memory");

        let memories = state
            .pool
            .read(|conn| {
                let row = conn.query_row("SELECT COUNT(*) FROM memories", [], |row| {
                    row.get::<_, i64>(0)
                })?;
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
                        source_path: None,
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
                source_path: None,
                runtime_path: None,
                idempotency_key: None,
                metadata: None,
                memory_type: None,
                agent_id: None,
                visibility: None,
                scope: None,
                session_key: None,
                structured: None,
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

const MAX_FORGET_BATCH: usize = 200;
const FORGET_CONFIRM_THRESHOLD: usize = 25;

#[derive(Debug, Deserialize)]
pub struct ForgetBatchBody {
    pub mode: Option<String>,
    pub ids: Option<Vec<String>>,
    pub query: Option<String>,
    #[serde(rename = "type")]
    pub memory_type: Option<String>,
    pub tags: Option<String>,
    pub who: Option<String>,
    pub source_type: Option<String>,
    pub since: Option<String>,
    pub until: Option<String>,
    pub scope: Option<String>,
    pub limit: Option<usize>,
    pub reason: Option<String>,
    pub force: Option<bool>,
    pub if_version: Option<i64>,
    pub confirm_token: Option<String>,
    pub changed_by: Option<String>,
}

#[derive(Debug, Clone)]
struct ForgetCandidate {
    id: String,
    pinned: i64,
    version: i64,
    score: f64,
}

fn trim_opt(value: Option<String>) -> Option<String> {
    value
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

fn forget_confirm_token(ids: &[String]) -> String {
    let mut unique = ids.to_vec();
    unique.sort();
    unique.dedup();
    let canonical = unique.join("|");
    let digest = Sha256::digest(canonical.as_bytes());
    let hex = digest
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    hex[..32].to_string()
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
            "status": "version_conflict",
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

// ---------------------------------------------------------------------------
// POST /api/memory/forget
// ---------------------------------------------------------------------------

pub async fn forget_batch(
    State(state): State<Arc<AppState>>,
    Json(body): Json<ForgetBatchBody>,
) -> axum::response::Response {
    let mode = trim_opt(body.mode.clone()).unwrap_or_else(|| "preview".to_string());
    if mode != "preview" && mode != "execute" {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "mode must be preview or execute"})),
        )
            .into_response();
    }

    let limit = body.limit.unwrap_or(20).clamp(1, MAX_FORGET_BATCH);
    let ids = body
        .ids
        .unwrap_or_default()
        .into_iter()
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty())
        .collect::<Vec<_>>();
    let query = trim_opt(body.query);
    let memory_type = trim_opt(body.memory_type);
    let tags = trim_opt(body.tags);
    let who = trim_opt(body.who);
    let source_type = trim_opt(body.source_type);
    let since = trim_opt(body.since);
    let until = trim_opt(body.until);
    let scope = body.scope.map(|v| v.trim().to_string());

    let has_query_scope = query.is_some()
        || memory_type.is_some()
        || tags.is_some()
        || who.is_some()
        || source_type.is_some()
        || since.is_some()
        || until.is_some()
        || scope.is_some();
    if ids.is_empty() && !has_query_scope {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": "query, ids, or at least one filter (type/tags/who/source_type/since/until) is required"
            })),
        )
            .into_response();
    }

    let candidates = state
        .pool
        .read(move |conn: &rusqlite::Connection| -> Result<Vec<ForgetCandidate>, CoreError> {
            if !ids.is_empty() {
                let mut deduped = Vec::<String>::new();
                for id in ids.into_iter().take(limit) {
                    if !deduped.contains(&id) {
                        deduped.push(id);
                    }
                }
                if deduped.is_empty() {
                    return Ok(Vec::new());
                }
                let placeholders = std::iter::repeat_n("?", deduped.len()).collect::<Vec<_>>().join(", ");
                let sql = format!(
                    "SELECT id, pinned, version FROM memories WHERE (is_deleted = 0 OR is_deleted IS NULL) AND id IN ({placeholders})"
                );
                let mut stmt = conn.prepare(&sql)?;
                let rows = stmt
                    .query_map(rusqlite::params_from_iter(deduped.iter()), |row| {
                        Ok(ForgetCandidate {
                            id: row.get(0)?,
                            pinned: row.get(1)?,
                            version: row.get(2)?,
                            score: 0.0,
                        })
                    })?
                    .filter_map(|row| row.ok())
                    .collect::<Vec<_>>();
                return Ok(deduped
                    .iter()
                    .filter_map(|id| rows.iter().find(|row| &row.id == id).cloned())
                    .collect());
            }

            let mut clauses = vec!["(is_deleted = 0 OR is_deleted IS NULL)".to_string()];
            let mut args = Vec::<String>::new();
            if let Some(value) = query {
                clauses.push("(content LIKE ? OR tags LIKE ?)".to_string());
                args.push(format!("%{value}%"));
                args.push(format!("%{value}%"));
            }
            if let Some(value) = memory_type {
                clauses.push("type = ?".to_string());
                args.push(value);
            }
            if let Some(value) = tags {
                for tag in value.split(',').map(str::trim).filter(|tag| !tag.is_empty()) {
                    clauses.push("tags LIKE ?".to_string());
                    args.push(format!("%{tag}%"));
                }
            }
            if let Some(value) = who {
                clauses.push("who = ?".to_string());
                args.push(value);
            }
            if let Some(value) = source_type {
                clauses.push("source_type = ?".to_string());
                args.push(value);
            }
            if let Some(value) = scope {
                clauses.push("scope = ?".to_string());
                args.push(value);
            } else {
                clauses.push("scope IS NULL".to_string());
            }
            if let Some(value) = since {
                clauses.push("created_at >= ?".to_string());
                args.push(value);
            }
            if let Some(value) = until {
                clauses.push("created_at <= ?".to_string());
                args.push(value);
            }

            let sql = format!(
                "SELECT id, pinned, version FROM memories WHERE {} ORDER BY pinned DESC, importance DESC, updated_at DESC LIMIT {limit}",
                clauses.join(" AND ")
            );
            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt
                .query_map(rusqlite::params_from_iter(args.iter()), |row| {
                    Ok(ForgetCandidate {
                        id: row.get(0)?,
                        pinned: row.get(1)?,
                        version: row.get(2)?,
                        score: 0.0,
                    })
                })?
                .filter_map(|row| row.ok())
                .collect::<Vec<_>>();
            Ok(rows)
        })
        .await
        .unwrap_or_default();

    let candidate_ids: Vec<String> = candidates.iter().map(|c| c.id.clone()).collect::<Vec<_>>();
    let confirm_token = forget_confirm_token(&candidate_ids);
    let requires_confirm = candidate_ids.len() > FORGET_CONFIRM_THRESHOLD;

    if mode == "preview" {
        return Json(serde_json::json!({
            "mode": "preview",
            "count": candidates.len(),
            "requiresConfirm": requires_confirm,
            "confirmToken": confirm_token,
            "candidates": candidates.iter().map(|c| serde_json::json!({
                "id": c.id,
                "score": (c.score * 1000.0).round() / 1000.0,
                "pinned": c.pinned != 0,
                "version": c.version,
            })).collect::<Vec<_>>()
        }))
        .into_response();
    }

    let Some(reason) = trim_opt(body.reason) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "reason is required for execute mode"})),
        )
            .into_response();
    };
    if body.if_version.is_some() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": "if_version is not supported for batch forget; use DELETE /api/memory/:id for version-guarded deletes"
            })),
        )
            .into_response();
    }
    if requires_confirm && body.confirm_token.as_deref() != Some(confirm_token.as_str()) {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": "confirm_token is required for large forget operations; run preview first",
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

    let force = body.force.unwrap_or(false);
    let actor = trim_opt(body.changed_by).unwrap_or_else(|| "api".to_string());
    let requested = candidate_ids.len();
    let result = state
        .pool
        .write(Priority::High, move |conn| {
            let mut results = Vec::new();
            for id in candidate_ids {
                let tx_result = transactions::forget(
                    conn,
                    &transactions::ForgetInput {
                        id: &id,
                        force,
                        if_version: None,
                        actor: &actor,
                        reason: Some(reason.as_str()),
                        actor_type: None,
                    },
                )?;
                results.push(forget_result_json(id, tx_result));
            }
            Ok(serde_json::Value::Array(results))
        })
        .await;

    match result {
        Ok(results_value) => {
            let results = results_value.as_array().cloned().unwrap_or_default();
            let deleted = results
                .iter()
                .filter(|result| result.get("status").and_then(|v| v.as_str()) == Some("deleted"))
                .count();
            Json(serde_json::json!({
                "mode": "execute",
                "requested": requested,
                "deleted": deleted,
                "results": results,
            }))
            .into_response()
        }
        Err(e) => {
            warn!(err = %e, "batch forget failed");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": "Forget failed"})),
            )
                .into_response()
        }
    }
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
