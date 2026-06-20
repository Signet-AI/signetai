//! Pipeline throughput benchmark.
//!
//! Enqueues 100 extraction jobs against the bench-dataset fixture and measures
//! end-to-end completion through the signet-pipeline worker loop with a no-op
//! LLM provider.
//! Run: cargo bench -p signet-pipeline --bench throughput

use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;
use std::time::{Duration, Instant};

use signet_core::db::{DbPool, Priority};
use signet_core::queries::{job, memory};
use signet_pipeline::provider::{GenerateOpts, GenerateResult, LlmProvider, ProviderError};
use signet_pipeline::significance_gate::SignificanceConfig;
use signet_pipeline::worker::{self, WorkerConfig};

const JOBS: usize = 100;

struct NoopProvider;

impl LlmProvider for NoopProvider {
    fn generate(
        &self,
        _prompt: &str,
        _opts: &GenerateOpts,
    ) -> Pin<Box<dyn Future<Output = Result<GenerateResult, ProviderError>> + Send + '_>> {
        Box::pin(async {
            Ok(GenerateResult {
                text: r#"{"facts":[],"entities":[]}"#.to_string(),
                usage: None,
            })
        })
    }

    fn name(&self) -> &str {
        "bench-noop"
    }
}

fn bench_db_path() -> PathBuf {
    let dir = std::env::temp_dir().join("signet-pipeline-throughput-bench");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir.join("bench.db")
}

fn fixture_path() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../contracts/fixtures/bench-dataset.sql")
}

fn add_column_if_missing(
    conn: &rusqlite::Connection,
    table: &str,
    column: &str,
    typedef: &str,
) -> Result<(), signet_core::error::CoreError> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let has_column = stmt
        .query_map([], |row| row.get::<_, String>(1))?
        .filter_map(Result::ok)
        .any(|name| name == column);
    if !has_column {
        conn.execute_batch(&format!(
            "ALTER TABLE {table} ADD COLUMN {column} {typedef}"
        ))?;
    }
    Ok(())
}

fn ensure_fixture_compat(conn: &rusqlite::Connection) -> Result<(), signet_core::error::CoreError> {
    add_column_if_missing(conn, "memories", "context", "TEXT")?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS sessions (
            session_key TEXT PRIMARY KEY,
            harness TEXT,
            started_at TEXT,
            last_activity_at TEXT,
            status TEXT,
            runtime_path TEXT
        );",
    )?;
    Ok(())
}

fn load_fixture(conn: &rusqlite::Connection) -> Result<(), signet_core::error::CoreError> {
    ensure_fixture_compat(conn)?;
    let sql = std::fs::read_to_string(fixture_path())?;
    conn.execute_batch(&sql)?;
    conn.execute(
        "INSERT OR REPLACE INTO vec_embeddings (id, embedding)
         SELECT id, vector FROM embeddings",
        [],
    )?;
    // The SLO is defined as enqueueing 100 jobs and timing them to completion.
    // Existing fixture jobs remain in the dataset for table shape/statistics, but
    // are made non-runnable so they do not mix unrelated job types into the run.
    conn.execute(
        "UPDATE memory_jobs
         SET status = 'completed', completed_at = COALESCE(completed_at, updated_at)
         WHERE status = 'pending'",
        [],
    )?;
    Ok(())
}

fn enqueue_jobs(conn: &rusqlite::Connection) -> Result<(), signet_core::error::CoreError> {
    let now = chrono::Utc::now().to_rfc3339();
    for i in 0..JOBS {
        let id = format!("bench-throughput-mem-{i:04}");
        let content = format!(
            "Pipeline throughput benchmark memory {i}. This content is long enough to pass the worker input length gate and exercise extraction bookkeeping."
        );
        let hash = format!("throughput-hash-{i:04}");
        memory::insert(
            conn,
            &memory::InsertMemory {
                id: &id,
                content: &content,
                normalized_content: &content.to_lowercase(),
                content_hash: &hash,
                memory_type: "observation",
                tags: "pipeline,throughput,benchmark",
                who: Some("bench"),
                why: None,
                project: None,
                importance: 0.5,
                pinned: false,
                extraction_status: "pending",
                embedding_model: None,
                extraction_model: None,
                source_type: None,
                source_id: None,
                source_path: None,
                idempotency_key: None,
                runtime_path: None,
                now: &now,
                updated_by: "bench",
                agent_id: "default",
                visibility: "global",
                scope: None,
            },
        )?;
        job::enqueue(
            conn,
            &job::EnqueueJob {
                id: &format!("bench-throughput-job-{i:04}"),
                memory_id: Some(&id),
                job_type: "extraction",
                payload: Some("{}"),
                max_attempts: 1,
                now: &now,
                document_id: None,
            },
        )?;
    }
    Ok(())
}

async fn completed_jobs(pool: &DbPool) -> Result<i64, signet_core::error::CoreError> {
    pool.read(|conn| {
        let count = conn.query_row(
            "SELECT COUNT(*) FROM memory_jobs
             WHERE id LIKE 'bench-throughput-job-%' AND status = 'completed'",
            [],
            |row| row.get(0),
        )?;
        Ok(count)
    })
    .await
}

async fn failed_jobs(pool: &DbPool) -> Result<i64, signet_core::error::CoreError> {
    pool.read(|conn| {
        let count = conn.query_row(
            "SELECT COUNT(*) FROM memory_jobs
             WHERE id LIKE 'bench-throughput-job-%' AND status != 'completed'",
            [],
            |row| row.get(0),
        )?;
        Ok(count)
    })
    .await
}

#[tokio::main(flavor = "multi_thread")]
async fn main() {
    println!("=== Signet Pipeline Throughput Benchmark ===\n");
    println!(
        "Platform: {} / {}",
        std::env::consts::OS,
        std::env::consts::ARCH
    );
    println!("Dataset: {}", fixture_path().display());
    println!("Jobs: {JOBS}");
    println!();

    let path = bench_db_path();
    let (pool, writer_handle) = DbPool::open(&path).expect("failed to open bench DB");

    pool.write(Priority::Low, |conn| {
        load_fixture(conn)?;
        Ok(serde_json::Value::Null)
    })
    .await
    .expect("load fixture");

    let mut config = WorkerConfig {
        max_retries: 1,
        max_load_per_cpu: 10_000.0,
        overload_backoff_ms: 1,
        extraction_timeout_ms: 1_000,
        extraction_max_tokens: 64,
        graph_enabled: false,
        structural_enabled: false,
        significance: SignificanceConfig {
            enabled: false,
            ..WorkerConfig::default().significance
        },
        ..WorkerConfig::default()
    };
    config.write_gate.enabled = false;

    let provider: Arc<dyn LlmProvider> = Arc::new(NoopProvider);
    let semaphore = Arc::new(signet_pipeline::provider::LlmSemaphore::new(32));
    let worker = worker::start(pool.clone(), provider, semaphore, config);

    let start = Instant::now();
    pool.write_tx(Priority::Low, |conn| {
        enqueue_jobs(conn)?;
        Ok(serde_json::Value::Null)
    })
    .await
    .expect("enqueue jobs");

    let deadline = Instant::now() + Duration::from_secs(70);
    loop {
        let completed = completed_jobs(&pool).await.expect("count completed");
        if completed == JOBS as i64 {
            break;
        }
        if Instant::now() > deadline {
            let remaining = failed_jobs(&pool).await.expect("count remaining");
            panic!("timed out waiting for jobs: completed={completed} remaining={remaining}");
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    let elapsed = start.elapsed();
    let jobs_per_sec = JOBS as f64 / elapsed.as_secs_f64();

    println!(
        "Completed {JOBS} jobs in {:.2}ms",
        elapsed.as_secs_f64() * 1000.0
    );
    println!("Pipeline throughput: {:.2} jobs/s", jobs_per_sec);
    println!(
        "SLO: >10 jobs/s {}",
        if jobs_per_sec > 10.0 { "PASS" } else { "FAIL" }
    );

    worker.stop().await;
    drop(pool);
    let _ = writer_handle.await;
    let _ = std::fs::remove_file(path);
    let _ = std::fs::remove_dir_all(std::env::temp_dir().join("signet-pipeline-throughput-bench"));
}
