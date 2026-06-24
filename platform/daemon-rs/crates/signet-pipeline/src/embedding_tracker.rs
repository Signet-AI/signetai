//! Incremental embedding refresh retry tracker.
//!
//! This module mirrors the deterministic retry/suppression logic from
//! `platform/daemon/src/embedding-tracker.ts`. It intentionally does not own
//! provider I/O or database writes; callers pass stale rows and a fetch closure
//! for one polling cycle.

use std::collections::HashMap;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StaleEmbeddingRow {
    pub id: String,
    pub content: String,
    pub content_hash: String,
    pub current_model: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EmbeddingFailureState {
    pub count: u32,
    pub retry_at: u64,
}

pub type EmbeddingFailureMap = HashMap<String, EmbeddingFailureState>;

#[derive(Debug, Clone, PartialEq)]
pub struct EmbeddingCycleSuccess {
    pub row: StaleEmbeddingRow,
    pub vector: Vec<f32>,
    pub content_hash: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct EmbeddingCycleResult {
    pub queue_depth: usize,
    pub failed: usize,
    pub results: Vec<EmbeddingCycleSuccess>,
}

pub fn compute_embedding_retry_backoff_ms(count: u32, poll_ms: u64) -> u64 {
    if count <= 1 {
        return (poll_ms * 5).max(60_000);
    }
    if count == 2 {
        return (poll_ms * 25).max(5 * 60_000);
    }
    if count == 3 {
        return (poll_ms * 150).max(30 * 60_000);
    }
    (poll_ms * 300).max(60 * 60_000)
}

fn failure_key(row: &StaleEmbeddingRow, model: &str) -> String {
    format!("{}:{}:{}", row.id, row.content_hash, model)
}

fn clear_row_failures(failures: &mut EmbeddingFailureMap, row: &StaleEmbeddingRow, model: &str) {
    let prefix = format!("{}:", row.id);
    let suffix = format!(":{model}");
    failures.retain(|key, _| !(key.starts_with(&prefix) && key.ends_with(&suffix)));
}

pub fn process_embedding_cycle<F>(
    rows: &[StaleEmbeddingRow],
    failures: &mut EmbeddingFailureMap,
    model: &str,
    poll_ms: u64,
    mut fetch_embedding: F,
    now_ms: u64,
) -> EmbeddingCycleResult
where
    F: FnMut(&str) -> Option<Vec<f32>>,
{
    let ready_rows = rows
        .iter()
        .filter(|row| {
            failures
                .get(&failure_key(row, model))
                .is_none_or(|state| state.retry_at <= now_ms)
        })
        .cloned()
        .collect::<Vec<_>>();

    let mut results = Vec::new();
    let mut failed = 0;

    for row in &ready_rows {
        let key = failure_key(row, model);
        if let Some(vector) = fetch_embedding(&row.content) {
            clear_row_failures(failures, row, model);
            results.push(EmbeddingCycleSuccess {
                row: row.clone(),
                vector,
                content_hash: row.content_hash.clone(),
            });
            continue;
        }

        failed += 1;
        let next = failures.get(&key).map_or(1, |state| state.count + 1);
        let wait = compute_embedding_retry_backoff_ms(next, poll_ms);
        failures.insert(
            key,
            EmbeddingFailureState {
                count: next,
                retry_at: now_ms + wait,
            },
        );
    }

    EmbeddingCycleResult {
        queue_depth: ready_rows.len(),
        failed,
        results,
    }
}
