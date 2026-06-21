//! HTTP-level recall latency and search QPS benchmark.
//!
//! Spins up a real signet-daemon process on a free loopback port, seeds the
//! bench-dataset fixture, serves a deterministic local Ollama-compatible
//! embedding endpoint, then measures:
//! - 100 sequential POST /api/memory/recall latency p50/p95
//! - concurrent GET /memory/search throughput
//!
//! Run: cargo bench -p signet-daemon --bench http_recall

use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use axum::Router;
use axum::extract::Json;
use axum::routing::post;
use reqwest::Client;
use serde_json::json;
use signet_core::db::{DbPool, Priority};
use tempfile::TempDir;
use tokio::process::{Child, Command};

const QUERY: &str = "benchmark memory content test number search";
const SEARCH_REQUESTS: usize = 256;
const SEARCH_CONCURRENCY: usize = 16;
const DIMENSIONS: usize = signet_core::constants::DEFAULT_EMBEDDING_DIMENSIONS;

fn fixture_path() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../contracts/fixtures/bench-dataset.sql")
}

fn ephemeral_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

fn daemon_binary() -> String {
    if let Ok(path) = std::env::var("CARGO_BIN_EXE_signet-daemon") {
        if Path::new(&path).exists() {
            return path;
        }
    }
    if let Ok(target_dir) = std::env::var("CARGO_TARGET_DIR") {
        let path = PathBuf::from(target_dir).join("debug/signet-daemon");
        if path.exists() {
            return path.to_string_lossy().to_string();
        }
    }
    for candidate in [
        "target/debug/signet-daemon",
        "target/release/signet-daemon",
        "../../target/debug/signet-daemon",
        "../../target/release/signet-daemon",
    ] {
        let path = Path::new(candidate);
        if path.exists() {
            return path.to_string_lossy().to_string();
        }
    }
    let workspace_path =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/debug/signet-daemon");
    if workspace_path.exists() {
        return workspace_path.to_string_lossy().to_string();
    }
    "signet-daemon".to_string()
}

async fn embedding_handler(Json(_body): Json<serde_json::Value>) -> Json<serde_json::Value> {
    let mut embedding = vec![0.0_f32; DIMENSIONS];
    embedding[0] = 1.0;
    Json(json!({ "embedding": embedding }))
}

async fn start_embedding_server() -> (String, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind embedding server");
    let addr = listener.local_addr().expect("embedding server addr");
    let app = Router::new().route("/api/embeddings", post(embedding_handler));
    let handle = tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    (format!("http://{addr}"), handle)
}

fn write_agent_yaml(root: &Path, embedding_url: &str) {
    let yaml = format!(
        r#"agent:
  name: bench-agent
embedding:
  provider: ollama
  model: bench-embedding
  dimensions: {DIMENSIONS}
  base_url: {embedding_url}
search:
  alpha: 0.65
  minScore: 0.1
  topK: 50
"#
    );
    std::fs::write(root.join("agent.yaml"), yaml).expect("write agent.yaml");
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

async fn seed_database(root: &Path) {
    let memory_dir = root.join("memory");
    std::fs::create_dir_all(&memory_dir).expect("create memory dir");
    std::fs::create_dir_all(root.join(".daemon/logs")).expect("create logs dir");
    let db_path = memory_dir.join("memories.db");
    let (pool, writer_handle) = DbPool::open(&db_path).expect("open seed DB");
    pool.write(Priority::Low, |conn| {
        ensure_fixture_compat(conn)?;
        let fixture = std::fs::read_to_string(fixture_path())?;
        conn.execute_batch(&fixture)?;
        conn.execute(
            "INSERT OR REPLACE INTO vec_embeddings (id, embedding)
             SELECT id, vector FROM embeddings",
            [],
        )?;
        Ok(serde_json::Value::Null)
    })
    .await
    .expect("seed bench fixture");
    drop(pool);
    let _ = writer_handle.await;
}

async fn spawn_daemon(root: &Path, port: u16) -> Child {
    let mut command = Command::new(daemon_binary());
    command
        .env("SIGNET_PATH", root)
        .env("SIGNET_PORT", port.to_string())
        .env("SIGNET_HOST", "127.0.0.1")
        .env("SIGNET_BIND", "127.0.0.1")
        .env("RUST_LOG", "warn")
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    command.spawn().expect("spawn signet-daemon")
}

async fn wait_for_daemon(client: &Client, base: &str) {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        assert!(Instant::now() <= deadline, "daemon did not become ready");
        if let Ok(resp) = client.get(format!("{base}/health")).send().await {
            if resp.status().is_success() {
                return;
            }
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

fn percentile(sorted: &[Duration], pct: f64) -> Duration {
    let idx = ((sorted.len() as f64 * pct).ceil() as usize)
        .saturating_sub(1)
        .min(sorted.len().saturating_sub(1));
    sorted[idx]
}

async fn measure_recall_latency(
    client: &Client,
    base: &str,
) -> (Duration, Duration, Vec<Duration>) {
    let mut latencies = Vec::with_capacity(100);
    for _ in 0..100 {
        let start = Instant::now();
        let resp = client
            .post(format!("{base}/api/memory/recall"))
            .json(&json!({ "query": QUERY, "limit": 10, "agentId": "default" }))
            .send()
            .await
            .expect("recall request");
        assert!(
            resp.status().is_success(),
            "recall status {}",
            resp.status()
        );
        let body: serde_json::Value = resp.json().await.expect("recall body");
        let empty = Vec::new();
        let results_arr = body
            .get("results")
            .and_then(|v| v.as_array())
            .unwrap_or(&empty);
        // SLO validity: a broken recall path (fixture/scoping/FTS/vector) that
        // returns an empty array would report misleadingly fast PASS numbers.
        // Require non-empty hits on the fixed bench query before recording.
        assert!(
            !results_arr.is_empty(),
            "recall returned no results (broken search path would game the SLO): {body}"
        );
        latencies.push(start.elapsed());
    }
    let mut sorted = latencies.clone();
    sorted.sort_unstable();
    (
        percentile(&sorted, 0.50),
        percentile(&sorted, 0.95),
        latencies,
    )
}

async fn measure_search_qps(client: &Client, base: &str) -> f64 {
    let url = format!("{base}/memory/search?q=testing%20benchmark%20search%20results&limit=10");
    // #13 REVIEW FIX: validate non-empty results before QPS measurement
    // (an endpoint returning 200 {results:[]} would game the SLO).
    let validate = client.get(&url).send().await.expect("validation search");
    assert!(validate.status().is_success());
    let vbody: serde_json::Value = validate.json().await.expect("validation body");
    assert!(
        !vbody
            .get("results")
            .and_then(|v| v.as_array())
            .unwrap_or(&vec![])
            .is_empty(),
        "search returned no results (broken path would game the QPS SLO)"
    );
    let start = Instant::now();
    let mut handles = Vec::with_capacity(SEARCH_CONCURRENCY);
    for worker in 0..SEARCH_CONCURRENCY {
        let client = client.clone();
        let url = url.clone();
        handles.push(tokio::spawn(async move {
            let mut completed = 0usize;
            let mut next = worker;
            while next < SEARCH_REQUESTS {
                let resp = client.get(&url).send().await.expect("search request");
                assert!(
                    resp.status().is_success(),
                    "search status {}",
                    resp.status()
                );
                let _: serde_json::Value = resp.json().await.expect("search body");
                completed += 1;
                next += SEARCH_CONCURRENCY;
            }
            completed
        }));
    }
    let mut completed = 0usize;
    for handle in handles {
        completed += handle.await.expect("search task");
    }
    completed as f64 / start.elapsed().as_secs_f64()
}

#[tokio::main(flavor = "multi_thread")]
async fn main() {
    println!("=== Signet Daemon HTTP Recall Benchmark ===\n");
    println!(
        "Platform: {} / {}",
        std::env::consts::OS,
        std::env::consts::ARCH
    );
    println!("Dataset: {}", fixture_path().display());
    println!("Query: {QUERY}");
    println!();

    let tmp = TempDir::new().expect("temp workspace");
    let (embedding_url, embedding_handle) = start_embedding_server().await;
    write_agent_yaml(tmp.path(), &embedding_url);
    seed_database(tmp.path()).await;

    let port = ephemeral_port();
    let base = format!("http://127.0.0.1:{port}");
    let mut child = spawn_daemon(tmp.path(), port).await;
    let client = Client::builder()
        .timeout(Duration::from_secs(10))
        .pool_max_idle_per_host(SEARCH_CONCURRENCY)
        .build()
        .expect("http client");

    wait_for_daemon(&client, &base).await;

    // Cold/warm-up request, discarded per bench-spec methodology.
    let warmup = client
        .post(format!("{base}/api/memory/recall"))
        .json(&json!({ "query": QUERY, "limit": 10, "agentId": "default" }))
        .send()
        .await
        .expect("warmup recall");
    assert!(
        warmup.status().is_success(),
        "warmup status {}",
        warmup.status()
    );

    // bench-spec methodology: 1 cold run (discarded) + 3 warm + 1 final,
    // report the median across the 5 measured runs to reduce noise.
    const TOTAL_RUNS: usize = 5;
    let mut p50s = Vec::with_capacity(TOTAL_RUNS);
    let mut p95s = Vec::with_capacity(TOTAL_RUNS);
    let mut qpss = Vec::with_capacity(TOTAL_RUNS);
    for run in 0..TOTAL_RUNS {
        let (p50, p95, latencies) = measure_recall_latency(&client, &base).await;
        let qps = measure_search_qps(&client, &base).await;
        let label = if run == 0 { "cold" } else { "warm" };
        println!(
            "[run {}/{}] p50={:.2}ms p95={:.2}ms qps={:.2}/s ({})",
            run + 1,
            TOTAL_RUNS,
            p50.as_secs_f64() * 1000.0,
            p95.as_secs_f64() * 1000.0,
            qps,
            label
        );
        p50s.push(p50);
        p95s.push(p95);
        qpss.push(qps);
        let _ = &latencies; // keep signature stable
    }
    // Cold run (index 0) is discarded per bench-spec; median of runs 1..=4.
    p50s.remove(0);
    p95s.remove(0);
    qpss.remove(0);
    p50s.sort();
    p95s.sort();
    qpss.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let p50 = p50s[p50s.len() / 2];
    let p95 = p95s[p95s.len() / 2];
    let qps = qpss[qpss.len() / 2];

    println!("--- median over {} warm runs ---", p50s.len());
    println!("Recall p50: {:.2}ms", p50.as_secs_f64() * 1000.0);
    println!("Recall p95: {:.2}ms", p95.as_secs_f64() * 1000.0);
    println!("Search QPS: {:.2}/s", qps);
    println!(
        "SLO recall p50 <15ms: {}",
        if p50 < Duration::from_millis(15) {
            "PASS"
        } else {
            "FAIL"
        }
    );
    println!(
        "SLO recall p95 <40ms: {}",
        if p95 < Duration::from_millis(40) {
            "PASS"
        } else {
            "FAIL"
        }
    );
    println!(
        "SLO search QPS >200/s: {}",
        if qps > 200.0 { "PASS" } else { "FAIL" }
    );

    let _ = child.start_kill();
    let _ = child.wait().await;
    embedding_handle.abort();
}
