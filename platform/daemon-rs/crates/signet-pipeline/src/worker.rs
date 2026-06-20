//! Pipeline worker: leases jobs, calls LLM extraction, applies decisions.
//!
//! The worker polls the `memory_jobs` queue, processes extraction jobs
//! via the LLM provider, and writes results through the DB writer.

use std::sync::Arc;
use std::time::Duration;

use chrono::Utc;
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex, watch};
use tracing::{info, warn};

use signet_core::db::DbPool;
use signet_core::error::CoreError;
use signet_core::queries::memory;
use signet_core::types::{DecisionAction, DecisionProposal};
use signet_services::{graph, normalize::normalize_and_hash};

use crate::antonyms;

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
    let mut drain_queue = false;
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

        // Calculate backoff delay. After a successful job, immediately poll once
        // more to drain queued work instead of paying poll_ms per job. Idle
        // behavior still sleeps for poll_ms when the queue is empty.
        let delay = if overloaded {
            Duration::from_millis(config.overload_backoff_ms)
        } else if drain_queue && consecutive_failures == 0 {
            Duration::ZERO
        } else if consecutive_failures > 0 {
            let backoff = base_delay * 2u32.pow(consecutive_failures.min(6));
            backoff.min(max_delay)
        } else {
            base_delay
        };
        drain_queue = false;

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
                } else {
                    drain_queue = true;
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
                "SELECT content, agent_id,
                            COALESCE(extraction_status, 'none'),
                            project, scope, COALESCE(visibility, 'global')
                     FROM memories
                     WHERE id = ?1 AND COALESCE(is_deleted, 0) = 0",
            )?;
            let row: Option<(
                String,
                Option<String>,
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

    let agent_id = agent_id
        .filter(|id| !id.trim().is_empty())
        .ok_or("source memory missing agent_id")?;

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
        mark_extraction_complete(pool, &source_memory_id, provider.name()).await?;
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
    if !facts.is_empty() {
        let decisions = run_attributed_shadow_decisions(
            &facts,
            pool,
            provider.as_ref(),
            &config.decision,
            &agent_id,
            source_scope.as_deref(),
            &source_visibility,
        )
        .await;

        warnings.extend(decisions.warnings);

        if config.shadow_mode {
            record_shadow_decision_histories(
                pool,
                &source_memory_id,
                &decisions.proposals,
                &facts,
                provider.name(),
                facts.len(),
                entities_count,
            )
            .await?;
            warnings.push("shadow_mode: decisions not applied".into());
        } else {
            // Process proposals: apply write gate to ADD proposals, run contradiction checks
            // for update/delete proposals, and persist accepted fact memories. Mirrors TS
            // controlled writes at platform/daemon/src/pipeline/worker.ts:453-580 and
            // platform/daemon/src/pipeline/worker.ts:1290-1322. TS proposals carry `fact`
            // directly (platform/daemon/src/pipeline/decision.ts:40-46, 322-352), so Rust
            // preserves the fact index instead of re-matching proposals by confidence/reason.
            for attributed in &decisions.proposals {
                let Some(fact) = facts.get(attributed.fact_index) else {
                    return Err(format!(
                        "decision proposal referenced missing fact index {}",
                        attributed.fact_index
                    ));
                };
                let proposal = &attributed.proposal;

                match proposal.action {
                    DecisionAction::Add => {
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
                            write_gate::assess_write_gate(pool, &config.write_gate, &gate_input)
                                .await;

                        if !gate_result.pass {
                            warnings.push(format!(
                                "write_gate_blocked: reason={} surprisal={:?} threshold={}",
                                gate_result.reason.as_str(),
                                gate_result.surprise,
                                gate_result.threshold
                            ));
                            record_decision_history_only(
                                pool,
                                &source_memory_id,
                                proposal,
                                fact,
                                DecisionAuditMeta {
                                    shadow: false,
                                    extraction_model: provider.name().to_string(),
                                    fact_count: facts.len(),
                                    entity_count: entities_count,
                                    skipped_reason: Some("write_gate_low_surprisal".to_string()),
                                    ..DecisionAuditMeta::default()
                                },
                            )
                            .await?;
                            continue;
                        }

                        match insert_extracted_fact_memory(
                            pool,
                            fact,
                            proposal,
                            &source_memory_id,
                            &agent_id,
                            source_project.as_deref(),
                            source_scope.as_deref(),
                            &source_visibility,
                            provider.name(),
                            facts.len(),
                            entities_count,
                        )
                        .await?
                        {
                            FactWriteOutcome::Inserted { .. } => facts_written += 1,
                            FactWriteOutcome::Duplicate { existing_id } => warnings
                                .push(format!("deduped_fact: existing_memory_id={existing_id}")),
                        }
                    }
                    DecisionAction::Update | DecisionAction::Delete => {
                        let mut contradiction_risk = false;
                        if let Some(target_id) = proposal.target_memory_id.as_deref() {
                            contradiction_risk = contradiction_risk_for_target(
                                pool,
                                fact.content.as_str(),
                                target_id,
                                &agent_id,
                                source_scope.as_deref(),
                                &source_visibility,
                            )
                            .await?;
                            if contradiction_risk {
                                warnings.push(format!(
                                    "contradiction_risk: action={:?} target_memory_id={target_id}",
                                    proposal.action
                                ));
                            }
                        }
                        record_decision_history_only(
                            pool,
                            &source_memory_id,
                            proposal,
                            fact,
                            DecisionAuditMeta {
                                shadow: false,
                                extraction_model: provider.name().to_string(),
                                fact_count: facts.len(),
                                entity_count: entities_count,
                                blocked_reason: Some("destructive_mutations_disabled".to_string()),
                                review_needed: contradiction_risk,
                                contradiction_risk,
                                ..DecisionAuditMeta::default()
                            },
                        )
                        .await?;
                    }
                    DecisionAction::None => {
                        record_decision_history_only(
                            pool,
                            &source_memory_id,
                            proposal,
                            fact,
                            DecisionAuditMeta {
                                shadow: false,
                                extraction_model: provider.name().to_string(),
                                fact_count: facts.len(),
                                entity_count: entities_count,
                                ..DecisionAuditMeta::default()
                            },
                        )
                        .await?;
                    }
                }
            }
        }
    }

    // Persist extracted entities if graph is enabled
    if config.graph_enabled && !config.shadow_mode && !result.entities.is_empty() {
        persist_extracted_entities(pool, &source_memory_id, &agent_id, &result.entities).await?;
    }

    // Mark memory as extracted
    mark_extraction_complete(pool, &source_memory_id, provider.name()).await?;

    Ok(JobResult {
        facts_extracted: facts_written,
        entities_extracted: entities_count,
        warnings,
    })
}

#[derive(Debug, Clone)]
struct AttributedDecisionProposal {
    proposal: DecisionProposal,
    fact_index: usize,
}

#[derive(Debug, Clone, Default)]
struct AttributedDecisionResult {
    proposals: Vec<AttributedDecisionProposal>,
    warnings: Vec<String>,
}

async fn run_attributed_shadow_decisions(
    facts: &[extraction::ExtractedFact],
    pool: &DbPool,
    provider: &dyn LlmProvider,
    cfg: &DecisionConfig,
    agent_id: &str,
    scope: Option<&str>,
    visibility: &str,
) -> AttributedDecisionResult {
    let mut attributed = AttributedDecisionResult::default();

    for (fact_index, fact) in facts.iter().enumerate() {
        let result = decision::run_shadow_decisions(
            std::slice::from_ref(fact),
            pool,
            provider,
            cfg,
            agent_id,
            scope,
            visibility,
            &std::collections::HashMap::new(),
        )
        .await;
        attributed.warnings.extend(result.warnings);
        attributed
            .proposals
            .extend(
                result
                    .proposals
                    .into_iter()
                    .map(|proposal| AttributedDecisionProposal {
                        proposal,
                        fact_index,
                    }),
            );
    }

    attributed
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum FactWriteOutcome {
    Inserted { id: String },
    Duplicate { existing_id: String },
}

#[derive(Debug, Clone, Default)]
struct DecisionAuditMeta {
    shadow: bool,
    extraction_model: String,
    fact_count: usize,
    entity_count: usize,
    created_memory_id: Option<String>,
    deduped_existing_id: Option<String>,
    blocked_reason: Option<String>,
    review_needed: bool,
    contradiction_risk: bool,
    skipped_reason: Option<String>,
}

async fn insert_extracted_fact_memory(
    pool: &DbPool,
    fact: &extraction::ExtractedFact,
    proposal: &DecisionProposal,
    source_memory_id: &str,
    agent_id: &str,
    source_project: Option<&str>,
    source_scope: Option<&str>,
    source_visibility: &str,
    extraction_model: &str,
    fact_count: usize,
    entity_count: usize,
) -> Result<FactWriteOutcome, String> {
    let normalized = normalize_and_hash(&fact.content);
    let fact = fact.clone();
    let proposal = proposal.clone();
    let fact_type = fact.fact_type.clone();
    let source_memory_id = source_memory_id.to_string();
    let agent_id = agent_id.to_string();
    let source_project = source_project.map(str::to_string);
    let source_scope = source_scope.map(str::to_string);
    let source_visibility = source_visibility.to_string();
    let extraction_model = extraction_model.to_string();
    let importance = fact.confidence.clamp(0.0, 1.0);

    pool.write_tx(signet_core::db::Priority::Low, move |conn| {
        if let Some(existing_id) = find_existing_fact_by_hash_scoped(
            conn,
            &normalized.hash,
            &agent_id,
            source_scope.as_deref(),
        )? {
            record_decision_history(
                conn,
                &source_memory_id,
                &proposal,
                &fact,
                DecisionAuditMeta {
                    shadow: false,
                    extraction_model: extraction_model.clone(),
                    fact_count,
                    entity_count,
                    deduped_existing_id: Some(existing_id.clone()),
                    ..DecisionAuditMeta::default()
                },
            )?;
            return Ok(serde_json::json!({
                "status": "duplicate",
                "id": existing_id,
            }));
        }

        let id = uuid::Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();
        let inserted_id = match memory::insert(
            conn,
            &memory::InsertMemory {
                id: &id,
                content: &normalized.storage,
                normalized_content: &normalized.normalized,
                content_hash: &normalized.hash,
                memory_type: &fact_type,
                tags: "[]",
                who: Some("pipeline-v2"),
                why: Some("extracted-fact"),
                project: source_project.as_deref(),
                importance,
                pinned: false,
                extraction_status: "completed",
                embedding_model: None,
                extraction_model: Some(&extraction_model),
                source_type: Some("pipeline-v2"),
                source_id: Some(&source_memory_id),
                source_path: None,
                idempotency_key: None,
                runtime_path: None,
                now: &now,
                updated_by: "pipeline-v2",
                agent_id: &agent_id,
                visibility: &source_visibility,
                scope: source_scope.as_deref(),
            },
        ) {
            Ok(inserted_id) => inserted_id,
            Err(error) if is_unique_constraint_error(&error) => {
                let existing_id = find_existing_fact_by_hash_scoped(
                    conn,
                    &normalized.hash,
                    &agent_id,
                    source_scope.as_deref(),
                )?
                .ok_or_else(|| {
                    CoreError::Conflict(
                        "fact insert hit UNIQUE constraint but no scoped duplicate was found"
                            .to_string(),
                    )
                })?;
                record_decision_history(
                    conn,
                    &source_memory_id,
                    &proposal,
                    &fact,
                    DecisionAuditMeta {
                        shadow: false,
                        extraction_model: extraction_model.clone(),
                        fact_count,
                        entity_count,
                        deduped_existing_id: Some(existing_id.clone()),
                        ..DecisionAuditMeta::default()
                    },
                )?;
                return Ok(serde_json::json!({
                    "status": "duplicate",
                    "id": existing_id,
                }));
            }
            Err(error) => return Err(error),
        };

        record_created_memory_history(
            conn,
            &inserted_id,
            &normalized.storage,
            &proposal,
            &fact,
            &source_memory_id,
            &extraction_model,
        )?;
        record_decision_history(
            conn,
            &source_memory_id,
            &proposal,
            &fact,
            DecisionAuditMeta {
                shadow: false,
                extraction_model: extraction_model.clone(),
                fact_count,
                entity_count,
                created_memory_id: Some(inserted_id.clone()),
                ..DecisionAuditMeta::default()
            },
        )?;

        Ok(serde_json::json!({
            "status": "inserted",
            "id": inserted_id,
        }))
    })
    .await
    .map_err(|error| error.to_string())
    .and_then(|value| {
        let status = value
            .get("status")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "fact write returned malformed status".to_string())?;
        let id = value
            .get("id")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "fact write returned malformed id".to_string())?
            .to_string();
        match status {
            "inserted" => Ok(FactWriteOutcome::Inserted { id }),
            "duplicate" => Ok(FactWriteOutcome::Duplicate { existing_id: id }),
            other => Err(format!("fact write returned unknown status: {other}")),
        }
    })
}

fn find_existing_fact_by_hash_scoped(
    conn: &rusqlite::Connection,
    hash: &str,
    agent_id: &str,
    scope: Option<&str>,
) -> Result<Option<String>, CoreError> {
    let mut stmt = conn.prepare_cached(
        "SELECT id FROM memories
         WHERE content_hash = ?1
           AND COALESCE(is_deleted, 0) = 0
           AND agent_id = ?2
           AND IFNULL(scope, '') = ?3
         LIMIT 1",
    )?;
    let scope_key = scope.unwrap_or("");
    let existing_id = stmt
        .query_row(rusqlite::params![hash, agent_id, scope_key], |row| {
            row.get(0)
        })
        .optional()?;
    Ok(existing_id)
}

fn is_unique_constraint_error(error: &CoreError) -> bool {
    let message = error.to_string();
    message.contains("UNIQUE constraint") || message.contains("idx_memories_content_hash_unique")
}

async fn record_decision_history_only(
    pool: &DbPool,
    source_memory_id: &str,
    proposal: &DecisionProposal,
    fact: &extraction::ExtractedFact,
    meta: DecisionAuditMeta,
) -> Result<(), String> {
    let source_memory_id = source_memory_id.to_string();
    let proposal = proposal.clone();
    let fact = fact.clone();
    pool.write_tx(signet_core::db::Priority::Low, move |conn| {
        record_decision_history(conn, &source_memory_id, &proposal, &fact, meta)?;
        Ok(serde_json::Value::Null)
    })
    .await
    .map(|_| ())
    .map_err(|error| error.to_string())
}

async fn record_shadow_decision_histories(
    pool: &DbPool,
    source_memory_id: &str,
    proposals: &[AttributedDecisionProposal],
    facts: &[extraction::ExtractedFact],
    extraction_model: &str,
    fact_count: usize,
    entity_count: usize,
) -> Result<(), String> {
    let source_memory_id = source_memory_id.to_string();
    let proposals = proposals.to_vec();
    let facts = facts.to_vec();
    let extraction_model = extraction_model.to_string();
    pool.write_tx(signet_core::db::Priority::Low, move |conn| {
        for attributed in &proposals {
            let fact = facts.get(attributed.fact_index).ok_or_else(|| {
                CoreError::Invalid(format!(
                    "decision proposal referenced missing fact index {}",
                    attributed.fact_index
                ))
            })?;
            record_decision_history(
                conn,
                &source_memory_id,
                &attributed.proposal,
                fact,
                DecisionAuditMeta {
                    shadow: true,
                    extraction_model: extraction_model.clone(),
                    fact_count,
                    entity_count,
                    ..DecisionAuditMeta::default()
                },
            )?;
        }
        Ok(serde_json::Value::Null)
    })
    .await
    .map(|_| ())
    .map_err(|error| error.to_string())
}

fn record_decision_history(
    conn: &rusqlite::Connection,
    source_memory_id: &str,
    proposal: &DecisionProposal,
    fact: &extraction::ExtractedFact,
    meta: DecisionAuditMeta,
) -> Result<(), CoreError> {
    let now = Utc::now().to_rfc3339();
    let metadata = serde_json::json!({
        "shadow": meta.shadow,
        "proposedAction": decision_action_name(&proposal.action),
        "targetMemoryId": proposal.target_memory_id,
        "targetContent": serde_json::Value::Null,
        "confidence": proposal.confidence,
        "fact": fact,
        "extractionModel": meta.extraction_model,
        "factCount": meta.fact_count,
        "entityCount": meta.entity_count,
        "createdMemoryId": meta.created_memory_id,
        "updatedMemoryId": serde_json::Value::Null,
        "deletedMemoryId": serde_json::Value::Null,
        "dedupedExistingId": meta.deduped_existing_id,
        "blockedReason": meta.blocked_reason,
        "reviewNeeded": meta.review_needed,
        "contradictionRisk": meta.contradiction_risk,
        "skippedReason": meta.skipped_reason,
    })
    .to_string();

    memory::insert_history(
        conn,
        &memory::InsertHistory {
            id: &uuid::Uuid::new_v4().to_string(),
            memory_id: source_memory_id,
            event: "none",
            old_content: None,
            new_content: None,
            changed_by: if meta.shadow {
                "pipeline-shadow"
            } else {
                "pipeline-v2"
            },
            reason: Some(proposal.reason.as_str()),
            metadata: Some(&metadata),
            now: &now,
            actor_type: None,
            session_id: None,
            request_id: None,
        },
    )
}

fn record_created_memory_history(
    conn: &rusqlite::Connection,
    memory_id: &str,
    content: &str,
    proposal: &DecisionProposal,
    fact: &extraction::ExtractedFact,
    source_memory_id: &str,
    extraction_model: &str,
) -> Result<(), CoreError> {
    let now = Utc::now().to_rfc3339();
    let metadata = serde_json::json!({
        "proposedAction": decision_action_name(&proposal.action),
        "sourceMemoryId": source_memory_id,
        "decisionConfidence": proposal.confidence,
        "factConfidence": fact.confidence,
        "extractionModel": extraction_model,
    })
    .to_string();

    memory::insert_history(
        conn,
        &memory::InsertHistory {
            id: &uuid::Uuid::new_v4().to_string(),
            memory_id,
            event: "created",
            old_content: None,
            new_content: Some(content),
            changed_by: "pipeline-v2",
            reason: Some(proposal.reason.as_str()),
            metadata: Some(&metadata),
            now: &now,
            actor_type: None,
            session_id: None,
            request_id: None,
        },
    )
}

fn decision_action_name(action: &DecisionAction) -> &'static str {
    match action {
        DecisionAction::Add => "add",
        DecisionAction::Update => "update",
        DecisionAction::Delete => "delete",
        DecisionAction::None => "none",
    }
}

async fn contradiction_risk_for_target(
    pool: &DbPool,
    fact_content: &str,
    target_memory_id: &str,
    agent_id: &str,
    source_scope: Option<&str>,
    source_visibility: &str,
) -> Result<bool, String> {
    if fact_content.trim().is_empty() {
        return Ok(false);
    }

    let fact_content = fact_content.to_string();
    let target_memory_id = target_memory_id.to_string();
    let agent_id = agent_id.to_string();
    let source_scope = source_scope.map(str::to_string);
    let source_visibility = source_visibility.to_string();

    pool.read(move |conn| {
        let (sql, params): (&str, Vec<Box<dyn rusqlite::ToSql>>) = if let Some(scope) = source_scope
        {
            (
                "SELECT content FROM memories
                 WHERE id = ?1 AND COALESCE(is_deleted, 0) = 0
                   AND agent_id = ?2 AND visibility = ?3 AND scope = ?4",
                vec![
                    Box::new(target_memory_id.clone()),
                    Box::new(agent_id.clone()),
                    Box::new(source_visibility.clone()),
                    Box::new(scope),
                ],
            )
        } else {
            (
                "SELECT content FROM memories
                 WHERE id = ?1 AND COALESCE(is_deleted, 0) = 0
                   AND agent_id = ?2 AND visibility = ?3 AND scope IS NULL",
                vec![
                    Box::new(target_memory_id.clone()),
                    Box::new(agent_id.clone()),
                    Box::new(source_visibility.clone()),
                ],
            )
        };
        let param_refs: Vec<&dyn rusqlite::ToSql> = params.iter().map(|p| p.as_ref()).collect();
        let target_content = conn
            .query_row(sql, param_refs.as_slice(), |row| row.get::<_, String>(0))
            .ok();

        let Some(target_content) = target_content else {
            return Ok(false);
        };

        Ok(detect_contradiction_risk(&fact_content, &target_content))
    })
    .await
    .map_err(|error| error.to_string())
}

fn detect_contradiction_risk(fact_content: &str, target_content: &str) -> bool {
    let fact_tokens = antonyms::tokenize(fact_content);
    let target_tokens = antonyms::tokenize(target_content);

    if antonyms::overlap_count(&fact_tokens, &target_tokens) < 3 {
        return false;
    }

    let fact_set = fact_tokens.iter().map(String::as_str).collect();
    let target_set = target_tokens.iter().map(String::as_str).collect();

    (antonyms::has_negation(&fact_tokens) != antonyms::has_negation(&target_tokens))
        || antonyms::has_antonym_conflict(
            &fact_set,
            &target_set,
            antonyms::PROSPECTIVE_ANTONYM_PAIRS,
        )
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
async fn mark_extraction_complete(
    pool: &DbPool,
    memory_id: &str,
    extraction_model: &str,
) -> Result<(), String> {
    let mid = memory_id.to_string();
    let extraction_model = extraction_model.to_string();
    pool.write(signet_core::db::Priority::Low, move |conn| {
        let ts = chrono::Utc::now().to_rfc3339();
        conn.execute(
            "UPDATE memories SET extraction_status = 'completed', extraction_model = ?1, updated_at = ?2
             WHERE id = ?3 AND COALESCE(extraction_status, 'none') NOT IN ('complete', 'completed')",
            rusqlite::params![extraction_model, ts, mid],
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
    use std::collections::VecDeque;
    use std::sync::{Arc, Mutex as StdMutex};

    use super::{
        LeasedJob, WorkerConfig, WorkerRuntimeStats, new_runtime_stats_handle, process_extract,
    };
    use crate::provider::{GenerateOpts, GenerateResult, LlmProvider, LlmSemaphore, ProviderError};
    use signet_core::db::{DbPool, Priority};

    struct StaticProvider {
        text: String,
    }

    struct SequenceProvider {
        texts: StdMutex<VecDeque<String>>,
    }

    impl SequenceProvider {
        fn new(texts: Vec<String>) -> Self {
            Self {
                texts: StdMutex::new(texts.into()),
            }
        }
    }

    impl LlmProvider for SequenceProvider {
        fn generate(
            &self,
            _prompt: &str,
            _opts: &GenerateOpts,
        ) -> std::pin::Pin<
            Box<
                dyn std::future::Future<Output = Result<GenerateResult, ProviderError>> + Send + '_,
            >,
        > {
            let text = self
                .texts
                .lock()
                .expect("sequence provider lock")
                .pop_front()
                .expect("sequence provider response");
            Box::pin(async move { Ok(GenerateResult { text, usage: None }) })
        }

        fn name(&self) -> &str {
            "sequence-test-model"
        }
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

    async fn seed_source_memory(
        pool: &DbPool,
        id: &str,
        agent_id: &str,
        visibility: &str,
        scope: Option<&str>,
        project: Option<&str>,
        content: &str,
    ) {
        let id = id.to_string();
        let agent_id = agent_id.to_string();
        let visibility = visibility.to_string();
        let scope = scope.map(str::to_string);
        let project = project.map(str::to_string);
        let content = content.to_string();
        pool.write(Priority::High, move |conn| {
            let now = chrono::Utc::now().to_rfc3339();
            conn.execute(
                "INSERT INTO memories
                 (id, type, content, created_at, updated_at, updated_by, vector_clock,
                  agent_id, visibility, scope, project, is_deleted, extraction_status)
                 VALUES (?1, 'transcript', ?2, ?3, ?3, 'test', '{}', ?4, ?5, ?6, ?7, 0, 'none')",
                rusqlite::params![id, content, now, agent_id, visibility, scope, project],
            )?;
            Ok(serde_json::Value::Null)
        })
        .await
        .expect("seed source memory");
    }

    #[tokio::test]
    async fn process_extract_add_decision_writes_fact_memory_with_source_scope() {
        let (pool, handle) = open_test_pool();
        pool.write(Priority::High, |conn| {
            let now = chrono::Utc::now().to_rfc3339();
            conn.execute(
                "INSERT INTO memories
                 (id, type, content, created_at, updated_at, updated_by, vector_clock,
                  agent_id, visibility, scope, project, is_deleted, extraction_status)
                 VALUES ('source-memory', 'transcript',
                         'User: Please remember the Signet pipeline worker fact-write parity details.\nAssistant: I will preserve the relevant attribution, scoping, and source lineage details for the Rust worker implementation.',
                         ?1, ?1, 'test', '{}', 'agent-core3', 'private', 'repo-scope',
                         'platform/daemon-rs', 0, 'none')",
                rusqlite::params![now],
            )?;
            Ok(serde_json::Value::Null)
        })
        .await
        .expect("seed source memory");

        let fact_content = "The Rust pipeline worker must write extracted ADD decision facts as real scoped memories with pipeline-v2 source attribution and source memory lineage.";
        let extraction = serde_json::json!({
            "facts": [{
                "content": fact_content,
                "type": "fact",
                "confidence": 0.82
            }],
            "entities": [{
                "source": "Rust pipeline worker",
                "target": "fact memory",
                "relationship": "writes",
                "source_type": "system",
                "target_type": "artifact"
            }]
        })
        .to_string();
        let decision = serde_json::json!({
            "action": "add",
            "confidence": 0.82,
            "reason": format!("new fact: {fact_content}")
        })
        .to_string();
        let provider: Arc<dyn LlmProvider> =
            Arc::new(SequenceProvider::new(vec![extraction, decision]));
        let mut config = WorkerConfig {
            graph_enabled: true,
            shadow_mode: false,
            ..WorkerConfig::default()
        };
        config.significance.enabled = false;

        let result = process_extract(
            &pool,
            &LeasedJob {
                id: "job-add-fact".to_string(),
                memory_id: Some("source-memory".to_string()),
                job_type: "extract".to_string(),
                payload: None,
                attempts: 1,
            },
            &provider,
            &Arc::new(LlmSemaphore::new(1)),
            &config,
        )
        .await
        .expect("process extract");

        assert_eq!(result.facts_extracted, 1);
        assert_eq!(result.entities_extracted, 1);

        let written = pool
            .read(|conn| {
                let row = conn.query_row(
                    "SELECT id, content, type, who, why, source_type, source_id, agent_id,
                            visibility, scope, project, importance, extraction_status,
                            extraction_model, updated_by
                     FROM memories
                     WHERE source_type = 'pipeline-v2' AND source_id = 'source-memory'",
                    [],
                    |row| {
                        Ok(serde_json::json!({
                            "id": row.get::<_, String>(0)?,
                            "content": row.get::<_, String>(1)?,
                            "type": row.get::<_, String>(2)?,
                            "who": row.get::<_, String>(3)?,
                            "why": row.get::<_, String>(4)?,
                            "source_type": row.get::<_, String>(5)?,
                            "source_id": row.get::<_, String>(6)?,
                            "agent_id": row.get::<_, String>(7)?,
                            "visibility": row.get::<_, String>(8)?,
                            "scope": row.get::<_, String>(9)?,
                            "project": row.get::<_, String>(10)?,
                            "importance": row.get::<_, f64>(11)?,
                            "extraction_status": row.get::<_, String>(12)?,
                            "extraction_model": row.get::<_, String>(13)?,
                            "updated_by": row.get::<_, String>(14)?,
                        }))
                    },
                )?;
                Ok(row)
            })
            .await
            .expect("read written fact");

        assert_eq!(written["content"], fact_content);
        assert_eq!(written["type"], "fact");
        assert_eq!(written["who"], "pipeline-v2");
        assert_eq!(written["why"], "extracted-fact");
        assert_eq!(written["source_type"], "pipeline-v2");
        assert_eq!(written["source_id"], "source-memory");
        assert_eq!(written["agent_id"], "agent-core3");
        assert_eq!(written["visibility"], "private");
        assert_eq!(written["scope"], "repo-scope");
        assert_eq!(written["project"], "platform/daemon-rs");
        assert_eq!(written["importance"], 0.82);
        assert_eq!(written["extraction_status"], "completed");
        assert_eq!(written["extraction_model"], "sequence-test-model");
        assert_eq!(written["updated_by"], "pipeline-v2");

        let written_id = written["id"].as_str().expect("written id").to_string();
        let history = pool
            .read(move |conn| {
                let created: serde_json::Value = conn.query_row(
                    "SELECT event, changed_by, reason, new_content, metadata FROM memory_history WHERE memory_id = ?1",
                    rusqlite::params![written_id],
                    |row| {
                        Ok(serde_json::json!({
                            "event": row.get::<_, String>(0)?,
                            "changed_by": row.get::<_, String>(1)?,
                            "reason": row.get::<_, String>(2)?,
                            "new_content": row.get::<_, String>(3)?,
                            "metadata": serde_json::from_str::<serde_json::Value>(&row.get::<_, String>(4)?)
                                .expect("created metadata json"),
                        }))
                    },
                )?;
                let decision: serde_json::Value = conn.query_row(
                    "SELECT event, changed_by, reason, metadata FROM memory_history WHERE memory_id = 'source-memory'",
                    [],
                    |row| {
                        Ok(serde_json::json!({
                            "event": row.get::<_, String>(0)?,
                            "changed_by": row.get::<_, String>(1)?,
                            "reason": row.get::<_, String>(2)?,
                            "metadata": serde_json::from_str::<serde_json::Value>(&row.get::<_, String>(3)?)
                                .expect("decision metadata json"),
                        }))
                    },
                )?;
                Ok(serde_json::json!({"created": created, "decision": decision}))
            })
            .await
            .expect("read fact write history");

        assert_eq!(history["created"]["event"], "created");
        assert_eq!(history["created"]["changed_by"], "pipeline-v2");
        assert_eq!(
            history["created"]["reason"],
            format!("new fact: {fact_content}")
        );
        assert_eq!(history["created"]["new_content"], fact_content);
        assert_eq!(
            history["created"]["metadata"]["sourceMemoryId"],
            "source-memory"
        );
        assert_eq!(history["created"]["metadata"]["proposedAction"], "add");
        assert_eq!(history["decision"]["event"], "none");
        assert_eq!(history["decision"]["changed_by"], "pipeline-v2");
        assert_eq!(
            history["decision"]["metadata"]["createdMemoryId"],
            written["id"]
        );
        assert_eq!(
            history["decision"]["metadata"]["fact"]["content"],
            fact_content
        );

        let source_status = pool
            .read(|conn| {
                let row = conn.query_row(
                    "SELECT extraction_status, extraction_model FROM memories WHERE id = 'source-memory'",
                    [],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
                )?;
                Ok(row)
            })
            .await
            .expect("read source status");
        assert_eq!(
            source_status,
            ("completed".to_string(), "sequence-test-model".to_string())
        );

        let graph_counts = pool
            .read(|conn| {
                let mentions: i64 = conn.query_row(
                    "SELECT COUNT(*) FROM memory_entity_mentions WHERE memory_id = 'source-memory'",
                    [],
                    |row| row.get(0),
                )?;
                Ok(mentions)
            })
            .await
            .expect("read entity mentions");
        assert_eq!(graph_counts, 2);

        drop(pool);
        handle.abort();
    }

    #[tokio::test]
    async fn process_extract_add_decisions_with_identical_confidence_write_each_source_fact() {
        let (pool, handle) = open_test_pool();
        seed_source_memory(
            &pool,
            "source-identical-confidence",
            "agent-core3",
            "private",
            Some("repo-scope"),
            Some("platform/daemon-rs"),
            "User: Please retain both independent Rust parity facts from this transcript so the extraction pipeline can prove proposal attribution across identical confidence values.",
        )
        .await;

        let fact_a = "The Rust parity worker must preserve the first independently extracted fact when several ADD decisions share the same confidence value during controlled writes.";
        let fact_b = "The Rust parity worker must preserve the second independently extracted fact when several ADD decisions share the same confidence value during controlled writes.";
        let extraction = serde_json::json!({
            "facts": [
                {"content": fact_a, "type": "fact", "confidence": 0.77},
                {"content": fact_b, "type": "fact", "confidence": 0.77}
            ],
            "entities": []
        })
        .to_string();
        let decision_a = serde_json::json!({
            "action": "add",
            "confidence": 0.77,
            "reason": "No existing memories match this fact"
        })
        .to_string();
        let decision_b = serde_json::json!({
            "action": "add",
            "confidence": 0.77,
            "reason": "No existing memories match this fact"
        })
        .to_string();
        let provider: Arc<dyn LlmProvider> = Arc::new(SequenceProvider::new(vec![
            extraction, decision_a, decision_b,
        ]));
        let mut config = WorkerConfig {
            graph_enabled: false,
            shadow_mode: false,
            ..WorkerConfig::default()
        };
        config.significance.enabled = false;

        let result = process_extract(
            &pool,
            &LeasedJob {
                id: "job-identical-confidence".to_string(),
                memory_id: Some("source-identical-confidence".to_string()),
                job_type: "extract".to_string(),
                payload: None,
                attempts: 1,
            },
            &provider,
            &Arc::new(LlmSemaphore::new(1)),
            &config,
        )
        .await
        .expect("process identical confidence facts");

        assert_eq!(result.facts_extracted, 2);
        let written = pool
            .read(move |conn| {
                let count: i64 = conn.query_row(
                    "SELECT COUNT(*) FROM memories
                     WHERE source_type = 'pipeline-v2' AND source_id = 'source-identical-confidence'",
                    [],
                    |row| row.get(0),
                )?;
                let fact_a_count: i64 = conn.query_row(
                    "SELECT COUNT(*) FROM memories WHERE content = ?1",
                    rusqlite::params![fact_a],
                    |row| row.get(0),
                )?;
                let fact_b_count: i64 = conn.query_row(
                    "SELECT COUNT(*) FROM memories WHERE content = ?1",
                    rusqlite::params![fact_b],
                    |row| row.get(0),
                )?;
                Ok((count, fact_a_count, fact_b_count))
            })
            .await
            .expect("read identical confidence writes");
        assert_eq!(written, (2, 1, 1));

        drop(pool);
        handle.abort();
    }

    #[tokio::test]
    async fn process_extract_dedupes_same_fact_across_visibility_with_history() {
        let (pool, handle) = open_test_pool();
        seed_source_memory(
            &pool,
            "source-visibility-dedupe",
            "agent-core3",
            "private",
            Some("repo-scope"),
            Some("platform/daemon-rs"),
            "User: Please retain the scoped visibility dedupe audit behavior for the Rust pipeline worker controlled fact write path.",
        )
        .await;

        let fact_content = "The Rust pipeline worker must dedupe extracted facts by content hash, agent id, and scope even when source visibility differs from an existing memory row.";
        let normalized = signet_services::normalize::normalize_and_hash(fact_content);
        let normalized_content = normalized.normalized.clone();
        let content_hash = normalized.hash.clone();
        let content_hash_for_audit = content_hash.clone();
        pool.write(Priority::High, move |conn| {
            let now = chrono::Utc::now().to_rfc3339();
            conn.execute(
                "INSERT INTO memories
                 (id, type, content, normalized_content, content_hash, created_at, updated_at,
                  updated_by, vector_clock, agent_id, visibility, scope, project, is_deleted,
                  extraction_status)
                 VALUES ('existing-visibility-dedupe', 'fact', ?1, ?2, ?3, ?4, ?4, 'test', '{}',
                         'agent-core3', 'global', 'repo-scope', 'platform/daemon-rs', 0, 'completed')",
                rusqlite::params![
                    fact_content,
                    normalized_content,
                    content_hash,
                    now
                ],
            )?;
            Ok(serde_json::Value::Null)
        })
        .await
        .expect("seed existing visibility duplicate");

        let extraction = serde_json::json!({
            "facts": [{"content": fact_content, "type": "fact", "confidence": 0.81}],
            "entities": []
        })
        .to_string();
        let decision = serde_json::json!({
            "action": "add",
            "confidence": 0.81,
            "reason": "No existing memories match this fact"
        })
        .to_string();
        let provider: Arc<dyn LlmProvider> =
            Arc::new(SequenceProvider::new(vec![extraction, decision]));
        let mut config = WorkerConfig {
            graph_enabled: false,
            shadow_mode: false,
            ..WorkerConfig::default()
        };
        config.significance.enabled = false;

        let result = process_extract(
            &pool,
            &LeasedJob {
                id: "job-visibility-dedupe".to_string(),
                memory_id: Some("source-visibility-dedupe".to_string()),
                job_type: "extract".to_string(),
                payload: None,
                attempts: 1,
            },
            &provider,
            &Arc::new(LlmSemaphore::new(1)),
            &config,
        )
        .await
        .expect("process visibility duplicate");

        assert_eq!(result.facts_extracted, 0);
        assert!(result.warnings.iter().any(
            |warning| warning == "deduped_fact: existing_memory_id=existing-visibility-dedupe"
        ));
        let audit = pool
            .read(move |conn| {
                let memory_count: i64 = conn.query_row(
                    "SELECT COUNT(*) FROM memories WHERE content_hash = ?1 AND agent_id = 'agent-core3' AND scope = 'repo-scope'",
                    rusqlite::params![content_hash_for_audit],
                    |row| row.get(0),
                )?;
                let history: serde_json::Value = conn.query_row(
                    "SELECT event, changed_by, reason, metadata FROM memory_history WHERE memory_id = 'source-visibility-dedupe'",
                    [],
                    |row| {
                        Ok(serde_json::json!({
                            "event": row.get::<_, String>(0)?,
                            "changed_by": row.get::<_, String>(1)?,
                            "reason": row.get::<_, String>(2)?,
                            "metadata": serde_json::from_str::<serde_json::Value>(&row.get::<_, String>(3)?)
                                .expect("dedupe metadata json"),
                        }))
                    },
                )?;
                Ok(serde_json::json!({"memory_count": memory_count, "history": history}))
            })
            .await
            .expect("read visibility dedupe audit");
        assert_eq!(audit["memory_count"], 1);
        assert_eq!(audit["history"]["event"], "none");
        assert_eq!(audit["history"]["changed_by"], "pipeline-v2");
        assert_eq!(
            audit["history"]["metadata"]["dedupedExistingId"],
            "existing-visibility-dedupe"
        );
        assert_eq!(audit["history"]["metadata"]["proposedAction"], "add");

        drop(pool);
        handle.abort();
    }

    #[tokio::test]
    async fn process_extract_records_blocked_destructive_and_shadow_decision_history() {
        let (pool, handle) = open_test_pool();
        seed_source_memory(
            &pool,
            "source-blocked-decision",
            "agent-core3",
            "private",
            Some("repo-scope"),
            Some("platform/daemon-rs"),
            "User: Please audit blocked destructive controlled writes for the Rust pipeline worker while keeping extracted facts traceable to source decisions.",
        )
        .await;
        seed_source_memory(
            &pool,
            "source-shadow-decision",
            "agent-core3",
            "private",
            Some("repo-scope"),
            Some("platform/daemon-rs"),
            "User: Please audit shadow controlled writes for the Rust pipeline worker while keeping extracted facts traceable to source decisions.",
        )
        .await;
        pool.write(Priority::High, |conn| {
            let now = chrono::Utc::now().to_rfc3339();
            conn.execute(
                "INSERT INTO memories
                 (id, type, content, created_at, updated_at, updated_by, vector_clock,
                  agent_id, visibility, scope, project, is_deleted, extraction_status)
                 VALUES ('target-blocked-delete', 'fact',
                         'The Rust pipeline worker target memory remains available for blocked destructive delete decision auditing.',
                         ?1, ?1, 'test', '{}', 'agent-core3', 'private', 'repo-scope',
                         'platform/daemon-rs', 0, 'completed')",
                rusqlite::params![now],
            )?;
            Ok(serde_json::Value::Null)
        })
        .await
        .expect("seed blocked target");

        let blocked_fact = "The Rust pipeline worker target memory remains available for blocked destructive delete decision auditing and must not be deleted by controlled writes.";
        let blocked_extraction = serde_json::json!({
            "facts": [{"content": blocked_fact, "type": "fact", "confidence": 0.83}],
            "entities": []
        })
        .to_string();
        let blocked_decision = serde_json::json!({
            "action": "delete",
            "targetId": "target-blocked-delete",
            "confidence": 0.91,
            "reason": "Destructive delete should be blocked for audit parity"
        })
        .to_string();
        let blocked_provider: Arc<dyn LlmProvider> = Arc::new(SequenceProvider::new(vec![
            blocked_extraction,
            blocked_decision,
        ]));
        let mut config = WorkerConfig {
            graph_enabled: false,
            shadow_mode: false,
            ..WorkerConfig::default()
        };
        config.significance.enabled = false;
        config.decision.min_score = 0.0;

        let blocked_result = process_extract(
            &pool,
            &LeasedJob {
                id: "job-blocked-decision".to_string(),
                memory_id: Some("source-blocked-decision".to_string()),
                job_type: "extract".to_string(),
                payload: None,
                attempts: 1,
            },
            &blocked_provider,
            &Arc::new(LlmSemaphore::new(1)),
            &config,
        )
        .await
        .expect("process blocked destructive decision");
        assert_eq!(blocked_result.facts_extracted, 0);

        let shadow_fact = "The Rust pipeline worker shadow mode must record source decision audit history without inserting extracted ADD fact memories.";
        let shadow_extraction = serde_json::json!({
            "facts": [{"content": shadow_fact, "type": "fact", "confidence": 0.84}],
            "entities": []
        })
        .to_string();
        let shadow_decision = serde_json::json!({
            "action": "add",
            "confidence": 0.84,
            "reason": "No existing memories match this fact"
        })
        .to_string();
        let shadow_provider: Arc<dyn LlmProvider> = Arc::new(SequenceProvider::new(vec![
            shadow_extraction,
            shadow_decision,
        ]));
        let mut shadow_config = WorkerConfig {
            graph_enabled: false,
            shadow_mode: true,
            ..WorkerConfig::default()
        };
        shadow_config.significance.enabled = false;

        let shadow_result = process_extract(
            &pool,
            &LeasedJob {
                id: "job-shadow-decision".to_string(),
                memory_id: Some("source-shadow-decision".to_string()),
                job_type: "extract".to_string(),
                payload: None,
                attempts: 1,
            },
            &shadow_provider,
            &Arc::new(LlmSemaphore::new(1)),
            &shadow_config,
        )
        .await
        .expect("process shadow decision");
        assert_eq!(shadow_result.facts_extracted, 0);

        let audit = pool
            .read(|conn| {
                let blocked: serde_json::Value = conn.query_row(
                    "SELECT event, changed_by, reason, metadata FROM memory_history WHERE memory_id = 'source-blocked-decision'",
                    [],
                    |row| {
                        Ok(serde_json::json!({
                            "event": row.get::<_, String>(0)?,
                            "changed_by": row.get::<_, String>(1)?,
                            "reason": row.get::<_, String>(2)?,
                            "metadata": serde_json::from_str::<serde_json::Value>(&row.get::<_, String>(3)?)
                                .expect("blocked metadata json"),
                        }))
                    },
                )?;
                let shadow: serde_json::Value = conn.query_row(
                    "SELECT event, changed_by, reason, metadata FROM memory_history WHERE memory_id = 'source-shadow-decision'",
                    [],
                    |row| {
                        Ok(serde_json::json!({
                            "event": row.get::<_, String>(0)?,
                            "changed_by": row.get::<_, String>(1)?,
                            "reason": row.get::<_, String>(2)?,
                            "metadata": serde_json::from_str::<serde_json::Value>(&row.get::<_, String>(3)?)
                                .expect("shadow metadata json"),
                        }))
                    },
                )?;
                let shadow_inserted: i64 = conn.query_row(
                    "SELECT COUNT(*) FROM memories WHERE source_type = 'pipeline-v2' AND source_id = 'source-shadow-decision'",
                    [],
                    |row| row.get(0),
                )?;
                Ok(serde_json::json!({
                    "blocked": blocked,
                    "shadow": shadow,
                    "shadow_inserted": shadow_inserted,
                }))
            })
            .await
            .expect("read blocked and shadow audit");

        assert_eq!(audit["blocked"]["event"], "none");
        assert_eq!(audit["blocked"]["changed_by"], "pipeline-v2");
        assert_eq!(
            audit["blocked"]["reason"],
            "Destructive delete should be blocked for audit parity"
        );
        assert_eq!(audit["blocked"]["metadata"]["proposedAction"], "delete");
        assert_eq!(
            audit["blocked"]["metadata"]["blockedReason"],
            "destructive_mutations_disabled"
        );
        assert_eq!(audit["shadow"]["event"], "none");
        assert_eq!(audit["shadow"]["changed_by"], "pipeline-shadow");
        assert_eq!(audit["shadow"]["metadata"]["shadow"], true);
        assert_eq!(audit["shadow"]["metadata"]["proposedAction"], "add");
        assert_eq!(audit["shadow_inserted"], 0);

        drop(pool);
        handle.abort();
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
