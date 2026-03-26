use crate::streaming::*;
use crate::{CompletionOpts, CompletionStream, Provider, StreamEvent};
use async_trait::async_trait;
use forge_core::{ForgeError, Message, MessageContent, Role, ToolDefinition, TokenUsage};
use futures::StreamExt;
use reqwest::Client;
use serde_json::{json, Value};
use tokio_stream::wrappers::ReceiverStream;
use tracing::{debug, error};

const ANTHROPIC_API_URL: &str = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION: &str = "2023-06-01";

pub struct AnthropicProvider {
    model: String,
    api_key: String,
    client: Client,
}

impl AnthropicProvider {
    pub fn new(model: String, api_key: String) -> Self {
        let client = Client::builder()
            .timeout(std::time::Duration::from_secs(300))
            .connect_timeout(std::time::Duration::from_secs(10))
            .pool_idle_timeout(std::time::Duration::from_secs(300))
            .pool_max_idle_per_host(4)
            .build()
            .unwrap_or_default();
        Self {
            model,
            api_key,
            client,
        }
    }

    fn build_messages(&self, messages: &[Message]) -> Vec<Value> {
        messages
            .iter()
            .filter(|m| m.role != Role::System)
            .map(|m| {
                let content: Vec<Value> = m
                    .content
                    .iter()
                    .map(|c| match c {
                        MessageContent::Text { text } => json!({
                            "type": "text",
                            "text": text,
                        }),
                        MessageContent::ToolUse { id, name, input } => json!({
                            "type": "tool_use",
                            "id": id,
                            "name": name,
                            "input": input,
                        }),
                        MessageContent::ToolResult {
                            tool_use_id,
                            content,
                            is_error,
                        } => json!({
                            "type": "tool_result",
                            "tool_use_id": tool_use_id,
                            "content": content,
                            "is_error": is_error,
                        }),
                    })
                    .collect();

                json!({
                    "role": match m.role {
                        Role::User => "user",
                        Role::Assistant => "assistant",
                        Role::System => unreachable!(),
                    },
                    "content": content,
                })
            })
            .collect()
    }

    fn build_tools(&self, tools: &[ToolDefinition]) -> Vec<Value> {
        tools
            .iter()
            .map(|t| {
                json!({
                    "name": t.name,
                    "description": t.description,
                    "input_schema": t.input_schema,
                })
            })
            .collect()
    }
}

#[async_trait]
impl Provider for AnthropicProvider {
    fn name(&self) -> &str {
        "anthropic"
    }

    fn model(&self) -> &str {
        &self.model
    }

    fn context_window(&self) -> usize {
        match self.model.as_str() {
            m if m.contains("opus") => 200_000,
            m if m.contains("sonnet") => 200_000,
            m if m.contains("haiku") => 200_000,
            _ => 200_000,
        }
    }

    async fn complete(
        &self,
        messages: &[Message],
        tools: &[ToolDefinition],
        opts: &CompletionOpts,
    ) -> Result<CompletionStream, ForgeError> {
        use crate::ReasoningEffort;

        // Adjust max_tokens and thinking based on effort level
        let (max_tokens, thinking_budget) = match opts.effort {
            ReasoningEffort::Low => (opts.max_tokens.unwrap_or(4096), None),
            ReasoningEffort::Medium => (opts.max_tokens.unwrap_or(8192), None),
            ReasoningEffort::High => (opts.max_tokens.unwrap_or(16384), Some(10000usize)),
        };

        let mut body = json!({
            "model": self.model,
            "max_tokens": max_tokens,
            "messages": self.build_messages(messages),
            "stream": true,
        });

        // Extended thinking for high effort
        if let Some(budget) = thinking_budget {
            body["thinking"] = json!({
                "type": "enabled",
                "budget_tokens": budget,
            });
        }

        if let Some(system) = &opts.system_prompt {
            body["system"] = json!([{
                "type": "text",
                "text": system,
                "cache_control": { "type": "ephemeral" }
            }]);
        }

        // Temperature — lower for high effort (more focused), higher for low
        let temp = opts.temperature.unwrap_or(match opts.effort {
            ReasoningEffort::Low => 0.3,
            ReasoningEffort::Medium => 0.7,
            ReasoningEffort::High => 0.5,
        });
        body["temperature"] = json!(temp);

        if !tools.is_empty() {
            body["tools"] = json!(self.build_tools(tools));
        }

        debug!("Sending request to Anthropic API: model={}", self.model);

        let response = self
            .client
            .post(ANTHROPIC_API_URL)
            .header("x-api-key", &self.api_key)
            .header("anthropic-version", ANTHROPIC_VERSION)
            .header("content-type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|e| ForgeError::provider(format!("HTTP error: {e}")))?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response
                .text()
                .await
                .unwrap_or_else(|_| "unknown error".to_string());
            return Err(ForgeError::provider(format!(
                "Anthropic API error ({status}): {body}"
            )));
        }

        let (tx, rx) = tokio::sync::mpsc::channel::<StreamEvent>(256);

        let mut byte_stream = response.bytes_stream();

        tokio::spawn(async move {
            let mut buffer = String::new();
            let mut input_tokens = 0usize;
            let mut output_tokens = 0usize;

            while let Some(chunk) = byte_stream.next().await {
                let chunk = match chunk {
                    Ok(c) => c,
                    Err(e) => {
                        let _ = tx.send(StreamEvent::Error(e.to_string())).await;
                        break;
                    }
                };

                buffer.push_str(&String::from_utf8_lossy(&chunk));

                // Process complete SSE events from buffer
                while let Some(event) = extract_sse_event(&mut buffer) {
                    if let Some(stream_event) =
                        parse_anthropic_event(&event, &mut input_tokens, &mut output_tokens)
                    {
                        let is_done = matches!(stream_event, StreamEvent::Done);
                        if tx.send(stream_event).await.is_err() {
                            return;
                        }
                        if is_done {
                            return;
                        }
                    }
                }
            }

            // Send final usage + done
            let _ = tx
                .send(StreamEvent::Usage(TokenUsage {
                    input_tokens,
                    output_tokens,
                    ..Default::default()
                }))
                .await;
            let _ = tx.send(StreamEvent::Done).await;
        });

        Ok(Box::pin(ReceiverStream::new(rx)))
    }

    async fn available(&self) -> bool {
        !self.api_key.is_empty()
    }

    async fn preconnect(&self) {
        // Warm the connection pool by sending a lightweight request.
        // reqwest pools HTTP/2 connections, so subsequent requests to the
        // same host reuse the existing TCP+TLS connection (~100-200ms saved).
        let _ = self
            .client
            .head(ANTHROPIC_API_URL)
            .header("x-api-key", &self.api_key)
            .send()
            .await;
    }
}

/// Extract a single SSE event from the buffer, returning the data payload
fn extract_sse_event(buffer: &mut String) -> Option<String> {
    // SSE events are separated by double newlines
    let end = buffer.find("\n\n")?;
    let raw = buffer[..end].to_string();
    buffer.drain(..end + 2);

    // Extract the "data: " line(s)
    let mut data = String::new();
    for line in raw.lines() {
        if let Some(payload) = line.strip_prefix("data: ") {
            if !data.is_empty() {
                data.push('\n');
            }
            data.push_str(payload);
        }
    }

    if data.is_empty() {
        None
    } else {
        Some(data)
    }
}

/// Parse an Anthropic SSE event into our StreamEvent
fn parse_anthropic_event(
    data: &str,
    input_tokens: &mut usize,
    output_tokens: &mut usize,
) -> Option<StreamEvent> {
    let event: AnthropicEvent = match serde_json::from_str(data) {
        Ok(e) => e,
        Err(e) => {
            error!("Failed to parse Anthropic event: {e}\nData: {data}");
            return None;
        }
    };

    match event {
        AnthropicEvent::MessageStart { message } => {
            if let Some(usage) = message.usage {
                *input_tokens = usage.input_tokens;
            }
            None
        }
        AnthropicEvent::ContentBlockStart { content_block, .. } => match content_block {
            ContentBlock::Text { .. } => None,
            ContentBlock::ToolUse { id, name, .. } => {
                Some(StreamEvent::ToolUseStart { id, name })
            }
        },
        AnthropicEvent::ContentBlockDelta { delta, .. } => match delta {
            ContentDelta::TextDelta { text } => Some(StreamEvent::TextDelta(text)),
            ContentDelta::InputJsonDelta { partial_json } => {
                Some(StreamEvent::ToolUseInput(partial_json))
            }
        },
        AnthropicEvent::ContentBlockStop { .. } => Some(StreamEvent::ToolUseEnd),
        AnthropicEvent::MessageDelta { usage, .. } => {
            if let Some(u) = usage {
                *output_tokens = u.output_tokens;
            }
            None
        }
        AnthropicEvent::MessageStop {} => Some(StreamEvent::Done),
        AnthropicEvent::Ping {} => None,
        AnthropicEvent::Error { error } => Some(StreamEvent::Error(format!(
            "{}: {}",
            error.error_type, error.message
        ))),
    }
}
