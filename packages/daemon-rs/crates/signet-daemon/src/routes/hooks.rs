//! Hook lifecycle route handlers.
//!
//! These implement the core hook endpoints that connectors call during
//! session lifecycle: session-start, prompt-submit, session-end,
//! remember, recall, pre-compaction, and compaction-complete.

use std::fs;
use std::path::Path;
use std::sync::Arc;

use sha2::{Digest, Sha256};

use axum::Json;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use serde::Deserialize;
use tracing::warn;

use signet_core::db::Priority;
use signet_pipeline::memory_lineage::{
    ArtifactKind, SummaryArtifactInput, TranscriptArtifactInput, resolve_memory_sentence,
    upsert_thread_head, write_compaction_artifact, write_memory_projection,
    write_transcript_artifact,
};
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

/// Returns the session_key of the most recent session for a project.
/// Checks `session_transcripts` first, then falls back to `memory_artifacts`
/// so that compactions executed after a prior compaction (which deletes
/// session_transcripts rows) still resolve a stable lineage anchor.
fn latest_session_for_project(
    conn: &rusqlite::Connection,
    project: &str,
    agent_id: &str,
) -> rusqlite::Result<Option<String>> {
    // Primary: live transcript rows (present before first compaction).
    let mut stmt = conn.prepare(
        "SELECT session_key FROM session_transcripts \
         WHERE agent_id = ?1 AND project = ?2 AND session_key IS NOT NULL \
         ORDER BY created_at DESC LIMIT 1",
    )?;
    let mut rows = stmt.query(rusqlite::params![agent_id, project])?;
    if let Some(row) = rows.next()? {
        return row.get(0);
    }

    // Fallback: artifacts written by a prior compaction for this project.
    // session_transcripts may have been deleted after the first compaction,
    // but memory_artifacts is never cleared by the compaction path.
    let mut stmt = conn.prepare(
        "SELECT session_key FROM memory_artifacts \
         WHERE agent_id = ?1 AND project = ?2 AND session_key IS NOT NULL \
         ORDER BY captured_at DESC LIMIT 1",
    )?;
    let mut rows = stmt.query(rusqlite::params![agent_id, project])?;
    rows.next()?.map(|row| row.get(0)).transpose()
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

fn pipeline_enabled(state: &AppState) -> bool {
    // Runtime pause takes priority — workers refuse to run when this is set,
    // so we must not enqueue new work either.
    if state.pipeline_paused() {
        return false;
    }
    state
        .config
        .manifest
        .memory
        .as_ref()
        .and_then(|memory| memory.pipeline_v2.as_ref())
        .map(|pipeline| (pipeline.enabled || pipeline.shadow_mode) && !pipeline.paused)
        .unwrap_or(false)
}

/// Returns true when `canonical` is inside an allowed base directory.
///
/// Only `/tmp/signet/` is allowed — the documented connector staging
/// convention from API.md.  `$SIGNET_WORKSPACE/memory/` is intentionally
/// excluded: that directory holds OUTPUT artifacts for all agents, so any
/// caller reading from it could cross agent ownership boundaries by pointing
/// at another agent's `--transcript.md` or `--summary.md`.  Connectors
/// should stage transcripts to `/tmp/signet/` before sending session-end.
///
/// The TS daemon relies on the global auth middleware for this boundary;
/// daemon-rs enforces it explicitly here.
fn transcript_path_allowed(canonical: &Path) -> bool {
    canonical.starts_with("/tmp/signet")
}

/// Hard cap on transcript content accepted by session-end.  Prevents a DoS /
/// disk-growth attack via an oversized file or inline payload.  Matches the
/// TS daemon's MAX_TRANSCRIPT_CHARS safety cap (100 000 chars), applied here
/// at the byte level before any allocation.  Content exceeding this limit is
/// truncated with a `[truncated]` marker before artifact / DB writes.
const MAX_TRANSCRIPT_BYTES: usize = 400_000; // ~100k chars * 4 bytes/char (UTF-8 worst case)

/// Normalize a caller-supplied project path so lineage lookups use a
/// consistent key.  Mirrors session-start project normalization:
///   1. Try `canonicalize()` (resolves symlinks + `..`).
///   2. Fall back to string normalization: backslash → slash, trim trailing
///      slash, lowercase.
/// Returns `None` when the input is empty or blank.
fn normalize_project(raw: Option<&str>) -> Option<String> {
    let s = raw?.trim();
    if s.is_empty() {
        return None;
    }
    if let Ok(canonical) = Path::new(s).canonicalize() {
        // Preserve exact case — lowercasing collapses distinct projects
        // on case-sensitive filesystems (e.g. /work/Foo vs /work/foo).
        return Some(
            canonical
                .to_string_lossy()
                .trim_end_matches('/')
                .to_string(),
        );
    }
    // Path doesn't exist on this machine — normalize separators only.
    Some(s.replace('\\', "/").trim_end_matches('/').to_string())
}

fn normalize_session_transcript(harness: &str, raw: &str) -> String {
    if harness.trim().eq_ignore_ascii_case("codex") {
        return raw.to_string();
    }

    let lines = raw
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>();
    if lines.is_empty() {
        return String::new();
    }

    let mut parsed = 0usize;
    let mut normalized = Vec::new();
    for line in &lines {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        parsed += 1;
        if let Some(text) = normalize_json_transcript_line(&value) {
            normalized.push(text);
        }
    }

    // Fall back to raw if fewer than 60% of lines parsed as JSON, OR if we
    // parsed enough JSON but extracted zero messages (valid-but-unrecognized
    // JSONL format).  An empty normalized string would silently discard all
    // input content; raw is always preferable to silence.
    if parsed * 10 < lines.len() * 6 || normalized.is_empty() {
        raw.to_string()
    } else {
        normalized.join("\n")
    }
}

fn normalize_json_transcript_line(value: &serde_json::Value) -> Option<String> {
    if value.get("type").and_then(serde_json::Value::as_str) == Some("item.completed") {
        let item = value.get("item")?;
        if item.get("type").and_then(serde_json::Value::as_str) == Some("agent_message") {
            let text = item
                .get("text")
                .or_else(|| item.get("message"))
                .or_else(|| item.get("content"))
                .and_then(serde_json::Value::as_str)?;
            return Some(format!("Assistant: {text}"));
        }
    }

    if value.get("type").and_then(serde_json::Value::as_str) == Some("event_msg") {
        let payload = value.get("payload")?;
        if payload.get("type").and_then(serde_json::Value::as_str) == Some("user_message") {
            let text = payload
                .get("message")
                .or_else(|| payload.get("text"))
                .or_else(|| payload.get("content"))
                .and_then(serde_json::Value::as_str)?;
            return Some(format!("User: {text}"));
        }
    }

    let role = value
        .get("role")
        .or_else(|| value.get("speaker"))
        .and_then(serde_json::Value::as_str);
    let text = value
        .get("content")
        .or_else(|| value.get("text"))
        .or_else(|| value.get("message"))
        .and_then(serde_json::Value::as_str);
    match (role, text) {
        (Some("user"), Some(text)) => Some(format!("User: {text}")),
        (Some("assistant"), Some(text)) => Some(format!("Assistant: {text}")),
        _ => None,
    }
}

fn upsert_session_transcript(
    conn: &rusqlite::Connection,
    session_key: &str,
    transcript: &str,
    harness: &str,
    project: Option<&str>,
    agent_id: &str,
) -> rusqlite::Result<()> {
    if session_key.trim().is_empty() || transcript.trim().is_empty() {
        return Ok(());
    }
    let now = chrono::Utc::now().to_rfc3339();
    let _ = conn.execute(
        "INSERT INTO session_transcripts (session_key, agent_id, content, harness, project, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(session_key, agent_id) DO UPDATE SET
            content = excluded.content,
            harness = excluded.harness,
            project = excluded.project",
        rusqlite::params![session_key, agent_id, transcript, harness, project, now],
    )?;
    Ok(())
}

fn enqueue_summary_job(
    conn: &rusqlite::Connection,
    harness: &str,
    transcript: &str,
    session_key: Option<&str>,
    session_id: &str,
    project: Option<&str>,
    agent_id: &str,
    trigger: &str,
    captured_at: &str,
    started_at: Option<&str>,
    ended_at: Option<&str>,
) -> rusqlite::Result<String> {
    // Idempotency: check for an existing non-dead job for (agent_id, session_id, trigger).
    // 'dead' is excluded so a fresh retry can create a new job after permanent failure.
    // 'processing' is an older alias for 'leased' kept for schema compatibility.
    //
    // Completed/done jobs → return the existing id (summary already produced).
    // Active jobs (pending/leased/processing) → update transcript in case the
    //   retry has fresher content (e.g. a previously truncated payload is now
    //   complete); return the existing id to avoid duplicating the job.
    if let Ok((existing_id, existing_status)) = conn.query_row(
        "SELECT id, status FROM summary_jobs \
         WHERE agent_id = ?1 AND session_id = ?2 AND trigger = ?3 \
         AND status IN ('pending', 'leased', 'processing', 'completed', 'done') LIMIT 1",
        rusqlite::params![agent_id, session_id, trigger],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
    ) {
        if existing_status == "pending" || existing_status == "leased" || existing_status == "processing" {
            // Update the transcript so retries with fresher content are used.
            let _ = conn.execute(
                "UPDATE summary_jobs SET transcript = ?1, updated_at = ?2 WHERE id = ?3",
                rusqlite::params![transcript, chrono::Utc::now().to_rfc3339(), existing_id],
            );
        }
        return Ok(existing_id);
    }
    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO summary_jobs
         (id, session_key, session_id, harness, project, agent_id, transcript,
          trigger, captured_at, started_at, ended_at, status, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'pending', ?12, ?12)",
        rusqlite::params![
            id,
            session_key,
            session_id,
            harness,
            project,
            agent_id,
            transcript,
            trigger,
            captured_at,
            started_at,
            ended_at,
            now,
        ],
    )?;
    Ok(id)
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
    // Mirror TS hooks.userPromptSubmit.minScore confidence gate. The TS path
    // uses calibrated hybridRecall + reranker scores; here we use term-coverage
    // (matched_terms / total_terms) as a query-relevance proxy until the Rust
    // prompt_submit path integrates full hybrid scoring.
    let min_score = state
        .config
        .manifest
        .hooks
        .as_ref()
        .map(|h| h.user_prompt_submit.min_score)
        .unwrap_or(0.8)
        .clamp(0.0, 1.0);

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
            // NOTE: when full hybrid scoring / reranker integration lands, preserve actual
            // calibrated scores from the reranker — never synthesize from rank position.
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

            // Confidence gate: compute term-coverage for the top result as a
            // query-relevance proxy (matched_needles / total_needles → [0, 1]).
            // Replaces the TS calibrated hybridRecall score until full hybrid
            // scoring lands in this path.
            let coverage = if !mem_rows.is_empty() && !needles.is_empty() {
                let top = mem_rows[0].1.to_lowercase();
                let matched = needles.iter().filter(|n| top.contains(n.as_str())).count();
                matched as f64 / needles.len() as f64
            } else {
                0.0
            };

            if !mem_rows.is_empty() && !anchor_missed && coverage >= min_score {
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
    pub transcript: Option<String>,
    pub transcript_path: Option<String>,
    pub session_id: Option<String>,
    pub session_key: Option<String>,
    pub cwd: Option<String>,
    pub reason: Option<String>,
    pub runtime_path: Option<String>,
    pub agent_id: Option<String>,
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

    let session_key = body
        .session_key
        .clone()
        .or(body.session_id.clone())
        .unwrap_or_default();
    let path = resolve_runtime_path(&headers, body.runtime_path.as_deref());

    if let Some(p) = path
        && let Some(claimed_by) = state.sessions.check(&session_key, p)
    {
        state.sessions.release(&session_key);
        state.continuity.clear(&session_key);
        state.dedup.clear_session_start(&session_key);
        state.dedup.clear(&session_key);
        return conflict_response(claimed_by);
    }

    // Honor bypass — no-op response with clean state release, same as TS daemon.
    if !session_key.is_empty() && state.sessions.is_bypassed(&session_key) {
        state.sessions.release(&session_key);
        state.continuity.clear(&session_key);
        state.dedup.clear_session_start(&session_key);
        state.dedup.clear(&session_key);
        return (
            StatusCode::OK,
            Json(serde_json::json!({"memoriesSaved": 0, "bypassed": true})),
        )
            .into_response();
    }

    let is_clear = body.reason.as_deref() == Some("clear");
    // snapshot_retained: true when peek found a snapshot but the DB write
    // failed.  The snapshot stays in-memory so a client retry can attempt the
    // checkpoint again.  Error-path returns that allow retry must NOT call
    // continuity.clear while this flag is set.
    let snapshot_retained = if !is_clear {
        if let Some(snapshot) = state.continuity.peek_snapshot(&session_key) {
            let wrote = state
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
            if wrote.is_ok() {
                state.continuity.consume(&session_key);
                false
            } else {
                warn!(session = %session_key, "session-end: checkpoint write failed, snapshot retained for retry");
                true
            }
        } else {
            false
        }
    } else {
        false
    };
    // sessions.release is deferred to after artifact/job persistence so no
    // concurrent session-end can race in while canonical writes are in flight.

    if is_clear {
        state.sessions.release(&session_key);
        state.continuity.clear(&session_key);
        state.dedup.clear_session_start(&session_key);
        state.dedup.clear(&session_key);
        return (
            StatusCode::OK,
            Json(serde_json::json!({"memoriesSaved": 0})),
        )
            .into_response();
    }

    // Validate body.agent_id against the agent encoded in session_key.
    // resolve_remember_agent rejects if they disagree, preventing lineage from
    // being written under a different agent than the one that opened the session.
    let agent_id = match resolve_remember_agent(
        body.agent_id.as_deref(),
        headers.get("x-signet-agent-id").and_then(|v| v.to_str().ok()),
        if session_key.trim().is_empty() {
            None
        } else {
            Some(session_key.as_str())
        },
    ) {
        Ok(id) => id,
        Err(e) => {
            state.sessions.release(&session_key);
            if !snapshot_retained {
                state.continuity.clear(&session_key);
            }
            state.dedup.clear_session_start(&session_key);
            state.dedup.clear(&session_key);
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"error": e})),
            )
                .into_response();
        }
    };
    let ended_at = chrono::Utc::now().to_rfc3339();
    // Normalize cwd to a stable project key: canonicalize resolves symlinks/..;
    // string fallback handles non-existent paths from remote connectors.
    // Consistent project keys are required for exact-equality lineage lookups.
    let project = normalize_project(body.cwd.as_deref());
    // session_id is resolved after transcript load so the content-hash fallback
    // can include transcript content (making it retry-stable when neither
    // session_id nor session_key is provided by the caller).

    // Raw transcript content — normalization is deferred so the canonical
    // artifact always receives the unmodified original.  Read via the
    // canonicalized path (not the caller-supplied string) to close the TOCTOU
    // window between symlink-resolution and open.
    //
    // If transcript_path was supplied but unreadable/outside-allowlist, that
    // is a hard error: silently falling back to "" would drop the session's
    // lineage without telling the caller.  Continuity is preserved so the
    // caller can retry once the file is accessible.
    let transcript = if let Some(path) = body
        .transcript_path
        .as_deref()
        .filter(|p| !p.trim().is_empty())
    {
        // Canonicalize so the read is from the real inode, not the
        // caller-supplied string.  A symlink swap after canonicalize()
        // cannot redirect the subsequent open because we open the
        // resolved canonical path — not the original string.
        let canonical = match fs::canonicalize(path) {
            Ok(p) => p,
            Err(e) => {
                warn!(path, error = %e, "session-end: transcript_path unresolvable");
                state.sessions.release(&session_key);
                // Preserve continuity: caller should retry when the file appears.
                state.dedup.clear_session_start(&session_key);
                state.dedup.clear(&session_key);
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(serde_json::json!({"error": format!("transcript_path unresolvable: {e}")})),
                )
                    .into_response();
            }
        };
        // Allowlist: only /tmp/signet/ (documented connector staging path).
        // workspace/memory/ is excluded — it holds multi-agent output artifacts
        // and reading from it would allow cross-agent exfiltration.
        if !transcript_path_allowed(&canonical) {
            warn!(
                path = %canonical.display(),
                "session-end: transcript_path outside allowed roots"
            );
            state.sessions.release(&session_key);
            state.dedup.clear_session_start(&session_key);
            state.dedup.clear(&session_key);
            return (
                StatusCode::FORBIDDEN,
                Json(serde_json::json!({"error": "transcript_path outside allowed workspace roots"})),
            )
                .into_response();
        }
        // Reject oversized files before allocation.
        let file_len = fs::metadata(&canonical)
            .map(|m| m.len() as usize)
            .unwrap_or(0);
        if file_len > MAX_TRANSCRIPT_BYTES {
            warn!(
                path = %canonical.display(),
                bytes = file_len,
                limit = MAX_TRANSCRIPT_BYTES,
                "session-end: transcript_path exceeds size limit"
            );
            state.sessions.release(&session_key);
            state.dedup.clear_session_start(&session_key);
            state.dedup.clear(&session_key);
            return (
                StatusCode::PAYLOAD_TOO_LARGE,
                Json(serde_json::json!({
                    "error": format!("transcript_path exceeds {MAX_TRANSCRIPT_BYTES} byte limit")
                })),
            )
                .into_response();
        }
        match fs::read_to_string(&canonical) {
            Ok(content) => content,
            Err(e) => {
                warn!(path = %canonical.display(), error = %e, "session-end: transcript_path read failed");
                state.sessions.release(&session_key);
                // Preserve continuity: caller should retry.
                state.dedup.clear_session_start(&session_key);
                state.dedup.clear(&session_key);
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(serde_json::json!({"error": format!("transcript_path read failed: {e}")})),
                )
                    .into_response();
            }
        }
    } else {
        // Inline transcript — truncate rather than reject so connectors that
        // send everything inline are not broken by the size cap.
        let raw = body
            .transcript
            .as_deref()
            .map(str::to_string)
            .unwrap_or_default();
        if raw.len() > MAX_TRANSCRIPT_BYTES {
            warn!(
                bytes = raw.len(),
                limit = MAX_TRANSCRIPT_BYTES,
                "session-end: inline transcript truncated to size limit"
            );
            // Find the last valid UTF-8 char boundary at or before the limit
            // so the slice never panics on multibyte input.
            let at = (0..=MAX_TRANSCRIPT_BYTES.min(raw.len()))
                .rev()
                .find(|&i| raw.is_char_boundary(i))
                .unwrap_or(0);
            format!("{}\n[truncated]", &raw[..at])
        } else {
            raw
        }
    };

    // Normalized view used for LLM inputs (summary job) and the legacy DB
    // upsert.  The canonical artifact above gets the raw original.
    let normalized = normalize_session_transcript(harness, &transcript);

    // Resolve session_id now that transcript is available for the content-hash
    // fallback.  Priority: explicit body.session_id → session_key → content hash.
    // The hash covers (harness, agent_id, project, transcript prefix) so the
    // same session-end content always maps to the same ID across retries, making
    // artifact writes and summary-job dedup idempotent even when the caller omits
    // both sessionId and sessionKey.
    let session_id = body
        .session_id
        .clone()
        .or_else(|| {
            if session_key.trim().is_empty() {
                None
            } else {
                Some(session_key.clone())
            }
        })
        .unwrap_or_else(|| {
            // Hash the full transcript (not just a prefix) to avoid false
            // collisions when distinct sessions share a common opening.
            // A 512-char prefix would collide for any two sessions in the
            // same project that start with identical boilerplate content.
            let mut h = Sha256::new();
            h.update(harness.as_bytes());
            h.update(b":");
            h.update(agent_id.as_bytes());
            h.update(b":");
            h.update(project.as_deref().unwrap_or("").as_bytes());
            h.update(b":");
            h.update(transcript.as_bytes());
            let digest = h.finalize();
            let hex: String = digest[..8].iter().map(|b| format!("{b:02x}")).collect();
            format!("session-end:{hex}")
        });

    // Gate before any writes — no-op sessions don't need artifact/job work.
    if transcript.trim().is_empty() {
        state.sessions.release(&session_key);
        state.continuity.clear(&session_key);
        state.dedup.clear_session_start(&session_key);
        state.dedup.clear(&session_key);
        return (
            StatusCode::OK,
            Json(serde_json::json!({"memoriesSaved": 0, "queued": false})),
        )
            .into_response();
    }

    // Canonical artifact always written before pipeline gates — it is the
    // lineage source of truth regardless of pipeline_enabled or shadow_mode.
    // This matches compaction_complete, which also writes artifacts unconditionally
    // so manifests and backlinks never reference transcripts that don't exist.
    {
        let transcript_value = transcript.clone();
        let root = state.config.base_path.clone();
        let session_key_value = if session_key.trim().is_empty() {
            None
        } else {
            Some(session_key.clone())
        };
        let input = TranscriptArtifactInput {
            agent_id: agent_id.clone(),
            session_id: session_id.clone(),
            session_key: session_key_value,
            project: project.clone(),
            harness: Some(harness.to_string()),
            captured_at: ended_at.clone(),
            started_at: None,
            ended_at: Some(ended_at.clone()),
            transcript: transcript_value,
        };
        // Hard failure: lineage chain is broken without this artifact.
        if let Err(e) = state
            .pool
            .write(Priority::Low, move |conn| {
                write_transcript_artifact(conn, &root, input)
                    .map(|_| serde_json::Value::Null)
                    .map_err(signet_core::error::CoreError::Migration)
            })
            .await
        {
            state.sessions.release(&session_key);
            // Transient failure — client may retry.  Preserve the snapshot if
            // it was retained from a failed checkpoint write so the retry can
            // still commit it.
            if !snapshot_retained {
                state.continuity.clear(&session_key);
            }
            state.dedup.clear_session_start(&session_key);
            state.dedup.clear(&session_key);
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": format!("transcript artifact write failed: {e}")})),
            )
                .into_response();
        }
    }

    // Stop here if pipeline is fully disabled (not enabled, not shadow).
    // Shadow mode falls through and enqueues the summary job — matching the
    // TS daemon, which calls enqueueSummaryJob for shadow sessions too.
    // The canonical --summary.md artifact is produced by the worker later.
    if !pipeline_enabled(state.as_ref()) {
        state.sessions.release(&session_key);
        state.continuity.clear(&session_key);
        state.dedup.clear_session_start(&session_key);
        state.dedup.clear(&session_key);
        return (
            StatusCode::OK,
            Json(serde_json::json!({"memoriesSaved": 0})),
        )
            .into_response();
    }

    // Legacy DB upsert — best-effort, only when pipeline is enabled or in
    // shadow.  Canonical artifact above is the source of truth; this feeds
    // the legacy extraction pipeline.
    if !session_key.trim().is_empty() {
        let transcript_value = normalized.clone();
        let harness_value = harness.to_string();
        let project_value = project.clone();
        let session_key_value = session_key.clone();
        let agent_value = agent_id.clone();
        if let Err(e) = state
            .pool
            .write(Priority::Low, move |conn| {
                upsert_session_transcript(
                    conn,
                    &session_key_value,
                    &transcript_value,
                    &harness_value,
                    project_value.as_deref(),
                    &agent_value,
                )?;
                Ok(serde_json::Value::Null)
            })
            .await
        {
            warn!(error = %e, "session-end: transcript DB upsert failed, continuing");
        }
    }

    // Clamp the LLM input (summary job) by char count — canonical artifact
    // already received the full raw transcript above for lossless storage.
    // The summary job gets the normalized (text) view, not raw JSONL.
    const MAX_TRANSCRIPT_CHARS: usize = 100_000;
    let summary_transcript = if normalized.chars().count() > MAX_TRANSCRIPT_CHARS {
        let safe: String = normalized.chars().take(MAX_TRANSCRIPT_CHARS).collect();
        format!("{safe}\n[truncated]")
    } else {
        normalized.clone()
    };

    let harness_value = harness.to_string();
    let project_value = project.clone();
    let session_key_value = if session_key.trim().is_empty() {
        None
    } else {
        Some(session_key.clone())
    };
    let session_id_value = session_id.clone();
    let agent_value = agent_id.clone();
    let transcript_value = summary_transcript;
    let ended_value = ended_at.clone();
    let result = state
        .pool
        .write(Priority::High, move |conn| {
            let job_id = enqueue_summary_job(
                conn,
                &harness_value,
                &transcript_value,
                session_key_value.as_deref(),
                &session_id_value,
                project_value.as_deref(),
                &agent_value,
                "session_end",
                &ended_value,
                None,
                Some(&ended_value),
            )?;
            Ok(serde_json::json!({
                "memoriesSaved": 0,
                "queued": true,
                "jobId": job_id,
            }))
        })
        .await;

    match result {
        Ok(val) => {
            // Persistence succeeded — safe to release session claim and clear
            // in-memory state now. Release before clear so any racing
            // session-start sees a clean slot.
            state.sessions.release(&session_key);
            state.continuity.clear(&session_key);
            state.dedup.clear_session_start(&session_key);
            state.dedup.clear(&session_key);
            (StatusCode::OK, Json(val)).into_response()
        }
        Err(e) => {
            // Enqueue failed — release claim so a retry can reclaim.  Preserve
            // the snapshot if it was retained from a failed checkpoint write so
            // the retry can still commit it.
            state.sessions.release(&session_key);
            if !snapshot_retained {
                state.continuity.clear(&session_key);
            }
            state.dedup.clear_session_start(&session_key);
            state.dedup.clear(&session_key);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": e.to_string()})),
            )
                .into_response()
        }
    }
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
    let Some(harness) = body.harness.as_deref() else {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "harness is required"})),
        )
            .into_response();
    };

    let Some(summary) = body
        .summary
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    else {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "summary is required"})),
        )
            .into_response();
    };

    let path = resolve_runtime_path(&headers, body.runtime_path.as_deref());

    if let (Some(key), Some(p)) = (&body.session_key, path)
        && let Some(claimed_by) = state.sessions.check(key, p)
    {
        return conflict_response(claimed_by);
    }

    if let Some(key) = &body.session_key {
        state.dedup.reset_prompt_dedup(key);
    }

    // Honor bypass — same early-return as TS daemon compaction-complete.
    if let Some(key) = &body.session_key {
        if state.sessions.is_bypassed(key) {
            return (
                StatusCode::OK,
                Json(serde_json::json!({"success": true, "bypassed": true})),
            )
                .into_response();
        }
    }

    // Compaction artifacts are canonical lineage and must be written regardless
    // of pipeline_enabled or shadow_mode — skipping them here would break the
    // lineage chain for MEMORY.md projection even when the memory pipeline is
    // otherwise disabled.  This matches the TS daemon, which has no pipeline
    // gate in compaction-complete.

    let captured_at = chrono::Utc::now().to_rfc3339();
    let harness_value = harness.to_string();
    let summary_value = summary.to_string();
    // Validate body.agent_id against the agent encoded in session_key so
    // compaction lineage can't be attributed to an arbitrary caller-supplied id.
    let agent_id = match resolve_remember_agent(
        body.agent_id.as_deref(),
        headers.get("x-signet-agent-id").and_then(|v| v.to_str().ok()),
        body.session_key.as_deref(),
    ) {
        Ok(id) => id,
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"error": e})),
            )
                .into_response();
        }
    };
    let sentence = resolve_memory_sentence(
        &summary_value,
        body.project.as_deref(),
        Some(harness),
        ArtifactKind::Compaction,
        None,
        None,
    )
    .await;
    let root = state.config.base_path.clone();
    let session_key = body.session_key.clone();
    let fallback_project = body.project.clone();

    // Step 1: Resolve lineage metadata and write canonical artifacts first.
    // DB ingest is intentionally deferred until artifacts are on disk so that
    // an artifact-write failure leaves no committed DB state — retries start
    // clean.  If artifact writes succeed but DB ingest fails (step 2), the
    // artifact is already canonical; ingest is idempotent via session_id key.
    //
    // Artifact filename stability on retry: write_compaction_artifact calls
    // ensure_canonical_manifest, which queries memory_artifacts for an existing
    // manifest by session_id before creating one.  If step 1 succeeded on a
    // prior attempt, the manifest row is already committed; retries find it
    // and read back its original captured_at for the filename — NOT the fresh
    // Utc::now() from this invocation.  The filename is therefore stable across
    // retries for the same logical compaction event.
    let artifact_result = state
        .pool
        .write(Priority::High, {
            let session_key = session_key.clone();
            let agent_id = agent_id.clone();
            let fallback_project = fallback_project.clone();
            let captured_at = captured_at.clone();
            let harness_value = harness_value.clone();
            let summary_value = summary_value.clone();
            move |conn| {
                let project = resolve_compaction_project(
                    conn,
                    session_key.as_deref(),
                    &agent_id,
                    fallback_project.as_deref(),
                )?;
                // Stable lineage ID for the compaction event.  When session_key
                // is present it is authoritative.  When absent, derive a
                // content-hash ID so that retries for the same compaction event
                // produce the same session_id — making ensure_canonical_manifest
                // idempotent and preventing duplicate artifacts.
                //
                // Hash includes agent_id + project + summary.  Two genuinely
                // distinct compaction events producing identical summary text for
                // the same agent/project are an accepted edge case: the trade-off
                // between retry idempotency (requires stable id) and cross-event
                // uniqueness (requires session_key from caller) cannot be resolved
                // without a caller-provided identifier.  Callers should always
                // send session_key when available.
                let sid = session_key.clone().unwrap_or_else(|| {
                    let mut h = Sha256::new();
                    h.update(agent_id.as_bytes());
                    h.update(b":");
                    h.update(project.as_deref().unwrap_or("").as_bytes());
                    h.update(b":");
                    h.update(summary_value.as_bytes());
                    let digest = h.finalize();
                    let hex: String = digest[..8]
                        .iter()
                        .map(|b| format!("{b:02x}"))
                        .collect();
                    format!("compaction:{hex}")
                });
                write_compaction_artifact(
                    conn,
                    &root,
                    SummaryArtifactInput {
                        agent_id: agent_id.clone(),
                        session_id: sid.clone(),
                        session_key: session_key.clone(),
                        project: project.clone(),
                        harness: Some(harness_value),
                        captured_at: captured_at.clone(),
                        started_at: None,
                        ended_at: Some(captured_at),
                        summary: summary_value,
                    },
                    sentence,
                )
                .map_err(signet_core::error::CoreError::Migration)?;
                // write_memory_projection is deferred to after DB ingest (step 2)
                // so MEMORY.md reflects the newly ingested session_summary row.
                Ok(serde_json::json!({
                    "project": project,
                    "sessionId": sid,
                }))
            }
        })
        .await;

    let meta = match artifact_result {
        Ok(v) => v,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": format!("compaction artifact write failed: {e}")})),
            )
                .into_response();
        }
    };

    let session_id = meta["sessionId"].as_str().unwrap_or("").to_string();
    let project: Option<String> = meta["project"].as_str().map(str::to_string);

    // Step 2: DB ingest. Artifact is committed above so this is recoverable
    // on failure. idempotency_key=session_id ensures retries don't create
    // duplicate memory rows.
    let ingest_result = state
        .pool
        .write(Priority::Low, {
            let session_key = session_key.clone();
            let agent_id = agent_id.clone();
            let harness_value = harness_value.clone();
            let summary_value = summary_value.clone();
            let session_id = session_id.clone();
            let root = state.config.base_path.clone();
            move |conn| {
                let r = transactions::ingest(
                    conn,
                    &transactions::IngestInput {
                        content: &summary_value,
                        memory_type: "session_summary",
                        tags: vec!["session".into(), "summary".into(), harness_value.clone()],
                        who: None,
                        why: Some("compaction"),
                        project: project.as_deref(),
                        importance: 0.3,
                        pinned: false,
                        source_type: Some("compaction"),
                        source_id: session_key.as_deref(),
                        idempotency_key: Some(&session_id),
                        runtime_path: None,
                        actor: "compaction",
                        agent_id: &agent_id,
                        visibility: "global",
                        scope: None,
                    },
                )?;
                if let Some(key) = session_key.as_deref() {
                    let _ = conn.execute(
                        "DELETE FROM session_transcripts WHERE session_key = ?1 AND agent_id = ?2",
                        rusqlite::params![key, agent_id],
                    );
                    let _ = conn.execute(
                        "DELETE FROM session_extract_cursors WHERE session_key = ?1 AND agent_id = ?2",
                        rusqlite::params![key, agent_id],
                    );
                }

                // Write temporal DAG node — mirrors the TS daemon's
                // compaction-complete path (daemon.ts ~L6140-6173).
                let node_id = session_key
                    .as_deref()
                    .map(|k| format!("{k}:compaction:{}", chrono::Utc::now().timestamp_millis()))
                    .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
                let token_count = (summary_value.len() / 4) as i64;
                let _ = conn.execute(
                    "INSERT OR REPLACE INTO session_summaries (
                         id, project, depth, kind, content, token_count,
                         earliest_at, latest_at, session_key, harness,
                         agent_id, source_type, source_ref, meta_json, created_at
                     ) VALUES (?1, ?2, 0, 'session', ?3, ?4, ?5, ?5, ?6, ?7, ?8,
                               'compaction', ?6, ?9, ?5)",
                    rusqlite::params![
                        node_id,
                        project,
                        summary_value,
                        token_count,
                        captured_at,
                        session_key,
                        harness_value,
                        agent_id,
                        serde_json::json!({"source": "compaction-complete"}).to_string(),
                    ],
                );
                let thread_key = session_key.as_deref().unwrap_or(&node_id);
                let sample: String = summary_value.chars().take(200).collect();
                let _ = upsert_thread_head(
                    conn,
                    &agent_id,
                    thread_key,
                    "compaction",
                    project.as_deref(),
                    session_key.as_deref(),
                    "compaction",
                    session_key.as_deref(),
                    Some(&harness_value),
                    &node_id,
                    &captured_at,
                    &sample,
                );

                // Project MEMORY.md after ingest so it includes the new row.
                write_memory_projection(conn, &root, &agent_id)
                    .map_err(signet_core::error::CoreError::Migration)?;
                Ok(serde_json::Value::String(r.id))
            }
        })
        .await;

    match ingest_result {
        Ok(v) => (
            StatusCode::OK,
            Json(serde_json::json!({"success": true, "memoryId": v})),
        )
            .into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e.to_string()})),
        )
            .into_response(),
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
    use std::sync::Arc;

    use axum::Json;
    use axum::body::to_bytes;
    use axum::extract::State;
    use axum::http::{HeaderMap, StatusCode};
    use serde_json::Value;
    use signet_core::config::{
        AgentManifest, DaemonConfig, MemoryManifestConfig, PipelineV2Config,
    };
    use signet_core::db::DbPool;
    use tempfile::TempDir;

    use crate::auth::rate_limiter::{AuthRateLimiter, default_limits};
    use crate::auth::types::AuthMode;
    use crate::state::AppState;

    use super::{
        CHECKPOINT_MIN_DELTA, CompactionCompleteBody, SessionEndBody, compaction_complete,
        extract_delta, parse_visibility, require_session_scope_for_write,
        resolve_compaction_project, resolve_remember_agent, session_agent_id, session_end,
        strip_untrusted_metadata,
    };
    use signet_services::session::{RuntimePath, SessionTracker};

    async fn test_json(resp: axum::response::Response) -> Value {
        let body = to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        serde_json::from_slice(&body).unwrap()
    }

    fn test_state(name: &str) -> (Arc<AppState>, tokio::task::JoinHandle<()>, TempDir) {
        let tmp = tempfile::Builder::new().prefix(name).tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join("memory")).unwrap();
        std::fs::create_dir_all(tmp.path().join(".daemon/logs")).unwrap();
        let mut manifest = AgentManifest::default();
        let mut memory = MemoryManifestConfig::default();
        memory.pipeline_v2 = Some(PipelineV2Config::default());
        manifest.memory = Some(memory);
        let cfg = DaemonConfig {
            base_path: tmp.path().to_path_buf(),
            db_path: tmp.path().join("memory").join("memories.db"),
            port: 3850,
            host: "127.0.0.1".to_string(),
            bind: Some("127.0.0.1".to_string()),
            manifest,
        };
        let (pool, writer) = DbPool::open(&cfg.db_path).unwrap();
        let state = Arc::new(AppState::new(
            cfg,
            pool,
            None,
            None,
            AuthMode::Local,
            None,
            AuthRateLimiter::from_rules(&default_limits()),
        ));
        (state, writer, tmp)
    }

    #[tokio::test]
    async fn session_end_persists_transcript_artifact_and_queues_summary() {
        let (state, writer, tmp) = test_state("hooks-session-end");
        let transcript = [
            "User: discuss packages/daemon-rs hooks parity.",
            "Assistant: implement the rolling lineage projection for MEMORY.md.",
        ]
        .join("\n")
        .repeat(24);

        let resp = session_end(
            State(state.clone()),
            HeaderMap::new(),
            Json(SessionEndBody {
                harness: Some("codex".to_string()),
                transcript: Some(transcript),
                transcript_path: None,
                session_id: None,
                session_key: Some("agent:agent-a:sess-1".to_string()),
                cwd: Some("packages/daemon-rs".to_string()),
                reason: None,
                runtime_path: None,
                agent_id: Some("agent-a".to_string()),
            }),
        )
        .await;

        assert_eq!(resp.status(), StatusCode::OK);
        let body = test_json(resp).await;
        assert_eq!(body["queued"], serde_json::Value::Bool(true));
        assert!(body["jobId"].is_string());

        let counts = state
            .pool
            .read(|conn| {
                let jobs: i64 = conn
                    .query_row("SELECT COUNT(*) FROM summary_jobs", [], |row| row.get(0))
                    .unwrap_or(0);
                let transcripts: i64 = conn
                    .query_row("SELECT COUNT(*) FROM session_transcripts", [], |row| {
                        row.get(0)
                    })
                    .unwrap_or(0);
                let artifacts: i64 = conn
                    .query_row(
                        "SELECT COUNT(*) FROM memory_artifacts WHERE source_kind = 'transcript'",
                        [],
                        |row| row.get(0),
                    )
                    .unwrap_or(0);
                let manifests: i64 = conn
                    .query_row(
                        "SELECT COUNT(*) FROM memory_artifacts WHERE source_kind = 'manifest'",
                        [],
                        |row| row.get(0),
                    )
                    .unwrap_or(0);
                Ok((jobs, transcripts, artifacts, manifests))
            })
            .await
            .unwrap();

        assert_eq!(counts.0, 1);
        assert_eq!(counts.1, 1);
        assert_eq!(counts.2, 1);
        assert_eq!(counts.3, 1);

        let files = std::fs::read_dir(tmp.path().join("memory"))
            .unwrap()
            .filter_map(|entry| {
                entry
                    .ok()
                    .and_then(|value| value.file_name().into_string().ok())
            })
            .collect::<Vec<_>>();
        assert!(files.iter().any(|name| name.ends_with("--transcript.md")));
        assert!(files.iter().any(|name| name.ends_with("--manifest.md")));

        drop(state);
        let _ = writer.await;
    }

    #[tokio::test]
    async fn compaction_complete_writes_artifact_projection_and_clears_runtime_transcript() {
        let (state, writer, tmp) = test_state("hooks-compaction");
        let transcript = [
            "User: preserve packages/daemon-rs MEMORY.md lineage.",
            "Assistant: transcript artifact should remain canonical after compaction.",
        ]
        .join("\n")
        .repeat(24);

        let _ = session_end(
            State(state.clone()),
            HeaderMap::new(),
            Json(SessionEndBody {
                harness: Some("codex".to_string()),
                transcript: Some(transcript),
                transcript_path: None,
                session_id: None,
                session_key: Some("agent:agent-a:sess-2".to_string()),
                cwd: Some("packages/daemon-rs".to_string()),
                reason: None,
                runtime_path: None,
                agent_id: Some("agent-a".to_string()),
            }),
        )
        .await;

        let resp = compaction_complete(
            State(state.clone()),
            HeaderMap::new(),
            Json(CompactionCompleteBody {
                harness: Some("codex".to_string()),
                summary: Some("# Compaction Summary\n\n## packages/daemon-rs\n\nCompaction preserved the daemon-rs lineage work and the rolling MEMORY.md projection contract.".to_string()),
                session_key: Some("agent:agent-a:sess-2".to_string()),
                project: Some("packages/daemon-rs".to_string()),
                agent_id: Some("agent-a".to_string()),
                runtime_path: None,
            }),
        )
        .await;

        assert_eq!(resp.status(), StatusCode::OK);
        let body = test_json(resp).await;
        assert_eq!(body["success"], serde_json::Value::Bool(true));
        assert!(body["memoryId"].is_string());

        let counts = state
            .pool
            .read(|conn| {
                let compactions: i64 = conn
                    .query_row(
                        "SELECT COUNT(*) FROM memory_artifacts WHERE source_kind = 'compaction'",
                        [],
                        |row| row.get(0),
                    )
                    .unwrap_or(0);
                let transcripts: i64 = conn
                    .query_row("SELECT COUNT(*) FROM session_transcripts", [], |row| {
                        row.get(0)
                    })
                    .unwrap_or(0);
                Ok((compactions, transcripts))
            })
            .await
            .unwrap();

        assert_eq!(counts.0, 1);
        assert_eq!(counts.1, 0);

        let memory_md = std::fs::read_to_string(tmp.path().join("MEMORY.md")).unwrap();
        assert!(memory_md.contains("Session Ledger (Last 30 Days)"));
        assert!(memory_md.contains("[[memory/"));

        let manifest = std::fs::read_dir(tmp.path().join("memory"))
            .unwrap()
            .filter_map(|entry| entry.ok().map(|value| value.path()))
            .find(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.ends_with("--manifest.md"))
            })
            .unwrap();
        let manifest_text = std::fs::read_to_string(manifest).unwrap();
        assert!(manifest_text.contains("compaction_path: memory/"));

        drop(state);
        let _ = writer.await;
    }

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
