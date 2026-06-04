//! Embedding provider trait and implementations (Ollama, OpenAI-compatible, native ONNX).

use std::path::{Path, PathBuf};
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
// Native ONNX embedding provider
// ---------------------------------------------------------------------------

const HF_MODEL_ID: &str = "nomic-ai/nomic-embed-text-v1.5";
const ONNX_FILENAME: &str = "model.onnx";
const TOKENIZER_FILENAME: &str = "tokenizer.json";
const EXPECTED_DIMS: usize = 768;
const INIT_RETRY_COOLDOWN_SECS: u64 = 300;

pub struct NativeEmbeddingProvider {
    inner: tokio::sync::Mutex<NativeEmbeddingInner>,
    dims: usize,
}

struct NativeEmbeddingInner {
    session: Option<ort::session::Session>,
    tokenizer: Option<tokenizers::Tokenizer>,
    last_init_failure: Option<std::time::Instant>,
    init_error: Option<String>,
}

impl NativeEmbeddingProvider {
    pub fn new(dims: usize) -> Self {
        Self {
            inner: tokio::sync::Mutex::new(NativeEmbeddingInner {
                session: None,
                tokenizer: None,
                last_init_failure: None,
                init_error: None,
            }),
            dims,
        }
    }

    fn model_dir() -> PathBuf {
        let base = std::env::var("SIGNET_PATH")
            .map(PathBuf::from)
            .unwrap_or_else(|_| {
                std::env::var("HOME")
                    .or_else(|_| std::env::var("USERPROFILE"))
                    .map(PathBuf::from)
                    .unwrap_or_else(|_| PathBuf::from("."))
                    .join(".agents")
            });
        base.join(".models")
            .join("nomic-ai")
            .join("nomic-embed-text-v1.5")
    }

    async fn ensure_initialized(inner: &mut NativeEmbeddingInner) -> Result<(), String> {
        if inner.session.is_some() && inner.tokenizer.is_some() {
            return Ok(());
        }
        if let Some(t) = inner.last_init_failure {
            if t.elapsed().as_secs() < INIT_RETRY_COOLDOWN_SECS {
                return Err(inner.init_error.clone().unwrap_or_else(|| "init cooldown".to_string()));
            }
        }
        match Self::load_model_and_tokenizer() {
            Ok((session, tokenizer)) => {
                info!(
                    model = HF_MODEL_ID,
                    dims = EXPECTED_DIMS,
                    "native ONNX embedding model loaded"
                );
                inner.session = Some(session);
                inner.tokenizer = Some(tokenizer);
                inner.last_init_failure = None;
                inner.init_error = None;
                Ok(())
            }
            Err(e) => {
                warn!(error = %e, "native ONNX embedding model load failed");
                inner.last_init_failure = Some(std::time::Instant::now());
                inner.init_error = Some(e.clone());
                Err(e)
            }
        }
    }

    fn load_model_and_tokenizer() -> Result<(ort::session::Session, tokenizers::Tokenizer), String> {
        let model_dir = Self::model_dir();
        let onnx_path = model_dir.join("onnx").join(ONNX_FILENAME);
        let tokenizer_path = model_dir.join(TOKENIZER_FILENAME);

        if !onnx_path.exists() || !tokenizer_path.exists() {
            Self::download_model(&model_dir)?;
        }

        let mut builder = ort::session::Session::builder()
            .map_err(|e| format!("ONNX session builder failed: {e}"))?;
        let session = builder
            .commit_from_file(&onnx_path)
            .map_err(|e| format!("ONNX session load failed: {e}"))?;

        let tokenizer = tokenizers::Tokenizer::from_file(&tokenizer_path)
            .map_err(|e| format!("tokenizer load failed: {e}"))?;

        Ok((session, tokenizer))
    }

    fn download_model(model_dir: &Path) -> Result<(), String> {
        use std::fs;
        use std::io::Write;

        let onnx_dir = model_dir.join("onnx");
        fs::create_dir_all(&onnx_dir)
            .map_err(|e| format!("create model dir: {e}"))?;

        info!(path = %model_dir.display(), "downloading native embedding model from HuggingFace Hub");

        let client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(300))
            .build()
            .map_err(|e| format!("http client: {e}"))?;

        let files = [
            ("onnx/model.onnx", onnx_dir.join("model.onnx")),
            ("tokenizer.json", model_dir.join("tokenizer.json")),
            ("tokenizer_config.json", model_dir.join("tokenizer_config.json")),
            ("config.json", model_dir.join("config.json")),
            ("special_tokens_map.json", model_dir.join("special_tokens_map.json")),
        ];

        for (remote_name, local_path) in &files {
            if local_path.exists() {
                continue;
            }
            let url = format!(
                "https://huggingface.co/{}/resolve/main/{}",
                HF_MODEL_ID, remote_name
            );
            info!(url = %url, "downloading model file");
            let resp = client
                .get(&url)
                .header("User-Agent", "signet-daemon")
                .send()
                .map_err(|e| format!("download {remote_name}: {e}"))?;

            if !resp.status().is_success() {
                return Err(format!("download {remote_name}: HTTP {}", resp.status()));
            }

            let bytes = resp.bytes().map_err(|e| format!("read {remote_name}: {e}"))?;
            let mut f = fs::File::create(local_path)
                .map_err(|e| format!("create {remote_name}: {e}"))?;
            f.write_all(&bytes).map_err(|e| format!("write {remote_name}: {e}"))?;
        }

        info!("native embedding model download complete");
        Ok(())
    }

    fn embed_sync_inner(inner: &mut NativeEmbeddingInner, text: &str) -> Option<Vec<f32>> {
        let session = inner.session.as_mut()?;
        let tokenizer = inner.tokenizer.as_ref()?;
        Self::embed_sync(session, tokenizer, text)
    }

    fn embed_sync(
        session: &mut ort::session::Session,
        tokenizer: &tokenizers::Tokenizer,
        text: &str,
    ) -> Option<Vec<f32>> {
        let encoded = tokenizer.encode(text, true).ok()?;

        let input_ids = encoded.get_ids();
        let attention_mask = encoded.get_attention_mask();
        let n = input_ids.len();

        let input_ids_data: Vec<i64> = input_ids.iter().map(|&id| id as i64).collect();
        let attention_mask_data: Vec<i64> = attention_mask.iter().map(|&m| m as i64).collect();
        let token_type_data: Vec<i64> = vec![0i64; n];

        let shape = vec![1i64, n as i64];

        let input_tensor = ort::value::Tensor::from_array((shape.clone(), input_ids_data)).ok()?;
        let mask_tensor = ort::value::Tensor::from_array((shape.clone(), attention_mask_data)).ok()?;
        let ttid_tensor = ort::value::Tensor::from_array((shape, token_type_data)).ok()?;

        let outputs = session
            .run(ort::inputs! {
                "input_ids" => input_tensor,
                "attention_mask" => mask_tensor,
                "token_type_ids" => ttid_tensor,
            })
            .ok()?;

        let output = &outputs[0];
        let raw: &[f32] = match output.try_extract_tensor::<f32>() {
            Ok((_shape, data)) => data,
            Err(_) => return None,
        };

        let hidden_dim = EXPECTED_DIMS;
        let seq_len = n;

        let mask_f: Vec<f32> = attention_mask.iter().map(|&m| m as f32).collect();

        let mut pooled = vec![0.0f32; hidden_dim];
        let mut mask_sum = 0.0f32;
        for t in 0..seq_len {
            let w = mask_f[t];
            mask_sum += w;
            for d in 0..hidden_dim {
                pooled[d] += raw[t * hidden_dim + d] * w;
            }
        }
        if mask_sum > 0.0 {
            for v in &mut pooled {
                *v /= mask_sum;
            }
        }

        let norm: f32 = pooled.iter().map(|v| v * v).sum::<f32>().sqrt();
        if norm > 0.0 {
            for v in &mut pooled {
                *v /= norm;
            }
        }

        Some(pooled)
    }
}

impl EmbeddingProvider for NativeEmbeddingProvider {
    fn embed(
        &self,
        text: &str,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Option<Vec<f32>>> + Send + '_>> {
        let text = text.to_string();
        Box::pin(async move {
            let start = Instant::now();

            let mut inner = self.inner.lock().await;
            if let Err(e) = Self::ensure_initialized(&mut inner).await {
                warn!(error = %e, "native embedding not available");
                return None;
            }

            if inner.session.is_none() || inner.tokenizer.is_none() {
                return None;
            }

            let result = Self::embed_sync_inner(&mut inner, &text);
            drop(inner);

            match result {
                Some(vec) => {
                    let latency = start.elapsed().as_millis() as u64;
                    info!(latency_ms = latency, dims = vec.len(), "native embedding computed");
                    Some(vec)
                }
                None => {
                    warn!("native embedding inference returned None");
                    None
                }
            }
        })
    }

    fn name(&self) -> &str {
        "native"
    }

    fn dimensions(&self) -> usize {
        self.dims
    }
}

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
            info!(
                provider = "native",
                model = HF_MODEL_ID,
                dims = cfg.dimensions,
                "native ONNX embedding provider initialized (lazy load)"
            );
            Arc::new(NativeEmbeddingProvider::new(cfg.dimensions))
        }
        other => {
            warn!(provider = other, "unknown embedding provider, using noop");
            Arc::new(NoopProvider::new(cfg.dimensions))
        }
    }
}
