use crate::Tool;
use async_trait::async_trait;
use forge_core::{ToolCall, ToolDefinition, ToolPermission, ToolResult};
use serde_json::json;
use tracing::debug;

pub struct EditTool;

#[async_trait]
impl Tool for EditTool {
    fn name(&self) -> &str {
        "Edit"
    }

    fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: "Edit".to_string(),
            description: "Perform exact string replacement in a file.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "file_path": {
                        "type": "string",
                        "description": "The absolute path to the file to modify"
                    },
                    "old_string": {
                        "type": "string",
                        "description": "The exact text to find and replace"
                    },
                    "new_string": {
                        "type": "string",
                        "description": "The text to replace it with"
                    },
                    "replace_all": {
                        "type": "boolean",
                        "description": "Replace all occurrences (default: false)"
                    }
                },
                "required": ["file_path", "old_string", "new_string"]
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

        let old_string = match call.input.get("old_string").and_then(|v| v.as_str()) {
            Some(s) => s,
            None => return ToolResult::error(&call.id, "Missing 'old_string' parameter"),
        };

        let new_string = match call.input.get("new_string").and_then(|v| v.as_str()) {
            Some(s) => s,
            None => return ToolResult::error(&call.id, "Missing 'new_string' parameter"),
        };

        let replace_all = call
            .input
            .get("replace_all")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        debug!("Editing file: {file_path}");

        let content = match std::fs::read_to_string(file_path) {
            Ok(c) => c,
            Err(e) => return ToolResult::error(&call.id, format!("Failed to read {file_path}: {e}")),
        };

        if !content.contains(old_string) {
            return ToolResult::error(
                &call.id,
                format!("old_string not found in {file_path}"),
            );
        }

        if !replace_all {
            let count = content.matches(old_string).count();
            if count > 1 {
                return ToolResult::error(
                    &call.id,
                    format!(
                        "old_string matches {count} times in {file_path}. Use replace_all=true or provide more context to make it unique."
                    ),
                );
            }
        }

        let new_content = if replace_all {
            content.replace(old_string, new_string)
        } else {
            content.replacen(old_string, new_string, 1)
        };

        match std::fs::write(file_path, &new_content) {
            Ok(()) => ToolResult::success(&call.id, format!("Successfully edited {file_path}")),
            Err(e) => ToolResult::error(&call.id, format!("Failed to write {file_path}: {e}")),
        }
    }
}
