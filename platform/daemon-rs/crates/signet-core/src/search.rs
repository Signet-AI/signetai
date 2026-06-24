//! Hybrid recall search: FTS5 BM25 + sqlite-vec cosine KNN + alpha blending.
//!
//! Score formula: `score = alpha * vector + (1 - alpha) * keyword`
//!
//! Optional post-processing: rehearsal boost (access frequency + recency decay),
//! traversal-primary graph fusion, TS SEC-lite shaping, dampening, currentness,
//! source fallbacks, reranking.
//!
//! Parity references: `platform/daemon/src/memory-search.ts:997` stages recall
//! collection before authorized content handling; `:1634` authorizes candidates
//! before content/reranker/access mutation; `:1333`, `:1378`, `:1679`,
//! `:1834`, `:1950`, and `:2003` define temporal fusion, traversal-primary
//! fusion, SEC-lite, dampening, currentness, and source fallbacks.

use std::collections::{HashMap, HashSet};

use rusqlite::{Connection, params};
use tracing::warn;

use crate::constants::DEFAULT_HYBRID_ALPHA;
use crate::error::CoreError;

// ---------------------------------------------------------------------------
// Search types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct ScoredHit {
    pub id: String,
    pub score: f64,
    pub source: SearchSource,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SearchSource {
    Vector,
    Keyword,
    Hybrid,
    Graph,
    Traversal,
    Hint,
    Structured,
    Temporal,
    TemporalCandidate,
    TemporalHybrid,
    Sec,
    Source,
    SourceObsidian,
    NativeArtifact,
}

impl SearchSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Vector => "vector",
            Self::Keyword => "keyword",
            Self::Hybrid => "hybrid",
            Self::Graph => "graph",
            Self::Traversal => "traversal",
            Self::Hint => "hint",
            Self::Structured => "structured",
            Self::Temporal => "temporal",
            Self::TemporalCandidate => "temporal_candidate",
            Self::TemporalHybrid => "temporal_hybrid",
            Self::Sec => "sec",
            Self::Source => "source",
            Self::SourceObsidian => "source_obsidian",
            Self::NativeArtifact => "native_memory",
        }
    }
}

/// Full search hit including memory data (post-fetch).
#[derive(Debug, Clone)]
pub struct SearchHit {
    pub id: String,
    pub content: String,
    pub score: f64,
    pub memory_type: String,
    pub source: SearchSource,
    pub tags: Vec<String>,
    pub confidence: f64,
}

/// Options for the high-level `hybrid_search` convenience function.
#[derive(Debug, Clone)]
pub struct SearchOptions {
    pub query: String,
    pub vector: Option<Vec<f32>>,
    pub limit: usize,
    pub alpha: f64,
    pub min_score: f64,
    pub top_k: usize,
    pub memory_type: Option<String>,
}

impl Default for SearchOptions {
    fn default() -> Self {
        Self {
            query: String::new(),
            vector: None,
            limit: 10,
            alpha: DEFAULT_HYBRID_ALPHA,
            min_score: 0.1,
            top_k: 50,
            memory_type: None,
        }
    }
}

// ---------------------------------------------------------------------------
// Filter clause builder
// ---------------------------------------------------------------------------

/// Dynamic filter parameters for recall queries.
#[derive(Debug, Default)]
pub struct RecallFilter<'a> {
    pub memory_type: Option<&'a str>,
    pub tags: Option<&'a str>,
    pub who: Option<&'a str>,
    pub pinned: Option<bool>,
    pub importance_min: Option<f64>,
    pub since: Option<&'a str>,
    pub until: Option<&'a str>,
    pub scope: Option<&'a str>,
    pub project: Option<&'a str>,
    pub agent_id: Option<&'a str>,
    pub read_policy: Option<&'a str>,
    pub policy_group: Option<&'a str>,
}

struct FilterClause {
    sql: String,
    args: Vec<Box<dyn rusqlite::types::ToSql>>,
}

fn build_filter(f: &RecallFilter) -> FilterClause {
    let mut parts = vec!["COALESCE(m.is_deleted, 0) = 0".to_string()];
    let mut args: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

    if let Some(scope) = f.scope {
        parts.push("m.scope = ?".to_string());
        args.push(Box::new(scope.to_string()));
    } else {
        parts.push("m.scope IS NULL".to_string());
    }

    if let Some(t) = f.memory_type {
        parts.push("m.type = ?".to_string());
        args.push(Box::new(t.to_string()));
    }
    if let Some(tags) = f.tags {
        for t in tags.split(',').map(str::trim).filter(|s| !s.is_empty()) {
            parts.push("m.tags LIKE ?".to_string());
            args.push(Box::new(format!("%{t}%")));
        }
    }
    if let Some(w) = f.who {
        parts.push("m.who = ?".to_string());
        args.push(Box::new(w.to_string()));
    }
    if f.pinned == Some(true) {
        parts.push("m.pinned = 1".to_string());
    }
    if let Some(min) = f.importance_min {
        parts.push("m.importance >= ?".to_string());
        args.push(Box::new(min));
    }
    if let Some(s) = f.since {
        parts.push("m.created_at >= ?".to_string());
        args.push(Box::new(s.to_string()));
    }
    if let Some(u) = f.until {
        parts.push("m.created_at <= ?".to_string());
        args.push(Box::new(u.to_string()));
    }
    if let Some(project) = f.project {
        parts.push("m.project = ?".to_string());
        args.push(Box::new(project.to_string()));
    }
    if let Some(agent_id) = f.agent_id {
        match f.read_policy.unwrap_or("isolated") {
            "shared" => {
                parts.push(
                    "(m.visibility = 'global' OR m.agent_id = ?) AND m.visibility != 'archived'"
                        .to_string(),
                );
                args.push(Box::new(agent_id.to_string()));
            }
            "group" => {
                if let Some(group) = f.policy_group {
                    parts.push(
                        "((m.visibility = 'global' AND m.agent_id IN (SELECT id FROM agents WHERE policy_group = ?)) OR m.agent_id = ?) AND m.visibility != 'archived'".to_string(),
                    );
                    args.push(Box::new(group.to_string()));
                    args.push(Box::new(agent_id.to_string()));
                } else {
                    parts.push("m.agent_id = ? AND m.visibility != 'archived'".to_string());
                    args.push(Box::new(agent_id.to_string()));
                }
            }
            _ => {
                parts.push("m.agent_id = ? AND m.visibility != 'archived'".to_string());
                args.push(Box::new(agent_id.to_string()));
            }
        }
    }

    let sql = if parts.is_empty() {
        String::new()
    } else {
        format!(" AND {}", parts.join(" AND "))
    };

    FilterClause { sql, args }
}

// ---------------------------------------------------------------------------
// FTS5 query sanitization
// ---------------------------------------------------------------------------

/// Sanitize a raw user query for FTS5 MATCH.
///
/// Strips FTS5 syntax characters (colons, quotes, parens, asterisks, carets)
/// and double-quotes each token so it's treated as a literal phrase.
/// Preserves FTS5 boolean operators (OR, AND, NOT).
pub fn sanitize_fts(raw: &str) -> String {
    raw.split_whitespace()
        .filter_map(|token| {
            if token == "OR" || token == "AND" || token == "NOT" {
                return Some(token.to_string());
            }
            let cleaned: String = token.chars().filter(|c| !":\"()^*".contains(*c)).collect();
            let cleaned = cleaned.trim();
            if cleaned.is_empty() {
                return None;
            }
            Some(format!("\"{cleaned}\""))
        })
        .collect::<Vec<_>>()
        .join(" ")
}

// ---------------------------------------------------------------------------
// BM25 keyword search
// ---------------------------------------------------------------------------

/// Run FTS5 keyword search with min-max normalized BM25 scores.
///
/// The TS daemon normalizes BM25 within the batch: `|raw| / max(|raw|)`.
/// This preserves relative ranking while mapping to [0,1].
pub fn fts_search(
    conn: &Connection,
    query: &str,
    top_k: usize,
    filter: &RecallFilter,
) -> Result<Vec<ScoredHit>, CoreError> {
    let sanitized = sanitize_fts(query);
    if sanitized.is_empty() {
        return Ok(Vec::new());
    }

    let fc = build_filter(filter);

    let sql = format!(
        "SELECT m.id, bm25(memories_fts) AS raw_score
         FROM memories_fts
         JOIN memories m ON memories_fts.rowid = m.rowid
         WHERE memories_fts MATCH ?1{filter_sql}
         ORDER BY raw_score
         LIMIT ?{n}",
        filter_sql = fc.sql,
        n = fc.args.len() + 2,
    );

    let mut stmt = conn.prepare(&sql)?;

    // Build params: [query, ...filter_args, top_k]
    let mut all: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
    all.push(Box::new(sanitized));
    all.extend(fc.args);
    all.push(Box::new(top_k as i64));

    let refs: Vec<&dyn rusqlite::types::ToSql> = all.iter().map(|b| b.as_ref()).collect();

    let rows: Vec<(String, f64)> = stmt
        .query_map(refs.as_slice(), |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, f64>(1)?))
        })?
        .filter_map(|r| r.ok())
        .collect();

    if rows.is_empty() {
        return Ok(Vec::new());
    }

    // Min-max normalize: BM25 scores are negative (lower = better)
    let raw: Vec<f64> = rows.iter().map(|(_, s)| s.abs()).collect();
    let max = raw.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    let normalizer = if max > 0.0 { max } else { 1.0 };

    Ok(rows
        .into_iter()
        .map(|(id, score)| ScoredHit {
            id,
            score: score.abs() / normalizer,
            source: SearchSource::Keyword,
        })
        .collect())
}

/// Simple BM25 keyword search with 1/(1+|score|) normalization.
/// Used by the basic `hybrid_search` convenience function.
pub fn keyword_search(conn: &Connection, query: &str, limit: usize) -> Vec<(String, f64)> {
    let result = conn
        .prepare(
            "SELECT m.id, bm25(memories_fts) AS raw_score
             FROM memories_fts
             JOIN memories m ON memories_fts.rowid = m.rowid
             WHERE memories_fts MATCH ?1
             ORDER BY raw_score
             LIMIT ?2",
        )
        .and_then(|mut stmt| {
            let rows = stmt.query_map(params![query, limit], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, f64>(1)?))
            })?;
            Ok(rows
                .filter_map(|r| r.ok())
                .map(|(id, raw)| {
                    let normalized = 1.0 / (1.0 + raw.abs());
                    (id, normalized)
                })
                .collect())
        });

    result.unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Vector (KNN) search
// ---------------------------------------------------------------------------

/// Run cosine KNN search via sqlite-vec.
///
/// Returns similarity scores in [0,1] where `similarity = 1 - cosine_distance`.
pub fn vector_search(
    conn: &Connection,
    query_vec: &[f32],
    limit: usize,
    memory_type: Option<&str>,
) -> Vec<(String, f64)> {
    let blob: Vec<u8> = query_vec.iter().flat_map(|f| f.to_le_bytes()).collect();

    let sql = if memory_type.is_some() {
        "SELECT e.source_id, v.distance
         FROM vec_embeddings v
         JOIN embeddings e ON v.id = e.id
         JOIN memories m ON e.source_id = m.id
         WHERE v.embedding MATCH ?1 AND k = ?2 AND m.type = ?3
         ORDER BY v.distance"
    } else {
        "SELECT e.source_id, v.distance
         FROM vec_embeddings v
         JOIN embeddings e ON v.id = e.id
         JOIN memories m ON e.source_id = m.id
         WHERE v.embedding MATCH ?1 AND k = ?2
         ORDER BY v.distance"
    };

    let result = (|| -> Result<Vec<(String, f64)>, rusqlite::Error> {
        let mut stmt = conn.prepare(sql)?;

        let collect = |row: &rusqlite::Row| -> rusqlite::Result<(String, f64)> {
            Ok((row.get::<_, String>(0)?, row.get::<_, f64>(1)?))
        };

        let raw: Vec<(String, f64)> = if let Some(t) = memory_type {
            stmt.query_map(params![blob, limit, t], collect)?
                .filter_map(|r| r.ok())
                .collect()
        } else {
            stmt.query_map(params![blob, limit], collect)?
                .filter_map(|r| r.ok())
                .collect()
        };

        Ok(raw
            .into_iter()
            .map(|(id, dist)| {
                let sim = (1.0 - dist).max(0.0);
                (id, sim)
            })
            .collect())
    })();

    match result {
        Ok(v) => v,
        Err(e) => {
            warn!(err = %e, "vector search failed");
            Vec::new()
        }
    }
}

/// Vector search returning `ScoredHit` (for use with `merge_scores`).
pub fn vec_search_scored(
    conn: &Connection,
    query_vec: &[f32],
    top_k: usize,
    filter: &RecallFilter,
) -> Vec<ScoredHit> {
    let blob: Vec<u8> = query_vec.iter().flat_map(|f| f.to_le_bytes()).collect();
    let fc = build_filter(filter);
    let sql = format!(
        "SELECT e.source_id, v.distance
         FROM vec_embeddings v
         JOIN embeddings e ON v.id = e.id
         JOIN memories m ON e.source_id = m.id
         WHERE v.embedding MATCH ? AND k = ?{filter_sql}
         ORDER BY v.distance",
        filter_sql = fc.sql,
    );

    let result = (|| -> Result<Vec<ScoredHit>, rusqlite::Error> {
        let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
        params.push(Box::new(blob));
        params.push(Box::new(top_k as i64));
        params.extend(fc.args);
        let refs: Vec<&dyn rusqlite::types::ToSql> = params.iter().map(|b| b.as_ref()).collect();

        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(refs.as_slice(), |row| {
            let dist = row.get::<_, f64>(1)?;
            Ok(ScoredHit {
                id: row.get(0)?,
                score: (1.0 - dist).max(0.0),
                source: SearchSource::Vector,
            })
        })?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    })();

    match result {
        Ok(v) => v,
        Err(e) => {
            warn!(err = %e, "vector search failed");
            Vec::new()
        }
    }
}

// ---------------------------------------------------------------------------
// Hybrid merge
// ---------------------------------------------------------------------------

/// Merge FTS5 and vector results with alpha blending.
///
/// `alpha` weights vector vs keyword: `score = alpha * vec + (1-alpha) * bm25`.
/// Results below `min_score` are dropped. Output sorted by score descending.
pub fn merge_scores(
    fts: &[ScoredHit],
    vec: &[ScoredHit],
    alpha: f64,
    min_score: f64,
) -> Vec<ScoredHit> {
    let bm25_map: HashMap<&str, f64> = fts.iter().map(|h| (h.id.as_str(), h.score)).collect();
    let vec_map: HashMap<&str, f64> = vec.iter().map(|h| (h.id.as_str(), h.score)).collect();

    let mut ids = HashSet::new();
    for h in fts {
        ids.insert(h.id.as_str());
    }
    for h in vec {
        ids.insert(h.id.as_str());
    }

    let mut scored: Vec<ScoredHit> = ids
        .into_iter()
        .filter_map(|id| {
            let bm25 = bm25_map.get(id).copied().unwrap_or(0.0);
            let v = vec_map.get(id).copied().unwrap_or(0.0);

            let (score, source) = if bm25 > 0.0 && v > 0.0 {
                (alpha * v + (1.0 - alpha) * bm25, SearchSource::Hybrid)
            } else if v > 0.0 {
                (v, SearchSource::Vector)
            } else {
                (bm25, SearchSource::Keyword)
            };

            if score >= min_score {
                Some(ScoredHit {
                    id: id.to_string(),
                    score,
                    source,
                })
            } else {
                None
            }
        })
        .collect();

    scored.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    scored
}

const HINT_ONLY_SCORE_CAP: f64 = 0.75;
const TEMPORAL_TOPIC_SCORE_CAP: f64 = 0.85;

#[derive(Debug, Clone)]
pub struct CurrentnessInfo {
    pub active: Vec<String>,
    pub superseded: Vec<(String, Option<String>)>,
}

#[derive(Debug, Clone)]
pub struct SourceFallbackHit {
    pub id: String,
    pub content: String,
    pub score: f64,
    pub source: SearchSource,
    pub source_id: String,
    pub source_type: String,
    pub tags: String,
    pub importance: f64,
    pub who: String,
    pub project: Option<String>,
    pub created_at: String,
    pub source_path: String,
}

fn sorted_hits(mut hits: Vec<ScoredHit>) -> Vec<ScoredHit> {
    hits.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    hits
}

fn clamp01(v: f64) -> f64 {
    if v.is_finite() {
        v.clamp(0.0, 1.0)
    } else {
        0.0
    }
}

fn tokenize_query(raw: &str) -> Vec<String> {
    let stops: HashSet<&'static str> = [
        "a", "an", "and", "are", "as", "at", "be", "but", "by", "for", "from", "how", "i", "in",
        "is", "it", "of", "on", "or", "that", "the", "this", "to", "was", "what", "when", "where",
        "which", "who", "with", "you", "your",
    ]
    .into_iter()
    .collect();
    let mut seen = HashSet::new();
    raw.to_lowercase()
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|token| token.len() >= 2 && !stops.contains(*token))
        .filter_map(|token| {
            if seen.insert(token.to_string()) {
                Some(token.to_string())
            } else {
                None
            }
        })
        .collect()
}

/// Prospective hint FTS candidate channel from TS `memory-search.ts:1203`.
/// Hints are candidate scouts; hint-only rows are capped during final fusion.
pub fn hint_search(
    conn: &Connection,
    query: &str,
    top_k: usize,
    filter: &RecallFilter,
) -> Vec<ScoredHit> {
    let sanitized = sanitize_fts(query);
    let agent_id = match filter.agent_id {
        Some(id) if !id.trim().is_empty() => id,
        _ => return Vec::new(),
    };
    if sanitized.is_empty() {
        return Vec::new();
    }
    let fc = build_filter(filter);
    let sql = format!(
        "SELECT h.memory_id AS id, bm25(memory_hints_fts) AS raw_score
         FROM memory_hints_fts
         JOIN memory_hints h ON memory_hints_fts.rowid = h.rowid
         JOIN memories m ON m.id = h.memory_id
         WHERE memory_hints_fts MATCH ?1 AND h.agent_id = ?2{filter_sql}
         ORDER BY raw_score LIMIT ?{n}",
        filter_sql = fc.sql,
        n = fc.args.len() + 3,
    );
    let result = (|| -> Result<Vec<(String, f64)>, rusqlite::Error> {
        let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
        params.push(Box::new(sanitized));
        params.push(Box::new(agent_id.to_string()));
        params.extend(fc.args);
        params.push(Box::new(top_k as i64));
        let refs: Vec<&dyn rusqlite::types::ToSql> = params.iter().map(|b| b.as_ref()).collect();
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(refs.as_slice(), |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, f64>(1)?))
        })?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    })();
    let rows = match result {
        Ok(rows) => rows,
        Err(e) => {
            warn!(err = %e, "hint search failed");
            return Vec::new();
        }
    };
    let max = rows
        .iter()
        .map(|(_, s)| s.abs())
        .fold(0.0, f64::max)
        .max(1.0);
    rows.into_iter()
        .map(|(id, score)| ScoredHit {
            id,
            score: score.abs() / max,
            source: SearchSource::Hint,
        })
        .collect()
}

/// Temporal candidate expansion/fusion seed from TS `memory-search.ts:1333`.
/// This only collects IDs and confidence; content is not read until after
/// `authorize_scored_candidates`.
pub fn temporal_candidates(
    conn: &Connection,
    top_k: usize,
    filter: &RecallFilter,
    min_score: f64,
) -> Vec<ScoredHit> {
    let agent_id = match filter.agent_id {
        Some(id) if !id.trim().is_empty() => id,
        _ => return Vec::new(),
    };
    let fc = build_filter(filter);
    let sql = format!(
        "SELECT te.subject_id, MAX(COALESCE(te.confidence, 1.0)) AS confidence
         FROM temporal_edges te
         JOIN memories m ON m.id = te.subject_id
         WHERE te.agent_id = ?1 AND te.subject_type = 'memory'{filter_sql}
         GROUP BY te.subject_id
         ORDER BY confidence DESC, MAX(te.start_at) DESC
         LIMIT ?{n}",
        filter_sql = fc.sql,
        n = fc.args.len() + 2,
    );
    let result = (|| -> Result<Vec<ScoredHit>, rusqlite::Error> {
        let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = vec![Box::new(agent_id.to_string())];
        params.extend(fc.args);
        params.push(Box::new(top_k as i64));
        let refs: Vec<&dyn rusqlite::types::ToSql> = params.iter().map(|b| b.as_ref()).collect();
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(refs.as_slice(), |row| {
            Ok(ScoredHit {
                id: row.get(0)?,
                score: clamp01(row.get::<_, f64>(1).unwrap_or(1.0)).max(min_score.max(0.05)),
                source: SearchSource::TemporalCandidate,
            })
        })?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    })();
    match result {
        Ok(rows) => rows,
        Err(e) => {
            warn!(err = %e, "temporal candidate search failed");
            Vec::new()
        }
    }
}

/// Recall-route temporal gate from TS `memory-search.ts:1105-1123`.
/// Temporal edge candidates only participate after request/query temporal
/// intent has been parsed; otherwise ordinary recall must not be reordered by
/// memories that merely have temporal metadata.
pub fn temporal_candidates_for_recall(
    conn: &Connection,
    top_k: usize,
    filter: &RecallFilter,
    min_score: f64,
    temporal_intent: bool,
) -> Vec<ScoredHit> {
    if temporal_intent {
        temporal_candidates(conn, top_k, filter, min_score)
    } else {
        Vec::new()
    }
}

/// Structured path candidate channel from TS `memory-search.ts:1290`.
pub fn structured_path_candidates(
    conn: &Connection,
    query: &str,
    top_k: usize,
    filter: &RecallFilter,
) -> Vec<ScoredHit> {
    let agent_id = match filter.agent_id {
        Some(id) if !id.trim().is_empty() => id,
        _ => return Vec::new(),
    };
    let tokens = tokenize_query(query);
    if tokens.is_empty() {
        return Vec::new();
    }
    let mut by_id: HashMap<String, f64> = HashMap::new();
    for token in tokens.iter().take(8) {
        let fc = build_filter(filter);
        let sql = format!(
            "SELECT m.id, MAX(COALESCE(ea.importance, 0.5)) AS score
             FROM entity_attributes ea
             JOIN memories m ON m.id = ea.memory_id
             LEFT JOIN entity_aspects asp ON asp.id = ea.aspect_id
             LEFT JOIN entities ent ON ent.id = asp.entity_id
             WHERE ea.agent_id = ?1 AND ea.status = 'active'
               AND (lower(ea.content) LIKE ?2 OR lower(ea.normalized_content) LIKE ?2 OR lower(COALESCE(ent.name, '')) LIKE ?2){filter_sql}
             GROUP BY m.id
             ORDER BY score DESC LIMIT ?{n}",
            filter_sql = fc.sql,
            n = fc.args.len() + 3,
        );
        let like = format!("%{}%", token);
        let result = (|| -> Result<Vec<(String, f64)>, rusqlite::Error> {
            let mut params: Vec<Box<dyn rusqlite::types::ToSql>> =
                vec![Box::new(agent_id.to_string()), Box::new(like)];
            params.extend(fc.args);
            params.push(Box::new(top_k as i64));
            let refs: Vec<&dyn rusqlite::types::ToSql> =
                params.iter().map(|b| b.as_ref()).collect();
            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt.query_map(refs.as_slice(), |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, f64>(1).unwrap_or(0.5),
                ))
            })?;
            Ok(rows.filter_map(|r| r.ok()).collect())
        })();
        if let Ok(rows) = result {
            for (id, score) in rows {
                by_id
                    .entry(id)
                    .and_modify(|existing| *existing = (*existing).max(score))
                    .or_insert(score);
            }
        }
    }
    sorted_hits(
        by_id
            .into_iter()
            .map(|(id, score)| ScoredHit {
                id,
                score: clamp01(score),
                source: SearchSource::Structured,
            })
            .take(top_k)
            .collect(),
    )
}

/// Traversal-primary graph candidate channel from TS `memory-search.ts:1378`.
pub fn traversal_primary_candidates(
    conn: &Connection,
    query: &str,
    top_k: usize,
    filter: &RecallFilter,
    min_score: f64,
) -> Vec<ScoredHit> {
    let agent_id = match filter.agent_id {
        Some(id) if !id.trim().is_empty() => id,
        _ => return Vec::new(),
    };
    let tokens = tokenize_query(query);
    if tokens.is_empty() {
        return Vec::new();
    }
    let mut by_id: HashMap<String, f64> = HashMap::new();
    for token in tokens.iter().take(8) {
        let fc = build_filter(filter);
        let sql = format!(
            "SELECT mem.memory_id, MAX(COALESCE(ea.importance, m.importance, 0.5)) AS score
             FROM memory_entity_mentions mem
             JOIN memories m ON m.id = mem.memory_id
             JOIN entities ent ON ent.id = mem.entity_id
             LEFT JOIN entity_aspects asp ON asp.entity_id = ent.id AND asp.agent_id = ?1
             LEFT JOIN entity_attributes ea ON ea.aspect_id = asp.id AND ea.agent_id = ?1 AND ea.status = 'active'
             WHERE (lower(ent.name) LIKE ?2 OR lower(COALESCE(ea.content, '')) LIKE ?2 OR lower(COALESCE(ea.normalized_content, '')) LIKE ?2){filter_sql}
             GROUP BY mem.memory_id
             ORDER BY score DESC LIMIT ?{n}",
            filter_sql = fc.sql,
            n = fc.args.len() + 3,
        );
        let like = format!("%{}%", token);
        let result = (|| -> Result<Vec<(String, f64)>, rusqlite::Error> {
            let mut params: Vec<Box<dyn rusqlite::types::ToSql>> =
                vec![Box::new(agent_id.to_string()), Box::new(like)];
            params.extend(fc.args);
            params.push(Box::new(top_k as i64));
            let refs: Vec<&dyn rusqlite::types::ToSql> =
                params.iter().map(|b| b.as_ref()).collect();
            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt.query_map(refs.as_slice(), |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, f64>(1).unwrap_or(0.5),
                ))
            })?;
            Ok(rows.filter_map(|r| r.ok()).collect())
        })();
        if let Ok(rows) = result {
            for (id, score) in rows {
                by_id
                    .entry(id)
                    .and_modify(|existing| *existing = (*existing).max(score))
                    .or_insert(score);
            }
        }
    }
    sorted_hits(
        by_id
            .into_iter()
            .map(|(id, score)| ScoredHit {
                id,
                score: clamp01(score).max(min_score),
                source: SearchSource::Traversal,
            })
            .collect(),
    )
    .into_iter()
    .take(top_k)
    .collect()
}

/// TS `memory-search.ts:1634`: authorize candidates before content reads,
/// rerankers, or access mutations. This is the native security boundary.
pub fn authorize_scored_candidates(
    conn: &Connection,
    scored: &[ScoredHit],
    filter: &RecallFilter,
) -> Vec<ScoredHit> {
    if scored.is_empty() {
        return Vec::new();
    }
    let mut ordered = Vec::new();
    let mut seen = HashSet::new();
    for hit in scored {
        if seen.insert(hit.id.as_str()) {
            ordered.push(hit.id.as_str());
        }
    }
    let placeholders = ordered
        .iter()
        .enumerate()
        .map(|(i, _)| format!("?{}", i + 1))
        .collect::<Vec<_>>()
        .join(",");
    let fc = build_filter(filter);
    let sql = format!(
        "SELECT m.id FROM memories m WHERE m.id IN ({placeholders}){filter_sql}",
        filter_sql = fc.sql
    );
    let allowed: HashSet<String> = match conn.prepare(&sql) {
        Ok(mut stmt) => {
            let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = ordered
                .iter()
                .map(|id| Box::new((*id).to_string()) as Box<dyn rusqlite::types::ToSql>)
                .collect();
            params.extend(fc.args);
            let refs: Vec<&dyn rusqlite::types::ToSql> =
                params.iter().map(|b| b.as_ref()).collect();
            stmt.query_map(refs.as_slice(), |row| row.get::<_, String>(0))
                .ok()
                .map(|rows| rows.filter_map(|r| r.ok()).collect())
                .unwrap_or_default()
        }
        Err(e) => {
            warn!(err = %e, "candidate authorization failed");
            HashSet::new()
        }
    };
    scored
        .iter()
        .filter(|hit| allowed.contains(&hit.id))
        .cloned()
        .collect()
}

/// Flat candidate fusion, matching TS `memory-search.ts:1333` ordering rules.
pub fn merge_recall_candidates(
    fts: &[ScoredHit],
    hints: &[ScoredHit],
    vec: &[ScoredHit],
    structured: &[ScoredHit],
    temporal: &[ScoredHit],
    alpha: f64,
    min_score: f64,
) -> Vec<ScoredHit> {
    let mut bm25 = HashMap::new();
    let mut hint = HashMap::new();
    let mut vector = HashMap::new();
    let mut sec = HashMap::new();
    let mut temp = HashMap::new();
    for h in fts {
        bm25.insert(h.id.as_str(), h.score);
    }
    for h in hints {
        hint.entry(h.id.as_str())
            .and_modify(|v: &mut f64| *v = (*v).max(h.score))
            .or_insert(h.score);
    }
    for h in vec {
        vector.insert(h.id.as_str(), h.score);
    }
    for h in structured {
        sec.entry(h.id.as_str())
            .and_modify(|v: &mut f64| *v = (*v).max(h.score))
            .or_insert(h.score);
    }
    for h in temporal {
        temp.insert(h.id.as_str(), h.score);
    }
    let mut ids = HashSet::new();
    ids.extend(bm25.keys().copied());
    ids.extend(hint.keys().copied());
    ids.extend(vector.keys().copied());
    ids.extend(sec.keys().copied());
    ids.extend(temp.keys().copied());
    let mut out = Vec::new();
    for id in ids {
        let b = bm25.get(id).copied().unwrap_or(0.0);
        let h = hint.get(id).copied().unwrap_or(0.0);
        let v = vector.get(id).copied().unwrap_or(0.0);
        let s = sec.get(id).copied().unwrap_or(0.0);
        let t = temp.get(id).copied().unwrap_or(0.0);
        let topic_evidence = b > 0.0 || h > 0.0 || v > 0.0 || s > 0.0;
        let temporal_score = if t > 0.0 && topic_evidence { 0.85 } else { 0.0 };
        let (mut score, mut source) = if b > 0.0 && v > 0.0 {
            (alpha * v + (1.0 - alpha) * b, SearchSource::Hybrid)
        } else if v > 0.0 {
            (v, SearchSource::Vector)
        } else if b > 0.0 {
            (b, SearchSource::Keyword)
        } else if temporal_score > 0.0 {
            (temporal_score, SearchSource::Temporal)
        } else if t > 0.0 {
            (t, SearchSource::TemporalCandidate)
        } else {
            (s, SearchSource::Structured)
        };
        if h > 0.0 && h >= score {
            let has_direct = b > 0.0 || v > 0.0 || s > 0.0;
            score = if has_direct {
                h
            } else {
                h.min(HINT_ONLY_SCORE_CAP)
            };
            source = if b > 0.0 || v > 0.0 {
                SearchSource::Hybrid
            } else if s > 0.0 {
                SearchSource::Sec
            } else {
                SearchSource::Hint
            };
        }
        if s > 0.0 && s >= score {
            score = s;
            source = if b > 0.0 || v > 0.0 || h > 0.0 {
                SearchSource::Sec
            } else {
                SearchSource::Structured
            };
        }
        if temporal_score > 0.0 && temporal_score >= score {
            score = temporal_score;
            source = if b > 0.0 || v > 0.0 || h > 0.0 || s > 0.0 {
                SearchSource::TemporalHybrid
            } else {
                SearchSource::Temporal
            };
        }
        if score >= min_score {
            out.push(ScoredHit {
                id: id.to_string(),
                score,
                source,
            });
        }
    }
    sorted_hits(out)
}

/// Traversal-primary fusion from TS `memory-search.ts:1378`: graph candidates
/// are a retrieval channel, not merely a boost, while keeping flat coverage.
pub fn fuse_traversal_primary(
    flat: &[ScoredHit],
    traversal: &[ScoredHit],
    limit: usize,
    top_k: usize,
) -> Vec<ScoredHit> {
    if traversal.is_empty() {
        return flat.to_vec();
    }
    let candidate_budget = limit.max(top_k.min(limit.saturating_mul(4).max(limit)));
    let min_flat = ((candidate_budget as f64) * 0.4).ceil() as usize;
    let flat_ids: HashSet<&str> = flat.iter().map(|h| h.id.as_str()).collect();
    let mut by_id: HashMap<&str, ScoredHit> = HashMap::new();
    for hit in flat.iter().chain(traversal.iter()) {
        match by_id.get(hit.id.as_str()) {
            Some(existing) if existing.score >= hit.score => {}
            _ => {
                by_id.insert(hit.id.as_str(), hit.clone());
            }
        }
    }
    let fused = sorted_hits(by_id.into_values().collect());
    let mut selected = Vec::new();
    let mut flat_count = 0usize;
    for hit in fused {
        if selected.len() >= candidate_budget {
            break;
        }
        let is_flat = flat_ids.contains(hit.id.as_str());
        let remaining = candidate_budget - selected.len();
        let needed_flat = min_flat.min(flat.len()).saturating_sub(flat_count);
        if !is_flat && needed_flat >= remaining {
            continue;
        }
        if is_flat {
            flat_count += 1;
        }
        selected.push(hit);
    }
    selected
}

/// SEC-lite from TS `memory-search.ts:1679`: shape separate evidence channels
/// after fusion without letting graph-only rows dominate anchored evidence.
pub fn apply_sec_lite(
    scored: &mut Vec<ScoredHit>,
    fts: &[ScoredHit],
    hints: &[ScoredHit],
    vec: &[ScoredHit],
    structured: &[ScoredHit],
    traversal: &[ScoredHit],
    min_score: f64,
) {
    if scored.is_empty() {
        return;
    }
    let map = |hits: &[ScoredHit]| -> HashMap<String, f64> {
        hits.iter().map(|h| (h.id.clone(), h.score)).collect()
    };
    let lexical = map(fts);
    let semantic = map(vec);
    let hint = map(hints);
    let structured_map = map(structured);
    let traversal_map = map(traversal);
    let has_secondary = scored.iter().any(|row| {
        hint.get(row.id.as_str()).copied().unwrap_or(0.0) > 0.0
            || structured_map.get(row.id.as_str()).copied().unwrap_or(0.0) > 0.0
            || traversal_map.get(row.id.as_str()).copied().unwrap_or(0.0) > 0.0
    });
    for row in scored.iter_mut() {
        let id = row.id.as_str();
        let l = clamp01(lexical.get(id).copied().unwrap_or(0.0));
        let s = clamp01(semantic.get(id).copied().unwrap_or(0.0));
        let h = clamp01(hint.get(id).copied().unwrap_or(0.0));
        let t = clamp01(traversal_map.get(id).copied().unwrap_or(0.0));
        let st = clamp01(structured_map.get(id).copied().unwrap_or(0.0));
        let lexical_floor = if l > 0.0 {
            if has_secondary { 0.4 + l * 0.02 } else { l }
        } else {
            0.0
        };
        let mut shaped = (l * 0.25 + s * 0.30 + h * 0.30 + t * 0.15 + st * 0.15)
            .max(lexical_floor)
            .max(h);
        if st >= 0.25 {
            shaped += (st - 0.25) * 0.8;
        }
        if st >= 0.2 {
            shaped = shaped.max(st);
        }
        let anchored = l > 0.0 || h > 0.0 || s >= 0.35 || st >= 0.35;
        if t > 0.0 && !anchored {
            shaped = shaped.min(0.35);
        }
        shaped = clamp01(shaped);
        if shaped >= min_score {
            row.score = shaped;
            row.source = if t > 0.0 && (l > 0.0 || s > 0.0 || h > 0.0 || st > 0.0) {
                SearchSource::Sec
            } else if st > 0.0 && (l > 0.0 || s > 0.0 || h > 0.0) {
                SearchSource::Sec
            } else if st > 0.0 && t == 0.0 {
                SearchSource::Structured
            } else if h > 0.0 && l == 0.0 && s == 0.0 {
                SearchSource::Hint
            } else {
                row.source
            };
        } else {
            row.score = 0.0;
        }
    }
    scored.retain(|row| row.score >= min_score);
    scored.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
}

pub fn score_temporal_topic_evidence(query: &str, content: &str) -> f64 {
    let query_tokens = tokenize_query(query);
    if query_tokens.is_empty() {
        return 0.0;
    }
    let content_tokens: HashSet<String> = tokenize_query(content).into_iter().collect();
    let matched = query_tokens
        .iter()
        .filter(|token| content_tokens.contains(*token))
        .count();
    if matched == 0 {
        return 0.0;
    }
    let coverage = matched as f64 / query_tokens.len() as f64;
    let density = matched as f64 / (content_tokens.len().max(8) as f64);
    TEMPORAL_TOPIC_SCORE_CAP.min(0.35 + coverage * 0.4 + density * 0.1)
}

/// Temporal topic evidence after auth, per TS `memory-search.ts:1643`.
pub fn apply_temporal_topic_evidence(conn: &Connection, scored: &mut [ScoredHit], query: &str) {
    let ids: Vec<&str> = scored
        .iter()
        .filter(|h| {
            matches!(
                h.source,
                SearchSource::TemporalCandidate
                    | SearchSource::Temporal
                    | SearchSource::TemporalHybrid
            )
        })
        .map(|h| h.id.as_str())
        .collect();
    if ids.is_empty() {
        return;
    }
    let placeholders = ids
        .iter()
        .enumerate()
        .map(|(i, _)| format!("?{}", i + 1))
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!("SELECT id, content FROM memories WHERE id IN ({placeholders})");
    let rows: HashMap<String, String> = match conn.prepare(&sql) {
        Ok(mut stmt) => {
            let refs: Vec<&dyn rusqlite::types::ToSql> = ids
                .iter()
                .map(|s| s as &dyn rusqlite::types::ToSql)
                .collect();
            stmt.query_map(refs.as_slice(), |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .ok()
            .map(|rows| rows.filter_map(|r| r.ok()).collect())
            .unwrap_or_default()
        }
        Err(e) => {
            warn!(err = %e, "temporal topic evidence query failed");
            return;
        }
    };
    for row in scored.iter_mut() {
        if let Some(content) = rows.get(&row.id) {
            let topic = score_temporal_topic_evidence(query, content);
            if topic > 0.0
                && (matches!(row.source, SearchSource::TemporalCandidate) || topic > row.score)
            {
                row.score = topic;
                row.source = if matches!(row.source, SearchSource::TemporalCandidate) {
                    SearchSource::Temporal
                } else {
                    SearchSource::TemporalHybrid
                };
            }
        }
    }
}

/// Post-fusion dampening from TS `memory-search.ts:1834` / `pipeline/dampening.ts`.
pub fn apply_dampening(conn: &Connection, scored: &mut [ScoredHit], query: &str) {
    if scored.is_empty() {
        return;
    }
    let ids: Vec<&str> = scored.iter().map(|s| s.id.as_str()).collect();
    let placeholders = ids
        .iter()
        .enumerate()
        .map(|(i, _)| format!("?{}", i + 1))
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!("SELECT id, content, type FROM memories WHERE id IN ({placeholders})");
    let rows: HashMap<String, (String, String)> = match conn.prepare(&sql) {
        Ok(mut stmt) => {
            let refs: Vec<&dyn rusqlite::types::ToSql> = ids
                .iter()
                .map(|s| s as &dyn rusqlite::types::ToSql)
                .collect();
            stmt.query_map(refs.as_slice(), |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    (row.get::<_, String>(1)?, row.get::<_, String>(2)?),
                ))
            })
            .ok()
            .map(|rows| rows.filter_map(|r| r.ok()).collect())
            .unwrap_or_default()
        }
        Err(e) => {
            warn!(err = %e, "dampening metadata query failed");
            return;
        }
    };
    let query_tokens: HashSet<String> = tokenize_query(query).into_iter().collect();
    for hit in scored.iter_mut() {
        let Some((content, mem_type)) = rows.get(&hit.id) else {
            continue;
        };
        if matches!(
            hit.source,
            SearchSource::Vector
                | SearchSource::Hybrid
                | SearchSource::Traversal
                | SearchSource::Sec
                | SearchSource::Structured
        ) && hit.score > 0.3
            && !query_tokens.is_empty()
        {
            let content_tokens: HashSet<String> = tokenize_query(content).into_iter().collect();
            if !query_tokens
                .iter()
                .any(|token| content_tokens.contains(token))
            {
                hit.score *= 0.5;
            }
        }
        if mem_type == "constraint" || mem_type == "decision" {
            hit.score *= 1.2;
        } else if content.len() >= 50
            && (content.contains("202")
                || content.to_lowercase().contains("january")
                || content.to_lowercase().contains("february")
                || content.to_lowercase().contains("march")
                || content.to_lowercase().contains("april")
                || content.to_lowercase().contains("may")
                || content.to_lowercase().contains("june")
                || content.to_lowercase().contains("july")
                || content.to_lowercase().contains("august")
                || content.to_lowercase().contains("september")
                || content.to_lowercase().contains("october")
                || content.to_lowercase().contains("november")
                || content.to_lowercase().contains("december"))
        {
            hit.score *= 1.1;
        }
    }
    scored.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
}

fn shorten_currentness_content(content: &str) -> String {
    let one = content.split_whitespace().collect::<Vec<_>>().join(" ");
    if one.len() <= 240 {
        one
    } else {
        format!("{}...", &one[..one.floor_char_boundary(237)])
    }
}

/// Currentness loading and bias from TS `memory-search.ts:1950`.
pub fn load_currentness_info(
    conn: &Connection,
    ids: &[&str],
    agent_id: &str,
) -> HashMap<String, CurrentnessInfo> {
    if ids.is_empty() {
        return HashMap::new();
    }
    let placeholders = ids
        .iter()
        .enumerate()
        .map(|(i, _)| format!("?{}", i + 1))
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "SELECT ea.memory_id, ea.content, ea.status, replacement.content AS replacement_content
         FROM entity_attributes ea
         LEFT JOIN entity_attributes replacement ON replacement.id = ea.superseded_by AND replacement.agent_id = ea.agent_id
         WHERE ea.memory_id IN ({placeholders}) AND ea.agent_id = ?{} AND ea.status IN ('active', 'superseded')
         ORDER BY ea.importance DESC, ea.created_at DESC",
        ids.len() + 1
    );
    let result = (|| -> Result<Vec<(String, String, String, Option<String>)>, rusqlite::Error> {
        let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = ids
            .iter()
            .map(|id| Box::new((*id).to_string()) as Box<dyn rusqlite::types::ToSql>)
            .collect();
        params.push(Box::new(agent_id.to_string()));
        let refs: Vec<&dyn rusqlite::types::ToSql> = params.iter().map(|b| b.as_ref()).collect();
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(refs.as_slice(), |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
            ))
        })?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    })();
    let mut out: HashMap<String, CurrentnessInfo> = HashMap::new();
    if let Ok(rows) = result {
        for (memory_id, content, status, replacement) in rows {
            let entry = out.entry(memory_id).or_insert_with(|| CurrentnessInfo {
                active: Vec::new(),
                superseded: Vec::new(),
            });
            if status == "active" && entry.active.len() < 3 {
                entry.active.push(shorten_currentness_content(&content));
            } else if status == "superseded" && entry.superseded.len() < 3 {
                entry.superseded.push((
                    shorten_currentness_content(&content),
                    replacement.map(|r| shorten_currentness_content(&r)),
                ));
            }
        }
    }
    out
}

pub fn apply_currentness_bias(
    scored: &mut [ScoredHit],
    currentness: &HashMap<String, CurrentnessInfo>,
) {
    for hit in scored.iter_mut() {
        let Some(info) = currentness.get(&hit.id) else {
            continue;
        };
        if info.active.is_empty() && !info.superseded.is_empty() {
            hit.score *= 0.65;
        } else if !info.superseded.is_empty() {
            hit.score *= 0.85;
        } else if !info.active.is_empty() {
            hit.score *= 1.03;
        }
    }
    scored.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
}

pub fn annotate_currentness(content: &str, info: Option<&CurrentnessInfo>) -> String {
    let Some(info) = info else {
        return content.to_string();
    };
    if info.superseded.is_empty() {
        return content.to_string();
    }
    let mut lines = vec!["[Signet currentness]".to_string()];
    if !info.active.is_empty() {
        lines.push("Current structured facts:".to_string());
        for item in &info.active {
            lines.push(format!("- {item}"));
        }
    }
    lines.push(
        "Superseded structured facts, historical unless the question asks about the past:"
            .to_string(),
    );
    for (content, replacement) in &info.superseded {
        lines.push(format!("- {content}"));
        if let Some(replacement) = replacement {
            lines.push(format!("  Current replacement: {replacement}"));
        }
    }
    format!("{}\n\n{}", lines.join("\n"), content)
}

fn source_path_from_chunk_text(chunk_text: &str) -> String {
    chunk_text
        .lines()
        .find_map(|line| {
            line.to_lowercase()
                .strip_prefix("source_path:")
                .map(|_| line["source_path:".len()..].trim().to_string())
        })
        .unwrap_or_default()
}

fn cosine_from_blob(query_vec: &[f32], blob: &[u8]) -> f64 {
    let len = query_vec.len().min(blob.len() / 4);
    if len == 0 {
        return 0.0;
    }
    let mut dot = 0.0f64;
    let mut qn = 0.0f64;
    let mut mn = 0.0f64;
    for i in 0..len {
        let q = query_vec[i] as f64;
        let start = i * 4;
        let m = f32::from_le_bytes([
            blob[start],
            blob[start + 1],
            blob[start + 2],
            blob[start + 3],
        ]) as f64;
        dot += q * m;
        qn += q * q;
        mn += m * m;
    }
    let denom = qn.sqrt() * mn.sqrt();
    if denom <= 0.0 {
        0.0
    } else {
        clamp01(dot / denom)
    }
}

/// Source/session/transcript fallback from TS `memory-search.ts:2003`.
pub fn source_chunk_vector_fallbacks(
    conn: &Connection,
    query_vec: Option<&[f32]>,
    existing_source_ids: &HashSet<String>,
    limit: usize,
    agent_id: &str,
    project: Option<&str>,
) -> Vec<SourceFallbackHit> {
    let Some(query_vec) = query_vec else {
        return Vec::new();
    };
    if limit == 0 || project.is_some() {
        return Vec::new();
    }
    let result = (|| -> Result<Vec<SourceFallbackHit>, rusqlite::Error> {
        let mut stmt = conn.prepare(
            "SELECT id, source_type, source_id, vector, chunk_text, created_at
             FROM embeddings
             WHERE source_type IN ('source_chunk', 'source_obsidian_chunk')
               AND vector IS NOT NULL AND agent_id = ?1",
        )?;
        let rows = stmt.query_map(params![agent_id], |row| {
            let id: String = row.get(0)?;
            let source_type: String = row.get(1)?;
            let source_id: String = row.get(2)?;
            let vector: Vec<u8> = row.get(3)?;
            let chunk_text: String = row.get(4)?;
            let created_at: String = row.get(5)?;
            let source_path = source_path_from_chunk_text(&chunk_text);
            let provider = source_id
                .split_once(':')
                .map(|(p, _)| p)
                .unwrap_or("source")
                .to_string();
            let source = if source_id.starts_with("obsidian:") {
                SearchSource::SourceObsidian
            } else {
                SearchSource::Source
            };
            Ok(SourceFallbackHit {
                id: format!("source-chunk:{id}"),
                content: format!("[Source chunk: {source_path}]\n{chunk_text}"),
                score: cosine_from_blob(query_vec, &vector),
                source,
                source_id: source_id.clone(),
                source_type: source_type.clone(),
                tags: format!("{provider},source,{source_type},vector"),
                importance: 0.6,
                who: provider,
                project: None,
                created_at,
                source_path,
            })
        })?;
        Ok(rows
            .filter_map(|r| r.ok())
            .filter(|h| h.score > 0.0 && !existing_source_ids.contains(&h.source_id))
            .collect())
    })();
    match result {
        Ok(mut rows) => {
            rows.sort_by(|a, b| {
                b.score
                    .partial_cmp(&a.score)
                    .unwrap_or(std::cmp::Ordering::Equal)
            });
            rows.truncate(limit);
            rows
        }
        Err(e) => {
            warn!(err = %e, "source chunk vector fallback failed");
            Vec::new()
        }
    }
}

pub fn native_artifact_fallbacks(
    conn: &Connection,
    query: &str,
    existing_source_ids: &HashSet<String>,
    limit: usize,
    agent_id: &str,
    project: Option<&str>,
) -> Vec<SourceFallbackHit> {
    let fts = sanitize_fts(query);
    if fts.is_empty() || limit == 0 {
        return Vec::new();
    }
    let mut sql = String::from(
        "SELECT ma.rowid, ma.source_path, ma.source_kind, ma.harness, ma.project,
                COALESCE(ma.updated_at, ma.captured_at) AS updated_at, ma.content,
                bm25(memory_artifacts_fts) AS rank
         FROM memory_artifacts_fts
         JOIN memory_artifacts ma ON ma.rowid = memory_artifacts_fts.rowid
         WHERE memory_artifacts_fts MATCH ?1
           AND ma.agent_id = ?2
           AND (ma.source_kind LIKE 'native_%' OR ma.source_kind LIKE 'source_%')
           AND COALESCE(ma.is_deleted, 0) = 0
           AND ma.source_node_id = 'memory-md-native-bridge'
           AND ma.harness IS NOT NULL",
    );
    let mut params: Vec<Box<dyn rusqlite::types::ToSql>> =
        vec![Box::new(fts), Box::new(agent_id.to_string())];
    if let Some(project) = project {
        sql.push_str(" AND (ma.project = ?3 OR ma.project IS NULL)");
        params.push(Box::new(project.to_string()));
    }
    let limit_param = params.len() + 1;
    sql.push_str(&format!(
        " ORDER BY rank ASC, updated_at DESC LIMIT ?{limit_param}"
    ));
    params.push(Box::new((limit.max(2).min(50)) as i64));
    let result = (|| -> Result<Vec<SourceFallbackHit>, rusqlite::Error> {
        let refs: Vec<&dyn rusqlite::types::ToSql> = params.iter().map(|b| b.as_ref()).collect();
        let mut stmt = conn.prepare(&sql)?;
        let rows: Vec<(
            i64,
            String,
            String,
            Option<String>,
            Option<String>,
            String,
            String,
            f64,
        )> = stmt
            .query_map(refs.as_slice(), |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                    row.get(7)?,
                ))
            })?
            .filter_map(|r| r.ok())
            .collect();
        let max_rank = rows.iter().map(|r| r.7.abs()).fold(1.0, f64::max);
        Ok(rows
            .into_iter()
            .filter_map(
                |(rowid, source_path, source_kind, harness, project, updated_at, content, rank)| {
                    let digest = blake3::hash(source_path.as_bytes()).to_hex()[..16].to_string();
                    let public_id = format!(
                        "native:{}:{}:{}",
                        harness.clone().unwrap_or_else(|| "unknown".to_string()),
                        source_kind,
                        digest
                    );
                    if existing_source_ids.contains(&public_id) || content.is_empty() {
                        return None;
                    }
                    let prefix = if harness.as_deref() == Some("obsidian") {
                        "[Obsidian vault note"
                    } else {
                        "[Native harness memory"
                    };
                    Some(SourceFallbackHit {
                        id: format!("native-artifact:{rowid}"),
                        content: format!("{prefix}: {source_path}]\n{content}"),
                        score: if max_rank > 0.0 {
                            (rank.abs() / max_rank).clamp(0.01, 1.1)
                        } else {
                            0.2
                        },
                        source: SearchSource::NativeArtifact,
                        source_id: public_id,
                        source_type: source_kind.clone(),
                        tags: format!(
                            "{},native-memory,{source_kind}",
                            harness.clone().unwrap_or_default()
                        ),
                        importance: 0.55,
                        who: harness.unwrap_or_default(),
                        project,
                        created_at: updated_at,
                        source_path,
                    })
                },
            )
            .collect())
    })();
    match result {
        Ok(mut rows) => {
            rows.sort_by(|a, b| {
                b.score
                    .partial_cmp(&a.score)
                    .unwrap_or(std::cmp::Ordering::Equal)
            });
            rows.truncate(limit);
            rows
        }
        Err(e) => {
            warn!(err = %e, "native artifact fallback failed");
            Vec::new()
        }
    }
}

// ---------------------------------------------------------------------------
// Post-processing boosts
// ---------------------------------------------------------------------------

/// Rehearsal boost: frequently-accessed memories with recency decay.
///
/// Boost = `weight * ln(access_count + 1) * 0.5^(days_since / half_life)`.
/// Multiplicative: `score *= (1 + boost)`.
pub fn apply_rehearsal_boost(
    conn: &Connection,
    scored: &mut [ScoredHit],
    weight: f64,
    half_life_days: f64,
) {
    if scored.is_empty() || weight <= 0.0 {
        return;
    }

    let ids: Vec<&str> = scored.iter().map(|s| s.id.as_str()).collect();
    let placeholders: String = ids
        .iter()
        .enumerate()
        .map(|(i, _)| format!("?{}", i + 1))
        .collect::<Vec<_>>()
        .join(",");

    let sql = format!(
        "SELECT id, access_count, last_accessed FROM memories WHERE id IN ({placeholders})"
    );

    let access: HashMap<String, (i64, Option<String>)> = match conn.prepare(&sql) {
        Ok(mut stmt) => {
            let refs: Vec<&dyn rusqlite::types::ToSql> = ids
                .iter()
                .map(|s| s as &dyn rusqlite::types::ToSql)
                .collect();
            stmt.query_map(refs.as_slice(), |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    (
                        row.get::<_, i64>(1).unwrap_or(0),
                        row.get::<_, Option<String>>(2)?,
                    ),
                ))
            })
            .ok()
            .map(|rows| rows.filter_map(|r| r.ok()).collect())
            .unwrap_or_default()
        }
        Err(e) => {
            warn!(err = %e, "rehearsal boost query failed");
            return;
        }
    };

    let now = chrono::Utc::now();
    for hit in scored.iter_mut() {
        if let Some((count, last)) = access.get(&hit.id) {
            if *count <= 0 {
                continue;
            }
            let days_since = last
                .as_deref()
                .and_then(|s| {
                    chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S")
                        .ok()
                        .or_else(|| {
                            chrono::DateTime::parse_from_rfc3339(s)
                                .ok()
                                .map(|dt| dt.naive_utc())
                        })
                })
                .map(|dt| (now.naive_utc() - dt).num_seconds() as f64 / 86_400.0)
                .unwrap_or(half_life_days);
            let recency = 0.5_f64.powf(days_since / half_life_days);
            let boost = weight * (*count as f64 + 1.0).ln() * recency;
            hit.score *= 1.0 + boost;
        }
    }

    scored.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
}

/// Graph boost: pull up memories linked via knowledge graph entities.
///
/// Additive blend: `score = (1 - weight) * score + weight`.
pub fn apply_graph_boost(scored: &mut [ScoredHit], linked_ids: &HashSet<String>, weight: f64) {
    if scored.is_empty() || linked_ids.is_empty() || weight <= 0.0 {
        return;
    }

    for hit in scored.iter_mut() {
        if linked_ids.contains(&hit.id) {
            hit.score = (1.0 - weight) * hit.score + weight;
        }
    }

    scored.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
}

// ---------------------------------------------------------------------------
// Access tracking
// ---------------------------------------------------------------------------

/// Bump access_count and last_accessed for recalled memory IDs.
pub fn touch_accessed(conn: &Connection, ids: &[&str]) {
    if ids.is_empty() {
        return;
    }

    let placeholders: String = ids
        .iter()
        .enumerate()
        .map(|(i, _)| format!("?{}", i + 1))
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "UPDATE memories SET last_accessed = datetime('now'), access_count = access_count + 1
         WHERE id IN ({placeholders})"
    );

    let refs: Vec<&dyn rusqlite::types::ToSql> = ids
        .iter()
        .map(|s| s as &dyn rusqlite::types::ToSql)
        .collect();

    if let Err(e) = conn.execute(&sql, refs.as_slice()) {
        warn!(err = %e, "failed to update access tracking");
    }
}

// ---------------------------------------------------------------------------
// High-level convenience function
// ---------------------------------------------------------------------------

/// Alpha-weighted hybrid search combining vector and keyword results.
///
/// This is a simpler interface that fetches full memory rows. For the full
/// recall pipeline with filters, boosts, and reranking, use the component
/// functions directly.
pub fn hybrid_search(conn: &Connection, opts: &SearchOptions) -> Result<Vec<SearchHit>, CoreError> {
    let alpha = opts.alpha;
    let min_score = opts.min_score;
    let top_k = opts.top_k;
    let limit = opts.limit;

    // Vector search
    let vec_results = match &opts.vector {
        Some(v) => vector_search(conn, v, top_k, opts.memory_type.as_deref()),
        None => Vec::new(),
    };

    // Keyword search
    let kw_results = keyword_search(conn, &opts.query, top_k);

    // Build score maps
    let vec_map: HashMap<&str, f64> = vec_results
        .iter()
        .map(|(id, s)| (id.as_str(), *s))
        .collect();
    let kw_map: HashMap<&str, f64> = kw_results.iter().map(|(id, s)| (id.as_str(), *s)).collect();

    // Merge all IDs
    let mut all_ids: Vec<&str> = Vec::new();
    for (id, _) in &vec_results {
        all_ids.push(id);
    }
    for (id, _) in &kw_results {
        if !vec_map.contains_key(id.as_str()) {
            all_ids.push(id);
        }
    }

    // Blend scores
    let mut scored: Vec<(&str, f64, SearchSource)> = Vec::new();
    for id in &all_ids {
        let vs = vec_map.get(id).copied().unwrap_or(0.0);
        let ks = kw_map.get(id).copied().unwrap_or(0.0);

        let (score, source) = if vs > 0.0 && ks > 0.0 {
            (alpha * vs + (1.0 - alpha) * ks, SearchSource::Hybrid)
        } else if vs > 0.0 {
            (vs, SearchSource::Vector)
        } else {
            (ks, SearchSource::Keyword)
        };

        if score >= min_score {
            scored.push((id, score, source));
        }
    }

    scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    scored.truncate(limit);

    if scored.is_empty() {
        return Ok(Vec::new());
    }

    // Fetch memory rows for top IDs
    let top_ids: Vec<&str> = scored.iter().map(|(id, _, _)| *id).collect();
    let placeholders: String = top_ids.iter().map(|_| "?").collect::<Vec<_>>().join(", ");

    let sql = format!(
        "SELECT id, content, type, tags, confidence FROM memories WHERE id IN ({placeholders})"
    );

    let mut stmt = conn.prepare(&sql)?;
    let sql_params: Vec<&dyn rusqlite::types::ToSql> = top_ids
        .iter()
        .map(|id| id as &dyn rusqlite::types::ToSql)
        .collect();

    let rows: HashMap<String, (String, String, Option<String>, f64)> = stmt
        .query_map(sql_params.as_slice(), |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, f64>(4)?,
            ))
        })?
        .filter_map(|r| r.ok())
        .map(|(id, content, typ, tags, conf)| (id, (content, typ, tags, conf)))
        .collect();

    let results = scored
        .iter()
        .filter_map(|(id, score, source)| {
            let (content, typ, tags, conf) = rows.get(*id)?;
            let parsed_tags: Vec<String> = tags
                .as_ref()
                .and_then(|t| serde_json::from_str(t).ok())
                .unwrap_or_default();

            Some(SearchHit {
                id: id.to_string(),
                content: content.clone(),
                score: (score * 100.0).round() / 100.0,
                memory_type: typ.clone(),
                source: *source,
                tags: parsed_tags,
                confidence: *conf,
            })
        })
        .collect();

    Ok(results)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> Connection {
        crate::db::register_vec_extension();
        let conn = Connection::open_in_memory().unwrap();
        crate::db::configure_pragmas_pub(&conn).unwrap();
        crate::migrations::run(&conn).unwrap();
        crate::db::ensure_fts_pub(&conn).unwrap();
        crate::db::ensure_vec_table_pub(&conn).unwrap();
        conn
    }

    fn insert_memory(conn: &Connection, id: &str, content: &str, mem_type: &str) {
        insert_memory_scoped(conn, id, content, mem_type, "default", "global", None);
    }

    fn insert_memory_scoped(
        conn: &Connection,
        id: &str,
        content: &str,
        mem_type: &str,
        agent_id: &str,
        visibility: &str,
        scope: Option<&str>,
    ) {
        conn.execute(
            "INSERT INTO memories (id, content, type, created_at, updated_at, updated_by, importance, agent_id, visibility, scope)
             VALUES (?1, ?2, ?3, datetime('now'), datetime('now'), 'test', 0.5, ?4, ?5, ?6)",
            params![id, content, mem_type, agent_id, visibility, scope],
        )
        .unwrap();
    }

    #[test]
    fn sanitize_fts_basic() {
        assert_eq!(sanitize_fts("hello world"), "\"hello\" \"world\"");
        assert_eq!(sanitize_fts("col:term"), "\"colterm\"");
        assert_eq!(sanitize_fts("OR"), "OR");
        assert_eq!(sanitize_fts(""), "");
        assert_eq!(sanitize_fts("he*llo"), "\"hello\"");
        assert_eq!(sanitize_fts("rust OR python"), "\"rust\" OR \"python\"");
    }

    #[test]
    fn fts_search_basic() {
        let conn = setup();
        insert_memory(
            &conn,
            "m1",
            "Rust is a systems programming language",
            "fact",
        );
        insert_memory(&conn, "m2", "Python is great for data science", "fact");
        insert_memory(&conn, "m3", "Rust has zero-cost abstractions", "fact");

        let results = fts_search(&conn, "Rust programming", 10, &RecallFilter::default()).unwrap();
        assert!(!results.is_empty());
        let ids: Vec<&str> = results.iter().map(|r| r.id.as_str()).collect();
        assert!(ids.contains(&"m1") || ids.contains(&"m3"));
    }

    #[test]
    fn fts_search_with_filter() {
        let conn = setup();
        insert_memory(&conn, "m1", "Rust systems programming", "fact");
        insert_memory(&conn, "m2", "Rust web development", "preference");

        let filter = RecallFilter {
            memory_type: Some("preference"),
            ..Default::default()
        };
        let results = fts_search(&conn, "Rust", 10, &filter).unwrap();
        // Should only return m2
        assert!(results.iter().all(|r| r.id != "m1"));
    }

    #[test]
    fn merge_scores_alpha() {
        let fts = vec![
            ScoredHit {
                id: "a".into(),
                score: 0.8,
                source: SearchSource::Keyword,
            },
            ScoredHit {
                id: "b".into(),
                score: 0.5,
                source: SearchSource::Keyword,
            },
        ];
        let vec = vec![
            ScoredHit {
                id: "a".into(),
                score: 0.6,
                source: SearchSource::Vector,
            },
            ScoredHit {
                id: "c".into(),
                score: 0.9,
                source: SearchSource::Vector,
            },
        ];

        let merged = merge_scores(&fts, &vec, 0.5, 0.1);

        let a = merged.iter().find(|h| h.id == "a").unwrap();
        assert!((a.score - 0.7).abs() < 0.001); // 0.5*0.6 + 0.5*0.8
        assert_eq!(a.source, SearchSource::Hybrid);

        let c = merged.iter().find(|h| h.id == "c").unwrap();
        assert!((c.score - 0.9).abs() < 0.001);
        assert_eq!(c.source, SearchSource::Vector);

        let b = merged.iter().find(|h| h.id == "b").unwrap();
        assert!((b.score - 0.5).abs() < 0.001);
        assert_eq!(b.source, SearchSource::Keyword);

        // Sorted desc
        assert!(merged[0].score >= merged[1].score);
    }

    #[test]
    fn merge_scores_min_filter() {
        let fts = vec![ScoredHit {
            id: "low".into(),
            score: 0.05,
            source: SearchSource::Keyword,
        }];
        let merged = merge_scores(&fts, &[], 0.5, 0.1);
        assert!(merged.is_empty()); // Below min_score
    }

    #[test]
    fn graph_boost_applies() {
        let mut scored = vec![
            ScoredHit {
                id: "a".into(),
                score: 0.5,
                source: SearchSource::Keyword,
            },
            ScoredHit {
                id: "b".into(),
                score: 0.8,
                source: SearchSource::Vector,
            },
        ];

        let linked: HashSet<String> = ["a".to_string()].into();
        apply_graph_boost(&mut scored, &linked, 0.15);

        let a = scored.iter().find(|h| h.id == "a").unwrap();
        assert!((a.score - 0.575).abs() < 0.001); // (1-0.15)*0.5 + 0.15

        let b = scored.iter().find(|h| h.id == "b").unwrap();
        assert!((b.score - 0.8).abs() < 0.001); // Unchanged
    }

    #[test]
    fn authorize_candidates_blocks_cross_agent_before_touch() {
        let conn = setup();
        insert_memory_scoped(
            &conn,
            "allowed",
            "apollo scoped fact",
            "fact",
            "agent-a",
            "private",
            None,
        );
        insert_memory_scoped(
            &conn,
            "blocked",
            "apollo secret fact",
            "fact",
            "agent-b",
            "private",
            None,
        );
        let scored = vec![
            ScoredHit {
                id: "allowed".into(),
                score: 0.9,
                source: SearchSource::Keyword,
            },
            ScoredHit {
                id: "blocked".into(),
                score: 1.0,
                source: SearchSource::Traversal,
            },
        ];
        let filter = RecallFilter {
            agent_id: Some("agent-a"),
            read_policy: Some("isolated"),
            ..Default::default()
        };

        let authorized = authorize_scored_candidates(&conn, &scored, &filter);
        assert_eq!(
            authorized.iter().map(|h| h.id.as_str()).collect::<Vec<_>>(),
            vec!["allowed"]
        );
        let ids: Vec<&str> = authorized.iter().map(|h| h.id.as_str()).collect();
        touch_accessed(&conn, &ids);

        let blocked_count: i64 = conn
            .query_row(
                "SELECT access_count FROM memories WHERE id = 'blocked'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let allowed_count: i64 = conn
            .query_row(
                "SELECT access_count FROM memories WHERE id = 'allowed'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(blocked_count, 0);
        assert_eq!(allowed_count, 1);
    }

    #[test]
    fn normal_recall_without_temporal_intent_does_not_get_temporal_boost() {
        let conn = setup();
        insert_memory(&conn, "keyword", "apollo direct keyword", "fact");
        insert_memory(&conn, "temporal", "apollo temporal edge", "fact");
        conn.execute(
            "INSERT INTO temporal_edges (id, agent_id, subject_type, subject_id, facet, start_at, confidence, created_at, updated_at)
             VALUES ('te-normal-gate', 'default', 'memory', 'temporal', 'observed', '2026-06-01T00:00:00Z', 0.95, datetime('now'), datetime('now'))",
            [],
        )
        .unwrap();
        let filter = RecallFilter {
            agent_id: Some("default"),
            read_policy: Some("shared"),
            ..Default::default()
        };
        let keyword_hits = vec![
            ScoredHit {
                id: "keyword".to_string(),
                score: 0.7,
                source: SearchSource::Keyword,
            },
            ScoredHit {
                id: "temporal".to_string(),
                score: 0.2,
                source: SearchSource::Keyword,
            },
        ];

        let normal_temporal = temporal_candidates_for_recall(&conn, 10, &filter, 0.1, false);
        let mut normal =
            merge_recall_candidates(&keyword_hits, &[], &[], &[], &normal_temporal, 0.5, 0.1);
        normal.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap());

        assert!(normal_temporal.is_empty());
        assert_eq!(normal.first().unwrap().id, "keyword");
        assert_eq!(
            normal.iter().find(|h| h.id == "temporal").unwrap().source,
            SearchSource::Keyword
        );

        let temporal_intent = temporal_candidates_for_recall(&conn, 10, &filter, 0.1, true);
        let mut boosted =
            merge_recall_candidates(&keyword_hits, &[], &[], &[], &temporal_intent, 0.5, 0.1);
        boosted.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap());

        assert_eq!(boosted.first().unwrap().id, "temporal");
        assert!(matches!(
            boosted.first().unwrap().source,
            SearchSource::TemporalHybrid
        ));
    }

    #[test]
    fn temporal_and_traversal_candidates_can_be_primary_then_topic_scored() {
        let conn = setup();
        insert_memory(&conn, "flat", "apollo keyword direct", "fact");
        insert_memory(
            &conn,
            "temporal",
            "apollo launch window was updated",
            "fact",
        );
        insert_memory(
            &conn,
            "graph",
            "launch checklist without surface token",
            "decision",
        );
        conn.execute(
            "INSERT INTO temporal_edges (id, agent_id, subject_type, subject_id, facet, start_at, confidence, created_at, updated_at)
             VALUES ('te1', 'default', 'memory', 'temporal', 'observed', '2026-06-01T00:00:00Z', 0.6, datetime('now'), datetime('now'))",
            [],
        ).unwrap();
        conn.execute(
            "INSERT INTO entities (id, name, entity_type, created_at, updated_at, agent_id)
             VALUES ('e1', 'apollo', 'topic', datetime('now'), datetime('now'), 'default')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO memory_entity_mentions (memory_id, entity_id) VALUES ('graph', 'e1')",
            [],
        )
        .unwrap();
        let filter = RecallFilter {
            agent_id: Some("default"),
            read_policy: Some("shared"),
            ..Default::default()
        };

        let flat = merge_recall_candidates(
            &fts_search(&conn, "apollo", 10, &filter).unwrap(),
            &[],
            &[],
            &[],
            &temporal_candidates(&conn, 10, &filter, 0.1),
            0.5,
            0.1,
        );
        let traversal = traversal_primary_candidates(&conn, "apollo", 10, &filter, 0.1);
        let mut fused = authorize_scored_candidates(
            &conn,
            &fuse_traversal_primary(&flat, &traversal, 5, 10),
            &filter,
        );
        apply_temporal_topic_evidence(&conn, &mut fused, "apollo launch");
        fused.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap());
        let ids: Vec<&str> = fused.iter().map(|h| h.id.as_str()).collect();

        assert!(ids.contains(&"temporal"));
        assert!(ids.contains(&"graph"));
        assert!(fused.iter().find(|h| h.id == "temporal").unwrap().score >= 0.85);
    }

    #[test]
    fn sec_dampening_and_currentness_change_ordering() {
        let conn = setup();
        insert_memory(
            &conn,
            "semantic_noise",
            "unrelated oranges and pears",
            "fact",
        );
        insert_memory(
            &conn,
            "decision",
            "apollo decision with concrete action",
            "decision",
        );
        insert_memory(&conn, "superseded", "apollo old endpoint", "fact");
        conn.execute(
            "INSERT INTO entity_attributes (id, agent_id, memory_id, kind, content, normalized_content, importance, status, created_at, updated_at)
             VALUES ('ea1', 'default', 'superseded', 'fact', 'old endpoint', 'old endpoint', 0.9, 'superseded', datetime('now'), datetime('now'))",
            [],
        ).unwrap();
        let mut scored = vec![
            ScoredHit {
                id: "semantic_noise".into(),
                score: 0.8,
                source: SearchSource::Vector,
            },
            ScoredHit {
                id: "decision".into(),
                score: 0.62,
                source: SearchSource::Keyword,
            },
            ScoredHit {
                id: "superseded".into(),
                score: 0.7,
                source: SearchSource::Keyword,
            },
        ];
        let fts = vec![
            ScoredHit {
                id: "decision".into(),
                score: 0.62,
                source: SearchSource::Keyword,
            },
            ScoredHit {
                id: "superseded".into(),
                score: 0.7,
                source: SearchSource::Keyword,
            },
        ];
        let vec_hits = vec![ScoredHit {
            id: "semantic_noise".into(),
            score: 0.8,
            source: SearchSource::Vector,
        }];
        let structured = vec![ScoredHit {
            id: "decision".into(),
            score: 0.9,
            source: SearchSource::Structured,
        }];
        apply_sec_lite(&mut scored, &fts, &[], &vec_hits, &structured, &[], 0.1);
        apply_dampening(&conn, &mut scored, "apollo decision");
        let ids: Vec<&str> = scored.iter().map(|h| h.id.as_str()).collect();
        let currentness = load_currentness_info(&conn, &ids, "default");
        apply_currentness_bias(&mut scored, &currentness);

        assert_eq!(scored.first().unwrap().id, "decision");
        assert!(
            scored
                .iter()
                .find(|h| h.id == "semantic_noise")
                .unwrap()
                .score
                < 0.8
        );
        assert!(scored.iter().find(|h| h.id == "superseded").unwrap().score < 0.7);
    }

    #[test]
    fn source_chunk_fallback_returns_scoped_supplementary_candidate() {
        let conn = setup();
        let vector: Vec<f32> = vec![1.0, 0.0, 0.0, 0.0];
        let blob: Vec<u8> = vector.iter().flat_map(|f| f.to_le_bytes()).collect();
        conn.execute(
            "INSERT INTO embeddings (id, content_hash, vector, dimensions, source_type, source_id, chunk_text, created_at, agent_id)
             VALUES ('emb-source', 'hash-source', ?1, 4, 'source_chunk', 'obsidian:vault:note', 'source_path: note.md\napollo source content', datetime('now'), 'agent-a')",
            params![blob],
        ).unwrap();

        let hits = source_chunk_vector_fallbacks(
            &conn,
            Some(&vector),
            &HashSet::new(),
            5,
            "agent-a",
            None,
        );
        let blocked = source_chunk_vector_fallbacks(
            &conn,
            Some(&vector),
            &HashSet::new(),
            5,
            "agent-b",
            None,
        );

        assert_eq!(hits.len(), 1);
        assert!(hits[0].id.starts_with("source-chunk:"));
        assert!(hits[0].content.contains("apollo source content"));
        assert!(blocked.is_empty());
    }

    #[test]
    fn source_chunk_fallback_returns_obsidian_source_key_and_label() {
        let conn = setup();
        let vector: Vec<f32> = vec![1.0, 0.0, 0.0, 0.0];
        let blob: Vec<u8> = vector.iter().flat_map(|f| f.to_le_bytes()).collect();
        conn.execute(
            "INSERT INTO embeddings (id, content_hash, vector, dimensions, source_type, source_id, chunk_text, created_at, agent_id)
             VALUES ('emb-obsidian', 'hash-obsidian', ?1, 4, 'source_obsidian_chunk', 'obsidian:vault:note', 'source_path: vault/note.md\napollo obsidian source content', datetime('now'), 'agent-a')",
            params![blob],
        )
        .unwrap();

        let hits = source_chunk_vector_fallbacks(
            &conn,
            Some(&vector),
            &HashSet::new(),
            5,
            "agent-a",
            None,
        );

        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].source_type, "source_obsidian_chunk");
        assert_eq!(hits[0].source.as_str(), "source_obsidian");
        assert!(hits[0].tags.contains("source_obsidian_chunk"));
    }

    #[test]
    fn vec_search_with_embeddings() {
        let conn = setup();
        insert_memory(&conn, "m1", "Rust programming", "fact");

        // Insert embedding for m1
        let vec_data: Vec<f32> = (0..768).map(|i| (i as f32) / 768.0).collect();
        let emb = crate::queries::embedding::InsertEmbedding {
            id: "e1",
            content_hash: "hash1",
            vector: &vec_data,
            source_type: "memory",
            source_id: "m1",
            chunk_text: "Rust programming",
            now: "2024-01-01T00:00:00Z",
            agent_id: Some("default"),
        };
        crate::queries::embedding::upsert(&conn, &emb).unwrap();

        // Search with a very similar vector
        let query: Vec<f32> = (0..768).map(|i| (i as f32) / 768.0 + 0.001).collect();
        let results = vector_search(&conn, &query, 10, None);

        assert!(!results.is_empty());
        assert_eq!(results[0].0, "m1");
        assert!(results[0].1 > 0.9);
    }
}
