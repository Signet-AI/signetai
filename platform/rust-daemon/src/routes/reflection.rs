use crate::routes::auth;
use crate::{agent, execute, ApiError, AppState};
use axum::http::StatusCode;
use axum::{
    extract::{Path, Query, State},
    http::HeaderMap,
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::json;
use serde_json::Value;
use signet_core_native::Operation;
use time::OffsetDateTime;
use uuid::Uuid;

#[derive(Debug, Deserialize)]
pub(crate) struct ReflectionQuery {
    pub limit: Option<usize>,
    #[serde(alias = "agentId")]
    pub agent_id: Option<String>,
    pub count: Option<usize>,
}

#[derive(Debug, Deserialize)]
struct AnswerBody {
    answer: Option<String>,
}

fn limit(query: &ReflectionQuery) -> usize {
    query.limit.unwrap_or(30).clamp(1, 100)
}

async fn list(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<ReflectionQuery>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(
        execute(
            &state,
            Operation::ReflectionList {
                agent_id: agent(&headers, None, None)?,
                limit: limit(&query),
            },
        )
        .await?,
    ))
}

async fn today(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<ReflectionQuery>,
) -> Result<Json<Value>, ApiError> {
    let now = OffsetDateTime::now_utc();
    let date = format!(
        "{:04}-{:02}-{:02}",
        now.year(),
        u8::from(now.month()),
        now.day()
    );
    Ok(Json(
        execute(
            &state,
            Operation::ReflectionToday {
                agent_id: agent(&headers, None, None)?,
                date,
                limit: limit(&query),
            },
        )
        .await?,
    ))
}

async fn generate(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<ReflectionQuery>,
) -> Result<Json<Value>, ApiError> {
    let claims = auth::gate(&state, &headers).await?;
    if !auth::authority_allows(
        &claims,
        "agent",
        &json!({"agent": agent(&headers, None, None)?}),
        &["admin".into()],
    ) {
        return Err(ApiError::forbidden("admin permission required"));
    }
    let _ = query;
    let workspace = std::env::var_os("SIGNET_PATH")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::path::PathBuf::from("."));
    let config = std::fs::read_to_string(workspace.join("agent.yaml")).unwrap_or_default();
    let section = config
        .split("pipelineV2:")
        .nth(1)
        .and_then(|s| s.split("reflections:").nth(1));
    let section = section.unwrap_or("");
    let enabled = section
        .lines()
        .take(12)
        .any(|line| line.trim() == "enabled: true");
    if !enabled {
        return Err(ApiError::bad_request(
            "Reflections are disabled in pipeline config",
        ));
    }
    let count = query.count.unwrap_or(1).clamp(1, 6);
    let model = section
        .lines()
        .find_map(|l| l.trim().strip_prefix("model:"))
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .or_else(|| std::env::var("SIGNET_OPENAI_MODEL").ok())
        .ok_or_else(|| ApiError::bad_request("model is required"))?;
    let memories = execute(
        &state,
        Operation::ReflectionMemories {
            agent_id: agent(&headers, None, None)?,
            limit: 50,
        },
    )
    .await?;
    let prompt = format!("Review these memories and return JSON with an entries array containing up to {count} reflective questions. Memories: {}", serde_json::to_string(&memories).unwrap_or_default());
    let response = super::inference::call_openai(
        &std::env::var("SIGNET_OPENAI_BASE_URL")
            .map_err(|_| ApiError::upstream("provider is not configured"))?,
        std::env::var("SIGNET_OPENAI_API_KEY").ok(),
        json!({"model":model,"messages":[{"role":"user","content":prompt}],"max_tokens":4096}),
    )
    .await
    .map_err(|e| ApiError::upstream(format!("provider request failed: {e:?}")))?;
    let content = response
        .pointer("/choices/0/message/content")
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::upstream("provider response missing content"))?;
    let parsed: Value = serde_json::from_str(content)
        .map_err(|_| ApiError::upstream("provider returned malformed reflection JSON"))?;
    let entries = parsed
        .get("entries")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let agent_id = agent(&headers, None, None)?;
    let date = OffsetDateTime::now_utc().date().to_string();
    execute(
        &state,
        Operation::ReflectionInsert {
            agent_id,
            date: date.clone(),
            model,
            entries,
        },
    )
    .await?;
    let reflections = execute(
        &state,
        Operation::ReflectionToday {
            agent_id: agent(&headers, None, None)?,
            date,
            limit: 6,
        },
    )
    .await?;
    Ok(Json(
        json!({"reflection": reflections.get("reflection").cloned().unwrap_or(Value::Null), "reflections": reflections.get("reflections").cloned().unwrap_or(json!([])), "generated": true}),
    ))
}

async fn answer(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    body: Result<Json<AnswerBody>, axum::extract::rejection::JsonRejection>,
) -> Result<Json<Value>, ApiError> {
    let claims = auth::gate(&state, &headers).await?;
    let agent_id = agent(&headers, None, None)?;
    if !auth::authority_allows(
        &claims,
        "agent",
        &json!({"agent": agent_id}),
        &["modify".into()],
    ) {
        return Err(ApiError::forbidden("modify permission required"));
    }
    let Json(body) = body.map_err(|_| ApiError::bad_request("Invalid JSON body"))?;
    let answer = body
        .answer
        .ok_or_else(|| ApiError::bad_request("answer is required"))?;
    let answer = answer.trim().to_owned();
    if answer.is_empty() {
        return Err(ApiError::bad_request("answer is required"));
    }
    if answer.chars().count() > 10_000 {
        return Err(ApiError {
            status: StatusCode::PAYLOAD_TOO_LARGE,
            code: "payload_too_large",
            message: "answer exceeds 10000 characters".into(),
        });
    }
    let result = execute(
        &state,
        Operation::ReflectionAnswer {
            agent_id,
            id,
            answer,
            memory_id: Uuid::new_v4().to_string(),
            answered_at: OffsetDateTime::now_utc()
                .format(&time::format_description::well_known::Rfc3339)
                .unwrap_or_default(),
        },
    )
    .await;
    match result {
        Err(error)
            if error.message == "already answered" || error.message == "Already answered" =>
        {
            Err(ApiError {
                status: StatusCode::CONFLICT,
                code: "conflict",
                message: error.message,
            })
        }
        other => other.map(Json),
    }
}

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/api/reflections", get(list))
        .route("/api/reflections/today", get(today))
        .route("/api/reflections/generate", post(generate))
        .route("/api/reflections/{id}/answer", post(answer))
}
