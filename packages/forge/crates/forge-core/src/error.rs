use thiserror::Error;

#[derive(Error, Debug)]
pub enum ForgeError {
    #[error("Provider error: {0}")]
    Provider(String),

    #[error("Tool execution error: {0}")]
    Tool(String),

    #[error("Signet daemon error: {0}")]
    Daemon(String),

    #[error("Configuration error: {0}")]
    Config(String),

    #[error("Session error: {0}")]
    Session(String),

    #[error("MCP error: {0}")]
    Mcp(String),

    #[error("HTTP error: {0}")]
    Http(#[from] reqwest::Error),

    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Context window exceeded: {used} / {limit} tokens")]
    ContextOverflow { used: usize, limit: usize },

    #[error("Permission denied for tool: {0}")]
    PermissionDenied(String),

    #[error("API key not found for provider: {0}")]
    ApiKeyMissing(String),
}

/// Error category for retry decisions
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorCategory {
    /// Transient server errors (5xx, timeouts) — retryable with backoff
    Transient,
    /// Rate limit (429) — retryable with longer backoff
    RateLimit,
    /// Context window exceeded — retryable after compaction
    ContextOverflow,
    /// Client errors (4xx except 429), auth failures — not retryable
    Client,
    /// Unknown or unclassifiable — not retryable
    Fatal,
}

impl ForgeError {
    pub fn provider(msg: impl Into<String>) -> Self {
        Self::Provider(msg.into())
    }

    pub fn daemon(msg: impl Into<String>) -> Self {
        Self::Daemon(msg.into())
    }

    pub fn config(msg: impl Into<String>) -> Self {
        Self::Config(msg.into())
    }

    /// Classify this error for retry decisions
    pub fn category(&self) -> ErrorCategory {
        match self {
            Self::ContextOverflow { .. } => ErrorCategory::ContextOverflow,
            Self::Provider(msg) if is_rate_limit(msg) => ErrorCategory::RateLimit,
            Self::Provider(msg) if is_transient(msg) => ErrorCategory::Transient,
            Self::Provider(msg) if is_client_error(msg) => ErrorCategory::Client,
            Self::Http(e) if e.status().is_some_and(|s| s.as_u16() == 429) => {
                ErrorCategory::RateLimit
            }
            Self::Http(e) if e.is_timeout() || e.is_connect() => ErrorCategory::Transient,
            Self::Http(e) if e.status().is_some_and(|s| s.is_server_error()) => {
                ErrorCategory::Transient
            }
            Self::ApiKeyMissing(_) | Self::Config(_) | Self::PermissionDenied(_) => {
                ErrorCategory::Client
            }
            _ => ErrorCategory::Fatal,
        }
    }
}

fn is_rate_limit(msg: &str) -> bool {
    msg.contains("HTTP 429")
        || msg.contains("status 429")
        || msg.contains("status: 429")
        || msg.contains("rate limit")
        || msg.contains("Rate limit")
        || msg.contains("rate_limit")
}

fn is_transient(msg: &str) -> bool {
    msg.contains("HTTP 500")
        || msg.contains("HTTP 502")
        || msg.contains("HTTP 503")
        || msg.contains("HTTP 504")
        || msg.contains("status 500")
        || msg.contains("status 502")
        || msg.contains("status 503")
        || msg.contains("status 504")
        || msg.contains("status: 500")
        || msg.contains("status: 502")
        || msg.contains("status: 503")
        || msg.contains("status: 504")
        || msg.contains("timeout")
        || msg.contains("Timeout")
        || msg.contains("ECONNREFUSED")
        || msg.contains("ECONNRESET")
        || msg.contains("ETIMEDOUT")
        || msg.contains("connection reset")
        || msg.contains("Connection reset")
        || msg.contains("connection refused")
        || msg.contains("Connection refused")
}

fn is_client_error(msg: &str) -> bool {
    msg.contains("HTTP 400")
        || msg.contains("HTTP 401")
        || msg.contains("HTTP 403")
        || msg.contains("HTTP 404")
        || msg.contains("HTTP 422")
        || msg.contains("status 400")
        || msg.contains("status 401")
        || msg.contains("status 403")
        || msg.contains("status 404")
        || msg.contains("status 422")
        || msg.contains("status: 400")
        || msg.contains("status: 401")
        || msg.contains("status: 403")
        || msg.contains("status: 404")
        || msg.contains("status: 422")
}

pub type ForgeResult<T> = Result<T, ForgeError>;
