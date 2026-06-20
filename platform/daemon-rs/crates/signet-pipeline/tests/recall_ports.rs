use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, params};
use signet_pipeline::memory_lineage::write_memory_projection;
use signet_services::session::{
    ContinuitySnapshot, ContinuityTracker, DedupState, StructuralSnapshot,
    get_checkpoints_for_project, get_checkpoints_for_session, insert_checkpoint,
};

fn setup_conn() -> Connection {
    let conn = Connection::open_in_memory().expect("open in-memory db");
    signet_core::migrations::run(&conn).expect("run migrations");
    conn
}

fn temp_root(name: &str) -> PathBuf {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_nanos())
        .unwrap_or(0);
    let dir = std::env::temp_dir().join(format!(
        "signet-recall-ports-{name}-{}-{now}",
        std::process::id()
    ));
    fs::create_dir_all(&dir).expect("create temp root");
    dir
}

fn insert_artifact(conn: &Connection, agent_id: &str, token: &str, sentence: &str, content: &str) {
    conn.execute(
        "INSERT INTO memory_artifacts (
            agent_id, source_path, source_sha256, source_kind, session_id,
            session_key, session_token, project, harness, captured_at,
            started_at, ended_at, manifest_path, source_node_id,
            memory_sentence, memory_sentence_quality, content, updated_at
         ) VALUES (?1, ?2, ?3, 'summary', ?4, ?4, ?4, '/repo/signet', 'codex',
                   '2026-06-19T00:00:00Z', NULL, '2026-06-19T00:05:00Z', ?5, NULL,
                   ?6, 'ok', ?7, '2026-06-19T00:05:00Z')",
        params![
            agent_id,
            format!("memory/{token}--summary.md"),
            format!("sha-{token}"),
            token,
            format!("memory/{token}--manifest.md"),
            sentence,
            content
        ],
    )
    .expect("insert artifact");
}

#[test]
fn memory_head_projection_rejects_unsafe_agent_and_writes_scoped_budgeted_file() {
    // Ported from `platform/daemon/src/memory-head.test.ts:92`, `:109`, and `:142`,
    // plus `platform/daemon/src/context-budget.test.ts:31`: MEMORY.md projection is
    // agent-scoped and truncates selected context instead of overflowing budget.
    let conn = setup_conn();
    let root = temp_root("memory-head-budget");

    let err = write_memory_projection(&conn, &root, "../agent-a")
        .expect_err("unsafe agent id must fail before writing");
    assert!(err.contains("Invalid agentId for MEMORY.md path"));
    assert!(!root.join("MEMORY.md").exists());
    assert!(!root.join("agents").exists());

    conn.execute(
        "INSERT INTO memories
         (id, content, type, agent_id, visibility, is_deleted, importance, pinned, created_at, updated_at, updated_by)
         VALUES ('mem-retain', 'retain this context for MEMORY projection', 'fact', 'agent-a', 'private', 0, 0.9, 1,
                 '2026-06-19T00:00:00Z', '2026-06-19T00:00:00Z', 'test')",
        [],
    )
    .expect("insert memory");
    for i in 0..180 {
        insert_artifact(
            &conn,
            "agent-a",
            &format!("session-{i:03}"),
            &format!(
                "Session {i} preserved durable Signet recall context for the projection budget."
            ),
            &"large artifact body ".repeat(80),
        );
    }

    write_memory_projection(&conn, &root, "agent-a").expect("write scoped projection");
    let path = root.join("agents/agent-a/MEMORY.md");
    let file = fs::read_to_string(&path).expect("read scoped MEMORY.md");
    assert!(file.starts_with("# Working Memory Summary"));
    assert!(file.contains("retain this context for MEMORY projection"));
    assert!(
        file.len() < 1_200_000,
        "projection should be budgeted, got {} bytes",
        file.len()
    );
    assert!(!root.join("MEMORY.md").exists());

    fs::remove_dir_all(root).ok();
}

#[test]
fn session_checkpoints_persist_structural_snapshots_and_project_queries() {
    // Ported from `platform/daemon/src/session-checkpoints.test.ts:109`, `:130`,
    // `:158`, and `:166`: checkpoint rows store query/remember arrays,
    // structural snapshot columns, and remain queryable by session/project.
    let conn = setup_conn();
    let snapshot = ContinuitySnapshot {
        session_key: "sess-1".into(),
        harness: "claude-code".into(),
        project: Some("/tmp/project".into()),
        project_normalized: Some("/tmp/project".into()),
        prompt_count: 5,
        total_prompt_count: 5,
        queries: vec!["typescript".into(), "database".into()],
        remembers: vec!["User prefers dark mode".into()],
        snippets: Vec::new(),
        duration_secs: 600,
        structural: Some(StructuralSnapshot {
            focal_entity_ids: vec!["entity-1".into()],
            focal_entity_names: vec!["signetai".into()],
            active_aspect_ids: vec!["aspect-1".into()],
            surfaced_constraint_count: 2,
            traversal_memory_count: 8,
        }),
    };

    insert_checkpoint(
        &conn,
        &snapshot,
        "periodic",
        "## Checkpoint\nSome work happened",
    )
    .expect("insert checkpoint");
    let by_session = get_checkpoints_for_session(&conn, "sess-1").expect("session checkpoints");
    assert_eq!(by_session.len(), 1);
    assert_eq!(by_session[0].session_key, "sess-1");
    assert_eq!(by_session[0].harness, "claude-code");
    assert_eq!(by_session[0].prompt_count, 5);
    assert_eq!(
        by_session[0].memory_queries.as_deref(),
        Some("[\"typescript\",\"database\"]")
    );
    assert_eq!(
        by_session[0].recent_remembers.as_deref(),
        Some("[\"User prefers dark mode\"]")
    );
    assert_eq!(
        by_session[0].focal_entity_names.as_deref(),
        Some("[\"signetai\"]")
    );
    assert_eq!(by_session[0].surfaced_constraint_count, Some(2));
    assert_eq!(by_session[0].traversal_memory_count, Some(8));

    let by_project =
        get_checkpoints_for_project(&conn, "/tmp/project", 10).expect("project checkpoints");
    assert_eq!(by_project.len(), 1);
    assert_eq!(by_project[0].session_key, "sess-1");
}

#[test]
fn continuity_tracker_merges_structural_snapshot_into_next_checkpoint_snapshot() {
    // Ported from `platform/daemon/src/session-checkpoints.test.ts:166`: queued
    // checkpoint state carries structural snapshots explicitly into the flushed row.
    let tracker = ContinuityTracker::new();
    tracker.init("structural-merge", "codex", Some("/repo"), Some("/repo"));
    tracker.record_prompt(
        "structural-merge",
        "recall gates",
        "Prompt about recall gates",
    );
    tracker.record_remember("structural-merge", "User prefers scoped recall");
    tracker.set_structural_snapshot(
        "structural-merge",
        StructuralSnapshot {
            focal_entity_ids: vec!["entity-1".into(), "entity-2".into()],
            focal_entity_names: vec!["signetai".into(), "signet-core".into()],
            active_aspect_ids: vec!["aspect-1".into(), "aspect-2".into()],
            surfaced_constraint_count: 3,
            traversal_memory_count: 24,
        },
    );

    let snapshot = tracker
        .peek_snapshot("structural-merge")
        .expect("checkpoint snapshot");
    assert_eq!(snapshot.queries, vec!["recall gates"]);
    assert_eq!(snapshot.remembers, vec!["User prefers scoped recall"]);
    let structural = snapshot.structural.expect("structural snapshot");
    assert_eq!(
        structural.focal_entity_names,
        vec!["signetai", "signet-core"]
    );
    assert_eq!(structural.active_aspect_ids, vec!["aspect-1", "aspect-2"]);
    assert_eq!(structural.surfaced_constraint_count, 3);
    assert_eq!(structural.traversal_memory_count, 24);
}

#[test]
fn session_start_dedup_is_scoped_and_prompt_dedup_resets_after_compaction() {
    // Ported from `platform/daemon/src/session-recall-dedupe.test.ts:181` and
    // `platform/daemon/src/session-checkpoints.test.ts:472`: dedupe must isolate
    // agents sharing raw harness keys and must clear prompt-level recalled IDs after compaction.
    let dedup = DedupState::new();
    assert!(!dedup.mark_session_start_scoped("agent-a", Some("codex"), Some("/repo"), "sess-1"));
    assert!(dedup.mark_session_start_scoped("agent-a", Some("codex"), Some("/repo"), "sess-1"));
    assert!(!dedup.mark_session_start_scoped("agent-b", Some("codex"), Some("/repo"), "sess-1"));

    dedup.record_prompt_ids("sess-1", vec!["mem-1".into(), "mem-2".into()]);
    assert_eq!(dedup.recent_ids("sess-1"), vec!["mem-1", "mem-2"]);
    dedup.reset_prompt_dedup("sess-1");
    assert!(dedup.recent_ids("sess-1").is_empty());
}
