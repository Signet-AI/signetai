use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, RwLock as StdRwLock};
use std::{collections::HashMap, time::SystemTime};

use serde::{Deserialize, Serialize};
use signet_core::config::DaemonConfig;
use signet_core::db::DbPool;
use signet_pipeline::document::DocumentHandle;
use signet_pipeline::embedding::EmbeddingProvider;
use signet_pipeline::provider::LlmProvider;
use signet_pipeline::summary::SummaryHandle;
use signet_pipeline::synthesis::SynthesisHandle;
use signet_pipeline::worker::{SharedWorkerRuntimeStats, WorkerHandle};
use signet_services::session::{ContinuityTracker, DedupState, SessionTracker};
use tokio::sync::{Mutex, RwLock};

use crate::analytics::AnalyticsCollector;
use crate::auth::rate_limiter::{AuthRateLimiter, RateLimitRule, default_limits};
use crate::auth::tokens::load_or_create_secret;
use crate::auth::types::AuthMode;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OsAgentSession {
    pub id: String,
    pub server_id: String,
    pub task: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_class: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub privacy: Option<String>,
    pub status: String,
    pub step: u32,
    pub max_steps: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

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

#[derive(Debug, Clone)]
pub struct OpenClawHeartbeatData {
    pub plugin_version: String,
    pub hooks_registered: Vec<String>,
    pub last_error: Option<String>,
    pub latency_ms: f64,
    pub total_succeeded: i64,
    pub total_failed: i64,
}

#[derive(Debug, Clone)]
pub struct OpenClawHeartbeat {
    pub timestamp: String,
    pub data: OpenClawHeartbeatData,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum UpdateChannel {
    Stable,
    Nightly,
}

impl Default for UpdateChannel {
    fn default() -> Self {
        Self::Stable
    }
}

impl UpdateChannel {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Stable => "stable",
            Self::Nightly => "nightly",
        }
    }

    pub fn npm_tag(&self) -> &'static str {
        match self {
            Self::Stable => "latest",
            Self::Nightly => "next",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateRuntimeConfig {
    pub auto_install: bool,
    pub check_interval: i64,
    pub channel: UpdateChannel,
}

impl Default for UpdateRuntimeConfig {
    fn default() -> Self {
        Self {
            auto_install: false,
            check_interval: 21_600,
            channel: UpdateChannel::Stable,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub current_version: String,
    pub latest_version: Option<String>,
    pub update_available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub release_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub release_notes: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub published_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub check_error: Option<String>,
    pub restart_required: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pending_version: Option<String>,
    pub is_major_upgrade: bool,
}

#[derive(Debug, Clone)]
pub struct UpdateRuntimeState {
    pub current_version: String,
    pub last_check: Option<UpdateInfo>,
    pub last_check_time: Option<String>,
    pub check_in_progress: bool,
    pub install_in_progress: bool,
    pub pending_restart_version: Option<String>,
    pub last_auto_update_at: Option<String>,
    pub last_auto_update_error: Option<String>,
    pub config: UpdateRuntimeConfig,
}

impl UpdateRuntimeState {
    pub fn new(base_path: &std::path::Path, current_version: String) -> Self {
        Self {
            current_version,
            last_check: None,
            last_check_time: None,
            check_in_progress: false,
            install_in_progress: false,
            pending_restart_version: None,
            last_auto_update_at: None,
            last_auto_update_error: None,
            config: UpdateRuntimeConfig::load(base_path),
        }
    }
}

impl UpdateRuntimeConfig {
    pub fn load(base_path: &std::path::Path) -> Self {
        let mut config = Self::default();
        for name in ["agent.yaml", "AGENT.yaml"] {
            let path = base_path.join(name);
            let Ok(content) = std::fs::read_to_string(&path) else {
                continue;
            };
            let Ok(value) = serde_yml::from_str::<serde_yml::Value>(&content) else {
                continue;
            };
            let Some(updates) = value
                .as_mapping()
                .and_then(|map| {
                    map.get(yaml_key("updates"))
                        .or_else(|| map.get(yaml_key("update")))
                })
                .and_then(serde_yml::Value::as_mapping)
            else {
                continue;
            };

            if let Some(value) =
                yaml_bool(updates, "autoInstall").or_else(|| yaml_bool(updates, "auto_install"))
            {
                config.auto_install = value;
            }
            if let Some(value) = yaml_i64(updates, "checkInterval")
                .or_else(|| yaml_i64(updates, "check_interval"))
                .filter(|value| (300..=604_800).contains(value))
            {
                config.check_interval = value;
            }
            if let Some(channel) = yaml_string(updates, "channel").and_then(|raw| {
                match raw.trim().to_ascii_lowercase().as_str() {
                    "stable" | "latest" => Some(UpdateChannel::Stable),
                    "nightly" | "next" => Some(UpdateChannel::Nightly),
                    _ => None,
                }
            }) {
                config.channel = channel;
            }
            break;
        }
        config
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRuntimeConfig {
    pub enabled: bool,
    pub auto_commit: bool,
    pub auto_sync: bool,
    pub sync_interval: u64,
    pub remote: String,
    pub branch: String,
}

impl GitRuntimeConfig {
    pub fn load(base_path: &std::path::Path) -> Self {
        let mut config = Self::default();
        for name in ["agent.yaml", "AGENT.yaml"] {
            let path = base_path.join(name);
            let Ok(content) = std::fs::read_to_string(&path) else {
                continue;
            };
            let Ok(value) = serde_yml::from_str::<serde_yml::Value>(&content) else {
                continue;
            };
            let Some(git) = value
                .as_mapping()
                .and_then(|map| map.get(serde_yml::Value::String("git".into())))
                .and_then(serde_yml::Value::as_mapping)
            else {
                continue;
            };

            if let Some(value) = yaml_bool(git, "enabled") {
                config.enabled = value;
            }
            if let Some(value) = yaml_bool(git, "autoCommit") {
                config.auto_commit = value;
            }
            if let Some(value) = yaml_bool(git, "autoSync") {
                config.auto_sync = value;
            }
            if let Some(value) = yaml_u64(git, "syncInterval") {
                config.sync_interval = value;
            }
            if let Some(value) = yaml_string(git, "remote").filter(|value| !value.is_empty()) {
                config.remote = value;
            }
            if let Some(value) = yaml_string(git, "branch").filter(|value| !value.is_empty()) {
                config.branch = value;
            }
            break;
        }

        if config.branch.is_empty() {
            config.branch = detect_git_branch(base_path, &config.remote);
        }
        config
    }

    pub fn apply_patch(&mut self, body: &serde_json::Value) {
        if let Some(value) = body.get("autoCommit").and_then(serde_json::Value::as_bool) {
            self.auto_commit = value;
        }
        if let Some(value) = body.get("autoSync").and_then(serde_json::Value::as_bool) {
            self.auto_sync = value;
        }
        if let Some(value) = body.get("syncInterval").and_then(serde_json::Value::as_u64) {
            self.sync_interval = value;
        }
        if let Some(value) = body
            .get("remote")
            .and_then(serde_json::Value::as_str)
            .filter(|value| !value.is_empty())
        {
            self.remote = value.to_string();
        }
        if let Some(value) = body
            .get("branch")
            .and_then(serde_json::Value::as_str)
            .filter(|value| !value.is_empty())
        {
            self.branch = value.to_string();
        }
    }
}

impl Default for GitRuntimeConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            auto_commit: false,
            auto_sync: false,
            sync_interval: 300,
            remote: "origin".to_string(),
            branch: String::new(),
        }
    }
}

fn yaml_key(key: &str) -> serde_yml::Value {
    serde_yml::Value::String(key.to_string())
}

fn yaml_string(map: &serde_yml::Mapping, key: &str) -> Option<String> {
    map.get(&yaml_key(key))
        .and_then(serde_yml::Value::as_str)
        .map(ToOwned::to_owned)
}

fn yaml_bool(map: &serde_yml::Mapping, key: &str) -> Option<bool> {
    match map.get(&yaml_key(key)) {
        Some(value) => value
            .as_bool()
            .or_else(|| value.as_str().map(|raw| raw == "true")),
        None => None,
    }
}

fn yaml_u64(map: &serde_yml::Mapping, key: &str) -> Option<u64> {
    map.get(&yaml_key(key))
        .and_then(|value| value.as_u64().or_else(|| value.as_str()?.parse().ok()))
}

fn yaml_i64(map: &serde_yml::Mapping, key: &str) -> Option<i64> {
    map.get(&yaml_key(key))
        .and_then(|value| value.as_i64().or_else(|| value.as_str()?.parse().ok()))
}

fn detect_git_branch(base_path: &std::path::Path, remote: &str) -> String {
    if let Ok(output) = std::process::Command::new("git")
        .args(["symbolic-ref", &format!("refs/remotes/{remote}/HEAD")])
        .current_dir(base_path)
        .output()
    {
        if output.status.success() {
            let raw = String::from_utf8_lossy(&output.stdout).trim().to_string();
            let prefix = format!("refs/remotes/{remote}/");
            if let Some(branch) = raw.strip_prefix(&prefix) {
                return branch.to_string();
            }
        }
    }

    if let Ok(output) = std::process::Command::new("git")
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(base_path)
        .output()
    {
        if output.status.success() {
            let branch = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !branch.is_empty() && branch != "HEAD" {
                return branch;
            }
        }
    }

    "main".to_string()
}

#[derive(Clone)]
pub struct AuthRuntimeState {
    pub mode: AuthMode,
    pub secret: Option<Vec<u8>>,
    pub admin_limiter: AuthRateLimiter,
    pub recall_llm_limiter: AuthRateLimiter,
}

impl AuthRuntimeState {
    pub fn from_config(config: &DaemonConfig) -> anyhow::Result<Self> {
        let mode = read_auth_mode(config);
        let secret = if mode == AuthMode::Local {
            None
        } else {
            let path = config.base_path.join(".daemon").join("auth-secret");
            Some(load_or_create_secret(&path)?)
        };
        let rules = merge_rate_limits(config);
        Ok(Self {
            mode,
            secret,
            admin_limiter: AuthRateLimiter::from_rules(&rules),
            recall_llm_limiter: AuthRateLimiter::from_rules(&rules),
        })
    }
}

pub fn read_auth_mode(config: &DaemonConfig) -> AuthMode {
    config
        .manifest
        .auth
        .as_ref()
        .and_then(|auth| auth.mode.as_deref())
        .map(AuthMode::from_str_lossy)
        .unwrap_or_default()
}

pub fn merge_rate_limits(config: &DaemonConfig) -> HashMap<String, RateLimitRule> {
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

/// Shared application state passed to all route handlers.
pub struct AppState {
    pub config: DaemonConfig,
    pub pool: DbPool,
    pub embedding: RwLock<Option<Arc<dyn EmbeddingProvider>>>,
    /// LLM provider for reranking and recall summary synthesis.
    pub llm: RwLock<Option<Arc<dyn LlmProvider>>>,
    pub pipeline_paused: AtomicBool,
    pub pipeline_transition: AtomicBool,
    pub extraction_worker_handle: Mutex<Option<WorkerHandle>>,
    pub summary_worker_handle: Mutex<Option<SummaryHandle>>,
    pub synthesis_worker_handle: Mutex<Option<SynthesisHandle>>,
    pub document_worker_handle: Mutex<Option<DocumentHandle>>,
    pub extraction_worker_stats: RwLock<Option<SharedWorkerRuntimeStats>>,
    pub auth: StdRwLock<AuthRuntimeState>,
    pub sessions: SessionTracker,
    pub continuity: ContinuityTracker,
    pub dedup: DedupState,
    pub extraction_state: RwLock<Option<ExtractionRuntimeState>>,
    pub harness_last_seen: RwLock<HashMap<String, String>>,
    pub openclaw_heartbeat: RwLock<Option<OpenClawHeartbeat>>,
    pub git_config: RwLock<GitRuntimeConfig>,
    pub update_state: RwLock<UpdateRuntimeState>,
    pub analytics: AnalyticsCollector,
    pub secret_exec_jobs: RwLock<HashMap<String, serde_json::Value>>,
    pub os_agent_sessions: RwLock<HashMap<String, OsAgentSession>>,
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
        llm: Option<Arc<dyn LlmProvider>>,
        extraction_worker_stats: Option<SharedWorkerRuntimeStats>,
        auth: AuthRuntimeState,
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
        let git_config = GitRuntimeConfig::load(&config.base_path);
        let update_state =
            UpdateRuntimeState::new(&config.base_path, env!("CARGO_PKG_VERSION").to_string());

        Self {
            config,
            pool,
            embedding: RwLock::new(embedding),
            llm: RwLock::new(llm),
            pipeline_paused: AtomicBool::new(paused),
            pipeline_transition: AtomicBool::new(false),
            extraction_worker_handle: Mutex::new(None),
            summary_worker_handle: Mutex::new(None),
            synthesis_worker_handle: Mutex::new(None),
            document_worker_handle: Mutex::new(None),
            extraction_worker_stats: RwLock::new(extraction_worker_stats),
            auth: StdRwLock::new(auth),
            sessions: SessionTracker::new(),
            continuity: ContinuityTracker::new(),
            dedup: DedupState::new(),
            extraction_state: RwLock::new(extraction_state),
            harness_last_seen: RwLock::new(HashMap::new()),
            openclaw_heartbeat: RwLock::new(None),
            git_config: RwLock::new(git_config),
            update_state: RwLock::new(update_state),
            analytics: AnalyticsCollector::default(),
            secret_exec_jobs: RwLock::new(HashMap::new()),
            os_agent_sessions: RwLock::new(HashMap::new()),
        }
    }

    pub fn pipeline_paused(&self) -> bool {
        self.pipeline_paused.load(Ordering::SeqCst)
    }

    pub fn auth_snapshot(&self) -> AuthRuntimeState {
        match self.auth.read() {
            Ok(auth) => auth.clone(),
            Err(poisoned) => poisoned.into_inner().clone(),
        }
    }

    pub fn reload_auth_runtime(&self) -> anyhow::Result<AuthRuntimeState> {
        let config = DaemonConfig::from_env().map_err(anyhow::Error::msg)?;
        let next = AuthRuntimeState::from_config(&config)?;
        match self.auth.write() {
            Ok(mut auth) => *auth = next.clone(),
            Err(poisoned) => *poisoned.into_inner() = next.clone(),
        }
        Ok(next)
    }

    fn normalize_harness_id(harness: &str) -> Option<&'static str> {
        match harness.trim().to_ascii_lowercase().as_str() {
            "claude" | "claude-code" => Some("claude-code"),
            "opencode" => Some("opencode"),
            "openclaw" => Some("openclaw"),
            "gemini" | "gemini-cli" => Some("gemini"),
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
    use super::{AuthRuntimeState, derive_initial_extraction_state};
    use crate::auth::types::AuthMode;
    use signet_core::config::{AgentManifest, AuthConfig, DaemonConfig};

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

    #[test]
    fn team_auth_without_legacy_method_creates_healthcheck_secret() {
        let dir = tempfile::tempdir().expect("tempdir");
        let config = DaemonConfig {
            base_path: dir.path().to_path_buf(),
            db_path: dir.path().join("memory").join("memories.db"),
            port: 3850,
            host: "127.0.0.1".to_string(),
            bind: Some("127.0.0.1".to_string()),
            manifest: AgentManifest {
                auth: Some(AuthConfig {
                    method: None,
                    chain_id: None,
                    mode: Some("team".to_string()),
                    rate_limits: None,
                }),
                ..Default::default()
            },
        };

        let auth = AuthRuntimeState::from_config(&config).expect("auth runtime");

        assert_eq!(auth.mode, AuthMode::Team);
        assert_eq!(auth.secret.as_deref().map(<[u8]>::len), Some(32));
        let secret = std::fs::read(dir.path().join(".daemon").join("auth-secret"))
            .expect("auth secret file");
        assert_eq!(secret.len(), 32);
    }
}
