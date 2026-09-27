use rusqlite::Connection;
use signet_core_native::{CoreError, WorkspaceOwner};
use tempfile::NamedTempFile;

// v157 was generated from the PR-base TypeScript registry at 7a46e8227b4f2a3ad629f0de80ebce02330967bd.
// The pinned behavioral reference 11e4720c07107caf7fdd57a685eca24e8a82e654 ends at v153; see the separate fixture below.

#[test]
fn owner_admits_authentic_typescript_157_and_reopen_preserves_history_data_and_index() {
    let file = NamedTempFile::new().unwrap();
    let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/ts_applied_157.sqlite");
    std::fs::copy(fixture, file.path()).unwrap();
    let db = Connection::open(file.path()).unwrap();
    let history_before: Vec<(i64, String, String)> = db
        .prepare("SELECT version,applied_at,checksum FROM schema_migrations WHERE version>=155")
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    let audit_before: Vec<(i64,String,Option<i64>,Option<String>)> = db.prepare("SELECT version,applied_at,duration_ms,checksum FROM schema_migrations_audit WHERE version>=155 ORDER BY id").unwrap().query_map([],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).unwrap().collect::<Result<_, _>>().unwrap();
    drop(
        WorkspaceOwner::open(file.path(), 4)
            .expect("authentic TypeScript 157 schema should be admitted"),
    );
    verify_fixture_rows(file.path());
    drop(WorkspaceOwner::open(file.path(), 4).expect("repeated reopen should be idempotent"));
    verify_fixture_rows(file.path());
    let history_after: Vec<(i64, String, String)> = db
        .prepare("SELECT version,applied_at,checksum FROM schema_migrations WHERE version>=155")
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    let audit_after: Vec<(i64,String,Option<i64>,Option<String>)> = db.prepare("SELECT version,applied_at,duration_ms,checksum FROM schema_migrations_audit WHERE version>=155 ORDER BY id").unwrap().query_map([],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).unwrap().collect::<Result<_, _>>().unwrap();
    assert_eq!(history_after, history_before);
    assert_eq!(audit_after, audit_before);
    let schema: Vec<(String, String)> = db
        .prepare("SELECT type,name FROM sqlite_master WHERE name IN ('embedding_repair_checkpoints','embedding_repair_progress','idx_embedding_repair_checkpoints_status') ORDER BY type,name")
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(
        schema,
        vec![
            (
                "index".into(),
                "idx_embedding_repair_checkpoints_status".into()
            ),
            ("table".into(), "embedding_repair_checkpoints".into()),
            ("table".into(), "embedding_repair_progress".into())
        ]
    );
    assert_eq!(
        history_after
            .iter()
            .map(|r| (r.0, r.2.as_str()))
            .collect::<Vec<_>>(),
        vec![(155, "1f938a32"), (156, "334babc9"), (157, "-2d144030")]
    );
    assert_eq!(
        audit_after
            .iter()
            .map(|r| (r.0, r.3.as_deref()))
            .collect::<Vec<_>>(),
        vec![
            (155, Some("1f938a32")),
            (156, Some("334babc9")),
            (157, Some("-2d144030"))
        ]
    );
}

fn verify_fixture_rows(path: &std::path::Path) {
    let db = Connection::open(path).unwrap();
    let progress:(String,Option<String>,i64,Option<String>,String)=db.query_row("SELECT agent_id,last_completed_at,last_affected,last_error,updated_at FROM embedding_repair_progress WHERE agent_id='fixture-agent'",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).unwrap();
    assert_eq!(
        progress,
        (
            "fixture-agent".into(),
            Some("2026-09-26T10:00:00.000Z".into()),
            8,
            Some("preserve progress".into()),
            "2026-09-26T11:45:00.000Z".into()
        )
    );
    let agent: (String, String) = db
        .query_row(
            "SELECT id,name FROM agents WHERE id='fixture-agent'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(agent, ("fixture-agent".into(), "Fixture Agent".into()));
}

#[test]
fn fresh_migration_metadata_has_typescript_not_null_constraints() {
    let file = NamedTempFile::new().unwrap();
    drop(WorkspaceOwner::open(file.path(), 4).unwrap());
    let db = Connection::open(file.path()).unwrap();
    let columns: Vec<(String, i64)> = db
        .prepare("PRAGMA table_info(schema_migrations)")
        .unwrap()
        .query_map([], |r| Ok((r.get(1)?, r.get(3)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert!(columns
        .iter()
        .any(|(name, not_null)| name == "applied_at" && *not_null == 1));
    assert!(columns
        .iter()
        .any(|(name, not_null)| name == "checksum" && *not_null == 1));
    let versions: Vec<i64> = db
        .prepare("SELECT version FROM schema_migrations ORDER BY version")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert!(!versions.iter().any(|version| *version >= 153));
}

#[test]
fn owner_upgrades_pinned_typescript_153_schema_through_current_157_and_reopens() {
    let file = NamedTempFile::new().unwrap();
    let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/ts_applied_153.sqlite");
    std::fs::copy(fixture, file.path()).unwrap();
    let db = Connection::open(file.path()).unwrap();
    db.execute_batch(
        "INSERT INTO transcript_capture_jobs(id,agent_id,harness,session_id,transcript,captured_at,created_at,updated_at)
         VALUES ('legacy-v153','default','test-harness','session-v153','legacy transcript body',
                 '2026-09-26T00:00:00.000Z','2026-09-26T00:00:00.000Z','2026-09-26T00:00:00.000Z');
         INSERT INTO documents(id,source_type,raw_content,metadata_json,agent_id,project,created_at,updated_at)
         VALUES ('legacy-document','filesystem','legacy document body',
                 '{\"signet\":{\"project\":\"metadata-after-v80\"},\"retained\":\"yes\"}',
                 'default','column-scope','2026-09-26T00:00:00.000Z','2026-09-26T00:00:00.000Z');",
    )
    .unwrap();
    let has_workspace_column: i64 = db
        .query_row(
            "SELECT count(*) FROM pragma_table_info('documents') WHERE name='workspace_id'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(has_workspace_column, 0);
    let baseline_history: (i64, i64, i64) = db
        .query_row(
            "SELECT MIN(version),MAX(version),COUNT(*) FROM schema_migrations",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!(baseline_history, (1, 153, 153));
    let history_before: Vec<(i64, String, String)> = db
        .prepare("SELECT version,applied_at,checksum FROM schema_migrations WHERE version BETWEEN 1 AND 153 ORDER BY version")
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    let audit_before: Vec<(i64, String, Option<i64>, Option<String>)> = db
        .prepare("SELECT version,applied_at,duration_ms,checksum FROM schema_migrations_audit WHERE version BETWEEN 1 AND 153 ORDER BY id")
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    drop(db);

    drop(
        WorkspaceOwner::open(file.path(), 4)
            .expect("pinned TypeScript v153 workspace should upgrade"),
    );
    let db = Connection::open(file.path()).unwrap();
    let history_after: Vec<(i64, String, String)> = db
        .prepare("SELECT version,applied_at,checksum FROM schema_migrations WHERE version BETWEEN 1 AND 153 ORDER BY version")
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(history_after, history_before);
    let audit_after: Vec<(i64, String, Option<i64>, Option<String>)> = db
        .prepare("SELECT version,applied_at,duration_ms,checksum FROM schema_migrations_audit WHERE version BETWEEN 1 AND 153 ORDER BY id")
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(audit_after, audit_before);
    let legacy_document: (String, String, String, String) = db
        .query_row(
            "SELECT content,metadata,project,workspace_id FROM documents WHERE id='legacy-document'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .unwrap();
    assert_eq!(
        legacy_document,
        (
            "legacy document body".into(),
            "{\"signet\":{\"project\":\"metadata-after-v80\"},\"retained\":\"yes\"}".into(),
            "column-scope".into(),
            "default".into(),
        )
    );
    let history: Vec<(i64, String)> = db
        .prepare("SELECT version,checksum FROM schema_migrations WHERE version BETWEEN 154 AND 157 ORDER BY version")
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    let expected = vec![
        (154, "-2c048e44".to_owned()),
        (155, "1f938a32".to_owned()),
        (156, "334babc9".to_owned()),
        (157, "-2d144030".to_owned()),
    ];
    assert_eq!(history, expected);
    let audit: Vec<(i64, Option<String>)> = db
        .prepare("SELECT version,checksum FROM schema_migrations_audit WHERE version BETWEEN 154 AND 157 ORDER BY id")
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(
        audit,
        expected
            .iter()
            .map(|(version, checksum)| (*version, Some(checksum.clone())))
            .collect::<Vec<_>>()
    );
    let transcript: (
        String,
        String,
        Option<String>,
        Option<String>,
        Option<i64>,
        Option<f64>,
        Option<String>,
        Option<String>,
    ) = db
        .query_row(
            "SELECT id,transcript,source_identity,source_sha256,source_size_bytes,source_mtime_ms,source_format,audit_path FROM transcript_capture_jobs WHERE id='legacy-v153'",
            [],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                    row.get(7)?,
                ))
            },
        )
        .unwrap();
    assert_eq!(
        transcript,
        (
            "legacy-v153".into(),
            "legacy transcript body".into(),
            None,
            None,
            None,
            None,
            None,
            None,
        )
    );
    let source_index_count: i64 = db
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name IN ('idx_transcript_capture_jobs_source_identity','idx_transcript_capture_jobs_source_digest','idx_source_sync_failures_active')",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(source_index_count, 3);
    drop(db);

    drop(WorkspaceOwner::open(file.path(), 4).expect("upgraded workspace should reopen"));
    let db = Connection::open(file.path()).unwrap();
    let reopened_audit: Vec<(i64, Option<String>)> = db
        .prepare("SELECT version,checksum FROM schema_migrations_audit WHERE version BETWEEN 154 AND 157 ORDER BY id")
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(reopened_audit, audit);
}

#[test]
fn owner_repairs_missing_tail_history_row_with_complete_prefix() {
    let file = NamedTempFile::new().unwrap();
    let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/ts_applied_157.sqlite");
    std::fs::copy(fixture, file.path()).unwrap();

    let db = Connection::open(file.path()).unwrap();
    db.execute("DELETE FROM schema_migrations WHERE version=154", [])
        .unwrap();
    drop(db);

    drop(
        WorkspaceOwner::open(file.path(), 4)
            .expect("TypeScript replays absent registered rows without rejecting later versions"),
    );
    let db = Connection::open(file.path()).unwrap();
    let replayed_154: String = db
        .query_row(
            "SELECT checksum FROM schema_migrations WHERE version=154",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(replayed_154, "-2c048e44");
    let replayed_79: i64 = db
        .query_row(
            "SELECT count(*) FROM schema_migrations WHERE version=79",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(replayed_79, 1);
}

#[test]
fn owner_replays_only_the_exact_missing_v79_gap_before_tail() {
    let file = NamedTempFile::new().unwrap();
    let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/ts_applied_157.sqlite");
    std::fs::copy(fixture, file.path()).unwrap();
    let db = Connection::open(file.path()).unwrap();
    db.execute("DELETE FROM schema_migrations WHERE version=79", [])
        .unwrap();
    let history_before: Vec<(i64, String, String)> = db
        .prepare("SELECT version,applied_at,checksum FROM schema_migrations ORDER BY version")
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    drop(db);

    drop(WorkspaceOwner::open(file.path(), 4).expect("exact v79 gap should replay"));
    let db = Connection::open(file.path()).unwrap();
    let history_after: Vec<(i64, String, String)> = db
        .prepare("SELECT version,applied_at,checksum FROM schema_migrations ORDER BY version")
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(history_after.len(), history_before.len() + 1);
    assert!(history_after
        .iter()
        .any(|(version, _, checksum)| *version == 79 && checksum == "5939169c"));
}

#[test]
fn owner_replays_missing_v79_with_preexisting_same_name_index_like_typescript() {
    let file = NamedTempFile::new().unwrap();
    let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/ts_v80_missing_79.sqlite");
    std::fs::copy(fixture, file.path()).unwrap();
    let db = Connection::open(file.path()).unwrap();
    db.execute("DROP INDEX idx_transcript_capture_jobs_status", [])
        .unwrap();
    db.execute(
        "CREATE INDEX idx_transcript_capture_jobs_status ON transcript_capture_jobs(harness)",
        [],
    )
    .unwrap();
    let audit_before: i64 = db
        .query_row(
            "SELECT count(*) FROM schema_migrations_audit WHERE version=79",
            [],
            |row| row.get(0),
        )
        .unwrap();
    drop(db);

    drop(
        WorkspaceOwner::open(file.path(), 4)
            .expect("TypeScript v79 records the migration when its declared table artifact exists"),
    );
    let db = Connection::open(file.path()).unwrap();
    let history_checksum: String = db
        .query_row(
            "SELECT checksum FROM schema_migrations WHERE version=79",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(history_checksum, "5939169c");
    let index_sql: String = db
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_transcript_capture_jobs_status'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(index_sql.contains("transcript_capture_jobs(harness)"));
    let audit_after: i64 = db
        .query_row(
            "SELECT count(*) FROM schema_migrations_audit WHERE version=79",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(audit_after, audit_before + 1);
    drop(db);

    drop(
        WorkspaceOwner::open(file.path(), 4).expect("reopen should preserve the replayed history"),
    );
    let db = Connection::open(file.path()).unwrap();
    let reopened_audit: i64 = db
        .query_row(
            "SELECT count(*) FROM schema_migrations_audit WHERE version=79",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(reopened_audit, audit_after);
}

#[test]
fn owner_rejects_tail_checksum_mismatch_without_history_mutation() {
    let file = NamedTempFile::new().unwrap();
    let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/ts_applied_157.sqlite");
    std::fs::copy(fixture, file.path()).unwrap();
    let db = Connection::open(file.path()).unwrap();
    let audit_before: i64 = db
        .query_row(
            "SELECT count(*) FROM schema_migrations_audit WHERE version=156",
            [],
            |row| row.get(0),
        )
        .unwrap();
    db.execute(
        "UPDATE schema_migrations SET checksum='invalid' WHERE version=156",
        [],
    )
    .unwrap();
    drop(db);

    let result = WorkspaceOwner::open(file.path(), 4);
    assert!(matches!(
        result,
        Err(CoreError::UnsupportedMigrationHistory(_))
    ));
    let db = Connection::open(file.path()).unwrap();
    let checksum: String = db
        .query_row(
            "SELECT checksum FROM schema_migrations WHERE version=156",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(checksum, "invalid");
    let audit_after: i64 = db
        .query_row(
            "SELECT count(*) FROM schema_migrations_audit WHERE version=156",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(audit_after, audit_before);
}

#[test]
fn owner_repairs_missing_154_index_during_startup_without_rewriting_history() {
    let file = NamedTempFile::new().unwrap();
    let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/ts_applied_157.sqlite");
    std::fs::copy(fixture, file.path()).unwrap();
    let db = Connection::open(file.path()).unwrap();
    let history_before: (String, String) = db
        .query_row(
            "SELECT applied_at,checksum FROM schema_migrations WHERE version=154",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    let audit_before: i64 = db
        .query_row(
            "SELECT count(*) FROM schema_migrations_audit WHERE version=154",
            [],
            |row| row.get(0),
        )
        .unwrap();
    db.execute("DROP INDEX idx_transcript_capture_jobs_source_digest", [])
        .unwrap();
    drop(db);

    drop(WorkspaceOwner::open(file.path(), 4).expect("owner should repair missing v154 index"));
    let db = Connection::open(file.path()).unwrap();
    let index_count: i64 = db
        .query_row(
            "SELECT count(*) FROM sqlite_master WHERE type='index' AND name='idx_transcript_capture_jobs_source_digest'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(index_count, 1);
    let history_after: (String, String) = db
        .query_row(
            "SELECT applied_at,checksum FROM schema_migrations WHERE version=154",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(history_after, history_before);
    let audit_after: i64 = db
        .query_row(
            "SELECT count(*) FROM schema_migrations_audit WHERE version=154",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(audit_after, audit_before);
}

#[test]
fn owner_repairs_missing_155_partial_index_from_recorded_tail_migration() {
    let file = NamedTempFile::new().unwrap();
    let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/ts_applied_157.sqlite");
    std::fs::copy(fixture, file.path()).unwrap();
    let db = Connection::open(file.path()).unwrap();
    let history_before: (String, String) = db
        .query_row(
            "SELECT applied_at,checksum FROM schema_migrations WHERE version=155",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    let audit_before: i64 = db
        .query_row(
            "SELECT count(*) FROM schema_migrations_audit WHERE version=155",
            [],
            |row| row.get(0),
        )
        .unwrap();
    db.execute("DROP INDEX idx_source_sync_failures_active", [])
        .unwrap();
    drop(db);

    drop(WorkspaceOwner::open(file.path(), 4).expect("owner should repair missing v155 index"));
    let db = Connection::open(file.path()).unwrap();
    let index_sql: String = db
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_source_sync_failures_active'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(index_sql
        .to_ascii_lowercase()
        .contains("where resolved_at is null"));
    let history_after: (String, String) = db
        .query_row(
            "SELECT applied_at,checksum FROM schema_migrations WHERE version=155",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(history_after, history_before);
    let audit_after: i64 = db
        .query_row(
            "SELECT count(*) FROM schema_migrations_audit WHERE version=155",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(audit_after, audit_before);
}

#[test]
fn owner_rejects_wrong_partial_source_sync_index_without_mutating_history() {
    let file = NamedTempFile::new().unwrap();
    let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/ts_applied_157.sqlite");
    std::fs::copy(fixture, file.path()).unwrap();
    let db = Connection::open(file.path()).unwrap();
    let history_before: (String, String) = db
        .query_row(
            "SELECT applied_at,checksum FROM schema_migrations WHERE version=155",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    let audit_before: i64 = db
        .query_row(
            "SELECT count(*) FROM schema_migrations_audit WHERE version=155",
            [],
            |row| row.get(0),
        )
        .unwrap();
    db.execute("DROP INDEX idx_source_sync_failures_active", [])
        .unwrap();
    db.execute(
        "CREATE INDEX idx_source_sync_failures_active ON source_sync_failures(agent_id,source_key,phase,item_path)",
        [],
    )
    .unwrap();
    drop(db);

    assert!(matches!(
        WorkspaceOwner::open(file.path(), 4),
        Err(CoreError::UnsupportedMigrationHistory(_))
    ));
    let db = Connection::open(file.path()).unwrap();
    let index_sql: String = db
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_source_sync_failures_active'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(!index_sql
        .to_ascii_lowercase()
        .contains("where resolved_at is null"));
    let history_after: (String, String) = db
        .query_row(
            "SELECT applied_at,checksum FROM schema_migrations WHERE version=155",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(history_after, history_before);
    let audit_after: i64 = db
        .query_row(
            "SELECT count(*) FROM schema_migrations_audit WHERE version=155",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(audit_after, audit_before);
}

#[test]
fn owner_repairs_missing_156_index_from_recorded_tail_migration() {
    let file = NamedTempFile::new().unwrap();
    let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/ts_applied_157.sqlite");
    std::fs::copy(fixture, file.path()).unwrap();
    let db = Connection::open(file.path()).unwrap();
    let history_before: (String, String) = db
        .query_row(
            "SELECT applied_at,checksum FROM schema_migrations WHERE version=156",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    let audit_before: i64 = db
        .query_row(
            "SELECT count(*) FROM schema_migrations_audit WHERE version=156",
            [],
            |row| row.get(0),
        )
        .unwrap();
    db.execute("DROP INDEX idx_embedding_repair_checkpoints_status", [])
        .unwrap();
    drop(db);

    drop(WorkspaceOwner::open(file.path(), 4).expect("owner should repair missing v156 index"));
    let db = Connection::open(file.path()).unwrap();
    let index_count: i64 = db
        .query_row(
            "SELECT count(*) FROM sqlite_master WHERE type='index' AND name='idx_embedding_repair_checkpoints_status'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(index_count, 1);
    let history_after: (String, String) = db
        .query_row(
            "SELECT applied_at,checksum FROM schema_migrations WHERE version=156",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(history_after, history_before);
    let audit_after: i64 = db
        .query_row(
            "SELECT count(*) FROM schema_migrations_audit WHERE version=156",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(audit_after, audit_before + 1);
}

#[test]
fn owner_rejects_wrong_column_tail_index_without_mutating_history() {
    let file = NamedTempFile::new().unwrap();
    let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/ts_applied_157.sqlite");
    std::fs::copy(fixture, file.path()).unwrap();
    let db = Connection::open(file.path()).unwrap();
    let history_before: (String, String) = db
        .query_row(
            "SELECT applied_at,checksum FROM schema_migrations WHERE version=156",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    db.execute("DROP INDEX idx_embedding_repair_checkpoints_status", [])
        .unwrap();
    db.execute(
        "CREATE INDEX idx_embedding_repair_checkpoints_status ON embedding_repair_checkpoints(model)",
        [],
    )
    .unwrap();
    let audit_before: i64 = db
        .query_row(
            "SELECT count(*) FROM schema_migrations_audit WHERE version=156",
            [],
            |row| row.get(0),
        )
        .unwrap();
    drop(db);

    assert!(matches!(
        WorkspaceOwner::open(file.path(), 4),
        Err(CoreError::UnsupportedMigrationHistory(_))
    ));
    let db = Connection::open(file.path()).unwrap();
    let index_columns: Vec<String> = db
        .prepare("PRAGMA index_info(idx_embedding_repair_checkpoints_status)")
        .unwrap()
        .query_map([], |row| row.get(2))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(index_columns, vec!["model"]);
    let history_after: (String, String) = db
        .query_row(
            "SELECT applied_at,checksum FROM schema_migrations WHERE version=156",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(history_after, history_before);
    let audit_after: i64 = db
        .query_row(
            "SELECT count(*) FROM schema_migrations_audit WHERE version=156",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(audit_after, audit_before);
}

#[test]
fn owner_rejects_partial_future_history_without_applying_tail_schema() {
    let file = NamedTempFile::new().unwrap();
    let db = Connection::open(file.path()).unwrap();
    db.execute_batch(
        "CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL, checksum TEXT NOT NULL);
         INSERT INTO schema_migrations VALUES (157,'partial-history','wrong-checksum');",
    )
    .unwrap();
    drop(db);

    assert!(WorkspaceOwner::open(file.path(), 4).is_err());

    let db = Connection::open(file.path()).unwrap();
    let tables: i64 = db
        .query_row(
            "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='embedding_repair_progress'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(tables, 0);
}

#[test]
fn owner_rejects_invalid_migration_version_without_mutating_history() {
    let file = NamedTempFile::new().unwrap();
    let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/ts_applied_153.sqlite");
    std::fs::copy(fixture, file.path()).unwrap();
    let db = Connection::open(file.path()).unwrap();
    db.execute("DELETE FROM schema_migrations WHERE version=80", [])
        .unwrap();
    db.execute(
        "INSERT INTO schema_migrations(version,applied_at,checksum) VALUES(0,'2026-09-26','invalid')",
        [],
    )
    .unwrap();
    let history_before: Vec<(i64, String, String)> = db
        .prepare("SELECT version,applied_at,checksum FROM schema_migrations ORDER BY version")
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    drop(db);

    assert!(WorkspaceOwner::open(file.path(), 4).is_err());

    let db = Connection::open(file.path()).unwrap();
    let history_after: Vec<(i64, String, String)> = db
        .prepare("SELECT version,applied_at,checksum FROM schema_migrations ORDER BY version")
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(history_after, history_before);
}

#[test]
fn owner_preserves_explicit_non_default_workspace_when_project_disagrees() {
    let file = NamedTempFile::new().unwrap();
    let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/ts_applied_153.sqlite");
    std::fs::copy(fixture, file.path()).unwrap();
    let db = Connection::open(file.path()).unwrap();
    db.execute_batch(
        r#"ALTER TABLE documents ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default';
         ALTER TABLE documents ADD COLUMN metadata TEXT NOT NULL DEFAULT '{}';
         INSERT INTO documents(id,source_type,metadata_json,agent_id,project,workspace_id,metadata,created_at,updated_at) VALUES
             ('doc-explicit-scope','test','{"signet":{"project":"/repo/metadata"}}','agent-a','/repo/project','workspace-a','{}','2026-09-26T00:00:00.000Z','2026-09-26T00:00:00.000Z');"#,
    )
    .unwrap();
    drop(db);

    drop(WorkspaceOwner::open(file.path(), 4).expect("legacy workspace should be admitted"));
    let db = Connection::open(file.path()).unwrap();
    let scopes: (String, Option<String>, String) = db
        .query_row(
            "SELECT agent_id,project,workspace_id FROM documents WHERE id='doc-explicit-scope'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!(
        scopes,
        (
            "agent-a".into(),
            Some("/repo/project".into()),
            "workspace-a".into()
        )
    );
}

#[test]
fn owner_preserves_default_workspace_when_project_paths_differ() {
    let file = NamedTempFile::new().unwrap();
    let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/ts_applied_153.sqlite");
    std::fs::copy(fixture, file.path()).unwrap();
    let db = Connection::open(file.path()).unwrap();
    db.execute_batch(
        "ALTER TABLE documents ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default';
         ALTER TABLE documents ADD COLUMN metadata TEXT NOT NULL DEFAULT '{}';
         INSERT INTO documents(id,source_type,metadata_json,agent_id,project,workspace_id,metadata,created_at,updated_at) VALUES
             ('doc-scope','test','{\"signet\":{\"project\":\"/repo/meta\"}}','default','/repo/column','default','{}','2026-09-26T00:00:00.000Z','2026-09-26T00:00:00.000Z'),
             ('doc-metadata-only','test','{\"signet\":{\"project\":\"/repo/metadata-only\"}}','default',NULL,'default','{}','2026-09-26T00:00:00.000Z','2026-09-26T00:00:00.000Z');",
    )
    .unwrap();
    drop(db);

    drop(
        WorkspaceOwner::open(file.path(), 4)
            .expect("owner should preserve the materialized project scope"),
    );
    let db = Connection::open(file.path()).unwrap();
    let scopes: Vec<(String, Option<String>, String)> = db
        .prepare("SELECT id,project,workspace_id FROM documents WHERE id IN ('doc-scope','doc-metadata-only') ORDER BY id")
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(
        scopes,
        vec![
            ("doc-metadata-only".into(), None, "default".into()),
            (
                "doc-scope".into(),
                Some("/repo/column".into()),
                "default".into()
            ),
        ]
    );
}

#[test]
fn owner_replays_pinned_typescript_v80_missing_v79_gap_and_reopens_idempotently() {
    let file = NamedTempFile::new().unwrap();
    let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/ts_v80_missing_79.sqlite");
    std::fs::copy(fixture, file.path()).unwrap();
    let db = Connection::open(file.path()).unwrap();
    db.execute(
        "INSERT INTO documents(id,source_type,metadata_json,agent_id,project,created_at,updated_at) VALUES('v80-replay-seed','test',NULL,'fixture-agent','/sentinel','2026-09-26','2026-09-26')",
        [],
    )
    .unwrap();
    let seed: (String, String, Option<String>) = db
        .query_row(
            "SELECT id,agent_id,project FROM documents WHERE id='v80-replay-seed'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    let audit_before: i64 = db
        .query_row(
            "SELECT count(*) FROM schema_migrations_audit WHERE version=79",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(audit_before, 1);
    drop(db);
    drop(
        WorkspaceOwner::open(file.path(), 4)
            .expect("pinned TypeScript v80 exact v79 gap must replay"),
    );
    let db = Connection::open(file.path()).unwrap();
    assert_eq!(
        db.query_row(
            "SELECT checksum FROM schema_migrations WHERE version=79",
            [],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        "5939169c"
    );
    assert_eq!(
        db.query_row(
            "SELECT count(*) FROM schema_migrations_audit WHERE version=79",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        2
    );
    assert_eq!(
        db.query_row(
            "SELECT id,agent_id,project FROM documents WHERE id='v80-replay-seed'",
            [],
            |r| Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<String>>(2)?
            ))
        )
        .unwrap(),
        seed
    );
    assert_eq!(db.query_row("SELECT count(*) FROM sqlite_master WHERE type='index' AND name IN ('idx_transcript_capture_jobs_status','idx_transcript_capture_jobs_agent_session')", [], |r| r.get::<_,i64>(0)).unwrap(), 2);
    drop(db);
    drop(WorkspaceOwner::open(file.path(), 4).expect("second open must be idempotent"));
    let db = Connection::open(file.path()).unwrap();
    assert_eq!(
        db.query_row(
            "SELECT count(*) FROM schema_migrations_audit WHERE version=79",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        2
    );
}

#[test]
fn owner_replays_missing_v79_history_and_preserves_existing_audit_and_rows() {
    let file = NamedTempFile::new().unwrap();
    let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/ts_applied_153.sqlite");
    std::fs::copy(fixture, file.path()).unwrap();
    let db = Connection::open(file.path()).unwrap();
    let expected_checksum: String = db
        .query_row(
            "SELECT checksum FROM schema_migrations WHERE version=79",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let audit_before: i64 = db
        .query_row(
            "SELECT count(*) FROM schema_migrations_audit WHERE version=79",
            [],
            |r| r.get(0),
        )
        .unwrap();
    db.execute_batch("DELETE FROM schema_migrations WHERE version=79;")
        .unwrap();
    drop(db);
    drop(WorkspaceOwner::open(file.path(), 4).expect("owner should replay exactly missing v79"));
    let db = Connection::open(file.path()).unwrap();
    let restored: String = db
        .query_row(
            "SELECT checksum FROM schema_migrations WHERE version=79",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(restored, expected_checksum);
    let audit_after: i64 = db
        .query_row(
            "SELECT count(*) FROM schema_migrations_audit WHERE version=79",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(audit_after, audit_before + 1);
    assert!(db
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='transcript_capture_jobs'",
            [],
            |_| Ok(())
        )
        .is_ok());
    assert!(db.query_row("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_transcript_capture_jobs_status'", [], |_| Ok(())).is_ok());
    assert!(db.query_row("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_transcript_capture_jobs_agent_session'", [], |_| Ok(())).is_ok());
    drop(db);
    drop(WorkspaceOwner::open(file.path(), 4).expect("reopen should be idempotent"));
    let db = Connection::open(file.path()).unwrap();
    let audit_reopened: i64 = db
        .query_row(
            "SELECT count(*) FROM schema_migrations_audit WHERE version=79",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(audit_reopened, audit_after);
}

#[test]
fn owner_restores_typescript_v2_history_after_legacy_native_backfill() {
    let file = NamedTempFile::new().unwrap();
    let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/ts_applied_153.sqlite");
    std::fs::copy(fixture, file.path()).unwrap();
    let db = Connection::open(file.path()).unwrap();
    let canonical_history: (String, String) = db
        .query_row(
            "SELECT applied_at,checksum FROM schema_migrations WHERE version=2",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    let canonical_audit: Vec<(String, String)> = db
        .prepare(
            "SELECT applied_at,checksum FROM schema_migrations_audit WHERE version=2 ORDER BY id",
        )
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    db.execute_batch(
        "INSERT INTO documents(id,source_type,raw_content,metadata_json,agent_id,project,created_at,updated_at)
         VALUES ('legacy-marker-document','filesystem','preserve body',
                 '{\"signet\":{\"project\":\"preserved-project\"}}',
                 'default','preserved-project','2026-09-26T00:00:00.000Z','2026-09-26T00:00:00.000Z');
         ALTER TABLE documents ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default';
         ALTER TABLE documents ADD COLUMN metadata TEXT NOT NULL DEFAULT '{}';
         UPDATE schema_migrations SET applied_at='2026-09-26 11:00:00',checksum='document-workspace-backfill-v1' WHERE version=2;",
    )
    .unwrap();
    drop(db);

    drop(
        WorkspaceOwner::open(file.path(), 4)
            .expect("legacy marker should be repaired transactionally"),
    );
    let db = Connection::open(file.path()).unwrap();
    let restored_history: (String, String) = db
        .query_row(
            "SELECT applied_at,checksum FROM schema_migrations WHERE version=2",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(restored_history, canonical_history);
    let restored_audit: Vec<(String, String)> = db
        .prepare(
            "SELECT applied_at,checksum FROM schema_migrations_audit WHERE version=2 ORDER BY id",
        )
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(restored_audit, canonical_audit);
    let document: (String, String, String) = db
        .query_row(
            "SELECT content,metadata,workspace_id FROM documents WHERE id='legacy-marker-document'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!(
        document,
        (
            "preserve body".into(),
            "{\"signet\":{\"project\":\"preserved-project\"}}".into(),
            "default".into(),
        )
    );
}

#[test]
fn owner_repairs_a_missing_155_history_row_before_recorded_156_and_157() {
    let file = NamedTempFile::new().unwrap();
    let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/ts_applied_157.sqlite");
    std::fs::copy(fixture, file.path()).unwrap();

    let db = Connection::open(file.path()).unwrap();
    let audit_count_before: i64 = db
        .query_row(
            "SELECT count(*) FROM schema_migrations_audit WHERE version=157",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(audit_count_before, 1);
    db.execute("DROP TABLE embedding_repair_progress", [])
        .unwrap();
    drop(db);

    drop(
        WorkspaceOwner::open(file.path(), 4)
            .expect("owner should repair the missing artifact claimed by migration 157"),
    );

    let db = Connection::open(file.path()).unwrap();
    let progress_rows: i64 = db
        .query_row(
            "SELECT count(*) FROM embedding_repair_progress",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(progress_rows, 0);
    let audit_count_after: i64 = db
        .query_row(
            "SELECT count(*) FROM schema_migrations_audit WHERE version=157",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(audit_count_after, audit_count_before + 1);
    let migration: (String, String) = db
        .query_row(
            "SELECT applied_at,checksum FROM schema_migrations WHERE version=157",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(migration.1, "-2d144030");
}

#[test]
fn owner_repairs_a_missing_156_history_row_before_recorded_157_and_reopens() {
    let file = NamedTempFile::new().unwrap();
    let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/ts_applied_157.sqlite");
    std::fs::copy(fixture, file.path()).unwrap();

    let db = Connection::open(file.path()).unwrap();
    let audit_before: i64 = db
        .query_row(
            "SELECT count(*) FROM schema_migrations_audit WHERE version=156",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let applied_at_157_before: String = db
        .query_row(
            "SELECT applied_at FROM schema_migrations WHERE version=157",
            [],
            |row| row.get(0),
        )
        .unwrap();
    db.execute("DELETE FROM schema_migrations WHERE version=156", [])
        .unwrap();
    drop(db);

    drop(
        WorkspaceOwner::open(file.path(), 4)
            .expect("missing 156 history should be filled before the existing 157 row"),
    );
    drop(WorkspaceOwner::open(file.path(), 4).expect("repaired history should reopen"));
    verify_fixture_rows(file.path());

    let db = Connection::open(file.path()).unwrap();
    let applied_versions: Vec<(i64, String)> = db
        .prepare(
            "SELECT version,checksum FROM schema_migrations WHERE version>=153 ORDER BY version",
        )
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(
        applied_versions,
        vec![
            (153, "96fd94a".into()),
            (154, "-2c048e44".into()),
            (155, "1f938a32".into()),
            (156, "334babc9".into()),
            (157, "-2d144030".into()),
        ]
    );
    let audit_after: i64 = db
        .query_row(
            "SELECT count(*) FROM schema_migrations_audit WHERE version=156",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(audit_after, audit_before + 1);
    let applied_at_157_after: String = db
        .query_row(
            "SELECT applied_at FROM schema_migrations WHERE version=157",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(applied_at_157_after, applied_at_157_before);
}

#[test]
fn owner_repairs_a_recorded_156_migration_when_its_table_is_missing() {
    let file = NamedTempFile::new().unwrap();
    let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/ts_applied_157.sqlite");
    std::fs::copy(fixture, file.path()).unwrap();

    let db = Connection::open(file.path()).unwrap();
    let audit_before: Vec<i64> = db
        .prepare(
            "SELECT version FROM schema_migrations_audit WHERE version IN (156,157) ORDER BY version",
        )
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    db.execute("DROP TABLE embedding_repair_checkpoints", [])
        .unwrap();
    drop(db);

    drop(
        WorkspaceOwner::open(file.path(), 4)
            .expect("recorded migration 156 should recreate its missing table"),
    );

    let db = Connection::open(file.path()).unwrap();
    let artifacts: Vec<(String, String)> = db
        .prepare(
            "SELECT type,name FROM sqlite_master WHERE name IN ('embedding_repair_checkpoints','embedding_repair_progress','idx_embedding_repair_checkpoints_status') ORDER BY type,name",
        )
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(
        artifacts,
        vec![
            (
                "index".into(),
                "idx_embedding_repair_checkpoints_status".into()
            ),
            ("table".into(), "embedding_repair_checkpoints".into()),
            ("table".into(), "embedding_repair_progress".into())
        ]
    );
    let checkpoint_rows: i64 = db
        .query_row(
            "SELECT count(*) FROM embedding_repair_checkpoints",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(checkpoint_rows, 0);
    let progress: (String, Option<String>, i64, Option<String>, String) = db
        .query_row(
            "SELECT agent_id,last_completed_at,last_affected,last_error,updated_at FROM embedding_repair_progress WHERE agent_id='fixture-agent'",
            [],
            |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?)),
        )
        .unwrap();
    assert_eq!(
        progress,
        (
            "fixture-agent".into(),
            Some("2026-09-26T10:00:00.000Z".into()),
            8,
            Some("preserve progress".into()),
            "2026-09-26T11:45:00.000Z".into()
        )
    );
    let audit_after: Vec<i64> = db
        .prepare(
            "SELECT version FROM schema_migrations_audit WHERE version IN (156,157) ORDER BY version",
        )
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(audit_after, vec![156, 156, 157, 157]);
    assert_eq!(audit_before, vec![156, 157]);
}

#[test]
fn failed_embedding_migration_rolls_back_schema_and_history_changes() {
    let file = NamedTempFile::new().unwrap();
    let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/ts_applied_157.sqlite");
    std::fs::copy(fixture, file.path()).unwrap();

    let db = Connection::open(file.path()).unwrap();
    let audit_before: i64 = db
        .query_row(
            "SELECT count(*) FROM schema_migrations_audit WHERE version=157",
            [],
            |row| row.get(0),
        )
        .unwrap();
    db.execute_batch(
        "CREATE TABLE embedding_repair_checkpoints_legacy (
             checkpoint_id TEXT PRIMARY KEY,
             agent_id TEXT NOT NULL CHECK (length(trim(agent_id)) > 0),
             model TEXT NOT NULL CHECK (length(trim(model)) > 0),
             status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'complete', 'failed')),
             batches INTEGER NOT NULL DEFAULT 0 CHECK (batches >= 0),
             selected INTEGER NOT NULL DEFAULT 0 CHECK (selected >= 0),
             written INTEGER NOT NULL DEFAULT 0 CHECK (written >= 0),
             failed INTEGER NOT NULL DEFAULT 0 CHECK (failed >= 0),
             stale INTEGER NOT NULL DEFAULT 0 CHECK (stale >= 0),
             cross_agent_hash_conflicts INTEGER NOT NULL DEFAULT 0 CHECK (cross_agent_hash_conflicts >= 0),
             last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
         );
         INSERT INTO embedding_repair_checkpoints_legacy
             SELECT checkpoint_id,agent_id,model,status,batches,selected,written,failed,stale,cross_agent_hash_conflicts,last_error,created_at,updated_at
             FROM embedding_repair_checkpoints;
         DROP TABLE embedding_repair_checkpoints;
         ALTER TABLE embedding_repair_checkpoints_legacy RENAME TO embedding_repair_checkpoints;
         DROP TABLE embedding_repair_progress;
         CREATE VIEW embedding_repair_progress AS
             SELECT CAST(NULL AS TEXT) AS agent_id, CAST(NULL AS TEXT) AS last_completed_at,
                    CAST(0 AS INTEGER) AS last_affected, CAST(NULL AS TEXT) AS last_error,
                    CAST('' AS TEXT) AS updated_at WHERE 0;
         DELETE FROM schema_migrations WHERE version=157;",
    )
    .unwrap();
    drop(db);

    assert!(WorkspaceOwner::open(file.path(), 4).is_err());

    let db = Connection::open(file.path()).unwrap();
    let profile_column: i64 = db
        .query_row(
            "SELECT count(*) FROM pragma_table_info('embedding_repair_checkpoints') WHERE name='profile_fingerprint'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(profile_column, 0);
    let status_index: i64 = db
        .query_row(
            "SELECT count(*) FROM sqlite_master WHERE type='index' AND name='idx_embedding_repair_checkpoints_status'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(status_index, 0);
    let progress_view: i64 = db
        .query_row(
            "SELECT count(*) FROM sqlite_master WHERE type='view' AND name='embedding_repair_progress'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(progress_view, 1);
    let version_157: i64 = db
        .query_row(
            "SELECT count(*) FROM schema_migrations WHERE version=157",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(version_157, 0);
    let audit_after: i64 = db
        .query_row(
            "SELECT count(*) FROM schema_migrations_audit WHERE version=157",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(audit_after, audit_before);
    let preserved_checkpoint: (String, String) = db
        .query_row(
            "SELECT agent_id,model FROM embedding_repair_checkpoints WHERE checkpoint_id='fixture-checkpoint'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(
        preserved_checkpoint,
        ("fixture-agent".into(), "fixture-model".into())
    );
}

#[test]
fn owner_repairs_missing_project_without_rewriting_materialized_agent_or_history() {
    let file = NamedTempFile::new().unwrap();
    let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/ts_applied_153.sqlite");
    std::fs::copy(fixture, file.path()).unwrap();
    let db = Connection::open(file.path()).unwrap();
    let history_before: (String, String) = db
        .query_row(
            "SELECT applied_at,checksum FROM schema_migrations WHERE version=80",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    let audit_before: i64 = db
        .query_row(
            "SELECT count(*) FROM schema_migrations_audit WHERE version=80",
            [],
            |row| row.get(0),
        )
        .unwrap();
    db.execute_batch(
        "DROP INDEX idx_documents_agent_project;
         DROP INDEX idx_documents_source_scope;
         ALTER TABLE documents DROP COLUMN project;
         INSERT INTO documents(id,source_type,metadata_json,agent_id,created_at,updated_at) VALUES
             ('doc-project-repair','test','{\"signet\":{\"agentId\":\"metadata-agent\",\"project\":\"/repo/new-project\"}}','stored-agent','2026-09-26T00:00:00.000Z','2026-09-26T00:00:00.000Z');",
    )
    .unwrap();
    drop(db);

    drop(
        WorkspaceOwner::open(file.path(), 4)
            .expect("owner should repair only the missing project column"),
    );
    let db = Connection::open(file.path()).unwrap();
    let row: (String, Option<String>) = db
        .query_row(
            "SELECT agent_id,project FROM documents WHERE id='doc-project-repair'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(
        row,
        ("stored-agent".into(), Some("/repo/new-project".into()))
    );
    let history_after: (String, String) = db
        .query_row(
            "SELECT applied_at,checksum FROM schema_migrations WHERE version=80",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(history_after, history_before);
    let audit_after: i64 = db
        .query_row(
            "SELECT count(*) FROM schema_migrations_audit WHERE version=80",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(audit_after, audit_before);
}

#[test]
fn owner_repairs_missing_agent_without_rewriting_materialized_project_or_history() {
    let file = NamedTempFile::new().unwrap();
    let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/ts_applied_153.sqlite");
    std::fs::copy(fixture, file.path()).unwrap();
    let db = Connection::open(file.path()).unwrap();
    let history_before: (String, String) = db
        .query_row(
            "SELECT applied_at,checksum FROM schema_migrations WHERE version=80",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    let audit_before: i64 = db
        .query_row(
            "SELECT count(*) FROM schema_migrations_audit WHERE version=80",
            [],
            |row| row.get(0),
        )
        .unwrap();
    db.execute_batch(
        "DROP INDEX idx_documents_agent_project;
         DROP INDEX idx_documents_source_scope;
         ALTER TABLE documents DROP COLUMN agent_id;
         INSERT INTO documents(id,source_type,metadata_json,project,created_at,updated_at) VALUES
             ('doc-agent-repair','test','{\"signet\":{\"agentId\":\"metadata-agent\",\"project\":\"/repo/new-project\"}}','stored-project','2026-09-26T00:00:00.000Z','2026-09-26T00:00:00.000Z');",
    )
    .unwrap();
    drop(db);

    drop(
        WorkspaceOwner::open(file.path(), 4)
            .expect("owner should repair only the missing agent_id column"),
    );
    let db = Connection::open(file.path()).unwrap();
    let row: (String, Option<String>) = db
        .query_row(
            "SELECT agent_id,project FROM documents WHERE id='doc-agent-repair'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(
        row,
        ("metadata-agent".into(), Some("stored-project".into()))
    );
    let history_after: (String, String) = db
        .query_row(
            "SELECT applied_at,checksum FROM schema_migrations WHERE version=80",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(history_after, history_before);
    let audit_after: i64 = db
        .query_row(
            "SELECT count(*) FROM schema_migrations_audit WHERE version=80",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(audit_after, audit_before);
}

#[test]
fn incomplete_scope_marker_is_backfilled_once_and_then_explicit_default_is_preserved() {
    let file = NamedTempFile::new().unwrap();
    let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/ts_applied_153.sqlite");
    std::fs::copy(fixture, file.path()).unwrap();
    let db = Connection::open(file.path()).unwrap();
    db.execute_batch(
        "ALTER TABLE documents ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default';
         ALTER TABLE documents ADD COLUMN metadata TEXT NOT NULL DEFAULT '{}';
         INSERT INTO documents(id,source_type,metadata_json,agent_id,project,workspace_id,metadata,created_at,updated_at) VALUES
          ('legacy-project-scope','test','{\"signet\":{\"project\":\"/repo/legacy\"}}','default','/repo/legacy','default','{}','2026-09-26','2026-09-26');
         INSERT INTO documents(id,source_type,metadata_json,agent_id,project,workspace_id,metadata,created_at,updated_at) VALUES
          ('explicit-default-scope','test','{\"signet\":{\"project\":\"/repo/must-not-override\"}}','agent-a',NULL,'default','{}','2026-09-26','2026-09-26');",
    ).unwrap();
    drop(db);

    drop(WorkspaceOwner::open(file.path(), 4).expect("legacy workspace admission"));
    let db = Connection::open(file.path()).unwrap();
    let first: (String, String) = db.query_row(
        "SELECT id,workspace_id FROM documents WHERE id IN ('legacy-project-scope','explicit-default-scope') ORDER BY id LIMIT 1",
        [], |r| Ok((r.get(0)?, r.get(1)?)),
    ).unwrap();
    assert_eq!(first, ("explicit-default-scope".into(), "default".into()));
    let legacy: String = db
        .query_row(
            "SELECT workspace_id FROM documents WHERE id='legacy-project-scope'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(legacy, "default");
    db.execute(
        "UPDATE documents SET project='/repo/late-edit' WHERE id='explicit-default-scope'",
        [],
    )
    .unwrap();
    drop(db);

    drop(
        WorkspaceOwner::open(file.path(), 4)
            .expect("reopen must not reinterpret a materialized default"),
    );
    let db = Connection::open(file.path()).unwrap();
    let explicit: String = db
        .query_row(
            "SELECT workspace_id FROM documents WHERE id='explicit-default-scope'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(explicit, "default");
}

#[test]
fn partial_unrelated_history_does_not_authorize_tail_migration_repair() {
    let file = NamedTempFile::new().unwrap();
    let db = Connection::open(file.path()).unwrap();
    db.execute_batch(
        "CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL, checksum TEXT NOT NULL);
         INSERT INTO schema_migrations VALUES(157,'now','wrong-checksum');",
    ).unwrap();
    drop(db);
    assert!(WorkspaceOwner::open(file.path(), 4).is_err());
}
