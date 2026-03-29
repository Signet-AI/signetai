//! Memory CRUD operations.
//!
//! Insert, get, update, soft-delete, recover, list, and history queries.

use rusqlite::{Connection, OptionalExtension, params};

use crate::error::CoreError;
use crate::types::{ExtractionStatus, Memory, MemoryHistory, MemoryType};

// ---------------------------------------------------------------------------
// Row parser
// ---------------------------------------------------------------------------

fn row_to_memory(row: &rusqlite::Row) -> rusqlite::Result<Memory> {
    let tags_json: Option<String> = row.get("tags")?;
    let tags: Vec<String> = tags_json
        .as_deref()
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or_default();

    let vc_json: Option<String> = row.get("vector_clock")?;
    let vector_clock = vc_json
        .as_deref()
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or_default();

    let mem_type_str: String = row.get("type")?;
    let ext_status_str: Option<String> = row.get("extraction_status")?;

    Ok(Memory {
        id: row.get("id")?,
        memory_type: MemoryType::from_str_lossy(&mem_type_str),
        category: row.get("category")?,
        content: row.get("content")?,
        confidence: row.get::<_, f64>("confidence").unwrap_or(0.5),
        source_id: row.get("source_id")?,
        source_type: row.get("source_type")?,
        tags,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        updated_by: row.get::<_, String>("updated_by").unwrap_or_default(),
        vector_clock,
        version: row.get::<_, i64>("version").unwrap_or(1),
        manual_override: row.get::<_, i64>("manual_override").unwrap_or(0) != 0,
        content_hash: row.get("content_hash")?,
        normalized_content: row.get("normalized_content")?,
        is_deleted: row.get::<_, i64>("is_deleted").unwrap_or(0) != 0,
        deleted_at: row.get("deleted_at")?,
        pinned: row.get::<_, i64>("pinned").unwrap_or(0) != 0,
        importance: row.get::<_, f64>("importance").unwrap_or(0.5),
        extraction_status: ExtractionStatus::from_str_lossy(
            ext_status_str.as_deref().unwrap_or("none"),
        ),
        embedding_model: row.get("embedding_model")?,
        extraction_model: row.get("extraction_model")?,
        update_count: row.get::<_, i64>("update_count").unwrap_or(0),
        access_count: row.get::<_, i64>("access_count").unwrap_or(0),
        last_accessed: row.get("last_accessed")?,
        who: row.get("who")?,
        why: row.get("why")?,
        project: row.get("project")?,
        session_id: row.get("session_id").ok().flatten(),
        idempotency_key: row.get("idempotency_key")?,
        runtime_path: row.get("runtime_path")?,
        source_path: row.get("source_path")?,
        source_section: row.get("source_section")?,
    })
}

// ---------------------------------------------------------------------------
// Read operations
// ---------------------------------------------------------------------------

/// Get a single memory by ID.
pub fn get(conn: &Connection, id: &str) -> Result<Option<Memory>, CoreError> {
    let mut stmt = conn.prepare_cached("SELECT * FROM memories WHERE id = ?1")?;
    let mut rows = stmt.query_map(params![id], row_to_memory)?;
    match rows.next() {
        Some(Ok(m)) => Ok(Some(m)),
        Some(Err(e)) => Err(e.into()),
        None => Ok(None),
    }
}

/// List memories, optionally filtered by type. Non-deleted only.
pub fn list(
    conn: &Connection,
    memory_type: Option<&str>,
    limit: usize,
    offset: usize,
) -> Result<Vec<Memory>, CoreError> {
    let (sql, has_type) = if memory_type.is_some() {
        (
            "SELECT * FROM memories WHERE is_deleted = 0 AND type = ?1 \
             ORDER BY created_at DESC LIMIT ?2 OFFSET ?3",
            true,
        )
    } else {
        (
            "SELECT * FROM memories WHERE is_deleted = 0 \
             ORDER BY created_at DESC LIMIT ?1 OFFSET ?2",
            false,
        )
    };

    let mut stmt = conn.prepare_cached(sql)?;
    let rows = if has_type {
        stmt.query_map(params![memory_type.unwrap(), limit, offset], row_to_memory)?
    } else {
        stmt.query_map(params![limit, offset], row_to_memory)?
    };

    Ok(rows.filter_map(|r| r.ok()).collect())
}

/// Count memories, optionally filtered by type. Non-deleted only.
pub fn count(conn: &Connection, memory_type: Option<&str>) -> Result<i64, CoreError> {
    if let Some(t) = memory_type {
        Ok(conn.query_row(
            "SELECT count(*) FROM memories WHERE is_deleted = 0 AND type = ?1",
            params![t],
            |r| r.get(0),
        )?)
    } else {
        Ok(conn.query_row(
            "SELECT count(*) FROM memories WHERE is_deleted = 0",
            [],
            |r| r.get(0),
        )?)
    }
}

/// Check if a content hash already exists (for deduplication).
pub fn exists_by_hash(conn: &Connection, hash: &str) -> Result<Option<String>, CoreError> {
    let mut stmt = conn.prepare_cached(
        "SELECT id FROM memories WHERE content_hash = ?1 AND is_deleted = 0 LIMIT 1",
    )?;
    let mut rows = stmt.query_map(params![hash], |r| r.get::<_, String>(0))?;
    match rows.next() {
        Some(Ok(id)) => Ok(Some(id)),
        Some(Err(e)) => Err(e.into()),
        None => Ok(None),
    }
}

/// Check if a content hash exists in the same scoped domain.
pub fn exists_by_hash_scoped(
    conn: &Connection,
    hash: &str,
    agent_id: &str,
    scope: Option<&str>,
    visibility: &str,
) -> Result<Option<String>, CoreError> {
    let sql = if scope.is_some() {
        "SELECT id FROM memories
         WHERE content_hash = ?1
           AND is_deleted = 0
           AND agent_id = ?2
           AND visibility = ?3
           AND scope = ?4
         LIMIT 1"
    } else {
        "SELECT id FROM memories
         WHERE content_hash = ?1
           AND is_deleted = 0
           AND agent_id = ?2
           AND visibility = ?3
           AND scope IS NULL
         LIMIT 1"
    };
    let mut stmt = conn.prepare_cached(sql)?;
    let id = if let Some(sc) = scope {
        stmt.query_row(params![hash, agent_id, visibility, sc], |r| {
            r.get::<_, String>(0)
        })
        .optional()?
    } else {
        stmt.query_row(params![hash, agent_id, visibility], |r| {
            r.get::<_, String>(0)
        })
        .optional()?
    };
    Ok(id)
}

// ---------------------------------------------------------------------------
// Write operations (call on write connection only)
// ---------------------------------------------------------------------------

/// Input for inserting a new memory.
pub struct InsertMemory<'a> {
    pub id: &'a str,
    pub content: &'a str,
    pub normalized_content: &'a str,
    pub content_hash: &'a str,
    pub memory_type: &'a str,
    pub tags: &'a str,
    pub who: Option<&'a str>,
    pub why: Option<&'a str>,
    pub project: Option<&'a str>,
    pub importance: f64,
    pub pinned: bool,
    pub extraction_status: &'a str,
    pub embedding_model: Option<&'a str>,
    pub extraction_model: Option<&'a str>,
    pub source_type: Option<&'a str>,
    pub source_id: Option<&'a str>,
    pub idempotency_key: Option<&'a str>,
    pub runtime_path: Option<&'a str>,
    pub now: &'a str,
    pub updated_by: &'a str,
    pub agent_id: &'a str,
    pub visibility: &'a str,
    pub scope: Option<&'a str>,
}

/// Insert a new memory row. Returns the ID.
pub fn insert(conn: &Connection, m: &InsertMemory) -> Result<String, CoreError> {
    conn.execute(
        "INSERT INTO memories
         (id, content, normalized_content, content_hash, type, tags,
          who, why, project, importance, pinned, is_deleted,
          extraction_status, embedding_model, extraction_model,
         source_type, source_id, idempotency_key, runtime_path,
          confidence, created_at, updated_at, updated_by, agent_id, visibility, scope)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,0,?12,?13,?14,?15,?16,?17,?18,?10,?19,?19,?20,?21,?22,?23)",
        params![
            m.id,
            m.content,
            m.normalized_content,
            m.content_hash,
            m.memory_type,
            m.tags,
            m.who,
            m.why,
            m.project,
            m.importance,
            m.pinned as i64,
            m.extraction_status,
            m.embedding_model,
            m.extraction_model,
            m.source_type,
            m.source_id,
            m.idempotency_key,
            m.runtime_path,
            m.now,
            m.updated_by,
            m.agent_id,
            m.visibility,
            m.scope,
        ],
    )?;
    Ok(m.id.to_string())
}

/// Fields that can be updated on a memory.
pub struct UpdateFields<'a> {
    pub content: Option<&'a str>,
    pub normalized_content: Option<&'a str>,
    pub content_hash: Option<&'a str>,
    pub memory_type: Option<&'a str>,
    pub tags: Option<&'a str>,
    pub importance: Option<f64>,
    pub pinned: Option<bool>,
    pub extraction_status: Option<&'a str>,
    pub extraction_model: Option<&'a str>,
    pub embedding_model: Option<&'a str>,
}

/// Result of an update attempt.
#[derive(Debug)]
pub enum UpdateResult {
    Updated { new_version: i64 },
    NotFound,
    Deleted,
    VersionConflict { current: i64 },
    DuplicateHash { existing_id: String },
    NoChanges,
}

/// Update a memory with optimistic concurrency control.
pub fn update(
    conn: &Connection,
    id: &str,
    fields: &UpdateFields,
    updated_by: &str,
    now: &str,
    if_version: Option<i64>,
) -> Result<UpdateResult, CoreError> {
    // Fetch current state
    let current = get(conn, id)?;
    let current = match current {
        Some(m) if m.is_deleted => return Ok(UpdateResult::Deleted),
        Some(m) => m,
        None => return Ok(UpdateResult::NotFound),
    };

    // Version check
    if let Some(expected) = if_version
        && current.version != expected
    {
        return Ok(UpdateResult::VersionConflict {
            current: current.version,
        });
    }

    // Duplicate content hash check
    if let Some(hash) = fields.content_hash
        && let Some(dup_id) = exists_by_hash(conn, hash)?
        && dup_id != id
    {
        return Ok(UpdateResult::DuplicateHash {
            existing_id: dup_id,
        });
    }

    // Build dynamic SET clause
    let mut sets: Vec<String> = Vec::new();
    let mut values: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
    let mut idx = 1;

    macro_rules! field {
        ($name:expr, $val:expr) => {
            if let Some(v) = $val {
                sets.push(format!("{} = ?{}", $name, idx));
                values.push(Box::new(v.to_string()));
                idx += 1;
            }
        };
    }

    field!("content", fields.content);
    field!("normalized_content", fields.normalized_content);
    field!("content_hash", fields.content_hash);
    field!("type", fields.memory_type);
    field!("tags", fields.tags);
    field!("extraction_status", fields.extraction_status);
    field!("extraction_model", fields.extraction_model);
    field!("embedding_model", fields.embedding_model);

    if let Some(imp) = fields.importance {
        sets.push(format!("importance = ?{idx}"));
        values.push(Box::new(imp));
        idx += 1;
    }
    if let Some(pin) = fields.pinned {
        sets.push(format!("pinned = ?{idx}"));
        values.push(Box::new(pin as i64));
        idx += 1;
    }

    if sets.is_empty() {
        return Ok(UpdateResult::NoChanges);
    }

    // Always bump version and timestamps
    sets.push("version = version + 1".to_string());
    sets.push("update_count = COALESCE(update_count, 0) + 1".to_string());
    sets.push(format!("updated_at = ?{idx}"));
    values.push(Box::new(now.to_string()));
    idx += 1;
    sets.push(format!("updated_by = ?{idx}"));
    values.push(Box::new(updated_by.to_string()));
    idx += 1;

    let sql = format!(
        "UPDATE memories SET {} WHERE id = ?{}",
        sets.join(", "),
        idx
    );
    values.push(Box::new(id.to_string()));

    let params: Vec<&dyn rusqlite::types::ToSql> = values.iter().map(|v| v.as_ref()).collect();
    conn.execute(&sql, params.as_slice())?;

    Ok(UpdateResult::Updated {
        new_version: current.version + 1,
    })
}

/// Soft-delete a memory.
pub fn soft_delete(
    conn: &Connection,
    id: &str,
    updated_by: &str,
    now: &str,
    force: bool,
    if_version: Option<i64>,
) -> Result<DeleteResult, CoreError> {
    let current = get(conn, id)?;
    let current = match current {
        Some(m) if m.is_deleted => return Ok(DeleteResult::AlreadyDeleted),
        Some(m) => m,
        None => return Ok(DeleteResult::NotFound),
    };

    if let Some(expected) = if_version
        && current.version != expected
    {
        return Ok(DeleteResult::VersionConflict {
            current: current.version,
        });
    }

    if current.pinned && !force {
        return Ok(DeleteResult::PinnedRequiresForce);
    }

    conn.execute(
        "UPDATE memories SET is_deleted = 1, deleted_at = ?1, updated_at = ?1,
         updated_by = ?2, version = version + 1 WHERE id = ?3",
        params![now, updated_by, id],
    )?;

    Ok(DeleteResult::Deleted {
        new_version: current.version + 1,
    })
}

/// Result of a delete attempt.
#[derive(Debug)]
pub enum DeleteResult {
    Deleted { new_version: i64 },
    NotFound,
    AlreadyDeleted,
    VersionConflict { current: i64 },
    PinnedRequiresForce,
}

/// Recover a soft-deleted memory within the retention window.
pub fn recover(
    conn: &Connection,
    id: &str,
    updated_by: &str,
    now: &str,
    retention_window_ms: u64,
    if_version: Option<i64>,
) -> Result<RecoverResult, CoreError> {
    let current = get(conn, id)?;
    let current = match current {
        Some(m) if !m.is_deleted => return Ok(RecoverResult::NotDeleted),
        Some(m) => m,
        None => return Ok(RecoverResult::NotFound),
    };

    if let Some(expected) = if_version
        && current.version != expected
    {
        return Ok(RecoverResult::VersionConflict {
            current: current.version,
        });
    }

    // Check retention window
    if let Some(deleted_at) = &current.deleted_at
        && let Ok(deleted) = chrono::DateTime::parse_from_rfc3339(deleted_at)
    {
        let elapsed = chrono::Utc::now()
            .signed_duration_since(deleted)
            .num_milliseconds();
        if elapsed > retention_window_ms as i64 {
            return Ok(RecoverResult::RetentionExpired);
        }
    }

    conn.execute(
        "UPDATE memories SET is_deleted = 0, deleted_at = NULL, updated_at = ?1,
         updated_by = ?2, version = version + 1 WHERE id = ?3",
        params![now, updated_by, id],
    )?;

    Ok(RecoverResult::Recovered {
        new_version: current.version + 1,
    })
}

/// Result of a recovery attempt.
#[derive(Debug)]
pub enum RecoverResult {
    Recovered { new_version: i64 },
    NotFound,
    NotDeleted,
    VersionConflict { current: i64 },
    RetentionExpired,
}

/// Bump access count and last_accessed timestamp.
pub fn touch(conn: &Connection, id: &str, now: &str) -> Result<(), CoreError> {
    conn.execute(
        "UPDATE memories SET access_count = access_count + 1, last_accessed = ?1 WHERE id = ?2",
        params![now, id],
    )?;
    Ok(())
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

pub struct InsertHistory<'a> {
    pub id: &'a str,
    pub memory_id: &'a str,
    pub event: &'a str,
    pub old_content: Option<&'a str>,
    pub new_content: Option<&'a str>,
    pub changed_by: &'a str,
    pub reason: Option<&'a str>,
    pub metadata: Option<&'a str>,
    pub now: &'a str,
    pub actor_type: Option<&'a str>,
    pub session_id: Option<&'a str>,
    pub request_id: Option<&'a str>,
}

pub fn insert_history(conn: &Connection, h: &InsertHistory) -> Result<(), CoreError> {
    conn.execute(
        "INSERT INTO memory_history
         (id, memory_id, event, old_content, new_content, changed_by,
          reason, metadata, created_at, actor_type, session_id, request_id)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
        params![
            h.id,
            h.memory_id,
            h.event,
            h.old_content,
            h.new_content,
            h.changed_by,
            h.reason,
            h.metadata,
            h.now,
            h.actor_type,
            h.session_id,
            h.request_id,
        ],
    )?;
    Ok(())
}

pub fn get_history(conn: &Connection, memory_id: &str) -> Result<Vec<MemoryHistory>, CoreError> {
    let mut stmt = conn.prepare_cached(
        "SELECT * FROM memory_history WHERE memory_id = ?1 ORDER BY created_at ASC",
    )?;
    let rows = stmt.query_map(params![memory_id], |row| {
        let event_str: String = row.get("event")?;
        Ok(MemoryHistory {
            id: row.get("id")?,
            memory_id: row.get("memory_id")?,
            event: crate::types::HistoryEvent::from_str_lossy(&event_str),
            old_content: row.get("old_content")?,
            new_content: row.get("new_content")?,
            changed_by: row.get("changed_by")?,
            reason: row.get("reason")?,
            metadata: row.get("metadata")?,
            created_at: row.get("created_at")?,
            actor_type: row.get("actor_type")?,
            session_id: row.get("session_id")?,
            request_id: row.get("request_id")?,
        })
    })?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> rusqlite::Connection {
        crate::db::register_vec_extension();
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::configure_pragmas_pub(&conn).unwrap();
        crate::migrations::run(&conn).unwrap();
        crate::db::ensure_fts_pub(&conn).unwrap();
        crate::db::ensure_vec_table_pub(&conn).unwrap();
        conn
    }

    fn make_input<'a>(id: &'a str, content: &'a str, hash: &'a str) -> InsertMemory<'a> {
        InsertMemory {
            id,
            content,
            normalized_content: content,
            content_hash: hash,
            memory_type: "fact",
            tags: "[]",
            who: None,
            why: None,
            project: None,
            importance: 0.5,
            pinned: false,
            extraction_status: "none",
            embedding_model: None,
            extraction_model: None,
            source_type: None,
            source_id: None,
            idempotency_key: None,
            runtime_path: None,
            now: "2024-01-01T00:00:00Z",
            updated_by: "test",
            agent_id: "default",
            visibility: "global",
            scope: None,
        }
    }

    #[test]
    fn insert_and_get() {
        let conn = setup();
        let mut input = make_input("mem_1", "Rust is fast", "abc123");
        input.importance = 0.8;
        insert(&conn, &input).unwrap();

        let mem = get(&conn, "mem_1").unwrap().unwrap();
        assert_eq!(mem.content, "Rust is fast");
        assert_eq!(mem.importance, 0.8);
        assert!(!mem.is_deleted);
    }

    #[test]
    fn list_and_count() {
        let conn = setup();
        for i in 0..5 {
            let id = format!("mem_{i}");
            let hash = format!("hash_{i}");
            insert(&conn, &make_input(&id, "test", &hash)).unwrap();
        }

        assert_eq!(count(&conn, None).unwrap(), 5);
        assert_eq!(count(&conn, Some("fact")).unwrap(), 5);
        assert_eq!(count(&conn, Some("preference")).unwrap(), 0);

        let mems = list(&conn, None, 3, 0).unwrap();
        assert_eq!(mems.len(), 3);
    }

    #[test]
    fn soft_delete_and_recover() {
        let conn = setup();
        insert(&conn, &make_input("mem_del", "deletable", "del_hash")).unwrap();

        let now = chrono::Utc::now().to_rfc3339();
        let res = soft_delete(&conn, "mem_del", "test", &now, false, None).unwrap();
        assert!(matches!(res, DeleteResult::Deleted { .. }));

        let mem = get(&conn, "mem_del").unwrap().unwrap();
        assert!(mem.is_deleted);
        assert_eq!(count(&conn, None).unwrap(), 0);

        let res = recover(&conn, "mem_del", "test", &now, 30 * 24 * 3600 * 1000, None).unwrap();
        assert!(matches!(res, RecoverResult::Recovered { .. }));

        let mem = get(&conn, "mem_del").unwrap().unwrap();
        assert!(!mem.is_deleted);
    }

    #[test]
    fn pinned_blocks_delete() {
        let conn = setup();
        let mut input = make_input("mem_pin", "pinned", "pin_hash");
        input.pinned = true;
        insert(&conn, &input).unwrap();

        let res = soft_delete(
            &conn,
            "mem_pin",
            "test",
            "2024-01-02T00:00:00Z",
            false,
            None,
        )
        .unwrap();
        assert!(matches!(res, DeleteResult::PinnedRequiresForce));

        let res =
            soft_delete(&conn, "mem_pin", "test", "2024-01-02T00:00:00Z", true, None).unwrap();
        assert!(matches!(res, DeleteResult::Deleted { .. }));
    }

    #[test]
    fn update_version_control() {
        let conn = setup();
        insert(&conn, &make_input("mem_upd", "original", "upd_hash")).unwrap();

        let fields = UpdateFields {
            content: Some("updated"),
            normalized_content: Some("updated"),
            content_hash: Some("upd_hash2"),
            memory_type: None,
            tags: None,
            importance: None,
            pinned: None,
            extraction_status: None,
            extraction_model: None,
            embedding_model: None,
        };

        let res = update(
            &conn,
            "mem_upd",
            &fields,
            "test",
            "2024-01-02T00:00:00Z",
            Some(1),
        )
        .unwrap();
        assert!(matches!(res, UpdateResult::Updated { new_version: 2 }));

        let res = update(
            &conn,
            "mem_upd",
            &fields,
            "test",
            "2024-01-03T00:00:00Z",
            Some(1),
        )
        .unwrap();
        assert!(matches!(res, UpdateResult::VersionConflict { current: 2 }));
    }
}
