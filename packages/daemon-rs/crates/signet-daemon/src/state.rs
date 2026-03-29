use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::{collections::HashMap, time::SystemTime};

use signet_core::config::DaemonConfig;
use signet_core::db::DbPool;
use signet_pipeline::embedding::EmbeddingProvider;
use signet_pipeline::summary::SummaryHandle;
use signet_pipeline::synthesis::SynthesisHandle;
use signet_pipeline::worker::{SharedWorkerRuntimeStats, WorkerHandle};
use signet_services::session::{ContinuityTracker, DedupState, SessionTracker};
use tokio::sync::{Mutex, RwLock};

use crate::auth::rate_limiter::AuthRateLimiter;
use crate::auth::types::AuthMode;

/// Runtime extraction provider resolution state, matching the JS daemon contract.
#[derive(Debug, Clone)]
pub struct ExtractionRuntimeState {
    pub configured: Option<String>,
    pub resolved: String,
    pub effective: String,
    pub fallback_provider: String,
    pub status: String,
    pub degraded: bool,
    pub fallback_applied: bool,
    pub reason: Option<String>,
    pub since: Option<String>,
}

/// Shared application state passed to all route handlers.
pub struct AppState {
    pub config: DaemonConfig,
    pub pool: DbPool,
    pub embedding: RwLock<Option<Arc<dyn EmbeddingProvider>>>,
    pub pipeline_paused: AtomicBool,
    pub pipeline_transition: AtomicBool,
    pub extraction_worker_handle: Mutex<Option<WorkerHandle>>,
    pub summary_worker_handle: Mutex<Option<SummaryHandle>>,
    pub synthesis_worker_handle: Mutex<Option<SynthesisHandle>>,
    pub extraction_worker_stats: RwLock<Option<SharedWorkerRuntimeStats>>,
    pub auth_mode: AuthMode,
    pub auth_secret: Option<Vec<u8>>,
    pub auth_admin_limiter: AuthRateLimiter,
    pub sessions: SessionTracker,
    pub continuity: ContinuityTracker,
    pub dedup: DedupState,
    pub extraction_state: RwLock<Option<ExtractionRuntimeState>>,
    pub harness_last_seen: RwLock<HashMap<String, String>>,
}

pub(crate) fn derive_initial_extraction_state(
    provider: &str,
    fallback_provider: &str,
    pipeline_enabled: bool,
    paused: bool,
) -> ExtractionRuntimeState {
    let status = if !pipeline_enabled || provider == "none" {
        "disabled"
    } else if paused {
        "paused"
    } else {
        "active"
    };
    let effective = if status == "disabled" || status == "paused" {
        "none"
    } else {
        provider
    };
    ExtractionRuntimeState {
        configured: Some(provider.to_string()),
        resolved: provider.to_string(),
        effective: effective.to_string(),
        fallback_provider: fallback_provider.to_string(),
        status: status.to_string(),
        degraded: false,
        fallback_applied: false,
        reason: None,
        since: None,
    }
}

impl AppState {
    pub fn new(
        config: DaemonConfig,
        pool: DbPool,
        embedding: Option<Arc<dyn EmbeddingProvider>>,
        extraction_worker_stats: Option<SharedWorkerRuntimeStats>,
        auth_mode: AuthMode,
        auth_secret: Option<Vec<u8>>,
        auth_admin_limiter: AuthRateLimiter,
    ) -> Self {
        let paused = config
            .manifest
            .memory
            .as_ref()
            .and_then(|m| m.pipeline_v2.as_ref())
            .map(|p| p.paused)
            .unwrap_or(false);

        // Derive initial extraction runtime state from config, mirroring
        // the JS daemon's startup resolution contract.
        let extraction_state = config
            .manifest
            .memory
            .as_ref()
            .and_then(|m| m.pipeline_v2.as_ref())
            .map(|pipeline| {
                let extraction = &pipeline.extraction;
                derive_initial_extraction_state(
                    &extraction.provider,
                    &extraction.fallback_provider,
                    pipeline.enabled,
                    paused,
                )
            });

        Self {
            config,
            pool,
            embedding: RwLock::new(embedding),
            pipeline_paused: AtomicBool::new(paused),
            pipeline_transition: AtomicBool::new(false),
            extraction_worker_handle: Mutex::new(None),
            summary_worker_handle: Mutex::new(None),
            synthesis_worker_handle: Mutex::new(None),
            extraction_worker_stats: RwLock::new(extraction_worker_stats),
            auth_mode,
            auth_secret,
            auth_admin_limiter,
            sessions: SessionTracker::new(),
            continuity: ContinuityTracker::new(),
            dedup: DedupState::new(),
            extraction_state: RwLock::new(extraction_state),
            harness_last_seen: RwLock::new(HashMap::new()),
        }
    }

    pub fn pipeline_paused(&self) -> bool {
        self.pipeline_paused.load(Ordering::SeqCst)
    }

    fn normalize_harness_id(harness: &str) -> Option<&'static str> {
        match harness.trim().to_ascii_lowercase().as_str() {
            "claude" | "claude-code" => Some("claude-code"),
            "opencode" => Some("opencode"),
            "openclaw" => Some("openclaw"),
            "forge" => Some("forge"),
            _ => None,
        }
    }

    pub async fn stamp_harness(&self, harness: &str) {
        let Some(harness) = Self::normalize_harness_id(harness) else {
            return;
        };
        let timestamp = chrono::DateTime::<chrono::Utc>::from(SystemTime::now()).to_rfc3339();
        self.harness_last_seen
            .write()
            .await
            .insert(harness.to_string(), timestamp);
    }

    pub async fn harness_last_seen(&self, harness: &str) -> Option<String> {
        self.harness_last_seen.read().await.get(harness).cloned()
    }
}

#[cfg(test)]
mod tests {
    use super::derive_initial_extraction_state;

    #[test]
    fn paused_starts_with_effective_none() {
        let state = derive_initial_extraction_state("claude-code", "ollama", true, true);
        assert_eq!(state.status, "paused");
        assert_eq!(state.resolved, "claude-code");
        assert_eq!(state.effective, "none");
    }

    #[test]
    fn disabled_starts_with_effective_none_when_pipeline_disabled() {
        let state = derive_initial_extraction_state("claude-code", "ollama", false, false);
        assert_eq!(state.status, "disabled");
        assert_eq!(state.resolved, "claude-code");
        assert_eq!(state.effective, "none");
    }

    #[test]
    fn disabled_starts_with_effective_none_when_provider_none() {
        let state = derive_initial_extraction_state("none", "ollama", true, false);
        assert_eq!(state.status, "disabled");
        assert_eq!(state.resolved, "none");
        assert_eq!(state.effective, "none");
    }

    #[test]
    fn active_keeps_effective_provider() {
        let state = derive_initial_extraction_state("claude-code", "ollama", true, false);
        assert_eq!(state.status, "active");
        assert_eq!(state.resolved, "claude-code");
        assert_eq!(state.effective, "claude-code");
    }
}
