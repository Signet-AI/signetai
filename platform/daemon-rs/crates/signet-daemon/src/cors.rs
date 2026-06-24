use std::sync::Arc;

use axum::{
    body::Body,
    extract::{Request, State},
    http::{
        HeaderMap, HeaderValue, Method, Response, StatusCode, Uri,
        header::{
            ACCESS_CONTROL_ALLOW_CREDENTIALS, ACCESS_CONTROL_ALLOW_HEADERS,
            ACCESS_CONTROL_ALLOW_METHODS, ACCESS_CONTROL_ALLOW_ORIGIN,
            ACCESS_CONTROL_REQUEST_HEADERS, CONTENT_LENGTH, CONTENT_TYPE, ORIGIN, VARY,
        },
    },
    middleware::Next,
};
use signet_core::config::{DaemonConfig, network_mode_from_bind};

use crate::state::AppState;

const ALLOWED_ORIGINS: [&str; 5] = [
    "http://localhost:3850",
    "http://127.0.0.1:3850",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "app://signet",
];
const DEFAULT_ALLOW_METHODS: &str = "GET,HEAD,PUT,POST,DELETE,PATCH";

pub async fn cors_middleware(
    State(state): State<Arc<AppState>>,
    req: Request<Body>,
    next: Next,
) -> Response<Body> {
    let origin = req
        .headers()
        .get(ORIGIN)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let request_headers = req
        .headers()
        .get(ACCESS_CONTROL_REQUEST_HEADERS)
        .and_then(|value| value.to_str().ok())
        .map(normalize_request_headers);
    let allow_origin = origin
        .as_deref()
        .filter(|origin| is_allowed_origin(&state.config, origin))
        .and_then(|origin| HeaderValue::from_str(origin).ok());

    if req.method() == Method::OPTIONS {
        let mut response = Response::new(Body::empty());
        *response.status_mut() = StatusCode::NO_CONTENT;
        apply_preflight_headers(response.headers_mut(), allow_origin, request_headers);
        return response;
    }

    let mut response = next.run(req).await;
    apply_simple_headers(response.headers_mut(), allow_origin);
    response
}

fn apply_simple_headers(headers: &mut HeaderMap, allow_origin: Option<HeaderValue>) {
    if let Some(origin) = allow_origin {
        headers.insert(ACCESS_CONTROL_ALLOW_ORIGIN, origin);
    }
    headers.insert(
        ACCESS_CONTROL_ALLOW_CREDENTIALS,
        HeaderValue::from_static("true"),
    );
    headers.append(VARY, HeaderValue::from_static("Origin"));
}

fn apply_preflight_headers(
    headers: &mut HeaderMap,
    allow_origin: Option<HeaderValue>,
    request_headers: Option<String>,
) {
    if let Some(origin) = allow_origin {
        headers.insert(ACCESS_CONTROL_ALLOW_ORIGIN, origin);
    }
    headers.insert(
        ACCESS_CONTROL_ALLOW_CREDENTIALS,
        HeaderValue::from_static("true"),
    );
    headers.append(VARY, HeaderValue::from_static("Origin"));
    headers.insert(
        ACCESS_CONTROL_ALLOW_METHODS,
        HeaderValue::from_static(DEFAULT_ALLOW_METHODS),
    );
    if let Some(headers_value) =
        request_headers.and_then(|value| HeaderValue::from_str(&value).ok())
    {
        headers.insert(ACCESS_CONTROL_ALLOW_HEADERS, headers_value);
        headers.append(
            VARY,
            HeaderValue::from_static("Access-Control-Request-Headers"),
        );
    }
    headers.remove(CONTENT_LENGTH);
    headers.remove(CONTENT_TYPE);
}

fn normalize_request_headers(headers: &str) -> String {
    headers
        .split(',')
        .map(str::trim)
        .filter(|header| !header.is_empty())
        .collect::<Vec<_>>()
        .join(",")
}

fn is_allowed_origin(config: &DaemonConfig, origin: &str) -> bool {
    if ALLOWED_ORIGINS.contains(&origin) {
        return true;
    }

    let bind = config.bind.as_deref().unwrap_or(&config.host);
    if network_mode_from_bind(bind) != "tailscale" {
        return false;
    }

    let Ok(uri) = origin.parse::<Uri>() else {
        return false;
    };
    let Some(scheme) = uri.scheme_str() else {
        return false;
    };
    if scheme != "http" && scheme != "https" {
        return false;
    }
    if origin_port(&uri, scheme) != Some(config.port) {
        return false;
    }
    let Some(host) = uri.host() else {
        return false;
    };
    let host = normalize_origin_host(host);
    if is_loopback_origin_host(&host) {
        return false;
    }
    is_tailscale_origin_host(&host)
}

fn origin_port(uri: &Uri, scheme: &str) -> Option<u16> {
    uri.port_u16().or(match scheme {
        "http" => Some(80),
        "https" => Some(443),
        _ => None,
    })
}

fn normalize_origin_host(host: &str) -> String {
    host.to_ascii_lowercase()
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_string()
}

fn is_loopback_origin_host(host: &str) -> bool {
    host == "localhost" || host == "::1" || host == "0:0:0:0:0:0:0:1" || host.starts_with("127.")
}

fn is_tailscale_origin_host(host: &str) -> bool {
    if host.ends_with(".ts.net") {
        return true;
    }
    if host.starts_with("fd7a:115c:a1e0:") {
        return true;
    }
    if !host.starts_with("100.") {
        return false;
    }
    let parts: Vec<&str> = host.split('.').collect();
    if parts.len() != 4 {
        return false;
    }
    parse_js_integer_prefix(parts[1]).is_some_and(|second| (64..=127).contains(&second))
}

fn parse_js_integer_prefix(value: &str) -> Option<i32> {
    let digits: String = value.chars().take_while(|ch| ch.is_ascii_digit()).collect();
    if digits.is_empty() {
        return None;
    }
    digits.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use signet_core::config::AgentManifest;

    fn config(port: u16, bind: &str) -> DaemonConfig {
        DaemonConfig {
            base_path: std::path::PathBuf::new(),
            db_path: std::path::PathBuf::new(),
            port,
            host: "127.0.0.1".to_string(),
            bind: Some(bind.to_string()),
            manifest: AgentManifest::default(),
        }
    }

    #[test]
    fn allowed_origin_rules_match_ts_state_helpers() {
        let tailscale = config(3850, "0.0.0.0");
        assert!(is_allowed_origin(&tailscale, "http://localhost:3850"));
        assert!(is_allowed_origin(&tailscale, "http://127.0.0.1:5173"));
        assert!(is_allowed_origin(&tailscale, "app://signet"));
        assert!(is_allowed_origin(&tailscale, "http://100.100.100.100:3850"));
        assert!(is_allowed_origin(
            &tailscale,
            "https://demo.tailnet.ts.net:3850"
        ));
        assert!(is_allowed_origin(
            &tailscale,
            "http://[fd7a:115c:a1e0::1]:3850"
        ));
        assert!(!is_allowed_origin(&tailscale, "http://example.com:3850"));
        assert!(!is_allowed_origin(&tailscale, "http://127.0.0.1:3851"));
        assert!(!is_allowed_origin(
            &config(3850, "127.0.0.1"),
            "http://100.100.100.100:3850"
        ));
    }
}
