//! Synthesis worker: deterministic MEMORY.md regeneration.
//!
//! Renders MEMORY.md from canonical artifacts plus DB-native state after an
//! activity window, instead of asking an LLM to rewrite the whole document.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use tokio::sync::{Mutex, watch};
use tracing::{info, warn};

use signet_core::db::{DbPool, Priority};

use crate::memory_lineage::write_memory_projection;
use crate::provider::{LlmProvider, LlmSemaphore};

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

pub struct SynthesisHandle {
    shutdown: watch::Sender<bool>,
    handle: tokio::task::JoinHandle<()>,
}

impl SynthesisHandle {
    pub async fn stop(self) {
        let _ = self.shutdown.send(true);
        let _ = self.handle.await;
    }
}

pub fn start(
    pool: DbPool,
    provider: Arc<dyn LlmProvider>,
    semaphore: Arc<LlmSemaphore>,
    config: SynthesisConfig,
) -> SynthesisHandle {
    let (tx, rx) = watch::channel(false);
    let handle = tokio::spawn(worker_loop(pool, provider, semaphore, config, rx));
    SynthesisHandle {
        shutdown: tx,
        handle,
    }
}

async fn worker_loop(
    pool: DbPool,
    provider: Arc<dyn LlmProvider>,
    semaphore: Arc<LlmSemaphore>,
    config: SynthesisConfig,
    mut shutdown: watch::Receiver<bool>,
) {
    let write_lock: Arc<Mutex<()>> = Arc::new(Mutex::new(()));
    let mut last_synthesis: Option<std::time::Instant> = None;
    let base = Duration::from_millis(config.poll_ms);

    info!(poll_ms = config.poll_ms, "synthesis worker started");

    loop {
        tokio::select! {
            _ = tokio::time::sleep(base) => {}
            _ = shutdown.changed() => {
                info!("synthesis worker shutting down");
                break;
            }
        }

        if *shutdown.borrow() {
            break;
        }

        if let Some(last) = last_synthesis
            && last.elapsed() < Duration::from_secs(config.min_interval_secs)
        {
            continue;
        }

        let needs_synthesis = match check_synthesis_needed(&pool, &last_synthesis).await {
            Ok(needed) => needed,
            Err(err) => {
                warn!(err = %err, "failed to check synthesis need");
                continue;
            }
        };
        if !needs_synthesis {
            continue;
        }

        let _guard = write_lock.lock().await;
        info!("starting MEMORY.md synthesis");
        let start = std::time::Instant::now();

        match run_synthesis(&pool, &provider, &semaphore, &config).await {
            Ok(result) => {
                last_synthesis = Some(std::time::Instant::now());
                info!(
                    summaries = result.summary_count,
                    length = result.output_length,
                    duration_ms = start.elapsed().as_millis() as u64,
                    "synthesis completed"
                );
            }
            Err(err) => {
                warn!(err = %err, "synthesis failed");
            }
        }
    }
}

async fn check_synthesis_needed(
    pool: &DbPool,
    last_run: &Option<std::time::Instant>,
) -> Result<bool, String> {
    if last_run.is_none() {
        let count: usize = pool
            .read(|conn| {
                Ok(conn
                    .query_row("SELECT COUNT(*) FROM session_summaries", [], |row| {
                        row.get(0)
                    })
                    .unwrap_or(0))
            })
            .await
            .map_err(|err| err.to_string())?;
        return Ok(count > 0);
    }

    let count: usize = pool
        .read(|conn| {
            Ok(conn
                .query_row(
                    "SELECT COUNT(*) FROM summary_jobs WHERE status = 'completed' AND completed_at > datetime('now', '-1 hour')",
                    [],
                    |row| row.get(0),
                )
                .unwrap_or(0))
        })
        .await
        .map_err(|err| err.to_string())?;
    Ok(count > 0)
}

async fn run_synthesis(
    pool: &DbPool,
    _provider: &Arc<dyn LlmProvider>,
    _semaphore: &Arc<LlmSemaphore>,
    config: &SynthesisConfig,
) -> Result<SynthesisResult, String> {
    let start = std::time::Instant::now();
    let root = PathBuf::from(&config.agents_dir);
    let data = pool
        .write(Priority::Low, move |conn| {
            let count: usize = conn
                .query_row(
                    "SELECT COUNT(*) FROM session_summaries WHERE agent_id = ?1",
                    ["default"],
                    |row| row.get(0),
                )
                .unwrap_or(0);
            if count == 0 {
                return Ok(serde_json::json!({
                    "count": 0usize,
                    "length": 0usize,
                }));
            }
            let rendered = write_memory_projection(conn, &root, "default")
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
