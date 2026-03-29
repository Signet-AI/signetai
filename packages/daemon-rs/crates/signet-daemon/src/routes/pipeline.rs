//! Pipeline status and model management routes.

use std::net::{IpAddr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::Ordering;

use axum::{
    extract::{ConnectInfo, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Json, Response},
};
use serde_yml::{Mapping, Value};
use signet_core::config::PipelineV2Config;

use crate::auth::middleware::{
    authenticate_headers, require_permission_guard, require_rate_limit_guard,
};
use crate::auth::types::Permission;
use crate::state::AppState;

const PIPELINE_CONFIG_FILES: [&str; 3] = ["agent.yaml", "AGENT.yaml", "config.yaml"];

#[derive(Clone, Copy)]
struct PipelineMode {
    enabled: bool,
    frozen: bool,
    paused: bool,
    shadow: bool,
}

fn find_config_file(base: &Path) -> Option<PathBuf> {
    PIPELINE_CONFIG_FILES
        .iter()
        .map(|name| base.join(name))
        .find(|path| path.exists())
}

fn key(name: &str) -> Value {
    Value::String(name.to_string())
}

fn read_mapping<'a>(map: &'a Mapping, name: &str) -> Option<&'a Mapping> {
    map.get(&key(name)).and_then(Value::as_mapping)
}

fn read_bool(map: &Mapping, name: &str) -> Option<bool> {
    map.get(&key(name)).and_then(Value::as_bool)
}

fn read_pipeline_mode_from_value(
    value: &Value,
    fallback: Option<&PipelineV2Config>,
) -> PipelineMode {
    let fallback = fallback.cloned().unwrap_or_default();
    let mut mode = PipelineMode {
        enabled: fallback.enabled,
        paused: fallback.paused,
        frozen: fallback.mutations_frozen,
        shadow: fallback.shadow_mode,
    };

    let Some(root) = value.as_mapping() else {
        return mode;
    };
    let Some(mem) = read_mapping(root, "memory") else {
        return mode;
    };
    let Some(p2) = read_mapping(mem, "pipelineV2") else {
        return mode;
    };

    if let Some(enabled) = read_bool(p2, "enabled") {
        mode.enabled = enabled;
    }
    if let Some(paused) = read_bool(p2, "paused") {
        mode.paused = paused;
    }
    if let Some(frozen) = read_bool(p2, "mutationsFrozen") {
        mode.frozen = frozen;
    }
    if let Some(shadow) = read_bool(p2, "shadowMode") {
        mode.shadow = shadow;
    }

    mode
}

fn read_pipeline_mode(base: &Path, fallback: Option<&PipelineV2Config>) -> PipelineMode {
    let Some(path) = find_config_file(base) else {
        return read_pipeline_mode_from_value(&Value::Null, fallback);
    };
    let Ok(raw) = std::fs::read_to_string(path) else {
        return read_pipeline_mode_from_value(&Value::Null, fallback);
    };
    let Ok(value) = serde_yml::from_str::<Value>(&raw) else {
        return read_pipeline_mode_from_value(&Value::Null, fallback);
    };
    read_pipeline_mode_from_value(&value, fallback)
}

fn format_pipeline_mode(mode: PipelineMode) -> &'static str {
    if !mode.enabled {
        return "disabled";
    }
    if mode.paused {
        return "paused";
    }
    if mode.frozen {
        return "frozen";
    }
    if mode.shadow {
        return "shadow";
    }
    "controlled-write"
}

fn set_pipeline_paused(
    base: &Path,
    paused: bool,
    fallback: Option<&PipelineV2Config>,
) -> Result<(String, bool, PipelineMode), String> {
    let path = find_config_file(base)
        .ok_or_else(|| "No Signet config file found. Run `signet setup` first.".to_string())?;
    let raw = std::fs::read_to_string(&path).map_err(|err| err.to_string())?;
    let value = serde_yml::from_str::<Value>(&raw).map_err(|err| err.to_string())?;

    let mut root = match value {
        Value::Mapping(map) => map,
        _ => Mapping::new(),
    };
    let mut mem = match root.remove(&key("memory")) {
        Some(Value::Mapping(map)) => map,
        _ => Mapping::new(),
    };
    let mut p2 = match mem.remove(&key("pipelineV2")) {
        Some(Value::Mapping(map)) => map,
        _ => Mapping::new(),
    };

    let prev = read_bool(&p2, "paused").unwrap_or(false);
    p2.insert(key("paused"), Value::Bool(paused));
    mem.insert(key("pipelineV2"), Value::Mapping(p2));
    root.insert(key("memory"), Value::Mapping(mem));

    let next = Value::Mapping(root);
    let body = serde_yml::to_string(&next).map_err(|err| err.to_string())?;
    std::fs::write(&path, body).map_err(|err| err.to_string())?;

    Ok((
        path.to_string_lossy().to_string(),
        prev != paused,
        read_pipeline_mode_from_value(&next, fallback),
    ))
}

fn is_loopback(addr: &SocketAddr) -> bool {
    match addr.ip() {
        IpAddr::V4(ip) => ip.is_loopback(),
        IpAddr::V6(ip) => {
            ip.is_loopback()
                || ip
                    .to_ipv4_mapped()
                    .map(|mapped| mapped.is_loopback())
                    .unwrap_or(false)
        }
    }
}

fn live_pipeline_mode(state: &AppState) -> PipelineMode {
    let pipeline = state
        .config
        .manifest
        .memory
        .as_ref()
        .and_then(|m| m.pipeline_v2.as_ref());
    let mut mode = read_pipeline_mode(state.config.base_path.as_path(), pipeline);
    mode.paused = state.pipeline_paused();
    mode
}

fn build_embedding(
    state: &AppState,
) -> Option<Arc<dyn signet_pipeline::embedding::EmbeddingProvider>> {
    state
        .config
        .manifest
        .embedding
        .as_ref()
        .map(|cfg| signet_pipeline::embedding::from_config(cfg, None))
}

async fn apply_pause_state(state: &AppState, paused: bool) {
    state.pipeline_paused.store(paused, Ordering::SeqCst);
    let next = if paused { None } else { build_embedding(state) };
    *state.embedding.write().await = next;

    // Update extraction runtime state on pause/resume transitions,
    // mirroring the JS daemon's restartPipelineRuntime behavior.
    if paused {
        crate::stop_extraction_worker(state).await;
        crate::stop_summary_worker(state).await;
        crate::stop_synthesis_worker(state).await;

        // Pipeline pause disables extraction execution at runtime.
        // Preserve "blocked" and "disabled" states so write routes keep the
        // startup block guard active while paused.
        let mut guard = state.extraction_state.write().await;
        if let Some(es) = guard.as_mut() {
            if es.status != "disabled" && es.status != "blocked" {
                es.status = "paused".to_string();
                es.effective = "none".to_string();
                es.degraded = false;
                es.fallback_applied = false;
                es.reason = None;
                es.since = None;
            }
        }
    } else {
        // On resume, re-check provider availability and update status,
        // but do NOT dead-letter pending jobs — backlog accumulated during
        // an intentional pause should be preserved for draining.
        crate::resume_extraction_check(state).await;
        let _ = crate::start_extraction_worker(state).await;
        let _ = crate::start_summary_worker(state).await;
        let _ = crate::start_synthesis_worker(state).await;
    }
}

fn guard_admin(
    state: &AppState,
    headers: &HeaderMap,
    peer: &SocketAddr,
) -> Result<(), Box<Response>> {
    let is_local = is_loopback(peer);
    let auth = authenticate_headers(
        state.auth_mode,
        state.auth_secret.as_deref(),
        headers,
        is_local,
    )?;
    require_permission_guard(&auth, Permission::Admin, state.auth_mode, is_local)?;
    require_rate_limit_guard(
        &auth,
        "admin",
        &state.auth_admin_limiter,
        state.auth_mode,
        None,
    )?;
    Ok(())
}

/// GET /api/pipeline/status — pipeline worker and queue status.
pub async fn status(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    let queues = state
        .pool
        .read(|conn| {
            let memory_pending: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM memory_jobs WHERE status = 'pending'",
                    [],
                    |r| r.get(0),
                )
                .unwrap_or(0);
            let memory_leased: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM memory_jobs WHERE status = 'leased'",
                    [],
                    |r| r.get(0),
                )
                .unwrap_or(0);
            let memory_completed: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM memory_jobs WHERE status = 'completed'",
                    [],
                    |r| r.get(0),
                )
                .unwrap_or(0);
            let memory_failed: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM memory_jobs WHERE status = 'failed'",
                    [],
                    |r| r.get(0),
                )
                .unwrap_or(0);
            let memory_dead: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM memory_jobs WHERE status = 'dead'",
                    [],
                    |r| r.get(0),
                )
                .unwrap_or(0);

            let summary_pending: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM summary_jobs WHERE status = 'pending'",
                    [],
                    |r| r.get(0),
                )
                .unwrap_or(0);
            let summary_leased: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM summary_jobs WHERE status = 'leased'",
                    [],
                    |r| r.get(0),
                )
                .unwrap_or(0);
            let summary_completed: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM summary_jobs WHERE status = 'completed'",
                    [],
                    |r| r.get(0),
                )
                .unwrap_or(0);

            Ok(serde_json::json!({
                "memory": {
                    "pending": memory_pending,
                    "leased": memory_leased,
                    "completed": memory_completed,
                    "failed": memory_failed,
                    "dead": memory_dead,
                },
                "summary": {
                    "pending": summary_pending,
                    "leased": summary_leased,
                    "completed": summary_completed,
                }
            }))
        })
        .await
        .unwrap_or_else(|_| serde_json::json!({}));

    Json(serde_json::json!({
        "queues": queues,
        "mode": format_pipeline_mode(live_pipeline_mode(&state)),
        "predictor": {
            "running": false,
            "modelReady": false,
            "coldStartExited": false,
        },
    }))
}

/// GET /api/pipeline/models — list available LLM models.
pub async fn models(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    let extraction = state
        .config
        .manifest
        .memory
        .as_ref()
        .and_then(|m| m.pipeline_v2.as_ref())
        .map(|p| &p.extraction);

    let provider = extraction.map(|e| e.provider.as_str()).unwrap_or("ollama");
    let model = extraction.map(|e| e.model.as_str()).unwrap_or("qwen3:4b");

    Json(serde_json::json!({
        "models": [
            {
                "name": model,
                "provider": provider,
                "active": true,
            }
        ],
    }))
}

/// GET /api/pipeline/models/by-provider — models grouped by provider.
pub async fn models_by_provider(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    let extraction = state
        .config
        .manifest
        .memory
        .as_ref()
        .and_then(|m| m.pipeline_v2.as_ref())
        .map(|p| &p.extraction);

    let provider = extraction.map(|e| e.provider.as_str()).unwrap_or("ollama");
    let model = extraction.map(|e| e.model.as_str()).unwrap_or("qwen3:4b");

    let mut result = serde_json::Map::new();
    result.insert(
        provider.to_string(),
        serde_json::json!([{ "name": model, "active": true }]),
    );

    Json(serde_json::Value::Object(result))
}

/// POST /api/pipeline/models/refresh — refresh model registry.
pub async fn models_refresh(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    models(State(state)).await
}

pub async fn pause(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> impl IntoResponse {
    toggle_pause(state, headers, peer, true).await
}

pub async fn resume(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> impl IntoResponse {
    toggle_pause(state, headers, peer, false).await
}

async fn toggle_pause(
    state: Arc<AppState>,
    headers: HeaderMap,
    peer: SocketAddr,
    paused: bool,
) -> Response {
    if let Err(resp) = guard_admin(state.as_ref(), &headers, &peer) {
        return *resp;
    }

    if state.pipeline_transition.swap(true, Ordering::SeqCst) {
        return (
            StatusCode::CONFLICT,
            Json(serde_json::json!({
                "success": false,
                "error": "Pipeline transition already in progress",
            })),
        )
            .into_response();
    }

    let base = state.config.base_path.clone();
    let fallback = state
        .config
        .manifest
        .memory
        .as_ref()
        .and_then(|m| m.pipeline_v2.clone());

    let res = tokio::task::spawn_blocking(move || {
        set_pipeline_paused(base.as_path(), paused, fallback.as_ref())
    })
    .await;

    state.pipeline_transition.store(false, Ordering::SeqCst);

    match res {
        Ok(Ok((file, changed, _))) => {
            apply_pause_state(state.as_ref(), paused).await;
            (
                StatusCode::OK,
                Json(serde_json::json!({
                    "success": true,
                    "changed": changed,
                    "paused": paused,
                    "file": file,
                    "mode": format_pipeline_mode(live_pipeline_mode(&state)),
                })),
            )
                .into_response()
        }
        Ok(Err(err)) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({
                "success": false,
                "error": err,
            })),
        )
            .into_response(),
        Err(err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({
                "success": false,
                "error": err.to_string(),
            })),
        )
            .into_response(),
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::net::SocketAddr;
    use std::sync::Arc;
    use std::sync::atomic::Ordering;

    use axum::Router;
    use axum::body::{Body, to_bytes};
    use axum::extract::connect_info::ConnectInfo;
    use axum::http::{Method, Request, StatusCode};
    use axum::routing::{get, post};
    use signet_core::config::{
        AgentIdentity, AgentManifest, AuthConfig as ManifestAuthConfig, DaemonConfig,
        EmbeddingConfig, MemoryManifestConfig, PipelineV2Config, RateLimitConfig,
    };
    use signet_core::db::DbPool;
    use tempfile::{TempDir, tempdir};
    use tower::ServiceExt;

    use crate::auth::rate_limiter::{AuthRateLimiter, default_limits};
    use crate::auth::tokens::{create_token, generate_secret};
    use crate::auth::types::{AuthMode, TokenRole, TokenScope};
    use crate::state::AppState;

    use super::{
        find_config_file, format_pipeline_mode, pause, read_pipeline_mode, resume,
        set_pipeline_paused, status,
    };

    struct TestState {
        state: Arc<AppState>,
        secret: Option<Vec<u8>>,
        _dir: TempDir,
    }

    fn mode_name(mode: AuthMode) -> String {
        match mode {
            AuthMode::Local => "local",
            AuthMode::Team => "team",
            AuthMode::Hybrid => "hybrid",
        }
        .to_string()
    }

    fn build_state(mode: AuthMode, paused: bool, admin_max: u64) -> TestState {
        let dir = tempdir().expect("tempdir");
        let db = dir.path().join("memory").join("memories.db");
        std::fs::create_dir_all(db.parent().expect("db parent")).expect("create memory dir");
        std::fs::write(
            dir.path().join("agent.yaml"),
            format!(
                "memory:\n  pipelineV2:\n    enabled: true\n    paused: {}\n",
                if paused { "true" } else { "false" }
            ),
        )
        .expect("write config");

        let (pool, _writer) = DbPool::open(&db).expect("open db");

        let mut limits = HashMap::new();
        limits.insert(
            "admin".to_string(),
            RateLimitConfig {
                window_ms: Some(60_000),
                max: Some(admin_max),
            },
        );

        let manifest = AgentManifest {
            agent: AgentIdentity {
                name: "test-agent".to_string(),
                description: None,
                created: None,
                updated: None,
            },
            embedding: Some(EmbeddingConfig::default()),
            memory: Some(MemoryManifestConfig {
                database: None,
                vectors: None,
                session_budget: None,
                decay_rate: None,
                pipeline_v2: Some(PipelineV2Config {
                    paused,
                    ..Default::default()
                }),
            }),
            auth: Some(ManifestAuthConfig {
                method: "token".to_string(),
                chain_id: None,
                mode: Some(mode_name(mode)),
                rate_limits: Some(limits),
            }),
            ..Default::default()
        };

        let secret = if mode == AuthMode::Local {
            None
        } else {
            Some(generate_secret())
        };
        let embedding = if paused {
            None
        } else {
            manifest
                .embedding
                .as_ref()
                .map(|cfg| signet_pipeline::embedding::from_config(cfg, None))
        };

        let mut rules = default_limits();
        if let Some(rule) = rules.get_mut("admin") {
            rule.max = admin_max;
        }

        let state = Arc::new(AppState::new(
            DaemonConfig {
                base_path: dir.path().to_path_buf(),
                db_path: db,
                port: 3850,
                host: "127.0.0.1".to_string(),
                bind: Some("127.0.0.1".to_string()),
                manifest,
            },
            pool,
            embedding,
            None,
            mode,
            secret.clone(),
            AuthRateLimiter::from_rules(&rules),
        ));

        TestState {
            state,
            secret,
            _dir: dir,
        }
    }

    fn app(state: Arc<AppState>) -> Router {
        Router::new()
            .route("/pause", post(pause))
            .route("/resume", post(resume))
            .route("/status", get(status))
            .with_state(state)
    }

    async fn call(
        app: Router,
        method: Method,
        path: &str,
        peer: SocketAddr,
        token: Option<&str>,
    ) -> (StatusCode, serde_json::Value) {
        let mut req = Request::builder()
            .method(method)
            .uri(path)
            .body(Body::empty())
            .expect("build request");
        if let Some(token) = token {
            req.headers_mut().insert(
                "authorization",
                format!("Bearer {token}").parse().expect("auth header"),
            );
        }
        req.extensions_mut().insert(ConnectInfo(peer));

        let resp = app.oneshot(req).await.expect("send request");
        let status = resp.status();
        let body = to_bytes(resp.into_body(), usize::MAX)
            .await
            .expect("read body");
        let json = serde_json::from_slice(&body).expect("json body");
        (status, json)
    }

    #[test]
    fn finds_fallback_config_files() {
        let dir = tempdir().expect("tempdir");
        std::fs::write(
            dir.path().join("AGENT.yaml"),
            "memory:\n  pipelineV2:\n    paused: true\n",
        )
        .expect("write config");

        let file = find_config_file(dir.path()).expect("config file");

        assert!(file.ends_with("AGENT.yaml"));
    }

    #[test]
    fn writes_paused_state_and_reports_mode() {
        let dir = tempdir().expect("tempdir");
        let path = dir.path().join("agent.yaml");
        std::fs::write(&path, "memory:\n  pipelineV2:\n    enabled: true\n").expect("write config");

        let (file, changed, mode) =
            set_pipeline_paused(dir.path(), true, None).expect("toggle paused");
        let raw = std::fs::read_to_string(path).expect("read config");

        assert_eq!(file, dir.path().join("agent.yaml").to_string_lossy());
        assert!(changed);
        assert_eq!(format_pipeline_mode(mode), "paused");
        assert!(raw.contains("paused: true"));
    }

    #[test]
    fn reads_paused_mode_from_config_file() {
        let dir = tempdir().expect("tempdir");
        std::fs::write(
            dir.path().join("agent.yaml"),
            "memory:\n  pipelineV2:\n    enabled: true\n    paused: true\n",
        )
        .expect("write config");

        let mode = read_pipeline_mode(dir.path(), None);

        assert_eq!(format_pipeline_mode(mode), "paused");
    }

    #[tokio::test]
    async fn team_pause_requires_admin_token() {
        let test = build_state(AuthMode::Team, false, 10);
        let peer = SocketAddr::from(([10, 0, 0, 8], 9000));

        let (status, body) =
            call(app(test.state.clone()), Method::POST, "/pause", peer, None).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(body["error"], "authentication required");

        let secret = test.secret.as_ref().expect("team secret");
        let token = create_token(
            secret,
            "agent-1",
            TokenScope::default(),
            TokenRole::Agent,
            3600,
        );
        let (status, body) = call(
            app(test.state.clone()),
            Method::POST,
            "/pause",
            peer,
            Some(&token),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert!(
            body["error"]
                .as_str()
                .unwrap_or_default()
                .contains("permission")
        );
    }

    #[tokio::test]
    async fn pause_and_resume_flip_live_runtime_state() {
        let test = build_state(AuthMode::Local, false, 10);
        let peer = SocketAddr::from(([127, 0, 0, 1], 3850));

        assert!(test.state.embedding.read().await.is_some());
        assert!(!test.state.pipeline_paused());
        {
            let extraction = test.state.extraction_state.read().await;
            let extraction = extraction.as_ref().expect("initial extraction state");
            assert_eq!(extraction.status, "active");
            assert_eq!(extraction.effective, "ollama");
        }

        let (status, body) =
            call(app(test.state.clone()), Method::POST, "/pause", peer, None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["paused"], true);
        assert_eq!(body["mode"], "paused");
        assert!(test.state.pipeline_paused());
        assert!(test.state.embedding.read().await.is_none());
        {
            let extraction = test.state.extraction_state.read().await;
            let extraction = extraction.as_ref().expect("paused extraction state");
            assert_eq!(extraction.status, "paused");
            assert_eq!(extraction.effective, "none");
            assert!(!extraction.degraded);
            assert!(!extraction.fallback_applied);
            assert!(extraction.reason.is_none());
            assert!(extraction.since.is_none());
        }

        let (status, body) =
            call(app(test.state.clone()), Method::GET, "/status", peer, None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["mode"], "paused");

        let (status, body) =
            call(app(test.state.clone()), Method::POST, "/resume", peer, None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["paused"], false);
        assert_eq!(body["mode"], "controlled-write");
        assert!(!test.state.pipeline_paused());
        assert!(test.state.embedding.read().await.is_some());
        {
            let extraction = test.state.extraction_state.read().await;
            let extraction = extraction.as_ref().expect("resumed extraction state");
            assert_eq!(extraction.status, "active");
            assert_eq!(extraction.effective, "ollama");
            assert!(!extraction.degraded);
            assert!(!extraction.fallback_applied);
        }
    }

    #[tokio::test]
    async fn team_pause_rate_limits_admin_requests() {
        let test = build_state(AuthMode::Team, false, 1);
        let peer = SocketAddr::from(([10, 0, 0, 9], 9001));
        let secret = test.secret.as_ref().expect("team secret");
        let token = create_token(
            secret,
            "admin-1",
            TokenScope::default(),
            TokenRole::Admin,
            3600,
        );

        let (status, _) = call(
            app(test.state.clone()),
            Method::POST,
            "/pause",
            peer,
            Some(&token),
        )
        .await;
        assert_eq!(status, StatusCode::OK);

        let (status, body) = call(
            app(test.state.clone()),
            Method::POST,
            "/resume",
            peer,
            Some(&token),
        )
        .await;
        assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(body["error"], "rate limit exceeded");
    }

    #[tokio::test]
    async fn pause_returns_conflict_when_transition_is_active() {
        let test = build_state(AuthMode::Local, false, 10);
        let peer = SocketAddr::from(([127, 0, 0, 1], 3850));
        test.state.pipeline_transition.store(true, Ordering::SeqCst);

        let (status, body) =
            call(app(test.state.clone()), Method::POST, "/pause", peer, None).await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(body["error"], "Pipeline transition already in progress");
    }

    #[tokio::test]
    async fn pause_preserves_blocked_runtime_resolution_fields() {
        let test = build_state(AuthMode::Local, false, 10);
        let peer = SocketAddr::from(([127, 0, 0, 1], 3850));

        {
            let mut extraction = test.state.extraction_state.write().await;
            let extraction = extraction.as_mut().expect("initial extraction state");
            extraction.status = "blocked".to_string();
            extraction.effective = "none".to_string();
            extraction.degraded = true;
            extraction.fallback_applied = false;
            extraction.reason = Some("startup preflight failed".to_string());
            extraction.since = Some("2026-03-27T00:00:00Z".to_string());
        }

        let (status, body) =
            call(app(test.state.clone()), Method::POST, "/pause", peer, None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["paused"], true);

        let extraction = test.state.extraction_state.read().await;
        let extraction = extraction.as_ref().expect("paused extraction state");
        assert_eq!(extraction.status, "blocked");
        assert_eq!(extraction.effective, "none");
        assert!(extraction.degraded);
        assert!(!extraction.fallback_applied);
        assert_eq!(
            extraction.reason.as_deref(),
            Some("startup preflight failed")
        );
        assert_eq!(extraction.since.as_deref(), Some("2026-03-27T00:00:00Z"));
    }

    #[tokio::test]
    async fn pause_and_resume_manage_worker_handle_lifecycle() {
        let test = build_state(AuthMode::Local, false, 10);
        let peer = SocketAddr::from(([127, 0, 0, 1], 3850));

        assert!(test.state.extraction_worker_handle.lock().await.is_none());
        let started = crate::start_extraction_worker(test.state.as_ref()).await;
        assert!(started);
        assert!(test.state.extraction_worker_handle.lock().await.is_some());

        let (status, body) =
            call(app(test.state.clone()), Method::POST, "/pause", peer, None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["paused"], true);
        assert!(test.state.extraction_worker_handle.lock().await.is_none());

        let (status, body) =
            call(app(test.state.clone()), Method::POST, "/resume", peer, None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["paused"], false);
        assert!(test.state.extraction_worker_handle.lock().await.is_some());

        crate::stop_extraction_worker(test.state.as_ref()).await;
        assert!(test.state.extraction_worker_handle.lock().await.is_none());
    }
}
