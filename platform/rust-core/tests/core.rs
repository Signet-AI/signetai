use rusqlite::Connection;
use signet_core_native::{Core, CoreError, NewMemory, Operation, UpdateMemory, WorkspaceOwner};
use tempfile::tempdir;

fn core() -> Core {
    let d = tempdir().unwrap();
    let p = d.path().join("db.sqlite");
    let _workspace = Box::leak(Box::new(d));
    Core::open(&p, 2).unwrap()
}

#[test]
fn fresh_db_and_idempotent_init() {
    let c = core();
    assert!(c.ready().unwrap());
    c.initialize().unwrap();
    c.initialize().unwrap();
}
#[test]
fn scoped_writes_and_reads() {
    let c = core();
    let a = c.remember("a", NewMemory::text("hello world")).unwrap();
    let b = c.remember("b", NewMemory::text("hello other")).unwrap();
    assert_eq!(c.list("a", false).unwrap().len(), 1);
    assert!(c.get("a", &a).unwrap().is_some());
    assert!(c.get("a", &b).unwrap().is_none());
    assert_eq!(c.recall("a", "world").unwrap().len(), 1);
    c.update("a", &a, UpdateMemory::text("changed")).unwrap();
    c.delete("a", &a).unwrap();
    assert!(c.list("a", false).unwrap().is_empty());
    c.recover("a", &a).unwrap();
    assert_eq!(c.get("a", &a).unwrap().unwrap().content, "changed");
    assert_eq!(c.history("a", &a).unwrap().len(), 4);
}
#[test]
fn queue_saturates_explicitly() {
    let c = core();
    c.admit("a", "one").unwrap();
    c.admit("a", "two").unwrap();
    assert!(matches!(
        c.admit("a", "three"),
        Err(CoreError::QueueFull { .. })
    ));
    assert_eq!(c.release_admitted(1).unwrap(), 1);
    c.admit("a", "after-release").unwrap();
}
#[test]
fn failed_update_rolls_back() {
    let c = core();
    let id = c.remember("a", NewMemory::text("stable")).unwrap();
    assert!(matches!(
        c.update("other-agent", &id, UpdateMemory::text("must-not-write")),
        Err(CoreError::NotFound)
    ));
    assert_eq!(c.get("a", &id).unwrap().unwrap().content, "stable");
}

#[test]
fn opens_a_current_style_workspace_without_destroying_existing_rows() {
    let d = tempdir().unwrap();
    let p = d.path().join("current.sqlite");
    let connection = Connection::open(&p).unwrap();
    connection.execute_batch(
        "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL, checksum TEXT NOT NULL);
         CREATE TABLE memories (id TEXT PRIMARY KEY, content TEXT NOT NULL, agent_id TEXT, is_deleted INTEGER DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
         INSERT INTO memories(id, content, agent_id, is_deleted, created_at, updated_at) VALUES ('legacy', 'kept', 'legacy-agent', 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');",
    ).unwrap();
    drop(connection);

    let owner = Core::open(&p, 4).unwrap();
    let existing = owner.get("legacy-agent", "legacy").unwrap().unwrap();
    assert_eq!(existing.content, "kept");
    let id = owner
        .remember("legacy-agent", NewMemory::text("new"))
        .unwrap();
    assert!(owner.get("legacy-agent", &id).unwrap().is_some());
}

#[test]
fn workspace_submit_operations_run_on_owner_without_requeue_deadlock() {
    let d = tempdir().unwrap();
    let owner = WorkspaceOwner::open(&d.path().join("owner.sqlite"), 2).unwrap();
    assert_eq!(owner.submit(Operation::Health).unwrap()["ready"], true);
    let created = owner.submit(Operation::Remember {
        agent_id: "agent".into(), content: "inline".into(), metadata: serde_json::json!({}),
    }).unwrap();
    assert!(created["id"].as_str().is_some());
    let listed = owner.submit(Operation::List { agent_id: "agent".into(), include_deleted: false }).unwrap();
    assert_eq!(listed.as_array().unwrap().len(), 1);
}