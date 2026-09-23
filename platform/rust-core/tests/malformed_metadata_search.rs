use rusqlite::Connection;
use signet_core_native::{Core, Operation};
use tempfile::tempdir;

#[test]
fn memory_search_returns_matches_when_legacy_metadata_is_malformed() {
    let dir = tempdir().unwrap();
    let db_path = dir.path().join("memories.sqlite");
    let core = Core::open(&db_path, 2).unwrap();
    core.submit(Operation::Remember {
        agent_id: "agent".into(),
        content: "legacy malformed needle".into(),
        metadata: serde_json::json!({}),
    })
    .unwrap();
    core.submit(Operation::Remember {
        agent_id: "agent".into(),
        content: "live legacy needle".into(),
        metadata: serde_json::json!({}),
    })
    .unwrap();
    drop(core);

    let db = Connection::open(&db_path).unwrap();
    db.execute(
        "UPDATE memories SET metadata = ?, stale_at = ? WHERE content = ?",
        (
            "{malformed",
            "2025-01-01T00:00:00Z",
            "legacy malformed needle",
        ),
    )
    .unwrap();
    db.execute(
        "UPDATE memories SET superseded_by = ? WHERE content = ?",
        ("replacement", "valid legacy needle"),
    )
    .unwrap();
    drop(db);

    let core = Core::open(&db_path, 2).unwrap();
    let result = core
        .submit(Operation::MemorySearch {
            agent_id: "agent".into(),
            query: "needle".into(),
            limit: 10,
        })
        .unwrap();
    let ids = result["results"].as_array().unwrap();
    assert_eq!(ids.len(), 1);
    assert!(ids
        .iter()
        .any(|row| row["content"] == "live legacy needle"));
    assert!(!ids
        .iter()
        .any(|row| row["content"] == "legacy malformed needle"));
    assert!(!ids
        .iter()
        .any(|row| row["content"] == "valid legacy needle"));
}
