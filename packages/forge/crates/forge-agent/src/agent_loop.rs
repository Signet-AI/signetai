use crate::context::ContextManager;
use crate::permissions::{PermissionManager, PermissionRequest, PermissionResponse};
use crate::retry::{RetryDecision, RetryState};
use crate::session::SharedSession;
use forge_core::{
    Message, MessageContent, PolicyBlockReason, TaskEventEnvelope, TaskKind, TaskPhase, ToolCall,
    ToolDefinition, TokenUsage,
};
use forge_provider::{CompletionOpts, CompletionStream, Provider, ReasoningEffort, StreamEvent};
use forge_signet::hooks::SessionHooks;
use forge_tools::{self, Tool as _};
use futures::StreamExt;
use std::collections::VecDeque;
use std::hash::{Hash, Hasher};
use std::net::{SocketAddr, TcpStream};
use std::sync::Arc;
use tokio::sync::{mpsc, Mutex};
use tracing::{debug, error, info, warn};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ContextTier {
    Hot,
    Warm,
    Cold,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum McpCallOutcome {
    Success,
    TimedOut,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TurnPlan {
    Short,
    Normal,
    Deep,
}

impl TurnPlan {
    fn max_tokens(self) -> usize {
        match self {
            Self::Short => 4_096,
            Self::Normal => 8_192,
            Self::Deep => 12_288,
        }
    }

    fn effort(self) -> ReasoningEffort {
        match self {
            Self::Short => ReasoningEffort::Low,
            Self::Normal => ReasoningEffort::Medium,
            Self::Deep => ReasoningEffort::High,
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Short => "short",
            Self::Normal => "normal",
            Self::Deep => "deep",
        }
    }
}

#[derive(Debug, Default)]
struct AdaptiveTuning {
    llm_latency_ms: VecDeque<u64>,
    tool_result_sizes: VecDeque<usize>,
    tool_truncations: VecDeque<bool>,
}

impl AdaptiveTuning {
    const MAX_POINTS: usize = 32;

    fn record_llm_latency(&mut self, ms: u64) {
        self.llm_latency_ms.push_back(ms);
        if self.llm_latency_ms.len() > Self::MAX_POINTS {
            self.llm_latency_ms.pop_front();
        }
    }

    fn record_tool_result(&mut self, original_chars: usize, truncated: bool) {
        self.tool_result_sizes.push_back(original_chars);
        if self.tool_result_sizes.len() > Self::MAX_POINTS {
            self.tool_result_sizes.pop_front();
        }
        self.tool_truncations.push_back(truncated);
        if self.tool_truncations.len() > Self::MAX_POINTS {
            self.tool_truncations.pop_front();
        }
    }

    fn p95_llm_ms(&self) -> Option<u64> {
        percentile_u64(&self.llm_latency_ms, 0.95)
    }

    fn truncation_rate(&self) -> f64 {
        if self.tool_truncations.is_empty() {
            return 0.0;
        }
        let trues = self.tool_truncations.iter().filter(|&&v| v).count() as f64;
        trues / self.tool_truncations.len() as f64
    }

    fn recommended_tool_chars(&self) -> usize {
        let p95 = self.p95_llm_ms().unwrap_or(0);
        let trunc = self.truncation_rate();
        if p95 > 12_000 {
            8_000
        } else if trunc > 0.40 {
            14_000
        } else if p95 < 4_000 && trunc < 0.10 {
            13_000
        } else {
            12_000
        }
    }
}

#[derive(Debug, Clone)]
struct ClampedToolOutput {
    content: String,
    original_len: usize,
    truncated: bool,
}

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
    /// Structured task telemetry envelope (turn/tool lifecycle)
    TaskTelemetry(TaskEventEnvelope),
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
    /// Rolling performance telemetry for adaptive phase-3 tuning
    tuning: Arc<Mutex<AdaptiveTuning>>,
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
            if ollama_compaction_reachable() {
                let ollama = forge_provider::create_provider("ollama", "qwen3:4b", "ollama");
                match ollama {
                    Ok(p) => {
                        info!("Ollama endpoint reachable; enabling compaction offload");
                        Some(Arc::from(p))
                    }
                    Err(err) => {
                        debug!("Failed to construct Ollama compaction provider: {err}");
                        None
                    }
                }
            } else {
                debug!("Ollama endpoint unavailable; compaction will use primary provider");
                None
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
            tuning: Arc::new(Mutex::new(AdaptiveTuning::default())),
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

    async fn emit_task(&self, evt: TaskEventEnvelope) {
        let _ = self.event_tx.send(AgentEvent::TaskTelemetry(evt.clone())).await;
        if let Some(hooks) = &self.hooks {
            let hooks = hooks.clone();
            let event = evt;
            let timeout = timeout_from_env("FORGE_TASK_TELEMETRY_TIMEOUT_MS", 150, 50, 2_000);
            tokio::spawn(async move {
                let _ = tokio::time::timeout(timeout, hooks.task_telemetry(&event)).await;
            });
        }
    }

    fn hook_timeout() -> std::time::Duration {
        timeout_from_env("FORGE_HOOK_TIMEOUT_MS", 1_200, 100, 10_000)
    }

    async fn run_pre_turn_hook(&self, user_input: &str) {
        let Some(hooks) = &self.hooks else {
            return;
        };
        let timeout = Self::hook_timeout();
        match tokio::time::timeout(timeout, hooks.pre_turn(user_input)).await {
            Ok(Ok(())) => {}
            Ok(Err(e)) => {
                debug!("pre-turn hook failed (isolated): {e}");
            }
            Err(_) => {
                debug!("pre-turn hook timed out after {:?}", timeout);
            }
        }
    }

    async fn run_pre_tool_hook(&self, tool_name: &str, tool_input: &serde_json::Value) {
        let Some(hooks) = &self.hooks else {
            return;
        };
        let timeout = Self::hook_timeout();
        match tokio::time::timeout(timeout, hooks.pre_tool(tool_name, tool_input)).await {
            Ok(Ok(())) => {}
            Ok(Err(e)) => {
                debug!("pre-tool hook failed for {} (isolated): {}", tool_name, e);
            }
            Err(_) => {
                debug!("pre-tool hook timed out for {} after {:?}", tool_name, timeout);
            }
        }
    }

    async fn run_post_tool_hook(
        &self,
        tool_name: &str,
        tool_input: &serde_json::Value,
        is_error: bool,
        output_size: usize,
    ) {
        let Some(hooks) = &self.hooks else {
            return;
        };
        let timeout = Self::hook_timeout();
        match tokio::time::timeout(
            timeout,
            hooks.post_tool(tool_name, tool_input, is_error, output_size),
        )
        .await
        {
            Ok(Ok(())) => {}
            Ok(Err(e)) => {
                debug!("post-tool hook failed for {} (isolated): {}", tool_name, e);
            }
            Err(_) => {
                debug!("post-tool hook timed out for {} after {:?}", tool_name, timeout);
            }
        }
    }

    async fn run_post_turn_hook(&self, assistant_text_size: usize, tool_call_count: usize) {
        let Some(hooks) = &self.hooks else {
            return;
        };
        let timeout = Self::hook_timeout();
        match tokio::time::timeout(
            timeout,
            hooks.post_turn(assistant_text_size, tool_call_count),
        )
        .await
        {
            Ok(Ok(())) => {}
            Ok(Err(e)) => {
                debug!("post-turn hook failed (isolated): {}", e);
            }
            Err(_) => {
                debug!("post-turn hook timed out after {:?}", timeout);
            }
        }
    }

    async fn choose_turn_plan(
        &self,
        user_input: &str,
        estimated_message_tokens: usize,
    ) -> TurnPlan {
        let context_pressure = if self.context_manager.max_tokens() == 0 {
            0.0
        } else {
            estimated_message_tokens as f64 / self.context_manager.max_tokens() as f64
        };
        let input_len = user_input.chars().count();
        let lower = user_input.to_lowercase();
        let deep_signal = lower.contains("analyze")
            || lower.contains("design")
            || lower.contains("compare")
            || lower.contains("root cause")
            || input_len > 700;
        let short_signal = input_len < 120
            && !deep_signal
            && !lower.contains("step")
            && !lower.contains("plan");

        let latency_p95 = self.tuning.lock().await.p95_llm_ms().unwrap_or(0);
        if context_pressure > 0.75 || latency_p95 > 14_000 {
            return TurnPlan::Short;
        }
        if deep_signal && context_pressure < 0.60 && latency_p95 < 10_000 {
            return TurnPlan::Deep;
        }
        if short_signal && latency_p95 > 8_000 {
            return TurnPlan::Short;
        }
        TurnPlan::Normal
    }

    /// Call the provider with retry logic for transient failures.
    async fn call_provider_with_retry(
        &self,
        session: &SharedSession,
        messages: &[Message],
        tool_definitions: &[ToolDefinition],
        opts: &CompletionOpts,
    ) -> Result<CompletionStream, forge_core::ForgeError> {
        let mut retry = RetryState::new();

        // First attempt uses the messages as-is
        let mut current_messages = messages.to_vec();

        loop {
            match self
                .provider
                .complete(&current_messages, tool_definitions, opts)
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
        let mut by_name: std::collections::BTreeMap<String, ToolDefinition> = self
            .tool_definitions
            .iter()
            .map(|d| (d.name.clone(), d.clone()))
            .collect();
        for client in &self.mcp_clients {
            match client.list_tools().await {
                Ok(tools) => {
                    for tool in tools {
                        by_name.insert(tool.name.clone(), tool);
                    }
                }
                Err(e) => {
                    tracing::warn!("Failed to list MCP tools: {e}");
                }
            }
        }
        self.tool_definitions = by_name.into_values().collect();
    }

    async fn active_tool_definitions(&self) -> Vec<ToolDefinition> {
        let mut by_name: std::collections::BTreeMap<String, ToolDefinition> = self
            .tool_definitions
            .iter()
            .map(|d| (d.name.clone(), d.clone()))
            .collect();
        for client in &self.mcp_clients {
            match client.list_tools().await {
                Ok(tools) => {
                    for tool in tools {
                        by_name.insert(tool.name.clone(), tool);
                    }
                }
                Err(err) => {
                    debug!("MCP tool refresh failed (non-fatal): {err}");
                }
            }
        }
        by_name.into_values().collect()
    }

    /// Process a user message through the full agentic loop
    pub async fn process_message(&self, session: &SharedSession, user_input: &str) {
        let turn_task_id = uuid::Uuid::new_v4().to_string();
        let turn_started = std::time::Instant::now();
        self.emit_task(TaskEventEnvelope {
            schema: TaskEventEnvelope::SCHEMA.to_string(),
            task_id: turn_task_id.clone(),
            parent_task_id: None,
            kind: TaskKind::Turn,
            phase: TaskPhase::Started,
            name: "turn".to_string(),
            duration_ms: None,
            attempt: Some(1),
            error: None,
            meta: Some(serde_json::json!({
                "provider": self.provider.name(),
                "model": self.provider.model()
            })),
        })
        .await;

        // 0. Detect model/provider switch before adding the new user message.
        //    If switched, update session metadata and inject a compact handoff.
        let switch_context = {
            let mut s = session.lock().await;
            if s.model != self.provider.model() || s.provider != self.provider.name() {
                let previous = format!("{} ({})", s.model, s.provider);
                let current = format!("{} ({})", self.provider.model(), self.provider.name());
                let handoff = build_model_switch_handoff(&s.messages, &previous, &current);
                s.model = self.provider.model().to_string();
                s.provider = self.provider.name().to_string();
                Some(handoff)
            } else {
                None
            }
        };

        if switch_context.is_some() {
            let _ = self
                .event_tx
                .send(AgentEvent::Status(
                    "Model switch detected — reinjecting context handoff...".to_string(),
                ))
                .await;
        }

        // 1. Add user message to session FIRST (independent of recall)
        {
            let mut s = session.lock().await;
            s.add_message(Message::user(user_input));
        }
        self.run_pre_turn_hook(user_input).await;

        // 2. Run memory recall + provider preconnect in PARALLEL
        let mut memory_context = String::new();
        if let Some(hooks) = &self.hooks {
            let _ = self
                .event_tx
                .send(AgentEvent::Status("◇ Recalling memories...".to_string()))
                .await;

            // Overlap: recall memories while warming the provider connection
            let recall_query = if let Some(handoff) = &switch_context {
                format!("{}\n\nUser prompt:\n{}", handoff, user_input)
            } else {
                user_input.to_string()
            };
            let recall_timeout =
                timeout_from_env("FORGE_RECALL_TIMEOUT_MS", 1_000, 250, 15_000);
            let recall_future =
                tokio::time::timeout(recall_timeout, hooks.prompt_submit(&recall_query));
            let preconnect_future = self.provider.preconnect();

            let (recall_result, _) = tokio::join!(recall_future, preconnect_future);

            match recall_result {
                Ok(Ok((injection, count))) if !injection.is_empty() => {
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
                Ok(Ok(_)) => {}
                Ok(Err(e)) => {
                    debug!("Prompt hook failed (non-fatal): {e}");
                }
                Err(_) => {
                    debug!("Prompt hook timed out after {:?}", recall_timeout);
                }
            }
        } else {
            // No daemon — still preconnect to provider
            self.provider.preconnect().await;
        }

        if let Some(handoff) = switch_context {
            if memory_context.is_empty() {
                memory_context = handoff;
            } else {
                memory_context = format!("{memory_context}\n\n{handoff}");
            }
        }

        // Notify TUI that we're now waiting for the LLM
        let _ = self
            .event_tx
            .send(AgentEvent::Status("◆ Thinking...".to_string()))
            .await;

        // 3. Run the agentic loop
        let mut loop_detector = LoopDetector::new(3);
        loop {
            let raw_estimated_messages_tokens = {
                let s = session.lock().await;
                ContextManager::estimate_tokens(&s.messages)
            };
            let estimated_messages_tokens = adjust_estimate_for_model(
                raw_estimated_messages_tokens,
                self.provider.name(),
                self.provider.model(),
            );
            let turn_plan = self
                .choose_turn_plan(user_input, estimated_messages_tokens)
                .await;
            let turn_memory_context = prepare_memory_context_for_turn(
                memory_context.clone(),
                self.context_manager.max_tokens(),
                estimated_messages_tokens,
            );

            // Build system prompt with memory context
            let full_system = if turn_memory_context.is_empty() {
                self.system_prompt.clone()
            } else {
                format!("{}\n\n{}", self.system_prompt, turn_memory_context)
            };

            let user_effort = *self.effort.lock().await;
            let effective_effort = max_effort(user_effort, turn_plan.effort());
            let current_bypass = *self.bypass.lock().await;

            let dynamic_tool_max_chars = self.tuning.lock().await.recommended_tool_chars();
            let opts = CompletionOpts {
                system_prompt: Some(full_system),
                max_tokens: Some(turn_plan.max_tokens()),
                effort: effective_effort,
                bypass: current_bypass,
                ..Default::default()
            };
            let show_turn_plan = std::env::var("FORGE_SHOW_TURN_PLAN")
                .ok()
                .map(|v| {
                    let s = v.trim().to_ascii_lowercase();
                    matches!(s.as_str(), "1" | "true" | "yes" | "on")
                })
                .unwrap_or(false);
            if show_turn_plan {
                let _ = self
                    .event_tx
                    .send(AgentEvent::Status(format!(
                        "Turn plan: {} (effort={}, max_tokens={}, tool_cap={})",
                        turn_plan.label(),
                        effective_effort.as_str(),
                        turn_plan.max_tokens(),
                        dynamic_tool_max_chars
                    )))
                    .await;
            }

            // Pre-sampling compaction: check token estimate BEFORE calling
            // the LLM. If we're approaching the context window limit, compact
            // first to avoid wasting an LLM call on an oversized prompt.
            // Uses the already-adjusted estimate so the compaction gate is
            // consistent with the turn plan's view of token pressure.
            {
                let estimated = estimated_messages_tokens;
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
            let llm_started = std::time::Instant::now();
            let active_tool_definitions = self.active_tool_definitions().await;
            let stream = match self
                .call_provider_with_retry(
                    session,
                    &messages,
                    &active_tool_definitions,
                    &opts,
                )
                .await
            {
                Ok(s) => s,
                Err(e) => {
                    error!("Provider error (all retries exhausted): {e}");
                    self.emit_task(TaskEventEnvelope {
                        schema: TaskEventEnvelope::SCHEMA.to_string(),
                        task_id: turn_task_id.clone(),
                        parent_task_id: None,
                        kind: TaskKind::Turn,
                        phase: TaskPhase::Failed,
                        name: "turn".to_string(),
                        duration_ms: Some(turn_started.elapsed().as_millis() as u64),
                        attempt: Some(1),
                        error: Some(e.to_string()),
                        meta: None,
                    })
                    .await;
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
            let provider_is_cli = self.provider.name().ends_with("-cli");

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
                            self.emit_task(TaskEventEnvelope {
                                schema: TaskEventEnvelope::SCHEMA.to_string(),
                                task_id: turn_task_id.clone(),
                                parent_task_id: None,
                                kind: TaskKind::Turn,
                                phase: TaskPhase::Failed,
                                name: "turn".to_string(),
                                duration_ms: Some(turn_started.elapsed().as_millis() as u64),
                                attempt: Some(1),
                                error: Some(format!("stale stream timeout ({}s)", STALE_STREAM_SECS * 2)),
                                meta: None,
                            }).await;
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
                        // CLI providers (codex/claude/gemini CLI) already execute their own
                        // tools. Keep tool events for UI visibility, but do not enqueue
                        // tool calls into Forge's tool runner.
                        if !provider_is_cli {
                            tool_calls.push(ToolCall {
                                id: current_tool_id.clone(),
                                name: current_tool_name.clone(),
                                input,
                            });
                        }
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
                        self.emit_task(TaskEventEnvelope {
                            schema: TaskEventEnvelope::SCHEMA.to_string(),
                            task_id: turn_task_id.clone(),
                            parent_task_id: None,
                            kind: TaskKind::Turn,
                            phase: TaskPhase::Failed,
                            name: "turn".to_string(),
                            duration_ms: Some(turn_started.elapsed().as_millis() as u64),
                            attempt: Some(1),
                            error: Some(e.clone()),
                            meta: None,
                        })
                        .await;
                        let _ = self.event_tx.send(AgentEvent::Error(e)).await;
                        return;
                    }
                }
            }
            let llm_elapsed_ms = llm_started.elapsed().as_millis() as u64;
            {
                let mut tuning = self.tuning.lock().await;
                tuning.record_llm_latency(llm_elapsed_ms);
            }

            // 6. Build assistant message with all content blocks
            let mut content = Vec::new();
            let assistant_text_size = assistant_text.chars().count();
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
            self.run_post_turn_hook(assistant_text_size, tool_calls.len())
                .await;

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
                self.emit_task(TaskEventEnvelope {
                    schema: TaskEventEnvelope::SCHEMA.to_string(),
                    task_id: turn_task_id.clone(),
                    parent_task_id: None,
                    kind: TaskKind::Turn,
                    phase: TaskPhase::Succeeded,
                    name: "turn".to_string(),
                    duration_ms: Some(turn_started.elapsed().as_millis() as u64),
                    attempt: Some(1),
                    error: None,
                    meta: Some(serde_json::json!({
                        "tool_calls": 0usize
                    })),
                })
                .await;
                return;
            }

            // 8. Execute tool calls with permission checks.
            // Read-only tools are parallelized; write tools run sequentially.
            // Identical tool calls (same name + input) are deduplicated.
            let mut tool_results_content = Vec::new();

            // Deduplicate tool calls by (name, input) hash.
            // duplicate_to_original maps each skipped call's ID → the original call's ID
            // so we can copy results after execution to satisfy the API contract.
            let mut seen_keys = std::collections::HashSet::<(String, String)>::new();
            let mut deduped_calls: Vec<&ToolCall> = Vec::new();
            let mut key_to_original: std::collections::HashMap<(String, String), String> = std::collections::HashMap::new();
            let mut duplicate_to_original: Vec<(String, String)> = Vec::new();
            for tc in &tool_calls {
                let key = (tc.name.clone(), serde_json::to_string(&tc.input).unwrap_or_default());
                if seen_keys.insert(key.clone()) {
                    deduped_calls.push(tc);
                    key_to_original.insert(key, tc.id.clone());
                } else if let Some(original_id) = key_to_original.get(&key) {
                    debug!("Deduplicating tool call: {} (duplicate of {})", tc.id, original_id);
                    duplicate_to_original.push((tc.id.clone(), original_id.clone()));
                }
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
                    self.emit_task(TaskEventEnvelope {
                        schema: TaskEventEnvelope::SCHEMA.to_string(),
                        task_id: turn_task_id.clone(),
                        parent_task_id: None,
                        kind: TaskKind::Turn,
                        phase: TaskPhase::Failed,
                        name: "turn".to_string(),
                        duration_ms: Some(turn_started.elapsed().as_millis() as u64),
                        attempt: Some(1),
                        error: Some(msg.clone()),
                        meta: None,
                    })
                    .await;
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
            readonly_calls.sort_by_key(|tc| readonly_priority(&tc.name));
            write_calls.sort_by_key(|tc| write_priority(&tc.name));

            let known_tool_names: Vec<String> = active_tool_definitions
                .iter()
                .map(|d| d.name.clone())
                .collect();

            // Execute read-only tools in parallel
            if !readonly_calls.is_empty() {
                let _ = self
                    .event_tx
                    .send(AgentEvent::Status(format!(
                        "Executing {} read-only tool{}...",
                        readonly_calls.len(),
                        if readonly_calls.len() == 1 { "" } else { "s" }
                    )))
                    .await;
                debug!("Executing {} read-only tools in parallel", readonly_calls.len());
                let mut joinset = tokio::task::JoinSet::new();
                let mut completed_readonly_ids = std::collections::HashSet::new();
                for tc in &readonly_calls {
                    self.run_pre_tool_hook(&tc.name, &tc.input).await;
                    let tc_owned = (*tc).clone();
                    let tool_task_id = uuid::Uuid::new_v4().to_string();
                    self.emit_task(TaskEventEnvelope {
                        schema: TaskEventEnvelope::SCHEMA.to_string(),
                        task_id: tool_task_id.clone(),
                        parent_task_id: Some(turn_task_id.clone()),
                        kind: TaskKind::Tool,
                        phase: TaskPhase::Started,
                        name: tc_owned.name.clone(),
                        duration_ms: None,
                        attempt: Some(1),
                        error: None,
                        meta: Some(serde_json::json!({"mode":"readonly"})),
                    }).await;
                    let daemon_url = self.daemon_url.clone();
                    let provider = Arc::clone(&self.provider);
                    let mcp_clients = self.mcp_clients.clone();
                    let known_tool_names = known_tool_names.clone();
                    joinset.spawn(async move {
                        let started = std::time::Instant::now();
                        let timeout = tool_timeout_for_name(
                            &tc_owned.name,
                            forge_core::ToolPermission::ReadOnly,
                        );
                        let tool = match &daemon_url {
                            Some(url) => forge_tools::find_tool_with_subagent(
                                &tc_owned.name, url, provider,
                            ),
                            None => forge_tools::find_tool(&tc_owned.name),
                        };
                        let result = if let Some(tool) = tool {
                            match tokio::time::timeout(timeout, tool.execute(&tc_owned)).await {
                                Ok(result) => result,
                                Err(_) => forge_core::ToolResult::error(
                                    &tc_owned.id,
                                    format!(
                                        "Tool '{}' timed out after {}s",
                                        tc_owned.name,
                                        timeout.as_secs()
                                    ),
                                ),
                            }
                        } else {
                            let (outcome, output) = call_mcp_tool_with_timeout(
                                &mcp_clients,
                                &tc_owned.name,
                                &tc_owned.input,
                                timeout,
                            )
                            .await;
                            match (outcome, output) {
                                (McpCallOutcome::Success, Some(output)) => {
                                    forge_core::ToolResult::success(&tc_owned.id, output)
                                }
                                (McpCallOutcome::TimedOut, _) => forge_core::ToolResult::error(
                                    &tc_owned.id,
                                    format!(
                                        "Tool '{}' timed out after {}s",
                                        tc_owned.name,
                                        timeout.as_secs()
                                    ),
                                ),
                                (McpCallOutcome::Failed, _) => {
                                    if known_tool_names.iter().any(|t| t == &tc_owned.name) {
                                        forge_core::ToolResult::error(
                                            &tc_owned.id,
                                            format!(
                                                "Tool '{}' failed across all MCP routes",
                                                tc_owned.name
                                            ),
                                        )
                                    } else {
                                        invalid_tool_call_result(&tc_owned, &known_tool_names)
                                    }
                                }
                                (McpCallOutcome::Success, None) => forge_core::ToolResult::error(
                                    &tc_owned.id,
                                    format!("Tool '{}' returned no output", tc_owned.name),
                                ),
                            }
                        };
                        (tc_owned, result, started.elapsed().as_millis() as u64, tool_task_id)
                    });
                }

                while let Some(outcome) = joinset.join_next().await {
                    match outcome {
                        Ok((tc, result, elapsed_ms, tool_task_id)) => {
                            completed_readonly_ids.insert(tc.id.clone());
                            let bounded = clamp_tool_content_with_dynamic_max(
                                &result.content,
                                dynamic_tool_max_chars,
                            );
                            {
                                let mut tuning = self.tuning.lock().await;
                                tuning.record_tool_result(bounded.original_len, bounded.truncated);
                            }
                            let _ = self.event_tx.send(AgentEvent::ToolResult {
                                id: tc.id.clone(),
                                name: tc.name.clone(),
                                output: bounded.content.clone(),
                                is_error: result.is_error,
                            }).await;
                            self.emit_task(TaskEventEnvelope {
                                schema: TaskEventEnvelope::SCHEMA.to_string(),
                                task_id: tool_task_id,
                                parent_task_id: Some(turn_task_id.clone()),
                                kind: TaskKind::Tool,
                                phase: if result.is_error { TaskPhase::Failed } else { TaskPhase::Succeeded },
                                name: tc.name.clone(),
                                duration_ms: Some(elapsed_ms),
                                attempt: Some(1),
                                error: if result.is_error { Some(result.content.clone()) } else { None },
                                meta: Some(tool_task_meta(
                                    "readonly",
                                    if result.is_error { Some(result.content.as_str()) } else { None },
                                )),
                            }).await;
                            self.run_post_tool_hook(
                                &tc.name,
                                &tc.input,
                                result.is_error,
                                bounded.original_len,
                            )
                            .await;
                            tool_results_content.push(MessageContent::ToolResult {
                                tool_use_id: result.tool_use_id,
                                content: bounded.content,
                                is_error: result.is_error,
                            });
                        }
                        Err(join_err) => {
                            warn!("Read-only tool task join failed: {join_err}");
                        }
                    }
                }

                for tc in &readonly_calls {
                    if completed_readonly_ids.contains(&tc.id) {
                        continue;
                    }
                    let fallback = forge_core::ToolResult::error(
                        &tc.id,
                        format!(
                            "Tool '{}' did not complete due to internal task failure",
                            tc.name
                        ),
                    );
                    let bounded =
                        clamp_tool_content_with_dynamic_max(&fallback.content, dynamic_tool_max_chars);
                    {
                        let mut tuning = self.tuning.lock().await;
                        tuning.record_tool_result(bounded.original_len, bounded.truncated);
                    }
                    let _ = self.event_tx.send(AgentEvent::ToolResult {
                        id: tc.id.clone(),
                        name: tc.name.clone(),
                        output: bounded.content.clone(),
                        is_error: true,
                    }).await;
                    self.emit_task(TaskEventEnvelope {
                        schema: TaskEventEnvelope::SCHEMA.to_string(),
                        task_id: uuid::Uuid::new_v4().to_string(),
                        parent_task_id: Some(turn_task_id.clone()),
                        kind: TaskKind::Tool,
                        phase: TaskPhase::Failed,
                        name: tc.name.clone(),
                        duration_ms: None,
                        attempt: Some(1),
                        error: Some("internal task failure".to_string()),
                        meta: Some(serde_json::json!({"mode":"readonly"})),
                    }).await;
                    self.run_post_tool_hook(
                        &tc.name,
                        &tc.input,
                        true,
                        bounded.original_len,
                    )
                    .await;
                    tool_results_content.push(MessageContent::ToolResult {
                        tool_use_id: fallback.tool_use_id,
                        content: bounded.content,
                        is_error: true,
                    });
                }
            }

            // Execute write tools sequentially with permission checks
            for tc in &write_calls {
                let _ = self
                    .event_tx
                    .send(AgentEvent::Status(format!("Executing tool: {}", tc.name)))
                    .await;
                self.run_pre_tool_hook(&tc.name, &tc.input).await;
                let tool_task_id = uuid::Uuid::new_v4().to_string();
                self.emit_task(TaskEventEnvelope {
                    schema: TaskEventEnvelope::SCHEMA.to_string(),
                    task_id: tool_task_id.clone(),
                    parent_task_id: Some(turn_task_id.clone()),
                    kind: TaskKind::Tool,
                    phase: TaskPhase::Started,
                    name: tc.name.clone(),
                    duration_ms: None,
                    attempt: Some(1),
                    error: None,
                    meta: Some(serde_json::json!({"mode":"write"})),
                }).await;
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
                            self.emit_task(TaskEventEnvelope {
                                schema: TaskEventEnvelope::SCHEMA.to_string(),
                                task_id: tool_task_id.clone(),
                                parent_task_id: Some(turn_task_id.clone()),
                                kind: TaskKind::Tool,
                                phase: TaskPhase::Failed,
                                name: tc.name.clone(),
                                duration_ms: Some(0),
                                attempt: Some(1),
                                error: Some("permission denied".to_string()),
                                meta: Some(serde_json::json!({"mode":"write"})),
                            }).await;
                            self.run_post_tool_hook(
                                &tc.name,
                                &tc.input,
                                true,
                                result.content.chars().count(),
                            )
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
                let timeout = tool_timeout_for_name(&tc.name, forge_core::ToolPermission::Write);
                let tool_started = std::time::Instant::now();

                let result = if let Some(tool) = tool_impl {
                    match tokio::time::timeout(timeout, tool.execute(tc)).await {
                        Ok(result) => result,
                        Err(_) => forge_core::ToolResult::error(
                            &tc.id,
                            format!("Tool '{}' timed out after {}s", tc.name, timeout.as_secs()),
                        ),
                    }
                } else {
                    let (outcome, output) = call_mcp_tool_with_timeout(
                        &self.mcp_clients,
                        &tc.name,
                        &tc.input,
                        timeout,
                    )
                    .await;
                    match (outcome, output) {
                        (McpCallOutcome::Success, Some(output)) => {
                            forge_core::ToolResult::success(&tc.id, output)
                        }
                        (McpCallOutcome::TimedOut, _) => forge_core::ToolResult::error(
                            &tc.id,
                            format!("Tool '{}' timed out after {}s", tc.name, timeout.as_secs()),
                        ),
                        (McpCallOutcome::Failed, _) => {
                            if known_tool_names.iter().any(|t| t == &tc.name) {
                                forge_core::ToolResult::error(
                                    &tc.id,
                                    format!("Tool '{}' failed across all MCP routes", tc.name),
                                )
                            } else {
                                invalid_tool_call_result(tc, &known_tool_names)
                            }
                        }
                        (McpCallOutcome::Success, None) => forge_core::ToolResult::error(
                            &tc.id,
                            format!("Tool '{}' returned no output", tc.name),
                        ),
                    }
                };

                let bounded =
                    clamp_tool_content_with_dynamic_max(&result.content, dynamic_tool_max_chars);
                {
                    let mut tuning = self.tuning.lock().await;
                    tuning.record_tool_result(bounded.original_len, bounded.truncated);
                }
                let _ = self
                    .event_tx
                    .send(AgentEvent::ToolResult {
                        id: tc.id.clone(),
                        name: tc.name.clone(),
                        output: bounded.content.clone(),
                        is_error: result.is_error,
                    })
                    .await;
                self.emit_task(TaskEventEnvelope {
                    schema: TaskEventEnvelope::SCHEMA.to_string(),
                    task_id: tool_task_id,
                    parent_task_id: Some(turn_task_id.clone()),
                    kind: TaskKind::Tool,
                    phase: if result.is_error { TaskPhase::Failed } else { TaskPhase::Succeeded },
                    name: tc.name.clone(),
                    duration_ms: Some(tool_started.elapsed().as_millis() as u64),
                    attempt: Some(1),
                    error: if result.is_error { Some(result.content.clone()) } else { None },
                    meta: Some(tool_task_meta(
                        "write",
                        if result.is_error { Some(result.content.as_str()) } else { None },
                    )),
                }).await;
                self.run_post_tool_hook(
                    &tc.name,
                    &tc.input,
                    result.is_error,
                    bounded.original_len,
                )
                .await;

                tool_results_content.push(MessageContent::ToolResult {
                    tool_use_id: result.tool_use_id,
                    content: bounded.content,
                    is_error: result.is_error,
                });
            }

            // Reuse results for deduplicated tool calls so every tool_use gets a tool_result.
            if !duplicate_to_original.is_empty() {
                let results_by_id: std::collections::HashMap<String, (String, bool)> =
                    tool_results_content
                        .iter()
                        .filter_map(|c| match c {
                            MessageContent::ToolResult { tool_use_id, content, is_error } => {
                                Some((tool_use_id.clone(), (content.clone(), *is_error)))
                            }
                            _ => None,
                        })
                        .collect();
                for (dup_id, orig_id) in &duplicate_to_original {
                    if let Some((content, is_error)) = results_by_id.get(orig_id) {
                        tool_results_content.push(MessageContent::ToolResult {
                            tool_use_id: dup_id.clone(),
                            content: content.clone(),
                            is_error: *is_error,
                        });
                    }
                }
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

fn ollama_compaction_reachable() -> bool {
    if std::env::var("FORGE_COMPACTION_PROVIDER")
        .ok()
        .map(|v| v.eq_ignore_ascii_case("primary"))
        .unwrap_or(false)
    {
        return false;
    }

    let host = std::env::var("OLLAMA_HOST")
        .ok()
        .or_else(|| std::env::var("OLLAMA_BASE_URL").ok())
        .unwrap_or_else(|| "127.0.0.1:11434".to_string());
    let normalized = host
        .trim_start_matches("http://")
        .trim_start_matches("https://")
        .split('/')
        .next()
        .unwrap_or("127.0.0.1:11434");

    let addr: SocketAddr = match normalized.parse() {
        Ok(parsed) => parsed,
        Err(_) => return false,
    };

    TcpStream::connect_timeout(&addr, std::time::Duration::from_millis(300)).is_ok()
}

async fn call_mcp_tool_with_timeout(
    clients: &[Arc<forge_mcp::McpStdioClient>],
    name: &str,
    input: &serde_json::Value,
    timeout: std::time::Duration,
) -> (McpCallOutcome, Option<String>) {
    let mut saw_timeout = false;
    for client in clients {
        match tokio::time::timeout(timeout, client.call_tool(name, input.clone())).await {
            Ok(Ok(output)) => return (McpCallOutcome::Success, Some(output)),
            Ok(Err(_)) => continue,
            Err(_) => saw_timeout = true,
        }
    }
    if saw_timeout {
        (McpCallOutcome::TimedOut, None)
    } else {
        (McpCallOutcome::Failed, None)
    }
}

fn build_model_switch_handoff(messages: &[Message], previous: &str, current: &str) -> String {
    let tail = messages
        .iter()
        .rev()
        .take(6)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .map(|m| {
            let role = match m.role {
                forge_core::Role::System => "System",
                forge_core::Role::User => "User",
                forge_core::Role::Assistant => "Assistant",
            };
            let text = m.text();
            let clipped = if text.chars().count() > 400 {
                let cut: String = text.chars().take(397).collect();
                format!("{cut}...")
            } else {
                text
            };
            format!("{role}: {clipped}")
        })
        .collect::<Vec<_>>()
        .join("\n");

    format!(
        "[Model Switch Handoff]\n\
         Previous model: {previous}\n\
         Current model: {current}\n\
         Preserve continuity with this recent context:\n{tail}"
    )
}

fn invalid_tool_call_result(tc: &ToolCall, available_tools: &[String]) -> forge_core::ToolResult {
    let mut suggestions = suggest_tool_names(&tc.name, available_tools, 5);
    if suggestions.is_empty() {
        suggestions = available_tools.iter().take(5).cloned().collect();
    }

    let suggestion_text = if suggestions.is_empty() {
        "No registered tools were available.".to_string()
    } else {
        format!("Try one of: {}", suggestions.join(", "))
    };

    let msg = format!(
        "Invalid tool call: '{}'. {}. Correct the tool name and retry this step.",
        tc.name, suggestion_text
    );
    forge_core::ToolResult::error(&tc.id, msg)
}

fn detect_policy_block_reason(message: &str) -> Option<PolicyBlockReason> {
    const REASONS: [PolicyBlockReason; 5] = [
        PolicyBlockReason::CommandNotAllowlisted,
        PolicyBlockReason::CommandHasShellOperators,
        PolicyBlockReason::CommandEmpty,
        PolicyBlockReason::PathOutsideWorkspace,
        PolicyBlockReason::PathOutsideAllowlist,
    ];
    REASONS
        .into_iter()
        .find(|reason| message.contains(reason.code()))
}

fn tool_task_meta(mode: &str, error_content: Option<&str>) -> serde_json::Value {
    if let Some(error) = error_content {
        if let Some(reason) = detect_policy_block_reason(error) {
            return serde_json::json!({
                "mode": mode,
                "policy_denied": true,
                "policy_reason": reason.code(),
                "event": "policy_denied",
            });
        }
    }
    serde_json::json!({ "mode": mode })
}

fn max_effort(a: ReasoningEffort, b: ReasoningEffort) -> ReasoningEffort {
    match (a, b) {
        (ReasoningEffort::High, _) | (_, ReasoningEffort::High) => ReasoningEffort::High,
        (ReasoningEffort::Medium, _) | (_, ReasoningEffort::Medium) => ReasoningEffort::Medium,
        _ => ReasoningEffort::Low,
    }
}

fn provider_chars_per_token(provider: &str, model: &str) -> f64 {
    let p = provider.to_lowercase();
    let m = model.to_lowercase();
    if p.contains("anthropic") || m.contains("claude") {
        3.7
    } else if p.contains("openai") || m.contains("gpt") || p.contains("xai") {
        3.8
    } else if p.contains("gemini") || p.contains("google") {
        4.2
    } else if m.contains("qwen") || m.contains("llama") || p.contains("ollama") {
        3.5
    } else {
        4.0
    }
}

fn adjust_estimate_for_model(raw_tokens: usize, provider: &str, model: &str) -> usize {
    let chars_per_token = provider_chars_per_token(provider, model);
    let factor = 4.0 / chars_per_token;
    ((raw_tokens as f64) * factor).ceil() as usize
}

fn clamp_tool_content_with_dynamic_max(content: &str, dynamic_max_chars: usize) -> ClampedToolOutput {
    // Guardrail: keep tool reinjection bounded to avoid runaway context growth.
    // Tool-specific limits still apply earlier; this is the final safety net.
    const DEFAULT_MAX_CHARS: usize = 12_000;
    const MIN_MAX_CHARS: usize = 1_024;
    const ABSOLUTE_MAX_CHARS: usize = 100_000;
    let env_max_chars = std::env::var("FORGE_TOOL_RESULT_MAX_CHARS")
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .map(|v| v.clamp(MIN_MAX_CHARS, ABSOLUTE_MAX_CHARS));
    let adaptive_max_chars = if dynamic_max_chars == 0 {
        DEFAULT_MAX_CHARS
    } else {
        dynamic_max_chars.clamp(MIN_MAX_CHARS, ABSOLUTE_MAX_CHARS)
    };
    let max_chars = env_max_chars
        .map(|cap| adaptive_max_chars.min(cap))
        .unwrap_or(adaptive_max_chars);
    const DEFAULT_MAX_LINES: usize = 400;
    const MIN_MAX_LINES: usize = 40;
    const ABSOLUTE_MAX_LINES: usize = 4_000;
    let max_lines = std::env::var("FORGE_TOOL_RESULT_MAX_LINES")
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .map(|v| v.clamp(MIN_MAX_LINES, ABSOLUTE_MAX_LINES))
        .unwrap_or(DEFAULT_MAX_LINES);
    const DEFAULT_MAX_LINE_CHARS: usize = 640;
    const MIN_MAX_LINE_CHARS: usize = 120;
    const ABSOLUTE_MAX_LINE_CHARS: usize = 8_192;
    let max_line_chars = std::env::var("FORGE_TOOL_RESULT_MAX_LINE_CHARS")
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .map(|v| v.clamp(MIN_MAX_LINE_CHARS, ABSOLUTE_MAX_LINE_CHARS))
        .unwrap_or(DEFAULT_MAX_LINE_CHARS);

    let mut did_line_truncate = false;
    let per_line_clamped = content
        .lines()
        .map(|line| {
            if line.chars().count() <= max_line_chars {
                return line.to_string();
            }
            did_line_truncate = true;
            let cut = line
                .char_indices()
                .take_while(|(idx, _)| *idx < max_line_chars)
                .last()
                .map(|(idx, ch)| idx + ch.len_utf8())
                .unwrap_or(0);
            format!(
                "{}… [line truncated at {} chars]",
                &line[..cut], max_line_chars
            )
        })
        .collect::<Vec<_>>()
        .join("\n");

    let mut did_line_count_truncate = false;
    let normalized = if per_line_clamped.lines().count() > max_lines {
        did_line_count_truncate = true;
        let keep_head = max_lines / 2;
        let keep_tail = max_lines.saturating_sub(keep_head);
        let lines: Vec<&str> = per_line_clamped.lines().collect();
        let head = lines.iter().take(keep_head).copied().collect::<Vec<_>>().join("\n");
        let tail = lines
            .iter()
            .rev()
            .take(keep_tail)
            .copied()
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<Vec<_>>()
            .join("\n");
        format!(
            "{head}\n\n[truncated: {} lines omitted]\n\n{tail}",
            lines.len().saturating_sub(max_lines)
        )
    } else {
        content.to_string()
    };

    if normalized.len() <= max_chars {
        return ClampedToolOutput {
            content: normalized,
            original_len: content.len(),
            truncated: did_line_truncate || did_line_count_truncate,
        };
    }
    let cut = normalized
        .char_indices()
        .take_while(|(idx, _)| *idx < max_chars)
        .last()
        .map(|(idx, ch)| idx + ch.len_utf8())
        .unwrap_or(0);
    let head = &normalized[..cut];
    let bounded = format!(
        "{head}\n\n[truncated: tool output exceeded {max_chars} chars (original: {} chars); request a narrower query/path to continue]",
        normalized.len()
    );
    ClampedToolOutput {
        content: bounded,
        original_len: content.len(),
        truncated: true,
    }
}

fn readonly_priority(name: &str) -> u8 {
    match name {
        "Read" | "Glob" | "Grep" => 0,
        "memory_search" | "memory_get" | "memory_list" | "knowledge_expand" => 1,
        "WebFetch" | "WebSearch" => 2,
        _ => 3,
    }
}

fn write_priority(name: &str) -> u8 {
    match name {
        "Write" | "Edit" => 0,
        "memory_store" | "memory_modify" | "memory_forget" => 1,
        "Bash" | "secret_exec" | "SubAgent" => 2,
        _ => 1,
    }
}

fn compute_available_injection_tokens(
    max_tokens: usize,
    estimated_message_tokens: usize,
) -> usize {
    // When context window is unknown (0), use a sensible default so memory
    // injection is not silently disabled — matches prior unconditional behavior.
    const DEFAULT_CONTEXT_WINDOW: usize = 8_000;
    let effective = if max_tokens == 0 {
        warn!("Provider context window is 0 (unknown); defaulting to {DEFAULT_CONTEXT_WINDOW} for memory budget");
        DEFAULT_CONTEXT_WINDOW
    } else {
        max_tokens
    };
    let soft_cap = effective.saturating_mul(18) / 100;
    let remaining = effective.saturating_mul(78) / 100;
    let budget_after_messages = remaining.saturating_sub(estimated_message_tokens);
    budget_after_messages.min(soft_cap)
}

fn context_tier(max_tokens: usize, estimated_message_tokens: usize) -> ContextTier {
    const DEFAULT_CONTEXT_WINDOW: usize = 8_000;
    let effective_max_tokens = if max_tokens == 0 {
        DEFAULT_CONTEXT_WINDOW
    } else {
        max_tokens
    };

    let remaining = effective_max_tokens
        .saturating_mul(78)
        .saturating_div(100)
        .saturating_sub(estimated_message_tokens);
    let ratio_pct = remaining
        .saturating_mul(100)
        .saturating_div(effective_max_tokens);
    if ratio_pct >= 16 {
        ContextTier::Hot
    } else if ratio_pct >= 8 {
        ContextTier::Warm
    } else {
        ContextTier::Cold
    }
}

fn clamp_memory_context(memory_context: String, available_tokens: usize) -> String {
    if available_tokens == 0 || memory_context.is_empty() {
        return String::new();
    }
    let estimated_tokens = memory_context.len() / 4;
    if estimated_tokens <= available_tokens {
        return memory_context;
    }
    let max_chars = available_tokens.saturating_mul(4).max(256);
    let cut = memory_context
        .char_indices()
        .take_while(|(idx, _)| *idx < max_chars)
        .last()
        .map(|(idx, ch)| idx + ch.len_utf8())
        .unwrap_or(0);
    let head = &memory_context[..cut];
    format!(
        "{head}\n\n[truncated: memory context reduced to fit token budget ({available_tokens} tokens)]"
    )
}

fn compact_memory_context_by_tier(
    memory_context: String,
    available_tokens: usize,
    tier: ContextTier,
) -> String {
    if memory_context.is_empty() || available_tokens == 0 {
        return String::new();
    }

    let max_chars = available_tokens.saturating_mul(4).max(256);
    match tier {
        ContextTier::Hot => clamp_memory_context(memory_context, available_tokens),
        ContextTier::Warm => {
            let current_chars = memory_context.chars().count();
            if current_chars <= max_chars {
                return memory_context;
            }
            let head_chars = max_chars.saturating_mul(3) / 5;
            let tail_chars = max_chars.saturating_sub(head_chars);

            let head: String = memory_context.chars().take(head_chars).collect();
            let tail_rev: String = memory_context.chars().rev().take(tail_chars).collect();
            let tail: String = tail_rev.chars().rev().collect();
            format!(
                "{head}\n\n[adaptive compaction (warm tier): middle context omitted]\n\n{tail}"
            )
        }
        ContextTier::Cold => {
            let mut selected = String::new();
            for line in memory_context.lines() {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                let lowered = trimmed.to_lowercase();
                let salient = trimmed.starts_with('-')
                    || trimmed.starts_with('*')
                    || trimmed.starts_with('[')
                    || trimmed.starts_with('#')
                    || lowered.contains("decision")
                    || lowered.contains("next")
                    || lowered.contains("todo")
                    || lowered.contains("issue");
                if salient || selected.is_empty() {
                    if !selected.is_empty() {
                        selected.push('\n');
                    }
                    selected.push_str(trimmed);
                }
                if selected.len() >= max_chars {
                    break;
                }
            }
            clamp_memory_context(selected, available_tokens)
        }
    }
}

fn prepare_memory_context_for_turn(
    memory_context: String,
    max_tokens: usize,
    estimated_message_tokens: usize,
) -> String {
    let available = compute_available_injection_tokens(max_tokens, estimated_message_tokens);
    compact_memory_context_by_tier(
        memory_context,
        available,
        context_tier(max_tokens, estimated_message_tokens),
    )
}

fn timeout_from_env(name: &str, default_ms: u64, min_ms: u64, max_ms: u64) -> std::time::Duration {
    let ms = std::env::var(name)
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .map(|v| v.clamp(min_ms, max_ms))
        .unwrap_or(default_ms);
    std::time::Duration::from_millis(ms)
}

fn tool_timeout_for_name(name: &str, permission: forge_core::ToolPermission) -> std::time::Duration {
    let fast = timeout_from_env("FORGE_TOOL_TIMEOUT_MS_FAST", 8_000, 1_000, 120_000);
    let normal = timeout_from_env("FORGE_TOOL_TIMEOUT_MS_NORMAL", 15_000, 1_000, 180_000);
    let slow = timeout_from_env("FORGE_TOOL_TIMEOUT_MS_SLOW", 30_000, 1_000, 300_000);

    match (permission, name) {
        (forge_core::ToolPermission::ReadOnly, "Read" | "Glob" | "Grep")
        | (_, "memory_get" | "memory_list" | "memory_search" | "knowledge_expand") => fast,
        (_, "WebFetch" | "WebSearch" | "Bash" | "SubAgent" | "secret_exec") => slow,
        _ => normal,
    }
}

fn percentile_u64(values: &VecDeque<u64>, p: f64) -> Option<u64> {
    if values.is_empty() {
        return None;
    }
    let mut sorted: Vec<u64> = values.iter().copied().collect();
    sorted.sort_unstable();
    let max_idx = sorted.len().saturating_sub(1);
    let rank = ((max_idx as f64) * p.clamp(0.0, 1.0)).round() as usize;
    sorted.get(rank.min(max_idx)).copied()
}

fn suggest_tool_names(target: &str, available: &[String], limit: usize) -> Vec<String> {
    let mut scored: Vec<(usize, String)> = available
        .iter()
        .map(|name| (edit_distance_case_insensitive(target, name), name.clone()))
        .collect();
    scored.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
    scored.into_iter().take(limit).map(|(_, n)| n).collect()
}

fn edit_distance_case_insensitive(a: &str, b: &str) -> usize {
    let a = a.to_lowercase();
    let b = b.to_lowercase();
    let ac: Vec<char> = a.chars().collect();
    let bc: Vec<char> = b.chars().collect();

    if ac.is_empty() {
        return bc.len();
    }
    if bc.is_empty() {
        return ac.len();
    }

    let mut prev: Vec<usize> = (0..=bc.len()).collect();
    let mut curr: Vec<usize> = vec![0; bc.len() + 1];

    for (i, ca) in ac.iter().enumerate() {
        curr[0] = i + 1;
        for (j, cb) in bc.iter().enumerate() {
            let cost = if ca == cb { 0 } else { 1 };
            curr[j + 1] = (prev[j + 1] + 1).min(curr[j] + 1).min(prev[j] + cost);
        }
        std::mem::swap(&mut prev, &mut curr);
    }

    prev[bc.len()]
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

#[cfg(test)]
mod tests {
    use super::{
        adjust_estimate_for_model, clamp_memory_context, clamp_tool_content_with_dynamic_max,
        compact_memory_context_by_tier, context_tier,
        edit_distance_case_insensitive, max_effort, prepare_memory_context_for_turn,
        suggest_tool_names, tool_timeout_for_name, write_priority, ContextTier,
    };

    #[test]
    fn suggests_closest_tool_name() {
        let available = vec![
            "memory_search".to_string(),
            "memory_store".to_string(),
            "memory_modify".to_string(),
            "bash".to_string(),
        ];
        let out = suggest_tool_names("memory_serach", &available, 2);
        assert_eq!(out.first().map(String::as_str), Some("memory_search"));
    }

    #[test]
    fn edit_distance_is_case_insensitive() {
        assert_eq!(edit_distance_case_insensitive("BASH", "bash"), 0);
        assert!(edit_distance_case_insensitive("mcp_lsit", "mcp_list") > 0);
    }

    #[test]
    fn clamp_tool_content_bounds_large_payloads() {
        let big = "a".repeat(20_000);
        let out = clamp_tool_content_with_dynamic_max(&big, 12_000);
        assert!(out.content.len() < 13_000);
        assert!(out.content.contains("[truncated: tool output exceeded"));
    }

    #[test]
    fn clamp_memory_context_respects_budget() {
        let ctx = "m".repeat(10_000);
        let out = clamp_memory_context(ctx, 200);
        assert!(out.len() <= 1_200);
        assert!(out.contains("memory context reduced to fit token budget"));
    }

    #[test]
    fn prepare_memory_context_noop_when_small() {
        let ctx = "small-context".to_string();
        let out = prepare_memory_context_for_turn(ctx.clone(), 200_000, 1_000);
        assert_eq!(out, ctx);
    }

    #[test]
    fn context_tier_degrades_with_higher_usage() {
        assert_eq!(context_tier(200_000, 10_000), ContextTier::Hot);
        assert_eq!(context_tier(200_000, 130_000), ContextTier::Warm);
        assert_eq!(context_tier(200_000, 170_000), ContextTier::Cold);
    }

    #[test]
    fn write_priority_runs_edit_before_bash() {
        assert!(write_priority("Edit") < write_priority("Bash"));
    }

    #[test]
    fn tool_timeout_prioritizes_fast_vs_slow_classes() {
        let fast = tool_timeout_for_name("Read", forge_core::ToolPermission::ReadOnly);
        let slow = tool_timeout_for_name("WebFetch", forge_core::ToolPermission::ReadOnly);
        assert!(fast < slow);
    }

    #[test]
    fn cold_tier_compaction_keeps_salient_markers_case_insensitive() {
        let ctx = "noise\nDECISION: keep this\nanother line".to_string();
        let out = compact_memory_context_by_tier(ctx, 300, ContextTier::Cold);
        assert!(out.to_lowercase().contains("decision"));
    }

    #[test]
    fn model_adjustment_changes_estimate_for_providers() {
        let openai = adjust_estimate_for_model(1_000, "openai", "gpt-5");
        let gemini = adjust_estimate_for_model(1_000, "gemini", "gemini-2.5-pro");
        assert!(openai > gemini);
    }

    #[test]
    fn dynamic_tool_cap_applies() {
        let big = "x".repeat(20_000);
        let out = clamp_tool_content_with_dynamic_max(&big, 5_000);
        assert!(out.content.len() < 7_000);
        assert!(out.truncated);
    }

    #[test]
    fn truncation_flag_set_for_line_only_truncation() {
        let long_line = "y".repeat(10_000);
        let out = clamp_tool_content_with_dynamic_max(&long_line, 100_000);
        assert!(out.truncated);
    }

    #[test]
    fn max_effort_respects_user_override() {
        assert_eq!(
            max_effort(forge_provider::ReasoningEffort::High, forge_provider::ReasoningEffort::Low),
            forge_provider::ReasoningEffort::High
        );
    }
}
