use std::collections::VecDeque;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use rusqlite::params;
use signet_core::db::{DbPool, Priority};
use signet_pipeline::provider::{
    GenerateOpts, GenerateResult, LlmProvider, LlmSemaphore, ProviderError,
};
use signet_pipeline::significance_gate::SignificanceConfig;
use signet_pipeline::worker::{WorkerConfig, start};
use signet_pipeline::write_gate::WriteGateConfig;
use uuid::Uuid;

struct ScriptedProvider {
    name: &'static str,
    outputs: Mutex<VecDeque<Result<String, String>>>,
}

impl ScriptedProvider {
    fn new(name: &'static str, outputs: Vec<Result<String, String>>) -> Self {
        Self {
            name,
            outputs: Mutex::new(outputs.into()),
        }
    }
}

impl LlmProvider for ScriptedProvider {
    fn generate(
        &self,
        _prompt: &str,
        _opts: &GenerateOpts,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<GenerateResult, ProviderError>> + Send + '_>>
    {
        let output = self
            .outputs
            .lock()
            .expect("scripted provider lock")
            .pop_front()
            .unwrap_or_else(|| Err("scripted provider exhausted".to_string()));
        Box::pin(async move {
            match output {
                Ok(text) => Ok(GenerateResult { text, usage: None }),
                Err(error) => Err(ProviderError::Other(error)),
            }
        })
    }

    fn name(&self) -> &str {
        self.name
    }
}

fn unique_db_path(prefix: &str) -> PathBuf {
    std::env::temp_dir().join(format!("signet-{prefix}-{}.db", Uuid::new_v4()))
}

fn worker_config(shadow_mode: bool, graph_enabled: bool) -> WorkerConfig {
    WorkerConfig {
        poll_ms: 5,
        max_retries: 3,
        lease_timeout_ms: 1_000,
        max_load_per_cpu: f64::MAX,
        overload_backoff_ms: 20,
        extraction_timeout_ms: 1_000,
        extraction_max_tokens: 1024,
        min_confidence: 0.7,
        shadow_mode,
        graph_enabled,
        structural_enabled: false,
        significance: SignificanceConfig {
            enabled: false,
            min_turns: 5,
            min_entity_overlap: 1,
            novelty_threshold: 0.15,
        },
        write_gate: WriteGateConfig {
            enabled: false,
            threshold: 0.3,
            continuity_discount: 0.1,
        },
        ..WorkerConfig::default()
    }
}

async fn seed_source_memory(
    pool: &DbPool,
    id: &str,
    content: &str,
    agent_id: &str,
    visibility: &str,
    scope: Option<&str>,
    project: Option<&str>,
) {
    let id = id.to_string();
    let content = content.to_string();
    let agent_id = agent_id.to_string();
    let visibility = visibility.to_string();
    let scope = scope.map(str::to_string);
    let project = project.map(str::to_string);
    pool.write(Priority::High, move |conn| {
        let now = chrono::Utc::now().to_rfc3339();
        conn.execute(
            "INSERT INTO memories
             (id, type, content, confidence, importance, created_at, updated_at,
              updated_by, vector_clock, is_deleted, extraction_status, agent_id,
              visibility, scope, project, source_type, source_id)
             VALUES (?1, 'transcript', ?2, 1.0, 0.5, ?3, ?3, 'test', '{}', 0,
                     'none', ?4, ?5, ?6, ?7, 'manual', ?1)",
            params![id, content, now, agent_id, visibility, scope, project],
        )?;
        Ok(serde_json::Value::Null)
    })
    .await
    .expect("seed source memory");
}

async fn enqueue_extract_job(pool: &DbPool, job_id: &str, memory_id: &str) {
    let job_id = job_id.to_string();
    let memory_id = memory_id.to_string();
    pool.write(Priority::High, move |conn| {
        let now = chrono::Utc::now().to_rfc3339();
        conn.execute(
            "INSERT INTO memory_jobs
             (id, memory_id, job_type, status, attempts, max_attempts, created_at, updated_at)
             VALUES (?1, ?2, 'extract', 'pending', 0, 3, ?3, ?3)",
            params![job_id, memory_id, now],
        )?;
        Ok(serde_json::Value::Null)
    })
    .await
    .expect("enqueue extract job");
}

async fn wait_for_job_status(pool: &DbPool, job_id: &str, status: &str) -> serde_json::Value {
    let started = Instant::now();
    loop {
        let job_id_owned = job_id.to_string();
        let row = pool
            .read(move |conn| {
                let row = conn.query_row(
                    "SELECT status, attempts, error, result FROM memory_jobs WHERE id = ?1",
                    [job_id_owned],
                    |row| {
                        Ok(serde_json::json!({
                            "status": row.get::<_, String>(0)?,
                            "attempts": row.get::<_, i64>(1)?,
                            "error": row.get::<_, Option<String>>(2)?,
                            "result": row.get::<_, Option<String>>(3)?,
                        }))
                    },
                )?;
                Ok(row)
            })
            .await
            .expect("read job");
        if row["status"] == status {
            return row;
        }
        assert!(
            started.elapsed() < Duration::from_secs(3),
            "timed out waiting for {job_id} to become {status}; last row: {row}"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

fn extraction_response(fact: &str, entities: serde_json::Value) -> String {
    serde_json::json!({
        "facts": [{"content": fact, "type": "preference", "confidence": 0.91}],
        "entities": entities,
    })
    .to_string()
}

fn add_decision_response(fact: &str) -> String {
    serde_json::json!({
        "action": "add",
        "confidence": 0.91,
        "reason": format!("Store durable extracted fact: {fact}"),
    })
    .to_string()
}

// Port of platform/daemon/src/pipeline/worker.test.ts:452-495 and 678-720,
// plus the end-to-end write/graph/history assertions from
// platform/daemon/src/pipeline/worker.integration.test.ts:465-560.
#[tokio::test]
async fn worker_extracts_add_decision_writes_fact_history_graph_and_fts() {
    let path = unique_db_path("worker-port-add");
    let (pool, writer) = DbPool::open(&path).expect("open worker db");
    let source_id = "source-port-add";
    let fact = "The Rust ported pipeline worker test must write extracted ADD proposal facts as scoped pipeline-v2 memories with durable audit history.";
    seed_source_memory(
        &pool,
        source_id,
        "User: Please remember that the Rust pipeline worker port must preserve scoped fact writes, graph links, and audit history from extracted facts.",
        "agent-worker-port",
        "private",
        Some("repo-scope"),
        Some("platform/daemon-rs"),
    )
    .await;
    enqueue_extract_job(&pool, "job-port-add", source_id).await;

    let provider: Arc<dyn LlmProvider> = Arc::new(ScriptedProvider::new(
        "mock-test",
        vec![
            Ok(extraction_response(
                fact,
                serde_json::json!([{
                    "source": "Rust pipeline worker",
                    "source_type": "system",
                    "relationship": "writes",
                    "target": "scoped fact memories",
                    "target_type": "artifact"
                }]),
            )),
            Ok(add_decision_response(fact)),
        ],
    ));
    let handle = start(
        pool.clone(),
        provider,
        Arc::new(LlmSemaphore::new(1)),
        worker_config(false, true),
    );

    let job = wait_for_job_status(&pool, "job-port-add", "completed").await;
    handle.stop().await;
    assert_eq!(job["attempts"], 1);
    let result: serde_json::Value = serde_json::from_str(job["result"].as_str().unwrap()).unwrap();
    assert_eq!(result["factsExtracted"], 1);
    assert_eq!(result["entitiesExtracted"], 1);

    let snapshot = pool
        .read(move |conn| {
            let written: serde_json::Value = conn.query_row(
                "SELECT id, content, type, source_type, source_id, agent_id, visibility,
                        scope, project, extraction_status, extraction_model, updated_by
                 FROM memories
                 WHERE source_type = 'pipeline-v2' AND source_id = ?1",
                [source_id],
                |row| {
                    Ok(serde_json::json!({
                        "id": row.get::<_, String>(0)?,
                        "content": row.get::<_, String>(1)?,
                        "type": row.get::<_, String>(2)?,
                        "sourceType": row.get::<_, String>(3)?,
                        "sourceId": row.get::<_, String>(4)?,
                        "agentId": row.get::<_, String>(5)?,
                        "visibility": row.get::<_, String>(6)?,
                        "scope": row.get::<_, String>(7)?,
                        "project": row.get::<_, String>(8)?,
                        "extractionStatus": row.get::<_, String>(9)?,
                        "extractionModel": row.get::<_, String>(10)?,
                        "updatedBy": row.get::<_, String>(11)?,
                    }))
                },
            )?;
            let written_id = written["id"].as_str().unwrap();
            let source_status: String = conn.query_row(
                "SELECT extraction_status FROM memories WHERE id = ?1",
                [source_id],
                |row| row.get(0),
            )?;
            let created_history: serde_json::Value = conn.query_row(
                "SELECT event, changed_by, new_content, metadata FROM memory_history WHERE memory_id = ?1",
                [written_id],
                |row| {
                    let metadata: String = row.get(3)?;
                    Ok(serde_json::json!({
                        "event": row.get::<_, String>(0)?,
                        "changedBy": row.get::<_, String>(1)?,
                        "newContent": row.get::<_, String>(2)?,
                        "metadata": serde_json::from_str::<serde_json::Value>(&metadata).unwrap(),
                    }))
                },
            )?;
            let source_history: serde_json::Value = conn.query_row(
                "SELECT event, changed_by, metadata FROM memory_history WHERE memory_id = ?1",
                [source_id],
                |row| {
                    let metadata: String = row.get(2)?;
                    Ok(serde_json::json!({
                        "event": row.get::<_, String>(0)?,
                        "changedBy": row.get::<_, String>(1)?,
                        "metadata": serde_json::from_str::<serde_json::Value>(&metadata).unwrap(),
                    }))
                },
            )?;
            let entity_count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM entities WHERE agent_id = 'agent-worker-port'",
                [],
                |row| row.get(0),
            )?;
            let relation_count: i64 =
                conn.query_row("SELECT COUNT(*) FROM relations", [], |row| row.get(0))?;
            let mention_count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM memory_entity_mentions WHERE memory_id = ?1",
                [source_id],
                |row| row.get(0),
            )?;
            let fts_count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM memories_fts WHERE memories_fts MATCH 'scoped AND audit'",
                [],
                |row| row.get(0),
            )?;
            Ok(serde_json::json!({
                "written": written,
                "sourceStatus": source_status,
                "createdHistory": created_history,
                "sourceHistory": source_history,
                "entityCount": entity_count,
                "relationCount": relation_count,
                "mentionCount": mention_count,
                "ftsCount": fts_count,
            }))
        })
        .await
        .expect("read worker snapshot");

    assert_eq!(snapshot["written"]["content"], fact);
    assert_eq!(snapshot["written"]["type"], "preference");
    assert_eq!(snapshot["written"]["sourceType"], "pipeline-v2");
    assert_eq!(snapshot["written"]["sourceId"], source_id);
    assert_eq!(snapshot["written"]["agentId"], "agent-worker-port");
    assert_eq!(snapshot["written"]["visibility"], "private");
    assert_eq!(snapshot["written"]["scope"], "repo-scope");
    assert_eq!(snapshot["written"]["project"], "platform/daemon-rs");
    assert_eq!(snapshot["written"]["extractionStatus"], "completed");
    assert_eq!(snapshot["written"]["extractionModel"], "mock-test");
    assert_eq!(snapshot["written"]["updatedBy"], "pipeline-v2");
    assert_eq!(snapshot["sourceStatus"], "completed");
    assert_eq!(snapshot["createdHistory"]["event"], "created");
    assert_eq!(snapshot["createdHistory"]["changedBy"], "pipeline-v2");
    assert_eq!(snapshot["createdHistory"]["newContent"], fact);
    assert_eq!(
        snapshot["createdHistory"]["metadata"]["sourceMemoryId"],
        source_id
    );
    assert_eq!(snapshot["sourceHistory"]["event"], "none");
    assert_eq!(snapshot["sourceHistory"]["changedBy"], "pipeline-v2");
    assert_eq!(snapshot["sourceHistory"]["metadata"]["shadow"], false);
    assert_eq!(
        snapshot["sourceHistory"]["metadata"]["proposedAction"],
        "add"
    );
    assert_eq!(
        snapshot["sourceHistory"]["metadata"]["createdMemoryId"],
        snapshot["written"]["id"]
    );
    assert_eq!(snapshot["entityCount"], 2);
    assert_eq!(snapshot["relationCount"], 1);
    assert_eq!(snapshot["mentionCount"], 2);
    assert!(snapshot["ftsCount"].as_i64().unwrap() >= 1);

    drop(pool);
    writer.abort();
    let _ = std::fs::remove_file(path);
}

// Port of platform/daemon/src/pipeline/worker.test.ts:472-495 and
// platform/daemon/src/pipeline/worker.integration.test.ts:622-665.
#[tokio::test]
async fn worker_shadow_mode_records_decision_history_without_fact_or_graph_writes() {
    let path = unique_db_path("worker-port-shadow");
    let (pool, writer) = DbPool::open(&path).expect("open worker db");
    let source_id = "source-port-shadow";
    let fact = "The Rust pipeline worker shadow mode should audit ADD proposals without inserting derived fact memories or graph links for the source transcript.";
    seed_source_memory(
        &pool,
        source_id,
        "User: Please verify shadow mode keeps proposed extracted facts auditable while preventing controlled writes and graph persistence.",
        "agent-shadow-port",
        "global",
        None,
        None,
    )
    .await;
    enqueue_extract_job(&pool, "job-port-shadow", source_id).await;

    let provider: Arc<dyn LlmProvider> = Arc::new(ScriptedProvider::new(
        "mock-shadow",
        vec![
            Ok(extraction_response(
                fact,
                serde_json::json!([{
                    "source": "Shadow worker",
                    "relationship": "skips",
                    "target": "fact writes"
                }]),
            )),
            Ok(add_decision_response(fact)),
        ],
    ));
    let handle = start(
        pool.clone(),
        provider,
        Arc::new(LlmSemaphore::new(1)),
        worker_config(true, true),
    );

    let job = wait_for_job_status(&pool, "job-port-shadow", "completed").await;
    handle.stop().await;
    let result: serde_json::Value = serde_json::from_str(job["result"].as_str().unwrap()).unwrap();
    assert_eq!(result["factsExtracted"], 0);
    assert_eq!(result["entitiesExtracted"], 1);

    let snapshot = pool
        .read(move |conn| {
            let derived_count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM memories WHERE source_type = 'pipeline-v2' AND source_id = ?1",
                [source_id],
                |row| row.get(0),
            )?;
            let mention_count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM memory_entity_mentions WHERE memory_id = ?1",
                [source_id],
                |row| row.get(0),
            )?;
            let history: serde_json::Value = conn.query_row(
                "SELECT event, changed_by, metadata FROM memory_history WHERE memory_id = ?1",
                [source_id],
                |row| {
                    let metadata: String = row.get(2)?;
                    Ok(serde_json::json!({
                        "event": row.get::<_, String>(0)?,
                        "changedBy": row.get::<_, String>(1)?,
                        "metadata": serde_json::from_str::<serde_json::Value>(&metadata).unwrap(),
                    }))
                },
            )?;
            Ok(serde_json::json!({
                "derivedCount": derived_count,
                "mentionCount": mention_count,
                "history": history,
            }))
        })
        .await
        .expect("read shadow snapshot");

    assert_eq!(snapshot["derivedCount"], 0);
    assert_eq!(snapshot["mentionCount"], 0);
    assert_eq!(snapshot["history"]["event"], "none");
    assert_eq!(snapshot["history"]["changedBy"], "pipeline-shadow");
    assert_eq!(snapshot["history"]["metadata"]["shadow"], true);
    assert_eq!(snapshot["history"]["metadata"]["proposedAction"], "add");

    drop(pool);
    writer.abort();
    let _ = std::fs::remove_file(path);
}

// Port of platform/daemon/src/pipeline/worker.test.ts:540-556, tightened to
// prove a transient provider error is retried and then completed by a later tick.
#[tokio::test]
async fn worker_retries_transient_provider_errors_before_completion() {
    let path = unique_db_path("worker-port-retry");
    let (pool, writer) = DbPool::open(&path).expect("open worker db");
    let source_id = "source-port-retry";
    let fact = "The Rust pipeline worker should retry a transient LLM extraction failure and complete the durable extraction job on a subsequent successful provider call.";
    seed_source_memory(
        &pool,
        source_id,
        "User: Please verify transient provider failures are retried instead of losing the extraction job before durable processing can complete.",
        "default",
        "global",
        None,
        None,
    )
    .await;
    enqueue_extract_job(&pool, "job-port-retry", source_id).await;

    let provider: Arc<dyn LlmProvider> = Arc::new(ScriptedProvider::new(
        "mock-retry",
        vec![
            Err("Transient LLM failure".to_string()),
            Ok(extraction_response(fact, serde_json::json!([]))),
            Ok(add_decision_response(fact)),
        ],
    ));
    let handle = start(
        pool.clone(),
        provider,
        Arc::new(LlmSemaphore::new(1)),
        worker_config(false, false),
    );

    let job = wait_for_job_status(&pool, "job-port-retry", "completed").await;
    handle.stop().await;
    assert!(
        job["attempts"].as_i64().unwrap() >= 2,
        "job was not retried: {job}"
    );
    assert!(
        job["error"]
            .as_str()
            .unwrap_or_default()
            .contains("LLM generation failed"),
        "first failure should remain auditable on the job row: {job}"
    );
    let result: serde_json::Value = serde_json::from_str(job["result"].as_str().unwrap()).unwrap();
    assert_eq!(result["factsExtracted"], 1);

    drop(pool);
    writer.abort();
    let _ = std::fs::remove_file(path);
}
