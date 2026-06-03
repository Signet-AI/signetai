//! Embedding CRUD and vec sync operations.
//!
//! Manages the `embeddings` table (metadata + blob) and keeps the
//! `vec_embeddings` virtual table in sync for KNN queries.

use rusqlite::{Connection, params};
use tracing::warn;

use crate::error::CoreError;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Convert f32 slice to little-endian byte blob for sqlite-vec.
pub fn vector_to_blob(vec: &[f32]) -> Vec<u8> {
    vec.iter().flat_map(|f| f.to_le_bytes()).collect()
}

/// Convert byte blob back to f32 vec.
pub fn blob_to_vector(blob: &[u8]) -> Vec<f32> {
    blob.chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect()
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

pub struct InsertEmbedding<'a> {
    pub id: &'a str,
    pub content_hash: &'a str,
    pub vector: &'a [f32],
    pub source_type: &'a str,
    pub source_id: &'a str,
    pub chunk_text: &'a str,
    pub now: &'a str,
    pub agent_id: Option<&'a str>,
}

/// Upsert an embedding row (idempotent via ON CONFLICT on content_hash).
pub fn upsert(conn: &Connection, e: &InsertEmbedding) -> Result<(), CoreError> {
    let blob = vector_to_blob(e.vector);
    let dims = e.vector.len();

    conn.execute(
        "INSERT INTO embeddings
         (id, content_hash, vector, dimensions, source_type, source_id, chunk_text, created_at, agent_id)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)
         ON CONFLICT(content_hash) DO UPDATE SET
           vector = excluded.vector,
           dimensions = excluded.dimensions,
           source_type = excluded.source_type,
           source_id = excluded.source_id,
           chunk_text = excluded.chunk_text,
           created_at = excluded.created_at,
           agent_id = excluded.agent_id",
        params![
            e.id,
            e.content_hash,
            blob,
            dims,
            e.source_type,
            e.source_id,
            e.chunk_text,
            e.now,
            e.agent_id
        ],
    )?;

    // Sync to vec table. On conflict, SQLite keeps the existing row id, so
    // resolve the canonical embedding id before updating the vector index.
    let actual_id: String = conn.query_row(
        "SELECT id FROM embeddings WHERE content_hash = ?1",
        params![e.content_hash],
        |row| row.get(0),
    )?;
    sync_vec_insert(conn, &actual_id, e.vector);

    Ok(())
}

/// Get the vector blob for a given source.
pub fn get_vector(
    conn: &Connection,
    source_type: &str,
    source_id: &str,
) -> Result<Option<Vec<f32>>, CoreError> {
    let mut stmt = conn.prepare_cached(
        "SELECT vector FROM embeddings WHERE source_type = ?1 AND source_id = ?2 LIMIT 1",
    )?;
    let mut rows = stmt.query_map(params![source_type, source_id], |row| {
        let blob: Vec<u8> = row.get(0)?;
        Ok(blob_to_vector(&blob))
    })?;
    match rows.next() {
        Some(Ok(v)) => Ok(Some(v)),
        Some(Err(e)) => Err(e.into()),
        None => Ok(None),
    }
}

/// Delete embeddings by source, optionally keeping one content_hash.
pub fn delete_by_source(
    conn: &Connection,
    source_type: &str,
    source_id: &str,
    keep_hash: Option<&str>,
) -> Result<usize, CoreError> {
    // First get IDs for vec cleanup
    let ids = get_ids_by_source(conn, source_type, source_id, keep_hash)?;

    // Delete from vec table
    for id in &ids {
        sync_vec_delete(conn, id);
    }

    // Delete from embeddings
    let count = if let Some(hash) = keep_hash {
        conn.execute(
            "DELETE FROM embeddings WHERE source_type = ?1 AND source_id = ?2 AND content_hash <> ?3",
            params![source_type, source_id, hash],
        )?
    } else {
        conn.execute(
            "DELETE FROM embeddings WHERE source_type = ?1 AND source_id = ?2",
            params![source_type, source_id],
        )?
    };

    Ok(count)
}

/// Count total embeddings.
pub fn count(conn: &Connection) -> Result<i64, CoreError> {
    Ok(conn.query_row("SELECT count(*) FROM embeddings", [], |r| r.get(0))?)
}

// ---------------------------------------------------------------------------
// Vec table sync
// ---------------------------------------------------------------------------

/// Insert/replace into vec_embeddings virtual table.
fn sync_vec_insert(conn: &Connection, id: &str, vector: &[f32]) {
    let blob = vector_to_blob(vector);
    if let Err(e) = conn.execute(
        "INSERT OR REPLACE INTO vec_embeddings (id, embedding) VALUES (?1, ?2)",
        params![id, blob],
    ) {
        warn!(err = %e, "vec_embeddings insert failed");
    }
}

/// Delete from vec_embeddings by ID.
fn sync_vec_delete(conn: &Connection, id: &str) {
    if let Err(e) = conn.execute("DELETE FROM vec_embeddings WHERE id = ?1", params![id]) {
        warn!(err = %e, "vec_embeddings delete failed");
    }
}

/// Get embedding IDs for a source, optionally excluding a hash.
fn get_ids_by_source(
    conn: &Connection,
    source_type: &str,
    source_id: &str,
    exclude_hash: Option<&str>,
) -> Result<Vec<String>, CoreError> {
    if let Some(hash) = exclude_hash {
        let mut stmt = conn.prepare_cached(
            "SELECT id FROM embeddings WHERE source_type = ?1 AND source_id = ?2 AND content_hash <> ?3",
        )?;
        let rows = stmt.query_map(params![source_type, source_id, hash], |r| r.get(0))?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    } else {
        let mut stmt = conn.prepare_cached(
            "SELECT id FROM embeddings WHERE source_type = ?1 AND source_id = ?2",
        )?;
        let rows = stmt.query_map(params![source_type, source_id], |r| r.get(0))?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }
}

/// Invalidate the umap_cache table (after embedding changes).
pub fn invalidate_umap_cache(conn: &Connection) {
    let _ = conn.execute_batch("DELETE FROM umap_cache");
}
