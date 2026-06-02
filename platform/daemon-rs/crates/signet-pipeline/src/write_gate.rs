//! Adaptive write gate for extraction Phase C.
//!
//! Evaluates whether a candidate memory should be written by measuring its
//! surprisal (1 - max_similarity) against existing scoped memories.
//! Content types that must always be persisted (constraints, errors, decisions)
//! bypass the gate entirely.  Continuity signals can lower the effective
//! threshold when the session is actively writing to the same context.

use rusqlite::{ToSql, params};
use tracing::debug;

use signet_core::db::DbPool;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CONSTRAINT_KEYWORDS: &[&str] = &["constraint", "must", "never", "always", "required"];
const ERROR_KEYWORDS: &[&str] = &[
    "error",
    "exception",
    "failed",
    "failure",
    "stack trace",
    "traceback",
    "crash",
    "bug",
];

/// Substring patterns for decision-indicating language (from TS inline-entity-linker).
const DECISION_PATTERNS_SIMPLE: &[&str] = &[
    "decided to",
    "decided on",
    "decided against",
    "switched from",
    "switched to",
    "migrated from",
    "migrated to",
    "migrated away",
    "went with",
    "sticking with",
    "committed to",
    "settled on",
    "will use",
    "will go with",
    "will stick with",
    "adopted",
    "architecture decision",
    "design decision",
];

const CONTINUITY_WINDOW_MS: u64 = 30 * 60 * 1000;
const CONTINUITY_RECENT_MIN: i64 = 3;
const CONTINUITY_SIMILARITY_THRESHOLD: f64 = 0.65;
const NEIGHBOR_LIMIT: i64 = 50;
const VEC_OVERFETCH_MULTIPLIER: i64 = 2;
const RECENT_SIMILARITY_LIMIT: i64 = 5;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// Configuration for the write gate.
#[derive(Debug, Clone)]
pub struct WriteGateConfig {
    pub enabled: bool,
    pub threshold: f64,
    pub continuity_discount: f64,
}

/// Input to the write gate assessment.
#[derive(Debug, Clone)]
pub struct WriteGateInput {
    pub agent_id: String,
    pub source_memory_id: String,
    pub source_project: Option<String>,
    pub source_scope: Option<String>,
    pub source_visibility: String,
    pub fact_type: String,
    pub content: String,
    pub vector: Option<Vec<f32>>,
}

/// Continuity signals used to lower the surprisal threshold.
#[derive(Debug, Clone, Default)]
pub struct WriteGateSignals {
    pub same_directory: bool,
    pub recent_stores: bool,
    pub semantic_similarity: bool,
}

/// Reason for the gate outcome.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WriteGateReason {
    GateDisabled,
    DecisionBypass,
    ConstraintBypass,
    ErrorBypass,
    MissingEmbedding,
    LowSurprisal,
    Passed,
}

impl WriteGateReason {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::GateDisabled => "gate_disabled",
            Self::DecisionBypass => "decision_bypass",
            Self::ConstraintBypass => "constraint_bypass",
            Self::ErrorBypass => "error_bypass",
            Self::MissingEmbedding => "missing_embedding",
            Self::LowSurprisal => "low_surprisal",
            Self::Passed => "passed",
        }
    }
}

/// Result of the write gate assessment.
#[derive(Debug, Clone)]
pub struct WriteGateResult {
    pub pass: bool,
    pub bypassed: bool,
    pub reason: WriteGateReason,
    pub surprise: Option<f64>,
    pub max_similarity: Option<f64>,
    pub threshold: f64,
    pub continuity_applied: bool,
    pub signals: WriteGateSignals,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

#[inline]
fn clamp_unit(v: f64) -> f64 {
    v.clamp(0.0, 1.0)
}

/// Deserialize a byte blob into f32 vector (little-endian).
fn f32_vec_from_blob(blob: &[u8]) -> Vec<f32> {
    blob.chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect()
}

/// Serialize an f32 vector into a byte blob for sqlite-vec.
fn vec_to_blob(v: &[f32]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(v.len() * 4);
    for f in v {
        bytes.extend_from_slice(&f.to_le_bytes());
    }
    bytes
}

/// Cosine similarity between two f32 vectors.
fn cosine_similarity(a: &[f32], b: &[f32]) -> f64 {
    let mut dot = 0.0_f64;
    let mut norm_a = 0.0_f64;
    let mut norm_b = 0.0_f64;
    for (l, r) in a.iter().zip(b.iter()) {
        let l = f64::from(*l);
        let r = f64::from(*r);
        dot += l * r;
        norm_a += l * l;
        norm_b += r * r;
    }
    let denom = norm_a.sqrt() * norm_b.sqrt();
    if denom > 0.0 { dot / denom } else { 0.0 }
}

fn is_constraint_content(content: &str) -> bool {
    let lower = content.to_lowercase();
    CONSTRAINT_KEYWORDS.iter().any(|k| lower.contains(k))
}

fn is_error_content(content: &str) -> bool {
    let lower = content.to_lowercase();
    ERROR_KEYWORDS.iter().any(|k| lower.contains(k))
}

/// Check whether content text contains decision-indicating language.
/// Ports DECISION_PATTERNS from TS inline-entity-linker.
pub fn is_decision_content(content: &str) -> bool {
    let lower = content.to_lowercase();
    // Multi-word patterns that need "over" or "instead"
    if (lower.contains("chose to") || lower.contains("chosen to"))
        && (lower.contains("over") || lower.contains("instead"))
    {
        return true;
    }
    if lower.contains("picked") && lower.contains("over") {
        return true;
    }
    if lower.contains("prefer")
        && (lower.contains("over") || lower.contains("instead") || lower.contains("rather"))
    {
        return true;
    }
    // Simple keyword patterns
    DECISION_PATTERNS_SIMPLE.iter().any(|p| lower.contains(p))
}

/// Build a bypass result with all signals false.
fn bypass_result(reason: WriteGateReason, threshold: f64) -> WriteGateResult {
    WriteGateResult {
        pass: true,
        bypassed: true,
        reason,
        surprise: None,
        max_similarity: None,
        threshold,
        continuity_applied: false,
        signals: WriteGateSignals::default(),
    }
}

// ---------------------------------------------------------------------------
// Max-similarity queries
// ---------------------------------------------------------------------------

/// Find max similarity using sqlite-vec virtual table (fast path).
fn find_max_similarity_vec(
    conn: &rusqlite::Connection,
    query: &[f32],
    input: &WriteGateInput,
) -> Option<f64> {
    let query_blob = vec_to_blob(query);
    let k: i64 = if input.source_scope.is_some() || input.source_visibility != "global" {
        NEIGHBOR_LIMIT * VEC_OVERFETCH_MULTIPLIER
    } else {
        NEIGHBOR_LIMIT
    };

    let sql = if input.source_scope.is_some() {
        "SELECT v.distance
         FROM vec_embeddings v
         JOIN embeddings e ON v.id = e.id
         JOIN memories m ON e.source_id = m.id
         WHERE v.embedding MATCH ?1 AND k = ?2
           AND e.source_type = 'memory'
           AND m.is_deleted = 0
           AND m.agent_id = ?3
           AND m.visibility = ?4
           AND m.type = ?5
           AND m.id <> ?6
           AND m.scope = ?7
         ORDER BY v.distance
         LIMIT 1"
    } else {
        "SELECT v.distance
         FROM vec_embeddings v
         JOIN embeddings e ON v.id = e.id
         JOIN memories m ON e.source_id = m.id
         WHERE v.embedding MATCH ?1 AND k = ?2
           AND e.source_type = 'memory'
           AND m.is_deleted = 0
           AND m.agent_id = ?3
           AND m.visibility = ?4
           AND m.type = ?5
           AND m.id <> ?6
           AND m.scope IS NULL
         ORDER BY v.distance
         LIMIT 1"
    };

    let result = if let Some(ref scope) = input.source_scope {
        conn.query_row(
            sql,
            params![
                &query_blob,
                k,
                input.agent_id,
                input.source_visibility,
                input.fact_type,
                input.source_memory_id,
                scope
            ],
            |row| row.get::<_, f64>(0),
        )
    } else {
        conn.query_row(
            sql,
            params![
                &query_blob,
                k,
                input.agent_id,
                input.source_visibility,
                input.fact_type,
                input.source_memory_id
            ],
            |row| row.get::<_, f64>(0),
        )
    };

    match result {
        Ok(distance) if distance.is_finite() => Some(clamp_unit(1.0 - distance)),
        _ => None,
    }
}

/// Find max similarity via dense scan of recent scoped rows (fallback).
fn find_max_similarity_fallback(
    conn: &rusqlite::Connection,
    query: &[f32],
    input: &WriteGateInput,
) -> Option<f64> {
    let scope_clause = if input.source_scope.is_some() {
        "AND m.scope = ?"
    } else {
        "AND m.scope IS NULL"
    };
    let sql = format!(
        "SELECT e.vector
         FROM embeddings e
         JOIN memories m ON e.source_id = m.id
         WHERE e.source_type = 'memory'
           AND m.is_deleted = 0
           AND m.agent_id = ?
           AND m.visibility = ?
           AND m.type = ?
           AND m.id <> ?
           {scope_clause}
         ORDER BY m.updated_at DESC
         LIMIT ?"
    );

    let mut params: Vec<Box<dyn ToSql>> = vec![
        Box::new(input.agent_id.clone()),
        Box::new(input.source_visibility.clone()),
        Box::new(input.fact_type.clone()),
        Box::new(input.source_memory_id.clone()),
    ];
    if let Some(ref scope) = input.source_scope {
        params.push(Box::new(scope.clone()));
    }
    params.push(Box::new(NEIGHBOR_LIMIT));

    let param_refs: Vec<&dyn ToSql> = params.iter().map(|p| p.as_ref()).collect();
    let mut stmt = match conn.prepare(&sql) {
        Ok(s) => s,
        Err(_) => return None,
    };
    let rows = match stmt.query_map(param_refs.as_slice(), |row| row.get::<_, Vec<u8>>(0)) {
        Ok(r) => r,
        Err(_) => return None,
    };

    let mut max_sim = 0.0_f64;
    let mut any = false;
    for row in rows.flatten() {
        let vec = f32_vec_from_blob(&row);
        if vec.len() == query.len() {
            let score = clamp_unit(cosine_similarity(query, &vec));
            if score > max_sim {
                max_sim = score;
            }
            any = true;
        }
    }
    if any { Some(max_sim) } else { None }
}

/// Find max similarity, trying sqlite-vec first then falling back to dense scan.
fn find_max_similarity(
    conn: &rusqlite::Connection,
    query: &[f32],
    input: &WriteGateInput,
) -> Option<f64> {
    if let Some(sim) = find_max_similarity_vec(conn, query, input) {
        return Some(sim);
    }
    find_max_similarity_fallback(conn, query, input)
}

// ---------------------------------------------------------------------------
// Continuity signals
// ---------------------------------------------------------------------------

/// Compute the three continuity signals used to lower the surprisal threshold.
fn compute_continuity_signals(
    conn: &rusqlite::Connection,
    input: &WriteGateInput,
    query: Option<&[f32]>,
) -> WriteGateSignals {
    let cutoff = continuity_cutoff_iso();

    // same_directory: recent stores in the same project within the window
    let same_directory = input.source_project.as_ref().map_or(false, |project| {
        count_recent_scoped(conn, input, project, &cutoff) > 0
    });

    // recent_stores: enough stores in this scope within the window
    let recent_stores = count_recent(conn, input, &cutoff) >= CONTINUITY_RECENT_MIN;

    // semantic_similarity: high similarity with recent scoped memories
    let semantic_similarity = query.map_or(false, |q| check_semantic_continuity(conn, input, q));

    WriteGateSignals {
        same_directory,
        recent_stores,
        semantic_similarity,
    }
}

/// Build the ISO 8601 cutoff timestamp for the continuity window.
fn continuity_cutoff_iso() -> String {
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;
    let cutoff_ms = now_ms - CONTINUITY_WINDOW_MS as i64;
    chrono::DateTime::from_timestamp_millis(cutoff_ms)
        .map(|dt| dt.to_rfc3339())
        .unwrap_or_default()
}

/// Count recent memories in the same project + scope.
fn count_recent_scoped(
    conn: &rusqlite::Connection,
    input: &WriteGateInput,
    project: &str,
    cutoff: &str,
) -> i64 {
    let sql = if input.source_scope.is_some() {
        "SELECT COUNT(*) AS cnt FROM memories
         WHERE agent_id = ?1 AND visibility = ?2 AND id <> ?3
           AND scope = ?4 AND project = ?5 AND is_deleted = 0 AND created_at >= ?6"
    } else {
        "SELECT COUNT(*) AS cnt FROM memories
         WHERE agent_id = ?1 AND visibility = ?2 AND id <> ?3
           AND scope IS NULL AND project = ?4 AND is_deleted = 0 AND created_at >= ?5"
    };

    if let Some(ref scope) = input.source_scope {
        conn.query_row(
            sql,
            params![
                input.agent_id,
                input.source_visibility,
                input.source_memory_id,
                scope,
                project,
                cutoff
            ],
            |row| row.get::<_, i64>(0),
        )
        .unwrap_or(0)
    } else {
        conn.query_row(
            sql,
            params![
                input.agent_id,
                input.source_visibility,
                input.source_memory_id,
                project,
                cutoff
            ],
            |row| row.get::<_, i64>(0),
        )
        .unwrap_or(0)
    }
}

/// Count recent memories in the scope (any project).
fn count_recent(conn: &rusqlite::Connection, input: &WriteGateInput, cutoff: &str) -> i64 {
    let sql = if input.source_scope.is_some() {
        "SELECT COUNT(*) AS cnt FROM memories
         WHERE agent_id = ?1 AND visibility = ?2 AND id <> ?3
           AND scope = ?4 AND is_deleted = 0 AND created_at >= ?5"
    } else {
        "SELECT COUNT(*) AS cnt FROM memories
         WHERE agent_id = ?1 AND visibility = ?2 AND id <> ?3
           AND scope IS NULL AND is_deleted = 0 AND created_at >= ?4"
    };

    if let Some(ref scope) = input.source_scope {
        conn.query_row(
            sql,
            params![
                input.agent_id,
                input.source_visibility,
                input.source_memory_id,
                scope,
                cutoff
            ],
            |row| row.get::<_, i64>(0),
        )
        .unwrap_or(0)
    } else {
        conn.query_row(
            sql,
            params![
                input.agent_id,
                input.source_visibility,
                input.source_memory_id,
                cutoff
            ],
            |row| row.get::<_, i64>(0),
        )
        .unwrap_or(0)
    }
}

/// Check semantic continuity: is the query vector similar to recent scoped memories?
fn check_semantic_continuity(
    conn: &rusqlite::Connection,
    input: &WriteGateInput,
    query: &[f32],
) -> bool {
    let scope_clause = if input.source_scope.is_some() {
        "AND m.scope = ?"
    } else {
        "AND m.scope IS NULL"
    };
    let project_clause = if input.source_project.is_some() {
        "AND m.project = ?"
    } else {
        ""
    };
    let sql = format!(
        "SELECT e.vector
         FROM embeddings e
         JOIN memories m ON e.source_id = m.id
         WHERE e.source_type = 'memory'
           AND m.agent_id = ?
           AND m.visibility = ?
           AND m.id <> ?
           AND m.is_deleted = 0
           {scope_clause}
           {project_clause}
         ORDER BY m.created_at DESC
         LIMIT ?"
    );

    let mut params: Vec<Box<dyn ToSql>> = vec![
        Box::new(input.agent_id.clone()),
        Box::new(input.source_visibility.clone()),
        Box::new(input.source_memory_id.clone()),
    ];
    if let Some(ref scope) = input.source_scope {
        params.push(Box::new(scope.clone()));
    }
    if let Some(ref project) = input.source_project {
        params.push(Box::new(project.clone()));
    }
    params.push(Box::new(RECENT_SIMILARITY_LIMIT));

    let param_refs: Vec<&dyn ToSql> = params.iter().map(|p| p.as_ref()).collect();
    let Ok(mut stmt) = conn.prepare(&sql) else {
        return false;
    };
    let Ok(rows) = stmt.query_map(param_refs.as_slice(), |row| row.get::<_, Vec<u8>>(0)) else {
        return false;
    };

    let mut max_sim = 0.0_f64;
    let mut any = false;
    for row in rows.flatten() {
        let vec = f32_vec_from_blob(&row);
        if vec.len() == query.len() {
            let score = clamp_unit(cosine_similarity(query, &vec));
            if score > max_sim {
                max_sim = score;
            }
            any = true;
        }
    }
    any && max_sim >= CONTINUITY_SIMILARITY_THRESHOLD
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Assess whether a candidate memory should pass the adaptive write gate.
///
/// Returns a `WriteGateResult` indicating whether the memory should be written,
/// whether it was bypassed (always-written content types), and the surprisal
/// score and continuity signals for observability.
pub async fn assess_write_gate(
    pool: &DbPool,
    cfg: &WriteGateConfig,
    input: &WriteGateInput,
) -> WriteGateResult {
    let base_threshold = clamp_unit(cfg.threshold);

    if !cfg.enabled {
        return bypass_result(WriteGateReason::GateDisabled, base_threshold);
    }

    // Decision content always passes
    if input.fact_type == "decision" || is_decision_content(&input.content) {
        return bypass_result(WriteGateReason::DecisionBypass, base_threshold);
    }

    // Constraint content always passes
    if is_constraint_content(&input.content) {
        return bypass_result(WriteGateReason::ConstraintBypass, base_threshold);
    }

    // Error content always passes
    if is_error_content(&input.content) {
        return bypass_result(WriteGateReason::ErrorBypass, base_threshold);
    }

    // Missing embedding bypasses (can't compute surprisal)
    let vector = match input.vector.as_deref() {
        Some(v) if !v.is_empty() => v,
        _ => return bypass_result(WriteGateReason::MissingEmbedding, base_threshold),
    };

    // All subsequent work needs DB access -- clone ownable fields for the closure
    let vector_owned = vector.to_vec();
    let input_owned = input.clone();
    let continuity_discount = cfg.continuity_discount;

    let result = pool
        .read(move |conn| {
            let signals = compute_continuity_signals(conn, &input_owned, Some(&vector_owned));
            let continuity_applied =
                signals.same_directory && signals.recent_stores && signals.semantic_similarity;
            let effective_threshold = clamp_unit(
                base_threshold
                    - if continuity_applied {
                        clamp_unit(continuity_discount)
                    } else {
                        0.0
                    },
            );
            let max_similarity = find_max_similarity(conn, &vector_owned, &input_owned);
            let surprise = clamp_unit(1.0 - max_similarity.unwrap_or(0.0));

            debug!(
                surprise = surprise,
                max_sim = ?max_similarity,
                threshold = effective_threshold,
                continuity = continuity_applied,
                "write gate assessment"
            );

            if surprise < effective_threshold {
                Ok(WriteGateResult {
                    pass: false,
                    bypassed: false,
                    reason: WriteGateReason::LowSurprisal,
                    surprise: Some(surprise),
                    max_similarity,
                    threshold: effective_threshold,
                    continuity_applied,
                    signals,
                })
            } else {
                Ok(WriteGateResult {
                    pass: true,
                    bypassed: false,
                    reason: WriteGateReason::Passed,
                    surprise: Some(surprise),
                    max_similarity,
                    threshold: effective_threshold,
                    continuity_applied,
                    signals,
                })
            }
        })
        .await;

    // If pool read fails, allow the write (fail open for safety)
    match result {
        Ok(r) => r,
        Err(e) => {
            debug!(error = %e, "write gate DB read failed, allowing write");
            WriteGateResult {
                pass: true,
                bypassed: true,
                reason: WriteGateReason::Passed,
                surprise: None,
                max_similarity: None,
                threshold: base_threshold,
                continuity_applied: false,
                signals: WriteGateSignals::default(),
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // --- Helper tests ---

    #[test]
    fn clamp_unit_bounds() {
        assert_eq!(clamp_unit(-0.5), 0.0);
        assert_eq!(clamp_unit(0.5), 0.5);
        assert_eq!(clamp_unit(1.5), 1.0);
    }

    #[test]
    fn vec_blob_roundtrip() {
        let original: Vec<f32> = vec![0.1, -0.2, 0.3, 0.0, 1.0];
        let blob = vec_to_blob(&original);
        let recovered = f32_vec_from_blob(&blob);
        assert_eq!(original, recovered);
    }

    #[test]
    fn cosine_similarity_identical() {
        let v = vec![1.0_f32, 0.0, 0.0];
        let sim = cosine_similarity(&v, &v);
        assert!((sim - 1.0).abs() < 1e-6);
    }

    #[test]
    fn cosine_similarity_orthogonal() {
        let a = vec![1.0_f32, 0.0];
        let b = vec![0.0_f32, 1.0];
        let sim = cosine_similarity(&a, &b);
        assert!(sim.abs() < 1e-6);
    }

    #[test]
    fn cosine_similarity_opposite() {
        let a = vec![1.0_f32, 0.0];
        let b = vec![-1.0_f32, 0.0];
        let sim = cosine_similarity(&a, &b);
        assert!((sim - (-1.0)).abs() < 1e-6);
    }

    // --- Content classification tests ---

    #[test]
    fn constraint_detection() {
        assert!(is_constraint_content("You must never do this"));
        assert!(is_constraint_content("This is required"));
        assert!(is_constraint_content("Always validate input"));
        assert!(!is_constraint_content("The weather is nice"));
    }

    #[test]
    fn error_detection() {
        assert!(is_error_content("An error occurred"));
        assert!(is_error_content("stack trace: at main"));
        assert!(is_error_content("The process failed"));
        assert!(!is_error_content("Success message"));
    }

    #[test]
    fn decision_detection_simple() {
        assert!(is_decision_content("We decided to use Rust instead of Go"));
        assert!(is_decision_content("I went with PostgreSQL"));
        assert!(is_decision_content("Adopted the new framework"));
        assert!(is_decision_content("This was an architecture decision"));
        assert!(is_decision_content("Switched from SQLite to Postgres"));
    }

    #[test]
    fn decision_detection_with_over() {
        assert!(is_decision_content("I chose to use Bun over Node"));
        assert!(is_decision_content("We picked React over Vue"));
        assert!(is_decision_content("I prefer Rust over C++"));
    }

    #[test]
    fn not_decision_content() {
        assert!(!is_decision_content("The weather is nice today"));
        assert!(!is_decision_content("We had a meeting about the project"));
        assert!(!is_decision_content("The constraint is simple"));
    }

    // --- Bypass path tests (no DB needed) ---

    fn test_input(content: &str, fact_type: &str, vector: Option<Vec<f32>>) -> WriteGateInput {
        WriteGateInput {
            agent_id: "test".into(),
            source_memory_id: "m1".into(),
            source_project: None,
            source_scope: None,
            source_visibility: "global".into(),
            fact_type: fact_type.into(),
            content: content.into(),
            vector,
        }
    }

    fn test_cfg(enabled: bool) -> WriteGateConfig {
        WriteGateConfig {
            enabled,
            threshold: 0.5,
            continuity_discount: 0.1,
        }
    }

    fn test_db(suffix: &str) -> (DbPool, std::path::PathBuf) {
        let db_path = std::env::temp_dir().join(format!("signet_write_gate_test_{suffix}.db"));
        let _ = std::fs::remove_file(&db_path);
        let (pool, _handle) = DbPool::open(&db_path).expect("open test DB");
        (pool, db_path)
    }

    #[tokio::test]
    async fn gate_disabled_bypasses() {
        let (pool, _db_path) = test_db("disabled");

        let result = assess_write_gate(
            &pool,
            &test_cfg(false),
            &test_input("content", "fact", Some(vec![0.1, 0.2])),
        )
        .await;
        assert!(result.pass);
        assert!(result.bypassed);
        assert_eq!(result.reason, WriteGateReason::GateDisabled);
    }

    #[tokio::test]
    async fn decision_type_bypasses() {
        let (pool, _db_path) = test_db("decision_type");

        let result = assess_write_gate(
            &pool,
            &test_cfg(true),
            &test_input("decided to use Rust", "decision", Some(vec![0.1, 0.2])),
        )
        .await;
        assert!(result.pass);
        assert!(result.bypassed);
        assert_eq!(result.reason, WriteGateReason::DecisionBypass);
    }

    #[tokio::test]
    async fn decision_content_bypasses() {
        let (pool, _db_path) = test_db("decision_content");

        let result = assess_write_gate(
            &pool,
            &test_cfg(true),
            &test_input("I went with PostgreSQL", "fact", Some(vec![0.1, 0.2])),
        )
        .await;
        assert!(result.pass);
        assert!(result.bypassed);
        assert_eq!(result.reason, WriteGateReason::DecisionBypass);
    }

    #[tokio::test]
    async fn constraint_content_bypasses() {
        let (pool, _db_path) = test_db("constraint");

        let result = assess_write_gate(
            &pool,
            &test_cfg(true),
            &test_input("You must always validate", "fact", Some(vec![0.1, 0.2])),
        )
        .await;
        assert!(result.pass);
        assert!(result.bypassed);
        assert_eq!(result.reason, WriteGateReason::ConstraintBypass);
    }

    #[tokio::test]
    async fn error_content_bypasses() {
        let (pool, _db_path) = test_db("error");

        let result = assess_write_gate(
            &pool,
            &test_cfg(true),
            &test_input(
                "The process crashed with an error",
                "fact",
                Some(vec![0.1, 0.2]),
            ),
        )
        .await;
        assert!(result.pass);
        assert!(result.bypassed);
        assert_eq!(result.reason, WriteGateReason::ErrorBypass);
    }

    #[tokio::test]
    async fn missing_embedding_bypasses() {
        let (pool, _db_path) = test_db("missing_emb");

        let result = assess_write_gate(
            &pool,
            &test_cfg(true),
            &test_input("normal content", "fact", None),
        )
        .await;
        assert!(result.pass);
        assert!(result.bypassed);
        assert_eq!(result.reason, WriteGateReason::MissingEmbedding);
    }

    #[tokio::test]
    async fn empty_embedding_bypasses() {
        let (pool, _db_path) = test_db("empty_emb");

        let result = assess_write_gate(
            &pool,
            &test_cfg(true),
            &test_input("normal content", "fact", Some(vec![])),
        )
        .await;
        assert!(result.pass);
        assert!(result.bypassed);
        assert_eq!(result.reason, WriteGateReason::MissingEmbedding);
    }

    // --- DB-dependent test: with no existing memories, surprise should be 1.0 (passes gate) ---

    #[tokio::test]
    async fn novel_content_passes() {
        let (pool, _db_path) = test_db("novel");

        let result = assess_write_gate(
            &pool,
            &test_cfg(true),
            &test_input(
                "completely novel content about quantum physics",
                "fact",
                Some(vec![0.5, -0.3, 0.8]),
            ),
        )
        .await;
        assert!(result.pass);
        assert!(!result.bypassed);
        assert_eq!(result.reason, WriteGateReason::Passed);
        // With no existing memories, max_similarity should be 0, surprise = 1.0
        assert_eq!(result.surprise, Some(1.0));
    }
}
