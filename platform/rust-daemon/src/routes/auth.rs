use crate::{execute, ApiError, AppState};
use axum::{
    body::Bytes,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    routing::{delete, get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};

const MAX_BODY: usize = 64 * 1024;
#[derive(Deserialize)]
struct KeyRequest {
    name: String,
    #[serde(default)]
    role: Option<String>,
    #[serde(default)]
    agent_id: Option<String>,
    #[serde(default)]
    expires_at: Option<String>,
    #[serde(default)]
    scope: Value,
}
#[derive(Deserialize)]
struct TokenRequest {
    role: String,
    #[serde(default)]
    scope: Value,
    #[serde(default)]
    ttl_seconds: Option<u64>,
}

pub(crate) fn router() -> Router<AppState> {
    routes()
}
pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/auth/methods", get(methods))
        .route("/api/auth/token", post(token))
        .route("/api/auth/api-keys", get(list).post(create))
        .route("/api/auth/api-keys/{id}", delete(revoke))
}
fn credential(headers: &HeaderMap) -> Option<String> {
    headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(str::to_owned)
        .or_else(|| {
            headers
                .get("x-signet-api-key")
                .and_then(|v| v.to_str().ok())
                .map(str::to_owned)
        })
}
async fn gate(state: &AppState, headers: &HeaderMap) -> Result<Value, ApiError> {
    let token = credential(headers).ok_or_else(|| {
        ApiError::unauthorized("valid Bearer token or x-signet-api-key is required")
    })?;
    let result = execute(
        state,
        signet_core_native::Operation::AuthKeyVerify { token },
    )
    .await?;
    if result.get("authenticated").and_then(Value::as_bool) == Some(true) {
        Ok(result)
    } else {
        Err(ApiError::unauthorized(
            result
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("invalid credentials"),
        ))
    }
}
async fn methods() -> Json<Value> {
    Json(json!({"mode":"api-key","providers":[{"id":"api-key","type":"api-key","enabled":true}]}))
}
async fn token(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<Value>, ApiError> {
    let claims = gate(&state, &headers).await?;
    if body.len() > MAX_BODY {
        return Err(ApiError::bad_request("request body exceeds limit"));
    }
    let req: TokenRequest =
        serde_json::from_slice(&body).map_err(|_| ApiError::bad_request("invalid request body"))?;
    if !["admin", "operator", "agent", "readonly"].contains(&req.role.as_str()) {
        return Err(ApiError::bad_request("invalid role"));
    }
    Ok(Json(
        json!({"token":credential(&headers).unwrap_or_default(),"expiresAt":null,"role":req.role,"scope":req.scope,"agentId":claims.get("agentId")}),
    ))
}
async fn list(State(state): State<AppState>, headers: HeaderMap) -> Result<Json<Value>, ApiError> {
    let claims = gate(&state, &headers).await?;
    let agent_id = claims
        .get("agentId")
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::unauthorized("agent identity is required"))?;
    Ok(Json(
        json!({"apiKeys":execute(&state, signet_core_native::Operation::AuthKeyList { agent_id: agent_id.to_owned() }).await?}),
    ))
}
async fn create(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let claims = gate(&state, &headers).await?;
    if body.len() > MAX_BODY {
        return Err(ApiError::bad_request("request body exceeds limit"));
    }
    let req: KeyRequest =
        serde_json::from_slice(&body).map_err(|_| ApiError::bad_request("invalid request body"))?;
    let agent_id = claims
        .get("agentId")
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::unauthorized("agent identity is required"))?;
    if req.agent_id.as_deref().is_some_and(|id| id != agent_id) {
        return Err(ApiError::bad_request("agent scope mismatch"));
    }
    let result = execute(
        &state,
        signet_core_native::Operation::AuthKeyCreate {
            agent_id: agent_id.to_owned(),
            name: req.name,
            role: req.role.unwrap_or_else(|| "agent".into()),
            scope: req.scope,
            expires_at: req.expires_at,
        },
    )
    .await?;
    Ok((StatusCode::CREATED, Json(json!({"apiKey":result}))))
}
async fn revoke(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let claims = gate(&state, &headers).await?;
    let agent_id = claims
        .get("agentId")
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::unauthorized("agent identity is required"))?;
    Ok(Json(
        json!({"apiKey":execute(&state, signet_core_native::Operation::AuthKeyRevoke { agent_id: agent_id.to_owned(), id }).await?}),
    ))
}
