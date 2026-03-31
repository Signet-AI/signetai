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
    /// Post-turn compaction threshold (0.0 - 1.0)
    compact_threshold: f64,
    /// Pre-sampling compaction threshold — lower than post-turn to catch
    /// approaching limits before wasting an LLM call (0.0 - 1.0)
    pre_sample_threshold: f64,
    /// Optional cheaper/faster provider for summarization.
    /// Falls back to the primary provider if None.
    compaction_provider: Option<Arc<dyn Provider>>,
}

impl ContextManager {
    pub fn new(max_tokens: usize) -> Self {
        Self {
            max_tokens,
            compact_threshold: 0.9,
            pre_sample_threshold: 0.8,
            compaction_provider: None,
        }
    }

    /// Set an auxiliary provider for compaction (e.g. local Ollama model).
    /// When set, compaction uses this instead of the primary conversational model.
    pub fn with_compaction_provider(mut self, provider: Arc<dyn Provider>) -> Self {
        self.compaction_provider = Some(provider);
        self
    }

    /// Check if we should compact the context (post-turn, 90% threshold)
    pub fn should_compact(&self, current_tokens: usize) -> bool {
        current_tokens as f64 > self.max_tokens as f64 * self.compact_threshold
    }

    /// Check if we should compact before calling the LLM (80% threshold).
    /// Prevents wasted calls on prompts that will exceed the context window.
    pub fn should_compact_before_sampling(&self, current_tokens: usize) -> bool {
        current_tokens as f64 > self.max_tokens as f64 * self.pre_sample_threshold
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

    /// Compact the session by summarizing older messages.
    /// Uses the auxiliary compaction provider if configured, otherwise
    /// falls back to the primary conversational model.
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

        // Use auxiliary provider if available, otherwise fall back to primary.
        // The auxiliary provider is typically a cheaper/faster local model
        // (e.g. Ollama qwen3:4b) that produces adequate summaries without
        // burning expensive API tokens on the primary model.
        let summary_provider = self.compaction_provider.as_ref().unwrap_or(provider);
        let provider_name = summary_provider.name();

        debug!("Running compaction via {} provider", provider_name);

        let stream = summary_provider
            .complete(&summary_messages, &[], &opts)
            .await
            .map_err(|e| {
                // If auxiliary provider fails, try primary as fallback
                if self.compaction_provider.is_some() {
                    warn!("Auxiliary compaction provider failed: {e}, falling back to primary");
                }
                format!("Compaction LLM call failed: {e}")
            });

        // Fallback: if auxiliary failed, try the primary provider
        let stream = match stream {
            Ok(s) => s,
            Err(_) if self.compaction_provider.is_some() => {
                info!("Falling back to primary provider for compaction");
                provider
                    .complete(&summary_messages, &[], &opts)
                    .await
                    .map_err(|e2| format!("Primary fallback also failed: {e2}"))?
            }
            Err(e) => return Err(e),
        };

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
                "Compacted {} messages into summary + {} kept messages (via {})",
                to_summarize.len(),
                to_keep.len(),
                provider_name
            );
        }

        Ok(())
    }

    pub fn max_tokens(&self) -> usize {
        self.max_tokens
    }
}
