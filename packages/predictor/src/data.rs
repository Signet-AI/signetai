use std::f64::consts::PI;
use std::path::Path;

use rusqlite::{Connection, OpenFlags};

use crate::tokenizer::fnv1a_hash;

/// Configuration for data loading and label construction
pub struct DataConfig {
    pub min_scorer_confidence: f64,
    pub loss_temperature: f64,
    pub native_dim: usize,
}

impl Default for DataConfig {
    fn default() -> Self {
        Self {
            min_scorer_confidence: 0.6,
            loss_temperature: 0.5,
            native_dim: 768,
        }
    }
}

/// Raw row from session_memories + memories + embeddings join
#[allow(dead_code)]
struct CandidateRow {
    memory_id: String,
    effective_score: f64,
    was_injected: bool,
    relevance_score: Option<f64>,
    fts_hit_count: i64,
    source: String,
    importance: f64,
    mem_created_at: String,
    access_count: i64,
    is_deleted: bool,
    mem_project: Option<String>,
    pinned: bool,
    mem_content: String,
    embedding_blob: Option<Vec<u8>>,
    embedding_dims: Option<i64>,
}

/// Raw row from session_scores
#[allow(dead_code)]
struct SessionRow {
    session_key: String,
    project: Option<String>,
    score: f64,
    confidence: Option<f64>,
    novel_context_count: Option<i64>,
    created_at: String,
}

#[derive(Debug, Clone)]
pub struct TrainingSample {
    pub session_id: String,
    pub query_embedding: Vec<f64>,
    pub candidate_embeddings: Vec<Vec<f64>>,
    pub candidate_texts: Vec<Option<String>>,
    pub candidate_features: Vec<Vec<f64>>,
    pub project_slot: usize,
    pub labels: Vec<f64>,
}

#[derive(Debug)]
pub enum DataError {
    Sql(rusqlite::Error),
    NoData(String),
}

impl From<rusqlite::Error> for DataError {
    fn from(value: rusqlite::Error) -> Self {
        Self::Sql(value)
    }
}

/// Result from loading training data, includes skip count for telemetry
pub struct LoadResult {
    pub samples: Vec<TrainingSample>,
    pub sessions_skipped: usize,
}

// ---------------------------------------------------------------------------
// Embedding blob parsing
// ---------------------------------------------------------------------------

fn parse_embedding_blob(blob: &[u8], expected_dims: usize) -> Option<Vec<f64>> {
    if blob.len() != expected_dims * 4 {
        return None;
    }
    Some(
        blob.chunks_exact(4)
            .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]) as f64)
            .collect(),
    )
}

// ---------------------------------------------------------------------------
// Timestamp parsing (no chrono dependency)
// ---------------------------------------------------------------------------

/// Parse "YYYY-MM-DDThh:mm:ss" prefix from an ISO 8601 string.
/// Returns (year, month, day, hour, minute, second). Ignores fractional
/// seconds and timezone suffix.
fn parse_timestamp(s: &str) -> Option<(i32, u32, u32, u32, u32, u32)> {
    // Minimum length: "YYYY-MM-DDThh:mm:ss" = 19 chars
    if s.len() < 19 {
        return None;
    }
    let b = s.as_bytes();
    // Quick structural check
    if b[4] != b'-'
        || b[7] != b'-'
        || (b[10] != b'T' && b[10] != b' ')
        || b[13] != b':'
        || b[16] != b':'
    {
        return None;
    }
    let year = s[0..4].parse::<i32>().ok()?;
    let month = s[5..7].parse::<u32>().ok()?;
    let day = s[8..10].parse::<u32>().ok()?;
    let hour = s[11..13].parse::<u32>().ok()?;
    let minute = s[14..16].parse::<u32>().ok()?;
    let second = s[17..19].parse::<u32>().ok()?;
    Some((year, month, day, hour, minute, second))
}

/// Howard Hinnant's civil date algorithm — days since 1970-01-01.
fn days_since_epoch(year: i32, month: u32, day: u32) -> i64 {
    let y = if month <= 2 {
        year as i64 - 1
    } else {
        year as i64
    };
    let m = if month <= 2 {
        month as i64 + 9
    } else {
        month as i64 - 3
    };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = (y - era * 400) as u64;
    let doy = (153 * m as u64 + 2) / 5 + day as u64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe as i64 - 719468
}

fn days_between(a: &str, b: &str) -> f64 {
    let pa = parse_timestamp(a);
    let pb = parse_timestamp(b);
    match (pa, pb) {
        (Some((y1, m1, d1, h1, min1, s1)), Some((y2, m2, d2, h2, min2, s2))) => {
            let secs_a = days_since_epoch(y1, m1, d1) * 86400
                + h1 as i64 * 3600
                + min1 as i64 * 60
                + s1 as i64;
            let secs_b = days_since_epoch(y2, m2, d2) * 86400
                + h2 as i64 * 3600
                + min2 as i64 * 60
                + s2 as i64;
            (secs_b - secs_a).abs() as f64 / 86400.0
        }
        _ => 0.0,
    }
}

fn parse_hour(s: &str) -> f64 {
    parse_timestamp(s)
        .map(|(_, _, _, h, _, _)| h as f64)
        .unwrap_or(0.0)
}

/// Zeller's formula adapted — returns 0.0..6.0 (Mon=0 .. Sun=6).
fn parse_day_of_week(s: &str) -> f64 {
    match parse_timestamp(s) {
        Some((year, month, day, _, _, _)) => {
            // Tomohiko Sakamoto's algorithm
            let t = [0i32, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4];
            let y = if month < 3 { year - 1 } else { year };
            let dow = (y + y / 4 - y / 100 + y / 400 + t[(month - 1) as usize] + day as i32) % 7;
            // Sakamoto gives 0=Sunday, we want 0=Monday
            ((dow + 6) % 7) as f64
        }
        None => 0.0,
    }
}

fn parse_month(s: &str) -> f64 {
    parse_timestamp(s)
        .map(|(_, m, _, _, _, _)| m as f64)
        .unwrap_or(1.0)
}

// ---------------------------------------------------------------------------
// Feature vector construction (12 dimensions)
// ---------------------------------------------------------------------------

fn build_features(row: &CandidateRow, session: &SessionRow, session_gap_hours: f64) -> Vec<f64> {
    let age_days = days_between(&row.mem_created_at, &session.created_at);
    let hour = parse_hour(&session.created_at);
    let dow = parse_day_of_week(&session.created_at);
    let month = parse_month(&session.created_at) - 1.0; // 0-indexed for sin/cos

    let has_embedding = if row.embedding_blob.is_some() {
        1.0
    } else {
        0.0
    };
    let deleted = if row.is_deleted { 1.0 } else { 0.0 };

    vec![
        (age_days + 1.0).ln(),                // [0] recency
        row.importance,                       // [1] importance
        (row.access_count as f64 + 1.0).ln(), // [2] usage frequency
        (2.0 * PI * hour / 24.0).sin(),       // [3] time of day sin
        (2.0 * PI * hour / 24.0).cos(),       // [4] time of day cos
        (2.0 * PI * dow / 7.0).sin(),         // [5] day of week sin
        (2.0 * PI * dow / 7.0).cos(),         // [6] day of week cos
        (2.0 * PI * month / 12.0).sin(),      // [7] month sin
        (2.0 * PI * month / 12.0).cos(),      // [8] month cos
        (session_gap_hours + 1.0).ln(),       // [9] session gap
        has_embedding,                        // [10] embedding flag
        deleted,                              // [11] deletion status
    ]
}

// ---------------------------------------------------------------------------
// Label construction
// ---------------------------------------------------------------------------

fn compute_label(row: &CandidateRow, session: &SessionRow) -> f64 {
    if row.is_deleted {
        return -0.3;
    }
    if row.was_injected {
        let base = match row.relevance_score {
            Some(rel) => rel,
            None => {
                if session.score >= 0.5 {
                    session.score
                } else {
                    session.score * 0.5
                }
            }
        };
        let mut label = base;
        if row.fts_hit_count > 0 {
            label = (label + 0.1).min(1.0);
        } else if session.score < 0.3 {
            label = (label - 0.1).max(0.0);
        }
        return label;
    }
    // Not injected
    let mut label: f64 = if row.fts_hit_count >= 2 {
        0.6
    } else if row.fts_hit_count == 1 {
        0.3
    } else {
        0.0
    };
    if let Some(ncc) = session.novel_context_count {
        if ncc > 0 && row.fts_hit_count > 0 {
            label = (label + 0.1).min(1.0);
        }
    }
    if row.access_count > 10 && label < 1.0 {
        label += 0.05;
    }
    label
}

// ---------------------------------------------------------------------------
// Query embedding — mean of injected embeddings
// ---------------------------------------------------------------------------

fn compute_query_embedding(candidates: &[CandidateRow], native_dim: usize) -> Vec<f64> {
    let injected: Vec<Vec<f64>> = candidates
        .iter()
        .filter(|c| c.was_injected)
        .filter_map(|c| {
            c.embedding_blob
                .as_ref()
                .and_then(|blob| parse_embedding_blob(blob, native_dim))
        })
        .collect();
    if injected.is_empty() {
        return vec![0.0; native_dim];
    }
    let n = injected.len() as f64;
    let mut avg = vec![0.0; native_dim];
    for emb in &injected {
        for (i, val) in emb.iter().enumerate() {
            avg[i] += val / n;
        }
    }
    avg
}

// ---------------------------------------------------------------------------
// Project slot hashing
// ---------------------------------------------------------------------------

fn project_to_slot(project: Option<&str>, num_slots: usize) -> usize {
    match project {
        Some(p) if !p.is_empty() => (fnv1a_hash(p.as_bytes()) as usize) % num_slots,
        _ => 0,
    }
}

// ---------------------------------------------------------------------------
// Main loader
// ---------------------------------------------------------------------------

pub fn load_training_samples(
    db_path: &Path,
    limit: usize,
    config: &DataConfig,
) -> Result<LoadResult, DataError> {
    let conn = Connection::open_with_flags(db_path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;

    // Count sessions excluded by confidence gate (for telemetry)
    let sessions_skipped: usize = {
        let mut count_stmt = conn.prepare(
            "SELECT COUNT(*)
             FROM session_scores ss
             WHERE ss.confidence IS NOT NULL
               AND ss.score IS NOT NULL
               AND ss.confidence < ?1",
        )?;
        count_stmt.query_row(rusqlite::params![config.min_scorer_confidence], |row| {
            row.get::<_, i64>(0)
        })? as usize
    };

    // Query 1: scored sessions — confidence filter in SQL so LIMIT
    // applies to qualifying rows, not all rows
    let mut stmt = conn.prepare(
        "SELECT ss.session_key, ss.project, ss.score, ss.confidence,
                ss.novel_context_count, ss.created_at
         FROM session_scores ss
         WHERE ss.confidence IS NOT NULL
           AND ss.score IS NOT NULL
           AND ss.confidence >= ?1
         ORDER BY ss.created_at DESC
         LIMIT ?2",
    )?;

    let qualifying: Vec<SessionRow> = {
        let mut rows =
            stmt.query(rusqlite::params![config.min_scorer_confidence, limit as i64])?;
        let mut out = Vec::new();
        while let Some(row) = rows.next()? {
            out.push(SessionRow {
                session_key: row.get(0)?,
                project: row.get(1)?,
                score: row.get(2)?,
                confidence: row.get(3)?,
                novel_context_count: row.get(4)?,
                created_at: row.get(5)?,
            });
        }
        out
    };

    // Query 2 & 3 prep
    let mut candidates_stmt = conn.prepare(
        "SELECT sm.memory_id, sm.effective_score, sm.was_injected,
                sm.relevance_score, sm.fts_hit_count, sm.source,
                m.importance, m.created_at AS mem_created_at,
                m.access_count, m.is_deleted, m.project AS mem_project,
                m.pinned, m.content AS mem_content,
                e.vector AS embedding_blob, e.dimensions AS embedding_dims
         FROM session_memories sm
         JOIN memories m ON sm.memory_id = m.id
         LEFT JOIN embeddings e
           ON e.source_id = m.id AND e.source_type = 'memory'
         WHERE sm.session_key = ?1
         ORDER BY sm.rank ASC",
    )?;

    let mut gap_stmt = conn.prepare(
        "SELECT MAX(ss2.created_at) AS prev_created_at
         FROM session_scores ss2
         WHERE ss2.project = ?1
           AND ss2.created_at < ?2",
    )?;

    let mut samples = Vec::new();

    for session in &qualifying {
        // Fetch candidates
        let candidates: Vec<CandidateRow> = {
            let mut rows = candidates_stmt.query(rusqlite::params![&session.session_key])?;
            let mut out = Vec::new();
            while let Some(row) = rows.next()? {
                out.push(CandidateRow {
                    memory_id: row.get(0)?,
                    effective_score: row.get::<_, Option<f64>>(1)?.unwrap_or(0.0),
                    was_injected: row.get::<_, i64>(2)? != 0,
                    relevance_score: row.get(3)?,
                    fts_hit_count: row.get(4)?,
                    source: row.get(5)?,
                    importance: row.get::<_, Option<f64>>(6)?.unwrap_or(0.5),
                    mem_created_at: row.get(7)?,
                    access_count: row.get::<_, Option<i64>>(8)?.unwrap_or(0),
                    is_deleted: row.get::<_, i64>(9)? != 0,
                    mem_project: row.get(10)?,
                    pinned: row.get::<_, i64>(11)? != 0,
                    mem_content: row.get(12)?,
                    embedding_blob: row.get(13)?,
                    embedding_dims: row.get(14)?,
                });
            }
            out
        };

        if candidates.is_empty() {
            continue;
        }

        // Session gap (query 3)
        let session_gap_hours = if let Some(ref proj) = session.project {
            let prev: Option<String> = gap_stmt
                .query_row(rusqlite::params![proj, &session.created_at], |row| {
                    row.get(0)
                })?;
            match prev {
                Some(prev_ts) => days_between(&prev_ts, &session.created_at) * 24.0,
                None => 0.0,
            }
        } else {
            0.0
        };

        // Build features, labels, embeddings
        let query_embedding = compute_query_embedding(&candidates, config.native_dim);
        let mut candidate_embeddings = Vec::with_capacity(candidates.len());
        let mut candidate_texts = Vec::with_capacity(candidates.len());
        let mut candidate_features = Vec::with_capacity(candidates.len());
        let mut labels = Vec::with_capacity(candidates.len());

        for cand in &candidates {
            // Always parse at native_dim so the model receives correctly-sized
            // embeddings. If the DB stores a different dimension, the blob won't
            // parse and we fall through to the text path.
            let parsed = cand
                .embedding_blob
                .as_ref()
                .and_then(|b| parse_embedding_blob(b, config.native_dim));
            match parsed {
                Some(emb) => {
                    candidate_embeddings.push(emb);
                    candidate_texts.push(None);
                }
                None => {
                    candidate_embeddings.push(Vec::new());
                    candidate_texts.push(Some(cand.mem_content.clone()));
                }
            }
            candidate_features.push(build_features(cand, session, session_gap_hours));
            labels.push(compute_label(cand, session));
        }

        let project_slot = project_to_slot(session.project.as_deref(), 32);

        samples.push(TrainingSample {
            session_id: session.session_key.clone(),
            query_embedding,
            candidate_embeddings,
            candidate_texts,
            candidate_features,
            project_slot,
            labels,
        });
    }

    Ok(LoadResult {
        samples,
        sessions_skipped,
    })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn create_test_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "
            CREATE TABLE session_scores (
                id TEXT PRIMARY KEY, session_key TEXT NOT NULL, project TEXT,
                harness TEXT, score REAL NOT NULL, memories_recalled INTEGER,
                memories_used INTEGER, novel_context_count INTEGER,
                reasoning TEXT, created_at TEXT NOT NULL, confidence REAL,
                continuity_reasoning TEXT
            );
            CREATE TABLE memories (
                id TEXT PRIMARY KEY, type TEXT NOT NULL DEFAULT 'fact',
                category TEXT, content TEXT NOT NULL, confidence REAL DEFAULT 1.0,
                importance REAL DEFAULT 0.5, source_id TEXT, source_type TEXT,
                tags TEXT, who TEXT, why TEXT, project TEXT,
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                updated_by TEXT NOT NULL DEFAULT 'system', last_accessed TEXT,
                access_count INTEGER DEFAULT 0, vector_clock TEXT NOT NULL DEFAULT '{}',
                version INTEGER DEFAULT 1, manual_override INTEGER DEFAULT 0,
                pinned INTEGER DEFAULT 0, is_deleted INTEGER DEFAULT 0,
                deleted_at TEXT, content_hash TEXT
            );
            CREATE TABLE session_memories (
                id TEXT PRIMARY KEY, session_key TEXT NOT NULL,
                memory_id TEXT NOT NULL, source TEXT NOT NULL,
                effective_score REAL, predictor_score REAL,
                final_score REAL NOT NULL, rank INTEGER NOT NULL,
                was_injected INTEGER NOT NULL, relevance_score REAL,
                fts_hit_count INTEGER NOT NULL DEFAULT 0,
                agent_preference TEXT, created_at TEXT NOT NULL,
                UNIQUE(session_key, memory_id)
            );
            CREATE TABLE embeddings (
                id TEXT PRIMARY KEY, content_hash TEXT NOT NULL UNIQUE,
                vector BLOB NOT NULL, dimensions INTEGER NOT NULL,
                source_type TEXT NOT NULL, source_id TEXT NOT NULL,
                chunk_text TEXT NOT NULL, created_at TEXT NOT NULL
            );
        ",
        )
        .unwrap();
        conn
    }

    fn make_f32_blob(values: &[f32]) -> Vec<u8> {
        values.iter().flat_map(|v| v.to_le_bytes()).collect()
    }

    #[test]
    fn parse_embedding_blob_valid() {
        let dims = 4;
        let blob = make_f32_blob(&[1.0, 2.0, 3.0, 4.0]);
        let result = parse_embedding_blob(&blob, dims).unwrap();
        assert_eq!(result.len(), 4);
        assert!((result[0] - 1.0).abs() < 1e-6);
        assert!((result[3] - 4.0).abs() < 1e-6);
    }

    #[test]
    fn parse_embedding_blob_wrong_size() {
        let blob = make_f32_blob(&[1.0, 2.0]);
        assert!(parse_embedding_blob(&blob, 3).is_none());
    }

    #[test]
    fn parse_embedding_blob_empty() {
        assert!(parse_embedding_blob(&[], 1).is_none());
        assert!(parse_embedding_blob(&[], 0).is_some()); // 0 dims, 0 bytes = valid
    }

    #[test]
    fn build_features_produces_12_dims() {
        let row = CandidateRow {
            memory_id: "m1".into(),
            effective_score: 0.8,
            was_injected: true,
            relevance_score: Some(0.7),
            fts_hit_count: 2,
            source: "recall".into(),
            importance: 0.6,
            mem_created_at: "2026-01-15T10:00:00Z".into(),
            access_count: 5,
            is_deleted: false,
            mem_project: Some("proj".into()),
            pinned: false,
            mem_content: "test content".into(),
            embedding_blob: None,
            embedding_dims: None,
        };
        let session = SessionRow {
            session_key: "s1".into(),
            project: Some("proj".into()),
            score: 0.8,
            confidence: Some(0.9),
            novel_context_count: Some(3),
            created_at: "2026-02-20T14:30:00Z".into(),
        };
        let features = build_features(&row, &session, 24.0);
        assert_eq!(features.len(), 12);
        // [0] = ln(age_days + 1) > 0
        assert!(features[0] > 0.0);
        // [1] = importance = 0.6
        assert!((features[1] - 0.6).abs() < 1e-9);
        // [2] = ln(5 + 1)
        assert!((features[2] - (6.0_f64).ln()).abs() < 1e-9);
        // [9] = ln(24 + 1)
        assert!((features[9] - (25.0_f64).ln()).abs() < 1e-9);
        // [10] = 0 (no embedding)
        assert!((features[10] - 0.0).abs() < 1e-9);
        // [11] = 0 (not deleted)
        assert!((features[11] - 0.0).abs() < 1e-9);
    }

    #[test]
    fn compute_label_deleted() {
        let row = CandidateRow {
            memory_id: "m1".into(),
            effective_score: 0.8,
            was_injected: true,
            relevance_score: Some(0.9),
            fts_hit_count: 5,
            source: "recall".into(),
            importance: 0.8,
            mem_created_at: "2026-01-01T00:00:00Z".into(),
            access_count: 20,
            is_deleted: true,
            mem_project: None,
            pinned: false,
            mem_content: "deleted".into(),
            embedding_blob: None,
            embedding_dims: None,
        };
        let session = SessionRow {
            session_key: "s1".into(),
            project: None,
            score: 0.9,
            confidence: Some(0.9),
            novel_context_count: None,
            created_at: "2026-02-01T00:00:00Z".into(),
        };
        assert!((compute_label(&row, &session) - (-0.3)).abs() < 1e-9);
    }

    #[test]
    fn compute_label_injected_high_relevance_fts() {
        let row = CandidateRow {
            memory_id: "m1".into(),
            effective_score: 0.9,
            was_injected: true,
            relevance_score: Some(0.95),
            fts_hit_count: 3,
            source: "recall".into(),
            importance: 0.8,
            mem_created_at: "2026-01-01T00:00:00Z".into(),
            access_count: 10,
            is_deleted: false,
            mem_project: None,
            pinned: false,
            mem_content: "important".into(),
            embedding_blob: None,
            embedding_dims: None,
        };
        let session = SessionRow {
            session_key: "s1".into(),
            project: None,
            score: 0.8,
            confidence: Some(0.9),
            novel_context_count: None,
            created_at: "2026-02-01T00:00:00Z".into(),
        };
        let label = compute_label(&row, &session);
        // base = 0.95, + 0.1 = 1.05, capped to 1.0
        assert!((label - 1.0).abs() < 1e-9);
    }

    #[test]
    fn compute_label_injected_no_fts_low_session() {
        let row = CandidateRow {
            memory_id: "m1".into(),
            effective_score: 0.5,
            was_injected: true,
            relevance_score: None,
            fts_hit_count: 0,
            source: "recall".into(),
            importance: 0.5,
            mem_created_at: "2026-01-01T00:00:00Z".into(),
            access_count: 0,
            is_deleted: false,
            mem_project: None,
            pinned: false,
            mem_content: "test".into(),
            embedding_blob: None,
            embedding_dims: None,
        };
        let session = SessionRow {
            session_key: "s1".into(),
            project: None,
            score: 0.2,
            confidence: Some(0.8),
            novel_context_count: None,
            created_at: "2026-02-01T00:00:00Z".into(),
        };
        let label = compute_label(&row, &session);
        // base = 0.2 * 0.5 = 0.1, no fts + session < 0.3 => 0.1 - 0.1 = 0.0
        assert!((label - 0.0).abs() < 1e-9);
    }

    #[test]
    fn compute_label_not_injected_fts_gte_2() {
        let row = CandidateRow {
            memory_id: "m1".into(),
            effective_score: 0.0,
            was_injected: false,
            relevance_score: None,
            fts_hit_count: 3,
            source: "fts".into(),
            importance: 0.5,
            mem_created_at: "2026-01-01T00:00:00Z".into(),
            access_count: 0,
            is_deleted: false,
            mem_project: None,
            pinned: false,
            mem_content: "test".into(),
            embedding_blob: None,
            embedding_dims: None,
        };
        let session = SessionRow {
            session_key: "s1".into(),
            project: None,
            score: 0.5,
            confidence: Some(0.8),
            novel_context_count: None,
            created_at: "2026-02-01T00:00:00Z".into(),
        };
        assert!((compute_label(&row, &session) - 0.6).abs() < 1e-9);
    }

    #[test]
    fn compute_label_not_injected_no_fts() {
        let row = CandidateRow {
            memory_id: "m1".into(),
            effective_score: 0.0,
            was_injected: false,
            relevance_score: None,
            fts_hit_count: 0,
            source: "fts".into(),
            importance: 0.5,
            mem_created_at: "2026-01-01T00:00:00Z".into(),
            access_count: 0,
            is_deleted: false,
            mem_project: None,
            pinned: false,
            mem_content: "test".into(),
            embedding_blob: None,
            embedding_dims: None,
        };
        let session = SessionRow {
            session_key: "s1".into(),
            project: None,
            score: 0.5,
            confidence: Some(0.8),
            novel_context_count: None,
            created_at: "2026-02-01T00:00:00Z".into(),
        };
        assert!((compute_label(&row, &session) - 0.0).abs() < 1e-9);
    }

    #[test]
    fn project_to_slot_deterministic() {
        let a = project_to_slot(Some("my-project"), 32);
        let b = project_to_slot(Some("my-project"), 32);
        assert_eq!(a, b);
        assert!(a < 32);
    }

    #[test]
    fn project_to_slot_none_is_zero() {
        assert_eq!(project_to_slot(None, 32), 0);
        assert_eq!(project_to_slot(Some(""), 32), 0);
    }

    #[test]
    fn compute_query_embedding_mean_of_two() {
        let dims = 3;
        let blob1 = make_f32_blob(&[2.0, 4.0, 6.0]);
        let blob2 = make_f32_blob(&[4.0, 8.0, 10.0]);
        let candidates = vec![
            CandidateRow {
                memory_id: "m1".into(),
                effective_score: 0.8,
                was_injected: true,
                relevance_score: None,
                fts_hit_count: 0,
                source: "recall".into(),
                importance: 0.5,
                mem_created_at: "2026-01-01T00:00:00Z".into(),
                access_count: 0,
                is_deleted: false,
                mem_project: None,
                pinned: false,
                mem_content: "a".into(),
                embedding_blob: Some(blob1),
                embedding_dims: Some(dims as i64),
            },
            CandidateRow {
                memory_id: "m2".into(),
                effective_score: 0.6,
                was_injected: true,
                relevance_score: None,
                fts_hit_count: 0,
                source: "recall".into(),
                importance: 0.5,
                mem_created_at: "2026-01-01T00:00:00Z".into(),
                access_count: 0,
                is_deleted: false,
                mem_project: None,
                pinned: false,
                mem_content: "b".into(),
                embedding_blob: Some(blob2),
                embedding_dims: Some(dims as i64),
            },
        ];
        let result = compute_query_embedding(&candidates, dims);
        assert_eq!(result.len(), 3);
        assert!((result[0] - 3.0).abs() < 1e-4);
        assert!((result[1] - 6.0).abs() < 1e-4);
        assert!((result[2] - 8.0).abs() < 1e-4);
    }

    #[test]
    fn compute_query_embedding_no_injected() {
        let candidates = vec![CandidateRow {
            memory_id: "m1".into(),
            effective_score: 0.5,
            was_injected: false,
            relevance_score: None,
            fts_hit_count: 0,
            source: "fts".into(),
            importance: 0.5,
            mem_created_at: "2026-01-01T00:00:00Z".into(),
            access_count: 0,
            is_deleted: false,
            mem_project: None,
            pinned: false,
            mem_content: "x".into(),
            embedding_blob: None,
            embedding_dims: None,
        }];
        let result = compute_query_embedding(&candidates, 4);
        assert_eq!(result, vec![0.0; 4]);
    }

    #[test]
    fn timestamp_parsing_basic() {
        let ts = "2026-02-20T14:30:45Z";
        let parsed = parse_timestamp(ts).unwrap();
        assert_eq!(parsed, (2026, 2, 20, 14, 30, 45));

        assert!((parse_hour(ts) - 14.0).abs() < 1e-9);
        assert!((parse_month(ts) - 2.0).abs() < 1e-9);

        // 2026-02-20 is a Friday. Sakamoto: 0=Sun => our 0=Mon => Friday=4
        let dow = parse_day_of_week(ts);
        assert!((dow - 4.0).abs() < 1e-9);
    }

    #[test]
    fn days_since_epoch_known() {
        // 1970-01-01 = day 0
        assert_eq!(days_since_epoch(1970, 1, 1), 0);
        // 2000-01-01 = day 10957
        assert_eq!(days_since_epoch(2000, 1, 1), 10957);
    }

    #[test]
    fn load_training_samples_integration() {
        let conn = create_test_db();

        // Insert qualifying session (confidence 0.9)
        conn.execute(
            "INSERT INTO session_scores (id, session_key, project, score, confidence, novel_context_count, created_at)
             VALUES ('ss1', 'session-good', 'proj-a', 0.8, 0.9, 2, '2026-02-20T14:00:00Z')",
            [],
        )
        .unwrap();

        // Insert skipped session (confidence 0.3)
        conn.execute(
            "INSERT INTO session_scores (id, session_key, project, score, confidence, novel_context_count, created_at)
             VALUES ('ss2', 'session-bad', 'proj-a', 0.5, 0.3, 0, '2026-02-19T10:00:00Z')",
            [],
        )
        .unwrap();

        // Insert memories
        conn.execute(
            "INSERT INTO memories (id, content, importance, created_at, updated_at, access_count, is_deleted, pinned)
             VALUES ('mem1', 'User prefers dark mode', 0.7, '2026-01-10T08:00:00Z', '2026-01-10T08:00:00Z', 3, 0, 0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO memories (id, content, importance, created_at, updated_at, access_count, is_deleted, pinned)
             VALUES ('mem2', 'Uses vim keybindings', 0.5, '2026-01-15T12:00:00Z', '2026-01-15T12:00:00Z', 1, 0, 0)",
            [],
        )
        .unwrap();

        // Insert session_memories for qualifying session
        conn.execute(
            "INSERT INTO session_memories (id, session_key, memory_id, source, effective_score, final_score, rank, was_injected, relevance_score, fts_hit_count, created_at)
             VALUES ('sm1', 'session-good', 'mem1', 'recall', 0.8, 0.8, 1, 1, 0.7, 2, '2026-02-20T14:00:00Z')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO session_memories (id, session_key, memory_id, source, effective_score, final_score, rank, was_injected, fts_hit_count, created_at)
             VALUES ('sm2', 'session-good', 'mem2', 'fts', 0.3, 0.3, 2, 0, 1, '2026-02-20T14:00:00Z')",
            [],
        )
        .unwrap();

        // Insert embedding for mem1
        let blob = make_f32_blob(&[0.1_f32; 4]);
        conn.execute(
            "INSERT INTO embeddings (id, content_hash, vector, dimensions, source_type, source_id, chunk_text, created_at)
             VALUES ('e1', 'hash1', ?1, 4, 'memory', 'mem1', 'User prefers dark mode', '2026-01-10T08:00:00Z')",
            rusqlite::params![blob],
        )
        .unwrap();

        // Write to temp file using VACUUM INTO
        let tmp = std::env::temp_dir().join("predictor_test_data.db");
        conn.execute(&format!("VACUUM INTO '{}'", tmp.display()), [])
            .unwrap();

        let config = DataConfig {
            min_scorer_confidence: 0.6,
            loss_temperature: 0.5,
            native_dim: 4,
        };
        let result = load_training_samples(&tmp, 100, &config).unwrap();

        assert_eq!(
            result.sessions_skipped, 1,
            "one session should be skipped by confidence gate"
        );
        assert_eq!(
            result.samples.len(),
            1,
            "one qualifying session should produce a sample"
        );

        let sample = &result.samples[0];
        assert_eq!(sample.session_id, "session-good");
        assert_eq!(sample.candidate_embeddings.len(), 2);
        assert_eq!(sample.candidate_features.len(), 2);
        assert_eq!(sample.labels.len(), 2);

        // First candidate has embedding, second does not
        assert_eq!(sample.candidate_embeddings[0].len(), 4);
        assert!(sample.candidate_texts[0].is_none());
        assert!(sample.candidate_embeddings[1].is_empty());
        assert!(sample.candidate_texts[1].is_some());

        // Feature dims = 12
        assert_eq!(sample.candidate_features[0].len(), 12);
        assert_eq!(sample.candidate_features[1].len(), 12);

        // Labels in reasonable range
        for label in &sample.labels {
            assert!(
                *label >= -0.5 && *label <= 1.0,
                "label {label} out of range"
            );
        }

        // Query embedding should be non-zero (one injected candidate with embedding)
        assert!(sample.query_embedding.iter().any(|v| *v != 0.0));

        // Clean up
        let _ = std::fs::remove_file(&tmp);
    }
}
