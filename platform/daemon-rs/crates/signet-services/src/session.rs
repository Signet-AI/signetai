//! Session management: tracker (runtime path mutex), continuity state,
//! checkpoint CRUD.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};

use signet_core::error::CoreError;
use signet_core::types::SessionCheckpoint;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STALE_SESSION_MS: u64 = 4 * 60 * 60 * 1000; // 4 hours
const MAX_PENDING_QUERIES: usize = 20;
const MAX_PENDING_REMEMBERS: usize = 10;
const MAX_PENDING_SNIPPETS: usize = 10;
const SNIPPET_MAX_LEN: usize = 200;

// ---------------------------------------------------------------------------
// Runtime path
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuntimePath {
    Plugin,
    Legacy,
}

impl RuntimePath {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "plugin" => Some(Self::Plugin),
            "legacy" => Some(Self::Legacy),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Plugin => "plugin",
            Self::Legacy => "legacy",
        }
    }
}

// ---------------------------------------------------------------------------
// Session claim
// ---------------------------------------------------------------------------

struct SessionClaim {
    path: RuntimePath,
    expires: Instant,
    bypassed: bool,
    agent_id: String,
    /// ISO-8601 timestamp recorded when the claim was first created.
    claimed_at: String,
}

impl SessionClaim {
    fn is_stale(&self) -> bool {
        Instant::now() > self.expires
    }

    fn refresh(&mut self) {
        self.expires = Instant::now() + Duration::from_millis(STALE_SESSION_MS);
    }

    /// Compute the absolute expiry as an ISO-8601 string by projecting the
    /// remaining TTL onto the current wall clock.
    fn expires_at_iso(&self) -> String {
        let remaining = self.expires.saturating_duration_since(Instant::now());
        let wall = std::time::SystemTime::now() + remaining;
        let ts = wall
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        chrono::DateTime::from_timestamp(ts as i64, 0)
            .unwrap_or_else(chrono::Utc::now)
            .to_rfc3339()
    }
}

// ---------------------------------------------------------------------------
// Session tracker
// ---------------------------------------------------------------------------

pub struct SessionTracker {
    claims: Mutex<HashMap<String, SessionClaim>>,
    /// Bypass state stored independently of tracker claims, mirroring the TS
    /// `bypassedSessions` Set. Allows presence-only sessions to be bypassed
    /// without a live tracker claim.
    ///
    /// Agent-scoping is NOT needed here: the bypass write path
    /// (`routes::sessions::bypass`) calls `find_live_session(key, agent_id)`
    /// before writing, so only agent-verified keys are ever stored.
    /// Session keys embed the agent ID (`agent:<id>:<uuid>`), making
    /// cross-agent key sharing structurally impossible in practice.
    bypassed_keys: Mutex<std::collections::HashSet<String>>,
}

#[derive(Debug)]
pub enum ClaimResult {
    Ok,
    Conflict { claimed_by: RuntimePath },
}

impl SessionTracker {
    fn normalize_key<'a>(key: &'a str) -> &'a str {
        key.strip_prefix("session:").unwrap_or(key)
    }

    pub fn new() -> Self {
        Self {
            claims: Mutex::new(HashMap::new()),
            bypassed_keys: Mutex::new(std::collections::HashSet::new()),
        }
    }

    /// Claim a session for a runtime path. Returns Ok if claimed successfully
    /// or conflict if claimed by another path.
    pub fn claim(&self, key: &str, path: RuntimePath, agent_id: &str) -> ClaimResult {
        let key = Self::normalize_key(key);
        let mut claims = self.claims.lock().unwrap();

        if let Some(claim) = claims.get_mut(key) {
            if claim.path == path {
                claim.refresh();
                return ClaimResult::Ok;
            }
            if claim.is_stale() {
                // Evict stale claim
                claims.remove(key);
            } else {
                return ClaimResult::Conflict {
                    claimed_by: claim.path,
                };
            }
        }

        // Clear any stale bypass state for this key so a new session on the
        // same key does not inherit bypass from a previous session lifetime.
        self.bypassed_keys.lock().unwrap().remove(key);
        claims.insert(
            key.to_string(),
            SessionClaim {
                path,
                expires: Instant::now() + Duration::from_millis(STALE_SESSION_MS),
                bypassed: false,
                agent_id: agent_id.to_string(),
                claimed_at: chrono::Utc::now().to_rfc3339(),
            },
        );
        ClaimResult::Ok
    }

    /// Release a session. Clears both the tracker claim and any bypass state
    /// so bypass does not leak across session lifetimes.
    pub fn release(&self, key: &str) {
        let key = Self::normalize_key(key);
        self.claims.lock().unwrap().remove(key);
        self.bypassed_keys.lock().unwrap().remove(key);
    }

    /// Get the runtime path for a session.
    pub fn get_path(&self, key: &str) -> Option<RuntimePath> {
        let key = Self::normalize_key(key);
        let mut claims = self.claims.lock().unwrap();
        if let Some(claim) = claims.get(key) {
            if claim.is_stale() {
                claims.remove(key);
                return None;
            }
            Some(claim.path)
        } else {
            None
        }
    }

    /// Check if session path matches, returns conflict response if not.
    pub fn check(&self, key: &str, path: RuntimePath) -> Option<RuntimePath> {
        let key = Self::normalize_key(key);
        let claims = self.claims.lock().unwrap();
        if let Some(claim) = claims.get(key)
            && !claim.is_stale()
            && claim.path != path
        {
            return Some(claim.path);
        }
        None
    }

    /// Renew a session's TTL. Returns true if the session was found and
    /// refreshed, false if the session is not tracked or already expired.
    /// Mirrors TS renewSession() — called on checkpoint-extract to keep
    /// long-lived sessions (Discord bots) alive without ending them.
    pub fn renew(&self, key: &str) -> bool {
        let key = Self::normalize_key(key);
        let mut claims = self.claims.lock().unwrap();
        if let Some(claim) = claims.get_mut(key) {
            if claim.is_stale() {
                claims.remove(key);
                return false;
            }
            claim.refresh();
            true
        } else {
            false
        }
    }

    /// Bypass a session. Works for both tracker-claimed and presence-only
    /// sessions — bypass state is stored in a separate set (mirrors TS
    /// `bypassedSessions`), so it does not require an active tracker claim.
    pub fn bypass(&self, key: &str) {
        let key = Self::normalize_key(key);
        self.bypassed_keys.lock().unwrap().insert(key.to_string());
        if let Some(claim) = self.claims.lock().unwrap().get_mut(key) {
            claim.bypassed = true;
        }
    }

    /// Unbypass a session.
    pub fn unbypass(&self, key: &str) {
        let key = Self::normalize_key(key);
        self.bypassed_keys.lock().unwrap().remove(key);
        if let Some(claim) = self.claims.lock().unwrap().get_mut(key) {
            claim.bypassed = false;
        }
    }

    /// Check if session is bypassed. Checks the independent bypass set so
    /// presence-only sessions (not in tracker) are also handled correctly.
    pub fn is_bypassed(&self, key: &str) -> bool {
        let key = Self::normalize_key(key);
        self.bypassed_keys.lock().unwrap().contains(key)
    }

    /// List active sessions.
    pub fn list_sessions(&self, agent_id: Option<&str>) -> Vec<SessionInfo> {
        let claims = self.claims.lock().unwrap();
        claims
            .iter()
            .filter(|(_, c)| !c.is_stale())
            .filter(|(_, c)| agent_id.map_or(true, |aid| c.agent_id == aid))
            .map(|(key, claim)| SessionInfo {
                key: key.clone(),
                agent_id: claim.agent_id.clone(),
                runtime_path: claim.path.as_str().to_string(),
                claimed_at: claim.claimed_at.clone(),
                expires_at: claim.expires_at_iso(),
                bypassed: claim.bypassed,
            })
            .collect()
    }

    /// Clean up stale sessions. Bypass state is NOT pruned here — presence-only
    /// sessions never have tracker claims so their bypass entries would be
    /// incorrectly removed. Bypass state is only cleared on explicit release(),
    /// matching the TS bypassedSessions Set lifecycle.
    pub fn cleanup(&self) -> usize {
        let mut claims = self.claims.lock().unwrap();
        let before = claims.len();
        claims.retain(|_, c| !c.is_stale());
        before - claims.len()
    }
}

impl Default for SessionTracker {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub key: String,
    #[serde(skip)]
    pub agent_id: String,
    pub runtime_path: String,
    pub claimed_at: String,
    pub expires_at: String,
    pub bypassed: bool,
}

impl Serialize for RuntimePath {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for RuntimePath {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let s = String::deserialize(d)?;
        Self::parse(&s).ok_or_else(|| serde::de::Error::custom("invalid runtime path"))
    }
}

// ---------------------------------------------------------------------------
// Continuity state (in-memory per-session accumulation)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct ContinuityState {
    pub session_key: String,
    pub harness: String,
    pub project: Option<String>,
    pub project_normalized: Option<String>,
    pub prompt_count: u32,
    pub total_prompt_count: u32,
    pub last_checkpoint_at: Instant,
    pub pending_queries: Vec<String>,
    pub pending_remembers: Vec<String>,
    pub pending_snippets: Vec<String>,
    pub started_at: Instant,
    pub structural_snapshot: Option<StructuralSnapshot>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StructuralSnapshot {
    pub focal_entity_ids: Vec<String>,
    pub focal_entity_names: Vec<String>,
    pub active_aspect_ids: Vec<String>,
    pub surfaced_constraint_count: i64,
    pub traversal_memory_count: i64,
}

#[derive(Debug, Clone)]
pub struct ContinuitySnapshot {
    pub session_key: String,
    pub harness: String,
    pub project: Option<String>,
    pub project_normalized: Option<String>,
    pub prompt_count: u32,
    pub total_prompt_count: u32,
    pub queries: Vec<String>,
    pub remembers: Vec<String>,
    pub snippets: Vec<String>,
    pub duration_secs: u64,
    pub structural: Option<StructuralSnapshot>,
}

pub struct ContinuityTracker {
    states: Mutex<HashMap<String, ContinuityState>>,
}

impl ContinuityTracker {
    pub fn new() -> Self {
        Self {
            states: Mutex::new(HashMap::new()),
        }
    }

    /// Initialize continuity for a session.
    pub fn init(
        &self,
        session_key: &str,
        harness: &str,
        project: Option<&str>,
        project_normalized: Option<&str>,
    ) {
        let mut states = self.states.lock().unwrap();
        states.insert(
            session_key.to_string(),
            ContinuityState {
                session_key: session_key.to_string(),
                harness: harness.to_string(),
                project: project.map(|s| s.to_string()),
                project_normalized: project_normalized.map(|s| s.to_string()),
                prompt_count: 0,
                total_prompt_count: 0,
                last_checkpoint_at: Instant::now(),
                pending_queries: Vec::new(),
                pending_remembers: Vec::new(),
                pending_snippets: Vec::new(),
                started_at: Instant::now(),
                structural_snapshot: None,
            },
        );
    }

    /// Record a prompt (keyword terms + snippet).
    pub fn record_prompt(&self, session_key: &str, query_terms: &str, snippet: &str) {
        let mut states = self.states.lock().unwrap();
        if let Some(state) = states.get_mut(session_key) {
            state.prompt_count += 1;
            state.total_prompt_count += 1;

            if !query_terms.is_empty() && state.pending_queries.len() < MAX_PENDING_QUERIES {
                state.pending_queries.push(query_terms.to_string());
            }
            if !snippet.is_empty() && state.pending_snippets.len() < MAX_PENDING_SNIPPETS {
                let truncated = if snippet.len() > SNIPPET_MAX_LEN {
                    &snippet[..SNIPPET_MAX_LEN]
                } else {
                    snippet
                };
                state.pending_snippets.push(truncated.to_string());
            }
        }
    }

    /// Record a /remember call.
    pub fn record_remember(&self, session_key: &str, content: &str) {
        let mut states = self.states.lock().unwrap();
        if let Some(state) = states.get_mut(session_key)
            && state.pending_remembers.len() < MAX_PENDING_REMEMBERS
        {
            let truncated = if content.len() > SNIPPET_MAX_LEN {
                &content[..SNIPPET_MAX_LEN]
            } else {
                content
            };
            state.pending_remembers.push(truncated.to_string());
        }
    }

    /// Set the structural snapshot for a session.
    pub fn set_structural_snapshot(&self, session_key: &str, snapshot: StructuralSnapshot) {
        let mut states = self.states.lock().unwrap();
        if let Some(state) = states.get_mut(session_key) {
            state.structural_snapshot = Some(snapshot);
        }
    }

    /// Check if a checkpoint should trigger based on config thresholds.
    pub fn should_checkpoint(
        &self,
        session_key: &str,
        prompt_interval: u32,
        time_interval_secs: u64,
    ) -> bool {
        let states = self.states.lock().unwrap();
        if let Some(state) = states.get(session_key) {
            if state.prompt_count >= prompt_interval {
                return true;
            }
            let elapsed = state.last_checkpoint_at.elapsed().as_secs();
            if elapsed >= time_interval_secs && state.prompt_count > 0 {
                return true;
            }
        }
        false
    }

    /// Consume state: return snapshot and reset prompt counters.
    /// Read a snapshot clone without consuming pending state.
    /// Use this when you need the snapshot to attempt a write first;
    /// call `consume` only after the write succeeds so a write failure
    /// leaves pending data in memory for a safe retry.
    pub fn peek_snapshot(&self, session_key: &str) -> Option<ContinuitySnapshot> {
        let states = self.states.lock().unwrap();
        let state = states.get(session_key)?;
        Some(ContinuitySnapshot {
            session_key: state.session_key.clone(),
            harness: state.harness.clone(),
            project: state.project.clone(),
            project_normalized: state.project_normalized.clone(),
            prompt_count: state.prompt_count,
            total_prompt_count: state.total_prompt_count,
            queries: state.pending_queries.clone(),
            remembers: state.pending_remembers.clone(),
            snippets: state.pending_snippets.clone(),
            duration_secs: state.started_at.elapsed().as_secs(),
            structural: state.structural_snapshot.clone(),
        })
    }

    pub fn consume(&self, session_key: &str) -> Option<ContinuitySnapshot> {
        let mut states = self.states.lock().unwrap();
        let state = states.get_mut(session_key)?;

        let snapshot = ContinuitySnapshot {
            session_key: state.session_key.clone(),
            harness: state.harness.clone(),
            project: state.project.clone(),
            project_normalized: state.project_normalized.clone(),
            prompt_count: state.prompt_count,
            total_prompt_count: state.total_prompt_count,
            queries: std::mem::take(&mut state.pending_queries),
            remembers: std::mem::take(&mut state.pending_remembers),
            snippets: std::mem::take(&mut state.pending_snippets),
            duration_secs: state.started_at.elapsed().as_secs(),
            structural: state.structural_snapshot.clone(),
        };

        state.prompt_count = 0;
        state.last_checkpoint_at = Instant::now();

        Some(snapshot)
    }

    /// Clear continuity state for a session.
    pub fn clear(&self, session_key: &str) {
        let mut states = self.states.lock().unwrap();
        states.remove(session_key);
    }

    /// Get total prompt count (non-consuming).
    pub fn total_prompt_count(&self, session_key: &str) -> u32 {
        let states = self.states.lock().unwrap();
        states
            .get(session_key)
            .map(|s| s.total_prompt_count)
            .unwrap_or(0)
    }
}

impl Default for ContinuityTracker {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// Dedup state
// ---------------------------------------------------------------------------

/// Tracks session-start dedup (prevent re-injection) and prompt dedup (recent memory IDs).
pub struct DedupState {
    session_start_seen: Mutex<HashMap<String, bool>>,
    prompt_recent: Mutex<HashMap<String, Vec<Vec<String>>>>,
}

impl DedupState {
    pub fn new() -> Self {
        Self {
            session_start_seen: Mutex::new(HashMap::new()),
            prompt_recent: Mutex::new(HashMap::new()),
        }
    }

    fn session_start_scope_key(
        agent_id: &str,
        harness: Option<&str>,
        project: Option<&str>,
        session_key: &str,
    ) -> String {
        [
            agent_id.trim(),
            harness.unwrap_or_default().trim(),
            project.unwrap_or_default().trim(),
            session_key.trim(),
        ]
        .join("\0")
    }

    /// Mark session start as seen. Returns true if already seen.
    pub fn mark_session_start(&self, session_key: &str) -> bool {
        self.mark_session_start_scoped("default", None, None, session_key)
    }

    pub fn has_session_start_scoped(
        &self,
        agent_id: &str,
        harness: Option<&str>,
        project: Option<&str>,
        session_key: &str,
    ) -> bool {
        let key = Self::session_start_scope_key(agent_id, harness, project, session_key);
        self.session_start_seen.lock().unwrap().contains_key(&key)
    }

    /// Mark an agent/harness/project-scoped session start as seen.
    /// Mirrors TS `sessionStartDedupeKey()` so agents that share a raw
    /// harness session key do not suppress each other's first full inject.
    pub fn mark_session_start_scoped(
        &self,
        agent_id: &str,
        harness: Option<&str>,
        project: Option<&str>,
        session_key: &str,
    ) -> bool {
        let key = Self::session_start_scope_key(agent_id, harness, project, session_key);
        let mut seen = self.session_start_seen.lock().unwrap();
        if seen.contains_key(&key) {
            true
        } else {
            seen.insert(key, true);
            false
        }
    }

    /// Clear session start mark.
    pub fn clear_session_start(&self, session_key: &str) {
        self.clear_session_start_scoped("default", None, None, session_key);
        let mut seen = self.session_start_seen.lock().unwrap();
        seen.retain(|key, _| key.rsplit('\0').next() != Some(session_key.trim()));
    }

    pub fn clear_session_start_scoped(
        &self,
        agent_id: &str,
        harness: Option<&str>,
        project: Option<&str>,
        session_key: &str,
    ) {
        let key = Self::session_start_scope_key(agent_id, harness, project, session_key);
        let mut seen = self.session_start_seen.lock().unwrap();
        seen.remove(&key);
    }

    /// Record injected memory IDs for dedup window (last 5 prompts).
    pub fn record_prompt_ids(&self, session_key: &str, ids: Vec<String>) {
        let mut recent = self.prompt_recent.lock().unwrap();
        let window = recent.entry(session_key.to_string()).or_default();
        window.push(ids);
        if window.len() > 5 {
            window.remove(0);
        }
    }

    /// Get all memory IDs in recent dedup window.
    pub fn recent_ids(&self, session_key: &str) -> Vec<String> {
        let recent = self.prompt_recent.lock().unwrap();
        recent
            .get(session_key)
            .map(|w| w.iter().flatten().cloned().collect())
            .unwrap_or_default()
    }

    /// Clear dedup state for a session.
    pub fn clear(&self, session_key: &str) {
        let mut recent = self.prompt_recent.lock().unwrap();
        recent.remove(session_key);
    }

    /// Reset dedup on compaction (allows re-injection after context flush).
    pub fn reset_prompt_dedup(&self, session_key: &str) {
        let mut recent = self.prompt_recent.lock().unwrap();
        recent.remove(session_key);
    }
}

impl Default for DedupState {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// Checkpoint CRUD
// ---------------------------------------------------------------------------

fn row_to_checkpoint(row: &rusqlite::Row) -> rusqlite::Result<SessionCheckpoint> {
    Ok(SessionCheckpoint {
        id: row.get("id")?,
        session_key: row.get("session_key")?,
        harness: row.get("harness")?,
        project: row.get("project")?,
        project_normalized: row.get("project_normalized")?,
        trigger: row.get("trigger")?,
        digest: row.get("digest")?,
        prompt_count: row.get("prompt_count")?,
        memory_queries: row.get("memory_queries")?,
        recent_remembers: row.get("recent_remembers")?,
        created_at: row.get("created_at")?,
        focal_entity_ids: row.get("focal_entity_ids")?,
        focal_entity_names: row.get("focal_entity_names")?,
        active_aspect_ids: row.get("active_aspect_ids")?,
        surfaced_constraint_count: row.get("surfaced_constraint_count")?,
        traversal_memory_count: row.get("traversal_memory_count")?,
    })
}

pub fn insert_checkpoint(
    conn: &Connection,
    snapshot: &ContinuitySnapshot,
    trigger: &str,
    digest: &str,
) -> Result<String, CoreError> {
    let id = uuid::Uuid::new_v4().to_string();
    let ts = chrono::Utc::now().to_rfc3339();

    let queries_json = serde_json::to_string(&snapshot.queries).ok();
    let remembers_json = serde_json::to_string(&snapshot.remembers).ok();

    let (focal_ids, focal_names, aspect_ids, constraint_count, traversal_count) =
        if let Some(s) = &snapshot.structural {
            (
                serde_json::to_string(&s.focal_entity_ids).ok(),
                serde_json::to_string(&s.focal_entity_names).ok(),
                serde_json::to_string(&s.active_aspect_ids).ok(),
                Some(s.surfaced_constraint_count),
                Some(s.traversal_memory_count),
            )
        } else {
            (None, None, None, None, None)
        };

    conn.execute(
        "INSERT INTO session_checkpoints
         (id, session_key, harness, project, project_normalized, trigger, digest,
          prompt_count, memory_queries, recent_remembers, created_at,
          focal_entity_ids, focal_entity_names, active_aspect_ids,
          surfaced_constraint_count, traversal_memory_count)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
        params![
            id,
            snapshot.session_key,
            snapshot.harness,
            snapshot.project,
            snapshot.project_normalized,
            trigger,
            digest,
            snapshot.prompt_count,
            queries_json,
            remembers_json,
            ts,
            focal_ids,
            focal_names,
            aspect_ids,
            constraint_count,
            traversal_count,
        ],
    )?;

    Ok(id)
}

pub fn get_checkpoints_for_session(
    conn: &Connection,
    session_key: &str,
) -> Result<Vec<SessionCheckpoint>, CoreError> {
    let mut stmt = conn.prepare_cached(
        "SELECT * FROM session_checkpoints WHERE session_key = ?1 ORDER BY created_at DESC",
    )?;
    let rows = stmt.query_map(params![session_key], row_to_checkpoint)?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

pub fn get_checkpoints_for_project(
    conn: &Connection,
    project: &str,
    limit: usize,
) -> Result<Vec<SessionCheckpoint>, CoreError> {
    let mut stmt = conn.prepare_cached(
        "SELECT * FROM session_checkpoints
         WHERE project_normalized = ?1 OR project = ?1
         ORDER BY created_at DESC LIMIT ?2",
    )?;
    let rows = stmt.query_map(params![project, limit], row_to_checkpoint)?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

pub fn get_latest_checkpoint(
    conn: &Connection,
    project_normalized: &str,
) -> Result<Option<SessionCheckpoint>, CoreError> {
    let mut stmt = conn.prepare_cached(
        "SELECT * FROM session_checkpoints
         WHERE project_normalized = ?1
         ORDER BY created_at DESC LIMIT 1",
    )?;
    let mut rows = stmt.query_map(params![project_normalized], row_to_checkpoint)?;
    match rows.next() {
        Some(Ok(c)) => Ok(Some(c)),
        Some(Err(e)) => Err(e.into()),
        None => Ok(None),
    }
}

/// Get recent checkpoints within a time window for session recovery.
pub fn get_recovery_checkpoints(
    conn: &Connection,
    project_normalized: &str,
    window_hours: u64,
) -> Result<Vec<SessionCheckpoint>, CoreError> {
    let cutoff = chrono::Utc::now() - chrono::Duration::hours(window_hours as i64);
    let mut stmt = conn.prepare_cached(
        "SELECT * FROM session_checkpoints
         WHERE project_normalized = ?1 AND created_at >= ?2
         ORDER BY created_at DESC LIMIT 5",
    )?;
    let rows = stmt.query_map(
        params![project_normalized, cutoff.to_rfc3339()],
        row_to_checkpoint,
    )?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_claim_and_release() {
        let tracker = SessionTracker::new();

        // First claim succeeds
        assert!(matches!(
            tracker.claim("s1", RuntimePath::Plugin, "default"),
            ClaimResult::Ok
        ));

        // Same path re-claim refreshes
        assert!(matches!(
            tracker.claim("s1", RuntimePath::Plugin, "default"),
            ClaimResult::Ok
        ));

        // Different path conflicts
        assert!(matches!(
            tracker.claim("s1", RuntimePath::Legacy, "default"),
            ClaimResult::Conflict { .. }
        ));

        // Release
        tracker.release("s1");
        assert!(matches!(
            tracker.claim("s1", RuntimePath::Legacy, "default"),
            ClaimResult::Ok
        ));
    }

    #[test]
    fn session_bypass() {
        let tracker = SessionTracker::new();
        tracker.claim("s1", RuntimePath::Plugin, "default");
        assert!(!tracker.is_bypassed("s1"));

        tracker.bypass("s1");
        assert!(tracker.is_bypassed("s1"));

        tracker.unbypass("s1");
        assert!(!tracker.is_bypassed("s1"));
    }

    #[test]
    fn continuity_accumulation() {
        let continuity = ContinuityTracker::new();
        continuity.init("s1", "claude-code", Some("/project"), Some("/project"));

        continuity.record_prompt("s1", "rust async", "How do I handle async?");
        continuity.record_prompt("s1", "tokio spawn", "Using tokio::spawn");
        continuity.record_remember("s1", "User prefers async/await");

        assert_eq!(continuity.total_prompt_count("s1"), 2);

        let snapshot = continuity.consume("s1").unwrap();
        assert_eq!(snapshot.prompt_count, 2);
        assert_eq!(snapshot.total_prompt_count, 2);
        assert_eq!(snapshot.queries.len(), 2);
        assert_eq!(snapshot.remembers.len(), 1);

        // After consume, prompt_count resets but total stays
        assert_eq!(continuity.total_prompt_count("s1"), 2);

        continuity.record_prompt("s1", "test", "test");
        let snapshot2 = continuity.consume("s1").unwrap();
        assert_eq!(snapshot2.prompt_count, 1);
        assert_eq!(snapshot2.total_prompt_count, 3);
    }

    #[test]
    fn dedup_window() {
        let dedup = DedupState::new();

        // First session start not seen
        assert!(!dedup.mark_session_start("s1"));
        // Second is seen
        assert!(dedup.mark_session_start("s1"));

        dedup.record_prompt_ids("s1", vec!["m1".into(), "m2".into()]);
        dedup.record_prompt_ids("s1", vec!["m3".into()]);

        let recent = dedup.recent_ids("s1");
        assert_eq!(recent.len(), 3);

        dedup.reset_prompt_dedup("s1");
        assert!(dedup.recent_ids("s1").is_empty());
    }

    #[test]
    fn session_start_dedupe_is_agent_harness_project_scoped() {
        let dedup = DedupState::new();
        assert!(!dedup.mark_session_start_scoped("agent-a", Some("pi"), Some("/repo"), "shared"));
        assert!(dedup.mark_session_start_scoped("agent-a", Some("pi"), Some("/repo"), "shared"));
        assert!(!dedup.mark_session_start_scoped("agent-b", Some("pi"), Some("/repo"), "shared"));
        assert!(!dedup.mark_session_start_scoped(
            "agent-a",
            Some("codex"),
            Some("/repo"),
            "shared"
        ));
        dedup.clear_session_start_scoped("agent-a", Some("pi"), Some("/repo"), "shared");
        assert!(!dedup.mark_session_start_scoped("agent-a", Some("pi"), Some("/repo"), "shared"));
    }

    #[test]
    fn checkpoint_should_trigger() {
        let continuity = ContinuityTracker::new();
        continuity.init("s1", "claude-code", None, None);

        // No prompts yet
        assert!(!continuity.should_checkpoint("s1", 5, 300));

        // Record 5 prompts
        for _ in 0..5 {
            continuity.record_prompt("s1", "test", "test");
        }
        assert!(continuity.should_checkpoint("s1", 5, 300));
    }
}
