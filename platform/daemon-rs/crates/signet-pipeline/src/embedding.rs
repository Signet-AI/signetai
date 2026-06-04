//! Embedding provider trait and implementations (Ollama, OpenAI-compatible).

use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;
use tracing::{info, warn};

use signet_core::config::EmbeddingConfig;

// ---------------------------------------------------------------------------
// Provider trait
// ---------------------------------------------------------------------------

/// Trait for embedding providers.
///
/// Implementations should handle timeouts, retries, and dimension validation
/// internally. Returns `None` on transient failures (not an error).
pub trait EmbeddingProvider: Send + Sync {
    /// Embed a single text string, returning the vector.
    fn embed(
        &self,
        text: &str,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Option<Vec<f32>>> + Send + '_>>;

    /// Provider name for logging.
    fn name(&self) -> &str;

    /// Expected dimensionality.
    fn dimensions(&self) -> usize;
}

// ---------------------------------------------------------------------------
// Health tracking
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct ProviderHealth {
    pub total: u64,
    pub errors: u64,
    pub last_latency_ms: u64,
    pub avg_latency_ms: f64,
}

#[derive(Debug)]
struct HealthTracker {
    total: u64,
    errors: u64,
    total_latency_ms: u64,
    last_latency_ms: u64,
}

impl HealthTracker {
    fn new() -> Self {
        Self {
            total: 0,
            errors: 0,
            total_latency_ms: 0,
            last_latency_ms: 0,
        }
    }

    fn record_success(&mut self, latency_ms: u64) {
        self.total += 1;
        self.last_latency_ms = latency_ms;
        self.total_latency_ms += latency_ms;
    }

    fn record_error(&mut self) {
        self.total += 1;
        self.errors += 1;
    }

    fn snapshot(&self) -> ProviderHealth {
        ProviderHealth {
            total: self.total,
            errors: self.errors,
            last_latency_ms: self.last_latency_ms,
            avg_latency_ms: if self.total > self.errors {
                self.total_latency_ms as f64 / (self.total - self.errors) as f64
            } else {
                0.0
            },
        }
    }
}

// ---------------------------------------------------------------------------
// Ollama provider
// ---------------------------------------------------------------------------

/// Ollama embedding provider via HTTP POST /api/embeddings.
pub struct OllamaProvider {
    client: reqwest::Client,
    base_url: String,
    model: String,
    dims: usize,
    health: Mutex<HealthTracker>,
}

#[derive(Serialize)]
struct OllamaRequest<'a> {
    model: &'a str,
    prompt: &'a str,
}

#[derive(Deserialize)]
struct OllamaResponse {
    embedding: Option<Vec<f64>>,
}

impl OllamaProvider {
    pub fn new(base_url: &str, model: &str, dims: usize) -> Self {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .unwrap_or_default();

        Self {
            client,
            base_url: base_url.trim_end_matches('/').to_string(),
            model: model.to_string(),
            dims,
            health: Mutex::new(HealthTracker::new()),
        }
    }

    pub async fn health(&self) -> ProviderHealth {
        self.health.lock().await.snapshot()
    }
}

impl EmbeddingProvider for OllamaProvider {
    fn embed(
        &self,
        text: &str,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Option<Vec<f32>>> + Send + '_>> {
        let text = text.to_string();
        Box::pin(async move { self.embed_inner(&text).await })
    }

    fn name(&self) -> &str {
        "ollama"
    }

    fn dimensions(&self) -> usize {
        self.dims
    }
}

impl OllamaProvider {
    async fn embed_inner(&self, text: &str) -> Option<Vec<f32>> {
        let start = Instant::now();

        let url = format!("{}/api/embeddings", self.base_url);
        let body = OllamaRequest {
            model: &self.model,
            prompt: text,
        };

        let res = match self.client.post(&url).json(&body).send().await {
            Ok(r) => r,
            Err(e) => {
                warn!(err = %e, provider = "ollama", "embedding request failed");
                self.health.lock().await.record_error();
                return None;
            }
        };

        if !res.status().is_success() {
            warn!(
                status = res.status().as_u16(),
                provider = "ollama",
                model = %self.model,
                "embedding request returned error"
            );
            self.health.lock().await.record_error();
            return None;
        }

        let data: OllamaResponse = match res.json().await {
            Ok(d) => d,
            Err(e) => {
                warn!(err = %e, provider = "ollama", "failed to parse response");
                self.health.lock().await.record_error();
                return None;
            }
        };

        let vec = data.embedding?;
        let latency = start.elapsed().as_millis() as u64;
        self.health.lock().await.record_success(latency);

        // Validate dimensions
        if vec.len() != self.dims {
            warn!(
                expected = self.dims,
                got = vec.len(),
                provider = "ollama",
                "dimension mismatch"
            );
        }

        Some(vec.into_iter().map(|f| f as f32).collect())
    }
}

// ---------------------------------------------------------------------------
// OpenAI-compatible provider
// ---------------------------------------------------------------------------

/// OpenAI-compatible embedding provider (works with OpenAI, Azure, local proxies).
pub struct OpenAIProvider {
    client: reqwest::Client,
    base_url: String,
    model: String,
    api_key: String,
    dims: usize,
    health: Mutex<HealthTracker>,
}

#[derive(Serialize)]
struct OpenAIRequest<'a> {
    model: &'a str,
    input: &'a str,
}

#[derive(Deserialize)]
struct OpenAIResponse {
    data: Option<Vec<OpenAIEmbedding>>,
}

#[derive(Deserialize)]
struct OpenAIEmbedding {
    embedding: Vec<f64>,
}

impl OpenAIProvider {
    pub fn new(base_url: &str, model: &str, api_key: &str, dims: usize) -> Self {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .unwrap_or_default();

        Self {
            client,
            base_url: base_url.trim_end_matches('/').to_string(),
            model: model.to_string(),
            api_key: api_key.to_string(),
            dims,
            health: Mutex::new(HealthTracker::new()),
        }
    }

    pub async fn health(&self) -> ProviderHealth {
        self.health.lock().await.snapshot()
    }
}

impl EmbeddingProvider for OpenAIProvider {
    fn embed(
        &self,
        text: &str,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Option<Vec<f32>>> + Send + '_>> {
        let text = text.to_string();
        Box::pin(async move { self.embed_inner(&text).await })
    }

    fn name(&self) -> &str {
        "openai"
    }

    fn dimensions(&self) -> usize {
        self.dims
    }
}

impl OpenAIProvider {
    async fn embed_inner(&self, text: &str) -> Option<Vec<f32>> {
        let start = Instant::now();

        let url = format!("{}/embeddings", self.base_url);
        let body = OpenAIRequest {
            model: &self.model,
            input: text,
        };

        let mut req = self.client.post(&url).json(&body);
        if !self.api_key.is_empty() {
            req = req.header("Authorization", format!("Bearer {}", self.api_key));
        }

        let res = match req.send().await {
            Ok(r) => r,
            Err(e) => {
                warn!(err = %e, provider = "openai", "embedding request failed");
                self.health.lock().await.record_error();
                return None;
            }
        };

        if !res.status().is_success() {
            warn!(
                status = res.status().as_u16(),
                provider = "openai",
                model = %self.model,
                "embedding request returned error"
            );
            self.health.lock().await.record_error();
            return None;
        }

        let data: OpenAIResponse = match res.json().await {
            Ok(d) => d,
            Err(e) => {
                warn!(err = %e, provider = "openai", "failed to parse response");
                self.health.lock().await.record_error();
                return None;
            }
        };

        let vec = data.data?.into_iter().next()?.embedding;
        let latency = start.elapsed().as_millis() as u64;
        self.health.lock().await.record_success(latency);

        if vec.len() != self.dims {
            warn!(
                expected = self.dims,
                got = vec.len(),
                provider = "openai",
                "dimension mismatch"
            );
        }

        Some(vec.into_iter().map(|f| f as f32).collect())
    }
}

// ---------------------------------------------------------------------------
// No-op provider
// ---------------------------------------------------------------------------

/// No-op provider that always returns None. Used when embedding is disabled.
pub struct NoopProvider {
    dims: usize,
}

impl NoopProvider {
    pub fn new(dims: usize) -> Self {
        Self { dims }
    }
}

impl EmbeddingProvider for NoopProvider {
    fn embed(
        &self,
        _text: &str,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Option<Vec<f32>>> + Send + '_>> {
        Box::pin(async { None })
    }

    fn name(&self) -> &str {
        "none"
    }

    fn dimensions(&self) -> usize {
        self.dims
    }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

const DEFAULT_OLLAMA_URL: &str = "http://localhost:11434";
const DEFAULT_OPENAI_URL: &str = "https://api.openai.com/v1";

/// Create an embedding provider from config.
pub fn from_config(cfg: &EmbeddingConfig, api_key: Option<&str>) -> Arc<dyn EmbeddingProvider> {
    match cfg.provider.as_str() {
        "ollama" => {
            let url = cfg
                .base_url
                .as_deref()
                .filter(|s| !s.is_empty())
                .unwrap_or(DEFAULT_OLLAMA_URL);
            info!(provider = "ollama", model = %cfg.model, url, dims = cfg.dimensions, "embedding provider initialized");
            Arc::new(OllamaProvider::new(url, &cfg.model, cfg.dimensions))
        }
        "openai" => {
            let url = cfg
                .base_url
                .as_deref()
                .filter(|s| !s.is_empty())
                .unwrap_or(DEFAULT_OPENAI_URL);
            let key = api_key.or(cfg.api_key.as_deref()).unwrap_or("");
            info!(provider = "openai", model = %cfg.model, url, dims = cfg.dimensions, "embedding provider initialized");
            Arc::new(OpenAIProvider::new(url, &cfg.model, key, cfg.dimensions))
        }
        "none" => {
            info!("embedding provider disabled");
            Arc::new(NoopProvider::new(cfg.dimensions))
        }
        "native" => {
            let url = cfg
                .base_url
                .as_deref()
                .filter(|s| !s.is_empty())
                .unwrap_or(DEFAULT_OLLAMA_URL);
            info!(
                provider = "native",
                fallback = "ollama",
                model = %cfg.model,
                url,
                dims = cfg.dimensions,
                "native embedding not available in daemon-rs; falling back to ollama"
            );
            Arc::new(OllamaProvider::new(url, &cfg.model, cfg.dimensions))
        }
        other => {
            warn!(provider = other, "unknown embedding provider, using noop");
            Arc::new(NoopProvider::new(cfg.dimensions))
        }
    }
}
