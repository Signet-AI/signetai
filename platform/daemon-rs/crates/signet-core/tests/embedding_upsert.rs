use rusqlite::{Connection, params};

use signet_core::queries::embedding::{InsertEmbedding, upsert};
use signet_core::search::vector_search;

fn setup() -> Connection {
    signet_core::db::register_vec_extension();
    let conn = Connection::open_in_memory().expect("open in-memory db");
    signet_core::db::configure_pragmas_pub(&conn).expect("configure pragmas");
    signet_core::migrations::run(&conn).expect("run migrations");
    signet_core::db::ensure_fts_pub(&conn).expect("ensure fts");
    signet_core::db::ensure_vec_table_pub(&conn).expect("ensure vec table");
    conn
}

#[test]
fn upsert_embedding_stamps_agent_and_syncs_vec_index() {
    let conn = setup();
    conn.execute(
        "INSERT INTO memories
         (id, content, type, agent_id, created_at, updated_at, updated_by, importance)
         VALUES (?1, ?2, 'fact', ?3, ?4, ?4, 'test', 0.5)",
        params![
            "mem-agent",
            "Rust daemon embeds memories on write",
            "agent-a",
            "2026-06-01T00:00:00Z"
        ],
    )
    .expect("insert memory");

    let vector: Vec<f32> = (0..768).map(|i| (i as f32) / 768.0).collect();
    upsert(
        &conn,
        &InsertEmbedding {
            id: "memory:mem-agent",
            content_hash: "memory:agent-a:mem-agent:hash",
            vector: &vector,
            source_type: "memory",
            source_id: "mem-agent",
            chunk_text: "Rust daemon embeds memories on write",
            now: "2026-06-01T00:00:01Z",
            agent_id: Some("agent-a"),
        },
    )
    .expect("upsert embedding");

    let agent_id: String = conn
        .query_row(
            "SELECT agent_id FROM embeddings WHERE source_id = ?1",
            params!["mem-agent"],
            |row| row.get(0),
        )
        .expect("read embedding agent");
    assert_eq!(agent_id, "agent-a");

    let vec_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM vec_embeddings WHERE id = ?1",
            params!["memory:mem-agent"],
            |row| row.get(0),
        )
        .expect("read vec count");
    assert_eq!(vec_count, 1);

    let results = vector_search(&conn, &vector, 5, None);
    assert_eq!(
        results.first().map(|(id, _)| id.as_str()),
        Some("mem-agent")
    );
}
