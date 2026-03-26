use crate::Tool;
use async_trait::async_trait;
use forge_core::{ToolCall, ToolDefinition, ToolPermission, ToolResult};
use serde_json::json;
use std::path::Path;
use tracing::debug;

pub struct WriteTool;

#[async_trait]
impl Tool for WriteTool {
    fn name(&self) -> &str {
        "Write"
    }

    fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: "Write".to_string(),
            description: "Write content to a file, creating it if it doesn't exist.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "file_path": {
                        "type": "string",
                        "description": "The absolute path to the file to write"
                    },
                    "content": {
                        "type": "string",
                        "description": "The content to write to the file"
                    }
                },
                "required": ["file_path", "content"]
            }),
        }
    }

    fn permission(&self) -> ToolPermission {
        ToolPermission::Write
    }

    async fn execute(&self, call: &ToolCall) -> ToolResult {
        let file_path = match call.input.get("file_path").and_then(|v| v.as_str()) {
            Some(p) => p,
            None => return ToolResult::error(&call.id, "Missing 'file_path' parameter"),
        };

        let content = match call.input.get("content").and_then(|v| v.as_str()) {
            Some(c) => c,
            None => return ToolResult::error(&call.id, "Missing 'content' parameter"),
        };

        debug!("Writing file: {file_path} ({} bytes)", content.len());

        // Create parent directories if needed
        if let Some(parent) = Path::new(file_path).parent() {
            if !parent.exists() {
                if let Err(e) = std::fs::create_dir_all(parent) {
                    return ToolResult::error(
                        &call.id,
                        format!("Failed to create directory: {e}"),
                    );
                }
            }
        }

        match std::fs::write(file_path, content) {
            Ok(()) => ToolResult::success(
                &call.id,
                format!("Successfully wrote {} bytes to {file_path}", content.len()),
            ),
            Err(e) => ToolResult::error(&call.id, format!("Failed to write {file_path}: {e}")),
        }
    }
}
