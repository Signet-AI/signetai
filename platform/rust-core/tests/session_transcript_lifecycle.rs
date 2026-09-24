use signet_core_native::{Operation, WorkspaceOwner};
use std::{
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};

fn database() -> PathBuf {
    let id = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    std::env::temp_dir().join(format!("session-transcript-{id}.db"))
}

#[test]
fn transcript_upsert_is_readable_after_owner_restart_and_agent_scoped() {
    let path = database();
    let owner = WorkspaceOwner::open(&path, 8).unwrap();
    owner.initialize().unwrap();
    owner
        .submit(Operation::TranscriptUpsert {
            agent_id: "agent-a".into(),
            session_key: "session-1".into(),
            harness: "codex".into(),
            project: Some("project-a".into()),
            content: "durable transcript body".into(),
            idempotency_key: "once".into(),
        })
        .unwrap();
    drop(owner);
    let owner = WorkspaceOwner::open(&path, 8).unwrap();
    owner.initialize().unwrap();
    let rows = owner
        .submit(Operation::TranscriptList {
            agent_id: "agent-a".into(),
            limit: 100,
        })
        .unwrap();
    assert_eq!(rows[0]["content"], "durable transcript body");
    let other = owner
        .submit(Operation::TranscriptList {
            agent_id: "agent-b".into(),
            limit: 100,
        })
        .unwrap();
    assert_eq!(other.as_array().unwrap().len(), 0);
    drop(owner);
    let _ = std::fs::remove_file(path);
}
