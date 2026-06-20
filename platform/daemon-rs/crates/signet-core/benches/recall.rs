//! Recall and search benchmarks.
//!
//! Measures: FTS search latency, hybrid search latency, memory insert throughput.
//! Run: cargo bench -p signet-core -- recall

use std::hint::black_box;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use signet_core::db::{DbPool, Priority};

const QUERY: &str = "what did the user say about testing benchmark search results";
const DIMENSIONS: usize = signet_core::constants::DEFAULT_EMBEDDING_DIMENSIONS;

fn bench_db_path(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(name);
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir.join("bench.db")
}

fn setup_db(
    rt: &tokio::runtime::Runtime,
    name: &str,
) -> (DbPool, tokio::task::JoinHandle<()>, PathBuf) {
    let path = bench_db_path(name);
    let (pool, handle) = rt
        .block_on(async { DbPool::open(&path) })
        .expect("failed to open bench DB");
    (pool, handle, path)
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

fn load_bench_fixture(conn: &rusqlite::Connection) -> Result<(), signet_core::error::CoreError> {
    ensure_fixture_compat(conn)?;
    let sql = std::fs::read_to_string(fixture_path())?;
    conn.execute_batch(&sql)?;
    conn.execute(
        "INSERT OR REPLACE INTO vec_embeddings (id, embedding)
         SELECT id, vector FROM embeddings",
        [],
    )?;
    Ok(())
}

fn populate(conn: &rusqlite::Connection, count: usize) {
    let now = chrono::Utc::now().to_rfc3339();
    for i in 0..count {
        let id = format!("bench-{i:04}");
        let content = format!(
            "Memory content for benchmark test number {i}. This contains enough text to exercise \
             the FTS5 indexer and produce meaningful search results across different memory types."
        );
        let hash = blake3::hash(content.as_bytes()).to_hex().to_string();
        let m = signet_core::queries::memory::InsertMemory {
            id: &id,
            content: &content,
            normalized_content: &content.to_lowercase(),
            content_hash: &hash,
            memory_type: "observation",
            tags: "benchmark,testing",
            who: Some("user"),
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
        };
        let _ = signet_core::queries::memory::insert(conn, &m);
    }
}

fn bench_fts_search(conn: &rusqlite::Connection, iterations: usize) -> Duration {
    let filter = signet_core::search::RecallFilter {
        agent_id: Some("default"),
        ..Default::default()
    };
    let start = Instant::now();
    for _ in 0..iterations {
        let results = signet_core::search::fts_search(conn, QUERY, 10, &filter);
        black_box(&results);
    }
    start.elapsed()
}

fn bench_hybrid_search(conn: &rusqlite::Connection, iterations: usize) -> Duration {
    let filter = signet_core::search::RecallFilter {
        agent_id: Some("default"),
        ..Default::default()
    };
    let vector = vec![0.0_f32; DIMENSIONS];
    let start = Instant::now();
    for _ in 0..iterations {
        let fts = signet_core::search::fts_search(conn, QUERY, 50, &filter).unwrap_or_default();
        let vec = signet_core::search::vec_search_scored(conn, &vector, 50, &filter);
        let results = signet_core::search::merge_scores(&fts, &vec, 0.65, 0.1);
        black_box(&results);
    }
    start.elapsed()
}

fn bench_memory_list(conn: &rusqlite::Connection, iterations: usize) -> Duration {
    let start = Instant::now();
    for _ in 0..iterations {
        let results = signet_core::queries::memory::list(conn, None, 50, 0);
        black_box(&results);
    }
    start.elapsed()
}

fn bench_memory_insert(conn: &rusqlite::Connection, count: usize) -> Duration {
    let now = chrono::Utc::now().to_rfc3339();
    let start = Instant::now();
    for i in 0..count {
        let id = format!("insert-bench-{i:06}");
        let content = format!("Insert benchmark memory {i} with searchable content.");
        let hash = blake3::hash(content.as_bytes()).to_hex().to_string();
        let m = signet_core::queries::memory::InsertMemory {
            id: &id,
            content: &content,
            normalized_content: &content.to_lowercase(),
            content_hash: &hash,
            memory_type: "fact",
            tags: "insert-bench",
            who: Some("user"),
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
        };
        let _ = signet_core::queries::memory::insert(conn, &m);
    }
    start.elapsed()
}

fn print_rate(label: &str, iterations: usize, elapsed: Duration) -> f64 {
    let total_us = elapsed.as_micros() as u64;
    let per_op = total_us as f64 / iterations as f64;
    println!("--- {label} ---");
    println!("  {iterations} iterations in {total_us}μs");
    println!("  per op: {:.1}μs ({:.2}ms)", per_op, per_op / 1000.0);
    println!("  QPS (est): {:.0}", 1_000_000.0 / per_op);
    println!();
    per_op / 1000.0
}

fn main() {
    println!("=== Signet Core Benchmarks ===\n");

    println!(
        "Platform: {} / {}",
        std::env::consts::OS,
        std::env::consts::ARCH
    );
    println!("Dataset: {}", fixture_path().display());
    println!();

    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .unwrap();
    let (pool, handle, path) = setup_db(&rt, "signet-core-recall-bench");

    println!("Loading bench-dataset fixture...");
    rt.block_on(async {
        pool.write(Priority::Low, move |conn| {
            load_bench_fixture(conn)?;
            Ok(serde_json::Value::Null)
        })
        .await
    })
    .unwrap();
    println!("Done.\n");

    let iterations = 500usize;

    let fts_ms = rt
        .block_on(async {
            pool.read(move |conn| Ok(bench_fts_search(conn, iterations).as_micros()))
                .await
        })
        .unwrap();
    let fts_ms = print_rate(
        "FTS Search (bench-dataset, 10 results)",
        iterations,
        Duration::from_micros(fts_ms as u64),
    );

    let hybrid_ms = rt
        .block_on(async {
            pool.read(move |conn| Ok(bench_hybrid_search(conn, iterations).as_micros()))
                .await
        })
        .unwrap();
    let hybrid_ms = print_rate(
        "Hybrid Search (FTS + sqlite-vec, bench-dataset)",
        iterations,
        Duration::from_micros(hybrid_ms as u64),
    );

    let list_ms = rt
        .block_on(async {
            pool.read(move |conn| Ok(bench_memory_list(conn, iterations).as_micros()))
                .await
        })
        .unwrap();
    let _ = print_rate(
        "Memory List (limit=50)",
        iterations,
        Duration::from_micros(list_ms as u64),
    );

    println!("--- Memory Insert ---");
    let count = 500;
    let elapsed = rt
        .block_on(async {
            pool.write(Priority::Low, move |conn| {
                populate(conn, 0);
                Ok(serde_json::json!(
                    bench_memory_insert(conn, count).as_micros()
                ))
            })
            .await
        })
        .unwrap();
    let total_us = elapsed.as_u64().unwrap_or(0);
    let per_op = total_us as f64 / count as f64;
    println!("  {count} inserts in {total_us}μs");
    println!("  per insert: {:.1}μs ({:.2}ms)", per_op, per_op / 1000.0);
    println!("  inserts/sec: {:.0}", 1_000_000.0 / per_op);
    println!();

    println!("=== SLO-Oriented Core Check ===");
    println!(
        "  FTS recall p50 proxy:    {:.2}ms (target <15ms) {}",
        fts_ms,
        if fts_ms < 15.0 { "PASS" } else { "FAIL" }
    );
    println!(
        "  Hybrid search QPS proxy: {:.0}/s (target >200/s) {}",
        1000.0 / hybrid_ms,
        if (1000.0 / hybrid_ms) > 200.0 {
            "PASS"
        } else {
            "FAIL"
        }
    );
    println!("  Note: authoritative SLOs are measured by signet-daemon/benches/http_recall.rs.\n");

    drop(pool);
    let _ = rt.block_on(handle);
    let _ = std::fs::remove_file(path);
    let _ = std::fs::remove_dir_all(std::env::temp_dir().join("signet-core-recall-bench"));
    println!("Cleanup complete.");
}
