use crate::{CompletionOpts, CompletionStream, Provider, StreamEvent};
use async_trait::async_trait;
use forge_core::{ForgeError, Message, MessageContent, Role, ToolDefinition, TokenUsage};
use futures::StreamExt;
use reqwest::Client;
use serde_json::{json, Value};
use tokio_stream::wrappers::ReceiverStream;
use tracing::{debug, error};

const GEMINI_API_URL: &str = "https://generativelanguage.googleapis.com/v1beta/models";

pub struct GeminiProvider {
    model: String,
    api_key: String,
    client: Client,
}

impl GeminiProvider {
    pub fn new(model: String, api_key: String) -> Self {
        let client = Client::builder()
            .timeout(std::time::Duration::from_secs(300))
            .connect_timeout(std::time::Duration::from_secs(10))
            .build()
            .unwrap_or_default();
        Self {
            model,
            api_key,
            client,
        }
    }

    fn build_contents(&self, messages: &[Message]) -> Vec<Value> {
        messages
            .iter()
            .filter(|m| m.role != Role::System)
            .map(|m| {
                let role = match m.role {
                    Role::User => "user",
                    Role::Assistant => "model",
                    Role::System => unreachable!(),
                };

                let parts: Vec<Value> = m
                    .content
                    .iter()
                    .map(|c| match c {
                        MessageContent::Text { text } => json!({ "text": text }),
                        MessageContent::ToolUse { name, input, .. } => json!({
                            "functionCall": {
                                "name": name,
                                "args": input,
                            }
                        }),
                        MessageContent::ToolResult {
                            tool_use_id: _,
                            content,
                            ..
                        } => json!({
                            "functionResponse": {
                                "name": "tool",
                                "response": { "result": content },
                            }
                        }),
                    })
                    .collect();

                json!({
                    "role": role,
                    "parts": parts,
                })
            })
            .collect()
    }

    fn build_tools(&self, tools: &[ToolDefinition]) -> Value {
        let declarations: Vec<Value> = tools
            .iter()
            .map(|t| {
                json!({
                    "name": t.name,
                    "description": t.description,
                    "parameters": t.input_schema,
                })
            })
            .collect();

        json!([{ "functionDeclarations": declarations }])
    }
}

#[async_trait]
impl Provider for GeminiProvider {
    fn name(&self) -> &str {
        "gemini"
    }

    fn model(&self) -> &str {
        &self.model
    }

    fn context_window(&self) -> usize {
        match self.model.as_str() {
            m if m.contains("pro") => 1_000_000,
            m if m.contains("flash") => 1_000_000,
            _ => 128_000,
        }
    }

    async fn complete(
        &self,
        messages: &[Message],
        tools: &[ToolDefinition],
        opts: &CompletionOpts,
    ) -> Result<CompletionStream, ForgeError> {
        let mut body = json!({
            "contents": self.build_contents(messages),
        });

        // System instruction
        if let Some(system) = &opts.system_prompt {
            body["systemInstruction"] = json!({
                "parts": [{ "text": system }]
            });
        }

        // Generation config
        let mut gen_config = json!({});
        if let Some(max_tokens) = opts.max_tokens {
            gen_config["maxOutputTokens"] = json!(max_tokens);
        }
        if let Some(temp) = opts.temperature {
            gen_config["temperature"] = json!(temp);
        }
        body["generationConfig"] = gen_config;

        if !tools.is_empty() {
            body["tools"] = self.build_tools(tools);
        }

        let url = format!(
            "{}/{}:streamGenerateContent?alt=sse",
            GEMINI_API_URL, self.model
        );

        debug!("Sending request to Gemini API: model={}", self.model);

        let response = self
            .client
            .post(&url)
            .header("Content-Type", "application/json")
            .header("x-goog-api-key", &self.api_key)
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
                "Gemini API error ({status}): {body}"
            )));
        }

        let (tx, rx) = tokio::sync::mpsc::channel::<StreamEvent>(256);
        let mut byte_stream = response.bytes_stream();

        tokio::spawn(async move {
            let mut buffer = String::new();

            while let Some(chunk) = byte_stream.next().await {
                let chunk = match chunk {
                    Ok(c) => c,
                    Err(e) => {
                        let _ = tx.send(StreamEvent::Error(e.to_string())).await;
                        break;
                    }
                };

                buffer.push_str(&String::from_utf8_lossy(&chunk));

                while let Some(data) = extract_sse_data(&mut buffer) {
                    for event in parse_gemini_chunk(&data) {
                        let is_done = matches!(event, StreamEvent::Done);
                        if tx.send(event).await.is_err() {
                            return;
                        }
                        if is_done {
                            return;
                        }
                    }
                }
            }

            let _ = tx.send(StreamEvent::Done).await;
        });

        Ok(Box::pin(ReceiverStream::new(rx)))
    }

    async fn available(&self) -> bool {
        !self.api_key.is_empty()
    }
}

fn extract_sse_data(buffer: &mut String) -> Option<String> {
    let end = buffer.find("\n\n")?;
    let raw = buffer[..end].to_string();
    buffer.drain(..end + 2);

    for line in raw.lines() {
        if let Some(payload) = line.strip_prefix("data: ") {
            return Some(payload.to_string());
        }
    }
    None
}

/// Gemini sends complete function calls in one chunk (not streamed like Anthropic).
/// We need to emit ToolUseStart + ToolUseInput + ToolUseEnd as separate events.
fn parse_gemini_chunk(data: &str) -> Vec<StreamEvent> {
    let chunk: Value = match serde_json::from_str(data) {
        Ok(v) => v,
        Err(e) => {
            error!("Failed to parse Gemini chunk: {e}");
            return vec![];
        }
    };

    let mut events = Vec::new();

    // Check for candidates
    if let Some(candidates) = chunk.get("candidates").and_then(|c| c.as_array()) {
        if let Some(candidate) = candidates.first() {
            if let Some(parts) = candidate
                .get("content")
                .and_then(|c| c.get("parts"))
                .and_then(|p| p.as_array())
            {
                for part in parts {
                    // Text content
                    if let Some(text) = part.get("text").and_then(|t| t.as_str()) {
                        events.push(StreamEvent::TextDelta(text.to_string()));
                    }

                    // Function call — emit all three events
                    if let Some(fc) = part.get("functionCall") {
                        let name = fc
                            .get("name")
                            .and_then(|n| n.as_str())
                            .unwrap_or("unknown");
                        let args = fc.get("args").cloned().unwrap_or(json!({}));
                        let args_str = args.to_string();

                        events.push(StreamEvent::ToolUseStart {
                            id: format!("gemini-{}", uuid::Uuid::new_v4()),
                            name: name.to_string(),
                        });
                        events.push(StreamEvent::ToolUseInput(args_str));
                        events.push(StreamEvent::ToolUseEnd);
                    }
                }
            }
        }
    }

    // Check usage metadata
    if let Some(metadata) = chunk.get("usageMetadata") {
        let input = metadata
            .get("promptTokenCount")
            .and_then(|v| v.as_u64())
            .unwrap_or(0) as usize;
        let output = metadata
            .get("candidatesTokenCount")
            .and_then(|v| v.as_u64())
            .unwrap_or(0) as usize;
        if input > 0 || output > 0 {
            events.push(StreamEvent::Usage(TokenUsage {
                input_tokens: input,
                output_tokens: output,
                ..Default::default()
            }));
        }
    }

    events
}
