//! Recall and search benchmarks.
//!
//! Measures: FTS search latency, hybrid search latency, memory insert throughput.
//! Run: cargo bench -p signet-core -- recall

use std::hint::black_box;
use std::time::{Duration, Instant};

fn setup_db() -> (signet_core::db::DbPool, tokio::task::JoinHandle<()>) {
    let dir = std::env::temp_dir().join("signet-bench");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("bench.db");
    signet_core::db::DbPool::open(&path).expect("failed to open bench DB")
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
    let filter = signet_core::search::RecallFilter::default();
    let start = Instant::now();
    for _ in 0..iterations {
        let results = signet_core::search::fts_search(conn, "benchmark test exercise", 10, &filter);
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

fn main() {
    println!("=== Signet Core Benchmarks ===\n");

    // Hardware info
    println!(
        "Platform: {} / {}",
        std::env::consts::OS,
        std::env::consts::ARCH
    );
    println!();

    // Setup
    let (pool, handle) = setup_db();
    let rt = tokio::runtime::Runtime::new().unwrap();

    // Populate benchmark data
    println!("Populating 1000 memories...");
    rt.block_on(async {
        pool.write(signet_core::db::Priority::Low, move |conn| {
            populate(conn, 1000);
            Ok(serde_json::Value::Null)
        })
        .await
    })
    .unwrap();
    println!("Done.\n");

    // Benchmark: FTS search
    println!("--- FTS Search (1000 memories, 10 results) ---");
    let iterations = 500usize;
    let elapsed = rt
        .block_on(async {
            pool.read(move |conn| {
                Ok(serde_json::json!(
                    bench_fts_search(conn, iterations).as_micros()
                ))
            })
            .await
        })
        .unwrap();
    let total_us = elapsed.as_u64().unwrap_or(0);
    let per_op = total_us as f64 / iterations as f64;
    println!("  {iterations} iterations in {total_us}μs");
    println!("  p50 (est): {:.1}μs ({:.2}ms)", per_op, per_op / 1000.0);
    println!("  QPS (est): {:.0}", 1_000_000.0 / per_op);
    println!();

    // Benchmark: memory list
    println!("--- Memory List (limit=50) ---");
    let elapsed = rt
        .block_on(async {
            pool.read(move |conn| {
                Ok(serde_json::json!(
                    bench_memory_list(conn, iterations).as_micros()
                ))
            })
            .await
        })
        .unwrap();
    let total_us = elapsed.as_u64().unwrap_or(0);
    let per_op = total_us as f64 / iterations as f64;
    println!("  {iterations} iterations in {total_us}μs");
    println!("  per op: {:.1}μs ({:.2}ms)", per_op, per_op / 1000.0);
    println!();

    // Benchmark: memory insert
    println!("--- Memory Insert ---");
    let count = 500;
    let elapsed = rt
        .block_on(async {
            pool.write(signet_core::db::Priority::Low, move |conn| {
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

    // SLO check
    println!("=== SLO Check ===");
    let search_per_ms = (rt
        .block_on(async {
            pool.read(move |conn| Ok(serde_json::json!(bench_fts_search(conn, 100).as_millis())))
                .await
        })
        .unwrap()
        .as_u64()
        .unwrap_or(1) as f64)
        / 100.0;

    let pass_latency = search_per_ms < 15.0;
    let pass_qps = (1000.0 / search_per_ms) > 200.0;
    println!(
        "  Recall p50:  {:.1}ms (target <15ms) {}",
        search_per_ms,
        if pass_latency { "PASS" } else { "FAIL" }
    );
    println!(
        "  Search QPS:  {:.0}/s (target >200/s) {}",
        1000.0 / search_per_ms,
        if pass_qps { "PASS" } else { "FAIL" }
    );
    println!();

    // Cleanup
    drop(pool);
    let _ = rt.block_on(handle);
    let _ = std::fs::remove_dir_all(std::env::temp_dir().join("signet-bench"));
    println!("Cleanup complete.");
}
