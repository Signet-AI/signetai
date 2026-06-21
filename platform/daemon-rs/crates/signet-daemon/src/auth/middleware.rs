//! Axum middleware for auth: token validation, permission checks,
//! scope enforcement, and rate limiting.

use std::{net::SocketAddr, sync::Arc};

use axum::body::Body;
use axum::extract::{ConnectInfo, Request, State};
use axum::http::{HeaderMap, Method, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Json, Response};

use super::api_keys::{is_signet_api_key, verify_api_key_from_workspace};
use super::policy::{check_permission, check_scope};
use super::rate_limiter::AuthRateLimiter;
use super::tokens::verify_token;
use super::types::{AuthMode, AuthResult, Permission, TokenScope};
use crate::state::AppState;

// ---------------------------------------------------------------------------
// Auth state stored in request extensions
// ---------------------------------------------------------------------------

#[derive(Clone)]
pub struct AuthState {
    pub result: AuthResult,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn extract_bearer(headers: &HeaderMap) -> Option<&str> {
    let val = headers.get("authorization")?.to_str().ok()?;
    let token = val.strip_prefix("Bearer ")?;
    if token.is_empty() { None } else { Some(token) }
}

fn is_loopback_request(req: &Request<Body>) -> bool {
    req.extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|ConnectInfo(peer)| is_loopback_ip(peer.ip()))
        .unwrap_or(false)
}

/// True for loopback in any form: IPv4 127.0.0.0/8, IPv6 ::1, and the
/// IPv4-mapped IPv6 form ::ffff:127.0.0.1 (which `IpAddr::is_loopback` does
/// NOT catch). Mirrors the TS middleware + existing Rust route helpers.
pub fn is_loopback_ip(ip: std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v4) => v4.is_loopback(),
        std::net::IpAddr::V6(v6) => {
            v6.is_loopback() || v6.to_ipv4_mapped().is_some_and(|v4| v4.is_loopback())
        }
    }
}

pub fn is_auth_open_path(path: &str) -> bool {
    if path == "/health" {
        return true;
    }
    if matches!(
        path,
        "/api/auth/login" | "/api/auth/methods" | "/api/auth/whoami"
    ) {
        return true;
    }
    path.starts_with("/api/auth/sso/") || path.starts_with("/api/auth/saml/")
}

fn is_dashboard_request(req: &Request<Body>) -> bool {
    if !matches!(req.method(), &Method::GET | &Method::HEAD) {
        return false;
    }
    let path = req.uri().path();
    if path.starts_with("/api/")
        || path.starts_with("/memory/")
        || path == "/mcp"
        || path.starts_with("/v1/")
    {
        return false;
    }
    if path == "/" || path.contains('.') {
        return true;
    }
    req.headers()
        .get("accept")
        .and_then(|value| value.to_str().ok())
        .is_some_and(|accept| accept.contains("text/html"))
}

fn optional_auth_state(headers: &HeaderMap, secret: Option<&[u8]>) -> AuthState {
    if let (Some(token), Some(secret)) = (extract_bearer(headers), secret) {
        return AuthState {
            result: verify_token(secret, token),
        };
    }
    AuthState {
        result: AuthResult::unauthenticated(),
    }
}

// ---------------------------------------------------------------------------
// Auth config for middleware
// ---------------------------------------------------------------------------

#[derive(Clone)]
pub struct AuthConfig {
    pub mode: AuthMode,
    pub secret: Option<Vec<u8>>,
}

pub fn authenticate_headers(
    mode: AuthMode,
    secret: Option<&[u8]>,
    headers: &HeaderMap,
    is_local: bool,
) -> Result<AuthState, Box<Response>> {
    if mode == AuthMode::Local {
        return Ok(AuthState {
            result: AuthResult::unauthenticated(),
        });
    }

    if mode == AuthMode::Hybrid && is_local {
        let result = if let Some(token) = extract_bearer(headers) {
            if is_signet_api_key(token) {
                verify_api_key_from_workspace(token)
            } else if let Some(secret) = secret {
                verify_token(secret, token)
            } else {
                AuthResult::unauthenticated()
            }
        } else {
            AuthResult::unauthenticated()
        };

        return Ok(AuthState { result });
    }

    let Some(token) = extract_bearer(headers) else {
        return Err(Box::new(
            (
                StatusCode::UNAUTHORIZED,
                [("www-authenticate", "Bearer")],
                Json(serde_json::json!({"error": "authentication required"})),
            )
                .into_response(),
        ));
    };

    let result = if is_signet_api_key(token) {
        verify_api_key_from_workspace(token)
    } else {
        let Some(secret) = secret else {
            return Err(Box::new(
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(serde_json::json!({"error": "auth secret not configured"})),
                )
                    .into_response(),
            ));
        };
        verify_token(secret, token)
    };
    if !result.authenticated {
        let err = result.error.as_deref().unwrap_or("invalid token");
        return Err(Box::new(
            (
                StatusCode::UNAUTHORIZED,
                [("www-authenticate", "Bearer")],
                Json(serde_json::json!({"error": err})),
            )
                .into_response(),
        ));
    }

    Ok(AuthState { result })
}

// ---------------------------------------------------------------------------
// Auth middleware (validates token, sets AuthState in extensions)
// ---------------------------------------------------------------------------

pub async fn auth_middleware(
    State(state): State<Arc<AppState>>,
    mut req: Request<Body>,
    next: Next,
) -> Response {
    let auth_runtime = state.auth_snapshot();
    let is_local = is_loopback_request(&req);
    let auth = if is_auth_open_path(req.uri().path()) || is_dashboard_request(&req) {
        optional_auth_state(req.headers(), auth_runtime.secret.as_deref())
    } else {
        match authenticate_headers(
            auth_runtime.mode,
            auth_runtime.secret.as_deref(),
            req.headers(),
            is_local,
        ) {
            Ok(auth) => auth,
            Err(resp) => return *resp,
        }
    };

    // TS applies requirePermission("admin") to /api/repair/*, /api/troubleshoot/*,
    // and /api/secrets* before the handler (repair-routes.ts:81-85,
    // secrets-routes.ts:91-95). Enforce the same here in the global middleware
    // so every handler under these paths requires admin, not just basic auth.
    let path = req.uri().path();
    if is_admin_required_path(path) {
        if let Err(resp) =
            require_permission_guard(&auth, Permission::Admin, auth_runtime.mode, is_local)
        {
            return *resp;
        }
    }

    req.extensions_mut().insert(auth);
    next.run(req).await
}

/// Paths that require Permission::Admin in both TS and Rust. Mirrors TS
/// `app.use("/api/repair/*", requirePermission("admin"))` etc.
fn is_admin_required_path(path: &str) -> bool {
    path.starts_with("/api/repair/")
        || path.starts_with("/api/troubleshoot/")
        || path.starts_with("/api/secrets")
        // secrets sub-routes: /api/secrets, /api/secrets/:name, /api/secrets/exec, etc.
        || path == "/api/secrets"
        // #4 REVIEW FIX: TS requires admin for plugins and graphiq too.
        || path.starts_with("/api/plugins")
        || path.starts_with("/api/graphiq/")
}

// ---------------------------------------------------------------------------
// Permission guard (use as axum extractor or middleware)
// ---------------------------------------------------------------------------

pub fn require_permission_guard(
    auth_state: &AuthState,
    perm: Permission,
    mode: AuthMode,
    is_local: bool,
) -> Result<(), Box<Response>> {
    // Hybrid + localhost without token = full access
    if mode == AuthMode::Hybrid && is_local && !auth_state.result.authenticated {
        return Ok(());
    }

    let decision = check_permission(auth_state.result.claims.as_ref(), perm, mode);
    if !decision.allowed {
        return Err(Box::new(
            (
                StatusCode::FORBIDDEN,
                Json(serde_json::json!({"error": decision.reason.unwrap_or("forbidden".into())})),
            )
                .into_response(),
        ));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Scope guard
// ---------------------------------------------------------------------------

pub fn require_scope_guard(
    auth_state: &AuthState,
    target: &TokenScope,
    mode: AuthMode,
    is_local: bool,
) -> Result<(), Box<Response>> {
    if mode == AuthMode::Hybrid && is_local && !auth_state.result.authenticated {
        return Ok(());
    }

    let decision = check_scope(auth_state.result.claims.as_ref(), target, mode);
    if !decision.allowed {
        return Err(Box::new(
            (
                StatusCode::FORBIDDEN,
                Json(serde_json::json!({"error": decision.reason.unwrap_or("scope violation".into())})),
            )
                .into_response(),
        ));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Rate limit guard
// ---------------------------------------------------------------------------

pub fn require_rate_limit_guard(
    auth_state: &AuthState,
    operation: &str,
    limiter: &AuthRateLimiter,
    mode: AuthMode,
    actor_header: Option<&str>,
) -> Result<(), Box<Response>> {
    if mode == AuthMode::Local {
        return Ok(());
    }

    let actor = auth_state
        .result
        .claims
        .as_ref()
        .map(|c| c.sub.as_str())
        .or(actor_header)
        .unwrap_or("anonymous");

    let check = limiter.check_and_record(operation, actor);
    if !check.allowed {
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        let retry_after = check.reset_at.saturating_sub(now_ms) / 1000 + 1;

        let retry_str = retry_after.to_string();
        return Err(Box::new(
            (
                StatusCode::TOO_MANY_REQUESTS,
                [("retry-after", retry_str.as_str())],
                Json(serde_json::json!({
                    "error": "rate limit exceeded",
                    "retryAfter": check.reset_at,
                })),
            )
                .into_response(),
        ));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Agent scope resolution (mirrors TS resolveScopedAgent)
// ---------------------------------------------------------------------------

/// Resolve the effective agent_id for a request, applying scope enforcement
/// when auth is active. Mirrors TS `resolveScopedAgent()` in request-scope.ts.
///
/// - Local mode or hybrid+unauthenticated: pass-through, no enforcement.
/// - Otherwise: validate that the token's scope permits the requested agent.
///
/// Returns the resolved agent_id, or an error string for a 403 response.
pub fn resolve_scoped_agent(
    auth_state: &AuthState,
    mode: AuthMode,
    is_local: bool,
    requested: Option<&str>,
) -> Result<String, String> {
    let scoped = auth_state
        .result
        .claims
        .as_ref()
        .and_then(|c| c.scope.agent.as_deref());
    let agent_id = requested
        .filter(|s| !s.trim().is_empty())
        .or(scoped)
        .unwrap_or("default")
        .to_string();

    // No enforcement in local mode or hybrid without token
    if mode == AuthMode::Local {
        return Ok(agent_id);
    }
    if mode == AuthMode::Hybrid && is_local && !auth_state.result.authenticated {
        return Ok(agent_id);
    }

    let target = TokenScope {
        agent: Some(agent_id.clone()),
        project: None,
        user: None,
    };
    let decision = check_scope(auth_state.result.claims.as_ref(), &target, mode);
    if decision.allowed {
        Ok(agent_id)
    } else {
        Err(decision.reason.unwrap_or_else(|| "scope violation".into()))
    }
}
