use rusqlite::Connection;
use signet_core_native::Core;
use tempfile::tempdir;

#[test]
fn ontology_claim_lineage_schema_is_additive_and_owner_scoped() {
    let workspace = tempdir().unwrap();
    let path = workspace.path().join("legacy-lineage.sqlite");
    let db = Connection::open(&path).unwrap();
    db.execute_batch(
        r#"CREATE TABLE entities (
            id TEXT PRIMARY KEY,
            agent_id TEXT NOT NULL,
            workspace_id TEXT NOT NULL DEFAULT 'default',
            name TEXT NOT NULL,
            canonical_name TEXT,
            entity_type TEXT NOT NULL DEFAULT 'person',
            description TEXT,
            mentions INTEGER DEFAULT 0,
            pinned INTEGER DEFAULT 0,
            pinned_at TEXT,
            status TEXT DEFAULT 'active',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE entity_aspects (
            id TEXT PRIMARY KEY,
            entity_id TEXT NOT NULL,
            agent_id TEXT NOT NULL,
            name TEXT NOT NULL,
            canonical_name TEXT,
            weight REAL NOT NULL DEFAULT 0.5,
            status TEXT DEFAULT 'active',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE entity_attributes (
            id TEXT PRIMARY KEY,
            aspect_id TEXT NOT NULL,
            agent_id TEXT NOT NULL,
            memory_id TEXT,
            kind TEXT NOT NULL,
            content TEXT NOT NULL,
            normalized_content TEXT,
            group_key TEXT,
            claim_key TEXT,
            confidence REAL DEFAULT 0.5,
            importance REAL DEFAULT 0.5,
            status TEXT DEFAULT 'active',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE entity_dependencies (
            id TEXT PRIMARY KEY,
            source_entity_id TEXT NOT NULL,
            target_entity_id TEXT NOT NULL,
            agent_id TEXT NOT NULL,
            dependency_type TEXT NOT NULL,
            strength REAL NOT NULL,
            status TEXT DEFAULT 'active',
            updated_at TEXT NOT NULL
        );
        CREATE TABLE memories (
            id TEXT PRIMARY KEY,
            agent_id TEXT NOT NULL,
            content TEXT NOT NULL,
            metadata TEXT NOT NULL DEFAULT '{}',
            deleted INTEGER NOT NULL DEFAULT 0,
            created_at TEXT,
            updated_at TEXT
        );
        CREATE TABLE session_transcripts (
            session_key TEXT NOT NULL,
            agent_id TEXT NOT NULL,
            harness TEXT NOT NULL,
            project TEXT,
            content TEXT NOT NULL,
            content_hash TEXT NOT NULL,
            idempotency_key TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            completed_at TEXT,
            PRIMARY KEY(agent_id, session_key)
        );
        INSERT INTO entities (id, agent_id, workspace_id, name, entity_type, created_at, updated_at)
            VALUES ('entity-a', 'agent-a', 'preserved-workspace', 'Entity A', 'person', '2026-09-22', '2026-09-22');
        INSERT INTO entity_aspects (id, entity_id, agent_id, name, created_at, updated_at)
            VALUES ('aspect-a', 'entity-a', 'agent-a', 'identity', '2026-09-22', '2026-09-22');
        INSERT INTO entity_attributes (id, aspect_id, agent_id, kind, content, created_at, updated_at)
            VALUES ('attribute-a', 'aspect-a', 'agent-a', 'fact', 'content', '2026-09-22', '2026-09-22');
        INSERT INTO entity_dependencies (id, source_entity_id, target_entity_id, agent_id, dependency_type, strength, updated_at)
            VALUES ('dependency-a', 'entity-a', 'entity-a', 'agent-a', 'related', 1.0, '2026-09-22');
        INSERT INTO memories (id, agent_id, content, created_at, updated_at)
            VALUES ('memory-a', 'agent-a', 'memory', '2026-09-22', '2026-09-22');
        INSERT INTO session_transcripts
            (session_key, agent_id, harness, content, content_hash, idempotency_key, created_at, updated_at)
            VALUES ('session-a', 'agent-a', 'test', 'transcript', 'hash', 'idem-a', '2026-09-22', '2026-09-22');
        CREATE TABLE memory_artifacts (
            agent_id TEXT NOT NULL DEFAULT 'default',
            source_path TEXT NOT NULL,
            source_sha256 TEXT NOT NULL,
            source_kind TEXT NOT NULL,
            session_id TEXT NOT NULL,
            session_token TEXT NOT NULL,
            captured_at TEXT NOT NULL,
            content TEXT NOT NULL DEFAULT '',
            updated_at TEXT NOT NULL,
            PRIMARY KEY (agent_id, source_path)
        );
        INSERT INTO memory_artifacts
            (agent_id, source_path, source_sha256, source_kind, session_id,
             session_token, captured_at, content, updated_at)
        VALUES
            ('agent-a', 'session.md', 'sha', 'session', 'session-a',
             'token-a', '2026-09-22T00:00:00Z', 'exact source text',
             '2026-09-22T00:00:00Z');
        CREATE TABLE aggregate_evidence_sources (
            aggregate_memory_id TEXT NOT NULL,
            source_kind TEXT NOT NULL,
            source_id TEXT NOT NULL,
            source_path TEXT,
            agent_id TEXT NOT NULL DEFAULT 'default',
            created_at TEXT NOT NULL,
            PRIMARY KEY (aggregate_memory_id, source_kind, source_id)
        );
        INSERT INTO aggregate_evidence_sources
            (aggregate_memory_id, source_kind, source_id, source_path, agent_id, created_at)
        VALUES
            ('derived-a', 'artifact', 'artifact-a', 'session.md', 'agent-a',
             '2026-09-22T00:00:00Z');
        CREATE TABLE aggregate_memory_sources (
            aggregate_memory_id TEXT NOT NULL,
            source_memory_id TEXT NOT NULL
        );"#,
    )
    .unwrap();
    drop(db);

    let core = Core::open(&path, 2).unwrap();
    let artifacts = core
        .database_sample(
            "memory_artifacts".into(),
            10,
            0,
            Some("agent-a".into()),
            None,
        )
        .unwrap();
    let artifact_columns = artifacts["columns"].as_array().unwrap();
    for column in [
        "source_id",
        "source_root",
        "source_external_id",
        "source_parent_path",
        "source_meta_json",
        "source_mtime_ms",
        "is_deleted",
        "deleted_at",
    ] {
        assert!(
            artifact_columns.iter().any(|value| value == column),
            "missing additive memory_artifacts column {column}"
        );
    }
    assert_eq!(artifacts["rows"][0]["source_path"], "session.md");
    assert_eq!(artifacts["rows"][0]["content"], "exact source text");

    let derived = core
        .database_sample(
            "derived_memory_sources".into(),
            10,
            0,
            Some("agent-a".into()),
            None,
        )
        .unwrap();
    assert_eq!(derived["rows"].as_array().unwrap().len(), 1);
    assert_eq!(derived["rows"][0]["derived_memory_id"], "derived-a");
    assert_eq!(derived["rows"][0]["source_kind"], "artifact");
    assert_eq!(derived["rows"][0]["source_id"], "artifact-a");

    let preserved_entity = core
        .database_sample(
            "entities".into(),
            10,
            0,
            Some("agent-a".into()),
            Some("preserved-workspace".into()),
        )
        .unwrap();
    assert_eq!(preserved_entity["rows"].as_array().unwrap().len(), 1);
    assert_eq!(preserved_entity["rows"][0]["id"], "entity-a");

    for table in [
        "entity_aspects",
        "entity_attributes",
        "entity_dependencies",
        "memories",
    ] {
        let sample = core
            .database_sample(
                table.into(),
                10,
                0,
                Some("agent-a".into()),
                Some("default".into()),
            )
            .unwrap();
        assert_eq!(
            sample["rows"].as_array().unwrap().len(),
            1,
            "legacy {table} row must receive the additive default workspace"
        );
    }

    let transcripts = core
        .database_sample(
            "session_transcripts".into(),
            10,
            0,
            Some("agent-a".into()),
            None,
        )
        .unwrap();
    assert_eq!(transcripts["rows"].as_array().unwrap().len(), 1);
    assert!(
        !transcripts["columns"]
            .as_array()
            .unwrap()
            .iter()
            .any(|value| value == "workspace_id"),
        "session transcripts remain agent/session scoped; do not add an unused workspace boundary"
    );

    let attributes = core
        .database_sample(
            "entity_attributes".into(),
            10,
            0,
            Some("agent-a".into()),
            Some("default".into()),
        )
        .unwrap();
    for column in [
        "workspace_id",
        "version",
        "version_root_id",
        "previous_attribute_id",
        "archived_at",
        "archived_by",
        "archive_reason",
    ] {
        assert!(
            attributes["columns"]
                .as_array()
                .unwrap()
                .iter()
                .any(|value| value == column),
            "missing ontology attribute column {column}"
        );
    }
    let assertions = core
        .database_sample(
            "epistemic_assertions".into(),
            10,
            0,
            Some("agent-a".into()),
            None,
        )
        .unwrap();
    for column in [
        "subject_entity_id",
        "claim_attribute_id",
        "evidence",
        "source_kind",
        "source_id",
    ] {
        assert!(
            assertions["columns"]
                .as_array()
                .unwrap()
                .iter()
                .any(|value| value == column),
            "missing epistemic assertion column {column}"
        );
    }
    let schema = core.database_schema().unwrap();
    let assertion_table = schema["tables"]
        .as_array()
        .unwrap()
        .iter()
        .find(|table| table["name"] == "epistemic_assertions")
        .expect("epistemic_assertions table missing");
    assert!(assertion_table["indexes"]
        .as_array()
        .unwrap()
        .iter()
        .any(|index| index["name"] == "idx_epistemic_assertions_observer_entity"));
}

#[test]
fn legacy_entities_receive_default_workspace_scope() {
    let workspace = tempdir().unwrap();
    let path = workspace.path().join("legacy-entities.sqlite");
    let db = Connection::open(&path).unwrap();
    db.execute_batch(
        "CREATE TABLE entities (
            id TEXT PRIMARY KEY,
            agent_id TEXT NOT NULL,
            name TEXT NOT NULL,
            entity_type TEXT NOT NULL,
            status TEXT,
            created_at TEXT,
            updated_at TEXT
        );
        INSERT INTO entities (id, agent_id, name, entity_type, status, created_at, updated_at)
            VALUES ('legacy-entity', 'agent-a', 'Legacy Entity', 'person', 'active', '2026-09-22', '2026-09-22');",
    )
    .unwrap();
    drop(db);

    let core = Core::open(&path, 2).unwrap();
    let entities = core
        .database_sample(
            "entities".into(),
            10,
            0,
            Some("agent-a".into()),
            Some("default".into()),
        )
        .unwrap();
    assert_eq!(entities["rows"].as_array().unwrap().len(), 1);
    assert_eq!(entities["rows"][0]["id"], "legacy-entity");
}
