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
    pub scope: Option<String>,
    pub project: Option<String>,
}

#[derive(Serialize)]
pub struct RecallResponse {
    pub results: Vec<RecallHit>,
    pub query: String,
    pub method: String,
    pub meta: RecallMeta,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecallMeta {
    pub total_returned: usize,
    pub has_supplementary: bool,
    pub no_hits: bool,
    pub timings: RecallTimings,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecallTimings {
    pub total_ms: f64,
    pub stages: Vec<RecallStageTiming>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecallStageTiming {
    pub name: String,
    pub duration_ms: f64,
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
    pub visibility: Option<String>,
    pub scope: Option<String>,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub supplementary: Option<bool>,
}

fn recall_response(results: Vec<RecallHit>, query: String, method: String) -> RecallResponse {
    let total_returned = results.len();
    let has_supplementary = results.iter().any(|hit| hit.supplementary == Some(true));
    RecallResponse {
        results,
        query,
        method,
        meta: RecallMeta {
            total_returned,
            has_supplementary,
            no_hits: total_returned == 0,
            timings: RecallTimings {
                total_ms: 0.0,
                stages: Vec::new(),
            },
        },
    }
}

fn refresh_recall_meta(resp: &mut RecallResponse) {
    resp.meta.total_returned = resp.results.len();
    resp.meta.has_supplementary = resp
        .results
        .iter()
        .any(|hit| hit.supplementary == Some(true));
    resp.meta.no_hits = resp.results.is_empty();
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
        let auth_runtime = state.auth_snapshot();
        let (reranker_enabled, use_extraction_model) = state
            .config
            .manifest
            .memory
            .as_ref()
            .and_then(|m| m.pipeline_v2.as_ref())
            .map(|p| (p.reranker.enabled, p.reranker.use_extraction_model))
            .unwrap_or((false, false));
        if reranker_enabled && use_extraction_model && auth_runtime.mode != AuthMode::Local {
            // authenticate_headers returns Err only for hard auth failures; in local
            // mode we already returned above, so unwrap_or with unauthenticated is safe.
            let auth = authenticate_headers(
                auth_runtime.mode,
                auth_runtime.secret.as_deref(),
                &headers,
                is_loopback(&peer),
            )
            .unwrap_or_else(|_| crate::auth::middleware::AuthState {
                result: crate::auth::types::AuthResult::unauthenticated(),
            });
            if let Err(resp) = require_rate_limit_guard(
                &auth,
                "recallLlm",
                &auth_runtime.recall_llm_limiter,
                auth_runtime.mode,
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
    let agent_id = body
        .agent_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| "default".to_string());
    let scope = body
        .scope
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);
    let project = body
        .project
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);
    let query_for_response = query.clone();

    let result = state
        .pool
        .read(move |conn| {
            let read_policy: String = conn
                .query_row(
                    "SELECT read_policy FROM agents WHERE id = ?1",
                    rusqlite::params![&agent_id],
                    |row| row.get(0),
                )
                .unwrap_or_else(|_| "isolated".to_string());
            let policy_group: Option<String> = conn
                .query_row(
                    "SELECT policy_group FROM agents WHERE id = ?1",
                    rusqlite::params![&agent_id],
                    |row| row.get(0),
                )
                .ok()
                .flatten();
            let filter = RecallFilter {
                memory_type: mem_type.as_deref(),
                tags: tags.as_deref(),
                who: who.as_deref(),
                pinned,
                importance_min,
                since: since.as_deref(),
                until: until.as_deref(),
                scope: scope.as_deref(),
                project: project.as_deref(),
                agent_id: Some(agent_id.as_str()),
                read_policy: Some(read_policy.as_str()),
                policy_group: policy_group.as_deref(),
            };

            // FTS5 keyword search
            let fts_hits = fts_search(conn, &keyword_query, top_k, &filter).unwrap_or_default();

            // Vector KNN search
            let vec_hits = match &query_vec {
                Some(v) => vec_search_scored(conn, v, top_k, &filter),
                None => vec![],
            };

            // Merge
            let mut scored = merge_scores(&fts_hits, &vec_hits, alpha, min_score);
            scored.truncate(limit);

            if scored.is_empty() {
                return Ok(recall_response(
                    vec![],
                    query_for_response,
                    "hybrid".to_string(),
                ));
            }

            // Fetch full rows with agent scope filtering
            let ids: Vec<&str> = scored.iter().map(|s| s.id.as_str()).collect();
            let placeholders: String = ids
                .iter()
                .map(|_| "?")
                .collect::<Vec<_>>()
                .join(",");

            let mut clauses = Vec::new();
            let mut filter_params: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
            if let Some(scope) = &scope {
                clauses.push("scope = ?");
                filter_params.push(Box::new(scope.clone()));
            } else {
                clauses.push("scope IS NULL");
            }
            if let Some(project) = &project {
                clauses.push("project = ?");
                filter_params.push(Box::new(project.clone()));
            }
            {
                let aid = &agent_id;
                match read_policy.as_str() {
                    "shared" => {
                        clauses.push("(visibility = 'global' OR agent_id = ?) AND visibility != 'archived'");
                        filter_params.push(Box::new(aid.clone()));
                    }
                    "group" => {
                        if let Some(group) = &policy_group {
                            clauses.push("((visibility = 'global' AND agent_id IN (SELECT id FROM agents WHERE policy_group = ?)) OR agent_id = ?) AND visibility != 'archived'");
                            filter_params.push(Box::new(group.clone()));
                            filter_params.push(Box::new(aid.clone()));
                        } else {
                            clauses.push("agent_id = ? AND visibility != 'archived'");
                            filter_params.push(Box::new(aid.clone()));
                        }
                    }
                    _ => {
                        clauses.push("agent_id = ? AND visibility != 'archived'");
                        filter_params.push(Box::new(aid.clone()));
                    }
                }
            }
            let filter_sql = if clauses.is_empty() {
                String::new()
            } else {
                format!(" AND {}", clauses.join(" AND "))
            };

            let sql = format!(
                "SELECT id, content, type, tags, pinned, importance, who, project, created_at, visibility, scope
                 FROM memories WHERE id IN ({placeholders}){filter_sql}"
            );

            let mut stmt = conn.prepare(&sql)?;
            let mut refs: Vec<Box<dyn rusqlite::types::ToSql>> = ids
                .iter()
                .map(|s| Box::new(s.to_string()) as Box<dyn rusqlite::types::ToSql>)
                .collect();
            refs.extend(filter_params);
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
                            visibility: row.get(9)?,
                            scope: row.get(10)?,
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
            Ok(recall_response(results, query_for_response, method.to_string()))
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
                                    visibility: None,
                                    scope: None,
                                    created_at: chrono::Utc::now().to_rfc3339(),
                                    supplementary: Some(true),
                                },
                            );
                        }
                    }
                }
            }
            refresh_recall_meta(&mut resp);
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
    pub scope: Option<String>,
    pub project: Option<String>,
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
        scope: params.scope,
        project: params.project,
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
        scope: None,
        project: None,
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

fn embedding_check_score(status: &str) -> f64 {
    match status {
        "ok" => 1.0,
        "warn" => 0.5,
        _ => 0.0,
    }
}

fn embedding_score_status(score: f64) -> &'static str {
    if score >= 0.8 {
        "healthy"
    } else if score >= 0.5 {
        "degraded"
    } else {
        "unhealthy"
    }
}

fn round_health_score(score: f64) -> f64 {
    (score.clamp(0.0, 1.0) * 1000.0).round() / 1000.0
}

fn vec_runtime_detail(error: &str) -> serde_json::Value {
    serde_json::json!({
        "sqlite": serde_json::Value::Null,
        "sqliteAttempt": serde_json::Value::Null,
        "sqliteWarning": serde_json::Value::Null,
        "extensionPath": serde_json::Value::Null,
        "extensionLoaded": false,
        "extensionLoadError": serde_json::Value::Null,
        "error": error,
    })
}

fn missing_vec_table(error: &str) -> bool {
    error.contains("no such table: vec_embeddings")
        || error.contains("no such table: main.vec_embeddings")
}

pub async fn embeddings_health(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    let cfg = state.config.manifest.embedding.clone().unwrap_or_default();
    let base_url = resolve_embedding_base_url(&cfg.provider, cfg.base_url.as_deref());
    let provider_available = state.embedding.read().await.is_some();
    let provider_error = if cfg.provider == "none" {
        Some("Embedding provider set to 'none' — vector search disabled".to_string())
    } else if provider_available {
        None
    } else {
        Some("Embedding provider unavailable".to_string())
    };

    let report = state
        .pool
        .read({
            let cfg = cfg.clone();
            let base_url = base_url.clone();
            move |conn| {
                let provider_status = if provider_available { "ok" } else { "fail" };
                let mut checks = vec![serde_json::json!({
                    "name": "provider-available",
                    "status": provider_status,
                    "message": provider_error
                        .clone()
                        .unwrap_or_else(|| format!("{} ({}) is reachable", cfg.provider, cfg.model)),
                    "detail": if provider_available {
                        serde_json::Value::Null
                    } else {
                        serde_json::json!({
                            "provider": cfg.provider,
                            "base_url": base_url,
                            "error": provider_error,
                        })
                    },
                    "fix": if provider_available {
                        serde_json::Value::Null
                    } else {
                        serde_json::json!("Verify embedding provider configuration and connectivity")
                    },
                })];

                let total: i64 = conn
                    .query_row(
                        "SELECT COUNT(*) FROM memories WHERE COALESCE(is_deleted, 0) = 0",
                        [],
                        |r| r.get(0),
                    )
                    .unwrap_or(0);
                let embedded: i64 = if total == 0 {
                    0
                } else {
                    conn.query_row(
                        "SELECT COUNT(*) FROM memories m
                         INNER JOIN embeddings e
                           ON e.source_type = 'memory' AND e.source_id = m.id
                         WHERE COALESCE(m.is_deleted, 0) = 0",
                        [],
                        |r| r.get(0),
                    )
                    .unwrap_or(0)
                };
                let coverage = if total == 0 {
                    1.0
                } else {
                    embedded as f64 / total as f64
                };
                let coverage_percent = (coverage * 1000.0).round() / 10.0;
                let coverage_status = if coverage >= 0.95 {
                    "ok"
                } else if coverage >= 0.8 {
                    "warn"
                } else {
                    "fail"
                };
                checks.push(serde_json::json!({
                    "name": "coverage",
                    "status": coverage_status,
                    "message": if total == 0 {
                        "No active memories to embed".to_string()
                    } else if coverage_status == "ok" {
                        format!("{coverage_percent}% of memories have embeddings")
                    } else {
                        format!(
                            "{coverage_percent}% coverage — {} memories missing embeddings",
                            total - embedded
                        )
                    },
                    "detail": {
                        "total": total,
                        "embedded": embedded,
                        "unembedded": total - embedded,
                        "coverage": coverage_percent,
                    },
                }));

                let dims = {
                    let mut stmt = conn.prepare("SELECT DISTINCT dimensions FROM embeddings")?;
                    stmt.query_map([], |r| r.get::<_, i64>(0))?
                        .collect::<rusqlite::Result<Vec<_>>>()?
                };
                let mismatched: Vec<i64> = dims
                    .iter()
                    .copied()
                    .filter(|dim| *dim != cfg.dimensions as i64)
                    .collect();
                checks.push(if dims.is_empty() {
                    serde_json::json!({
                        "name": "dimension-mismatch",
                        "status": "ok",
                        "message": "No embeddings to check",
                    })
                } else if mismatched.is_empty() {
                    serde_json::json!({
                        "name": "dimension-mismatch",
                        "status": "ok",
                        "message": format!("All embeddings are {}-dimensional", cfg.dimensions),
                    })
                } else {
                    serde_json::json!({
                        "name": "dimension-mismatch",
                        "status": "fail",
                        "message": format!(
                            "Found dimensions [{}] but config expects {}",
                            dims.iter().map(ToString::to_string).collect::<Vec<_>>().join(", "),
                            cfg.dimensions
                        ),
                        "detail": {"expected": cfg.dimensions, "found": dims},
                        "fix": "Re-embed affected memories with the correct model/dimensions",
                    })
                });

                let models = {
                    let mut stmt = conn.prepare(
                        "SELECT DISTINCT embedding_model FROM memories WHERE embedding_model IS NOT NULL",
                    )?;
                    stmt.query_map([], |r| r.get::<_, String>(0))?
                        .collect::<rusqlite::Result<Vec<_>>>()?
                };
                checks.push(if models.len() <= 1 {
                    serde_json::json!({
                        "name": "model-drift",
                        "status": "ok",
                        "message": if let Some(model) = models.first() {
                            format!("All memories use {model}")
                        } else {
                            "No embedding models recorded".to_string()
                        },
                    })
                } else {
                    serde_json::json!({
                        "name": "model-drift",
                        "status": "warn",
                        "message": format!("Mixed embedding models: {}", models.join(", ")),
                        "detail": {"models": models},
                        "fix": "Re-embed older memories to unify to the current model",
                    })
                });

                match conn.query_row(
                    "SELECT COUNT(*) FROM embeddings e LEFT JOIN vec_embeddings v ON v.id = e.id WHERE v.id IS NULL",
                    [],
                    |r| r.get::<_, i64>(0),
                ) {
                    Ok(0) => checks.push(serde_json::json!({
                        "name": "null-vectors",
                        "status": "ok",
                        "message": "No null or empty vectors found",
                    })),
                    Ok(count) => checks.push(serde_json::json!({
                        "name": "null-vectors",
                        "status": "fail",
                        "message": format!("{count} embedding(s) have null or empty vectors"),
                        "detail": {"count": count},
                        "fix": "Run re-embed repair to regenerate these vectors",
                    })),
                    Err(e) if missing_vec_table(&e.to_string()) => checks.push(serde_json::json!({
                        "name": "null-vectors",
                        "status": "warn",
                        "message": "Cannot verify null vectors because vec_embeddings is unavailable",
                        "detail": vec_runtime_detail(&e.to_string()),
                        "fix": "Install sqlite-vec or restart daemon to initialize the vector table",
                    })),
                    Err(e) => checks.push(serde_json::json!({
                        "name": "null-vectors",
                        "status": "fail",
                        "message": "Failed to verify vector row coverage",
                        "detail": vec_runtime_detail(&e.to_string()),
                        "fix": "Inspect SQLite schema integrity and repair the underlying query failure",
                    })),
                }

                let emb_count: i64 = conn
                    .query_row("SELECT COUNT(*) FROM embeddings", [], |r| r.get(0))
                    .unwrap_or(0);
                match conn.query_row("SELECT COUNT(*) FROM vec_embeddings", [], |r| {
                    r.get::<_, i64>(0)
                }) {
                    Ok(vec_count) if emb_count == vec_count => checks.push(serde_json::json!({
                        "name": "vec-table-sync",
                        "status": "ok",
                        "message": format!("embeddings ({emb_count}) and vec_embeddings ({vec_count}) are in sync"),
                    })),
                    Ok(vec_count) => checks.push(serde_json::json!({
                        "name": "vec-table-sync",
                        "status": "warn",
                        "message": format!("embeddings has {emb_count} rows but vec_embeddings has {vec_count}"),
                        "detail": {"embeddings": emb_count, "vecEmbeddings": vec_count},
                        "fix": "Run embedding repair to resync the vector index",
                    })),
                    Err(e) if missing_vec_table(&e.to_string()) => checks.push(serde_json::json!({
                        "name": "vec-table-sync",
                        "status": "warn",
                        "message": "vec_embeddings table not found",
                        "detail": vec_runtime_detail(&e.to_string()),
                        "fix": "Install sqlite-vec or restart daemon to initialize the vector table",
                    })),
                    Err(e) => checks.push(serde_json::json!({
                        "name": "vec-table-sync",
                        "status": "fail",
                        "message": "Failed to inspect vec_embeddings health",
                        "detail": vec_runtime_detail(&e.to_string()),
                        "fix": "Inspect SQLite schema integrity and repair the underlying query failure",
                    })),
                }

                let orphaned: i64 = conn
                    .query_row(
                        "SELECT COUNT(*) FROM embeddings e
                         LEFT JOIN memories m ON e.source_type = 'memory' AND e.source_id = m.id
                         WHERE e.source_type = 'memory'
                           AND (m.id IS NULL OR COALESCE(m.is_deleted, 0) = 1)",
                        [],
                        |r| r.get(0),
                    )
                    .unwrap_or(0);
                checks.push(if orphaned == 0 {
                    serde_json::json!({
                        "name": "orphaned-embeddings",
                        "status": "ok",
                        "message": "No orphaned embeddings found",
                    })
                } else {
                    serde_json::json!({
                        "name": "orphaned-embeddings",
                        "status": "warn",
                        "message": format!("{orphaned} embedding(s) point to deleted or missing memories"),
                        "detail": {"count": orphaned},
                        "fix": "Clean orphaned embeddings to reclaim space",
                    })
                });

                let weights = [
                    ("provider-available", 0.3),
                    ("coverage", 0.25),
                    ("dimension-mismatch", 0.15),
                    ("model-drift", 0.1),
                    ("null-vectors", 0.08),
                    ("vec-table-sync", 0.07),
                    ("orphaned-embeddings", 0.05),
                ];
                let score = weights
                    .iter()
                    .map(|(name, weight)| {
                        checks
                            .iter()
                            .find(|check| check.get("name").and_then(|v| v.as_str()) == Some(*name))
                            .and_then(|check| check.get("status").and_then(|v| v.as_str()))
                            .map(|status| embedding_check_score(status) * weight)
                            .unwrap_or(0.0)
                    })
                    .sum::<f64>();
                let score = round_health_score(score);

                Ok(serde_json::json!({
                    "status": embedding_score_status(score),
                    "score": score,
                    "checkedAt": chrono::Utc::now().to_rfc3339(),
                    "config": {
                        "provider": cfg.provider,
                        "model": cfg.model,
                        "dimensions": cfg.dimensions,
                    },
                    "checks": checks,
                }))
            }
        })
        .await
        .unwrap_or_else(|e| {
            serde_json::json!({
                "status": "unhealthy",
                "score": 0,
                "checkedAt": chrono::Utc::now().to_rfc3339(),
                "config": {
                    "provider": cfg.provider,
                    "model": cfg.model,
                    "dimensions": cfg.dimensions,
                },
                "checks": [{
                    "name": "database",
                    "status": "fail",
                    "message": format!("{e}"),
                }],
            })
        });

    Json(report)
}

#[derive(Debug, Deserialize)]
pub struct ProjectionQuery {
    pub dimensions: Option<String>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

fn bounded_i64(value: Option<i64>, min: i64, max: i64) -> Option<i64> {
    value.map(|n| n.clamp(min, max))
}

pub async fn embeddings_projection(
    State(state): State<Arc<AppState>>,
    Query(query): Query<ProjectionQuery>,
) -> impl IntoResponse {
    let dimensions = if query.dimensions.as_deref() == Some("3") {
        3
    } else {
        2
    };
    let offset = bounded_i64(query.offset, 0, 100_000).unwrap_or(0);
    let limit = bounded_i64(query.limit, 1, 5_000);

    let result = state
        .pool
        .read(move |conn| {
            let total: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM embeddings WHERE source_type = 'memory'",
                    [],
                    |r| r.get(0),
                )
                .unwrap_or(0);
            let effective_limit = limit.unwrap_or(total).max(0);
            Ok(serde_json::json!({
                "status": "ready",
                "dimensions": dimensions,
                "count": 0,
                "total": total,
                "limit": effective_limit,
                "offset": offset,
                "hasMore": offset + effective_limit < total,
                "nodes": [],
                "edges": [],
            }))
        })
        .await;

    match result {
        Ok(body) => (StatusCode::OK, Json(body)),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"status": "error", "message": format!("{e}")})),
        ),
    }
}

fn resolve_embedding_base_url(provider: &str, configured: Option<&str>) -> String {
    let trimmed = configured.map(str::trim).filter(|value| !value.is_empty());
    match provider {
        "openai" => trimmed.unwrap_or("https://api.openai.com/v1").to_string(),
        "llama-cpp" => trimmed.unwrap_or("http://localhost:8080").to_string(),
        _ => trimmed.unwrap_or("http://localhost:11434").to_string(),
    }
}
