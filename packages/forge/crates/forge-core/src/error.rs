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
}

pub type ForgeResult<T> = Result<T, ForgeError>;
