//! Dreaming worker runtime parity for the TypeScript daemon.
//!
//! This module owns the background scheduler and manual trigger semantics around
//! the lower-level dreaming pass implementation in [`crate::dreaming`]. It
//! mirrors `platform/daemon/src/pipeline/dreaming-worker.ts`: discover all
//! data-bearing agents, sweep orphaned running passes on start, serialize pass
//! execution, and support fire-and-forget manual triggers that return the pass
//! id after the DB row is created.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rusqlite::params;
use signet_core::db::{DbPool, Priority};
use thiserror::Error;
use tokio::task::JoinHandle;
use tracing::{error, info, warn};

use crate::dreaming::{
    DreamingConfig, DreamingMode, DreamingPassResult, LlmGenerateFn, create_dreaming_pass,
    get_dreaming_state, record_dreaming_failure, run_dreaming_pass, should_trigger_dreaming,
};

const CHECK_INTERVAL_MS: u64 = 5 * 60 * 1_000;

#[derive(Debug, Error)]
pub enum DreamingWorkerError {
    #[error("A dreaming pass is already running")]
    AlreadyRunning,
    #[error("dreaming pass failed: {0}")]
    PassFailed(String),
    #[error("database error: {0}")]
    Database(String),
}

#[derive(Debug, Clone)]
pub struct DreamingWorkerConfig {
    pub check_interval: Duration,
}

impl Default for DreamingWorkerConfig {
    fn default() -> Self {
        Self {
            check_interval: Duration::from_millis(CHECK_INTERVAL_MS),
        }
    }
}

#[derive(Debug, Default)]
struct WorkerState {
    active: bool,
    active_agent_id: Option<String>,
    active_pass_id: Option<String>,
    stopped: bool,
}

/// Handle for a running dreaming worker.
pub struct DreamingWorkerHandle {
    pool: DbPool,
    generator: Arc<dyn LlmGenerateFn + Send + Sync>,
    dreaming_config: DreamingConfig,
    agents_dir: String,
    default_agent_id: String,
    state: Arc<Mutex<WorkerState>>,
    scheduler: Mutex<Option<JoinHandle<()>>>,
}

fn normalize_agent_id(agent_id: Option<&str>, fallback: &str) -> String {
    let trimmed = agent_id.unwrap_or_default().trim();
    if trimmed.is_empty() {
        fallback.to_string()
    } else {
        trimmed.to_string()
    }
}

/// Discover agents the periodic dreaming worker should consider.
///
/// This is a direct Rust port of `getDreamingWorkerAgentIds`: registered
/// agents plus any agent with dreaming state/passes, memories, summaries, or
/// graph entities, with the configured default agent always included.
pub async fn get_dreaming_worker_agent_ids(pool: &DbPool, default_agent_id: &str) -> Vec<String> {
    let fallback = default_agent_id.to_string();
    pool.read(move |conn| {
        let mut stmt = conn.prepare(
            "SELECT id FROM agents
             UNION
             SELECT DISTINCT agent_id AS id FROM dreaming_state
             UNION
             SELECT DISTINCT agent_id AS id FROM dreaming_passes
             UNION
             SELECT DISTINCT agent_id AS id FROM memories WHERE is_deleted = 0
             UNION
             SELECT DISTINCT agent_id AS id FROM session_summaries
             UNION
             SELECT DISTINCT agent_id AS id FROM entities",
        )?;
        let rows = stmt
            .query_map([], |row| row.get::<_, Option<String>>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut ids = rows
            .into_iter()
            .filter_map(|id| {
                let normalized = normalize_agent_id(id.as_deref(), "");
                (!normalized.is_empty()).then_some(normalized)
            })
            .collect::<Vec<_>>();
        ids.push(fallback);
        ids.sort();
        ids.dedup();
        Ok(ids)
    })
    .await
    .unwrap_or_else(|e| {
        warn!(error = %e, "failed to discover dreaming worker agents");
        vec![default_agent_id.to_string()]
    })
}

async fn sweep_orphaned_passes(pool: &DbPool) {
    match pool
        .write(Priority::Low, |conn| {
            let changes = conn.execute(
                "UPDATE dreaming_passes
                 SET status = 'failed',
                     completed_at = datetime('now'),
                     error = 'Orphaned by daemon restart'
                 WHERE status = 'running'",
                [],
            )?;
            Ok(serde_json::json!({ "changes": changes }))
        })
        .await
    {
        Ok(value) => {
            let changes = value["changes"].as_u64().unwrap_or(0);
            if changes > 0 {
                warn!(
                    changes,
                    "swept orphaned running dreaming pass(es) from prior shutdown"
                );
            }
        }
        Err(e) => warn!(error = %e, "failed to sweep orphaned dreaming passes"),
    }
}

async fn mark_pass_failed(pool: &DbPool, pass_id: &str, error_message: &str) {
    let pass_id = pass_id.to_string();
    let error_message = error_message.to_string();
    if let Err(e) = pool
        .write(Priority::Low, move |conn| {
            conn.execute(
                "UPDATE dreaming_passes
                 SET status = 'failed', completed_at = datetime('now'), error = ?1
                 WHERE id = ?2 AND status = 'running'",
                params![error_message, pass_id],
            )?;
            Ok(serde_json::Value::Null)
        })
        .await
    {
        warn!(error = %e, "failed to mark dreaming pass failed");
    }
}

impl DreamingWorkerHandle {
    pub fn running(&self) -> bool {
        self.state.lock().expect("dreaming worker state").active
    }

    pub fn active_agent_id(&self) -> Option<String> {
        self.state
            .lock()
            .expect("dreaming worker state")
            .active_agent_id
            .clone()
    }

    pub fn active_pass_id(&self) -> Option<String> {
        self.state
            .lock()
            .expect("dreaming worker state")
            .active_pass_id
            .clone()
    }

    /// Cancel future scheduling. An in-flight pass continues asynchronously,
    /// matching the TypeScript worker shutdown contract.
    pub fn stop(&self) {
        {
            let mut state = self.state.lock().expect("dreaming worker state");
            state.stopped = true;
        }
        if let Some(handle) = self.scheduler.lock().expect("dreaming scheduler").take() {
            handle.abort();
        }
    }

    /// Force-trigger a pass and await completion.
    pub async fn trigger(
        &self,
        mode: DreamingMode,
        agent_id: Option<&str>,
    ) -> Result<DreamingPassResult, DreamingWorkerError> {
        let run_agent_id = normalize_agent_id(agent_id, &self.default_agent_id);
        self.run_pass(run_agent_id, mode, None).await
    }

    /// Fire-and-forget trigger. The pass row is created before this method
    /// returns, so callers can poll status by the returned pass id.
    pub async fn trigger_async(
        &self,
        mode: DreamingMode,
        agent_id: Option<&str>,
    ) -> Result<String, DreamingWorkerError> {
        let run_agent_id = normalize_agent_id(agent_id, &self.default_agent_id);
        {
            let mut state = self.state.lock().expect("dreaming worker state");
            if state.active {
                return Err(DreamingWorkerError::AlreadyRunning);
            }
            state.active = true;
            state.active_agent_id = Some(run_agent_id.clone());
            state.active_pass_id = None;
        }

        let pass_id = create_dreaming_pass(&self.pool, &run_agent_id, &mode).await;
        {
            let mut state = self.state.lock().expect("dreaming worker state");
            state.active_pass_id = Some(pass_id.clone());
        }

        let pool = self.pool.clone();
        let generator = self.generator.clone();
        let cfg = self.dreaming_config.clone();
        let agents_dir = self.agents_dir.clone();
        let state = self.state.clone();
        let pass_id_for_task = pass_id.clone();
        tokio::spawn(async move {
            let result = run_dreaming_pass(
                &pool,
                generator.as_ref(),
                &cfg,
                &agents_dir,
                &run_agent_id,
                &mode,
                Some(&pass_id_for_task),
            )
            .await;
            if let Err(e) = result {
                record_dreaming_failure(&pool, &run_agent_id).await;
                mark_pass_failed(&pool, &pass_id_for_task, &e).await;
                error!(agent_id = %run_agent_id, pass_id = %pass_id_for_task, error = %e, "async dreaming trigger failed");
            }
            let mut guard = state.lock().expect("dreaming worker state");
            guard.active = false;
            guard.active_agent_id = None;
            guard.active_pass_id = None;
        });

        Ok(pass_id)
    }

    async fn run_pass(
        &self,
        run_agent_id: String,
        mode: DreamingMode,
        existing_pass_id: Option<String>,
    ) -> Result<DreamingPassResult, DreamingWorkerError> {
        {
            let mut state = self.state.lock().expect("dreaming worker state");
            if state.active {
                return Err(DreamingWorkerError::AlreadyRunning);
            }
            state.active = true;
            state.active_agent_id = Some(run_agent_id.clone());
            state.active_pass_id = existing_pass_id.clone();
        }

        let result = run_dreaming_pass(
            &self.pool,
            self.generator.as_ref(),
            &self.dreaming_config,
            &self.agents_dir,
            &run_agent_id,
            &mode,
            existing_pass_id.as_deref(),
        )
        .await;

        let mut pass_id_to_fail = existing_pass_id;
        if let Ok(pass) = &result {
            pass_id_to_fail = Some(pass.pass_id.clone());
        }

        if let Err(e) = &result {
            record_dreaming_failure(&self.pool, &run_agent_id).await;
            if let Some(pass_id) = pass_id_to_fail.as_deref() {
                mark_pass_failed(&self.pool, pass_id, e).await;
            }
        }

        {
            let mut state = self.state.lock().expect("dreaming worker state");
            state.active = false;
            state.active_agent_id = None;
            state.active_pass_id = None;
        }

        result.map_err(DreamingWorkerError::PassFailed)
    }
}

async fn check_once(
    pool: DbPool,
    generator: Arc<dyn LlmGenerateFn + Send + Sync>,
    dreaming_config: DreamingConfig,
    agents_dir: String,
    default_agent_id: String,
    state: Arc<Mutex<WorkerState>>,
) {
    if state.lock().expect("dreaming worker state").active {
        return;
    }

    for run_agent_id in get_dreaming_worker_agent_ids(&pool, &default_agent_id).await {
        {
            let guard = state.lock().expect("dreaming worker state");
            if guard.stopped || guard.active {
                return;
            }
        }

        let state_snapshot = get_dreaming_state(&pool, &run_agent_id).await;
        let is_first =
            state_snapshot.last_pass_at.is_none() && dreaming_config.backfill_on_first_run;
        let mode = if is_first {
            DreamingMode::Compact
        } else {
            DreamingMode::Incremental
        };

        if !should_trigger_dreaming(&pool, &dreaming_config, &run_agent_id).await {
            continue;
        }

        info!(
            agent_id = %run_agent_id,
            tokens = state_snapshot.tokens_since_last_pass,
            threshold = dreaming_config.token_threshold,
            mode = ?mode,
            "token threshold reached, starting dreaming pass"
        );

        let handle = DreamingWorkerHandle {
            pool: pool.clone(),
            generator: generator.clone(),
            dreaming_config: dreaming_config.clone(),
            agents_dir: agents_dir.clone(),
            default_agent_id: default_agent_id.clone(),
            state: state.clone(),
            scheduler: Mutex::new(None),
        };
        match handle.run_pass(run_agent_id.clone(), mode, None).await {
            Ok(_) => {}
            Err(DreamingWorkerError::AlreadyRunning) => return,
            Err(e) => error!(agent_id = %run_agent_id, error = %e, "dreaming check failed"),
        }
    }
}

/// Start the dreaming worker scheduler.
pub async fn start_dreaming_worker(
    pool: DbPool,
    generator: Arc<dyn LlmGenerateFn + Send + Sync>,
    dreaming_config: DreamingConfig,
    agents_dir: impl Into<PathBuf>,
    default_agent_id: impl Into<String>,
    worker_config: DreamingWorkerConfig,
) -> DreamingWorkerHandle {
    sweep_orphaned_passes(&pool).await;

    let agents_dir = agents_dir.into().display().to_string();
    let default_agent_id = default_agent_id.into();
    let state = Arc::new(Mutex::new(WorkerState::default()));

    let scheduler_pool = pool.clone();
    let scheduler_generator = generator.clone();
    let scheduler_cfg = dreaming_config.clone();
    let scheduler_agents_dir = agents_dir.clone();
    let scheduler_default_agent = default_agent_id.clone();
    let scheduler_state = state.clone();
    let check_interval = worker_config.check_interval;
    let scheduler = tokio::spawn(async move {
        loop {
            tokio::time::sleep(check_interval).await;
            if scheduler_state
                .lock()
                .expect("dreaming worker state")
                .stopped
            {
                break;
            }
            check_once(
                scheduler_pool.clone(),
                scheduler_generator.clone(),
                scheduler_cfg.clone(),
                scheduler_agents_dir.clone(),
                scheduler_default_agent.clone(),
                scheduler_state.clone(),
            )
            .await;
        }
    });

    info!(
        threshold = dreaming_config.token_threshold,
        "dreaming worker started"
    );

    DreamingWorkerHandle {
        pool,
        generator,
        dreaming_config,
        agents_dir,
        default_agent_id,
        state,
        scheduler: Mutex::new(Some(scheduler)),
    }
}
