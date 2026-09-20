use crate::routes::auth;
use crate::{agent, execute, ApiError, AppState};
use axum::{
    extract::{Query, State},
    http::HeaderMap,
    routing::{get, post},
    Json, Router,
};
use axum::{http::StatusCode, response::IntoResponse};
use serde::Deserialize;
use serde_json::{json, Value};
use signet_core_native::Operation;
use std::{
    collections::BTreeMap,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

pub(crate) async fn pipeline_status(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(
        execute(
            &state,
            Operation::PipelineStatus {
                agent_id: agent(&headers, None, None)?,
            },
        )
        .await?,
    ))
}
pub(crate) async fn dream_status(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(
        execute(
            &state,
            Operation::DreamStatus {
                agent_id: agent(&headers, None, None)?,
            },
        )
        .await?,
    ))
}
pub(crate) async fn active_passes(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(
        execute(
            &state,
            Operation::DreamActivePasses {
                agent_id: agent(&headers, None, None)?,
            },
        )
        .await?,
    ))
}
pub(crate) async fn pause(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(
        execute(
            &state,
            Operation::PipelineSetPaused {
                agent_id: agent(&headers, None, None)?,
                paused: true,
            },
        )
        .await?,
    ))
}
pub(crate) async fn resume(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(
        execute(
            &state,
            Operation::PipelineSetPaused {
                agent_id: agent(&headers, None, None)?,
                paused: false,
            },
        )
        .await?,
    ))
}
pub(crate) async fn trigger(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Option<Json<Value>>,
) -> Result<Json<Value>, ApiError> {
    let payload = body.map(|Json(value)| value).unwrap_or_else(|| json!({}));
    let workspace_id = headers
        .get("x-workspace-id")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("default")
        .to_owned();
    if serde_json::to_vec(&payload)
        .map_err(|_| ApiError::bad_request("invalid payload"))?
        .len()
        > 65_536
    {
        return Err(ApiError::bad_request("payload exceeds 64 KiB"));
    }
    Ok(Json(
        execute(
            &state,
            Operation::DreamTrigger {
                agent_id: agent(&headers, None, None)?,
                workspace_id,
                payload,
            },
        )
        .await?,
    ))
}
#[derive(Debug, Deserialize)]
struct ModelQuery {
    provider: Option<String>,
    deprecated: Option<String>,
    limit: Option<usize>,
}

fn catalog() -> Vec<Value> {
    let entries: &[(&str, &[(&str, &str, &str, &str, &str)])] = &[
        (
            "acpx",
            &[
                ("haiku", "Claude Code · haiku", "low", "harness", "false"),
                (
                    "gpt-5.4-mini",
                    "Codex CLI · gpt-5.4-mini",
                    "low",
                    "harness",
                    "false",
                ),
                (
                    "opencode/gemini-3-flash",
                    "OpenCode · opencode/gemini-3-flash",
                    "low",
                    "harness",
                    "false",
                ),
            ],
        ),
        (
            "llama-cpp",
            &[
                ("qwen3:4b", "qwen3:4b", "low", "local", "false"),
                ("qwen3:8b", "qwen3:8b", "low", "local", "false"),
            ],
        ),
        (
            "ollama",
            &[
                ("qwen3:4b", "qwen3:4b", "low", "local", "false"),
                ("llama3", "llama3", "low", "local", "false"),
            ],
        ),
        (
            "claude-code",
            &[
                ("haiku", "Haiku", "low", "harness", "false"),
                ("sonnet", "Sonnet", "mid", "harness", "false"),
                ("opus", "Opus", "high", "harness", "false"),
            ],
        ),
        (
            "codex",
            &[
                (
                    "gpt-5.3-codex-spark",
                    "gpt-5.3-codex-spark",
                    "low",
                    "harness",
                    "false",
                ),
                ("gpt-5.4-mini", "gpt-5.4-mini", "low", "harness", "false"),
                ("gpt-5.4", "gpt-5.4", "mid", "harness", "false"),
                ("gpt-5.5", "gpt-5.5", "high", "harness", "false"),
                ("gpt-5.6-luna", "gpt-5.6-luna", "high", "harness", "false"),
                ("gpt-5.6-sol", "gpt-5.6-sol", "high", "harness", "false"),
                ("gpt-5.6-terra", "gpt-5.6-terra", "high", "harness", "false"),
            ],
        ),
        (
            "opencode",
            &[
                (
                    "opencode/gemini-3-flash",
                    "opencode/gemini-3-flash",
                    "low",
                    "harness",
                    "false",
                ),
                (
                    "opencode/gpt-5.4-mini",
                    "opencode/gpt-5.4-mini",
                    "low",
                    "harness",
                    "false",
                ),
                (
                    "opencode/gpt-5.5",
                    "opencode/gpt-5.5",
                    "mid",
                    "harness",
                    "false",
                ),
            ],
        ),
        (
            "anthropic",
            &[
                (
                    "claude-haiku-4-5",
                    "Claude Haiku 4.5",
                    "low",
                    "provider",
                    "false",
                ),
                (
                    "claude-sonnet-4-6",
                    "Claude Sonnet 4.6",
                    "mid",
                    "provider",
                    "false",
                ),
                (
                    "claude-opus-4-6",
                    "Claude Opus 4.6",
                    "high",
                    "provider",
                    "false",
                ),
            ],
        ),
        (
            "openrouter",
            &[
                (
                    "openai/gpt-5.4-mini",
                    "openai/gpt-5.4-mini",
                    "low",
                    "provider",
                    "false",
                ),
                (
                    "openai/gpt-5.4",
                    "openai/gpt-5.4",
                    "mid",
                    "provider",
                    "false",
                ),
                (
                    "anthropic/claude-sonnet-4.6",
                    "anthropic/claude-sonnet-4.6",
                    "mid",
                    "provider",
                    "false",
                ),
                (
                    "google/gemini-3.1-pro-preview",
                    "google/gemini-3.1-pro-preview",
                    "high",
                    "provider",
                    "false",
                ),
                (
                    "deepseek/deepseek-v4-pro",
                    "deepseek/deepseek-v4-pro",
                    "high",
                    "provider",
                    "false",
                ),
            ],
        ),
        (
            "openai-compatible",
            &[
                ("gpt-4o-mini", "gpt-4o-mini", "low", "provider", "false"),
                ("gpt-4.1-mini", "gpt-4.1-mini", "low", "provider", "false"),
                ("local-model", "local-model", "low", "provider", "false"),
            ],
        ),
    ];
    entries.iter().flat_map(|(provider, models)| models.iter().map(move |(id, label, tier, _source, deprecated)| json!({"id": id, "provider": provider, "label": label, "tier": tier, "deprecated": deprecated == &"true"}))).collect()
}

fn registry() -> Value {
    let mut counts = BTreeMap::new();
    for model in catalog() {
        if let Some(provider) = model["provider"].as_str() {
            *counts.entry(provider.to_owned()).or_insert(0) += 1;
        }
    }
    json!({"initialized": true, "lastRefreshAt": 0, "modelCounts": counts})
}

static LAST_REFRESH: OnceLock<Mutex<Option<Instant>>> = OnceLock::new();

async fn models(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<ModelQuery>,
) -> Result<Json<Value>, ApiError> {
    auth::gate(&state, &headers).await?;
    let limit = query.limit.unwrap_or(100);
    if limit == 0 || limit > 100 {
        return Err(ApiError::bad_request("limit must be between 1 and 100"));
    }
    let models = catalog()
        .into_iter()
        .filter(|m| query.provider.as_deref().is_none_or(|p| m["provider"] == p))
        .filter(|m| {
            query
                .deprecated
                .as_deref()
                .is_none_or(|d| m["deprecated"] == (d == "true"))
        })
        .take(limit)
        .collect::<Vec<_>>();
    Ok(Json(json!({"models": models, "registry": registry()})))
}

async fn models_by_provider(
    State(state): State<AppState>,
    headers: HeaderMap,
    _query: Query<ModelQuery>,
) -> Result<Json<Value>, ApiError> {
    auth::gate(&state, &headers).await?;
    let mut by_provider = BTreeMap::new();
    for model in catalog() {
        if let Some(p) = model["provider"].as_str() {
            by_provider
                .entry(p.to_owned())
                .or_insert_with(Vec::new)
                .push(model);
        }
    }
    Ok(Json(json!(by_provider)))
}

async fn refresh_models(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<axum::response::Response, ApiError> {
    auth::gate(&state, &headers).await?;
    let refresh = LAST_REFRESH.get_or_init(|| Mutex::new(None));
    let mut last = refresh.lock().expect("refresh mutex poisoned");
    if last.is_some_and(|instant| instant.elapsed() < Duration::from_secs(60)) {
        return Ok((
            StatusCode::TOO_MANY_REQUESTS,
            Json(json!({"models": catalog(), "registry": registry(), "throttled": true})),
        )
            .into_response());
    }
    *last = Some(Instant::now());
    Ok(Json(json!({"models": catalog(), "registry": registry()})).into_response())
}

async fn unsupported_dreaming(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    auth::gate(&state, &headers).await?;
    Err(ApiError::not_implemented(
        "Dreaming orchestration is unsupported by the fresh native operation boundary",
    ))
}

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/api/pipeline/status", get(pipeline_status))
        .route("/api/pipeline/pause", post(pause))
        .route("/api/pipeline/resume", post(resume))
        .route("/api/pipeline/models", get(models))
        .route("/api/pipeline/models/by-provider", get(models_by_provider))
        .route("/api/pipeline/models/refresh", post(refresh_models))
        .route("/api/dream/status", get(dream_status))
        .route("/api/dream/passes/active", get(active_passes))
        .route(
            "/api/dream/passes/{pass_id}/events",
            get(unsupported_dreaming),
        )
        .route(
            "/api/dream/passes/{pass_id}/tools",
            get(unsupported_dreaming),
        )
        .route("/api/dream/quality", get(unsupported_dreaming))
        .route("/api/dream/exclusions/requeue", post(unsupported_dreaming))
        .route("/api/dream/operations", post(unsupported_dreaming))
        .route("/api/dream/tools", get(unsupported_dreaming))
        .route("/api/dream/tools/{capability}", post(unsupported_dreaming))
        .route("/api/dream/trigger", post(trigger))
}
