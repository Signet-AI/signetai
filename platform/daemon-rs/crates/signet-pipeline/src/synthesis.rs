//! Synthesis worker: deterministic MEMORY.md regeneration.
//!
//! Renders MEMORY.md from canonical artifacts plus DB-native state after an
//! activity window, instead of asking an LLM to rewrite the whole document.

use std::collections::VecDeque;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex as AsyncMutex, Notify, watch};
use tracing::{info, warn};

use signet_core::db::{DbPool, Priority};

use crate::memory_lineage::write_memory_projection;
use crate::provider::{LlmProvider, LlmSemaphore};

const FORCE_RETRY_MS: u64 = 5_000;
const DRAIN_TIMEOUT_BUFFER_MS: u64 = 1_000;

#[derive(Debug, Clone)]
pub struct SynthesisConfig {
    pub poll_ms: u64,
    pub min_interval_secs: u64,
    pub timeout_ms: u64,
    pub max_tokens: u32,
    pub agents_dir: String,
}

impl Default for SynthesisConfig {
    fn default() -> Self {
        Self {
            poll_ms: 30_000,
            min_interval_secs: 3600,
            timeout_ms: 120_000,
            max_tokens: 8192,
            agents_dir: std::env::var("SIGNET_PATH").unwrap_or_else(|_| {
                std::env::var("HOME")
                    .map(|h| format!("{h}/.agents"))
                    .unwrap_or_else(|_| "~/.agents".into())
            }),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SynthesisResult {
    pub summary_count: usize,
    pub output_length: usize,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SynthesisTriggerOptions {
    pub force: bool,
    pub source: Option<String>,
    pub agent_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManualSynthesisResult {
    pub success: bool,
    pub skipped: bool,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SynthesisDrainResult {
    Completed,
    Timeout,
}

#[derive(Debug, Clone)]
struct PendingForce {
    source: String,
    agent_id: String,
    count: usize,
}

#[derive(Debug)]
struct SynthesisStateInner {
    stopped: bool,
    is_synthesizing: bool,
    next_lock_token: u64,
    active_lock_token: Option<u64>,
    pending_queue: VecDeque<PendingForce>,
}

#[derive(Debug)]
struct SynthesisState {
    inner: StdMutex<SynthesisStateInner>,
    notify: Notify,
}

impl SynthesisState {
    fn new() -> Self {
        Self {
            inner: StdMutex::new(SynthesisStateInner {
                stopped: false,
                is_synthesizing: false,
                next_lock_token: 1,
                active_lock_token: None,
                pending_queue: VecDeque::new(),
            }),
            notify: Notify::new(),
        }
    }

    fn set_stopped(&self) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.stopped = true;
        }
        self.notify.notify_waiters();
    }

    fn stopped(&self) -> bool {
        self.inner.lock().map(|inner| inner.stopped).unwrap_or(true)
    }

    fn is_synthesizing(&self) -> bool {
        self.inner
            .lock()
            .map(|inner| inner.is_synthesizing)
            .unwrap_or(false)
    }

    fn pending_force_count(&self) -> usize {
        self.inner
            .lock()
            .map(|inner| inner.pending_queue.iter().map(|entry| entry.count).sum())
            .unwrap_or(0)
    }

    fn acquire_write_lock(&self) -> Option<u64> {
        let mut inner = self.inner.lock().ok()?;
        if inner.stopped || inner.is_synthesizing {
            return None;
        }
        inner.is_synthesizing = true;
        let token = inner.next_lock_token;
        inner.next_lock_token += 1;
        inner.active_lock_token = Some(token);
        Some(token)
    }

    fn release_write_lock(&self, token: u64) {
        if let Ok(mut inner) = self.inner.lock() {
            if inner.active_lock_token != Some(token) {
                return;
            }
            inner.active_lock_token = None;
            inner.is_synthesizing = false;
        }
        self.notify.notify_waiters();
    }

    fn enqueue_pending_force(&self, source: String, agent_id: &str) {
        if let Ok(mut inner) = self.inner.lock() {
            if let Some(existing) = inner
                .pending_queue
                .iter_mut()
                .find(|entry| entry.agent_id == agent_id)
            {
                existing.count += 1;
                existing.source = source;
            } else {
                inner.pending_queue.push_back(PendingForce {
                    source,
                    agent_id: agent_id.to_string(),
                    count: 1,
                });
            }
        }
        self.notify.notify_waiters();
    }

    fn clear_pending_force_for(&self, agent_id: &str) {
        if let Ok(mut inner) = self.inner.lock() {
            inner
                .pending_queue
                .retain(|entry| entry.agent_id != agent_id);
        }
    }

    fn peek_pending_force(&self) -> Option<PendingForce> {
        self.inner
            .lock()
            .ok()
            .and_then(|inner| inner.pending_queue.front().cloned())
    }

    fn complete_pending_force(&self, agent_id: &str) {
        if let Ok(mut inner) = self.inner.lock()
            && let Some(entry) = inner.pending_queue.front_mut()
            && entry.agent_id == agent_id
        {
            if entry.count <= 1 {
                inner.pending_queue.pop_front();
            } else {
                entry.count -= 1;
            }
        }
        self.notify.notify_waiters();
    }

    fn rotate_pending_force(&self) {
        if let Ok(mut inner) = self.inner.lock() {
            if inner.pending_queue.len() > 1
                && let Some(entry) = inner.pending_queue.pop_front()
            {
                inner.pending_queue.push_back(entry);
            }
        }
    }
}

pub struct SynthesisHandle {
    shutdown: watch::Sender<bool>,
    handle: AsyncMutex<Option<tokio::task::JoinHandle<()>>>,
    state: Arc<SynthesisState>,
    pool: DbPool,
    provider: Arc<dyn LlmProvider>,
    semaphore: Arc<LlmSemaphore>,
    config: SynthesisConfig,
}

impl SynthesisHandle {
    pub async fn stop(&self) {
        self.state.set_stopped();
        let _ = self.shutdown.send(true);
        let handle = self.handle.lock().await.take();
        if let Some(handle) = handle {
            let _ = handle.await;
        }
    }

    pub async fn drain(&self) -> SynthesisDrainResult {
        if !self.state.is_synthesizing() {
            return SynthesisDrainResult::Completed;
        }

        let timeout_ms = self.config.timeout_ms + DRAIN_TIMEOUT_BUFFER_MS;
        let timeout = tokio::time::sleep(Duration::from_millis(timeout_ms));
        tokio::pin!(timeout);
        loop {
            tokio::select! {
                _ = &mut timeout => return SynthesisDrainResult::Timeout,
                _ = self.state.notify.notified() => {
                    if !self.state.is_synthesizing() {
                        return SynthesisDrainResult::Completed;
                    }
                }
            }
        }
    }

    pub fn acquire_write_lock(&self) -> Option<u64> {
        self.state.acquire_write_lock()
    }

    pub fn release_write_lock(&self, token: u64) {
        self.state.release_write_lock(token);
    }

    pub fn running(&self) -> bool {
        !self.state.stopped()
    }

    pub fn is_synthesizing(&self) -> bool {
        self.state.is_synthesizing()
    }

    pub fn pending_force_count(&self) -> usize {
        self.state.pending_force_count()
    }

    pub fn last_run_at(&self, agent_id: Option<&str>) -> u64 {
        read_last_synthesis_time_at(&self.config.agents_dir, agent_id)
    }

    pub async fn trigger_now(
        &self,
        opts: Option<SynthesisTriggerOptions>,
    ) -> ManualSynthesisResult {
        let opts = opts.unwrap_or_default();
        let agent_id = normalize_agent_id(opts.agent_id.as_deref());
        if self.state.stopped() {
            return ManualSynthesisResult {
                success: false,
                skipped: true,
                reason: Some("Synthesis worker stopped".to_string()),
            };
        }

        let Some(lock_token) = self.state.acquire_write_lock() else {
            if opts.force {
                self.state.enqueue_pending_force(
                    opts.source.unwrap_or_else(|| "manual".to_string()),
                    &agent_id,
                );
                return ManualSynthesisResult {
                    success: false,
                    skipped: true,
                    reason: Some("Synthesis already in progress (queued forced retry)".to_string()),
                };
            }
            return ManualSynthesisResult {
                success: false,
                skipped: true,
                reason: Some("Synthesis already in progress".to_string()),
            };
        };

        let result = async {
            let now = unix_ms();
            let last_run = read_last_synthesis_time_at(&self.config.agents_dir, Some(&agent_id));
            let elapsed = now.saturating_sub(last_run);
            let min_interval_ms = self.config.min_interval_secs.saturating_mul(1_000);
            if !opts.force && elapsed < min_interval_ms {
                let reason = format!(
                    "Too recent — last run {}m ago, minimum is {}m",
                    elapsed / 60_000,
                    min_interval_ms / 60_000
                );
                return ManualSynthesisResult {
                    success: false,
                    skipped: true,
                    reason: Some(reason),
                };
            }

            let run = run_synthesis_state(
                &self.pool,
                &self.provider,
                &self.semaphore,
                &self.config,
                &agent_id,
            )
            .await;

            if matches!(run, SynthesisRunState::Busy | SynthesisRunState::Failed) && opts.force {
                self.state.enqueue_pending_force(
                    opts.source.unwrap_or_else(|| "manual".to_string()),
                    &agent_id,
                );
            }
            if should_record_success(&run) {
                write_last_synthesis_time_at(&self.config.agents_dir, unix_ms(), Some(&agent_id));
                self.state.clear_pending_force_for(&agent_id);
            }

            match run {
                SynthesisRunState::Ok(_) => ManualSynthesisResult {
                    success: true,
                    skipped: false,
                    reason: None,
                },
                SynthesisRunState::Empty => ManualSynthesisResult {
                    success: false,
                    skipped: true,
                    reason: Some("No session summaries to synthesize".to_string()),
                },
                SynthesisRunState::Busy => ManualSynthesisResult {
                    success: false,
                    skipped: true,
                    reason: Some(if opts.force {
                        "MEMORY.md head busy (queued forced retry)".to_string()
                    } else {
                        "MEMORY.md head busy".to_string()
                    }),
                },
                SynthesisRunState::Failed => ManualSynthesisResult {
                    success: false,
                    skipped: false,
                    reason: None,
                },
            }
        }
        .await;

        self.state.release_write_lock(lock_token);
        result
    }
}

pub fn start(
    pool: DbPool,
    provider: Arc<dyn LlmProvider>,
    semaphore: Arc<LlmSemaphore>,
    config: SynthesisConfig,
) -> SynthesisHandle {
    let (tx, rx) = watch::channel(false);
    let state = Arc::new(SynthesisState::new());
    let handle = tokio::spawn(worker_loop(
        pool.clone(),
        provider.clone(),
        semaphore.clone(),
        config.clone(),
        state.clone(),
        rx,
    ));
    SynthesisHandle {
        shutdown: tx,
        handle: AsyncMutex::new(Some(handle)),
        state,
        pool,
        provider,
        semaphore,
        config,
    }
}

async fn worker_loop(
    pool: DbPool,
    provider: Arc<dyn LlmProvider>,
    semaphore: Arc<LlmSemaphore>,
    config: SynthesisConfig,
    state: Arc<SynthesisState>,
    mut shutdown: watch::Receiver<bool>,
) {
    let base = Duration::from_millis(config.poll_ms.max(1));

    info!(poll_ms = config.poll_ms, "synthesis worker started");

    loop {
        tokio::select! {
            _ = tokio::time::sleep(base) => {}
            _ = state.notify.notified() => {}
            _ = shutdown.changed() => {
                info!("synthesis worker shutting down");
                break;
            }
        }

        if *shutdown.borrow() || state.stopped() {
            break;
        }

        if let Some(pending) = state.peek_pending_force() {
            let retry_delay = if run_forced_drain_attempt(
                &pool, &provider, &semaphore, &config, &state, &pending,
            )
            .await
            {
                state.complete_pending_force(&pending.agent_id);
                state.pending_force_count() > 0
            } else {
                state.rotate_pending_force();
                true
            };
            if retry_delay {
                tokio::time::sleep(Duration::from_millis(
                    FORCE_RETRY_MS.min(config.poll_ms.max(1)),
                ))
                .await;
            }
            continue;
        }

        let last_run = read_last_synthesis_time_at(&config.agents_dir, Some("default"));
        let elapsed = unix_ms().saturating_sub(last_run);
        if elapsed < config.min_interval_secs.saturating_mul(1_000) {
            continue;
        }

        let needs_synthesis = match check_synthesis_needed(&pool).await {
            Ok(needed) => needed,
            Err(err) => {
                warn!(err = %err, "failed to check synthesis need");
                continue;
            }
        };
        if !needs_synthesis {
            continue;
        }

        let Some(lock_token) = state.acquire_write_lock() else {
            continue;
        };
        info!("starting MEMORY.md synthesis");
        let started_at = std::time::Instant::now();

        match run_synthesis_state(&pool, &provider, &semaphore, &config, "default").await {
            SynthesisRunState::Ok(result) => {
                write_last_synthesis_time_at(&config.agents_dir, unix_ms(), Some("default"));
                info!(
                    summaries = result.summary_count,
                    length = result.output_length,
                    duration_ms = started_at.elapsed().as_millis() as u64,
                    "synthesis completed"
                );
            }
            SynthesisRunState::Empty => {
                write_last_synthesis_time_at(&config.agents_dir, unix_ms(), Some("default"));
                info!("synthesis skipped because no summaries were available");
            }
            SynthesisRunState::Busy => {
                warn!("MEMORY.md head busy, synthesis will retry on a later tick");
            }
            SynthesisRunState::Failed => {
                warn!("synthesis failed");
            }
        }
        state.release_write_lock(lock_token);
    }
}

async fn run_forced_drain_attempt(
    pool: &DbPool,
    provider: &Arc<dyn LlmProvider>,
    semaphore: &Arc<LlmSemaphore>,
    config: &SynthesisConfig,
    state: &SynthesisState,
    pending: &PendingForce,
) -> bool {
    let Some(lock_token) = state.acquire_write_lock() else {
        return false;
    };

    let result = run_synthesis_state(pool, provider, semaphore, config, &pending.agent_id).await;
    let completed = should_record_success(&result);
    if completed {
        write_last_synthesis_time_at(&config.agents_dir, unix_ms(), Some(&pending.agent_id));
    } else {
        warn!(
            source = pending.source,
            agent_id = pending.agent_id,
            "forced synthesis retry deferred"
        );
    }
    state.release_write_lock(lock_token);
    completed
}

async fn check_synthesis_needed(pool: &DbPool) -> Result<bool, String> {
    let count: usize = pool
        .read(|conn| {
            Ok(conn
                .query_row(
                    "SELECT COUNT(*) FROM session_summaries WHERE agent_id = ?1",
                    ["default"],
                    |row| row.get(0),
                )
                .unwrap_or(0))
        })
        .await
        .map_err(|err| err.to_string())?;
    Ok(count > 0)
}

#[derive(Debug)]
enum SynthesisRunState {
    Ok(SynthesisResult),
    Empty,
    Busy,
    Failed,
}

fn should_record_success(result: &SynthesisRunState) -> bool {
    matches!(result, SynthesisRunState::Ok(_) | SynthesisRunState::Empty)
}

async fn run_synthesis_state(
    pool: &DbPool,
    provider: &Arc<dyn LlmProvider>,
    semaphore: &Arc<LlmSemaphore>,
    config: &SynthesisConfig,
    agent_id: &str,
) -> SynthesisRunState {
    match run_synthesis_for_agent(pool, provider, semaphore, config, agent_id).await {
        Ok(result) if result.summary_count == 0 => SynthesisRunState::Empty,
        Ok(result) => SynthesisRunState::Ok(result),
        Err(err) if is_busy_error(&err) => {
            warn!(err = %err, "MEMORY.md head busy");
            SynthesisRunState::Busy
        }
        Err(err) => {
            warn!(err = %err, "synthesis failed");
            SynthesisRunState::Failed
        }
    }
}

async fn run_synthesis_for_agent(
    pool: &DbPool,
    _provider: &Arc<dyn LlmProvider>,
    _semaphore: &Arc<LlmSemaphore>,
    config: &SynthesisConfig,
    agent_id: &str,
) -> Result<SynthesisResult, String> {
    let start = std::time::Instant::now();
    let root = PathBuf::from(&config.agents_dir);
    let agent_id = agent_id.to_string();
    let data = pool
        .write(Priority::Low, move |conn| {
            let count: usize = conn
                .query_row(
                    "SELECT COUNT(*) FROM session_summaries WHERE agent_id = ?1",
                    [&agent_id],
                    |row| row.get(0),
                )
                .unwrap_or(0);
            if count == 0 {
                return Ok(serde_json::json!({
                    "count": 0usize,
                    "length": 0usize,
                }));
            }
            let rendered = write_memory_projection(conn, &root, &agent_id) // TODO REVIEW #9: TS uses memory_md_heads lease/revision/backups; Rust bypasses those. Documented gap.
                .map_err(signet_core::error::CoreError::Migration)?;
            Ok(serde_json::json!({
                "count": count,
                "length": rendered.content.len(),
            }))
        })
        .await
        .map_err(|err| err.to_string())?;

    Ok(SynthesisResult {
        summary_count: data
            .get("count")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0) as usize,
        output_length: data
            .get("length")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0) as usize,
        duration_ms: start.elapsed().as_millis() as u64,
    })
}

fn is_busy_error(err: &str) -> bool {
    let lower = err.to_lowercase();
    lower.contains("busy") || lower.contains("locked")
}

fn normalize_agent_id(agent_id: Option<&str>) -> String {
    let next = agent_id.unwrap_or("default").trim();
    if next.is_empty() {
        "default".to_string()
    } else {
        next.to_string()
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct LastSynthesisState {
    last_run_at: u64,
}

pub fn read_last_synthesis_time_at<P: AsRef<Path>>(agents_dir: P, agent_id: Option<&str>) -> u64 {
    let path = last_synthesis_path(agents_dir.as_ref(), agent_id);
    let Ok(raw) = fs::read_to_string(path) else {
        return 0;
    };
    serde_json::from_str::<LastSynthesisState>(&raw)
        .map(|state| state.last_run_at)
        .unwrap_or(0)
}

pub fn write_last_synthesis_time_at<P: AsRef<Path>>(
    agents_dir: P,
    timestamp: u64,
    agent_id: Option<&str>,
) {
    let agents_dir = agents_dir.as_ref();
    let daemon_dir = agents_dir.join(".daemon");
    if fs::create_dir_all(&daemon_dir).is_err() {
        return;
    }
    let path = last_synthesis_path(agents_dir, agent_id);
    let body = serde_json::to_string(&LastSynthesisState {
        last_run_at: timestamp,
    })
    .unwrap_or_else(|_| format!("{{\"lastRunAt\":{timestamp}}}"));
    let _ = fs::write(path, body);
}

fn last_synthesis_path(agents_dir: &Path, agent_id: Option<&str>) -> PathBuf {
    let agent_id = normalize_agent_id(agent_id);
    let filename = if agent_id == "default" {
        "last-synthesis.json".to_string()
    } else {
        format!("last-synthesis.{}.json", encode_uri_component(&agent_id))
    };
    agents_dir.join(".daemon").join(filename)
}

fn encode_uri_component(value: &str) -> String {
    let mut out = String::new();
    for byte in value.bytes() {
        let ch = byte as char;
        if ch.is_ascii_alphanumeric()
            || matches!(ch, '-' | '_' | '.' | '!' | '~' | '*' | '\'' | '(' | ')')
        {
            out.push(ch);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

fn unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}
