use crate::{agent, execute, ApiError, AppState};
use axum::{
    extract::{Query, State},
    http::HeaderMap,
    routing::get,
    Json, Router,
};
use serde::Deserialize;
use serde_json::Value;
use signet_core_native::Operation;
use time::OffsetDateTime;

#[derive(Debug, Deserialize)]
pub(crate) struct ReflectionQuery {
    pub limit: Option<usize>,
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

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/api/reflections", get(list))
        .route("/api/reflections/today", get(today))
}
