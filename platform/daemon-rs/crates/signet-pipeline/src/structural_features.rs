//! Candidate feature-vector parity with `platform/daemon/src/structural-features.ts`.
//!
//! Computes the 17 predictor inputs used by the daemon scorer: recency,
//! importance/access signals, cyclic session time, embedding presence,
//! supersession state, structural entity/aspect slots, structural density, and
//! traversal source flags.

use std::collections::{HashMap, HashSet};

use chrono::{DateTime, NaiveDateTime, Utc};
use rusqlite::{Connection, params};

pub const PREDICTOR_FEATURE_DIMENSIONS: usize = 17;
const MILLIS_PER_DAY: f64 = 86_400_000.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum StructuralCandidateSource {
    Effective,
    FtsOnly,
    KaTraversal,
    KaTraversalPinned,
}

impl StructuralCandidateSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Effective => "effective",
            Self::FtsOnly => "fts_only",
            Self::KaTraversal => "ka_traversal",
            Self::KaTraversalPinned => "ka_traversal_pinned",
        }
    }

    pub fn from_predictor_source(value: &str) -> Option<Self> {
        match value {
            "effective" => Some(Self::Effective),
            "fts_only" => Some(Self::FtsOnly),
            "ka_traversal" => Some(Self::KaTraversal),
            // TS intentionally excludes `ka_traversal_pinned` from sourceById
            // in buildCandidateFeatures (structural-features.ts:155-158).
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct StructuralFeatures {
    pub entity_slot: u8,
    pub aspect_slot: u8,
    pub is_constraint: i64,
    pub structural_density: i64,
    pub candidate_source: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CandidateInput {
    pub id: String,
    pub importance: f64,
    pub created_at: String,
    pub access_count: i64,
    pub last_accessed: Option<String>,
    pub pinned: bool,
    pub is_superseded: bool,
    pub source: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SessionFeatureContext {
    pub project_slot: f64,
    pub time_of_day: f64,
    pub day_of_week: f64,
    pub month_of_year: f64,
    pub session_gap_days: f64,
}

#[derive(Debug, Clone)]
struct StructuralAttributeRow {
    memory_id: String,
    kind: String,
    aspect_id: String,
    entity_id: String,
    importance: f64,
    created_at: String,
}

fn placeholders(count: usize) -> String {
    std::iter::repeat_n("?", count)
        .collect::<Vec<_>>()
        .join(", ")
}

/// FNV-1a over UTF-16 code units, matching JS `charCodeAt` in TS lines 34-40.
pub fn hash_slot(value: &str) -> u8 {
    let mut hash = 2_166_136_261_u32;
    for unit in value.encode_utf16() {
        hash ^= u32::from(unit);
        hash = hash.wrapping_mul(16_777_619);
    }
    (hash % 256) as u8
}

fn parse_to_millis(iso: &str) -> Option<i64> {
    if let Ok(ts) = DateTime::parse_from_rfc3339(iso) {
        return Some(ts.timestamp_millis());
    }
    if let Ok(ts) = NaiveDateTime::parse_from_str(iso, "%Y-%m-%d %H:%M:%S") {
        return Some(ts.and_utc().timestamp_millis());
    }
    if let Ok(ts) = NaiveDateTime::parse_from_str(iso, "%Y-%m-%dT%H:%M:%S") {
        return Some(ts.and_utc().timestamp_millis());
    }
    None
}

pub fn days_since(iso: &str, now_ms: i64) -> f64 {
    let Some(ts) = parse_to_millis(iso) else {
        return 0.0;
    };
    ((now_ms - ts) as f64 / MILLIS_PER_DAY).max(0.0)
}

fn choose_primary_row(
    current: Option<StructuralAttributeRow>,
    next: StructuralAttributeRow,
) -> StructuralAttributeRow {
    let Some(current) = current else {
        return next;
    };
    let current_constraint = i32::from(current.kind == "constraint");
    let next_constraint = i32::from(next.kind == "constraint");
    if next_constraint != current_constraint {
        return if next_constraint > current_constraint {
            next
        } else {
            current
        };
    }
    if next.importance != current.importance {
        return if next.importance > current.importance {
            next
        } else {
            current
        };
    }
    if next.created_at < current.created_at {
        next
    } else {
        current
    }
}

fn structural_density(conn: &Connection, entity_id: &str, agent_id: &str) -> rusqlite::Result<i64> {
    let aspect_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM entity_aspects WHERE entity_id = ?1 AND agent_id = ?2",
        params![entity_id, agent_id],
        |row| row.get(0),
    )?;
    let attribute_count: i64 = conn.query_row(
        "SELECT COUNT(*)
         FROM entity_attributes ea
         JOIN entity_aspects asp ON asp.id = ea.aspect_id
         WHERE asp.entity_id = ?1
           AND asp.agent_id = ?2
           AND ea.agent_id = ?3
           AND ea.kind = 'attribute'
           AND ea.status = 'active'",
        params![entity_id, agent_id, agent_id],
        |row| row.get(0),
    )?;
    Ok(aspect_count + attribute_count)
}

pub fn get_structural_features(
    conn: &Connection,
    memory_ids: &[String],
    agent_id: &str,
    source_by_id: Option<&HashMap<String, StructuralCandidateSource>>,
) -> rusqlite::Result<HashMap<String, Option<StructuralFeatures>>> {
    let mut features_by_memory_id = memory_ids
        .iter()
        .map(|memory_id| (memory_id.clone(), None))
        .collect::<HashMap<_, _>>();
    if memory_ids.is_empty() {
        return Ok(features_by_memory_id);
    }

    // Mirrors TS lines 78-104: load active rows for requested memories and
    // choose constraint > importance > oldest created_at as the primary row.
    let sql = format!(
        "SELECT ea.memory_id, ea.kind, ea.aspect_id, ea.importance, ea.created_at, asp.entity_id
         FROM entity_attributes ea
         JOIN entity_aspects asp ON asp.id = ea.aspect_id
         WHERE ea.memory_id IN ({})
           AND ea.agent_id = ?
           AND ea.status = 'active'
         ORDER BY ea.memory_id ASC,
           CASE ea.kind WHEN 'constraint' THEN 0 ELSE 1 END,
           ea.importance DESC,
           ea.created_at ASC",
        placeholders(memory_ids.len())
    );

    let mut values = memory_ids
        .iter()
        .cloned()
        .map(rusqlite::types::Value::Text)
        .collect::<Vec<_>>();
    values.push(rusqlite::types::Value::Text(agent_id.to_string()));

    let mut stmt = conn.prepare(&sql)?;
    let mut rows = stmt.query(rusqlite::params_from_iter(values))?;
    let mut by_memory_id: HashMap<String, StructuralAttributeRow> = HashMap::new();
    while let Some(row) = rows.next()? {
        let next = StructuralAttributeRow {
            memory_id: row.get(0)?,
            kind: row.get(1)?,
            aspect_id: row.get(2)?,
            importance: row.get(3)?,
            created_at: row.get(4)?,
            entity_id: row.get(5)?,
        };
        let key = next.memory_id.clone();
        let current = by_memory_id.remove(&key);
        by_memory_id.insert(key, choose_primary_row(current, next));
    }

    let mut density_cache = HashMap::<String, i64>::new();
    for (memory_id, row) in by_memory_id {
        let density = match density_cache.get(&row.entity_id) {
            Some(value) => *value,
            None => {
                let value = structural_density(conn, &row.entity_id, agent_id)?;
                density_cache.insert(row.entity_id.clone(), value);
                value
            }
        };
        features_by_memory_id.insert(
            memory_id.clone(),
            Some(StructuralFeatures {
                entity_slot: hash_slot(&row.entity_id),
                aspect_slot: hash_slot(&row.aspect_id),
                is_constraint: i64::from(row.kind == "constraint"),
                structural_density: density,
                candidate_source: source_by_id
                    .and_then(|sources| sources.get(&memory_id).copied())
                    .map(|source| source.as_str().to_string()),
            }),
        );
    }

    Ok(features_by_memory_id)
}

pub fn build_candidate_features(
    conn: &Connection,
    candidates: &[CandidateInput],
    agent_id: &str,
    session_context: SessionFeatureContext,
) -> rusqlite::Result<Vec<[f64; PREDICTOR_FEATURE_DIMENSIONS]>> {
    build_candidate_features_with_now(
        conn,
        candidates,
        agent_id,
        session_context,
        Utc::now().timestamp_millis(),
    )
}

pub fn build_candidate_features_with_now(
    conn: &Connection,
    candidates: &[CandidateInput],
    agent_id: &str,
    session_context: SessionFeatureContext,
    now_ms: i64,
) -> rusqlite::Result<Vec<[f64; PREDICTOR_FEATURE_DIMENSIONS]>> {
    if candidates.is_empty() {
        return Ok(Vec::new());
    }

    let candidate_ids = candidates
        .iter()
        .map(|candidate| candidate.id.clone())
        .collect::<Vec<_>>();
    let source_by_id = candidates
        .iter()
        .filter_map(|candidate| {
            StructuralCandidateSource::from_predictor_source(candidate.source.as_deref()?)
                .map(|source| (candidate.id.clone(), source))
        })
        .collect::<HashMap<_, _>>();
    let structural_by_id =
        get_structural_features(conn, &candidate_ids, agent_id, Some(&source_by_id))?;

    let sql = format!(
        "SELECT DISTINCT source_id
         FROM embeddings
         WHERE source_type = 'memory'
           AND source_id IN ({})",
        placeholders(candidate_ids.len())
    );
    let embedded_ids = conn
        .prepare(&sql)?
        .query_map(
            rusqlite::params_from_iter(
                candidate_ids
                    .iter()
                    .cloned()
                    .map(rusqlite::types::Value::Text),
            ),
            |row| row.get::<_, String>(0),
        )?
        .collect::<rusqlite::Result<HashSet<_>>>()?;

    let tod_angle = (2.0 * std::f64::consts::PI * session_context.time_of_day) / 24.0;
    let dow_angle = (2.0 * std::f64::consts::PI * session_context.day_of_week) / 7.0;
    let moy_angle = (2.0 * std::f64::consts::PI * session_context.month_of_year) / 12.0;
    let safe_session_gap_days = session_context.session_gap_days.max(0.0);

    candidates
        .iter()
        .map(|candidate| {
            let structural = structural_by_id
                .get(&candidate.id)
                .and_then(|value| value.as_ref());
            let source = structural
                .and_then(|value| value.candidate_source.as_deref())
                .or(candidate.source.as_deref());
            Ok([
                (days_since(&candidate.created_at, now_ms) + 1.0).ln(),
                candidate.importance,
                (candidate.access_count as f64 + 1.0).ln(),
                tod_angle.sin(),
                tod_angle.cos(),
                dow_angle.sin(),
                dow_angle.cos(),
                moy_angle.sin(),
                moy_angle.cos(),
                (safe_session_gap_days + 1.0).ln(),
                f64::from(embedded_ids.contains(&candidate.id)),
                f64::from(candidate.is_superseded),
                structural.map_or(0.0, |value| f64::from(value.entity_slot) / 255.0),
                structural.map_or(0.0, |value| f64::from(value.aspect_slot) / 255.0),
                structural.map_or(0.0, |value| value.is_constraint as f64),
                structural.map_or(0.0, |value| (value.structural_density as f64 + 1.0).ln()),
                f64::from(source == Some("ka_traversal")),
            ])
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE entity_aspects (
                id TEXT PRIMARY KEY,
                entity_id TEXT NOT NULL,
                agent_id TEXT NOT NULL,
                name TEXT NOT NULL,
                canonical_name TEXT NOT NULL,
                weight REAL NOT NULL DEFAULT 0.5,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE entity_attributes (
                id TEXT PRIMARY KEY,
                aspect_id TEXT,
                agent_id TEXT NOT NULL,
                memory_id TEXT,
                kind TEXT NOT NULL,
                content TEXT NOT NULL,
                normalized_content TEXT NOT NULL,
                confidence REAL NOT NULL DEFAULT 0,
                importance REAL NOT NULL DEFAULT 0.5,
                status TEXT NOT NULL DEFAULT 'active',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE embeddings (
                id TEXT PRIMARY KEY,
                content_hash TEXT,
                vector BLOB,
                dimensions INTEGER,
                source_type TEXT,
                source_id TEXT,
                chunk_text TEXT,
                created_at TEXT
            );",
        )
        .unwrap();
        let now = "2026-06-20T00:00:00Z";
        conn.execute(
            "INSERT INTO entity_aspects (id, entity_id, agent_id, name, canonical_name, weight, created_at, updated_at)
             VALUES ('aspect-1', 'entity-1', 'default', 'Auth', 'auth', 0.8, ?1, ?1)",
            [now],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO entity_attributes
             (id, aspect_id, agent_id, memory_id, kind, content, normalized_content, confidence, importance, status, created_at, updated_at)
             VALUES ('attr-1', 'aspect-1', 'default', 'mem-1', 'attribute', 'Auth uses WorkOS', 'auth uses workos', 1, 0.9, 'active', ?1, ?1)",
            [now],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO entity_attributes
             (id, aspect_id, agent_id, memory_id, kind, content, normalized_content, confidence, importance, status, created_at, updated_at)
             VALUES ('attr-2', 'aspect-1', 'default', 'mem-2', 'constraint', 'Never bypass auth review', 'never bypass auth review', 1, 0.8, 'active', ?1, ?1)",
            [now],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO embeddings (id, content_hash, vector, dimensions, source_type, source_id, chunk_text, created_at)
             VALUES ('emb-1', 'hash-mem-1', X'000000', 3, 'memory', 'mem-1', 'Auth uses WorkOS', ?1)",
            [now],
        )
        .unwrap();
        conn
    }

    #[test]
    fn returns_structural_slots_and_density_for_assigned_memories() {
        // Parity: TS structural-features.ts:65-126 returns null-initialized map,
        // chooses active entity_attributes, and stores aspect+attribute density.
        let conn = setup_conn();
        let source_by_id = HashMap::from([
            ("mem-1".to_string(), StructuralCandidateSource::KaTraversal),
            ("mem-2".to_string(), StructuralCandidateSource::Effective),
        ]);
        let features = get_structural_features(
            &conn,
            &[
                "mem-1".to_string(),
                "mem-2".to_string(),
                "mem-3".to_string(),
            ],
            "default",
            Some(&source_by_id),
        )
        .unwrap();

        let attr = features.get("mem-1").unwrap().as_ref().unwrap();
        let constraint = features.get("mem-2").unwrap().as_ref().unwrap();
        assert_eq!(attr.entity_slot, constraint.entity_slot);
        assert_eq!(attr.aspect_slot, constraint.aspect_slot);
        assert_eq!(attr.structural_density, 2);
        assert_eq!(constraint.is_constraint, 1);
        assert_eq!(attr.candidate_source.as_deref(), Some("ka_traversal"));
        assert_eq!(constraint.candidate_source.as_deref(), Some("effective"));
        assert!(features.get("mem-3").unwrap().is_none());
    }

    #[test]
    fn builds_17_element_vectors_and_clamps_negative_session_gap() {
        // Parity: TS structural-features.ts:128-208 builds 17 numeric inputs;
        // line 177 clamps negative gaps before the log at line 192.
        let conn = setup_conn();
        let now = DateTime::parse_from_rfc3339("2026-06-20T00:00:00Z")
            .unwrap()
            .timestamp_millis();
        let vectors = build_candidate_features_with_now(
            &conn,
            &[
                CandidateInput {
                    id: "mem-1".to_string(),
                    importance: 0.9,
                    created_at: "2026-06-20T00:00:00Z".to_string(),
                    access_count: 3,
                    last_accessed: None,
                    pinned: false,
                    is_superseded: false,
                    source: Some("ka_traversal".to_string()),
                },
                CandidateInput {
                    id: "mem-3".to_string(),
                    importance: 0.5,
                    created_at: "2026-06-20T00:00:00Z".to_string(),
                    access_count: 0,
                    last_accessed: None,
                    pinned: false,
                    is_superseded: false,
                    source: Some("effective".to_string()),
                },
            ],
            "default",
            SessionFeatureContext {
                project_slot: 0.0,
                time_of_day: 12.0,
                day_of_week: 3.0,
                month_of_year: 2.0,
                session_gap_days: -3.0,
            },
            now,
        )
        .unwrap();

        assert_eq!(vectors.len(), 2);
        assert_eq!(vectors[0].len(), PREDICTOR_FEATURE_DIMENSIONS);
        assert_eq!(vectors[0][9], 0.0);
        assert_eq!(vectors[0][10], 1.0);
        assert_eq!(vectors[0][14], 0.0);
        assert_eq!(vectors[0][16], 1.0);
        assert_eq!(vectors[1][12], 0.0);
        assert_eq!(vectors[1][13], 0.0);
        assert_eq!(vectors[1][15], 0.0);
    }

    #[test]
    fn chooses_constraint_before_higher_importance_attribute() {
        // Parity: TS structural-features.ts:49-63 primary row tie-breaker prefers
        // constraints before importance and oldest created_at.
        let conn = setup_conn();
        conn.execute(
            "INSERT INTO entity_attributes
             (id, aspect_id, agent_id, memory_id, kind, content, normalized_content, confidence, importance, status, created_at, updated_at)
             VALUES ('attr-3', 'aspect-1', 'default', 'mem-1', 'constraint', 'Constraint wins', 'constraint wins', 1, 0.1, 'active', '2026-06-19T00:00:00Z', '2026-06-19T00:00:00Z')",
            [],
        )
        .unwrap();
        let features =
            get_structural_features(&conn, &["mem-1".to_string()], "default", None).unwrap();
        assert_eq!(features["mem-1"].as_ref().unwrap().is_constraint, 1);
    }
}
