use signet_core_native::{WorkerJob, WorkspaceOwner};
use std::sync::Arc;
use tokio::time::{sleep, timeout, Duration};

const MAX_CONCURRENCY: usize = 2;
const MAX_RUNTIME: Duration = Duration::from_secs(30);

pub(crate) fn start(owner: Arc<WorkspaceOwner>) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut active = Vec::new();
        loop {
            active.retain(|task: &tokio::task::JoinHandle<()>| !task.is_finished());
            while active.len() < MAX_CONCURRENCY {
                let Ok(Some(job)) = owner.worker_claim() else {
                    break;
                };
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
    let reason = format!("unsupported external provider for job kind {}", job.kind);
    let result = timeout(MAX_RUNTIME, async move {
        owner.finish_worker_job(job, "failed", Some(&reason))
    })
    .await;
    if let Ok(Err(error)) = result {
        eprintln!("durable worker terminal update failed: {error}");
    }
}
