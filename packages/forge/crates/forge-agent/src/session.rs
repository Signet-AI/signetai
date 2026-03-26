use chrono::{DateTime, Utc};
use forge_core::Message;
use std::sync::Arc;
use tokio::sync::Mutex;
use uuid::Uuid;

/// Shared session handle — both the agent loop and TUI hold a reference
pub type SharedSession = Arc<Mutex<Session>>;

/// Represents a conversation session
#[derive(Debug)]
pub struct Session {
    pub id: String,
    pub messages: Vec<Message>,
    pub started_at: DateTime<Utc>,
    pub model: String,
    pub provider: String,
    pub project: Option<String>,
    pub total_input_tokens: usize,
    pub total_output_tokens: usize,
}

impl Session {
    pub fn new(model: &str, provider: &str, project: Option<String>) -> Self {
        Self {
            id: Uuid::new_v4().to_string(),
            messages: Vec::new(),
            started_at: Utc::now(),
            model: model.to_string(),
            provider: provider.to_string(),
            project,
            total_input_tokens: 0,
            total_output_tokens: 0,
        }
    }

    pub fn shared(model: &str, provider: &str, project: Option<String>) -> SharedSession {
        Arc::new(Mutex::new(Self::new(model, provider, project)))
    }

    pub fn add_message(&mut self, message: Message) {
        self.messages.push(message);
    }

    pub fn total_tokens(&self) -> usize {
        self.total_input_tokens + self.total_output_tokens
    }

    /// Build transcript from conversation history (for session-end hook)
    pub fn transcript(&self) -> String {
        self.messages
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
    }
}
