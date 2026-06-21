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
    RecallFilter, annotate_currentness, apply_currentness_bias, apply_dampening,
    apply_rehearsal_boost, apply_sec_lite, apply_temporal_topic_evidence,
    authorize_scored_candidates, fts_search, fuse_traversal_primary, hint_search,
    load_currentness_info, merge_recall_candidates, native_artifact_fallbacks,
    source_chunk_vector_fallbacks, structured_path_candidates, temporal_candidates_for_recall,
    touch_accessed, traversal_primary_candidates, vec_search_scored,
};

use crate::auth::middleware::{
    authenticate_headers, require_permission_guard, require_rate_limit_guard, resolve_scoped_agent,
};
use crate::auth::types::{AuthMode, Permission};
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
    pub time: Option<RecallTimeOptions>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecallTimeOptions {
    pub start: Option<String>,
    pub end: Option<String>,
    pub facets: Option<Vec<String>>,
    pub mode: Option<String>,
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
    pub source_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub supplementary: Option<bool>,
}

fn parse_recall_time(
    value: &str,
    field: &'static str,
) -> Result<chrono::DateTime<chrono::Utc>, &'static str> {
    chrono::DateTime::parse_from_rfc3339(value.trim())
        .map(|dt| dt.with_timezone(&chrono::Utc))
        .map_err(|_| match field {
            "time.start" => "time.start must be a valid ISO timestamp",
            _ => "time.end must be a valid ISO timestamp",
        })
}

fn validate_recall_time_options(time: Option<&RecallTimeOptions>) -> Result<(), &'static str> {
    let Some(options) = time else {
        return Ok(());
    };
    let Some(start) = options
        .start
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    else {
        return Err("time.start is required when time is provided");
    };
    let start = parse_recall_time(start, "time.start")?;
    if let Some(end) = options.end.as_deref() {
        if end.trim().is_empty() {
            return Err("time.end must be a valid ISO timestamp");
        }
        let end = parse_recall_time(end, "time.end")?;
        if end <= start {
            return Err("time.end must be after time.start");
        }
    }
    if let Some(facets) = options.facets.as_ref() {
        const ALLOWED: &[&str] = &[
            "session", "source", "captured", "observed", "occurred", "valid",
        ];
        if facets
            .iter()
            .any(|facet| !ALLOWED.contains(&facet.as_str()))
        {
            return Err(
                "time.facets entries must be one of: session, source, captured, observed, occurred, valid",
            );
        }
    }
    if let Some(mode) = options.mode.as_deref()
        && !matches!(mode, "auto" | "timeline" | "filter")
    {
        return Err("time.mode must be one of: auto, timeline, filter");
    }
    Ok(())
}

fn has_temporal_candidate_intent(_body: &RecallBody) -> bool {
    // Disabled until this route can pass validated temporal ranges/facets to the
    // candidate query. TS validates and filters in temporal-recall.ts:229-257;
    // treating time.start as a boolean gate boosted every temporal edge.
    false
}

fn fallback_existing_source_ids(results: &[RecallHit]) -> std::collections::HashSet<String> {
    results
        .iter()
        .filter_map(|row| row.source_id.as_deref())
        .map(str::trim)
        .filter(|source_id| !source_id.is_empty())
        .map(ToOwned::to_owned)
        .collect()
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
    if let Err(error) = validate_recall_time_options(body.time.as_ref()) {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": error})),
        )
            .into_response();
    }
    let temporal_intent = has_temporal_candidate_intent(&body);

    // Authenticate recall unconditionally in team/hybrid mode, enforce Recall
    // permission, and resolve the scoped agent (so a limited/cross-agent
    // credential cannot read memory outside its scope). LLM-enabled recall
    // additionally receives its independent rate limit below; local mode
    // remains permissive through authenticate_headers.
    let (agent_id, _auth) = {
        let auth_runtime = state.auth_snapshot();
        let is_local = is_loopback(&peer);
        let auth = match authenticate_headers(
            auth_runtime.mode,
            auth_runtime.secret.as_deref(),
            &headers,
            is_local,
        ) {
            Ok(auth) => auth,
            Err(resp) => return (*resp).into_response(),
        };
        if let Err(resp) =
            require_permission_guard(&auth, Permission::Recall, auth_runtime.mode, is_local)
        {
            return (*resp).into_response();
        }
        let scoped = match resolve_scoped_agent(
            &auth,
            auth_runtime.mode,
            is_local,
            body.agent_id.as_deref(),
        ) {
            Ok(scoped) => scoped,
            Err(reason) => {
                return (
                    StatusCode::FORBIDDEN,
                    Json(serde_json::json!({"error": reason})),
                )
                    .into_response();
            }
        };
        let (reranker_enabled, use_extraction_model) = state
            .config
            .manifest
            .memory
            .as_ref()
            .and_then(|m| m.pipeline_v2.as_ref())
            .map(|p| (p.reranker.enabled, p.reranker.use_extraction_model))
            .unwrap_or((false, false));
        if reranker_enabled && use_extraction_model && auth_runtime.mode != AuthMode::Local {
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
        (scoped, auth)
    };

    // Clamp recall limit to TS normalizeRecallLimit bounds (1..50) to avoid
    // oversized hydration/fallback work on large limits.
    let limit = body.limit.unwrap_or(10).clamp(1, 50);

    // #4 REVIEW FIX: Enforce project scope from token claims.
    // TS overwrites recall params with claims.scope.project (memory-routes.ts:762).
    // A token scoped to project A must not recall project B.
    let scoped_project = _auth
        .result
        .claims
        .as_ref()
        .and_then(|c| c.scope.project.as_deref())
        .map(|s| s.to_string());
    if let Some(ref scope_proj) = scoped_project {
        if let Some(ref body_proj) = body.project {
            let body_proj = body_proj.trim();
            if !body_proj.is_empty() && body_proj != scope_proj.as_str() {
                return (
                    StatusCode::FORBIDDEN,
                    Json(serde_json::json!({
                        "error": "project scope mismatch",
                        "scoped_project": scope_proj,
                    })),
                )
                    .into_response();
            }
        }
    }
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
    // agent_id is resolved from the authenticated+scoped token above (not
    // trusted from the request body) — a limited credential cannot read
    // another agent's memories by passing agent_id in the body.
    let scope = body
        .scope
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);
    // #3 REVIEW FIX: use scoped_project when body.project is omitted.
    // A token scoped to project A must not recall all projects by omitting it.
    let project = scoped_project.as_ref().map(|s| s.clone()).or_else(|| {
        body.project
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned)
    });
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

            // Candidate collection order follows TS memory-search.ts:997/1162/1203/1261/1290/1333/1378.
            let fts_hits = fts_search(conn, &keyword_query, top_k, &filter).unwrap_or_default();
            let hint_hits = hint_search(conn, &keyword_query, top_k, &filter);
            let vec_hits = match &query_vec {
                Some(v) => vec_search_scored(conn, v, top_k, &filter),
                None => vec![],
            };
            let structured_hits = structured_path_candidates(conn, &query, top_k, &filter);
            let temporal_hits =
                temporal_candidates_for_recall(conn, top_k, &filter, min_score, temporal_intent);
            let flat = merge_recall_candidates(
                &fts_hits,
                &hint_hits,
                &vec_hits,
                &structured_hits,
                &temporal_hits,
                alpha,
                min_score,
            );
            let traversal_hits = traversal_primary_candidates(conn, &query, top_k, &filter, min_score);
            let mut scored = fuse_traversal_primary(&flat, &traversal_hits, limit, top_k);

            // Critical auth boundary: TS memory-search.ts:1634 authorizes all
            // IDs before any content-bearing stage, reranker, or access touch.
            scored = authorize_scored_candidates(conn, &scored, &filter);
            apply_temporal_topic_evidence(conn, &mut scored, &query);
            apply_sec_lite(
                &mut scored,
                &fts_hits,
                &hint_hits,
                &vec_hits,
                &structured_hits,
                &traversal_hits,
                min_score,
            );
            apply_rehearsal_boost(conn, &mut scored, 0.08, 14.0);
            apply_dampening(conn, &mut scored, &query);
            let scored_ids: Vec<&str> = scored.iter().map(|s| s.id.as_str()).collect();
            let currentness = load_currentness_info(conn, &scored_ids, &agent_id);
            apply_currentness_bias(&mut scored, &currentness);

            let pre_hydrate = if body.agent_id.is_some() || project.is_some() || scope.is_some() {
                limit.saturating_mul(3).max(limit)
            } else {
                limit
            };
            let top_ids: Vec<&str> = scored.iter().take(pre_hydrate).map(|s| s.id.as_str()).collect();
            let allow_source_fallbacks = temporal_hits.is_empty()
                && mem_type.is_none()
                && tags.is_none()
                && who.is_none()
                && pinned.is_none()
                && importance_min.is_none()
                && since.is_none()
                && until.is_none()
                && scope.is_none();

            let mut results = Vec::new();
            if !top_ids.is_empty() {
                let placeholders: String = top_ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
                let sql = format!(
                    "SELECT id, content, type, tags, pinned, importance, who, project, created_at, visibility, scope, source_id
                     FROM memories WHERE id IN ({placeholders}) AND COALESCE(is_deleted, 0) = 0"
                );

                let mut stmt = conn.prepare(&sql)?;
                let refs: Vec<Box<dyn rusqlite::types::ToSql>> = top_ids
                    .iter()
                    .map(|s| Box::new(s.to_string()) as Box<dyn rusqlite::types::ToSql>)
                    .collect();
                let param_refs: Vec<&dyn rusqlite::types::ToSql> =
                    refs.iter().map(|b| b.as_ref()).collect();

                let rows: std::collections::HashMap<String, RecallHit> = stmt
                    .query_map(param_refs.as_slice(), |row| {
                        let raw_content: String = row.get(1)?;
                        let id: String = row.get(0)?;
                        let content = annotate_currentness(&raw_content, currentness.get(&id));
                        let len = content.len();
                        let is_truncated = len > truncate;
                        let display = if is_truncated {
                            let boundary = content.floor_char_boundary(truncate);
                            format!("{} [truncated]", &content[..boundary])
                        } else {
                            content
                        };

                        Ok((
                            id.clone(),
                            RecallHit {
                                id,
                                content: display,
                                content_length: len,
                                truncated: is_truncated,
                                score: 0.0,
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
                                source_id: row.get(11)?,
                                supplementary: None,
                            },
                        ))
                    })?
                    .filter_map(|r| r.ok())
                    .collect();

                results = scored
                    .iter()
                    .take(pre_hydrate)
                    .filter_map(|s| {
                        let mut hit = rows.get(&s.id)?.clone();
                        hit.score = (s.score * 100.0).round() / 100.0;
                        hit.source = s.source.as_str().to_string();
                        Some(hit)
                    })
                    .take(limit)
                    .collect();
            }

            // Thin memory recall source/session/transcript fallbacks mirror TS memory-search.ts:2003.
            if results.len() < limit && allow_source_fallbacks {
                let fill = limit - results.len();
                let mut existing_source_ids = fallback_existing_source_ids(&results);
                let source_hits = source_chunk_vector_fallbacks(
                    conn,
                    query_vec.as_deref(),
                    &existing_source_ids,
                    fill,
                    &agent_id,
                    project.as_deref(),
                );
                for hit in source_hits {
                    if results.len() >= limit {
                        break;
                    }
                    existing_source_ids.insert(hit.source_id.clone());
                    let content_len = hit.content.len();
                    let truncated = content_len > truncate;
                    let content = if truncated {
                        let boundary = hit.content.floor_char_boundary(truncate);
                        format!("{} [truncated]", &hit.content[..boundary])
                    } else {
                        hit.content.clone()
                    };
                    let source_id = hit.source_id.clone();
                    results.push(RecallHit {
                        id: hit.id,
                        content,
                        content_length: content_len,
                        truncated,
                        score: (hit.score.clamp(0.01, 1.0) * 100.0).round() / 100.0,
                        source: hit.source.as_str().to_string(),
                        memory_type: hit.source_type,
                        tags: Some(hit.tags),
                        pinned: false,
                        importance: hit.importance,
                        who: Some(hit.who),
                        project: hit.project,
                        visibility: None,
                        scope: None,
                        created_at: hit.created_at,
                        source_id: Some(source_id),
                        supplementary: Some(true),
                    });
                }
                if results.len() < limit {
                    let fill = limit - results.len();
                    let native_hits = native_artifact_fallbacks(
                        conn,
                        &keyword_query,
                        &existing_source_ids,
                        fill,
                        &agent_id,
                        project.as_deref(),
                    );
                    for hit in native_hits {
                        if results.len() >= limit {
                            break;
                        }
                        let content_len = hit.content.len();
                        let truncated = content_len > truncate;
                        let content = if truncated {
                            let boundary = hit.content.floor_char_boundary(truncate);
                            format!("{} [truncated]", &hit.content[..boundary])
                        } else {
                            hit.content.clone()
                        };
                        let source_id = hit.source_id.clone();
                        results.push(RecallHit {
                            id: hit.id,
                            content,
                            content_length: content_len,
                            truncated,
                            score: (hit.score.clamp(0.01, 1.0) * 100.0).round() / 100.0,
                            source: hit.source.as_str().to_string(),
                            memory_type: hit.source_type,
                            tags: Some(hit.tags),
                            pinned: false,
                            importance: hit.importance,
                            who: Some(hit.who),
                            project: hit.project,
                            visibility: None,
                            scope: None,
                            created_at: hit.created_at,
                            source_id: Some(source_id),
                            supplementary: Some(true),
                        });
                    }
                }
            }

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
                                    source_id: None,
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
        time: None,
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
        time: None,
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

#[cfg(test)]
mod tests {
    use super::*;

    fn recall_body(query: &str) -> RecallBody {
        RecallBody {
            query: query.to_string(),
            keyword_query: None,
            limit: None,
            agent_id: Some("agent-a".to_string()),
            memory_type: None,
            tags: None,
            who: None,
            pinned: None,
            importance_min: None,
            since: None,
            until: None,
            scope: None,
            project: None,
            time: None,
        }
    }

    fn recall_hit(id: &str, source_id: Option<&str>) -> RecallHit {
        RecallHit {
            id: id.to_string(),
            content: String::new(),
            content_length: 0,
            truncated: false,
            score: 0.5,
            source: "keyword".to_string(),
            memory_type: "fact".to_string(),
            tags: None,
            pinned: false,
            importance: 0.5,
            who: None,
            project: None,
            visibility: None,
            scope: None,
            created_at: "2026-06-01T00:00:00Z".to_string(),
            source_id: source_id.map(ToOwned::to_owned),
            supplementary: None,
        }
    }

    #[test]
    fn reranker_temporal_candidate_channel_stays_disabled_for_time_requests() {
        let mut normal = recall_body("apollo launch checklist");
        normal.since = Some("2026-01-01T00:00:00Z".to_string());
        assert!(!has_temporal_candidate_intent(&normal));

        let explicit_day = recall_body("what happened with apollo on June 14, 2026?");
        assert!(!has_temporal_candidate_intent(&explicit_day));

        let mut request_time = recall_body("apollo launch checklist");
        request_time.time = Some(RecallTimeOptions {
            start: Some("2026-06-14T00:00:00Z".to_string()),
            end: Some("2026-06-15T00:00:00Z".to_string()),
            facets: Some(vec!["session".to_string(), "source".to_string()]),
            mode: Some("filter".to_string()),
        });
        assert!(validate_recall_time_options(request_time.time.as_ref()).is_ok());
        assert!(!has_temporal_candidate_intent(&request_time));

        let mut invalid_time = recall_body("apollo launch checklist");
        invalid_time.time = Some(RecallTimeOptions {
            start: Some("2026-06-15T00:00:00Z".to_string()),
            end: Some("2026-06-14T00:00:00Z".to_string()),
            facets: None,
            mode: Some("filter".to_string()),
        });
        assert_eq!(
            validate_recall_time_options(invalid_time.time.as_ref()),
            Err("time.end must be after time.start")
        );
    }

    #[test]
    fn reranker_fallback_dedupe_uses_hydrated_memory_source_ids() {
        let results = vec![
            recall_hit("memory-with-source", Some("obsidian:vault:note")),
            recall_hit("memory-without-source", None),
        ];

        let existing_source_ids = fallback_existing_source_ids(&results);

        assert!(existing_source_ids.contains("obsidian:vault:note"));
        assert!(!existing_source_ids.contains("memory-with-source"));
        assert!(!existing_source_ids.contains("memory-without-source"));
    }
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
