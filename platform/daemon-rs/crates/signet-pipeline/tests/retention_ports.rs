use std::path::PathBuf;

use rusqlite::{Connection, params};
use signet_core::db::{DbPool, Priority};
use signet_core::queries::embedding::vector_to_blob;
use signet_pipeline::retention::{RetentionConfig, run_sweep};
use uuid::Uuid;

fn unique_db_path(prefix: &str) -> PathBuf {
    std::env::temp_dir().join(format!("signet-{prefix}-{}.db", Uuid::new_v4()))
}

fn retention_config() -> RetentionConfig {
    RetentionConfig {
        interval_secs: 60,
        batch_size: 100,
        tombstone_days: 30,
        history_days: 180,
        completed_job_days: 14,
        dead_job_days: 30,
    }
}

// Port of platform/daemon/src/pipeline/retention-worker.test.ts:61-88,
// 163-195, and 197-240. This specifically guards the retention ordering that
// must remove graph links and embeddings before hard-deleting old tombstones.
#[tokio::test]
async fn retention_sweep_archives_old_tombstones_and_cleans_graph_before_delete() {
    let path = unique_db_path("retention-port-tombstone");
    let (pool, writer) = DbPool::open(&path).expect("open retention db");
    seed_tombstone_graph_fixture(&pool).await;

    let result = run_sweep(&pool, &retention_config())
        .await
        .expect("retention sweep");

    assert_eq!(result.graph_links_purged, 2);
    assert_eq!(result.entities_orphaned, 1);
    assert_eq!(result.embeddings_purged, 1);
    assert_eq!(result.tombstones_purged, 1);

    let snapshot = pool
        .read(|conn| {
            let cold_json: String = conn.query_row(
                "SELECT original_row_json FROM memories_cold WHERE memory_id = 'mem-old-deleted'",
                [],
                |row| row.get(0),
            )?;
            let cold: serde_json::Value = serde_json::from_str(&cold_json).unwrap();
            Ok(serde_json::json!({
                "oldDeleted": count(conn, "SELECT COUNT(*) FROM memories WHERE id = 'mem-old-deleted'")?,
                "recentDeleted": count(conn, "SELECT COUNT(*) FROM memories WHERE id = 'mem-recent-deleted'")?,
                "coldRows": count(conn, "SELECT COUNT(*) FROM memories_cold WHERE memory_id = 'mem-old-deleted'")?,
                "coldContent": cold["content"].clone(),
                "coldDeletedAt": cold["deleted_at"].clone(),
                "embeddingRows": count(conn, "SELECT COUNT(*) FROM embeddings WHERE id = 'emb-old-deleted'")?,
                "vecRows": count(conn, "SELECT COUNT(*) FROM vec_embeddings WHERE id = 'emb-old-deleted'")?,
                "oldMentions": count(conn, "SELECT COUNT(*) FROM memory_entity_mentions WHERE memory_id = 'mem-old-deleted'")?,
                "orphanEntity": count(conn, "SELECT COUNT(*) FROM entities WHERE id = 'entity-orphaned'")?,
                "survivorMentions": count(conn, "SELECT mentions FROM entities WHERE id = 'entity-survives'")?,
                "orphanRelation": count(conn, "SELECT COUNT(*) FROM relations WHERE id = 'rel-orphaned'")?,
            }))
        })
        .await
        .expect("read retention snapshot");

    assert_eq!(snapshot["oldDeleted"], 0);
    assert_eq!(snapshot["recentDeleted"], 1);
    assert_eq!(snapshot["coldRows"], 1);
    assert_eq!(snapshot["coldContent"], "old deleted memory");
    assert_eq!(snapshot["coldDeletedAt"], "2000-01-01T00:00:00.000Z");
    assert_eq!(snapshot["embeddingRows"], 0);
    assert_eq!(snapshot["vecRows"], 0);
    assert_eq!(snapshot["oldMentions"], 0);
    assert_eq!(snapshot["orphanEntity"], 0);
    assert_eq!(snapshot["survivorMentions"], 2);
    assert_eq!(snapshot["orphanRelation"], 0);

    drop(pool);
    writer.abort();
    let _ = std::fs::remove_file(path);
}

// Port of platform/daemon/src/pipeline/retention-worker.test.ts:90-160 and
// 243-253. This guards independent audit/job retention windows and the no-op
// zero-count behavior when a later sweep has nothing eligible left.
#[tokio::test]
async fn retention_sweep_purges_expired_history_and_jobs_without_touching_fresh_rows() {
    let path = unique_db_path("retention-port-history-jobs");
    let (pool, writer) = DbPool::open(&path).expect("open retention db");
    seed_history_job_fixture(&pool).await;

    let result = run_sweep(&pool, &retention_config())
        .await
        .expect("retention sweep");
    assert_eq!(result.history_purged, 1);
    assert_eq!(result.completed_jobs_purged, 1);
    assert_eq!(result.dead_jobs_purged, 1);
    assert_eq!(result.tombstones_purged, 0);
    assert_eq!(result.graph_links_purged, 0);

    let snapshot = pool
        .read(|conn| {
            Ok(serde_json::json!({
                "oldHistory": count(conn, "SELECT COUNT(*) FROM memory_history WHERE id = 'hist-old'")?,
                "recentHistory": count(conn, "SELECT COUNT(*) FROM memory_history WHERE id = 'hist-recent'")?,
                "oldCompleted": count(conn, "SELECT COUNT(*) FROM memory_jobs WHERE id = 'job-completed-old'")?,
                "recentCompleted": count(conn, "SELECT COUNT(*) FROM memory_jobs WHERE id = 'job-completed-recent'")?,
                "oldDead": count(conn, "SELECT COUNT(*) FROM memory_jobs WHERE id = 'job-dead-old'")?,
                "recentDead": count(conn, "SELECT COUNT(*) FROM memory_jobs WHERE id = 'job-dead-recent'")?,
            }))
        })
        .await
        .expect("read history/job snapshot");

    assert_eq!(snapshot["oldHistory"], 0);
    assert_eq!(snapshot["recentHistory"], 1);
    assert_eq!(snapshot["oldCompleted"], 0);
    assert_eq!(snapshot["recentCompleted"], 1);
    assert_eq!(snapshot["oldDead"], 0);
    assert_eq!(snapshot["recentDead"], 1);

    let noop = run_sweep(&pool, &retention_config())
        .await
        .expect("second retention sweep");
    assert_eq!(noop.graph_links_purged, 0);
    assert_eq!(noop.entities_orphaned, 0);
    assert_eq!(noop.embeddings_purged, 0);
    assert_eq!(noop.tombstones_purged, 0);
    assert_eq!(noop.history_purged, 0);
    assert_eq!(noop.completed_jobs_purged, 0);
    assert_eq!(noop.dead_jobs_purged, 0);

    drop(pool);
    writer.abort();
    let _ = std::fs::remove_file(path);
}

async fn seed_tombstone_graph_fixture(pool: &DbPool) {
    pool.write(Priority::High, |conn| {
        insert_memory(
            conn,
            "mem-old-deleted",
            "old deleted memory",
            1,
            Some("2000-01-01T00:00:00.000Z"),
        )?;
        insert_memory(
            conn,
            "mem-recent-deleted",
            "recent deleted memory",
            1,
            Some("2999-01-01T00:00:00.000Z"),
        )?;
        insert_memory(conn, "mem-active", "active memory", 0, None)?;
        conn.execute(
            "INSERT INTO entities (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at)
             VALUES ('entity-orphaned', 'Entity Orphaned', 'entity orphaned', 'concept', 'default', 1, '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z'),
                    ('entity-survives', 'Entity Survives', 'entity survives', 'concept', 'default', 3, '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z'),
                    ('entity-target', 'Entity Target', 'entity target', 'concept', 'default', 1, '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z')",
            [],
        )?;
        conn.execute(
            "INSERT INTO memory_entity_mentions (memory_id, entity_id, mention_text, confidence, created_at)
             VALUES ('mem-old-deleted', 'entity-orphaned', 'Entity Orphaned', 0.9, '2020-01-01T00:00:00.000Z'),
                    ('mem-old-deleted', 'entity-survives', 'Entity Survives', 0.9, '2020-01-01T00:00:00.000Z')",
            [],
        )?;
        conn.execute(
            "INSERT INTO relations (id, source_entity_id, target_entity_id, relation_type, strength, mentions, confidence, created_at, updated_at)
             VALUES ('rel-orphaned', 'entity-orphaned', 'entity-target', 'related_to', 1.0, 1, 0.8, '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z')",
            [],
        )?;
        let vector = vector_to_blob(&vec![0.0_f32; 768]);
        conn.execute(
            "INSERT INTO embeddings (id, content_hash, vector, dimensions, source_type, source_id, chunk_text, created_at)
             VALUES ('emb-old-deleted', 'emb-hash-old', ?1, 768, 'memory', 'mem-old-deleted', 'old deleted memory', '2020-01-01T00:00:00.000Z')",
            params![vector],
        )?;
        conn.execute(
            "INSERT INTO vec_embeddings (id, embedding) VALUES ('emb-old-deleted', ?1)",
            params![vector_to_blob(&vec![0.0_f32; 768])],
        )?;
        Ok(serde_json::Value::Null)
    })
    .await
    .expect("seed tombstone graph fixture");
}

async fn seed_history_job_fixture(pool: &DbPool) {
    pool.write(Priority::High, |conn| {
        insert_memory(conn, "mem-history-jobs", "memory with history jobs", 0, None)?;
        conn.execute(
            "INSERT INTO memory_history (id, memory_id, event, changed_by, created_at)
             VALUES ('hist-old', 'mem-history-jobs', 'updated', 'test', '2000-01-01T00:00:00.000Z'),
                    ('hist-recent', 'mem-history-jobs', 'updated', 'test', '2999-01-01T00:00:00.000Z')",
            [],
        )?;
        conn.execute(
            "INSERT INTO memory_jobs (id, memory_id, job_type, status, created_at, updated_at, completed_at, failed_at)
             VALUES ('job-completed-old', 'mem-history-jobs', 'extract', 'completed', '2000-01-01T00:00:00.000Z', '2000-01-01T00:00:00.000Z', '2000-01-01T00:00:00.000Z', NULL),
                    ('job-completed-recent', 'mem-history-jobs', 'extract', 'completed', '2999-01-01T00:00:00.000Z', '2999-01-01T00:00:00.000Z', '2999-01-01T00:00:00.000Z', NULL),
                    ('job-dead-old', 'mem-history-jobs', 'extract', 'dead', '2000-01-01T00:00:00.000Z', '2000-01-01T00:00:00.000Z', NULL, '2000-01-01T00:00:00.000Z'),
                    ('job-dead-recent', 'mem-history-jobs', 'extract', 'dead', '2999-01-01T00:00:00.000Z', '2999-01-01T00:00:00.000Z', NULL, '2999-01-01T00:00:00.000Z')",
            [],
        )?;
        Ok(serde_json::Value::Null)
    })
    .await
    .expect("seed history/job fixture");
}

fn insert_memory(
    conn: &Connection,
    id: &str,
    content: &str,
    is_deleted: i64,
    deleted_at: Option<&str>,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO memories (
            id, type, category, content, confidence, importance,
            source_id, source_type, tags, who, why, project,
            content_hash, normalized_content, extraction_status,
            embedding_model, extraction_model, update_count,
            created_at, updated_at, updated_by, vector_clock,
            is_deleted, deleted_at, agent_id, visibility
         )
         VALUES (?1, 'fact', 'preference', ?2, 0.9, 0.8,
                 'source-1', 'manual', '[\"tag\"]', 'user', 'test', 'project-a',
                 ?3, ?4, 'done', 'model-embed', 'model-extract', 3,
                 '2020-01-01T00:00:00.000Z', '2020-01-02T00:00:00.000Z', 'test', '{}',
                 ?5, ?6, 'default', 'global')",
        params![
            id,
            content,
            format!("hash-{id}"),
            content.to_lowercase(),
            is_deleted,
            deleted_at
        ],
    )?;
    Ok(())
}

fn count(conn: &Connection, sql: &str) -> rusqlite::Result<i64> {
    conn.query_row(sql, [], |row| row.get(0))
}
