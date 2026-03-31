use crate::context::ContextManager;
use crate::permissions::{PermissionManager, PermissionRequest, PermissionResponse};
use crate::retry::{RetryDecision, RetryState};
use crate::session::SharedSession;
use forge_core::{Message, MessageContent, ToolCall, ToolDefinition, TokenUsage};
use forge_provider::{CompletionOpts, CompletionStream, Provider, ReasoningEffort, StreamEvent};
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

        // Try to use Ollama as a cheap compaction provider.
        // Falls back to the primary model if Ollama isn't available.
        let compaction_provider: Option<Arc<dyn Provider>> = {
            let ollama = forge_provider::create_provider("ollama", "qwen3:4b", "ollama");
            match ollama {
                Ok(p) => {
                    info!("Ollama available — using qwen3:4b for context compaction");
                    Some(Arc::from(p))
                }
                Err(_) => None,
            }
        };

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
            context_manager: {
                let cm = ContextManager::new(context_window);
                match compaction_provider {
                    Some(p) => cm.with_compaction_provider(p),
                    None => cm,
                }
            },
            system_prompt,
            tool_definitions,
            effort,
            bypass,
            daemon_url,
            mcp_clients,
        }
    }

    /// Look up a tool's permission level by name
    fn resolve_tool_permission(&self, name: &str) -> forge_core::ToolPermission {
        match &self.daemon_url {
            Some(url) => forge_tools::find_tool_with_signet(name, url),
            None => forge_tools::find_tool(name),
        }
        .map(|t| t.permission())
        .unwrap_or(forge_core::ToolPermission::Write)
    }

    /// Call the provider with retry logic for transient failures.
    async fn call_provider_with_retry(
        &self,
        session: &SharedSession,
        messages: &[Message],
        opts: &CompletionOpts,
    ) -> Result<CompletionStream, forge_core::ForgeError> {
        let mut retry = RetryState::new();

        // First attempt uses the messages as-is
        let mut current_messages = messages.to_vec();

        loop {
            match self
                .provider
                .complete(&current_messages, &self.tool_definitions, opts)
                .await
            {
                Ok(stream) => return Ok(stream),
                Err(e) => match retry.decide(&e) {
                    RetryDecision::Retry(delay) => {
                        let _ = self
                            .event_tx
                            .send(AgentEvent::Status(format!(
                                "Provider error, retrying in {}s...",
                                delay.as_secs()
                            )))
                            .await;
                        tokio::time::sleep(delay).await;
                        // Re-read messages in case session was modified
                        current_messages = session.lock().await.messages.clone();
                    }
                    RetryDecision::CompactAndRetry => {
                        let _ = self
                            .event_tx
                            .send(AgentEvent::Status(
                                "Context overflow — compacting and retrying...".to_string(),
                            ))
                            .await;
                        if let Err(ce) = self
                            .context_manager
                            .compact(session, &self.provider, self.hooks.as_ref())
                            .await
                        {
                            warn!("Compaction failed during retry: {ce}");
                            return Err(e);
                        }
                        current_messages = session.lock().await.messages.clone();
                    }
                    RetryDecision::Fail => return Err(e),
                },
            }
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

            // Pre-sampling compaction: check token estimate BEFORE calling
            // the LLM. If we're approaching the context window limit, compact
            // first to avoid wasting an LLM call on an oversized prompt.
            {
                let estimated = {
                    let s = session.lock().await;
                    ContextManager::estimate_tokens(&s.messages)
                };
                if self.context_manager.should_compact_before_sampling(estimated) {
                    info!(
                        "Pre-sampling compaction: {} estimated tokens (~{}% of {})",
                        estimated,
                        (estimated as f64 / self.context_manager.max_tokens() as f64 * 100.0) as u32,
                        self.context_manager.max_tokens()
                    );
                    let _ = self
                        .event_tx
                        .send(AgentEvent::Status("Compacting context before next call...".to_string()))
                        .await;
                    if let Err(e) = self
                        .context_manager
                        .compact(session, &self.provider, self.hooks.as_ref())
                        .await
                    {
                        warn!("Pre-sampling compaction failed: {e}");
                    }
                }
            }

            // Get current messages snapshot
            let messages = {
                let s = session.lock().await;
                s.messages.clone()
            };

            // 4. Call the provider with retry logic
            let stream = match self
                .call_provider_with_retry(session, &messages, &opts)
                .await
            {
                Ok(s) => s,
                Err(e) => {
                    error!("Provider error (all retries exhausted): {e}");
                    let _ = self.event_tx.send(AgentEvent::Error(e.to_string())).await;
                    return;
                }
            };

            // 5. Process the stream with stale-stream detection.
            // If no events arrive for STALE_STREAM_SECS, warn the user.
            // If a second consecutive timeout occurs, cancel the stream.
            const STALE_STREAM_SECS: u64 = 90;

            let mut assistant_text = String::new();
            let mut tool_calls: Vec<ToolCall> = Vec::new();
            let mut current_tool_id = String::new();
            let mut current_tool_name = String::new();
            let mut current_tool_input = String::new();
            let mut stale_warnings: u32 = 0;

            let mut stream = std::pin::pin!(stream);

            loop {
                let event = tokio::select! {
                    next = stream.next() => next,
                    _ = tokio::time::sleep(std::time::Duration::from_secs(STALE_STREAM_SECS)) => {
                        stale_warnings += 1;
                        if stale_warnings >= 2 {
                            warn!("Stream stale for {}s (2nd timeout) — cancelling", STALE_STREAM_SECS * 2);
                            let _ = self.event_tx.send(AgentEvent::Error(
                                format!("No response for {}s — connection appears dead", STALE_STREAM_SECS * 2)
                            )).await;
                            return;
                        }
                        warn!("Stream stale for {STALE_STREAM_SECS}s — warning user");
                        let _ = self.event_tx.send(AgentEvent::Status(
                            format!("No response for {STALE_STREAM_SECS}s — connection may be stale")
                        )).await;
                        continue;
                    }
                };

                let event = match event {
                    Some(e) => {
                        stale_warnings = 0; // reset on any activity
                        e
                    }
                    None => break, // stream ended
                };

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

            // 8. Execute tool calls with permission checks.
            // Read-only tools are parallelized; write tools run sequentially.
            // Identical tool calls (same name + input) are deduplicated.
            let mut tool_results_content = Vec::new();

            // Deduplicate tool calls by (name, input) hash
            let mut seen_hashes = std::collections::HashSet::new();
            let mut deduped_calls: Vec<&ToolCall> = Vec::new();
            let mut dedup_map: std::collections::HashMap<u64, String> = std::collections::HashMap::new();
            for tc in &tool_calls {
                let mut hasher = std::collections::hash_map::DefaultHasher::new();
                tc.name.hash(&mut hasher);
                serde_json::to_string(&tc.input).unwrap_or_default().hash(&mut hasher);
                let hash = hasher.finish();
                if seen_hashes.insert(hash) {
                    deduped_calls.push(tc);
                } else {
                    // Map duplicate tool call ID to the original's ID for result reuse
                    if let Some(original_id) = dedup_map.get(&hash) {
                        debug!("Deduplicating tool call: {} (duplicate of {})", tc.id, original_id);
                    }
                }
                dedup_map.entry(hash).or_insert_with(|| tc.id.clone());
            }

            if deduped_calls.len() < tool_calls.len() {
                info!(
                    "Deduplicated {} → {} tool calls",
                    tool_calls.len(),
                    deduped_calls.len()
                );
            }

            // Partition into read-only (parallelizable) and write (sequential)
            let mut readonly_calls: Vec<&ToolCall> = Vec::new();
            let mut write_calls: Vec<&ToolCall> = Vec::new();

            for tc in &deduped_calls {
                // Doom-loop detection
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

                let permission = self.resolve_tool_permission(&tc.name);
                if permission == forge_core::ToolPermission::ReadOnly {
                    readonly_calls.push(tc);
                } else {
                    write_calls.push(tc);
                }
            }

            // Execute read-only tools in parallel
            if !readonly_calls.is_empty() {
                debug!("Executing {} read-only tools in parallel", readonly_calls.len());
                let mut handles = Vec::new();
                for tc in &readonly_calls {
                    let tc_owned = (*tc).clone();
                    let daemon_url = self.daemon_url.clone();
                    let provider = Arc::clone(&self.provider);
                    let mcp_clients = self.mcp_clients.clone();
                    handles.push(tokio::spawn(async move {
                        let tool = match &daemon_url {
                            Some(url) => forge_tools::find_tool_with_subagent(
                                &tc_owned.name, url, provider,
                            ),
                            None => forge_tools::find_tool(&tc_owned.name),
                        };
                        let result = if let Some(tool) = tool {
                            tool.execute(&tc_owned).await
                        } else {
                            let mut mcp_result = None;
                            for client in &mcp_clients {
                                if let Ok(output) = client.call_tool(&tc_owned.name, tc_owned.input.clone()).await {
                                    mcp_result = Some(forge_core::ToolResult::success(&tc_owned.id, output));
                                    break;
                                }
                            }
                            mcp_result.unwrap_or_else(|| {
                                forge_core::ToolResult::error(&tc_owned.id, format!("Unknown tool: {}", tc_owned.name))
                            })
                        };
                        (tc_owned, result)
                    }));
                }

                for handle in handles {
                    if let Ok((tc, result)) = handle.await {
                        let _ = self.event_tx.send(AgentEvent::ToolResult {
                            id: tc.id.clone(),
                            name: tc.name.clone(),
                            output: result.content.clone(),
                            is_error: result.is_error,
                        }).await;
                        tool_results_content.push(MessageContent::ToolResult {
                            tool_use_id: result.tool_use_id,
                            content: result.content,
                            is_error: result.is_error,
                        });
                    }
                }
            }

            // Execute write tools sequentially with permission checks
            for tc in &write_calls {
                let tool_impl = match &self.daemon_url {
                    Some(url) => forge_tools::find_tool_with_subagent(
                        &tc.name, url, Arc::clone(&self.provider),
                    ),
                    None => {
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
