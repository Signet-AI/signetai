use crate::Tool;
use async_trait::async_trait;
use forge_core::{ToolCall, ToolDefinition, ToolPermission, ToolResult};
use forge_provider::{CompletionOpts, Provider, StreamEvent};
use futures::StreamExt;
use serde_json::json;
use std::sync::Arc;
use tracing::{debug, warn};

/// Sub-agent tool — spawns a restricted research agent with limited tools.
///
/// The sub-agent calls the same provider but with a constrained system prompt
/// and no tool access (pure text completion for research tasks).
pub struct SubAgentTool {
    provider: Arc<dyn Provider>,
}

impl SubAgentTool {
    pub fn new(provider: Arc<dyn Provider>) -> Self {
        Self { provider }
    }
}

/// Allowed read-only tools that a sub-agent can request (for documentation only;
/// the sub-agent runs as a single completion call without actual tool execution).
const ALLOWED_TOOLS: &[&str] = &["Read", "Glob", "Grep"];

#[async_trait]
impl Tool for SubAgentTool {
    fn name(&self) -> &str {
        "SubAgent"
    }

    fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: "SubAgent".to_string(),
            description: "Spawn a restricted sub-agent for research tasks. The sub-agent uses \
                the same model but runs a single completion with no tool access. Use this for \
                quick research, analysis, or summarization that doesn't need file operations."
                .to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "task": {
                        "type": "string",
                        "description": "The research task or question for the sub-agent to answer"
                    },
                    "tools": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "Optional list of tools to allow (currently informational only). Defaults to [\"Read\", \"Glob\", \"Grep\"]."
                    }
                },
                "required": ["task"]
            }),
        }
    }

    fn permission(&self) -> ToolPermission {
        ToolPermission::Write
    }

    async fn execute(&self, call: &ToolCall) -> ToolResult {
        let task = match call.input.get("task").and_then(|v| v.as_str()) {
            Some(t) => t,
            None => return ToolResult::error(&call.id, "Missing 'task' parameter"),
        };

        // Validate requested tools (informational — logged but not enforced since
        // the sub-agent runs as a pure completion without tool dispatch)
        let requested_tools: Vec<String> = call
            .input
            .get("tools")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_else(|| ALLOWED_TOOLS.iter().map(|s| s.to_string()).collect());

        for tool in &requested_tools {
            if !ALLOWED_TOOLS.contains(&tool.as_str()) {
                warn!("SubAgent: requested tool '{}' is not in the allowed set", tool);
            }
        }

        debug!(
            "SubAgent: running task ({} chars) with tools {:?}",
            task.len(),
            requested_tools
        );

        // Build a minimal conversation: system prompt + user task
        let system_prompt = format!(
            "You are a research sub-agent. Answer the following task concisely and accurately. \
             Focus on facts and direct answers. Do not ask follow-up questions.\n\
             \n\
             Available tools (for context): {}",
            requested_tools.join(", ")
        );

        let messages = vec![forge_core::Message::user(task)];

        let opts = CompletionOpts {
            system_prompt: Some(system_prompt),
            max_tokens: Some(4096),
            ..Default::default()
        };

        // Run the completion with a 60-second timeout
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(60),
            self.run_completion(&messages, &opts),
        )
        .await;

        match result {
            Ok(Ok(response)) => {
                if response.is_empty() {
                    ToolResult::error(&call.id, "Sub-agent returned empty response")
                } else {
                    ToolResult::success(&call.id, response)
                }
            }
            Ok(Err(e)) => ToolResult::error(&call.id, format!("Sub-agent error: {e}")),
            Err(_) => ToolResult::error(&call.id, "Sub-agent timed out (60s limit)"),
        }
    }
}

impl SubAgentTool {
    /// Run a single completion and collect the text response
    async fn run_completion(
        &self,
        messages: &[forge_core::Message],
        opts: &CompletionOpts,
    ) -> Result<String, String> {
        // No tools — the sub-agent is pure text completion
        let tools = Vec::new();

        let stream = self
            .provider
            .complete(messages, &tools, opts)
            .await
            .map_err(|e| format!("Provider error: {e}"))?;

        let mut stream = std::pin::pin!(stream);
        let mut response = String::new();

        while let Some(event) = stream.next().await {
            match event {
                StreamEvent::TextDelta(text) => {
                    response.push_str(&text);
                }
                StreamEvent::Error(e) => {
                    return Err(format!("Stream error: {e}"));
                }
                StreamEvent::Done => break,
                _ => {}
            }
        }

        Ok(response)
    }
}
