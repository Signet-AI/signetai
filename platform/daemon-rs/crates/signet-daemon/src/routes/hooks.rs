//! Hook lifecycle route handlers.
//!
//! These implement the core hook endpoints that connectors call during
//! session lifecycle: session-start, prompt-submit, session-end,
//! remember, recall, pre-compaction, and compaction-complete.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use sha2::{Digest, Sha256};

use axum::Json;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use serde::Deserialize;
use tracing::{info, warn};

use signet_core::db::Priority;
use signet_pipeline::memory_lineage::{
    ArtifactKind, SummaryArtifactInput, TranscriptArtifactInput, is_noise_session,
    resolve_memory_sentence, upsert_thread_head, write_compaction_artifact,
    write_memory_projection, write_transcript_artifact,
};
use signet_services::session::{ClaimResult, RuntimePath, SessionTracker};
use signet_services::transactions;

use crate::state::AppState;
use crate::workspace_paths;

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

fn build_signet_system_prompt() -> &'static str {
    "[signet active]\n\
You have persistent memory managed by Signet.\n\
\n\
Memory Check Loop:\n\
- when to use: before commands, file edits, architectural choices, bug fixes, continuation work, user-preference-sensitive answers, or anything that may depend on prior decisions\n\
- procedure: check injected context first, then run 1-3 targeted recalls with mcp__signet__memory_search; shape recall queries as natural questions with an entity, event, and timeframe when possible; expand session lineage with mcp__signet__lcm_expand or known entities with mcp__signet__knowledge_expand and mcp__signet__knowledge_expand_session when needed\n\
- pitfalls: avoid bag-of-keywords queries; do not treat a missing automatic memory match as proof no prior context exists; do not trust memory blindly when repo, files, or live system state can verify it; do not spam broad recalls for trivial self-contained prompts; treat graph expansion as supporting context, not proof\n\
- verification: before acting, know what context you found, what remains unknown, and whether it is safe to proceed\n\
\n\
Memory tools:\n\
- mcp__signet__memory_search: search stored memories by keyword or meaning\n\
- mcp__signet__lcm_expand: expand a session summary into its full lineage and linked memories\n\
- mcp__signet__knowledge_expand: expand a known entity into its aspects, attributes, and dependencies\n\
- mcp__signet__knowledge_expand_session: find sessions linked to a known entity\n\
- mcp__signet__memory_store: save something to memory explicitly\n\
\n\
Cross-session history:\n\
- linked summary and transcript artifacts in your Signet workspace are inspectable across sessions\n\
- use transcript and summary artifacts when you need deeper history than MEMORY.md or recall snippets provide\n\
\n\
Identity files in your Signet workspace:\n\
- AGENTS.md: how you operate (maintain this)\n\
- SOUL.md: personality and values (maintain this)\n\
- IDENTITY.md: who you are (maintain this)\n\
- USER.md: who the user is (maintain this)\n\
- MEMORY.md: auto-generated working memory summary (system-managed)\n\
\n\
Secrets:\n\
- mcp__signet__secret_list\n\
- mcp__signet__secret_exec\n\
Secrets are injected into subprocesses as environment variables and are not exposed as raw values.\n"
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

fn load_guarded_transcript_path(
    path: &str,
    route: &str,
) -> Result<String, (StatusCode, serde_json::Value)> {
    let canonical = fs::canonicalize(path).map_err(|err| {
        warn!(path, error = %err, "{route}: transcript_path unresolvable");
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            serde_json::json!({"error": format!("transcript_path unresolvable: {err}")}),
        )
    })?;

    if !transcript_path_allowed(&canonical) {
        warn!(
            path = %canonical.display(),
            "{route}: transcript_path outside allowed roots"
        );
        return Err((
            StatusCode::FORBIDDEN,
            serde_json::json!({"error": "transcript_path outside allowed workspace roots"}),
        ));
    }

    let metadata = fs::metadata(&canonical).map_err(|err| {
        warn!(path = %canonical.display(), error = %err, "{route}: transcript_path metadata failed");
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            serde_json::json!({"error": format!("transcript_path metadata failed: {err}")}),
        )
    })?;

    if !metadata.is_file() {
        warn!(
            path = %canonical.display(),
            "{route}: transcript_path is not a regular file"
        );
        return Err((
            StatusCode::BAD_REQUEST,
            serde_json::json!({"error": "transcript_path must point to a regular file"}),
        ));
    }

    let file_len = metadata.len() as usize;
    if file_len > MAX_TRANSCRIPT_BYTES {
        warn!(
            path = %canonical.display(),
            bytes = file_len,
            limit = MAX_TRANSCRIPT_BYTES,
            "{route}: transcript_path exceeds size limit"
        );
        return Err((
            StatusCode::PAYLOAD_TOO_LARGE,
            serde_json::json!({
                "error": format!("transcript_path exceeds {MAX_TRANSCRIPT_BYTES} byte limit")
            }),
        ));
    }

    fs::read_to_string(&canonical).map_err(|err| {
        warn!(path = %canonical.display(), error = %err, "{route}: transcript_path read failed");
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            serde_json::json!({"error": format!("transcript_path read failed: {err}")}),
        )
    })
}

/// Hard cap on transcript content accepted by session-end.  Prevents a DoS /
/// disk-growth attack via an oversized file or inline payload.  Matches the
/// TS daemon's MAX_TRANSCRIPT_CHARS safety cap (100 000 chars), applied here
/// at the byte level before any allocation.  Content exceeding this limit is
/// truncated with a `[truncated]` marker before artifact / DB writes.
const MAX_TRANSCRIPT_BYTES: usize = 400_000; // ~100k chars * 4 bytes/char (UTF-8 worst case)
const MIN_PROMPT_ENTITY_MATCH_CHARS: usize = 3;
const ENTITY_CONTEXT_MAX_ATTRIBUTES_PER_ASPECT: i64 = 48;

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

fn normalize_session_transcript(raw: &str) -> String {
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

    // Fall back to raw only when the input does not look like JSONL
    // conversation data. If it is JSONL and we extracted zero turns, return
    // the empty normalized view so tool-only logs do not pollute summaries.
    if parsed * 10 < lines.len() * 6 {
        raw.to_string()
    } else {
        normalized.join("\n")
    }
}

fn normalize_json_transcript_line(value: &serde_json::Value) -> Option<String> {
    if value.get("type").and_then(serde_json::Value::as_str) == Some("item.completed") {
        let item = value.get("item")?;
        if item.get("type").and_then(serde_json::Value::as_str) == Some("agent_message") {
            let text = extract_json_message_text(item)?;
            return Some(format!("Assistant: {text}"));
        }
    }

    if value.get("type").and_then(serde_json::Value::as_str) == Some("event_msg") {
        let payload = value.get("payload")?;
        if payload.get("type").and_then(serde_json::Value::as_str) == Some("user_message") {
            let text = extract_json_string(payload, &["message", "text", "content"])?;
            return Some(format!("User: {text}"));
        }
    }

    if let Some(message) = value.get("message").and_then(serde_json::Value::as_object) {
        let role = extract_json_string_from_map(message, &["role", "speaker"]);
        let text = extract_json_message_text_from_map(message);
        match (role.as_deref(), text) {
            (Some("user"), Some(text)) => return Some(format!("User: {text}")),
            (Some("assistant"), Some(text)) => return Some(format!("Assistant: {text}")),
            _ => {}
        }
    }

    let role = extract_json_string(value, &["role", "speaker"]);
    let text = extract_json_message_text(value);
    match (role.as_deref(), text) {
        (Some("user"), Some(text)) => Some(format!("User: {text}")),
        (Some("assistant"), Some(text)) => Some(format!("Assistant: {text}")),
        _ => None,
    }
}

fn extract_json_string(value: &serde_json::Value, keys: &[&str]) -> Option<String> {
    let obj = value.as_object()?;
    extract_json_string_from_map(obj, keys)
}

fn extract_json_string_from_map(
    obj: &serde_json::Map<String, serde_json::Value>,
    keys: &[&str],
) -> Option<String> {
    keys.iter().find_map(|key| {
        obj.get(*key)
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .map(|text| text.replace(['\r', '\n'], " "))
    })
}

fn extract_json_message_text(value: &serde_json::Value) -> Option<String> {
    if let Some(text) = extract_json_string(value, &["content", "text", "message"]) {
        return Some(text);
    }

    let content = value.get("content")?.as_array()?;
    extract_json_text_parts(content)
}

fn extract_json_message_text_from_map(
    obj: &serde_json::Map<String, serde_json::Value>,
) -> Option<String> {
    if let Some(text) = extract_json_string_from_map(obj, &["content", "text", "message"]) {
        return Some(text);
    }

    let content = obj.get("content")?.as_array()?;
    extract_json_text_parts(content)
}

fn extract_json_text_parts(content: &[serde_json::Value]) -> Option<String> {
    let parts = content
        .iter()
        .filter_map(|item| {
            let obj = item.as_object()?;
            if obj.get("type").and_then(serde_json::Value::as_str) != Some("text") {
                return None;
            }
            extract_json_string_from_map(obj, &["text", "content"])
        })
        .collect::<Vec<_>>();
    if parts.is_empty() {
        None
    } else {
        Some(parts.join(" "))
    }
}

fn session_transcript_content(
    conn: &rusqlite::Connection,
    session_key: &str,
    agent_id: &str,
) -> rusqlite::Result<Option<String>> {
    let mut stmt = conn.prepare(
        "SELECT content FROM session_transcripts WHERE session_key = ?1 AND agent_id = ?2 LIMIT 1",
    )?;
    let mut rows = stmt.query(rusqlite::params![session_key, agent_id])?;
    if let Some(row) = rows.next()? {
        return row.get(0).map(Some);
    }
    Ok(None)
}

fn audit_fs_timestamp(iso: &str) -> String {
    iso.chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.') {
                ch
            } else {
                '-'
            }
        })
        .collect()
}

fn is_safe_audit_name(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

fn build_audit_path(root: &Path, file_name: &str) -> std::io::Result<PathBuf> {
    if !is_safe_audit_name(file_name) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "invalid transcript audit file name",
        ));
    }
    workspace_paths::child_file(root, &[".daemon", "logs", "transcripts", file_name])
}

fn resolve_audit_token(
    agent_id: &str,
    session_id: &str,
    session_key: Option<&str>,
    raw: &str,
) -> String {
    let scoped = if !session_id.trim().is_empty() {
        session_id.trim().to_string()
    } else if let Some(key) = session_key.map(str::trim).filter(|key| !key.is_empty()) {
        key.to_string()
    } else {
        let mut digest = Sha256::new();
        digest.update(raw.as_bytes());
        digest
            .finalize()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>()
    };
    let mut digest = Sha256::new();
    digest.update(agent_id.as_bytes());
    digest.update(b":");
    digest.update(scoped.as_bytes());
    let bytes = digest.finalize();
    bytes[..8]
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>()
}

fn write_transcript_audit(
    root: &Path,
    agent_id: &str,
    session_id: &str,
    session_key: Option<&str>,
    raw_transcript: &str,
    captured_at: Option<&str>,
) -> std::io::Result<()> {
    if raw_transcript.trim().is_empty() {
        return Ok(());
    }
    let token = resolve_audit_token(agent_id, session_id, session_key, raw_transcript);
    let latest = build_audit_path(root, &format!("{token}--latest.log"))?;
    fs::write(latest, raw_transcript)?;
    if let Some(captured_at) = captured_at {
        let final_path = build_audit_path(
            root,
            &format!(
                "{}--{}--raw-transcript.log",
                audit_fs_timestamp(captured_at),
                token
            ),
        )?;
        fs::write(final_path, raw_transcript)?;
    }
    Ok(())
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

fn delete_session_transcript(
    conn: &rusqlite::Connection,
    session_key: &str,
    agent_id: &str,
) -> rusqlite::Result<()> {
    if session_key.trim().is_empty() {
        return Ok(());
    }
    conn.execute(
        "DELETE FROM session_transcripts WHERE session_key = ?1 AND agent_id = ?2",
        rusqlite::params![session_key, agent_id],
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
    dedupe: bool,
) -> rusqlite::Result<String> {
    // Idempotency: check for an existing non-dead job for (agent_id, session_id, trigger).
    // 'dead' is excluded so a fresh retry can create a new job after permanent failure.
    // 'processing' is an older alias for 'leased' kept for schema compatibility.
    //
    // Completed/done jobs → return the existing id (summary already produced).
    // Active jobs (pending/leased/processing) → update transcript in case the
    //   retry has fresher content (e.g. a previously truncated payload is now
    //   complete); return the existing id to avoid duplicating the job.
    if dedupe
        && let Ok((existing_id, existing_status)) = conn.query_row(
            "SELECT id, status FROM summary_jobs \
         WHERE agent_id = ?1 AND session_id = ?2 AND trigger = ?3 \
         AND status IN ('pending', 'leased', 'processing', 'completed', 'done') LIMIT 1",
            rusqlite::params![agent_id, session_id, trigger],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
    {
        if existing_status == "pending"
            || existing_status == "leased"
            || existing_status == "processing"
        {
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
        && let ClaimResult::Conflict { claimed_by } =
            state.sessions.claim(&session_key, p, &agent_id)
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
                "inject": format!("{}\n[memory active | /remember | /recall]\nCurrent date: {}", build_signet_system_prompt(), now.format("%Y-%m-%d %H:%M")),
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
            let mut inject = String::new();
            inject.push_str(build_signet_system_prompt());
            // TS: injectParts.join("\n") with prompt ending \n produces a blank line here
            inject.push('\n');
            inject.push_str("[memory active | /remember | /recall]\n");
            inject.push_str(&format!("Current date: {}\n", now.format("%Y-%m-%d %H:%M")));

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
    pub transcript: Option<String>,
    pub transcript_path: Option<String>,
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

fn cap_prompt_inject(text: &str, limit: usize) -> String {
    if limit == 0 {
        return String::new();
    }
    if text.len() <= limit {
        return text.to_string();
    }
    let suffix = "...";
    let keep = limit.saturating_sub(suffix.len());
    let mut end = keep;
    while !text.is_char_boundary(end) && end > 0 {
        end -= 1;
    }
    if keep == 0 {
        return text.chars().take(limit).collect();
    }
    format!("{}{}", &text[..end], suffix)
}

fn normalize_prompt_entity_text(text: &str) -> String {
    let mut terms = Vec::new();
    let mut current = String::new();
    for ch in text.to_lowercase().replace('’', "'").chars() {
        if ch.is_ascii_alphanumeric() || ch == '\'' {
            current.push(ch);
        } else if !current.is_empty() {
            push_prompt_entity_term(&mut terms, &current);
            current.clear();
        }
    }
    if !current.is_empty() {
        push_prompt_entity_term(&mut terms, &current);
    }
    terms.join(" ")
}

fn push_prompt_entity_term(terms: &mut Vec<String>, raw: &str) {
    let token = raw
        .strip_suffix("'s")
        .or_else(|| raw.strip_suffix('\''))
        .unwrap_or(raw);
    for part in token.split('\'') {
        if !part.is_empty() {
            terms.push(part.to_string());
        }
    }
}

fn prompt_entity_terms(text: &str) -> Vec<String> {
    normalize_prompt_entity_text(text)
        .split_whitespace()
        .map(str::to_string)
        .collect()
}

fn prompt_bare_possessive_allowed(phrase_term: &str) -> bool {
    phrase_term.len() >= 4
        && !matches!(
            phrase_term,
            "agent"
                | "artifact"
                | "concept"
                | "connector"
                | "document"
                | "event"
                | "memory"
                | "policy"
                | "preference"
                | "product"
                | "project"
                | "skill"
                | "source"
                | "system"
                | "task"
                | "tool"
                | "workflow"
        )
}

fn prompt_entity_term_matches(prompt_term: &str, phrase_term: &str) -> bool {
    prompt_term == phrase_term
        || (prompt_bare_possessive_allowed(phrase_term) && prompt_term == format!("{phrase_term}s"))
}

fn prompt_phrase_span(prompt: &str, phrase: &str) -> Option<(usize, usize)> {
    let prompt_terms = prompt_entity_terms(prompt);
    let phrase_terms = prompt_entity_terms(phrase);
    if phrase_terms.join(" ").len() < MIN_PROMPT_ENTITY_MATCH_CHARS
        || phrase_terms.is_empty()
        || phrase_terms.len() > prompt_terms.len()
    {
        return None;
    }
    for start in 0..=(prompt_terms.len() - phrase_terms.len()) {
        if phrase_terms
            .iter()
            .enumerate()
            .all(|(offset, term)| prompt_entity_term_matches(&prompt_terms[start + offset], term))
        {
            return Some((start, start + phrase_terms.len()));
        }
    }
    None
}

fn prompt_spans_overlap(a: (usize, usize), b: (usize, usize)) -> bool {
    a.0 < b.1 && b.0 < a.1
}

fn prompt_entity_context_type_allowed(entity_type: &str) -> bool {
    matches!(
        entity_type.to_ascii_lowercase().as_str(),
        "person" | "project"
    )
}

fn prompt_generic_entity_phrase(phrase_terms: &[String]) -> bool {
    if phrase_terms.len() != 1 {
        return false;
    }
    let term = phrase_terms[0].as_str();
    if !prompt_bare_possessive_allowed(term) {
        return true;
    }
    term.strip_suffix('s')
        .is_some_and(|singular| !prompt_bare_possessive_allowed(singular))
}

fn prompt_role_entity(row: &PromptEntityRow) -> bool {
    if row.pinned.clamp(0, 1) > 0 {
        return false;
    }
    let entity_terms = prompt_entity_terms(&row.entity_name);
    let matched_terms = prompt_entity_terms(&row.matched_text);
    if entity_terms.len() != 1 || matched_terms.len() != 1 {
        return false;
    }
    matches!(entity_terms[0].as_str(), "assistant" | "human" | "user")
        && matches!(matched_terms[0].as_str(), "assistant" | "human" | "user")
}

fn prompt_broad_uncategorized_attribute(group: &str, claim: &str) -> bool {
    normalize_prompt_entity_text(group) == "general"
        && normalize_prompt_entity_text(claim) == "uncategorized"
}

fn prompt_generic_context_query(context_terms: &HashSet<String>) -> bool {
    !context_terms.is_empty()
        && context_terms.iter().all(|term| {
            matches!(
                term.as_str(),
                "context" | "contexts" | "current" | "prompt" | "relevant" | "view" | "views"
            )
        })
}

fn score_prompt_entity_candidate(
    match_source: &str,
    matched_text: &str,
    mentions: i64,
    pinned: i64,
) -> f64 {
    let phrase = normalize_prompt_entity_text(matched_text);
    let phrase_terms = prompt_entity_terms(matched_text);
    phrase_terms.len() as f64 * 8.0
        + phrase.len() as f64 * 0.35
        + (mentions.max(0) as f64).ln_1p()
        + pinned.clamp(0, 1) as f64 * 8.0
        + if match_source == "alias" { -0.25 } else { 0.0 }
}

#[derive(Clone)]
struct PromptEntityRow {
    entity_id: String,
    entity_name: String,
    entity_type: String,
    matched_text: String,
    match_source: String,
    mentions: i64,
    pinned: i64,
}

#[derive(Clone)]
struct PromptEntityCandidate {
    row: PromptEntityRow,
    normalized_phrase: String,
    span_start: usize,
    span_end: usize,
    score: f64,
}

fn is_low_signal_prompt(prompt: &str) -> bool {
    let normalized = normalize_prompt_entity_text(prompt);
    if normalized.is_empty() {
        return true;
    }
    matches!(
        normalized.as_str(),
        "cool"
            | "got it"
            | "go ahead"
            | "great"
            | "k"
            | "kk"
            | "nice"
            | "ok"
            | "okay"
            | "okay cool"
            | "sounds good"
            | "sure"
            | "thanks"
            | "thank you"
            | "yes"
            | "yes please"
            | "yep"
    )
}

fn is_prompt_context_term(term: &str) -> bool {
    term.len() >= 3
        && !matches!(
            term,
            "about"
                | "actually"
                | "after"
                | "all"
                | "also"
                | "and"
                | "any"
                | "are"
                | "before"
                | "but"
                | "can"
                | "could"
                | "did"
                | "does"
                | "doing"
                | "done"
                | "for"
                | "from"
                | "get"
                | "had"
                | "has"
                | "have"
                | "hey"
                | "how"
                | "into"
                | "its"
                | "just"
                | "kind"
                | "like"
                | "make"
                | "more"
                | "need"
                | "now"
                | "okay"
                | "our"
                | "out"
                | "please"
                | "pretty"
                | "really"
                | "right"
                | "say"
                | "should"
                | "some"
                | "something"
                | "still"
                | "sure"
                | "thanks"
                | "thank"
                | "that"
                | "the"
                | "their"
                | "them"
                | "then"
                | "there"
                | "these"
                | "they"
                | "this"
                | "too"
                | "use"
                | "very"
                | "want"
                | "was"
                | "well"
                | "were"
                | "what"
                | "when"
                | "which"
                | "who"
                | "why"
                | "will"
                | "with"
                | "would"
                | "yeah"
                | "yes"
                | "you"
                | "your"
        )
        && !term.chars().all(|ch| ch.is_ascii_digit())
}

fn f32_vector_from_blob(blob: &[u8]) -> Vec<f32> {
    blob.chunks_exact(4)
        .map(|chunk| f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
        .collect()
}

fn cosine_similarity(a: &[f32], b: &[f32]) -> f64 {
    let mut dot = 0.0_f64;
    let mut norm_a = 0.0_f64;
    let mut norm_b = 0.0_f64;
    for (left, right) in a.iter().zip(b.iter()) {
        let left = f64::from(*left);
        let right = f64::from(*right);
        dot += left * right;
        norm_a += left * left;
        norm_b += right * right;
    }
    let denom = norm_a.sqrt() * norm_b.sqrt();
    if denom > 0.0 { dot / denom } else { 0.0 }
}

fn memory_embedding_score(
    conn: &rusqlite::Connection,
    memory_id: &str,
    agent_id: &str,
    query_vector: Option<&[f32]>,
) -> f64 {
    let Some(query_vector) = query_vector else {
        return 0.0;
    };
    let vectors = match conn.prepare(
        "SELECT vector, dimensions
         FROM embeddings
         WHERE source_type = 'memory'
           AND source_id = ?1
           AND agent_id = ?2
           AND vector IS NOT NULL",
    ) {
        Ok(mut stmt) => stmt
            .query_map(rusqlite::params![memory_id, agent_id], |row| {
                Ok((row.get::<_, Vec<u8>>(0)?, row.get::<_, usize>(1)?))
            })
            .ok()
            .map(|rows| rows.filter_map(|r| r.ok()).collect::<Vec<_>>())
            .unwrap_or_default(),
        Err(_) => vec![],
    };
    vectors
        .iter()
        .filter(|(blob, dimensions)| {
            *dimensions == query_vector.len() && blob.len() == query_vector.len() * 4
        })
        .map(|(blob, _)| cosine_similarity(query_vector, &f32_vector_from_blob(blob)))
        .fold(0.0, f64::max)
}

fn build_entity_context_inject(metadata_header: &str, lines: &[String]) -> String {
    let mut parts = vec![
        metadata_header.trim_end().to_string(),
        String::new(),
        "## Relevant Entity Context".to_string(),
        String::new(),
    ];
    parts.extend_from_slice(lines);
    format!("{}\n", parts.join("\n").trim_end())
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
    let terms: Vec<String> = normalize_prompt_entity_text(&cleaned)
        .split_whitespace()
        .filter(|w| is_prompt_context_term(w))
        .map(str::to_string)
        .take(12)
        .collect();
    let query_terms = terms.join(" ");
    let metadata_header = format_metadata_header();
    let agent_id = body
        .agent_id
        .clone()
        .unwrap_or_else(|| "default".to_string());

    // Record in continuity tracker
    if let Some(key) = &body.session_key {
        let snippet = if cleaned.len() > 200 {
            &cleaned[..200]
        } else {
            cleaned.as_str()
        };
        state.continuity.record_prompt(key, &query_terms, snippet);
    }

    if let Some(session_key_value) = body.session_key.clone() {
        let mut raw_transcript = body.transcript.clone().unwrap_or_default();
        if raw_transcript.is_empty()
            && let Some(path) = body.transcript_path.as_deref()
            && !path.trim().is_empty()
        {
            let canonical = match fs::canonicalize(path) {
                Ok(value) => value,
                Err(e) => {
                    warn!(path, error = %e, "prompt-submit: transcript_path unresolvable");
                    return (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        Json(serde_json::json!({"error": format!("transcript_path unresolvable: {e}")})),
                    )
                        .into_response();
                }
            };
            if !transcript_path_allowed(&canonical) {
                warn!(path = %canonical.display(), "prompt-submit: transcript_path outside allowed roots");
                return (
                    StatusCode::FORBIDDEN,
                    Json(serde_json::json!({"error": "transcript_path outside allowed workspace roots"})),
                )
                    .into_response();
            }
            match fs::read_to_string(&canonical) {
                Ok(content) => raw_transcript = content,
                Err(e) => {
                    warn!(path = %canonical.display(), error = %e, "prompt-submit: transcript read failed")
                }
            }
        }

        let normalized = normalize_session_transcript(&raw_transcript);
        if !normalized.trim().is_empty() {
            let harness_value = harness.to_string();
            let project_value = body.project.clone();
            let agent_value = agent_id.clone();
            let session_key_for_write = session_key_value.clone();
            let normalized_for_write = normalized.clone();
            let normalized_len = normalized_for_write.len();
            if let Err(e) = state
                .pool
                .write(Priority::Low, move |conn| {
                    let should_write =
                        session_transcript_content(conn, &session_key_for_write, &agent_value)?
                            .is_none_or(|value| normalized_len >= value.len());
                    if !should_write {
                        return Ok(serde_json::Value::Bool(false));
                    }
                    upsert_session_transcript(
                        conn,
                        &session_key_for_write,
                        &normalized_for_write,
                        &harness_value,
                        project_value.as_deref(),
                        &agent_value,
                    )
                    .map(|_| serde_json::Value::Bool(true))
                    .map_err(|err| signet_core::error::CoreError::Migration(err.to_string()))
                })
                .await
            {
                warn!(error = %e, session_key = %session_key_value, "prompt-submit: transcript upsert failed");
            }
        }

        if !raw_transcript.trim().is_empty()
            && let Err(e) = write_transcript_audit(
                &state.config.base_path,
                &agent_id,
                &session_key_value,
                Some(session_key_value.as_str()),
                &raw_transcript,
                None,
            )
        {
            warn!(error = %e, session_key = %session_key_value, "prompt-submit: transcript audit write failed");
        }
    }

    if query_terms.is_empty() || is_low_signal_prompt(&cleaned) {
        return (
            StatusCode::OK,
            Json(serde_json::json!({
                "inject": "",
                "memoryCount": 0,
                "queryTerms": query_terms,
                "engine": if query_terms.is_empty() { "no-entity" } else { "low-signal" },
            })),
        )
            .into_response();
    }

    let query_terms_for_resp = query_terms.clone();
    let min_score = state
        .config
        .manifest
        .hooks
        .as_ref()
        .map(|h| h.user_prompt_submit.min_score)
        .filter(|score| score.is_finite())
        .map(|score| score.clamp(0.0, 1.0))
        .unwrap_or(0.8);
    let max_inject_chars = state
        .config
        .manifest
        .hooks
        .as_ref()
        .map(|h| h.user_prompt_submit.max_inject_chars)
        .unwrap_or(500);
    let semantic_query = query_terms.clone();
    let embedding_provider = state.embedding.read().await.clone();
    let query_vector_for_scoring = match embedding_provider {
        Some(provider) if !semantic_query.trim().is_empty() => {
            provider.embed(&semantic_query).await
        }
        _ => None,
    };

    let result = state
			.pool
			.read(move |conn| {
            let has_aliases = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master
                     WHERE type = 'table'
                       AND name IN ('entities', 'entity_aspects', 'entity_attributes', 'entity_aliases')",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap_or(0)
                == 4;
            if !has_aliases {
                return Ok(serde_json::json!({
                    "inject": "",
                    "memoryCount": 0,
                    "queryTerms": query_terms_for_resp,
                    "engine": "no-entity",
                }));
            }

            let entity_rows = match conn.prepare(
                "SELECT id, name, COALESCE(entity_type, 'unknown') AS entity_type,
                        COALESCE(canonical_name, LOWER(name)) AS matched_text,
                        'name' AS source, COALESCE(mentions, 0) AS mentions,
                        COALESCE(pinned, 0) AS pinned
                 FROM entities
                 WHERE agent_id = ?1
                   AND COALESCE(status, 'active') = 'active'
                 UNION ALL
                 SELECT e.id, e.name, COALESCE(e.entity_type, 'unknown') AS entity_type,
                        a.alias AS matched_text,
                        'alias' AS source, COALESCE(e.mentions, 0) AS mentions,
                        COALESCE(e.pinned, 0) AS pinned
                 FROM entity_aliases a
                 JOIN entities e ON e.id = a.entity_id AND e.agent_id = a.agent_id
                 WHERE a.agent_id = ?1
                   AND a.status = 'active'
                   AND COALESCE(e.status, 'active') = 'active'",
            ) {
                Ok(mut stmt) => stmt
                    .query_map([agent_id.clone()], |row| {
                        Ok(PromptEntityRow {
                            entity_id: row.get::<_, String>(0)?,
                            entity_name: row.get::<_, String>(1)?,
                            entity_type: row.get::<_, String>(2)?,
                            matched_text: row.get::<_, String>(3)?,
                            match_source: row.get::<_, String>(4)?,
                            mentions: row.get::<_, i64>(5)?,
                            pinned: row.get::<_, i64>(6)?,
                        })
                    })
                    .ok()
                    .map(|rows| rows.filter_map(|r| r.ok()).collect::<Vec<_>>())
                    .unwrap_or_default(),
                Err(_) => vec![],
            };

            let mut candidates_by_phrase = HashMap::<String, Vec<PromptEntityCandidate>>::new();
            for row in entity_rows {
                if !prompt_entity_context_type_allowed(&row.entity_type)
                    || prompt_role_entity(&row)
                    || prompt_generic_entity_phrase(&prompt_entity_terms(&row.matched_text))
                {
                    continue;
                }
                let Some((span_start, span_end)) = prompt_phrase_span(&cleaned, &row.matched_text) else {
                    continue;
                };
                let normalized_phrase = normalize_prompt_entity_text(&row.matched_text);
                let score = score_prompt_entity_candidate(
                    &row.match_source,
                    &row.matched_text,
                    row.mentions,
                    row.pinned,
                );
                candidates_by_phrase
                    .entry(normalized_phrase.clone())
                    .or_default()
                    .push(PromptEntityCandidate {
                        row,
                        normalized_phrase,
                        span_start,
                        span_end,
                        score,
                    });
            }

            let mut phrase_winners = candidates_by_phrase
                .into_values()
                .filter_map(|mut candidates| {
                    candidates.sort_by(|a, b| {
                        b.score
                            .partial_cmp(&a.score)
                            .unwrap_or(std::cmp::Ordering::Equal)
                            .then_with(|| b.row.mentions.cmp(&a.row.mentions))
                            .then_with(|| b.normalized_phrase.len().cmp(&a.normalized_phrase.len()))
                            .then_with(|| a.row.entity_name.cmp(&b.row.entity_name))
                    });
                    candidates.into_iter().next()
                })
                .collect::<Vec<_>>();
            let top_score = phrase_winners
                .iter()
                .map(|candidate| candidate.score)
                .fold(0.0, f64::max);
            let minimum_score = 12.0_f64.max(top_score * 0.45);
            phrase_winners.retain(|candidate| candidate.score >= minimum_score);
            phrase_winners.sort_by(|a, b| {
                b.score
                    .partial_cmp(&a.score)
                    .unwrap_or(std::cmp::Ordering::Equal)
                    .then_with(|| {
                        (b.span_end - b.span_start).cmp(&(a.span_end - a.span_start))
                    })
                    .then_with(|| b.row.mentions.cmp(&a.row.mentions))
                    .then_with(|| a.row.entity_name.cmp(&b.row.entity_name))
            });

            let mut seen = HashSet::new();
            let mut selected_spans = Vec::new();
            let mut entity_matches = Vec::new();
            for candidate in phrase_winners {
                if !seen.insert(candidate.row.entity_id.clone()) {
                    continue;
                }
                let span = (candidate.span_start, candidate.span_end);
                if selected_spans
                    .iter()
                    .any(|selected| prompt_spans_overlap(*selected, span))
                {
                    continue;
                }
                selected_spans.push(span);
                entity_matches.push(candidate.row);
                if entity_matches.len() >= 2 {
                    break;
                }
            }
            if entity_matches.is_empty() {
                return Ok(serde_json::json!({
                    "inject": "",
                    "memoryCount": 0,
                    "queryTerms": query_terms_for_resp,
                    "engine": "no-entity",
                }));
            }

            let prompt_terms = normalize_prompt_entity_text(&cleaned)
                .split_whitespace()
                .filter(|term| is_prompt_context_term(term))
                .map(str::to_string)
                .collect::<HashSet<_>>();
            let all_entity_terms = entity_matches
                .iter()
                .flat_map(|entity| {
                    normalize_prompt_entity_text(&format!(
                        "{} {}",
                        entity.entity_name, entity.matched_text
                    ))
                    .split_whitespace()
                    .map(str::to_string)
                    .collect::<Vec<_>>()
                })
                .collect::<HashSet<_>>();
            let mut lines = Vec::new();
            for entity in entity_matches {
                let context_terms = prompt_terms
                    .iter()
                    .filter(|term| {
                        !all_entity_terms
                            .iter()
                            .any(|entity_term| prompt_entity_term_matches(term, entity_term))
                    })
                    .cloned()
                    .collect::<HashSet<_>>();
                let aspects = match conn.prepare(
                    "SELECT id, name, canonical_name, weight
                     FROM entity_aspects
                     WHERE entity_id = ?1
                       AND agent_id = ?2
                       AND COALESCE(status, 'active') = 'active'
                     ORDER BY weight DESC, name ASC
                     LIMIT 12",
                ) {
                    Ok(mut stmt) => stmt
                        .query_map(rusqlite::params![&entity.entity_id, agent_id.clone()], |row| {
                            Ok((
                                row.get::<_, String>(0)?,
                                row.get::<_, String>(1)?,
                                row.get::<_, String>(2)?,
                                row.get::<_, f64>(3)?,
                            ))
                        })
                        .ok()
                        .map(|rows| rows.filter_map(|r| r.ok()).collect::<Vec<_>>())
                        .unwrap_or_default(),
                    Err(_) => vec![],
                };
                let mut selected_aspects = Vec::new();
                for (aspect_id, aspect_name, _canonical_name, _weight) in aspects {
                    let generic_context_query = prompt_generic_context_query(&context_terms);
                    let attr_rows = match conn.prepare(
                        "SELECT ea.id, ea.content, COALESCE(ea.memory_id, ''),
                                COALESCE(ea.group_key, ''), COALESCE(ea.claim_key, ''),
                                ea.confidence, ea.importance
                         FROM entity_attributes ea
                         WHERE ea.aspect_id = ?1
                           AND ea.agent_id = ?2
                           AND NOT (COALESCE(ea.group_key, 'general') = 'general'
                             AND COALESCE(ea.claim_key, 'uncategorized') = 'uncategorized')
                           AND ea.status = 'active'
                           AND ea.superseded_by IS NULL
                           AND NOT EXISTS (
                             SELECT 1
                             FROM entity_attributes newer
                             WHERE newer.aspect_id = ea.aspect_id
                               AND newer.agent_id = ea.agent_id
                               AND newer.kind = ea.kind
                               AND COALESCE(newer.group_key, 'general') = COALESCE(ea.group_key, 'general')
                               AND newer.claim_key = ea.claim_key
                               AND newer.status = 'active'
                               AND newer.superseded_by IS NULL
                               AND COALESCE(newer.version, 1) > COALESCE(ea.version, 1)
                           )
                         ORDER BY ea.importance DESC, ea.updated_at DESC
                         LIMIT ?3",
                    ) {
                        Ok(mut stmt) => stmt
                            .query_map(
                                rusqlite::params![
                                    aspect_id,
                                    agent_id.clone(),
                                    ENTITY_CONTEXT_MAX_ATTRIBUTES_PER_ASPECT
                                ],
                                |row| {
                                Ok((
                                    row.get::<_, String>(0)?,
                                    row.get::<_, String>(1)?,
                                    row.get::<_, String>(2)?,
                                    row.get::<_, String>(3)?,
                                    row.get::<_, String>(4)?,
                                    row.get::<_, f64>(5)?,
                                    row.get::<_, f64>(6)?,
                                ))
                                },
                            )
                            .ok()
                            .map(|rows| rows.filter_map(|r| r.ok()).collect::<Vec<_>>())
                            .unwrap_or_default(),
                        Err(_) => vec![],
                    };
                    if attr_rows.is_empty() || context_terms.is_empty() {
                        continue;
                    }
                    let matched_attr_ids = attr_rows
                        .iter()
                        .filter_map(|(attr_id, content, memory_id, group, claim, confidence, importance)| {
                            let attr_text = normalize_prompt_entity_text(content);
                            let group_text = normalize_prompt_entity_text(group);
                            let claim_text = normalize_prompt_entity_text(claim);
                            let content_overlap = attr_text
                                .split_whitespace()
                                .any(|term| context_terms.contains(term));
                            let claim_overlap = claim_text
                                .split_whitespace()
                                .filter(|term| context_terms.contains(*term))
                                .count();
                            let group_overlap = if claim_overlap > 0 {
                                group_text
                                    .split_whitespace()
                                    .filter(|term| context_terms.contains(*term))
                                    .count()
                            } else {
                                0
                            };
                            let path_overlap = claim_overlap + group_overlap > 0;
                            let lexical_score = if content_overlap || path_overlap {
                                let base = if path_overlap { 0.8 } else { 0.72 };
                                base + importance.clamp(0.0, 1.0) * 0.18
                                    + confidence.clamp(0.0, 1.0) * 0.1
                            } else {
                                0.0
                            };
                            let semantic_score = if memory_id.is_empty() {
                                0.0
                            } else {
                                memory_embedding_score(
                                    conn,
                                    memory_id,
                                    &agent_id,
                                    query_vector_for_scoring.as_deref(),
                                )
                            };
                            if generic_context_query && lexical_score == 0.0 {
                                None
                            } else {
                                let score = lexical_score.max(semantic_score);
                                (score >= min_score).then(|| attr_id.clone())
                            }
                        })
                        .collect::<HashSet<_>>();
                    if !matched_attr_ids.is_empty() {
                        selected_aspects.push((aspect_id, aspect_name, matched_attr_ids));
                    }
                    if selected_aspects.len() >= 3 {
                        break;
                    }
                }
                for (aspect_id, aspect_name, matched_attr_ids) in selected_aspects {
                    let attrs = match conn.prepare(
                        "SELECT ea.id, ea.kind, ea.content, COALESCE(ea.group_key, 'general'), COALESCE(ea.claim_key, 'uncategorized'),
                                COALESCE(ea.source_kind, ''), COALESCE(ea.source_id, ''), COALESCE(ea.memory_id, ''),
                                COALESCE(ea.version, 1)
                         FROM entity_attributes ea
                         WHERE ea.aspect_id = ?1
                           AND ea.agent_id = ?2
                           AND NOT (COALESCE(ea.group_key, 'general') = 'general'
                             AND COALESCE(ea.claim_key, 'uncategorized') = 'uncategorized')
                           AND ea.status = 'active'
                           AND ea.superseded_by IS NULL
                           AND NOT EXISTS (
                             SELECT 1
                             FROM entity_attributes newer
                             WHERE newer.aspect_id = ea.aspect_id
                               AND newer.agent_id = ea.agent_id
                               AND newer.kind = ea.kind
                               AND COALESCE(newer.group_key, 'general') = COALESCE(ea.group_key, 'general')
                               AND newer.claim_key = ea.claim_key
                               AND newer.status = 'active'
                               AND newer.superseded_by IS NULL
                               AND COALESCE(newer.version, 1) > COALESCE(ea.version, 1)
                           )
                         ORDER BY CASE ea.kind WHEN 'constraint' THEN 0 ELSE 1 END, ea.importance DESC, ea.updated_at DESC
                         LIMIT 8",
                    ) {
                        Ok(mut stmt) => stmt
                            .query_map(
                                rusqlite::params![
                                    aspect_id,
                                    agent_id.clone()
                                ],
                                |row| {
                                Ok((
                                    row.get::<_, String>(0)?,
                                    row.get::<_, String>(1)?,
                                    row.get::<_, String>(2)?,
                                    row.get::<_, String>(3)?,
                                    row.get::<_, String>(4)?,
                                    row.get::<_, String>(5)?,
                                    row.get::<_, String>(6)?,
                                    row.get::<_, String>(7)?,
                                    row.get::<_, i64>(8)?,
                                ))
                                },
                            )
                            .ok()
                            .map(|rows| rows.filter_map(|r| r.ok()).collect::<Vec<_>>())
                            .unwrap_or_default(),
                        Err(_) => vec![],
                    };
                    for (attr_id, kind, content, group, claim, source_kind, source_id, memory_id, version) in attrs {
                        if !matched_attr_ids.contains(&attr_id) {
                            continue;
                        }
                        if prompt_broad_uncategorized_attribute(&group, &claim) {
                            continue;
                        }
                        let source = if !source_kind.is_empty() && !source_id.is_empty() {
                            format!("{source_kind}:{source_id}")
                        } else if !memory_id.is_empty() {
                            format!("memory:{memory_id}")
                        } else {
                            format!("v{version}")
                        };
                        lines.push(format!(
                            "- [{kind}] {} / {aspect_name} / {group} / {claim}: {} ({source})",
                            entity.entity_name,
                            trim_for_inject(&content, 240)
                        ));
                        if lines.len() >= 8 {
                            break;
                        }
                    }
                    if lines.len() >= 8 {
                        break;
                    }
                }
                if lines.len() >= 8 {
                    break;
                }
            }

            if lines.is_empty() {
                return Ok(serde_json::json!({
                    "inject": "",
                    "memoryCount": 0,
                    "queryTerms": query_terms_for_resp,
                    "engine": "no-aspect-hit",
                }));
            }

			let inject = build_entity_context_inject(&metadata_header, &lines);
			Ok(serde_json::json!({
				"inject": cap_prompt_inject(&inject, max_inject_chars),
				"memoryCount": lines.len(),
				"queryTerms": query_terms_for_resp,
				"engine": "entity-context",
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
        headers
            .get("x-signet-agent-id")
            .and_then(|v| v.to_str().ok()),
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
                    Json(
                        serde_json::json!({"error": format!("transcript_path unresolvable: {e}")}),
                    ),
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
                Json(
                    serde_json::json!({"error": "transcript_path outside allowed workspace roots"}),
                ),
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
    let mut normalized = normalize_session_transcript(&transcript);
    if !session_key.trim().is_empty() {
        let session_key_value = session_key.clone();
        let agent_value = agent_id.clone();
        if let Ok(Some(stored)) = state
            .pool
            .read(move |conn| {
                session_transcript_content(conn, &session_key_value, &agent_value)
                    .map_err(|err| signet_core::error::CoreError::Migration(err.to_string()))
            })
            .await
            && !stored.trim().is_empty()
            && (normalized.trim().is_empty() || stored.len() > normalized.len())
        {
            info!(
                session_key,
                live_chars = stored.len(),
                final_chars = normalized.len(),
                "session-end: using stored transcript snapshot"
            );
            normalized = stored;
        }
    }

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

    if let Err(e) = write_transcript_audit(
        &state.config.base_path,
        &agent_id,
        &session_id,
        if session_key.trim().is_empty() {
            None
        } else {
            Some(session_key.as_str())
        },
        &transcript,
        Some(&ended_at),
    ) {
        warn!(error = %e, "session-end: transcript audit write failed");
    }

    // Gate before canonical artifact/job work — raw audit traces are still
    // preserved for non-empty transcripts even when normalization produces no
    // conversation turns.
    if normalized.trim().is_empty() {
        if !session_key.trim().is_empty() {
            let session_key_value = session_key.clone();
            let agent_value = agent_id.clone();
            if let Err(e) = state
                .pool
                .write(Priority::Low, move |conn| {
                    delete_session_transcript(conn, &session_key_value, &agent_value)
                        .map(|_| serde_json::Value::Null)
                        .map_err(|err| signet_core::error::CoreError::Migration(err.to_string()))
                })
                .await
            {
                warn!(error = %e, "session-end: transcript DB cleanup failed, continuing");
            }
        }
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

    let noise = is_noise_session(
        project.as_deref(),
        Some(session_id.as_str()),
        Some(session_key.as_str()),
        Some(harness),
    );

    // Canonical artifact always written before pipeline gates — it is the
    // lineage source of truth regardless of pipeline_enabled or shadow_mode.
    // This matches compaction_complete, which also writes artifacts unconditionally
    // so manifests and backlinks never reference transcripts that don't exist.
    if !noise {
        let transcript_value = normalized.clone();
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
            warn!(
                session = %session_key,
                agent_id = %agent_id,
                error = %e,
                "session-end: transcript artifact write failed"
            );
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(
                    serde_json::json!({"error": format!("transcript artifact write failed: {e}")}),
                ),
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
    if noise {
        if !session_key.trim().is_empty() {
            let session_key_value = session_key.clone();
            let agent_value = agent_id.clone();
            if let Err(e) = state
                .pool
                .write(Priority::Low, move |conn| {
                    delete_session_transcript(conn, &session_key_value, &agent_value)
                        .map(|_| serde_json::Value::Null)
                        .map_err(|err| signet_core::error::CoreError::Migration(err.to_string()))
                })
                .await
            {
                warn!(error = %e, "session-end: transcript DB cleanup failed, continuing");
            }
        }
        state.sessions.release(&session_key);
        if !snapshot_retained {
            state.continuity.clear(&session_key);
        }
        state.dedup.clear_session_start(&session_key);
        state.dedup.clear(&session_key);
        return (
            StatusCode::OK,
            Json(serde_json::json!({"memoriesSaved": 0, "queued": false})),
        )
            .into_response();
    }

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
                true,
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
                    source_path: None,
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

    // Load search config — parity with TS `const cfg = loadMemoryConfig(AGENTS_DIR)`.
    // NOTE: TS reads from disk per-request (always fresh); Rust reads from
    // startup-populated state.config (requires daemon restart for changes).
    // Previously the handler used a hardcoded default of 10 and applied no min_score
    // filter; the TS endpoint was updated to pass cfg through hybridRecall which
    // uses cfg.search.top_k and cfg.search.min_score.  Mirror those semantics here.
    let search_cfg = state.config.manifest.search.clone().unwrap_or_default();
    let limit = body.limit.unwrap_or(search_cfg.top_k).min(50);
    let min_score = search_cfg.min_score;
    let query = query.to_string();
    let project = body.project.clone();

    let result = state
        .pool
        .read(move |conn| {
            // FTS search — fetch up to `limit` candidates ordered by importance,
            // then apply the configured min_score threshold before returning.
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
                        Ok(rows) => rows
                            .filter_map(|r| r.ok())
                            // Apply min_score filter (importance is the FTS-path
                            // proxy for relevance score, matching TS cfg.search.min_score).
                            .filter(|m| {
                                m.get("importance")
                                    .and_then(|v| v.as_f64())
                                    .map(|imp| imp >= min_score)
                                    // Include memories with missing/null importance
                                    // so older unscored records are not silently excluded.
                                    .unwrap_or(true)
                            })
                            .collect::<Vec<_>>(),
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
    let harness = harness.to_string();

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
    let harness_value = harness.clone();
    let summary_value = summary.to_string();
    // Validate body.agent_id against the agent encoded in session_key so
    // compaction lineage can't be attributed to an arbitrary caller-supplied id.
    let agent_id = match resolve_remember_agent(
        body.agent_id.as_deref(),
        headers
            .get("x-signet-agent-id")
            .and_then(|v| v.to_str().ok()),
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
        Some(harness.as_str()),
        ArtifactKind::Compaction,
        None,
        None,
    )
    .await;
    let root = state.config.base_path.clone();
    let session_key = body.session_key.clone();
    let fallback_project = body.project.clone();
    let noise_harness = harness.clone();

    // Step 1: Resolve lineage metadata and write canonical artifacts for
    // projectable sessions before DB ingest.
    // DB ingest is intentionally deferred until artifacts are on disk so that
    // an artifact-write failure leaves no committed DB state — retries start
    // clean. If artifact writes succeed but DB ingest fails (step 2), the
    // artifact is already canonical; ingest is idempotent via session_id key.
    let artifact_result = state
        .pool
        .write(Priority::High, {
            let session_key = session_key.clone();
            let agent_id = agent_id.clone();
            let fallback_project = fallback_project.clone();
            let captured_at = captured_at.clone();
            let harness_value = harness_value.clone();
            let summary_value = summary_value.clone();
            let noise_harness = noise_harness.clone();
            move |conn| {
                let project = resolve_compaction_project(
                    conn,
                    session_key.as_deref(),
                    &agent_id,
                    fallback_project.as_deref(),
                )?;
                // Stable lineage ID for the compaction event. When session_key
                // is present it is authoritative. When absent, derive a
                // content-hash ID so retries for the same compaction event
                // produce the same session_id.
                let sid = session_key.clone().unwrap_or_else(|| {
                    let mut h = Sha256::new();
                    h.update(agent_id.as_bytes());
                    h.update(b":");
                    h.update(project.as_deref().unwrap_or("").as_bytes());
                    h.update(b":");
                    h.update(summary_value.as_bytes());
                    let digest = h.finalize();
                    let hex: String = digest[..8].iter().map(|b| format!("{b:02x}")).collect();
                    format!("compaction:{hex}")
                });
                let noise = is_noise_session(
                    project.as_deref(),
                    Some(sid.as_str()),
                    session_key.as_deref(),
                    Some(noise_harness.as_str()),
                );
                if !noise {
                    // ensure_canonical_manifest queries memory_artifacts for an
                    // existing manifest by session_id before creating one. If a
                    // prior attempt already committed step 1, retries reuse the
                    // original captured_at and keep filenames stable.
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
                }
                // write_memory_projection is deferred to after DB ingest (step 2)
                // so MEMORY.md reflects the newly ingested session_summary row.
                Ok(serde_json::json!({
                    "noise": noise,
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
                Json(
                    serde_json::json!({"error": format!("compaction artifact write failed: {e}")}),
                ),
            )
                .into_response();
        }
    };

    let session_id = meta["sessionId"].as_str().unwrap_or("").to_string();
    let project: Option<String> = meta["project"].as_str().map(str::to_string);
    let noise = meta["noise"].as_bool().unwrap_or_else(|| {
        is_noise_session(
            project.as_deref(),
            Some(session_id.as_str()),
            session_key.as_deref(),
            Some(harness.as_str()),
        )
    });

    // Step 2: DB ingest. Projectable sessions already committed their canonical
    // artifact above, so this remains recoverable on failure. idempotency_key=
    // session_id ensures retries don't create duplicate memory rows.
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
                let memory_id = if noise {
                    serde_json::Value::Null
                } else {
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
                            source_path: None,
                            idempotency_key: Some(&session_id),
                            runtime_path: None,
                            actor: "compaction",
                            agent_id: &agent_id,
                            visibility: "global",
                            scope: None,
                        },
                    )?;

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
                    serde_json::Value::String(r.id)
                };

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

                // Project MEMORY.md after ingest so it includes the new row.
                write_memory_projection(conn, &root, &agent_id)
                    .map_err(signet_core::error::CoreError::Migration)?;
                Ok(memory_id)
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
// Enqueues a summary job for the delta only, then advances the byte cursor.
// Cursor advancement happens after enqueue so a crash cannot permanently skip
// an unprocessed transcript window.
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
    pub harness: Option<String>,
    pub session_key: Option<String>,
    pub agent_id: Option<String>,
    pub project: Option<String>,
    // Inline transcript (takes precedence over stored transcript).
    pub transcript: Option<String>,
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
    let Some(harness) = body.harness.clone() else {
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
    let inline = body
        .transcript
        .as_deref()
        .map(normalize_session_transcript)
        .filter(|text| !text.is_empty());
    let path_transcript = if inline.is_none() {
        match body
            .transcript_path
            .as_deref()
            .filter(|path| !path.trim().is_empty())
        {
            Some(path) => match load_guarded_transcript_path(path, "session-checkpoint-extract") {
                Ok(raw) => {
                    let normalized = normalize_session_transcript(&raw);
                    if normalized.is_empty() {
                        None
                    } else {
                        Some(normalized)
                    }
                }
                Err((status, body)) => return (status, Json(body)).into_response(),
            },
            None => None,
        }
    } else {
        None
    };
    let sk = session_key.clone();
    let aid = agent_id.clone();
    let project = body.project.clone();
    let harness_value = harness;

    let result = state
        .pool
        .write(Priority::High, move |conn| {
            // Read current extraction cursor.
            let cursor: i64 = conn
                .query_row(
                    "SELECT last_offset FROM session_extract_cursors \
                     WHERE session_key = ?1 AND agent_id = ?2",
                    rusqlite::params![sk, aid],
                    |row| row.get(0),
                )
                .unwrap_or(0);

            // Resolve transcript: inline body → guarded transcript_path file → stored.
            // Always filter stored fallback by agent_id.
            let mut from_store = false;
            let full = inline
                .or(path_transcript)
                .or_else(|| {
                    from_store = true;
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

            if !from_store {
                let prev = session_transcript_content(conn, &sk, &aid)?;
                if prev.as_ref().is_none_or(|stored| full.len() >= stored.len()) {
                    upsert_session_transcript(
                        conn,
                        &sk,
                        &full,
                        &harness_value,
                        project.as_deref(),
                        &aid,
                    )?;
                }
            }

            let Some(delta) = extract_delta(&full, cursor) else {
                return Ok(serde_json::json!({"skipped": true}));
            };

            const MAX_DELTA_CHARS: usize = 100_000;
            let capped = if delta.chars().count() > MAX_DELTA_CHARS {
                let safe = delta.chars().take(MAX_DELTA_CHARS).collect::<String>();
                format!("{safe}\n[truncated]")
            } else {
                delta.to_string()
            };

            let now = chrono::Utc::now().to_rfc3339();
            let job_id = enqueue_summary_job(
                conn,
                &harness_value,
                &capped,
                Some(&sk),
                &sk,
                project.as_deref(),
                &aid,
                "checkpoint_extract",
                &now,
                None,
                None,
                false,
            )?;

            conn.execute(
                "INSERT INTO session_extract_cursors (session_key, agent_id, last_offset, last_extract_at)
                 VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(session_key, agent_id) DO UPDATE SET
                    last_offset = excluded.last_offset,
                    last_extract_at = excluded.last_extract_at",
                rusqlite::params![sk, aid, full.len() as i64, now],
            )?;

            Ok(serde_json::json!({"queued": true, "jobId": job_id}))
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
    use std::path::Path;
    use std::sync::Arc;

    use axum::Json;
    use axum::body::to_bytes;
    use axum::extract::State;
    use axum::http::{HeaderMap, StatusCode};
    use serde_json::Value;
    use sha2::{Digest, Sha256};
    use signet_core::config::{
        AgentManifest, DaemonConfig, HooksConfig, MemoryManifestConfig, PipelineV2Config,
        UserPromptSubmitHookConfig,
    };
    use signet_core::db::{DbPool, Priority};
    use signet_pipeline::embedding::EmbeddingProvider;
    use tempfile::TempDir;

    use crate::auth::rate_limiter::{AuthRateLimiter, default_limits};
    use crate::auth::types::AuthMode;
    use crate::state::AppState;

    use super::{
        CHECKPOINT_MIN_DELTA, CheckpointExtractBody, CompactionCompleteBody, PromptSubmitBody,
        SessionEndBody, build_signet_system_prompt, compaction_complete, extract_delta,
        memory_embedding_score, normalize_session_transcript, parse_visibility, prompt_submit,
        require_session_scope_for_write, resolve_audit_token, resolve_compaction_project,
        resolve_remember_agent, session_agent_id, session_checkpoint_extract, session_end,
        session_transcript_content, strip_untrusted_metadata, upsert_session_transcript,
    };
    use signet_services::session::{RuntimePath, SessionTracker};

    async fn test_json(resp: axum::response::Response) -> Value {
        let body = to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        serde_json::from_slice(&body).unwrap()
    }

    struct TestEmbeddingProvider {
        vector: Vec<f32>,
    }

    impl EmbeddingProvider for TestEmbeddingProvider {
        fn embed(
            &self,
            _text: &str,
        ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Option<Vec<f32>>> + Send + '_>>
        {
            let vector = self.vector.clone();
            Box::pin(async move { Some(vector) })
        }

        fn name(&self) -> &str {
            "test"
        }

        fn dimensions(&self) -> usize {
            self.vector.len()
        }
    }

    fn vector_blob(values: &[f32]) -> Vec<u8> {
        values
            .iter()
            .flat_map(|value| value.to_le_bytes())
            .collect()
    }

    fn has_markdown(dir: &Path) -> bool {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return false;
        };
        entries.flatten().any(|entry| {
            let path = entry.path();
            if path.is_dir() {
                return has_markdown(&path);
            }
            path.extension().and_then(|ext| ext.to_str()) == Some("md")
        })
    }

    fn test_state_with_manifest(
        name: &str,
        configure: impl FnOnce(&mut AgentManifest),
    ) -> (Arc<AppState>, tokio::task::JoinHandle<()>, TempDir) {
        let tmp = tempfile::Builder::new().prefix(name).tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join("memory")).unwrap();
        std::fs::create_dir_all(tmp.path().join(".daemon/logs")).unwrap();
        let mut manifest = AgentManifest::default();
        let mut memory = MemoryManifestConfig::default();
        memory.pipeline_v2 = Some(PipelineV2Config::default());
        manifest.memory = Some(memory);
        configure(&mut manifest);
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
            None,
            AuthMode::Local,
            None,
            AuthRateLimiter::from_rules(&default_limits()),
            AuthRateLimiter::from_rules(&default_limits()),
        ));
        (state, writer, tmp)
    }

    fn test_state(name: &str) -> (Arc<AppState>, tokio::task::JoinHandle<()>, TempDir) {
        test_state_with_manifest(name, |_| {})
    }

    #[tokio::test]
    async fn session_end_persists_transcript_artifact_and_queues_summary() {
        let (state, writer, tmp) = test_state("hooks-session-end");
        let transcript = [
            "User: discuss platform/daemon-rs hooks parity.",
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
                cwd: Some("platform/daemon-rs".to_string()),
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
    async fn checkpoint_extract_queues_summary_and_advances_cursor() {
        let (state, writer, _tmp) = test_state("hooks-checkpoint-extract");
        let transcript = "checkpoint extract parity ".repeat(30);
        let session_key = "agent:agent-a:ckpt-queue";

        let resp = session_checkpoint_extract(
            State(state.clone()),
            HeaderMap::new(),
            Json(CheckpointExtractBody {
                harness: Some("codex".to_string()),
                session_key: Some(session_key.to_string()),
                agent_id: Some("agent-a".to_string()),
                project: Some("platform/daemon-rs".to_string()),
                transcript: Some(transcript.clone()),
                transcript_path: None,
                runtime_path: None,
            }),
        )
        .await;

        assert_eq!(resp.status(), StatusCode::OK);
        let body = test_json(resp).await;
        assert_eq!(body["queued"], serde_json::Value::Bool(true));
        assert!(body["jobId"].is_string());

        let (jobs, cursor, stored_len, trigger, job_transcript) = state
            .pool
            .read(move |conn| {
                let jobs: i64 = conn
                    .query_row("SELECT COUNT(*) FROM summary_jobs", [], |row| row.get(0))
                    .unwrap_or(0);
                let cursor: i64 = conn
                    .query_row(
                        "SELECT last_offset FROM session_extract_cursors \
                         WHERE session_key = ?1 AND agent_id = ?2",
                        rusqlite::params![session_key, "agent-a"],
                        |row| row.get(0),
                    )
                    .unwrap_or(0);
                let stored_len: i64 = conn
                    .query_row(
                        "SELECT length(content) FROM session_transcripts \
                         WHERE session_key = ?1 AND agent_id = ?2",
                        rusqlite::params![session_key, "agent-a"],
                        |row| row.get(0),
                    )
                    .unwrap_or(0);
                let (trigger, job_transcript): (String, String) = conn
                    .query_row(
                        "SELECT trigger, transcript FROM summary_jobs LIMIT 1",
                        [],
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    )
                    .unwrap();
                Ok((jobs, cursor, stored_len, trigger, job_transcript))
            })
            .await
            .unwrap();

        assert_eq!(jobs, 1);
        assert_eq!(cursor, transcript.len() as i64);
        assert_eq!(stored_len, transcript.len() as i64);
        assert_eq!(trigger, "checkpoint_extract");
        assert_eq!(job_transcript, transcript);

        drop(state);
        let _ = writer.await;
    }

    #[tokio::test]
    async fn checkpoint_extract_skips_replay_and_queues_new_delta() {
        let (state, writer, _tmp) = test_state("hooks-checkpoint-delta");
        let initial = "x".repeat(CHECKPOINT_MIN_DELTA + 100);
        let extended = format!("{initial}{}", "y".repeat(CHECKPOINT_MIN_DELTA + 100));
        let session_key = "agent:agent-a:ckpt-delta";

        for transcript in [&initial, &extended] {
            let resp = session_checkpoint_extract(
                State(state.clone()),
                HeaderMap::new(),
                Json(CheckpointExtractBody {
                    harness: Some("test".to_string()),
                    session_key: Some(session_key.to_string()),
                    agent_id: Some("agent-a".to_string()),
                    project: None,
                    transcript: Some(transcript.to_string()),
                    transcript_path: None,
                    runtime_path: None,
                }),
            )
            .await;
            assert_eq!(resp.status(), StatusCode::OK);
            let body = test_json(resp).await;
            assert_eq!(body["queued"], serde_json::Value::Bool(true));
        }

        let replay = session_checkpoint_extract(
            State(state.clone()),
            HeaderMap::new(),
            Json(CheckpointExtractBody {
                harness: Some("test".to_string()),
                session_key: Some(session_key.to_string()),
                agent_id: Some("agent-a".to_string()),
                project: None,
                transcript: Some(extended.clone()),
                transcript_path: None,
                runtime_path: None,
            }),
        )
        .await;
        assert_eq!(replay.status(), StatusCode::OK);
        let body = test_json(replay).await;
        assert_eq!(body["skipped"], serde_json::Value::Bool(true));

        let (jobs, stored_len, last_job_len) = state
            .pool
            .read(move |conn| {
                let jobs: i64 = conn
                    .query_row("SELECT COUNT(*) FROM summary_jobs", [], |row| row.get(0))
                    .unwrap_or(0);
                let stored_len: i64 = conn
                    .query_row(
                        "SELECT length(content) FROM session_transcripts \
                         WHERE session_key = ?1 AND agent_id = ?2",
                        rusqlite::params![session_key, "agent-a"],
                        |row| row.get(0),
                    )
                    .unwrap_or(0);
                let last_job_len: i64 = conn
                    .query_row(
                        "SELECT length(transcript) FROM summary_jobs \
                         ORDER BY created_at DESC LIMIT 1",
                        [],
                        |row| row.get(0),
                    )
                    .unwrap_or(0);
                Ok((jobs, stored_len, last_job_len))
            })
            .await
            .unwrap();

        assert_eq!(jobs, 2);
        assert_eq!(stored_len, extended.len() as i64);
        assert_eq!(last_job_len, (CHECKPOINT_MIN_DELTA + 100) as i64);

        drop(state);
        let _ = writer.await;
    }

    #[tokio::test]
    async fn checkpoint_extract_rejects_transcript_path_outside_allowed_roots() {
        let (state, writer, tmp) = test_state("hooks-checkpoint-path-guard");
        let transcript_path = tmp.path().join("checkpoint-secret.txt");
        std::fs::write(
            &transcript_path,
            "outside checkpoint transcript ".repeat(30),
        )
        .unwrap();

        let resp = session_checkpoint_extract(
            State(state.clone()),
            HeaderMap::new(),
            Json(CheckpointExtractBody {
                harness: Some("test".to_string()),
                session_key: Some("agent:agent-a:ckpt-path-guard".to_string()),
                agent_id: Some("agent-a".to_string()),
                project: None,
                transcript: None,
                transcript_path: Some(transcript_path.display().to_string()),
                runtime_path: None,
            }),
        )
        .await;

        assert_eq!(resp.status(), StatusCode::FORBIDDEN);
        let body = test_json(resp).await;
        assert_eq!(
            body["error"],
            serde_json::Value::String(
                "transcript_path outside allowed workspace roots".to_string()
            )
        );

        let jobs = state
            .pool
            .read(|conn| {
                let jobs = conn.query_row("SELECT COUNT(*) FROM summary_jobs", [], |row| {
                    row.get::<_, i64>(0)
                })?;
                Ok(jobs)
            })
            .await
            .unwrap();
        assert_eq!(jobs, 0);

        drop(state);
        let _ = writer.await;
    }

    #[tokio::test]
    async fn checkpoint_extract_falls_back_to_stored_transcript_when_input_normalizes_empty() {
        let (state, writer, _tmp) = test_state("hooks-checkpoint-empty-fallback");
        let session_key = "agent:agent-a:ckpt-empty-fallback";
        let stored = "stored checkpoint transcript ".repeat(30);
        let stored_for_seed = stored.clone();

        state
            .pool
            .write(Priority::Low, move |conn| {
                upsert_session_transcript(
                    conn,
                    session_key,
                    &stored_for_seed,
                    "test",
                    Some("platform/daemon-rs"),
                    "agent-a",
                )?;
                Ok(serde_json::Value::Null)
            })
            .await
            .unwrap();

        let resp = session_checkpoint_extract(
            State(state.clone()),
            HeaderMap::new(),
            Json(CheckpointExtractBody {
                harness: Some("test".to_string()),
                session_key: Some(session_key.to_string()),
                agent_id: Some("agent-a".to_string()),
                project: None,
                transcript: Some(String::new()),
                transcript_path: None,
                runtime_path: None,
            }),
        )
        .await;

        assert_eq!(resp.status(), StatusCode::OK);
        let body = test_json(resp).await;
        assert_eq!(body["queued"], serde_json::Value::Bool(true));

        let job_transcript = state
            .pool
            .read(move |conn| {
                let transcript = conn.query_row(
                    "SELECT transcript FROM summary_jobs
                     WHERE session_key = ?1 AND agent_id = ?2
                     LIMIT 1",
                    rusqlite::params![session_key, "agent-a"],
                    |row| row.get::<_, String>(0),
                )?;
                Ok(transcript)
            })
            .await
            .unwrap();
        assert_eq!(job_transcript, stored);

        drop(state);
        let _ = writer.await;
    }

    #[tokio::test]
    async fn compaction_complete_writes_artifact_projection_and_clears_runtime_transcript() {
        let (state, writer, tmp) = test_state("hooks-compaction");
        let transcript = [
            "User: preserve platform/daemon-rs MEMORY.md lineage.",
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
                cwd: Some("platform/daemon-rs".to_string()),
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
                summary: Some("# Compaction Summary\n\n## platform/daemon-rs\n\nCompaction preserved the daemon-rs lineage work and the rolling MEMORY.md projection contract.".to_string()),
                session_key: Some("agent:agent-a:sess-2".to_string()),
                project: Some("platform/daemon-rs".to_string()),
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

    #[tokio::test]
    async fn prompt_submit_rejects_transcript_path_outside_allowed_roots() {
        let (state, writer, tmp) = test_state("hooks-prompt-submit-path-guard");
        let transcript_path = tmp.path().join("prompt-transcript.txt");
        std::fs::write(&transcript_path, "User: hi\nAssistant: hello").unwrap();

        let resp = prompt_submit(
            State(state.clone()),
            HeaderMap::new(),
            Json(PromptSubmitBody {
                harness: Some("test".to_string()),
                project: Some("platform/daemon-rs".to_string()),
                agent_id: Some("agent-a".to_string()),
                user_message: Some("review the release checklist".to_string()),
                user_prompt: None,
                last_assistant_message: None,
                session_key: Some("sess-prompt-denied".to_string()),
                transcript: None,
                transcript_path: Some(transcript_path.display().to_string()),
                runtime_path: None,
            }),
        )
        .await;

        assert_eq!(resp.status(), StatusCode::FORBIDDEN);
        let body = test_json(resp).await;
        assert_eq!(
            body["error"],
            serde_json::Value::String(
                "transcript_path outside allowed workspace roots".to_string()
            )
        );

        drop(state);
        let _ = writer.await;
    }

    #[tokio::test]
    async fn prompt_submit_keeps_longer_stored_transcript_snapshot() {
        let (state, writer, _tmp) = test_state("hooks-prompt-submit-length-guard");
        state
            .pool
            .write(Priority::Low, move |conn| {
                upsert_session_transcript(
                    conn,
                    "sess-prompt-guard",
                    &"User: longer transcript\nAssistant: still longer\n".repeat(6),
                    "test",
                    Some("platform/daemon-rs"),
                    "agent-a",
                )?;
                Ok(serde_json::Value::Null)
            })
            .await
            .unwrap();

        let resp = prompt_submit(
            State(state.clone()),
            HeaderMap::new(),
            Json(PromptSubmitBody {
                harness: Some("test".to_string()),
                project: Some("platform/daemon-rs".to_string()),
                agent_id: Some("agent-a".to_string()),
                user_message: Some("review the release checklist".to_string()),
                user_prompt: None,
                last_assistant_message: None,
                session_key: Some("sess-prompt-guard".to_string()),
                transcript: Some("User: short\nAssistant: short".to_string()),
                transcript_path: None,
                runtime_path: None,
            }),
        )
        .await;

        assert_eq!(resp.status(), StatusCode::OK);
        let stored = state
            .pool
            .read(|conn| {
                session_transcript_content(conn, "sess-prompt-guard", "agent-a")
                    .map_err(|err| signet_core::error::CoreError::Migration(err.to_string()))
            })
            .await
            .unwrap()
            .unwrap_or_default();
        assert!(stored.contains("longer transcript"));
        assert!(!stored.contains("User: short\nAssistant: short"));

        drop(state);
        let _ = writer.await;
    }

    #[tokio::test]
    async fn prompt_submit_injects_entity_context_for_active_alias() {
        let (state, writer, _tmp) = test_state("hooks-prompt-submit-entity-context");
        state
            .pool
            .write(Priority::Low, move |conn| {
                conn.execute(
                    "INSERT INTO entities (id, name, canonical_name, entity_type, description, agent_id, mentions, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 10, ?7, ?7)",
                    rusqlite::params![
                        "entity-signet",
                        "Signet",
                        "signet",
                        "project",
                        "Source-backed agent continuity substrate",
                        "agent-a",
                        "2026-05-27T00:00:00Z",
                    ],
                )?;
                conn.execute(
                    "INSERT INTO entity_aliases (id, entity_id, agent_id, alias, canonical_alias, confidence, source, status, created_at, updated_at)
                     VALUES ('alias-signetai', 'entity-signet', 'agent-a', 'SignetAI', 'signetai', 1.0, 'test', 'active', ?1, ?1)",
                    rusqlite::params!["2026-05-27T00:00:00Z"],
                )?;
                conn.execute(
                    "INSERT INTO entity_aspects (id, entity_id, agent_id, name, canonical_name, weight, created_at, updated_at)
                     VALUES ('aspect-architecture', 'entity-signet', 'agent-a', 'architecture', 'architecture', 0.9, ?1, ?1)",
                    rusqlite::params!["2026-05-27T00:00:00Z"],
                )?;
                conn.execute(
                    "INSERT INTO entity_aspects (id, entity_id, agent_id, name, canonical_name, weight, created_at, updated_at)
                     VALUES ('aspect-marketing', 'entity-signet', 'agent-a', 'marketing', 'marketing', 0.2, ?1, ?1)",
                    rusqlite::params!["2026-05-27T00:00:00Z"],
                )?;
                conn.execute(
                    "INSERT INTO entity_attributes
                     (id, aspect_id, agent_id, memory_id, kind, content, normalized_content, confidence, importance,
                      status, group_key, claim_key, source_kind, source_id, created_at, updated_at)
                     VALUES ('attr-architecture', 'aspect-architecture', 'agent-a', NULL, 'attribute',
                      'Prompt context should come from entity current views.',
                      'prompt context should come from entity current views', 0.95, 0.9, 'active',
                      'runtime', 'prompt_context', 'memory', 'mem-architecture', ?1, ?1)",
                    rusqlite::params!["2026-05-27T00:00:00Z"],
                )?;
                conn.execute(
                    "INSERT INTO entity_aspects (id, entity_id, agent_id, name, canonical_name, weight, created_at, updated_at)
                     VALUES ('aspect-general', 'entity-signet', 'agent-a', 'general', 'general', 1.0, ?1, ?1)",
                    rusqlite::params!["2026-05-27T00:00:00Z"],
                )?;
                conn.execute(
                    "INSERT INTO entity_attributes
                     (id, aspect_id, agent_id, memory_id, kind, content, normalized_content, confidence, importance,
                      status, group_key, claim_key, created_at, updated_at)
                     VALUES ('attr-general-junk', 'aspect-general', 'agent-a', NULL, 'constraint',
                      'Prompt context junk from general uncategorized should not inject.',
                      'prompt context junk from general uncategorized should not inject', 0.99, 1.0, 'active',
                      'general', 'uncategorized', ?1, ?1)",
                    rusqlite::params!["2026-05-27T00:00:00Z"],
                )?;
                conn.execute(
                    "INSERT INTO entity_attributes
                     (id, aspect_id, agent_id, memory_id, kind, content, normalized_content, confidence, importance,
                      status, group_key, claim_key, version, created_at, updated_at)
                     VALUES ('attr-architecture-stale', 'aspect-architecture', 'agent-a', NULL, 'attribute',
                      'Stale prompt context should not be injected.',
                      'stale prompt context should not be injected', 0.5, 2.0, 'active',
                      'runtime', 'prompt_context', 0, ?1, ?1)",
                    rusqlite::params!["2026-05-27T00:00:00Z"],
                )?;
                conn.execute(
                    "INSERT INTO entity_attributes
                     (id, aspect_id, agent_id, memory_id, kind, content, normalized_content, confidence, importance,
                      status, group_key, claim_key, created_at, updated_at)
                     VALUES ('attr-marketing', 'aspect-marketing', 'agent-a', NULL, 'attribute',
                      'Marketing copy should stay secondary.', 'marketing copy', 0.8, 0.3, 'active',
                      'copy', 'positioning', ?1, ?1)",
                    rusqlite::params!["2026-05-27T00:00:00Z"],
                )?;
                Ok(serde_json::Value::Null)
            })
            .await
            .unwrap();

        let resp = prompt_submit(
            State(state.clone()),
            HeaderMap::new(),
            Json(PromptSubmitBody {
                harness: Some("test".to_string()),
                project: Some("platform/daemon-rs".to_string()),
                agent_id: Some("agent-a".to_string()),
                user_message: Some(
                    "Should SignetAI prompt context include current views?".to_string(),
                ),
                user_prompt: None,
                last_assistant_message: None,
                session_key: Some("sess-prompt-entity".to_string()),
                transcript: None,
                transcript_path: None,
                runtime_path: None,
            }),
        )
        .await;

        assert_eq!(resp.status(), StatusCode::OK);
        let body = test_json(resp).await;
        let inject = body["inject"].as_str().unwrap_or_default();
        assert_eq!(
            body["engine"],
            serde_json::Value::String("entity-context".to_string())
        );
        assert!(inject.contains("## Relevant Entity Context"));
        assert!(inject.contains("Signet / architecture / runtime / prompt_context"));
        assert!(inject.contains("Prompt context should come from entity current views."));
        assert!(!inject.contains("Signet / general / general / uncategorized"));
        assert!(!inject.contains("Prompt context junk from general uncategorized"));
        assert!(!inject.contains("Stale prompt context should not be injected."));
        assert!(!inject.contains("## Relevant Memory"));
        assert!(!inject.contains("Marketing copy should stay secondary"));

        drop(state);
        let _ = writer.await;
    }

    #[tokio::test]
    async fn prompt_submit_prefers_canonical_entity_over_possessive_duplicate() {
        let (state, writer, _tmp) = test_state("hooks-prompt-submit-possessive-entity");
        state
            .pool
            .write(Priority::Low, move |conn| {
                let now = "2026-05-27T00:00:00Z";
                conn.execute(
                    "INSERT INTO entities (id, name, canonical_name, entity_type, description, agent_id, mentions, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
                    rusqlite::params![
                        "entity-signet",
                        "Signet",
                        "signet",
                        "project",
                        "Source-backed agent continuity substrate",
                        "agent-a",
                        10_i64,
                        now,
                    ],
                )?;
                conn.execute(
                    "INSERT INTO entity_aspects (id, entity_id, agent_id, name, canonical_name, weight, created_at, updated_at)
                     VALUES ('aspect-preferences', 'entity-signet', 'agent-a', 'preferences', 'preferences', 0.9, ?1, ?1)",
                    rusqlite::params![now],
                )?;
                conn.execute(
                    "INSERT INTO entity_attributes
                     (id, aspect_id, agent_id, memory_id, kind, content, normalized_content, confidence, importance,
                      status, group_key, claim_key, created_at, updated_at)
                     VALUES ('attr-preferences-pen', 'aspect-preferences', 'agent-a', NULL, 'attribute',
                      'Favorite pen is a Pilot G-2.',
                      'favorite pen is a pilot g 2', 0.95, 0.9, 'active',
                      'writing', 'favorite_pen', ?1, ?1)",
                    rusqlite::params![now],
                )?;
                conn.execute(
                    "INSERT INTO entities (id, name, canonical_name, entity_type, description, agent_id, mentions, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
                    rusqlite::params![
                        "entity-signet-possessive",
                        "Signet's",
                        "signet's",
                        "tool",
                        "Possessive duplicate",
                        "agent-a",
                        2_i64,
                        now,
                    ],
                )?;
                conn.execute(
                    "INSERT INTO entity_aspects (id, entity_id, agent_id, name, canonical_name, weight, created_at, updated_at)
                     VALUES ('aspect-possessive-noise', 'entity-signet-possessive', 'agent-a', 'noise', 'noise', 1.0, ?1, ?1)",
                    rusqlite::params![now],
                )?;
                conn.execute(
                    "INSERT INTO entity_attributes
                     (id, aspect_id, agent_id, memory_id, kind, content, normalized_content, confidence, importance,
                      status, group_key, claim_key, created_at, updated_at)
                     VALUES ('attr-possessive-noise', 'aspect-possessive-noise', 'agent-a', NULL, 'attribute',
                      'Possessive duplicate entity should not win prompt matching.',
                      'possessive duplicate entity should not win prompt matching', 0.95, 0.9, 'active',
                      'runtime', 'duplicate_guard', ?1, ?1)",
                    rusqlite::params![now],
                )?;
                Ok(serde_json::Value::Null)
            })
            .await
            .unwrap();

        let resp = prompt_submit(
            State(state.clone()),
            HeaderMap::new(),
            Json(PromptSubmitBody {
                harness: Some("test".to_string()),
                project: Some("platform/daemon-rs".to_string()),
                agent_id: Some("agent-a".to_string()),
                user_message: Some("What are Signet's favorite pens?".to_string()),
                user_prompt: None,
                last_assistant_message: None,
                session_key: Some("sess-prompt-possessive-entity".to_string()),
                transcript: None,
                transcript_path: None,
                runtime_path: None,
            }),
        )
        .await;

        assert_eq!(resp.status(), StatusCode::OK);
        let body = test_json(resp).await;
        let inject = body["inject"].as_str().unwrap_or_default();
        assert_eq!(
            body["engine"],
            serde_json::Value::String("entity-context".to_string())
        );
        assert!(inject.contains("Signet / preferences / writing / favorite_pen"));
        assert!(!inject.contains("Signet's / noise"));
        assert!(!inject.contains("Possessive duplicate entity should not win"));

        let bare_resp = prompt_submit(
            State(state.clone()),
            HeaderMap::new(),
            Json(PromptSubmitBody {
                harness: Some("test".to_string()),
                project: Some("platform/daemon-rs".to_string()),
                agent_id: Some("agent-a".to_string()),
                user_message: Some("What are Signets favorite pens?".to_string()),
                user_prompt: None,
                last_assistant_message: None,
                session_key: Some("sess-prompt-bare-possessive-entity".to_string()),
                transcript: None,
                transcript_path: None,
                runtime_path: None,
            }),
        )
        .await;

        assert_eq!(bare_resp.status(), StatusCode::OK);
        let bare_body = test_json(bare_resp).await;
        let bare_inject = bare_body["inject"].as_str().unwrap_or_default();
        assert_eq!(
            bare_body["engine"],
            serde_json::Value::String("entity-context".to_string())
        );
        assert!(bare_inject.contains("Signet / preferences / writing / favorite_pen"));

        drop(state);
        let _ = writer.await;
    }

    #[tokio::test]
    async fn prompt_submit_prefers_longest_non_overlapping_entity_span() {
        let (state, writer, _tmp) = test_state("hooks-prompt-submit-longest-entity-span");
        state
            .pool
            .write(Priority::Low, move |conn| {
                let now = "2026-05-27T00:00:00Z";
                for (id, name, canonical, mentions) in [
                    (
                        "entity-claude-code-connector",
                        "Claude Code connector",
                        "claude code connector",
                        8_i64,
                    ),
                    ("entity-claude-code", "Claude Code", "claude code", 135_i64),
                    ("entity-claude", "Claude", "claude", 113_i64),
                    ("entity-code", "code", "code", 15_i64),
                    ("entity-connector", "connector", "connector", 5_i64),
                ] {
                    conn.execute(
                        "INSERT INTO entities (id, name, canonical_name, entity_type, description, agent_id, mentions, created_at, updated_at)
                         VALUES (?1, ?2, ?3, 'project', 'Prompt test entity', 'agent-a', ?4, ?5, ?5)",
                        rusqlite::params![id, name, canonical, mentions, now],
                    )?;
                    conn.execute(
                        "INSERT INTO entity_aspects (id, entity_id, agent_id, name, canonical_name, weight, created_at, updated_at)
                         VALUES (?1, ?2, 'agent-a', 'runtime', 'runtime', 1.0, ?3, ?3)",
                        rusqlite::params![format!("aspect-{id}"), id, now],
                    )?;
                    conn.execute(
                        "INSERT INTO entity_attributes
                         (id, aspect_id, agent_id, memory_id, kind, content, normalized_content, confidence, importance,
                          status, group_key, claim_key, created_at, updated_at)
                         VALUES (?1, ?2, 'agent-a', NULL, 'attribute', ?3, ?4, 0.95, 0.9, 'active',
                          'setup', 'routing', ?5, ?5)",
                        rusqlite::params![
                            format!("attr-{id}"),
                            format!("aspect-{id}"),
                            format!("{name} setup context."),
                            format!("{canonical} setup context"),
                            now,
                        ],
                    )?;
                }
                Ok(serde_json::Value::Null)
            })
            .await
            .unwrap();

        let resp = prompt_submit(
            State(state.clone()),
            HeaderMap::new(),
            Json(PromptSubmitBody {
                harness: Some("test".to_string()),
                project: Some("platform/daemon-rs".to_string()),
                agent_id: Some("agent-a".to_string()),
                user_message: Some("Claude Code connector setup".to_string()),
                user_prompt: None,
                last_assistant_message: None,
                session_key: Some("sess-prompt-longest-entity-span".to_string()),
                transcript: None,
                transcript_path: None,
                runtime_path: None,
            }),
        )
        .await;

        assert_eq!(resp.status(), StatusCode::OK);
        let body = test_json(resp).await;
        let inject = body["inject"].as_str().unwrap_or_default();
        assert_eq!(
            body["engine"],
            serde_json::Value::String("entity-context".to_string())
        );
        assert!(inject.contains("Claude Code connector / runtime / setup / routing"));
        assert!(!inject.contains("- [attribute] Claude Code / runtime"));
        assert!(!inject.contains("- [attribute] connector / runtime"));

        drop(state);
        let _ = writer.await;
    }

    #[tokio::test]
    async fn prompt_submit_ignores_disallowed_entity_types() {
        let (state, writer, _tmp) = test_state("hooks-prompt-submit-disallowed-entity-type");
        state
            .pool
            .write(Priority::Low, move |conn| {
                let now = "2026-05-27T00:00:00Z";
                conn.execute(
                    "INSERT INTO entities (id, name, canonical_name, entity_type, description, agent_id, mentions, created_at, updated_at)
                     VALUES ('entity-claude-code-connector', 'Claude Code connector', 'claude code connector',
                      'tool', 'Prompt test entity', 'agent-a', 80, ?1, ?1)",
                    rusqlite::params![now],
                )?;
                conn.execute(
                    "INSERT INTO entity_aspects (id, entity_id, agent_id, name, canonical_name, weight, created_at, updated_at)
                     VALUES ('aspect-claude-code-connector-runtime', 'entity-claude-code-connector',
                      'agent-a', 'runtime', 'runtime', 1.0, ?1, ?1)",
                    rusqlite::params![now],
                )?;
                conn.execute(
                    "INSERT INTO entity_attributes
                     (id, aspect_id, agent_id, memory_id, kind, content, normalized_content, confidence, importance,
                      status, group_key, claim_key, created_at, updated_at)
                     VALUES ('attr-claude-code-connector-runtime', 'aspect-claude-code-connector-runtime',
                      'agent-a', NULL, 'attribute',
                      'Claude Code connector setup context should not inject.',
                      'claude code connector setup context should not inject',
                      0.95, 0.9, 'active', 'setup', 'routing', ?1, ?1)",
                    rusqlite::params![now],
                )?;
                Ok(serde_json::Value::Null)
            })
            .await
            .unwrap();

        let resp = prompt_submit(
            State(state.clone()),
            HeaderMap::new(),
            Json(PromptSubmitBody {
                harness: Some("test".to_string()),
                project: Some("platform/daemon-rs".to_string()),
                agent_id: Some("agent-a".to_string()),
                user_message: Some("Claude Code connector setup".to_string()),
                user_prompt: None,
                last_assistant_message: None,
                session_key: Some("sess-prompt-disallowed-entity-type".to_string()),
                transcript: None,
                transcript_path: None,
                runtime_path: None,
            }),
        )
        .await;

        assert_eq!(resp.status(), StatusCode::OK);
        let body = test_json(resp).await;
        assert_eq!(
            body["engine"],
            serde_json::Value::String("no-entity".to_string())
        );
        assert_eq!(body["inject"], serde_json::Value::String(String::new()));

        drop(state);
        let _ = writer.await;
    }

    #[tokio::test]
    async fn prompt_submit_ignores_generic_role_label_people() {
        let (state, writer, _tmp) = test_state("hooks-prompt-submit-role-label-entity");
        state
            .pool
            .write(Priority::Low, move |conn| {
                let now = "2026-05-27T00:00:00Z";
                conn.execute(
                    "INSERT INTO entities (id, name, canonical_name, entity_type, description, agent_id, mentions, created_at, updated_at)
                     VALUES ('entity-user-role', 'User', 'user', 'person', 'Role label', 'agent-a', 2000, ?1, ?1)",
                    rusqlite::params![now],
                )?;
                conn.execute(
                    "INSERT INTO entity_aspects (id, entity_id, agent_id, name, canonical_name, weight, created_at, updated_at)
                     VALUES ('aspect-user-general', 'entity-user-role', 'agent-a', 'general', 'general', 1.0, ?1, ?1)",
                    rusqlite::params![now],
                )?;
                conn.execute(
                    "INSERT INTO entity_attributes
                     (id, aspect_id, agent_id, memory_id, kind, content, normalized_content, confidence, importance,
                      status, group_key, claim_key, created_at, updated_at)
                     VALUES ('attr-user-role-context', 'aspect-user-general', 'agent-a', NULL, 'attribute',
                      'User prompt context role-label junk should not inject.',
                      'user prompt context role label junk should not inject',
                      0.95, 0.9, 'active', 'general', 'uncategorized', ?1, ?1)",
                    rusqlite::params![now],
                )?;
                Ok(serde_json::Value::Null)
            })
            .await
            .unwrap();

        let resp = prompt_submit(
            State(state.clone()),
            HeaderMap::new(),
            Json(PromptSubmitBody {
                harness: Some("test".to_string()),
                project: Some("platform/daemon-rs".to_string()),
                agent_id: Some("agent-a".to_string()),
                user_message: Some("tell the user about prompt context".to_string()),
                user_prompt: None,
                last_assistant_message: None,
                session_key: Some("sess-prompt-role-label-entity".to_string()),
                transcript: None,
                transcript_path: None,
                runtime_path: None,
            }),
        )
        .await;

        assert_eq!(resp.status(), StatusCode::OK);
        let body = test_json(resp).await;
        assert_eq!(
            body["engine"],
            serde_json::Value::String("no-entity".to_string())
        );
        assert_eq!(body["inject"], serde_json::Value::String(String::new()));

        drop(state);
        let _ = writer.await;
    }

    #[tokio::test]
    async fn prompt_submit_uses_structured_path_terms_for_zero_confidence_attributes() {
        let (state, writer, _tmp) = test_state("hooks-prompt-submit-path-terms");
        state
            .pool
            .write(Priority::Low, move |conn| {
                let now = "2026-05-27T00:00:00Z";
                conn.execute(
                    "INSERT INTO entities (id, name, canonical_name, entity_type, description, agent_id, mentions, created_at, updated_at)
                     VALUES ('entity-nicholai', 'Nicholai', 'nicholai', 'person', NULL, 'agent-a', 10, ?1, ?1)",
                    rusqlite::params![now],
                )?;
                conn.execute(
                    "INSERT INTO entity_aspects (id, entity_id, agent_id, name, canonical_name, weight, created_at, updated_at)
                     VALUES ('aspect-nicholai-preferences', 'entity-nicholai', 'agent-a', 'preferences', 'preferences', 1.0, ?1, ?1)",
                    rusqlite::params![now],
                )?;
                conn.execute(
                    "INSERT INTO entity_attributes
                     (id, aspect_id, agent_id, memory_id, kind, content, normalized_content, confidence, importance,
                      status, group_key, claim_key, created_at, updated_at)
                     VALUES ('attr-nicholai-favorite-pens', 'aspect-nicholai-preferences', 'agent-a', NULL, 'attribute',
                      'Nicholai prefers Pilot G-2 0.7 mm, Pilot G-TEC-C4, and Pilot Razor Point II pens.',
                      'nicholai prefers pilot g 2 0 7 mm pilot g tec c4 and pilot razor point ii pens',
                      0.0, 0.0, 'active', 'writing_tools', 'favorite_pens', ?1, ?1)",
                    rusqlite::params![now],
                )?;
                Ok(serde_json::Value::Null)
            })
            .await
            .unwrap();

        let resp = prompt_submit(
            State(state.clone()),
            HeaderMap::new(),
            Json(PromptSubmitBody {
                harness: Some("test".to_string()),
                project: Some("platform/daemon-rs".to_string()),
                agent_id: Some("agent-a".to_string()),
                user_message: Some("what are nicholais favorite pens?".to_string()),
                user_prompt: None,
                last_assistant_message: None,
                session_key: Some("sess-prompt-path-terms".to_string()),
                transcript: None,
                transcript_path: None,
                runtime_path: None,
            }),
        )
        .await;

        assert_eq!(resp.status(), StatusCode::OK);
        let body = test_json(resp).await;
        assert_eq!(
            body["engine"],
            serde_json::Value::String("entity-context".to_string())
        );
        let inject = body["inject"].as_str().unwrap_or_default();
        assert!(inject.contains("Nicholai / preferences / writing_tools / favorite_pens"));
        assert!(inject.contains("Pilot G-2 0.7 mm"));

        drop(state);
        let _ = writer.await;
    }

    #[tokio::test]
    async fn prompt_submit_does_not_match_generic_plural_entity_terms() {
        let (state, writer, _tmp) = test_state("hooks-prompt-submit-generic-plural");
        state
            .pool
            .write(Priority::Low, move |conn| {
                let now = "2026-05-27T00:00:00Z";
                conn.execute(
                    "INSERT INTO entities (id, name, canonical_name, entity_type, description, agent_id, mentions, created_at, updated_at)
                     VALUES ('entity-project', 'Project', 'project', 'project', 'Generic project entity', 'agent-a', 50, ?1, ?1)",
                    rusqlite::params![now],
                )?;
                conn.execute(
                    "INSERT INTO entity_aspects (id, entity_id, agent_id, name, canonical_name, weight, created_at, updated_at)
                     VALUES ('aspect-project-roadmap', 'entity-project', 'agent-a', 'roadmap', 'roadmap', 1.0, ?1, ?1)",
                    rusqlite::params![now],
                )?;
                conn.execute(
                    "INSERT INTO entity_attributes
                     (id, aspect_id, agent_id, memory_id, kind, content, normalized_content, confidence, importance,
                      status, group_key, claim_key, created_at, updated_at)
                     VALUES ('attr-project-roadmap', 'aspect-project-roadmap', 'agent-a', NULL, 'attribute',
                      'Generic project roadmap context should not inject for plural projects.',
                      'generic project roadmap context should not inject for plural projects',
                      0.95, 0.9, 'active', 'general', 'roadmap', ?1, ?1)",
                    rusqlite::params![now],
                )?;
                Ok(serde_json::Value::Null)
            })
            .await
            .unwrap();

        let resp = prompt_submit(
            State(state.clone()),
            HeaderMap::new(),
            Json(PromptSubmitBody {
                harness: Some("test".to_string()),
                project: Some("platform/daemon-rs".to_string()),
                agent_id: Some("agent-a".to_string()),
                user_message: Some("projects roadmap".to_string()),
                user_prompt: None,
                last_assistant_message: None,
                session_key: Some("sess-prompt-generic-plural".to_string()),
                transcript: None,
                transcript_path: None,
                runtime_path: None,
            }),
        )
        .await;

        assert_eq!(resp.status(), StatusCode::OK);
        let body = test_json(resp).await;
        assert_eq!(
            body["engine"],
            serde_json::Value::String("no-entity".to_string())
        );
        assert_eq!(body["inject"], serde_json::Value::String(String::new()));

        drop(state);
        let _ = writer.await;
    }

    #[tokio::test]
    async fn prompt_submit_entity_only_alias_without_aspect_hit_stays_silent() {
        let (state, writer, _tmp) = test_state("hooks-prompt-submit-entity-only");
        state
            .pool
            .write(Priority::Low, move |conn| {
                conn.execute(
                    "INSERT INTO entities (id, name, canonical_name, entity_type, description, agent_id, mentions, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 10, ?7, ?7)",
                    rusqlite::params![
                        "entity-signet",
                        "Signet",
                        "signet",
                        "project",
                        "Source-backed agent continuity substrate",
                        "agent-a",
                        "2026-05-27T00:00:00Z",
                    ],
                )?;
                conn.execute(
                    "INSERT INTO entity_aliases (id, entity_id, agent_id, alias, canonical_alias, confidence, source, status, created_at, updated_at)
                     VALUES ('alias-signetai', 'entity-signet', 'agent-a', 'SignetAI', 'signetai', 1.0, 'test', 'active', ?1, ?1)",
                    rusqlite::params!["2026-05-27T00:00:00Z"],
                )?;
                conn.execute(
                    "INSERT INTO entity_aspects (id, entity_id, agent_id, name, canonical_name, weight, created_at, updated_at)
                     VALUES ('aspect-architecture', 'entity-signet', 'agent-a', 'architecture', 'architecture', 0.95, ?1, ?1)",
                    rusqlite::params!["2026-05-27T00:00:00Z"],
                )?;
                conn.execute(
                    "INSERT INTO entity_attributes
                     (id, aspect_id, agent_id, memory_id, kind, content, normalized_content, confidence, importance,
                      status, group_key, claim_key, created_at, updated_at)
                     VALUES ('attr-architecture', 'aspect-architecture', 'agent-a', NULL, 'attribute',
                      'Prompt context should come from entity current views.',
                      'prompt context should come from entity current views', 0.95, 0.9, 'active',
                      'runtime', 'prompt_context', ?1, ?1)",
                    rusqlite::params!["2026-05-27T00:00:00Z"],
                )?;
                Ok(serde_json::Value::Null)
            })
            .await
            .unwrap();

        let resp = prompt_submit(
            State(state.clone()),
            HeaderMap::new(),
            Json(PromptSubmitBody {
                harness: Some("test".to_string()),
                project: Some("platform/daemon-rs".to_string()),
                agent_id: Some("agent-a".to_string()),
                user_message: Some("SignetAI".to_string()),
                user_prompt: None,
                last_assistant_message: None,
                session_key: Some("sess-prompt-entity-only".to_string()),
                transcript: None,
                transcript_path: None,
                runtime_path: None,
            }),
        )
        .await;

        assert_eq!(resp.status(), StatusCode::OK);
        let body = test_json(resp).await;
        assert_eq!(body["inject"], serde_json::Value::String(String::new()));
        assert_eq!(body["memoryCount"], serde_json::Value::Number(0.into()));
        assert_eq!(
            body["engine"],
            serde_json::Value::String("no-aspect-hit".to_string())
        );

        drop(state);
        let _ = writer.await;
    }

    #[tokio::test]
    async fn prompt_submit_uses_scoped_semantic_attribute_relevance() {
        let (state, writer, _tmp) = test_state("hooks-prompt-submit-semantic-attribute");
        *state.embedding.write().await = Some(Arc::new(TestEmbeddingProvider {
            vector: vec![1.0, 0.0],
        }));
        state
            .pool
            .write(Priority::Low, move |conn| {
                conn.execute(
                    "INSERT INTO entities (id, name, canonical_name, entity_type, description, agent_id, mentions, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 10, ?7, ?7)",
                    rusqlite::params![
                        "entity-signet",
                        "Signet",
                        "signet",
                        "project",
                        "Source-backed agent continuity substrate",
                        "agent-a",
                        "2026-05-27T00:00:00Z",
                    ],
                )?;
                conn.execute(
                    "INSERT INTO entity_aliases (id, entity_id, agent_id, alias, canonical_alias, confidence, source, status, created_at, updated_at)
                     VALUES ('alias-signetai', 'entity-signet', 'agent-a', 'SignetAI', 'signetai', 1.0, 'test', 'active', ?1, ?1)",
                    rusqlite::params!["2026-05-27T00:00:00Z"],
                )?;
                conn.execute(
                    "INSERT INTO entity_aspects (id, entity_id, agent_id, name, canonical_name, weight, created_at, updated_at)
                     VALUES ('aspect-preferences', 'entity-signet', 'agent-a', 'preferences', 'preferences', 0.8, ?1, ?1)",
                    rusqlite::params!["2026-05-27T00:00:00Z"],
                )?;
                conn.execute(
                    "INSERT INTO entity_aspects (id, entity_id, agent_id, name, canonical_name, weight, created_at, updated_at)
                     VALUES ('aspect-marketing', 'entity-signet', 'agent-a', 'marketing', 'marketing', 0.2, ?1, ?1)",
                    rusqlite::params!["2026-05-27T00:00:00Z"],
                )?;
                conn.execute(
                    "INSERT INTO memories (id, type, content, confidence, importance, created_at, updated_at, agent_id)
                     VALUES ('mem-preferences-pen', 'preference', 'Favorite pen is a Pilot G-2.', 0.95, 0.9, ?1, ?1, 'agent-a')",
                    rusqlite::params!["2026-05-27T00:00:00Z"],
                )?;
                conn.execute(
                    "INSERT INTO entity_attributes
                     (id, aspect_id, agent_id, memory_id, kind, content, normalized_content, confidence, importance,
                      status, group_key, claim_key, created_at, updated_at)
                     VALUES ('attr-preferences-pen', 'aspect-preferences', 'agent-a', 'mem-preferences-pen', 'attribute',
                      'Favorite pen is a Pilot G-2.',
                      'favorite pen is a pilot g 2', 0.95, 0.9, 'active',
                      'writing', 'favorite_pen', ?1, ?1)",
                    rusqlite::params!["2026-05-27T00:00:00Z"],
                )?;
                conn.execute(
                    "INSERT INTO entity_attributes
                     (id, aspect_id, agent_id, memory_id, kind, content, normalized_content, confidence, importance,
                      status, group_key, claim_key, created_at, updated_at)
                     VALUES ('attr-marketing', 'aspect-marketing', 'agent-a', NULL, 'attribute',
                      'Marketing copy should stay secondary.',
                      'marketing copy should stay secondary', 0.8, 0.3, 'active',
                      'copy', 'positioning', ?1, ?1)",
                    rusqlite::params!["2026-05-27T00:00:00Z"],
                )?;
                conn.execute(
                    "INSERT INTO embeddings
                     (id, content_hash, vector, dimensions, source_type, source_id, chunk_text, created_at, agent_id)
                     VALUES ('emb-preferences-pen', 'hash-preferences-pen', ?1, 2, 'memory',
                      'mem-preferences-pen', 'Favorite pen is a Pilot G-2.', ?2, 'agent-a')",
                    rusqlite::params![vector_blob(&[1.0, 0.0]), "2026-05-27T00:00:00Z"],
                )?;
                Ok(serde_json::Value::Null)
            })
            .await
            .unwrap();

        let resp = prompt_submit(
            State(state.clone()),
            HeaderMap::new(),
            Json(PromptSubmitBody {
                harness: Some("test".to_string()),
                project: Some("platform/daemon-rs".to_string()),
                agent_id: Some("agent-a".to_string()),
                user_message: Some("Signet likes taking notes".to_string()),
                user_prompt: None,
                last_assistant_message: None,
                session_key: Some("sess-prompt-semantic-attribute".to_string()),
                transcript: None,
                transcript_path: None,
                runtime_path: None,
            }),
        )
        .await;

        assert_eq!(resp.status(), StatusCode::OK);
        let body = test_json(resp).await;
        let inject = body["inject"].as_str().unwrap_or_default();
        assert_eq!(
            body["engine"],
            serde_json::Value::String("entity-context".to_string())
        );
        assert!(inject.contains("Signet / preferences / writing / favorite_pen"));
        assert!(inject.contains("Favorite pen is a Pilot G-2."));
        assert!(!inject.contains("Marketing copy should stay secondary"));

        drop(state);
        let _ = writer.await;
    }

    #[tokio::test]
    async fn prompt_submit_rejects_mismatched_semantic_embedding_dimensions() {
        let (state, writer, _tmp) = test_state("hooks-prompt-submit-semantic-dimension");
        state
            .pool
            .write(Priority::Low, move |conn| {
                conn.execute(
                    "INSERT INTO memories (id, type, content, confidence, importance, created_at, updated_at, agent_id)
                     VALUES ('mem-preferences-pen', 'preference', 'Favorite pen is a Pilot G-2.', 0.95, 0.9, ?1, ?1, 'agent-a')",
                    rusqlite::params!["2026-05-27T00:00:00Z"],
                )?;
                conn.execute(
                    "INSERT INTO embeddings
                     (id, content_hash, vector, dimensions, source_type, source_id, chunk_text, created_at, agent_id)
                     VALUES ('emb-preferences-pen-short', 'hash-preferences-pen-short', ?1, 1, 'memory',
                      'mem-preferences-pen', 'Favorite pen is a Pilot G-2.', ?2, 'agent-a')",
                    rusqlite::params![vector_blob(&[1.0]), "2026-05-27T00:00:00Z"],
                )?;
                Ok(serde_json::Value::Null)
            })
            .await
            .unwrap();

        let score = state
            .pool
            .read(move |conn| {
                Ok(serde_json::json!(memory_embedding_score(
                    conn,
                    "mem-preferences-pen",
                    "agent-a",
                    Some(&[1.0, 0.0]),
                )))
            })
            .await
            .unwrap()
            .as_f64()
            .unwrap_or(1.0);

        assert_eq!(score, 0.0);

        drop(state);
        let _ = writer.await;
    }

    #[tokio::test]
    async fn prompt_submit_aspect_name_without_attribute_hit_stays_silent() {
        let (state, writer, _tmp) = test_state("hooks-prompt-submit-aspect-name-only");
        state
            .pool
            .write(Priority::Low, move |conn| {
                conn.execute(
                    "INSERT INTO entities (id, name, canonical_name, entity_type, description, agent_id, mentions, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 10, ?7, ?7)",
                    rusqlite::params![
                        "entity-signet",
                        "Signet",
                        "signet",
                        "project",
                        "Source-backed agent continuity substrate",
                        "agent-a",
                        "2026-05-27T00:00:00Z",
                    ],
                )?;
                conn.execute(
                    "INSERT INTO entity_aliases (id, entity_id, agent_id, alias, canonical_alias, confidence, source, status, created_at, updated_at)
                     VALUES ('alias-signetai', 'entity-signet', 'agent-a', 'SignetAI', 'signetai', 1.0, 'test', 'active', ?1, ?1)",
                    rusqlite::params!["2026-05-27T00:00:00Z"],
                )?;
                conn.execute(
                    "INSERT INTO entity_aspects (id, entity_id, agent_id, name, canonical_name, weight, created_at, updated_at)
                     VALUES ('aspect-architecture', 'entity-signet', 'agent-a', 'architecture', 'architecture', 0.95, ?1, ?1)",
                    rusqlite::params!["2026-05-27T00:00:00Z"],
                )?;
                conn.execute(
                    "INSERT INTO entity_attributes
                     (id, aspect_id, agent_id, memory_id, kind, content, normalized_content, confidence, importance,
                      status, group_key, claim_key, created_at, updated_at)
                     VALUES ('attr-architecture', 'aspect-architecture', 'agent-a', NULL, 'attribute',
                      'Prompt context should come from entity current views.',
                      'prompt context should come from entity current views', 0.95, 0.9, 'active',
                      'runtime', 'prompt_context', ?1, ?1)",
                    rusqlite::params!["2026-05-27T00:00:00Z"],
                )?;
                Ok(serde_json::Value::Null)
            })
            .await
            .unwrap();

        let resp = prompt_submit(
            State(state.clone()),
            HeaderMap::new(),
            Json(PromptSubmitBody {
                harness: Some("test".to_string()),
                project: Some("platform/daemon-rs".to_string()),
                agent_id: Some("agent-a".to_string()),
                user_message: Some("SignetAI architecture".to_string()),
                user_prompt: None,
                last_assistant_message: None,
                session_key: Some("sess-prompt-aspect-name-only".to_string()),
                transcript: None,
                transcript_path: None,
                runtime_path: None,
            }),
        )
        .await;

        assert_eq!(resp.status(), StatusCode::OK);
        let body = test_json(resp).await;
        assert_eq!(body["inject"], serde_json::Value::String(String::new()));
        assert_eq!(body["memoryCount"], serde_json::Value::Number(0.into()));
        assert_eq!(
            body["engine"],
            serde_json::Value::String("no-aspect-hit".to_string())
        );

        drop(state);
        let _ = writer.await;
    }

    #[tokio::test]
    async fn prompt_submit_short_entity_name_does_not_match_ordinary_token() {
        let (state, writer, _tmp) = test_state("hooks-prompt-submit-short-entity");
        state
            .pool
            .write(Priority::Low, move |conn| {
                conn.execute(
                    "INSERT INTO entities (id, name, canonical_name, entity_type, description, agent_id, mentions, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 10, ?7, ?7)",
                    rusqlite::params![
                        "entity-ai",
                        "AI",
                        "ai",
                        "concept",
                        "Short entity name",
                        "agent-a",
                        "2026-05-27T00:00:00Z",
                    ],
                )?;
                conn.execute(
                    "INSERT INTO entity_aspects (id, entity_id, agent_id, name, canonical_name, weight, created_at, updated_at)
                     VALUES ('aspect-ai-architecture', 'entity-ai', 'agent-a', 'architecture', 'architecture', 1.0, ?1, ?1)",
                    rusqlite::params!["2026-05-27T00:00:00Z"],
                )?;
                conn.execute(
                    "INSERT INTO entity_attributes
                     (id, aspect_id, agent_id, memory_id, kind, content, normalized_content, confidence, importance,
                      status, group_key, claim_key, created_at, updated_at)
                     VALUES ('attr-ai-architecture', 'aspect-ai-architecture', 'agent-a', NULL, 'attribute',
                      'Short entity names should not match ordinary words.',
                      'short entity names should not match ordinary words', 0.95, 0.9, 'active',
                      'runtime', 'short_match_guard', ?1, ?1)",
                    rusqlite::params!["2026-05-27T00:00:00Z"],
                )?;
                Ok(serde_json::Value::Null)
            })
            .await
            .unwrap();

        let resp = prompt_submit(
            State(state.clone()),
            HeaderMap::new(),
            Json(PromptSubmitBody {
                harness: Some("test".to_string()),
                project: Some("platform/daemon-rs".to_string()),
                agent_id: Some("agent-a".to_string()),
                user_message: Some("Can AI architecture be summarized?".to_string()),
                user_prompt: None,
                last_assistant_message: None,
                session_key: Some("sess-prompt-short-entity".to_string()),
                transcript: None,
                transcript_path: None,
                runtime_path: None,
            }),
        )
        .await;

        assert_eq!(resp.status(), StatusCode::OK);
        let body = test_json(resp).await;
        assert_eq!(body["inject"], serde_json::Value::String(String::new()));
        assert_eq!(body["memoryCount"], serde_json::Value::Number(0.into()));
        assert_eq!(
            body["engine"],
            serde_json::Value::String("no-entity".to_string())
        );

        drop(state);
        let _ = writer.await;
    }

    #[tokio::test]
    async fn prompt_submit_preserves_zero_min_score_config() {
        let (state, writer, _tmp) =
            test_state_with_manifest("hooks-prompt-submit-zero-min-score", |manifest| {
                manifest.hooks = Some(HooksConfig {
                    user_prompt_submit: UserPromptSubmitHookConfig {
                        min_score: 0.0,
                        ..Default::default()
                    },
                });
            });
        state
            .pool
            .write(Priority::Low, move |conn| {
                conn.execute(
                    "INSERT INTO entities (id, name, canonical_name, entity_type, description, agent_id, mentions, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 10, ?7, ?7)",
                    rusqlite::params![
                        "entity-signet",
                        "Signet",
                        "signet",
                        "project",
                        "Source-backed agent continuity substrate",
                        "agent-a",
                        "2026-05-27T00:00:00Z",
                    ],
                )?;
                conn.execute(
                    "INSERT INTO entity_aliases (id, entity_id, agent_id, alias, canonical_alias, confidence, source, status, created_at, updated_at)
                     VALUES ('alias-signetai', 'entity-signet', 'agent-a', 'SignetAI', 'signetai', 1.0, 'test', 'active', ?1, ?1)",
                    rusqlite::params!["2026-05-27T00:00:00Z"],
                )?;
                conn.execute(
                    "INSERT INTO entity_aspects (id, entity_id, agent_id, name, canonical_name, weight, created_at, updated_at)
                     VALUES ('aspect-low-weight', 'entity-signet', 'agent-a', 'low weight', 'low weight', 0.2, ?1, ?1)",
                    rusqlite::params!["2026-05-27T00:00:00Z"],
                )?;
                conn.execute(
                    "INSERT INTO entity_attributes
                     (id, aspect_id, agent_id, memory_id, kind, content, normalized_content, confidence, importance,
                      status, group_key, claim_key, created_at, updated_at)
                     VALUES ('attr-low-weight', 'aspect-low-weight', 'agent-a', NULL, 'attribute',
                      'Prompt context can opt into low-weight current views.',
                      'prompt context can opt into low weight current views', 0.8, 0.2, 'active',
                      'runtime', 'min_score_zero', ?1, ?1)",
                    rusqlite::params!["2026-05-27T00:00:00Z"],
                )?;
                Ok(serde_json::Value::Null)
            })
            .await
            .unwrap();

        let resp = prompt_submit(
            State(state.clone()),
            HeaderMap::new(),
            Json(PromptSubmitBody {
                harness: Some("test".to_string()),
                project: Some("platform/daemon-rs".to_string()),
                agent_id: Some("agent-a".to_string()),
                user_message: Some("Should SignetAI use current views?".to_string()),
                user_prompt: None,
                last_assistant_message: None,
                session_key: Some("sess-prompt-zero-min-score".to_string()),
                transcript: None,
                transcript_path: None,
                runtime_path: None,
            }),
        )
        .await;

        assert_eq!(resp.status(), StatusCode::OK);
        let body = test_json(resp).await;
        let inject = body["inject"].as_str().unwrap_or_default();
        assert_eq!(
            body["engine"],
            serde_json::Value::String("entity-context".to_string())
        );
        assert!(inject.contains("Signet / low weight / runtime / min_score_zero"));
        assert!(inject.contains("Prompt context can opt into low-weight current views."));

        drop(state);
        let _ = writer.await;
    }

    #[tokio::test]
    async fn prompt_submit_caps_entity_context_to_max_inject_chars() {
        let (state, writer, _tmp) =
            test_state_with_manifest("hooks-prompt-submit-max-inject-chars", |manifest| {
                manifest.hooks = Some(HooksConfig {
                    user_prompt_submit: UserPromptSubmitHookConfig {
                        max_inject_chars: 180,
                        ..Default::default()
                    },
                });
            });
        state
			.pool
			.write(Priority::Low, move |conn| {
				conn.execute(
					"INSERT INTO entities (id, name, canonical_name, entity_type, description, agent_id, mentions, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 10, ?7, ?7)",
					rusqlite::params![
						"entity-signet",
						"Signet",
						"signet",
						"project",
						"Source-backed agent continuity substrate",
						"agent-a",
						"2026-05-27T00:00:00Z",
					],
				)?;
				conn.execute(
					"INSERT INTO entity_aliases (id, entity_id, agent_id, alias, canonical_alias, confidence, source, status, created_at, updated_at)
                     VALUES ('alias-signetai', 'entity-signet', 'agent-a', 'SignetAI', 'signetai', 1.0, 'test', 'active', ?1, ?1)",
					rusqlite::params!["2026-05-27T00:00:00Z"],
				)?;
				conn.execute(
					"INSERT INTO entity_aspects (id, entity_id, agent_id, name, canonical_name, weight, created_at, updated_at)
                     VALUES ('aspect-architecture', 'entity-signet', 'agent-a', 'architecture', 'architecture', 1.0, ?1, ?1)",
					rusqlite::params!["2026-05-27T00:00:00Z"],
				)?;
				conn.execute(
					"INSERT INTO entity_attributes
                     (id, aspect_id, agent_id, memory_id, kind, content, normalized_content, confidence, importance,
                      status, group_key, claim_key, created_at, updated_at)
                     VALUES ('attr-architecture', 'aspect-architecture', 'agent-a', NULL, 'attribute',
                      'Prompt context should include this opening but must not include the reviewer regression tail beyond the configured prompt-submit injection budget.',
                      'prompt context should include this opening but must not include the reviewer regression tail beyond the configured prompt submit injection budget',
                      0.95, 0.9, 'active', 'runtime', 'prompt_context_budget', ?1, ?1)",
					rusqlite::params!["2026-05-27T00:00:00Z"],
				)?;
				Ok(serde_json::Value::Null)
			})
			.await
			.unwrap();

        let resp = prompt_submit(
            State(state.clone()),
            HeaderMap::new(),
            Json(PromptSubmitBody {
                harness: Some("test".to_string()),
                project: Some("platform/daemon-rs".to_string()),
                agent_id: Some("agent-a".to_string()),
                user_message: Some(
                    "Should SignetAI prompt context include current views?".to_string(),
                ),
                user_prompt: None,
                last_assistant_message: None,
                session_key: Some("sess-prompt-max-inject-chars".to_string()),
                transcript: None,
                transcript_path: None,
                runtime_path: None,
            }),
        )
        .await;

        assert_eq!(resp.status(), StatusCode::OK);
        let body = test_json(resp).await;
        let inject = body["inject"].as_str().unwrap_or_default();
        assert_eq!(
            body["engine"],
            serde_json::Value::String("entity-context".to_string())
        );
        assert!(inject.len() <= 180);
        assert!(inject.contains("# Current Date & Time"));
        assert!(inject.contains("## Relevant Entity Context"));
        assert!(inject.ends_with("..."));
        assert!(!inject.contains("reviewer regression tail"));

        drop(state);
        let _ = writer.await;
    }

    #[tokio::test]
    async fn prompt_submit_without_known_entity_stays_silent() {
        let (state, writer, _tmp) = test_state("hooks-prompt-submit-no-entity");

        let resp = prompt_submit(
            State(state.clone()),
            HeaderMap::new(),
            Json(PromptSubmitBody {
                harness: Some("test".to_string()),
                project: Some("platform/daemon-rs".to_string()),
                agent_id: Some("agent-a".to_string()),
                user_message: Some("show prompt submit observability review".to_string()),
                user_prompt: None,
                last_assistant_message: None,
                session_key: Some("sess-prompt-silent".to_string()),
                transcript: None,
                transcript_path: None,
                runtime_path: None,
            }),
        )
        .await;

        assert_eq!(resp.status(), StatusCode::OK);
        let body = test_json(resp).await;
        assert_eq!(body["inject"], serde_json::Value::String(String::new()));
        assert_eq!(
            body["engine"],
            serde_json::Value::String("no-entity".to_string())
        );

        drop(state);
        let _ = writer.await;
    }

    #[test]
    fn normalize_session_transcript_normalizes_item_completed_text() {
        let raw = [
            r#"{"type":"item.completed","item":{"type":"agent_message","text":"line one\r\nline two"}}"#,
            r#"{"type":"event_msg","payload":{"type":"user_message","message":"done"}}"#,
        ]
        .join("\n");

        let normalized = normalize_session_transcript(&raw);

        assert!(normalized.contains("Assistant: line one  line two"));
        assert!(normalized.contains("User: done"));
    }

    #[test]
    fn resolve_audit_token_uses_full_raw_hash_when_session_identity_missing() {
        let raw = "User: audit me\nAssistant: on it";
        let raw_hash = {
            let mut digest = Sha256::new();
            digest.update(raw.as_bytes());
            digest
                .finalize()
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>()
        };
        let expected = {
            let mut digest = Sha256::new();
            digest.update(b"agent-a");
            digest.update(b":");
            digest.update(raw_hash.as_bytes());
            digest
                .finalize()
                .iter()
                .take(8)
                .map(|b| format!("{b:02x}"))
                .collect::<String>()
        };

        assert_eq!(resolve_audit_token("agent-a", "", None, raw), expected);
    }

    #[tokio::test]
    async fn prompt_submit_writes_transcript_audit_and_live_snapshot() {
        let (state, writer, tmp) = test_state("hooks-prompt-submit-audit");
        let stage_dir = std::path::Path::new("/tmp/signet");
        std::fs::create_dir_all(stage_dir).unwrap();
        let transcript_path = stage_dir.join(format!(
            "prompt-transcript-{}.txt",
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        std::fs::write(
            &transcript_path,
            "User: review the release checklist
Assistant: here's the checklist",
        )
        .unwrap();

        let resp = prompt_submit(
            State(state.clone()),
            HeaderMap::new(),
            Json(PromptSubmitBody {
                harness: Some("test".to_string()),
                project: Some("platform/daemon-rs".to_string()),
                agent_id: Some("agent-a".to_string()),
                user_message: Some("review the release checklist".to_string()),
                user_prompt: None,
                last_assistant_message: None,
                session_key: Some("sess-prompt-audit".to_string()),
                transcript: None,
                transcript_path: Some(transcript_path.display().to_string()),
                runtime_path: None,
            }),
        )
        .await;

        assert_eq!(resp.status(), StatusCode::OK);

        let stored = state
            .pool
            .read(|conn| {
                session_transcript_content(conn, "sess-prompt-audit", "agent-a")
                    .map_err(|err| signet_core::error::CoreError::Migration(err.to_string()))
            })
            .await
            .unwrap();
        assert!(
            stored
                .as_deref()
                .is_some_and(|value| value.contains("review the release checklist"))
        );

        let audit_dir = tmp.path().join(".daemon/logs/transcripts");
        let audit_entries = std::fs::read_dir(&audit_dir)
            .unwrap()
            .filter_map(|entry| entry.ok().map(|value| value.path()))
            .collect::<Vec<_>>();
        assert!(audit_entries.iter().any(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.ends_with("--latest.log"))
        }));
        let _ = std::fs::remove_file(&transcript_path);

        drop(state);
        let _ = writer.await;
    }

    #[tokio::test]
    async fn session_end_skips_transcript_artifact_for_noise_session() {
        let (state, writer, _tmp) = test_state("hooks-session-end-noise");
        state
            .pool
            .write(Priority::Low, |conn| {
                upsert_session_transcript(
                    conn,
                    "agent:agent-a:sess-noise",
                    "checkpoint transcript",
                    "codex",
                    Some("/tmp/signetai"),
                    "agent-a",
                )?;
                Ok(serde_json::Value::Null)
            })
            .await
            .unwrap();
        let transcript = [
            "User: this is a temp-session smoke test.",
            "Assistant: skip canonical transcript artifacts for /tmp projects.",
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
                session_key: Some("agent:agent-a:sess-noise".to_string()),
                cwd: Some("/tmp/signetai".to_string()),
                reason: None,
                runtime_path: None,
                agent_id: Some("agent-a".to_string()),
            }),
        )
        .await;

        assert_eq!(resp.status(), StatusCode::OK);
        let body = test_json(resp).await;
        assert_eq!(body["queued"], serde_json::Value::Bool(false));

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

        assert_eq!(counts.0, 0);
        assert_eq!(counts.1, 0);
        assert_eq!(counts.2, 0);
        assert_eq!(counts.3, 0);

        drop(state);
        let _ = writer.await;
    }

    #[tokio::test]
    async fn session_end_falls_back_to_stored_live_transcript_when_final_input_missing() {
        let (state, writer, tmp) = test_state("hooks-session-end-live-fallback");
        let now = chrono::Utc::now().to_rfc3339();
        state
            .pool
            .write(Priority::Low, move |conn| {
                conn.execute(
                    "INSERT INTO session_transcripts (session_key, content, harness, project, agent_id, created_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    rusqlite::params![
                        "agent:agent-a:sess-live-fallback",
                        "User: keep the live transcript if session-end falls over.\nAssistant: using the stored live transcript avoids losing the session.\n"
                            .repeat(8),
                        "test",
                        "platform/daemon-rs",
                        "agent-a",
                        now
                    ],
                )?;
                Ok(serde_json::Value::Null)
            })
            .await
            .unwrap();

        let resp = session_end(
            State(state.clone()),
            HeaderMap::new(),
            Json(SessionEndBody {
                harness: Some("test".to_string()),
                transcript: None,
                transcript_path: None,
                session_id: Some("sess-live-fallback".to_string()),
                session_key: Some("agent:agent-a:sess-live-fallback".to_string()),
                cwd: Some("platform/daemon-rs".to_string()),
                reason: None,
                runtime_path: None,
                agent_id: Some("agent-a".to_string()),
            }),
        )
        .await;

        assert_eq!(resp.status(), StatusCode::OK);
        let body = test_json(resp).await;
        assert_eq!(body["queued"], serde_json::Value::Bool(true));

        let transcript = std::fs::read_dir(tmp.path().join("memory"))
            .unwrap()
            .filter_map(|entry| entry.ok().map(|value| value.path()))
            .find(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.ends_with("--transcript.md"))
            })
            .map(|path| std::fs::read_to_string(path).unwrap())
            .unwrap();
        assert!(transcript.contains("keep the live transcript if session-end falls over"));
        assert!(transcript.contains("using the stored live transcript avoids losing the session"));

        drop(state);
        let _ = writer.await;
    }

    #[tokio::test]
    async fn session_end_writes_raw_audit_logs_but_keeps_canonical_transcript_clean() {
        let (state, writer, tmp) = test_state("hooks-session-end-audit");
        let transcript = [
            r#"{"type":"event_msg","payload":{"type":"user_message","message":"Run diagnostics"}}"#,
            r#"{"type":"response_item","payload":{"type":"function_call","name":"shell","arguments":"{\"cmd\":\"ls\"}"}}"#,
            r#"{"type":"response_item","payload":{"type":"function_call_output","output":"README.md"}}"#,
            r#"{"type":"item.completed","item":{"type":"agent_message","text":"Diagnostics complete"}}"#,
        ]
        .join("\n")
            + "\n";
        let transcript = transcript.repeat(20);

        let resp = session_end(
            State(state.clone()),
            HeaderMap::new(),
            Json(SessionEndBody {
                harness: Some("codex".to_string()),
                transcript: Some(transcript),
                transcript_path: None,
                session_id: Some("sess-audit".to_string()),
                session_key: Some("agent:agent-a:sess-audit".to_string()),
                cwd: Some("platform/daemon-rs".to_string()),
                reason: None,
                runtime_path: None,
                agent_id: Some("agent-a".to_string()),
            }),
        )
        .await;

        assert_eq!(resp.status(), StatusCode::OK);
        let body = test_json(resp).await;
        assert_eq!(body["queued"], serde_json::Value::Bool(true));

        let canonical = std::fs::read_dir(tmp.path().join("memory"))
            .unwrap()
            .filter_map(|entry| entry.ok().map(|value| value.path()))
            .find(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.ends_with("--transcript.md"))
            })
            .map(|path| std::fs::read_to_string(path).unwrap())
            .unwrap();
        assert!(canonical.contains("User: Run diagnostics"));
        assert!(canonical.contains("Assistant: Diagnostics complete"));
        assert!(!canonical.contains("function_call"));
        assert!(!canonical.contains("README.md"));

        let audit_dir = tmp.path().join(".daemon").join("logs").join("transcripts");
        let audit = std::fs::read_dir(audit_dir)
            .unwrap()
            .filter_map(|entry| entry.ok().map(|value| value.path()))
            .find(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.ends_with("--raw-transcript.log"))
            })
            .map(|path| std::fs::read_to_string(path).unwrap())
            .unwrap();
        assert!(audit.contains("\"type\":\"function_call\""));
        assert!(audit.contains("README.md"));

        drop(state);
        let _ = writer.await;
    }

    #[tokio::test]
    async fn compaction_complete_skips_noise_session_writes() {
        let (state, writer, tmp) = test_state("hooks-compaction-noise");

        let resp = compaction_complete(
            State(state.clone()),
            HeaderMap::new(),
            Json(CompactionCompleteBody {
                harness: Some("codex".to_string()),
                summary: Some(
                    "# Compaction Summary\n\n## temp\n\nSkip compaction writes for temp sessions."
                        .to_string(),
                ),
                session_key: Some("agent:agent-a:sess-noise".to_string()),
                project: Some("/tmp/signetai".to_string()),
                agent_id: Some("agent-a".to_string()),
                runtime_path: None,
            }),
        )
        .await;

        assert_eq!(resp.status(), StatusCode::OK);
        let body = test_json(resp).await;
        assert_eq!(body["success"], serde_json::Value::Bool(true));
        assert!(body["memoryId"].is_null());

        let counts = state
            .pool
            .read(|conn| {
                let artifacts: i64 = conn
                    .query_row(
                        "SELECT COUNT(*) FROM memory_artifacts WHERE source_kind = 'compaction'",
                        [],
                        |row| row.get(0),
                    )
                    .unwrap_or(0);
                let memories: i64 = conn
                    .query_row("SELECT COUNT(*) FROM memories", [], |row| row.get(0))
                    .unwrap_or(0);
                let summaries: i64 = conn
                    .query_row("SELECT COUNT(*) FROM session_summaries", [], |row| {
                        row.get(0)
                    })
                    .unwrap_or(0);
                let heads: i64 = conn
                    .query_row("SELECT COUNT(*) FROM memory_thread_heads", [], |row| {
                        row.get(0)
                    })
                    .unwrap_or(0);
                Ok((artifacts, memories, summaries, heads))
            })
            .await
            .unwrap();

        assert_eq!(counts.0, 0);
        assert_eq!(counts.1, 0);
        assert_eq!(counts.2, 0);
        assert_eq!(counts.3, 0);
        assert!(!has_markdown(&tmp.path().join("memory")));

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
    fn build_signet_system_prompt_mentions_transcript_artifacts() {
        let prompt = build_signet_system_prompt();
        assert!(prompt.contains("linked summary and transcript artifacts"));
        assert!(prompt.contains("Memory Check Loop"));
        assert!(prompt.contains("before commands, file edits, architectural choices"));
        assert!(prompt.contains("run 1-3 targeted recalls with mcp__signet__memory_search"));
        assert!(prompt.contains("missing automatic memory match as proof no prior context exists"));
    }

    #[test]
    fn normalize_session_transcript_strips_codex_tool_turns() {
        let raw = [
            r#"{"type":"event_msg","payload":{"type":"user_message","message":"Hello"}}"#,
            r#"{"type":"response_item","payload":{"type":"function_call","name":"shell","arguments":"{\"cmd\":\"ls\"}"}}"#,
            r#"{"type":"response_item","payload":{"type":"function_call_output","output":"README.md"}}"#,
            r#"{"type":"item.completed","item":{"type":"agent_message","text":"Hi"}}"#,
        ]
        .join("\n");
        assert_eq!(
            normalize_session_transcript(&raw),
            "User: Hello\nAssistant: Hi"
        );
    }

    #[test]
    fn normalize_session_transcript_returns_empty_for_tool_only_jsonl() {
        let raw = [
            r#"{"type":"response_item","payload":{"type":"function_call","name":"shell","arguments":"{\"cmd\":\"ls\"}"}}"#,
            r#"{"type":"response_item","payload":{"type":"function_call_output","output":"README.md"}}"#,
        ]
        .join("\n");
        assert_eq!(normalize_session_transcript(&raw), "");
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
