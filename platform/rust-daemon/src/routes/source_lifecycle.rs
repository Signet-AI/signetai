use crate::{agent, execute, ApiError, AppState};
use axum::{
    extract::{Path, State},
    http::HeaderMap,
    routing::{delete, get},
    Json, Router,
};
use serde_json::Value;
use signet_core_native::Operation;

async fn delete_source(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(source_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let agent_id = agent(&headers, None, None)?;
    Ok(Json(
        execute(
            &state,
            Operation::DeleteSource {
                agent_id,
                source_id,
            },
        )
        .await?,
    ))
}

async fn source_health(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(source_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let agent_id = agent(&headers, None, None)?;
    Ok(Json(
        execute(
            &state,
            Operation::SourceHealth {
                agent_id,
                source_id,
            },
        )
        .await?,
    ))
}

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/api/sources/{source_id}", delete(delete_source))
        .route("/api/sources/{source_id}/health", get(source_health))
}
