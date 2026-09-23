use rusqlite::Connection;
use signet_core_native::Core;
use tempfile::tempdir;

#[test]
fn ontology_claim_lineage_schema_is_additive_and_owner_scoped() {
    let workspace = tempdir().unwrap();
    let path = workspace.path().join("legacy-lineage.sqlite");
    let db = Connection::open(&path).unwrap();
    db.execute_batch(
        "CREATE TABLE memory_artifacts (
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
             '2026-09-22T00:00:00Z');",
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
}
