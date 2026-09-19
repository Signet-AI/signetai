use crate::{routes::auth, ApiError, AppState};
use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    routing::get,
    Json, Router,
};
use serde::Deserialize;
use serde_json::Value;

#[derive(Debug, Deserialize, Default)]
struct SampleQuery {
    limit: Option<usize>,
    offset: Option<usize>,
}

async fn authorize(state: &AppState, headers: &HeaderMap) -> Result<Value, ApiError> {
    let claims = auth::gate(state, headers).await?;
    let admin = claims.get("role").and_then(Value::as_str) == Some("admin");
    let allowed = claims
        .get("permissions")
        .and_then(Value::as_array)
        .is_some_and(|p| {
            p.iter()
                .any(|v| matches!(v.as_str(), Some("diagnostics") | Some("database:read")))
        });
    if !admin && !allowed {
        return Err(ApiError {
            status: StatusCode::FORBIDDEN,
            code: "forbidden",
            message: "diagnostics capability is required".into(),
        });
    }
    Ok(claims)
}

async fn schema(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    authorize(&state, &headers).await?;
    Ok(Json(state.owner.database_schema().map_err(ApiError::from)?))
}

async fn sample(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(table): Path<String>,
    Query(query): Query<SampleQuery>,
) -> Result<Json<Value>, ApiError> {
    let claims = authorize(&state, &headers).await?;
    let limit = query.limit.unwrap_or(25);
    let offset = query.offset.unwrap_or(0);
    let agent = claims
        .get("agentId")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let workspace = claims
        .get("scope")
        .and_then(|v| v.get("workspace"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    Ok(Json(
        state
            .owner
            .database_sample(table, limit, offset, agent, workspace)
            .map_err(ApiError::from)?,
    ))
}

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/api/diagnostics/database/schema", get(schema))
        .route(
            "/api/diagnostics/database/tables/{table}/sample",
            get(sample),
        )
}
