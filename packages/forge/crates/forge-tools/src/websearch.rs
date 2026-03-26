use crate::Tool;
use async_trait::async_trait;
use forge_core::{ToolCall, ToolDefinition, ToolPermission, ToolResult};
use serde_json::json;

/// Web search tool using DuckDuckGo HTML search (no API key needed)
pub struct WebSearchTool;

#[async_trait]
impl Tool for WebSearchTool {
    fn name(&self) -> &str {
        "WebSearch"
    }

    fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: "WebSearch".to_string(),
            description: "Search the web for current information. Returns titles, URLs, and snippets from search results.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "The search query"
                    },
                    "limit": {
                        "type": "number",
                        "description": "Maximum results to return (default: 5)"
                    }
                },
                "required": ["query"]
            }),
        }
    }

    fn permission(&self) -> ToolPermission {
        ToolPermission::ReadOnly
    }

    async fn execute(&self, call: &ToolCall) -> ToolResult {
        let query = match call.input.get("query").and_then(|v| v.as_str()) {
            Some(q) => q,
            None => return ToolResult::error(&call.id, "Missing 'query' parameter"),
        };
        let limit = call.input.get("limit").and_then(|v| v.as_u64()).unwrap_or(5) as usize;

        let url = format!(
            "https://html.duckduckgo.com/html/?q={}",
            urlencoding::encode(query)
        );

        let client = reqwest::Client::builder()
            .user_agent("Mozilla/5.0 (compatible; Forge/0.4)")
            .timeout(std::time::Duration::from_secs(10))
            .build()
            .unwrap();

        let resp = match client.get(&url).send().await {
            Ok(r) => r,
            Err(e) => return ToolResult::error(&call.id, format!("Search failed: {e}")),
        };

        let html = match resp.text().await {
            Ok(t) => t,
            Err(e) => return ToolResult::error(&call.id, format!("Failed to read response: {e}")),
        };

        // Parse results from DuckDuckGo HTML
        let mut results = Vec::new();
        for chunk in html.split("class=\"result__a\"") {
            if results.len() >= limit {
                break;
            }
            // Extract href
            if let Some(href_start) = chunk.find("href=\"") {
                let after = &chunk[href_start + 6..];
                if let Some(href_end) = after.find('"') {
                    let href = &after[..href_end];
                    // Extract title text (between > and </a>)
                    let title = after
                        .find('>')
                        .and_then(|s| {
                            let rest = &after[s + 1..];
                            rest.find("</a>").map(|e| {
                                strip_html(&rest[..e])
                            })
                        })
                        .unwrap_or_default();

                    if !href.is_empty() && !title.is_empty() {
                        // Extract snippet
                        let snippet = chunk
                            .find("class=\"result__snippet\"")
                            .and_then(|s| {
                                let rest = &chunk[s..];
                                rest.find('>').and_then(|gt| {
                                    let inner = &rest[gt + 1..];
                                    inner.find("</").map(|end| strip_html(&inner[..end]))
                                })
                            })
                            .unwrap_or_default();

                        results.push(format!("**{}**\n{}\n{}\n", title.trim(), href, snippet.trim()));
                    }
                }
            }
        }

        if results.is_empty() {
            ToolResult::success(&call.id, format!("No results found for: {query}"))
        } else {
            ToolResult::success(&call.id, results.join("\n"))
        }
    }
}

fn strip_html(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_tag = false;
    for c in s.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    // Decode common HTML entities
    out.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&nbsp;", " ")
}
