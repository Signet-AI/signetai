//! Entity, relation, and knowledge graph CRUD operations.

use rusqlite::{Connection, params};
use tracing::warn;

use crate::error::CoreError;
use crate::types::Entity;

// ---------------------------------------------------------------------------
// Row parser
// ---------------------------------------------------------------------------

fn row_to_entity(row: &rusqlite::Row) -> rusqlite::Result<Entity> {
    Ok(Entity {
        id: row.get("id")?,
        name: row.get("name")?,
        canonical_name: row.get("canonical_name")?,
        entity_type: row.get("entity_type")?,
        agent_id: row
            .get::<_, String>("agent_id")
            .unwrap_or_else(|_| "default".into()),
        description: row.get("description")?,
        mentions: row.get::<_, i64>("mentions").unwrap_or(0),
        pinned: row.get::<_, i64>("pinned").unwrap_or(0) != 0,
        pinned_at: row.get("pinned_at")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

// ---------------------------------------------------------------------------
// Entity CRUD
// ---------------------------------------------------------------------------

/// Get entity by ID.
pub fn get(conn: &Connection, id: &str) -> Result<Option<Entity>, CoreError> {
    let mut stmt = conn.prepare_cached("SELECT * FROM entities WHERE id = ?1")?;
    let mut rows = stmt.query_map(params![id], row_to_entity)?;
    match rows.next() {
        Some(Ok(e)) => Ok(Some(e)),
        Some(Err(e)) => Err(e.into()),
        None => Ok(None),
    }
}

/// Find entity by canonical name and agent.
pub fn find_by_canonical(
    conn: &Connection,
    canonical: &str,
    agent_id: &str,
) -> Result<Option<Entity>, CoreError> {
    let mut stmt = conn.prepare_cached(
        "SELECT * FROM entities WHERE canonical_name = ?1 AND agent_id = ?2 LIMIT 1",
    )?;
    let mut rows = stmt.query_map(params![canonical, agent_id], row_to_entity)?;
    match rows.next() {
        Some(Ok(e)) => Ok(Some(e)),
        Some(Err(e)) => Err(e.into()),
        None => Ok(None),
    }
}

/// Find entity by name.
pub fn find_by_name(conn: &Connection, name: &str) -> Result<Option<Entity>, CoreError> {
    let mut stmt = conn.prepare_cached("SELECT * FROM entities WHERE name = ?1 LIMIT 1")?;
    let mut rows = stmt.query_map(params![name], row_to_entity)?;
    match rows.next() {
        Some(Ok(e)) => Ok(Some(e)),
        Some(Err(e)) => Err(e.into()),
        None => Ok(None),
    }
}

/// Result of upserting an entity.
#[derive(Debug)]
pub struct UpsertResult {
    pub id: String,
    pub created: bool,
}

/// Upsert an entity. Short names (<4 chars) are skipped.
pub fn upsert(
    conn: &Connection,
    name: &str,
    canonical: &str,
    entity_type: &str,
    agent_id: &str,
    id: &str,
    now: &str,
) -> Result<Option<UpsertResult>, CoreError> {
    if name.len() < 4 {
        return Ok(None);
    }

    // Check for existing by canonical name + agent, or by name
    let existing: Option<(String, i64, String)> = conn
        .query_row(
            "SELECT id, mentions, entity_type FROM entities
             WHERE (canonical_name = ?1 AND agent_id = ?2) OR name = ?3
             LIMIT 1",
            params![canonical, agent_id, name],
            |r| Ok((r.get(0)?, r.get::<_, i64>(1).unwrap_or(0), r.get(2)?)),
        )
        .ok();

    if let Some((eid, mentions, existing_type)) = existing {
        // Bump mention count
        conn.execute(
            "UPDATE entities SET mentions = ?1, updated_at = ?2 WHERE id = ?3",
            params![mentions + 1, now, eid],
        )?;

        // Upgrade type from 'extracted' if we have better info
        if existing_type == "extracted" && entity_type != "extracted" {
            conn.execute(
                "UPDATE entities SET entity_type = ?1 WHERE id = ?2",
                params![entity_type, eid],
            )?;
        }

        Ok(Some(UpsertResult {
            id: eid,
            created: false,
        }))
    } else {
        // Try insert (may collide on UNIQUE(name))
        let inserted = conn.execute(
            "INSERT INTO entities
             (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at)
             VALUES (?1,?2,?3,?4,?5,1,?6,?6)
             ON CONFLICT(name) DO NOTHING",
            params![id, name, canonical, entity_type, agent_id, now],
        )?;

        if inserted > 0 {
            Ok(Some(UpsertResult {
                id: id.to_string(),
                created: true,
            }))
        } else {
            // Collision — fetch the existing row
            match find_by_name(conn, name)? {
                Some(e) => {
                    conn.execute(
                        "UPDATE entities SET mentions = mentions + 1, updated_at = ?1 WHERE id = ?2",
                        params![now, e.id],
                    )?;
                    Ok(Some(UpsertResult {
                        id: e.id,
                        created: false,
                    }))
                }
                None => Ok(None),
            }
        }
    }
}

/// List entities for an agent, ordered by mention count.
pub fn list(
    conn: &Connection,
    agent_id: &str,
    limit: usize,
    offset: usize,
) -> Result<Vec<Entity>, CoreError> {
    let mut stmt = conn.prepare_cached(
        "SELECT * FROM entities WHERE agent_id = ?1
         ORDER BY mentions DESC, updated_at DESC
         LIMIT ?2 OFFSET ?3",
    )?;
    let rows = stmt.query_map(params![agent_id, limit, offset], row_to_entity)?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

/// Count entities for an agent.
pub fn count(conn: &Connection, agent_id: &str) -> Result<i64, CoreError> {
    Ok(conn.query_row(
        "SELECT count(*) FROM entities WHERE agent_id = ?1",
        params![agent_id],
        |r| r.get(0),
    )?)
}

/// Delete an entity and cascade to relations and mentions.
pub fn delete(conn: &Connection, id: &str) -> Result<(), CoreError> {
    conn.execute(
        "DELETE FROM relations WHERE source_entity_id = ?1 OR target_entity_id = ?1",
        params![id],
    )?;
    conn.execute(
        "DELETE FROM memory_entity_mentions WHERE entity_id = ?1",
        params![id],
    )?;
    conn.execute("DELETE FROM entities WHERE id = ?1", params![id])?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Entity pinning
// ---------------------------------------------------------------------------

pub fn pin(conn: &Connection, id: &str, agent_id: &str, now: &str) -> Result<(), CoreError> {
    conn.execute(
        "UPDATE entities SET pinned = 1, pinned_at = ?1, updated_at = ?1
         WHERE id = ?2 AND agent_id = ?3",
        params![now, id, agent_id],
    )?;
    Ok(())
}

pub fn unpin(conn: &Connection, id: &str, agent_id: &str, now: &str) -> Result<(), CoreError> {
    conn.execute(
        "UPDATE entities SET pinned = 0, pinned_at = NULL, updated_at = ?1
         WHERE id = ?2 AND agent_id = ?3",
        params![now, id, agent_id],
    )?;
    Ok(())
}

pub fn list_pinned(conn: &Connection, agent_id: &str) -> Result<Vec<Entity>, CoreError> {
    let mut stmt = conn.prepare_cached(
        "SELECT * FROM entities
         WHERE agent_id = ?1
           AND pinned = 1
           AND COALESCE(status, 'active') = 'active'
         ORDER BY pinned_at DESC, updated_at DESC, name ASC",
    )?;
    let rows = stmt.query_map(params![agent_id], row_to_entity)?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

// ---------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------

/// Upsert a relation between two entities. Returns true if new.
pub fn upsert_relation(
    conn: &Connection,
    id: &str,
    source_id: &str,
    target_id: &str,
    relation_type: &str,
    confidence: f64,
    now: &str,
) -> Result<bool, CoreError> {
    let existing: Option<(String, i64, f64)> = conn
        .query_row(
            "SELECT id, mentions, confidence FROM relations
             WHERE source_entity_id = ?1 AND target_entity_id = ?2 AND relation_type = ?3
             LIMIT 1",
            params![source_id, target_id, relation_type],
            |r| {
                Ok((
                    r.get(0)?,
                    r.get::<_, i64>(1).unwrap_or(1),
                    r.get::<_, f64>(2).unwrap_or(0.5),
                ))
            },
        )
        .ok();

    if let Some((rid, mentions, old_conf)) = existing {
        // Running average confidence
        let new_conf = (old_conf * mentions as f64 + confidence) / (mentions as f64 + 1.0);
        conn.execute(
            "UPDATE relations SET mentions = ?1, confidence = ?2, updated_at = ?3 WHERE id = ?4",
            params![mentions + 1, new_conf, now, rid],
        )?;
        Ok(false)
    } else {
        conn.execute(
            "INSERT INTO relations
             (id, source_entity_id, target_entity_id, relation_type,
              strength, mentions, confidence, created_at, updated_at)
             VALUES (?1,?2,?3,?4,1.0,1,?5,?6,?6)",
            params![id, source_id, target_id, relation_type, confidence, now],
        )?;
        Ok(true)
    }
}

/// Link a memory to an entity mention.
pub fn link_mention(
    conn: &Connection,
    memory_id: &str,
    entity_id: &str,
    mention_text: Option<&str>,
    confidence: Option<f64>,
    now: &str,
) -> Result<(), CoreError> {
    if let Err(e) = conn.execute(
        "INSERT OR IGNORE INTO memory_entity_mentions
         (memory_id, entity_id, mention_text, confidence, created_at)
         VALUES (?1,?2,?3,?4,?5)",
        params![memory_id, entity_id, mention_text, confidence, now],
    ) {
        warn!(err = %e, "failed to link mention");
    }
    Ok(())
}

/// Decrement mention count and clean up orphans.
pub fn decrement_mentions(conn: &Connection, entity_ids: &[String]) -> Result<usize, CoreError> {
    let mut orphans = Vec::new();

    for eid in entity_ids {
        conn.execute(
            "UPDATE entities SET mentions = MAX(0, mentions - 1) WHERE id = ?1",
            params![eid],
        )?;

        let remaining: i64 = conn
            .query_row(
                "SELECT mentions FROM entities WHERE id = ?1",
                params![eid],
                |r| r.get(0),
            )
            .unwrap_or(0);

        if remaining == 0 {
            orphans.push(eid.clone());
        }
    }

    // Cascade delete orphans
    for eid in &orphans {
        delete(conn, eid)?;
    }

    Ok(orphans.len())
}
