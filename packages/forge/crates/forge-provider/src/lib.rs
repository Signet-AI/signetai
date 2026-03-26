pub mod anthropic;
pub mod cli;
pub mod gemini;
pub mod openai;
pub mod streaming;

use async_trait::async_trait;
use forge_core::{ForgeError, Message, ToolDefinition, TokenUsage};
use std::pin::Pin;
use tokio_stream::Stream;

/// Events emitted by a provider during streaming completion
#[derive(Debug, Clone)]
pub enum StreamEvent {
    /// Incremental text content
    TextDelta(String),
    /// A tool use block has started
    ToolUseStart { id: String, name: String },
    /// Incremental JSON input for the current tool call
    ToolUseInput(String),
    /// The current tool use block is complete
    ToolUseEnd,
    /// Tool execution result (from CLI-managed tools)
    ToolResult { name: String, output: String, is_error: bool },
    /// Token usage statistics
    Usage(TokenUsage),
    /// Stream is complete
    Done,
    /// Phase hint for TUI (e.g. "thinking", "planning")
    Status(String),
    /// An error occurred during streaming
    Error(String),
}

/// A stream of completion events
pub type CompletionStream = Pin<Box<dyn Stream<Item = StreamEvent> + Send>>;

/// Reasoning effort level
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub enum ReasoningEffort {
    Low,
    #[default]
    Medium,
    High,
}

impl ReasoningEffort {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
        }
    }

    pub fn parse(s: &str) -> Self {
        match s.to_lowercase().as_str() {
            "low" | "l" => Self::Low,
            "high" | "h" => Self::High,
            _ => Self::Medium,
        }
    }
}

/// Options for a completion request
#[derive(Debug, Clone, Default)]
pub struct CompletionOpts {
    pub max_tokens: Option<usize>,
    pub temperature: Option<f64>,
    pub system_prompt: Option<String>,
    /// For models that support extended thinking / reasoning
    pub thinking: Option<ThinkingConfig>,
    /// Reasoning effort level (low/medium/high)
    pub effort: ReasoningEffort,
    /// Skip permission prompts on CLI providers
    pub bypass: bool,
}

#[derive(Debug, Clone)]
pub struct ThinkingConfig {
    pub enabled: bool,
    pub budget_tokens: Option<usize>,
}

/// The core provider trait — each AI provider implements this
#[async_trait]
pub trait Provider: Send + Sync {
    /// Provider name (e.g., "anthropic", "openai")
    fn name(&self) -> &str;

    /// Current model ID (e.g., "claude-sonnet-4-6")
    fn model(&self) -> &str;

    /// Context window size in tokens
    fn context_window(&self) -> usize;

    /// Send a completion request and get a streaming response
    async fn complete(
        &self,
        messages: &[Message],
        tools: &[ToolDefinition],
        opts: &CompletionOpts,
    ) -> Result<CompletionStream, ForgeError>;

    /// Check if the provider is available (API key set, endpoint reachable)
    async fn available(&self) -> bool;

    /// Pre-warm the connection to reduce time-to-first-token.
    /// Called in parallel with memory recall so the TCP+TLS handshake
    /// overlaps with the daemon round-trip.
    async fn preconnect(&self) {
        // Default no-op — providers can override to warm their connection pool
    }
}

/// Create a provider by name (API-based providers)
pub fn create_provider(
    provider_name: &str,
    model: &str,
    api_key: &str,
) -> Result<Box<dyn Provider>, ForgeError> {
    match provider_name {
        "anthropic" => Ok(Box::new(anthropic::AnthropicProvider::new(
            model.to_string(),
            api_key.to_string(),
        ))),
        "openai" => Ok(Box::new(openai::openai(model, api_key))),
        "gemini" | "google" => Ok(Box::new(gemini::GeminiProvider::new(
            model.to_string(),
            api_key.to_string(),
        ))),
        "groq" => Ok(Box::new(openai::groq(model, api_key))),
        "ollama" => Ok(Box::new(openai::ollama(model))),
        "openrouter" => Ok(Box::new(openai::openrouter(model, api_key))),
        "xai" => Ok(Box::new(openai::xai(model, api_key))),
        other => Err(ForgeError::provider(format!(
            "Unknown provider: {other}. Available: anthropic, openai, gemini, groq, ollama, openrouter, xai, claude-cli, codex-cli, gemini-cli"
        ))),
    }
}

/// Create a CLI-based provider
pub fn create_cli_provider(
    kind: cli::CliKind,
    cli_path: &str,
    model: &str,
) -> Box<dyn Provider> {
    Box::new(cli::CliProvider::new(
        kind,
        cli_path.to_string(),
        model.to_string(),
    ))
}

/// List all available provider names
pub fn available_providers() -> &'static [&'static str] {
    &[
        "anthropic",
        "openai",
        "gemini",
        "groq",
        "ollama",
        "openrouter",
        "xai",
    ]
}
