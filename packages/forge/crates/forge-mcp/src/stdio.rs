use crate::protocol::{JsonRpcRequest, JsonRpcResponse};
use forge_core::{ForgeError, ToolDefinition};
use serde_json::{json, Value};
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;
use tracing::{debug, info};

/// MCP server configuration
#[derive(Debug, Clone)]
pub struct McpServerConfig {
    pub name: String,
    pub command: String,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
}

/// An MCP client that communicates over stdio (JSON-RPC over stdin/stdout)
pub struct McpStdioClient {
    name: String,
    child: Mutex<Child>,
    next_id: Mutex<u64>,
}

impl McpStdioClient {
    /// Spawn an MCP server process and initialize the connection
    pub async fn connect(config: &McpServerConfig) -> Result<Self, ForgeError> {
        info!("Connecting to MCP server: {} ({})", config.name, config.command);

        let mut cmd = Command::new(&config.command);
        cmd.args(&config.args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());

        for (key, value) in &config.env {
            cmd.env(key, value);
        }

        let child = cmd
            .spawn()
            .map_err(|e| ForgeError::Mcp(format!("Failed to spawn {}: {e}", config.command)))?;

        let client = Self {
            name: config.name.clone(),
            child: Mutex::new(child),
            next_id: Mutex::new(1),
        };

        // Initialize the MCP connection
        client.initialize().await?;

        info!("MCP server {} connected", config.name);
        Ok(client)
    }

    async fn next_id(&self) -> u64 {
        let mut id = self.next_id.lock().await;
        let current = *id;
        *id += 1;
        current
    }

    /// Send a JSON-RPC request and receive a response
    async fn request(&self, method: &str, params: Option<Value>) -> Result<Value, ForgeError> {
        let id = self.next_id().await;
        let request = JsonRpcRequest::new(id, method, params);
        let request_json = serde_json::to_string(&request)
            .map_err(|e| ForgeError::Mcp(format!("Serialize error: {e}")))?;

        debug!("MCP {} → {method} (id={id})", self.name);

        let mut child = self.child.lock().await;

        // Write request
        let stdin = child
            .stdin
            .as_mut()
            .ok_or_else(|| ForgeError::Mcp("MCP server stdin closed".to_string()))?;
        stdin
            .write_all(request_json.as_bytes())
            .await
            .map_err(|e| ForgeError::Mcp(format!("Write error: {e}")))?;
        stdin
            .write_all(b"\n")
            .await
            .map_err(|e| ForgeError::Mcp(format!("Write error: {e}")))?;
        stdin
            .flush()
            .await
            .map_err(|e| ForgeError::Mcp(format!("Flush error: {e}")))?;

        // Read response
        let stdout = child
            .stdout
            .as_mut()
            .ok_or_else(|| ForgeError::Mcp("MCP server stdout closed".to_string()))?;
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        reader
            .read_line(&mut line)
            .await
            .map_err(|e| ForgeError::Mcp(format!("Read error: {e}")))?;

        let response: JsonRpcResponse = serde_json::from_str(&line)
            .map_err(|e| ForgeError::Mcp(format!("Parse response error: {e}")))?;

        if let Some(err) = response.error {
            return Err(ForgeError::Mcp(format!(
                "MCP error {}: {}",
                err.code, err.message
            )));
        }

        response
            .result
            .ok_or_else(|| ForgeError::Mcp("Empty response".to_string()))
    }

    /// Initialize the MCP connection (handshake)
    async fn initialize(&self) -> Result<(), ForgeError> {
        let params = json!({
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {
                "name": "forge",
                "version": env!("CARGO_PKG_VERSION"),
            }
        });

        self.request("initialize", Some(params)).await?;

        // Send initialized notification (no response expected)
        let id = self.next_id().await;
        let notification = JsonRpcRequest::new(id, "notifications/initialized", None);
        let json = serde_json::to_string(&notification)
            .map_err(|e| ForgeError::Mcp(format!("Serialize error: {e}")))?;

        let mut child = self.child.lock().await;
        if let Some(stdin) = child.stdin.as_mut() {
            let _ = stdin.write_all(json.as_bytes()).await;
            let _ = stdin.write_all(b"\n").await;
            let _ = stdin.flush().await;
        }

        Ok(())
    }

    /// List available tools from the MCP server
    pub async fn list_tools(&self) -> Result<Vec<ToolDefinition>, ForgeError> {
        let result = self.request("tools/list", None).await?;

        let tools = result
            .get("tools")
            .and_then(|t| t.as_array())
            .cloned()
            .unwrap_or_default();

        let definitions: Vec<ToolDefinition> = tools
            .iter()
            .filter_map(|t| {
                let name = t.get("name")?.as_str()?;
                let description = t
                    .get("description")
                    .and_then(|d| d.as_str())
                    .unwrap_or("");
                let schema = t
                    .get("inputSchema")
                    .cloned()
                    .unwrap_or(json!({"type": "object"}));

                Some(ToolDefinition {
                    name: format!("{}_{}", self.name, name),
                    description: format!("[{}] {}", self.name, description),
                    input_schema: schema,
                })
            })
            .collect();

        debug!(
            "MCP {} has {} tools",
            self.name,
            definitions.len()
        );
        Ok(definitions)
    }

    /// Call a tool on the MCP server
    pub async fn call_tool(
        &self,
        tool_name: &str,
        arguments: Value,
    ) -> Result<String, ForgeError> {
        // Strip the server name prefix to get the actual tool name
        let actual_name = tool_name
            .strip_prefix(&format!("{}_", self.name))
            .unwrap_or(tool_name);

        let params = json!({
            "name": actual_name,
            "arguments": arguments,
        });

        let result = self.request("tools/call", Some(params)).await?;

        // Extract text content from the response
        let content = result
            .get("content")
            .and_then(|c| c.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|item| {
                        if item.get("type").and_then(|t| t.as_str()) == Some("text") {
                            item.get("text").and_then(|t| t.as_str()).map(String::from)
                        } else {
                            None
                        }
                    })
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .unwrap_or_else(|| result.to_string());

        Ok(content)
    }

    pub fn name(&self) -> &str {
        &self.name
    }
}

impl Drop for McpStdioClient {
    fn drop(&mut self) {
        // Try to kill the child process
        if let Ok(mut child) = self.child.try_lock() {
            let _ = child.start_kill();
        }
    }
}
