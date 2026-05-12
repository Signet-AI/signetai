//! Search and recall route handlers.

use std::net::SocketAddr;
use std::sync::Arc;

use axum::Json;
use axum::extract::{ConnectInfo, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use serde::{Deserialize, Serialize};
use tracing::warn;

use signet_core::search::{
    RecallFilter, fts_search, merge_scores, touch_accessed, vec_search_scored,
};

use crate::auth::middleware::{authenticate_headers, require_rate_limit_guard};
use crate::auth::types::AuthMode;
use crate::reranker;
use crate::routes::pipeline::is_loopback;
use crate::state::AppState;

// ---------------------------------------------------------------------------
// POST /api/memory/recall
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecallBody {
    pub query: String,
    pub keyword_query: Option<String>,
    pub limit: Option<usize>,
    pub agent_id: Option<String>,
    #[serde(rename = "type")]
    pub memory_type: Option<String>,
    pub tags: Option<String>,
    pub who: Option<String>,
    pub pinned: Option<bool>,
    pub importance_min: Option<f64>,
    pub since: Option<String>,
    pub until: Option<String>,
}

#[derive(Serialize)]
pub struct RecallResponse {
    pub results: Vec<RecallHit>,
    pub query: String,
    pub method: String,
}

#[derive(Clone, Serialize)]
pub struct RecallHit {
    pub id: String,
    pub content: String,
    pub content_length: usize,
    pub truncated: bool,
    pub score: f64,
    pub source: String,
    #[serde(rename = "type")]
    pub memory_type: String,
    pub tags: Option<String>,
    pub pinned: bool,
    pub importance: f64,
    pub who: Option<String>,
    pub project: Option<String>,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub supplementary: Option<bool>,
}

pub async fn recall(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<RecallBody>,
) -> impl IntoResponse {
    let query = body.query.trim().to_string();
    if query.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "query is required"})),
        )
            .into_response();
    }

    // Rate-limit LLM-enabled recall independently of plain recall.
    // Skipped in local auth mode; active in team/hybrid modes.
    {
        let (reranker_enabled, use_extraction_model) = state
            .config
            .manifest
            .memory
            .as_ref()
            .and_then(|m| m.pipeline_v2.as_ref())
            .map(|p| (p.reranker.enabled, p.reranker.use_extraction_model))
            .unwrap_or((false, false));
        if reranker_enabled && use_extraction_model && state.auth_mode != AuthMode::Local {
            // authenticate_headers returns Err only for hard auth failures; in local
            // mode we already returned above, so unwrap_or with unauthenticated is safe.
            let auth = authenticate_headers(
                state.auth_mode,
                state.auth_secret.as_deref(),
                &headers,
                is_loopback(&peer),
            )
            .unwrap_or_else(|_| crate::auth::middleware::AuthState {
                result: crate::auth::types::AuthResult::unauthenticated(),
            });
            if let Err(resp) = require_rate_limit_guard(
                &auth,
                "recallLlm",
                &state.recall_llm_limiter,
                state.auth_mode,
                None,
            ) {
                return (*resp).into_response();
            }
        }
    }

    let limit = body.limit.unwrap_or(10);
    let search_cfg = state.config.manifest.search.clone().unwrap_or_default();
    let alpha = search_cfg.alpha;
    let min_score = search_cfg.min_score;
    let top_k = search_cfg.top_k;
    let truncate = state
        .config
        .manifest
        .memory
        .as_ref()
        .and_then(|m| m.pipeline_v2.as_ref())
        .map(|p| p.guardrails.recall_truncate_chars)
        .unwrap_or(50_000);

    // Embed query if we have a provider
    let provider = state.embedding.read().await.clone();
    let query_vec = if let Some(provider) = provider {
        provider.embed(&query).await
    } else {
        None
    };
    let has_vec = query_vec.is_some();

    let keyword_query = body.keyword_query.unwrap_or_else(|| query.clone());
    let mem_type = body.memory_type.clone();
    let tags = body.tags.clone();
    let who = body.who.clone();
    let pinned = body.pinned;
    let importance_min = body.importance_min;
    let since = body.since.clone();
    let until = body.until.clone();
    let agent_id = body.agent_id.clone();
    let query_for_response = query.clone();

    let result = state
        .pool
        .read(move |conn| {
            let filter = RecallFilter {
                memory_type: mem_type.as_deref(),
                tags: tags.as_deref(),
                who: who.as_deref(),
                pinned,
                importance_min,
                since: since.as_deref(),
                until: until.as_deref(),
            };

            // FTS5 keyword search
            let fts_hits = fts_search(conn, &keyword_query, top_k, &filter).unwrap_or_default();

            // Vector KNN search
            let vec_hits = match &query_vec {
                Some(v) => vec_search_scored(conn, v, top_k, mem_type.as_deref()),
                None => vec![],
            };

            // Merge
            let mut scored = merge_scores(&fts_hits, &vec_hits, alpha, min_score);
            scored.truncate(limit);

            if scored.is_empty() {
                return Ok(RecallResponse {
                    results: vec![],
                    query: query_for_response,
                    method: "hybrid".to_string(),
                });
            }

            // Fetch full rows with agent scope filtering
            let ids: Vec<&str> = scored.iter().map(|s| s.id.as_str()).collect();
            let id_count = ids.len();
            let placeholders: String = ids
                .iter()
                .enumerate()
                .map(|(i, _)| format!("?{}", i + 1))
                .collect::<Vec<_>>()
                .join(",");

            // Build agent scope clause
            let (agent_clause, agent_params) = if let Some(ref aid) = agent_id {
                // Look up agent's read_policy
                let policy: String = conn
                    .query_row(
                        "SELECT read_policy FROM agents WHERE id = ?1",
                        rusqlite::params![aid],
                        |row| row.get(0),
                    )
                    .unwrap_or_else(|_| "isolated".to_string());

                match policy.as_str() {
                    "shared" => (
                        format!(
                            " AND (visibility = 'global' OR agent_id = ?{}) AND visibility != 'archived'",
                            id_count + 1
                        ),
                        vec![aid.clone()],
                    ),
                    "group" => {
                        let group: Option<String> = conn
                            .query_row(
                                "SELECT policy_group FROM agents WHERE id = ?1",
                                rusqlite::params![aid],
                                |row| row.get(0),
                            )
                            .ok()
                            .flatten();
                        if let Some(g) = group {
                            (
                                format!(
                                    " AND ((visibility = 'global' AND agent_id IN (SELECT id FROM agents WHERE policy_group = ?{})) OR agent_id = ?{}) AND visibility != 'archived'",
                                    id_count + 1,
                                    id_count + 2,
                                ),
                                vec![g, aid.clone()],
                            )
                        } else {
                            // No group configured — fall back to isolated (own memories only)
                            (
                                format!(
                                    " AND agent_id = ?{} AND visibility != 'archived'",
                                    id_count + 1
                                ),
                                vec![aid.clone()],
                            )
                        }
                    }
                    _ => (
                        format!(
                            " AND agent_id = ?{} AND visibility != 'archived'",
                            id_count + 1
                        ),
                        vec![aid.clone()],
                    ),
                }
            } else {
                (String::new(), vec![])
            };

            let sql = format!(
                "SELECT id, content, type, tags, pinned, importance, who, project, created_at
                 FROM memories WHERE id IN ({placeholders}){agent_clause}"
            );

            let mut stmt = conn.prepare(&sql)?;
            let mut refs: Vec<Box<dyn rusqlite::types::ToSql>> = ids
                .iter()
                .map(|s| Box::new(s.to_string()) as Box<dyn rusqlite::types::ToSql>)
                .collect();
            for p in &agent_params {
                refs.push(Box::new(p.clone()));
            }
            let param_refs: Vec<&dyn rusqlite::types::ToSql> =
                refs.iter().map(|b| b.as_ref()).collect();

            let rows: std::collections::HashMap<String, RecallHit> = stmt
                .query_map(param_refs.as_slice(), |row| {
                    let content: String = row.get(1)?;
                    let len = content.len();
                    let is_truncated = len > truncate;
                    let display = if is_truncated {
                        // floor_char_boundary avoids slicing mid-codepoint
                        let boundary = content.floor_char_boundary(truncate);
                        format!("{} [truncated]", &content[..boundary])
                    } else {
                        content
                    };

                    Ok((
                        row.get::<_, String>(0)?,
                        RecallHit {
                            id: row.get(0)?,
                            content: display,
                            content_length: len,
                            truncated: is_truncated,
                            score: 0.0, // Filled below
                            source: String::new(),
                            memory_type: row.get(2)?,
                            tags: row.get(3)?,
                            pinned: row.get::<_, i64>(4)? != 0,
                            importance: row.get(5)?,
                            who: row.get(6)?,
                            project: row.get(7)?,
                            created_at: row.get(8)?,
                            supplementary: None,
                        },
                    ))
                })?
                .filter_map(|r| r.ok())
                .collect();

            let results: Vec<RecallHit> = scored
                .iter()
                .filter_map(|s| {
                    let mut hit = rows.get(&s.id)?.clone();
                    hit.score = (s.score * 100.0).round() / 100.0;
                    hit.source = s.source.as_str().to_string();
                    Some(hit)
                })
                .collect();

            let method = if has_vec { "hybrid" } else { "keyword" };
            Ok(RecallResponse {
                results,
                query: query_for_response,
                method: method.to_string(),
            })
        })
        .await;

    // --- Optional LLM reranker + recall summary (parity with TS daemon) ---
    // LLM calls are only made when the user has explicitly opted in via
    // `memory.pipelineV2.reranker.enabled: true` AND
    // `memory.pipelineV2.reranker.useExtractionModel: true`.
    // Callers should be aware of the per-request LLM cost this incurs.
    // The recall endpoint sits behind the daemon's existing auth middleware;
    // operators should use token auth + rate limiting if recall is exposed
    // beyond the local loopback.
    let result = match result {
        Ok(mut resp) if !resp.results.is_empty() => {
            let (reranker_enabled, use_extraction_model) = state
                .config
                .manifest
                .memory
                .as_ref()
                .and_then(|m| m.pipeline_v2.as_ref())
                .map(|p| (p.reranker.enabled, p.reranker.use_extraction_model))
                .unwrap_or((false, false));

            if reranker_enabled && use_extraction_model {
                let llm = state.llm.read().await.clone();
                if let Some(ref provider) = llm {
                    let timeout_ms = state
                        .config
                        .manifest
                        .memory
                        .as_ref()
                        .and_then(|m| m.pipeline_v2.as_ref())
                        .map(|p| p.reranker.timeout_ms)
                        .unwrap_or(2_000);
                    let top_n = state
                        .config
                        .manifest
                        .memory
                        .as_ref()
                        .and_then(|m| m.pipeline_v2.as_ref())
                        .map(|p| p.reranker.top_n)
                        .unwrap_or(20);

                    let candidates: Vec<(&str, &str, f64)> = resp
                        .results
                        .iter()
                        .take(top_n)
                        .map(|h| (h.id.as_str(), h.content.as_str(), h.score))
                        .collect();

                    let (updated_scores, summary) = reranker::rerank_and_summarize(
                        provider,
                        &resp.query,
                        &candidates,
                        timeout_ms,
                    )
                    .await;

                    // Apply updated scores from LLM reranker.
                    // Sort on full-precision blended score before rounding,
                    // matching TS daemon ordering behavior.
                    if let Some(scores) = updated_scores {
                        let score_map: std::collections::HashMap<&str, f64> =
                            scores.iter().map(|(id, s)| (id.as_str(), *s)).collect();
                        // Update with full-precision scores and sort first.
                        let mut full_scores: Vec<(usize, f64)> = resp
                            .results
                            .iter()
                            .enumerate()
                            .map(|(i, h)| {
                                let s = score_map.get(h.id.as_str()).copied().unwrap_or(h.score);
                                (i, s)
                            })
                            .collect();
                        full_scores.sort_by(|a, b| {
                            b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal)
                        });
                        let mut reordered: Vec<RecallHit> = full_scores
                            .iter()
                            .map(|(i, s)| {
                                let mut hit = resp.results[*i].clone();
                                hit.score = (s * 100.0).round() / 100.0;
                                hit
                            })
                            .collect();
                        std::mem::swap(&mut resp.results, &mut reordered);
                    }

                    // Inject summary card only when limit >= 2: one slot for
                    // the summary, at least one slot for a real memory to
                    // verify against. Matches TS daemon parity contract.
                    if limit >= 2 {
                        if let Some(text) = summary {
                            let content =
                                format!("[model summary, verify against source memories] {text}");
                            let top_score = resp.results.first().map(|h| h.score).unwrap_or(0.5);
                            let score = top_score.clamp(0.01, 1.0);

                            // SHA-1 digest of query for stable id, matching TS daemon.
                            use sha1::Digest;
                            let hash = sha1::Sha1::digest(resp.query.as_bytes());
                            let digest = format!("{hash:x}");
                            let digest = &digest[..12];

                            if resp.results.len() >= limit {
                                resp.results.pop();
                            }
                            resp.results.insert(
                                0,
                                RecallHit {
                                    id: format!("summary:{digest}"),
                                    content: content.clone(),
                                    content_length: content.len(),
                                    truncated: false,
                                    score,
                                    source: "llm_summary".to_string(),
                                    memory_type: "semantic".to_string(),
                                    tags: None,
                                    pinned: false,
                                    importance: 0.9,
                                    who: None,
                                    project: None,
                                    created_at: chrono::Utc::now().to_rfc3339(),
                                    supplementary: Some(true),
                                },
                            );
                        }
                    }
                }
            }
            Ok(resp)
        }
        other => other,
    };

    match result {
        Ok(resp) => {
            // Update access tracking on a writable connection (fire-and-forget).
            // Exclude supplementary cards (e.g. llm_summary) — they are not
            // stored in the database and have no access-time row to update.
            if !resp.results.is_empty() {
                let ids: Vec<String> = resp
                    .results
                    .iter()
                    .filter(|h| h.supplementary != Some(true))
                    .map(|h| h.id.clone())
                    .collect();
                let pool = state.pool.clone();
                tokio::spawn(async move {
                    let _ = pool
                        .write(signet_core::db::Priority::Low, move |conn| {
                            let refs: Vec<&str> = ids.iter().map(|s| s.as_str()).collect();
                            touch_accessed(conn, &refs);
                            Ok(serde_json::Value::Null)
                        })
                        .await;
                });
            }
            (StatusCode::OK, Json(serde_json::to_value(resp).unwrap())).into_response()
        }
        Err(e) => {
            warn!(err = %e, "recall failed");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": "Recall failed", "results": []})),
            )
                .into_response()
        }
    }
}

// ---------------------------------------------------------------------------
// GET /api/memory/search?q=...
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct SearchParams {
    pub q: Option<String>,
    pub limit: Option<usize>,
    #[serde(rename = "type")]
    pub memory_type: Option<String>,
    pub tags: Option<String>,
    pub who: Option<String>,
    pub pinned: Option<String>,
    pub importance_min: Option<f64>,
    pub since: Option<String>,
}

pub async fn search_get(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Query(params): Query<SearchParams>,
) -> axum::response::Response {
    let q = params.q.unwrap_or_default().trim().to_string();
    if q.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "query is required"})),
        )
            .into_response();
    }

    let pinned = params.pinned.as_deref().map(|p| p == "1" || p == "true");

    let body = RecallBody {
        query: q,
        keyword_query: None,
        limit: params.limit,
        agent_id: None,
        memory_type: params.memory_type,
        tags: params.tags,
        who: params.who,
        pinned,
        importance_min: params.importance_min,
        since: params.since,
        until: None,
    };

    recall(State(state), ConnectInfo(peer), headers, Json(body))
        .await
        .into_response()
}

// ---------------------------------------------------------------------------
// GET /memory/search (legacy alias)
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct LegacySearchParams {
    pub q: Option<String>,
    pub limit: Option<usize>,
}

pub async fn legacy_search(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Query(params): Query<LegacySearchParams>,
) -> axum::response::Response {
    let q = params.q.unwrap_or_default().trim().to_string();
    if q.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "query is required"})),
        )
            .into_response();
    }

    let body = RecallBody {
        query: q,
        keyword_query: None,
        limit: params.limit,
        agent_id: None,
        memory_type: None,
        tags: None,
        who: None,
        pinned: None,
        importance_min: None,
        since: None,
        until: None,
    };

    recall(State(state), ConnectInfo(peer), headers, Json(body))
        .await
        .into_response()
}

// ---------------------------------------------------------------------------
// GET /api/embeddings
// ---------------------------------------------------------------------------

pub async fn embeddings_stats(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    let stats = state
        .pool
        .read(|conn| {
            let total: i64 = conn.query_row("SELECT COUNT(*) FROM embeddings", [], |r| r.get(0))?;
            let memories: i64 = conn
                .query_row(
                    "SELECT COUNT(DISTINCT source_id) FROM embeddings WHERE source_type = 'memory'",
                    [],
                    |r| r.get(0),
                )
                .unwrap_or(0);
            let dims: Option<i64> = conn
                .query_row("SELECT dimensions FROM embeddings LIMIT 1", [], |r| {
                    r.get(0)
                })
                .ok();

            Ok(serde_json::json!({
                "total": total,
                "memoriesWithEmbeddings": memories,
                "dimensions": dims,
            }))
        })
        .await
        .unwrap_or_else(|_| serde_json::json!({"error": "db unavailable"}));

    Json(stats)
}

pub async fn embeddings_status(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    let cfg = state.config.manifest.embedding.clone().unwrap_or_default();
    let base_url = resolve_embedding_base_url(&cfg.provider, cfg.base_url.as_deref());
    let mut status = serde_json::json!({
        "provider": cfg.provider,
        "model": cfg.model,
        "base_url": base_url,
        "available": false,
        "checkedAt": chrono::Utc::now().to_rfc3339(),
    });

    if cfg.provider == "none" {
        status["error"] =
            serde_json::json!("Embedding provider set to 'none' — vector search disabled");
    } else if state.embedding.read().await.is_some() {
        status["available"] = serde_json::json!(true);
        status["dimensions"] = serde_json::json!(cfg.dimensions);
    } else {
        status["error"] = serde_json::json!("Embedding provider unavailable");
    }

    status["tracker"] = serde_json::Value::Null;
    Json(status)
}

fn resolve_embedding_base_url(provider: &str, configured: Option<&str>) -> String {
    let trimmed = configured.map(str::trim).filter(|value| !value.is_empty());
    match provider {
        "openai" => trimmed.unwrap_or("https://api.openai.com/v1").to_string(),
        "llama-cpp" => trimmed.unwrap_or("http://localhost:8080").to_string(),
        _ => trimmed.unwrap_or("http://localhost:11434").to_string(),
    }
}
