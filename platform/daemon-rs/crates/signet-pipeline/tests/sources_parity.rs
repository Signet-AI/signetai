use std::collections::HashSet;

use rusqlite::{Connection, params};
use signet_core::queries::embedding::vector_to_blob;
use signet_core::search::{SearchSource, source_chunk_vector_fallbacks};
use signet_core::types::ExtractedEntity;
use signet_pipeline::graph_transactions::{
    DecrementInput, StructuredAspect, StructuredAttribute, decrement_entity_mentions,
    persist_structured,
};

fn setup_conn() -> Connection {
    signet_core::db::register_vec_extension();
    let conn = Connection::open_in_memory().expect("open in-memory db");
    signet_core::db::configure_pragmas_pub(&conn).expect("configure pragmas");
    signet_core::migrations::run(&conn).expect("run migrations");
    signet_core::db::ensure_fts_pub(&conn).expect("ensure fts");
    signet_core::db::ensure_vec_table_pub(&conn).expect("ensure vec table");
    conn
}

fn extracted(source: &str, relationship: &str, target: &str) -> ExtractedEntity {
    ExtractedEntity {
        source: source.to_string(),
        source_type: Some("project".to_string()),
        relationship: relationship.to_string(),
        target: target.to_string(),
        target_type: Some("project".to_string()),
        confidence: 0.9,
    }
}

fn insert_memory(conn: &Connection, id: &str, content: &str) {
    conn.execute(
        "INSERT INTO memories
         (id, content, normalized_content, content_hash, type, agent_id, updated_by, created_at, updated_at, is_deleted)
         VALUES (?1, ?2, ?2, ?3, 'fact', 'default', 'test', '2026-06-20T00:00:00Z', '2026-06-20T00:00:00Z', 0)",
        params![id, content, format!("hash-{id}")],
    )
    .expect("insert memory fixture");
}

// Port of platform/daemon/src/obsidian-source-embeddings.test.ts:53-104 and
// source-artifact-graph.test.ts:48-88. Source chunks must remain source-backed
// recall hits, carry provider/path provenance, honor agent scope, and avoid
// materializing local memories.
#[test]
fn source_chunk_fallback_preserves_provider_path_scope_without_memories() {
    let conn = setup_conn();
    let query_vec = vec![1.0_f32, 0.0, 0.0];
    let matching = vector_to_blob(&query_vec);
    let wrong = vector_to_blob(&[0.0_f32, 1.0, 0.0]);

    for (id, agent_id, source_type, source_id, chunk_text, vector) in [
        (
            "emb-obsidian",
            "agent-a",
            "source_obsidian_chunk",
            "obsidian:vault:notes/Hyprland.md#heading:1-4:0",
            "source_id: obsidian:vault\nsource_provider: obsidian\nsource_path: /vault/notes/Hyprland.md\nHyprland source-backed note claim.",
            matching.clone(),
        ),
        (
            "emb-other-agent",
            "agent-b",
            "source_obsidian_chunk",
            "obsidian:vault:notes/Other.md#heading:1-4:0",
            "source_path: /vault/notes/Other.md\nOther agent source chunk must not leak.",
            matching.clone(),
        ),
        (
            "emb-wrong-vector",
            "agent-a",
            "source_chunk",
            "discord:test:message/789#body:1-4:0",
            "source_path: discord://guild/123/channel/456/message/789\nWrong vector source chunk.",
            wrong,
        ),
    ] {
        conn.execute(
            "INSERT INTO embeddings
             (id, content_hash, vector, dimensions, source_type, source_id, chunk_text, created_at, agent_id)
             VALUES (?1, ?2, ?3, 3, ?4, ?5, ?6, '2026-06-20T00:00:00Z', ?7)",
            params![id, format!("hash-{id}"), vector, source_type, source_id, chunk_text, agent_id],
        )
        .expect("insert source chunk embedding");
    }

    let hits =
        source_chunk_vector_fallbacks(&conn, Some(&query_vec), &HashSet::new(), 5, "agent-a", None);

    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].source, SearchSource::SourceObsidian);
    assert_eq!(hits[0].source_path, "/vault/notes/Hyprland.md");
    assert_eq!(
        hits[0].source_id,
        "obsidian:vault:notes/Hyprland.md#heading:1-4:0"
    );
    assert!(
        hits[0]
            .content
            .contains("Hyprland source-backed note claim")
    );
    let memory_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM memories", [], |row| row.get(0))
        .expect("count memories");
    assert_eq!(memory_count, 0);

    let existing = HashSet::from(["obsidian:vault:notes/Hyprland.md#heading:1-4:0".to_string()]);
    assert!(
        source_chunk_vector_fallbacks(&conn, Some(&query_vec), &existing, 5, "agent-a", None)
            .is_empty()
    );
}

// Port of platform/daemon/src/source-artifact-graph.test.ts:29-88 and
// obsidian-source-graph.test.ts:68-124. Rust does not yet own the provider
// graph projector, so this locks the migrated schema/read contract those
// projectors rely on: source-owned graph rows are provenance-preserving,
// memoryless, and agent-scoped.
#[test]
fn source_owned_graph_rows_preserve_provenance_and_agent_scope() {
    let conn = setup_conn();
    conn.execute_batch(
        "INSERT INTO entities
            (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at,
             source_id, source_kind, source_path, source_root)
         VALUES
            ('doc-a', 'Message 789', 'source:discord:test:message:789', 'source_document', 'agent-a', 1,
             '2026-06-20T00:00:00Z', '2026-06-20T00:00:00Z', 'discord:test',
             'source_discord_message', 'discord://guild/123/channel/456/message/789',
             'discord://source/discord:test'),
            ('folder-a', 'channel/456', 'source:discord:test:channel:456', 'source_folder', 'agent-a', 1,
             '2026-06-20T00:00:00Z', '2026-06-20T00:00:00Z', 'discord:test',
             'source_discord_channel', 'discord://guild/123/channel/456',
             'discord://source/discord:test'),
            ('doc-b', 'Other Message', 'source:discord:test:message:other', 'source_document', 'agent-b', 1,
             '2026-06-20T00:00:00Z', '2026-06-20T00:00:00Z', 'discord:test',
             'source_discord_message', 'discord://guild/123/channel/456/message/other',
             'discord://source/discord:test');
         INSERT INTO entity_aspects
            (id, entity_id, agent_id, name, canonical_name, weight, created_at, updated_at)
         VALUES
            ('asp-a', 'doc-a', 'agent-a', 'Message 789', 'message 789', 0.5,
             '2026-06-20T00:00:00Z', '2026-06-20T00:00:00Z');
         INSERT INTO entity_attributes
            (id, aspect_id, agent_id, memory_id, kind, content, normalized_content,
             group_key, claim_key, confidence, importance, status, created_at, updated_at,
             source_id, source_kind, source_path, source_root)
         VALUES
            ('attr-a', 'asp-a', 'agent-a', NULL, 'attribute',
             'Signet Discord source parity preserves provider provenance for graph claims.',
             'signet discord source parity preserves provider provenance for graph claims.',
             'discord_test', 'provider_provenance', 0.8, 0.5, 'active',
             '2026-06-20T00:00:00Z', '2026-06-20T00:00:00Z', 'discord:test',
             'source_discord_message', 'discord://guild/123/channel/456/message/789',
             'discord://source/discord:test');
         INSERT INTO entity_dependencies
            (id, source_entity_id, target_entity_id, agent_id, dependency_type, strength, confidence,
             reason, created_at, updated_at, source_id, source_kind, source_path, source_root)
         VALUES
            ('dep-a', 'folder-a', 'doc-a', 'agent-a', 'contains', 1.0, 0.9,
             'source artifact parent contains document', '2026-06-20T00:00:00Z',
             '2026-06-20T00:00:00Z', 'discord:test', 'source_discord_message',
             'discord://guild/123/channel/456/message/789', 'discord://source/discord:test');",
    )
    .expect("seed source-owned graph rows");

    let memories: i64 = conn
        .query_row("SELECT COUNT(*) FROM memories", [], |row| row.get(0))
        .expect("count memories");
    assert_eq!(memories, 0);

    let row: (String, String, String, String) = conn
        .query_row(
            "SELECT entity_type, source_id, source_kind, source_path
             FROM entities WHERE agent_id = 'agent-a' AND source_path = 'discord://guild/123/channel/456/message/789'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .expect("read source document row");
    assert_eq!(row.0, "source_document");
    assert_eq!(row.1, "discord:test");
    assert_eq!(row.2, "source_discord_message");
    assert_eq!(row.3, "discord://guild/123/channel/456/message/789");

    let attr_memory_id: Option<String> = conn
        .query_row(
            "SELECT memory_id FROM entity_attributes WHERE id = 'attr-a'",
            [],
            |row| row.get(0),
        )
        .expect("read source attr memory link");
    assert_eq!(attr_memory_id, None);

    let agent_a_docs: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM entities WHERE agent_id = 'agent-a' AND source_id = 'discord:test'",
            [],
            |row| row.get(0),
        )
        .expect("count agent a source rows");
    let agent_b_docs: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM entities WHERE agent_id = 'agent-b' AND source_id = 'discord:test'",
            [],
            |row| row.get(0),
        )
        .expect("count agent b source rows");
    assert_eq!(agent_a_docs, 2);
    assert_eq!(agent_b_docs, 1);
}

// Port of platform/daemon/src/pipeline/graph-transactions.test.ts:217-278.
// Structured co-occurrence writes must create a reasoned dependency and the DB
// audit trigger must record creation metadata.
#[test]
fn structured_graph_persistence_records_dependency_audit_history() {
    let conn = setup_conn();
    insert_memory(
        &conn,
        "mem-audit",
        "Alpha Project uses Bravo Project and Charlie Project together in the same workflow.",
    );
    let result = persist_structured(
        &conn,
        &[
            extracted("Alpha Project", "uses", "Bravo Project"),
            extracted("Alpha Project", "uses", "Charlie Project"),
        ],
        &[
            StructuredAspect {
                entity_name: "Bravo Project".to_string(),
                entity_type: Some("project".to_string()),
                aspect: "role".to_string(),
                attributes: vec![StructuredAttribute {
                    group_key: None,
                    claim_key: None,
                    content: "is part of the same workflow".to_string(),
                    confidence: None,
                    importance: None,
                }],
            },
            StructuredAspect {
                entity_name: "Charlie Project".to_string(),
                entity_type: Some("project".to_string()),
                aspect: "role".to_string(),
                attributes: vec![StructuredAttribute {
                    group_key: None,
                    claim_key: None,
                    content: "is part of the same workflow".to_string(),
                    confidence: None,
                    importance: None,
                }],
            },
        ],
        "mem-audit",
        "Alpha Project uses Bravo Project and Charlie Project together in the same workflow.",
        "default",
        "2026-06-20T00:00:00Z",
    );

    assert_eq!(result.relations_inserted, 2);
    assert_eq!(result.attributes_created, 2);

    let dep: (String, String) = conn
        .query_row(
            "SELECT id, reason
             FROM entity_dependencies
             WHERE source_entity_id IN (SELECT id FROM entities WHERE canonical_name = 'bravo project')
               AND target_entity_id IN (SELECT id FROM entities WHERE canonical_name = 'charlie project')
               AND dependency_type = 'related_to'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("related_to dependency");
    assert!(dep.1.contains("mem-audit"));

    let hist: (String, String, String, String) = conn
        .query_row(
            "SELECT event, changed_by, reason, metadata
             FROM entity_dependency_history
             WHERE dependency_id = ?1 AND event = 'created'
             ORDER BY rowid DESC LIMIT 1",
            params![dep.0],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .expect("dependency audit history");
    assert_eq!(hist.0, "created");
    assert_eq!(hist.1, "db-trigger");
    assert!(hist.2.contains("mem-audit"));
    assert!(hist.3.contains("trg_entity_dependencies_audit_insert"));
}

// Port of platform/daemon/src/pipeline/supersession.test.ts:225-248 and
// graph-transactions.test.ts claim-key coverage. A newer structured claim in
// the same group/claim slot supersedes the older active attribute.
#[test]
fn structured_claim_key_supersedes_older_attribute_in_same_slot() {
    let conn = setup_conn();
    insert_memory(
        &conn,
        "mem-old",
        "Project uses MySQL database for primary storage",
    );
    insert_memory(
        &conn,
        "mem-new",
        "Project now uses PostgreSQL database instead of MySQL for primary storage",
    );
    let first = persist_structured(
        &conn,
        &[],
        &[StructuredAspect {
            entity_name: "Nicholai".to_string(),
            entity_type: Some("person".to_string()),
            aspect: "storage".to_string(),
            attributes: vec![StructuredAttribute {
                group_key: Some("runtime".to_string()),
                claim_key: Some("database engine".to_string()),
                content: "Project uses MySQL database for primary storage".to_string(),
                confidence: Some(0.9),
                importance: Some(0.6),
            }],
        }],
        "mem-old",
        "Project uses MySQL database for primary storage",
        "default",
        "1000",
    );
    assert_eq!(first.attributes_created, 1);

    let second = persist_structured(
        &conn,
        &[],
        &[StructuredAspect {
            entity_name: "Nicholai".to_string(),
            entity_type: Some("person".to_string()),
            aspect: "storage".to_string(),
            attributes: vec![StructuredAttribute {
                group_key: Some("runtime".to_string()),
                claim_key: Some("database engine".to_string()),
                content:
                    "Project now uses PostgreSQL database instead of MySQL for primary storage"
                        .to_string(),
                confidence: Some(0.9),
                importance: Some(0.7),
            }],
        }],
        "mem-new",
        "Project now uses PostgreSQL database instead of MySQL for primary storage",
        "default",
        "2000",
    );
    assert_eq!(second.attributes_created, 1);
    assert_eq!(second.attributes_superseded, 1);

    let rows = {
        let mut stmt = conn
            .prepare(
                "SELECT memory_id, content, status, superseded_by, group_key, claim_key
                 FROM entity_attributes ORDER BY memory_id",
            )
            .expect("prepare attributes query");
        stmt.query_map([], |row| {
            Ok((
                row.get::<_, Option<String>>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, Option<String>>(5)?,
            ))
        })
        .expect("query attributes")
        .collect::<Result<Vec<_>, _>>()
        .expect("collect attributes")
    };

    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].0.as_deref(), Some("mem-new"));
    assert_eq!(rows[0].2, "active");
    assert_eq!(rows[0].4.as_deref(), Some("runtime"));
    assert_eq!(rows[0].5.as_deref(), Some("database_engine"));
    assert_eq!(rows[1].0.as_deref(), Some("mem-old"));
    assert_eq!(rows[1].2, "superseded");
    assert!(rows[1].3.is_some());
}

// Port of platform/daemon/src/pipeline/graph-transactions.test.ts:352-417
// entity decrement coverage. Purging a memory must decrement mentions, remove orphaned
// entities, and delete dangling relations/mention links.
#[test]
fn decrement_entity_mentions_removes_orphans_and_dangling_edges() {
    let conn = setup_conn();
    insert_memory(&conn, "mem-1", "Alice works with Bobby.");
    persist_structured(
        &conn,
        &[extracted("Alice", "works_with", "Bobby")],
        &[],
        "mem-1",
        "Alice works with Bobby.",
        "default",
        "2026-06-20T00:00:00Z",
    );
    let ids = {
        let mut stmt = conn
            .prepare("SELECT id FROM entities ORDER BY name")
            .expect("prepare entity ids");
        stmt.query_map([], |row| row.get::<_, String>(0))
            .expect("query entity ids")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect entity ids")
    };
    assert_eq!(ids.len(), 2);

    let result = decrement_entity_mentions(&conn, &DecrementInput { entity_ids: ids });
    assert_eq!(result.entities_orphaned, 2);
    for table in ["entities", "relations", "memory_entity_mentions"] {
        let sql = format!("SELECT COUNT(*) FROM {table}");
        let count: i64 = conn
            .query_row(&sql, [], |row| row.get(0))
            .expect("count graph table");
        assert_eq!(count, 0, "{table} should be empty after orphan cleanup");
    }
}
