//! Shadow decision engine for extraction Phase B.
//!
//! Evaluates extracted facts against existing memories using hybrid
//! (BM25 + vector) search, then asks the LLM whether to add/update/delete/skip.
//! All decisions are proposals -- logged to memory_history but never
//! mutating memory content directly.

use std::collections::{HashMap, HashSet};

use tracing::debug;

use signet_core::db::DbPool;
use signet_core::types::{DecisionAction, DecisionProposal, DecisionResult};

use crate::extraction::ExtractedFact;
use crate::provider::{GenerateOpts, LlmProvider};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CANDIDATE_LIMIT: usize = 5;
const VECTOR_OVERFETCH_MULTIPLIER: usize = 2;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

struct CandidateMemory {
    id: String,
    content: String,
    memory_type: String,
}

struct DecisionScope {
    agent_id: String,
    scope: Option<String>,
    visibility: String,
}

/// Configuration for the decision engine.
#[derive(Debug, Clone)]
pub struct DecisionConfig {
    pub alpha: f64,
    pub min_score: f64,
    pub timeout_ms: u64,
}

// ---------------------------------------------------------------------------
// BM25 candidate retrieval
// ---------------------------------------------------------------------------

fn find_candidates_bm25(
    conn: &rusqlite::Connection,
    query: &str,
    limit: usize,
    scope: &DecisionScope,
) -> HashMap<String, f64> {
    let mut map = HashMap::new();
    let fts_query = build_fts_match_query(query);
    if fts_query.is_empty() {
        return map;
    }

    let scope_clause = if scope.scope.is_some() {
        "AND m.scope = ?"
    } else {
        "AND m.scope IS NULL"
    };

    let sql = format!(
        "SELECT m.id, bm25(memories_fts) AS raw_score
         FROM memories_fts
         JOIN memories m ON memories_fts.rowid = m.rowid
         WHERE memories_fts MATCH ?
           AND m.agent_id = ?
           AND m.visibility = ?
           {scope_clause}
         ORDER BY raw_score
         LIMIT ?"
    );

    let mut stmt = match conn.prepare_cached(&sql) {
        Ok(s) => s,
        Err(_) => return map,
    };

    let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = vec![
        Box::new(fts_query),
        Box::new(scope.agent_id.clone()),
        Box::new(scope.visibility.clone()),
    ];
    if let Some(ref s) = scope.scope {
        params.push(Box::new(s.clone()));
    }
    params.push(Box::new(limit));
    let param_refs: Vec<&dyn rusqlite::types::ToSql> = params.iter().map(|p| p.as_ref()).collect();

    let rows_result = stmt.query_map(param_refs.as_slice(), |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, f64>(1)?))
    });

    if let Ok(rows) = rows_result {
        for row in rows.flatten() {
            let score = 1.0 / (1.0 + row.1.abs());
            map.insert(row.0, score);
        }
    }

    map
}

/// Build an FTS5-safe match query. Returns empty string if nothing usable.
fn build_fts_match_query(query: &str) -> String {
    let tokens: Vec<&str> = query
        .split_whitespace()
        .filter(|t| t.len() >= 2)
        .take(10)
        .collect();
    if tokens.is_empty() {
        return String::new();
    }
    // OR-based match for broader recall
    tokens
        .iter()
        .map(|t| format!("\"{}\"*", t.replace('"', "")))
        .collect::<Vec<_>>()
        .join(" OR ")
}

// ---------------------------------------------------------------------------
// Vector candidate retrieval
// ---------------------------------------------------------------------------

fn find_candidates_vector(
    conn: &rusqlite::Connection,
    query_vec_blob: &[u8],
    limit: usize,
    scope: &DecisionScope,
) -> HashMap<String, f64> {
    let mut map = HashMap::new();
    let vector_limit = if scope.scope.is_some() || scope.visibility != "global" {
        limit * VECTOR_OVERFETCH_MULTIPLIER
    } else {
        limit
    };

    let scope_clause = if scope.scope.is_some() {
        "AND m.scope = ?"
    } else {
        "AND m.scope IS NULL"
    };

    let sql = format!(
        "SELECT e.source_id AS id, v.distance
         FROM vec_embeddings v
         JOIN embeddings e ON v.id = e.id
         JOIN memories m ON e.source_id = m.id
         WHERE v.embedding MATCH ? AND k = ?
           AND m.agent_id = ?
           AND m.visibility = ?
           {scope_clause}
           AND m.is_deleted = 0
         ORDER BY v.distance"
    );

    let mut stmt = match conn.prepare_cached(&sql) {
        Ok(s) => s,
        Err(_) => return map,
    };

    // Build param list dynamically to avoid closure type mismatch
    let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = vec![
        Box::new(query_vec_blob.to_vec()),
        Box::new(vector_limit),
        Box::new(scope.agent_id.clone()),
        Box::new(scope.visibility.clone()),
    ];
    if let Some(ref s) = scope.scope {
        params.push(Box::new(s.clone()));
    }
    let param_refs: Vec<&dyn rusqlite::types::ToSql> = params.iter().map(|p| p.as_ref()).collect();

    let rows_result = stmt.query_map(param_refs.as_slice(), |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, f64>(1)?))
    });

    if let Ok(rows) = rows_result {
        for row in rows.flatten() {
            let score: f64 = (1.0_f64 - row.1).max(0.0_f64);
            map.insert(row.0, score);
        }
    }

    map
}

/// Serialize an f32 vector into a byte blob for sqlite-vec.
fn vec_to_blob(v: &[f32]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(v.len() * 4);
    for f in v {
        bytes.extend_from_slice(&f.to_le_bytes());
    }
    bytes
}

// ---------------------------------------------------------------------------
// Fetch full memory rows
// ---------------------------------------------------------------------------

fn fetch_memory_rows(
    conn: &rusqlite::Connection,
    ids: &[String],
    scope: &DecisionScope,
) -> Vec<CandidateMemory> {
    if ids.is_empty() {
        return vec![];
    }

    let placeholders: Vec<&str> = ids.iter().map(|_| "?").collect();
    let scope_clause = if scope.scope.is_some() {
        "AND scope = ?"
    } else {
        "AND scope IS NULL"
    };
    let sql = format!(
        "SELECT id, content, type, importance
         FROM memories
         WHERE id IN ({}) AND is_deleted = 0
           AND agent_id = ?
           AND visibility = ?
           {scope_clause}",
        placeholders.join(", ")
    );

    let mut stmt = match conn.prepare_cached(&sql) {
        Ok(s) => s,
        Err(_) => return vec![],
    };

    let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
    for id in ids {
        params.push(Box::new(id.clone()));
    }
    params.push(Box::new(scope.agent_id.clone()));
    params.push(Box::new(scope.visibility.clone()));
    if let Some(ref s) = scope.scope {
        params.push(Box::new(s.clone()));
    }

    let param_refs: Vec<&dyn rusqlite::types::ToSql> = params.iter().map(|p| p.as_ref()).collect();

    let rows = stmt.query_map(param_refs.as_slice(), |row| {
        Ok(CandidateMemory {
            id: row.get(0)?,
            content: row.get(1)?,
            memory_type: row.get(2)?,
        })
    });

    rows.map(|r| r.flatten().collect()).unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Hybrid candidate search
// ---------------------------------------------------------------------------

async fn find_candidates(
    pool: &DbPool,
    query: &str,
    cfg: &DecisionConfig,
    scope: &DecisionScope,
    precomputed_embedding: Option<Vec<f32>>,
) -> Vec<CandidateMemory> {
    let query_owned = query.to_string();
    let alpha = cfg.alpha;
    let min_score = cfg.min_score;

    let scope_clone = DecisionScope {
        agent_id: scope.agent_id.clone(),
        scope: scope.scope.clone(),
        visibility: scope.visibility.clone(),
    };

    let embedding_blob = precomputed_embedding.map(|v| vec_to_blob(&v));

    pool.read(move |conn| {
        let fetch_limit = CANDIDATE_LIMIT * 2;

        let bm25_map = find_candidates_bm25(conn, &query_owned, fetch_limit, &scope_clone);

        let vector_map = if let Some(ref blob) = embedding_blob {
            find_candidates_vector(conn, blob, fetch_limit, &scope_clone)
        } else {
            HashMap::new()
        };

        // Combine scores
        let all_ids: HashSet<&String> = bm25_map.keys().chain(vector_map.keys()).collect();

        let mut scored: Vec<(&String, f64)> = all_ids
            .iter()
            .filter_map(|id| {
                let bm25 = bm25_map.get(*id).copied().unwrap_or(0.0);
                let vec_score = vector_map.get(*id).copied().unwrap_or(0.0);

                let score = if bm25 > 0.0 && vec_score > 0.0 {
                    alpha * vec_score + (1.0 - alpha) * bm25
                } else if vec_score > 0.0 {
                    vec_score
                } else {
                    bm25
                };

                if score >= min_score {
                    Some((*id, score))
                } else {
                    None
                }
            })
            .collect();

        scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        let top_ids: Vec<String> = scored
            .into_iter()
            .take(CANDIDATE_LIMIT)
            .map(|(id, _)| (*id).clone())
            .collect();

        Ok(fetch_memory_rows(conn, &top_ids, &scope_clone))
    })
    .await
    .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Decision prompt
// ---------------------------------------------------------------------------

fn build_decision_prompt(fact: &ExtractedFact, candidates: &[CandidateMemory]) -> String {
    let candidate_block = candidates
        .iter()
        .enumerate()
        .map(|(i, c)| {
            format!(
                "[{}] ID: {}\n    Type: {}\n    Content: {}",
                i + 1,
                c.id,
                c.memory_type,
                c.content
            )
        })
        .collect::<Vec<_>>()
        .join("\n\n");

    format!(
        r#"You are a memory management system. Given a new fact and existing memory candidates, decide the best action.

New fact (type: {}, confidence: {:.2}):
"{}"

Existing candidates:
{}

Actions:
- "add": New fact has no good match, should be stored as new memory
- "update": New fact supersedes or refines an existing candidate (specify targetId). Ensure the merged result is self-contained
- "delete": New fact contradicts/invalidates a candidate (specify targetId)
- "none": Fact is already covered by existing memories, skip

Return a JSON object:
{{"action": "add|update|delete|none", "targetId": "candidate-id-if-applicable", "confidence": 0.0-1.0, "reason": "brief explanation"}}

Return ONLY the JSON, no other text."#,
        fact.fact_type, fact.confidence, fact.content, candidate_block
    )
}

// ---------------------------------------------------------------------------
// Decision parsing
// ---------------------------------------------------------------------------

const VALID_ACTIONS: &[&str] = &["add", "update", "delete", "none"];

fn parse_decision(
    raw: &str,
    candidate_ids: &HashSet<String>,
    warnings: &mut Vec<String>,
) -> Option<(DecisionAction, Option<String>, f64, String)> {
    // Strip think blocks from models that use chain-of-thought
    let stripped = strip_think_blocks(raw);
    let json_str = stripped
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();

    let parsed: serde_json::Value = match serde_json::from_str(json_str) {
        Ok(v) => v,
        Err(_) => {
            // Try extracting embedded JSON object
            if let Some(json) = extract_json_object(json_str) {
                match serde_json::from_str(&json) {
                    Ok(v) => v,
                    Err(_) => {
                        warnings.push("Failed to parse decision JSON".into());
                        return None;
                    }
                }
            } else {
                warnings.push("Failed to parse decision JSON".into());
                return None;
            }
        }
    };

    let obj = match parsed.as_object() {
        Some(o) => o,
        None => {
            warnings.push("Decision is not an object".into());
            return None;
        }
    };

    let action_str = obj.get("action").and_then(|v| v.as_str()).unwrap_or("");
    if !VALID_ACTIONS.contains(&action_str) {
        warnings.push(format!("Invalid action: \"{action_str}\""));
        return None;
    }

    let target_id = obj
        .get("targetId")
        .and_then(|v| v.as_str())
        .map(String::from);

    // update/delete MUST reference a valid candidate
    if action_str == "update" || action_str == "delete" {
        if target_id.is_none() {
            warnings.push(format!("{action_str} decision missing targetId"));
            return None;
        }
        if let Some(ref tid) = target_id {
            if !candidate_ids.contains(tid) {
                warnings.push(format!("Decision references non-candidate ID: \"{tid}\""));
                return None;
            }
        }
    }

    let reason = obj
        .get("reason")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if reason.is_empty() {
        warnings.push("Decision missing reason".into());
        return None;
    }

    let raw_conf = obj
        .get("confidence")
        .and_then(|v| v.as_f64())
        .unwrap_or(0.5);
    let confidence = raw_conf.clamp(0.0, 1.0);

    let action = match action_str {
        "add" => DecisionAction::Add,
        "update" => DecisionAction::Update,
        "delete" => DecisionAction::Delete,
        _ => DecisionAction::None,
    };

    Some((action, target_id, confidence, reason))
}

/// Strip `<think...</think | >` blocks used by models like qwen3.
fn strip_think_blocks(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let bytes = s.as_bytes();
    let open_tag = "<think";
    let close_tag = "</think|>";
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i..].starts_with(open_tag.as_bytes()) {
            // Skip to the closing tag
            if let Some(end) = bytes[i..]
                .windows(close_tag.len())
                .position(|w| w == close_tag.as_bytes())
            {
                i += end + close_tag.len();
                continue;
            }
        }
        out.push(bytes[i] as char);
        i += 1;
    }
    out
}

fn extract_json_object(s: &str) -> Option<String> {
    let start = s.find('{')?;
    let bytes = s.as_bytes();
    let mut depth = 0i32;
    let mut in_string = false;
    let mut escaped = false;

    for (i, &b) in bytes[start..].iter().enumerate() {
        if escaped {
            escaped = false;
            continue;
        }
        match b {
            b'\\' if in_string => escaped = true,
            b'"' => in_string = !in_string,
            b'{' if !in_string => depth += 1,
            b'}' if !in_string => {
                depth -= 1;
                if depth == 0 {
                    return Some(s[start..start + i + 1].to_string());
                }
            }
            _ => {}
        }
    }

    None
}

// ---------------------------------------------------------------------------
// Main decision function
// ---------------------------------------------------------------------------

/// Run shadow decisions on extracted facts against existing memories.
///
/// For each fact, retrieves candidate memories via hybrid search, then asks
/// the LLM to decide whether to add/update/delete/skip. Returns proposals
/// without mutating any memory content.
///
/// `precomputed_embeddings` is an optional map from fact content hash to
/// its pre-computed embedding vector. If missing for a fact, only BM25
/// search is used for candidate retrieval.
pub async fn run_shadow_decisions(
    facts: &[ExtractedFact],
    pool: &DbPool,
    provider: &dyn LlmProvider,
    cfg: &DecisionConfig,
    agent_id: &str,
    scope: Option<&str>,
    visibility: &str,
    precomputed_embeddings: &HashMap<String, Vec<f32>>,
) -> DecisionResult {
    let mut proposals = Vec::new();
    let mut warnings = Vec::new();

    let scope_struct = DecisionScope {
        agent_id: agent_id.to_string(),
        scope: scope.map(String::from),
        visibility: visibility.to_string(),
    };

    for fact in facts {
        // Look up pre-computed embedding for this fact
        let embedding = precomputed_embeddings.get(&fact.content).cloned();

        let candidates = find_candidates(pool, &fact.content, cfg, &scope_struct, embedding).await;

        // No candidates -> propose ADD
        if candidates.is_empty() {
            proposals.push(DecisionProposal {
                action: DecisionAction::Add,
                target_memory_id: None,
                confidence: fact.confidence,
                reason: "No existing memories match this fact".into(),
            });
            continue;
        }

        let candidate_ids: HashSet<String> = candidates.iter().map(|c| c.id.clone()).collect();
        let prompt = build_decision_prompt(fact, &candidates);

        let opts = GenerateOpts {
            timeout_ms: Some(cfg.timeout_ms),
            max_tokens: Some(512),
        };

        match provider.generate(&prompt, &opts).await {
            Ok(output) => {
                if let Some((action, target_memory_id, confidence, reason)) =
                    parse_decision(&output.text, &candidate_ids, &mut warnings)
                {
                    proposals.push(DecisionProposal {
                        action,
                        target_memory_id,
                        confidence,
                        reason,
                    });
                }
            }
            Err(e) => {
                warnings.push(format!("Decision LLM error for fact: {e}"));
            }
        }
    }

    debug!(
        proposal_count = proposals.len(),
        warning_count = warnings.len(),
        "Shadow decisions complete"
    );

    DecisionResult {
        proposals,
        warnings,
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_valid_decision() {
        let raw = r#"{"action": "add", "confidence": 0.85, "reason": "No similar memories exist"}"#;
        let mut warnings = vec![];
        let result = parse_decision(raw, &HashSet::new(), &mut warnings);
        assert!(result.is_some());
        let (action, target_id, confidence, reason) = result.unwrap();
        assert_eq!(action, DecisionAction::Add);
        assert!(target_id.is_none());
        assert!((confidence - 0.85).abs() < f64::EPSILON);
        assert_eq!(reason, "No similar memories exist");
    }

    #[test]
    fn parse_update_with_valid_target() {
        let raw = r#"{"action": "update", "targetId": "mem-123", "confidence": 0.9, "reason": "Supersedes old info"}"#;
        let mut warnings = vec![];
        let candidates: HashSet<String> = ["mem-123".to_string()].into_iter().collect();
        let result = parse_decision(raw, &candidates, &mut warnings);
        assert!(result.is_some());
        let (action, target_id, _, _) = result.unwrap();
        assert_eq!(action, DecisionAction::Update);
        assert_eq!(target_id.as_deref(), Some("mem-123"));
    }

    #[test]
    fn parse_update_rejects_invalid_target() {
        let raw = r#"{"action": "update", "targetId": "nonexistent", "confidence": 0.9, "reason": "Bad target"}"#;
        let mut warnings = vec![];
        let candidates: HashSet<String> = ["mem-123".to_string()].into_iter().collect();
        let result = parse_decision(raw, &candidates, &mut warnings);
        assert!(result.is_none());
        assert!(warnings.iter().any(|w| w.contains("non-candidate")));
    }

    #[test]
    fn parse_rejects_invalid_action() {
        let raw = r#"{"action": "merge", "confidence": 0.5, "reason": "bad action"}"#;
        let mut warnings = vec![];
        let result = parse_decision(raw, &HashSet::new(), &mut warnings);
        assert!(result.is_none());
        assert!(warnings.iter().any(|w| w.contains("Invalid action")));
    }

    #[test]
    fn parse_rejects_missing_reason() {
        let raw = r#"{"action": "add", "confidence": 0.5}"#;
        let mut warnings = vec![];
        let result = parse_decision(raw, &HashSet::new(), &mut warnings);
        assert!(result.is_none());
        assert!(warnings.iter().any(|w| w.contains("missing reason")));
    }

    #[test]
    fn parse_with_think_block() {
        let raw = "<think\nLet me reason about this...\n</think|>\n{\"action\": \"none\", \"confidence\": 0.9, \"reason\": \"Already covered\"}";
        let mut warnings = vec![];
        let result = parse_decision(raw, &HashSet::new(), &mut warnings);
        assert!(result.is_some());
        let (action, _, _, _) = result.unwrap();
        assert_eq!(action, DecisionAction::None);
    }

    #[test]
    fn parse_with_code_fence() {
        let raw = "```json\n{\"action\": \"delete\", \"targetId\": \"m1\", \"confidence\": 0.8, \"reason\": \"Contradicts\"}\n```";
        let mut warnings = vec![];
        let candidates: HashSet<String> = ["m1".to_string()].into_iter().collect();
        let result = parse_decision(raw, &candidates, &mut warnings);
        assert!(result.is_some());
        let (action, _, _, _) = result.unwrap();
        assert_eq!(action, DecisionAction::Delete);
    }

    #[test]
    fn build_fts_match_query_returns_or_tokens() {
        let query = "The user prefers async await";
        let result = build_fts_match_query(query);
        assert!(result.contains("OR"));
        assert!(result.contains('"'));
    }

    #[test]
    fn build_fts_match_query_empty_for_short_tokens() {
        let query = "a b";
        let result = build_fts_match_query(query);
        assert!(result.is_empty());
    }

    #[test]
    fn extract_json_object_finds_balanced() {
        assert_eq!(
            extract_json_object(r#"prefix {"key": "value"} suffix"#),
            Some(r#"{"key": "value"}"#.to_string())
        );
        assert_eq!(
            extract_json_object(r#"{"nested": {"inner": 1}}"#),
            Some(r#"{"nested": {"inner": 1}}"#.to_string())
        );
        assert_eq!(extract_json_object("no json here"), None);
    }

    #[test]
    fn strip_think_blocks_removes_cot() {
        let input =
            "<think\nLet me analyze...\nStep 1: Check candidates\n</think|>\n{\"action\": \"add\"}";
        let stripped = strip_think_blocks(input);
        assert!(!stripped.contains("<think"));
        assert!(!stripped.contains("</think|>"));
        assert!(stripped.contains("{\"action\": \"add\"}"));
    }

    #[test]
    fn vec_to_blob_roundtrip() {
        let original = vec![0.1_f32, 0.2, 0.3, -0.5];
        let blob = vec_to_blob(&original);
        assert_eq!(blob.len(), 16); // 4 floats * 4 bytes

        // Decode back
        let decoded: Vec<f32> = blob
            .chunks_exact(4)
            .map(|chunk| f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
            .collect();
        assert_eq!(decoded.len(), original.len());
        for (a, b) in original.iter().zip(decoded.iter()) {
            assert!((a - b).abs() < f32::EPSILON);
        }
    }
}
