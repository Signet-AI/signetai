use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::Connection;
use signet_pipeline::memory_lineage::{
    MemorySentence, SummaryArtifactInput, TranscriptArtifactInput, reindex_memory_artifacts,
    write_memory_projection, write_summary_artifact, write_transcript_artifact,
};

fn temp_root(name: &str) -> PathBuf {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_nanos())
        .unwrap_or(0);
    let dir = std::env::temp_dir().join(format!(
        "signet-lineage-{name}-{}-{now}",
        std::process::id()
    ));
    fs::create_dir_all(&dir).expect("create temp root");
    dir
}

fn setup_conn() -> Connection {
    let conn = Connection::open_in_memory().expect("open in-memory db");
    signet_core::migrations::run(&conn).expect("run migrations");
    conn
}

fn transcript_input(transcript: &str) -> TranscriptArtifactInput {
    TranscriptArtifactInput {
        agent_id: "default".to_string(),
        session_id: "race-session".to_string(),
        session_key: Some("race-session".to_string()),
        project: Some("/work/signet".to_string()),
        harness: Some("opencode".to_string()),
        captured_at: "2026-06-01T01:45:42.236233+00:00".to_string(),
        started_at: None,
        ended_at: Some("2026-06-01T01:45:42.236233+00:00".to_string()),
        transcript: transcript.to_string(),
    }
}

fn summary_input(summary: &str) -> SummaryArtifactInput {
    SummaryArtifactInput {
        agent_id: "default".to_string(),
        session_id: "race-session".to_string(),
        session_key: Some("race-session".to_string()),
        project: Some("/work/signet".to_string()),
        harness: Some("opencode".to_string()),
        captured_at: "2026-06-01T01:45:42.236233+00:00".to_string(),
        started_at: None,
        ended_at: Some("2026-06-01T01:45:42.236233+00:00".to_string()),
        summary: summary.to_string(),
    }
}

fn sentence() -> MemorySentence {
    MemorySentence {
        text: "Captured Signet session lineage artifact behavior.".to_string(),
        quality: "ok".to_string(),
        generated_at: "2026-06-01T01:45:42.236233+00:00".to_string(),
    }
}

#[test]
fn memory_lineage_transcript_recapture_with_different_body_refuses_mutation() {
    let conn = setup_conn();
    let root = temp_root("transcript-recapture");

    let first = write_transcript_artifact(
        &conn,
        &root,
        transcript_input("User: first idle capture\nAssistant: ok"),
    )
    .expect("write first transcript");
    let first_content = fs::read_to_string(root.join(&first.artifact_path))
        .expect("read first transcript artifact");

    let collision = write_transcript_artifact(
        &conn,
        &root,
        transcript_input("User: first idle capture\nUser: later message\nAssistant: ok"),
    );

    assert!(
        collision
            .expect_err("changed transcript body must be immutable")
            .contains("Refusing to mutate immutable artifact")
    );
    let second_content = fs::read_to_string(root.join(&first.artifact_path))
        .expect("read original transcript artifact");
    assert_eq!(second_content, first_content);
    assert!(second_content.contains("first idle capture"));
    assert!(!second_content.contains("later message"));

    fs::remove_dir_all(root).ok();
}

#[test]
fn memory_lineage_identical_transcript_recapture_repairs_missing_artifact_index() {
    let conn = setup_conn();
    let root = temp_root("transcript-identical-recapture");

    let first = write_transcript_artifact(
        &conn,
        &root,
        transcript_input("User: same idle capture\nAssistant: ok"),
    )
    .expect("write first transcript");
    conn.execute(
        "DELETE FROM memory_artifacts WHERE source_path = ?1",
        [&first.artifact_path],
    )
    .expect("simulate DB index missing after artifact file write");

    let second = write_transcript_artifact(
        &conn,
        &root,
        transcript_input("User: same idle capture\nAssistant: ok"),
    )
    .expect("identical recapture should return existing transcript artifact");

    assert_eq!(second.artifact_path, first.artifact_path);
    let indexed_content: String = conn
        .query_row(
            "SELECT content FROM memory_artifacts WHERE source_path = ?1",
            [&first.artifact_path],
            |row| row.get(0),
        )
        .expect("identical recapture should repair missing memory_artifacts row");
    assert!(indexed_content.contains("same idle capture"));

    fs::remove_dir_all(root).ok();
}

#[test]
fn memory_lineage_summary_collision_with_different_body_still_refuses_mutation() {
    let conn = setup_conn();
    let root = temp_root("summary-collision");

    write_summary_artifact(
        &conn,
        &root,
        summary_input("# Summary\n\nFirst body."),
        sentence(),
    )
    .expect("write first summary");
    let collision = write_summary_artifact(
        &conn,
        &root,
        summary_input("# Summary\n\nDifferent body."),
        sentence(),
    );

    assert!(
        collision
            .expect_err("summary mutation should remain strict")
            .contains("Refusing to mutate immutable artifact")
    );

    fs::remove_dir_all(root).ok();
}

#[test]
fn memory_lineage_session_token_uses_session_id_not_shared_session_key() {
    let conn = setup_conn();
    let root = temp_root("session-token-session-id");
    let mut first = transcript_input("User: first session\nAssistant: ok");
    first.session_id = "session-end:path:one".to_string();
    first.session_key = Some("shared-key".to_string());
    let mut second = transcript_input("User: second session\nAssistant: ok");
    second.session_id = "session-end:path:two".to_string();
    second.session_key = Some("shared-key".to_string());

    let one = write_transcript_artifact(&conn, &root, first).expect("write first session");
    let two = write_transcript_artifact(&conn, &root, second).expect("write second session");

    assert_ne!(one.artifact_path, two.artifact_path);
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM memory_artifacts WHERE source_kind = 'transcript'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(count, 2);
    fs::remove_dir_all(root).ok();
}

#[test]
fn memory_lineage_projection_rejects_unsafe_agent_id_and_writes_scoped_path() {
    let conn = setup_conn();
    let root = temp_root("projection-agent-scope");

    let err = write_memory_projection(&conn, &root, "../evil")
        .expect_err("unsafe agent id should be rejected");
    assert!(err.contains("Invalid agentId for MEMORY.md path"));
    assert!(!root.join("MEMORY.md").exists());

    write_memory_projection(&conn, &root, "agent-a").expect("write scoped projection");
    assert!(root.join("agents/agent-a/MEMORY.md").exists());
    assert!(!root.join("MEMORY.md").exists());
    fs::remove_dir_all(root).ok();
}

#[test]
fn memory_lineage_reindex_preserves_noncanonical_external_artifact_rows() {
    let conn = setup_conn();
    let root = temp_root("reindex-external-preserve");
    conn.execute(
        "INSERT INTO memory_artifacts (
            agent_id, source_path, source_sha256, source_kind, session_id,
            session_key, session_token, project, harness, captured_at,
            started_at, ended_at, manifest_path, source_node_id,
            memory_sentence, memory_sentence_quality, content, updated_at
         ) VALUES ('default', 'external/native.md', 'sha', 'native', 'native:row',
                   'native', 'native-token', NULL, 'codex', '2026-06-01T00:00:00Z',
                   NULL, NULL, NULL, NULL, 'Indexed codex native memory.', 'fallback',
                   'external content', '2026-06-01T00:00:00Z')",
        [],
    )
    .unwrap();

    reindex_memory_artifacts(&conn, &root, Some("default")).expect("reindex succeeds");
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM memory_artifacts WHERE source_path = 'external/native.md'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(count, 1);
    fs::remove_dir_all(root).ok();
}
