use forge_mcp::McpStdioClient;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tracing::{debug, info, warn};

/// External MCP server configuration loaded from `~/.config/forge/mcp.json`.
#[derive(Debug, Deserialize, Serialize, Default)]
pub struct McpConfig {
    #[serde(default)]
    pub servers: Vec<McpServerEntry>,
}

/// A single external MCP server entry.
#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct McpServerEntry {
    pub name: String,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
}

impl McpConfig {
    /// Load the MCP config from `~/.config/forge/mcp.json`.
    /// Returns an empty config if the file does not exist or is invalid.
    pub fn load() -> Self {
        let path = Self::config_path();
        if !path.exists() {
            debug!("No MCP config at {}", path.display());
            return Self::default();
        }

        match std::fs::read_to_string(&path) {
            Ok(content) => match serde_json::from_str::<McpConfig>(&content) {
                Ok(config) => {
                    info!(
                        "Loaded MCP config with {} server(s) from {}",
                        config.servers.len(),
                        path.display()
                    );
                    config
                }
                Err(e) => {
                    warn!("Failed to parse MCP config {}: {e}", path.display());
                    Self::default()
                }
            },
            Err(e) => {
                warn!("Failed to read MCP config {}: {e}", path.display());
                Self::default()
            }
        }
    }

    /// Path to the config file.
    fn config_path() -> std::path::PathBuf {
        dirs::config_dir()
            .unwrap_or_else(|| dirs::home_dir().unwrap_or_default().join(".config"))
            .join("forge")
            .join("mcp.json")
    }
}

/// Connect to all configured external MCP servers.
///
/// Servers that fail to connect are logged as warnings and skipped.
/// Returns the successfully-connected clients.
pub async fn connect_mcp_servers(config: &McpConfig) -> Vec<Arc<McpStdioClient>> {
    let mut clients = Vec::new();

    for entry in &config.servers {
        let server_config = forge_mcp::McpServerConfig {
            name: entry.name.clone(),
            command: entry.command.clone(),
            args: entry.args.clone(),
            env: entry.env.iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
        };

        match McpStdioClient::connect(&server_config).await {
            Ok(client) => {
                info!("Connected to MCP server: {}", entry.name);
                clients.push(Arc::new(client));
            }
            Err(e) => {
                warn!("Failed to connect to MCP server '{}': {e}", entry.name);
            }
        }
    }

    clients
}
