use crate::Tool;
use crate::policy::WorkspacePolicy;
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
        let policy = WorkspacePolicy::from_env();
        let file_path = match policy.ensure_path_allowed(file_path) {
            Ok(p) => p,
            Err(e) => return ToolResult::error(&call.id, e),
        };

        let content = match call.input.get("content").and_then(|v| v.as_str()) {
            Some(c) => c,
            None => return ToolResult::error(&call.id, "Missing 'content' parameter"),
        };

        debug!("Writing file: {} ({} bytes)", file_path.display(), content.len());

        // Create parent directories if needed
        if let Some(parent) = Path::new(&file_path).parent() {
            if !parent.exists() {
                if let Err(e) = std::fs::create_dir_all(parent) {
                    return ToolResult::error(
                        &call.id,
                        format!("Failed to create directory: {e}"),
                    );
                }
            }
        }

        match std::fs::write(&file_path, content) {
            Ok(()) => ToolResult::success(
                &call.id,
                format!("Successfully wrote {} bytes to {}", content.len(), file_path.display()),
            ),
            Err(e) => ToolResult::error(&call.id, format!("Failed to write {}: {e}", file_path.display())),
        }
    }
}
