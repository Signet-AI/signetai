use std::{net::SocketAddr, sync::Arc};

use axum::{
    Json,
    body::Bytes,
    extract::{ConnectInfo, Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use chrono::{SecondsFormat, Utc};
use serde::Deserialize;
use serde_json::{Value, json};
use signet_core::{db::Priority, error::CoreError};

use crate::{
    auth::{
        api_keys::{self, ApiKeyCreateInput},
        middleware::{authenticate_headers, require_permission_guard, require_rate_limit_guard},
        password::{verify_password_hash, verify_plain_password},
        tokens::create_token,
        types::{Permission, TokenRole, TokenScope},
    },
    routes::pipeline::is_loopback,
    state::AppState,
};

const DEFAULT_TOKEN_TTL_SECONDS: i64 = 7 * 24 * 60 * 60;
const DEFAULT_SESSION_TOKEN_TTL_SECONDS: i64 = 24 * 60 * 60;
const MAX_USERNAME_LENGTH: usize = 128;
const MAX_PASSWORD_LENGTH: usize = 1024;

fn require_admin_auth(
    state: &AppState,
    peer: &SocketAddr,
    headers: &HeaderMap,
) -> Result<(), Response> {
    let is_local = is_loopback(peer);
    let auth_runtime = state.auth_snapshot();
    let auth = authenticate_headers(
        auth_runtime.mode,
        auth_runtime.secret.as_deref(),
        headers,
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
    Ok(())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenRequest {
    role: Option<String>,
    #[serde(default)]
    scope: TokenScope,
    ttl_seconds: Option<i64>,
}

#[derive(Debug)]
struct PasswordLoginConfig {
    username: String,
    password_hash: Option<String>,
    plain_password: Option<String>,
}

impl PasswordLoginConfig {
    fn configured(&self) -> bool {
        self.password_hash.is_some() || self.plain_password.is_some()
    }
}

fn read_env_trimmed(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn yaml_key(key: &str) -> serde_yml::Value {
    serde_yml::Value::String(key.to_string())
}

fn yaml_string(map: &serde_yml::Mapping, key: &str) -> Option<String> {
    map.get(yaml_key(key))
        .and_then(serde_yml::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn yaml_i64(map: &serde_yml::Mapping, key: &str) -> Option<i64> {
    map.get(yaml_key(key))
        .and_then(|value| value.as_i64().or_else(|| value.as_str()?.parse().ok()))
}

fn auth_mapping(state: &AppState) -> Option<serde_yml::Mapping> {
    let content = std::fs::read_to_string(state.config.base_path.join("agent.yaml"))
        .or_else(|_| std::fs::read_to_string(state.config.base_path.join("AGENT.yaml")))
        .ok()?;
    let value = serde_yml::from_str::<serde_yml::Value>(&content).ok()?;
    value
        .as_mapping()?
        .get(yaml_key("auth"))?
        .as_mapping()
        .cloned()
}

fn resolve_password_login(state: &AppState) -> PasswordLoginConfig {
    let auth = auth_mapping(state);
    let login = auth
        .as_ref()
        .and_then(|auth| auth.get(yaml_key("login")))
        .and_then(serde_yml::Value::as_mapping);
    let password = login
        .and_then(|login| login.get(yaml_key("password")))
        .and_then(serde_yml::Value::as_mapping);
    let legacy_admin = auth
        .as_ref()
        .and_then(|auth| auth.get(yaml_key("adminUser")))
        .and_then(serde_yml::Value::as_mapping);

    let username = read_env_trimmed("SIGNET_ADMIN_USERNAME")
        .or_else(|| password.and_then(|password| yaml_string(password, "username")))
        .or_else(|| legacy_admin.and_then(|admin| yaml_string(admin, "username")))
        .unwrap_or_else(|| "admin".to_string());
    let password_hash = read_env_trimmed("SIGNET_ADMIN_PASSWORD_HASH")
        .or_else(|| password.and_then(|password| yaml_string(password, "passwordHash")))
        .or_else(|| legacy_admin.and_then(|admin| yaml_string(admin, "passwordHash")));
    let plain_password = read_env_trimmed("SIGNET_ADMIN_PASSWORD");

    PasswordLoginConfig {
        username,
        password_hash,
        plain_password,
    }
}

fn session_token_ttl_seconds(state: &AppState) -> i64 {
    auth_mapping(state)
        .as_ref()
        .and_then(|auth| yaml_i64(auth, "sessionTokenTtlSeconds"))
        .filter(|ttl| *ttl > 0)
        .unwrap_or(DEFAULT_SESSION_TOKEN_TTL_SECONDS)
}

fn is_valid_login_string(value: Option<&Value>, max_length: usize) -> Option<&str> {
    let value = value?.as_str()?;
    if value.is_empty() || value.len() > max_length {
        None
    } else {
        Some(value)
    }
}

fn json_body(bytes: Bytes) -> Result<Value, Response> {
    serde_json::from_slice::<Value>(&bytes).map_err(|_| {
        (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "invalid request body"})),
        )
            .into_response()
    })
}

fn invalid(error: &str) -> Response {
    (StatusCode::BAD_REQUEST, Json(json!({"error": error}))).into_response()
}

fn db_error(err: impl std::fmt::Display) -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({"error": err.to_string()})),
    )
        .into_response()
}

fn parse_role(raw: Option<&str>) -> Result<TokenRole, Response> {
    match raw {
        Some("admin") => Ok(TokenRole::Admin),
        Some("operator") => Ok(TokenRole::Operator),
        Some("agent") => Ok(TokenRole::Agent),
        Some("readonly") => Ok(TokenRole::Readonly),
        _ => Err(invalid(
            "role must be one of: admin, operator, agent, readonly",
        )),
    }
}

fn parse_optional_role(raw: Option<&Value>) -> Result<Option<TokenRole>, Response> {
    match raw.and_then(Value::as_str) {
        Some("admin") => Ok(Some(TokenRole::Admin)),
        Some("operator") => Ok(Some(TokenRole::Operator)),
        Some("agent") => Ok(Some(TokenRole::Agent)),
        Some("readonly") => Ok(Some(TokenRole::Readonly)),
        Some(_) => Err(invalid(
            "role must be one of: admin, operator, agent, readonly",
        )),
        None => Ok(None),
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

fn parse_permission(value: &str) -> Option<Permission> {
    match value {
        "remember" => Some(Permission::Remember),
        "recall" => Some(Permission::Recall),
        "modify" => Some(Permission::Modify),
        "forget" => Some(Permission::Forget),
        "recover" => Some(Permission::Recover),
        "admin" => Some(Permission::Admin),
        "documents" => Some(Permission::Documents),
        "connectors" => Some(Permission::Connectors),
        "diagnostics" => Some(Permission::Diagnostics),
        "analytics" => Some(Permission::Analytics),
        _ => None,
    }
}

fn parse_permissions(value: Option<&Value>) -> Option<Vec<Permission>> {
    value.and_then(Value::as_array).map(|values| {
        values
            .iter()
            .filter_map(Value::as_str)
            .filter_map(parse_permission)
            .collect()
    })
}

fn parse_string_array(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn parse_scope(value: Option<&Value>) -> TokenScope {
    let Some(map) = value.and_then(Value::as_object) else {
        return TokenScope::default();
    };
    TokenScope {
        project: map
            .get("project")
            .and_then(Value::as_str)
            .map(str::to_string),
        agent: map.get("agent").and_then(Value::as_str).map(str::to_string),
        user: map.get("user").and_then(Value::as_str).map(str::to_string),
    }
}

fn optional_string(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).map(str::to_string)
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
    let effective_access = auth_runtime.mode == crate::auth::types::AuthMode::Local
        || auth.result.authenticated
        || (auth_runtime.mode == crate::auth::types::AuthMode::Hybrid
            && is_local
            && !auth.result.authenticated);

    Ok(Json(json!({
        "authenticated": auth.result.authenticated,
        "trustedLocal": auth_runtime.mode == crate::auth::types::AuthMode::Hybrid && is_local && !auth.result.authenticated,
        "effectiveAccess": effective_access,
        "claims": auth.result.claims,
        "mode": auth_runtime.mode,
        "providers": auth_provider_response(&state)["providers"].clone(),
    })))
}

fn auth_provider_response(state: &AppState) -> Value {
    let login = resolve_password_login(state);
    let auth_runtime = state.auth_snapshot();
    json!({
        "mode": auth_runtime.mode,
        "providers": [
            {
                "id": "password",
                "type": "password",
                "enabled": login.configured(),
                "username": login.username,
            },
            {
                "id": "sso",
                "type": "oidc",
                "enabled": false,
                "startPath": "/api/auth/sso/start",
            },
            {
                "id": "saml",
                "type": "saml",
                "enabled": false,
                "startPath": "/api/auth/saml/start",
            },
        ],
    })
}

/// GET /api/auth/methods — advertise dashboard login providers.
pub async fn methods(State(state): State<Arc<AppState>>) -> Json<Value> {
    Json(auth_provider_response(&state))
}

/// POST /api/auth/login — password login for configured dashboard admins.
pub async fn login(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    body: Bytes,
) -> Response {
    let auth_runtime = state.auth_snapshot();
    let limit_key = format!("login:{}", peer.ip());
    let check = auth_runtime.admin_limiter.check(&"login", &limit_key);
    if !check.allowed {
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        let retry_after = check.reset_at.saturating_sub(now_ms) / 1000 + 1;
        return (
            StatusCode::TOO_MANY_REQUESTS,
            [("retry-after", retry_after.to_string())],
            Json(json!({"error": "rate limit exceeded", "retryAfter": check.reset_at})),
        )
            .into_response();
    }
    auth_runtime.admin_limiter.record("login", &limit_key);

    let Some(secret) = auth_runtime.secret.as_deref() else {
        return invalid("auth secret not available");
    };

    let payload = match json_body(body) {
        Ok(Value::Object(map)) => map,
        Ok(_) => return invalid("invalid request body"),
        Err(resp) => return resp,
    };
    let Some(username) = is_valid_login_string(payload.get("username"), MAX_USERNAME_LENGTH) else {
        return invalid("username is required");
    };
    let Some(password) = is_valid_login_string(payload.get("password"), MAX_PASSWORD_LENGTH) else {
        return invalid("password is required");
    };

    let login = resolve_password_login(&state);
    if !login.configured() {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"error": "password login is not configured"})),
        )
            .into_response();
    }

    let username_matches = verify_plain_password(username, &login.username);
    let hash_matches = login
        .password_hash
        .as_deref()
        .is_some_and(|hash| verify_password_hash(password, hash));
    let plain_matches = login
        .plain_password
        .as_deref()
        .is_some_and(|plain| verify_plain_password(password, plain));
    if !username_matches || (!hash_matches && !plain_matches) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({"error": "invalid username or password"})),
        )
            .into_response();
    }

    let ttl = session_token_ttl_seconds(&state);
    let token = create_token(
        secret,
        "dashboard:admin",
        TokenScope::default(),
        TokenRole::Admin,
        ttl,
    );
    let expires_at =
        (Utc::now() + chrono::Duration::seconds(ttl)).to_rfc3339_opts(SecondsFormat::Millis, true);
    Json(json!({
        "token": token,
        "expiresAt": expires_at,
        "role": "admin",
        "username": login.username,
    }))
    .into_response()
}

pub async fn sso_start() -> Response {
    (
        StatusCode::from_u16(501).expect("valid status"),
        Json(json!({"error": "SSO login is not configured", "provider": "sso"})),
    )
        .into_response()
}

pub async fn sso_callback() -> Response {
    (
        StatusCode::from_u16(501).expect("valid status"),
        Json(json!({"error": "SSO callback is not configured", "provider": "sso"})),
    )
        .into_response()
}

pub async fn saml_start() -> Response {
    (
        StatusCode::from_u16(501).expect("valid status"),
        Json(json!({"error": "SAML login is not configured", "provider": "saml"})),
    )
        .into_response()
}

pub async fn saml_acs() -> Response {
    (
        StatusCode::from_u16(501).expect("valid status"),
        Json(json!({"error": "SAML ACS is not configured", "provider": "saml"})),
    )
        .into_response()
}

/// GET /api/auth/api-keys — list metadata-only API key records.
pub async fn list_api_keys(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Result<Json<Value>, Response> {
    require_admin_auth(&state, &peer, &headers)?;
    let api_keys = state
        .pool
        .read(|conn| api_keys::list_api_keys(conn).map_err(CoreError::from))
        .await
        .map_err(db_error)?;
    Ok(Json(json!({"apiKeys": api_keys})))
}

/// POST /api/auth/api-keys — create a metadata row and return the raw key once.
pub async fn create_api_key(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, Response> {
    require_admin_auth(&state, &peer, &headers)?;
    let payload = match json_body(body) {
        Ok(Value::Object(map)) => map,
        Ok(_) => return Err(invalid("invalid request body")),
        Err(resp) => return Err(resp),
    };
    let name = payload
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| invalid("name is required"))?
        .to_string();
    let role = parse_optional_role(payload.get("role"))?;
    let input = ApiKeyCreateInput {
        name,
        role,
        scope: parse_scope(payload.get("scope")),
        permissions: parse_permissions(payload.get("permissions")),
        connector: optional_string(payload.get("connector")),
        harness: optional_string(payload.get("harness")),
        agent_id: optional_string(payload.get("agentId")),
        allowed_projects: parse_string_array(payload.get("allowedProjects")),
        expires_at: optional_string(payload.get("expiresAt")),
    };
    let api_key = state
        .pool
        .write_tx(Priority::High, move |conn| {
            api_keys::create_api_key(conn, input)
                .map(|api_key| json!({"apiKey": api_key}))
                .map_err(CoreError::Invalid)
        })
        .await
        .map_err(|err| match err {
            CoreError::Invalid(message) => invalid(&message),
            other => db_error(other),
        })?;
    Ok((StatusCode::CREATED, Json(api_key)).into_response())
}

/// DELETE /api/auth/api-keys/:id — revoke a key by id or prefix.
pub async fn revoke_api_key(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Value>, Response> {
    require_admin_auth(&state, &peer, &headers)?;
    let revoked = state
        .pool
        .write_tx(Priority::High, move |conn| {
            api_keys::revoke_api_key(conn, &id)
                .map(|api_key| json!({"apiKey": api_key}))
                .map_err(CoreError::from)
        })
        .await
        .map_err(db_error)?;
    if revoked["apiKey"].is_null() {
        return Err((
            StatusCode::NOT_FOUND,
            Json(json!({"error": "API key not found"})),
        )
            .into_response());
    }
    Ok(Json(revoked))
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
