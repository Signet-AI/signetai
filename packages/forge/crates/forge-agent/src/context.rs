use crate::session::SharedSession;
use forge_core::Message;
use forge_provider::{CompletionOpts, Provider};
use forge_signet::hooks::SessionHooks;
use futures::StreamExt;
use std::sync::Arc;
use tracing::{debug, info, warn};

/// Manages context window and handles compaction
pub struct ContextManager {
    /// Maximum tokens before triggering compaction
    max_tokens: usize,
    /// Threshold percentage to trigger compaction (0.0 - 1.0)
    compact_threshold: f64,
}

impl ContextManager {
    pub fn new(max_tokens: usize) -> Self {
        Self {
            max_tokens,
            compact_threshold: 0.9,
        }
    }

    /// Check if we should compact the context
    pub fn should_compact(&self, current_tokens: usize) -> bool {
        current_tokens as f64 > self.max_tokens as f64 * self.compact_threshold
    }

    /// Estimate token count for messages (rough heuristic: ~4 chars per token)
    pub fn estimate_tokens(messages: &[Message]) -> usize {
        messages.iter().map(|m| {
            let text_len: usize = m.content.iter().map(|c| match c {
                forge_core::MessageContent::Text { text } => text.len(),
                forge_core::MessageContent::ToolUse { input, .. } => {
                    input.to_string().len()
                }
                forge_core::MessageContent::ToolResult { content, .. } => {
                    content.len()
                }
            }).sum();
            text_len / 4
        }).sum()
    }

    /// Compact the session by summarizing older messages
    pub async fn compact(
        &self,
        session: &SharedSession,
        provider: &Arc<dyn Provider>,
        hooks: Option<&SessionHooks>,
    ) -> Result<(), String> {
        info!("Context compaction triggered");

        // Call pre-compaction hook if available
        let _hook_instructions = if let Some(hooks) = hooks {
            match hooks.pre_compaction().await {
                Ok(instructions) => {
                    debug!("Pre-compaction hook returned {} bytes", instructions.len());
                    instructions
                }
                Err(e) => {
                    warn!("Pre-compaction hook failed: {e}");
                    String::new()
                }
            }
        } else {
            String::new()
        };

        let messages = {
            let s = session.lock().await;
            s.messages.clone()
        };

        if messages.len() < 4 {
            debug!("Too few messages to compact");
            return Ok(());
        }

        // Keep the last 2 messages (most recent context), summarize the rest
        let to_summarize = &messages[..messages.len() - 2];
        let to_keep = &messages[messages.len() - 2..];

        // Build a summary request
        let summary_prompt = format!(
            "Summarize the following conversation concisely, preserving key decisions, \
             code changes, file paths, and technical context. This summary will replace \
             the original messages to save context space.\n\n{}",
            to_summarize
                .iter()
                .map(|m| {
                    let role = match m.role {
                        forge_core::Role::System => "System",
                        forge_core::Role::User => "User",
                        forge_core::Role::Assistant => "Assistant",
                    };
                    format!("{role}: {}", m.text())
                })
                .collect::<Vec<_>>()
                .join("\n\n")
        );

        let summary_messages = vec![Message::user(&summary_prompt)];

        let opts = CompletionOpts {
            system_prompt: Some(
                "You are a conversation summarizer. Produce a concise summary \
                 that preserves all technical details, decisions, file paths, \
                 and code changes."
                    .to_string(),
            ),
            max_tokens: Some(2048),
            ..Default::default()
        };

        let stream = provider
            .complete(&summary_messages, &[], &opts)
            .await
            .map_err(|e| format!("Compaction LLM call failed: {e}"))?;

        let mut summary_text = String::new();
        let mut stream = std::pin::pin!(stream);
        while let Some(event) = stream.next().await {
            if let forge_provider::StreamEvent::TextDelta(text) = event {
                summary_text.push_str(&text);
            }
        }

        if summary_text.is_empty() {
            return Err("Compaction produced empty summary".to_string());
        }

        // Replace messages: summary + kept messages
        let summary_msg = Message::user(format!(
            "[Context Summary]\n\n{summary_text}"
        ));

        {
            let mut s = session.lock().await;
            s.messages.clear();
            s.messages.push(summary_msg);
            s.messages.extend_from_slice(to_keep);
            info!(
                "Compacted {} messages into summary + {} kept messages",
                to_summarize.len(),
                to_keep.len()
            );
        }

        Ok(())
    }

    pub fn max_tokens(&self) -> usize {
        self.max_tokens
    }
}
