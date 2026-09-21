use rusqlite::Connection;
use signet_core_native::{
    Core, CoreError, DocumentInput, NewMemory, Operation, UpdateMemory, WorkspaceOwner,
};
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
fn integrity_checkpoint_is_scoped_durable_and_excludes_fts() {
    let c = core();
    let first = c
        .submit(Operation::IntegrityVerify {
            agent_id: "agent-a".into(),
            workspace_id: "workspace-a".into(),
            project_id: Some("project-a".into()),
            visibility: "private".into(),
            budget: 2,
        })
        .unwrap();
    assert_eq!(first["status"], "verified");
    assert_eq!(first["checkpoint"]["nextTable"], "jobs");
    assert_eq!(first["fts"], "skipped");
    assert_eq!(first["integrityCheck"], "ok");
    assert_eq!(first["checkedTables"].as_array().unwrap().len(), 2);
    let second = c
        .submit(Operation::IntegrityVerify {
            agent_id: "agent-a".into(),
            workspace_id: "workspace-a".into(),
            project_id: Some("project-a".into()),
            visibility: "private".into(),
            budget: 2,
        })
        .unwrap();
    assert_eq!(second["checkpoint"]["completed"], true);
}
#[test]
fn memory_provenance_is_persisted_and_consistent_across_reads_and_updates() {
    let c = core();
    let manual_id = c.submit(Operation::Remember {
        agent_id: "agent-a".into(),
        content: "manual fact".into(),
        metadata: serde_json::json!({"sourceId":"src-1","sourceType":"manual","sourcePath":"notes.md","runtimePath":"plugin","idempotencyKey":"idem-1"}),
    }).unwrap()["id"].as_str().unwrap().to_owned();
    let derived_types = [
        "extract",
        "aggregate-recall",
        "session_end",
        "checkpoint",
        "dreaming",
    ];
    let mut ids = vec![manual_id.clone()];
    for source_type in derived_types {
        ids.push(
            c.submit(Operation::Remember {
                agent_id: "agent-a".into(),
                content: format!("{source_type} fact"),
                metadata: serde_json::json!({"sourceType":source_type}),
            })
            .unwrap()["id"]
                .as_str()
                .unwrap()
                .to_owned(),
        );
    }
    ids.push(
        c.submit(Operation::Remember {
            agent_id: "agent-a".into(),
            content: "unknown fact".into(),
            metadata: serde_json::json!({"sourceType":"unknown"}),
        })
        .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned(),
    );
    for id in &ids {
        let got = c
            .submit(Operation::Get {
                agent_id: "agent-a".into(),
                id: id.clone(),
            })
            .unwrap();
        let listed = c
            .submit(Operation::List {
                agent_id: "agent-a".into(),
                include_deleted: false,
                limit: None,
                cursor: None,
            })
            .unwrap()["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["id"] == *id)
            .cloned()
            .unwrap();
        let recalled = c
            .submit(Operation::Recall {
                agent_id: "agent-a".into(),
                query: got["content"].as_str().unwrap().into(),
            })
            .unwrap()
            .as_array()
            .unwrap()[0]
            .clone();
        assert_eq!(
            (
                got.get("sourceId"),
                got.get("sourceType"),
                got.get("sourcePath"),
                got.get("runtimePath"),
                got.get("idempotencyKey"),
                got.get("memoryKind")
            ),
            (
                listed.get("sourceId"),
                listed.get("sourceType"),
                listed.get("sourcePath"),
                listed.get("runtimePath"),
                listed.get("idempotencyKey"),
                listed.get("memoryKind")
            )
        );
        assert_eq!(recalled.get("memoryKind"), got.get("memoryKind"));
    }
    assert_eq!(
        c.submit(Operation::Get {
            agent_id: "agent-a".into(),
            id: manual_id.clone()
        })
        .unwrap()["memoryKind"],
        "episodic"
    );
    c.submit(Operation::Update {
        agent_id: "agent-a".into(),
        id: manual_id.clone(),
        content: "updated".into(),
        metadata: serde_json::json!({"sourceType":"extract"}),
    })
    .unwrap();
    let updated = c
        .submit(Operation::Get {
            agent_id: "agent-a".into(),
            id: manual_id,
        })
        .unwrap();
    assert!(updated["memoryKind"].is_null());
    assert_eq!(updated["sourceType"], "extract");
}

#[test]
fn legacy_memory_rows_migrate_without_data_loss() {
    let d = tempdir().unwrap();
    let p = d.path().join("legacy-memory.sqlite");
    let db = Connection::open(&p).unwrap();
    db.execute_batch("CREATE TABLE memories (id TEXT PRIMARY KEY, content TEXT NOT NULL, agent_id TEXT, is_deleted INTEGER DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL); INSERT INTO memories VALUES ('old','preserve','a',0,'t','t');").unwrap();
    drop(db);
    let c = Core::open(&p, 2).unwrap();
    let got = c.get("a", "old").unwrap().unwrap();
    assert_eq!(got.content, "preserve");
    let new_id = c
        .submit(Operation::Remember {
            agent_id: "a".into(),
            content: "migrated remember".into(),
            metadata: serde_json::json!({
                "sourceId": "legacy-source",
                "sourceType": "manual",
                "sourcePath": "legacy.md",
                "runtimePath": "runtime",
                "idempotencyKey": "legacy-idem"
            }),
        })
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let remembered = c
        .submit(Operation::Get {
            agent_id: "a".into(),
            id: new_id.clone(),
        })
        .unwrap();
    assert_eq!(remembered["memoryKind"], "episodic");
    assert!(c
        .submit(Operation::Get {
            agent_id: "other-agent".into(),
            id: new_id.clone(),
        })
        .unwrap()
        .is_null());
    let db = Connection::open(&p).unwrap();
    let raw: (Option<String>, Option<String>, Option<String>, Option<String>, Option<String>, Option<String>) = db
        .query_row(
            "SELECT source_id, source_type, source_path, runtime_path, idempotency_key, memory_kind FROM memories WHERE id=?",
            [&new_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
        )
        .unwrap();
    assert_eq!(
        raw,
        (
            Some("legacy-source".into()),
            Some("manual".into()),
            Some("legacy.md".into()),
            Some("runtime".into()),
            Some("legacy-idem".into()),
            Some("episodic".into())
        )
    );
    let cols: Vec<String> = db
        .prepare("PRAGMA table_info(memories)")
        .unwrap()
        .query_map([], |r| r.get(1))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert!(cols.iter().any(|c| c == "source_id"));
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
fn repair_requeue_does_not_event_preexisting_queued_job() {
    let c = core();
    let submit = |kind: &str| {
        c.submit(Operation::JobSubmit {
            agent_id: "agent".into(),
            workspace_id: "workspace".into(),
            kind: kind.into(),
            payload: serde_json::json!({}),
            deadline_at: None,
        })
        .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned()
    };
    let running_id = submit("dreaming");
    let claimed_id = c.worker_claim().unwrap().unwrap().id;
    assert_eq!(claimed_id, running_id);
    let queued_id = submit("dreaming");

    let repaired = c
        .submit(Operation::RepairRequeueRunning {
            agent_id: "agent".into(),
            workspace_id: "workspace".into(),
        })
        .unwrap();
    assert_eq!(repaired["requeued"], 1);

    let events = c
        .submit(Operation::JobEvents {
            agent_id: "agent".into(),
            workspace_id: "workspace".into(),
            id: queued_id,
            cursor: 0,
            limit: 100,
        })
        .unwrap();
    assert_eq!(events.as_array().unwrap().len(), 1);
    assert_eq!(events[0]["event"], "queued");
}

#[test]
fn knowledge_detail_aspects_and_attributes_are_scoped_and_bounded() {
    let c = core();
    let id = c
        .submit(Operation::KnowledgeEntityCreate {
            agent_id: "a".into(),
            workspace_id: "w".into(),
            name: "Thing".into(),
            entity_type: "project".into(),
            metadata: serde_json::json!({}),
        })
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let aspect = c
        .submit(Operation::KnowledgeAspectCreate {
            agent_id: "a".into(),
            workspace_id: "w".into(),
            entity_id: id.clone(),
            name: "Facts".into(),
            weight: 0.8,
        })
        .unwrap();
    let aid = aspect["id"].as_str().unwrap().to_owned();
    c.submit(Operation::KnowledgeAttributeCreate {
        agent_id: "a".into(),
        workspace_id: "w".into(),
        aspect_id: aid.clone(),
        kind: "attribute".into(),
        content: "blue".into(),
        claim_key: None,
        group_key: None,
        confidence: 0.9,
        importance: 0.7,
        memory_id: None,
    })
    .unwrap();
    assert_eq!(
        c.submit(Operation::KnowledgeEntityDetail {
            agent_id: "a".into(),
            workspace_id: "w".into(),
            entity_id: id.clone()
        })
        .unwrap()["name"],
        "Thing"
    );
    assert_eq!(
        c.submit(Operation::KnowledgeAspects {
            agent_id: "a".into(),
            workspace_id: "w".into(),
            entity_id: id.clone()
        })
        .unwrap()["items"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        c.submit(Operation::KnowledgeAttributes {
            agent_id: "a".into(),
            workspace_id: "w".into(),
            entity_id: id,
            aspect_id: aid,
            limit: 999,
            offset: 0,
            kind: None,
            status: None
        })
        .unwrap()["items"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert!(matches!(
        c.submit(Operation::KnowledgeEntityDetail {
            agent_id: "other".into(),
            workspace_id: "w".into(),
            entity_id: "nope".into()
        }),
        Err(CoreError::NotFound)
    ));
}

#[test]
fn knowledge_lists_exclude_deleted_parent_entity_and_aspect() {
    let c = core();
    let entity = c
        .submit(Operation::KnowledgeEntityCreate {
            agent_id: "a".into(),
            workspace_id: "w".into(),
            name: "Thing".into(),
            entity_type: "project".into(),
            metadata: serde_json::json!({}),
        })
        .unwrap();
    let entity_id = entity["id"].as_str().unwrap().to_owned();
    let aspect = c
        .submit(Operation::KnowledgeAspectCreate {
            agent_id: "a".into(),
            workspace_id: "w".into(),
            entity_id: entity_id.clone(),
            name: "Facts".into(),
            weight: 1.0,
        })
        .unwrap();
    let aspect_id = aspect["id"].as_str().unwrap().to_owned();
    c.submit(Operation::KnowledgeAttributeCreate {
        agent_id: "a".into(),
        workspace_id: "w".into(),
        aspect_id: aspect_id.clone(),
        kind: "attribute".into(),
        content: "blue".into(),
        claim_key: None,
        group_key: None,
        confidence: 1.0,
        importance: 1.0,
        memory_id: None,
    })
    .unwrap();
    assert_eq!(
        c.submit(Operation::KnowledgeAspects {
            agent_id: "a".into(),
            workspace_id: "w".into(),
            entity_id: entity_id.clone()
        })
        .unwrap()["items"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        c.submit(Operation::KnowledgeAttributes {
            agent_id: "a".into(),
            workspace_id: "w".into(),
            entity_id,
            aspect_id,
            limit: 10,
            offset: 0,
            kind: None,
            status: None
        })
        .unwrap()["items"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn dreaming_jobs_queue_and_cancel() {
    let c = core();
    let job = c
        .submit(Operation::JobSubmit {
            agent_id: "a".into(),
            workspace_id: "w".into(),
            kind: "dreaming".into(),
            payload: serde_json::json!({"batch": 1}),
            deadline_at: None,
        })
        .unwrap();
    assert_eq!(job["state"], "queued");
    let cancelled = c
        .submit(Operation::JobCancel {
            agent_id: "a".into(),
            workspace_id: "w".into(),
            id: job["id"].as_str().unwrap().into(),
            actor: "api".into(),
            reason: "requested".into(),
        })
        .unwrap();
    assert_eq!(cancelled["state"], "cancelled");
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
fn migrates_legacy_telemetry_before_scoped_index_and_preserves_rows() {
    let d = tempdir().unwrap();
    let p = d.path().join("legacy-telemetry.sqlite");
    let connection = Connection::open(&p).unwrap();
    connection
        .execute_batch(
            "CREATE TABLE telemetry_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                event TEXT NOT NULL,
                queue TEXT,
                timestamp TEXT NOT NULL,
                unsent INTEGER NOT NULL DEFAULT 1
            );
            INSERT INTO telemetry_events(event, queue, timestamp, unsent)
            VALUES ('legacy.event', 'legacy-queue', '2026-01-01T00:00:00Z', 1);",
        )
        .unwrap();
    drop(connection);

    let owner = Core::open(&p, 4).unwrap();
    let connection = Connection::open(&p).unwrap();
    let row = connection
        .query_row(
            "SELECT event, payload, created_at, agent_id, workspace_id FROM telemetry_events WHERE id=1",
            [],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                ))
            },
        )
        .unwrap();
    assert_eq!(
        row,
        (
            "legacy.event".into(),
            "{}".into(),
            "2026-01-01T00:00:00Z".into(),
            "default".into(),
            "default".into()
        )
    );
    assert_eq!(
        connection
            .query_row(
                "SELECT name FROM sqlite_schema WHERE type='index' AND name='telemetry_events_scope'",
                [],
                |row| row.get::<_, String>(0),
            )
            .unwrap(),
        "telemetry_events_scope"
    );
    drop(connection);
    owner.initialize().unwrap();
}

#[test]
fn migrates_legacy_api_keys_before_scoped_index_and_preserves_rows() {
    let d = tempdir().unwrap();
    let p = d.path().join("legacy-api-keys.sqlite");
    let connection = Connection::open(&p).unwrap();
    connection.execute_batch(
        "CREATE TABLE api_keys (id TEXT PRIMARY KEY, prefix TEXT NOT NULL UNIQUE, name TEXT NOT NULL, key_hash TEXT NOT NULL, role TEXT NOT NULL, scope_json TEXT NOT NULL, created_at TEXT NOT NULL);
         INSERT INTO api_keys(id,prefix,name,key_hash,role,scope_json,created_at) VALUES ('k1','p1','legacy','hash','agent','{}','2026-01-01');",
    ).unwrap();
    drop(connection);

    let owner = Core::open(&p, 4).unwrap();
    let connection = Connection::open(&p).unwrap();
    assert_eq!(
        connection
            .query_row(
                "SELECT name, agent_id, revoked_at, expires_at FROM api_keys WHERE id='k1'",
                [],
                |row| Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?
                ))
            )
            .unwrap(),
        ("legacy".to_string(), None, None, None)
    );
    assert_eq!(
        connection
            .query_row(
                "SELECT name FROM sqlite_schema WHERE type='index' AND name='api_keys_scope'",
                [],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
        "api_keys_scope"
    );
    drop(connection);
    owner.initialize().unwrap();
}

#[test]
fn migrates_legacy_secrets_before_scoped_index_and_preserves_rows() {
    let d = tempdir().unwrap();
    let p = d.path().join("legacy-secrets.sqlite");
    let connection = Connection::open(&p).unwrap();
    connection.execute_batch(
        "CREATE TABLE secrets (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, workspace_id TEXT NOT NULL, name TEXT NOT NULL, provider TEXT NOT NULL, value TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
         INSERT INTO secrets(id,agent_id,workspace_id,name,provider,value,created_at,updated_at) VALUES ('s1','a','w','legacy','local','value','2026-01-01','2026-01-01');",
    ).unwrap();
    drop(connection);

    let owner = Core::open(&p, 4).unwrap();
    let connection = Connection::open(&p).unwrap();
    assert_eq!(
        connection
            .query_row(
                "SELECT name, deleted FROM secrets WHERE id='s1'",
                [],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            )
            .unwrap(),
        ("legacy".to_string(), 0)
    );
    assert_eq!(
        connection
            .query_row(
                "SELECT name FROM sqlite_schema WHERE type='index' AND name='secrets_scope'",
                [],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
        "secrets_scope"
    );
    drop(connection);
    owner.initialize().unwrap();
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
            source_id: None,
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
fn migrates_legacy_documents_before_source_path_index() {
    let d = tempdir().unwrap();
    let p = d.path().join("legacy-documents-index.sqlite");
    let connection = Connection::open(&p).unwrap();
    connection
        .execute_batch(
            "CREATE TABLE documents (
                id TEXT PRIMARY KEY,
                source_id TEXT NOT NULL,
                content TEXT NOT NULL,
                metadata TEXT,
                created_at TEXT
            );
            INSERT INTO documents(id,source_id,content,metadata,created_at)
            VALUES ('legacy-doc','legacy-source','legacy body','{}','2026-01-01');",
        )
        .unwrap();
    drop(connection);

    let _owner = Core::open(&p, 4).unwrap();
    let connection = Connection::open(&p).unwrap();
    assert_eq!(
        connection
            .query_row(
                "SELECT agent_id, workspace_id, path, content FROM documents WHERE id='legacy-doc'",
                [],
                |row| Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            )
            .unwrap(),
        (
            "default".into(),
            "default".into(),
            "".into(),
            "legacy body".into()
        )
    );
    assert_eq!(
        connection
            .query_row(
                "SELECT name FROM sqlite_schema WHERE type='index' AND name='documents_source_path'",
                [],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
        "documents_source_path"
    );
}

#[test]
fn collapses_legacy_source_identity_collisions_without_losing_meaningful_config() {
    let d = tempdir().unwrap();
    let p = d.path().join("legacy-source-collision.sqlite");
    let connection = Connection::open(&p).unwrap();
    connection
        .execute_batch(
            "CREATE TABLE sources (id TEXT NOT NULL, agent_id TEXT, workspace_id TEXT, kind TEXT NOT NULL, name TEXT, config TEXT, metadata TEXT, generation INTEGER, created_at TEXT, PRIMARY KEY (id, agent_id, workspace_id));
             INSERT INTO sources VALUES ('same', NULL, NULL, 'folder', 'older', '', '{\"path\":\"/meaningful\"}', 3, '2026-01-01');
             INSERT INTO sources VALUES ('same', '', '', 'folder', 'winner', '   ', NULL, 4, '2026-01-02');",
        )
        .unwrap();
    drop(connection);

    let owner = Core::open(&p, 4).unwrap();
    let sources = owner
        .submit(Operation::ListSources {
            agent_id: "default".into(),
            workspace_id: "default".into(),
        })
        .unwrap();
    let sources = sources.as_array().unwrap();
    assert_eq!(sources.len(), 1);
    assert_eq!(sources[0]["name"], "winner");
    let connection = Connection::open(&p).unwrap();
    assert_eq!(
        connection
            .query_row(
                "SELECT generation FROM sources WHERE agent_id='default' AND workspace_id='default' AND id='same'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
        4
    );
    assert_eq!(sources[0]["config"]["path"], "/meaningful");
    owner.initialize().unwrap();
}

#[test]
fn preserves_legacy_source_metadata_configuration_when_config_is_blank_or_null() {
    let d = tempdir().unwrap();
    let p = d.path().join("legacy-source-metadata.sqlite");
    let connection = Connection::open(&p).unwrap();
    connection
        .execute_batch(
            "CREATE TABLE sources (id TEXT PRIMARY KEY, agent_id TEXT, kind TEXT NOT NULL, name TEXT, config TEXT, metadata TEXT, generation INTEGER, created_at TEXT);
             INSERT INTO sources VALUES ('blank-config', 'agent-a', 'folder', 'blank', '   ', '{\"path\":\"/blank\"}', 7, '2026-01-01');
             INSERT INTO sources VALUES ('null-config', 'agent-a', 'folder', 'null', NULL, '{\"path\":\"/null\"}', 8, '2026-01-02');",
        )
        .unwrap();
    drop(connection);

    let owner = Core::open(&p, 4).unwrap();
    let sources = owner
        .submit(Operation::ListSources {
            agent_id: "agent-a".into(),
            workspace_id: "default".into(),
        })
        .unwrap();
    let sources = sources.as_array().unwrap();
    assert_eq!(sources.len(), 2);
    for source in sources {
        let expected_path = format!("/{}", source["name"].as_str().unwrap());
        assert_eq!(source["config"]["path"], expected_path);
    }
}

#[test]
fn repairs_incomplete_version_two_document_backfill() {
    let d = tempdir().unwrap();
    let p = d.path().join("incomplete-v2.sqlite");
    let connection = Connection::open(&p).unwrap();
    connection.execute_batch("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT, checksum TEXT); INSERT INTO schema_migrations VALUES (2, '2026-01-01', 'wrong-checksum'); CREATE TABLE documents (id TEXT PRIMARY KEY, agent_id TEXT, source_id TEXT NOT NULL, path TEXT NOT NULL, content TEXT NOT NULL, metadata TEXT, created_at TEXT); INSERT INTO documents VALUES ('legacy-doc', 'agent', 'source', 'legacy.md', 'body', '{}', '2026-01-01');").unwrap();
    drop(connection);
    let _owner = Core::open(&p, 4).unwrap();
    let connection = Connection::open(&p).unwrap();
    assert_eq!(
        connection
            .query_row(
                "SELECT workspace_id FROM documents WHERE id='legacy-doc'",
                [],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
        "default"
    );
    assert_eq!(
        connection
            .query_row(
                "SELECT checksum FROM schema_migrations WHERE version=2",
                [],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
        "document-workspace-backfill-v1"
    );
}

#[test]
fn direct_ingest_document_handles_metadata_and_missing_source() {
    let owner = core();
    let source = owner
        .create_source(
            "agent",
            "default",
            "folder",
            "fixture",
            serde_json::json!({}),
        )
        .unwrap();
    let id = owner
        .ingest_document(
            "agent",
            DocumentInput {
                source_id: source.id.clone(),
                path: "note.md".into(),
                content: "document body".into(),
                metadata: serde_json::Value::Null,
            },
        )
        .unwrap();
    let document = owner
        .submit(Operation::DocumentGet {
            agent_id: "agent".into(),
            workspace_id: "default".into(),
            id,
        })
        .unwrap();
    assert_eq!(document["metadata"]["_workspaceId"], "default");
    assert_eq!(document["generation"], 0);
    assert!(document["contentHash"]
        .as_str()
        .is_some_and(|hash| hash.len() == 64));
    assert!(document["createdAt"].as_str().is_some());
    assert!(document["updatedAt"].as_str().is_some());
    let custom_source = owner
        .create_source(
            "agent",
            "custom",
            "folder",
            "custom-fixture",
            serde_json::json!({}),
        )
        .unwrap();
    let explicit_id = owner
        .ingest_document(
            "agent",
            DocumentInput {
                source_id: custom_source.id,
                path: "custom.md".into(),
                content: "custom body".into(),
                metadata: serde_json::json!({"_workspaceId": "custom"}),
            },
        )
        .unwrap();
    let explicit = owner
        .submit(Operation::DocumentGet {
            agent_id: "agent".into(),
            workspace_id: "custom".into(),
            id: explicit_id,
        })
        .unwrap();
    assert_eq!(explicit["metadata"]["_workspaceId"], "custom");
    assert!(owner
        .ingest_document(
            "agent",
            DocumentInput {
                source_id: "missing".into(),
                path: "bad.md".into(),
                content: "body".into(),
                metadata: serde_json::json!({})
            }
        )
        .is_err());
    assert!(owner
        .ingest_document(
            "agent",
            DocumentInput {
                source_id: source.id,
                path: "bad.md".into(),
                content: "body".into(),
                metadata: serde_json::json!([])
            }
        )
        .is_err());
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
fn explicit_source_ids_are_scoped_by_agent_and_workspace() {
    let owner = core();
    for (agent, workspace) in [
        ("agent-a", "workspace-a"),
        ("agent-a", "workspace-b"),
        ("agent-b", "workspace-a"),
    ] {
        owner
            .submit(Operation::CreateSource {
                agent_id: agent.into(),
                workspace_id: workspace.into(),
                kind: "notes".into(),
                name: "same".into(),
                source_id: Some("shared-id".into()),
                config: serde_json::json!({}),
            })
            .unwrap();
    }
    let duplicate = owner.submit(Operation::CreateSource {
        agent_id: "agent-a".into(),
        workspace_id: "workspace-a".into(),
        kind: "notes".into(),
        name: "duplicate".into(),
        source_id: Some("shared-id".into()),
        config: serde_json::json!({}),
    });
    assert!(
        matches!(duplicate, Err(CoreError::InvalidInput(message)) if message == "source id already exists")
    );
}

#[test]
fn explicit_source_reuse_fences_stale_generation() {
    let owner = core();
    let create = |owner: &Core| {
        owner
            .submit(Operation::CreateSource {
                agent_id: "agent".into(),
                workspace_id: "workspace".into(),
                kind: "notes".into(),
                name: "reused".into(),
                source_id: Some("stable-id".into()),
                config: serde_json::json!({}),
            })
            .unwrap()
    };
    create(&owner);
    owner
        .submit(Operation::DeleteSourceWithGeneration {
            agent_id: "agent".into(),
            workspace_id: "workspace".into(),
            source_id: "stable-id".into(),
            generation: Some(0),
        })
        .unwrap();
    let recreated = create(&owner);
    assert_eq!(recreated["id"], "stable-id");
    let stale = owner.submit(Operation::IngestDocument {
        agent_id: "agent".into(),
        workspace_id: "workspace".into(),
        source_id: "stable-id".into(),
        path: "stale".into(),
        content: "body".into(),
        metadata: serde_json::json!({"_generation": 0}),
    });
    assert!(matches!(stale, Err(CoreError::NotFound)));
    let current = owner.submit(Operation::IngestDocument {
        agent_id: "agent".into(),
        workspace_id: "workspace".into(),
        source_id: "stable-id".into(),
        path: "current".into(),
        content: "body".into(),
        metadata: serde_json::json!({"_generation": 1}),
    });
    assert!(current.is_ok());
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
            source_id: None,
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

#[test]
fn legacy_knowledge_dependency_schema_is_reconciled_idempotently() {
    let d = tempdir().unwrap();
    let path = d.path().join("legacy.sqlite");
    {
        let connection = Connection::open(&path).unwrap();
        connection.execute_batch(
            "CREATE TABLE entities (id TEXT PRIMARY KEY, name TEXT NOT NULL);
             CREATE TABLE entity_dependencies (
               id TEXT PRIMARY KEY, source_entity_id TEXT NOT NULL,
               target_entity_id TEXT NOT NULL, dependency_type TEXT NOT NULL,
               strength REAL NOT NULL, updated_at TEXT
             );
             INSERT INTO entities(id,name) VALUES ('source','Source'),('target','Target');
             INSERT INTO entity_dependencies(id,source_entity_id,target_entity_id,dependency_type,strength,updated_at)
               VALUES ('dep-1','source','target','blocks',0.75,NULL);",
        ).unwrap();
    }
    let core = Core::open(&path, 2).unwrap();
    let dependencies = || {
        core.submit(Operation::KnowledgeDependencies {
            agent_id: "default".into(),
            workspace_id: "default".into(),
            entity_id: "source".into(),
            limit: 10,
            direction: "outgoing".into(),
        })
        .unwrap()
    };
    let result = dependencies();
    assert_eq!(result["items"].as_array().unwrap().len(), 1);
    assert_eq!(result["items"][0]["id"], "dep-1");
    assert_eq!(result["items"][0]["status"], "active");
    assert_eq!(result["items"][0]["aspectId"], serde_json::Value::Null);
    assert_eq!(result["items"][0]["reason"], serde_json::Value::Null);
    assert_eq!(result["items"][0]["updatedAt"], "1970-01-01T00:00:00Z");
    let connection = Connection::open(&path).unwrap();
    for table in ["entities", "entity_dependencies"] {
        let mut statement = connection
            .prepare(&format!("PRAGMA table_info({table})"))
            .unwrap();
        let columns: Vec<String> = statement
            .query_map([], |row| row.get(1))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        for required in ["agent_id", "workspace_id"] {
            assert!(columns.iter().any(|c| c == required));
        }
    }
    assert_eq!(
        connection
            .query_row("SELECT count(*) FROM entities", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        2
    );
    assert_eq!(
        connection
            .query_row("SELECT count(*) FROM entity_dependencies", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(
        connection
            .query_row(
                "SELECT agent_id || ':' || workspace_id FROM entity_dependencies WHERE id='dep-1'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
        "default:default"
    );
    assert_eq!(
        connection
            .query_row(
                "SELECT updated_at FROM entity_dependencies WHERE id='dep-1'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
        "1970-01-01T00:00:00Z"
    );
    assert_eq!(
        connection
            .query_row("SELECT count(*) FROM entity_dependencies WHERE updated_at IS NULL OR trim(updated_at)=''", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        0
    );
    core.initialize().unwrap();
    assert_eq!(dependencies()["items"].as_array().unwrap().len(), 1);
}

#[test]
fn source_removal_lease_fences_stale_finalizer_and_blocks_ingest() {
    let owner = core();
    owner
        .submit(Operation::CreateSource {
            agent_id: "agent".into(),
            workspace_id: "workspace".into(),
            kind: "notes".into(),
            name: "leased".into(),
            config: serde_json::json!({}),
            source_id: Some("leased-source".into()),
        })
        .unwrap();
    let lease = owner
        .submit(Operation::AcquireSourceRemovalLease {
            agent_id: "agent".into(),
            workspace_id: "workspace".into(),
            source_id: "leased-source".into(),
            generation: Some(0),
        })
        .unwrap();
    assert_eq!(lease["status"], "pending");
    assert!(
        matches!(owner.submit(Operation::IngestDocument { agent_id:"agent".into(), workspace_id:"workspace".into(), source_id:"leased-source".into(), path:"blocked".into(), content:"body".into(), metadata:serde_json::json!({}) }), Err(CoreError::InvalidInput(message)) if message.contains("removal pending"))
    );
    owner
        .submit(Operation::FinalizeSourceRemoval {
            agent_id: "agent".into(),
            workspace_id: "workspace".into(),
            source_id: "leased-source".into(),
            generation: 0,
            lease_token: "stale".into(),
        })
        .unwrap_err();
    let token = lease["leaseToken"].as_str().unwrap().to_string();
    let done = owner
        .submit(Operation::FinalizeSourceRemoval {
            agent_id: "agent".into(),
            workspace_id: "workspace".into(),
            source_id: "leased-source".into(),
            generation: 0,
            lease_token: token,
        })
        .unwrap();
    assert_eq!(done["outcome"], "success");
}

#[test]
fn legacy_markdown_import_rejects_unbounded_files_and_invalid_calendar_dates() {
    let owner = core();
    let too_many = serde_json::Value::Array(
        (0..26)
            .map(|i| serde_json::json!({"name": format!("2026-01-{i:02}.md"), "content":"x"}))
            .collect(),
    );
    assert!(
        matches!(owner.submit(Operation::LegacyMarkdownImport { agent_id:"a".into(), workspace_id:"w".into(), files:too_many }), Err(CoreError::InvalidInput(message)) if message.contains("1-25"))
    );
    let invalid = serde_json::json!([{"name":"2026-02-31.md","content":"x"},{"name":"0000-00-00.md","content":"x"}]);
    let result = owner
        .submit(Operation::LegacyMarkdownImport {
            agent_id: "a".into(),
            workspace_id: "w".into(),
            files: invalid,
        })
        .unwrap();
    assert_eq!(result["imported"], 0);
    assert_eq!(result["skipped"], 2);
}

#[test]
fn legacy_markdown_import_chunks_single_paragraphs_and_fences_workspace_deduplication() {
    let owner = core();
    let content = "x".repeat(3000);
    let first = owner
        .submit(Operation::LegacyMarkdownImport {
            agent_id: "a".into(),
            workspace_id: "one".into(),
            files: serde_json::json!([{"name":"2026-01-01.md","content":content}]),
        })
        .unwrap();
    assert!(first["imported"].as_u64().unwrap() > 1);
    let second = owner
        .submit(Operation::LegacyMarkdownImport {
            agent_id: "a".into(),
            workspace_id: "two".into(),
            files: serde_json::json!([{"name":"2026-01-01.md","content":content}]),
        })
        .unwrap();
    assert_eq!(second["imported"], first["imported"]);
}

#[test]
fn legacy_markdown_import_is_scoped_deduplicated_and_reports_counts() {
    let owner = core();
    let files = serde_json::json!([
        {"name":"2026-01-02.md", "content":"first note\n\nsecond note"},
        {"name":"TEMPLATE.md", "content":"ignored"},
        {"name":"not-a-date.md", "content":"invalid"},
        {"name":"2026-01-03.md", "content":"   "}
    ]);
    let request = || {
        owner
            .submit(Operation::LegacyMarkdownImport {
                agent_id: "agent-a".into(),
                workspace_id: "workspace-a".into(),
                files: files.clone(),
            })
            .unwrap()
    };
    let first = request();
    assert_eq!(first["imported"], 2);
    assert_eq!(first["skipped"], 3);
    assert_eq!(first["errors"].as_array().unwrap().len(), 1);
    assert_eq!(
        owner
            .submit(Operation::List {
                agent_id: "agent-a".into(),
                include_deleted: false,
                limit: None,
                cursor: None
            })
            .unwrap()["items"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    let second = request();
    assert_eq!(second["imported"], 0);
    assert_eq!(second["skipped"], 5);
    assert_eq!(
        owner
            .submit(Operation::List {
                agent_id: "agent-a".into(),
                include_deleted: false,
                limit: None,
                cursor: None
            })
            .unwrap()["items"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        owner
            .submit(Operation::List {
                agent_id: "other-agent".into(),
                include_deleted: false,
                limit: None,
                cursor: None
            })
            .unwrap()["items"]
            .as_array()
            .unwrap()
            .len(),
        0
    );
}

#[test]
fn legacy_markdown_import_rejects_oversized_direct_operation_atomically() {
    let owner = core();
    let oversized = "x".repeat(8 * 1024 * 1024 + 1);
    let result = owner.submit(Operation::LegacyMarkdownImport {
        agent_id: "agent".into(),
        workspace_id: "workspace".into(),
        files: serde_json::json!([
            {"name":"2026-01-01.md","content":"accepted before rejection"},
            {"name":"2026-01-02.md","content":oversized}
        ]),
    });
    assert!(matches!(result, Err(CoreError::InvalidInput(message)) if message.contains("content")));
    assert_eq!(
        owner
            .submit(Operation::List {
                agent_id: "agent".into(),
                include_deleted: false,
                limit: None,
                cursor: None
            })
            .unwrap()["items"]
            .as_array()
            .unwrap()
            .len(),
        0
    );
}

#[test]
fn legacy_markdown_import_deduplicates_exact_content_but_imports_changed_content() {
    let owner = core();
    let import = |content: &str| {
        owner
            .submit(Operation::LegacyMarkdownImport {
                agent_id: "agent".into(),
                workspace_id: "workspace".into(),
                files: serde_json::json!([{"name":"2026-01-01.md","content":content}]),
            })
            .unwrap()
    };
    assert_eq!(import("first")["imported"], 1);
    assert_eq!(import("first")["imported"], 0);
    assert_eq!(import("changed")["imported"], 1);
    let duplicate_batch = owner
        .submit(Operation::LegacyMarkdownImport {
            agent_id: "agent".into(),
            workspace_id: "workspace".into(),
            files: serde_json::json!([
                {"name":"2026-01-02.md","content":"same"},
                {"name":"2026-01-02.md","content":"same"}
            ]),
        })
        .unwrap();
    assert_eq!(duplicate_batch["imported"], 1);
}

#[test]
fn source_removal_lease_blocks_direct_deletes_and_preserves_source_documents() {
    for delete in [false, true] {
        let owner = core();
        owner
            .submit(Operation::CreateSource {
                agent_id: "agent".into(),
                workspace_id: "workspace".into(),
                kind: "notes".into(),
                name: "leased".into(),
                config: serde_json::json!({}),
                source_id: Some("leased-source".into()),
            })
            .unwrap();
        owner
            .submit(Operation::IngestDocument {
                agent_id: "agent".into(),
                workspace_id: "workspace".into(),
                source_id: "leased-source".into(),
                path: "kept".into(),
                content: "body".into(),
                metadata: serde_json::json!({}),
            })
            .unwrap();
        owner
            .submit(Operation::AcquireSourceRemovalLease {
                agent_id: "agent".into(),
                workspace_id: "workspace".into(),
                source_id: "leased-source".into(),
                generation: Some(0),
            })
            .unwrap();

        let result = if delete {
            owner.submit(Operation::DeleteSourceWithGeneration {
                agent_id: "agent".into(),
                workspace_id: "workspace".into(),
                source_id: "leased-source".into(),
                generation: Some(0),
            })
        } else {
            owner.submit(Operation::DeleteSource {
                agent_id: "agent".into(),
                workspace_id: "workspace".into(),
                source_id: "leased-source".into(),
            })
        };
        assert!(
            matches!(result, Err(CoreError::InvalidInput(message)) if message.contains("removal pending"))
        );
        assert_eq!(
            owner
                .submit(Operation::ListSources {
                    agent_id: "agent".into(),
                    workspace_id: "workspace".into()
                })
                .unwrap()
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            owner
                .submit(Operation::DocumentList {
                    agent_id: "agent".into(),
                    workspace_id: "workspace".into(),
                    limit: 10
                })
                .unwrap()["items"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
    }
}

#[test]
fn legacy_entity_attributes_mark_referenced_memory_derived() {
    let d = tempdir().unwrap();
    let p = d.path().join("entity-attributes.sqlite");
    let db = Connection::open(&p).unwrap();
    db.execute_batch("CREATE TABLE memories (id TEXT PRIMARY KEY, content TEXT NOT NULL, agent_id TEXT, is_deleted INTEGER DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL); CREATE TABLE entity_attributes (id TEXT PRIMARY KEY, entity_id TEXT NOT NULL, memory_id TEXT, attribute TEXT NOT NULL); INSERT INTO memories VALUES ('old','preserve','a',0,'t','t'); INSERT INTO entity_attributes VALUES ('attr','entity','old','value');").unwrap();
    drop(db);
    let c = Core::open(&p, 2).unwrap();
    c.initialize().unwrap();
    let db = Connection::open(&p).unwrap();
    let kind: Option<String> = db
        .query_row("SELECT memory_kind FROM memories WHERE id='old'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(kind.as_deref(), Some("derived"));
}

#[test]
fn current_typescript_migration_history_fails_closed() {
    let d = tempdir().unwrap();
    let p = d.path().join("current-ts.sqlite");
    let db = Connection::open(&p).unwrap();
    db.execute_batch("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL, checksum TEXT NOT NULL); INSERT INTO schema_migrations VALUES (153,'now','ts-checksum');").unwrap();
    drop(db);
    let error = match Core::open(&p, 2) {
        Ok(_) => panic!("current TypeScript migration history must fail closed"),
        Err(error) => error,
    };
    assert!(format!("{error:?}").contains("UnsupportedMigrationHistory"));
}

#[test]
fn navigation_entity_resolves_current_schema_and_returns_detail_envelope() {
    let d = tempdir().unwrap();
    let p = d.path().join("navigation.sqlite");
    let db = Connection::open(&p).unwrap();
    db.execute_batch("CREATE TABLE entities (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, workspace_id TEXT NOT NULL, name TEXT NOT NULL, status TEXT); INSERT INTO entities VALUES ('entity-1','agent-a','workspace-a','Signet',NULL);").unwrap();
    drop(db);
    let c = Core::open(&p, 2).unwrap();
    let got = c
        .submit(Operation::KnowledgeNavigationEntity {
            agent_id: "agent-a".into(),
            workspace_id: "workspace-a".into(),
            name: " signet ".into(),
        })
        .unwrap();
    assert_eq!(got["entity"]["id"], "entity-1");
    assert_eq!(got["entity"]["name"], "Signet");
    assert!(got.get("aspectCount").is_some());
}

#[test]
fn owner_knowledge_writes_seed_current_tree() {
    let d = tempdir().unwrap();
    let p = d.path().join("owner-tree.sqlite");
    let db = Connection::open(&p).unwrap();
    db.execute_batch("CREATE TABLE entities (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, workspace_id TEXT NOT NULL, name TEXT NOT NULL, canonical_name TEXT, entity_type TEXT NOT NULL DEFAULT 'person', description TEXT, status TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL); CREATE TABLE entity_aspects (id TEXT PRIMARY KEY, entity_id TEXT NOT NULL, agent_id TEXT NOT NULL, workspace_id TEXT NOT NULL, name TEXT NOT NULL, canonical_name TEXT, weight REAL NOT NULL DEFAULT 0.5, status TEXT DEFAULT 'active', created_at TEXT NOT NULL, updated_at TEXT NOT NULL); CREATE TABLE entity_attributes (id TEXT PRIMARY KEY, aspect_id TEXT NOT NULL, agent_id TEXT NOT NULL, workspace_id TEXT NOT NULL, memory_id TEXT, kind TEXT NOT NULL, content TEXT NOT NULL, normalized_content TEXT, group_key TEXT, claim_key TEXT, confidence REAL DEFAULT 0.5, importance REAL DEFAULT 0.5, status TEXT DEFAULT 'active', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);").unwrap();
    drop(db);
    let c = Core::open(&p, 2).unwrap();
    let entity = c
        .submit(Operation::KnowledgeEntityCreate {
            agent_id: "a1".into(),
            workspace_id: "w1".into(),
            name: "Signet".into(),
            entity_type: "project".into(),
            metadata: serde_json::json!({"description":"owner"}),
        })
        .unwrap();
    let eid = entity["id"].as_str().unwrap().to_owned();
    let aspect = c
        .submit(Operation::KnowledgeAspectCreate {
            agent_id: "a1".into(),
            workspace_id: "w1".into(),
            entity_id: eid.clone(),
            name: "Food".into(),
            weight: 0.8,
        })
        .unwrap();
    let aid = aspect["id"].as_str().unwrap().to_owned();
    c.submit(Operation::KnowledgeAttributeCreate {
        agent_id: "a1".into(),
        workspace_id: "w1".into(),
        aspect_id: aid,
        kind: "attribute".into(),
        content: "Pizza".into(),
        claim_key: Some("favorite".into()),
        group_key: Some("restaurants".into()),
        confidence: 0.9,
        importance: 0.9,
        memory_id: None,
    })
    .unwrap();
    let tree = c
        .submit(Operation::KnowledgeTree {
            agent_id: "a1".into(),
            workspace_id: "w1".into(),
            entity_id: eid,
            depth: 3,
            max_aspects: 10,
            max_groups: 10,
            max_claims: 10,
            max_attributes: 10,
        })
        .unwrap();
    assert_eq!(tree["entity"]["name"], "Signet");
    assert_eq!(
        tree["items"][0]["groups"][0]["claims"][0]["claimKey"],
        "favorite"
    );
    assert!(c
        .submit(Operation::KnowledgeTree {
            agent_id: "other".into(),
            workspace_id: "w1".into(),
            entity_id: "Signet".into(),
            depth: 3,
            max_aspects: 10,
            max_groups: 10,
            max_claims: 10,
            max_attributes: 10
        })
        .is_err());
}

#[test]
fn current_schema_knowledge_tree_is_scoped_bounded_and_status_aware() {
    let d = tempdir().unwrap();
    let p = d.path().join("current-tree.sqlite");
    let db = Connection::open(&p).unwrap();
    db.execute_batch("CREATE TABLE entities (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, workspace_id TEXT NOT NULL, name TEXT NOT NULL, canonical_name TEXT, entity_type TEXT NOT NULL DEFAULT 'person', description TEXT, mentions INTEGER DEFAULT 0, pinned INTEGER DEFAULT 0, pinned_at TEXT, status TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL); CREATE TABLE entity_aspects (id TEXT PRIMARY KEY, entity_id TEXT NOT NULL, agent_id TEXT NOT NULL, workspace_id TEXT NOT NULL, name TEXT NOT NULL, canonical_name TEXT, weight REAL NOT NULL DEFAULT 0.5, status TEXT DEFAULT 'active', created_at TEXT NOT NULL, updated_at TEXT NOT NULL); CREATE TABLE entity_attributes (id TEXT PRIMARY KEY, aspect_id TEXT NOT NULL, agent_id TEXT NOT NULL, workspace_id TEXT NOT NULL, memory_id TEXT, kind TEXT NOT NULL, content TEXT NOT NULL, normalized_content TEXT, group_key TEXT, claim_key TEXT, confidence REAL DEFAULT 0.5, importance REAL DEFAULT 0.5, status TEXT DEFAULT 'active', created_at TEXT NOT NULL, updated_at TEXT NOT NULL); INSERT INTO entities VALUES ('e1','a1','w1','Signet','signet','person',NULL,5,0,NULL,'active','2026-01-01','2026-01-05'), ('e2','a2','w1','Signet','signet','person',NULL,9,0,NULL,'active','2026-01-01','2026-01-06'), ('e3','a1','w1','Deleted','deleted','person',NULL,9,0,NULL,'deleted','2026-01-01','2026-01-06'); INSERT INTO entity_aspects VALUES ('p1','e1','a1','w1','Food','food',0.9,'active','2026-01-01','2026-01-05'), ('p2','e1','a1','w1','Work','work',0.8,'active','2026-01-01','2026-01-04'), ('p3','e1','a1','w1','Old','old',1.0,'superseded','2026-01-01','2026-01-06'); INSERT INTO entity_attributes VALUES ('x1','p1','a1','w1',NULL,'attribute','Active food','active food','restaurants','favorite',0.9,0.9,'active','2026-01-01','2026-01-05'), ('x2','p1','a1','w1',NULL,'attribute','Old food','old food','restaurants','favorite',0.9,0.8,'superseded','2026-01-01','2026-01-04'), ('x3','p1','a1','w1',NULL,'constraint','Deleted food','deleted food','secret','deleted',0.9,0.7,'deleted','2026-01-01','2026-01-06'), ('x4','p1','a2','w1',NULL,'attribute','Other agent','other agent','restaurants','foreign',0.9,0.9,'active','2026-01-01','2026-01-06'), ('x5','p2','a1','w1',NULL,'attribute','Work fact','work fact','job','role',0.9,0.9,'active','2026-01-01','2026-01-03');").unwrap();
    drop(db);
    let c = Core::open(&p, 2).unwrap();
    let tree = c
        .submit(Operation::KnowledgeTree {
            agent_id: "a1".into(),
            workspace_id: "w1".into(),
            entity_id: "signet".into(),
            depth: 3,
            max_aspects: 1,
            max_groups: 1,
            max_claims: 1,
            max_attributes: 50,
        })
        .unwrap();
    assert_eq!(tree["entity"]["id"], "e1");
    assert_eq!(tree["limits"]["maxGroups"], 1);
    assert_eq!(tree["limits"]["maxClaims"], 1);
    assert_eq!(tree["items"].as_array().unwrap().len(), 1);
    assert_eq!(tree["items"][0]["groupCount"], 1);
    assert_eq!(tree["items"][0]["groups"].as_array().unwrap().len(), 1);
    assert_eq!(
        tree["items"][0]["groups"][0]["claims"][0]["claimKey"],
        "favorite"
    );
    assert_eq!(
        tree["items"][0]["groups"][0]["claims"][0]["attributeCount"],
        2
    );
    assert_eq!(
        tree["items"][0]["groups"][0]["claims"][0]["constraintCount"],
        0
    );
    assert_eq!(tree["items"][0]["groups"][0]["claims"][0]["activeCount"], 1);
    assert_eq!(
        tree["items"][0]["groups"][0]["claims"][0]["supersededCount"],
        1
    );
    assert_eq!(
        tree["items"][0]["groups"][0]["claims"][0]["preview"],
        "Active food"
    );
}

#[test]
fn current_schema_tree_reports_live_attribute_and_constraint_counts() {
    let c = core();
    let entity = c
        .submit(Operation::KnowledgeEntityCreate {
            agent_id: "a".into(),
            workspace_id: "w".into(),
            name: "Counts".into(),
            entity_type: "project".into(),
            metadata: serde_json::json!({}),
        })
        .unwrap();
    let eid = entity["id"].as_str().unwrap().to_owned();
    let aspect = c
        .submit(Operation::KnowledgeAspectCreate {
            agent_id: "a".into(),
            workspace_id: "w".into(),
            entity_id: eid.clone(),
            name: "Facts".into(),
            weight: 1.0,
        })
        .unwrap();
    let aid = aspect["id"].as_str().unwrap().to_owned();
    for (kind, content) in [
        ("attribute", "one"),
        ("attribute", "two"),
        ("constraint", "three"),
    ] {
        c.submit(Operation::KnowledgeAttributeCreate {
            agent_id: "a".into(),
            workspace_id: "w".into(),
            aspect_id: aid.clone(),
            kind: kind.into(),
            content: content.into(),
            claim_key: Some("claim".into()),
            group_key: Some("group".into()),
            confidence: 1.0,
            importance: 1.0,
            memory_id: None,
        })
        .unwrap();
    }
    let tree = c
        .submit(Operation::KnowledgeTree {
            agent_id: "a".into(),
            workspace_id: "w".into(),
            entity_id: "Counts".into(),
            depth: 2,
            max_aspects: 10,
            max_groups: 10,
            max_claims: 10,
            max_attributes: 10,
        })
        .unwrap();
    assert_eq!(tree["items"][0]["attributeCount"], 2);
    assert_eq!(tree["items"][0]["constraintCount"], 1);
    assert_eq!(tree["items"][0]["groupCount"], 1);
    assert_eq!(tree["items"][0]["claimCount"], 1);
    assert_eq!(tree["items"][0]["groups"][0]["attributeCount"], 2);
    assert_eq!(tree["items"][0]["groups"][0]["constraintCount"], 1);
    assert!(c
        .submit(Operation::KnowledgeTree {
            agent_id: "other".into(),
            workspace_id: "w".into(),
            entity_id: "Counts".into(),
            depth: 3,
            max_aspects: 10,
            max_groups: 10,
            max_claims: 10,
            max_attributes: 10,
        })
        .is_err());
}

#[test]
fn current_schema_navigation_treats_like_wildcards_as_literal() {
    let d = tempdir().unwrap();
    let p = d.path().join("wildcards.sqlite");
    let db = Connection::open(&p).unwrap();
    db.execute_batch("CREATE TABLE entities (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, workspace_id TEXT NOT NULL, name TEXT NOT NULL, canonical_name TEXT, entity_type TEXT NOT NULL DEFAULT 'person', description TEXT, status TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL); INSERT INTO entities VALUES ('literal','a','w','100% real','100% real','person',NULL,'active','2026-01-01','2026-01-02'), ('arbitrary','a','w','100 percent real','100 percent real','person',NULL,'active','2026-01-01','2026-01-03');") .unwrap();
    drop(db);
    let c = Core::open(&p, 2).unwrap();
    let got = c
        .submit(Operation::KnowledgeNavigationEntity {
            agent_id: "a".into(),
            workspace_id: "w".into(),
            name: "100%".into(),
        })
        .unwrap();
    assert_eq!(got["entity"]["id"], "literal");
}

#[test]
fn current_schema_navigation_uses_scoped_live_tables_and_rejects_bad_bounds() {
    let d = tempdir().unwrap();
    let p = d.path().join("current-navigation.sqlite");
    let db = Connection::open(&p).unwrap();
    db.execute_batch("CREATE TABLE entities (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, workspace_id TEXT NOT NULL, name TEXT NOT NULL, canonical_name TEXT, entity_type TEXT NOT NULL DEFAULT 'person', description TEXT, mentions INTEGER DEFAULT 0, pinned INTEGER DEFAULT 0, pinned_at TEXT, status TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL); CREATE TABLE entity_aspects (id TEXT PRIMARY KEY, entity_id TEXT NOT NULL, agent_id TEXT NOT NULL, workspace_id TEXT NOT NULL, name TEXT NOT NULL, canonical_name TEXT, weight REAL NOT NULL DEFAULT 0.5, status TEXT DEFAULT 'active', created_at TEXT NOT NULL, updated_at TEXT NOT NULL); CREATE TABLE entity_attributes (id TEXT PRIMARY KEY, aspect_id TEXT NOT NULL, agent_id TEXT NOT NULL, workspace_id TEXT NOT NULL, memory_id TEXT, kind TEXT NOT NULL, content TEXT NOT NULL, normalized_content TEXT, group_key TEXT, claim_key TEXT, confidence REAL DEFAULT 0.5, importance REAL DEFAULT 0.5, status TEXT DEFAULT 'active', created_at TEXT NOT NULL, updated_at TEXT NOT NULL); INSERT INTO entities VALUES ('e1','a1','w1','Signet','signet','person',NULL,1,0,NULL,'active','2026-01-01','2026-01-01'); INSERT INTO entity_aspects VALUES ('p1','e1','a1','w1','Food','food',0.8,'active','2026-01-01','2026-01-01'); INSERT INTO entity_attributes VALUES ('x1','p1','a1','w1',NULL,'attribute','Active claim','active claim','restaurants','favorite_place',0.9,0.9,'active','2026-01-01','2026-01-03'), ('x2','p1','a1','w1',NULL,'attribute','Old claim','old claim','restaurants','favorite_place',0.9,0.8,'superseded','2026-01-01','2026-01-02'), ('x3','p1','a1','w1',NULL,'constraint','Deleted claim','deleted claim','Restaurants','Other Claim',0.9,0.7,'deleted','2026-01-01','2026-01-04'), ('x4','p1','a2','w1',NULL,'attribute','Other agent','other agent','restaurants','favorite_place',0.9,0.9,'active','2026-01-01','2026-01-01'), ('x5','p1','a1','w2',NULL,'attribute','Other workspace','other workspace','restaurants','favorite_place',0.9,0.9,'active','2026-01-01','2026-01-01');").unwrap();
    drop(db);
    let c = Core::open(&p, 2).unwrap();
    let detail = c
        .submit(Operation::KnowledgeNavigationEntity {
            agent_id: "a1".into(),
            workspace_id: "w1".into(),
            name: "signet".into(),
        })
        .unwrap();
    assert_eq!(detail["aspectCount"], 1);
    assert_eq!(detail["attributeCount"], 1);
    let aspects = c
        .submit(Operation::KnowledgeNavigationAspects {
            agent_id: "a1".into(),
            workspace_id: "w1".into(),
            entity: "signet".into(),
        })
        .unwrap();
    assert_eq!(aspects["items"][0]["attributeCount"], 1);
    let groups = c
        .submit(Operation::KnowledgeNavigationGroups {
            agent_id: "a1".into(),
            workspace_id: "w1".into(),
            entity: "signet".into(),
            aspect: "food".into(),
        })
        .unwrap();
    assert_eq!(groups["items"][0]["groupKey"], "restaurants");
    assert_eq!(groups["items"][0]["attributeCount"], 1);
    let claims = c
        .submit(Operation::KnowledgeNavigationClaims {
            agent_id: "a1".into(),
            workspace_id: "w1".into(),
            entity: "signet".into(),
            aspect: "food".into(),
            group: "Restaurants".into(),
        })
        .unwrap();
    assert_eq!(claims["items"][0]["activeCount"], 1);
    assert_eq!(claims["items"][0]["supersededCount"], 1);
    assert_eq!(claims["items"][0]["preview"], "Active claim");
    let active = c
        .submit(Operation::KnowledgeNavigationAttributes {
            agent_id: "a1".into(),
            workspace_id: "w1".into(),
            entity: "signet".into(),
            aspect: "food".into(),
            group: "Restaurants".into(),
            claim: "Favorite Place".into(),
            limit: 1,
            offset: 0,
            kind: None,
            status: None,
        })
        .unwrap();
    assert_eq!(active["items"].as_array().unwrap().len(), 1);
    assert_eq!(active["items"][0]["content"], "Active claim");
    let all = c
        .submit(Operation::KnowledgeNavigationAttributes {
            agent_id: "a1".into(),
            workspace_id: "w1".into(),
            entity: "signet".into(),
            aspect: "food".into(),
            group: "restaurants".into(),
            claim: "favorite_place".into(),
            limit: 1,
            offset: 0,
            kind: None,
            status: Some("all".into()),
        })
        .unwrap();
    assert_eq!(all["items"].as_array().unwrap().len(), 1);
    assert!(matches!(
        c.submit(Operation::KnowledgeNavigationAttributes {
            agent_id: "a1".into(),
            workspace_id: "w1".into(),
            entity: "signet".into(),
            aspect: "food".into(),
            group: "restaurants".into(),
            claim: "favorite_place".into(),
            limit: 0,
            offset: 0,
            kind: None,
            status: None
        }),
        Err(CoreError::InvalidInput(_))
    ));
}

#[test]
fn current_schema_navigation_matches_spaced_keys_from_canonical_requests() {
    let d = tempdir().unwrap();
    let p = d.path().join("spaced-navigation.sqlite");
    let db = Connection::open(&p).unwrap();
    db.execute_batch("CREATE TABLE entities (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, workspace_id TEXT NOT NULL, name TEXT NOT NULL, canonical_name TEXT, entity_type TEXT NOT NULL DEFAULT 'person', description TEXT, mentions INTEGER DEFAULT 0, pinned INTEGER DEFAULT 0, pinned_at TEXT, status TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL); CREATE TABLE entity_aspects (id TEXT PRIMARY KEY, entity_id TEXT NOT NULL, agent_id TEXT NOT NULL, workspace_id TEXT NOT NULL, name TEXT NOT NULL, canonical_name TEXT, weight REAL NOT NULL DEFAULT 0.5, status TEXT DEFAULT 'active', created_at TEXT NOT NULL, updated_at TEXT NOT NULL); CREATE TABLE entity_attributes (id TEXT PRIMARY KEY, aspect_id TEXT NOT NULL, agent_id TEXT NOT NULL, workspace_id TEXT NOT NULL, memory_id TEXT, kind TEXT NOT NULL, content TEXT NOT NULL, normalized_content TEXT, group_key TEXT, claim_key TEXT, confidence REAL DEFAULT 0.5, importance REAL DEFAULT 0.5, status TEXT DEFAULT 'active', created_at TEXT NOT NULL, updated_at TEXT NOT NULL); INSERT INTO entities VALUES ('e1','a1','w1','Signet','signet','person',NULL,1,0,NULL,'active','2026-01-01','2026-01-01'); INSERT INTO entity_aspects VALUES ('p1','e1','a1','w1','Food','food',0.8,'active','2026-01-01','2026-01-01'); INSERT INTO entity_attributes VALUES ('x1','p1','a1','w1',NULL,'attribute','Active meal','active meal','dietary constraints','favorite meal',0.9,0.9,'active','2026-01-01','2026-01-03'), ('x2','p1','a2','w1',NULL,'attribute','Other agent','other agent','dietary constraints','favorite meal',0.9,0.9,'active','2026-01-01','2026-01-03'), ('x3','p1','a1','w2',NULL,'attribute','Other workspace','other workspace','dietary constraints','favorite meal',0.9,0.9,'active','2026-01-01','2026-01-03'), ('x4','p1','a1','w1',NULL,'attribute','Deleted','deleted','dietary constraints','favorite meal',0.9,0.9,'deleted','2026-01-01','2026-01-03');");
    drop(db);
    let c = Core::open(&p, 2).unwrap();
    let groups = c
        .submit(Operation::KnowledgeNavigationGroups {
            agent_id: "a1".into(),
            workspace_id: "w1".into(),
            entity: "signet".into(),
            aspect: "food".into(),
        })
        .unwrap();
    assert_eq!(groups["items"].as_array().unwrap().len(), 1);
    assert_eq!(groups["items"][0]["groupKey"], "dietary constraints");
    let claims = c
        .submit(Operation::KnowledgeNavigationClaims {
            agent_id: "a1".into(),
            workspace_id: "w1".into(),
            entity: "signet".into(),
            aspect: "food".into(),
            group: "dietary_constraints".into(),
        })
        .unwrap();
    assert_eq!(claims["items"].as_array().unwrap().len(), 1);
    assert_eq!(claims["items"][0]["claimKey"], "favorite meal");
    let attrs = c
        .submit(Operation::KnowledgeNavigationAttributes {
            agent_id: "a1".into(),
            workspace_id: "w1".into(),
            entity: "signet".into(),
            aspect: "food".into(),
            group: "dietary_constraints".into(),
            claim: "favorite_meal".into(),
            limit: 10,
            offset: 0,
            kind: None,
            status: None,
        })
        .unwrap();
    assert_eq!(attrs["items"].as_array().unwrap().len(), 1);
    assert_eq!(attrs["items"][0]["content"], "Active meal");
}
