//! Shared memory embedding helpers for write and repair routes.

use std::sync::Arc;

use rusqlite::{Connection, params};
use tracing::warn;

use signet_core::CoreError;
use signet_core::queries::embedding::{InsertEmbedding, upsert};

use crate::state::AppState;

#[derive(Clone, Debug)]
pub(crate) struct PreparedMemoryEmbedding {
    pub provider: String,
    pub vector: Vec<f32>,
}

pub(crate) async fn prepare_memory_embedding(
    state: &Arc<AppState>,
    content: &str,
) -> Option<PreparedMemoryEmbedding> {
    let provider = state.embedding.read().await.clone()?;
    let provider_name = provider.name().to_string();
    let expected_dimensions = provider.dimensions();
    let vector = provider.embed(content).await?;
    if vector.len() != expected_dimensions {
        warn!(
            provider = %provider_name,
            expected_dimensions,
            actual_dimensions = vector.len(),
            "memory embedding provider returned unexpected dimensions"
        );
        return None;
    }
    Some(PreparedMemoryEmbedding {
        provider: provider_name,
        vector,
    })
}

pub(crate) fn memory_has_embedding(conn: &Connection, memory_id: &str) -> Result<bool, CoreError> {
    let count: i64 = conn.query_row(
        "SELECT COUNT(*)
         FROM embeddings
         WHERE source_type = 'memory'
           AND source_id = ?1",
        params![memory_id],
        |row| row.get(0),
    )?;
    Ok(count > 0)
}

pub(crate) fn memory_embedding_hash(agent_id: &str, memory_id: &str, memory_hash: &str) -> String {
    format!("memory:{agent_id}:{memory_id}:{memory_hash}")
}

pub(crate) fn upsert_memory_embedding(
    conn: &Connection,
    memory_id: &str,
    memory_hash: &str,
    content: &str,
    agent_id: &str,
    embedding: Option<&PreparedMemoryEmbedding>,
) -> Result<bool, CoreError> {
    let Some(embedding) = embedding else {
        return Ok(false);
    };

    let now = chrono::Utc::now().to_rfc3339();
    let embedding_id = format!("memory:{memory_id}");
    let embedding_hash = memory_embedding_hash(agent_id, memory_id, memory_hash);
    upsert(
        conn,
        &InsertEmbedding {
            id: &embedding_id,
            content_hash: &embedding_hash,
            vector: &embedding.vector,
            source_type: "memory",
            source_id: memory_id,
            chunk_text: content,
            now: &now,
            agent_id: Some(agent_id),
        },
    )?;
    conn.execute(
        "UPDATE memories
         SET embedding_model = ?1
         WHERE id = ?2",
        params![embedding.provider, memory_id],
    )?;
    Ok(true)
}
