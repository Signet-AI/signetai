use rusqlite::Connection;

#[test]
fn repairs_partial_summary_jobs_columns_when_migration_is_already_stamped() {
    let conn = Connection::open_in_memory().expect("open in-memory db");
    signet_core::migrations::run(&conn).expect("initial migrations run");
    conn.execute_batch(
        "DROP TABLE summary_jobs;
         CREATE TABLE summary_jobs (
            id TEXT PRIMARY KEY,
            session_key TEXT,
            harness TEXT NOT NULL,
            project TEXT,
            transcript TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            result TEXT,
            attempts INTEGER DEFAULT 0,
            max_attempts INTEGER DEFAULT 3,
            created_at TEXT NOT NULL,
            completed_at TEXT,
            error TEXT,
            agent_id TEXT NOT NULL DEFAULT 'default',
            session_id TEXT,
            trigger TEXT NOT NULL DEFAULT 'session_end',
            captured_at TEXT,
            started_at TEXT,
            ended_at TEXT
         );
         INSERT INTO summary_jobs
            (id, session_key, harness, transcript, status, created_at)
         VALUES
            ('job-partial', 'session-a', 'opencode', 'user: hi', 'pending', '2026-06-01T00:00:00Z');",
    )
    .expect("simulate partially applied migration 37");

    signet_core::migrations::run(&conn).expect("rerun migrations repairs summary_jobs columns");

    let mut stmt = conn
        .prepare("PRAGMA table_info(summary_jobs)")
        .expect("prepare table_info");
    let columns: Vec<String> = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .expect("query table_info")
        .collect::<Result<Vec<_>, _>>()
        .expect("collect table_info");
    for column in ["leased_at", "updated_at", "failed_at"] {
        assert!(
            columns.iter().any(|name| name == column),
            "summary_jobs should repair missing {column}"
        );
    }

    let updated_at: String = conn
        .query_row(
            "SELECT updated_at FROM summary_jobs WHERE id = 'job-partial'",
            [],
            |row| row.get(0),
        )
        .expect("read backfilled updated_at");
    assert_eq!(updated_at, "2026-06-01T00:00:00Z");

    conn.execute(
        "UPDATE summary_jobs
         SET status = 'leased',
             leased_at = '2026-06-01T00:01:00Z',
             updated_at = '2026-06-01T00:01:00Z',
             attempts = attempts + 1
         WHERE id = 'job-partial'",
        [],
    )
    .expect("leased summary job update should succeed after repair");
}

#[test]
fn adds_harness_columns_and_dedupe_index_to_skill_invocations() {
    let conn = Connection::open_in_memory().expect("open in-memory db");
    signet_core::migrations::run(&conn).expect("migrations run");

    let mut stmt = conn
        .prepare("PRAGMA table_info(skill_invocations)")
        .expect("prepare table_info");
    let columns: Vec<String> = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .expect("query table_info")
        .collect::<Result<Vec<_>, _>>()
        .expect("collect table_info");
    for column in [
        "harness",
        "session_id",
        "tool_use_id",
        "cwd",
        "origin",
        "args",
    ] {
        assert!(
            columns.iter().any(|name| name == column),
            "skill_invocations missing {column}"
        );
    }

    let index_exists: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_skill_inv_dedupe')",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map(|n| n != 0)
        .expect("query dedupe index");
    assert!(index_exists, "idx_skill_inv_dedupe should exist");

    // Partial-unique dedupe: the same (agent_id, harness, session_id, tool_use_id) inserts once.
    let insert = "INSERT OR IGNORE INTO skill_invocations
        (id, skill_name, agent_id, source, latency_ms, success, created_at, harness, session_id, tool_use_id)
        VALUES (?1, 'caveman', ?2, 'agent', 0, 1, '2026-06-01T00:00:00Z', 'claude-code', 's1', 't1')";
    conn.execute(insert, ("row-a", "agent-a"))
        .expect("first insert");
    conn.execute(insert, ("row-b", "agent-a"))
        .expect("second insert ignored");
    conn.execute(insert, ("row-c", "agent-b"))
        .expect("second agent insert succeeds");
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM skill_invocations", [], |row| {
            row.get(0)
        })
        .expect("count rows");
    assert_eq!(
        count, 2,
        "dedupe should drop repeated harness invocations per agent"
    );
}

#[test]
fn backfills_document_scope_when_stamped_columns_were_missing() {
    let conn = Connection::open_in_memory().expect("open in-memory db");
    signet_core::migrations::run(&conn).expect("migrations run");
    conn.execute(
        "INSERT INTO documents (id, source_type, metadata_json, created_at, updated_at)
         VALUES ('doc-collision', 'obsidian', '{\"signet\":{\"agentId\":\"agent-meta\",\"project\":\"/meta\"}}', '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z')",
        [],
    )
    .expect("insert collision document");
    conn.execute_batch(
        "DROP INDEX IF EXISTS idx_documents_agent_project;
         DROP INDEX IF EXISTS idx_documents_source_scope;
         ALTER TABLE documents DROP COLUMN agent_id;
         ALTER TABLE documents DROP COLUMN project;",
    )
    .expect("simulate stamped TS v80 without document scope columns");

    signet_core::migrations::run(&conn)
        .expect("rerun migrations repairs missing document scope columns");

    let scope = conn
        .query_row(
            "SELECT agent_id, project FROM documents WHERE id = 'doc-collision'",
            [],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .expect("read repaired document scope");
    assert_eq!(scope.0, "agent-meta");
    assert_eq!(scope.1, "/meta");
}

#[test]
fn preserves_existing_document_scope_when_one_column_was_missing() {
    let conn = Connection::open_in_memory().expect("open in-memory db");
    signet_core::migrations::run(&conn).expect("migrations run");
    conn.execute(
        "INSERT INTO documents (id, source_type, metadata_json, agent_id, project, created_at, updated_at)
         VALUES ('doc-partial', 'obsidian', '{\"signet\":{\"agentId\":\"metadata-agent\",\"project\":\"/metadata\"}}', 'corrected-agent', '/corrected', '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z')",
        [],
    )
    .expect("insert partial document");
    conn.execute_batch(
        "DROP INDEX IF EXISTS idx_documents_agent_project;
         DROP INDEX IF EXISTS idx_documents_source_scope;
         ALTER TABLE documents DROP COLUMN project;",
    )
    .expect("simulate partial document scope repair");

    signet_core::migrations::run(&conn).expect("rerun migrations repairs missing project only");

    let scope = conn
        .query_row(
            "SELECT agent_id, project FROM documents WHERE id = 'doc-partial'",
            [],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .expect("read repaired partial document scope");
    assert_eq!(scope.0, "corrected-agent");
    assert_eq!(scope.1, "/metadata");
}

#[test]
fn repairs_memory_lifecycle_lineage_and_stamps_ts_versions() {
    let conn = Connection::open_in_memory().expect("open in-memory db");
    signet_core::migrations::run(&conn).expect("migrations run");

    for version in [79_i64, 81, 83] {
        let stamped: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version = ?1)",
                [version],
                |row| row.get::<_, i64>(0),
            )
            .map(|n| n != 0)
            .expect("query stamped TS version");
        assert!(
            stamped,
            "TS migration {version} should be stamped after parity repair"
        );
    }

    let transcript_jobs_exists: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='transcript_capture_jobs')",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map(|n| n != 0)
        .expect("query transcript capture table");
    assert!(
        transcript_jobs_exists,
        "transcript_capture_jobs should exist"
    );

    for column in ["superseded_by", "superseded_at", "superseded_reason"] {
        let exists: bool = conn
            .prepare("PRAGMA table_info(memories)")
            .expect("prepare table_info")
            .query_map([], |row| row.get::<_, String>(1))
            .expect("query table_info")
            .filter_map(Result::ok)
            .any(|name| name == column);
        assert!(exists, "memories missing {column}");
    }

    conn.execute(
        "INSERT INTO entities (id, name, canonical_name, entity_type, agent_id, created_at, updated_at)
         VALUES ('entity-source', 'Source', 'source', 'concept', 'agent-a', '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z')",
        [],
    )
    .expect("insert source entity");
    conn.execute(
        "INSERT INTO entities (id, name, canonical_name, entity_type, agent_id, created_at, updated_at)
         VALUES ('entity-target', 'Target', 'target', 'concept', 'agent-a', '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z')",
        [],
    )
    .expect("insert target entity");
    conn.execute(
        "INSERT INTO entities (id, name, canonical_name, entity_type, agent_id, created_at, updated_at)
         VALUES ('entity-other-agent', 'Other', 'other', 'concept', 'agent-b', '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z')",
        [],
    )
    .expect("insert other-agent entity");
    conn.execute(
        "INSERT INTO relations (id, source_entity_id, target_entity_id, relation_type, strength, created_at)
         VALUES ('legacy-rel', 'entity-source', 'entity-target', 'unknown_local_type', 0.8, '2026-07-01T00:00:01Z')",
        [],
    )
    .expect("insert legacy relation");
    conn.execute(
        "INSERT INTO relations (id, source_entity_id, target_entity_id, relation_type, strength, created_at)
         VALUES ('cross-agent-rel', 'entity-source', 'entity-other-agent', 'related_to', 0.9, '2026-07-01T00:00:02Z')",
        [],
    )
    .expect("insert cross-agent relation");
    conn.execute(
        "INSERT INTO documents (id, source_type, metadata_json, agent_id, project, created_at, updated_at)
         VALUES ('doc-guard', 'obsidian', '{\"signet\":{\"agentId\":\"metadata-agent\",\"project\":\"/old\"}}', 'corrected-agent', '/corrected', '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z')",
        [],
    )
    .expect("insert guarded document");
    conn.execute(
        "INSERT INTO memories (id, content, content_hash, type, source_type, visibility, agent_id, created_at, updated_at, updated_by)
         VALUES ('doc-memory-guard', 'chunk', 'doc-hash-guard', 'document_chunk', 'document', 'global', 'corrected-agent', '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z', 'test')",
        [],
    )
    .expect("insert guarded document memory");
    conn.execute(
        "INSERT INTO document_memories (document_id, memory_id)
         VALUES ('doc-guard', 'doc-memory-guard')",
        [],
    )
    .expect("link guarded document memory");
    conn.execute(
        "INSERT INTO documents (id, source_type, metadata_json, agent_id, project, created_at, updated_at)
         VALUES ('doc-placeholder', 'obsidian', '{\"signet\":{\"agentId\":\"metadata-agent\",\"project\":\"/metadata\"}}', 'default', NULL, '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z')",
        [],
    )
    .expect("insert placeholder document scope");
    conn.execute_batch(
        "DROP INDEX IF EXISTS idx_documents_agent_project;
         DROP INDEX IF EXISTS idx_documents_source_scope;
         DELETE FROM schema_migrations WHERE version = 83;",
    )
    .expect("drop document indexes and mark v83 pending for repair");

    signet_core::migrations::run(&conn).expect("rerun migrations backfills legacy relation");
    signet_core::migrations::run(&conn).expect("relation backfill remains idempotent");

    let row = conn
        .query_row(
            "SELECT agent_id, dependency_type, strength, reason, source_id, source_kind, status
             FROM entity_dependencies WHERE id = 'relation:legacy-rel'",
            [],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, f64>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                ))
            },
        )
        .expect("read backfilled dependency");
    assert_eq!(row.0, "agent-a");
    assert_eq!(row.1, "related_to");
    assert_eq!(row.2, 0.8);
    assert_eq!(row.3, "legacy relation backfill: unknown_local_type");
    assert_eq!(row.4, "legacy-rel");
    assert_eq!(row.5, "relation");
    assert_eq!(row.6, "active");

    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM entity_dependencies WHERE id = 'relation:legacy-rel'",
            [],
            |row| row.get(0),
        )
        .expect("count backfilled dependency rows");
    assert_eq!(count, 1, "legacy relation backfill should be idempotent");

    let cross_agent_exists: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM entity_dependencies WHERE id = 'relation:cross-agent-rel')",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map(|n| n != 0)
        .expect("query skipped cross-agent relation");
    assert!(
        !cross_agent_exists,
        "cross-agent relation should not be backfilled"
    );

    let guarded_document = conn
        .query_row(
            "SELECT agent_id, project FROM documents WHERE id = 'doc-guard'",
            [],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .expect("read guarded document");
    assert_eq!(guarded_document.0, "corrected-agent");
    assert_eq!(guarded_document.1, "/corrected");

    let repaired_document_indexes: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master
             WHERE type = 'index'
               AND name IN ('idx_documents_agent_project', 'idx_documents_source_scope')",
            [],
            |row| row.get(0),
        )
        .expect("count repaired document indexes");
    assert_eq!(repaired_document_indexes, 2);

    let document_memory_visibility: String = conn
        .query_row(
            "SELECT visibility FROM memories WHERE id = 'doc-memory-guard'",
            [],
            |row| row.get(0),
        )
        .expect("read guarded document memory visibility");
    assert_eq!(document_memory_visibility, "private");

    let placeholder_document = conn
        .query_row(
            "SELECT agent_id, project FROM documents WHERE id = 'doc-placeholder'",
            [],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .expect("read repaired placeholder document scope");
    assert_eq!(placeholder_document.0, "metadata-agent");
    assert_eq!(placeholder_document.1, "/metadata");

    conn.execute(
        "DELETE FROM entity_dependencies WHERE id = 'relation:legacy-rel'",
        [],
    )
    .expect("delete backfilled dependency after v83 stamp");
    signet_core::migrations::run(&conn)
        .expect("rerun migrations should not repeat v83 data backfill");
    let recreated_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM entity_dependencies WHERE id = 'relation:legacy-rel'",
            [],
            |row| row.get(0),
        )
        .expect("count deleted backfilled dependency rows");
    assert_eq!(recreated_count, 0, "v83 data backfill should be one-shot");
}
