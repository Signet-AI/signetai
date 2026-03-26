use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

/// Caches recent memory recall results to avoid redundant daemon calls.
/// Exact-match on query text with a short TTL.
/// Arc-wrapped internally so it can be shared between TUI (speculative) and agent (actual).
#[derive(Clone)]
pub struct RecallCache {
    inner: Arc<CacheInner>,
}

struct CacheInner {
    entries: Mutex<Vec<CacheEntry>>,
    max_entries: usize,
    ttl: Duration,
}

struct CacheEntry {
    query: String,
    injection: String,
    count: usize,
    created: Instant,
}

impl Default for RecallCache {
    fn default() -> Self {
        Self::new()
    }
}

impl RecallCache {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(CacheInner {
                entries: Mutex::new(Vec::new()),
                max_entries: 32,
                ttl: Duration::from_secs(30),
            }),
        }
    }

    /// Look up a cached recall result. Returns None on cache miss.
    pub async fn get(&self, query: &str) -> Option<(String, usize)> {
        let entries = self.inner.entries.lock().await;
        let now = Instant::now();

        entries
            .iter()
            .find(|e| e.query == query && now.duration_since(e.created) < self.inner.ttl)
            .map(|e| (e.injection.clone(), e.count))
    }

    /// Store a recall result in the cache.
    pub async fn put(&self, query: String, injection: String, count: usize) {
        let mut entries = self.inner.entries.lock().await;
        let now = Instant::now();

        // Remove expired entries
        entries.retain(|e| now.duration_since(e.created) < self.inner.ttl);

        // Remove duplicate if exists
        entries.retain(|e| e.query != query);

        // Evict oldest if at capacity
        if entries.len() >= self.inner.max_entries {
            entries.remove(0);
        }

        entries.push(CacheEntry {
            query,
            injection,
            count,
            created: now,
        });
    }

    /// Clear the entire cache (e.g., on session end when new memories may be stored).
    pub async fn clear(&self) {
        self.inner.entries.lock().await.clear();
    }
}
