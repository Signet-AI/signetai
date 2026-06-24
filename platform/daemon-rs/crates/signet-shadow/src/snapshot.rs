//! Internal SQLite state snapshots for shadow comparison.
//!
//! Snapshots are intentionally read-only and route-scoped. They canonicalize
//! rows into JSON objects so the response comparator can reuse the same parity
//! primitives for DB state.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::time::Duration;

use rusqlite::{Connection, OpenFlags, types::ValueRef};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TableSpec {
    pub name: String,
    pub key_columns: Vec<String>,
    pub columns: Vec<String>,
    pub ignore_columns: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct InternalSnapshot {
    pub tables: BTreeMap<String, Vec<serde_json::Value>>,
}

#[derive(Debug, Clone, Default)]
pub struct SnapshotOptions {
    pub workspace_path: Option<PathBuf>,
}

impl TableSpec {
    pub fn new(
        name: impl Into<String>,
        key_columns: Vec<&str>,
        columns: Vec<&str>,
        ignore_columns: Vec<&str>,
    ) -> Self {
        Self {
            name: name.into(),
            key_columns: key_columns.into_iter().map(str::to_string).collect(),
            columns: columns.into_iter().map(str::to_string).collect(),
            ignore_columns: ignore_columns.into_iter().map(str::to_string).collect(),
        }
    }
}

pub fn workspace_db_path(path: &Path) -> PathBuf {
    if path.extension().and_then(|ext| ext.to_str()) == Some("db") {
        path.to_path_buf()
    } else {
        path.join("memory").join("memories.db")
    }
}

pub fn snapshot_workspace(
    workspace_or_db: &Path,
    tables: &[TableSpec],
) -> Result<InternalSnapshot, anyhow::Error> {
    let db_path = workspace_db_path(workspace_or_db);
    let workspace_path = if db_path == workspace_or_db {
        db_path
            .parent()
            .and_then(Path::parent)
            .map(Path::to_path_buf)
    } else {
        Some(workspace_or_db.to_path_buf())
    };
    snapshot_db(&db_path, tables, &SnapshotOptions { workspace_path })
}

pub fn snapshot_db(
    db_path: &Path,
    tables: &[TableSpec],
    options: &SnapshotOptions,
) -> Result<InternalSnapshot, anyhow::Error> {
    let conn = Connection::open_with_flags(
        db_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
    )?;
    conn.busy_timeout(Duration::from_millis(1_000))?;
    conn.pragma_update(None, "query_only", true)?;

    let mut snapshot = InternalSnapshot::default();
    for spec in tables {
        let rows = snapshot_table(&conn, spec, options)?;
        snapshot.tables.insert(spec.name.clone(), rows);
    }
    Ok(snapshot)
}

fn snapshot_table(
    conn: &Connection,
    spec: &TableSpec,
    options: &SnapshotOptions,
) -> Result<Vec<serde_json::Value>, anyhow::Error> {
    if !identifier_is_safe(&spec.name) || !table_exists(conn, &spec.name)? {
        return Ok(Vec::new());
    }

    let existing = table_columns(conn, &spec.name)?;
    let ignored: BTreeSet<String> = spec.ignore_columns.iter().cloned().collect();
    let mut selected = Vec::new();
    for column in &spec.columns {
        if existing.contains(column) && !ignored.contains(column) && identifier_is_safe(column) {
            selected.push(column.clone());
        }
    }
    for key in &spec.key_columns {
        if existing.contains(key)
            && !ignored.contains(key)
            && identifier_is_safe(key)
            && !selected.contains(key)
        {
            selected.push(key.clone());
        }
    }

    if selected.is_empty() {
        return Ok(Vec::new());
    }

    let order_columns: Vec<String> = spec
        .key_columns
        .iter()
        .filter(|column| selected.contains(column) && identifier_is_safe(column))
        .cloned()
        .collect();
    let order_sql = if order_columns.is_empty() {
        selected.clone()
    } else {
        order_columns
    };

    let select_sql = selected
        .iter()
        .map(|column| quote_identifier(column))
        .collect::<Vec<_>>()
        .join(", ");
    let order_by_sql = order_sql
        .iter()
        .map(|column| quote_identifier(column))
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "SELECT {select_sql} FROM {} ORDER BY {order_by_sql}",
        quote_identifier(&spec.name)
    );

    let mut stmt = conn.prepare(&sql)?;
    let mut rows = stmt.query([])?;
    let mut out = Vec::new();
    while let Some(row) = rows.next()? {
        let mut object = serde_json::Map::new();
        for (index, column) in selected.iter().enumerate() {
            let value = row.get_ref(index)?;
            object.insert(column.clone(), canonical_cell(column, value, options));
        }
        out.push(serde_json::Value::Object(object));
    }
    Ok(out)
}

fn table_exists(conn: &Connection, table: &str) -> Result<bool, rusqlite::Error> {
    conn.query_row(
        "SELECT 1 FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?1 LIMIT 1",
        [table],
        |_| Ok(()),
    )
    .map(|_| true)
    .or_else(|err| match err {
        rusqlite::Error::QueryReturnedNoRows => Ok(false),
        other => Err(other),
    })
}

fn table_columns(conn: &Connection, table: &str) -> Result<BTreeSet<String>, rusqlite::Error> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({})", quote_identifier(table)))?;
    let columns = stmt.query_map([], |row| row.get::<_, String>(1))?;
    let mut out = BTreeSet::new();
    for column in columns {
        out.insert(column?);
    }
    Ok(out)
}

fn canonical_cell(
    column: &str,
    value: ValueRef<'_>,
    options: &SnapshotOptions,
) -> serde_json::Value {
    if is_secret_like(column) {
        return serde_json::Value::String("[REDACTED]".into());
    }

    match value {
        ValueRef::Null => serde_json::Value::Null,
        ValueRef::Integer(value) => serde_json::Value::Number(value.into()),
        ValueRef::Real(value) => serde_json::Number::from_f64(value)
            .map(serde_json::Value::Number)
            .unwrap_or(serde_json::Value::Null),
        ValueRef::Text(bytes) => {
            let text = String::from_utf8_lossy(bytes).to_string();
            canonical_text(column, &text, options)
        }
        ValueRef::Blob(bytes) => serde_json::json!({
            "blobBytes": bytes.len()
        }),
    }
}

fn canonical_text(column: &str, value: &str, options: &SnapshotOptions) -> serde_json::Value {
    if is_secret_like(column) {
        return serde_json::Value::String("[REDACTED]".into());
    }

    if looks_like_json_column(column)
        && let Ok(parsed) = serde_json::from_str::<serde_json::Value>(value)
    {
        return canonical_json_value(parsed, options);
    }

    if let Some(timestamp) = normalize_timestamp(value) {
        return serde_json::Value::String(timestamp);
    }

    serde_json::Value::String(normalize_path(value, options))
}

fn canonical_json_value(value: serde_json::Value, options: &SnapshotOptions) -> serde_json::Value {
    match value {
        serde_json::Value::Object(map) => {
            let mut sorted = BTreeMap::new();
            for (key, child) in map {
                let value = if is_secret_like(&key) {
                    serde_json::Value::String("[REDACTED]".into())
                } else {
                    canonical_json_value(child, options)
                };
                sorted.insert(key, value);
            }
            let mut object = serde_json::Map::new();
            for (key, value) in sorted {
                object.insert(key, value);
            }
            serde_json::Value::Object(object)
        }
        serde_json::Value::Array(values) => serde_json::Value::Array(
            values
                .into_iter()
                .map(|value| canonical_json_value(value, options))
                .collect(),
        ),
        serde_json::Value::String(value) => normalize_timestamp(&value)
            .map(serde_json::Value::String)
            .unwrap_or_else(|| serde_json::Value::String(normalize_path(&value, options))),
        other => other,
    }
}

pub fn is_secret_like(key: &str) -> bool {
    let normalized: String = key
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect();
    normalized.contains("token")
        || normalized.contains("secret")
        || normalized.contains("password")
        || normalized.contains("apikey")
        || normalized.contains("clientsecret")
}

fn looks_like_json_column(column: &str) -> bool {
    let column = column.to_ascii_lowercase();
    column.ends_with("_json") || column == "metadata" || column == "payload" || column == "tags"
}

fn normalize_timestamp(value: &str) -> Option<String> {
    chrono::DateTime::parse_from_rfc3339(value)
        .map(|timestamp| {
            timestamp
                .with_timezone(&chrono::Utc)
                .to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
        })
        .ok()
}

fn normalize_path(value: &str, options: &SnapshotOptions) -> String {
    let Some(workspace) = options.workspace_path.as_ref() else {
        return value.to_string();
    };
    let workspace = workspace.to_string_lossy();
    if workspace.is_empty() {
        value.to_string()
    } else {
        value.replace(workspace.as_ref(), "$WORKSPACE")
    }
}

fn identifier_is_safe(identifier: &str) -> bool {
    !identifier.is_empty()
        && identifier
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
}

fn quote_identifier(identifier: &str) -> String {
    format!("\"{}\"", identifier.replace('"', "\"\""))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonicalizes_rows_with_redaction_timestamps_paths_and_json() {
        let dir = unique_temp_dir("snapshot-canonical");
        let workspace = dir.join("workspace");
        std::fs::create_dir_all(workspace.join("memory")).unwrap();
        let db = workspace.join("memory").join("memories.db");
        // Use the ACTUAL workspace path (unique_temp_dir appends pid+nanos) so
        // the path normalizer can rewrite it to $WORKSPACE.
        let source_path = workspace.join("file.md");
        let conn = Connection::open(&db).unwrap();
        conn.execute_batch(&format!(
            "CREATE TABLE memories (
                id TEXT PRIMARY KEY,
                source_path TEXT,
                created_at TEXT,
                apiKey TEXT,
                metadata TEXT
            );
            INSERT INTO memories VALUES (
                'm1',
                '{source_path}',
                '2026-01-01T00:00:00.123Z',
                'real-key',
                '{{\"clientSecret\":\"real-secret\",\"b\":2,\"a\":1}}'
            );",
            source_path = source_path.display()
        ))
        .unwrap();
        drop(conn);

        let snapshot = snapshot_workspace(
            &workspace,
            &[TableSpec::new(
                "memories",
                vec!["id"],
                vec!["id", "source_path", "created_at", "apiKey", "metadata"],
                vec![],
            )],
        )
        .unwrap();

        let rows = snapshot.tables.get("memories").unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["apiKey"], "[REDACTED]");
        assert_eq!(rows[0]["created_at"], "2026-01-01T00:00:00Z");
        assert_eq!(rows[0]["source_path"], "$WORKSPACE/file.md");
        assert_eq!(rows[0]["metadata"]["clientSecret"], "[REDACTED]");
        assert_eq!(rows[0]["metadata"]["a"], 1);

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn opens_database_read_only() {
        let dir = unique_temp_dir("snapshot-readonly");
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("memories.db");
        let conn = Connection::open(&db).unwrap();
        conn.execute_batch(
            "CREATE TABLE memories (id TEXT PRIMARY KEY); INSERT INTO memories VALUES ('m1');",
        )
        .unwrap();
        drop(conn);

        let snapshot = snapshot_db(
            &db,
            &[TableSpec::new("memories", vec!["id"], vec!["id"], vec![])],
            &SnapshotOptions::default(),
        )
        .unwrap();
        assert_eq!(snapshot.tables["memories"][0]["id"], "m1");

        let _ = std::fs::remove_dir_all(dir);
    }

    fn unique_temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "signet-shadow-{name}-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }
}
