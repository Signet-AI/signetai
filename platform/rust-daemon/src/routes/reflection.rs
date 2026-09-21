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
    let enabled = config.lines().any(|line| line.trim() == "enabled: true");
    if !enabled {
        return Err(ApiError::bad_request(
            "Reflections are disabled in pipeline config",
        ));
    }
    Err(ApiError {
        status: StatusCode::NOT_IMPLEMENTED,
        code: "unsupported",
        message: "LLM generation is unavailable in the native provider".into(),
    })
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
