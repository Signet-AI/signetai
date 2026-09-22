use rusqlite::Connection;
use signet_core_native::{Core, Operation};
use tempfile::tempdir;

#[test]
fn integrity_only_skips_actual_fts5_objects() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("integrity.sqlite");
    let core = Core::open(&path, 2).unwrap();
    drop(core);
    let db = Connection::open(&path).unwrap();
    db.execute(
        "CREATE TABLE ordinary_phrase (value TEXT CHECK(value <> 'using fts5'))",
        [],
    )
    .unwrap();
    db.execute("CREATE VIRTUAL TABLE custom_search USING fts5(content)", [])
        .unwrap();
    let core = Core::open(&path, 2).unwrap();
    let result = core
        .submit(Operation::IntegrityVerify {
            agent_id: "agent".into(),
            workspace_id: "workspace".into(),
            project_id: None,
            visibility: "private".into(),
            budget: 1,
        })
        .unwrap();
    let skipped = result["skippedObjects"].as_array().unwrap();
    assert!(skipped.iter().any(|object| object == "custom_search"));
    assert!(!skipped.iter().any(|object| object == "ordinary_phrase"));
}

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
    let actual_schema_version: i64 = Connection::open(&path)
        .unwrap()
        .query_row("PRAGMA schema_version", [], |row| row.get(0))
        .unwrap();
    assert_eq!(first["checkpoint"]["schemaVersion"], actual_schema_version);

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
