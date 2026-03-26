use crate::client::SignetClient;
use forge_core::ForgeError;
use serde::{Deserialize, Serialize};
use tracing::debug;

#[derive(Debug, Deserialize)]
pub struct MemoryEntry {
    pub id: String,
    pub content: String,
    #[serde(default)]
    pub tags: Option<String>,
    #[serde(default)]
    pub importance: Option<f64>,
    #[serde(default)]
    pub created_at: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct RecallParams {
    pub query: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub top_k: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
}

/// Search memories via the daemon
pub async fn recall(
    client: &SignetClient,
    params: &RecallParams,
) -> Result<Vec<MemoryEntry>, ForgeError> {
    debug!("Recalling memories: query={}", params.query);

    let body = serde_json::to_value(params)
        .map_err(|e| ForgeError::daemon(format!("Failed to serialize recall params: {e}")))?;

    let result = client.post("/api/memory/recall", &body).await?;

    let memories: Vec<MemoryEntry> = serde_json::from_value(
        result
            .get("memories")
            .or_else(|| result.get("results"))
            .cloned()
            .unwrap_or(serde_json::Value::Array(vec![])),
    )
    .unwrap_or_default();

    debug!("Recalled {} memories", memories.len());
    Ok(memories)
}

/// Store a new memory via the daemon
pub async fn remember(
    client: &SignetClient,
    content: &str,
    tags: Option<&str>,
) -> Result<String, ForgeError> {
    debug!("Storing memory: {} bytes", content.len());

    let mut body = serde_json::json!({
        "content": content,
    });

    if let Some(t) = tags {
        body["tags"] = serde_json::json!(t);
    }

    let result = client.post("/api/memory/remember", &body).await?;

    let id = result
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown")
        .to_string();

    debug!("Stored memory with id: {id}");
    Ok(id)
}
