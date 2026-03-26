use crate::{CompletionOpts, CompletionStream, Provider, StreamEvent};
use async_trait::async_trait;
use forge_core::{ForgeError, Message, MessageContent, Role, ToolDefinition, TokenUsage};
use portable_pty::{CommandBuilder, PtySize, native_pty_system};
use tokio_stream::wrappers::ReceiverStream;
use tracing::{debug, warn};

/// A provider that delegates to an installed CLI tool (claude, codex, gemini, etc.)
/// The CLI handles its own authentication, tool execution, and agent loop.
/// Forge streams the output to the TUI and handles Signet integration.
pub struct CliProvider {
    cli_kind: CliKind,
    cli_path: String,
    model: String,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum CliKind {
    Claude,
    Codex,
    Gemini,
}

impl CliProvider {
    pub fn new(kind: CliKind, cli_path: String, model: String) -> Self {
        Self {
            cli_kind: kind,
            cli_path,
            model,
        }
    }

    /// Build the command arguments for each CLI tool
    fn build_args(&self, prompt: &str, opts: &crate::CompletionOpts) -> Vec<String> {
        match self.cli_kind {
            CliKind::Claude => {
                let mut args = vec![
                    "-p".to_string(),
                    prompt.to_string(),
                    "--output-format".to_string(),
                    "stream-json".to_string(),
                    "--verbose".to_string(),
                ];
                if !self.model.is_empty() {
                    args.push("--model".to_string());
                    args.push(self.model.clone());
                }
                if opts.bypass {
                    args.push("--dangerously-skip-permissions".to_string());
                }
                args
            }
            CliKind::Codex => {
                let mut args = vec![
                    "exec".to_string(),
                    "--json".to_string(),
                    "--skip-git-repo-check".to_string(),
                ];
                if !self.model.is_empty() {
                    args.push("--model".to_string());
                    args.push(self.model.clone());
                }
                if opts.bypass {
                    args.push("--dangerously-bypass-approvals-and-sandbox".to_string());
                } else {
                    // full-auto avoids interactive approval prompts
                    args.push("--full-auto".to_string());
                }
                args.push(prompt.to_string());
                args
            }
            CliKind::Gemini => {
                let mut args = vec!["-p".to_string(), prompt.to_string()];
                if !self.model.is_empty() {
                    args.push("--model".to_string());
                    args.push(self.model.clone());
                }
                // Gemini has no permission bypass — sandbox is off by default
                args
            }
        }
    }

    /// Build prompt for CLI providers.
    /// Sends system prompt (identity) + latest user message only.
    /// Skips conversation history — CLI manages its own context.
    fn build_prompt(messages: &[Message], opts: &CompletionOpts) -> String {
        let mut parts = Vec::new();

        // System prompt carries identity (SOUL.md, IDENTITY.md, etc.)
        if let Some(system) = &opts.system_prompt {
            parts.push(format!("<system>\n{system}\n</system>"));
        }

        // Only the latest user message — no conversation history replay
        if let Some(last) = messages.iter().rev().find(|m| m.role == Role::User) {
            for content in &last.content {
                if let MessageContent::Text { text } = content {
                    parts.push(text.clone());
                }
            }
        }

        if !parts.is_empty() {
            return parts.join("\n\n");
        }

        // Fallback: build full prompt if nothing else worked
        let mut parts = Vec::new();
        let history_msgs: Vec<&Message> = messages
            .iter()
            .filter(|m| m.role != Role::System)
            .collect();

        if history_msgs.len() > 1 {
            parts.push("<conversation_history>".to_string());
            for msg in &history_msgs[..history_msgs.len() - 1] {
                let role_label = match msg.role {
                    Role::User => "User",
                    Role::Assistant => "Assistant",
                    Role::System => continue,
                };
                for content in &msg.content {
                    match content {
                        MessageContent::Text { text } => {
                            parts.push(format!("{role_label}: {text}"));
                        }
                        MessageContent::ToolUse { name, input, .. } => {
                            parts.push(format!(
                                "Assistant [tool: {name}]: {}",
                                serde_json::to_string(input).unwrap_or_default()
                            ));
                        }
                        MessageContent::ToolResult { content, .. } => {
                            let truncated = if content.len() > 2000 {
                                format!("{}... (truncated)", &content[..2000])
                            } else {
                                content.clone()
                            };
                            parts.push(format!("Tool result: {truncated}"));
                        }
                    }
                }
            }
            parts.push("</conversation_history>".to_string());
        }

        // Latest user message
        if let Some(last) = history_msgs.last() {
            for content in &last.content {
                if let MessageContent::Text { text } = content {
                    parts.push(text.clone());
                }
            }
        }

        parts.join("\n\n")
    }
}

#[async_trait]
impl Provider for CliProvider {
    fn name(&self) -> &str {
        match self.cli_kind {
            CliKind::Claude => "claude-cli",
            CliKind::Codex => "codex-cli",
            CliKind::Gemini => "gemini-cli",
        }
    }

    fn model(&self) -> &str {
        if self.model.is_empty() {
            match self.cli_kind {
                CliKind::Claude => "claude-sonnet-4-6",
                CliKind::Codex => "gpt-5.4",
                CliKind::Gemini => "gemini-2.5-flash",
            }
        } else {
            &self.model
        }
    }

    fn context_window(&self) -> usize {
        match self.cli_kind {
            CliKind::Claude => 200_000,
            CliKind::Codex => 200_000,
            CliKind::Gemini => 1_000_000,
        }
    }

    async fn complete(
        &self,
        messages: &[Message],
        _tools: &[ToolDefinition],
        opts: &CompletionOpts,
    ) -> Result<CompletionStream, ForgeError> {
        let prompt = Self::build_prompt(messages, opts);
        let args = self.build_args(&prompt, opts);

        debug!(
            "Spawning CLI via PTY: {} {}",
            self.cli_path,
            args.join(" ").chars().take(200).collect::<String>()
        );

        // Use a PTY so the CLI gets line-buffered stdout (thinks it's a terminal).
        // Without this, piped stdout is fully-buffered and output arrives in large
        // chunks or only after the process exits — no live streaming.
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize { rows: 24, cols: 200, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| ForgeError::provider(format!("Failed to open PTY: {e}")))?;

        let mut cmd = CommandBuilder::new(&self.cli_path);
        cmd.args(&args);
        // Inherit full environment so CLIs get PATH, HOME, API keys, etc.
        for (k, v) in std::env::vars() {
            cmd.env(k, v);
        }
        // Then override specific vars
        cmd.env("SIGNET_NO_HOOKS", "1");
        cmd.env("TERM", "dumb");
        cmd.env("NO_COLOR", "1");
        cmd.env("LANG", "en_US.UTF-8");

        let mut child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| ForgeError::provider(format!("Failed to spawn {}: {e}", self.cli_path)))?;

        // Drop the slave side — we only read from the master
        drop(pair.slave);

        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| ForgeError::provider(format!("Failed to clone PTY reader: {e}")))?;

        // Keep master alive so we can drop it to signal EOF when child exits
        let master = pair.master;

        let (tx, rx) = tokio::sync::mpsc::channel::<StreamEvent>(256);
        let cli_kind = self.cli_kind;

        // Spawn a watcher thread: when the child exits, drop the PTY master
        // to send EOF to the reader thread (prevents hanging on macOS).
        let tx_watcher = tx.clone();
        std::thread::spawn(move || {
            match child.wait() {
                Ok(status) => {
                    if !status.success() {
                        let code = status.exit_code();
                        let err_msg = format!("CLI exited with code {code}");
                        warn!("{err_msg}");
                        let _ = tx_watcher.blocking_send(StreamEvent::Error(err_msg));
                    }
                }
                Err(e) => {
                    let _ = tx_watcher.blocking_send(StreamEvent::Error(format!("CLI process error: {e}")));
                }
            }
            // Drop master — sends EOF to the reader thread
            drop(master);
        });

        // Read PTY output on a blocking thread with large buffer (64KB like WindowedClaude)
        // to handle burst output from agent/bash tool runs without backpressure.
        tokio::task::spawn_blocking(move || {
            use std::io::Read;
            let mut raw = reader;
            let mut buf = vec![0u8; 64 * 1024];
            let mut leftover = String::new();

            // Claude CLI: track input tokens from message_start for usage reporting
            let mut claude_input_tokens: usize = 0;
            // Claude CLI: track whether text was already sent via assistant event
            let mut claude_text_sent = false;

            // Codex function_call tracking: map call_id → tool name,
            // and track which calls already emitted ToolUseStart
            let mut codex_tool_names = std::collections::HashMap::<String, String>::new();
            let mut codex_started = std::collections::HashSet::<String>::new();

            // Macro to send events from the blocking thread
            macro_rules! send {
                ($event:expr) => {
                    if tx.blocking_send($event).is_err() { return; }
                };
            }

            // Strip ANSI escape sequences for JSON parsing
            fn strip_ansi(s: &str) -> String {
                let mut out = String::with_capacity(s.len());
                let mut chars = s.chars();
                while let Some(c) = chars.next() {
                    if c == '\x1b' {
                        // Skip ESC [ ... (letter) sequences
                        if let Some(next) = chars.next() {
                            if next == '[' {
                                for inner in chars.by_ref() {
                                    if inner.is_ascii_alphabetic() || inner == 'm' || inner == 'K' || inner == 'H' || inner == 'J' {
                                        break;
                                    }
                                }
                            }
                            // Also skip ESC ] ... BEL/ST (OSC sequences)
                        }
                    } else if c == '\r' {
                        // Skip carriage returns from PTY
                        continue;
                    } else {
                        out.push(c);
                    }
                }
                out
            }

            // Read in large chunks, split into lines, process each
            'outer: loop {
                let n = match raw.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => n,
                    Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(_) => break,
                };

                let chunk = String::from_utf8_lossy(&buf[..n]);
                leftover.push_str(&chunk);

                while let Some(nl) = leftover.find('\n') {
                    let line = strip_ansi(leftover[..nl].trim());
                    leftover.drain(..nl + 1);

                    if line.is_empty() {
                        continue;
                    }
                    tracing::info!("PTY line [{}]: {}", match cli_kind { CliKind::Claude => "claude", CliKind::Codex => "codex", CliKind::Gemini => "gemini" }, &line);

                match cli_kind {
                    CliKind::Claude => {
                        let parsed: serde_json::Value = match serde_json::from_str(&line) {
                            Ok(v) => v,
                            Err(_) => {
                                send!(StreamEvent::TextDelta(format!("{line}\n")));
                                continue;
                            }
                        };

                        let event_type = parsed
                            .get("type")
                            .and_then(|v| v.as_str())
                            .unwrap_or("");

                        match event_type {
                            "assistant" => {
                                // Extract text from message.content[] array
                                // Format: {"message": {"content": [{"type": "text", "text": "..."}]}}
                                if let Some(content) = parsed
                                    .pointer("/message/content")
                                    .and_then(|v| v.as_array())
                                {
                                    for block in content {
                                        let btype = block.get("type").and_then(|v| v.as_str()).unwrap_or("");
                                        if btype == "text" {
                                            if let Some(text) = block.get("text").and_then(|v| v.as_str()) {
                                                if !text.is_empty() {
                                                    claude_text_sent = true;
                                                    send!(StreamEvent::TextDelta(text.to_string()));
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                            "content_block_start" => {
                                // Detect block type for phase updates
                                if let Some(block) = parsed.get("content_block") {
                                    let btype = block.get("type").and_then(|v| v.as_str()).unwrap_or("");
                                    match btype {
                                        "tool_use" => {
                                            let name = block.get("name").and_then(|v| v.as_str()).unwrap_or("tool");
                                            let id = block.get("id").and_then(|v| v.as_str()).unwrap_or("");
                                            send!(StreamEvent::ToolUseStart {
                                                id: id.to_string(),
                                                name: name.to_string(),
                                            });
                                        }
                                        "thinking" => {
                                            send!(StreamEvent::Status("thinking".to_string()));
                                        }
                                        _ => {}
                                    }
                                }
                            }
                            "content_block_delta" => {
                                if let Some(delta) = parsed.get("delta") {
                                    let dtype = delta.get("type").and_then(|v| v.as_str()).unwrap_or("");
                                    match dtype {
                                        "text_delta" => {
                                            if let Some(text) = delta.get("text").and_then(|v| v.as_str()) {
                                                send!(StreamEvent::TextDelta(text.to_string()));
                                            }
                                        }
                                        "input_json_delta" => {
                                            if let Some(json) = delta.get("partial_json").and_then(|v| v.as_str()) {
                                                send!(StreamEvent::ToolUseInput(json.to_string()));
                                            }
                                        }
                                        "thinking_delta" => {
                                            // Thinking content — keep phase active but don't
                                            // display to user (matches Claude Code behavior)
                                        }
                                        _ => {
                                            if let Some(text) = delta.get("text").and_then(|v| v.as_str()) {
                                                send!(StreamEvent::TextDelta(text.to_string()));
                                            }
                                        }
                                    }
                                }
                            }
                            "content_block_stop" => {
                                // Could be end of tool_use block
                                send!(StreamEvent::ToolUseEnd);
                            }
                            "tool_result" | "tool_output" => {
                                // CLI-managed tool execution result
                                let name = parsed.get("tool_name")
                                    .or_else(|| parsed.get("name"))
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("tool")
                                    .to_string();
                                let output = parsed.get("output")
                                    .or_else(|| parsed.get("content"))
                                    .map(|v| {
                                        if let Some(s) = v.as_str() { s.to_string() }
                                        else { v.to_string() }
                                    })
                                    .unwrap_or_default();
                                let is_error = parsed.get("is_error")
                                    .and_then(|v| v.as_bool())
                                    .unwrap_or(false);
                                send!(StreamEvent::ToolResult { name, output, is_error });
                            }
                            "message_start" => {
                                // Input token count from message start
                                if let Some(usage) = parsed.get("message").and_then(|m| m.get("usage")) {
                                    let input = usage.get("input_tokens").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
                                    claude_input_tokens = input;
                                }
                            }
                            "message_delta" => {
                                // Output token count + stop reason
                                if let Some(usage) = parsed.get("usage") {
                                    let output = usage.get("output_tokens").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
                                    let _ = tx.blocking_send(StreamEvent::Usage(TokenUsage {
                                        input_tokens: claude_input_tokens,
                                        output_tokens: output,
                                        ..Default::default()
                                    }));
                                }
                            }
                            "result" => {
                                // Only send text if not already sent via assistant event
                                if !claude_text_sent {
                                    if let Some(result) = parsed.get("result").and_then(|v| v.as_str()) {
                                        if !result.is_empty() {
                                            let _ = tx.blocking_send(StreamEvent::TextDelta(result.to_string()));
                                        }
                                    }
                                }
                                break 'outer;
                            }
                            _ => {}
                        }
                    }
                    CliKind::Codex => {
                        let parsed: serde_json::Value = match serde_json::from_str(&line) {
                            Ok(v) => v,
                            Err(_) => {
                                let _ = tx.blocking_send(StreamEvent::TextDelta(format!("{line}\n")));
                                continue;
                            }
                        };

                        let event_type = parsed
                            .get("type")
                            .and_then(|v| v.as_str())
                            .unwrap_or("");

                        match event_type {
                            // Early notification — tool is starting
                            "item.created" => {
                                if let Some(item) = parsed.get("item") {
                                    let item_type = item.get("type").and_then(|t| t.as_str()).unwrap_or("");
                                    if item_type == "function_call" {
                                        let name = item.get("name").and_then(|n| n.as_str()).unwrap_or("tool");
                                        let call_id = item.get("call_id")
                                            .or_else(|| item.get("id"))
                                            .and_then(|v| v.as_str())
                                            .unwrap_or("");
                                        codex_tool_names.insert(call_id.to_string(), name.to_string());
                                        codex_started.insert(call_id.to_string());
                                        send!(StreamEvent::ToolUseStart {
                                            id: call_id.to_string(),
                                            name: name.to_string(),
                                        });
                                    }
                                }
                            }
                            "item.completed" => {
                                if let Some(item) = parsed.get("item") {
                                    let item_type = item.get("type").and_then(|t| t.as_str()).unwrap_or("");
                                    match item_type {
                                        "message" => {
                                            // Extract text from content array
                                            if let Some(content) = item.get("content").and_then(|c| c.as_array()) {
                                                for block in content {
                                                    let btype = block.get("type").and_then(|t| t.as_str()).unwrap_or("");
                                                    if btype == "output_text" || btype == "text" {
                                                        if let Some(text) = block.get("text").and_then(|t| t.as_str()) {
                                                            send!(StreamEvent::TextDelta(text.to_string()));
                                                        }
                                                    }
                                                }
                                            } else if let Some(text) = item.get("text").and_then(|t| t.as_str()) {
                                                send!(StreamEvent::TextDelta(text.to_string()));
                                            }
                                        }
                                        "function_call" => {
                                            let name = item.get("name").and_then(|n| n.as_str()).unwrap_or("tool");
                                            let call_id = item.get("call_id")
                                                .or_else(|| item.get("id"))
                                                .and_then(|v| v.as_str())
                                                .unwrap_or("");
                                            codex_tool_names.insert(call_id.to_string(), name.to_string());
                                            // Emit ToolUseStart if item.created didn't fire
                                            if !codex_started.contains(call_id) {
                                                send!(StreamEvent::ToolUseStart {
                                                    id: call_id.to_string(),
                                                    name: name.to_string(),
                                                });
                                            }
                                        }
                                        "function_call_output" => {
                                            let call_id = item.get("call_id").and_then(|v| v.as_str()).unwrap_or("");
                                            let name = codex_tool_names.get(call_id)
                                                .cloned()
                                                .unwrap_or_else(|| "tool".to_string());
                                            let output = item.get("output").and_then(|o| o.as_str()).unwrap_or("");
                                            send!(StreamEvent::ToolResult {
                                                name,
                                                output: output.to_string(),
                                                is_error: false,
                                            });
                                        }
                                        "error" => {
                                            let msg = item.get("message").and_then(|m| m.as_str()).unwrap_or("Codex error");
                                            send!(StreamEvent::Error(msg.to_string()));
                                        }
                                        _ => {
                                            // Unknown item type — try text extraction
                                            if let Some(text) = item.get("text").and_then(|t| t.as_str()) {
                                                send!(StreamEvent::TextDelta(text.to_string()));
                                            }
                                        }
                                    }
                                }
                            }
                            "error" | "turn.failed" => {
                                let msg = parsed.get("message")
                                    .or_else(|| parsed.get("error").and_then(|e| e.get("message")))
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("Unknown error");
                                send!(StreamEvent::Error(msg.to_string()));
                                break 'outer;
                            }
                            "turn.completed" => {
                                if let Some(usage) = parsed.get("usage") {
                                    let input = usage.get("input_tokens").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
                                    let output = usage.get("output_tokens").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
                                    let _ = tx.blocking_send(StreamEvent::Usage(TokenUsage {
                                        input_tokens: input,
                                        output_tokens: output,
                                        ..Default::default()
                                    }));
                                }
                                break 'outer;
                            }
                            _ => {}
                        }
                    }
                    CliKind::Gemini => {
                        // Gemini CLI may output JSON or plain text depending on version.
                        // Attempt structured parsing; fall back to raw text.
                        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&line) {
                            let event_type = parsed.get("type").and_then(|v| v.as_str()).unwrap_or("");
                            match event_type {
                                "text" | "content" => {
                                    if let Some(text) = parsed.get("text")
                                        .or_else(|| parsed.get("content"))
                                        .and_then(|v| v.as_str())
                                    {
                                        send!(StreamEvent::TextDelta(text.to_string()));
                                    }
                                }
                                "tool_call" | "function_call" => {
                                    let name = parsed.get("name")
                                        .or_else(|| parsed.get("function_call").and_then(|f| f.get("name")))
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("tool");
                                    let id = parsed.get("id").and_then(|v| v.as_str()).unwrap_or("");
                                    send!(StreamEvent::ToolUseStart {
                                        id: id.to_string(),
                                        name: name.to_string(),
                                    });
                                }
                                "tool_result" | "function_response" => {
                                    let name = parsed.get("name").and_then(|v| v.as_str()).unwrap_or("tool");
                                    let output = parsed.get("output")
                                        .or_else(|| parsed.get("response"))
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("");
                                    send!(StreamEvent::ToolResult {
                                        name: name.to_string(),
                                        output: output.to_string(),
                                        is_error: false,
                                    });
                                }
                                "error" => {
                                    let msg = parsed.get("message").and_then(|v| v.as_str()).unwrap_or("Gemini error");
                                    send!(StreamEvent::Error(msg.to_string()));
                                    break 'outer;
                                }
                                "done" | "end" => break 'outer,
                                _ => {
                                    // JSON but unknown type — extract text if present
                                    if let Some(text) = parsed.get("text")
                                        .or_else(|| parsed.get("content"))
                                        .or_else(|| parsed.get("message"))
                                        .and_then(|v| v.as_str())
                                    {
                                        send!(StreamEvent::TextDelta(text.to_string()));
                                    }
                                }
                            }
                        } else {
                            // Plain text output
                            send!(StreamEvent::TextDelta(format!("{line}\n")));
                        }
                    }
                }
                } // end while let Some(nl) — line splitting
            } // end 'outer loop — chunk reading

            // Reader loop exited (EOF from master drop or process exit)
            let _ = tx.blocking_send(StreamEvent::Done);
        });

        Ok(Box::pin(ReceiverStream::new(rx)))
    }

    async fn available(&self) -> bool {
        // Check if the CLI binary exists and is executable
        tokio::process::Command::new(&self.cli_path)
            .arg("--version")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .await
            .map(|s| s.success())
            .unwrap_or(false)
    }
}

/// Detect installed CLI tools and return their paths
pub async fn detect_cli_tools() -> Vec<(CliKind, String)> {
    let checks = [
        (CliKind::Claude, "claude"),
        (CliKind::Codex, "codex"),
        (CliKind::Gemini, "gemini"),
    ];

    let mut found = Vec::new();

    for (kind, name) in &checks {
        if let Ok(output) = tokio::process::Command::new("which")
            .arg(name)
            .output()
            .await
        {
            if output.status.success() {
                let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if !path.is_empty() {
                    debug!("Found CLI tool: {name} at {path}");
                    found.push((*kind, path));
                }
            }
        }
    }

    found
}

/// Default model for each CLI tool
pub fn default_model_for_cli(kind: CliKind) -> &'static str {
    match kind {
        CliKind::Claude => "claude-sonnet-4-6",
        CliKind::Codex => "gpt-5.4",
        CliKind::Gemini => "gemini-2.5-flash",
    }
}

/// Display name for each CLI kind
pub fn cli_display_name(kind: CliKind) -> &'static str {
    match kind {
        CliKind::Claude => "Claude Code",
        CliKind::Codex => "Codex",
        CliKind::Gemini => "Gemini CLI",
    }
}
