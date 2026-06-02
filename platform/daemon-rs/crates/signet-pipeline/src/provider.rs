//! LLM provider trait and implementations (Ollama HTTP, Anthropic HTTP,
//! OpenAI-compatible HTTP, CLI subprocess, OpenCode HTTP).

use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex, Semaphore};
use tracing::{info, warn};

// ---------------------------------------------------------------------------
// Provider trait
// ---------------------------------------------------------------------------

/// Usage statistics from an LLM generation call.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmUsage {
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub cache_read_tokens: Option<u64>,
    pub cache_creation_tokens: Option<u64>,
    pub total_duration_ms: Option<u64>,
}

/// Result of an LLM generation with optional usage stats.
#[derive(Debug, Clone)]
pub struct GenerateResult {
    pub text: String,
    pub usage: Option<LlmUsage>,
}

/// Options for an LLM generation call.
#[derive(Debug, Clone, Default)]
pub struct GenerateOpts {
    pub timeout_ms: Option<u64>,
    pub max_tokens: Option<u32>,
}

/// Errors from LLM providers.
#[derive(Debug, thiserror::Error)]
pub enum ProviderError {
    #[error("request timeout after {0}ms")]
    Timeout(u64),
    #[error("HTTP error {status}: {body}")]
    Http { status: u16, body: String },
    #[error("provider unavailable: {0}")]
    Unavailable(String),
    #[error("parse error: {0}")]
    Parse(String),
    #[error("{0}")]
    Other(String),
}

/// Trait for LLM text generation providers.
pub trait LlmProvider: Send + Sync {
    /// Generate text from a prompt.
    fn generate(
        &self,
        prompt: &str,
        opts: &GenerateOpts,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<GenerateResult, ProviderError>> + Send + '_>,
    >;

    /// Provider name for logging.
    fn name(&self) -> &str;
}

// ---------------------------------------------------------------------------
// Concurrency control
// ---------------------------------------------------------------------------

/// Global semaphore to limit concurrent LLM calls across all workers.
pub struct LlmSemaphore {
    semaphore: Semaphore,
}

impl LlmSemaphore {
    pub fn new(max: usize) -> Self {
        Self {
            semaphore: Semaphore::new(max),
        }
    }

    /// Acquire a permit, execute the future, then release.
    pub async fn run<F, T>(&self, f: F) -> T
    where
        F: std::future::Future<Output = T>,
    {
        let _permit = self.semaphore.acquire().await.expect("semaphore closed");
        f.await
    }
}

impl Default for LlmSemaphore {
    fn default() -> Self {
        let max = std::env::var("SIGNET_MAX_LLM_CONCURRENCY")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(4);
        Self::new(max)
    }
}

// ---------------------------------------------------------------------------
// Ollama provider
// ---------------------------------------------------------------------------

/// Ollama LLM provider via HTTP POST /api/generate.
pub struct OllamaLlmProvider {
    client: reqwest::Client,
    base_url: String,
    model: String,
    default_timeout_ms: u64,
    max_context_tokens: Option<u32>,
    health: Mutex<HealthTracker>,
}

#[derive(Serialize)]
struct OllamaGenRequest<'a> {
    model: &'a str,
    prompt: &'a str,
    stream: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    options: Option<OllamaGenOptions>,
}

#[derive(Serialize)]
struct OllamaGenOptions {
    #[serde(skip_serializing_if = "Option::is_none")]
    num_predict: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    num_ctx: Option<u32>,
}

#[derive(Deserialize)]
struct OllamaGenResponse {
    response: Option<String>,
    eval_count: Option<u64>,
    prompt_eval_count: Option<u64>,
    total_duration: Option<u64>,
}

impl OllamaLlmProvider {
    pub fn new(base_url: &str, model: &str, timeout_ms: u64) -> Self {
        Self::with_context(base_url, model, timeout_ms, None)
    }

    pub fn with_context(
        base_url: &str,
        model: &str,
        timeout_ms: u64,
        max_context_tokens: Option<u32>,
    ) -> Self {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_millis(timeout_ms.max(5000)))
            .build()
            .unwrap_or_default();

        Self {
            client,
            base_url: base_url.trim_end_matches('/').to_string(),
            model: model.to_string(),
            default_timeout_ms: timeout_ms,
            max_context_tokens,
            health: Mutex::new(HealthTracker::new()),
        }
    }

    pub async fn health(&self) -> ProviderHealth {
        self.health.lock().await.snapshot()
    }

    async fn generate_inner(
        &self,
        prompt: &str,
        opts: &GenerateOpts,
    ) -> Result<GenerateResult, ProviderError> {
        let start = Instant::now();
        let timeout = Duration::from_millis(opts.timeout_ms.unwrap_or(self.default_timeout_ms));

        let options = if opts.max_tokens.is_some() || self.max_context_tokens.is_some() {
            Some(OllamaGenOptions {
                num_predict: opts.max_tokens,
                num_ctx: self.max_context_tokens,
            })
        } else {
            None
        };

        let body = OllamaGenRequest {
            model: &self.model,
            prompt,
            stream: false,
            options,
        };

        let url = format!("{}/api/generate", self.base_url);

        let res = self
            .client
            .post(&url)
            .json(&body)
            .timeout(timeout)
            .send()
            .await
            .map_err(|e| {
                self.record_error_sync();
                if e.is_timeout() {
                    ProviderError::Timeout(timeout.as_millis() as u64)
                } else {
                    ProviderError::Other(e.to_string())
                }
            })?;

        if !res.status().is_success() {
            let status = res.status().as_u16();
            let body = res.text().await.unwrap_or_default();
            self.record_error_sync();
            return Err(ProviderError::Http { status, body });
        }

        let data: OllamaGenResponse = res.json().await.map_err(|e| {
            self.record_error_sync();
            ProviderError::Parse(e.to_string())
        })?;

        let text = data.response.unwrap_or_default();
        let latency = start.elapsed().as_millis() as u64;

        {
            let mut h = self.health.lock().await;
            h.record_success(latency);
        }

        Ok(GenerateResult {
            text,
            usage: Some(LlmUsage {
                input_tokens: data.prompt_eval_count,
                output_tokens: data.eval_count,
                total_duration_ms: data.total_duration.map(|ns| ns / 1_000_000),
                ..Default::default()
            }),
        })
    }

    fn record_error_sync(&self) {
        // Best-effort non-async error recording
        if let Ok(mut h) = self.health.try_lock() {
            h.record_error();
        }
    }
}

impl LlmProvider for OllamaLlmProvider {
    fn generate(
        &self,
        prompt: &str,
        opts: &GenerateOpts,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<GenerateResult, ProviderError>> + Send + '_>,
    > {
        let prompt = prompt.to_string();
        let opts = opts.clone();
        Box::pin(async move { self.generate_inner(&prompt, &opts).await })
    }

    fn name(&self) -> &str {
        "ollama"
    }
}

// ---------------------------------------------------------------------------
// Anthropic provider
// ---------------------------------------------------------------------------

/// Anthropic LLM provider via HTTP POST /v1/messages.
pub struct AnthropicProvider {
    client: reqwest::Client,
    api_key: String,
    model: String,
    default_timeout_ms: u64,
    max_retries: u32,
    health: Mutex<HealthTracker>,
}

#[derive(Serialize)]
struct AnthropicRequest<'a> {
    model: &'a str,
    max_tokens: u32,
    messages: Vec<AnthropicMessage<'a>>,
}

#[derive(Serialize)]
struct AnthropicMessage<'a> {
    role: &'a str,
    content: &'a str,
}

#[derive(Deserialize)]
struct AnthropicResponse {
    content: Option<Vec<AnthropicContent>>,
    usage: Option<AnthropicUsage>,
}

#[derive(Deserialize)]
struct AnthropicContent {
    text: Option<String>,
}

#[derive(Deserialize)]
struct AnthropicUsage {
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    cache_creation_input_tokens: Option<u64>,
    cache_read_input_tokens: Option<u64>,
}

/// Resolve model aliases to full IDs.
fn resolve_model(model: &str) -> &str {
    match model {
        "haiku" => "claude-haiku-4-5-20251001",
        "sonnet" => "claude-sonnet-4-6-20260314",
        "opus" => "claude-opus-4-6-20260314",
        _ => model,
    }
}

impl AnthropicProvider {
    pub fn new(api_key: &str, model: &str, timeout_ms: u64) -> Self {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_millis(timeout_ms.max(5000)))
            .build()
            .unwrap_or_default();

        Self {
            client,
            api_key: api_key.to_string(),
            model: resolve_model(model).to_string(),
            default_timeout_ms: timeout_ms,
            max_retries: 2,
            health: Mutex::new(HealthTracker::new()),
        }
    }

    pub async fn health(&self) -> ProviderHealth {
        self.health.lock().await.snapshot()
    }

    async fn generate_inner(
        &self,
        prompt: &str,
        opts: &GenerateOpts,
    ) -> Result<GenerateResult, ProviderError> {
        let start = Instant::now();
        let deadline =
            start + Duration::from_millis(opts.timeout_ms.unwrap_or(self.default_timeout_ms));
        let max_tokens = opts.max_tokens.unwrap_or(4096);

        let body = AnthropicRequest {
            model: &self.model,
            max_tokens,
            messages: vec![AnthropicMessage {
                role: "user",
                content: prompt,
            }],
        };

        let mut last_err = ProviderError::Other("no attempts".into());

        for attempt in 0..=self.max_retries {
            if Instant::now() > deadline {
                return Err(ProviderError::Timeout(
                    opts.timeout_ms.unwrap_or(self.default_timeout_ms),
                ));
            }

            // Backoff between retries
            if attempt > 0 {
                let delay = Duration::from_millis(500 * 2u64.pow(attempt - 1));
                let remaining = deadline.saturating_duration_since(Instant::now());
                tokio::time::sleep(delay.min(remaining)).await;
            }

            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(ProviderError::Timeout(
                    opts.timeout_ms.unwrap_or(self.default_timeout_ms),
                ));
            }

            let res = self
                .client
                .post("https://api.anthropic.com/v1/messages")
                .header("x-api-key", &self.api_key)
                .header("anthropic-version", "2023-06-01")
                .header("content-type", "application/json")
                .json(&body)
                .timeout(remaining)
                .send()
                .await;

            match res {
                Ok(r) => {
                    let status = r.status().as_u16();
                    if r.status().is_success() {
                        let data: AnthropicResponse = r.json().await.map_err(|e| {
                            self.record_error_sync();
                            ProviderError::Parse(e.to_string())
                        })?;

                        let text = data
                            .content
                            .and_then(|c| c.into_iter().next())
                            .and_then(|c| c.text)
                            .unwrap_or_default();

                        let latency = start.elapsed().as_millis() as u64;
                        {
                            let mut h = self.health.lock().await;
                            h.record_success(latency);
                        }

                        return Ok(GenerateResult {
                            text,
                            usage: data.usage.map(|u| LlmUsage {
                                input_tokens: u.input_tokens,
                                output_tokens: u.output_tokens,
                                cache_read_tokens: u.cache_read_input_tokens,
                                cache_creation_tokens: u.cache_creation_input_tokens,
                                total_duration_ms: Some(latency),
                            }),
                        });
                    }

                    // Non-retryable errors
                    if status == 401 || ((400..500).contains(&status) && status != 429) {
                        let body_text = r.text().await.unwrap_or_default();
                        self.record_error_sync();
                        return Err(ProviderError::Http {
                            status,
                            body: body_text,
                        });
                    }

                    // Retryable (429, 5xx)
                    let body_text = r.text().await.unwrap_or_default();
                    last_err = ProviderError::Http {
                        status,
                        body: body_text,
                    };
                    warn!(status, attempt, "anthropic retryable error");
                }
                Err(e) => {
                    if e.is_timeout() {
                        return Err(ProviderError::Timeout(
                            opts.timeout_ms.unwrap_or(self.default_timeout_ms),
                        ));
                    }
                    last_err = ProviderError::Other(e.to_string());
                    warn!(%e, attempt, "anthropic request failed");
                }
            }
        }

        self.record_error_sync();
        Err(last_err)
    }

    fn record_error_sync(&self) {
        if let Ok(mut h) = self.health.try_lock() {
            h.record_error();
        }
    }
}

impl LlmProvider for AnthropicProvider {
    fn generate(
        &self,
        prompt: &str,
        opts: &GenerateOpts,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<GenerateResult, ProviderError>> + Send + '_>,
    > {
        let prompt = prompt.to_string();
        let opts = opts.clone();
        Box::pin(async move { self.generate_inner(&prompt, &opts).await })
    }

    fn name(&self) -> &str {
        "anthropic"
    }
}

// ---------------------------------------------------------------------------
// OpenAI-compatible provider (covers llama-cpp, openrouter, generic)
// ---------------------------------------------------------------------------

/// OpenAI-compatible LLM provider via HTTP POST /v1/chat/completions.
///
/// Used by: `openai-compatible`, `llama-cpp`, `openrouter`.
pub struct OpenAiCompatProvider {
    client: reqwest::Client,
    base_url: String,
    api_key: Option<String>,
    model: String,
    provider_name: &'static str,
    default_timeout_ms: u64,
    extra_headers: Vec<(String, String)>,
    health: Mutex<HealthTracker>,
}

#[derive(Serialize)]
struct ChatCompletionRequest<'a> {
    model: &'a str,
    messages: Vec<ChatMessage<'a>>,
    max_tokens: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    temperature: Option<f32>,
}

#[derive(Serialize)]
struct ChatMessage<'a> {
    role: &'a str,
    content: &'a str,
}

#[derive(Deserialize)]
struct ChatCompletionResponse {
    choices: Option<Vec<ChatChoice>>,
    usage: Option<ChatUsage>,
}

#[derive(Deserialize)]
struct ChatChoice {
    message: Option<ChatChoiceMessage>,
}

#[derive(Deserialize)]
struct ChatChoiceMessage {
    content: Option<String>,
}

#[derive(Deserialize)]
struct ChatUsage {
    prompt_tokens: Option<u64>,
    completion_tokens: Option<u64>,
}

impl OpenAiCompatProvider {
    pub fn new(
        base_url: &str,
        model: &str,
        api_key: Option<&str>,
        timeout_ms: u64,
        provider_name: &'static str,
    ) -> Self {
        Self::with_extra_headers(base_url, model, api_key, timeout_ms, provider_name, vec![])
    }

    pub fn with_extra_headers(
        base_url: &str,
        model: &str,
        api_key: Option<&str>,
        timeout_ms: u64,
        provider_name: &'static str,
        extra_headers: Vec<(String, String)>,
    ) -> Self {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_millis(timeout_ms.max(5000)))
            .build()
            .unwrap_or_default();

        Self {
            client,
            base_url: base_url.trim_end_matches('/').to_string(),
            api_key: api_key.map(|s| s.to_string()),
            model: model.to_string(),
            provider_name,
            default_timeout_ms: timeout_ms,
            extra_headers,
            health: Mutex::new(HealthTracker::new()),
        }
    }

    pub async fn health(&self) -> ProviderHealth {
        self.health.lock().await.snapshot()
    }

    async fn generate_inner(
        &self,
        prompt: &str,
        opts: &GenerateOpts,
    ) -> Result<GenerateResult, ProviderError> {
        let start = Instant::now();
        let timeout = Duration::from_millis(opts.timeout_ms.unwrap_or(self.default_timeout_ms));
        let max_tokens = opts.max_tokens.unwrap_or(4096);

        let body = ChatCompletionRequest {
            model: &self.model,
            messages: vec![ChatMessage {
                role: "user",
                content: prompt,
            }],
            max_tokens,
            temperature: None,
        };

        let url = format!("{}/v1/chat/completions", self.base_url);

        let mut req = self
            .client
            .post(&url)
            .header("content-type", "application/json")
            .timeout(timeout);

        if let Some(ref key) = self.api_key {
            req = req.header("authorization", format!("Bearer {key}"));
        }

        for (k, v) in &self.extra_headers {
            req = req.header(k.as_str(), v.as_str());
        }

        let res = req.json(&body).send().await.map_err(|e| {
            if let Ok(mut h) = self.health.try_lock() {
                h.record_error();
            }
            if e.is_timeout() {
                ProviderError::Timeout(timeout.as_millis() as u64)
            } else {
                ProviderError::Other(e.to_string())
            }
        })?;

        if !res.status().is_success() {
            let status = res.status().as_u16();
            let body = res.text().await.unwrap_or_default();
            if let Ok(mut h) = self.health.try_lock() {
                h.record_error();
            }
            return Err(ProviderError::Http { status, body });
        }

        let data: ChatCompletionResponse = res.json().await.map_err(|e| {
            if let Ok(mut h) = self.health.try_lock() {
                h.record_error();
            }
            ProviderError::Parse(e.to_string())
        })?;

        let text = data
            .choices
            .and_then(|c| c.into_iter().next())
            .and_then(|c| c.message)
            .and_then(|m| m.content)
            .unwrap_or_default();

        let latency = start.elapsed().as_millis() as u64;
        {
            let mut h = self.health.lock().await;
            h.record_success(latency);
        }

        Ok(GenerateResult {
            text,
            usage: data.usage.map(|u| LlmUsage {
                input_tokens: u.prompt_tokens,
                output_tokens: u.completion_tokens,
                total_duration_ms: Some(latency),
                ..Default::default()
            }),
        })
    }
}

impl LlmProvider for OpenAiCompatProvider {
    fn generate(
        &self,
        prompt: &str,
        opts: &GenerateOpts,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<GenerateResult, ProviderError>> + Send + '_>,
    > {
        let prompt = prompt.to_string();
        let opts = opts.clone();
        Box::pin(async move { self.generate_inner(&prompt, &opts).await })
    }

    fn name(&self) -> &str {
        self.provider_name
    }
}

// ---------------------------------------------------------------------------
// CLI subprocess provider (covers claude-code, codex, acpx, command)
// ---------------------------------------------------------------------------

/// LLM provider that spawns a CLI subprocess, pipes the prompt to stdin,
/// and reads the response from stdout.
pub struct CliProvider {
    binary: String,
    args: Vec<String>,
    provider_name: &'static str,
    default_timeout_ms: u64,
    health: Mutex<HealthTracker>,
}

impl CliProvider {
    pub fn new(binary: &str, args: &[&str], timeout_ms: u64, provider_name: &'static str) -> Self {
        Self {
            binary: binary.to_string(),
            args: args.iter().map(|s| s.to_string()).collect(),
            provider_name,
            default_timeout_ms: timeout_ms,
            health: Mutex::new(HealthTracker::new()),
        }
    }

    pub async fn health(&self) -> ProviderHealth {
        self.health.lock().await.snapshot()
    }

    async fn generate_inner(
        &self,
        prompt: &str,
        opts: &GenerateOpts,
    ) -> Result<GenerateResult, ProviderError> {
        let start = Instant::now();
        let timeout = Duration::from_millis(opts.timeout_ms.unwrap_or(self.default_timeout_ms));

        let mut cmd = tokio::process::Command::new(&self.binary);
        cmd.args(&self.args)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());

        let mut child = cmd.spawn().map_err(|e| {
            if let Ok(mut h) = self.health.try_lock() {
                h.record_error();
            }
            ProviderError::Unavailable(format!("failed to spawn {}: {}", self.binary, e))
        })?;

        // Write prompt to stdin
        use tokio::io::AsyncWriteExt;
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(prompt.as_bytes()).await;
            drop(stdin); // close stdin to signal EOF
        }

        // Wait with timeout
        match tokio::time::timeout(timeout, child.wait_with_output()).await {
            Ok(Ok(output)) => {
                let text = String::from_utf8_lossy(&output.stdout).to_string();

                if !output.status.success() {
                    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
                    if let Ok(mut h) = self.health.try_lock() {
                        h.record_error();
                    }
                    return Err(ProviderError::Other(format!(
                        "{} exited with {}: {}",
                        self.binary,
                        output.status.code().unwrap_or(-1),
                        stderr.trim()
                    )));
                }

                let latency = start.elapsed().as_millis() as u64;
                {
                    let mut h = self.health.lock().await;
                    h.record_success(latency);
                }

                Ok(GenerateResult {
                    text,
                    usage: Some(LlmUsage {
                        total_duration_ms: Some(latency),
                        ..Default::default()
                    }),
                })
            }
            Ok(Err(e)) => {
                if let Ok(mut h) = self.health.try_lock() {
                    h.record_error();
                }
                Err(ProviderError::Other(format!(
                    "failed to wait for {}: {}",
                    self.binary, e
                )))
            }
            Err(_) => {
                // Timeout -- child was moved into the timeout future,
                // so we can't kill it here. It will be killed when dropped.
                if let Ok(mut h) = self.health.try_lock() {
                    h.record_error();
                }
                Err(ProviderError::Timeout(timeout.as_millis() as u64))
            }
        }
    }
}

impl LlmProvider for CliProvider {
    fn generate(
        &self,
        prompt: &str,
        opts: &GenerateOpts,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<GenerateResult, ProviderError>> + Send + '_>,
    > {
        let prompt = prompt.to_string();
        let opts = opts.clone();
        Box::pin(async move { self.generate_inner(&prompt, &opts).await })
    }

    fn name(&self) -> &str {
        self.provider_name
    }
}

// ---------------------------------------------------------------------------
// OpenCode provider
// ---------------------------------------------------------------------------

/// OpenCode LLM provider via HTTP session API.
pub struct OpenCodeProvider {
    client: reqwest::Client,
    base_url: String,
    model: String,
    default_timeout_ms: u64,
    health: Mutex<HealthTracker>,
}

#[derive(Serialize)]
struct OpenCodeMessageRequest<'a> {
    message: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    model: Option<&'a str>,
}

#[derive(Deserialize)]
struct OpenCodeSessionResponse {
    session_id: Option<String>,
}

#[derive(Deserialize)]
struct OpenCodeMessageResponse {
    response: Option<String>,
}

impl OpenCodeProvider {
    pub fn new(base_url: &str, model: &str, timeout_ms: u64) -> Self {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_millis(timeout_ms.max(5000)))
            .build()
            .unwrap_or_default();

        Self {
            client,
            base_url: base_url.trim_end_matches('/').to_string(),
            model: model.to_string(),
            default_timeout_ms: timeout_ms,
            health: Mutex::new(HealthTracker::new()),
        }
    }

    pub async fn health(&self) -> ProviderHealth {
        self.health.lock().await.snapshot()
    }

    async fn generate_inner(
        &self,
        prompt: &str,
        opts: &GenerateOpts,
    ) -> Result<GenerateResult, ProviderError> {
        let start = Instant::now();
        let timeout = Duration::from_millis(opts.timeout_ms.unwrap_or(self.default_timeout_ms));

        // Create a session
        let session_url = format!("{}/session", self.base_url);
        let session_res = self
            .client
            .post(&session_url)
            .timeout(timeout)
            .send()
            .await
            .map_err(|e| ProviderError::Other(format!("opencode session create: {e}")))?;

        if !session_res.status().is_success() {
            let status = session_res.status().as_u16();
            let body = session_res.text().await.unwrap_or_default();
            return Err(ProviderError::Http { status, body });
        }

        let session_data: OpenCodeSessionResponse = session_res
            .json()
            .await
            .map_err(|e| ProviderError::Parse(format!("opencode session parse: {e}")))?;

        let session_id = session_data
            .session_id
            .ok_or_else(|| ProviderError::Parse("opencode: no session_id".into()))?;

        // Send message to session
        let msg_url = format!("{}/session/{session_id}/message", self.base_url);
        let remaining = timeout.saturating_sub(start.elapsed());

        let msg_body = OpenCodeMessageRequest {
            message: prompt,
            model: Some(&self.model),
        };

        let msg_res = self
            .client
            .post(&msg_url)
            .header("content-type", "application/json")
            .timeout(remaining)
            .json(&msg_body)
            .send()
            .await
            .map_err(|e| {
                if e.is_timeout() {
                    ProviderError::Timeout(timeout.as_millis() as u64)
                } else {
                    ProviderError::Other(format!("opencode message send: {e}"))
                }
            })?;

        if !msg_res.status().is_success() {
            let status = msg_res.status().as_u16();
            let body = msg_res.text().await.unwrap_or_default();
            if let Ok(mut h) = self.health.try_lock() {
                h.record_error();
            }
            return Err(ProviderError::Http { status, body });
        }

        let msg_data: OpenCodeMessageResponse = msg_res.json().await.map_err(|e| {
            if let Ok(mut h) = self.health.try_lock() {
                h.record_error();
            }
            ProviderError::Parse(format!("opencode response parse: {e}"))
        })?;

        let text = msg_data.response.unwrap_or_default();
        let latency = start.elapsed().as_millis() as u64;
        {
            let mut h = self.health.lock().await;
            h.record_success(latency);
        }

        Ok(GenerateResult {
            text,
            usage: Some(LlmUsage {
                total_duration_ms: Some(latency),
                ..Default::default()
            }),
        })
    }
}

impl LlmProvider for OpenCodeProvider {
    fn generate(
        &self,
        prompt: &str,
        opts: &GenerateOpts,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<GenerateResult, ProviderError>> + Send + '_>,
    > {
        let prompt = prompt.to_string();
        let opts = opts.clone();
        Box::pin(async move { self.generate_inner(&prompt, &opts).await })
    }

    fn name(&self) -> &str {
        "opencode"
    }
}

// ---------------------------------------------------------------------------
// Health tracking (shared with embedding providers)
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
// Factory
// ---------------------------------------------------------------------------

const DEFAULT_OLLAMA_URL: &str = "http://localhost:11434";
const DEFAULT_TIMEOUT_MS: u64 = 90_000;
pub const DEFAULT_OLLAMA_MAX_CONTEXT_TOKENS: u32 = 8192;

/// Resolve the Ollama context window size from env or default.
///
/// Reads `SIGNET_OLLAMA_FALLBACK_MAX_CTX` (kept for backwards compatibility).
/// Despite the `FALLBACK` label, this value applies to **all** Ollama summary
/// paths — both the degraded-fallback case and an explicitly-configured
/// `synthesis.provider = ollama` deployment.
pub fn resolve_ollama_max_context_tokens() -> u32 {
    std::env::var("SIGNET_OLLAMA_FALLBACK_MAX_CTX")
        .ok()
        .and_then(|s| s.trim().parse::<u32>().ok())
        .filter(|&n| n > 0)
        .unwrap_or(DEFAULT_OLLAMA_MAX_CONTEXT_TOKENS)
}

/// LLM provider configuration.
#[derive(Debug, Clone)]
pub struct LlmProviderConfig {
    pub provider: String,
    pub model: String,
    pub base_url: Option<String>,
    pub api_key: Option<String>,
    pub timeout_ms: Option<u64>,
    pub max_context_tokens: Option<u32>,
}

/// Create an LLM provider from config.
pub fn from_config(cfg: &LlmProviderConfig) -> Arc<dyn LlmProvider> {
    let timeout = cfg.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS);

    match cfg.provider.as_str() {
        "ollama" => {
            let url = cfg
                .base_url
                .as_deref()
                .filter(|s| !s.is_empty())
                .unwrap_or(DEFAULT_OLLAMA_URL);
            info!(provider = "ollama", model = %cfg.model, url, timeout_ms = timeout, "LLM provider initialized");
            Arc::new(OllamaLlmProvider::with_context(
                url,
                &cfg.model,
                timeout,
                cfg.max_context_tokens,
            ))
        }
        "anthropic" => {
            let key = cfg.api_key.as_deref().unwrap_or("");
            info!(provider = "anthropic", model = %cfg.model, timeout_ms = timeout, "LLM provider initialized");
            Arc::new(AnthropicProvider::new(key, &cfg.model, timeout))
        }
        "llama-cpp" => {
            let url = cfg
                .base_url
                .as_deref()
                .filter(|s| !s.is_empty())
                .unwrap_or("http://127.0.0.1:8080");
            info!(provider = "llama-cpp", model = %cfg.model, url, timeout_ms = timeout, "LLM provider initialized");
            Arc::new(OpenAiCompatProvider::new(
                url,
                &cfg.model,
                None,
                timeout,
                "llama-cpp",
            ))
        }
        "openrouter" => {
            let url = cfg
                .base_url
                .as_deref()
                .filter(|s| !s.is_empty())
                .unwrap_or("https://openrouter.ai/api/v1");
            let env_key = std::env::var("OPENROUTER_API_KEY").ok();
            let key = cfg.api_key.as_deref().or(env_key.as_deref());
            info!(provider = "openrouter", model = %cfg.model, timeout_ms = timeout, "LLM provider initialized");
            Arc::new(OpenAiCompatProvider::with_extra_headers(
                url,
                &cfg.model,
                key,
                timeout,
                "openrouter",
                vec![
                    (
                        "HTTP-Referer".to_string(),
                        "https://signetai.sh".to_string(),
                    ),
                    ("X-Title".to_string(), "Signet".to_string()),
                ],
            ))
        }
        "openai-compatible" => {
            let url = cfg
                .base_url
                .as_deref()
                .filter(|s| !s.is_empty())
                .unwrap_or("http://localhost:8000");
            info!(provider = "openai-compatible", model = %cfg.model, url, timeout_ms = timeout, "LLM provider initialized");
            Arc::new(OpenAiCompatProvider::new(
                url,
                &cfg.model,
                cfg.api_key.as_deref(),
                timeout,
                "openai-compatible",
            ))
        }
        "claude-code" => {
            info!(provider = "claude-code", model = %cfg.model, timeout_ms = timeout, "LLM provider initialized");
            Arc::new(CliProvider::new(
                "claude",
                &["--print"],
                timeout,
                "claude-code",
            ))
        }
        "codex" => {
            info!(provider = "codex", model = %cfg.model, timeout_ms = timeout, "LLM provider initialized");
            Arc::new(CliProvider::new("codex", &["exec"], timeout, "codex"))
        }
        "acpx" => {
            info!(provider = "acpx", model = %cfg.model, timeout_ms = timeout, "LLM provider initialized");
            Arc::new(CliProvider::new("acpx", &[], timeout, "acpx"))
        }
        "command" => {
            let binary = cfg
                .base_url
                .as_deref()
                .filter(|s| !s.is_empty())
                .unwrap_or("echo");
            info!(
                provider = "command",
                binary = binary,
                timeout_ms = timeout,
                "LLM provider initialized"
            );
            Arc::new(CliProvider::new(binary, &[], timeout, "command"))
        }
        "opencode" => {
            let url = cfg
                .base_url
                .as_deref()
                .filter(|s| !s.is_empty())
                .unwrap_or("http://localhost:13284");
            info!(provider = "opencode", model = %cfg.model, url, timeout_ms = timeout, "LLM provider initialized");
            Arc::new(OpenCodeProvider::new(url, &cfg.model, timeout))
        }
        other => {
            warn!(
                provider = other,
                "unknown LLM provider, using ollama fallback"
            );
            let url = cfg
                .base_url
                .as_deref()
                .filter(|s| !s.is_empty())
                .unwrap_or(DEFAULT_OLLAMA_URL);
            Arc::new(OllamaLlmProvider::with_context(
                url,
                &cfg.model,
                timeout,
                cfg.max_context_tokens,
            ))
        }
    }
}
