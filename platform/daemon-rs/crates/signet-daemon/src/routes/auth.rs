use std::{net::SocketAddr, sync::Arc};

use axum::{
    Json,
    extract::{ConnectInfo, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use chrono::{SecondsFormat, Utc};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::{
    auth::{
        middleware::{authenticate_headers, require_permission_guard, require_rate_limit_guard},
        tokens::create_token,
        types::{Permission, TokenRole, TokenScope},
    },
    routes::pipeline::is_loopback,
    state::AppState,
};

const DEFAULT_TOKEN_TTL_SECONDS: i64 = 7 * 24 * 60 * 60;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenRequest {
    role: Option<String>,
    #[serde(default)]
    scope: TokenScope,
    ttl_seconds: Option<i64>,
}

/// GET /api/auth/whoami
///
/// Mirrors the TypeScript daemon's local-mode shape: unauthenticated callers
/// still receive a 200 with auth status, null claims, and the configured mode.
pub async fn whoami(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Result<Json<Value>, Response> {
    let is_local = is_loopback(&peer);
    let auth_runtime = state.auth_snapshot();
    let auth = authenticate_headers(
        auth_runtime.mode,
        auth_runtime.secret.as_deref(),
        &headers,
        is_local,
    )
    .map_err(|resp| *resp)?;

    Ok(Json(json!({
        "authenticated": auth.result.authenticated,
        "claims": auth.result.claims,
        "mode": auth_runtime.mode,
    })))
}

fn parse_role(raw: Option<&str>) -> Result<TokenRole, Response> {
    match raw {
        Some("admin") => Ok(TokenRole::Admin),
        Some("operator") => Ok(TokenRole::Operator),
        Some("agent") => Ok(TokenRole::Agent),
        Some("readonly") => Ok(TokenRole::Readonly),
        _ => Err((
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "role must be one of: admin, operator, agent, readonly"})),
        )
            .into_response()),
    }
}

fn role_name(role: TokenRole) -> &'static str {
    match role {
        TokenRole::Admin => "admin",
        TokenRole::Operator => "operator",
        TokenRole::Agent => "agent",
        TokenRole::Readonly => "readonly",
    }
}

/// POST /api/auth/token — mint a scoped token for team/hybrid mode.
pub async fn token(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<TokenRequest>,
) -> Result<Json<Value>, Response> {
    let is_local = is_loopback(&peer);
    let auth_runtime = state.auth_snapshot();
    let auth = authenticate_headers(
        auth_runtime.mode,
        auth_runtime.secret.as_deref(),
        &headers,
        is_local,
    )
    .map_err(|resp| *resp)?;
    require_permission_guard(&auth, Permission::Admin, auth_runtime.mode, is_local)
        .map_err(|resp| *resp)?;
    require_rate_limit_guard(
        &auth,
        "admin",
        &auth_runtime.admin_limiter,
        auth_runtime.mode,
        headers.get("x-signet-actor").and_then(|v| v.to_str().ok()),
    )
    .map_err(|resp| *resp)?;

    let Some(secret) = auth_runtime.secret.as_deref() else {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "auth secret not available (local mode?)"})),
        )
            .into_response());
    };
    let role = parse_role(body.role.as_deref())?;
    let ttl = body
        .ttl_seconds
        .filter(|ttl| *ttl > 0)
        .unwrap_or(DEFAULT_TOKEN_TTL_SECONDS);
    let token = create_token(
        secret,
        &format!("token:{}", role_name(role)),
        body.scope,
        role,
        ttl,
    );
    let expires_at =
        (Utc::now() + chrono::Duration::seconds(ttl)).to_rfc3339_opts(SecondsFormat::Millis, true);

    Ok(Json(json!({
        "token": token,
        "expiresAt": expires_at,
    })))
}
