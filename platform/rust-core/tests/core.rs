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
fn migrates_legacy_transcripts_before_idempotency_index() {
    let d = tempdir().unwrap();
    let p = d.path().join("legacy-transcripts.sqlite");
    let connection = Connection::open(&p).unwrap();
    connection.execute_batch(
        "CREATE TABLE session_transcripts (session_key TEXT NOT NULL, agent_id TEXT NOT NULL, harness TEXT NOT NULL, project TEXT, content TEXT NOT NULL, content_hash TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT);
         INSERT INTO session_transcripts(session_key,agent_id,harness,project,content,content_hash,created_at,updated_at) VALUES ('one','a','test',NULL,'one','h1','2026-01-01','2026-01-01'),('two','a','test',NULL,'two','h2','2026-01-02','2026-01-02');
         CREATE TABLE ontology_records (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, kind TEXT NOT NULL, value TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
         INSERT INTO ontology_records VALUES ('o1','a','kind','{}',0,'2026-01-01','2026-01-01');",
    ).unwrap();
    drop(connection);
    let owner = Core::open(&p, 4).unwrap();
    let connection = Connection::open(&p).unwrap();
    let keys: Vec<String> = {
        let mut query = connection
            .prepare("SELECT idempotency_key FROM session_transcripts ORDER BY rowid")
            .unwrap();
        query
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    };
    assert_eq!(keys, vec!["legacy:1", "legacy:2"]);
    assert_eq!(
        connection
            .query_row(
                "SELECT workspace_id FROM ontology_records WHERE id='o1'",
                [],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
        "default"
    );
    owner.initialize().unwrap();
    owner.initialize().unwrap();
}

#[test]
fn blank_document_workspaces_are_default_scoped_across_all_operations() {
    let owner = core();
    let source = owner
        .submit(Operation::CreateSource {
            agent_id: "default".into(),
            workspace_id: "default".into(),
            kind: "folder".into(),
            name: "blank-workspaces".into(),
            config: serde_json::json!({}),
        })
        .unwrap();
    let source_id = source["id"].as_str().unwrap().to_owned();
    let mut ids = Vec::new();
    for (path, metadata) in [
        ("null.md", serde_json::Value::Null),
        ("empty.md", serde_json::json!({"_workspaceId": ""})),
        ("whitespace.md", serde_json::json!({"_workspaceId": "   "})),
    ] {
        ids.push(
            owner
                .submit(Operation::IngestDocument {
                    agent_id: "default".into(),
                    workspace_id: "default".into(),
                    source_id: source_id.clone(),
                    path: path.into(),
                    content: format!("body for {path}"),
                    metadata,
                })
                .unwrap()["id"]
                .as_str()
                .unwrap()
                .to_owned(),
        );
    }
    let listed = owner
        .submit(Operation::DocumentList {
            agent_id: "default".into(),
            workspace_id: "default".into(),
            limit: 10,
        })
        .unwrap();
    assert_eq!(listed["items"].as_array().unwrap().len(), 3);
    for id in &ids {
        let document = owner
            .submit(Operation::DocumentGet {
                agent_id: "default".into(),
                workspace_id: "default".into(),
                id: id.clone(),
            })
            .unwrap();
        assert!(!document.is_null());
        assert_eq!(
            owner
                .submit(Operation::DocumentChunks {
                    agent_id: "default".into(),
                    workspace_id: "default".into(),
                    id: id.clone(),
                    limit: 10,
                })
                .unwrap()["items"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
    }
    let deleted = owner
        .submit(Operation::DocumentDelete {
            agent_id: "default".into(),
            workspace_id: "default".into(),
            id: ids[0].clone(),
        })
        .unwrap();
    assert_eq!(deleted["deleted"], true);
    assert_eq!(
        owner
            .submit(Operation::SourceHealth {
                agent_id: "default".into(),
                workspace_id: "default".into(),
                source_id: source_id.clone()
            })
            .unwrap()["documents"],
        2
    );
    let deleted_source = owner
        .submit(Operation::DeleteSource {
            agent_id: "default".into(),
            workspace_id: "default".into(),
            source_id,
        })
        .unwrap();
    assert_eq!(deleted_source["documentsDeleted"], 2);
    owner.initialize().unwrap();
    owner.initialize().unwrap();
}

#[test]
fn migrates_legacy_source_and_document_workspace_to_default_and_cleans_up() {
    let d = tempdir().unwrap();
    let p = d.path().join("legacy-sources.sqlite");
    let connection = Connection::open(&p).unwrap();
    connection.execute_batch(
        "CREATE TABLE sources (id TEXT PRIMARY KEY, agent_id TEXT, kind TEXT NOT NULL, name TEXT, config TEXT, created_at TEXT);
         CREATE TABLE documents (id TEXT PRIMARY KEY, agent_id TEXT, source_id TEXT NOT NULL, path TEXT NOT NULL, content TEXT NOT NULL, metadata TEXT, created_at TEXT);
         INSERT INTO sources VALUES ('legacy-source', NULL, 'folder', 'legacy', '{}', '2026-01-01');
         INSERT INTO documents VALUES ('legacy-doc', NULL, 'legacy-source', 'legacy.md', 'legacy body', '{}', '2026-01-01');",
    ).unwrap();
    drop(connection);
    let owner = Core::open(&p, 4).unwrap();
    assert_eq!(
        owner
            .submit(Operation::ListSources {
                agent_id: "default".into(),
                workspace_id: "default".into()
            })
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let docs = owner
        .submit(Operation::DocumentList {
            agent_id: "default".into(),
            workspace_id: "default".into(),
            limit: 10,
        })
        .unwrap();
    assert_eq!(docs["items"].as_array().unwrap().len(), 1);
    let health = owner
        .submit(Operation::SourceHealth {
            agent_id: "default".into(),
            workspace_id: "default".into(),
            source_id: "legacy-source".into(),
        })
        .unwrap();
    assert_eq!(health["documents"], 1);
    let deleted = owner
        .submit(Operation::DeleteSource {
            agent_id: "default".into(),
            workspace_id: "default".into(),
            source_id: "legacy-source".into(),
        })
        .unwrap();
    assert_eq!(deleted["documentsDeleted"], 1);
    assert_eq!(
        owner
            .submit(Operation::DocumentList {
                agent_id: "default".into(),
                workspace_id: "default".into(),
                limit: 10
            })
            .unwrap()["items"]
            .as_array()
            .unwrap()
            .len(),
        0
    );
}

#[test]
fn source_tombstones_are_workspace_scoped_and_legacy_rows_backfill() {
    let d = tempdir().unwrap();
    let p = d.path().join("legacy-tombstones.sqlite");
    let connection = Connection::open(&p).unwrap();
    connection.execute_batch(
        "CREATE TABLE source_tombstones (agent_id TEXT NOT NULL, source_id TEXT NOT NULL, generation INTEGER NOT NULL, deleted_at TEXT NOT NULL, PRIMARY KEY(agent_id,source_id));
         INSERT INTO source_tombstones VALUES ('agent-a','same-source',3,'2026-01-01');",
    ).unwrap();
    drop(connection);
    let owner = Core::open(&p, 4).unwrap();
    let connection = Connection::open(&p).unwrap();
    let columns: Vec<String> = connection
        .prepare("PRAGMA table_info(source_tombstones)")
        .unwrap()
        .query_map([], |row| row.get(1))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(
        columns,
        vec![
            "agent_id",
            "workspace_id",
            "source_id",
            "generation",
            "deleted_at"
        ]
    );
    assert_eq!(
        connection
            .query_row(
                "SELECT workspace_id FROM source_tombstones WHERE agent_id='agent-a'",
                [],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
        "default"
    );
    connection.execute("INSERT INTO source_tombstones(agent_id,workspace_id,source_id,generation,deleted_at) VALUES('agent-a','other','same-source',4,'2026-01-02')", []).unwrap();
    assert_eq!(connection.query_row("SELECT count(*) FROM source_tombstones WHERE agent_id='agent-a' AND source_id='same-source'", [], |row| row.get::<_, i64>(0)).unwrap(), 2);
    owner.initialize().unwrap();
}
#[test]
fn paginated_lists_are_bounded_scoped_and_complete() {
    let d = tempdir().unwrap();
    let owner = WorkspaceOwner::open(&d.path().join("page.sqlite"), 8).unwrap();
    for i in 0..3 {
        owner
            .submit(Operation::Remember {
                agent_id: "a".into(),
                content: format!("m{i}"),
                metadata: serde_json::json!({}),
            })
            .unwrap();
    }
    owner
        .submit(Operation::Remember {
            agent_id: "b".into(),
            content: "other".into(),
            metadata: serde_json::json!({}),
        })
        .unwrap();
    let first = owner
        .submit(Operation::List {
            agent_id: "a".into(),
            include_deleted: false,
            limit: Some(2),
            cursor: None,
        })
        .unwrap();
    assert_eq!(first["items"].as_array().unwrap().len(), 2);
    assert_eq!(first["complete"], false);
    let second = owner
        .submit(Operation::List {
            agent_id: "a".into(),
            include_deleted: false,
            limit: Some(2),
            cursor: Some(first["nextCursor"].as_str().unwrap().into()),
        })
        .unwrap();
    assert_eq!(second["items"].as_array().unwrap().len(), 1);
    assert_eq!(second["complete"], true);
    assert!(matches!(
        owner.submit(Operation::List {
            agent_id: "a".into(),
            include_deleted: false,
            limit: Some(101),
            cursor: None
        }),
        Err(CoreError::InvalidInput(_))
    ));
}

#[test]
fn workspace_submit_operations_run_on_owner_without_requeue_deadlock() {
    let d = tempdir().unwrap();
    let owner = WorkspaceOwner::open(&d.path().join("owner.sqlite"), 2).unwrap();
    assert_eq!(owner.submit(Operation::Health).unwrap()["ready"], true);
    let created = owner
        .submit(Operation::Remember {
            agent_id: "agent".into(),
            content: "inline".into(),
            metadata: serde_json::json!({}),
        })
        .unwrap();
    assert!(created["id"].as_str().is_some());
    let listed = owner
        .submit(Operation::List {
            agent_id: "agent".into(),
            include_deleted: false,
            limit: None,
            cursor: None,
        })
        .unwrap();
    assert_eq!(listed["items"].as_array().unwrap().len(), 1);
}

#[test]
fn workspace_submit_supports_all_durable_operation_variants() {
    let d = tempdir().unwrap();
    let owner = WorkspaceOwner::open(&d.path().join("all-operations.sqlite"), 8).unwrap();
    let source = owner
        .submit(Operation::CreateSource {
            agent_id: "agent".into(),
            workspace_id: "workspace".into(),
            kind: "notes".into(),
            name: "fixture".into(),
            config: serde_json::json!({"root": "/workspace"}),
        })
        .unwrap();
    let source_id = source["id"].as_str().unwrap().to_owned();
    assert_eq!(
        owner
            .submit(Operation::ListSources {
                agent_id: "agent".into(),
                workspace_id: "workspace".into(),
            })
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let document = owner
        .submit(Operation::IngestDocument {
            agent_id: "agent".into(),
            workspace_id: "workspace".into(),
            source_id,
            path: "note.md".into(),
            content: "document body".into(),
            metadata: serde_json::json!({}),
        })
        .unwrap();
    assert!(document["id"].as_str().is_some());
    let memory = owner
        .submit(Operation::Remember {
            agent_id: "agent".into(),
            content: "operation body".into(),
            metadata: serde_json::json!({"kind": "test"}),
        })
        .unwrap();
    let id = memory["id"].as_str().unwrap().to_owned();
    assert!(owner
        .submit(Operation::Get {
            agent_id: "agent".into(),
            id: id.clone()
        })
        .unwrap()["content"]
        .is_string());
    assert_eq!(
        owner
            .submit(Operation::Recall {
                agent_id: "agent".into(),
                query: "operation".into()
            })
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        owner
            .submit(Operation::Update {
                agent_id: "agent".into(),
                id: id.clone(),
                content: "updated body".into(),
                metadata: serde_json::json!({})
            })
            .unwrap()["updated"],
        true
    );
    assert_eq!(
        owner
            .submit(Operation::SoftDelete {
                agent_id: "agent".into(),
                id: id.clone()
            })
            .unwrap()["deleted"],
        true
    );
    assert_eq!(
        owner
            .submit(Operation::History {
                agent_id: "agent".into(),
                id: id.clone()
            })
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
        3
    );
    assert_eq!(
        owner
            .submit(Operation::Recover {
                agent_id: "agent".into(),
                id
            })
            .unwrap()["recovered"],
        true
    );
}
