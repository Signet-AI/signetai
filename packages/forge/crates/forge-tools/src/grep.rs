use crate::Tool;
use async_trait::async_trait;
use forge_core::{ToolCall, ToolDefinition, ToolPermission, ToolResult};
use serde_json::json;
use tokio::process::Command;
use tracing::debug;

pub struct GrepTool;

#[async_trait]
impl Tool for GrepTool {
    fn name(&self) -> &str {
        "Grep"
    }

    fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: "Grep".to_string(),
            description: "Search file contents using regex patterns. Uses ripgrep if available, falls back to grep.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "pattern": {
                        "type": "string",
                        "description": "Regex pattern to search for"
                    },
                    "path": {
                        "type": "string",
                        "description": "File or directory to search in (defaults to current directory)"
                    },
                    "glob": {
                        "type": "string",
                        "description": "Filter files by glob pattern (e.g., '*.rs')"
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

        let path = call
            .input
            .get("path")
            .and_then(|v| v.as_str())
            .unwrap_or(".");

        let file_glob = call.input.get("glob").and_then(|v| v.as_str());

        debug!("Grepping: pattern={pattern}, path={path}");

        // Try ripgrep first, fall back to grep
        let mut cmd = if which_exists("rg") {
            let mut c = Command::new("rg");
            c.arg("--no-heading")
                .arg("--line-number")
                .arg("--max-count")
                .arg("100");
            if let Some(g) = file_glob {
                c.arg("--glob").arg(g);
            }
            c.arg(pattern).arg(path);
            c
        } else {
            let mut c = Command::new("grep");
            c.arg("-rn")
                .arg("--max-count=100")
                .arg(pattern)
                .arg(path);
            c
        };

        match cmd.output().await {
            Ok(output) => {
                let stdout = String::from_utf8_lossy(&output.stdout);
                if stdout.is_empty() {
                    ToolResult::success(&call.id, "No matches found.")
                } else {
                    ToolResult::success(&call.id, stdout.to_string())
                }
            }
            Err(e) => ToolResult::error(&call.id, format!("Grep failed: {e}")),
        }
    }
}

fn which_exists(cmd: &str) -> bool {
    std::process::Command::new("which")
        .arg(cmd)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}
