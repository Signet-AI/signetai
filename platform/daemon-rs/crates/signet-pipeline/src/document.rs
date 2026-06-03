//! Document worker: ingest external documents via chunking + embedding.
//!
//! Polls `memory_jobs` for `document_ingest` jobs, fetches content,
//! splits into overlapping chunks, embeds each chunk, and indexes.

use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::sync::watch;
use tracing::{info, warn};

use signet_core::db::DbPool;

use signet_core::queries::embedding::{self, InsertEmbedding};
use signet_services::normalize::normalize_and_hash;

use crate::embedding::EmbeddingProvider;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/// Configuration for the document worker.
#[derive(Debug, Clone)]
pub struct DocumentConfig {
    pub poll_ms: u64,
    pub max_retries: u32,
    pub chunk_size: usize,
    pub chunk_overlap: usize,
    pub max_chunks: usize,
    pub extraction_timeout_ms: u64,
    pub extraction_max_tokens: u32,
    pub embedding_model: Option<String>,
}

impl Default for DocumentConfig {
    fn default() -> Self {
        Self {
            poll_ms: 2_000,
            max_retries: 3,
            chunk_size: 1024,
            chunk_overlap: 128,
            max_chunks: 100,
            extraction_timeout_ms: 60_000,
            extraction_max_tokens: 2048,
            embedding_model: None,
        }
    }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// A document chunk ready for embedding.
#[derive(Debug, Clone)]
pub struct Chunk {
    pub index: usize,
    pub text: String,
    pub start: usize,
    pub end: usize,
}

#[derive(Debug, Clone)]
struct EmbeddedChunk {
    chunk: Chunk,
    vector: Option<Vec<f32>>,
}

/// Result of document ingestion.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentResult {
    pub chunks_created: usize,
    pub chunks_skipped: usize,
    pub total_chars: usize,
}

// ---------------------------------------------------------------------------
// Worker handle
// ---------------------------------------------------------------------------

pub struct DocumentHandle {
    shutdown: watch::Sender<bool>,
    handle: tokio::task::JoinHandle<()>,
}

impl DocumentHandle {
    pub async fn stop(self) {
        let _ = self.shutdown.send(true);
        let _ = self.handle.await;
    }
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

pub fn start(
    pool: DbPool,
    provider: Arc<dyn EmbeddingProvider>,
    config: DocumentConfig,
) -> DocumentHandle {
    let (tx, rx) = watch::channel(false);
    let handle = tokio::spawn(worker_loop(pool, provider, config, rx));
    DocumentHandle {
        shutdown: tx,
        handle,
    }
}

async fn worker_loop(
    pool: DbPool,
    provider: Arc<dyn EmbeddingProvider>,
    config: DocumentConfig,
    mut shutdown: watch::Receiver<bool>,
) {
    let mut failures: u32 = 0;
    let base = Duration::from_millis(config.poll_ms);
    let max = Duration::from_secs(120);

    info!(poll_ms = config.poll_ms, "document worker started");

    loop {
        if *shutdown.borrow() {
            info!("document worker shutting down");
            break;
        }

        let delay = if failures > 0 {
            (base * 2u32.pow(failures.min(6))).min(max)
        } else {
            base
        };

        tokio::select! {
            _ = tokio::time::sleep(delay) => {}
            _ = shutdown.changed() => {
                info!("document worker shutting down");
                break;
            }
        }

        // Lease a document_ingest job
        let job = match lease_document_job(&pool, config.max_retries).await {
            Ok(Some(j)) => j,
            Ok(None) => continue,
            Err(e) => {
                warn!(err = %e, "failed to lease document job");
                failures += 1;
                continue;
            }
        };

        info!(job_id = %job.id, "processing document ingest job");

        match process_document(&pool, provider.as_ref(), &job, &config).await {
            Ok(result) => {
                failures = 0;
                let json = serde_json::to_string(&result).unwrap_or_default();
                if let Err(e) = complete_document_job(&pool, &job.id, &json).await {
                    warn!(err = %e, "failed to complete document job");
                }
                info!(
                    job_id = %job.id,
                    chunks = result.chunks_created,
                    chars = result.total_chars,
                    "document ingestion completed"
                );
            }
            Err(e) => {
                failures += 1;
                warn!(err = %e, job_id = %job.id, "document job failed");
                if let Err(fe) = fail_document_job(&pool, &job.id, &e).await {
                    warn!(err = %fe, "failed to record document failure");
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Job processing
// ---------------------------------------------------------------------------

/// Split content into overlapping chunks.
pub fn chunk_content(content: &str, size: usize, overlap: usize, max: usize) -> Vec<Chunk> {
    let mut chunks = Vec::new();
    let bytes = content.as_bytes();
    let mut start = 0;

    while start < bytes.len() && chunks.len() < max {
        let end = (start + size).min(bytes.len());

        // Find a safe UTF-8 boundary
        let safe_end = if end < bytes.len() {
            // Walk back to find a char boundary
            let mut e = end;
            while e > start && !content.is_char_boundary(e) {
                e -= 1;
            }
            e
        } else {
            end
        };

        if safe_end <= start {
            break;
        }

        chunks.push(Chunk {
            index: chunks.len(),
            text: content[start..safe_end].to_string(),
            start,
            end: safe_end,
        });

        // Advance by (size - overlap), ensuring progress
        let step = size.saturating_sub(overlap).max(1);
        start += step;

        // Find next char boundary
        while start < bytes.len() && !content.is_char_boundary(start) {
            start += 1;
        }
    }

    chunks
}

async fn process_document(
    pool: &DbPool,
    provider: &dyn EmbeddingProvider,
    job: &DocumentJob,
    config: &DocumentConfig,
) -> Result<DocumentResult, String> {
    let content = job
        .payload
        .as_deref()
        .ok_or("document job missing payload")?;

    // Parse payload to get content
    let payload: serde_json::Value =
        serde_json::from_str(content).map_err(|e| format!("invalid payload: {e}"))?;

    let text = payload["content"]
        .as_str()
        .ok_or("payload missing 'content' field")?;
    let agent_id = document_payload_agent_id(&payload);
    let document_id = job.document_id.clone().or_else(|| {
        payload["documentId"]
            .as_str()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned)
    });

    if text.trim().is_empty() {
        if let Some(document_id) = document_id {
            mark_document_done(pool, &document_id, 0, 0).await?;
        }
        return Ok(DocumentResult {
            chunks_created: 0,
            chunks_skipped: 0,
            total_chars: 0,
        });
    }

    let chunks = chunk_content(
        text,
        config.chunk_size,
        config.chunk_overlap,
        config.max_chunks,
    );
    let total_chars = text.len();
    let chunks_created = chunks.len();
    if let Some(document_id) = document_id.as_ref() {
        update_document_status(pool, document_id, "embedding", None).await?;
    }

    let mut embedded_chunks = Vec::with_capacity(chunks.len());
    for chunk in chunks {
        let vector = match provider.embed(&chunk.text).await {
            Some(vector) if vector.len() == provider.dimensions() => Some(vector),
            Some(vector) => {
                warn!(
                    expected = provider.dimensions(),
                    got = vector.len(),
                    document_id = document_id.as_deref().unwrap_or(""),
                    "document chunk embedding dimension mismatch"
                );
                None
            }
            None => None,
        };
        embedded_chunks.push(EmbeddedChunk { chunk, vector });
    }

    if let Some(document_id) = document_id {
        update_document_status(pool, &document_id, "indexing", None).await?;
        persist_document_chunks(pool, &document_id, &agent_id, &embedded_chunks, config).await?;
    }

    Ok(DocumentResult {
        chunks_created,
        chunks_skipped: 0,
        total_chars,
    })
}

// ---------------------------------------------------------------------------
// Job types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
struct DocumentJob {
    id: String,
    document_id: Option<String>,
    payload: Option<String>,
    attempts: i64,
}

fn document_payload_agent_id(payload: &serde_json::Value) -> String {
    payload
        .get("agentId")
        .or_else(|| payload.get("agent_id"))
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("default")
        .to_string()
}

fn document_memory_embedding_hash(agent_id: &str, memory_id: &str, memory_hash: &str) -> String {
    format!("memory:{agent_id}:{memory_id}:{memory_hash}")
}

async fn update_document_status(
    pool: &DbPool,
    document_id: &str,
    status: &str,
    error: Option<&str>,
) -> Result<(), String> {
    let document_id = document_id.to_string();
    let status = status.to_string();
    let error = error.map(ToOwned::to_owned);
    pool.write(signet_core::db::Priority::Low, move |conn| {
        let ts = chrono::Utc::now().to_rfc3339();
        conn.execute(
            "UPDATE documents
             SET status = ?1,
                 error = ?2,
                 updated_at = ?3
             WHERE id = ?4",
            rusqlite::params![status, error, ts, document_id],
        )?;
        Ok(serde_json::Value::Null)
    })
    .await
    .map(|_| ())
    .map_err(|error| error.to_string())
}

async fn mark_document_done(
    pool: &DbPool,
    document_id: &str,
    chunk_count: usize,
    memory_count: usize,
) -> Result<(), String> {
    let document_id = document_id.to_string();
    pool.write(signet_core::db::Priority::Low, move |conn| {
        let ts = chrono::Utc::now().to_rfc3339();
        conn.execute(
            "UPDATE documents
             SET status = 'done',
                 chunk_count = ?1,
                 memory_count = ?2,
                 completed_at = ?3,
                 updated_at = ?3
             WHERE id = ?4",
            rusqlite::params![chunk_count, memory_count, ts, document_id],
        )?;
        Ok(serde_json::Value::Null)
    })
    .await
    .map(|_| ())
    .map_err(|error| error.to_string())
}

async fn persist_document_chunks(
    pool: &DbPool,
    document_id: &str,
    agent_id: &str,
    chunks: &[EmbeddedChunk],
    config: &DocumentConfig,
) -> Result<(), String> {
    let document_id = document_id.to_string();
    let agent_id = agent_id.to_string();
    let chunks = chunks.to_vec();
    let embedding_model = config.embedding_model.clone();
    pool.write(signet_core::db::Priority::Low, move |conn| {
        let ts = chrono::Utc::now().to_rfc3339();
        let old_memory_ids = {
            let mut stmt = conn
                .prepare_cached("SELECT memory_id FROM document_memories WHERE document_id = ?1")?;
            stmt.query_map(rusqlite::params![document_id], |row| {
                row.get::<_, String>(0)
            })?
            .filter_map(Result::ok)
            .collect::<Vec<_>>()
        };
        conn.execute(
            "DELETE FROM document_memories WHERE document_id = ?1",
            rusqlite::params![document_id],
        )?;
        for memory_id in old_memory_ids {
            let _ = embedding::delete_by_source(conn, "memory", &memory_id, None);
            conn.execute(
                "UPDATE memories
                 SET is_deleted = 1, deleted_at = ?1, updated_at = ?1
                 WHERE id = ?2",
                rusqlite::params![ts, memory_id],
            )?;
        }

        for chunk in &chunks {
            let normalized = normalize_and_hash(&chunk.chunk.text);
            let existing_memory_id = conn
                .query_row(
                    "SELECT id FROM memories
                     WHERE content_hash = ?1
                       AND COALESCE(is_deleted, 0) = 0
                       AND agent_id = ?2
                       AND visibility = 'private'
                       AND IFNULL(scope, '') = ''
                     LIMIT 1",
                    rusqlite::params![normalized.hash, agent_id],
                    |row| row.get::<_, String>(0),
                )
                .ok();
            let memory_id = uuid::Uuid::new_v4().to_string();
            let linked_memory_id = if let Some(existing) = existing_memory_id {
                existing
            } else {
                conn.execute(
                    "INSERT INTO memories
                     (id, type, category, content, normalized_content, content_hash,
                      confidence, importance, source_id, source_type, tags, created_at,
                     updated_at, updated_by, vector_clock, agent_id, visibility,
                     is_deleted, extraction_status, embedding_model)
                     VALUES (?1, 'document_chunk', 'document_chunk', ?2, ?3, ?4,
                             1.0, 0.3, ?5, 'document', ?6, ?7,
                             ?7, 'document-worker', '{}', ?8, 'private',
                             0, 'none', ?9)",
                    rusqlite::params![
                        memory_id,
                        normalized.storage,
                        normalized.normalized,
                        normalized.hash,
                        document_id,
                        format!("document,chunk:{}", chunk.chunk.index),
                        ts,
                        agent_id,
                        chunk.vector.as_ref().and(embedding_model.as_deref()),
                    ],
                )?;
                memory_id
            };
            conn.execute(
                "INSERT INTO document_memories (document_id, memory_id, chunk_index)
                 VALUES (?1, ?2, ?3)",
                rusqlite::params![document_id, linked_memory_id, chunk.chunk.index],
            )?;

            if let Some(vector) = chunk.vector.as_ref() {
                let linked_agent_id: String = conn.query_row(
                    "SELECT COALESCE(NULLIF(agent_id, ''), 'default')
                     FROM memories
                     WHERE id = ?1",
                    rusqlite::params![linked_memory_id],
                    |row| row.get(0),
                )?;
                let embedding_hash = document_memory_embedding_hash(
                    &linked_agent_id,
                    &linked_memory_id,
                    &normalized.hash,
                );
                embedding::upsert(
                    conn,
                    &InsertEmbedding {
                        id: &uuid::Uuid::new_v4().to_string(),
                        content_hash: &embedding_hash,
                        vector,
                        source_type: "memory",
                        source_id: &linked_memory_id,
                        chunk_text: &chunk.chunk.text,
                        now: &ts,
                        agent_id: Some(&linked_agent_id),
                    },
                )?;
            }
        }
        conn.execute(
            "UPDATE documents
             SET status = 'done',
                 chunk_count = ?1,
                 memory_count = ?1,
                 completed_at = ?2,
                 updated_at = ?2
             WHERE id = ?3",
            rusqlite::params![chunks.len(), ts, document_id],
        )?;
        Ok(serde_json::Value::Null)
    })
    .await
    .map(|_| ())
    .map_err(|error| error.to_string())
}

// ---------------------------------------------------------------------------
// Job queue
// ---------------------------------------------------------------------------

async fn lease_document_job(
    pool: &DbPool,
    max_attempts: u32,
) -> Result<Option<DocumentJob>, String> {
    let val = pool
        .write(signet_core::db::Priority::Low, move |conn| {
            let ts = chrono::Utc::now().to_rfc3339();
            let mut stmt = conn.prepare_cached(
                "UPDATE memory_jobs SET status = 'leased', leased_at = ?1, updated_at = ?1, attempts = attempts + 1
                 WHERE id = (
                    SELECT id FROM memory_jobs
                    WHERE status = 'pending' AND job_type = 'document_ingest' AND attempts < ?2
                    ORDER BY created_at ASC LIMIT 1
                ) RETURNING id, document_id, payload, attempts",
            )?;

            let job = stmt
                .query_row(rusqlite::params![ts, max_attempts], |row| {
                    Ok(serde_json::json!({
                        "id": row.get::<_, String>(0)?,
                        "document_id": row.get::<_, Option<String>>(1)?,
                        "payload": row.get::<_, Option<String>>(2)?,
                        "attempts": row.get::<_, i64>(3)?,
                    }))
                })
                .ok();

            Ok(job.unwrap_or(serde_json::Value::Null))
        })
        .await
        .map_err(|e| e.to_string())?;

    if val.is_null() {
        Ok(None)
    } else {
        serde_json::from_value(val).map_err(|e| e.to_string())
    }
}

async fn complete_document_job(pool: &DbPool, job_id: &str, result: &str) -> Result<(), String> {
    let id = job_id.to_string();
    let result = result.to_string();
    pool.write(signet_core::db::Priority::Low, move |conn| {
        let ts = chrono::Utc::now().to_rfc3339();
        conn.execute(
            "UPDATE memory_jobs SET status = 'completed', result = ?1, completed_at = ?2, updated_at = ?2 WHERE id = ?3",
            rusqlite::params![result, ts, id],
        )?;
        Ok(serde_json::Value::Null)
    })
    .await
    .map(|_| ())
    .map_err(|e| e.to_string())
}

async fn fail_document_job(pool: &DbPool, job_id: &str, error: &str) -> Result<(), String> {
    let id = job_id.to_string();
    let error = error.to_string();
    pool.write(signet_core::db::Priority::Low, move |conn| {
        let ts = chrono::Utc::now().to_rfc3339();
        conn.execute(
            "UPDATE memory_jobs SET status = 'pending', error = ?1, failed_at = ?2, updated_at = ?2 WHERE id = ?3",
            rusqlite::params![error, ts, id],
        )?;
        Ok(serde_json::Value::Null)
    })
    .await
    .map(|_| ())
    .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use signet_core::db::Priority;

    #[test]
    fn chunk_basic() {
        let text = "abcdefghij"; // 10 chars
        let chunks = chunk_content(text, 4, 1, 100);
        assert!(!chunks.is_empty());
        assert_eq!(chunks[0].text, "abcd");
        // With overlap=1, step=3, second chunk starts at 3
        assert_eq!(chunks[1].text, "defg");
    }

    #[test]
    fn chunk_empty() {
        let chunks = chunk_content("", 4, 1, 100);
        assert!(chunks.is_empty());
    }

    #[test]
    fn chunk_max_limit() {
        let text = "a".repeat(1000);
        let chunks = chunk_content(&text, 10, 0, 5);
        assert_eq!(chunks.len(), 5);
    }

    #[test]
    fn chunk_unicode_safety() {
        // Multi-byte UTF-8: each char is 4 bytes
        let text = "🎉🎊🎈🎁🎂";
        let chunks = chunk_content(text, 8, 0, 100);
        // Each emoji is 4 bytes, chunk_size=8 fits 2 emojis
        for chunk in &chunks {
            // Verify no panics on invalid UTF-8
            assert!(!chunk.text.is_empty());
        }
    }

    fn open_test_pool() -> (DbPool, tokio::task::JoinHandle<()>) {
        let path =
            std::env::temp_dir().join(format!("signet-document-{}.db", uuid::Uuid::new_v4()));
        DbPool::open(&path).expect("open document test db")
    }

    #[tokio::test]
    async fn process_document_persists_chunks_and_marks_document_indexed() {
        let (pool, handle) = open_test_pool();
        pool.write(Priority::High, |conn| {
            let now = chrono::Utc::now().to_rfc3339();
            conn.execute(
                "INSERT INTO documents
                 (id, source_type, content_type, title, raw_content, status,
                  chunk_count, memory_count, created_at, updated_at)
                 VALUES ('doc-replay', 'text', 'text/plain', 'Replay', 'abcdefghi',
                         'queued', 0, 0, ?1, ?1)",
                rusqlite::params![now],
            )?;
            Ok(serde_json::Value::Null)
        })
        .await
        .expect("seed document row");

        let result = process_document(
            &pool,
            &FakeEmbeddingProvider { dims: 768 },
            &DocumentJob {
                id: "job-document".to_string(),
                document_id: Some("doc-replay".to_string()),
                payload: Some(
                    serde_json::json!({
                        "content": "abcdefghi",
                        "agentId": "agent-doc"
                    })
                    .to_string(),
                ),
                attempts: 1,
            },
            &DocumentConfig {
                chunk_size: 4,
                chunk_overlap: 1,
                max_chunks: 10,
                embedding_model: Some("fake-embedding".to_string()),
                ..DocumentConfig::default()
            },
        )
        .await
        .expect("process document");
        assert_eq!(result.chunks_created, 3);

        let persisted = pool
            .read(|conn| {
                let status: String = conn.query_row(
                    "SELECT status FROM documents WHERE id = 'doc-replay'",
                    [],
                    |row| row.get(0),
                )?;
                let chunk_count: i64 = conn.query_row(
                    "SELECT chunk_count FROM documents WHERE id = 'doc-replay'",
                    [],
                    |row| row.get(0),
                )?;
                let linked: i64 = conn.query_row(
                    "SELECT COUNT(*) FROM document_memories WHERE document_id = 'doc-replay'",
                    [],
                    |row| row.get(0),
                )?;
                let memories: i64 = conn.query_row(
                    "SELECT COUNT(*) FROM memories WHERE source_id = 'doc-replay' AND is_deleted = 0",
                    [],
                    |row| row.get(0),
                )?;
                let embeddings: i64 = conn.query_row(
                    "SELECT COUNT(*) FROM embeddings e
                     JOIN document_memories dm ON dm.memory_id = e.source_id
                     WHERE dm.document_id = 'doc-replay'",
                    [],
                    |row| row.get(0),
                )?;
                let vec_embeddings: i64 = conn
                    .query_row("SELECT COUNT(*) FROM vec_embeddings", [], |row| row.get(0))
                    .unwrap_or(0);
                let embedding_model: Option<String> = conn.query_row(
                    "SELECT embedding_model FROM memories WHERE source_id = 'doc-replay' LIMIT 1",
                    [],
                    |row| row.get(0),
                )?;
                let memory_agents: i64 = conn.query_row(
                    "SELECT COUNT(*) FROM memories
                     WHERE source_id = 'doc-replay'
                       AND is_deleted = 0
                       AND agent_id = 'agent-doc'",
                    [],
                    |row| row.get(0),
                )?;
                let embedding_agents: i64 = conn.query_row(
                    "SELECT COUNT(*) FROM embeddings e
                     JOIN document_memories dm ON dm.memory_id = e.source_id
                     WHERE dm.document_id = 'doc-replay'
                       AND e.agent_id = 'agent-doc'",
                    [],
                    |row| row.get(0),
                )?;
                Ok(serde_json::json!({
                    "status": status,
                    "chunkCount": chunk_count,
                    "linked": linked,
                    "memories": memories,
                    "embeddings": embeddings,
                    "vecEmbeddings": vec_embeddings,
                    "embeddingModel": embedding_model,
                    "memoryAgents": memory_agents,
                    "embeddingAgents": embedding_agents,
                }))
            })
            .await
            .expect("read document chunks");
        assert_eq!(persisted["status"], "done");
        assert_eq!(persisted["chunkCount"], 3);
        assert_eq!(persisted["linked"], 3);
        assert_eq!(persisted["memories"], 3);
        assert_eq!(persisted["embeddings"], 3);
        assert_eq!(persisted["vecEmbeddings"], 3);
        assert_eq!(persisted["embeddingModel"], "fake-embedding");
        assert_eq!(persisted["memoryAgents"], 3);
        assert_eq!(persisted["embeddingAgents"], 3);

        drop(pool);
        handle.abort();
    }

    #[tokio::test]
    async fn process_document_scopes_embedding_hash_by_agent_and_memory() {
        let (pool, handle) = open_test_pool();
        pool.write(Priority::High, |conn| {
            let now = chrono::Utc::now().to_rfc3339();
            conn.execute(
                "INSERT INTO documents
                 (id, source_type, content_type, title, raw_content, status,
                  chunk_count, memory_count, created_at, updated_at)
                 VALUES
                 ('doc-agent-a', 'text', 'text/plain', 'Agent A', 'same chunk',
                  'queued', 0, 0, ?1, ?1),
                 ('doc-agent-b', 'text', 'text/plain', 'Agent B', 'same chunk',
                  'queued', 0, 0, ?1, ?1)",
                rusqlite::params![now],
            )?;
            Ok(serde_json::Value::Null)
        })
        .await
        .expect("seed document rows");

        let config = DocumentConfig {
            chunk_size: 64,
            chunk_overlap: 0,
            max_chunks: 10,
            embedding_model: Some("fake-embedding".to_string()),
            ..DocumentConfig::default()
        };
        for (document_id, agent_id) in [("doc-agent-a", "agent-a"), ("doc-agent-b", "agent-b")] {
            process_document(
                &pool,
                &FakeEmbeddingProvider { dims: 768 },
                &DocumentJob {
                    id: format!("job-{document_id}"),
                    document_id: Some(document_id.to_string()),
                    payload: Some(
                        serde_json::json!({
                            "content": "same chunk",
                            "agentId": agent_id,
                        })
                        .to_string(),
                    ),
                    attempts: 1,
                },
                &config,
            )
            .await
            .expect("process scoped document");
        }

        let raw_hash = normalize_and_hash("same chunk").hash;
        let query_hash = raw_hash.clone();
        let persisted = pool
            .read(move |conn| {
                Ok(serde_json::json!({
                    "embeddingCount": conn.query_row(
                        "SELECT COUNT(*) FROM embeddings WHERE source_type = 'memory'",
                        [],
                        |row| row.get::<_, i64>(0),
                    )?,
                    "distinctHashes": conn.query_row(
                        "SELECT COUNT(DISTINCT content_hash) FROM embeddings WHERE source_type = 'memory'",
                        [],
                        |row| row.get::<_, i64>(0),
                    )?,
                    "rawHashRows": conn.query_row(
                        "SELECT COUNT(*) FROM embeddings WHERE content_hash = ?1",
                        [&query_hash],
                        |row| row.get::<_, i64>(0),
                    )?,
                    "agentA": conn.query_row(
                        "SELECT COUNT(*) FROM embeddings WHERE source_type = 'memory' AND agent_id = 'agent-a'",
                        [],
                        |row| row.get::<_, i64>(0),
                    )?,
                    "agentB": conn.query_row(
                        "SELECT COUNT(*) FROM embeddings WHERE source_type = 'memory' AND agent_id = 'agent-b'",
                        [],
                        |row| row.get::<_, i64>(0),
                    )?,
                    "scopedHashes": conn.query_row(
                        "SELECT COUNT(*) FROM embeddings e
                         JOIN memories m ON m.id = e.source_id
                         WHERE e.content_hash = 'memory:' || m.agent_id || ':' || m.id || ':' || m.content_hash",
                        [],
                        |row| row.get::<_, i64>(0),
                    )?,
                }))
            })
            .await
            .expect("read scoped document embeddings");

        assert_eq!(persisted["embeddingCount"], 2);
        assert_eq!(persisted["distinctHashes"], 2);
        assert_eq!(persisted["rawHashRows"], 0);
        assert_eq!(persisted["agentA"], 1);
        assert_eq!(persisted["agentB"], 1);
        assert_eq!(persisted["scopedHashes"], 2);

        drop(pool);
        handle.abort();
    }

    struct FakeEmbeddingProvider {
        dims: usize,
    }

    impl EmbeddingProvider for FakeEmbeddingProvider {
        fn embed(
            &self,
            text: &str,
        ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Option<Vec<f32>>> + Send + '_>>
        {
            let len = text.len() as f32;
            Box::pin(async move { Some(vec![len; 768]) })
        }

        fn name(&self) -> &str {
            "fake"
        }

        fn dimensions(&self) -> usize {
            self.dims
        }
    }
}
