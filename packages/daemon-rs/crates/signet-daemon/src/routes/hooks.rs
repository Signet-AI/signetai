//! Hook lifecycle route handlers.
//!
//! These implement the core hook endpoints that connectors call during
//! session lifecycle: session-start, prompt-submit, session-end,
//! remember, recall, pre-compaction, and compaction-complete.

use std::sync::Arc;

use axum::Json;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use serde::Deserialize;
use tracing::warn;

use signet_core::db::Priority;
use signet_services::session::{ClaimResult, RuntimePath, SessionTracker};
use signet_services::transactions;

use crate::state::AppState;

// ---------------------------------------------------------------------------
// Helper: extract runtime path from header or body
// ---------------------------------------------------------------------------

fn resolve_runtime_path(headers: &HeaderMap, body_path: Option<&str>) -> Option<RuntimePath> {
    headers
        .get("x-signet-runtime-path")
        .and_then(|v| v.to_str().ok())
        .or(body_path)
        .and_then(RuntimePath::parse)
}

fn conflict_response(claimed_by: RuntimePath) -> axum::response::Response {
    (
        StatusCode::CONFLICT,
        Json(serde_json::json!({
            "error": format!("session claimed by {} path", claimed_by.as_str())
        })),
    )
        .into_response()
}

fn resolve_compaction_project(
    conn: &rusqlite::Connection,
    session_key: Option<&str>,
    agent_id: &str,
    fallback: Option<&str>,
) -> rusqlite::Result<Option<String>> {
    let Some(key) = session_key else {
        return Ok(fallback.map(ToOwned::to_owned));
    };

    let mut stmt = conn.prepare(
        "SELECT project FROM session_transcripts WHERE session_key = ?1 AND agent_id = ?2 LIMIT 1",
    )?;
    let mut rows = stmt.query(rusqlite::params![key, agent_id])?;
    if let Some(row) = rows.next()? {
        return row.get(0);
    }

    Ok(fallback.map(ToOwned::to_owned))
}

fn strip_untrusted_metadata(raw: &str) -> String {
    raw.lines()
        .filter(|line| {
            let trimmed = line.trim_start();
            !trimmed.starts_with("conversation_label:")
                && !trimmed.starts_with("session_label:")
                && !trimmed.starts_with("assistant_context:")
                && !trimmed.starts_with("system_context:")
        })
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
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

fn normalize_agent_id(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn resolve_remember_agent(
    explicit: Option<&str>,
    header: Option<&str>,
    session_key: Option<&str>,
) -> Result<String, &'static str> {
    let explicit_agent = normalize_agent_id(explicit);
    let header_agent = normalize_agent_id(header);
    let bound = session_agent_id(session_key);
    if let Some(bound) = bound.as_deref() {
        if let Some(explicit) = explicit_agent.as_deref()
            && explicit != bound
        {
            return Err("agent_id does not match session scope");
        }
        if let Some(header) = header_agent.as_deref()
            && header != bound
        {
            return Err("x-signet-agent-id does not match session scope");
        }
    }

    Ok(explicit_agent
        .or(header_agent)
        .or(bound)
        .unwrap_or_else(|| "default".to_string()))
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
    let session_agent = session_agent_id(Some(key));
    if session_agent.is_none() {
        return Err("session_key must be agent scoped");
    }
    if sessions.get_path(key).is_none() {
        return Err("session_key is not active");
    }
    if agent_id != "default" && session_agent.as_deref() != Some(agent_id) {
        return Err("agent_id does not match session scope");
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// POST /api/hooks/session-start
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStartBody {
    pub harness: Option<String>,
    pub project: Option<String>,
    pub agent_id: Option<String>,
    #[allow(dead_code)] // Will be used for context-aware injection in Phase 5
    pub context: Option<String>,
    pub session_key: Option<String>,
    pub runtime_path: Option<String>,
}

pub async fn session_start(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<SessionStartBody>,
) -> axum::response::Response {
    let Some(harness) = body.harness.as_deref() else {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "harness is required"})),
        )
            .into_response();
    };
    state.stamp_harness(harness).await;

    let session_key = body
        .session_key
        .clone()
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let path = resolve_runtime_path(&headers, body.runtime_path.as_deref());
    let agent_id = body.agent_id.clone().unwrap_or_else(|| "default".into());

    // Session claim
    if let Some(p) = path
        && let ClaimResult::Conflict { claimed_by } = state.sessions.claim(&session_key, p)
    {
        return conflict_response(claimed_by);
    }

    // Dedup — if session_key was already seen, return minimal stub
    if state.dedup.mark_session_start(&session_key) {
        let now = chrono::Utc::now();
        return (
            StatusCode::OK,
            Json(serde_json::json!({
                "identity": { "name": state.config.manifest.agent.name },
                "memories": [],
                "inject": format!("Current date: {}", now.format("%Y-%m-%d %H:%M")),
                "deduped": true,
            })),
        )
            .into_response();
    }

    // Normalize project path for continuity
    let project_normalized = body
        .project
        .as_ref()
        .map(|p| p.replace('\\', "/").trim_end_matches('/').to_lowercase());

    // Initialize continuity tracking
    let harness_owned = harness.to_string();
    state.continuity.init(
        &session_key,
        &harness_owned,
        body.project.as_deref(),
        project_normalized.as_deref(),
    );

    let identity_name = state.config.manifest.agent.name.clone();
    let identity_desc = state.config.manifest.agent.description.clone();

    // Load recovery checkpoints and build response
    let pn = project_normalized.clone();
    let result = state
        .pool
        .read(move |conn| {
            // Get recovery checkpoints if project exists
            let recovery = if let Some(pn) = &pn {
                signet_services::session::get_recovery_checkpoints(conn, pn, 4).unwrap_or_default()
            } else {
                vec![]
            };

            // Build inject string
            let now = chrono::Utc::now();
            let mut inject = format!("Current date: {}\n", now.format("%Y-%m-%d %H:%M"));

            // Add recovery digest if available
            if let Some(checkpoint) = recovery.first() {
                inject.push_str(&format!("\n[Session Recovery]\n{}\n", checkpoint.digest));
            }

            Ok(serde_json::json!({
                "identity": {
                    "name": identity_name,
                    "description": identity_desc,
                },
                "memories": [],
                "inject": inject,
                "sessionKey": session_key,
                "agentId": agent_id,
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
// POST /api/hooks/user-prompt-submit
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptSubmitBody {
    pub harness: Option<String>,
    #[allow(dead_code)] // Will be used for project-scoped search in Phase 5
    pub project: Option<String>,
    #[allow(dead_code)] // Will be used for multi-agent support in Phase 5
    pub agent_id: Option<String>,
    pub user_message: Option<String>,
    pub user_prompt: Option<String>,
    #[allow(dead_code)] // Will be used for context-aware search in Phase 5
    pub last_assistant_message: Option<String>,
    pub session_key: Option<String>,
    pub runtime_path: Option<String>,
}

fn trim_for_inject(text: &str, limit: usize) -> String {
    let trimmed = text.trim();
    if trimmed.len() <= limit {
        return trimmed.to_string();
    }
    let mut end = limit;
    while !trimmed.is_char_boundary(end) && end > 0 {
        end -= 1;
    }
    format!("{}...", &trimmed[..end])
}

fn escape_like(text: &str) -> String {
    text.replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

fn extract_anchor_terms(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for token in text.to_lowercase().split(|c: char| {
        !c.is_ascii_alphanumeric() && c != '_' && c != ':' && c != '/' && c != '.' && c != '-'
    }) {
        if token.len() < 6 {
            continue;
        }
        let has_digit = token.chars().any(|c| c.is_ascii_digit());
        let has_marker = token.contains('_')
            || token.contains(':')
            || token.contains('/')
            || token.contains('.')
            || token.contains('-');
        if !has_digit && !has_marker && token.len() < 18 {
            continue;
        }
        if seen.insert(token.to_string()) {
            out.push(token.to_string());
            if out.len() >= 8 {
                break;
            }
        }
    }
    out
}

fn format_metadata_header() -> String {
    let now = chrono::Local::now();
    format!(
        "# Current Date & Time\n{} ({})\n",
        now.format("%A, %B %-d, %Y at %-I:%M %p"),
        now.format("%Z")
    )
}

pub async fn prompt_submit(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<PromptSubmitBody>,
) -> axum::response::Response {
    let Some(harness) = body.harness.as_deref() else {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "harness is required"})),
        )
            .into_response();
    };
    state.stamp_harness(harness).await;

    let path = resolve_runtime_path(&headers, body.runtime_path.as_deref());

    // Session conflict check
    if let (Some(key), Some(p)) = (&body.session_key, path)
        && let Some(claimed_by) = state.sessions.check(key, p)
    {
        return conflict_response(claimed_by);
    }

    // Check bypass
    if let Some(key) = &body.session_key
        && state.sessions.is_bypassed(key)
    {
        return (
            StatusCode::OK,
            Json(serde_json::json!({
                "inject": "",
                "memoryCount": 0,
            })),
        )
            .into_response();
    }

    // Extract the user message (prefer userMessage over userPrompt)
    let message = body
        .user_message
        .as_deref()
        .or(body.user_prompt.as_deref())
        .unwrap_or("");
    let cleaned = strip_untrusted_metadata(message);

    // Extract simple query terms for search
    let terms: Vec<&str> = cleaned
        .split_whitespace()
        .filter(|w| w.len() >= 3)
        .take(12)
        .collect();
    let query_terms = terms.join(" ");
    let metadata_header = format_metadata_header();

    // Record in continuity tracker
    if let Some(key) = &body.session_key {
        let snippet = if cleaned.len() > 200 {
            &cleaned[..200]
        } else {
            cleaned.as_str()
        };
        state.continuity.record_prompt(key, &query_terms, snippet);
    }

    if query_terms.is_empty() {
        return (
            StatusCode::OK,
            Json(serde_json::json!({
                "inject": metadata_header,
                "memoryCount": 0,
                "queryTerms": query_terms,
            })),
        )
            .into_response();
    }

    let project = body.project.clone();
    let session_key = body.session_key.clone();
    let agent_id = body
        .agent_id
        .clone()
        .unwrap_or_else(|| "default".to_string());
    let query_terms_for_resp = query_terms.clone();

    let result = state
        .pool
        .read(move |conn| {
            let mut terms = query_terms
                .split_whitespace()
                .map(str::to_string)
                .collect::<Vec<_>>();
            if terms.is_empty() {
                terms.push(cleaned.clone());
            }
            let needles = terms
                .iter()
                .take(6)
                .map(|t| t.to_lowercase())
                .collect::<Vec<_>>();
            let like_patterns = needles
                .iter()
                .map(|t| format!("%{}%", escape_like(&t.to_lowercase())))
                .collect::<Vec<_>>();

            // 1) Structured recall from memories (best effort parity with TS hybrid-first path).
            let mut mem_sql = String::from(
                "SELECT id, content, created_at
                 FROM memories
                 WHERE deleted = 0",
            );
            let mut mem_params: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
            let read_policy: String = conn
                .query_row(
                    "SELECT read_policy FROM agents WHERE id = ?1",
                    rusqlite::params![agent_id.clone()],
                    |row| row.get(0),
                )
                .unwrap_or_else(|_| "isolated".to_string());
            match read_policy.as_str() {
                "shared" => {
                    mem_sql.push_str(" AND (visibility = 'global' OR agent_id = ?) AND visibility != 'archived'");
                    mem_params.push(Box::new(agent_id.clone()));
                }
                "group" => {
                    let group: Option<String> = conn
                        .query_row(
                            "SELECT policy_group FROM agents WHERE id = ?1",
                            rusqlite::params![agent_id.clone()],
                            |row| row.get(0),
                        )
                        .ok()
                        .flatten();
                    if let Some(g) = group {
                        mem_sql.push_str(
                            " AND ((visibility = 'global' AND agent_id IN (SELECT id FROM agents WHERE policy_group = ?)) OR agent_id = ?) AND visibility != 'archived'",
                        );
                        mem_params.push(Box::new(g));
                        mem_params.push(Box::new(agent_id.clone()));
                    } else {
                        mem_sql.push_str(" AND agent_id = ? AND visibility != 'archived'");
                        mem_params.push(Box::new(agent_id.clone()));
                    }
                }
                _ => {
                    mem_sql.push_str(" AND agent_id = ? AND visibility != 'archived'");
                    mem_params.push(Box::new(agent_id.clone()));
                }
            }
            if let Some(ref p) = project {
                mem_sql.push_str(" AND project = ?");
                mem_params.push(Box::new(p.clone()));
            }
            if !like_patterns.is_empty() {
                let clauses = like_patterns
                    .iter()
                    .map(|_| "LOWER(content) LIKE ? ESCAPE '\\'")
                    .collect::<Vec<_>>()
                    .join(" OR ");
                mem_sql.push_str(" AND (");
                mem_sql.push_str(&clauses);
                mem_sql.push(')');
                for pat in &like_patterns {
                    mem_params.push(Box::new(pat.clone()));
                }
            }
            mem_sql.push_str(" ORDER BY importance DESC, created_at DESC LIMIT 5");
            let mem_param_refs: Vec<&dyn rusqlite::types::ToSql> =
                mem_params.iter().map(|p| p.as_ref()).collect();
            let mem_rows = match conn.prepare(&mem_sql) {
                Ok(mut stmt) => stmt
                    .query_map(mem_param_refs.as_slice(), |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                        ))
                    })
                    .ok()
                    .map(|rows| rows.filter_map(|r| r.ok()).collect::<Vec<_>>())
                    .unwrap_or_default(),
                Err(_) => vec![],
            };

            let anchors = extract_anchor_terms(&cleaned);
            let anchor_missed = !anchors.is_empty()
                && !mem_rows
                    .iter()
                    .take(8)
                    .map(|(_, content, _)| content.to_lowercase())
                    .any(|content| anchors.iter().any(|anchor| content.contains(anchor)));

            if !mem_rows.is_empty() && !anchor_missed {
                let lines = mem_rows
                    .iter()
                    .map(|(_, content, created_at)| {
                        format!("- {} ({})", trim_for_inject(content, 300), created_at)
                    })
                    .collect::<Vec<_>>();
                return Ok(serde_json::json!({
                    "inject": format!(
                        "{}\n[signet:recall | query=\"{}\" | results={} | engine=hybrid]\n{}",
                        metadata_header,
                        query_terms_for_resp,
                        lines.len(),
                        lines.join("\n")
                    ),
                    "memoryCount": lines.len(),
                    "queryTerms": query_terms_for_resp,
                    "engine": "hybrid",
                }));
            }

            // 2) Temporal fallback from persisted thread heads.
            if let Ok(mut stmt) = conn.prepare(
                "SELECT node_id, sample, latest_at, label, project
                 FROM memory_thread_heads
                 WHERE agent_id = ?1
                 ORDER BY latest_at DESC LIMIT 24",
            ) {
                let rows = stmt
                    .query_map([agent_id.clone()], |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, String>(3)?,
                            row.get::<_, Option<String>>(4)?,
                        ))
                    })
                    .ok()
                    .map(|rows| rows.filter_map(|r| r.ok()).collect::<Vec<_>>())
                    .unwrap_or_default();

                let mut picked = Vec::new();
                for (id, sample, latest_at, label, row_project) in rows {
                    let lower = sample.to_lowercase();
                    if !needles.iter().any(|needle| !needle.is_empty() && lower.contains(needle)) {
                        continue;
                    }
                    if let Some(ref want) = project {
                        if row_project.as_deref() != Some(want.as_str()) {
                            continue;
                        }
                    }
                    picked.push(format!(
                        "- [node {}] {} ({}, {})",
                        id,
                        trim_for_inject(&sample, 280),
                        latest_at,
                        label
                    ));
                    if picked.len() >= 4 {
                        break;
                    }
                }
                if !picked.is_empty() {
                    return Ok(serde_json::json!({
                        "inject": format!(
                            "{}\n[signet:recall | query=\"{}\" | results={} | engine=temporal-fallback]\n{}",
                            metadata_header,
                            query_terms_for_resp,
                            picked.len(),
                            picked.join("\n")
                        ),
                        "memoryCount": picked.len(),
                        "queryTerms": query_terms_for_resp,
                        "engine": "temporal-fallback",
                    }));
                }
            }

            // 3) Transcript fallback.
            let mut tx_sql = String::from(
                "SELECT session_key, content, updated_at, project
                 FROM session_transcripts
                 WHERE agent_id = ?",
            );
            let mut tx_params: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
            tx_params.push(Box::new(agent_id.clone()));
            if let Some(ref p) = project {
                tx_sql.push_str(" AND project = ?");
                tx_params.push(Box::new(p.clone()));
            }
            if let Some(ref sk) = session_key {
                // Prefer other sessions first, but still allow this session if it is all we have.
                tx_sql.push_str(" ORDER BY (session_key = ?) ASC, updated_at DESC LIMIT 6");
                tx_params.push(Box::new(sk.clone()));
            } else {
                tx_sql.push_str(" ORDER BY updated_at DESC LIMIT 6");
            }
            let tx_param_refs: Vec<&dyn rusqlite::types::ToSql> =
                tx_params.iter().map(|p| p.as_ref()).collect();
            let tx_rows = match conn.prepare(&tx_sql) {
                Ok(mut stmt) => stmt
                    .query_map(tx_param_refs.as_slice(), |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, Option<String>>(2)?,
                        ))
                    })
                    .ok()
                    .map(|rows| rows.filter_map(|r| r.ok()).collect::<Vec<_>>())
                    .unwrap_or_default(),
                Err(_) => vec![],
            };

            let mut tx_lines = Vec::new();
            for (sk, content, updated_at) in tx_rows {
                let lower = content.to_lowercase();
                if !needles.iter().any(|needle| !needle.is_empty() && lower.contains(needle)) {
                    continue;
                }
                let excerpt = trim_for_inject(&content, 260);
                tx_lines.push(format!(
                    "- {} ({}, session {})",
                    excerpt,
                    updated_at.unwrap_or_else(|| "unknown".to_string()),
                    sk
                ));
                if tx_lines.len() >= 3 {
                    break;
                }
            }
            if !tx_lines.is_empty() {
                return Ok(serde_json::json!({
                    "inject": format!(
                        "{}\n[signet:recall | query=\"{}\" | results={} | engine=transcript-fallback]\n{}",
                        metadata_header,
                        query_terms_for_resp,
                        tx_lines.len(),
                        tx_lines.join("\n")
                    ),
                    "memoryCount": tx_lines.len(),
                    "queryTerms": query_terms_for_resp,
                    "engine": "transcript-fallback",
                }));
            }

            Ok(serde_json::json!({
                "inject": metadata_header,
                "memoryCount": 0,
                "queryTerms": query_terms_for_resp,
            }))
        })
        .await;

    return match result {
        Ok(val) => (StatusCode::OK, Json(val)).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e.to_string()})),
        )
            .into_response(),
    };
}

// ---------------------------------------------------------------------------
// POST /api/hooks/session-end
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionEndBody {
    pub harness: Option<String>,
    #[allow(dead_code)] // Will be used for transcript extraction in Phase 5
    pub transcript_path: Option<String>,
    pub session_id: Option<String>,
    pub session_key: Option<String>,
    #[allow(dead_code)] // Will be used for project resolution in Phase 5
    pub cwd: Option<String>,
    pub reason: Option<String>,
    pub runtime_path: Option<String>,
}

pub async fn session_end(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<SessionEndBody>,
) -> axum::response::Response {
    let Some(harness) = body.harness.as_deref() else {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "harness is required"})),
        )
            .into_response();
    };
    state.stamp_harness(harness).await;

    // Resolve session key (sessionKey preferred, sessionId as fallback)
    let session_key = body
        .session_key
        .as_deref()
        .or(body.session_id.as_deref())
        .unwrap_or("");
    let path = resolve_runtime_path(&headers, body.runtime_path.as_deref());

    // Session conflict check (still release even if conflict)
    if let Some(p) = path
        && let Some(claimed_by) = state.sessions.check(session_key, p)
    {
        // Release and return conflict
        state.sessions.release(session_key);
        state.continuity.clear(session_key);
        state.dedup.clear_session_start(session_key);
        state.dedup.clear(session_key);
        return conflict_response(claimed_by);
    }

    // Write final checkpoint if we have continuity state
    let is_clear = body.reason.as_deref() == Some("clear");
    let sk = session_key.to_string();

    if !is_clear && let Some(snapshot) = state.continuity.consume(session_key) {
        let _ = state
            .pool
            .write(Priority::High, move |conn| {
                signet_services::session::insert_checkpoint(
                    conn,
                    &snapshot,
                    "session_end",
                    "Session ended",
                )?;
                Ok(serde_json::Value::Null)
            })
            .await;
    }

    // Always release session state
    state.sessions.release(&sk);
    state.continuity.clear(&sk);
    state.dedup.clear_session_start(&sk);
    state.dedup.clear(&sk);

    // NOTE: transcript extraction enqueue is not implemented in daemon-rs yet
    // (Phase 5). This route currently performs checkpoint/session cleanup only.
    // When transcript extraction is added here, it MUST check
    // state.is_extraction_blocked() and dead-letter blocked work.

    (
        StatusCode::OK,
        Json(serde_json::json!({
            "memoriesSaved": 0,
            "queued": false,
        })),
    )
        .into_response()
}

// ---------------------------------------------------------------------------
// POST /api/hooks/remember
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HookRememberBody {
    pub harness: Option<String>,
    pub who: Option<String>,
    pub project: Option<String>,
    pub content: Option<String>,
    pub session_key: Option<String>,
    pub idempotency_key: Option<String>,
    pub runtime_path: Option<String>,
    pub agent_id: Option<String>,
    pub visibility: Option<String>,
    pub scope: Option<String>,
}

pub async fn remember(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<HookRememberBody>,
) -> axum::response::Response {
    let Some(_harness) = body.harness.as_deref() else {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "harness is required"})),
        )
            .into_response();
    };

    let content = body.content.as_deref().unwrap_or("").trim();
    if content.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "content is required"})),
        )
            .into_response();
    }

    let path = resolve_runtime_path(&headers, body.runtime_path.as_deref());

    // Session conflict check
    if let (Some(key), Some(p)) = (&body.session_key, path)
        && let Some(claimed_by) = state.sessions.check(key, p)
    {
        return conflict_response(claimed_by);
    }

    // Parse "critical:" prefix — pins memory and sets importance to 1.0
    let (content, importance, pinned) = if let Some(rest) = content.strip_prefix("critical:") {
        (rest.trim().to_string(), 1.0, true)
    } else {
        (content.to_string(), 0.5, false)
    };

    // Parse "[tag1,tag2]:" prefix for tags
    let (content, tags) = if content.starts_with('[') {
        if let Some(bracket_end) = content.find("]:") {
            let tag_str = &content[1..bracket_end];
            let tags: Vec<String> = tag_str.split(',').map(|s| s.trim().to_string()).collect();
            let rest = content[bracket_end + 2..].trim().to_string();
            (rest, tags)
        } else {
            (content, vec![])
        }
    } else {
        (content, vec![])
    };

    let who = body.who.clone();
    let project = body.project.clone();
    let idempotency_key = body.idempotency_key.clone();
    let runtime_path_str = path.map(|p| p.as_str().to_string());
    let session_key = body.session_key.clone();
    let agent_id = match resolve_remember_agent(
        body.agent_id.as_deref(),
        headers
            .get("x-signet-agent-id")
            .and_then(|v| v.to_str().ok()),
        session_key.as_deref(),
    ) {
        Ok(id) => id,
        Err(err) => {
            return (
                StatusCode::FORBIDDEN,
                Json(serde_json::json!({ "error": err })),
            )
                .into_response();
        }
    };
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
    let scope = body
        .scope
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
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

    // Record in continuity tracker
    if let Some(key) = &session_key {
        state.continuity.record_remember(key, &content);
    }

    let result = state
        .pool
        .write(Priority::High, move |conn| {
            let r = transactions::ingest(
                conn,
                &transactions::IngestInput {
                    content: &content,
                    memory_type: "fact",
                    tags,
                    who: who.as_deref(),
                    why: None,
                    project: project.as_deref(),
                    importance,
                    pinned,
                    source_type: Some("hook"),
                    source_id: None,
                    idempotency_key: idempotency_key.as_deref(),
                    runtime_path: runtime_path_str.as_deref(),
                    actor: "hook",
                    agent_id: &agent_id,
                    visibility: &visibility,
                    scope: scope.as_deref(),
                },
            )?;

            Ok(serde_json::json!({
                "saved": true,
                "id": r.id,
            }))
        })
        .await;

    match result {
        Ok(val) => (StatusCode::OK, Json(val)).into_response(),
        Err(e) => {
            warn!(err = %e, "hook remember failed");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": "Failed to save memory"})),
            )
                .into_response()
        }
    }
}

// ---------------------------------------------------------------------------
// POST /api/hooks/recall
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HookRecallBody {
    pub harness: Option<String>,
    pub query: Option<String>,
    pub project: Option<String>,
    pub limit: Option<usize>,
    pub session_key: Option<String>,
    pub runtime_path: Option<String>,
}

pub async fn recall(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<HookRecallBody>,
) -> axum::response::Response {
    let Some(_harness) = body.harness.as_deref() else {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "harness is required"})),
        )
            .into_response();
    };

    let Some(query) = body.query.as_deref() else {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "query is required"})),
        )
            .into_response();
    };

    let path = resolve_runtime_path(&headers, body.runtime_path.as_deref());

    // Session conflict check
    if let (Some(key), Some(p)) = (&body.session_key, path)
        && let Some(claimed_by) = state.sessions.check(key, p)
    {
        return conflict_response(claimed_by);
    }

    let limit = body.limit.unwrap_or(10).min(50);
    let query = query.to_string();
    let project = body.project.clone();

    let result = state
        .pool
        .read(move |conn| {
            // FTS search
            let mut sql = String::from(
                "SELECT id, content, type, importance, tags, created_at FROM memories
                 WHERE deleted = 0",
            );
            let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

            if let Some(ref p) = project {
                sql.push_str(" AND project = ?");
                params.push(Box::new(p.clone()));
            }

            // Try FTS match
            sql.push_str(" AND id IN (SELECT rowid FROM memories_fts WHERE memories_fts MATCH ?)");
            params.push(Box::new(query.clone()));

            sql.push_str(" ORDER BY importance DESC LIMIT ?");
            params.push(Box::new(limit as i64));

            let param_refs: Vec<&dyn rusqlite::types::ToSql> =
                params.iter().map(|p| p.as_ref()).collect();

            let results = match conn.prepare(&sql) {
                Ok(mut stmt) => {
                    let rows = stmt.query_map(param_refs.as_slice(), |row| {
                        Ok(serde_json::json!({
                            "id": row.get::<_, String>(0)?,
                            "content": row.get::<_, String>(1)?,
                            "type": row.get::<_, String>(2)?,
                            "importance": row.get::<_, f64>(3)?,
                            "tags": row.get::<_, Option<String>>(4)?,
                            "created_at": row.get::<_, String>(5)?,
                        }))
                    });
                    match rows {
                        Ok(rows) => rows.filter_map(|r| r.ok()).collect::<Vec<_>>(),
                        Err(_) => vec![],
                    }
                }
                Err(_) => vec![],
            };

            let count = results.len();
            Ok(serde_json::json!({
                "results": results,
                "count": count,
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
// POST /api/hooks/pre-compaction
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreCompactionBody {
    pub harness: Option<String>,
    #[allow(dead_code)] // Will be used for context-aware summaries in Phase 5
    pub session_context: Option<String>,
    #[allow(dead_code)] // Will be used for budget calculation in Phase 5
    pub message_count: Option<u32>,
    pub session_key: Option<String>,
    pub runtime_path: Option<String>,
}

pub async fn pre_compaction(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<PreCompactionBody>,
) -> axum::response::Response {
    let Some(_harness) = body.harness.as_deref() else {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "harness is required"})),
        )
            .into_response();
    };

    let path = resolve_runtime_path(&headers, body.runtime_path.as_deref());

    // Session conflict check
    if let (Some(key), Some(p)) = (&body.session_key, path)
        && let Some(claimed_by) = state.sessions.check(key, p)
    {
        return conflict_response(claimed_by);
    }

    // Write pre-compaction checkpoint
    if let Some(key) = &body.session_key
        && let Some(snapshot) = state.continuity.consume(key)
    {
        let _ = state
            .pool
            .write(Priority::High, move |conn| {
                signet_services::session::insert_checkpoint(
                    conn,
                    &snapshot,
                    "pre_compaction",
                    "Context compaction triggered",
                )?;
                Ok(serde_json::Value::Null)
            })
            .await;
    }

    // Build summary prompt and guidelines
    let guidelines = "Preserve key decisions, action items, and context. \
         Omit routine exchanges and redundant details."
        .to_string();

    let prompt = format!(
        "You are about to lose context due to window overflow. \
         Summarize the conversation so far, focusing on:\n\
         1. Key decisions made\n\
         2. Outstanding tasks and action items\n\
         3. Important context that should survive compaction\n\n\
         Guidelines: {guidelines}"
    );

    (
        StatusCode::OK,
        Json(serde_json::json!({
            "summaryPrompt": prompt,
            "guidelines": guidelines,
        })),
    )
        .into_response()
}

// ---------------------------------------------------------------------------
// POST /api/hooks/compaction-complete
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompactionCompleteBody {
    pub harness: Option<String>,
    pub summary: Option<String>,
    pub session_key: Option<String>,
    pub project: Option<String>,
    pub agent_id: Option<String>,
    pub runtime_path: Option<String>,
}

pub async fn compaction_complete(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<CompactionCompleteBody>,
) -> axum::response::Response {
    let Some(_harness) = body.harness.as_deref() else {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "harness is required"})),
        )
            .into_response();
    };

    let Some(summary) = body.summary.as_deref() else {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "summary is required"})),
        )
            .into_response();
    };

    let path = resolve_runtime_path(&headers, body.runtime_path.as_deref());

    // Session conflict check
    if let (Some(key), Some(p)) = (&body.session_key, path)
        && let Some(claimed_by) = state.sessions.check(key, p)
    {
        return conflict_response(claimed_by);
    }

    // Reset prompt dedup so memories can be re-injected after compaction
    if let Some(key) = &body.session_key {
        state.dedup.reset_prompt_dedup(key);
    }

    // Save summary as session_summary memory
    let summary = summary.to_string();
    let harness = body.harness.clone().unwrap_or_default();
    let fallback_project = body.project.clone();
    let agent_id = body.agent_id.clone().unwrap_or_else(|| "default".into());
    // Compaction resets the message array to a short post-compaction summary.
    // Clear the stored transcript and extract cursor so the next checkpoint
    // fires from byte 0 instead of skipping because the pre-compaction cursor
    // exceeds the new (shorter) transcript. Mirrors the TS daemon behaviour
    // added in the same PR. Non-fatal on failure (tables may not exist yet).
    if let Some(key) = &body.session_key {
        let sk = key.clone();
        let aid = agent_id.clone();
        let _ = state
            .pool
            .write(Priority::Low, move |conn| {
                let _ = conn.execute(
                    "DELETE FROM session_transcripts WHERE session_key = ?1 AND agent_id = ?2",
                    rusqlite::params![sk, aid],
                );
                let _ = conn.execute(
                    "DELETE FROM session_extract_cursors WHERE session_key = ?1 AND agent_id = ?2",
                    rusqlite::params![sk, aid],
                );
                Ok(serde_json::Value::Null)
            })
            .await;
    }
    let session_key = body.session_key.clone();
    let result = state
        .pool
        .write(Priority::High, move |conn| {
            let project = resolve_compaction_project(
                conn,
                session_key.as_deref(),
                &agent_id,
                fallback_project.as_deref(),
            )?;
            let r = transactions::ingest(
                conn,
                &transactions::IngestInput {
                    content: &summary,
                    memory_type: "session_summary",
                    tags: vec!["session".into(), "summary".into(), harness.clone()],
                    who: None,
                    why: Some("compaction"),
                    project: project.as_deref(),
                    importance: 0.3,
                    pinned: false,
                    source_type: Some("compaction"),
                    source_id: session_key.as_deref(),
                    idempotency_key: None,
                    runtime_path: None,
                    actor: "compaction",
                    agent_id: &agent_id,
                    visibility: "global",
                    scope: None,
                },
            )?;

            Ok(serde_json::json!({
                "success": true,
                "memoryId": r.id,
            }))
        })
        .await;

    match result {
        Ok(val) => (StatusCode::OK, Json(val)).into_response(),
        Err(e) => {
            warn!(err = %e, "compaction-complete failed");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": e.to_string()})),
            )
                .into_response()
        }
    }
}

// ---------------------------------------------------------------------------
// POST /api/hooks/session-checkpoint-extract
//
// Mid-session delta extraction for long-lived sessions (Discord bots, etc.)
// that never call session-end. Reads the stored session transcript, computes
// the delta since the last extraction cursor, and advances the cursor when
// the delta is large enough.
//
// Summary job enqueuing is Phase 5 (same as session_end's TODO comment).
// Until then this returns {queued: false} when a delta was found, mirroring
// how session_end writes a checkpoint but defers async extraction.
// ---------------------------------------------------------------------------

const CHECKPOINT_MIN_DELTA: usize = 500;

/// Returns the transcript slice starting at `cursor`, or None if the
/// delta is absent or below the minimum size threshold.
fn extract_delta<'a>(full: &'a str, cursor: i64) -> Option<&'a str> {
    let mut start = cursor.max(0) as usize;
    if start >= full.len() {
        return None;
    }
    // Snap to next char boundary if the cursor landed mid-char (multi-byte
    // UTF-8). Prefers re-extracting a few bytes over panicking or silently
    // skipping a checkpoint.
    if !full.is_char_boundary(start) {
        start = (start + 1..=full.len())
            .find(|&i| full.is_char_boundary(i))
            .unwrap_or(full.len());
    }
    let delta = &full[start..];
    if delta.len() < CHECKPOINT_MIN_DELTA {
        None
    } else {
        Some(delta)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointExtractBody {
    #[allow(dead_code)] // accepted for API compat; used for harness stamping in Phase 5
    pub harness: Option<String>,
    pub session_key: Option<String>,
    pub agent_id: Option<String>,
    #[allow(dead_code)] // used for project resolution in Phase 5
    pub project: Option<String>,
    // Inline transcript (takes precedence over stored transcript).
    pub transcript: Option<String>,
    #[allow(dead_code)] // Phase 5: read from path when no stored transcript
    pub transcript_path: Option<String>,
    pub runtime_path: Option<String>,
}

pub async fn session_checkpoint_extract(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<CheckpointExtractBody>,
) -> axum::response::Response {
    // Both harness and sessionKey are required — matches TS daemon validation
    // and the contract documented in docs/API.md.
    let Some(_harness) = body.harness.as_deref() else {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "harness is required"})),
        )
            .into_response();
    };
    let Some(session_key) = body.session_key.clone() else {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "sessionKey is required"})),
        )
            .into_response();
    };

    let path = resolve_runtime_path(&headers, body.runtime_path.as_deref());

    // Session conflict check — only extract for the claiming runtime path.
    if let Some(p) = path
        && let Some(claimed_by) = state.sessions.check(&session_key, p)
    {
        return conflict_response(claimed_by);
    }

    // Honor bypass — consistent with other hook routes and the TS daemon.
    if state.sessions.is_bypassed(&session_key) {
        return (StatusCode::OK, Json(serde_json::json!({"skipped": true}))).into_response();
    }

    // Refresh session TTL — keeps long-lived sessions (Discord bots) alive
    // without ending the claim. Mirrors TS daemon renewSession() call on
    // this route. Non-fatal: sessions without an active claim are a no-op.
    state.sessions.renew(&session_key);

    // Resolve agent_id: explicit value > "agent:{id}:..." session-key parse > "default".
    // Mirrors TS resolveAgentId(sessionKey) so multi-agent checkpoints scope correctly.
    let agent_id = normalize_agent_id(body.agent_id.as_deref())
        .or_else(|| session_agent_id(Some(&session_key)))
        .unwrap_or_else(|| "default".to_string());
    let inline = body.transcript.clone();
    // transcript_path is trusted the same way as in session_end — OpenClaw
    // session files may be anywhere (project dirs, /tmp, containers). Auth
    // middleware provides network-level protection. Mirrors TS daemon behavior.
    let tpath = body.transcript_path.clone();
    let sk = session_key.clone();
    let aid = agent_id.clone();

    let result = state
        .pool
        .write(Priority::Low, move |conn| {
            // Read current extraction cursor.
            let cursor: i64 = conn
                .query_row(
                    "SELECT last_offset FROM session_extract_cursors \
                     WHERE session_key = ?1 AND agent_id = ?2",
                    rusqlite::params![sk, aid],
                    |row| row.get(0),
                )
                .unwrap_or(0);

            // Resolve transcript: inline body → transcript_path file → stored.
            // Mirrors the TS daemon priority order. Always filter by agent_id.
            let full = inline
                .or_else(|| {
                    tpath
                        .as_deref()
                        .and_then(|p| std::fs::read_to_string(p).ok())
                })
                .or_else(|| {
                    conn.query_row(
                        "SELECT content FROM session_transcripts \
                         WHERE session_key = ?1 AND agent_id = ?2",
                        rusqlite::params![sk, aid],
                        |row| row.get::<_, String>(0),
                    )
                    .ok()
                });

            let Some(full) = full else {
                return Ok(serde_json::json!({"skipped": true}));
            };

            if extract_delta(&full, cursor).is_none() {
                return Ok(serde_json::json!({"skipped": true}));
            }

            // Cursor advance deferred to Phase 5 (same as session_end TODO).
            // Advancing without a summary job would permanently discard the
            // delta. Return {queued: false} — a documented response meaning
            // "delta was found but no job was enqueued this time". Callers
            // treat this identically to {skipped: true} for retry purposes.
            // TODO: Phase 5 — enqueue summary job, then advance cursor.
            Ok(serde_json::json!({"queued": false}))
        })
        .await;

    match result {
        Ok(val) => (StatusCode::OK, Json(val)).into_response(),
        Err(e) => {
            warn!(err = %e, "session-checkpoint-extract failed");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": e.to_string()})),
            )
                .into_response()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        CHECKPOINT_MIN_DELTA, extract_delta, parse_visibility, require_session_scope_for_write,
        resolve_compaction_project, resolve_remember_agent, session_agent_id,
        strip_untrusted_metadata,
    };
    use signet_services::session::{RuntimePath, SessionTracker};

    #[test]
    fn session_agent_id_parses_agent_session_keys() {
        assert_eq!(
            session_agent_id(Some("agent:alpha:sess-1")).as_deref(),
            Some("alpha")
        );
        assert_eq!(session_agent_id(Some("session:sess-1")), None);
    }

    #[test]
    fn resolve_remember_agent_rejects_session_scope_mismatch() {
        let err = resolve_remember_agent(Some("agent-b"), None, Some("agent:agent-a:sess-1"))
            .unwrap_err();
        assert_eq!(err, "agent_id does not match session scope");
    }

    #[test]
    fn resolve_remember_agent_binds_to_session_scope() {
        let agent = resolve_remember_agent(
            Some("agent-a"),
            Some("agent-a"),
            Some("agent:agent-a:sess-1"),
        )
        .unwrap();
        assert_eq!(agent, "agent-a");
    }

    #[test]
    fn resolve_remember_agent_inherits_session_scope_when_agent_missing() {
        let agent = resolve_remember_agent(None, None, Some("agent:agent-a:sess-1")).unwrap();
        assert_eq!(agent, "agent-a");
    }

    #[test]
    fn require_session_scope_for_write_blocks_unscoped_overrides() {
        let sessions = SessionTracker::new();
        let err = require_session_scope_for_write(&sessions, "agent-a", "global", None, None)
            .unwrap_err();
        assert_eq!(
            err,
            "non-default agent_id requires session_key with agent scope"
        );

        let err = require_session_scope_for_write(&sessions, "default", "private", None, None)
            .unwrap_err();
        assert_eq!(
            err,
            "non-default visibility/scope requires session_key with agent scope"
        );
    }

    #[test]
    fn require_session_scope_for_write_requires_active_agent_session() {
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
            sessions.claim("agent:agent-a:sess-1", RuntimePath::Plugin),
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
    fn parse_visibility_rejects_invalid_values() {
        assert_eq!(parse_visibility(None).unwrap(), "global");
        assert_eq!(parse_visibility(Some("archived")).unwrap(), "archived");
        assert!(parse_visibility(Some("invalid")).is_err());
    }

    #[test]
    fn compaction_project_prefers_transcript_lineage() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute(
            "CREATE TABLE session_transcripts (
                session_key TEXT NOT NULL,
                agent_id    TEXT NOT NULL DEFAULT 'default',
                content     TEXT NOT NULL,
                harness     TEXT,
                project     TEXT,
                created_at  TEXT NOT NULL,
                PRIMARY KEY (session_key, agent_id)
            )",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO session_transcripts (session_key, content, harness, project, agent_id, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![
                "sess-1",
                "compaction transcript",
                "codex",
                "proj-transcript",
                "agent-a",
                "2026-03-25T00:00:00Z"
            ],
        )
        .unwrap();

        let project =
            resolve_compaction_project(&conn, Some("sess-1"), "agent-a", Some("proj-fallback"))
                .unwrap();

        assert_eq!(project.as_deref(), Some("proj-transcript"));
    }

    #[test]
    fn compaction_project_falls_back_to_request_project() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute(
            "CREATE TABLE session_transcripts (
                session_key TEXT NOT NULL,
                agent_id    TEXT NOT NULL DEFAULT 'default',
                content     TEXT NOT NULL,
                harness     TEXT,
                project     TEXT,
                created_at  TEXT NOT NULL,
                PRIMARY KEY (session_key, agent_id)
            )",
            [],
        )
        .unwrap();

        let project = resolve_compaction_project(
            &conn,
            Some("sess-missing"),
            "agent-a",
            Some("proj-fallback"),
        )
        .unwrap();

        assert_eq!(project.as_deref(), Some("proj-fallback"));
    }

    #[test]
    fn extract_delta_skips_when_small() {
        let short = "a".repeat(CHECKPOINT_MIN_DELTA - 1);
        assert!(extract_delta(&short, 0).is_none());
    }

    #[test]
    fn extract_delta_returns_slice_when_large_enough() {
        let full = "a".repeat(CHECKPOINT_MIN_DELTA + 10);
        let delta = extract_delta(&full, 0).unwrap();
        assert_eq!(delta.len(), full.len());
    }

    #[test]
    fn extract_delta_uses_cursor_offset() {
        let prefix = "x".repeat(100);
        let suffix = "y".repeat(CHECKPOINT_MIN_DELTA + 1);
        let full = format!("{prefix}{suffix}");
        let delta = extract_delta(&full, 100).unwrap();
        assert_eq!(delta, suffix.as_str());
    }

    #[test]
    fn extract_delta_skips_when_cursor_at_end() {
        let full = "a".repeat(CHECKPOINT_MIN_DELTA + 100);
        let cursor = full.len() as i64;
        assert!(extract_delta(&full, cursor).is_none());
    }

    #[test]
    fn extract_delta_skips_when_cursor_past_end() {
        let full = "a".repeat(CHECKPOINT_MIN_DELTA);
        assert!(extract_delta(&full, (full.len() + 1) as i64).is_none());
    }

    #[test]
    fn extract_delta_snaps_past_mid_char_cursor() {
        // "🦀" is 4 bytes. A cursor landing at byte 1, 2, or 3 is mid-char.
        // Snap should move forward to byte 4 (start of the suffix).
        let suffix = "a".repeat(CHECKPOINT_MIN_DELTA + 50);
        let full = format!("🦀{suffix}"); // 🦀 occupies bytes 0-3
        // cursor at byte 1 (inside the crab emoji) — must not panic.
        let delta = extract_delta(&full, 1);
        assert!(
            delta.is_some(),
            "should snap to byte 4 and return the suffix"
        );
        assert_eq!(delta.unwrap().len(), suffix.len());
    }

    #[test]
    fn strip_untrusted_metadata_removes_envelope_lines() {
        let cleaned = strip_untrusted_metadata(
            "conversation_label: ops\nassistant_context: ignore this\nwhat changed in tier2",
        );
        assert_eq!(cleaned, "what changed in tier2");
    }
}
