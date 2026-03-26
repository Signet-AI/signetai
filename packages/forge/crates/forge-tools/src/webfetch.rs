use crate::Tool;
use async_trait::async_trait;
use forge_core::{ToolCall, ToolDefinition, ToolPermission, ToolResult};
use serde_json::json;

/// Fetch content from a URL and return as text
pub struct WebFetchTool;

#[async_trait]
impl Tool for WebFetchTool {
    fn name(&self) -> &str {
        "WebFetch"
    }

    fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: "WebFetch".to_string(),
            description: "Fetch the content of a web page and return it as text. Strips HTML tags for readability. Useful for reading documentation, articles, or API responses.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "url": {
                        "type": "string",
                        "description": "The URL to fetch"
                    },
                    "raw": {
                        "type": "boolean",
                        "description": "If true, return raw HTML instead of stripped text (default: false)"
                    },
                    "max_length": {
                        "type": "number",
                        "description": "Maximum characters to return (default: 50000)"
                    }
                },
                "required": ["url"]
            }),
        }
    }

    fn permission(&self) -> ToolPermission {
        ToolPermission::ReadOnly
    }

    async fn execute(&self, call: &ToolCall) -> ToolResult {
        let url = match call.input.get("url").and_then(|v| v.as_str()) {
            Some(u) => u,
            None => return ToolResult::error(&call.id, "Missing 'url' parameter"),
        };
        let raw = call.input.get("raw").and_then(|v| v.as_bool()).unwrap_or(false);
        let max = call.input.get("max_length").and_then(|v| v.as_u64()).unwrap_or(50_000) as usize;

        let client = reqwest::Client::builder()
            .user_agent("Mozilla/5.0 (compatible; Forge/0.4)")
            .timeout(std::time::Duration::from_secs(30))
            .redirect(reqwest::redirect::Policy::limited(5))
            .build()
            .unwrap();

        let resp = match client.get(url).send().await {
            Ok(r) => r,
            Err(e) => return ToolResult::error(&call.id, format!("Fetch failed: {e}")),
        };

        let status = resp.status();
        if !status.is_success() {
            return ToolResult::error(
                &call.id,
                format!("HTTP {status} for {url}"),
            );
        }

        let body = match resp.text().await {
            Ok(t) => t,
            Err(e) => return ToolResult::error(&call.id, format!("Failed to read body: {e}")),
        };

        let content = if raw {
            body
        } else {
            strip_to_text(&body)
        };

        let truncated = if content.len() > max {
            format!("{}...\n\n[Truncated at {max} chars, full page is {} chars]", &content[..max], content.len())
        } else {
            content
        };

        ToolResult::success(&call.id, &truncated)
    }
}

/// Strip HTML to readable text — removes tags, scripts, styles, normalizes whitespace
fn strip_to_text(html: &str) -> String {
    let mut out = String::with_capacity(html.len() / 3);
    let mut in_tag = false;
    let mut in_script = false;
    let mut in_style = false;
    let mut last_was_space = false;

    let lower = html.to_lowercase();
    let chars: Vec<char> = html.chars().collect();
    let lower_chars: Vec<char> = lower.chars().collect();

    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '<' {
            // Check for script/style start/end
            let rest: String = lower_chars[i..].iter().take(20).collect();
            if rest.starts_with("<script") {
                in_script = true;
            } else if rest.starts_with("</script") {
                in_script = false;
            } else if rest.starts_with("<style") {
                in_style = true;
            } else if rest.starts_with("</style") {
                in_style = false;
            }
            // Block-level tags → newline
            if (rest.starts_with("<br") || rest.starts_with("<p") || rest.starts_with("</p")
                || rest.starts_with("<div") || rest.starts_with("</div")
                || rest.starts_with("<h") || rest.starts_with("</h")
                || rest.starts_with("<li") || rest.starts_with("<tr"))
                && !last_was_space {
                    out.push('\n');
                    last_was_space = true;
                }
            in_tag = true;
            i += 1;
            continue;
        }

        if chars[i] == '>' {
            in_tag = false;
            i += 1;
            continue;
        }

        if in_tag || in_script || in_style {
            i += 1;
            continue;
        }

        // Decode HTML entities inline
        if chars[i] == '&' {
            let rest: String = chars[i..].iter().take(10).collect();
            if rest.starts_with("&amp;") {
                out.push('&');
                i += 5;
                last_was_space = false;
                continue;
            } else if rest.starts_with("&lt;") {
                out.push('<');
                i += 4;
                last_was_space = false;
                continue;
            } else if rest.starts_with("&gt;") {
                out.push('>');
                i += 4;
                last_was_space = false;
                continue;
            } else if rest.starts_with("&quot;") {
                out.push('"');
                i += 6;
                last_was_space = false;
                continue;
            } else if rest.starts_with("&nbsp;") {
                out.push(' ');
                i += 6;
                last_was_space = true;
                continue;
            }
        }

        if chars[i].is_whitespace() {
            if !last_was_space {
                out.push(if chars[i] == '\n' { '\n' } else { ' ' });
                last_was_space = true;
            }
        } else {
            out.push(chars[i]);
            last_was_space = false;
        }
        i += 1;
    }

    // Collapse multiple newlines
    let mut result = String::with_capacity(out.len());
    let mut consecutive = 0;
    for c in out.chars() {
        if c == '\n' {
            consecutive += 1;
            if consecutive <= 2 {
                result.push(c);
            }
        } else {
            consecutive = 0;
            result.push(c);
        }
    }
    result.trim().to_string()
}
