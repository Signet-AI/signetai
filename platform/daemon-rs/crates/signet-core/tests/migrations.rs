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
