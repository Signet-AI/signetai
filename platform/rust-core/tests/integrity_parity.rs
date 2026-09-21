use rusqlite::Connection;
use signet_core_native::{Core, Operation};
use tempfile::tempdir;

#[test]
fn integrity_reports_skipped_fts_objects_and_restarts_after_schema_change() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("integrity.sqlite");
    let core = Core::open(&path, 2).unwrap();

    let first = core
        .submit(Operation::IntegrityVerify {
            agent_id: "agent".into(),
            workspace_id: "workspace".into(),
            project_id: None,
            visibility: "private".into(),
            budget: 1,
        })
        .unwrap();
    assert!(first["skippedObjects"].is_array());
    assert!(first["skippedObjects"]
        .as_array()
        .unwrap()
        .iter()
        .all(|object| object.as_str().unwrap().contains("memories_fts")));
    assert!(first["checkpoint"]["schemaVersion"].is_number());

    drop(core);
    Connection::open(&path)
        .unwrap()
        .execute("CREATE TABLE integrity_parity_probe (id INTEGER)", [])
        .unwrap();
    let core = Core::open(&path, 2).unwrap();
    let restarted = core
        .submit(Operation::IntegrityVerify {
            agent_id: "agent".into(),
            workspace_id: "workspace".into(),
            project_id: None,
            visibility: "private".into(),
            budget: 1,
        })
        .unwrap();
    assert_eq!(restarted["checkedTables"][0]["table"], "documents");
    assert!(restarted["checkpoint"]["schemaVersion"].is_number());
}
