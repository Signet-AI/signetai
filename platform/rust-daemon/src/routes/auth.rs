use crate::{execute, ApiError, AppState};
use axum::{
    body::Bytes,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    routing::{delete, get, post},
    Json, Router,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use hmac::{Hmac, Mac};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::Sha256;
use std::{
    env, fs,
    path::Path as FsPath,
    time::{SystemTime, UNIX_EPOCH},
};
use time::{format_description::well_known::Rfc3339, OffsetDateTime};

type HmacSha256 = Hmac<Sha256>;

const MAX_BODY: usize = 64 * 1024;

pub(crate) fn load_secret(workspace: &FsPath) -> Option<Vec<u8>> {
    let secret = fs::read(workspace.join(".daemon").join("auth-secret")).ok()?;
    (secret.len() == 32).then_some(secret)
}

fn now_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

pub(crate) fn verify_token(state: &AppState, token: &str) -> Option<Value> {
    let secret = state.auth_secret.as_deref()?;
    let (payload, signature) = token.split_once('.')?;
    let signature = URL_SAFE_NO_PAD.decode(signature).ok()?;
    let mut mac = HmacSha256::new_from_slice(secret).ok()?;
    mac.update(payload.as_bytes());
    mac.verify_slice(&signature).ok()?;
    let payload = URL_SAFE_NO_PAD.decode(payload).ok()?;
    let claims: Value = serde_json::from_slice(&payload).ok()?;
    let role = claims.get("role")?.as_str()?;
    if !["admin", "operator", "agent", "readonly"].contains(&role) {
        return None;
    }
    let scope = claims.get("scope")?.as_object()?;
    let iat = claims.get("iat")?.as_u64()?;
    let exp = claims.get("exp")?.as_u64()?;
    if exp <= now_seconds() || iat > exp {
        return None;
    }
    let agent_id = scope.get("agent").and_then(Value::as_str);
    Some(json!({
        "authenticated": true,
        "sub": claims.get("sub"),
        "role": role,
        "scope": claims.get("scope"),
        "iat": iat,
        "exp": exp,
        "agentId": agent_id,
        "permissions": claims.get("permissions").cloned().unwrap_or_else(|| json!([])),
    }))
}

fn issue_token(
    secret: &[u8],
    subject: String,
    role: &str,
    scope: Value,
    ttl_seconds: u64,
) -> Result<(String, String), ApiError> {
    let now = now_seconds();
    let expires = now.saturating_add(ttl_seconds.clamp(1, 31_536_000));
    let claims = json!({
        "sub": subject,
        "role": role,
        "scope": scope,
        "iat": now,
        "exp": expires,
    });
    let payload = serde_json::to_vec(&claims)
        .map_err(|_| ApiError::unavailable("could not serialize auth token"))?;
    let encoded = URL_SAFE_NO_PAD.encode(payload);
    let mut mac = HmacSha256::new_from_slice(secret)
        .map_err(|_| ApiError::unavailable("auth secret is invalid"))?;
    mac.update(encoded.as_bytes());
    let token = format!(
        "{encoded}.{}",
        URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
    );
    let expires_at = OffsetDateTime::from_unix_timestamp(expires as i64)
        .map_err(|_| ApiError::unavailable("could not format token expiry"))?
        .format(&Rfc3339)
        .map_err(|_| ApiError::unavailable("could not format token expiry"))?;
    Ok((token, expires_at))
}
#[derive(Deserialize)]
struct KeyRequest {
    name: String,
    #[serde(default)]
    role: Option<String>,
    #[serde(default, alias = "agentId")]
    agent_id: Option<String>,
    #[serde(default, alias = "expiresAt")]
    expires_at: Option<String>,
    #[serde(default = "empty_object")]
    scope: Value,
    #[serde(default)]
    permissions: Vec<String>,
    #[serde(default)]
    connector: Option<String>,
    #[serde(default)]
    harness: Option<String>,
    #[serde(default, alias = "allowedProjects")]
    allowed_projects: Vec<String>,
}
#[derive(Deserialize)]
struct TokenRequest {
    role: String,
    #[serde(default = "empty_object")]
    scope: Value,
    #[serde(default, alias = "ttlSeconds")]
    ttl_seconds: Option<u64>,
}
fn empty_object() -> Value {
    json!({})
}

pub(crate) fn router() -> Router<AppState> {
    routes()
}
pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/auth/methods", get(methods))
        .route("/api/auth/sso/start", get(unsupported_sso))
        .route("/api/auth/sso/callback", get(unsupported_sso))
        .route("/api/auth/saml/start", get(unsupported_saml))
        .route("/api/auth/saml/acs", post(unsupported_saml))
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
fn role_rank(role: &str) -> Option<u8> {
    match role {
        "readonly" => Some(0),
        "agent" => Some(1),
        "operator" => Some(2),
        "admin" => Some(3),
        _ => None,
    }
}

pub(crate) fn authority_allows(
    authority: &Value,
    requested_role: &str,
    requested_scope: &Value,
    requested_permissions: &[String],
) -> bool {
    let Some(authority_role) = authority
        .get("role")
        .and_then(Value::as_str)
        .and_then(role_rank)
    else {
        return false;
    };
    let Some(requested_rank) = role_rank(requested_role) else {
        return false;
    };
    if requested_rank > authority_role {
        return false;
    }
    let authority_scope = authority.get("scope").and_then(Value::as_object);
    let requested_scope = requested_scope.as_object();
    let authority_is_unscoped = authority_scope.is_none_or(|scope| scope.is_empty());
    if let (Some(parent), Some(child)) = (authority_scope, requested_scope) {
        if !authority_is_unscoped {
            for (key, value) in child {
                if let Some(parent_value) = parent.get(key) {
                    if parent_value != value {
                        return false;
                    }
                } else if key == "agent" || key == "workspace" {
                    return false;
                }
            }
        }
    } else if requested_scope.is_some() && !authority_is_unscoped && authority_role < 3 {
        return false;
    }
    let allowed = authority.get("permissions").and_then(Value::as_array);
    if let Some(allowed) = allowed {
        if !requested_permissions.iter().all(|permission| {
            allowed
                .iter()
                .any(|value| value.as_str() == Some(permission))
        }) {
            return false;
        }
    }
    true
}

fn configured_credential() -> Option<String> {
    env::var("SIGNET_API_KEY")
        .ok()
        .filter(|value| !value.is_empty())
        .or_else(|| {
            env::var("SIGNET_TOKEN")
                .ok()
                .filter(|value| !value.is_empty())
        })
}
pub(crate) async fn gate(state: &AppState, headers: &HeaderMap) -> Result<Value, ApiError> {
    let token = credential(headers).ok_or_else(|| {
        ApiError::unauthorized("valid Bearer token or x-signet-api-key is required")
    })?;
    if configured_credential().as_deref() == Some(token.as_str()) {
        let agent_id = headers
            .get("x-signet-agent")
            .and_then(|value| value.to_str().ok())
            .filter(|value| !value.is_empty())
            .map(str::to_owned);
        return Ok(json!({
            "authenticated": true,
            "agentId": agent_id,
            "role": "admin",
            "scope": {}
        }));
    }
    if let Some(claims) = verify_token(state, &token) {
        return Ok(claims);
    }
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

async fn unsupported_sso() -> Result<Json<Value>, ApiError> {
    Err(ApiError {
        status: StatusCode::NOT_IMPLEMENTED,
        code: "unsupported",
        message: "SSO login is not configured".into(),
    })
}
async fn unsupported_saml() -> Result<Json<Value>, ApiError> {
    Err(ApiError {
        status: StatusCode::NOT_IMPLEMENTED,
        code: "unsupported",
        message: "SAML login is not configured".into(),
    })
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
    if role_rank(&req.role).is_none() {
        return Err(ApiError::bad_request("invalid role"));
    }
    let requested_agent = req.scope.get("agent").and_then(Value::as_str);
    if let Some(authority_agent) = claims.get("agentId").and_then(Value::as_str) {
        if requested_agent.is_some_and(|agent| agent != authority_agent) {
            return Err(ApiError::unauthorized(
                "requested scope exceeds authenticated authority",
            ));
        }
    }
    if !authority_allows(&claims, &req.role, &req.scope, &[]) {
        return Err(ApiError {
            status: StatusCode::FORBIDDEN,
            code: "forbidden",
            message: "requested token authority exceeds authenticated authority".to_owned(),
        });
    }
    let secret = state
        .auth_secret
        .as_deref()
        .ok_or_else(|| ApiError::bad_request("auth secret is unavailable"))?;
    let subject = claims
        .get("sub")
        .and_then(Value::as_str)
        .unwrap_or("signet-token")
        .to_owned();
    let (token, expires_at) = issue_token(
        secret,
        subject,
        &req.role,
        req.scope,
        req.ttl_seconds.unwrap_or(3_600),
    )?;
    Ok(Json(json!({"token":token,"expiresAt":expires_at})))
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
    let connector = req.connector;
    let harness = req.harness.or_else(|| connector.clone());
    let permissions = if req.permissions.is_empty() && (connector.is_some() || harness.is_some()) {
        vec![
            "recall".to_owned(),
            "remember".to_owned(),
            "documents".to_owned(),
        ]
    } else {
        req.permissions
    };
    let requested_role = req.role.unwrap_or_else(|| "agent".into());
    if !authority_allows(&claims, &requested_role, &req.scope, &permissions) {
        return Err(ApiError::unauthorized(
            "requested key authority exceeds authenticated authority",
        ));
    }
    let result = execute(
        &state,
        signet_core_native::Operation::AuthKeyCreate {
            agent_id: agent_id.to_owned(),
            name: req.name,
            role: requested_role,
            scope: req.scope,
            permissions: Value::Array(permissions.into_iter().map(Value::String).collect()),
            connector,
            harness,
            allowed_projects: Value::Array(
                req.allowed_projects
                    .into_iter()
                    .map(Value::String)
                    .collect(),
            ),
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
