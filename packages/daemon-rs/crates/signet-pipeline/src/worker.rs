//! Pipeline worker: leases jobs, calls LLM extraction, applies decisions.
//!
//! The worker polls the `memory_jobs` queue, processes extraction jobs
//! via the LLM provider, and writes results through the DB writer.

use std::sync::Arc;
use std::time::Duration;

use chrono::Utc;
use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex, watch};
use tracing::{info, warn};

use signet_core::db::DbPool;

use crate::extraction;
use crate::provider::{GenerateOpts, LlmProvider, LlmSemaphore};

// ---------------------------------------------------------------------------
// Worker config
// ---------------------------------------------------------------------------

/// Configuration for the pipeline worker.
#[derive(Debug, Clone)]
pub struct WorkerConfig {
    pub poll_ms: u64,
    pub max_retries: u32,
    pub lease_timeout_ms: u64,
    pub max_load_per_cpu: f64,
    pub overload_backoff_ms: u64,
    pub extraction_timeout_ms: u64,
    pub extraction_max_tokens: u32,
    pub min_confidence: f64,
    pub shadow_mode: bool,
    pub graph_enabled: bool,
    pub structural_enabled: bool,
}

impl Default for WorkerConfig {
    fn default() -> Self {
        Self {
            poll_ms: 500,
            max_retries: 3,
            lease_timeout_ms: 30_000,
            max_load_per_cpu: 0.8,
            overload_backoff_ms: 30_000,
            extraction_timeout_ms: 90_000,
            extraction_max_tokens: 4096,
            min_confidence: 0.5,
            shadow_mode: false,
            graph_enabled: true,
            structural_enabled: true,
        }
    }
}

// ---------------------------------------------------------------------------
// Job types
// ---------------------------------------------------------------------------

/// A leased job from the queue.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LeasedJob {
    pub id: String,
    pub memory_id: Option<String>,
    pub job_type: String,
    pub payload: Option<String>,
    pub attempts: i64,
}

/// Result of processing a job.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobResult {
    pub facts_extracted: usize,
    pub entities_extracted: usize,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerRuntimeSnapshot {
    pub running: bool,
    pub overloaded: bool,
    pub load_per_cpu: Option<f64>,
    pub overload_since_ms: Option<i64>,
    pub next_tick_in_ms: Option<u64>,
    pub max_load_per_cpu: f64,
    pub overload_backoff_ms: u64,
}

#[derive(Debug, Clone)]
pub struct WorkerRuntimeStats {
    running: bool,
    overloaded: bool,
    load_per_cpu: Option<f64>,
    overload_since_ms: Option<i64>,
    next_tick_at_ms: Option<i64>,
    max_load_per_cpu: f64,
    overload_backoff_ms: u64,
}

impl WorkerRuntimeStats {
    fn new(max_load_per_cpu: f64, overload_backoff_ms: u64) -> Self {
        Self {
            running: false,
            overloaded: false,
            load_per_cpu: None,
            overload_since_ms: None,
            next_tick_at_ms: None,
            max_load_per_cpu,
            overload_backoff_ms,
        }
    }

    fn mark_running(&mut self, running: bool) {
        self.running = running;
        if !running {
            self.overloaded = false;
            self.load_per_cpu = None;
            self.overload_since_ms = None;
            self.next_tick_at_ms = None;
        }
    }

    fn record_poll_state(&mut self, load_per_cpu: Option<f64>, overloaded: bool, now_ms: i64) {
        self.load_per_cpu = load_per_cpu;
        self.overloaded = overloaded;

        if !overloaded {
            self.overload_since_ms = None;
            return;
        }

        if self.overload_since_ms.is_none() {
            self.overload_since_ms = Some(now_ms);
        }
    }

    fn record_next_delay(&mut self, now_ms: i64, delay_ms: u64) {
        self.next_tick_at_ms = Some(now_ms.saturating_add(delay_ms as i64));
    }

    pub fn snapshot(&self, now_ms: i64) -> WorkerRuntimeSnapshot {
        WorkerRuntimeSnapshot {
            running: self.running,
            overloaded: self.overloaded,
            load_per_cpu: self.load_per_cpu,
            overload_since_ms: self.overload_since_ms,
            next_tick_in_ms: self
                .next_tick_at_ms
                .map(|at| at.saturating_sub(now_ms).max(0) as u64),
            max_load_per_cpu: self.max_load_per_cpu,
            overload_backoff_ms: self.overload_backoff_ms,
        }
    }
}

pub type SharedWorkerRuntimeStats = Arc<Mutex<WorkerRuntimeStats>>;

/// Build a shared runtime-stats handle using configured load-shedding bounds.
pub fn new_runtime_stats_handle(
    max_load_per_cpu: f64,
    overload_backoff_ms: u64,
) -> SharedWorkerRuntimeStats {
    Arc::new(Mutex::new(WorkerRuntimeStats::new(
        max_load_per_cpu,
        overload_backoff_ms,
    )))
}

// ---------------------------------------------------------------------------
// Worker handle
// ---------------------------------------------------------------------------

/// Handle for controlling the pipeline worker.
pub struct WorkerHandle {
    shutdown: watch::Sender<bool>,
    handle: tokio::task::JoinHandle<()>,
    stats: SharedWorkerRuntimeStats,
}

impl WorkerHandle {
    pub fn stats_handle(&self) -> SharedWorkerRuntimeStats {
        self.stats.clone()
    }

    /// Signal the worker to stop and wait for it to finish.
    pub async fn stop(self) {
        let _ = self.shutdown.send(true);
        let _ = self.handle.await;
    }
}

// ---------------------------------------------------------------------------
// Start the worker
// ---------------------------------------------------------------------------

/// Start the pipeline worker loop.
pub fn start(
    pool: DbPool,
    provider: Arc<dyn LlmProvider>,
    semaphore: Arc<LlmSemaphore>,
    config: WorkerConfig,
) -> WorkerHandle {
    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let stats = new_runtime_stats_handle(config.max_load_per_cpu, config.overload_backoff_ms);

    let handle = tokio::spawn(worker_loop(
        pool,
        provider,
        semaphore,
        config,
        shutdown_rx,
        stats.clone(),
    ));

    WorkerHandle {
        shutdown: shutdown_tx,
        handle,
        stats,
    }
}

fn current_epoch_ms() -> i64 {
    Utc::now().timestamp_millis()
}

fn current_load_per_cpu() -> Option<f64> {
    #[cfg(unix)]
    {
        let mut loads = [0.0f64; 1];
        // SAFETY: `loads` points to writable storage for one f64 sample.
        let rc = unsafe { libc::getloadavg(loads.as_mut_ptr(), 1) };
        if rc < 1 {
            return None;
        }
        let cpus = std::thread::available_parallelism().ok()?.get() as f64;
        if cpus <= 0.0 {
            return None;
        }
        return Some(loads[0] / cpus);
    }

    #[cfg(not(unix))]
    {
        None
    }
}

async fn worker_loop(
    pool: DbPool,
    provider: Arc<dyn LlmProvider>,
    semaphore: Arc<LlmSemaphore>,
    config: WorkerConfig,
    mut shutdown: watch::Receiver<bool>,
    stats: SharedWorkerRuntimeStats,
) {
    let mut consecutive_failures: u32 = 0;
    let base_delay = Duration::from_millis(config.poll_ms);
    let max_delay = Duration::from_secs(60);

    info!(
        poll_ms = config.poll_ms,
        provider = provider.name(),
        "pipeline worker started"
    );

    {
        let mut guard = stats.lock().await;
        guard.mark_running(true);
    }

    loop {
        // Check shutdown
        if *shutdown.borrow() {
            info!("pipeline worker shutting down");
            let mut guard = stats.lock().await;
            guard.mark_running(false);
            break;
        }

        let now_ms = current_epoch_ms();
        let load_per_cpu = current_load_per_cpu();
        let overloaded = load_per_cpu
            .map(|load| load.is_finite() && load > config.max_load_per_cpu)
            .unwrap_or(false);

        {
            let mut guard = stats.lock().await;
            guard.record_poll_state(load_per_cpu, overloaded, now_ms);
        }

        // Calculate backoff delay
        let delay = if overloaded {
            Duration::from_millis(config.overload_backoff_ms)
        } else {
            if consecutive_failures > 0 {
                let backoff = base_delay * 2u32.pow(consecutive_failures.min(6));
                backoff.min(max_delay)
            } else {
                base_delay
            }
        };

        {
            let mut guard = stats.lock().await;
            guard.record_next_delay(now_ms, delay.as_millis() as u64);
        }

        // Wait with shutdown check
        tokio::select! {
            _ = tokio::time::sleep(delay) => {}
            _ = shutdown.changed() => {
                info!("pipeline worker shutting down");
                let mut guard = stats.lock().await;
                guard.mark_running(false);
                break;
            }
        }

        if overloaded {
            continue;
        }

        // Try to lease a job
        let job = match lease_job(&pool, config.max_retries).await {
            Ok(Some(job)) => job,
            Ok(None) => continue, // No jobs available
            Err(e) => {
                warn!(err = %e, "failed to lease job");
                consecutive_failures += 1;
                continue;
            }
        };

        info!(job_id = %job.id, job_type = %job.job_type, "processing pipeline job");

        // Process based on job type
        let result = match job.job_type.as_str() {
            "extract" | "extraction" => process_extract(&pool, &job, &provider, &semaphore, &config).await,
            other => {
                warn!(job_type = other, "unknown job type");
                Err(format!("unknown job type: {other}"))
            }
        };

        // Record result
        match result {
            Ok(jr) => {
                consecutive_failures = 0;
                let result_json = serde_json::to_string(&jr).unwrap_or_default();
                if let Err(e) = complete_job(&pool, &job.id, &result_json).await {
                    warn!(err = %e, job_id = %job.id, "failed to complete job");
                }
                info!(
                    job_id = %job.id,
                    facts = jr.facts_extracted,
                    entities = jr.entities_extracted,
                    "job completed"
                );
            }
            Err(e) => {
                consecutive_failures += 1;
                warn!(err = %e, job_id = %job.id, "job failed");
                if let Err(fe) = fail_job(&pool, &job.id, &e).await {
                    warn!(err = %fe, job_id = %job.id, "failed to record job failure");
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Job processing
// ---------------------------------------------------------------------------

async fn process_extract(
    pool: &DbPool,
    job: &LeasedJob,
    provider: &Arc<dyn LlmProvider>,
    semaphore: &Arc<LlmSemaphore>,
    config: &WorkerConfig,
) -> Result<JobResult, String> {
    // Load memory content
    let memory_id = job
        .memory_id
        .as_deref()
        .ok_or("extract job missing memory_id")?
        .to_string();

    let content = pool
        .read(move |conn| {
            let mut stmt =
                conn.prepare_cached("SELECT content FROM memories WHERE id = ?1 AND deleted = 0")?;
            let content: Option<String> = stmt
                .query_row(rusqlite::params![memory_id], |r| r.get(0))
                .ok();
            Ok(content)
        })
        .await
        .map_err(|e| e.to_string())?
        .ok_or("memory not found or deleted")?;

    if content.trim().len() < 20 {
        return Ok(JobResult {
            facts_extracted: 0,
            entities_extracted: 0,
            warnings: vec!["content too short for extraction".into()],
        });
    }

    // Build prompt and call LLM (semaphore-guarded)
    let prompt = extraction::build_prompt(&content);
    let opts = GenerateOpts {
        timeout_ms: Some(config.extraction_timeout_ms),
        max_tokens: Some(config.extraction_max_tokens),
    };

    let provider = provider.clone();
    let raw = semaphore
        .run(async { provider.generate(&prompt, &opts).await })
        .await
        .map_err(|e| format!("LLM generation failed: {e}"))?;

    // Parse extraction output
    let result = extraction::parse(&raw.text);

    // Filter by confidence threshold
    let facts: Vec<_> = result
        .facts
        .into_iter()
        .filter(|f| f.confidence >= config.min_confidence)
        .collect();

    let facts_count = facts.len();
    let entities_count = result.entities.len();

    // TODO: Phase 5.3 — apply shadow decisions (add/update/delete)
    // For now, record extraction results without applying writes.
    // The full pipeline will:
    // 1. Search for existing similar memories (hybrid search)
    // 2. Run shadow decision engine (add/update/delete/none)
    // 3. Apply controlled writes with safety gates
    // 4. Persist graph entities
    // 5. Enqueue structural jobs (classify, dependency)

    Ok(JobResult {
        facts_extracted: facts_count,
        entities_extracted: entities_count,
        warnings: result.warnings,
    })
}

// ---------------------------------------------------------------------------
// Job queue operations
// ---------------------------------------------------------------------------

async fn lease_job(pool: &DbPool, max_attempts: u32) -> Result<Option<LeasedJob>, String> {
    let val = pool
        .write(signet_core::db::Priority::Low, move |conn| {
            let ts = chrono::Utc::now().to_rfc3339();
            let mut stmt = conn.prepare_cached(
                "UPDATE memory_jobs SET status = 'leased', leased_at = ?1, updated_at = ?1, attempts = attempts + 1
                 WHERE id = (
                    SELECT id FROM memory_jobs
                    WHERE status = 'pending' AND attempts < ?2
                    ORDER BY created_at ASC LIMIT 1
                 ) RETURNING id, memory_id, job_type, payload, attempts",
            )?;

            let job = stmt
                .query_row(rusqlite::params![ts, max_attempts], |row| {
                    Ok(serde_json::json!({
                        "id": row.get::<_, String>(0)?,
                        "memory_id": row.get::<_, Option<String>>(1)?,
                        "job_type": row.get::<_, String>(2)?,
                        "payload": row.get::<_, Option<String>>(3)?,
                        "attempts": row.get::<_, i64>(4)?,
                    }))
                })
                .ok();

            Ok(job.unwrap_or(serde_json::Value::Null))
        })
        .await
        .map_err(|e| e.to_string())?;

    if val.is_null() {
        Ok(None)
    } else {
        serde_json::from_value(val).map_err(|e| e.to_string())
    }
}

async fn complete_job(pool: &DbPool, job_id: &str, result: &str) -> Result<(), String> {
    let id = job_id.to_string();
    let result = result.to_string();
    pool.write(signet_core::db::Priority::Low, move |conn| {
        let ts = chrono::Utc::now().to_rfc3339();
        conn.execute(
            "UPDATE memory_jobs SET status = 'completed', result = ?1, completed_at = ?2, updated_at = ?2 WHERE id = ?3",
            rusqlite::params![result, ts, id],
        )?;
        Ok(serde_json::Value::Null)
    })
    .await
    .map(|_| ())
    .map_err(|e| e.to_string())
}

async fn fail_job(pool: &DbPool, job_id: &str, error: &str) -> Result<(), String> {
    let id = job_id.to_string();
    let error = error.to_string();
    pool.write(signet_core::db::Priority::Low, move |conn| {
        let ts = chrono::Utc::now().to_rfc3339();
        conn.execute(
            "UPDATE memory_jobs SET status = 'pending', error = ?1, failed_at = ?2, updated_at = ?2, attempts = attempts + 1 WHERE id = ?3",
            rusqlite::params![error, ts, id],
        )?;
        Ok(serde_json::Value::Null)
    })
    .await
    .map(|_| ())
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::{WorkerRuntimeStats, new_runtime_stats_handle};

    #[test]
    fn runtime_stats_preserve_overload_since_and_countdown() {
        let mut stats = WorkerRuntimeStats::new(0.8, 30_000);
        stats.mark_running(true);
        stats.record_poll_state(Some(1.4), true, 1_000);
        stats.record_next_delay(1_000, 30_000);
        let snap_1 = stats.snapshot(1_000);
        assert!(snap_1.running);
        assert!(snap_1.overloaded);
        assert_eq!(snap_1.overload_since_ms, Some(1_000));
        assert_eq!(snap_1.next_tick_in_ms, Some(30_000));

        stats.record_poll_state(Some(1.2), true, 11_000);
        stats.record_next_delay(11_000, 20_000);
        let snap_2 = stats.snapshot(11_000);
        assert_eq!(snap_2.overload_since_ms, Some(1_000));
        assert_eq!(snap_2.next_tick_in_ms, Some(20_000));
    }

    #[test]
    fn runtime_stats_clear_when_not_overloaded_or_not_running() {
        let mut stats = WorkerRuntimeStats::new(0.8, 30_000);
        stats.mark_running(true);
        stats.record_poll_state(Some(1.3), true, 1_000);
        stats.record_next_delay(1_000, 30_000);
        stats.record_poll_state(Some(0.2), false, 2_000);
        stats.record_next_delay(2_000, 2_000);
        let snap = stats.snapshot(2_000);
        assert!(!snap.overloaded);
        assert_eq!(snap.overload_since_ms, None);
        assert_eq!(snap.next_tick_in_ms, Some(2_000));

        stats.mark_running(false);
        let snap = stats.snapshot(3_000);
        assert!(!snap.running);
        assert_eq!(snap.load_per_cpu, None);
        assert_eq!(snap.next_tick_in_ms, None);
    }

    #[tokio::test]
    async fn new_runtime_stats_handle_uses_configured_bounds() {
        let stats = new_runtime_stats_handle(0.55, 42_000);
        let snap = stats.lock().await.snapshot(0);
        assert_eq!(snap.max_load_per_cpu, 0.55);
        assert_eq!(snap.overload_backoff_ms, 42_000);
        assert!(!snap.running);
        assert!(!snap.overloaded);
    }
}
