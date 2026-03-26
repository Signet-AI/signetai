use crate::Tool;
use async_trait::async_trait;
use forge_core::{ToolCall, ToolDefinition, ToolPermission, ToolResult};
use forge_signet::daemon_auth_headers_from_env;
use serde_json::json;

/// Signet memory search — calls daemon /api/memory/recall
pub struct MemorySearchTool {
    pub daemon_url: String,
}

#[async_trait]
impl Tool for MemorySearchTool {
    fn name(&self) -> &str { "memory_search" }

    fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: "memory_search".to_string(),
            description: "Search Signet memories using hybrid vector + keyword search. Returns scored results with content and metadata.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Search query" },
                    "limit": { "type": "number", "description": "Max results (default: 10)" }
                },
                "required": ["query"]
            }),
        }
    }

    fn permission(&self) -> ToolPermission { ToolPermission::ReadOnly }

    async fn execute(&self, call: &ToolCall) -> ToolResult {
        let query = match call.input.get("query").and_then(|v| v.as_str()) {
            Some(q) => q,
            None => return ToolResult::error(&call.id, "Missing 'query'"),
        };
        let limit = call.input.get("limit").and_then(|v| v.as_u64()).unwrap_or(10);

        let client = reqwest::Client::new();
        let body = json!({ "query": query, "limit": limit });
        match client
            .post(format!("{}/api/memory/recall", self.daemon_url))
            .headers(daemon_auth_headers_from_env(None))
            .json(&body)
            .send()
            .await
        {
            Ok(resp) => match resp.json::<serde_json::Value>().await {
                Ok(data) => {
                    let results = data.get("results").and_then(|v| v.as_array());
                    match results {
                        Some(arr) => {
                            let formatted: Vec<String> = arr.iter().map(|r| {
                                let content = r.get("content").and_then(|v| v.as_str()).unwrap_or("");
                                let score = r.get("score").and_then(|v| v.as_f64()).unwrap_or(0.0);
                                let id = r.get("id").and_then(|v| v.as_str()).unwrap_or("");
                                format!("[{:.2}] {content} (id: {id})", score)
                            }).collect();
                            ToolResult::success(&call.id, formatted.join("\n\n"))
                        }
                        None => ToolResult::success(&call.id, "No results found"),
                    }
                }
                Err(e) => ToolResult::error(&call.id, format!("Parse error: {e}")),
            },
            Err(e) => ToolResult::error(&call.id, format!("Daemon error: {e}")),
        }
    }
}

/// Signet memory store — calls daemon /api/memory/remember
pub struct MemoryStoreTool {
    pub daemon_url: String,
}

#[async_trait]
impl Tool for MemoryStoreTool {
    fn name(&self) -> &str { "memory_store" }

    fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: "memory_store".to_string(),
            description: "Store a new memory in Signet. The memory will be extracted, embedded, and indexed for future recall.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "content": { "type": "string", "description": "The memory content to store" }
                },
                "required": ["content"]
            }),
        }
    }

    fn permission(&self) -> ToolPermission { ToolPermission::Write }

    async fn execute(&self, call: &ToolCall) -> ToolResult {
        let content = match call.input.get("content").and_then(|v| v.as_str()) {
            Some(c) => c,
            None => return ToolResult::error(&call.id, "Missing 'content'"),
        };

        let client = reqwest::Client::new();
        let body = json!({ "content": content });
        match client
            .post(format!("{}/api/memory/remember", self.daemon_url))
            .headers(daemon_auth_headers_from_env(None))
            .json(&body)
            .send()
            .await
        {
            Ok(resp) => match resp.json::<serde_json::Value>().await {
                Ok(data) => {
                    let id = data.get("id").and_then(|v| v.as_str()).unwrap_or("unknown");
                    ToolResult::success(&call.id, format!("Memory stored (id: {id})"))
                }
                Err(e) => ToolResult::error(&call.id, format!("Parse error: {e}")),
            },
            Err(e) => ToolResult::error(&call.id, format!("Daemon error: {e}")),
        }
    }
}

/// Signet knowledge graph expansion
pub struct KnowledgeExpandTool {
    pub daemon_url: String,
}

#[async_trait]
impl Tool for KnowledgeExpandTool {
    fn name(&self) -> &str { "knowledge_expand" }

    fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: "knowledge_expand".to_string(),
            description: "Drill into an entity in the Signet knowledge graph. Returns constraints, aspects, attributes, and dependencies for the named entity.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "entity": { "type": "string", "description": "Entity name to expand" }
                },
                "required": ["entity"]
            }),
        }
    }

    fn permission(&self) -> ToolPermission { ToolPermission::ReadOnly }

    async fn execute(&self, call: &ToolCall) -> ToolResult {
        let entity = match call.input.get("entity").and_then(|v| v.as_str()) {
            Some(e) => e,
            None => return ToolResult::error(&call.id, "Missing 'entity'"),
        };

        let client = reqwest::Client::new();
        let body = json!({ "entity": entity });
        match client
            .post(format!("{}/api/knowledge/expand", self.daemon_url))
            .headers(daemon_auth_headers_from_env(None))
            .json(&body)
            .send()
            .await
        {
            Ok(resp) => match resp.text().await {
                Ok(text) => ToolResult::success(&call.id, text),
                Err(e) => ToolResult::error(&call.id, format!("Read error: {e}")),
            },
            Err(e) => ToolResult::error(&call.id, format!("Daemon error: {e}")),
        }
    }
}

/// Signet secret exec — run command with secrets injected
pub struct SecretExecTool {
    pub daemon_url: String,
}

#[async_trait]
impl Tool for SecretExecTool {
    fn name(&self) -> &str { "secret_exec" }

    fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: "secret_exec".to_string(),
            description: "Execute a shell command with Signet-managed secrets injected as environment variables. Secrets are never exposed directly.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "command": { "type": "string", "description": "Shell command to execute" },
                    "secrets": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "Secret names to inject (e.g. [\"GITHUB_TOKEN\", \"OPENAI_API_KEY\"])"
                    }
                },
                "required": ["command"]
            }),
        }
    }

    fn permission(&self) -> ToolPermission { ToolPermission::Write }

    async fn execute(&self, call: &ToolCall) -> ToolResult {
        let command = match call.input.get("command").and_then(|v| v.as_str()) {
            Some(c) => c,
            None => return ToolResult::error(&call.id, "Missing 'command'"),
        };
        let secrets: Vec<String> = call.input.get("secrets")
            .and_then(|v| v.as_array())
            .map(|arr| arr.iter().filter_map(|v| v.as_str().map(String::from)).collect())
            .unwrap_or_default();

        let client = reqwest::Client::new();
        let body = json!({ "command": command, "secrets": secrets });
        match client
            .post(format!("{}/api/secrets/exec", self.daemon_url))
            .headers(daemon_auth_headers_from_env(None))
            .json(&body)
            .send()
            .await
        {
            Ok(resp) => match resp.json::<serde_json::Value>().await {
                Ok(data) => {
                    let stdout = data.get("stdout").and_then(|v| v.as_str()).unwrap_or("");
                    let stderr = data.get("stderr").and_then(|v| v.as_str()).unwrap_or("");
                    let code = data.get("exitCode").and_then(|v| v.as_i64()).unwrap_or(-1);
                    let mut out = String::new();
                    if !stdout.is_empty() { out.push_str(stdout); }
                    if !stderr.is_empty() {
                        if !out.is_empty() { out.push('\n'); }
                        out.push_str(&format!("stderr: {stderr}"));
                    }
                    if code != 0 { out.push_str(&format!("\nexit code: {code}")); }
                    if code != 0 {
                        ToolResult::error(&call.id, out)
                    } else {
                        ToolResult::success(&call.id, out)
                    }
                }
                Err(e) => ToolResult::error(&call.id, format!("Parse error: {e}")),
            },
            Err(e) => ToolResult::error(&call.id, format!("Daemon error: {e}")),
        }
    }
}
