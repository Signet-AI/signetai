use crate::ExternalOwner;
use serde_json::{json, Value};
use signet_core_native::{Operation, WorkerJob};
use std::sync::Arc;
use tokio::time::{sleep, Duration};

const MAX_CONCURRENCY: usize = 2;

pub(crate) fn start(owner: Arc<ExternalOwner>) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut active = Vec::new();
        loop {
            active.retain(|task: &tokio::task::JoinHandle<()>| !task.is_finished());
            while active.len() < MAX_CONCURRENCY {
                let Ok(value) = owner.submit_async(Operation::WorkerClaim).await else {
                    break;
                };
                if value.is_null() {
                    break;
                }
                let Ok(job) = serde_json::from_value::<WorkerJob>(value) else {
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

async fn execute(owner: Arc<ExternalOwner>, job: WorkerJob) {
    let result: Result<(String, Value), String> = match serde_json::from_str::<Value>(&job.payload)
    {
        Err(error) => Err(error.to_string()),
        Ok(payload) => {
            if payload.get("provider").and_then(Value::as_str) != Some("fixture") {
                Err("provider unavailable: expected fixture".into())
            } else if payload
                .get("content")
                .and_then(Value::as_str)
                .map_or(true, |v| v.is_empty() || v.len() > 4096)
            {
                Err("fixture content is required and bounded to 4096 bytes".into())
            } else {
                Ok((
                    payload
                        .get("content")
                        .and_then(Value::as_str)
                        .unwrap()
                        .to_owned(),
                    payload,
                ))
            }
        }
    };
    match result {
        Ok((content, payload)) => {
            let workspace = job.workspace_id.clone().unwrap_or_else(|| "default".into());
            let write = owner.submit_async(Operation::OntologyUpsert {
                agent_id: job.agent_id.clone(), workspace_id: workspace,
                kind: "dream.fixture".into(), id: None,
                value: json!({"content":content,"provider":"fixture","jobId":job.id,"payload":payload}),
            }).await;
            let (state, error, result) = match write {
                Ok(output) => (
                    "completed".into(),
                    None,
                    Some(
                        json!({"provider":"fixture","output":output,"provenance":{"jobId":job.id,"source":"dreaming"}}),
                    ),
                ),
                Err(error) => ("failed".into(), Some(error.to_string()), None),
            };
            finish(owner, job, state, error, result).await;
        }
        Err(error) => finish(owner, job, "failed".into(), Some(error.to_string()), None).await,
    }
}

async fn finish(
    owner: Arc<ExternalOwner>,
    job: WorkerJob,
    state: String,
    error: Option<String>,
    result: Option<Value>,
) {
    if let Err(error) = owner
        .submit_async(Operation::WorkerFinish {
            job,
            state,
            error,
            result,
        })
        .await
    {
        eprintln!("durable worker terminal update failed: {error}");
    }
}
