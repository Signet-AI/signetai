use crate::Tool;
use async_trait::async_trait;
use forge_core::{ToolCall, ToolDefinition, ToolPermission, ToolResult};
use forge_signet::daemon_auth_headers_from_env;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tracing::{debug, warn};

/// A marketplace tool definition fetched from the Signet daemon.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MarketplaceToolDef {
    pub name: String,
    pub description: String,
    pub input_schema: serde_json::Value,
}

/// A dynamically-registered tool that proxies calls to the Signet daemon's
/// marketplace endpoint: `POST /api/marketplace/tools/:name/call`.
pub struct MarketplaceTool {
    pub daemon_url: String,
    pub def: MarketplaceToolDef,
}

#[async_trait]
impl Tool for MarketplaceTool {
    fn name(&self) -> &str {
        &self.def.name
    }

    fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: self.def.name.clone(),
            description: format!("[marketplace] {}", self.def.description),
            input_schema: self.def.input_schema.clone(),
        }
    }

    fn permission(&self) -> ToolPermission {
        // Marketplace tools are externally-provided; require approval.
        ToolPermission::Write
    }

    async fn execute(&self, call: &ToolCall) -> ToolResult {
        let url = format!(
            "{}/api/marketplace/tools/{}/call",
            self.daemon_url,
            urlencoding::encode(&self.def.name)
        );

        let client = reqwest::Client::new();
        let body = json!({ "arguments": call.input });

        match client
            .post(&url)
            .headers(daemon_auth_headers_from_env(None))
            .json(&body)
            .send()
            .await
        {
            Ok(resp) => {
                let status = resp.status();
                match resp.text().await {
                    Ok(text) if status.is_success() => {
                        // Try to extract structured content, fall back to raw text
                        if let Ok(val) = serde_json::from_str::<serde_json::Value>(&text) {
                            let content = val
                                .get("content")
                                .and_then(|c| c.as_str())
                                .or_else(|| val.get("result").and_then(|r| r.as_str()))
                                .map(String::from)
                                .unwrap_or(text);
                            ToolResult::success(&call.id, content)
                        } else {
                            ToolResult::success(&call.id, text)
                        }
                    }
                    Ok(text) => ToolResult::error(
                        &call.id,
                        format!("Marketplace tool error (HTTP {}): {}", status, text),
                    ),
                    Err(e) => ToolResult::error(
                        &call.id,
                        format!("Failed to read marketplace response: {e}"),
                    ),
                }
            }
            Err(e) => ToolResult::error(
                &call.id,
                format!("Marketplace daemon request failed: {e}"),
            ),
        }
    }
}

/// Fetch marketplace tool definitions from the Signet daemon.
///
/// Calls `GET /api/marketplace/tools` and returns parsed definitions.
/// Returns an empty vec on any error (non-fatal).
pub async fn fetch_marketplace_tools(daemon_url: &str) -> Vec<MarketplaceToolDef> {
    let url = format!("{}/api/marketplace/tools", daemon_url);
    let client = reqwest::Client::new();

    let resp = match client
        .get(&url)
        .headers(daemon_auth_headers_from_env(None))
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            debug!("Marketplace tools fetch failed: {e}");
            return Vec::new();
        }
    };

    if !resp.status().is_success() {
        debug!(
            "Marketplace tools endpoint returned {}",
            resp.status()
        );
        return Vec::new();
    }

    let body: serde_json::Value = match resp.json().await {
        Ok(v) => v,
        Err(e) => {
            warn!("Marketplace tools parse error: {e}");
            return Vec::new();
        }
    };

    // Expected shape: { "tools": [ { "name": ..., "description": ..., "inputSchema": ... } ] }
    let tools_arr = body
        .get("tools")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let defs: Vec<MarketplaceToolDef> = tools_arr
        .into_iter()
        .filter_map(|t| {
            let name = t.get("name")?.as_str()?.to_string();
            let description = t
                .get("description")
                .and_then(|d| d.as_str())
                .unwrap_or("")
                .to_string();
            let input_schema = t
                .get("inputSchema")
                .or_else(|| t.get("input_schema"))
                .cloned()
                .unwrap_or(json!({"type": "object"}));

            Some(MarketplaceToolDef {
                name,
                description,
                input_schema,
            })
        })
        .collect();

    debug!("Fetched {} marketplace tools", defs.len());
    defs
}

/// Create boxed Tool instances from marketplace definitions.
pub fn marketplace_tools(daemon_url: &str, defs: &[MarketplaceToolDef]) -> Vec<Box<dyn Tool>> {
    defs.iter()
        .map(|def| -> Box<dyn Tool> {
            Box::new(MarketplaceTool {
                daemon_url: daemon_url.to_string(),
                def: def.clone(),
            })
        })
        .collect()
}
