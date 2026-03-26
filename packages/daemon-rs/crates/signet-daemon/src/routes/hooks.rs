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
use signet_services::session::{ClaimResult, RuntimePath};
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

pub async fn prompt_submit(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<PromptSubmitBody>,
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

    // Extract simple query terms for search
    let terms: Vec<&str> = message
        .split_whitespace()
        .filter(|w| w.len() >= 3)
        .take(12)
        .collect();
    let query_terms = terms.join(" ");

    // Record in continuity tracker
    if let Some(key) = &body.session_key {
        let snippet = if message.len() > 200 {
            &message[..200]
        } else {
            message
        };
        state.continuity.record_prompt(key, &query_terms, snippet);
    }

    // TODO: Phase 5 — full hybrid search, memory injection, predictor scoring,
    // graph traversal, dedup window filtering, budget truncation

    (
        StatusCode::OK,
        Json(serde_json::json!({
            "inject": "",
            "memoryCount": 0,
            "queryTerms": query_terms,
        })),
    )
        .into_response()
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
    let Some(_harness) = body.harness.as_deref() else {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "harness is required"})),
        )
            .into_response();
    };

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

    // TODO: Phase 5 — transcript extraction, summary worker queueing

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
                    agent_id: "default",
                    visibility: "global",
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

#[cfg(test)]
mod tests {
    use super::resolve_compaction_project;

    #[test]
    fn compaction_project_prefers_transcript_lineage() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute(
            "CREATE TABLE session_transcripts (
                session_key TEXT PRIMARY KEY,
                content TEXT NOT NULL,
                harness TEXT,
                project TEXT,
                agent_id TEXT NOT NULL DEFAULT 'default',
                created_at TEXT NOT NULL
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
                session_key TEXT PRIMARY KEY,
                content TEXT NOT NULL,
                harness TEXT,
                project TEXT,
                agent_id TEXT NOT NULL DEFAULT 'default',
                created_at TEXT NOT NULL
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
}
