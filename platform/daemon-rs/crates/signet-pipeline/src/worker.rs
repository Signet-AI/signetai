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
use signet_services::graph;

use crate::decision::{self, DecisionConfig};
use crate::extraction;
use crate::provider::{GenerateOpts, LlmProvider, LlmSemaphore};
use crate::significance_gate::{self, SignificanceConfig};
use crate::write_gate::{self, WriteGateConfig};

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
    /// Significance gate: skips extraction for trivial sessions.
    pub significance: SignificanceConfig,
    /// Decision engine: evaluates extracted facts against existing memories.
    pub decision: DecisionConfig,
    /// Write gate: adaptive surprisal threshold for candidate memories.
    pub write_gate: WriteGateConfig,
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
            significance: SignificanceConfig {
                enabled: true,
                min_turns: 5,
                min_entity_overlap: 1,
                novelty_threshold: 0.15,
            },
            decision: DecisionConfig {
                alpha: 0.6,
                min_score: 0.3,
                timeout_ms: 30_000,
            },
            write_gate: WriteGateConfig {
                enabled: true,
                threshold: 0.3,
                continuity_discount: 0.1,
            },
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

    // Startup recovery: mark memory_jobs stuck in 'pending' with exhausted
    // attempts as 'dead'. The tick loop requires attempts < max_attempts, so
    // these jobs are silently skipped forever without this step, causing the
    // stall detector to fire on every interval.
    // Parity: mirrors recoverMemoryJobs() added to JS worker.ts in PR #372.
    {
        let recover = pool
            .write(signet_core::db::Priority::Low, |conn| {
                let updated = conn.execute(
                    "UPDATE memory_jobs SET status = 'dead'
                     WHERE status = 'pending' AND attempts >= max_attempts",
                    [],
                )?;
                Ok(updated.into())
            })
            .await;
        match recover {
            Ok(ref v) if v.as_u64().unwrap_or(0) > 0 => {
                info!(
                    updated = v.as_u64().unwrap_or(0),
                    "startup recovery: marked exhausted pending job(s) as dead"
                )
            }
            Ok(_) => {}
            Err(e) => warn!("startup recovery failed (non-fatal): {e}"),
        }
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
            "extract" | "extraction" => {
                process_extract(&pool, &job, &provider, &semaphore, &config).await
            }
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
    let source_memory_id = memory_id.clone();

    let (content, agent_id, extraction_status, source_project, source_scope, source_visibility) =
        pool.read(move |conn| {
            let mut stmt = conn.prepare_cached(
                "SELECT content, COALESCE(agent_id, 'default'),
                            COALESCE(extraction_status, 'none'),
                            project, scope, COALESCE(visibility, 'global')
                     FROM memories
                     WHERE id = ?1 AND COALESCE(is_deleted, 0) = 0",
            )?;
            let row: Option<(
                String,
                String,
                String,
                Option<String>,
                Option<String>,
                String,
            )> = stmt
                .query_row(rusqlite::params![memory_id], |r| {
                    Ok((
                        r.get(0)?,
                        r.get(1)?,
                        r.get(2)?,
                        r.get(3)?,
                        r.get(4)?,
                        r.get(5)?,
                    ))
                })
                .ok();
            Ok(row)
        })
        .await
        .map_err(|e| e.to_string())?
        .ok_or("memory not found or deleted")?;

    // Controlled-write gate: skip already-extracted memories
    if extraction_status == "complete" || extraction_status == "completed" {
        return Ok(JobResult {
            facts_extracted: 0,
            entities_extracted: 0,
            warnings: vec!["already extracted, skipping".into()],
        });
    }

    if content.trim().len() < 20 {
        return Ok(JobResult {
            facts_extracted: 0,
            entities_extracted: 0,
            warnings: vec!["content too short for extraction".into()],
        });
    }

    // --- Stage 1: Significance gate ---
    // Skip extraction for trivial sessions (saves LLM cost).
    let sig_result =
        significance_gate::assess_significance(&content, pool, &agent_id, &config.significance)
            .await;

    if !sig_result.significant {
        // Mark memory as extracted (raw transcript is already persisted)
        mark_extraction_complete(pool, &source_memory_id).await?;
        return Ok(JobResult {
            facts_extracted: 0,
            entities_extracted: 0,
            warnings: vec![format!("significance_gate: {}", sig_result.reason)],
        });
    }

    // --- Stage 2: LLM extraction ---
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

    let entities_count = result.entities.len();
    let mut warnings = result.warnings;
    let mut facts_written = 0_usize;

    // --- Stage 3: Shadow decisions on extracted facts ---
    if !config.shadow_mode && !facts.is_empty() {
        let decisions = decision::run_shadow_decisions(
            &facts,
            pool,
            provider.as_ref(),
            &config.decision,
            &agent_id,
            source_scope.as_deref(),
            &source_visibility,
            &std::collections::HashMap::new(), // No pre-computed embeddings yet
        )
        .await;

        warnings.extend(decisions.warnings);

        // Process proposals: apply write gate to ADD proposals, persist entities
        for proposal in &decisions.proposals {
            match proposal.action {
                signet_core::types::DecisionAction::Add => {
                    // Find the source fact for this proposal
                    let fact = facts
                        .iter()
                        .find(|f| {
                            f.confidence == proposal.confidence
                                || proposal.reason.contains(&f.content)
                        })
                        .or_else(|| facts.first());

                    let Some(fact) = fact else { continue };

                    // --- Stage 4: Write gate ---
                    let gate_input = write_gate::WriteGateInput {
                        agent_id: agent_id.clone(),
                        source_memory_id: source_memory_id.clone(),
                        source_project: source_project.clone(),
                        source_scope: source_scope.clone(),
                        source_visibility: source_visibility.clone(),
                        fact_type: fact.fact_type.clone(),
                        content: fact.content.clone(),
                        vector: None, // Embeddings computed on-demand later
                    };
                    let gate_result =
                        write_gate::assess_write_gate(pool, &config.write_gate, &gate_input).await;

                    if !gate_result.pass {
                        warnings.push(format!(
                            "write_gate_blocked: surprisal={:?} threshold={}",
                            gate_result.surprise, gate_result.threshold
                        ));
                        continue;
                    }

                    facts_written += 1;
                }
                signet_core::types::DecisionAction::Update => {
                    // Update proposals are informational in shadow mode
                    facts_written += 1;
                }
                signet_core::types::DecisionAction::Delete
                | signet_core::types::DecisionAction::None => {
                    // No write needed
                }
            }
        }
    } else if config.shadow_mode {
        // Shadow mode: just log, don't write
        facts_written = facts.len();
        warnings.push("shadow_mode: decisions not applied".into());
    } else {
        // No facts to decide on
        facts_written = facts.len();
    }

    // Persist extracted entities if graph is enabled
    if config.graph_enabled && !config.shadow_mode && !result.entities.is_empty() {
        persist_extracted_entities(pool, &source_memory_id, &agent_id, &result.entities).await?;
    }

    // Mark memory as extracted
    mark_extraction_complete(pool, &source_memory_id).await?;

    Ok(JobResult {
        facts_extracted: facts_written,
        entities_extracted: entities_count,
        warnings,
    })
}

async fn persist_extracted_entities(
    pool: &DbPool,
    memory_id: &str,
    agent_id: &str,
    entities: &[extraction::ExtractedEntity],
) -> Result<(), String> {
    let memory_id = memory_id.to_string();
    let agent_id = agent_id.to_string();
    let entities = entities
        .iter()
        .map(|entity| signet_core::types::ExtractedEntity {
            source: entity.source.clone(),
            source_type: entity.source_type.clone(),
            relationship: entity
                .relationship
                .clone()
                .unwrap_or_else(|| "related_to".to_string()),
            target: entity.target.clone(),
            target_type: entity.target_type.clone(),
            confidence: 0.7,
        })
        .collect::<Vec<_>>();
    pool.write(signet_core::db::Priority::Low, move |conn| {
        graph::persist_entities(
            conn,
            &graph::PersistEntitiesInput {
                entities: &entities,
                source_memory_id: &memory_id,
                agent_id: &agent_id,
            },
        )?;
        Ok(serde_json::Value::Null)
    })
    .await
    .map(|_| ())
    .map_err(|error| error.to_string())
}

/// Mark a memory's extraction status as completed.
async fn mark_extraction_complete(pool: &DbPool, memory_id: &str) -> Result<(), String> {
    let mid = memory_id.to_string();
    pool.write(signet_core::db::Priority::Low, move |conn| {
        let ts = chrono::Utc::now().to_rfc3339();
        conn.execute(
            "UPDATE memories SET extraction_status = 'completed', updated_at = ?1
             WHERE id = ?2 AND COALESCE(extraction_status, 'none') NOT IN ('complete', 'completed')",
            rusqlite::params![ts, mid],
        )?;
        Ok(serde_json::Value::Null)
    })
    .await
    .map(|_| ())
    .map_err(|e| format!("failed to mark extraction status: {e}"))
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
    use std::sync::Arc;

    use super::{
        LeasedJob, WorkerConfig, WorkerRuntimeStats, new_runtime_stats_handle, process_extract,
    };
    use crate::provider::{GenerateOpts, GenerateResult, LlmProvider, LlmSemaphore, ProviderError};
    use signet_core::db::{DbPool, Priority};

    struct StaticProvider {
        text: String,
    }

    impl LlmProvider for StaticProvider {
        fn generate(
            &self,
            _prompt: &str,
            _opts: &GenerateOpts,
        ) -> std::pin::Pin<
            Box<
                dyn std::future::Future<Output = Result<GenerateResult, ProviderError>> + Send + '_,
            >,
        > {
            let text = self.text.clone();
            Box::pin(async move { Ok(GenerateResult { text, usage: None }) })
        }

        fn name(&self) -> &str {
            "static"
        }
    }

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

    fn open_test_pool() -> (DbPool, tokio::task::JoinHandle<()>) {
        let path = std::env::temp_dir().join(format!("signet-worker-{}.db", uuid::Uuid::new_v4()));
        DbPool::open(&path).expect("open worker test db")
    }

    #[tokio::test]
    async fn process_extract_persists_graph_entities_when_enabled() {
        let (pool, handle) = open_test_pool();
        pool.write(Priority::High, |conn| {
            let now = chrono::Utc::now().to_rfc3339();
            conn.execute(
                "INSERT INTO memories
                 (id, type, content, created_at, updated_at, updated_by, vector_clock,
                  agent_id, is_deleted)
                 VALUES ('memory-graph', 'fact',
                         'This memory is intentionally long enough to pass extraction gating.',
                         ?1, ?1, 'test', '{}', 'agent-a', 0)",
                rusqlite::params![now],
            )?;
            Ok(serde_json::Value::Null)
        })
        .await
        .expect("seed worker memory");

        let provider: Arc<dyn LlmProvider> = Arc::new(StaticProvider {
            text: serde_json::json!({
                "facts": [],
                "entities": [{
                    "source": "Signet Daemon",
                    "target": "SQLite Store",
                    "relationship": "uses",
                    "source_type": "system",
                    "target_type": "database"
                }]
            })
            .to_string(),
        });
        let result = process_extract(
            &pool,
            &LeasedJob {
                id: "job-graph".to_string(),
                memory_id: Some("memory-graph".to_string()),
                job_type: "extract".to_string(),
                payload: None,
                attempts: 1,
            },
            &provider,
            &Arc::new(LlmSemaphore::new(1)),
            &WorkerConfig {
                graph_enabled: true,
                shadow_mode: false,
                ..WorkerConfig::default()
            },
        )
        .await
        .expect("process extract");
        assert_eq!(result.entities_extracted, 1);

        let graph_counts = pool
            .read(|conn| {
                let entities: i64 = conn.query_row(
                    "SELECT COUNT(*) FROM entities WHERE agent_id = 'agent-a'",
                    [],
                    |row| row.get(0),
                )?;
                let relations: i64 =
                    conn.query_row("SELECT COUNT(*) FROM relations", [], |row| row.get(0))?;
                let mentions: i64 = conn.query_row(
                    "SELECT COUNT(*) FROM memory_entity_mentions WHERE memory_id = 'memory-graph'",
                    [],
                    |row| row.get(0),
                )?;
                Ok(serde_json::json!({
                    "entities": entities,
                    "relations": relations,
                    "mentions": mentions,
                }))
            })
            .await
            .expect("read graph rows");
        assert_eq!(graph_counts["entities"], 2);
        assert_eq!(graph_counts["relations"], 1);
        assert_eq!(graph_counts["mentions"], 2);

        drop(pool);
        handle.abort();
    }
}
