//! Hybrid recall search: FTS5 BM25 + sqlite-vec cosine KNN + alpha blending.
//!
//! Score formula: `score = alpha * vector + (1 - alpha) * keyword`
//!
//! Optional post-processing: rehearsal boost (access frequency + recency decay),
//! graph boost (knowledge-graph-linked memories), reranking.

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
}

impl SearchSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Vector => "vector",
            Self::Keyword => "keyword",
            Self::Hybrid => "hybrid",
            Self::Graph => "graph",
            Self::Traversal => "ka_traversal",
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
    let mut parts = Vec::new();
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
        conn.execute(
            "INSERT INTO memories (id, content, type, created_at, updated_at, updated_by, importance)
             VALUES (?1, ?2, ?3, datetime('now'), datetime('now'), 'test', 0.5)",
            params![id, content, mem_type],
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
