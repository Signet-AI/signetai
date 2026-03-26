use crate::context::ContextManager;
use crate::permissions::{PermissionManager, PermissionRequest, PermissionResponse};
use crate::session::SharedSession;
use forge_core::{Message, MessageContent, ToolCall, ToolDefinition, TokenUsage};
use forge_provider::{CompletionOpts, Provider, ReasoningEffort, StreamEvent};
use forge_signet::hooks::SessionHooks;
use forge_tools::{self, Tool as _};
use futures::StreamExt;
use std::collections::VecDeque;
use std::hash::{Hash, Hasher};
use std::sync::Arc;
use tokio::sync::{mpsc, Mutex};
use tracing::{debug, error, info, warn};

/// Events sent from the agent loop to the TUI
#[derive(Debug, Clone)]
pub enum AgentEvent {
    /// Streaming text from the assistant
    TextDelta(String),
    /// A tool is being called
    ToolStart { id: String, name: String },
    /// Tool execution result
    ToolResult {
        id: String,
        name: String,
        output: String,
        is_error: bool,
    },
    /// Tool needs permission approval — TUI must respond via PermissionRequest channel
    ToolApproval(String, String, serde_json::Value),
    /// Token usage update
    Usage(TokenUsage),
    /// Agent turn complete
    TurnComplete,
    /// Error occurred
    Error(String),
    /// Retroactive detail for a running tool call (e.g. file path, command)
    ToolDetail { id: String, name: String, detail: String },
    /// Thinking/status message
    Status(String),
    /// Memory injection count from prompt-submit hook
    MemoryCount(usize),
}

/// The core agentic loop
pub struct AgentLoop {
    provider: Arc<dyn Provider>,
    hooks: Option<SessionHooks>,
    event_tx: mpsc::Sender<AgentEvent>,
    /// Channel for sending permission requests to the TUI
    permission_tx: mpsc::Sender<PermissionRequest>,
    permissions: Arc<Mutex<PermissionManager>>,
    context_manager: ContextManager,
    system_prompt: String,
    /// Cached tool definitions — computed once, reused every loop iteration
    tool_definitions: Vec<ToolDefinition>,
    /// Current reasoning effort level (shared with TUI via Arc<Mutex>)
    effort: Arc<Mutex<ReasoningEffort>>,
    /// CLI permission bypass (shared with TUI via Arc<Mutex>)
    bypass: Arc<Mutex<bool>>,
    /// Signet daemon URL (for Signet native tools)
    daemon_url: Option<String>,
    /// Connected MCP servers (for external tool routing)
    mcp_clients: Vec<Arc<forge_mcp::McpStdioClient>>,
}

impl AgentLoop {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        provider: Arc<dyn Provider>,
        hooks: Option<SessionHooks>,
        event_tx: mpsc::Sender<AgentEvent>,
        permission_tx: mpsc::Sender<PermissionRequest>,
        permissions: Arc<Mutex<PermissionManager>>,
        system_prompt: String,
        effort: Arc<Mutex<ReasoningEffort>>,
        bypass: Arc<Mutex<bool>>,
        daemon_url: Option<String>,
        mcp_clients: Vec<Arc<forge_mcp::McpStdioClient>>,
    ) -> Self {
        let context_window = provider.context_window();
        let tool_definitions = match &daemon_url {
            Some(url) => forge_tools::all_definitions_with_subagent(url, Arc::clone(&provider)),
            None => {
                let mut defs = forge_tools::all_definitions();
                defs.push(forge_tools::subagent::SubAgentTool::new(Arc::clone(&provider)).definition());
                defs
            }
        };
        // MCP tool definitions are added later via async refresh
        let _ = &mcp_clients; // suppress unused warning until async init
        Self {
            provider,
            hooks,
            event_tx,
            permission_tx,
            permissions,
            context_manager: ContextManager::new(context_window),
            system_prompt,
            tool_definitions,
            effort,
            bypass,
            daemon_url,
            mcp_clients,
        }
    }

    /// Refresh MCP tool definitions from connected servers
    pub async fn refresh_mcp_tools(&mut self) {
        for client in &self.mcp_clients {
            match client.list_tools().await {
                Ok(tools) => {
                    self.tool_definitions.extend(tools);
                }
                Err(e) => {
                    tracing::warn!("Failed to list MCP tools: {e}");
                }
            }
        }
    }

    /// Process a user message through the full agentic loop
    pub async fn process_message(&self, session: &SharedSession, user_input: &str) {
        // 1. Add user message to session FIRST (independent of recall)
        {
            let mut s = session.lock().await;
            s.add_message(Message::user(user_input));
        }

        // 2. Run memory recall + provider preconnect in PARALLEL
        let mut memory_context = String::new();
        if let Some(hooks) = &self.hooks {
            let _ = self
                .event_tx
                .send(AgentEvent::Status("◇ Recalling memories...".to_string()))
                .await;

            // Overlap: recall memories while warming the provider connection
            let recall_future = hooks.prompt_submit(user_input);
            let preconnect_future = self.provider.preconnect();

            let (recall_result, _) = tokio::join!(recall_future, preconnect_future);

            match recall_result {
                Ok((injection, count)) if !injection.is_empty() => {
                    debug!(
                        "Memory injection: {} bytes, {} memories",
                        injection.len(),
                        count
                    );
                    let _ = self
                        .event_tx
                        .send(AgentEvent::MemoryCount(count))
                        .await;
                    memory_context = injection;
                }
                Ok(_) => {}
                Err(e) => {
                    debug!("Prompt hook failed (non-fatal): {e}");
                }
            }
        } else {
            // No daemon — still preconnect to provider
            self.provider.preconnect().await;
        }

        // Notify TUI that we're now waiting for the LLM
        let _ = self
            .event_tx
            .send(AgentEvent::Status("◆ Thinking...".to_string()))
            .await;

        // 3. Run the agentic loop
        let mut loop_detector = LoopDetector::new(3);
        loop {
            // Build system prompt with memory context
            let full_system = if memory_context.is_empty() {
                self.system_prompt.clone()
            } else {
                format!("{}\n\n{}", self.system_prompt, memory_context)
            };

            let current_effort = *self.effort.lock().await;
            let current_bypass = *self.bypass.lock().await;

            let opts = CompletionOpts {
                system_prompt: Some(full_system),
                max_tokens: Some(8192),
                effort: current_effort,
                bypass: current_bypass,
                ..Default::default()
            };

            // Get current messages snapshot
            let messages = {
                let s = session.lock().await;
                s.messages.clone()
            };

            // 4. Call the provider (using cached tool definitions)
            let stream = match self
                .provider
                .complete(&messages, &self.tool_definitions, &opts)
                .await
            {
                Ok(s) => s,
                Err(e) => {
                    error!("Provider error: {e}");
                    let _ = self.event_tx.send(AgentEvent::Error(e.to_string())).await;
                    return;
                }
            };

            // 5. Process the stream
            let mut assistant_text = String::new();
            let mut tool_calls: Vec<ToolCall> = Vec::new();
            let mut current_tool_id = String::new();
            let mut current_tool_name = String::new();
            let mut current_tool_input = String::new();

            let mut stream = std::pin::pin!(stream);

            while let Some(event) = stream.next().await {
                match event {
                    StreamEvent::TextDelta(text) => {
                        assistant_text.push_str(&text);
                        let _ = self.event_tx.send(AgentEvent::TextDelta(text)).await;
                    }
                    StreamEvent::ToolUseStart { id, name } => {
                        current_tool_id = id.clone();
                        current_tool_name = name.clone();
                        current_tool_input.clear();
                        let _ = self
                            .event_tx
                            .send(AgentEvent::ToolStart {
                                id: id.clone(),
                                name: name.clone(),
                            })
                            .await;
                    }
                    StreamEvent::ToolUseInput(json) => {
                        current_tool_input.push_str(&json);
                    }
                    StreamEvent::ToolUseEnd => {
                        let input: serde_json::Value =
                            match serde_json::from_str(&current_tool_input) {
                                Ok(v) => v,
                                Err(e) => {
                                    warn!(
                                        "Failed to parse tool input JSON for {}: {e}",
                                        current_tool_name
                                    );
                                    serde_json::Value::Object(Default::default())
                                }
                            };
                        // Send detail (file path, command, pattern) to TUI
                        if !current_tool_name.is_empty() {
                            if let Some(detail) = extract_tool_detail(&current_tool_name, &input) {
                                let _ = self.event_tx.send(AgentEvent::ToolDetail {
                                    id: current_tool_id.clone(),
                                    name: current_tool_name.clone(),
                                    detail,
                                }).await;
                            }
                        }
                        tool_calls.push(ToolCall {
                            id: current_tool_id.clone(),
                            name: current_tool_name.clone(),
                            input,
                        });
                    }
                    StreamEvent::ToolResult { name, output, is_error } => {
                        let _ = self.event_tx.send(AgentEvent::ToolResult {
                            id: String::new(),
                            name,
                            output,
                            is_error,
                        }).await;
                    }
                    StreamEvent::Usage(usage) => {
                        {
                            let mut s = session.lock().await;
                            s.total_input_tokens += usage.input_tokens;
                            s.total_output_tokens += usage.output_tokens;
                        }
                        let _ = self.event_tx.send(AgentEvent::Usage(usage)).await;
                    }
                    StreamEvent::Status(msg) => {
                        let _ = self.event_tx.send(AgentEvent::Status(msg)).await;
                    }
                    StreamEvent::Done => break,
                    StreamEvent::Error(e) => {
                        let _ = self.event_tx.send(AgentEvent::Error(e)).await;
                        return;
                    }
                }
            }

            // 6. Build assistant message with all content blocks
            let mut content = Vec::new();
            if !assistant_text.is_empty() {
                content.push(MessageContent::Text {
                    text: assistant_text,
                });
            }
            for tc in &tool_calls {
                content.push(MessageContent::ToolUse {
                    id: tc.id.clone(),
                    name: tc.name.clone(),
                    input: tc.input.clone(),
                });
            }

            let assistant_msg = Message {
                id: uuid::Uuid::new_v4().to_string(),
                role: forge_core::Role::Assistant,
                content,
                model: Some(self.provider.model().to_string()),
                usage: None,
            };
            {
                let mut s = session.lock().await;
                s.add_message(assistant_msg);
            }

            // 7. If no tool calls, we're done — check compaction first
            if tool_calls.is_empty() {
                let estimated_tokens = {
                    let s = session.lock().await;
                    ContextManager::estimate_tokens(&s.messages)
                };
                if self.context_manager.should_compact(estimated_tokens) {
                    let _ = self
                        .event_tx
                        .send(AgentEvent::Status("Compacting context...".to_string()))
                        .await;
                    if let Err(e) = self
                        .context_manager
                        .compact(session, &self.provider, self.hooks.as_ref())
                        .await
                    {
                        warn!("Context compaction failed: {e}");
                    }
                }
                let _ = self.event_tx.send(AgentEvent::TurnComplete).await;
                return;
            }

            // 8. Execute tool calls with permission checks
            let mut tool_results_content = Vec::new();
            for tc in &tool_calls {
                // Doom-loop detection: 3 identical consecutive calls → break
                if loop_detector.record(&tc.name, &tc.input) {
                    let msg = format!(
                        "Loop detected: '{}' called 3 times with identical input. Breaking.",
                        tc.name
                    );
                    warn!("{msg}");
                    let _ = self.event_tx.send(AgentEvent::ToolResult {
                        id: tc.id.clone(),
                        name: tc.name.clone(),
                        output: msg.clone(),
                        is_error: true,
                    }).await;
                    let _ = self.event_tx.send(AgentEvent::Error(msg)).await;
                    let _ = self.event_tx.send(AgentEvent::TurnComplete).await;
                    return;
                }
                let tool_impl = match &self.daemon_url {
                    Some(url) => forge_tools::find_tool_with_subagent(
                        &tc.name,
                        url,
                        Arc::clone(&self.provider),
                    ),
                    None => {
                        // Check built-in tools first, then SubAgent
                        forge_tools::find_tool(&tc.name).or_else(|| {
                            if tc.name == "SubAgent" {
                                Some(Box::new(forge_tools::subagent::SubAgentTool::new(
                                    Arc::clone(&self.provider),
                                )))
                            } else {
                                None
                            }
                        })
                    }
                };
                let permission_level = tool_impl
                    .as_ref()
                    .map(|t| t.permission())
                    .unwrap_or(forge_core::ToolPermission::Write);

                let approved = {
                    let perms = self.permissions.lock().await;
                    perms.is_auto_approved(&tc.name, permission_level)
                };

                if !approved {
                    let _ = self
                        .event_tx
                        .send(AgentEvent::ToolApproval(
                            tc.id.clone(),
                            tc.name.clone(),
                            tc.input.clone(),
                        ))
                        .await;

                    let (response_tx, response_rx) = tokio::sync::oneshot::channel();
                    let _ = self
                        .permission_tx
                        .send(PermissionRequest {
                            tool_name: tc.name.clone(),
                            tool_input: tc.input.clone(),
                            response_tx,
                        })
                        .await;

                    let response = match response_rx.await {
                        Ok(r) => r,
                        Err(_) => PermissionResponse::Deny,
                    };

                    match response {
                        PermissionResponse::Allow => {}
                        PermissionResponse::AlwaysAllow => {
                            let mut perms = self.permissions.lock().await;
                            perms.approve_for_session(&tc.name);
                        }
                        PermissionResponse::Deny => {
                            let result = forge_core::ToolResult::error(
                                &tc.id,
                                "Permission denied by user",
                            );
                            let _ = self
                                .event_tx
                                .send(AgentEvent::ToolResult {
                                    id: tc.id.clone(),
                                    name: tc.name.clone(),
                                    output: result.content.clone(),
                                    is_error: true,
                                })
                                .await;
                            tool_results_content.push(MessageContent::ToolResult {
                                tool_use_id: result.tool_use_id,
                                content: result.content,
                                is_error: result.is_error,
                            });
                            continue;
                        }
                    }
                }

                info!("Executing tool: {} (id: {})", tc.name, tc.id);

                let result = if let Some(tool) = tool_impl {
                    tool.execute(tc).await
                } else {
                    // Try MCP clients for tools not in the built-in registry
                    let mut mcp_result = None;
                    for client in &self.mcp_clients {
                        if let Ok(output) = client.call_tool(&tc.name, tc.input.clone()).await {
                            mcp_result = Some(forge_core::ToolResult::success(&tc.id, output));
                            break;
                        }
                    }
                    mcp_result.unwrap_or_else(|| {
                        forge_core::ToolResult::error(&tc.id, format!("Unknown tool: {}", tc.name))
                    })
                };

                let _ = self
                    .event_tx
                    .send(AgentEvent::ToolResult {
                        id: tc.id.clone(),
                        name: tc.name.clone(),
                        output: result.content.clone(),
                        is_error: result.is_error,
                    })
                    .await;

                tool_results_content.push(MessageContent::ToolResult {
                    tool_use_id: result.tool_use_id,
                    content: result.content,
                    is_error: result.is_error,
                });
            }

            // Add tool results as a user message (Anthropic convention)
            let tool_result_msg = Message {
                id: uuid::Uuid::new_v4().to_string(),
                role: forge_core::Role::User,
                content: tool_results_content,
                model: None,
                usage: None,
            };
            {
                let mut s = session.lock().await;
                s.add_message(tool_result_msg);
            }

            // Loop back for the next LLM call with tool results
            memory_context.clear();
        }
    }
}

/// Extract a human-readable detail string from a tool's input JSON.
fn extract_tool_detail(name: &str, input: &serde_json::Value) -> Option<String> {
    match name.to_lowercase().as_str() {
        "bash" | "shell" | "secret_exec" => {
            input.get("command").and_then(|v| v.as_str()).map(|cmd| {
                if cmd.len() > 80 { format!("{}...", &cmd[..77]) } else { cmd.to_string() }
            })
        }
        "read" => {
            let path = input.get("file_path").and_then(|v| v.as_str())?;
            let short = shorten_path(path);
            match (
                input.get("offset").and_then(|v| v.as_u64()),
                input.get("limit").and_then(|v| v.as_u64()),
            ) {
                (Some(o), Some(l)) => Some(format!("{short}:{o}-{}", o + l)),
                (Some(o), None) => Some(format!("{short}:{o}")),
                _ => Some(short),
            }
        }
        "write" | "edit" => {
            input.get("file_path").and_then(|v| v.as_str()).map(shorten_path)
        }
        "grep" => input.get("pattern").and_then(|v| v.as_str()).map(|p| {
            if p.len() > 60 { format!("{}...", &p[..57]) } else { p.to_string() }
        }),
        "glob" => input.get("pattern").and_then(|v| v.as_str()).map(String::from),
        "memory_search" => input.get("query").and_then(|v| v.as_str()).map(|q| {
            if q.len() > 60 { format!("{}...", &q[..57]) } else { q.to_string() }
        }),
        _ => None,
    }
}

fn shorten_path(path: &str) -> String {
    let parts: Vec<&str> = path.split('/').collect();
    if parts.len() <= 2 {
        path.to_string()
    } else {
        format!(".../{}/{}", parts[parts.len() - 2], parts[parts.len() - 1])
    }
}

/// Detects repeated identical tool calls (doom loops).
struct LoopDetector {
    recent: VecDeque<u64>,
    threshold: usize,
}

impl LoopDetector {
    fn new(threshold: usize) -> Self {
        Self { recent: VecDeque::with_capacity(threshold + 1), threshold }
    }

    /// Record a call. Returns `true` if the last N calls are all identical.
    fn record(&mut self, name: &str, input: &serde_json::Value) -> bool {
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        name.hash(&mut hasher);
        serde_json::to_string(input).unwrap_or_default().hash(&mut hasher);
        let hash = hasher.finish();

        self.recent.push_back(hash);
        if self.recent.len() > self.threshold {
            self.recent.pop_front();
        }
        self.recent.len() >= self.threshold && self.recent.iter().all(|&h| h == hash)
    }
}
