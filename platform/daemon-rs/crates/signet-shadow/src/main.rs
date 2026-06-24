//! Shadow replay proxy.
//!
//! Sits in front of the TS daemon (primary, :3850) and Rust daemon (shadow, :3851).
//! Forwards every request to both, compares responses, logs divergences.
//!
//! Usage:
//!   signet-shadow                    # defaults: proxy on :3849, primary :3850, shadow :3851
//!   signet-shadow --proxy-port 3849 --primary-port 3850 --shadow-port 3851

mod compare;
mod divergence;
mod snapshot;

use std::sync::Arc;
use std::time::Instant;

use axum::{
    Router,
    body::Body,
    extract::State,
    http::{Method, Request, StatusCode},
    response::{IntoResponse, Response},
};
use tokio::signal;
use tracing::{error, info, warn};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

struct ProxyConfig {
    proxy_port: u16,
    primary_host: String,
    shadow_host: String,
    log_path: std::path::PathBuf,
    internal_state: Option<InternalStateConfig>,
}

#[derive(Clone)]
struct InternalStateConfig {
    primary_path: std::path::PathBuf,
    shadow_path: std::path::PathBuf,
    selector: compare::InternalStateSelector,
}

impl ProxyConfig {
    fn from_args() -> Self {
        let args: Vec<String> = std::env::args().collect();
        let proxy_port = flag_val(&args, "--proxy-port").unwrap_or(3849);
        let primary_port: u16 = flag_val(&args, "--primary-port").unwrap_or(3850);
        let shadow_port: u16 = flag_val(&args, "--shadow-port").unwrap_or(3851);
        let primary_host = flag_str(&args, "--primary-host")
            .unwrap_or_else(|| format!("http://localhost:{primary_port}"));
        let shadow_host = flag_str(&args, "--shadow-host")
            .unwrap_or_else(|| format!("http://localhost:{shadow_port}"));

        let log_dir = dirs_log();
        let log_path = log_dir.join("shadow-divergences.jsonl");
        let internal_state = internal_state_config(&args);

        Self {
            proxy_port,
            primary_host,
            shadow_host,
            log_path,
            internal_state,
        }
    }
}

/// Sanitize client-supplied x-request-id: ALWAYS hash to prevent any
/// secret-looking value (e.g. sk-aaa...) from leaking into the divergence log.
fn sanitize_request_id(raw: &str) -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut hasher = DefaultHasher::new();
    raw.hash(&mut hasher);
    format!("[req:{:016x}]", hasher.finish())
}

fn flag_val<T: std::str::FromStr>(args: &[String], name: &str) -> Option<T> {
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1))
        .and_then(|v| v.parse().ok())
}

fn flag_str(args: &[String], name: &str) -> Option<String> {
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1))
        .filter(|value| !value.starts_with("--"))
        .cloned()
}

fn flag_present(args: &[String], name: &str) -> bool {
    args.iter().any(|arg| arg == name)
}

fn internal_state_config(args: &[String]) -> Option<InternalStateConfig> {
    let selector_value = flag_str(args, "--internal-state")
        .or_else(|| flag_present(args, "--internal-state").then(|| "all".to_string()))
        .or_else(|| std::env::var("SIGNET_SHADOW_INTERNAL_STATE").ok());
    let selector = selector_value
        .as_deref()
        .and_then(compare::InternalStateSelector::from_value)?;
    let primary_path = flag_str(args, "--primary-signet-path")
        .or_else(|| std::env::var("SIGNET_SHADOW_PRIMARY_PATH").ok())
        .map(std::path::PathBuf::from)?;
    let shadow_path = flag_str(args, "--shadow-signet-path")
        .or_else(|| std::env::var("SIGNET_SHADOW_SHADOW_PATH").ok())
        .or_else(|| std::env::var("SIGNET_SHADOW_PATH").ok())
        .map(std::path::PathBuf::from)?;

    Some(InternalStateConfig {
        primary_path,
        shadow_path,
        selector,
    })
}

fn dirs_log() -> std::path::PathBuf {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_else(|_| ".".into());
    let base = std::env::var("SIGNET_PATH").unwrap_or_else(|_| format!("{home}/.agents"));
    let dir = std::path::PathBuf::from(base).join(".daemon/logs");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

struct ProxyState {
    client: reqwest::Client,
    primary: String,
    shadow: String,
    logger: divergence::DivergenceLogger,
    rules: compare::ParityRules,
    internal_state: Option<InternalStateConfig>,
}

// ---------------------------------------------------------------------------
// Proxy handler
// ---------------------------------------------------------------------------

async fn proxy(State(state): State<Arc<ProxyState>>, req: Request<Body>) -> Response {
    let method = req.method().clone();
    let uri = req.uri().clone();
    let path = uri.path().to_string();
    let query = uri.query().map(|q| q.to_string());

    // Read body once, clone for shadow
    let (parts, body) = req.into_parts();
    let body_bytes = match axum::body::to_bytes(body, 10 * 1024 * 1024).await {
        Ok(b) => b,
        Err(e) => {
            error!(%e, "failed to read request body");
            return StatusCode::BAD_REQUEST.into_response();
        }
    };

    let headers = parts.headers.clone();
    let primary_url = build_url(&state.primary, &path, query.as_deref());
    let shadow_url = build_url(&state.shadow, &path, query.as_deref());

    // Forward to primary (blocking — this is the user-facing response)
    let primary_start = Instant::now();
    let primary_result = forward(
        &state.client,
        &method,
        &primary_url,
        &headers,
        body_bytes.clone(),
    )
    .await;
    let primary_elapsed = primary_start.elapsed();

    // Forward to primary first, extract what we need for the response
    let (primary_status, primary_body, primary_ct, primary_json) = match primary_result {
        Ok(resp) => (
            resp.status,
            resp.body_bytes,
            resp.content_type,
            resp.body_json,
        ),
        Err(e) => {
            error!(%e, "primary request failed");
            return StatusCode::BAD_GATEWAY.into_response();
        }
    };

    // Build a ForwardResponse snapshot for shadow comparison
    let primary_snapshot = ForwardResponse {
        status: primary_status,
        body_bytes: primary_body.clone(),
        body_json: primary_json,
        content_type: primary_ct.clone(),
    };

    // Forward to shadow (non-blocking — fire and compare)
    let shadow_body = body_bytes.clone();
    let shadow_state = state.clone();
    let shadow_method = method.clone();
    let shadow_headers = headers.clone();
    let shadow_path = path.clone();
    // #7 REVIEW FIX: allowlist x-request-id shape (alphanumeric + dash, max 128)
    // to prevent client-supplied secrets/tokens from being logged verbatim.
    let request_id = headers
        .get("x-request-id")
        .and_then(|value| value.to_str().ok())
        .map(|raw| sanitize_request_id(raw));

    tokio::spawn(async move {
        let shadow_start = Instant::now();
        let shadow_result = forward(
            &shadow_state.client,
            &shadow_method,
            &shadow_url,
            &shadow_headers,
            shadow_body,
        )
        .await;
        let shadow_elapsed = shadow_start.elapsed();

        let endpoint = format!("{} {}", shadow_method, shadow_path);

        match shadow_result {
            Ok(shadow) => {
                let mut divergences =
                    shadow_state
                        .rules
                        .compare(&endpoint, &primary_snapshot, &shadow);
                let mut internal_compared = false;
                let mut snapshot_errors = Vec::new();

                if let Some(internal) = &shadow_state.internal_state {
                    let tables = shadow_state
                        .rules
                        .internal_table_specs(&endpoint, &internal.selector);
                    if !tables.is_empty() {
                        match (
                            snapshot::snapshot_workspace(&internal.primary_path, &tables),
                            snapshot::snapshot_workspace(&internal.shadow_path, &tables),
                        ) {
                            (Ok(primary_internal), Ok(shadow_internal)) => {
                                internal_compared = true;
                                divergences.extend(shadow_state.rules.compare_internal(
                                    &endpoint,
                                    &primary_internal,
                                    &shadow_internal,
                                ));
                            }
                            (primary_result, shadow_result) => {
                                if let Err(e) = primary_result {
                                    snapshot_errors.push(format!("primary snapshot failed: {e}"));
                                }
                                if let Err(e) = shadow_result {
                                    snapshot_errors.push(format!("shadow snapshot failed: {e}"));
                                }
                            }
                        }
                    }
                }

                if !divergences.is_empty() || !snapshot_errors.is_empty() {
                    let entry = divergence::DivergenceEntry {
                        timestamp: chrono::Utc::now().to_rfc3339(),
                        endpoint: endpoint.clone(),
                        primary_status: primary_snapshot.status,
                        shadow_status: shadow.status,
                        primary_latency_ms: primary_elapsed.as_millis() as u64,
                        shadow_latency_ms: shadow_elapsed.as_millis() as u64,
                        divergences,
                        request_id: request_id.clone(),
                        internal_compared,
                        snapshot_errors,
                    };

                    if let Err(e) = shadow_state.logger.log(&entry) {
                        error!(%e, "failed to log divergence");
                    }

                    warn!(
                        endpoint,
                        count = entry.divergences.len(),
                        internal = entry.internal_compared,
                        snapshot_errors = entry.snapshot_errors.len(),
                        "divergence detected"
                    );
                }
            }
            Err(e) => {
                warn!(%e, path = shadow_path, "shadow request failed");
                let entry = divergence::DivergenceEntry {
                    timestamp: chrono::Utc::now().to_rfc3339(),
                    endpoint,
                    primary_status: primary_snapshot.status,
                    shadow_status: 0,
                    primary_latency_ms: primary_elapsed.as_millis() as u64,
                    shadow_latency_ms: shadow_elapsed.as_millis() as u64,
                    divergences: vec![divergence::Divergence {
                        severity: divergence::Severity::Critical,
                        field: "connection".into(),
                        message: format!("shadow request failed: {e}"),
                        primary_value: None,
                        shadow_value: None,
                        category: None,
                        table: None,
                        key: None,
                        primary_json: None,
                        shadow_json: None,
                    }],
                    request_id,
                    internal_compared: false,
                    snapshot_errors: Vec::new(),
                };
                let _ = shadow_state.logger.log(&entry);
            }
        }
    });

    // Return primary response to caller
    let mut response = Response::builder().status(primary_status);
    if let Some(ct) = &primary_ct {
        response = response.header("content-type", ct.as_str());
    }
    response
        .body(Body::from(primary_body))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

// ---------------------------------------------------------------------------
// HTTP forwarding
// ---------------------------------------------------------------------------

struct ForwardResponse {
    status: u16,
    body_bytes: bytes::Bytes,
    body_json: Option<serde_json::Value>,
    content_type: Option<String>,
}

async fn forward(
    client: &reqwest::Client,
    method: &Method,
    url: &str,
    headers: &axum::http::HeaderMap,
    body: bytes::Bytes,
) -> Result<ForwardResponse, reqwest::Error> {
    let mut req = client.request(method.clone(), url);

    // Forward relevant headers
    for (name, value) in headers.iter() {
        let n = name.as_str();
        if n == "host" || n == "connection" || n == "transfer-encoding" {
            continue;
        }
        req = req.header(name.clone(), value.clone());
    }

    if !body.is_empty() {
        req = req.body(body);
    }

    let resp = req.send().await?;
    let status = resp.status().as_u16();
    let content_type = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());

    let body_bytes = resp.bytes().await?;
    let body_json = serde_json::from_slice(&body_bytes).ok();

    Ok(ForwardResponse {
        status,
        body_bytes,
        body_json,
        content_type,
    })
}

fn build_url(base: &str, path: &str, query: Option<&str>) -> String {
    match query {
        Some(q) => format!("{base}{path}?{q}"),
        None => format!("{base}{path}"),
    }
}

// ---------------------------------------------------------------------------
// Analysis subcommand
// ---------------------------------------------------------------------------

fn run_analysis(path: &std::path::Path) {
    let content = match std::fs::read_to_string(path) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("failed to read {}: {e}", path.display());
            std::process::exit(1);
        }
    };

    let entries: Vec<divergence::DivergenceEntry> = content
        .lines()
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect();

    if entries.is_empty() {
        println!("No divergences found.");
        return;
    }

    let mut critical = 0u64;
    let mut expected = 0u64;
    let mut by_endpoint: std::collections::HashMap<String, (u64, u64)> =
        std::collections::HashMap::new();
    let mut status_mismatches = 0u64;

    for entry in &entries {
        if entry.primary_status != entry.shadow_status {
            status_mismatches += 1;
        }

        for d in &entry.divergences {
            match d.severity {
                divergence::Severity::Critical => {
                    critical += 1;
                    by_endpoint.entry(entry.endpoint.clone()).or_default().0 += 1;
                }
                divergence::Severity::Expected => {
                    expected += 1;
                    by_endpoint.entry(entry.endpoint.clone()).or_default().1 += 1;
                }
            }
        }
    }

    println!("=== Shadow Replay Divergence Report ===\n");
    println!("Total entries:       {}", entries.len());
    println!("Status mismatches:   {status_mismatches}");
    println!("Critical divergences: {critical}");
    println!("Expected divergences: {expected}");
    println!();

    if !by_endpoint.is_empty() {
        println!("By endpoint:");
        let mut sorted: Vec<_> = by_endpoint.into_iter().collect();
        sorted.sort_by(|a, b| b.1.0.cmp(&a.1.0));
        for (endpoint, (crit, exp)) in &sorted {
            let marker = if *crit > 0 { "!!" } else { "  " };
            println!("  {marker} {endpoint}: {crit} critical, {exp} expected");
        }
    }

    println!();
    if critical > 0 {
        println!("RESULT: FAIL — {critical} critical divergences must be fixed before cutover");

        // Show first 5 critical divergences
        println!("\nFirst critical divergences:");
        let mut shown = 0;
        for entry in &entries {
            for d in &entry.divergences {
                if matches!(d.severity, divergence::Severity::Critical) {
                    println!(
                        "  [{endpoint}] {field}: {msg}",
                        endpoint = entry.endpoint,
                        field = d.field,
                        msg = d.message,
                    );
                    if let Some(ref pv) = d.primary_value {
                        println!("    primary: {pv}");
                    }
                    if let Some(ref sv) = d.shadow_value {
                        println!("    shadow:  {sv}");
                    }
                    shown += 1;
                    if shown >= 5 {
                        break;
                    }
                }
            }
            if shown >= 5 {
                break;
            }
        }
    } else {
        println!("RESULT: PASS — no critical divergences");
    }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "signet_shadow=info".into()),
        )
        .init();

    let args: Vec<String> = std::env::args().collect();

    // Subcommand: analyze divergence log
    if args.iter().any(|a| a == "--analyze") {
        let log_path = flag_str(&args, "--log")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| dirs_log().join("shadow-divergences.jsonl"));
        run_analysis(&log_path);
        return Ok(());
    }

    let config = ProxyConfig::from_args();

    // Load parity rules
    let rules_path = std::env::var("SIGNET_PARITY_RULES")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| {
            // Look relative to the binary or fall back to default
            std::path::PathBuf::from("contracts/parity-rules.json")
        });
    let rules = compare::ParityRules::load(&rules_path).unwrap_or_else(|e| {
        warn!(%e, "failed to load parity rules, using defaults");
        compare::ParityRules::default()
    });

    let logger = divergence::DivergenceLogger::new(&config.log_path)?;

    info!(
        proxy_port = config.proxy_port,
        primary = %config.primary_host,
        shadow = %config.shadow_host,
        log = %config.log_path.display(),
        internal_state = config.internal_state.is_some(),
        "starting shadow replay proxy"
    );

    let state = Arc::new(ProxyState {
        client: reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()?,
        primary: config.primary_host,
        shadow: config.shadow_host,
        logger,
        rules,
        internal_state: config.internal_state,
    });

    // Catch-all router — every request gets proxied
    let app = Router::new().fallback(proxy).with_state(state);

    let bind = format!("127.0.0.1:{}", config.proxy_port);
    let listener = tokio::net::TcpListener::bind(&bind).await?;
    let addr = listener.local_addr()?;
    info!(%addr, "shadow proxy listening");

    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = signal::ctrl_c().await;
            info!("shutting down shadow proxy");
        })
        .await?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_url_with_query() {
        let url = build_url("http://localhost:3850", "/api/memories", Some("limit=10"));
        assert_eq!(url, "http://localhost:3850/api/memories?limit=10");
    }

    #[test]
    fn build_url_without_query() {
        let url = build_url("http://localhost:3850", "/health", None);
        assert_eq!(url, "http://localhost:3850/health");
    }

    #[test]
    fn default_ports() {
        // Verify the defaults are sensible
        assert_eq!(3849_u16, 3849); // proxy
        assert_eq!(3850_u16, 3850); // primary (TS)
        assert_eq!(3851_u16, 3851); // shadow (Rust)
    }
}
