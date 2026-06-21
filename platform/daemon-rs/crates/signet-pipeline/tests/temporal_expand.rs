use rusqlite::{Connection, params};
use signet_pipeline::temporal_expand::{TemporalExpandOptions, expand_temporal_node};

fn setup_conn() -> Connection {
    let conn = Connection::open_in_memory().expect("open in-memory db");
    signet_core::migrations::run(&conn).expect("run migrations");
    conn
}

#[allow(clippy::too_many_arguments)]
fn insert_summary(
    conn: &Connection,
    id: &str,
    project: &str,
    depth: i64,
    kind: &str,
    content: &str,
    token_count: i64,
    session_key: Option<&str>,
    harness: Option<&str>,
    agent_id: &str,
    source_type: &str,
    source_ref: Option<&str>,
    meta_json: &str,
    now: &str,
) {
    conn.execute(
        "INSERT INTO session_summaries (
            id, project, depth, kind, content, token_count,
            earliest_at, latest_at, session_key, harness,
            agent_id, source_type, source_ref, meta_json, created_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?14, ?14, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        params![
            id,
            project,
            depth,
            kind,
            content,
            token_count,
            session_key,
            harness,
            agent_id,
            source_type,
            source_ref,
            meta_json,
            now,
            now,
        ],
    )
    .expect("insert summary");
}

fn insert_memory(
    conn: &Connection,
    id: &str,
    content: &str,
    memory_type: &str,
    project: &str,
    agent_id: &str,
    now: &str,
) {
    conn.execute(
        "INSERT INTO memories (
            id, content, type, importance, source_id, source_type,
            who, tags, project, agent_id, created_at, updated_at, updated_by
        ) VALUES (?1, ?2, ?3, 0.8, 'sess-1', 'session_end', 'system', 'release,deploy', ?4, ?5, ?6, ?6, 'test')",
        params![id, content, memory_type, project, agent_id, now],
    )
    .expect("insert memory");
}

// Port of platform/daemon/src/temporal-expand.test.ts:23-149 and the source
// query contract in platform/daemon/src/temporal-expand.ts:144-266.
#[test]
fn expands_lineage_linked_memories_and_transcript_context() {
    let conn = setup_conn();
    let now = "2026-06-20T00:00:00Z";
    insert_summary(
        &conn,
        "parent-1",
        "proj-a",
        1,
        "arc",
        "Arc summary",
        10,
        None,
        None,
        "agent-a",
        "condensation",
        None,
        "{}",
        now,
    );
    insert_summary(
        &conn,
        "node-1",
        "proj-a",
        0,
        "session",
        "Session summary keeps the release blockers and migration plan.",
        20,
        Some("sess-1"),
        Some("opencode"),
        "agent-a",
        "summary",
        Some("sess-1"),
        "{}",
        now,
    );
    insert_summary(
        &conn,
        "child-1",
        "proj-a",
        0,
        "session",
        "Chunk leaf with detailed blockers.",
        8,
        None,
        Some("opencode"),
        "agent-a",
        "chunk",
        Some("sess-1"),
        r#"{"ordinal":1}"#,
        now,
    );
    conn.execute(
        "INSERT INTO session_summary_children (parent_id, child_id, ordinal)
         VALUES ('parent-1', 'node-1', 0), ('node-1', 'child-1', 0)",
        [],
    )
    .expect("insert summary edges");
    insert_memory(
        &conn,
        "mem-1",
        "The migration plan must land before deploy.",
        "decision",
        "proj-a",
        "agent-a",
        now,
    );
    conn.execute(
        "INSERT INTO session_summary_memories (summary_id, memory_id) VALUES ('node-1', 'mem-1')",
        [],
    )
    .expect("insert linked memory");
    conn.execute(
        "INSERT INTO session_transcripts (
            session_key, content, harness, project, agent_id, created_at, updated_at
        ) VALUES (?1, ?2, 'opencode', 'proj-a', 'agent-a', ?3, ?3)",
        params![
            "sess-1",
            "User: check release blockers and migration plan\nAssistant: the deploy waits on migration 045 and compaction parity",
            now,
        ],
    )
    .expect("insert transcript");

    let out = expand_temporal_node(
        &conn,
        "node-1",
        "agent-a",
        TemporalExpandOptions {
            transcript_char_limit: Some(600),
            ..TemporalExpandOptions::default()
        },
    )
    .expect("expand node")
    .expect("node exists");

    assert_eq!(out.node.id, "node-1");
    assert_eq!(
        out.parents
            .iter()
            .map(|row| row.id.as_str())
            .collect::<Vec<_>>(),
        vec!["parent-1"]
    );
    assert_eq!(
        out.children
            .iter()
            .map(|row| row.id.as_str())
            .collect::<Vec<_>>(),
        vec!["child-1"]
    );
    assert_eq!(out.linked_memories[0].id, "mem-1");
    assert_eq!(out.linked_memories[0].memory_type, "decision");
    assert!(!out.linked_memories[0].deleted);
    let transcript = out.transcript.expect("transcript context");
    assert_eq!(transcript.session_key, "sess-1");
    assert_eq!(transcript.harness.as_deref(), Some("opencode"));
    assert_eq!(transcript.project.as_deref(), Some("proj-a"));
    assert!(transcript.excerpt.contains("migration plan"));
}

// Port of platform/daemon/src/temporal-expand.test.ts:151-265 and TS project
// filters in platform/daemon/src/temporal-expand.ts:161-216, :225-231.
#[test]
fn filters_nested_expansion_material_to_requested_project() {
    let conn = setup_conn();
    let now = "2026-06-20T00:00:00Z";
    insert_summary(
        &conn,
        "parent-offscope",
        "proj-b",
        1,
        "arc",
        "Off-scope parent",
        10,
        None,
        None,
        "agent-a",
        "condensation",
        None,
        "{}",
        now,
    );
    insert_summary(
        &conn,
        "node-scope",
        "proj-a",
        0,
        "session",
        "In-scope node",
        20,
        Some("sess-scope"),
        Some("opencode"),
        "agent-a",
        "summary",
        Some("sess-scope"),
        "{}",
        now,
    );
    insert_summary(
        &conn,
        "child-offscope",
        "proj-b",
        0,
        "session",
        "Off-scope child",
        8,
        None,
        Some("opencode"),
        "agent-a",
        "chunk",
        Some("sess-scope"),
        "{}",
        now,
    );
    conn.execute(
        "INSERT INTO session_summary_children (parent_id, child_id, ordinal)
         VALUES ('parent-offscope', 'node-scope', 0), ('node-scope', 'child-offscope', 0)",
        [],
    )
    .expect("insert summary edges");
    insert_memory(
        &conn,
        "mem-offscope",
        "Off-scope linked memory",
        "decision",
        "proj-b",
        "agent-a",
        now,
    );
    conn.execute(
        "INSERT INTO session_summary_memories (summary_id, memory_id) VALUES ('node-scope', 'mem-offscope')",
        [],
    )
    .expect("insert linked memory");
    conn.execute(
        "INSERT INTO session_transcripts (
            session_key, content, harness, project, agent_id, created_at, updated_at
        ) VALUES ('sess-scope', 'Off-scope transcript', 'opencode', 'proj-b', 'agent-a', ?1, ?1)",
        params![now],
    )
    .expect("insert transcript");

    let out = expand_temporal_node(
        &conn,
        "node-scope",
        "agent-a",
        TemporalExpandOptions {
            project: Some("proj-a"),
            transcript_char_limit: Some(600),
            ..TemporalExpandOptions::default()
        },
    )
    .expect("expand node")
    .expect("node exists");

    assert_eq!(out.node.id, "node-scope");
    assert!(out.parents.is_empty());
    assert!(out.children.is_empty());
    assert!(out.linked_memories.is_empty());
    assert!(out.transcript.is_none());
}
