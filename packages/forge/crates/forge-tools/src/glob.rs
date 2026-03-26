use crate::Tool;
use async_trait::async_trait;
use forge_core::{ToolCall, ToolDefinition, ToolPermission, ToolResult};
use serde_json::json;
use tracing::debug;

pub struct GlobTool;

#[async_trait]
impl Tool for GlobTool {
    fn name(&self) -> &str {
        "Glob"
    }

    fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: "Glob".to_string(),
            description: "Find files matching a glob pattern.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "pattern": {
                        "type": "string",
                        "description": "The glob pattern to match (e.g., '**/*.rs', 'src/**/*.ts')"
                    },
                    "path": {
                        "type": "string",
                        "description": "Directory to search in (defaults to current directory)"
                    }
                },
                "required": ["pattern"]
            }),
        }
    }

    fn permission(&self) -> ToolPermission {
        ToolPermission::ReadOnly
    }

    async fn execute(&self, call: &ToolCall) -> ToolResult {
        let pattern = match call.input.get("pattern").and_then(|v| v.as_str()) {
            Some(p) => p,
            None => return ToolResult::error(&call.id, "Missing 'pattern' parameter"),
        };

        let base_path = call
            .input
            .get("path")
            .and_then(|v| v.as_str())
            .unwrap_or(".");

        let full_pattern = if pattern.starts_with('/') {
            pattern.to_string()
        } else {
            format!("{base_path}/{pattern}")
        };

        debug!("Globbing: {full_pattern}");

        match glob::glob(&full_pattern) {
            Ok(paths) => {
                let results: Vec<String> = paths
                    .filter_map(|p| p.ok())
                    .map(|p| p.display().to_string())
                    .take(1000)
                    .collect();

                if results.is_empty() {
                    ToolResult::success(&call.id, "No files matched the pattern.")
                } else {
                    ToolResult::success(&call.id, results.join("\n"))
                }
            }
            Err(e) => ToolResult::error(&call.id, format!("Invalid glob pattern: {e}")),
        }
    }
}
