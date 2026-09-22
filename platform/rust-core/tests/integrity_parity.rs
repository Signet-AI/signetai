use rusqlite::Connection;
use signet_core_native::{Core, Operation};
use tempfile::tempdir;

fn verify(
    core: &Core,
    agent: &str,
    workspace: &str,
    project_id: Option<&str>,
    visibility: &str,
    budget: usize,
) -> serde_json::Value {
    core.submit(Operation::IntegrityVerify {
        agent_id: agent.into(),
        workspace_id: workspace.into(),
        project_id: project_id.map(str::to_owned),
        visibility: visibility.into(),
        budget,
    })
    .unwrap()
}

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

#[test]
fn integrity_migrates_legacy_checkpoint_columns() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("legacy.sqlite");
    let core = Core::open(&path, 2).unwrap();
    drop(core);
    let db = Connection::open(&path).unwrap();
    db.execute("CREATE TABLE integrity_checkpoints (agent_id TEXT NOT NULL, workspace_id TEXT NOT NULL, project_id TEXT NOT NULL DEFAULT '', visibility TEXT NOT NULL, schema_hash TEXT NOT NULL, next_table TEXT, completed INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, PRIMARY KEY(agent_id,workspace_id,project_id,visibility))", []).unwrap();
    drop(db);
    let core = Core::open(&path, 2).unwrap();
    let result = verify(&core, "agent", "workspace", None, "private", 1);
    assert!(result["checkpoint"]["schemaVersion"].is_number());
    let db = Connection::open(&path).unwrap();
    assert!(db
        .query_row(
            "SELECT skipped_objects FROM integrity_checkpoints",
            [],
            |r| r.get::<_, String>(0)
        )
        .is_ok());
}

#[test]
fn integrity_budget_advances_frontier_and_is_idempotent_after_completion() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("progress.sqlite");
    let core = Core::open(&path, 2).unwrap();
    let first = verify(&core, "agent", "workspace", None, "private", 1);
    assert_eq!(first["checkedTables"][0]["table"], "documents");
    assert_eq!(first["checkpoint"]["nextTable"], "memories");
    let second = verify(&core, "agent", "workspace", None, "private", 1);
    assert_eq!(second["checkedTables"][0]["table"], "memories");
    let third = verify(&core, "agent", "workspace", None, "private", 1);
    assert_eq!(third["checkedTables"][0]["table"], "jobs");
    assert_eq!(third["checkpoint"]["completed"], true);
    let repeat = verify(&core, "agent", "workspace", None, "private", 1);
    assert!(repeat["checkedTables"].as_array().unwrap().is_empty());
    assert_eq!(repeat["checkpoint"]["completed"], true);
}

#[test]
fn integrity_checkpoint_scopes_are_isolated() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("scopes.sqlite");
    let core = Core::open(&path, 2).unwrap();
    let private = verify(&core, "agent", "workspace", Some("one"), "private", 1);
    assert_eq!(private["checkpoint"]["nextTable"], "memories");
    let shared = verify(&core, "agent", "workspace", Some("one"), "shared", 1);
    assert_eq!(shared["checkedTables"][0]["table"], "documents");
    let other = verify(&core, "agent", "workspace", Some("two"), "private", 1);
    assert_eq!(other["checkedTables"][0]["table"], "documents");
}
