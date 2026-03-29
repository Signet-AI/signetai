//! Knowledge graph operations: aspects, attributes, dependencies, traversal,
//! stats, constellation overlay.
//!
//! Entity/relation CRUD lives in `signet_core::queries::entity`.
//! This module handles the higher-level knowledge architecture.

use std::collections::HashSet;
use std::time::Instant;

use rusqlite::{Connection, params};
use serde::Serialize;
use signet_core::error::CoreError;
use signet_core::types::{EntityAspect, EntityAttribute, EntityDependency, TaskMeta};

// ---------------------------------------------------------------------------
// Canonical name helper
// ---------------------------------------------------------------------------

pub fn to_canonical(name: &str) -> String {
    name.trim()
        .to_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

// ---------------------------------------------------------------------------
// Row parsers
// ---------------------------------------------------------------------------

fn row_to_aspect(row: &rusqlite::Row) -> rusqlite::Result<EntityAspect> {
    Ok(EntityAspect {
        id: row.get("id")?,
        entity_id: row.get("entity_id")?,
        agent_id: row.get("agent_id")?,
        name: row.get("name")?,
        canonical_name: row.get("canonical_name")?,
        weight: row.get("weight")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn row_to_attribute(row: &rusqlite::Row) -> rusqlite::Result<EntityAttribute> {
    Ok(EntityAttribute {
        id: row.get("id")?,
        aspect_id: row.get("aspect_id")?,
        agent_id: row.get("agent_id")?,
        memory_id: row.get("memory_id")?,
        kind: row.get("kind")?,
        content: row.get("content")?,
        normalized_content: row.get("normalized_content")?,
        confidence: row.get("confidence")?,
        importance: row.get("importance")?,
        status: row.get("status")?,
        superseded_by: row.get("superseded_by")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn row_to_dependency(row: &rusqlite::Row) -> rusqlite::Result<EntityDependency> {
    Ok(EntityDependency {
        id: row.get("id")?,
        source_entity_id: row.get("source_entity_id")?,
        target_entity_id: row.get("target_entity_id")?,
        agent_id: row.get("agent_id")?,
        aspect_id: row.get("aspect_id")?,
        dependency_type: row.get("dependency_type")?,
        strength: row.get("strength")?,
        reason: row.get("reason")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn row_to_task_meta(row: &rusqlite::Row) -> rusqlite::Result<TaskMeta> {
    Ok(TaskMeta {
        entity_id: row.get("entity_id")?,
        agent_id: row.get("agent_id")?,
        status: row.get("status")?,
        expires_at: row.get("expires_at")?,
        retention_until: row.get("retention_until")?,
        completed_at: row.get("completed_at")?,
        updated_at: row.get("updated_at")?,
    })
}

// ---------------------------------------------------------------------------
// Aspect CRUD
// ---------------------------------------------------------------------------

pub fn upsert_aspect(
    conn: &Connection,
    entity_id: &str,
    agent_id: &str,
    name: &str,
    weight: Option<f64>,
) -> Result<EntityAspect, CoreError> {
    let canonical = to_canonical(name);
    let id = uuid::Uuid::new_v4().to_string();
    let ts = now();
    let w = weight.unwrap_or(0.5);

    conn.execute(
        "INSERT INTO entity_aspects (id, entity_id, agent_id, name, canonical_name, weight, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
         ON CONFLICT(entity_id, canonical_name) DO UPDATE SET
           name = excluded.name,
           weight = excluded.weight,
           updated_at = excluded.updated_at",
        params![id, entity_id, agent_id, name, canonical, w, ts],
    )?;

    // Fetch the upserted row
    let mut stmt = conn.prepare_cached(
        "SELECT * FROM entity_aspects WHERE entity_id = ?1 AND canonical_name = ?2",
    )?;
    let aspect = stmt.query_row(params![entity_id, canonical], row_to_aspect)?;
    Ok(aspect)
}

pub fn get_aspects(
    conn: &Connection,
    entity_id: &str,
    agent_id: &str,
) -> Result<Vec<EntityAspect>, CoreError> {
    let mut stmt = conn.prepare_cached(
        "SELECT * FROM entity_aspects WHERE entity_id = ?1 AND agent_id = ?2
         ORDER BY weight DESC",
    )?;
    let rows = stmt.query_map(params![entity_id, agent_id], row_to_aspect)?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

pub fn delete_aspect(conn: &Connection, aspect_id: &str, agent_id: &str) -> Result<(), CoreError> {
    conn.execute(
        "DELETE FROM entity_aspects WHERE id = ?1 AND agent_id = ?2",
        params![aspect_id, agent_id],
    )?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Attribute CRUD
// ---------------------------------------------------------------------------

pub struct CreateAttributeInput<'a> {
    pub aspect_id: &'a str,
    pub agent_id: &'a str,
    pub memory_id: Option<&'a str>,
    pub kind: &'a str,
    pub content: &'a str,
    pub confidence: Option<f64>,
    pub importance: Option<f64>,
}

pub fn create_attribute(
    conn: &Connection,
    input: &CreateAttributeInput,
) -> Result<EntityAttribute, CoreError> {
    let id = uuid::Uuid::new_v4().to_string();
    let ts = now();
    let normalized = input
        .content
        .trim()
        .to_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let conf = input.confidence.unwrap_or(0.0);
    let imp = input.importance.unwrap_or(0.5);

    conn.execute(
        "INSERT INTO entity_attributes
         (id, aspect_id, agent_id, memory_id, kind, content, normalized_content,
          confidence, importance, status, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'active', ?10, ?10)",
        params![
            id,
            input.aspect_id,
            input.agent_id,
            input.memory_id,
            input.kind,
            input.content,
            normalized,
            conf,
            imp,
            ts
        ],
    )?;

    let mut stmt = conn.prepare_cached("SELECT * FROM entity_attributes WHERE id = ?1")?;
    let attr = stmt.query_row(params![id], row_to_attribute)?;
    Ok(attr)
}

pub fn get_attributes(
    conn: &Connection,
    aspect_id: &str,
    agent_id: &str,
) -> Result<Vec<EntityAttribute>, CoreError> {
    let mut stmt = conn.prepare_cached(
        "SELECT * FROM entity_attributes WHERE aspect_id = ?1 AND agent_id = ?2
         AND status = 'active' ORDER BY importance DESC",
    )?;
    let rows = stmt.query_map(params![aspect_id, agent_id], row_to_attribute)?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

pub struct AttributeFilter<'a> {
    pub entity_id: &'a str,
    pub aspect_id: &'a str,
    pub agent_id: &'a str,
    pub kind: Option<&'a str>,
    pub status: Option<&'a str>,
    pub limit: usize,
    pub offset: usize,
}

pub fn get_attributes_filtered(
    conn: &Connection,
    filter: &AttributeFilter,
) -> Result<Vec<EntityAttribute>, CoreError> {
    let mut sql = String::from(
        "SELECT ea.* FROM entity_attributes ea
         JOIN entity_aspects asp ON asp.id = ea.aspect_id
         WHERE asp.entity_id = ?1 AND asp.id = ?2 AND asp.agent_id = ?3 AND ea.agent_id = ?3",
    );
    let mut bound: Vec<Box<dyn rusqlite::types::ToSql>> = vec![
        Box::new(filter.entity_id.to_string()),
        Box::new(filter.aspect_id.to_string()),
        Box::new(filter.agent_id.to_string()),
    ];

    if let Some(k) = filter.kind {
        sql.push_str(&format!(" AND ea.kind = ?{}", bound.len() + 1));
        bound.push(Box::new(k.to_string()));
    }
    if let Some(s) = filter.status {
        sql.push_str(&format!(" AND ea.status = ?{}", bound.len() + 1));
        bound.push(Box::new(s.to_string()));
    }

    sql.push_str(&format!(
        " ORDER BY ea.importance DESC LIMIT ?{} OFFSET ?{}",
        bound.len() + 1,
        bound.len() + 2,
    ));
    bound.push(Box::new(filter.limit as i64));
    bound.push(Box::new(filter.offset as i64));

    let mut stmt = conn.prepare(&sql)?;
    let params = rusqlite::params_from_iter(bound.iter().map(|b| b.as_ref()));
    let rows = stmt.query_map(params, row_to_attribute)?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

pub fn get_constraints(
    conn: &Connection,
    entity_id: &str,
    agent_id: &str,
) -> Result<Vec<EntityAttribute>, CoreError> {
    let mut stmt = conn.prepare_cached(
        "SELECT ea.* FROM entity_attributes ea
         JOIN entity_aspects asp ON asp.id = ea.aspect_id
         WHERE asp.entity_id = ?1 AND asp.agent_id = ?2 AND ea.agent_id = ?2
           AND ea.kind = 'constraint' AND ea.status = 'active'
         ORDER BY ea.importance DESC",
    )?;
    let rows = stmt.query_map(params![entity_id, agent_id], row_to_attribute)?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

pub fn supersede_attribute(
    conn: &Connection,
    id: &str,
    superseded_by: &str,
    agent_id: &str,
) -> Result<(), CoreError> {
    conn.execute(
        "UPDATE entity_attributes SET status = 'superseded', superseded_by = ?1, updated_at = ?2
         WHERE id = ?3 AND agent_id = ?4",
        params![superseded_by, now(), id, agent_id],
    )?;
    Ok(())
}

pub fn delete_attribute(conn: &Connection, id: &str, agent_id: &str) -> Result<(), CoreError> {
    conn.execute(
        "UPDATE entity_attributes SET status = 'deleted', updated_at = ?1
         WHERE id = ?2 AND agent_id = ?3",
        params![now(), id, agent_id],
    )?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Dependency CRUD
// ---------------------------------------------------------------------------

pub struct UpsertDepInput<'a> {
    pub source_entity_id: &'a str,
    pub target_entity_id: &'a str,
    pub agent_id: &'a str,
    pub aspect_id: Option<&'a str>,
    pub dependency_type: &'a str,
    pub strength: Option<f64>,
    pub confidence: Option<f64>,
    pub reason: Option<&'a str>,
}

pub fn upsert_dependency(
    conn: &Connection,
    input: UpsertDepInput<'_>,
) -> Result<EntityDependency, CoreError> {
    let UpsertDepInput {
        source_entity_id,
        target_entity_id,
        agent_id,
        aspect_id,
        dependency_type,
        strength,
        confidence,
        reason,
    } = input;
    let ts = now();

    let existing: Option<(String, f64, Option<String>)> = conn
        .query_row(
            "SELECT id, strength, reason FROM entity_dependencies
             WHERE source_entity_id = ?1 AND target_entity_id = ?2
               AND dependency_type = ?3 AND agent_id = ?4",
            params![
                source_entity_id,
                target_entity_id,
                dependency_type,
                agent_id
            ],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .ok();

    if let Some((eid, existing_strength, _)) = existing {
        let s = strength.unwrap_or(existing_strength);
        conn.execute(
            "UPDATE entity_dependencies
             SET strength = ?1, aspect_id = ?2, updated_at = ?3,
                 reason = COALESCE(?5, reason),
                 confidence = COALESCE(?6, confidence)
             WHERE id = ?4",
            params![s, aspect_id, ts, eid, reason, confidence],
        )?;
        let mut stmt = conn.prepare_cached("SELECT * FROM entity_dependencies WHERE id = ?1")?;
        let dep = stmt.query_row(params![eid], row_to_dependency)?;
        Ok(dep)
    } else {
        let id = uuid::Uuid::new_v4().to_string();
        let s = strength.unwrap_or(0.5);
        let conf = confidence.unwrap_or(0.7);
        conn.execute(
            "INSERT INTO entity_dependencies
             (id, source_entity_id, target_entity_id, agent_id, aspect_id,
              dependency_type, strength, confidence, reason, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)",
            params![
                id,
                source_entity_id,
                target_entity_id,
                agent_id,
                aspect_id,
                dependency_type,
                s,
                conf,
                reason,
                ts
            ],
        )?;
        let mut stmt = conn.prepare_cached("SELECT * FROM entity_dependencies WHERE id = ?1")?;
        let dep = stmt.query_row(params![id], row_to_dependency)?;
        Ok(dep)
    }
}

pub fn get_dependencies_from(
    conn: &Connection,
    entity_id: &str,
    agent_id: &str,
) -> Result<Vec<EntityDependency>, CoreError> {
    let mut stmt = conn.prepare_cached(
        "SELECT * FROM entity_dependencies WHERE source_entity_id = ?1 AND agent_id = ?2",
    )?;
    let rows = stmt.query_map(params![entity_id, agent_id], row_to_dependency)?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

pub fn get_dependencies_to(
    conn: &Connection,
    entity_id: &str,
    agent_id: &str,
) -> Result<Vec<EntityDependency>, CoreError> {
    let mut stmt = conn.prepare_cached(
        "SELECT * FROM entity_dependencies WHERE target_entity_id = ?1 AND agent_id = ?2",
    )?;
    let rows = stmt.query_map(params![entity_id, agent_id], row_to_dependency)?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DependencyEdge {
    pub id: String,
    pub direction: String,
    pub dependency_type: String,
    pub strength: f64,
    pub aspect_id: Option<String>,
    pub reason: Option<String>,
    pub source_entity_id: String,
    pub source_entity_name: String,
    pub target_entity_id: String,
    pub target_entity_name: String,
    pub created_at: String,
    pub updated_at: String,
}

pub fn get_dependencies_detailed(
    conn: &Connection,
    entity_id: &str,
    agent_id: &str,
    direction: &str,
) -> Result<Vec<DependencyEdge>, CoreError> {
    let filter = match direction {
        "incoming" => "dep.target_entity_id = ?2",
        "outgoing" => "dep.source_entity_id = ?2",
        _ => "(dep.target_entity_id = ?2 OR dep.source_entity_id = ?2)",
    };

    let sql = format!(
        "SELECT dep.*, src.name AS source_entity_name, dst.name AS target_entity_name
         FROM entity_dependencies dep
         JOIN entities src ON src.id = dep.source_entity_id
         JOIN entities dst ON dst.id = dep.target_entity_id
         WHERE dep.agent_id = ?1 AND {filter}
         ORDER BY dep.strength DESC, dep.updated_at DESC"
    );

    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params![agent_id, entity_id], |row| {
        let src_id: String = row.get("source_entity_id")?;
        let tgt_id: String = row.get("target_entity_id")?;
        let dir = if tgt_id == entity_id {
            "incoming"
        } else {
            "outgoing"
        };
        Ok(DependencyEdge {
            id: row.get("id")?,
            direction: dir.to_string(),
            dependency_type: row.get("dependency_type")?,
            strength: row.get("strength")?,
            aspect_id: row.get("aspect_id")?,
            reason: row.get("reason")?,
            source_entity_id: src_id,
            source_entity_name: row.get("source_entity_name")?,
            target_entity_id: tgt_id,
            target_entity_name: row.get("target_entity_name")?,
            created_at: row.get("created_at")?,
            updated_at: row.get("updated_at")?,
        })
    })?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

pub fn delete_dependency(conn: &Connection, id: &str, agent_id: &str) -> Result<(), CoreError> {
    // History is written by the trg_entity_dependencies_audit_delete AFTER DELETE
    // trigger (migration 035), which covers app deletes, FK cascades, and direct SQL.
    // No app-layer history write here to avoid duplicate audit rows.
    conn.execute(
        "DELETE FROM entity_dependencies WHERE id = ?1 AND agent_id = ?2",
        params![id, agent_id],
    )?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Task metadata
// ---------------------------------------------------------------------------

pub fn upsert_task_meta(
    conn: &Connection,
    entity_id: &str,
    agent_id: &str,
    status: &str,
    expires_at: Option<&str>,
    retention_until: Option<&str>,
) -> Result<TaskMeta, CoreError> {
    let ts = now();
    let completed = if status == "done" || status == "cancelled" {
        Some(ts.as_str())
    } else {
        None
    };

    conn.execute(
        "INSERT INTO task_meta (entity_id, agent_id, status, expires_at, retention_until, completed_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(entity_id) DO UPDATE SET
           status = excluded.status,
           expires_at = excluded.expires_at,
           retention_until = excluded.retention_until,
           completed_at = excluded.completed_at,
           updated_at = excluded.updated_at",
        params![entity_id, agent_id, status, expires_at, retention_until, completed, ts],
    )?;

    let mut stmt = conn.prepare_cached("SELECT * FROM task_meta WHERE entity_id = ?1")?;
    let meta = stmt.query_row(params![entity_id], row_to_task_meta)?;
    Ok(meta)
}

pub fn get_task_meta(
    conn: &Connection,
    entity_id: &str,
    agent_id: &str,
) -> Result<Option<TaskMeta>, CoreError> {
    let mut stmt =
        conn.prepare_cached("SELECT * FROM task_meta WHERE entity_id = ?1 AND agent_id = ?2")?;
    let mut rows = stmt.query_map(params![entity_id, agent_id], row_to_task_meta)?;
    match rows.next() {
        Some(Ok(m)) => Ok(Some(m)),
        Some(Err(e)) => Err(e.into()),
        None => Ok(None),
    }
}

pub fn update_task_status(
    conn: &Connection,
    entity_id: &str,
    agent_id: &str,
    status: &str,
) -> Result<(), CoreError> {
    let ts = now();
    let completed = if status == "done" || status == "cancelled" {
        Some(ts.clone())
    } else {
        None
    };

    conn.execute(
        "UPDATE task_meta SET status = ?1, completed_at = ?2, updated_at = ?3
         WHERE entity_id = ?4 AND agent_id = ?5",
        params![status, completed, ts, entity_id, agent_id],
    )?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Knowledge list / detail (aggregated views)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntityListItem {
    pub id: String,
    pub name: String,
    pub entity_type: String,
    pub mentions: i64,
    pub pinned: bool,
    pub pinned_at: Option<String>,
    pub aspect_count: i64,
    pub attribute_count: i64,
    pub constraint_count: i64,
    pub dependency_count: i64,
}

pub fn list_knowledge_entities(
    conn: &Connection,
    agent_id: &str,
    entity_type: Option<&str>,
    query: Option<&str>,
    limit: usize,
    offset: usize,
) -> Result<Vec<EntityListItem>, CoreError> {
    let mut sql = String::from(
        "SELECT e.id, e.name, e.entity_type, e.mentions, e.pinned, e.pinned_at,
                COUNT(DISTINCT asp.id) as aspect_count,
                COUNT(DISTINCT CASE WHEN attr.kind='attribute' AND attr.status='active' THEN attr.id END) as attribute_count,
                COUNT(DISTINCT CASE WHEN attr.kind='constraint' AND attr.status='active' THEN attr.id END) as constraint_count,
                COUNT(DISTINCT dep.id) as dependency_count
         FROM entities e
         LEFT JOIN entity_aspects asp ON asp.entity_id = e.id AND asp.agent_id = e.agent_id
         LEFT JOIN entity_attributes attr ON attr.aspect_id = asp.id AND attr.agent_id = e.agent_id
         LEFT JOIN entity_dependencies dep ON dep.agent_id = e.agent_id AND (dep.source_entity_id = e.id OR dep.target_entity_id = e.id)
         WHERE e.agent_id = ?1",
    );
    let mut bound: Vec<Box<dyn rusqlite::types::ToSql>> = vec![Box::new(agent_id.to_string())];

    if let Some(t) = entity_type {
        sql.push_str(&format!(" AND e.entity_type = ?{}", bound.len() + 1));
        bound.push(Box::new(t.to_string()));
    }
    if let Some(q) = query {
        let pattern = format!("%{}%", to_canonical(q));
        sql.push_str(&format!(" AND e.canonical_name LIKE ?{}", bound.len() + 1));
        bound.push(Box::new(pattern));
    }

    sql.push_str(" GROUP BY e.id");
    sql.push_str(
        " ORDER BY e.pinned DESC, e.pinned_at DESC, e.mentions DESC, e.updated_at DESC, e.name ASC",
    );
    sql.push_str(&format!(
        " LIMIT ?{} OFFSET ?{}",
        bound.len() + 1,
        bound.len() + 2,
    ));
    bound.push(Box::new(limit as i64));
    bound.push(Box::new(offset as i64));

    let mut stmt = conn.prepare(&sql)?;
    let params = rusqlite::params_from_iter(bound.iter().map(|b| b.as_ref()));
    let rows = stmt.query_map(params, |row| {
        Ok(EntityListItem {
            id: row.get("id")?,
            name: row.get("name")?,
            entity_type: row.get("entity_type")?,
            mentions: row.get("mentions")?,
            pinned: row.get::<_, i64>("pinned")? != 0,
            pinned_at: row.get("pinned_at")?,
            aspect_count: row.get("aspect_count")?,
            attribute_count: row.get("attribute_count")?,
            constraint_count: row.get("constraint_count")?,
            dependency_count: row.get("dependency_count")?,
        })
    })?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StructuralDensity {
    pub aspect_count: i64,
    pub attribute_count: i64,
    pub constraint_count: i64,
    pub dependency_count: i64,
}

pub fn get_structural_density(
    conn: &Connection,
    entity_id: &str,
    agent_id: &str,
) -> Result<StructuralDensity, CoreError> {
    let aspects: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM entity_aspects WHERE entity_id = ?1 AND agent_id = ?2",
            params![entity_id, agent_id],
            |r| r.get(0),
        )
        .unwrap_or(0);
    let attributes: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM entity_attributes ea
             JOIN entity_aspects asp ON asp.id = ea.aspect_id
             WHERE asp.entity_id = ?1 AND ea.agent_id = ?2 AND ea.kind = 'attribute' AND ea.status = 'active'",
            params![entity_id, agent_id],
            |r| r.get(0),
        )
        .unwrap_or(0);
    let constraints: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM entity_attributes ea
             JOIN entity_aspects asp ON asp.id = ea.aspect_id
             WHERE asp.entity_id = ?1 AND ea.agent_id = ?2 AND ea.kind = 'constraint' AND ea.status = 'active'",
            params![entity_id, agent_id],
            |r| r.get(0),
        )
        .unwrap_or(0);
    let deps: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM entity_dependencies
             WHERE agent_id = ?1 AND (source_entity_id = ?2 OR target_entity_id = ?2)",
            params![agent_id, entity_id],
            |r| r.get(0),
        )
        .unwrap_or(0);

    Ok(StructuralDensity {
        aspect_count: aspects,
        attribute_count: attributes,
        constraint_count: constraints,
        dependency_count: deps,
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AspectWithCounts {
    #[serde(flatten)]
    pub aspect: EntityAspect,
    pub attribute_count: i64,
    pub constraint_count: i64,
}

pub fn get_aspects_with_counts(
    conn: &Connection,
    entity_id: &str,
    agent_id: &str,
) -> Result<Vec<AspectWithCounts>, CoreError> {
    let mut stmt = conn.prepare_cached(
        "SELECT asp.*,
                COUNT(DISTINCT CASE WHEN attr.kind='attribute' AND attr.status='active' THEN attr.id END) as attribute_count,
                COUNT(DISTINCT CASE WHEN attr.kind='constraint' AND attr.status='active' THEN attr.id END) as constraint_count
         FROM entity_aspects asp
         LEFT JOIN entity_attributes attr ON attr.aspect_id = asp.id AND attr.agent_id = asp.agent_id
         WHERE asp.entity_id = ?1 AND asp.agent_id = ?2
         GROUP BY asp.id
         ORDER BY asp.weight DESC, asp.name ASC",
    )?;
    let rows = stmt.query_map(params![entity_id, agent_id], |row| {
        Ok(AspectWithCounts {
            aspect: row_to_aspect(row)?,
            attribute_count: row.get("attribute_count")?,
            constraint_count: row.get("constraint_count")?,
        })
    })?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

// ---------------------------------------------------------------------------
// Knowledge statistics
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeStats {
    pub entity_count: i64,
    pub aspect_count: i64,
    pub attribute_count: i64,
    pub constraint_count: i64,
    pub dependency_count: i64,
    pub unassigned_memory_count: i64,
    pub coverage_percent: f64,
    pub feedback_updated_aspect_count: i64,
    pub average_aspect_weight: f64,
    pub max_weight_aspect_count: i64,
    pub min_weight_aspect_count: i64,
}

pub fn get_knowledge_stats(conn: &Connection, agent_id: &str) -> Result<KnowledgeStats, CoreError> {
    let entities: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM entities WHERE agent_id = ?1",
            params![agent_id],
            |r| r.get(0),
        )
        .unwrap_or(0);
    let aspects: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM entity_aspects WHERE agent_id = ?1",
            params![agent_id],
            |r| r.get(0),
        )
        .unwrap_or(0);
    let attributes: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM entity_attributes WHERE agent_id = ?1 AND kind = 'attribute' AND status = 'active'",
            params![agent_id],
            |r| r.get(0),
        )
        .unwrap_or(0);
    let constraints: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM entity_attributes WHERE agent_id = ?1 AND kind = 'constraint' AND status = 'active'",
            params![agent_id],
            |r| r.get(0),
        )
        .unwrap_or(0);
    let deps: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM entity_dependencies WHERE agent_id = ?1",
            params![agent_id],
            |r| r.get(0),
        )
        .unwrap_or(0);

    // Scoped memories via mentions
    let scoped: i64 = conn
        .query_row(
            "SELECT COUNT(DISTINCT mem.memory_id) FROM memory_entity_mentions mem
             JOIN entities e ON e.id = mem.entity_id WHERE e.agent_id = ?1",
            params![agent_id],
            |r| r.get(0),
        )
        .unwrap_or(0);

    // Assigned = attributes with non-null memory_id
    let assigned: i64 = conn
        .query_row(
            "SELECT COUNT(DISTINCT memory_id) FROM entity_attributes
             WHERE agent_id = ?1 AND memory_id IS NOT NULL AND status = 'active'",
            params![agent_id],
            |r| r.get(0),
        )
        .unwrap_or(0);

    let coverage = if scoped > 0 {
        (assigned as f64 / scoped as f64) * 100.0
    } else {
        0.0
    };

    // Aspect weight stats
    let avg_weight: f64 = conn
        .query_row(
            "SELECT AVG(weight) FROM entity_aspects WHERE agent_id = ?1",
            params![agent_id],
            |r| r.get(0),
        )
        .unwrap_or(0.5);
    let max_weight: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM entity_aspects WHERE agent_id = ?1 AND weight >= 1.0",
            params![agent_id],
            |r| r.get(0),
        )
        .unwrap_or(0);
    let min_weight: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM entity_aspects WHERE agent_id = ?1 AND weight <= 0.1",
            params![agent_id],
            |r| r.get(0),
        )
        .unwrap_or(0);

    // Feedback-updated aspects (last 7 days)
    let week_ago = chrono::Utc::now() - chrono::Duration::days(7);
    let feedback: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM entity_aspects WHERE agent_id = ?1 AND updated_at >= ?2",
            params![agent_id, week_ago.to_rfc3339()],
            |r| r.get(0),
        )
        .unwrap_or(0);

    Ok(KnowledgeStats {
        entity_count: entities,
        aspect_count: aspects,
        attribute_count: attributes,
        constraint_count: constraints,
        dependency_count: deps,
        unassigned_memory_count: scoped - assigned,
        coverage_percent: coverage,
        feedback_updated_aspect_count: feedback,
        average_aspect_weight: avg_weight,
        max_weight_aspect_count: max_weight,
        min_weight_aspect_count: min_weight,
    })
}

// ---------------------------------------------------------------------------
// Graph traversal
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default)]
pub struct TraversalConfig {
    pub max_aspects_per_entity: usize,
    pub max_attributes_per_aspect: usize,
    pub max_dependency_hops: usize,
    pub min_dependency_strength: f64,
    pub timeout_ms: u64,
    pub aspect_filter: Option<String>,
}

impl TraversalConfig {
    pub fn default_config() -> Self {
        Self {
            max_aspects_per_entity: 10,
            max_attributes_per_aspect: 20,
            max_dependency_hops: 30,
            min_dependency_strength: 0.3,
            timeout_ms: 500,
            aspect_filter: None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConstraintEntry {
    pub entity_name: String,
    pub content: String,
    pub importance: f64,
}

#[derive(Debug, Clone)]
pub struct TraversalResult {
    pub memory_ids: HashSet<String>,
    pub constraints: Vec<ConstraintEntry>,
    pub entity_count: usize,
    pub timed_out: bool,
    pub active_aspect_ids: Vec<String>,
}

pub fn traverse_knowledge_graph(
    conn: &Connection,
    focal_ids: &[String],
    agent_id: &str,
    config: &TraversalConfig,
) -> TraversalResult {
    let deadline = Instant::now() + std::time::Duration::from_millis(config.timeout_ms);
    let mut visited = HashSet::new();
    let mut memory_ids = HashSet::new();
    let mut constraints = Vec::new();
    let mut aspect_ids = Vec::new();
    let mut timed_out = false;

    // Process focal entities
    for eid in focal_ids {
        if !visited.insert(eid.clone()) {
            continue;
        }
        if Instant::now() > deadline {
            timed_out = true;
            break;
        }

        collect_entity(
            conn,
            eid,
            agent_id,
            config,
            &mut memory_ids,
            &mut constraints,
            &mut aspect_ids,
        );
    }

    // Expand via dependencies (one hop)
    if !timed_out {
        let focal_set: Vec<&str> = focal_ids.iter().map(|s| s.as_str()).collect();
        if let Ok(targets) = expand_dependencies(conn, &focal_set, agent_id, config) {
            for tid in targets {
                if Instant::now() > deadline {
                    timed_out = true;
                    break;
                }
                if !visited.insert(tid.clone()) {
                    continue;
                }
                collect_entity(
                    conn,
                    &tid,
                    agent_id,
                    config,
                    &mut memory_ids,
                    &mut constraints,
                    &mut aspect_ids,
                );
            }
        }
    }

    constraints.sort_by(|a, b| {
        b.importance
            .partial_cmp(&a.importance)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    TraversalResult {
        memory_ids,
        constraints,
        entity_count: visited.len(),
        timed_out,
        active_aspect_ids: aspect_ids,
    }
}

fn collect_entity(
    conn: &Connection,
    entity_id: &str,
    agent_id: &str,
    config: &TraversalConfig,
    memory_ids: &mut HashSet<String>,
    constraints: &mut Vec<ConstraintEntry>,
    aspect_ids: &mut Vec<String>,
) {
    // Collect constraints (always surface regardless of filters)
    if let Ok(cons) = get_constraints(conn, entity_id, agent_id) {
        let name = conn
            .query_row(
                "SELECT name FROM entities WHERE id = ?1",
                params![entity_id],
                |r| r.get::<_, String>(0),
            )
            .unwrap_or_default();

        for c in cons {
            constraints.push(ConstraintEntry {
                entity_name: name.clone(),
                content: c.content,
                importance: c.importance,
            });
        }
    }

    // Fetch aspects (apply optional filter)
    let aspects = if let Some(filter) = &config.aspect_filter {
        let pattern = format!("%{}%", to_canonical(filter));
        conn.prepare(
            "SELECT id FROM entity_aspects WHERE entity_id = ?1 AND agent_id = ?2
             AND canonical_name LIKE ?3
             ORDER BY weight DESC LIMIT ?4",
        )
        .and_then(|mut stmt| {
            let rows = stmt.query_map(
                params![entity_id, agent_id, pattern, config.max_aspects_per_entity],
                |r| r.get::<_, String>(0),
            )?;
            Ok(rows.filter_map(|r| r.ok()).collect::<Vec<_>>())
        })
        .unwrap_or_default()
    } else {
        conn.prepare(
            "SELECT id FROM entity_aspects WHERE entity_id = ?1 AND agent_id = ?2
             ORDER BY weight DESC LIMIT ?3",
        )
        .and_then(|mut stmt| {
            let rows = stmt.query_map(
                params![entity_id, agent_id, config.max_aspects_per_entity],
                |r| r.get::<_, String>(0),
            )?;
            Ok(rows.filter_map(|r| r.ok()).collect::<Vec<_>>())
        })
        .unwrap_or_default()
    };

    for aid in &aspects {
        aspect_ids.push(aid.clone());

        // Fetch attribute memory_ids
        if let Ok(mut stmt) = conn.prepare(
            "SELECT memory_id FROM entity_attributes WHERE aspect_id = ?1 AND status = 'active'
             ORDER BY importance DESC LIMIT ?2",
        ) {
            let mids: Vec<String> = stmt
                .query_map(params![aid, config.max_attributes_per_aspect], |r| {
                    r.get::<_, Option<String>>(0)
                })
                .ok()
                .into_iter()
                .flatten()
                .filter_map(|r| r.ok())
                .flatten()
                .collect();
            memory_ids.extend(mids);
        }
    }
}

fn expand_dependencies(
    conn: &Connection,
    focal_ids: &[&str],
    agent_id: &str,
    config: &TraversalConfig,
) -> Result<Vec<String>, CoreError> {
    if focal_ids.is_empty() {
        return Ok(Vec::new());
    }

    let placeholders: Vec<String> = (0..focal_ids.len())
        .map(|i| format!("?{}", i + 3))
        .collect();
    let sql = format!(
        "SELECT DISTINCT target_entity_id FROM entity_dependencies
         WHERE agent_id = ?1 AND source_entity_id IN ({}) AND strength >= ?2
         ORDER BY strength DESC LIMIT ?{}",
        placeholders.join(","),
        focal_ids.len() + 3,
    );

    let mut stmt = conn.prepare(&sql)?;
    let mut bound: Vec<Box<dyn rusqlite::types::ToSql>> = vec![
        Box::new(agent_id.to_string()),
        Box::new(config.min_dependency_strength),
    ];
    for id in focal_ids {
        bound.push(Box::new(id.to_string()));
    }
    bound.push(Box::new(config.max_dependency_hops as i64));

    let params = rusqlite::params_from_iter(bound.iter().map(|b| b.as_ref()));
    let rows = stmt.query_map(params, |r| r.get::<_, String>(0))?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

// ---------------------------------------------------------------------------
// Graph search boost (for recall)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct GraphBoostResult {
    pub linked_ids: HashSet<String>,
    pub entity_hits: usize,
    pub timed_out: bool,
}

pub fn get_graph_boost_ids(conn: &Connection, query: &str, timeout_ms: u64) -> GraphBoostResult {
    let deadline = Instant::now() + std::time::Duration::from_millis(timeout_ms);
    let mut result = GraphBoostResult {
        linked_ids: HashSet::new(),
        entity_hits: 0,
        timed_out: false,
    };

    // Tokenize
    let tokens: Vec<String> = query
        .to_lowercase()
        .split_whitespace()
        .filter(|t| t.len() >= 2)
        .map(|t| {
            t.chars()
                .filter(|c| c.is_alphanumeric())
                .collect::<String>()
        })
        .filter(|t| !t.is_empty())
        .collect();

    if tokens.is_empty() {
        return result;
    }

    // Step 1: Resolve entities matching any token
    let mut entity_ids = HashSet::new();
    for token in &tokens {
        let pattern = format!("%{token}%");
        let ids: Vec<String> = conn
            .prepare(
                "SELECT id FROM entities
                 WHERE canonical_name LIKE ?1 OR name LIKE ?1
                 ORDER BY mentions DESC LIMIT 20",
            )
            .and_then(|mut stmt| {
                let rows = stmt.query_map(params![pattern], |r| r.get::<_, String>(0))?;
                Ok(rows.filter_map(|r| r.ok()).collect())
            })
            .unwrap_or_default();
        entity_ids.extend(ids);
    }
    result.entity_hits = entity_ids.len();

    if entity_ids.is_empty() || Instant::now() > deadline {
        result.timed_out = Instant::now() > deadline;
        return result;
    }

    // Step 2: Expand one hop
    let mut expanded = entity_ids.clone();
    for eid in &entity_ids {
        let neighbors: Vec<String> = conn
            .prepare(
                "SELECT target_entity_id FROM relations WHERE source_entity_id = ?1
                 UNION
                 SELECT source_entity_id FROM relations WHERE target_entity_id = ?1
                 LIMIT 50",
            )
            .and_then(|mut stmt| {
                let rows = stmt.query_map(params![eid], |r| r.get::<_, String>(0))?;
                Ok(rows.filter_map(|r| r.ok()).collect())
            })
            .unwrap_or_default();
        expanded.extend(neighbors);
    }

    if Instant::now() > deadline {
        result.timed_out = true;
        return result;
    }

    // Step 3: Collect linked memory IDs
    for eid in &expanded {
        let mids: Vec<String> = conn
            .prepare(
                "SELECT DISTINCT mem.memory_id FROM memory_entity_mentions mem
                 JOIN memories m ON m.id = mem.memory_id
                 WHERE mem.entity_id = ?1 AND m.is_deleted = 0
                 LIMIT 200",
            )
            .and_then(|mut stmt| {
                let rows = stmt.query_map(params![eid], |r| r.get::<_, String>(0))?;
                Ok(rows.filter_map(|r| r.ok()).collect())
            })
            .unwrap_or_default();
        result.linked_ids.extend(mids);
    }

    result.timed_out = Instant::now() > deadline;
    result
}

// ---------------------------------------------------------------------------
// Focal entity resolution
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct FocalEntityResult {
    pub entity_ids: Vec<String>,
    pub entity_names: Vec<String>,
    pub pinned_ids: Vec<String>,
    pub source: String,
}

pub fn resolve_focal_entities(
    conn: &Connection,
    agent_id: &str,
    project: Option<&str>,
    checkpoint_ids: Option<&[String]>,
    query_tokens: Option<&[String]>,
) -> FocalEntityResult {
    let mut result = FocalEntityResult {
        entity_ids: Vec::new(),
        entity_names: Vec::new(),
        pinned_ids: Vec::new(),
        source: "query".into(),
    };

    // Pinned entities always included
    result.pinned_ids = conn
        .prepare("SELECT id FROM entities WHERE agent_id = ?1 AND pinned = 1")
        .and_then(|mut stmt| {
            let rows = stmt.query_map(params![agent_id], |r| r.get::<_, String>(0))?;
            Ok(rows.filter_map(|r| r.ok()).collect())
        })
        .unwrap_or_default();

    // Priority: checkpoint > project > query
    if let Some(ids) = checkpoint_ids
        && !ids.is_empty()
    {
        result.entity_ids = ids.to_vec();
        result.source = "checkpoint".into();
    }

    if result.entity_ids.is_empty()
        && let Some(path) = project
    {
        let tokens = extract_project_tokens(path);
        if !tokens.is_empty() {
            result.entity_ids = match_entities_by_tokens(conn, agent_id, &tokens, 5);
            result.source = "project".into();
        }
    }

    if result.entity_ids.is_empty()
        && let Some(tokens) = query_tokens
        && !tokens.is_empty()
    {
        result.entity_ids = match_entities_by_tokens(conn, agent_id, tokens, 20);
        result.source = "query".into();
    }

    // Merge pinned
    for pid in &result.pinned_ids {
        if !result.entity_ids.contains(pid) {
            result.entity_ids.push(pid.clone());
        }
    }

    // Resolve names
    result.entity_names = get_entity_names(conn, &result.entity_ids);

    result
}

fn extract_project_tokens(path: &str) -> Vec<String> {
    let parts: Vec<&str> = path.split(['/', '\\']).filter(|p| !p.is_empty()).collect();
    parts
        .iter()
        .rev()
        .take(2)
        .map(|p| {
            p.chars()
                .filter(|c| c.is_alphanumeric() || *c == '_' || *c == '-')
                .collect::<String>()
                .to_lowercase()
        })
        .filter(|t| !t.is_empty())
        .collect()
}

fn match_entities_by_tokens(
    conn: &Connection,
    agent_id: &str,
    tokens: &[String],
    limit: usize,
) -> Vec<String> {
    let mut ids = Vec::new();
    for token in tokens {
        let pattern = format!("%{token}%");
        let matched: Vec<String> = conn
            .prepare(
                "SELECT id FROM entities WHERE agent_id = ?1
                 AND (canonical_name LIKE ?2 OR name LIKE ?2)
                 ORDER BY mentions DESC LIMIT ?3",
            )
            .and_then(|mut stmt| {
                let rows =
                    stmt.query_map(params![agent_id, pattern, limit], |r| r.get::<_, String>(0))?;
                Ok(rows.filter_map(|r| r.ok()).collect())
            })
            .unwrap_or_default();
        for mid in matched {
            if !ids.contains(&mid) {
                ids.push(mid);
            }
        }
    }
    ids
}

fn get_entity_names(conn: &Connection, ids: &[String]) -> Vec<String> {
    ids.iter()
        .filter_map(|id| {
            conn.query_row(
                "SELECT name FROM entities WHERE id = ?1",
                params![id],
                |r| r.get::<_, String>(0),
            )
            .ok()
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Constellation overlay
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConstellationEntity {
    pub id: String,
    pub name: String,
    pub entity_type: String,
    pub mentions: i64,
    pub pinned: bool,
    pub aspects: Vec<ConstellationAspect>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConstellationAspect {
    pub id: String,
    pub name: String,
    pub weight: f64,
    pub attributes: Vec<ConstellationAttribute>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConstellationAttribute {
    pub id: String,
    pub content: String,
    pub kind: String,
    pub importance: f64,
    pub memory_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConstellationDependency {
    pub source_entity_id: String,
    pub target_entity_id: String,
    pub dependency_type: String,
    pub strength: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConstellationGraph {
    pub entities: Vec<ConstellationEntity>,
    pub dependencies: Vec<ConstellationDependency>,
}

pub fn get_constellation(
    conn: &Connection,
    agent_id: &str,
) -> Result<ConstellationGraph, CoreError> {
    // Phase 1: Get entities with mentions or pinned or aspects
    let mut stmt = conn.prepare(
        "SELECT e.id, e.name, e.entity_type, e.mentions, e.pinned FROM entities e
         WHERE e.agent_id = ?1 AND (e.mentions > 0 OR e.pinned = 1
           OR EXISTS(SELECT 1 FROM entity_aspects WHERE entity_id = e.id))
         ORDER BY e.pinned DESC, e.mentions DESC, e.name ASC LIMIT 500",
    )?;
    let entity_rows: Vec<(String, String, String, i64, bool)> = stmt
        .query_map(params![agent_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, i64>(3)?,
                r.get::<_, i64>(4)? != 0,
            ))
        })?
        .filter_map(|r| r.ok())
        .collect();

    let entity_set: HashSet<&str> = entity_rows.iter().map(|(id, ..)| id.as_str()).collect();
    let mut entities = Vec::new();

    for (eid, name, etype, mentions, pinned) in &entity_rows {
        // Phase 2: Fetch aspects
        let aspects_raw: Vec<(String, String, f64)> = conn
            .prepare(
                "SELECT id, name, weight FROM entity_aspects
                 WHERE entity_id = ?1 AND agent_id = ?2
                 ORDER BY weight DESC",
            )
            .and_then(|mut s| {
                let rows = s.query_map(params![eid, agent_id], |r| {
                    Ok((r.get(0)?, r.get(1)?, r.get(2)?))
                })?;
                Ok(rows.filter_map(|r| r.ok()).collect())
            })
            .unwrap_or_default();

        let mut aspects = Vec::new();
        for (aid, aname, weight) in aspects_raw {
            // Phase 3: Fetch active attributes
            let attrs: Vec<ConstellationAttribute> = conn
                .prepare(
                    "SELECT id, content, kind, importance, memory_id FROM entity_attributes
                     WHERE aspect_id = ?1 AND status = 'active'
                     ORDER BY importance DESC",
                )
                .and_then(|mut s| {
                    let rows = s.query_map(params![aid], |r| {
                        Ok(ConstellationAttribute {
                            id: r.get(0)?,
                            content: r.get(1)?,
                            kind: r.get(2)?,
                            importance: r.get(3)?,
                            memory_id: r.get(4)?,
                        })
                    })?;
                    Ok(rows.filter_map(|r| r.ok()).collect())
                })
                .unwrap_or_default();

            aspects.push(ConstellationAspect {
                id: aid,
                name: aname,
                weight,
                attributes: attrs,
            });
        }

        entities.push(ConstellationEntity {
            id: eid.clone(),
            name: name.clone(),
            entity_type: etype.clone(),
            mentions: *mentions,
            pinned: *pinned,
            aspects,
        });
    }

    // Phase 4: Fetch dependencies (both endpoints in set)
    let deps: Vec<ConstellationDependency> = conn
        .prepare(
            "SELECT source_entity_id, target_entity_id, dependency_type, strength
             FROM entity_dependencies WHERE agent_id = ?1",
        )
        .and_then(|mut s| {
            let rows = s.query_map(params![agent_id], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, f64>(3)?,
                ))
            })?;
            Ok(rows
                .filter_map(|r| r.ok())
                .filter(|(src, tgt, ..)| {
                    entity_set.contains(src.as_str()) && entity_set.contains(tgt.as_str())
                })
                .map(|(src, tgt, dtype, strength)| ConstellationDependency {
                    source_entity_id: src,
                    target_entity_id: tgt,
                    dependency_type: dtype,
                    strength,
                })
                .collect())
        })
        .unwrap_or_default();

    Ok(ConstellationGraph {
        entities,
        dependencies: deps,
    })
}

// ---------------------------------------------------------------------------
// Memory status propagation
// ---------------------------------------------------------------------------

pub fn propagate_memory_status(conn: &Connection, agent_id: &str) -> Result<usize, CoreError> {
    let orphaned: Vec<String> = conn
        .prepare(
            "SELECT id FROM entity_attributes WHERE agent_id = ?1 AND status = 'active'
             AND memory_id IS NOT NULL
             AND memory_id NOT IN (SELECT id FROM memories WHERE is_deleted = 0)",
        )
        .and_then(|mut stmt| {
            let rows = stmt.query_map(params![agent_id], |r| r.get::<_, String>(0))?;
            Ok(rows.filter_map(|r| r.ok()).collect())
        })
        .unwrap_or_default();

    let count = orphaned.len();
    let ts = now();
    for id in &orphaned {
        conn.execute(
            "UPDATE entity_attributes SET status = 'superseded', updated_at = ?1 WHERE id = ?2",
            params![ts, id],
        )?;
    }
    Ok(count)
}

// ---------------------------------------------------------------------------
// Entity persist from pipeline (extraction)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct PersistEntitiesInput<'a> {
    pub entities: &'a [signet_core::types::ExtractedEntity],
    pub source_memory_id: &'a str,
    pub agent_id: &'a str,
}

#[derive(Debug, Clone, Default)]
pub struct PersistEntitiesResult {
    pub entities_inserted: usize,
    pub entities_updated: usize,
    pub relations_inserted: usize,
    pub relations_updated: usize,
    pub mentions_linked: usize,
}

pub fn persist_entities(
    conn: &Connection,
    input: &PersistEntitiesInput,
) -> Result<PersistEntitiesResult, CoreError> {
    let mut result = PersistEntitiesResult::default();
    let ts = now();

    for triple in input.entities {
        let src_canonical = to_canonical(&triple.source);
        let tgt_canonical = to_canonical(&triple.target);

        // Skip short names
        if src_canonical.len() < 4 || tgt_canonical.len() < 4 {
            continue;
        }

        let src_type = triple.source_type.as_deref().unwrap_or("extracted");
        let tgt_type = triple.target_type.as_deref().unwrap_or("extracted");

        // Upsert source entity
        let src_id = uuid::Uuid::new_v4().to_string();
        let src_result = signet_core::queries::entity::upsert(
            conn,
            &triple.source,
            &src_canonical,
            src_type,
            input.agent_id,
            &src_id,
            &ts,
        )?;

        if let Some(r) = &src_result {
            if r.created {
                result.entities_inserted += 1;
            } else {
                result.entities_updated += 1;
            }
        }

        // Upsert target entity
        let tgt_id = uuid::Uuid::new_v4().to_string();
        let tgt_result = signet_core::queries::entity::upsert(
            conn,
            &triple.target,
            &tgt_canonical,
            tgt_type,
            input.agent_id,
            &tgt_id,
            &ts,
        )?;

        if let Some(r) = &tgt_result {
            if r.created {
                result.entities_inserted += 1;
            } else {
                result.entities_updated += 1;
            }
        }

        // Upsert relation
        if let (Some(src), Some(tgt)) = (&src_result, &tgt_result) {
            let rel_id = uuid::Uuid::new_v4().to_string();
            let created = signet_core::queries::entity::upsert_relation(
                conn,
                &rel_id,
                &src.id,
                &tgt.id,
                &triple.relationship,
                triple.confidence,
                &ts,
            )?;
            if created {
                result.relations_inserted += 1;
            } else {
                result.relations_updated += 1;
            }

            // Link mentions
            signet_core::queries::entity::link_mention(
                conn,
                input.source_memory_id,
                &src.id,
                Some(&triple.source),
                Some(triple.confidence),
                &ts,
            )?;
            result.mentions_linked += 1;

            signet_core::queries::entity::link_mention(
                conn,
                input.source_memory_id,
                &tgt.id,
                Some(&triple.target),
                Some(triple.confidence),
                &ts,
            )?;
            result.mentions_linked += 1;
        }
    }

    Ok(result)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        // Run just enough schema for tests
        conn.execute_batch(
            "CREATE TABLE entities (
                id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, canonical_name TEXT,
                entity_type TEXT NOT NULL, agent_id TEXT NOT NULL DEFAULT 'default',
                description TEXT, mentions INTEGER DEFAULT 0, pinned INTEGER DEFAULT 0,
                pinned_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
            );
            CREATE TABLE relations (
                id TEXT PRIMARY KEY, source_entity_id TEXT NOT NULL, target_entity_id TEXT NOT NULL,
                relation_type TEXT NOT NULL, strength REAL DEFAULT 1.0, mentions INTEGER DEFAULT 1,
                confidence REAL DEFAULT 0.5, metadata TEXT, created_at TEXT NOT NULL, updated_at TEXT
            );
            CREATE TABLE memory_entity_mentions (
                memory_id TEXT NOT NULL, entity_id TEXT NOT NULL,
                mention_text TEXT, confidence REAL, created_at TEXT,
                PRIMARY KEY (memory_id, entity_id)
            );
            CREATE TABLE memories (
                id TEXT PRIMARY KEY, content TEXT, is_deleted INTEGER DEFAULT 0
            );
            CREATE TABLE entity_aspects (
                id TEXT PRIMARY KEY, entity_id TEXT NOT NULL, agent_id TEXT NOT NULL DEFAULT 'default',
                name TEXT NOT NULL, canonical_name TEXT NOT NULL, weight REAL DEFAULT 0.5,
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                UNIQUE(entity_id, canonical_name)
            );
            CREATE TABLE entity_attributes (
                id TEXT PRIMARY KEY, aspect_id TEXT, agent_id TEXT NOT NULL DEFAULT 'default',
                memory_id TEXT, kind TEXT NOT NULL, content TEXT NOT NULL,
                normalized_content TEXT NOT NULL, confidence REAL DEFAULT 0.0,
                importance REAL DEFAULT 0.5, status TEXT NOT NULL DEFAULT 'active',
                superseded_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
            );
            CREATE TABLE entity_dependencies (
                id TEXT PRIMARY KEY, source_entity_id TEXT NOT NULL, target_entity_id TEXT NOT NULL,
                agent_id TEXT NOT NULL DEFAULT 'default', aspect_id TEXT,
                dependency_type TEXT NOT NULL, strength REAL DEFAULT 0.5,
                confidence REAL DEFAULT 0.7,
                reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
            );
            CREATE TABLE task_meta (
                entity_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL DEFAULT 'default',
                status TEXT NOT NULL, expires_at TEXT, retention_until TEXT,
                completed_at TEXT, updated_at TEXT NOT NULL
            );
            CREATE TABLE entity_dependency_history (
                id TEXT PRIMARY KEY, dependency_id TEXT NOT NULL,
                source_entity_id TEXT NOT NULL, target_entity_id TEXT NOT NULL,
                agent_id TEXT NOT NULL DEFAULT 'default', dependency_type TEXT NOT NULL,
                event TEXT NOT NULL, changed_by TEXT NOT NULL, reason TEXT NOT NULL,
                previous_reason TEXT, metadata TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );",
        )
        .unwrap();
        conn
    }

    fn insert_entity(conn: &Connection, id: &str, name: &str) {
        let ts = now();
        conn.execute(
            "INSERT INTO entities (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at)
             VALUES (?1, ?2, ?3, 'concept', 'default', 1, ?4, ?4)",
            params![id, name, to_canonical(name), ts],
        )
        .unwrap();
    }

    #[test]
    fn aspect_upsert_and_list() {
        let conn = setup();
        insert_entity(&conn, "e1", "Test Entity");

        let a1 = upsert_aspect(&conn, "e1", "default", "Capabilities", Some(0.8)).unwrap();
        assert_eq!(a1.canonical_name, "capabilities");
        assert_eq!(a1.weight, 0.8);

        // Upsert same canonical name updates weight
        let a2 = upsert_aspect(&conn, "e1", "default", "capabilities", Some(0.9)).unwrap();
        assert_eq!(a2.id, a1.id);
        assert_eq!(a2.weight, 0.9);

        let aspects = get_aspects(&conn, "e1", "default").unwrap();
        assert_eq!(aspects.len(), 1);
    }

    #[test]
    fn attribute_lifecycle() {
        let conn = setup();
        insert_entity(&conn, "e1", "Test Entity");
        let aspect = upsert_aspect(&conn, "e1", "default", "Skills", None).unwrap();

        let attr = create_attribute(
            &conn,
            &CreateAttributeInput {
                aspect_id: &aspect.id,
                agent_id: "default",
                memory_id: None,
                kind: "attribute",
                content: "Knows Rust",
                confidence: Some(0.9),
                importance: Some(0.7),
            },
        )
        .unwrap();
        assert_eq!(attr.status, "active");
        assert_eq!(attr.importance, 0.7);

        let attrs = get_attributes(&conn, &aspect.id, "default").unwrap();
        assert_eq!(attrs.len(), 1);

        // Create constraint
        create_attribute(
            &conn,
            &CreateAttributeInput {
                aspect_id: &aspect.id,
                agent_id: "default",
                memory_id: None,
                kind: "constraint",
                content: "Must use safe Rust",
                confidence: None,
                importance: Some(1.0),
            },
        )
        .unwrap();

        let constraints = get_constraints(&conn, "e1", "default").unwrap();
        assert_eq!(constraints.len(), 1);

        // Supersede the attribute (constraint stays active)
        supersede_attribute(&conn, &attr.id, "new-attr", "default").unwrap();
        let attrs = get_attributes(&conn, &aspect.id, "default").unwrap();
        assert_eq!(attrs.len(), 1); // only constraint remains active
    }

    #[test]
    fn dependency_crud() {
        let conn = setup();
        insert_entity(&conn, "e1", "Source Entity");
        insert_entity(&conn, "e2", "Target Entity");

        let dep = upsert_dependency(
            &conn,
            UpsertDepInput {
                source_entity_id: "e1",
                target_entity_id: "e2",
                agent_id: "default",
                aspect_id: None,
                dependency_type: "uses",
                strength: Some(0.7),
                confidence: None,
                reason: None,
            },
        )
        .unwrap();
        assert_eq!(dep.dependency_type, "uses");
        assert_eq!(dep.strength, 0.7);

        let from = get_dependencies_from(&conn, "e1", "default").unwrap();
        assert_eq!(from.len(), 1);

        let to = get_dependencies_to(&conn, "e2", "default").unwrap();
        assert_eq!(to.len(), 1);

        delete_dependency(&conn, &dep.id, "default").unwrap();
        let from = get_dependencies_from(&conn, "e1", "default").unwrap();
        assert_eq!(from.len(), 0);
    }

    #[test]
    fn task_meta_lifecycle() {
        let conn = setup();
        insert_entity(&conn, "e1", "Task Entity");

        let meta = upsert_task_meta(&conn, "e1", "default", "open", None, None).unwrap();
        assert_eq!(meta.status, "open");
        assert!(meta.completed_at.is_none());

        update_task_status(&conn, "e1", "default", "done").unwrap();
        let meta = get_task_meta(&conn, "e1", "default").unwrap().unwrap();
        assert_eq!(meta.status, "done");
        assert!(meta.completed_at.is_some());
    }

    #[test]
    fn traversal_collects_memories() {
        let conn = setup();
        insert_entity(&conn, "e1", "TraversalTest");

        // Insert memory
        conn.execute(
            "INSERT INTO memories (id, content, is_deleted) VALUES ('m1', 'test memory', 0)",
            [],
        )
        .unwrap();

        // Create aspect + attribute linked to memory
        let aspect = upsert_aspect(&conn, "e1", "default", "Info", None).unwrap();
        create_attribute(
            &conn,
            &CreateAttributeInput {
                aspect_id: &aspect.id,
                agent_id: "default",
                memory_id: Some("m1"),
                kind: "attribute",
                content: "linked",
                confidence: None,
                importance: None,
            },
        )
        .unwrap();

        let config = TraversalConfig::default_config();
        let result = traverse_knowledge_graph(&conn, &["e1".into()], "default", &config);

        assert!(result.memory_ids.contains("m1"));
        assert_eq!(result.entity_count, 1);
        assert!(!result.timed_out);
    }
}
