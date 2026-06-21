//! Session memory candidate and FTS hit tracking parity with
//! `platform/daemon/src/session-memories.ts`.
//!
//! Records the candidate pool injected at session start, tracks prompt-time FTS
//! hits, and accumulates agent relevance feedback for continuity scoring.

use std::collections::{HashMap, HashSet};

use chrono::Utc;
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::Value;
use uuid::Uuid;

const CHUNK_SIZE: usize = 50;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SessionMemorySource {
    Effective,
    FtsOnly,
    KaTraversal,
    KaTraversalPinned,
    Exploration,
}

impl SessionMemorySource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Effective => "effective",
            Self::FtsOnly => "fts_only",
            Self::KaTraversal => "ka_traversal",
            Self::KaTraversalPinned => "ka_traversal_pinned",
            Self::Exploration => "exploration",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct SessionMemoryCandidate {
    pub id: String,
    pub eff_score: f64,
    pub source: SessionMemorySource,
    pub final_score: Option<f64>,
    pub entity_slot: Option<i64>,
    pub aspect_slot: Option<i64>,
    pub is_constraint: Option<i64>,
    pub structural_density: Option<i64>,
    pub path_json: Option<String>,
}

pub fn record_session_candidates(
    conn: &Connection,
    session_key: Option<&str>,
    candidates: &[SessionMemoryCandidate],
    injected_ids: &HashSet<String>,
    agent_id: Option<&str>,
) -> rusqlite::Result<()> {
    let Some(session_key) = session_key.filter(|value| !value.is_empty()) else {
        return Ok(());
    };
    if candidates.is_empty() {
        return Ok(());
    }
    let agent_id = agent_id.unwrap_or("default");
    let now = Utc::now().to_rfc3339();

    let mut rank = 0_i64;
    for chunk in candidates.chunks(CHUNK_SIZE) {
        let row_sql = std::iter::repeat_n("(?,?,?,?,?,?,?,?,?,0,?,?,?,?,?,?)", chunk.len())
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!(
            "INSERT OR IGNORE INTO session_memories
             (id, session_key, agent_id, memory_id, source, effective_score,
              final_score, rank, was_injected,
              fts_hit_count, created_at,
              entity_slot, aspect_slot, is_constraint, structural_density,
              path_json)
             VALUES {row_sql}"
        );
        let mut values = Vec::with_capacity(chunk.len() * 15);
        for candidate in chunk {
            let was_injected = i64::from(injected_ids.contains(&candidate.id));
            let final_score = candidate.final_score.unwrap_or(candidate.eff_score);
            values.extend([
                rusqlite::types::Value::Text(Uuid::new_v4().to_string()),
                rusqlite::types::Value::Text(session_key.to_string()),
                rusqlite::types::Value::Text(agent_id.to_string()),
                rusqlite::types::Value::Text(candidate.id.clone()),
                rusqlite::types::Value::Text(candidate.source.as_str().to_string()),
                rusqlite::types::Value::Real(candidate.eff_score),
                rusqlite::types::Value::Real(final_score),
                rusqlite::types::Value::Integer(rank),
                rusqlite::types::Value::Integer(was_injected),
                rusqlite::types::Value::Text(now.clone()),
                opt_i64(candidate.entity_slot),
                opt_i64(candidate.aspect_slot),
                rusqlite::types::Value::Integer(candidate.is_constraint.unwrap_or(0)),
                opt_i64(candidate.structural_density),
                opt_text(candidate.path_json.clone()),
            ]);
            rank += 1;
        }
        conn.execute(&sql, rusqlite::params_from_iter(values))?;
    }

    Ok(())
}

fn opt_i64(value: Option<i64>) -> rusqlite::types::Value {
    value.map_or(
        rusqlite::types::Value::Null,
        rusqlite::types::Value::Integer,
    )
}

fn opt_text(value: Option<String>) -> rusqlite::types::Value {
    value.map_or(rusqlite::types::Value::Null, rusqlite::types::Value::Text)
}

pub fn track_fts_hits(
    conn: &Connection,
    session_key: Option<&str>,
    matched_ids: &[String],
    agent_id: Option<&str>,
) -> rusqlite::Result<()> {
    let Some(session_key) = session_key.filter(|value| !value.is_empty()) else {
        return Ok(());
    };
    if matched_ids.is_empty() {
        return Ok(());
    }
    let agent_id = agent_id.unwrap_or("default");
    let now = Utc::now().to_rfc3339();

    let mut update = conn.prepare_cached(
        "UPDATE session_memories
         SET fts_hit_count = fts_hit_count + 1
         WHERE session_key = ?1 AND agent_id = ?2 AND memory_id = ?3",
    )?;
    let mut insert = conn.prepare_cached(
        "INSERT OR IGNORE INTO session_memories
         (id, session_key, agent_id, memory_id, source, effective_score,
          final_score, rank, was_injected, fts_hit_count, created_at)
         VALUES (?1, ?2, ?3, ?4, 'fts_only', 0, 0, 0, 0, 1, ?5)",
    )?;

    for memory_id in matched_ids {
        let changed = update.execute(params![session_key, agent_id, memory_id])?;
        if changed == 0 {
            insert.execute(params![
                Uuid::new_v4().to_string(),
                session_key,
                agent_id,
                memory_id,
                now
            ])?;
        }
    }

    Ok(())
}

pub fn parse_feedback(raw: &Value) -> Option<HashMap<String, f64>> {
    let Value::Object(map) = raw else {
        return None;
    };
    let mut result = HashMap::new();
    let mut count = 0;
    for (key, val) in map {
        if key.is_empty() {
            continue;
        }
        let Some(score) = val.as_f64().filter(|score| score.is_finite()) else {
            continue;
        };
        result.insert(key.clone(), score.clamp(-1.0, 1.0));
        count += 1;
    }
    if count > 0 { Some(result) } else { None }
}

pub fn record_agent_feedback_inner(
    conn: &Connection,
    session_key: &str,
    feedback: &HashMap<String, f64>,
    agent_id: Option<&str>,
) -> rusqlite::Result<()> {
    let agent_id = agent_id.unwrap_or("default");
    let mut stmt = conn.prepare_cached(
        "UPDATE session_memories
         SET agent_relevance_score = CASE
                 WHEN agent_relevance_score IS NULL THEN ?1
                 ELSE (agent_relevance_score * agent_feedback_count + ?2) / (agent_feedback_count + 1)
             END,
             agent_feedback_count = COALESCE(agent_feedback_count, 0) + 1
         WHERE session_key = ?3 AND agent_id = ?4 AND memory_id = ?5",
    )?;

    for (memory_id, score) in feedback {
        stmt.execute(params![score, score, session_key, agent_id, memory_id])?;
    }
    Ok(())
}

pub fn record_agent_feedback(
    conn: &Connection,
    session_key: Option<&str>,
    feedback: &HashMap<String, f64>,
    agent_id: Option<&str>,
) -> rusqlite::Result<()> {
    let Some(session_key) = session_key.filter(|value| !value.is_empty()) else {
        return Ok(());
    };
    if feedback.is_empty() {
        return Ok(());
    }
    record_agent_feedback_inner(conn, session_key, feedback, agent_id)
}

#[derive(Debug, Clone, PartialEq)]
pub struct SessionMemoryRow {
    pub agent_id: String,
    pub memory_id: String,
    pub source: String,
    pub effective_score: Option<f64>,
    pub final_score: f64,
    pub rank: i64,
    pub was_injected: i64,
    pub fts_hit_count: i64,
    pub path_json: Option<String>,
}

pub fn session_memory_rows(
    conn: &Connection,
    session_key: &str,
) -> rusqlite::Result<Vec<SessionMemoryRow>> {
    let mut stmt = conn.prepare(
        "SELECT agent_id, memory_id, source, effective_score, final_score, rank,
                was_injected, fts_hit_count, path_json
         FROM session_memories
         WHERE session_key = ?1
         ORDER BY rank ASC, agent_id ASC, memory_id ASC",
    )?;
    stmt.query_map([session_key], |row| {
        Ok(SessionMemoryRow {
            agent_id: row.get(0)?,
            memory_id: row.get(1)?,
            source: row.get(2)?,
            effective_score: row.get(3)?,
            final_score: row.get(4)?,
            rank: row.get(5)?,
            was_injected: row.get(6)?,
            fts_hit_count: row.get(7)?,
            path_json: row.get(8)?,
        })
    })?
    .collect()
}

pub fn feedback_columns(
    conn: &Connection,
    session_key: &str,
    memory_id: &str,
    agent_id: Option<&str>,
) -> rusqlite::Result<Option<(Option<f64>, i64)>> {
    conn.query_row(
        "SELECT agent_relevance_score, agent_feedback_count
         FROM session_memories
         WHERE session_key = ?1 AND agent_id = ?2 AND memory_id = ?3",
        params![session_key, agent_id.unwrap_or("default"), memory_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
    .optional()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE session_memories (
                id TEXT PRIMARY KEY,
                session_key TEXT NOT NULL,
                agent_id TEXT NOT NULL DEFAULT 'default',
                memory_id TEXT NOT NULL,
                source TEXT NOT NULL,
                effective_score REAL,
                predictor_score REAL,
                final_score REAL NOT NULL,
                rank INTEGER NOT NULL,
                was_injected INTEGER NOT NULL,
                relevance_score REAL,
                fts_hit_count INTEGER NOT NULL DEFAULT 0,
                agent_preference TEXT,
                created_at TEXT NOT NULL,
                entity_slot INTEGER,
                aspect_slot INTEGER,
                is_constraint INTEGER NOT NULL DEFAULT 0,
                structural_density INTEGER,
                path_json TEXT,
                agent_relevance_score REAL,
                agent_feedback_count INTEGER DEFAULT 0,
                UNIQUE(session_key, agent_id, memory_id)
            );",
        )
        .unwrap();
        conn
    }

    fn candidate(id: &str, score: f64, source: SessionMemorySource) -> SessionMemoryCandidate {
        SessionMemoryCandidate {
            id: id.to_string(),
            eff_score: score,
            source,
            final_score: None,
            entity_slot: None,
            aspect_slot: None,
            is_constraint: None,
            structural_density: None,
            path_json: None,
        }
    }

    #[test]
    fn records_candidates_with_rank_scores_agent_path_and_idempotency() {
        // Parity: TS session-memories.ts:49-126 batch inserts candidates,
        // computes was_injected/finalScore/rank, stores agent/path, and uses
        // INSERT OR IGNORE for idempotency.
        let conn = setup_conn();
        let mut with_path = candidate("mem-aaa-111", 0.9, SessionMemorySource::KaTraversal);
        with_path.path_json = Some(r#"{"entity_ids":["ent-a"]}"#.to_string());
        let candidates = vec![
            with_path,
            candidate("mem-bbb-222", 0.7, SessionMemorySource::Effective),
            candidate("mem-ccc-333", 0.4, SessionMemorySource::Effective),
        ];
        let injected = HashSet::from(["mem-aaa-111".to_string(), "mem-bbb-222".to_string()]);
        record_session_candidates(
            &conn,
            Some("session-001"),
            &candidates,
            &injected,
            Some("agent-a"),
        )
        .unwrap();
        record_session_candidates(
            &conn,
            Some("session-001"),
            &candidates,
            &injected,
            Some("agent-a"),
        )
        .unwrap();

        let rows = session_memory_rows(&conn, "session-001").unwrap();
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0].rank, 0);
        assert_eq!(rows[1].rank, 1);
        assert_eq!(rows[0].agent_id, "agent-a");
        assert_eq!(rows[0].source, "ka_traversal");
        assert_eq!(rows[0].effective_score, Some(0.9));
        assert_eq!(rows[0].final_score, 0.9);
        assert_eq!(rows[0].was_injected, 1);
        assert!(rows[0].path_json.as_ref().unwrap().contains("entity_ids"));
        assert_eq!(rows[2].was_injected, 0);
    }

    #[test]
    fn candidate_recording_bails_on_missing_session_or_empty_candidates() {
        // Parity: TS session-memories.ts:55 returns before writing when session
        // key is absent or the candidate array is empty.
        let conn = setup_conn();
        let injected = HashSet::new();
        record_session_candidates(
            &conn,
            None,
            &[candidate("mem", 1.0, SessionMemorySource::Effective)],
            &injected,
            None,
        )
        .unwrap();
        record_session_candidates(&conn, Some("session"), &[], &injected, None).unwrap();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM session_memories", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn tracks_fts_hits_for_existing_new_and_agent_scoped_rows() {
        // Parity: TS session-memories.ts:140-189 increments existing rows and
        // inserts fts_only rows for memories absent from the candidate pool.
        let conn = setup_conn();
        let injected = HashSet::from(["mem-aaa-111".to_string()]);
        record_session_candidates(
            &conn,
            Some("session-fts"),
            &[candidate(
                "mem-aaa-111",
                0.9,
                SessionMemorySource::Effective,
            )],
            &injected,
            Some("agent-a"),
        )
        .unwrap();
        record_session_candidates(
            &conn,
            Some("session-fts"),
            &[candidate(
                "mem-aaa-111",
                0.9,
                SessionMemorySource::Effective,
            )],
            &injected,
            Some("agent-b"),
        )
        .unwrap();

        track_fts_hits(
            &conn,
            Some("session-fts"),
            &["mem-aaa-111".to_string()],
            Some("agent-a"),
        )
        .unwrap();
        track_fts_hits(
            &conn,
            Some("session-fts"),
            &["mem-aaa-111".to_string()],
            Some("agent-a"),
        )
        .unwrap();
        track_fts_hits(
            &conn,
            Some("session-fts"),
            &["mem-aaa-111".to_string(), "mem-bbb-222".to_string()],
            Some("agent-b"),
        )
        .unwrap();

        let counts = conn
            .prepare(
                "SELECT agent_id, memory_id, source, fts_hit_count
                 FROM session_memories
                 WHERE session_key = 'session-fts'
                 ORDER BY agent_id, memory_id",
            )
            .unwrap()
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            })
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        assert_eq!(
            counts,
            vec![
                (
                    "agent-a".to_string(),
                    "mem-aaa-111".to_string(),
                    "effective".to_string(),
                    2
                ),
                (
                    "agent-b".to_string(),
                    "mem-aaa-111".to_string(),
                    "effective".to_string(),
                    1
                ),
                (
                    "agent-b".to_string(),
                    "mem-bbb-222".to_string(),
                    "fts_only".to_string(),
                    1
                ),
            ]
        );
    }

    #[test]
    fn fts_tracking_bails_on_missing_session_or_empty_matches() {
        // Parity: TS session-memories.ts:145 returns before writing when session
        // key is absent or matchedIds is empty.
        let conn = setup_conn();
        track_fts_hits(&conn, None, &["mem".to_string()], None).unwrap();
        track_fts_hits(&conn, Some("session"), &[], None).unwrap();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM session_memories", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn parses_feedback_and_clamps_valid_scores() {
        // Parity: TS session-memories.ts:199-212 accepts only object maps,
        // skips empty keys/non-finite non-numbers, and clamps to [-1, 1].
        assert_eq!(parse_feedback(&Value::Null), None);
        assert_eq!(parse_feedback(&Value::Array(vec![])), None);
        assert_eq!(parse_feedback(&serde_json::json!({})), None);
        let parsed = parse_feedback(&serde_json::json!({
            "mem1": 5.0,
            "mem2": -3.0,
            "bad_string": "nope",
            "": 0.5,
            "also_good": -0.3
        }))
        .unwrap();
        assert_eq!(parsed.get("mem1"), Some(&1.0));
        assert_eq!(parsed.get("mem2"), Some(&-1.0));
        assert_eq!(parsed.get("also_good"), Some(&-0.3));
        assert!(!parsed.contains_key("bad_string"));
        assert!(!parsed.contains_key(""));
    }

    #[test]
    fn records_agent_feedback_running_mean_and_scope() {
        // Parity: TS session-memories.ts:224-245 updates rows with a running
        // mean and scopes by session_key + agent_id + memory_id.
        let conn = setup_conn();
        let injected = HashSet::from(["mem-aaa-111".to_string()]);
        record_session_candidates(
            &conn,
            Some("session-fb"),
            &[candidate(
                "mem-aaa-111",
                0.9,
                SessionMemorySource::Effective,
            )],
            &injected,
            Some("agent-a"),
        )
        .unwrap();
        record_session_candidates(
            &conn,
            Some("session-fb"),
            &[candidate(
                "mem-aaa-111",
                0.9,
                SessionMemorySource::Effective,
            )],
            &injected,
            Some("agent-b"),
        )
        .unwrap();

        record_agent_feedback_inner(
            &conn,
            "session-fb",
            &HashMap::from([("mem-aaa-111".to_string(), 0.8)]),
            Some("agent-a"),
        )
        .unwrap();
        record_agent_feedback_inner(
            &conn,
            "session-fb",
            &HashMap::from([("mem-aaa-111".to_string(), 0.4), ("ghost".to_string(), 0.9)]),
            Some("agent-a"),
        )
        .unwrap();

        assert_eq!(
            feedback_columns(&conn, "session-fb", "mem-aaa-111", Some("agent-a")).unwrap(),
            Some((Some(0.6000000000000001), 2))
        );
        assert_eq!(
            feedback_columns(&conn, "session-fb", "mem-aaa-111", Some("agent-b")).unwrap(),
            Some((None, 0))
        );
        assert_eq!(
            feedback_columns(&conn, "session-fb", "ghost", Some("agent-a")).unwrap(),
            None
        );
    }

    #[test]
    fn public_agent_feedback_bails_on_missing_session_or_empty_feedback() {
        // Parity: TS session-memories.ts:251-261 returns before writing when
        // session key is absent or feedback is empty.
        let conn = setup_conn();
        let injected = HashSet::from(["mem".to_string()]);
        record_session_candidates(
            &conn,
            Some("session-fb"),
            &[candidate("mem", 0.9, SessionMemorySource::Effective)],
            &injected,
            None,
        )
        .unwrap();
        record_agent_feedback(
            &conn,
            None,
            &HashMap::from([("mem".to_string(), 1.0)]),
            None,
        )
        .unwrap();
        record_agent_feedback(&conn, Some("session-fb"), &HashMap::new(), None).unwrap();
        assert_eq!(
            feedback_columns(&conn, "session-fb", "mem", None).unwrap(),
            Some((None, 0))
        );
    }
}
