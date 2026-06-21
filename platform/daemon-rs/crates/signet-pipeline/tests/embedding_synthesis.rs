use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;

use signet_core::db::{DbPool, Priority};
use signet_pipeline::embedding_tracker::{
    EmbeddingFailureMap, StaleEmbeddingRow, compute_embedding_retry_backoff_ms,
    process_embedding_cycle,
};
use signet_pipeline::provider::{
    GenerateOpts, GenerateResult, LlmProvider, LlmSemaphore, ProviderError,
};
use signet_pipeline::synthesis::{
    ManualSynthesisResult, SynthesisConfig, SynthesisTriggerOptions,
    start as start_synthesis_worker, write_last_synthesis_time_at,
};
use uuid::Uuid;

struct StaticProvider;

impl LlmProvider for StaticProvider {
    fn generate(
        &self,
        _prompt: &str,
        _opts: &GenerateOpts,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<GenerateResult, ProviderError>> + Send + '_>>
    {
        Box::pin(async move {
            Ok(GenerateResult {
                text: "unused deterministic synthesis provider".to_string(),
                usage: None,
            })
        })
    }

    fn name(&self) -> &str {
        "embedding-synthesis-test"
    }
}

fn row(content: &str, content_hash: &str) -> StaleEmbeddingRow {
    StaleEmbeddingRow {
        id: "mem-1".to_string(),
        content: content.to_string(),
        content_hash: content_hash.to_string(),
        current_model: None,
    }
}

fn unique_db_path(prefix: &str) -> PathBuf {
    std::env::temp_dir().join(format!("signet-{prefix}-{}.db", Uuid::new_v4()))
}

fn unique_root(prefix: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!("signet-{prefix}-{}", Uuid::new_v4()));
    fs::create_dir_all(&root).expect("create root");
    root
}

fn synthesis_config(root: &std::path::Path) -> SynthesisConfig {
    SynthesisConfig {
        poll_ms: 5,
        min_interval_secs: 3600,
        timeout_ms: 1_000,
        max_tokens: 1_024,
        agents_dir: root.display().to_string(),
    }
}

async fn seed_summary(pool: &DbPool, id: &str, agent_id: &str, content: &str) {
    let id = id.to_string();
    let agent_id = agent_id.to_string();
    let content = content.to_string();
    pool.write(Priority::High, move |conn| {
        conn.execute(
            "INSERT INTO session_summaries (
                id, project, depth, kind, content, token_count, earliest_at, latest_at,
                session_key, harness, agent_id, source_type, source_ref, meta_json, created_at
             ) VALUES (?1, 'project-synthesis-api', 0, 'session', ?2, 10,
                '2026-06-20T00:00:00Z', '2026-06-20T00:00:01Z', ?1,
                'codex', ?3, 'summary', ?1, '{}', '2026-06-20T00:00:01Z')",
            rusqlite::params![id, content, agent_id],
        )?;
        Ok(serde_json::Value::Null)
    })
    .await
    .expect("seed summary");
}

fn open_pool(prefix: &str) -> (DbPool, tokio::task::JoinHandle<()>, PathBuf) {
    let path = unique_db_path(prefix);
    let (pool, writer) = DbPool::open(&path).expect("open db");
    (pool, writer, path)
}

fn provider() -> Arc<dyn LlmProvider> {
    Arc::new(StaticProvider)
}

#[test]
fn embedding_backoff_matches_typescript_floors_and_poll_overrides() {
    assert_eq!(compute_embedding_retry_backoff_ms(1, 1_000), 60_000);
    assert_eq!(compute_embedding_retry_backoff_ms(2, 1_000), 5 * 60_000);
    assert_eq!(compute_embedding_retry_backoff_ms(3, 1_000), 30 * 60_000);
    assert_eq!(compute_embedding_retry_backoff_ms(4, 1_000), 60 * 60_000);
    assert_eq!(compute_embedding_retry_backoff_ms(1, 20_000), 100_000);
    assert_eq!(compute_embedding_retry_backoff_ms(2, 20_000), 500_000);
}

#[test]
fn embedding_cycle_suppresses_same_payload_but_not_new_hash_and_clears_on_success() {
    let mut failures: EmbeddingFailureMap = HashMap::new();
    let rows = vec![row("bad", "hash-a")];
    let mut calls = 0;

    let first = process_embedding_cycle(
        &rows,
        &mut failures,
        "mxbai-embed-large",
        1_000,
        |_| {
            calls += 1;
            None
        },
        1_000,
    );
    let second = process_embedding_cycle(
        &rows,
        &mut failures,
        "mxbai-embed-large",
        1_000,
        |_| {
            calls += 1;
            None
        },
        2_000,
    );

    assert_eq!(first.failed, 1);
    assert_eq!(second.failed, 0);
    assert_eq!(second.queue_depth, 0);
    assert_eq!(calls, 1);

    let changed = process_embedding_cycle(
        &[row("good-new-shape", "hash-new")],
        &mut failures,
        "mxbai-embed-large",
        1_000,
        |text| {
            assert_eq!(text, "good-new-shape");
            None
        },
        2_000,
    );
    assert_eq!(changed.queue_depth, 1);
    assert_eq!(changed.failed, 1);

    let retry = process_embedding_cycle(
        &rows,
        &mut failures,
        "mxbai-embed-large",
        1_000,
        |_| Some(vec![0.1, 0.2, 0.3]),
        70_000,
    );
    assert_eq!(retry.results.len(), 1);
    assert!(failures.is_empty(), "success clears all row/model failures");

    let after = process_embedding_cycle(
        &rows,
        &mut failures,
        "mxbai-embed-large",
        1_000,
        |_| Some(vec![0.1, 0.2, 0.3]),
        71_000,
    );
    assert_eq!(after.results.len(), 1);
    assert_eq!(after.failed, 0);
}

#[tokio::test]
async fn synthesis_manual_trigger_respects_write_lock_and_queues_forced_retries() {
    let (pool, writer, path) = open_pool("synthesis-lock");
    let root = unique_root("synthesis-lock-root");
    seed_summary(
        &pool,
        "summary-default",
        "default",
        "Default synthesis API content.",
    )
    .await;
    let handle = start_synthesis_worker(
        pool.clone(),
        provider(),
        Arc::new(LlmSemaphore::new(1)),
        synthesis_config(&root),
    );

    let lock = handle.acquire_write_lock().expect("manual lock");
    assert!(handle.is_synthesizing());

    let skipped = handle.trigger_now(None).await;
    assert_eq!(
        skipped,
        ManualSynthesisResult {
            success: false,
            skipped: true,
            reason: Some("Synthesis already in progress".to_string()),
        }
    );

    let forced = handle
        .trigger_now(Some(SynthesisTriggerOptions {
            force: true,
            source: Some("session-summary".to_string()),
            agent_id: Some("agent-a".to_string()),
        }))
        .await;
    assert_eq!(
        forced.reason.as_deref(),
        Some("Synthesis already in progress (queued forced retry)")
    );
    handle
        .trigger_now(Some(SynthesisTriggerOptions {
            force: true,
            source: Some("compaction-complete".to_string()),
            agent_id: Some("agent-a".to_string()),
        }))
        .await;
    handle
        .trigger_now(Some(SynthesisTriggerOptions {
            force: true,
            source: Some("compaction-complete".to_string()),
            agent_id: Some("agent-b".to_string()),
        }))
        .await;
    assert_eq!(handle.pending_force_count(), 3);

    handle.release_write_lock(lock);
    handle.stop().await;
    drop(pool);
    writer.abort();
    let _ = fs::remove_file(path);
    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn synthesis_manual_trigger_uses_per_agent_cooldown_and_force_override() {
    let (pool, writer, path) = open_pool("synthesis-cooldown");
    let root = unique_root("synthesis-cooldown-root");
    seed_summary(
        &pool,
        "summary-default",
        "default",
        "Default cooldown content.",
    )
    .await;
    seed_summary(
        &pool,
        "summary-agent-b",
        "agent-b",
        "Agent B cooldown content.",
    )
    .await;
    let cfg = synthesis_config(&root);
    write_last_synthesis_time_at(
        &root,
        chrono::Utc::now().timestamp_millis() as u64 - 5 * 60 * 1_000,
        None,
    );
    let handle = start_synthesis_worker(
        pool.clone(),
        provider(),
        Arc::new(LlmSemaphore::new(1)),
        cfg,
    );

    let default_skip = handle.trigger_now(None).await;
    assert_eq!(default_skip.success, false);
    assert_eq!(default_skip.skipped, true);
    assert_eq!(
        default_skip.reason.as_deref(),
        Some("Too recent — last run 5m ago, minimum is 60m")
    );

    let scoped = handle
        .trigger_now(Some(SynthesisTriggerOptions {
            force: false,
            source: None,
            agent_id: Some("agent-b".to_string()),
        }))
        .await;
    assert_eq!(scoped.success, true);
    assert!(root.join("agents/agent-b/MEMORY.md").exists());

    let forced = handle
        .trigger_now(Some(SynthesisTriggerOptions {
            force: true,
            source: Some("session-summary".to_string()),
            agent_id: None,
        }))
        .await;
    assert_eq!(forced.success, true);
    assert!(root.join("MEMORY.md").exists());

    handle.stop().await;
    drop(pool);
    writer.abort();
    let _ = fs::remove_file(path);
    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn synthesis_forced_queue_rotates_past_retrying_head_agent() {
    let (pool, writer, path) = open_pool("synthesis-forced-rotation");
    let root = unique_root("synthesis-forced-rotation-root");
    seed_summary(
        &pool,
        "summary-bad-agent",
        "../bad-agent",
        "Invalid agent should keep retrying and not starve the queue.",
    )
    .await;
    seed_summary(
        &pool,
        "summary-agent-b",
        "agent-b",
        "Agent B must not be starved by an earlier retry.",
    )
    .await;
    let mut cfg = synthesis_config(&root);
    cfg.min_interval_secs = 0;
    let handle = start_synthesis_worker(
        pool.clone(),
        provider(),
        Arc::new(LlmSemaphore::new(1)),
        cfg,
    );

    let lock = handle.acquire_write_lock().expect("hold write lock");
    handle
        .trigger_now(Some(SynthesisTriggerOptions {
            force: true,
            source: Some("session-summary".to_string()),
            agent_id: Some("../bad-agent".to_string()),
        }))
        .await;
    handle
        .trigger_now(Some(SynthesisTriggerOptions {
            force: true,
            source: Some("compaction-complete".to_string()),
            agent_id: Some("agent-b".to_string()),
        }))
        .await;
    handle.release_write_lock(lock);

    let projection = root.join("agents/agent-b/MEMORY.md");
    for _ in 0..200 {
        if projection.exists() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    assert!(
        fs::read_to_string(&projection)
            .unwrap_or_default()
            .contains("Agent B must not be starved"),
        "later forced agents should run even while an earlier entry retries"
    );

    handle.stop().await;
    drop(pool);
    writer.abort();
    let _ = fs::remove_file(path);
    let _ = fs::remove_dir_all(root);
}
