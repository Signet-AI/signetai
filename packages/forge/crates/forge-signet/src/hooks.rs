use crate::client::SignetClient;
use crate::recall_cache::RecallCache;
use forge_core::ForgeError;
use serde::Serialize;
use tracing::debug;

/// Manages Signet session lifecycle hooks.
///
/// These hooks communicate with the Signet daemon to:
/// - Inject memories at session start and per-prompt
/// - Trigger extraction pipeline on session end
///
/// IMPORTANT: The daemon handles extraction and embedding using its OWN
/// configured models (agent.yaml pipelineV2.extraction and embedding).
/// Forge's conversational model (the one the user talks to) is completely
/// separate. Changing the conversational model via the model picker does
/// NOT affect extraction or embedding.
pub struct SessionHooks {
    client: SignetClient,
    session_id: String,
    project: Option<String>,
    /// Cache for recent recall results — avoids redundant daemon calls
    recall_cache: RecallCache,
}

/// Payload sent to session-start hook
#[derive(Serialize)]
struct SessionStartPayload {
    harness: String,
    #[serde(rename = "sessionId")]
    session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    cwd: Option<String>,
    #[serde(rename = "runtimePath")]
    runtime_path: String,
}

/// Payload sent to user-prompt-submit hook
#[derive(Serialize)]
struct PromptSubmitPayload {
    harness: String,
    #[serde(rename = "sessionId")]
    session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    cwd: Option<String>,
    #[serde(rename = "userMessage")]
    user_message: String,
    #[serde(rename = "runtimePath")]
    runtime_path: String,
}

/// Payload sent to session-end hook.
/// The daemon uses this to enqueue a summary job which triggers
/// extraction using the daemon's own extraction model (typically
/// qwen3:4b via Ollama), NOT the conversational model.
#[derive(Serialize)]
struct SessionEndPayload {
    harness: String,
    #[serde(rename = "sessionId")]
    session_id: String,
    #[serde(rename = "sessionKey")]
    session_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    cwd: Option<String>,
    transcript: String,
    reason: String,
    #[serde(rename = "runtimePath")]
    runtime_path: String,
}

/// Payload sent to pre-compaction hook
#[derive(Serialize)]
struct PreCompactionPayload {
    harness: String,
    #[serde(rename = "sessionId")]
    session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    cwd: Option<String>,
    #[serde(rename = "runtimePath")]
    runtime_path: String,
}

const HARNESS_NAME: &str = "forge";
/// Forge uses "plugin" runtime path — it's a Signet-native harness,
/// not a legacy shell-hook connector
const RUNTIME_PATH: &str = "plugin";

impl SessionHooks {
    pub fn new(client: SignetClient, session_id: String, project: Option<String>) -> Self {
        Self {
            client,
            session_id,
            project,
            recall_cache: RecallCache::new(),
        }
    }

    /// Create with a shared recall cache (for speculative pre-recall from TUI)
    pub fn with_cache(
        client: SignetClient,
        session_id: String,
        project: Option<String>,
        cache: RecallCache,
    ) -> Self {
        Self {
            client,
            session_id,
            project,
            recall_cache: cache,
        }
    }

    /// Get a clone of the recall cache for sharing with the TUI
    pub fn recall_cache(&self) -> RecallCache {
        self.recall_cache.clone()
    }

    /// Call session-start hook — returns (injection_text, memory_count).
    /// The daemon injects relevant memories based on the project context
    /// and the predictor sidecar's relevance scoring.
    pub async fn session_start(&self) -> Result<(String, usize), ForgeError> {
        debug!("Calling session-start hook for session {}", self.session_id);

        let payload = SessionStartPayload {
            harness: HARNESS_NAME.to_string(),
            session_id: self.session_id.clone(),
            cwd: self.project.clone(),
            runtime_path: RUNTIME_PATH.to_string(),
        };

        let body = serde_json::to_value(&payload)
            .map_err(|e| ForgeError::daemon(format!("Failed to serialize payload: {e}")))?;

        let result = self.client.post("/api/hooks/session-start", &body).await?;

        // The daemon returns combined injection text in the "inject" field,
        // plus structured data in "memories", "identity", "recentContext"
        let context = result
            .get("inject")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        // Count memories from the structured array if available
        let memory_count = result
            .get("memories")
            .and_then(|v| v.as_array())
            .map(|a| a.len())
            .unwrap_or(0);

        debug!(
            "Session start: {} bytes inject, {} memories",
            context.len(),
            memory_count
        );
        Ok((context, memory_count))
    }

    /// Call user-prompt-submit hook — returns (injection_text, memory_count).
    /// The daemon runs hybrid search (vector + keyword) against the memory
    /// database using the user's message as the query, scored by the
    /// predictor sidecar and importance decay.
    pub async fn prompt_submit(&self, user_message: &str) -> Result<(String, usize), ForgeError> {
        // Check cache first — avoids daemon round-trip for repeated/similar queries
        if let Some(cached) = self.recall_cache.get(user_message).await {
            debug!("Recall cache hit for query ({}ms saved)", "~200-2000");
            return Ok(cached);
        }

        debug!("Calling user-prompt-submit hook (cache miss)");

        let payload = PromptSubmitPayload {
            harness: HARNESS_NAME.to_string(),
            session_id: self.session_id.clone(),
            cwd: self.project.clone(),
            user_message: user_message.to_string(),
            runtime_path: RUNTIME_PATH.to_string(),
        };

        let body = serde_json::to_value(&payload)
            .map_err(|e| ForgeError::daemon(format!("Failed to serialize payload: {e}")))?;

        let result = self
            .client
            .post("/api/hooks/user-prompt-submit", &body)
            .await?;

        let injection = result
            .get("inject")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        let memory_count = result
            .get("memoryCount")
            .and_then(|v| v.as_u64())
            .unwrap_or(0);

        let count = memory_count as usize;

        debug!(
            "Prompt submit: {} bytes inject, {} memories",
            injection.len(),
            count
        );

        // Cache the result for future exact-match queries
        self.recall_cache
            .put(user_message.to_string(), injection.clone(), count)
            .await;

        Ok((injection, count))
    }

    /// Call pre-compaction hook — called before auto-compacting context.
    /// The daemon may return instructions for how to structure the summary.
    pub async fn pre_compaction(&self) -> Result<String, ForgeError> {
        debug!("Calling pre-compaction hook");

        let payload = PreCompactionPayload {
            harness: HARNESS_NAME.to_string(),
            session_id: self.session_id.clone(),
            cwd: self.project.clone(),
            runtime_path: RUNTIME_PATH.to_string(),
        };

        let body = serde_json::to_value(&payload)
            .map_err(|e| ForgeError::daemon(format!("Failed to serialize payload: {e}")))?;

        let result = self
            .client
            .post("/api/hooks/pre-compaction", &body)
            .await?;

        let instructions = result
            .get("stdout")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        Ok(instructions)
    }

    /// Call session-end hook — triggers the extraction pipeline.
    ///
    /// The daemon will:
    /// 1. Write raw transcript to session_transcripts table
    /// 2. Enqueue a summary job (async, non-blocking)
    /// 3. The summary worker uses its OWN synthesis model
    ///    (pipelineV2.synthesis.{provider,model}) to extract facts
    /// 4. Those facts trigger extraction jobs processed by the extraction
    ///    worker using the extraction model (pipelineV2.extraction.{provider,model})
    /// 5. Embeddings are computed using the embedding model
    ///    (embedding.{provider,model}) — typically nomic-embed-text via Ollama
    ///
    /// None of these models are the conversational model that Forge uses.
    /// Forge sends the transcript and the daemon handles everything else.
    pub async fn session_end(&self, transcript: &str) -> Result<(), ForgeError> {
        // Clear recall cache — extraction will create new memories
        self.recall_cache.clear().await;

        debug!(
            "Calling session-end hook for session {} ({} bytes transcript)",
            self.session_id,
            transcript.len()
        );

        // Don't submit tiny transcripts — daemon ignores < 500 chars anyway
        if transcript.len() < 500 {
            debug!("Transcript too short ({} bytes), skipping session-end hook", transcript.len());
            return Ok(());
        }

        let payload = SessionEndPayload {
            harness: HARNESS_NAME.to_string(),
            session_id: self.session_id.clone(),
            session_key: self.session_id.clone(), // Use session ID as key for dedup
            cwd: self.project.clone(),
            transcript: transcript.to_string(),
            reason: "normal".to_string(),
            runtime_path: RUNTIME_PATH.to_string(),
        };

        let body = serde_json::to_value(&payload)
            .map_err(|e| ForgeError::daemon(format!("Failed to serialize payload: {e}")))?;

        self.client
            .post("/api/hooks/session-end", &body)
            .await?;

        debug!("Session end hook completed — extraction pipeline queued");
        Ok(())
    }

    pub fn session_id(&self) -> &str {
        &self.session_id
    }
}
