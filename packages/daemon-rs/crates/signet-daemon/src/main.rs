use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Instant;

use anyhow::Context;
use axum::{Router, extract::State, response::Json, routing::get};
use chrono::{SecondsFormat, Utc};
use signet_core::config::{DaemonConfig, network_mode_from_bind};
use signet_core::db::DbPool;
use tokio::signal;
use tracing::{info, warn};

#[allow(dead_code)] // Auth module built but not wired into routes until later phases
mod auth;
mod feedback;
mod mcp;
mod routes;
mod service;
mod state;

use auth::rate_limiter::{AuthRateLimiter, RateLimitRule, default_limits};
use auth::tokens::load_or_create_secret;
use auth::types::AuthMode;
use state::{AppState, ExtractionRuntimeState, derive_initial_extraction_state};

fn read_auth_mode(config: &DaemonConfig) -> AuthMode {
    config
        .manifest
        .auth
        .as_ref()
        .and_then(|auth| auth.mode.as_deref())
        .map(AuthMode::from_str_lossy)
        .unwrap_or_default()
}

fn merge_rate_limits(config: &DaemonConfig) -> HashMap<String, RateLimitRule> {
    let mut rules = default_limits();

    let Some(auth) = config.manifest.auth.as_ref() else {
        return rules;
    };
    let Some(raw) = auth.rate_limits.as_ref() else {
        return rules;
    };

    for (name, cfg) in raw {
        let Some(rule) = rules.get_mut(name) else {
            continue;
        };
        if let Some(window_ms) = cfg.window_ms.filter(|n| *n > 0) {
            rule.window_ms = window_ms;
        }
        if let Some(max) = cfg.max.filter(|n| *n > 0) {
            rule.max = max;
        }
    }

    rules
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().collect();

    // Service management subcommands (no logging needed)
    if args.iter().any(|a| a == "--install-service") {
        let config = DaemonConfig::from_env().map_err(anyhow::Error::msg)?;
        service::install(config.port)?;
        println!("signet service installed (port {})", config.port);
        return Ok(());
    }
    if args.iter().any(|a| a == "--uninstall-service") {
        service::uninstall()?;
        println!("signet service uninstalled");
        return Ok(());
    }
    if args.iter().any(|a| a == "--service-status") {
        let installed = service::is_installed();
        let running = service::is_running();
        println!("installed={installed} running={running}",);
        return Ok(());
    }

    // Initialize logging
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "signet_daemon=info,signet_core=info".into()),
        )
        .json()
        .init();

    // Load config
    let config = DaemonConfig::from_env().map_err(anyhow::Error::msg)?;

    // --check-migrations: open DB, run migrations, exit (for benchmarking startup)
    if args.iter().any(|a| a == "--check-migrations") {
        let start = Instant::now();
        std::fs::create_dir_all(config.memory_dir())?;
        let (_pool, _handle) = DbPool::open(&config.db_path).context("failed to open database")?;
        let elapsed = start.elapsed();
        info!(
            elapsed_ms = elapsed.as_millis(),
            "migrations check complete"
        );
        println!("ok ({}ms)", elapsed.as_millis());
        return Ok(());
    }

    info!(
        port = config.port,
        host = %config.host,
        bind = %config.bind.as_deref().unwrap_or(&config.host),
        db = %config.db_path.display(),
        base = %config.base_path.display(),
        "starting signet daemon"
    );

    // Ensure directories
    std::fs::create_dir_all(config.memory_dir())?;
    std::fs::create_dir_all(config.logs_dir())?;

    // Open database (runs migrations, starts writer task)
    let (pool, writer_handle) = DbPool::open(&config.db_path).context("failed to open database")?;

    // Initialize embedding provider
    let pipeline_paused = config
        .manifest
        .memory
        .as_ref()
        .and_then(|m| m.pipeline_v2.as_ref())
        .map(|p| p.paused)
        .unwrap_or(false);
    let embedding = if pipeline_paused {
        info!("pipeline paused; embedding provider startup deferred");
        None
    } else {
        config
            .manifest
            .embedding
            .as_ref()
            .map(|cfg| signet_pipeline::embedding::from_config(cfg, None))
    };

    let auth_mode = read_auth_mode(&config);
    let auth_secret = if auth_mode == AuthMode::Local {
        info!("auth mode local, admin routes unrestricted on loopback runtime");
        None
    } else {
        let path = config.base_path.join(".daemon").join("auth-secret");
        Some(load_or_create_secret(&path).context("failed to load auth secret")?)
    };
    let auth_admin_limiter = AuthRateLimiter::from_rules(&merge_rate_limits(&config));

    let extraction_worker_stats: Option<signet_pipeline::worker::SharedWorkerRuntimeStats> = None;

    // Build app state
    let state = Arc::new(AppState::new(
        config.clone(),
        pool,
        embedding,
        extraction_worker_stats,
        auth_mode,
        auth_secret,
        auth_admin_limiter,
    ));

    // Run extraction preflight synchronously before serving requests.
    // This matches the JS daemon's startup behavior and eliminates any
    // race between writes and provider validation.
    preflight_extraction(&state).await;

    // Start pipeline workers and wire their live runtime state into AppState.
    let _ = start_extraction_worker_inner(state.as_ref(), true).await;
    let _ = start_summary_worker(state.as_ref()).await;
    let _ = start_synthesis_worker(state.as_ref()).await;

    // Build router
    let app = Router::new()
        .route("/health", get(health))
        .route("/api/status", get(status))
        // Memory read routes
        .route("/api/memories", get(routes::memory::list))
        .route(
            "/api/memory/{id}",
            get(routes::memory::get).delete(routes::write::delete),
        )
        .route("/api/memory/{id}/history", get(routes::memory::history))
        // Search routes
        .route(
            "/api/memory/recall",
            axum::routing::post(routes::search::recall),
        )
        .route("/api/memory/search", get(routes::search::search_get))
        .route("/memory/search", get(routes::search::legacy_search))
        .route("/api/embeddings", get(routes::search::embeddings_stats))
        // Write routes
        .route(
            "/api/memory/remember",
            axum::routing::post(routes::write::remember),
        )
        .route(
            "/api/memory/save",
            axum::routing::post(routes::write::remember),
        )
        .route(
            "/api/hook/remember",
            axum::routing::post(routes::write::remember),
        )
        .route(
            "/api/memory/{id}/recover",
            axum::routing::post(routes::write::recover),
        )
        .route(
            "/api/memory/modify",
            axum::routing::post(routes::write::modify_batch),
        )
        .route(
            "/api/memory/feedback",
            axum::routing::post(routes::memory::feedback),
        )
        // Config routes
        .route(
            "/api/config",
            get(routes::config::get_config).post(routes::config::save_config),
        )
        .route("/api/harnesses", get(routes::harnesses::list))
        .route("/api/identity", get(routes::config::identity))
        .route("/api/features", get(routes::config::features))
        // Hook lifecycle routes
        .route(
            "/api/hooks/session-start",
            axum::routing::post(routes::hooks::session_start),
        )
        .route(
            "/api/hooks/user-prompt-submit",
            axum::routing::post(routes::hooks::prompt_submit),
        )
        .route(
            "/api/hooks/session-end",
            axum::routing::post(routes::hooks::session_end),
        )
        .route(
            "/api/hooks/remember",
            axum::routing::post(routes::hooks::remember),
        )
        .route(
            "/api/hooks/recall",
            axum::routing::post(routes::hooks::recall),
        )
        .route(
            "/api/hooks/pre-compaction",
            axum::routing::post(routes::hooks::pre_compaction),
        )
        .route(
            "/api/hooks/compaction-complete",
            axum::routing::post(routes::hooks::compaction_complete),
        )
        .route(
            "/api/hooks/session-checkpoint-extract",
            axum::routing::post(routes::hooks::session_checkpoint_extract),
        )
        // Agent roster routes (multi-agent support — migration 043)
        .route(
            "/api/agents",
            get(routes::agents::list).post(routes::agents::create),
        )
        .route(
            "/api/agents/{name}",
            get(routes::agents::get).delete(routes::agents::delete),
        )
        // Session routes
        .route("/api/sessions", get(routes::sessions::list))
        .route("/api/sessions/summaries", get(routes::sessions::summaries))
        .route(
            "/api/sessions/checkpoints",
            get(routes::sessions::checkpoints),
        )
        .route(
            "/api/sessions/checkpoints/latest",
            get(routes::sessions::checkpoint_latest),
        )
        .route("/api/sessions/{key}", get(routes::sessions::get))
        .route(
            "/api/sessions/{key}/bypass",
            axum::routing::post(routes::sessions::bypass),
        )
        // Knowledge graph routes
        .route(
            "/api/knowledge/entities",
            get(routes::knowledge::list_entities),
        )
        .route(
            "/api/knowledge/entities/pinned",
            get(routes::knowledge::list_pinned),
        )
        .route(
            "/api/knowledge/entities/{id}",
            get(routes::knowledge::get_entity_detail),
        )
        .route(
            "/api/knowledge/entities/{id}/aspects",
            get(routes::knowledge::get_aspects),
        )
        .route(
            "/api/knowledge/entities/{id}/aspects/{aspect_id}/attributes",
            get(routes::knowledge::get_attributes),
        )
        .route(
            "/api/knowledge/entities/{id}/dependencies",
            get(routes::knowledge::get_dependencies),
        )
        .route(
            "/api/knowledge/entities/{id}/pin",
            axum::routing::post(routes::knowledge::pin_entity)
                .delete(routes::knowledge::unpin_entity),
        )
        .route("/api/knowledge/stats", get(routes::knowledge::stats))
        .route(
            "/api/knowledge/constellation",
            get(routes::knowledge::constellation),
        )
        // Pipeline routes
        .route("/api/pipeline/status", get(routes::pipeline::status))
        .route(
            "/api/pipeline/pause",
            axum::routing::post(routes::pipeline::pause),
        )
        .route(
            "/api/pipeline/resume",
            axum::routing::post(routes::pipeline::resume),
        )
        .route("/api/pipeline/models", get(routes::pipeline::models))
        .route(
            "/api/pipeline/models/by-provider",
            get(routes::pipeline::models_by_provider),
        )
        .route(
            "/api/pipeline/models/refresh",
            axum::routing::post(routes::pipeline::models_refresh),
        )
        // Predictor routes
        .route("/api/predictor/status", get(routes::predictor::status))
        .route(
            "/api/predictor/comparisons",
            get(routes::predictor::comparisons),
        )
        .route(
            "/api/predictor/comparisons/by-project",
            get(routes::predictor::comparisons_by_project),
        )
        .route(
            "/api/predictor/comparisons/by-entity",
            get(routes::predictor::comparisons_by_entity),
        )
        .route("/api/predictor/training", get(routes::predictor::training))
        .route(
            "/api/predictor/training-pairs-count",
            get(routes::predictor::training_pairs_count),
        )
        .route(
            "/api/predictor/train",
            axum::routing::post(routes::predictor::train),
        )
        // Timeline routes
        .route("/api/memory/timeline", get(routes::timeline::activity))
        .route("/api/timeline/{id}", get(routes::timeline::incident))
        .route("/api/timeline/{id}/export", get(routes::timeline::export))
        // Repair routes
        .route(
            "/api/repair/requeue-dead",
            axum::routing::post(routes::repair::requeue_dead),
        )
        .route(
            "/api/repair/release-leases",
            axum::routing::post(routes::repair::release_leases),
        )
        .route(
            "/api/repair/check-fts",
            axum::routing::post(routes::repair::check_fts),
        )
        .route(
            "/api/repair/retention-sweep",
            axum::routing::post(routes::repair::retention_sweep),
        )
        .route(
            "/api/repair/embedding-gaps",
            get(routes::repair::embedding_gaps),
        )
        .route(
            "/api/repair/re-embed",
            axum::routing::post(routes::repair::re_embed),
        )
        .route(
            "/api/repair/resync-vec",
            axum::routing::post(routes::repair::resync_vec),
        )
        .route(
            "/api/repair/clean-orphans",
            axum::routing::post(routes::repair::clean_orphans),
        )
        .route("/api/repair/dedup-stats", get(routes::repair::dedup_stats))
        .route(
            "/api/repair/deduplicate",
            axum::routing::post(routes::repair::deduplicate),
        )
        .route(
            "/api/repair/backfill-skipped",
            axum::routing::post(routes::repair::backfill_skipped),
        )
        .route(
            "/api/repair/reclassify-entities",
            axum::routing::post(routes::repair::reclassify_entities),
        )
        .route(
            "/api/repair/prune-chunk-groups",
            axum::routing::post(routes::repair::prune_chunk_groups),
        )
        .route(
            "/api/repair/prune-singleton-entities",
            axum::routing::post(routes::repair::prune_singletons),
        )
        .route(
            "/api/repair/structural-backfill",
            axum::routing::post(routes::repair::structural_backfill),
        )
        .route("/api/repair/cold-stats", get(routes::repair::cold_stats))
        // MCP endpoint
        .route("/mcp", axum::routing::post(mcp::transport::handle))
        // Marketplace routes
        .route(
            "/api/marketplace/mcp",
            get(routes::marketplace::list_servers),
        )
        .route(
            "/api/marketplace/mcp/policy",
            get(routes::marketplace::get_policy).patch(routes::marketplace::set_policy),
        )
        .route(
            "/api/marketplace/mcp/tools",
            get(routes::marketplace::list_tools),
        )
        .route(
            "/api/marketplace/mcp/search",
            get(routes::marketplace::search_tools),
        )
        .route(
            "/api/marketplace/mcp/call",
            axum::routing::post(routes::marketplace::call_tool),
        )
        .route(
            "/api/marketplace/mcp/register",
            axum::routing::post(routes::marketplace::register_server),
        )
        .route(
            "/api/marketplace/mcp/browse",
            get(routes::marketplace::browse_catalog),
        )
        .route(
            "/api/marketplace/mcp/install",
            axum::routing::post(routes::marketplace::install_from_catalog),
        )
        .route(
            "/api/marketplace/mcp/test",
            axum::routing::post(routes::marketplace::test_config),
        )
        .route(
            "/api/marketplace/mcp/detail",
            get(routes::marketplace::catalog_detail),
        )
        .route(
            "/api/marketplace/mcp/{id}",
            get(routes::marketplace::get_server)
                .patch(routes::marketplace::update_server)
                .delete(routes::marketplace::delete_server),
        )
        // Secrets routes
        .route("/api/secrets", get(routes::secrets::list))
        .route(
            "/api/secrets/exec",
            axum::routing::post(routes::secrets::run_with_secrets),
        )
        .route(
            "/api/secrets/{name}",
            axum::routing::post(routes::secrets::put).delete(routes::secrets::delete),
        )
        // Scheduler routes
        .route(
            "/api/tasks",
            get(routes::scheduler::list).post(routes::scheduler::create),
        )
        .route(
            "/api/tasks/{id}",
            get(routes::scheduler::get)
                .patch(routes::scheduler::update)
                .delete(routes::scheduler::delete),
        )
        .route(
            "/api/tasks/{id}/run",
            axum::routing::post(routes::scheduler::trigger),
        )
        .route("/api/tasks/{id}/runs", get(routes::scheduler::runs))
        // Git routes
        .route("/api/git/status", get(routes::git::status))
        .route("/api/git/pull", axum::routing::post(routes::git::pull))
        .route("/api/git/push", axum::routing::post(routes::git::push))
        .route("/api/git/sync", axum::routing::post(routes::git::sync))
        .route(
            "/api/git/config",
            get(routes::git::get_config).post(routes::git::set_config),
        )
        // Cross-agent routes
        .route(
            "/api/cross-agent/presence",
            get(routes::crossagent::list_presence).post(routes::crossagent::upsert_presence),
        )
        .route(
            "/api/cross-agent/presence/{key}",
            axum::routing::delete(routes::crossagent::remove_presence),
        )
        .route(
            "/api/cross-agent/messages",
            get(routes::crossagent::list_messages).post(routes::crossagent::send_message),
        )
        // Connector routes
        .route(
            "/api/connectors",
            get(routes::connectors::list).post(routes::connectors::create),
        )
        .route(
            "/api/connectors/{id}",
            get(routes::connectors::get).delete(routes::connectors::delete),
        )
        .route(
            "/api/connectors/{id}/sync",
            axum::routing::post(routes::connectors::sync),
        )
        // Document routes
        .route(
            "/api/documents",
            get(routes::documents::list).post(routes::documents::ingest),
        )
        .route(
            "/api/documents/{id}",
            get(routes::documents::get).delete(routes::documents::delete),
        )
        .route("/api/documents/{id}/chunks", get(routes::documents::chunks))
        // Diagnostics routes
        .route("/api/diagnostics", get(routes::diagnostics::report))
        .route(
            "/api/diagnostics/{domain}",
            get(routes::diagnostics::domain),
        )
        .route("/api/logs", get(routes::diagnostics::logs))
        .route("/api/version", get(routes::diagnostics::version))
        .route("/api/update", get(routes::diagnostics::update_status))
        .with_state(state.clone());

    // Bind — use string form so "localhost" resolves via DNS
    let bind_host = config.bind.as_deref().unwrap_or(&config.host);
    let bind_addr = format!("{bind_host}:{}", config.port);

    let listener = tokio::net::TcpListener::bind(&bind_addr)
        .await
        .context("failed to bind")?;

    let addr = listener.local_addr()?;
    info!(%addr, "listening");

    // Serve with graceful shutdown
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown_signal())
    .await
    .context("server error")?;

    info!("shutting down");

    stop_synthesis_worker(state.as_ref()).await;
    stop_summary_worker(state.as_ref()).await;
    stop_extraction_worker(state.as_ref()).await;

    // Drop state to close DB channels, then await writer
    drop(state);
    let _ = writer_handle.await;

    info!("shutdown complete");
    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = async {
        signal::ctrl_c().await.expect("failed to listen for ctrl+c");
    };

    #[cfg(unix)]
    let terminate = async {
        signal::unix::signal(signal::unix::SignalKind::terminate())
            .expect("failed to listen for SIGTERM")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        () = ctrl_c => info!("received ctrl+c"),
        () = terminate => info!("received SIGTERM"),
    }
}

// ---------------------------------------------------------------------------
// Extraction provider startup preflight
// ---------------------------------------------------------------------------

/// Perform startup preflight checks on the extraction provider, mirroring the
/// JS daemon's startup-resolution contract. Updates `extraction_state` with
/// degraded/blocked status and dead-letters pending extraction jobs when blocked.
pub(crate) async fn preflight_extraction(state: &AppState) {
    extraction_probe(state, true, false).await;
}

/// Re-check extraction provider availability on resume. Updates status but
/// does NOT dead-letter pending jobs — backlog from an intentional pause
/// should be preserved for draining when the provider becomes available.
pub(crate) async fn resume_extraction_check(state: &AppState) {
    extraction_probe(state, false, true).await;
}

const DEFAULT_OLLAMA_EXTRACTION_MODEL: &str = "qwen3:4b";

fn resolve_runtime_extraction_model(
    effective_provider: &str,
    configured_provider: &str,
    configured_model: &str,
) -> String {
    if effective_provider == "ollama" && configured_provider != "ollama" {
        DEFAULT_OLLAMA_EXTRACTION_MODEL.to_string()
    } else {
        configured_model.to_string()
    }
}

fn resolve_runtime_extraction_endpoint(
    effective_provider: &str,
    configured_provider: &str,
    configured_endpoint: Option<&str>,
) -> Option<String> {
    if effective_provider == "ollama"
        && matches!(configured_provider, "anthropic" | "openrouter" | "opencode")
    {
        return None;
    }
    configured_endpoint
        .filter(|v| !v.is_empty())
        .map(|v| v.to_string())
}

fn worker_supports_extraction_provider(provider: &str) -> bool {
    matches!(provider, "ollama" | "anthropic")
}

fn provider_is_unsupported_for_daemon_startup_preflight(provider: &str) -> bool {
    matches!(provider, "openrouter")
}

async fn start_extraction_worker_inner(state: &AppState, dead_letter_on_blocked: bool) -> bool {
    {
        let handle = state.extraction_worker_handle.lock().await;
        if handle.is_some() {
            return true;
        }
    }

    let Some(pipeline) = state
        .config
        .manifest
        .memory
        .as_ref()
        .and_then(|m| m.pipeline_v2.as_ref())
    else {
        return false;
    };

    if !pipeline.enabled || pipeline.paused || state.pipeline_paused() {
        return false;
    }

    let mut effective_provider = {
        let guard = state.extraction_state.read().await;
        guard
            .as_ref()
            .map(|s| s.effective.clone())
            .unwrap_or_else(|| pipeline.extraction.provider.clone())
    };

    if effective_provider == "none" {
        return false;
    }

    if !worker_supports_extraction_provider(&effective_provider) {
        let now = chrono::Utc::now().to_rfc3339();
        let reason_prefix =
            format!("{effective_provider} is not supported by daemon-rs extraction worker");
        let fallback_provider = pipeline.extraction.fallback_provider.as_str();
        let ollama_fallback_endpoint = resolve_runtime_extraction_endpoint(
            "ollama",
            &pipeline.extraction.provider,
            pipeline.extraction.endpoint.as_deref(),
        );
        if fallback_provider == "ollama" && effective_provider != "ollama" {
            let ollama_ok = check_ollama_health(ollama_fallback_endpoint.as_deref()).await;
            if ollama_ok {
                *state.extraction_state.write().await = Some(ExtractionRuntimeState {
                    configured: Some(pipeline.extraction.provider.clone()),
                    resolved: pipeline.extraction.provider.clone(),
                    effective: "ollama".to_string(),
                    fallback_provider: fallback_provider.to_string(),
                    status: "degraded".to_string(),
                    degraded: true,
                    fallback_applied: true,
                    reason: Some(reason_prefix),
                    since: Some(now),
                });
                effective_provider = "ollama".to_string();
            } else {
                let reason = format!("{reason_prefix}; ollama fallback startup preflight failed");
                if dead_letter_on_blocked {
                    dead_letter_pending_extraction_jobs(state, &reason, &now).await;
                }
                *state.extraction_state.write().await = Some(ExtractionRuntimeState {
                    configured: Some(pipeline.extraction.provider.clone()),
                    resolved: pipeline.extraction.provider.clone(),
                    effective: "none".to_string(),
                    fallback_provider: fallback_provider.to_string(),
                    status: "blocked".to_string(),
                    degraded: true,
                    fallback_applied: false,
                    reason: Some(reason),
                    since: Some(now),
                });
                warn!(
                    provider = %effective_provider,
                    "extraction worker not started: provider unsupported and ollama fallback unavailable"
                );
                return false;
            }
        } else {
            let reason = if fallback_provider == "none" {
                format!("{reason_prefix}; fallbackProvider is none")
            } else {
                reason_prefix
            };
            if dead_letter_on_blocked {
                dead_letter_pending_extraction_jobs(state, &reason, &now).await;
            }
            *state.extraction_state.write().await = Some(ExtractionRuntimeState {
                configured: Some(pipeline.extraction.provider.clone()),
                resolved: pipeline.extraction.provider.clone(),
                effective: "none".to_string(),
                fallback_provider: fallback_provider.to_string(),
                status: "blocked".to_string(),
                degraded: true,
                fallback_applied: false,
                reason: Some(reason),
                since: Some(now),
            });
            warn!(
                provider = %effective_provider,
                "extraction worker not started: provider unsupported by daemon-rs worker"
            );
            return false;
        }
    }

    if !worker_supports_extraction_provider(&effective_provider) {
        warn!(
            provider = %effective_provider,
            "extraction worker not started: provider not supported by daemon-rs worker"
        );
        return false;
    }

    let api_key = if effective_provider == "anthropic" {
        std::env::var("ANTHROPIC_API_KEY")
            .ok()
            .filter(|k| !k.trim().is_empty())
    } else {
        None
    };

    if effective_provider == "anthropic" && api_key.is_none() {
        warn!("extraction worker not started: ANTHROPIC_API_KEY is missing");
        return false;
    }

    let runtime_model = resolve_runtime_extraction_model(
        &effective_provider,
        &pipeline.extraction.provider,
        &pipeline.extraction.model,
    );
    let runtime_endpoint = resolve_runtime_extraction_endpoint(
        &effective_provider,
        &pipeline.extraction.provider,
        pipeline.extraction.endpoint.as_deref(),
    );
    let provider_cfg = signet_pipeline::provider::LlmProviderConfig {
        provider: effective_provider.clone(),
        model: runtime_model,
        base_url: runtime_endpoint,
        api_key,
        timeout_ms: Some(pipeline.extraction.timeout),
    };
    let provider = signet_pipeline::provider::from_config(&provider_cfg);
    let semaphore = Arc::new(signet_pipeline::provider::LlmSemaphore::default());
    let worker_config = signet_pipeline::worker::WorkerConfig {
        poll_ms: pipeline.worker.poll_ms,
        max_retries: pipeline.worker.max_retries,
        lease_timeout_ms: pipeline.worker.lease_timeout_ms,
        max_load_per_cpu: pipeline.worker.max_load_per_cpu,
        overload_backoff_ms: pipeline.worker.overload_backoff_ms,
        extraction_timeout_ms: pipeline.extraction.timeout,
        extraction_max_tokens: 4096,
        min_confidence: pipeline.extraction.min_confidence,
        shadow_mode: pipeline.shadow_mode,
        graph_enabled: pipeline.graph.enabled,
        structural_enabled: pipeline.structural.enabled,
    };

    let handle =
        signet_pipeline::worker::start(state.pool.clone(), provider, semaphore, worker_config);
    let mut slot = state.extraction_worker_handle.lock().await;
    if slot.is_none() {
        let stats = handle.stats_handle();
        *slot = Some(handle);
        drop(slot);
        *state.extraction_worker_stats.write().await = Some(stats);
        true
    } else {
        drop(slot);
        handle.stop().await;
        true
    }
}

pub(crate) async fn start_extraction_worker(state: &AppState) -> bool {
    start_extraction_worker_inner(state, false).await
}

pub(crate) async fn stop_extraction_worker(state: &AppState) {
    let handle = {
        let mut slot = state.extraction_worker_handle.lock().await;
        slot.take()
    };

    if let Some(handle) = handle {
        handle.stop().await;
    }

    *state.extraction_worker_stats.write().await = None;
}

/// Resolve the API key env var for a given provider name.
fn api_key_for_provider(provider: &str) -> Option<String> {
    let var = match provider {
        "anthropic" => "ANTHROPIC_API_KEY",
        "openai" | "openrouter" => "OPENAI_API_KEY",
        _ => return None,
    };
    std::env::var(var).ok().filter(|v| !v.trim().is_empty())
}

pub(crate) async fn start_summary_worker(state: &AppState) -> bool {
    {
        let handle = state.summary_worker_handle.lock().await;
        if handle.is_some() {
            return true;
        }
    }

    let Some(pipeline) = state
        .config
        .manifest
        .memory
        .as_ref()
        .and_then(|memory| memory.pipeline_v2.as_ref())
    else {
        return false;
    };

    // Shadow mode workers run so that shadow sessions still produce canonical
    // --summary.md artifacts (matching TS daemon behavior).  Only a fully
    // disabled pipeline (enabled=false AND shadow_mode=false) skips the worker.
    if (!pipeline.enabled && !pipeline.shadow_mode) || pipeline.paused || state.pipeline_paused() {
        return false;
    }
    // Summary worker gates only on pipeline being active — session-end always
    // enqueues summary jobs and they must be consumed to write canonical
    // --summary.md artifacts. When no explicit provider is configured,
    // from_config falls back to Ollama so jobs are never stranded.

    let provider =
        signet_pipeline::provider::from_config(&signet_pipeline::provider::LlmProviderConfig {
            provider: pipeline.synthesis.provider.clone(),
            model: pipeline.synthesis.model.clone(),
            base_url: pipeline.synthesis.endpoint.clone(),
            api_key: api_key_for_provider(&pipeline.synthesis.provider),
            timeout_ms: Some(pipeline.synthesis.timeout),
        });
    let semaphore = Arc::new(signet_pipeline::provider::LlmSemaphore::default());
    let handle = signet_pipeline::summary::start(
        state.pool.clone(),
        provider,
        semaphore,
        signet_pipeline::summary::SummaryConfig {
            max_retries: pipeline.worker.max_retries,
            max_tokens: pipeline.synthesis.max_tokens as u32,
            timeout_ms: pipeline.synthesis.timeout,
            agents_dir: state.config.base_path.clone(),
            ..Default::default()
        },
    );

    let mut slot = state.summary_worker_handle.lock().await;
    if slot.is_none() {
        *slot = Some(handle);
        true
    } else {
        drop(slot);
        handle.stop().await;
        true
    }
}

pub(crate) async fn stop_summary_worker(state: &AppState) {
    let handle = {
        let mut slot = state.summary_worker_handle.lock().await;
        slot.take()
    };

    if let Some(handle) = handle {
        handle.stop().await;
    }
}

pub(crate) async fn start_synthesis_worker(state: &AppState) -> bool {
    {
        let handle = state.synthesis_worker_handle.lock().await;
        if handle.is_some() {
            return true;
        }
    }

    let Some(pipeline) = state
        .config
        .manifest
        .memory
        .as_ref()
        .and_then(|memory| memory.pipeline_v2.as_ref())
    else {
        return false;
    };

    // Mirror summary worker: allow shadow mode to run synthesis for parity.
    if (!pipeline.enabled && !pipeline.shadow_mode) || pipeline.paused || state.pipeline_paused() {
        return false;
    }
    if !pipeline.synthesis.enabled {
        return false;
    }
    // run_synthesis uses write_memory_projection (deterministic) and does not
    // call the LLM provider — provider is accepted by the API but unused.
    // Do not gate on provider == "none": installations without an LLM still
    // need the synthesis worker to refresh the projected MEMORY.md output.

    let provider =
        signet_pipeline::provider::from_config(&signet_pipeline::provider::LlmProviderConfig {
            provider: pipeline.synthesis.provider.clone(),
            model: pipeline.synthesis.model.clone(),
            base_url: pipeline.synthesis.endpoint.clone(),
            api_key: api_key_for_provider(&pipeline.synthesis.provider),
            timeout_ms: Some(pipeline.synthesis.timeout),
        });
    let semaphore = Arc::new(signet_pipeline::provider::LlmSemaphore::default());
    let handle = signet_pipeline::synthesis::start(
        state.pool.clone(),
        provider,
        semaphore,
        signet_pipeline::synthesis::SynthesisConfig {
            timeout_ms: pipeline.synthesis.timeout,
            max_tokens: pipeline.synthesis.max_tokens as u32,
            min_interval_secs: pipeline.synthesis.idle_gap_minutes.saturating_mul(60),
            agents_dir: state.config.base_path.to_string_lossy().to_string(),
            ..Default::default()
        },
    );

    let mut slot = state.synthesis_worker_handle.lock().await;
    if slot.is_none() {
        *slot = Some(handle);
        true
    } else {
        drop(slot);
        handle.stop().await;
        true
    }
}

pub(crate) async fn stop_synthesis_worker(state: &AppState) {
    let handle = {
        let mut slot = state.synthesis_worker_handle.lock().await;
        slot.take()
    };

    if let Some(handle) = handle {
        handle.stop().await;
    }
}

async fn extraction_probe(
    state: &AppState,
    dead_letter_on_blocked: bool,
    treat_worker_unsupported_as_unavailable: bool,
) {
    let pipeline = match state
        .config
        .manifest
        .memory
        .as_ref()
        .and_then(|m| m.pipeline_v2.as_ref())
    {
        Some(p) => p,
        None => return,
    };

    let extraction = &pipeline.extraction;

    // Skip preflight if pipeline is disabled, paused, or provider is "none"
    if !pipeline.enabled
        || extraction.provider == "none"
        || pipeline.paused
        || state.pipeline_paused()
    {
        *state.extraction_state.write().await = Some(derive_initial_extraction_state(
            &extraction.provider,
            &extraction.fallback_provider,
            pipeline.enabled,
            pipeline.paused || state.pipeline_paused(),
        ));
        return;
    }

    let provider = extraction.provider.as_str();
    let fallback_provider = extraction.fallback_provider.as_str();
    let now = chrono::Utc::now().to_rfc3339();

    let mut unavailability_reason: Option<String> = None;
    let available = if provider_is_unsupported_for_daemon_startup_preflight(provider)
        || (treat_worker_unsupported_as_unavailable
            && !worker_supports_extraction_provider(provider))
    {
        unavailability_reason = Some(format!(
            "{provider} is not supported by daemon-rs extraction worker"
        ));
        warn!(
            provider,
            "extraction preflight forcing fallback/block before provider probe: provider unsupported by daemon-rs worker"
        );
        false
    } else {
        match provider {
            "ollama" => check_ollama_health(extraction.endpoint.as_deref()).await,
            "claude-code" => cli_preflight("claude").await,
            "codex" => cli_preflight("codex").await,
            "anthropic" => check_anthropic_health(extraction.endpoint.as_deref()).await,
            "opencode" => check_opencode_health(extraction.endpoint.as_deref()).await,
            _ => {
                warn!(
                    provider,
                    "unknown extraction provider, assuming unavailable"
                );
                false
            }
        }
    };

    if available {
        // Provider is healthy — explicitly restore active state in case this
        // is a resume after a prior blocked/degraded state.
        let mut guard = state.extraction_state.write().await;
        if let Some(es) = guard.as_mut() {
            es.status = "active".to_string();
            es.effective = extraction.provider.clone();
            es.degraded = false;
            es.fallback_applied = false;
            es.reason = None;
            es.since = None;
        }
        return;
    }

    let reason_prefix = unavailability_reason
        .unwrap_or_else(|| format!("{provider} unavailable during extraction startup preflight"));
    info!(
        provider,
        "extraction provider unavailable, attempting fallback resolution"
    );

    // Try fallback to ollama if configured — use the configured endpoint
    // (mirrors JS daemon which resolves Ollama base URL from config)
    let ollama_fallback_endpoint =
        resolve_runtime_extraction_endpoint("ollama", provider, extraction.endpoint.as_deref());
    if fallback_provider == "ollama" && provider != "ollama" {
        let ollama_ok = check_ollama_health(ollama_fallback_endpoint.as_deref()).await;
        if ollama_ok {
            let new_state = ExtractionRuntimeState {
                configured: Some(extraction.provider.clone()),
                resolved: extraction.provider.clone(),
                effective: "ollama".to_string(),
                fallback_provider: fallback_provider.to_string(),
                status: "degraded".to_string(),
                degraded: true,
                fallback_applied: true,
                reason: Some(reason_prefix),
                since: Some(now),
            };
            *state.extraction_state.write().await = Some(new_state);
            warn!("extraction provider degraded, fell back to ollama");
            return;
        }
        // Ollama fallback also failed → blocked
        let new_state = ExtractionRuntimeState {
            configured: Some(extraction.provider.clone()),
            resolved: extraction.provider.clone(),
            effective: "none".to_string(),
            fallback_provider: fallback_provider.to_string(),
            status: "blocked".to_string(),
            degraded: true,
            fallback_applied: false,
            reason: Some(format!(
                "{reason_prefix}; ollama fallback startup preflight failed"
            )),
            since: Some(now.clone()),
        };
        let full_reason = format!("{reason_prefix}; ollama fallback startup preflight failed");
        *state.extraction_state.write().await = Some(new_state);
        if dead_letter_on_blocked {
            dead_letter_pending_extraction_jobs(state, &full_reason, &now).await;
        }
        warn!("extraction blocked: primary and ollama fallback both unavailable");
        return;
    }

    // No fallback or fallback is "none" → blocked
    let reason = if fallback_provider == "none" {
        format!("{reason_prefix}; fallbackProvider is none")
    } else {
        reason_prefix
    };
    let new_state = ExtractionRuntimeState {
        configured: Some(extraction.provider.clone()),
        resolved: extraction.provider.clone(),
        effective: "none".to_string(),
        fallback_provider: fallback_provider.to_string(),
        status: "blocked".to_string(),
        degraded: true,
        fallback_applied: false,
        reason: Some(reason.clone()),
        since: Some(now.clone()),
    };
    *state.extraction_state.write().await = Some(new_state);
    if dead_letter_on_blocked {
        dead_letter_pending_extraction_jobs(state, &reason, &now).await;
    }
    warn!("extraction blocked: provider unavailable with no viable fallback");
}

/// Check if the ollama HTTP server is reachable.
async fn check_ollama_health(endpoint: Option<&str>) -> bool {
    let base = endpoint
        .filter(|s| !s.is_empty())
        .unwrap_or("http://127.0.0.1:11434");
    let url = format!("{}/api/tags", base.trim_end_matches('/'));
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(2))
        .build();
    let Ok(client) = client else { return false };
    client
        .get(&url)
        .send()
        .await
        .map(|r: reqwest::Response| r.status().is_success())
        .unwrap_or(false)
}

/// Check if the OpenCode HTTP server is reachable.
async fn check_opencode_health(endpoint: Option<&str>) -> bool {
    let base = endpoint
        .filter(|s| !s.is_empty())
        .unwrap_or("http://127.0.0.1:4096");
    let url = format!("{}/health", base.trim_end_matches('/'));
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(2))
        .build();
    let Ok(client) = client else { return false };
    client
        .get(&url)
        .send()
        .await
        .map(|r: reqwest::Response| r.status().is_success())
        .unwrap_or(false)
}

fn normalize_endpoint_base(endpoint: Option<&str>, default_base: &str) -> String {
    endpoint
        .filter(|s| !s.is_empty())
        .unwrap_or(default_base)
        .trim_end_matches('/')
        .to_string()
}

fn append_api_path(base: &str, v1_path: &str, no_v1_path: &str) -> String {
    if base.ends_with("/v1") {
        format!("{base}{no_v1_path}")
    } else {
        format!("{base}{v1_path}")
    }
}

fn is_loopback_host(host: &str) -> bool {
    if host.eq_ignore_ascii_case("localhost") {
        return true;
    }
    let normalized = host
        .strip_prefix('[')
        .and_then(|s| s.strip_suffix(']'))
        .unwrap_or(host);
    normalized
        .parse::<std::net::IpAddr>()
        .map(|ip| ip.is_loopback())
        .unwrap_or(false)
}

fn host_matches_trusted_override(host: &str, candidate: &str) -> bool {
    let candidate = candidate.trim().to_ascii_lowercase();
    if candidate.is_empty() {
        return false;
    }
    let host = host.to_ascii_lowercase();
    if let Some(suffix) = candidate.strip_prefix("*.") {
        return host.len() > suffix.len()
            && host.ends_with(suffix)
            && host.as_bytes()[host.len() - suffix.len() - 1] == b'.';
    }
    host == candidate
}

fn host_in_trusted_override_list(host: &str, overrides_csv: Option<&str>) -> bool {
    overrides_csv
        .map(|csv| {
            csv.split(',')
                .any(|entry| host_matches_trusted_override(host, entry))
        })
        .unwrap_or(false)
}

/// Restrict credential-bearing startup probes to trusted provider hosts.
/// Non-loopback custom hosts must be explicitly allowlisted via
/// SIGNET_TRUSTED_PROVIDER_ENDPOINT_HOSTS before credentials are sent.
fn provider_endpoint_is_trusted_for_secret_probe(provider: &str, base: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(base) else {
        return false;
    };
    let Some(host) = url.host_str() else {
        return false;
    };

    if is_loopback_host(host) {
        return true;
    }

    if !url.scheme().eq_ignore_ascii_case("https") {
        return false;
    }

    (match provider {
        "anthropic" => host.eq_ignore_ascii_case("api.anthropic.com"),
        _ => false,
    }) || host_in_trusted_override_list(
        host,
        std::env::var("SIGNET_TRUSTED_PROVIDER_ENDPOINT_HOSTS")
            .ok()
            .as_deref(),
    )
}

fn provider_endpoint_allowlist_hint() -> &'static str {
    "set SIGNET_TRUSTED_PROVIDER_ENDPOINT_HOSTS to a comma-separated host allowlist (supports '*.example.com')"
}

/// Check Anthropic API reachability with credential validation.
async fn check_anthropic_health(endpoint: Option<&str>) -> bool {
    let Some(api_key) = std::env::var("ANTHROPIC_API_KEY")
        .ok()
        .map(|k| k.trim().to_string())
        .filter(|k| !k.is_empty())
    else {
        return false;
    };

    let base = normalize_endpoint_base(endpoint, "https://api.anthropic.com");
    let url = append_api_path(&base, "/v1/models", "/models");
    if !provider_endpoint_is_trusted_for_secret_probe("anthropic", &base) {
        warn!(
            endpoint = %base,
            hint = provider_endpoint_allowlist_hint(),
            "refusing anthropic startup probe for untrusted endpoint"
        );
        return false;
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(2))
        .build();
    let Ok(client) = client else { return false };
    client
        .get(&url)
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .send()
        .await
        .map(|r: reqwest::Response| r.status().is_success())
        .unwrap_or(false)
}

/// Check if a CLI binary exists on PATH AND can run `--version` successfully.
/// Matches the JS daemon's startup preflight which spawns the binary to verify
/// it's not a broken wrapper or non-executable file.
async fn cli_preflight(name: &str) -> bool {
    let Some(path) = which_find(name) else {
        return false;
    };
    // Verify the binary actually runs (mirrors JS daemon's --version check)
    tokio::time::timeout(
        std::time::Duration::from_secs(2),
        tokio::task::spawn_blocking(move || {
            std::process::Command::new(&path)
                .arg("--version")
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .map(|s| s.success())
                .unwrap_or(false)
        }),
    )
    .await
    .ok()
    .and_then(|result| result.ok())
    .unwrap_or(false)
}

/// Find a CLI binary on PATH using native lookup (no shell-out).
/// On Windows, also checks for .cmd/.exe/.bat wrappers (matching Bun.which behavior).
fn which_find(name: &str) -> Option<std::path::PathBuf> {
    let extensions: &[&str] = if cfg!(windows) {
        &["", ".exe", ".cmd", ".bat"]
    } else {
        &[""]
    };
    if let Some(path_var) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path_var) {
            for ext in extensions {
                let candidate = dir.join(format!("{name}{ext}"));
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
    }
    None
}

/// Dead-letter pending extraction jobs when extraction is blocked at startup.
/// Only targets 'pending' jobs — 'failed' and 'leased' are preserved for their
/// respective retry/recovery flows. Also marks affected memories as failed
/// (matching the JS daemon's `updateExtractionFailure` behavior).
async fn dead_letter_pending_extraction_jobs(state: &AppState, reason: &str, now: &str) {
    let reason = reason.to_string();
    let now = now.to_string();
    let result = state
        .pool
        .write_tx(signet_core::db::Priority::Low, move |conn| {
            // Collect affected memory IDs before updating jobs
            let mut stmt = conn.prepare(
                "SELECT DISTINCT memory_id FROM memory_jobs
                 WHERE job_type IN ('extract', 'extraction') AND status = 'pending'",
            )?;
            let memory_ids: Vec<String> = stmt
                .query_map([], |row| row.get(0))?
                .collect::<Result<Vec<_>, _>>()?;

            // Dead-letter the pending jobs
            let count = conn.execute(
                "UPDATE memory_jobs SET status = 'dead', error = ?1, failed_at = ?2, updated_at = ?2
                 WHERE job_type IN ('extract', 'extraction') AND status = 'pending'",
                rusqlite::params![reason, now],
            )?;

            // Mark affected memories as failed — but only if they have no
            // remaining leased (in-flight) extract jobs and no already-completed
            // extraction work for the same memory.
            if !memory_ids.is_empty() {
                let mut check_leased = conn.prepare(
                    "SELECT COUNT(*) FROM memory_jobs
                     WHERE memory_id = ?1 AND job_type IN ('extract', 'extraction') AND status = 'leased'",
                )?;
                let mut check_completed_jobs = conn.prepare(
                    "SELECT COUNT(*) FROM memory_jobs
                     WHERE memory_id = ?1 AND job_type IN ('extract', 'extraction') AND status = 'completed'",
                )?;
                let mut check_completed_memory = conn.prepare(
                    "SELECT COUNT(*) FROM memories
                     WHERE id = ?1 AND extraction_status IN ('complete', 'completed')",
                )?;
                let mut update_mem = conn.prepare(
                    "UPDATE memories SET extraction_status = 'failed' WHERE id = ?1",
                )?;
                for mid in &memory_ids {
                    let leased: i64 =
                        check_leased.query_row(rusqlite::params![mid], |row| row.get(0))?;
                    let completed_jobs: i64 = check_completed_jobs
                        .query_row(rusqlite::params![mid], |row| row.get(0))?;
                    let completed_memory: i64 = check_completed_memory
                        .query_row(rusqlite::params![mid], |row| row.get(0))?;
                    if leased == 0 && completed_jobs == 0 && completed_memory == 0 {
                        update_mem.execute(rusqlite::params![mid])?;
                    }
                }
            }

            Ok(serde_json::json!({ "changes": count }))
        })
        .await;
    match result {
        Ok(val) => {
            let count = val["changes"].as_u64().unwrap_or(0);
            if count > 0 {
                info!(count, "dead-lettered pending extraction jobs at startup");
            }
        }
        Err(e) => warn!(%e, "failed to dead-letter pending extraction jobs"),
    }
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

async fn health() -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "status": "ok",
        "version": env!("CARGO_PKG_VERSION"),
    }))
}

fn current_epoch_ms() -> i64 {
    Utc::now().timestamp_millis()
}

fn iso_from_epoch_ms(ms: i64) -> Option<String> {
    chrono::DateTime::<Utc>::from_timestamp_millis(ms)
        .map(|dt| dt.to_rfc3339_opts(SecondsFormat::Millis, true))
}

async fn status(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    let bind = state.config.bind.as_deref().unwrap_or(&state.config.host);
    let pipeline = state
        .config
        .manifest
        .memory
        .as_ref()
        .and_then(|memory| memory.pipeline_v2.as_ref());
    let extraction = {
        let guard = state.extraction_state.read().await;
        guard.as_ref().map(|es| {
            serde_json::json!({
                "configured": es.configured,
                "resolved": es.resolved,
                "effective": es.effective,
                "fallbackProvider": es.fallback_provider,
                "status": es.status,
                "degraded": es.degraded,
                "fallbackApplied": es.fallback_applied,
                "reason": es.reason,
                "since": es.since,
            })
        })
    };
    let extraction_worker_stats = state.extraction_worker_stats.read().await.clone();
    let extraction_worker = if let Some(pipeline) = pipeline {
        let paused = pipeline.paused || state.pipeline_paused();
        if let Some(stats) = extraction_worker_stats.as_ref() {
            let snapshot = stats.lock().await.snapshot(current_epoch_ms());
            let running = snapshot.running && !paused;
            let overloaded = running && snapshot.overloaded;
            let overload_since = if overloaded {
                snapshot.overload_since_ms.and_then(iso_from_epoch_ms)
            } else {
                None
            };
            Some(serde_json::json!({
                "running": running,
                "overloaded": overloaded,
                "loadPerCpu": if running { snapshot.load_per_cpu } else { None },
                "maxLoadPerCpu": snapshot.max_load_per_cpu,
                "overloadBackoffMs": snapshot.overload_backoff_ms,
                "overloadSince": overload_since,
                "nextTickInMs": if running { snapshot.next_tick_in_ms } else { None },
            }))
        } else {
            Some(serde_json::json!({
                "running": false,
                "overloaded": false,
                "loadPerCpu": None::<f64>,
                "maxLoadPerCpu": pipeline.worker.max_load_per_cpu,
                "overloadBackoffMs": pipeline.worker.overload_backoff_ms,
                "overloadSince": None::<String>,
                "nextTickInMs": None::<u64>,
            }))
        }
    } else {
        None
    };
    let db_stats = state
        .pool
        .read(|conn| {
            let memories: i64 = conn
                .query_row("SELECT count(*) FROM memories", [], |r| r.get(0))
                .unwrap_or(0);
            let entities: i64 = conn
                .query_row("SELECT count(*) FROM entities", [], |r| r.get(0))
                .unwrap_or(0);
            let embeddings: i64 = conn
                .query_row("SELECT count(*) FROM embeddings", [], |r| r.get(0))
                .unwrap_or(0);
            let schema_version: i64 = conn
                .query_row("SELECT MAX(version) FROM schema_migrations", [], |r| {
                    r.get(0)
                })
                .unwrap_or(0);

            Ok(serde_json::json!({
                "memories": memories,
                "entities": entities,
                "embeddings": embeddings,
                "schemaVersion": schema_version,
            }))
        })
        .await
        .unwrap_or_else(|_| serde_json::json!({"error": "db unavailable"}));

    Json(serde_json::json!({
        "status": "ok",
        "version": env!("CARGO_PKG_VERSION"),
        "port": state.config.port,
        "host": state.config.host,
        "bindHost": bind,
        "networkMode": network_mode_from_bind(bind),
        "db": db_stats,
        "agent": state.config.manifest.agent.name,
        "pipeline": {
            "extraction": extraction_worker,
        },
        "providerResolution": {
            "extraction": extraction,
        },
    }))
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::sync::Arc;

    use axum::extract::State;
    use signet_core::config::{
        AgentIdentity, AgentManifest, AuthConfig as ManifestAuthConfig, DaemonConfig,
        EmbeddingConfig, MemoryManifestConfig, PipelineV2Config, RateLimitConfig,
    };
    use signet_core::db::DbPool;
    use tempfile::tempdir;

    use crate::auth::rate_limiter::{AuthRateLimiter, default_limits};
    use crate::auth::types::AuthMode;
    use crate::state::{AppState, ExtractionRuntimeState};

    use super::{
        append_api_path, dead_letter_pending_extraction_jobs, host_in_trusted_override_list,
        host_matches_trusted_override, normalize_endpoint_base, preflight_extraction,
        provider_endpoint_is_trusted_for_secret_probe,
        provider_is_unsupported_for_daemon_startup_preflight, resolve_runtime_extraction_endpoint,
        resolve_runtime_extraction_model, resume_extraction_check, start_extraction_worker,
        start_extraction_worker_inner, status, stop_extraction_worker, stop_summary_worker,
        stop_synthesis_worker, worker_supports_extraction_provider,
    };

    fn test_state_with_pipeline_config(
        provider: &str,
        fallback_provider: &str,
        endpoint: Option<&str>,
        enabled: bool,
        paused: bool,
    ) -> Arc<AppState> {
        let dir = tempdir().expect("tempdir").keep();
        let db = dir.join("memory").join("memories.db");
        std::fs::create_dir_all(db.parent().expect("db parent")).expect("create memory dir");

        let mut limits = HashMap::new();
        limits.insert(
            "admin".to_string(),
            RateLimitConfig {
                window_ms: Some(60_000),
                max: Some(10),
            },
        );

        let mut pipeline = PipelineV2Config::default();
        pipeline.enabled = enabled;
        pipeline.paused = paused;
        pipeline.extraction.provider = provider.to_string();
        pipeline.extraction.fallback_provider = fallback_provider.to_string();
        pipeline.extraction.endpoint = endpoint.map(str::to_string);

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
                pipeline_v2: Some(pipeline),
            }),
            auth: Some(ManifestAuthConfig {
                method: "token".to_string(),
                chain_id: None,
                mode: Some("local".to_string()),
                rate_limits: Some(limits),
            }),
            ..Default::default()
        };

        let (pool, _writer) = DbPool::open(&db).expect("open db");
        let mut rules = default_limits();
        if let Some(rule) = rules.get_mut("admin") {
            rule.max = 10;
        }

        Arc::new(AppState::new(
            DaemonConfig {
                base_path: dir,
                db_path: db,
                port: 3850,
                host: "127.0.0.1".to_string(),
                bind: Some("127.0.0.1".to_string()),
                manifest,
            },
            pool,
            Some(signet_pipeline::embedding::from_config(
                &EmbeddingConfig::default(),
                None,
            )),
            Some(signet_pipeline::worker::new_runtime_stats_handle(
                0.8, 30_000,
            )),
            AuthMode::Local,
            None,
            AuthRateLimiter::from_rules(&rules),
        ))
    }

    fn test_state_with_extraction(
        provider: &str,
        fallback_provider: &str,
        endpoint: Option<&str>,
    ) -> Arc<AppState> {
        test_state_with_pipeline_config(provider, fallback_provider, endpoint, true, false)
    }

    fn test_state() -> Arc<AppState> {
        test_state_with_extraction("ollama", "ollama", None)
    }

    #[tokio::test]
    async fn status_includes_worker_runtime_fields_with_configured_bounds() {
        let state = test_state();
        let axum::response::Json(body) = status(State(state)).await;
        assert_eq!(body["pipeline"]["extraction"]["running"], false);
        assert_eq!(body["pipeline"]["extraction"]["overloaded"], false);
        assert_eq!(body["pipeline"]["extraction"]["maxLoadPerCpu"], 0.8);
        assert_eq!(body["pipeline"]["extraction"]["overloadBackoffMs"], 30000);
    }

    #[test]
    fn append_api_path_handles_v1_and_non_v1_bases() {
        assert_eq!(
            append_api_path("https://api.anthropic.com", "/v1/models", "/models"),
            "https://api.anthropic.com/v1/models"
        );
        assert_eq!(
            append_api_path("https://api.anthropic.com/v1", "/v1/models", "/models"),
            "https://api.anthropic.com/v1/models"
        );
    }

    #[test]
    fn normalize_endpoint_base_uses_trimmed_endpoint_or_default() {
        assert_eq!(
            normalize_endpoint_base(Some("https://api.anthropic.com/"), "https://default"),
            "https://api.anthropic.com"
        );
        assert_eq!(
            normalize_endpoint_base(None, "https://default/"),
            "https://default"
        );
    }

    #[test]
    fn trusted_secret_probe_hosts_allow_official_provider_endpoints() {
        assert!(provider_endpoint_is_trusted_for_secret_probe(
            "anthropic",
            "https://api.anthropic.com"
        ));
    }

    #[test]
    fn trusted_secret_probe_hosts_allow_loopback_endpoints() {
        assert!(provider_endpoint_is_trusted_for_secret_probe(
            "anthropic",
            "http://127.0.0.1:8080"
        ));
        assert!(provider_endpoint_is_trusted_for_secret_probe(
            "anthropic",
            "http://localhost:8080"
        ));
        assert!(provider_endpoint_is_trusted_for_secret_probe(
            "anthropic",
            "http://[::1]:8080"
        ));
    }

    #[test]
    fn trusted_secret_probe_hosts_reject_untrusted_or_mismatched_endpoints() {
        assert!(!provider_endpoint_is_trusted_for_secret_probe(
            "anthropic",
            "https://proxy.example.com"
        ));
        assert!(!provider_endpoint_is_trusted_for_secret_probe(
            "anthropic",
            "http://api.anthropic.com"
        ));
    }

    #[test]
    fn trusted_host_override_supports_exact_and_wildcard_matches() {
        assert!(host_matches_trusted_override(
            "proxy.company.net",
            "proxy.company.net"
        ));
        assert!(host_matches_trusted_override(
            "anthropic.gateway.company.net",
            "*.company.net"
        ));
        assert!(!host_matches_trusted_override(
            "company.net",
            "*.company.net"
        ));
        assert!(!host_matches_trusted_override(
            "proxy.company.net",
            "*.other.net"
        ));
    }

    #[test]
    fn trusted_host_override_list_parses_csv_entries() {
        assert!(host_in_trusted_override_list(
            "proxy.company.net",
            Some(" proxy.company.net , *.example.org ")
        ));
        assert!(host_in_trusted_override_list(
            "api.example.org",
            Some("proxy.company.net,*.example.org")
        ));
        assert!(!host_in_trusted_override_list(
            "api.example.org",
            Some("proxy.company.net")
        ));
    }

    #[tokio::test]
    async fn startup_dead_letter_marks_pending_jobs_and_memories_failed() {
        let state = test_state();
        state
            .pool
            .write_tx(signet_core::db::Priority::High, |conn| {
                conn.execute(
                    "INSERT INTO memories (id, content, normalized_content, content_hash, type, importance, extraction_status, created_at, updated_at, updated_by)
                     VALUES (?1, 'memory', 'memory', 'hash-1', 'fact', 0.5, 'queued', ?2, ?2, 'test')",
                    rusqlite::params!["mem-1", "2026-03-27T00:00:00Z"],
                )?;
                conn.execute(
                    "INSERT INTO memory_jobs (id, memory_id, job_type, status, created_at, updated_at)
                     VALUES (?1, ?2, 'extract', 'pending', ?3, ?3)",
                    rusqlite::params!["job-1", "mem-1", "2026-03-27T00:00:00Z"],
                )?;
                Ok(serde_json::json!({"ok": true}))
            })
            .await
            .expect("seed pending extraction");

        dead_letter_pending_extraction_jobs(
            &state,
            "Configured extraction provider unavailable at startup",
            "2026-03-27T00:00:01Z",
        )
        .await;

        let (job_status, memory_status) = state
            .pool
            .read(|conn| {
                let job_status: String = conn.query_row(
                    "SELECT status FROM memory_jobs WHERE id = 'job-1'",
                    [],
                    |row| row.get(0),
                )?;
                let memory_status: String = conn.query_row(
                    "SELECT extraction_status FROM memories WHERE id = 'mem-1'",
                    [],
                    |row| row.get(0),
                )?;
                Ok((job_status, memory_status))
            })
            .await
            .expect("read statuses");

        assert_eq!(job_status, "dead");
        assert_eq!(memory_status, "failed");
    }

    #[tokio::test]
    async fn startup_dead_letter_rolls_back_if_memory_updates_fail() {
        let state = test_state();
        state
            .pool
            .write_tx(signet_core::db::Priority::High, |conn| {
                conn.execute(
                    "INSERT INTO memories (id, content, normalized_content, content_hash, type, importance, extraction_status, created_at, updated_at, updated_by)
                     VALUES (?1, 'memory', 'memory', 'hash-2', 'fact', 0.5, 'queued', ?2, ?2, 'test')",
                    rusqlite::params!["mem-2", "2026-03-27T00:00:00Z"],
                )?;
                conn.execute(
                    "INSERT INTO memory_jobs (id, memory_id, job_type, status, created_at, updated_at)
                     VALUES (?1, ?2, 'extract', 'pending', ?3, ?3)",
                    rusqlite::params!["job-2", "mem-2", "2026-03-27T00:00:00Z"],
                )?;
                Ok(serde_json::json!({"ok": true}))
            })
            .await
            .expect("seed pending extraction");

        state
            .pool
            .write(signet_core::db::Priority::High, |conn| {
                conn.execute_batch(
                    "CREATE TRIGGER fail_memory_dead_letter_update
                     BEFORE UPDATE OF extraction_status ON memories
                     BEGIN
                       SELECT RAISE(FAIL, 'boom');
                     END;",
                )?;
                Ok(serde_json::json!({"ok": true}))
            })
            .await
            .expect("install failure trigger");

        dead_letter_pending_extraction_jobs(
            &state,
            "Configured extraction provider unavailable at startup",
            "2026-03-27T00:00:01Z",
        )
        .await;

        let job_status: String = state
            .pool
            .read(|conn| {
                conn.query_row(
                    "SELECT status FROM memory_jobs WHERE id = 'job-2'",
                    [],
                    |row| row.get(0),
                )
                .map_err(Into::into)
            })
            .await
            .expect("read rolled back job");

        assert_eq!(job_status, "pending");
    }

    #[tokio::test]
    async fn startup_dead_letter_preserves_completed_memory_status_when_stale_pending_exists() {
        let state = test_state();
        state
            .pool
            .write_tx(signet_core::db::Priority::High, |conn| {
                conn.execute(
                    "INSERT INTO memories (id, content, normalized_content, content_hash, type, importance, extraction_status, created_at, updated_at, updated_by)
                     VALUES (?1, 'memory', 'memory', 'hash-3', 'fact', 0.5, 'completed', ?2, ?2, 'test')",
                    rusqlite::params!["mem-3", "2026-03-27T00:00:00Z"],
                )?;
                conn.execute(
                    "INSERT INTO memory_jobs (id, memory_id, job_type, status, created_at, updated_at, completed_at)
                     VALUES (?1, ?2, 'extract', 'completed', ?3, ?3, ?3)",
                    rusqlite::params!["job-3-completed", "mem-3", "2026-03-27T00:00:00Z"],
                )?;
                conn.execute(
                    "INSERT INTO memory_jobs (id, memory_id, job_type, status, created_at, updated_at)
                     VALUES (?1, ?2, 'extract', 'pending', ?3, ?3)",
                    rusqlite::params!["job-3-pending", "mem-3", "2026-03-27T00:00:00Z"],
                )?;
                Ok(serde_json::json!({"ok": true}))
            })
            .await
            .expect("seed completed + pending extraction");

        dead_letter_pending_extraction_jobs(
            &state,
            "Configured extraction provider unavailable at startup",
            "2026-03-27T00:00:01Z",
        )
        .await;

        let (pending_status, memory_status): (String, String) = state
            .pool
            .read(|conn| {
                let pending_status: String = conn.query_row(
                    "SELECT status FROM memory_jobs WHERE id = 'job-3-pending'",
                    [],
                    |row| row.get(0),
                )?;
                let memory_status: String = conn.query_row(
                    "SELECT extraction_status FROM memories WHERE id = 'mem-3'",
                    [],
                    |row| row.get(0),
                )?;
                Ok((pending_status, memory_status))
            })
            .await
            .expect("read completed-memory status");

        assert_eq!(pending_status, "dead");
        assert_eq!(memory_status, "completed");
    }

    #[tokio::test]
    async fn unsupported_active_provider_downgrades_to_ollama_fallback_before_worker_start() {
        let state = test_state_with_extraction("claude-code", "ollama", None);

        {
            let mut extraction = state.extraction_state.write().await;
            *extraction = Some(ExtractionRuntimeState {
                configured: Some("claude-code".to_string()),
                resolved: "claude-code".to_string(),
                effective: "claude-code".to_string(),
                fallback_provider: "ollama".to_string(),
                status: "active".to_string(),
                degraded: false,
                fallback_applied: false,
                reason: None,
                since: None,
            });
        }

        let started = start_extraction_worker(state.as_ref()).await;
        assert!(started);

        let extraction = state.extraction_state.read().await.clone().expect("state");
        assert_eq!(extraction.effective, "ollama");
        assert_eq!(extraction.status, "degraded");
        assert!(extraction.fallback_applied);

        stop_synthesis_worker(state.as_ref()).await;
        stop_summary_worker(state.as_ref()).await;
        stop_extraction_worker(state.as_ref()).await;
    }

    #[tokio::test]
    async fn unsupported_active_provider_blocks_when_no_fallback_available() {
        let state = test_state_with_extraction("claude-code", "none", None);

        {
            let mut extraction = state.extraction_state.write().await;
            *extraction = Some(ExtractionRuntimeState {
                configured: Some("claude-code".to_string()),
                resolved: "claude-code".to_string(),
                effective: "claude-code".to_string(),
                fallback_provider: "none".to_string(),
                status: "active".to_string(),
                degraded: false,
                fallback_applied: false,
                reason: None,
                since: None,
            });
        }

        let started = start_extraction_worker(state.as_ref()).await;
        assert!(!started);

        let extraction = state.extraction_state.read().await.clone().expect("state");
        assert_eq!(extraction.effective, "none");
        assert_eq!(extraction.status, "blocked");
        assert!(!extraction.fallback_applied);
    }

    #[tokio::test]
    async fn startup_worker_block_dead_letters_pending_jobs_when_provider_becomes_blocked() {
        let state = test_state_with_extraction("claude-code", "none", None);

        state
            .pool
            .write_tx(signet_core::db::Priority::High, |conn| {
                conn.execute(
                    "INSERT INTO memories (id, content, normalized_content, content_hash, type, importance, extraction_status, created_at, updated_at, updated_by)
                     VALUES (?1, 'memory', 'memory', 'hash-startup-worker-block', 'fact', 0.5, 'queued', ?2, ?2, 'test')",
                    rusqlite::params!["mem-startup-worker-block", "2026-03-27T00:00:00Z"],
                )?;
                conn.execute(
                    "INSERT INTO memory_jobs (id, memory_id, job_type, status, created_at, updated_at)
                     VALUES (?1, ?2, 'extract', 'pending', ?3, ?3)",
                    rusqlite::params![
                        "job-startup-worker-block",
                        "mem-startup-worker-block",
                        "2026-03-27T00:00:00Z"
                    ],
                )?;
                Ok(serde_json::json!({"ok": true}))
            })
            .await
            .expect("seed pending extraction");

        {
            let mut extraction = state.extraction_state.write().await;
            *extraction = Some(ExtractionRuntimeState {
                configured: Some("claude-code".to_string()),
                resolved: "claude-code".to_string(),
                effective: "claude-code".to_string(),
                fallback_provider: "none".to_string(),
                status: "active".to_string(),
                degraded: false,
                fallback_applied: false,
                reason: None,
                since: None,
            });
        }

        let started = start_extraction_worker_inner(state.as_ref(), true).await;
        assert!(!started);

        let (job_status, memory_status) = state
            .pool
            .read(|conn| {
                let job_status: String = conn.query_row(
                    "SELECT status FROM memory_jobs WHERE id = 'job-startup-worker-block'",
                    [],
                    |row| row.get(0),
                )?;
                let memory_status: String = conn.query_row(
                    "SELECT extraction_status FROM memories WHERE id = 'mem-startup-worker-block'",
                    [],
                    |row| row.get(0),
                )?;
                Ok((job_status, memory_status))
            })
            .await
            .expect("read blocked startup statuses");

        assert_eq!(job_status, "dead");
        assert_eq!(memory_status, "failed");
    }

    #[tokio::test]
    async fn preflight_persists_disabled_resolution_when_provider_is_none() {
        let state = test_state_with_pipeline_config("none", "ollama", None, true, false);

        {
            let mut extraction = state.extraction_state.write().await;
            *extraction = Some(ExtractionRuntimeState {
                configured: Some("ollama".to_string()),
                resolved: "ollama".to_string(),
                effective: "ollama".to_string(),
                fallback_provider: "ollama".to_string(),
                status: "active".to_string(),
                degraded: false,
                fallback_applied: false,
                reason: Some("stale".to_string()),
                since: Some("2026-03-27T00:00:00Z".to_string()),
            });
        }

        preflight_extraction(state.as_ref()).await;

        let axum::response::Json(body) = status(State(state)).await;
        assert_eq!(
            body["providerResolution"]["extraction"]["status"],
            "disabled"
        );
        assert_eq!(body["providerResolution"]["extraction"]["resolved"], "none");
        assert_eq!(
            body["providerResolution"]["extraction"]["effective"],
            "none"
        );
        assert_eq!(
            body["providerResolution"]["extraction"]["reason"],
            serde_json::Value::Null
        );
    }

    #[tokio::test]
    async fn preflight_persists_paused_resolution_when_pipeline_is_paused() {
        let state = test_state_with_pipeline_config("claude-code", "ollama", None, true, true);

        {
            let mut extraction = state.extraction_state.write().await;
            *extraction = Some(ExtractionRuntimeState {
                configured: Some("claude-code".to_string()),
                resolved: "claude-code".to_string(),
                effective: "claude-code".to_string(),
                fallback_provider: "ollama".to_string(),
                status: "active".to_string(),
                degraded: true,
                fallback_applied: true,
                reason: Some("stale".to_string()),
                since: Some("2026-03-27T00:00:00Z".to_string()),
            });
        }

        preflight_extraction(state.as_ref()).await;

        let axum::response::Json(body) = status(State(state)).await;
        assert_eq!(body["providerResolution"]["extraction"]["status"], "paused");
        assert_eq!(
            body["providerResolution"]["extraction"]["resolved"],
            "claude-code"
        );
        assert_eq!(
            body["providerResolution"]["extraction"]["effective"],
            "none"
        );
        assert_eq!(
            body["providerResolution"]["extraction"]["reason"],
            serde_json::Value::Null
        );
    }

    #[tokio::test]
    async fn resume_check_blocks_worker_unsupported_provider_before_publishing_active() {
        let state = test_state_with_extraction("claude-code", "none", None);

        {
            let mut extraction = state.extraction_state.write().await;
            *extraction = Some(ExtractionRuntimeState {
                configured: Some("claude-code".to_string()),
                resolved: "claude-code".to_string(),
                effective: "none".to_string(),
                fallback_provider: "none".to_string(),
                status: "paused".to_string(),
                degraded: false,
                fallback_applied: false,
                reason: None,
                since: None,
            });
        }

        resume_extraction_check(state.as_ref()).await;

        let extraction = state.extraction_state.read().await.clone().expect("state");
        assert_eq!(extraction.status, "blocked");
        assert_eq!(extraction.effective, "none");
        assert_eq!(
            extraction.reason.as_deref(),
            Some(
                "claude-code is not supported by daemon-rs extraction worker; fallbackProvider is none"
            )
        );
    }

    #[test]
    fn resolve_runtime_extraction_model_drops_non_ollama_model_on_fallback() {
        assert_eq!(
            resolve_runtime_extraction_model("ollama", "codex", "gpt-5-codex-mini"),
            "qwen3:4b"
        );
    }

    #[test]
    fn resolve_runtime_extraction_model_keeps_model_when_provider_matches() {
        assert_eq!(
            resolve_runtime_extraction_model("ollama", "ollama", "qwen3.5:4b"),
            "qwen3.5:4b"
        );
        assert_eq!(
            resolve_runtime_extraction_model("codex", "codex", "gpt-5-codex-mini"),
            "gpt-5-codex-mini"
        );
    }

    #[test]
    fn resolve_runtime_extraction_endpoint_drops_non_ollama_api_endpoints_on_fallback() {
        assert_eq!(
            resolve_runtime_extraction_endpoint(
                "ollama",
                "openrouter",
                Some("https://openrouter.ai/api/v1")
            ),
            None
        );
        assert_eq!(
            resolve_runtime_extraction_endpoint(
                "ollama",
                "anthropic",
                Some("https://api.anthropic.com")
            ),
            None
        );
        assert_eq!(
            resolve_runtime_extraction_endpoint(
                "ollama",
                "opencode",
                Some("http://127.0.0.1:4096")
            ),
            None
        );
    }

    #[test]
    fn resolve_runtime_extraction_endpoint_keeps_configured_endpoint_when_not_fallback() {
        assert_eq!(
            resolve_runtime_extraction_endpoint("ollama", "ollama", Some("http://127.0.0.1:11434")),
            Some("http://127.0.0.1:11434".to_string())
        );
        assert_eq!(
            resolve_runtime_extraction_endpoint(
                "anthropic",
                "anthropic",
                Some("https://api.anthropic.com")
            ),
            Some("https://api.anthropic.com".to_string())
        );
    }

    #[test]
    fn resolve_runtime_extraction_endpoint_keeps_custom_ollama_endpoint_for_cli_fallback() {
        assert_eq!(
            resolve_runtime_extraction_endpoint(
                "ollama",
                "claude-code",
                Some("http://remote-ollama:11434")
            ),
            Some("http://remote-ollama:11434".to_string())
        );
        assert_eq!(
            resolve_runtime_extraction_endpoint(
                "ollama",
                "codex",
                Some("http://remote-ollama:11434")
            ),
            Some("http://remote-ollama:11434".to_string())
        );
    }

    #[test]
    fn worker_supports_only_ollama_and_anthropic_providers() {
        assert!(worker_supports_extraction_provider("ollama"));
        assert!(worker_supports_extraction_provider("anthropic"));
        assert!(!worker_supports_extraction_provider("claude-code"));
        assert!(!worker_supports_extraction_provider("codex"));
        assert!(!worker_supports_extraction_provider("opencode"));
        assert!(!worker_supports_extraction_provider("openrouter"));
    }

    #[test]
    fn only_openrouter_is_startup_preflight_blocked_as_unsupported() {
        assert!(!provider_is_unsupported_for_daemon_startup_preflight(
            "ollama"
        ));
        assert!(!provider_is_unsupported_for_daemon_startup_preflight(
            "anthropic"
        ));
        assert!(!provider_is_unsupported_for_daemon_startup_preflight(
            "claude-code"
        ));
        assert!(!provider_is_unsupported_for_daemon_startup_preflight(
            "codex"
        ));
        assert!(!provider_is_unsupported_for_daemon_startup_preflight(
            "opencode"
        ));
        assert!(provider_is_unsupported_for_daemon_startup_preflight(
            "openrouter"
        ));
    }
}
