use crate::Tool;
use async_trait::async_trait;
use forge_core::{ToolCall, ToolDefinition, ToolPermission, ToolResult};
use serde_json::json;
use tracing::debug;

pub struct ReadTool;

#[async_trait]
impl Tool for ReadTool {
    fn name(&self) -> &str {
        "Read"
    }

    fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: "Read".to_string(),
            description: "Read a file from the filesystem. Returns content with line numbers."
                .to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "file_path": {
                        "type": "string",
                        "description": "The absolute path to the file to read"
                    },
                    "offset": {
                        "type": "number",
                        "description": "Line number to start reading from (1-based)"
                    },
                    "limit": {
                        "type": "number",
                        "description": "Number of lines to read"
                    }
                },
                "required": ["file_path"]
            }),
        }
    }

    fn permission(&self) -> ToolPermission {
        ToolPermission::ReadOnly
    }

    async fn execute(&self, call: &ToolCall) -> ToolResult {
        let file_path = match call.input.get("file_path").and_then(|v| v.as_str()) {
            Some(p) => p,
            None => return ToolResult::error(&call.id, "Missing 'file_path' parameter"),
        };

        let offset = call
            .input
            .get("offset")
            .and_then(|v| v.as_u64())
            .unwrap_or(1) as usize;
        let limit = call
            .input
            .get("limit")
            .and_then(|v| v.as_u64())
            .unwrap_or(2000) as usize;

        debug!("Reading file: {file_path} (offset={offset}, limit={limit})");

        match std::fs::read_to_string(file_path) {
            Ok(content) => {
                let lines: Vec<&str> = content.lines().collect();
                let start = (offset.saturating_sub(1)).min(lines.len());
                let end = (start + limit).min(lines.len());

                let numbered: String = lines[start..end]
                    .iter()
                    .enumerate()
                    .map(|(i, line)| format!("{:>6}\t{}", start + i + 1, line))
                    .collect::<Vec<_>>()
                    .join("\n");

                ToolResult::success(&call.id, numbered)
            }
            Err(e) => ToolResult::error(&call.id, format!("Failed to read {file_path}: {e}")),
        }
    }
}
