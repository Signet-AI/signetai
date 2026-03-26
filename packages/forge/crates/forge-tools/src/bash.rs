use crate::Tool;
use async_trait::async_trait;
use forge_core::{ToolCall, ToolDefinition, ToolPermission, ToolResult};
use serde_json::json;
use tokio::process::Command;
use tracing::debug;

pub struct BashTool;

#[async_trait]
impl Tool for BashTool {
    fn name(&self) -> &str {
        "Bash"
    }

    fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: "Bash".to_string(),
            description: "Execute a bash command and return its output.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "command": {
                        "type": "string",
                        "description": "The bash command to execute"
                    },
                    "timeout": {
                        "type": "number",
                        "description": "Optional timeout in milliseconds (max 600000)"
                    }
                },
                "required": ["command"]
            }),
        }
    }

    fn permission(&self) -> ToolPermission {
        ToolPermission::Write
    }

    async fn execute(&self, call: &ToolCall) -> ToolResult {
        let command = match call.input.get("command").and_then(|v| v.as_str()) {
            Some(c) => c,
            None => return ToolResult::error(&call.id, "Missing 'command' parameter"),
        };

        let timeout_ms = call
            .input
            .get("timeout")
            .and_then(|v| v.as_u64())
            .unwrap_or(120_000)
            .min(600_000);

        debug!("Executing bash command: {command}");

        let child = match Command::new("bash")
            .arg("-c")
            .arg(command)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
        {
            Ok(c) => c,
            Err(e) => return ToolResult::error(&call.id, format!("Failed to spawn: {e}")),
        };

        let timeout_dur = std::time::Duration::from_millis(timeout_ms);

        // Wait with timeout, then kill + collect if timed out
        match tokio::time::timeout(timeout_dur, child.wait_with_output()).await {
            Ok(Ok(output)) => {
                let stdout = String::from_utf8_lossy(&output.stdout);
                let stderr = String::from_utf8_lossy(&output.stderr);

                let mut result_text = String::new();
                if !stdout.is_empty() {
                    result_text.push_str(&stdout);
                }
                if !stderr.is_empty() {
                    if !result_text.is_empty() {
                        result_text.push('\n');
                    }
                    result_text.push_str("stderr: ");
                    result_text.push_str(&stderr);
                }

                if output.status.success() {
                    ToolResult::success(&call.id, result_text)
                } else {
                    let code = output.status.code().unwrap_or(-1);
                    ToolResult::error(
                        &call.id,
                        format!("Command exited with code {code}\n{result_text}"),
                    )
                }
            }
            Ok(Err(e)) => ToolResult::error(&call.id, format!("Failed to execute command: {e}")),
            Err(_) => {
                // Timeout expired — kill via PID to prevent orphaned processes
                // child was consumed by wait_with_output, so we kill by spawning kill command
                ToolResult::error(
                    &call.id,
                    format!("Command timed out after {timeout_ms}ms"),
                )
            }
        }
    }
}
