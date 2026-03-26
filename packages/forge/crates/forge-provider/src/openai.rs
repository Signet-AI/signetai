use crate::{CompletionOpts, CompletionStream, Provider, StreamEvent};
use async_trait::async_trait;
use forge_core::{ForgeError, Message, MessageContent, Role, ToolDefinition, TokenUsage};
use futures::StreamExt;
use reqwest::Client;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio_stream::wrappers::ReceiverStream;
use tracing::{debug, error};

/// Generic OpenAI-compatible provider — works with OpenAI, Groq, Ollama, OpenRouter, xAI
pub struct OpenAIProvider {
    provider_name: String,
    model: String,
    api_key: String,
    base_url: String,
    context_window: usize,
    client: Client,
    extra_headers: Vec<(String, String)>,
}

impl OpenAIProvider {
    pub fn new(
        provider_name: impl Into<String>,
        model: impl Into<String>,
        api_key: impl Into<String>,
        base_url: impl Into<String>,
        context_window: usize,
    ) -> Self {
        let client = Client::builder()
            .timeout(std::time::Duration::from_secs(300))
            .connect_timeout(std::time::Duration::from_secs(10))
            .build()
            .unwrap_or_default();
        Self {
            provider_name: provider_name.into(),
            model: model.into(),
            api_key: api_key.into(),
            base_url: base_url.into(),
            context_window,
            client,
            extra_headers: Vec::new(),
        }
    }

    pub fn with_header(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.extra_headers.push((key.into(), value.into()));
        self
    }

    fn build_messages(&self, messages: &[Message], system: Option<&str>) -> Vec<Value> {
        let mut result = Vec::new();

        if let Some(sys) = system {
            result.push(json!({
                "role": "system",
                "content": sys,
            }));
        }

        for m in messages {
            match m.role {
                Role::System => continue, // handled above
                Role::User => {
                    // Check if this is a tool result message
                    let tool_results: Vec<&MessageContent> = m
                        .content
                        .iter()
                        .filter(|c| matches!(c, MessageContent::ToolResult { .. }))
                        .collect();

                    if !tool_results.is_empty() {
                        for tr in tool_results {
                            if let MessageContent::ToolResult {
                                tool_use_id,
                                content,
                                ..
                            } = tr
                            {
                                result.push(json!({
                                    "role": "tool",
                                    "tool_call_id": tool_use_id,
                                    "content": content,
                                }));
                            }
                        }
                    } else {
                        let text = m.text();
                        if !text.is_empty() {
                            result.push(json!({
                                "role": "user",
                                "content": text,
                            }));
                        }
                    }
                }
                Role::Assistant => {
                    let mut msg = json!({
                        "role": "assistant",
                    });

                    let text = m.text();
                    if !text.is_empty() {
                        msg["content"] = json!(text);
                    }

                    // Add tool calls if present
                    let tool_uses: Vec<Value> = m
                        .content
                        .iter()
                        .filter_map(|c| match c {
                            MessageContent::ToolUse { id, name, input } => Some(json!({
                                "id": id,
                                "type": "function",
                                "function": {
                                    "name": name,
                                    "arguments": input.to_string(),
                                }
                            })),
                            _ => None,
                        })
                        .collect();

                    if !tool_uses.is_empty() {
                        msg["tool_calls"] = json!(tool_uses);
                    }

                    result.push(msg);
                }
            }
        }

        result
    }

    fn build_tools(&self, tools: &[ToolDefinition]) -> Vec<Value> {
        tools
            .iter()
            .map(|t| {
                json!({
                    "type": "function",
                    "function": {
                        "name": t.name,
                        "description": t.description,
                        "parameters": t.input_schema,
                    }
                })
            })
            .collect()
    }
}

#[async_trait]
impl Provider for OpenAIProvider {
    fn name(&self) -> &str {
        &self.provider_name
    }

    fn model(&self) -> &str {
        &self.model
    }

    fn context_window(&self) -> usize {
        self.context_window
    }

    async fn complete(
        &self,
        messages: &[Message],
        tools: &[ToolDefinition],
        opts: &CompletionOpts,
    ) -> Result<CompletionStream, ForgeError> {
        let mut body = json!({
            "model": self.model,
            "messages": self.build_messages(messages, opts.system_prompt.as_deref()),
            "stream": true,
        });

        if let Some(max_tokens) = opts.max_tokens {
            body["max_tokens"] = json!(max_tokens);
        }

        if let Some(temp) = opts.temperature {
            body["temperature"] = json!(temp);
        }

        if !tools.is_empty() {
            body["tools"] = json!(self.build_tools(tools));
        }

        debug!(
            "Sending request to {} API: model={}",
            self.provider_name, self.model
        );

        let mut req = self
            .client
            .post(format!("{}/chat/completions", self.base_url))
            .header("Authorization", format!("Bearer {}", self.api_key))
            .header("Content-Type", "application/json");

        for (key, value) in &self.extra_headers {
            req = req.header(key.as_str(), value.as_str());
        }

        let response = req
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
                "{} API error ({status}): {body}",
                self.provider_name
            )));
        }

        let (tx, rx) = tokio::sync::mpsc::channel::<StreamEvent>(256);
        let mut byte_stream = response.bytes_stream();
        let provider_name = self.provider_name.clone();

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
                    if data == "[DONE]" {
                        let _ = tx.send(StreamEvent::Done).await;
                        return;
                    }

                    if let Some(event) = parse_openai_chunk(&data, &provider_name) {
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

#[derive(Debug, Deserialize)]
struct OpenAIChunk {
    choices: Vec<ChunkChoice>,
    #[serde(default)]
    usage: Option<OpenAIUsage>,
}

#[derive(Debug, Deserialize)]
struct ChunkChoice {
    delta: ChunkDelta,
    #[serde(default)]
    finish_reason: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ChunkDelta {
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    tool_calls: Option<Vec<ChunkToolCall>>,
}

#[derive(Debug, Deserialize)]
struct ChunkToolCall {
    #[serde(default)]
    #[allow(dead_code)]
    index: usize,
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    function: Option<ChunkFunction>,
}

#[derive(Debug, Deserialize)]
struct ChunkFunction {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    arguments: Option<String>,
}

#[derive(Debug, Deserialize)]
struct OpenAIUsage {
    prompt_tokens: usize,
    completion_tokens: usize,
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

fn parse_openai_chunk(data: &str, provider_name: &str) -> Option<StreamEvent> {
    let chunk: OpenAIChunk = match serde_json::from_str(data) {
        Ok(c) => c,
        Err(e) => {
            error!("Failed to parse {provider_name} chunk: {e}");
            return None;
        }
    };

    if let Some(usage) = chunk.usage {
        return Some(StreamEvent::Usage(TokenUsage {
            input_tokens: usage.prompt_tokens,
            output_tokens: usage.completion_tokens,
            ..Default::default()
        }));
    }

    let choice = chunk.choices.first()?;

    // Text content
    if let Some(content) = &choice.delta.content {
        if !content.is_empty() {
            return Some(StreamEvent::TextDelta(content.clone()));
        }
    }

    // Tool calls
    if let Some(tool_calls) = &choice.delta.tool_calls {
        for tc in tool_calls {
            if let Some(id) = &tc.id {
                // New tool call starting
                let name = tc
                    .function
                    .as_ref()
                    .and_then(|f| f.name.clone())
                    .unwrap_or_default();
                return Some(StreamEvent::ToolUseStart {
                    id: id.clone(),
                    name,
                });
            }
            if let Some(func) = &tc.function {
                if let Some(args) = &func.arguments {
                    if !args.is_empty() {
                        return Some(StreamEvent::ToolUseInput(args.clone()));
                    }
                }
            }
        }
    }

    // Check finish reason
    if let Some(reason) = &choice.finish_reason {
        if reason == "tool_calls" {
            return Some(StreamEvent::ToolUseEnd);
        }
    }

    None
}

// ---- Convenience constructors for specific providers ----

pub fn openai(model: &str, api_key: &str) -> OpenAIProvider {
    let ctx = match model {
        m if m.contains("gpt-4o") => 128_000,
        m if m.contains("gpt-4") => 128_000,
        m if m.contains("o1") || m.contains("o3") || m.contains("o4") => 200_000,
        _ => 128_000,
    };
    OpenAIProvider::new("openai", model, api_key, "https://api.openai.com/v1", ctx)
}

pub fn groq(model: &str, api_key: &str) -> OpenAIProvider {
    OpenAIProvider::new(
        "groq",
        model,
        api_key,
        "https://api.groq.com/openai/v1",
        32_768,
    )
}

pub fn ollama(model: &str) -> OpenAIProvider {
    OpenAIProvider::new(
        "ollama",
        model,
        "ollama", // Ollama doesn't need a key
        "http://localhost:11434/v1",
        32_768,
    )
}

pub fn openrouter(model: &str, api_key: &str) -> OpenAIProvider {
    OpenAIProvider::new(
        "openrouter",
        model,
        api_key,
        "https://openrouter.ai/api/v1",
        128_000,
    )
    .with_header("HTTP-Referer", "https://github.com/Signet-AI/signetai")
    .with_header("X-Title", "Signet Forge")
}

pub fn xai(model: &str, api_key: &str) -> OpenAIProvider {
    OpenAIProvider::new(
        "xai",
        model,
        api_key,
        "https://api.x.ai/v1",
        128_000,
    )
}
