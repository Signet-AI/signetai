use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ForgeConfig {
    #[serde(default = "default_provider")]
    pub provider: String,
    #[serde(default = "default_model")]
    pub model: String,
    #[serde(default = "default_daemon_url")]
    pub daemon_url: String,
    #[serde(default)]
    pub max_tokens: Option<usize>,
    #[serde(default)]
    pub temperature: Option<f64>,
    #[serde(default = "default_true")]
    pub auto_extract: bool,
    #[serde(default)]
    pub sync_extraction_model: bool,
    #[serde(default)]
    pub auto_approve: Vec<String>,
}

fn default_provider() -> String {
    "anthropic".to_string()
}

fn default_model() -> String {
    "claude-sonnet-4-6".to_string()
}

fn default_daemon_url() -> String {
    "http://localhost:3850".to_string()
}

fn default_true() -> bool {
    true
}

impl Default for ForgeConfig {
    fn default() -> Self {
        Self {
            provider: default_provider(),
            model: default_model(),
            daemon_url: default_daemon_url(),
            max_tokens: None,
            temperature: None,
            auto_extract: true,
            sync_extraction_model: false,
            auto_approve: vec![
                "Read".to_string(),
                "Glob".to_string(),
                "Grep".to_string(),
            ],
        }
    }
}

/// Model metadata for the model picker
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelInfo {
    pub id: String,
    pub name: String,
    pub provider: String,
    pub context_window: usize,
    #[serde(default)]
    pub supports_tools: bool,
    #[serde(default)]
    pub supports_streaming: bool,
}
