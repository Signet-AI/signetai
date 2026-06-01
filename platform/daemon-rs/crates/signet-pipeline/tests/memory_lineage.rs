use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::Connection;
use signet_pipeline::memory_lineage::{
    MemorySentence, SummaryArtifactInput, TranscriptArtifactInput, write_summary_artifact,
    write_transcript_artifact,
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
fn transcript_recapture_with_different_body_returns_existing_artifact() {
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
    conn.execute(
        "DELETE FROM memory_artifacts WHERE source_path = ?1",
        [&first.artifact_path],
    )
    .expect("simulate DB index missing after artifact file write");

    let second = write_transcript_artifact(
        &conn,
        &root,
        transcript_input("User: first idle capture\nUser: later message\nAssistant: ok"),
    )
    .expect("recapture should return existing transcript artifact");
    let second_content = fs::read_to_string(root.join(&second.artifact_path))
        .expect("read recaptured transcript artifact");

    assert_eq!(second.artifact_path, first.artifact_path);
    assert_eq!(second_content, first_content);
    assert!(second_content.contains("first idle capture"));
    assert!(!second_content.contains("later message"));
    let indexed_content: String = conn
        .query_row(
            "SELECT content FROM memory_artifacts WHERE source_path = ?1",
            [&first.artifact_path],
            |row| row.get(0),
        )
        .expect("recapture should repair missing memory_artifacts row");
    assert!(indexed_content.contains("first idle capture"));
    assert!(!indexed_content.contains("later message"));

    fs::remove_dir_all(root).ok();
}

#[test]
fn identical_transcript_recapture_repairs_missing_artifact_index() {
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
fn summary_collision_with_different_body_still_refuses_mutation() {
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
            .contains("refusing to mutate immutable artifact")
    );

    fs::remove_dir_all(root).ok();
}
