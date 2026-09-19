use signet_core_native::{WorkerJob, WorkspaceOwner};
use std::sync::Arc;
use tokio::time::{sleep, Duration};

const MAX_CONCURRENCY: usize = 2;
const MAX_RUNTIME: Duration = Duration::from_secs(30);

/// Durable execution loop. SQLite is accessed only through WorkspaceOwner.
pub(crate) fn start(owner: Arc<WorkspaceOwner>) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut active = Vec::new();
        loop {
            active.retain(|task: &tokio::task::JoinHandle<()>| !task.is_finished());
            while active.len() < MAX_CONCURRENCY {
                let claimed = owner.worker_claim();
                let Ok(Some(job)) = claimed else { break };
                let worker_owner = owner.clone();
                active.push(tokio::spawn(
                    async move { execute(worker_owner, job).await },
                ));
            }
            sleep(Duration::from_millis(100)).await;
        }
    })
}

async fn execute(owner: Arc<WorkspaceOwner>, job: WorkerJob) {
    // No provider or semantic Dreaming implementation is present in this slice.
    // Fail truthfully rather than manufacturing a successful pass.
    let reason = format!("unsupported external provider for job kind {}", job.kind);
    let _ = tokio::time::timeout(MAX_RUNTIME, async move {
        let _ = owner.finish_worker_job(job, "failed", Some(&reason));
    })
    .await;
}
