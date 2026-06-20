//! Misc/auth parity tests for database contracts shared with the TypeScript daemon.
//!
//! These tests cite the TypeScript source lines they replay because the Rust
//! daemon consumes the same SQLite workspace and must preserve the storage
//! contract even where route logic lives in `signet-daemon`.

use std::collections::BTreeSet;

use rusqlite::{Connection, params};

fn table_columns(conn: &Connection, table: &str) -> BTreeSet<String> {
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info({table})"))
        .expect("table info statement");
    stmt.query_map([], |row| row.get::<_, String>(1))
        .expect("table info rows")
        .map(|row| row.expect("column name"))
        .collect()
}

#[test]
fn api_keys_schema_matches_ts_metadata_only_store_contract() {
    // TS parity: platform/daemon/src/auth/api-keys.test.ts:9-27 creates the
    // api_keys table; lines 60-80 assert key creation stores metadata only and
    // verification relies on key_hash, prefix, role, scope, and permissions.
    let conn = Connection::open_in_memory().expect("open in-memory db");
    signet_core::migrations::run(&conn).expect("run migrations");

    let columns = table_columns(&conn, "api_keys");
    for required in [
        "id",
        "prefix",
        "name",
        "key_hash",
        "role",
        "scope_json",
        "permissions_json",
        "connector",
        "harness",
        "agent_id",
        "allowed_projects_json",
        "created_at",
        "last_used_at",
        "revoked_at",
        "expires_at",
    ] {
        assert!(columns.contains(required), "missing api_keys.{required}");
    }
    assert!(
        !columns.contains("key"),
        "raw API keys must never be persisted"
    );

    conn.execute(
        "INSERT INTO api_keys
         (id, prefix, name, key_hash, role, scope_json, permissions_json,
          connector, harness, agent_id, allowed_projects_json, created_at)
         VALUES (?1, ?2, ?3, ?4, 'agent', ?5, ?6, 'pi', 'pi', 'agent-pi', ?7, ?8)",
        params![
            "key-1",
            "abc123",
            "work laptop pi",
            "scrypt:test-hash-not-raw-secret",
            r#"{"agent":"agent-pi"}"#,
            r#"["recall","documents"]"#,
            r#"["/workspace/a"]"#,
            "2026-01-01T00:00:00Z",
        ],
    )
    .expect("insert api key metadata");

    let row: (String, String, String, Option<String>) = conn
        .query_row(
            "SELECT key_hash, scope_json, permissions_json, last_used_at
             FROM api_keys WHERE prefix = 'abc123'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .expect("read api key metadata");
    assert!(row.0.starts_with("scrypt:"));
    assert!(!row.0.contains("sig_sk_"));
    assert_eq!(row.1, r#"{"agent":"agent-pi"}"#);
    assert_eq!(row.2, r#"["recall","documents"]"#);
    assert!(row.3.is_none());
}

#[test]
fn api_key_revocation_and_lookup_indexes_exist_for_auth_routes() {
    // TS parity: platform/daemon/src/auth/api-keys.test.ts:97-106 revokes by
    // prefix and expects subsequent verification to fail; the Rust schema must
    // keep the prefix/active indexes that make those route checks reliable.
    let conn = Connection::open_in_memory().expect("open in-memory db");
    signet_core::migrations::run(&conn).expect("run migrations");

    let indexes: BTreeSet<String> = conn
        .prepare("PRAGMA index_list(api_keys)")
        .expect("index list statement")
        .query_map([], |row| row.get::<_, String>(1))
        .expect("index list rows")
        .map(|row| row.expect("index name"))
        .collect();

    assert!(indexes.contains("sqlite_autoindex_api_keys_1"));
    assert!(indexes.contains("sqlite_autoindex_api_keys_2"));
    assert!(indexes.contains("idx_api_keys_prefix"));
    assert!(indexes.contains("idx_api_keys_active"));
    assert!(indexes.contains("idx_api_keys_connector"));

    conn.execute(
        "INSERT INTO api_keys (id, prefix, name, key_hash, created_at)
         VALUES ('key-revoke', 'deadbeef', 'remote codex', 'scrypt:hash', '2026-01-01T00:00:00Z')",
        [],
    )
    .expect("insert revocable api key");
    conn.execute(
        "UPDATE api_keys SET revoked_at = COALESCE(revoked_at, ?1) WHERE prefix = ?2",
        params!["2026-01-02T00:00:00Z", "deadbeef"],
    )
    .expect("revoke api key");

    let revoked_at: String = conn
        .query_row(
            "SELECT revoked_at FROM api_keys WHERE prefix = 'deadbeef'",
            [],
            |row| row.get(0),
        )
        .expect("read revoked_at");
    assert_eq!(revoked_at, "2026-01-02T00:00:00Z");
}
