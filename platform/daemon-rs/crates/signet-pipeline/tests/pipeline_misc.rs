use std::collections::VecDeque;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use rusqlite::params;
use signet_core::db::{DbPool, Priority};
use signet_pipeline::provider::{
    CliProvider, GenerateOpts, GenerateResult, LlmProvider, LlmSemaphore, ProviderError,
};
use signet_pipeline::summary::{SummaryConfig, start as start_summary_worker};
use uuid::Uuid;

struct ScriptedProvider {
    outputs: Mutex<VecDeque<String>>,
}

impl ScriptedProvider {
    fn new(outputs: Vec<String>) -> Self {
        Self {
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
        let text = self
            .outputs
            .lock()
            .expect("scripted provider lock")
            .pop_front()
            .unwrap_or_else(|| "Signet summary artifact preserved project-a session continuity for future Rust parity work.".to_string());
        Box::pin(async move { Ok(GenerateResult { text, usage: None }) })
    }

    fn name(&self) -> &str {
        "summary-mock"
    }
}

fn unique_db_path(prefix: &str) -> PathBuf {
    std::env::temp_dir().join(format!("signet-{prefix}-{}.db", Uuid::new_v4()))
}

fn unique_root(prefix: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!("signet-{prefix}-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&root).expect("create test root");
    root
}

// Port of platform/daemon/src/pipeline/summary-worker.test.ts:84-125 and
// 183-207. The Rust worker persists the same durable session facts with
// source/session lineage, agent scope, content hashes, and audit actor data.
#[tokio::test]
async fn summary_worker_persists_hashed_scoped_session_facts_and_dag_root() {
    let path = unique_db_path("summary-port");
    let root = unique_root("summary-root");
    let (pool, writer) = DbPool::open(&path).expect("open summary db");
    seed_summary_job(
        &pool,
        "summary-job-1",
        "session-port-1",
        "agent-summary-port",
    )
    .await;

    let provider: Arc<dyn LlmProvider> = Arc::new(ScriptedProvider::new(vec![
        serde_json::json!({
            "summary": "# 2026-06-20 Session Notes\n\n## Rust Parity\n\nThe daemon-rs summary worker preserved session fact lineage for project-a.",
            "facts": [{
                "content": "The daemon-rs summary worker port stores hashed session facts under the owning agent scope for project-a continuity.",
                "importance": 0.4,
                "tags": "rust,summary",
                "type": "fact"
            }]
        })
        .to_string(),
        "The daemon-rs summary worker preserved project-a session fact lineage for Rust parity testing.".to_string(),
    ]));
    let handle = start_summary_worker(
        pool.clone(),
        provider,
        Arc::new(LlmSemaphore::new(1)),
        SummaryConfig {
            poll_ms: 5,
            max_retries: 3,
            max_tokens: 1024,
            timeout_ms: 1_000,
            min_message_count: 1,
            chunk_size: 20_000,
            agents_dir: root.clone(),
        },
    );

    let job = wait_for_summary_status(&pool, "summary-job-1", "completed").await;
    handle.stop().await;
    let result: serde_json::Value = serde_json::from_str(job["result"].as_str().unwrap()).unwrap();
    assert_eq!(result["factsExtracted"], 1);
    assert!(result["summaryLength"].as_i64().unwrap() > 20);

    let snapshot = pool
        .read(|conn| {
            let memory: serde_json::Value = conn.query_row(
                "SELECT content, content_hash, source_type, source_id, project, agent_id, updated_by
                 FROM memories
                 WHERE source_type = 'session_end' AND source_id = 'session-port-1'",
                [],
                |row| {
                    Ok(serde_json::json!({
                        "content": row.get::<_, String>(0)?,
                        "contentHash": row.get::<_, String>(1)?,
                        "sourceType": row.get::<_, String>(2)?,
                        "sourceId": row.get::<_, String>(3)?,
                        "project": row.get::<_, String>(4)?,
                        "agentId": row.get::<_, String>(5)?,
                        "updatedBy": row.get::<_, String>(6)?,
                    }))
                },
            )?;
            let history: serde_json::Value = conn.query_row(
                "SELECT event, changed_by FROM memory_history
                 WHERE memory_id = (SELECT id FROM memories WHERE source_type = 'session_end' AND source_id = 'session-port-1')",
                [],
                |row| {
                    Ok(serde_json::json!({
                        "event": row.get::<_, String>(0)?,
                        "changedBy": row.get::<_, String>(1)?,
                    }))
                },
            )?;
            let summary: serde_json::Value = conn.query_row(
                "SELECT depth, kind, agent_id, source_type, source_ref FROM session_summaries
                 WHERE session_key = 'session-port-1' AND agent_id = 'agent-summary-port'",
                [],
                |row| {
                    Ok(serde_json::json!({
                        "depth": row.get::<_, i64>(0)?,
                        "kind": row.get::<_, String>(1)?,
                        "agentId": row.get::<_, String>(2)?,
                        "sourceType": row.get::<_, String>(3)?,
                        "sourceRef": row.get::<_, String>(4)?,
                    }))
                },
            )?;
            Ok(serde_json::json!({
                "memory": memory,
                "history": history,
                "summary": summary,
            }))
        })
        .await
        .expect("read summary snapshot");

    assert_eq!(snapshot["memory"]["sourceType"], "session_end");
    assert_eq!(snapshot["memory"]["sourceId"], "session-port-1");
    assert_eq!(snapshot["memory"]["project"], "project-a");
    assert_eq!(snapshot["memory"]["agentId"], "agent-summary-port");
    assert_eq!(snapshot["memory"]["updatedBy"], "summary-worker");
    assert!(snapshot["memory"]["contentHash"].as_str().unwrap().len() > 20);
    assert_eq!(snapshot["history"]["event"], "created");
    assert_eq!(snapshot["history"]["changedBy"], "summary-worker");
    assert_eq!(snapshot["summary"]["depth"], 0);
    assert_eq!(snapshot["summary"]["kind"], "session");
    assert_eq!(snapshot["summary"]["sourceType"], "summary");
    assert_eq!(snapshot["summary"]["sourceRef"], "session-port-1");
    assert!(root.join("agents/agent-summary-port/MEMORY.md").exists());

    drop(pool);
    writer.abort();
    let _ = std::fs::remove_file(path);
    let _ = std::fs::remove_dir_all(root);
}

// Port of platform/daemon/src/pipeline/summary-condensation.test.ts:141-197.
// The DAG uniqueness contract must include agent_id so two agents can summarize
// the same harness session key independently.
#[tokio::test]
async fn summary_dag_allows_same_session_key_for_different_agents() {
    let path = unique_db_path("summary-dag-port");
    let (pool, writer) = DbPool::open(&path).expect("open summary dag db");
    pool.write(Priority::High, |conn| {
        conn.execute(
            "INSERT INTO session_summaries (
                id, project, depth, kind, content, token_count, earliest_at, latest_at,
                session_key, harness, agent_id, source_type, source_ref, meta_json, created_at
             ) VALUES
                ('sum-agent-a', 'project-a', 0, 'session', 'Agent A session summary', 10,
                 '2026-06-20T00:00:00Z', '2026-06-20T00:00:01Z', 'shared-session',
                 'codex', 'agent-a', 'summary', 'shared-session', '{}', '2026-06-20T00:00:01Z'),
                ('sum-agent-b', 'project-a', 0, 'session', 'Agent B session summary', 10,
                 '2026-06-20T00:00:00Z', '2026-06-20T00:00:01Z', 'shared-session',
                 'codex', 'agent-b', 'summary', 'shared-session', '{}', '2026-06-20T00:00:01Z')",
            [],
        )?;
        Ok(serde_json::Value::Null)
    })
    .await
    .expect("insert shared session summaries");

    let rows = pool
        .read(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, agent_id, session_key FROM session_summaries
                 WHERE session_key = 'shared-session' ORDER BY agent_id",
            )?;
            let rows = stmt
                .query_map([], |row| {
                    Ok(serde_json::json!({
                        "id": row.get::<_, String>(0)?,
                        "agentId": row.get::<_, String>(1)?,
                        "sessionKey": row.get::<_, String>(2)?,
                    }))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
        .await
        .expect("read shared session summaries");

    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0]["id"], "sum-agent-a");
    assert_eq!(rows[0]["agentId"], "agent-a");
    assert_eq!(rows[1]["id"], "sum-agent-b");
    assert_eq!(rows[1]["agentId"], "agent-b");

    drop(pool);
    writer.abort();
    let _ = std::fs::remove_file(path);
}

// Port of platform/daemon/src/pipeline/provider-executable-availability.test.ts:6-24.
// Rust has no separate available() API on CliProvider, so generation against an
// explicit missing relative executable must fail closed as unavailable.
#[tokio::test]
async fn cli_provider_checks_explicit_relative_missing_executable_paths() {
    let provider = CliProvider::new(
        "./node_modules/.bin/signet-missing-command",
        &[],
        100,
        "missing-relative-command",
    );
    let error = provider
        .generate(
            "prompt",
            &GenerateOpts {
                timeout_ms: Some(100),
                max_tokens: None,
            },
        )
        .await
        .expect_err("missing relative executable should be unavailable");
    assert!(
        matches!(&error, ProviderError::Unavailable(message) if message.contains("./node_modules/.bin/signet-missing-command")),
        "unexpected provider error: {error}"
    );
}

async fn seed_summary_job(pool: &DbPool, id: &str, session_key: &str, agent_id: &str) {
    let id = id.to_string();
    let session_key = session_key.to_string();
    let agent_id = agent_id.to_string();
    pool.write(Priority::High, move |conn| {
        let now = chrono::Utc::now().to_rfc3339();
        conn.execute(
            "INSERT INTO summary_jobs (
                id, session_key, session_id, harness, project, transcript, status,
                attempts, max_attempts, created_at, updated_at, trigger, captured_at,
                started_at, ended_at, agent_id
             ) VALUES (?1, ?2, ?2, 'codex', 'project-a', ?3, 'pending', 0, 3,
                       ?4, ?4, 'session_end', ?4, ?4, ?4, ?5)",
            params![
                id,
                session_key,
                "User: Please summarize the daemon-rs pipeline test port.\nAssistant: The worker should persist hashed facts, session DAG roots, and MEMORY.md projection under the owning agent.\nUser: Include project-a lineage and durable continuity facts.",
                now,
                agent_id
            ],
        )?;
        Ok(serde_json::Value::Null)
    })
    .await
    .expect("seed summary job");
}

async fn wait_for_summary_status(pool: &DbPool, job_id: &str, status: &str) -> serde_json::Value {
    let started = Instant::now();
    loop {
        let job_id_owned = job_id.to_string();
        let row = pool
            .read(move |conn| {
                let row = conn.query_row(
                    "SELECT status, attempts, error, result FROM summary_jobs WHERE id = ?1",
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
            .expect("read summary job");
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
