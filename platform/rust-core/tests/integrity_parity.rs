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
    db.execute("INSERT INTO integrity_checkpoints(agent_id,workspace_id,project_id,visibility,schema_hash,next_table,completed,updated_at) VALUES('legacy-agent','legacy-workspace','legacy-project','shared','legacy-hash','memories',1,'2000-01-02T03:04:05Z')", []).unwrap();
    drop(db);
    let core = Core::open(&path, 2).unwrap();
    let result = verify(&core, "agent", "workspace", None, "private", 1);
    assert!(result["checkpoint"]["schemaVersion"].is_number());
    let db = Connection::open(&path).unwrap();
    let legacy: (String, String, i64, String, String, i64) = db.query_row(
        "SELECT schema_hash,next_table,completed,updated_at,skipped_objects,schema_version FROM integrity_checkpoints WHERE agent_id='legacy-agent'",
        [], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?))) .unwrap();
    assert_eq!(
        legacy,
        (
            "legacy-hash".into(),
            "memories".into(),
            1,
            "2000-01-02T03:04:05Z".into(),
            "[]".into(),
            1
        )
    );
    let columns: Vec<String> = db
        .prepare("PRAGMA table_info(integrity_checkpoints)")
        .unwrap()
        .query_map([], |r| r.get(1))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert!(columns.contains(&"skipped_objects".into()));
    assert!(columns.contains(&"schema_version".into()));
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
    let db = Connection::open(&path).unwrap();
    let final_before_repeat: (Option<String>, i64, String, i64, String, String) = db.query_row(
        "SELECT next_table,completed,skipped_objects,schema_version,schema_hash,updated_at FROM integrity_checkpoints WHERE agent_id='agent' AND workspace_id='workspace' AND project_id='' AND visibility='private'",
        [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?))).unwrap();
    let repeat = verify(&core, "agent", "workspace", None, "private", 1);
    assert!(repeat["checkedTables"].as_array().unwrap().is_empty());
    assert_eq!(repeat["checkpoint"]["completed"], true);
    let final_after_repeat: (Option<String>, i64, String, i64, String, String) = db.query_row(
        "SELECT next_table,completed,skipped_objects,schema_version,schema_hash,updated_at FROM integrity_checkpoints WHERE agent_id='agent' AND workspace_id='workspace' AND project_id='' AND visibility='private'",
        [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?))).unwrap();
    assert_eq!(final_after_repeat, final_before_repeat);
}

#[test]
fn integrity_failure_does_not_overwrite_prior_checkpoint() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("corrupt.sqlite");
    let core = Core::open(&path, 2).unwrap();
    verify(&core, "agent", "workspace", None, "private", 1);
    let before_row: (Option<String>, i64, String, i64, String, String) = Connection::open(&path).unwrap().query_row(
        "SELECT next_table,completed,skipped_objects,schema_version,schema_hash,updated_at FROM integrity_checkpoints WHERE agent_id='agent' AND workspace_id='workspace' AND project_id='' AND visibility='private'",
        [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?))).unwrap();
    drop(core);
    let db = Connection::open(&path).unwrap();
    db.execute("CREATE TABLE corruption_probe (value INTEGER)", [])
        .unwrap();
    db.execute(
        "CREATE INDEX corruption_probe_index ON corruption_probe(value)",
        [],
    )
    .unwrap();
    let original_rootpage: i64 = db
        .query_row(
            "SELECT rootpage FROM sqlite_master WHERE name='corruption_probe_index'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let conflicting_rootpage: i64 = db
        .query_row(
            "SELECT rootpage FROM sqlite_master WHERE name='corruption_probe'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_ne!(original_rootpage, conflicting_rootpage);
    db.execute("PRAGMA writable_schema=ON", []).unwrap();
    db.execute(
        "UPDATE sqlite_master SET rootpage=?1 WHERE name='corruption_probe_index'",
        [conflicting_rootpage],
    )
    .unwrap();
    drop(db);
    let db = Connection::open(&path).unwrap();
    let integrity = db.query_row("PRAGMA integrity_check", [], |r| r.get::<_, String>(0));
    assert!(integrity.as_ref().map(|result| result != "ok").unwrap_or(true));
    drop(db);
    let core = Core::open(&path, 2).unwrap();
    let error = core
        .submit(Operation::IntegrityVerify {
            agent_id: "agent".into(),
            workspace_id: "workspace".into(),
            project_id: None,
            visibility: "private".into(),
            budget: 1,
        })
        .unwrap_err();
    assert!(error.to_string().contains("integrity") || error.to_string().contains("malformed"));
    let db = Connection::open(&path).unwrap();
    let after: (Option<String>, i64, String, i64, String, String) = db.query_row(
        "SELECT next_table,completed,skipped_objects,schema_version,schema_hash,updated_at FROM integrity_checkpoints WHERE agent_id='agent' AND workspace_id='workspace' AND project_id='' AND visibility='private'",
        [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?))).unwrap();
    assert_eq!(after, before_row);
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
    let other_agent = verify(&core, "other-agent", "workspace", Some("one"), "private", 1);
    let other_workspace = verify(&core, "agent", "other-workspace", Some("one"), "private", 1);
    assert_eq!(other_agent["checkedTables"][0]["table"], "documents");
    assert_eq!(other_workspace["checkedTables"][0]["table"], "documents");
    let db = Connection::open(&path).unwrap();
    let rows: i64 = db
        .query_row("SELECT count(*) FROM integrity_checkpoints", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(rows, 5);
    let private_next: Option<String> = db.query_row(
        "SELECT next_table FROM integrity_checkpoints WHERE agent_id='agent' AND workspace_id='workspace' AND project_id='one' AND visibility='private'",
        [], |r| r.get(0)).unwrap();
    let shared_next: Option<String> = db.query_row(
        "SELECT next_table FROM integrity_checkpoints WHERE agent_id='agent' AND workspace_id='workspace' AND project_id='one' AND visibility='shared'",
        [], |r| r.get(0)).unwrap();
    assert_eq!(private_next.as_deref(), Some("memories"));
    assert_eq!(shared_next.as_deref(), Some("memories"));
}
