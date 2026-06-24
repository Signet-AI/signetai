use std::path::PathBuf;

use rusqlite::params;
use signet_core::db::{DbPool, Priority};
use signet_core::queries::embedding::vector_to_blob;
use signet_pipeline::retention::{RetentionConfig, run_sweep};
use uuid::Uuid;

fn unique_db_path() -> PathBuf {
    std::env::temp_dir().join(format!("signet-retention-{}.db", Uuid::new_v4()))
}

#[tokio::test]
async fn retention_sweep_matches_typescript_ordered_semantics() {
    let path = unique_db_path();
    let (pool, handle) = DbPool::open(&path).expect("open retention test db");

    seed_retention_fixture(&pool).await;

    let result = run_sweep(
        &pool,
        &RetentionConfig {
            interval_secs: 60,
            batch_size: 100,
            tombstone_days: 30,
            history_days: 180,
            completed_job_days: 14,
            dead_job_days: 30,
        },
    )
    .await
    .expect("retention sweep should run");

    assert_eq!(result.graph_links_purged, 2);
    assert_eq!(result.entities_orphaned, 1);
    assert_eq!(result.embeddings_purged, 1);
    assert_eq!(result.tombstones_purged, 1);
    assert_eq!(result.history_purged, 1);
    assert_eq!(result.completed_jobs_purged, 1);
    assert_eq!(result.dead_jobs_purged, 1);

    let snapshot = pool
        .read(|conn| {
            let cold_json: String = conn.query_row(
                "SELECT original_row_json FROM memories_cold WHERE memory_id = 'mem-expired'",
                [],
                |row| row.get(0),
            )?;
            let cold: serde_json::Value = serde_json::from_str(&cold_json)
                .map_err(|err| signet_core::CoreError::Migration(err.to_string()))?;

            Ok(serde_json::json!({
                "expiredMemoryCount": count(conn, "SELECT COUNT(*) FROM memories WHERE id = 'mem-expired'")?,
                "freshDeletedMemoryCount": count(conn, "SELECT COUNT(*) FROM memories WHERE id = 'mem-fresh-deleted'")?,
                "coldArchiveCount": count(conn, "SELECT COUNT(*) FROM memories_cold WHERE memory_id = 'mem-expired'")?,
                "coldContent": cold["content"].clone(),
                "coldIsDeleted": cold["is_deleted"].clone(),
                "coldDeletedAt": cold["deleted_at"].clone(),
                "embeddingCount": count(conn, "SELECT COUNT(*) FROM embeddings WHERE id = 'emb-expired'")?,
                "vecEmbeddingCount": count(conn, "SELECT COUNT(*) FROM vec_embeddings WHERE id = 'emb-expired'")?,
                "mentionCount": count(conn, "SELECT COUNT(*) FROM memory_entity_mentions WHERE memory_id = 'mem-expired'")?,
                "orphanEntityCount": count(conn, "SELECT COUNT(*) FROM entities WHERE id = 'entity-orphan'")?,
                "sharedEntityMentions": count(conn, "SELECT mentions FROM entities WHERE id = 'entity-shared'")?,
                "orphanRelationCount": count(conn, "SELECT COUNT(*) FROM relations WHERE id = 'rel-orphan'")?,
                "oldHistoryCount": count(conn, "SELECT COUNT(*) FROM memory_history WHERE id = 'hist-old'")?,
                "freshHistoryCount": count(conn, "SELECT COUNT(*) FROM memory_history WHERE id = 'hist-fresh'")?,
                "completedOldCount": count(conn, "SELECT COUNT(*) FROM memory_jobs WHERE id = 'job-completed-old'")?,
                "completedFreshCount": count(conn, "SELECT COUNT(*) FROM memory_jobs WHERE id = 'job-completed-fresh'")?,
                "deadOldCount": count(conn, "SELECT COUNT(*) FROM memory_jobs WHERE id = 'job-dead-old'")?,
                "deadFreshFailedCount": count(conn, "SELECT COUNT(*) FROM memory_jobs WHERE id = 'job-dead-fresh-failed'")?,
                "trainingPairCount": count(conn, "SELECT COUNT(*) FROM predictor_training_pairs WHERE id = 'pair-old'")?,
            }))
        })
        .await
        .expect("read retention results");

    assert_eq!(snapshot["expiredMemoryCount"], 0);
    assert_eq!(snapshot["freshDeletedMemoryCount"], 1);
    assert_eq!(snapshot["coldArchiveCount"], 1);
    assert_eq!(snapshot["coldContent"], "expired memory content");
    assert_eq!(snapshot["coldIsDeleted"], 1);
    assert_eq!(snapshot["coldDeletedAt"], "2000-01-01T00:00:00.000Z");
    assert_eq!(snapshot["embeddingCount"], 0);
    assert_eq!(snapshot["vecEmbeddingCount"], 0);
    assert_eq!(snapshot["mentionCount"], 0);
    assert_eq!(snapshot["orphanEntityCount"], 0);
    assert_eq!(snapshot["sharedEntityMentions"], 1);
    assert_eq!(snapshot["orphanRelationCount"], 0);
    assert_eq!(snapshot["oldHistoryCount"], 0);
    assert_eq!(snapshot["freshHistoryCount"], 1);
    assert_eq!(snapshot["completedOldCount"], 0);
    assert_eq!(snapshot["completedFreshCount"], 1);
    assert_eq!(snapshot["deadOldCount"], 0);
    assert_eq!(snapshot["deadFreshFailedCount"], 1);
    assert_eq!(snapshot["trainingPairCount"], 1);

    drop(pool);
    handle.await.expect("writer task exits");
    let _ = std::fs::remove_file(path);
}

async fn seed_retention_fixture(pool: &DbPool) {
    pool.write(Priority::High, |conn| {
        insert_memory(
            conn,
            "mem-expired",
            "expired memory content",
            1,
            Some("2000-01-01T00:00:00.000Z"),
            "hash-expired",
        )?;
        insert_memory(
            conn,
            "mem-fresh-deleted",
            "fresh deleted memory content",
            1,
            Some("2999-01-01T00:00:00.000Z"),
            "hash-fresh-deleted",
        )?;
        insert_memory(conn, "mem-active", "active memory content", 0, None, "hash-active")?;

        conn.execute(
            "INSERT INTO entities (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at)
             VALUES ('entity-orphan', 'Entity Orphan', 'entity orphan', 'project', 'default', 1, '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z'),
                    ('entity-shared', 'Entity Shared', 'entity shared', 'project', 'default', 2, '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z'),
                    ('entity-keep', 'Entity Keep', 'entity keep', 'project', 'default', 1, '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z')",
            [],
        )?;
        conn.execute(
            "INSERT INTO memory_entity_mentions (memory_id, entity_id, mention_text, confidence, created_at)
             VALUES ('mem-expired', 'entity-orphan', 'Entity Orphan', 0.9, '2020-01-01T00:00:00.000Z'),
                    ('mem-expired', 'entity-shared', 'Entity Shared', 0.9, '2020-01-01T00:00:00.000Z')",
            [],
        )?;
        conn.execute(
            "INSERT INTO relations (id, source_entity_id, target_entity_id, relation_type, strength, mentions, confidence, created_at, updated_at)
             VALUES ('rel-orphan', 'entity-orphan', 'entity-keep', 'related_to', 1.0, 1, 0.8, '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z')",
            [],
        )?;

        let vector = vector_to_blob(&vec![0.0_f32; 768]);
        conn.execute(
            "INSERT INTO embeddings (id, content_hash, vector, dimensions, source_type, source_id, chunk_text, created_at)
             VALUES ('emb-expired', 'emb-hash-expired', ?1, 768, 'memory', 'mem-expired', 'expired memory content', '2020-01-01T00:00:00.000Z')",
            params![vector],
        )?;
        conn.execute(
            "INSERT INTO vec_embeddings (id, embedding) VALUES (?1, ?2)",
            params!["emb-expired", vector_to_blob(&vec![0.0_f32; 768])],
        )?;

        conn.execute(
            "INSERT INTO memory_history (id, memory_id, event, changed_by, created_at)
             VALUES ('hist-old', 'mem-active', 'created', 'test', '2000-01-01T00:00:00.000Z'),
                    ('hist-fresh', 'mem-active', 'created', 'test', '2999-01-01T00:00:00.000Z')",
            [],
        )?;

        conn.execute(
            "INSERT INTO memory_jobs (id, memory_id, job_type, status, created_at, updated_at, completed_at, failed_at)
             VALUES ('job-completed-old', 'mem-active', 'extract', 'completed', '2000-01-01T00:00:00.000Z', '2000-01-01T00:00:00.000Z', '2000-01-01T00:00:00.000Z', NULL),
                    ('job-completed-fresh', 'mem-active', 'extract', 'completed', '2999-01-01T00:00:00.000Z', '2999-01-01T00:00:00.000Z', '2999-01-01T00:00:00.000Z', NULL),
                    ('job-dead-old', 'mem-active', 'extract', 'dead', '2999-01-01T00:00:00.000Z', '2999-01-01T00:00:00.000Z', NULL, '2000-01-01T00:00:00.000Z'),
                    ('job-dead-fresh-failed', 'mem-active', 'extract', 'dead', '2000-01-01T00:00:00.000Z', '2000-01-01T00:00:00.000Z', NULL, '2999-01-01T00:00:00.000Z')",
            [],
        )?;

        conn.execute(
            "CREATE TABLE IF NOT EXISTS predictor_training_pairs (
                id TEXT PRIMARY KEY,
                agent_id TEXT NOT NULL DEFAULT 'default',
                session_key TEXT NOT NULL,
                memory_id TEXT NOT NULL,
                recency_days REAL NOT NULL,
                access_count INTEGER NOT NULL,
                importance REAL NOT NULL,
                decay_factor REAL NOT NULL,
                combined_label REAL NOT NULL,
                was_injected INTEGER NOT NULL,
                created_at TEXT NOT NULL
             )",
            [],
        )?;
        conn.execute(
            "INSERT INTO predictor_training_pairs (
                id, agent_id, session_key, memory_id, recency_days, access_count,
                importance, decay_factor, combined_label, was_injected, created_at
             ) VALUES ('pair-old', 'default', 'session-old', 'mem-expired', 365.0, 0,
                       0.5, 0.1, 0.7, 1, '2000-01-01T00:00:00.000Z')",
            [],
        )?;

        Ok(serde_json::json!(true))
    })
    .await
    .expect("seed retention fixture");
}

fn insert_memory(
    conn: &rusqlite::Connection,
    id: &str,
    content: &str,
    is_deleted: i64,
    deleted_at: Option<&str>,
    content_hash: &str,
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
            content_hash,
            content.to_lowercase(),
            is_deleted,
            deleted_at
        ],
    )?;
    Ok(())
}

fn count(conn: &rusqlite::Connection, sql: &str) -> rusqlite::Result<i64> {
    conn.query_row(sql, [], |row| row.get(0))
}
