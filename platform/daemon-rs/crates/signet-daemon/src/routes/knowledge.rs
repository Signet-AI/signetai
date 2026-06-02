//! Knowledge graph route handlers.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;

use axum::Json;
use axum::extract::{ConnectInfo, Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use signet_core::types::{Entity, EntityAspect};
use signet_services::graph;

use crate::auth::{
    middleware::{authenticate_headers, require_permission_guard, resolve_scoped_agent},
    types::Permission,
};
use crate::state::AppState;

fn escape_like(text: &str) -> String {
    text.replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

// ---------------------------------------------------------------------------
// GET /api/knowledge/entities
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct ListParams {
    pub agent_id: Option<String>,
    #[serde(rename = "type")]
    pub entity_type: Option<String>,
    pub q: Option<String>,
    pub limit: Option<usize>,
    pub offset: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImpactRequest {
    entity_id: Option<String>,
    direction: Option<String>,
    max_depth: Option<usize>,
}

pub async fn graph_impact(
    State(state): State<Arc<AppState>>,
    Json(req): Json<ImpactRequest>,
) -> impl IntoResponse {
    let Some(entity_id) = req.entity_id.map(|id| id.trim().to_string()) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "entityId is required"})),
        )
            .into_response();
    };
    if entity_id.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "entityId is required"})),
        )
            .into_response();
    }
    let direction = if req.direction.as_deref() == Some("upstream") {
        "upstream"
    } else {
        "downstream"
    }
    .to_string();
    let max_depth = req.max_depth.unwrap_or(3).clamp(1, 10);
    let result = state
        .pool
        .read(move |conn| {
            let root = conn
                .query_row(
                    "SELECT name FROM entities WHERE id = ?1",
                    rusqlite::params![&entity_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()?;
            let mut frontier = vec![entity_id.clone()];
            let mut visited = std::collections::HashSet::from([entity_id.clone()]);
            let mut impact = Vec::new();
            for depth in 1..=max_depth {
                if frontier.is_empty() {
                    break;
                }
                let mut found = Vec::new();
                let mut next = Vec::new();
                for current in &frontier {
                    let sql = if direction == "downstream" {
                        "SELECT e.id, e.name, e.entity_type
                           FROM entity_dependencies d
                           JOIN entities e ON e.id = d.target_entity_id
                          WHERE d.source_entity_id = ?1"
                    } else {
                        "SELECT e.id, e.name, e.entity_type
                           FROM entity_dependencies d
                           JOIN entities e ON e.id = d.source_entity_id
                          WHERE d.target_entity_id = ?1"
                    };
                    let mut stmt = conn.prepare_cached(sql)?;
                    let rows = stmt
                        .query_map(rusqlite::params![current], |row| {
                            Ok((
                                row.get::<_, String>(0)?,
                                row.get::<_, String>(1)?,
                                row.get::<_, String>(2)?,
                            ))
                        })?
                        .filter_map(Result::ok)
                        .collect::<Vec<_>>();
                    for (id, name, entity_type) in rows {
                        if visited.insert(id.clone()) {
                            next.push(id.clone());
                            found.push(serde_json::json!({
                                "id": id,
                                "name": name,
                                "type": entity_type,
                            }));
                        }
                    }
                }
                if !found.is_empty() {
                    impact.push(serde_json::json!({
                        "depth": depth,
                        "label": impact_depth_label(depth),
                        "entities": found,
                    }));
                }
                frontier = next;
            }
            Ok(serde_json::json!({
                "entityId": entity_id,
                "entityName": root.unwrap_or_else(|| entity_id.clone()),
                "direction": direction,
                "impact": impact,
            }))
        })
        .await
        .unwrap_or_else(|err| serde_json::json!({"error": err.to_string()}));
    Json(result).into_response()
}

fn impact_depth_label(depth: usize) -> &'static str {
    match depth {
        1 => "WILL BREAK",
        2 => "LIKELY AFFECTED",
        _ => "MAY NEED TESTING",
    }
}

pub async fn list_entities(
    State(state): State<Arc<AppState>>,
    axum::extract::Query(params): axum::extract::Query<ListParams>,
) -> axum::response::Response {
    let agent_id = params.agent_id.unwrap_or_else(|| "default".into());
    let limit = params.limit.unwrap_or(50).min(200);
    let offset = params.offset.unwrap_or(0);
    let entity_type = params.entity_type;
    let q = params.q;

    let result = state
        .pool
        .read(move |conn| {
            let items = graph::list_knowledge_entities(
                conn,
                &agent_id,
                entity_type.as_deref(),
                q.as_deref(),
                limit,
                offset,
            )?;
            Ok(serde_json::json!({
                "items": items,
                "limit": limit,
                "offset": offset,
            }))
        })
        .await;

    match result {
        Ok(val) => (StatusCode::OK, Json(val)).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e.to_string()})),
        )
            .into_response(),
    }
}

// ---------------------------------------------------------------------------
// GET /api/knowledge/entities/:id
// ---------------------------------------------------------------------------

pub async fn get_entity_detail(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    axum::extract::Query(params): axum::extract::Query<AgentIdParam>,
) -> axum::response::Response {
    let agent_id = params.agent_id.unwrap_or_else(|| "default".into());

    let result = state
        .pool
        .read(move |conn| {
            let entity = get_active_entity_by_id(conn, &id, &agent_id)?;
            let Some(entity) = entity else {
                return Ok(serde_json::json!({"_code": 404}));
            };
            let density = graph::get_structural_density(conn, &id, &agent_id)?;
            let incoming: i64 = conn
                .query_row(
                    "SELECT COUNT(*)
                     FROM entity_dependencies dep
                     JOIN entities src ON src.id = dep.source_entity_id AND src.agent_id = dep.agent_id
                     WHERE dep.target_entity_id = ?1
                       AND dep.agent_id = ?2
                       AND COALESCE(dep.status, 'active') = 'active'
                       AND COALESCE(src.status, 'active') = 'active'",
                    rusqlite::params![&id, &agent_id],
                    |r| r.get(0),
                )
                .unwrap_or(0);
            let outgoing: i64 = conn
                .query_row(
                    "SELECT COUNT(*)
                     FROM entity_dependencies dep
                     JOIN entities dst ON dst.id = dep.target_entity_id AND dst.agent_id = dep.agent_id
                     WHERE dep.source_entity_id = ?1
                       AND dep.agent_id = ?2
                       AND COALESCE(dep.status, 'active') = 'active'
                       AND COALESCE(dst.status, 'active') = 'active'",
                    rusqlite::params![&id, &agent_id],
                    |r| r.get(0),
                )
                .unwrap_or(0);

            Ok(serde_json::json!({
                "entity": entity,
                "aspectCount": density.aspect_count,
                "attributeCount": density.attribute_count,
                "constraintCount": density.constraint_count,
                "dependencyCount": density.dependency_count,
                "structuralDensity": density,
                "incomingDependencyCount": incoming,
                "outgoingDependencyCount": outgoing,
            }))
        })
        .await;

    match result {
        Ok(val) => {
            let code = val.get("_code").and_then(|c| c.as_u64());
            if code == Some(404) {
                return (
                    StatusCode::NOT_FOUND,
                    Json(serde_json::json!({"error": "Entity not found"})),
                )
                    .into_response();
            }
            (StatusCode::OK, Json(val)).into_response()
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e.to_string()})),
        )
            .into_response(),
    }
}

// ---------------------------------------------------------------------------
// GET /api/knowledge/entities/:id/aspects
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct AgentIdParam {
    pub agent_id: Option<String>,
}

pub async fn get_aspects(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    axum::extract::Query(params): axum::extract::Query<AgentIdParam>,
) -> axum::response::Response {
    let agent_id = params.agent_id.unwrap_or_else(|| "default".into());

    let result = state
        .pool
        .read(move |conn| {
            let items = graph::get_aspects_with_counts(conn, &id, &agent_id)?;
            Ok(serde_json::json!({"items": items}))
        })
        .await;

    match result {
        Ok(val) => (StatusCode::OK, Json(val)).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e.to_string()})),
        )
            .into_response(),
    }
}

// ---------------------------------------------------------------------------
// GET /api/knowledge/navigation/*
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct NavigationEntityParam {
    pub agent_id: Option<String>,
    pub name: Option<String>,
}

#[derive(Deserialize)]
pub struct NavigationTreeParams {
    pub agent_id: Option<String>,
    pub entity: Option<String>,
    pub max_aspects: Option<usize>,
    pub max_groups: Option<usize>,
    pub max_claims: Option<usize>,
    pub depth: Option<usize>,
}

#[derive(Deserialize)]
pub struct NavigationEntityNameParam {
    pub agent_id: Option<String>,
    pub entity: Option<String>,
}

#[derive(Deserialize)]
pub struct NavigationAspectParams {
    pub agent_id: Option<String>,
    pub entity: Option<String>,
    pub aspect: Option<String>,
}

#[derive(Deserialize)]
pub struct NavigationClaimParams {
    pub agent_id: Option<String>,
    pub entity: Option<String>,
    pub aspect: Option<String>,
    pub group: Option<String>,
}

#[derive(Deserialize)]
pub struct NavigationAttributeParams {
    pub agent_id: Option<String>,
    pub entity: Option<String>,
    pub aspect: Option<String>,
    pub group: Option<String>,
    pub claim: Option<String>,
    pub kind: Option<String>,
    pub status: Option<String>,
    pub limit: Option<usize>,
    pub offset: Option<usize>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NavigationAspect {
    aspect: EntityAspect,
    attribute_count: i64,
    constraint_count: i64,
    group_count: i64,
    claim_count: i64,
    groups: Vec<NavigationGroup>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NavigationGroup {
    group_key: String,
    attribute_count: i64,
    constraint_count: i64,
    claim_count: i64,
    latest_updated_at: Option<String>,
    claims: Vec<NavigationClaim>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NavigationClaim {
    claim_key: String,
    group_key: Option<String>,
    attribute_count: i64,
    constraint_count: i64,
    active_count: i64,
    superseded_count: i64,
    latest_updated_at: Option<String>,
    preview: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NavigationAttribute {
    id: String,
    aspect_id: Option<String>,
    agent_id: String,
    memory_id: Option<String>,
    kind: String,
    content: String,
    normalized_content: String,
    group_key: Option<String>,
    claim_key: Option<String>,
    confidence: f64,
    importance: f64,
    status: String,
    superseded_by: Option<String>,
    created_at: String,
    updated_at: String,
}

fn trimmed_required(input: Option<String>, field: &str) -> Result<String, Response> {
    let value = input.unwrap_or_default().trim().to_string();
    if value.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": format!("{field} is required")})),
        )
            .into_response());
    }
    Ok(value)
}

fn parse_navigation_limit(value: Option<usize>, default: usize, max: usize) -> usize {
    value.unwrap_or(default).clamp(1, max)
}

fn canonical_path_key(value: &str) -> String {
    graph::to_canonical(value).replace(' ', "_")
}

fn row_to_navigation_aspect(row: &rusqlite::Row<'_>) -> rusqlite::Result<EntityAspect> {
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

fn row_to_navigation_attribute(row: &rusqlite::Row<'_>) -> rusqlite::Result<NavigationAttribute> {
    Ok(NavigationAttribute {
        id: row.get("id")?,
        aspect_id: row.get("aspect_id")?,
        agent_id: row.get("agent_id")?,
        memory_id: row.get("memory_id")?,
        kind: row.get("kind")?,
        content: row.get("content")?,
        normalized_content: row.get("normalized_content")?,
        group_key: row.get("group_key")?,
        claim_key: row.get("claim_key")?,
        confidence: row.get("confidence")?,
        importance: row.get("importance")?,
        status: row.get("status")?,
        superseded_by: row.get("superseded_by")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn get_active_entity_by_id(
    conn: &rusqlite::Connection,
    id: &str,
    agent_id: &str,
) -> Result<Option<Entity>, signet_core::error::CoreError> {
    conn.query_row(
        "SELECT *
         FROM entities
         WHERE id = ?1
           AND agent_id = ?2
           AND COALESCE(status, 'active') = 'active'
         LIMIT 1",
        rusqlite::params![id, agent_id],
        |row| {
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
        },
    )
    .optional()
    .map_err(Into::into)
}

fn resolve_entity_by_name(
    conn: &rusqlite::Connection,
    agent_id: &str,
    name: &str,
) -> Result<Option<Entity>, signet_core::error::CoreError> {
    let canonical = graph::to_canonical(name);
    if canonical.is_empty() {
        return Ok(None);
    }
    let escaped = escape_like(&canonical);
    let starts = format!("{escaped}%");
    let contains = format!("%{escaped}%");
    let id: Option<String> = conn
        .query_row(
            "SELECT id
             FROM entities
             WHERE agent_id = ?1
               AND COALESCE(status, 'active') = 'active'
               AND (
                 COALESCE(canonical_name, LOWER(name)) = ?2
                 OR LOWER(name) = ?2
                 OR COALESCE(canonical_name, LOWER(name)) LIKE ?3 ESCAPE '\\'
                 OR LOWER(name) LIKE ?3 ESCAPE '\\'
                 OR COALESCE(canonical_name, LOWER(name)) LIKE ?4 ESCAPE '\\'
                 OR LOWER(name) LIKE ?4 ESCAPE '\\'
               )
             ORDER BY
               CASE
                 WHEN COALESCE(canonical_name, LOWER(name)) = ?2 THEN 0
                 WHEN LOWER(name) = ?2 THEN 1
                 WHEN COALESCE(canonical_name, LOWER(name)) LIKE ?3 ESCAPE '\\' THEN 2
                 WHEN LOWER(name) LIKE ?3 ESCAPE '\\' THEN 3
                 WHEN COALESCE(canonical_name, LOWER(name)) LIKE ?4 ESCAPE '\\' THEN 4
                 WHEN LOWER(name) LIKE ?4 ESCAPE '\\' THEN 5
                 ELSE 6
               END ASC,
               mentions DESC,
               updated_at DESC,
               name ASC
             LIMIT 1",
            rusqlite::params![agent_id, canonical, starts, contains],
            |row| row.get(0),
        )
        .optional()?;
    match id {
        Some(id) => signet_core::queries::entity::get(conn, &id),
        None => Ok(None),
    }
}

fn resolve_aspect_by_name(
    conn: &rusqlite::Connection,
    entity_id: &str,
    agent_id: &str,
    aspect: &str,
) -> Result<Option<EntityAspect>, signet_core::error::CoreError> {
    let canonical = graph::to_canonical(aspect);
    if canonical.is_empty() {
        return Ok(None);
    }
    let item = conn
        .query_row(
            "SELECT *
             FROM entity_aspects
             WHERE entity_id = ?1
               AND agent_id = ?2
               AND COALESCE(status, 'active') = 'active'
               AND (canonical_name = ?3 OR LOWER(name) = ?3)
             ORDER BY weight DESC, updated_at DESC
             LIMIT 1",
            rusqlite::params![entity_id, agent_id, canonical],
            row_to_navigation_aspect,
        )
        .optional()?;
    Ok(item)
}

fn entity_detail_json(
    conn: &rusqlite::Connection,
    entity: Entity,
    agent_id: &str,
) -> Result<serde_json::Value, signet_core::error::CoreError> {
    let density = graph::get_structural_density(conn, &entity.id, agent_id)?;
    let incoming: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM entity_dependencies WHERE target_entity_id = ?1 AND agent_id = ?2",
            rusqlite::params![entity.id, agent_id],
            |r| r.get(0),
        )
        .unwrap_or(0);
    let outgoing: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM entity_dependencies WHERE source_entity_id = ?1 AND agent_id = ?2",
            rusqlite::params![entity.id, agent_id],
            |r| r.get(0),
        )
        .unwrap_or(0);

    Ok(serde_json::json!({
        "entity": entity,
        "aspectCount": density.aspect_count,
        "attributeCount": density.attribute_count,
        "constraintCount": density.constraint_count,
        "dependencyCount": density.dependency_count,
        "structuralDensity": density,
        "incomingDependencyCount": incoming,
        "outgoingDependencyCount": outgoing,
    }))
}

fn query_navigation_groups(
    conn: &rusqlite::Connection,
    aspect_id: &str,
    agent_id: &str,
    limit: Option<usize>,
    include_claims: bool,
    max_claims: usize,
) -> Result<Vec<NavigationGroup>, signet_core::error::CoreError> {
    let sql = format!(
        "SELECT
           COALESCE(ea.group_key, 'general') AS group_key,
           COUNT(DISTINCT CASE WHEN ea.kind = 'attribute' AND ea.status = 'active' THEN ea.id END) AS attribute_count,
           COUNT(DISTINCT CASE WHEN ea.kind = 'constraint' AND ea.status = 'active' THEN ea.id END) AS constraint_count,
           COUNT(DISTINCT CASE WHEN ea.claim_key IS NOT NULL THEN ea.claim_key END) AS claim_count,
           MAX(ea.updated_at) AS latest_updated_at
         FROM entity_attributes ea
         WHERE ea.aspect_id = ?1
           AND ea.agent_id = ?2
           AND ea.status != 'deleted'
         GROUP BY COALESCE(ea.group_key, 'general')
         ORDER BY attribute_count DESC, constraint_count DESC, {}group_key ASC{}",
        if limit.is_some() { "claim_count DESC, " } else { "" },
        if limit.is_some() { " LIMIT ?3" } else { "" }
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = if let Some(limit) = limit {
        stmt.query_map(
            rusqlite::params![aspect_id, agent_id, limit as i64],
            |row| {
                Ok((
                    row.get::<_, String>("group_key")?,
                    row.get::<_, i64>("attribute_count")?,
                    row.get::<_, i64>("constraint_count")?,
                    row.get::<_, i64>("claim_count")?,
                    row.get::<_, Option<String>>("latest_updated_at")?,
                ))
            },
        )?
        .collect::<Result<Vec<_>, _>>()?
    } else {
        stmt.query_map(rusqlite::params![aspect_id, agent_id], |row| {
            Ok((
                row.get::<_, String>("group_key")?,
                row.get::<_, i64>("attribute_count")?,
                row.get::<_, i64>("constraint_count")?,
                row.get::<_, i64>("claim_count")?,
                row.get::<_, Option<String>>("latest_updated_at")?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?
    };

    let mut groups = Vec::with_capacity(rows.len());
    for (group_key, attribute_count, constraint_count, claim_count, latest_updated_at) in rows {
        let claims = if include_claims {
            query_navigation_claims(conn, aspect_id, agent_id, &group_key, Some(max_claims))?
        } else {
            Vec::new()
        };
        groups.push(NavigationGroup {
            group_key,
            attribute_count,
            constraint_count,
            claim_count,
            latest_updated_at,
            claims,
        });
    }
    Ok(groups)
}

fn query_navigation_claims(
    conn: &rusqlite::Connection,
    aspect_id: &str,
    agent_id: &str,
    group: &str,
    limit: Option<usize>,
) -> Result<Vec<NavigationClaim>, signet_core::error::CoreError> {
    let group = canonical_path_key(group);
    let group = if group.is_empty() {
        "general".to_string()
    } else {
        group
    };
    let sql = format!(
        "SELECT
           ea.claim_key,
           ea.group_key,
           COUNT(DISTINCT CASE WHEN ea.kind = 'attribute' THEN ea.id END) AS attribute_count,
           COUNT(DISTINCT CASE WHEN ea.kind = 'constraint' THEN ea.id END) AS constraint_count,
           COUNT(DISTINCT CASE WHEN ea.status = 'active' THEN ea.id END) AS active_count,
           COUNT(DISTINCT CASE WHEN ea.status = 'superseded' THEN ea.id END) AS superseded_count,
           MAX(ea.updated_at) AS latest_updated_at,
           (
             SELECT inner_attr.content
             FROM entity_attributes inner_attr
             WHERE inner_attr.aspect_id = ea.aspect_id
               AND inner_attr.agent_id = ea.agent_id
               AND COALESCE(inner_attr.group_key, 'general') = COALESCE(ea.group_key, 'general')
               AND inner_attr.claim_key = ea.claim_key
               AND inner_attr.status = 'active'
             ORDER BY inner_attr.importance DESC, inner_attr.updated_at DESC
             LIMIT 1
           ) AS preview
         FROM entity_attributes ea
         WHERE ea.aspect_id = ?1
           AND ea.agent_id = ?2
           AND COALESCE(ea.group_key, 'general') = ?3
           AND ea.claim_key IS NOT NULL
           AND ea.status != 'deleted'
         GROUP BY ea.claim_key, COALESCE(ea.group_key, 'general')
         ORDER BY active_count DESC, latest_updated_at DESC, ea.claim_key ASC{}",
        if limit.is_some() { " LIMIT ?4" } else { "" }
    );
    let mut stmt = conn.prepare(&sql)?;
    let mapper = |row: &rusqlite::Row<'_>| {
        Ok(NavigationClaim {
            claim_key: row.get("claim_key")?,
            group_key: row.get("group_key")?,
            attribute_count: row.get("attribute_count")?,
            constraint_count: row.get("constraint_count")?,
            active_count: row.get("active_count")?,
            superseded_count: row.get("superseded_count")?,
            latest_updated_at: row.get("latest_updated_at")?,
            preview: row.get("preview")?,
        })
    };
    let rows = if let Some(limit) = limit {
        stmt.query_map(
            rusqlite::params![aspect_id, agent_id, group, limit as i64],
            mapper,
        )?
        .collect::<Result<Vec<_>, _>>()?
    } else {
        stmt.query_map(rusqlite::params![aspect_id, agent_id, group], mapper)?
            .collect::<Result<Vec<_>, _>>()?
    };
    Ok(rows)
}

pub async fn navigation_entities(
    State(state): State<Arc<AppState>>,
    axum::extract::Query(params): axum::extract::Query<ListParams>,
) -> axum::response::Response {
    list_entities(State(state), axum::extract::Query(params)).await
}

pub async fn navigation_entity(
    State(state): State<Arc<AppState>>,
    axum::extract::Query(params): axum::extract::Query<NavigationEntityParam>,
) -> axum::response::Response {
    let agent_id = params.agent_id.unwrap_or_else(|| "default".into());
    let name = match trimmed_required(params.name, "name") {
        Ok(value) => value,
        Err(resp) => return resp,
    };
    let result = state
        .pool
        .read(move |conn| {
            let Some(entity) = resolve_entity_by_name(conn, &agent_id, &name)? else {
                return Ok(serde_json::json!({"_code": 404}));
            };
            entity_detail_json(conn, entity, &agent_id)
        })
        .await;

    match result {
        Ok(val) if val.get("_code").and_then(|c| c.as_u64()) == Some(404) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"error": "Entity not found"})),
        )
            .into_response(),
        Ok(val) => (StatusCode::OK, Json(val)).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e.to_string()})),
        )
            .into_response(),
    }
}

pub async fn navigation_tree(
    State(state): State<Arc<AppState>>,
    axum::extract::Query(params): axum::extract::Query<NavigationTreeParams>,
) -> axum::response::Response {
    let agent_id = params.agent_id.unwrap_or_else(|| "default".into());
    let entity_name = match trimmed_required(params.entity, "entity") {
        Ok(value) => value,
        Err(resp) => return resp,
    };
    let max_aspects = parse_navigation_limit(params.max_aspects, 20, 100);
    let max_groups = parse_navigation_limit(params.max_groups, 20, 100);
    let max_claims = parse_navigation_limit(params.max_claims, 50, 200);
    let depth = parse_navigation_limit(params.depth, 3, 3);
    let result = state
        .pool
        .read(move |conn| {
            let Some(entity) = resolve_entity_by_name(conn, &agent_id, &entity_name)? else {
                return Ok(serde_json::json!({"_code": 404}));
            };
            let mut stmt = conn.prepare(
                "SELECT
                   asp.*,
                   COUNT(DISTINCT CASE WHEN attr.kind = 'attribute' AND attr.status = 'active' THEN attr.id END) AS attribute_count,
                   COUNT(DISTINCT CASE WHEN attr.kind = 'constraint' AND attr.status = 'active' THEN attr.id END) AS constraint_count,
                   COUNT(DISTINCT CASE WHEN attr.status != 'deleted' THEN COALESCE(attr.group_key, 'general') END) AS group_count,
                   COUNT(DISTINCT CASE
                     WHEN attr.status != 'deleted' AND attr.claim_key IS NOT NULL
                     THEN COALESCE(attr.group_key, 'general') || ':' || attr.claim_key
                   END) AS claim_count
                 FROM entity_aspects asp
                 LEFT JOIN entity_attributes attr
                   ON attr.aspect_id = asp.id AND attr.agent_id = asp.agent_id
                 WHERE asp.entity_id = ?1
                   AND asp.agent_id = ?2
                   AND COALESCE(asp.status, 'active') = 'active'
                 GROUP BY asp.id
                 ORDER BY asp.weight DESC, asp.name ASC
                 LIMIT ?3",
            )?;
            let rows = stmt
                .query_map(
                    rusqlite::params![entity.id, agent_id, max_aspects as i64],
                    |row| {
                        Ok((
                            row_to_navigation_aspect(row)?,
                            row.get::<_, i64>("attribute_count")?,
                            row.get::<_, i64>("constraint_count")?,
                            row.get::<_, i64>("group_count")?,
                            row.get::<_, i64>("claim_count")?,
                        ))
                    },
                )?
                .collect::<Result<Vec<_>, _>>()?;
            let mut items = Vec::with_capacity(rows.len());
            for (aspect, attribute_count, constraint_count, group_count, claim_count) in rows {
                let groups = if depth >= 2 {
                    query_navigation_groups(conn, &aspect.id, &agent_id, Some(max_groups), depth >= 3, max_claims)?
                } else {
                    Vec::new()
                };
                items.push(NavigationAspect {
                    aspect,
                    attribute_count,
                    constraint_count,
                    group_count,
                    claim_count,
                    groups,
                });
            }
            Ok(serde_json::json!({
                "entity": entity,
                "limits": {
                    "maxAspects": max_aspects,
                    "maxGroups": max_groups,
                    "maxClaims": max_claims,
                    "depth": depth,
                },
                "items": items,
            }))
        })
        .await;

    match result {
        Ok(val) if val.get("_code").and_then(|c| c.as_u64()) == Some(404) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"error": "Entity not found"})),
        )
            .into_response(),
        Ok(val) => (StatusCode::OK, Json(val)).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e.to_string()})),
        )
            .into_response(),
    }
}

pub async fn navigation_aspects(
    State(state): State<Arc<AppState>>,
    axum::extract::Query(params): axum::extract::Query<NavigationEntityNameParam>,
) -> axum::response::Response {
    let agent_id = params.agent_id.unwrap_or_else(|| "default".into());
    let entity_name = match trimmed_required(params.entity, "entity") {
        Ok(value) => value,
        Err(resp) => return resp,
    };
    let result = state
        .pool
        .read(move |conn| {
            let Some(entity) = resolve_entity_by_name(conn, &agent_id, &entity_name)? else {
                return Ok(serde_json::json!({"_code": 404}));
            };
            let items = graph::get_aspects_with_counts(conn, &entity.id, &agent_id)?;
            Ok(serde_json::json!({"entity": entity, "items": items}))
        })
        .await;

    match result {
        Ok(val) if val.get("_code").and_then(|c| c.as_u64()) == Some(404) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"error": "Entity not found"})),
        )
            .into_response(),
        Ok(val) => (StatusCode::OK, Json(val)).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e.to_string()})),
        )
            .into_response(),
    }
}

pub async fn navigation_groups(
    State(state): State<Arc<AppState>>,
    axum::extract::Query(params): axum::extract::Query<NavigationAspectParams>,
) -> axum::response::Response {
    let agent_id = params.agent_id.unwrap_or_else(|| "default".into());
    let entity_name = match trimmed_required(params.entity, "entity") {
        Ok(value) => value,
        Err(resp) => return resp,
    };
    let aspect_name = match trimmed_required(params.aspect, "aspect") {
        Ok(value) => value,
        Err(resp) => return resp,
    };
    let result = state
        .pool
        .read(move |conn| {
            let Some(entity) = resolve_entity_by_name(conn, &agent_id, &entity_name)? else {
                return Ok(serde_json::json!({"_code": 404}));
            };
            let Some(aspect) = resolve_aspect_by_name(conn, &entity.id, &agent_id, &aspect_name)?
            else {
                return Ok(serde_json::json!({"_code": 404}));
            };
            let items = query_navigation_groups(conn, &aspect.id, &agent_id, None, false, 0)?;
            Ok(serde_json::json!({"entity": entity, "aspect": aspect, "items": items}))
        })
        .await;

    match result {
        Ok(val) if val.get("_code").and_then(|c| c.as_u64()) == Some(404) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"error": "Entity or aspect not found"})),
        )
            .into_response(),
        Ok(val) => (StatusCode::OK, Json(val)).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e.to_string()})),
        )
            .into_response(),
    }
}

pub async fn navigation_claims(
    State(state): State<Arc<AppState>>,
    axum::extract::Query(params): axum::extract::Query<NavigationClaimParams>,
) -> axum::response::Response {
    let agent_id = params.agent_id.unwrap_or_else(|| "default".into());
    let entity_name = match trimmed_required(params.entity, "entity") {
        Ok(value) => value,
        Err(resp) => return resp,
    };
    let aspect_name = match trimmed_required(params.aspect, "aspect") {
        Ok(value) => value,
        Err(resp) => return resp,
    };
    let group = match trimmed_required(params.group, "group") {
        Ok(value) => value,
        Err(resp) => return resp,
    };
    let result = state
        .pool
        .read(move |conn| {
            let Some(entity) = resolve_entity_by_name(conn, &agent_id, &entity_name)? else {
                return Ok(serde_json::json!({"_code": 404}));
            };
            let Some(aspect) = resolve_aspect_by_name(conn, &entity.id, &agent_id, &aspect_name)?
            else {
                return Ok(serde_json::json!({"_code": 404}));
            };
            let items = query_navigation_claims(conn, &aspect.id, &agent_id, &group, None)?;
            Ok(serde_json::json!({"entity": entity, "aspect": aspect, "items": items}))
        })
        .await;

    match result {
        Ok(val) if val.get("_code").and_then(|c| c.as_u64()) == Some(404) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"error": "Entity or aspect not found"})),
        )
            .into_response(),
        Ok(val) => (StatusCode::OK, Json(val)).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e.to_string()})),
        )
            .into_response(),
    }
}

pub async fn navigation_attributes(
    State(state): State<Arc<AppState>>,
    axum::extract::Query(params): axum::extract::Query<NavigationAttributeParams>,
) -> axum::response::Response {
    let agent_id = params.agent_id.unwrap_or_else(|| "default".into());
    let entity_name = match trimmed_required(params.entity, "entity") {
        Ok(value) => value,
        Err(resp) => return resp,
    };
    let aspect_name = match trimmed_required(params.aspect, "aspect") {
        Ok(value) => value,
        Err(resp) => return resp,
    };
    let group = match trimmed_required(params.group, "group") {
        Ok(value) => value,
        Err(resp) => return resp,
    };
    let claim = match trimmed_required(params.claim, "claim") {
        Ok(value) => value,
        Err(resp) => return resp,
    };
    let limit = params.limit.unwrap_or(50).clamp(1, 200);
    let offset = params.offset.unwrap_or(0);
    let kind = match params.kind.as_deref() {
        Some("attribute" | "constraint") => params.kind.clone(),
        _ => None,
    };
    let status = match params.status.as_deref() {
        Some("active" | "superseded" | "deleted" | "all") => params.status.clone(),
        _ => None,
    };
    let result = state
        .pool
        .read(move |conn| {
            let Some(entity) = resolve_entity_by_name(conn, &agent_id, &entity_name)? else {
                return Ok(serde_json::json!({"_code": 404}));
            };
            let Some(aspect) = resolve_aspect_by_name(conn, &entity.id, &agent_id, &aspect_name)?
            else {
                return Ok(serde_json::json!({"_code": 404}));
            };
            let group = canonical_path_key(&group);
            let group = if group.is_empty() {
                "general".to_string()
            } else {
                group
            };
            let claim = canonical_path_key(&claim);
            if claim.is_empty() {
                return Ok(serde_json::json!({
                    "entity": entity,
                    "aspect": aspect,
                    "items": [],
                    "limit": limit,
                    "offset": offset,
                }));
            }
            let mut conditions = vec![
                "ea.aspect_id = ?1".to_string(),
                "ea.agent_id = ?2".to_string(),
                "COALESCE(ea.group_key, 'general') = ?3".to_string(),
                "ea.claim_key = ?4".to_string(),
            ];
            let mut bound: Vec<Box<dyn rusqlite::types::ToSql>> = vec![
                Box::new(aspect.id.clone()),
                Box::new(agent_id.clone()),
                Box::new(group),
                Box::new(claim),
            ];
            if let Some(kind) = kind {
                conditions.push(format!("ea.kind = ?{}", bound.len() + 1));
                bound.push(Box::new(kind));
            }
            if let Some(status) = status {
                if status != "all" {
                    conditions.push(format!("ea.status = ?{}", bound.len() + 1));
                    bound.push(Box::new(status));
                }
            } else {
                conditions.push("ea.status = 'active'".to_string());
            }
            let limit_idx = bound.len() + 1;
            let offset_idx = bound.len() + 2;
            let sql = format!(
                "SELECT ea.*
                 FROM entity_attributes ea
                 WHERE {}
                 ORDER BY ea.created_at DESC, ea.importance DESC
                 LIMIT ?{limit_idx} OFFSET ?{offset_idx}",
                conditions.join(" AND ")
            );
            bound.push(Box::new(limit as i64));
            bound.push(Box::new(offset as i64));
            let mut stmt = conn.prepare(&sql)?;
            let params = rusqlite::params_from_iter(bound.iter().map(|b| b.as_ref()));
            let items = stmt
                .query_map(params, row_to_navigation_attribute)?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(serde_json::json!({
                "entity": entity,
                "aspect": aspect,
                "items": items,
                "limit": limit,
                "offset": offset,
            }))
        })
        .await;

    match result {
        Ok(val) if val.get("_code").and_then(|c| c.as_u64()) == Some(404) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"error": "Entity or aspect not found"})),
        )
            .into_response(),
        Ok(val) => (StatusCode::OK, Json(val)).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e.to_string()})),
        )
            .into_response(),
    }
}

// ---------------------------------------------------------------------------
// GET /api/knowledge/entities/:id/aspects/:aspectId/attributes
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct AttributeFilterParams {
    pub agent_id: Option<String>,
    pub kind: Option<String>,
    pub status: Option<String>,
    pub limit: Option<usize>,
    pub offset: Option<usize>,
}

pub async fn get_attributes(
    State(state): State<Arc<AppState>>,
    Path((entity_id, aspect_id)): Path<(String, String)>,
    axum::extract::Query(params): axum::extract::Query<AttributeFilterParams>,
) -> axum::response::Response {
    let agent_id = params.agent_id.unwrap_or_else(|| "default".into());
    let limit = params.limit.unwrap_or(50).min(200);
    let offset = params.offset.unwrap_or(0);
    let kind = params.kind;
    let status = params.status;

    let result = state
        .pool
        .read(move |conn| {
            let items = graph::get_attributes_filtered(
                conn,
                &graph::AttributeFilter {
                    entity_id: &entity_id,
                    aspect_id: &aspect_id,
                    agent_id: &agent_id,
                    kind: kind.as_deref(),
                    status: status.as_deref(),
                    limit,
                    offset,
                },
            )?;
            Ok(serde_json::json!({
                "items": items,
                "limit": limit,
                "offset": offset,
            }))
        })
        .await;

    match result {
        Ok(val) => (StatusCode::OK, Json(val)).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e.to_string()})),
        )
            .into_response(),
    }
}

// ---------------------------------------------------------------------------
// GET /api/knowledge/entities/:id/dependencies
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct DependencyParams {
    pub agent_id: Option<String>,
    pub direction: Option<String>,
}

pub async fn get_dependencies(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    axum::extract::Query(params): axum::extract::Query<DependencyParams>,
) -> axum::response::Response {
    let agent_id = params.agent_id.unwrap_or_else(|| "default".into());
    let direction = params.direction.unwrap_or_else(|| "both".into());

    let result = state
        .pool
        .read(move |conn| {
            let items = graph::get_dependencies_detailed(conn, &id, &agent_id, &direction)?;
            Ok(serde_json::json!({"items": items}))
        })
        .await;

    match result {
        Ok(val) => (StatusCode::OK, Json(val)).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e.to_string()})),
        )
            .into_response(),
    }
}

// ---------------------------------------------------------------------------
// POST /api/knowledge/entities/:id/pin
// DELETE /api/knowledge/entities/:id/pin
// ---------------------------------------------------------------------------

pub async fn pin_entity(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    axum::extract::Query(params): axum::extract::Query<AgentIdParam>,
) -> axum::response::Response {
    let agent_id = params.agent_id.unwrap_or_else(|| "default".into());

    let result = state
        .pool
        .write(signet_core::db::Priority::High, move |conn| {
            let ts = chrono::Utc::now().to_rfc3339();
            signet_core::queries::entity::pin(conn, &id, &agent_id, &ts)?;
            let Some(entity) = get_active_entity_by_id(conn, &id, &agent_id)? else {
                return Ok(serde_json::json!({"_code": 404}));
            };
            Ok(serde_json::json!({
                "pinned": true,
                "pinnedAt": entity.pinned_at,
            }))
        })
        .await;

    match result {
        Ok(val) => {
            if val.get("_code").and_then(|c| c.as_u64()) == Some(404) {
                return (
                    StatusCode::NOT_FOUND,
                    Json(serde_json::json!({"error": "Entity not found"})),
                )
                    .into_response();
            }
            (StatusCode::OK, Json(val)).into_response()
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e.to_string()})),
        )
            .into_response(),
    }
}

pub async fn unpin_entity(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    axum::extract::Query(params): axum::extract::Query<AgentIdParam>,
) -> axum::response::Response {
    let agent_id = params.agent_id.unwrap_or_else(|| "default".into());

    let result = state
        .pool
        .write(signet_core::db::Priority::High, move |conn| {
            let ts = chrono::Utc::now().to_rfc3339();
            signet_core::queries::entity::unpin(conn, &id, &agent_id, &ts)?;
            Ok(serde_json::json!({"pinned": false}))
        })
        .await;

    match result {
        Ok(val) => (StatusCode::OK, Json(val)).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e.to_string()})),
        )
            .into_response(),
    }
}

// ---------------------------------------------------------------------------
// GET /api/knowledge/entities/pinned
// ---------------------------------------------------------------------------

pub async fn list_pinned(
    State(state): State<Arc<AppState>>,
    axum::extract::Query(params): axum::extract::Query<AgentIdParam>,
) -> axum::response::Response {
    let agent_id = params.agent_id.unwrap_or_else(|| "default".into());

    let result = state
        .pool
        .read(move |conn| {
            let entities = signet_core::queries::entity::list_pinned(conn, &agent_id)?;
            let items: Vec<serde_json::Value> = entities
                .iter()
                .map(|e| {
                    serde_json::json!({
                        "id": e.id,
                        "name": e.name,
                        "pinnedAt": e.pinned_at,
                    })
                })
                .collect();
            Ok(serde_json::json!(items))
        })
        .await;

    match result {
        Ok(val) => (StatusCode::OK, Json(val)).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e.to_string()})),
        )
            .into_response(),
    }
}

// ---------------------------------------------------------------------------
// GET /api/knowledge/entities/health
// GET /api/knowledge/hygiene
// GET /api/knowledge/communities
// GET /api/knowledge/traversal/status
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct HealthParams {
    pub agent_id: Option<String>,
    pub since: Option<String>,
    pub min_comparisons: Option<usize>,
}

#[derive(Deserialize)]
pub struct HygieneParams {
    pub agent_id: Option<String>,
    pub limit: Option<usize>,
    pub memory_limit: Option<usize>,
}

#[derive(Deserialize)]
pub struct CommunitiesParams {
    pub agent_id: Option<String>,
}

#[derive(Clone)]
struct HealthSample {
    entity_name: String,
    predictor_won: f64,
    margin: f64,
}

fn table_exists(
    conn: &rusqlite::Connection,
    table: &str,
) -> Result<bool, signet_core::error::CoreError> {
    let exists: Option<String> = conn
        .query_row(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?1 LIMIT 1",
            rusqlite::params![table],
            |row| row.get(0),
        )
        .optional()?;
    Ok(exists.is_some())
}

fn is_generic_entity(name: &str, canonical_name: &str, mentions: i64) -> Option<&'static str> {
    let generic = [
        "a", "an", "and", "are", "be", "being", "but", "can", "did", "do", "does", "for", "from",
        "had", "has", "have", "he", "her", "him", "his", "i", "in", "is", "it", "its", "of", "on",
        "or", "she", "that", "the", "their", "them", "they", "this", "to", "was", "we", "were",
        "with", "you", "your",
    ];
    let normalized = graph::to_canonical(if canonical_name.is_empty() {
        name
    } else {
        canonical_name
    });
    if generic.contains(&normalized.as_str()) {
        return Some("generic_word");
    }
    if mentions == 0 {
        return Some("zero_mentions");
    }
    None
}

fn has_word_mention(content: &str, needle: &str) -> bool {
    let content = content.to_lowercase();
    let needle = needle.to_lowercase();
    let mut start = 0;
    while let Some(index) = content[start..].find(&needle) {
        let absolute = start + index;
        let before = content[..absolute].chars().next_back();
        let after = content[absolute + needle.len()..].chars().next();
        let before_ok = before.is_none_or(|c| !c.is_alphanumeric() && c != '_');
        let after_ok = after.is_none_or(|c| !c.is_alphanumeric() && c != '_');
        if before_ok && after_ok {
            return true;
        }
        start = absolute + needle.len();
    }
    false
}

fn mention_snippet(content: &str, needle: &str) -> String {
    let lower = content.to_lowercase();
    let needle = needle.to_lowercase();
    let Some(index) = lower.find(&needle) else {
        return content.chars().take(160).collect();
    };
    let start = index.saturating_sub(60);
    let end = (index + needle.len() + 60).min(content.len());
    let mut snippet = String::new();
    if start > 0 {
        snippet.push_str("...");
    }
    snippet.push_str(&content[start..end]);
    if end < content.len() {
        snippet.push_str("...");
    }
    snippet.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub async fn entity_health(
    State(state): State<Arc<AppState>>,
    axum::extract::Query(params): axum::extract::Query<HealthParams>,
) -> axum::response::Response {
    let agent_id = params.agent_id.unwrap_or_else(|| "default".into());
    let since = params.since.filter(|value| !value.is_empty());
    let min_comparisons = params.min_comparisons.unwrap_or(3).max(1);

    let result = state
        .pool
        .read(move |conn| {
            if !table_exists(conn, "predictor_comparisons")? {
                return Ok(serde_json::json!([]));
            }
            let mut sql = "SELECT focal_entity_id,
                                  COALESCE(focal_entity_name, '') AS focal_entity_name,
                                  predictor_won,
                                  margin
                           FROM predictor_comparisons
                           WHERE agent_id = ?1
                             AND focal_entity_id IS NOT NULL"
                .to_string();
            if since.is_some() {
                sql.push_str(" AND created_at >= ?2");
            }
            sql.push_str(" ORDER BY focal_entity_id ASC, created_at ASC");
            let mut stmt = conn.prepare(&sql)?;
            let rows = if let Some(since) = since {
                stmt.query_map(rusqlite::params![agent_id, since], |row| {
                    Ok((
                        row.get::<_, String>("focal_entity_id")?,
                        HealthSample {
                            entity_name: row.get::<_, String>("focal_entity_name")?,
                            predictor_won: row.get::<_, f64>("predictor_won")?,
                            margin: row.get::<_, f64>("margin")?,
                        },
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?
            } else {
                stmt.query_map(rusqlite::params![agent_id], |row| {
                    Ok((
                        row.get::<_, String>("focal_entity_id")?,
                        HealthSample {
                            entity_name: row.get::<_, String>("focal_entity_name")?,
                            predictor_won: row.get::<_, f64>("predictor_won")?,
                            margin: row.get::<_, f64>("margin")?,
                        },
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?
            };
            let mut grouped: HashMap<String, Vec<HealthSample>> = HashMap::new();
            for (entity_id, sample) in rows {
                grouped.entry(entity_id).or_default().push(sample);
            }
            let mut health = Vec::new();
            for (entity_id, samples) in grouped {
                if samples.len() < min_comparisons {
                    continue;
                }
                let wins = samples
                    .iter()
                    .filter(|sample| sample.predictor_won > 0.0)
                    .count();
                let avg_margin =
                    samples.iter().map(|sample| sample.margin).sum::<f64>() / samples.len() as f64;
                let midpoint = std::cmp::max(1, samples.len() / 2);
                let first_half = &samples[..midpoint];
                let second_half = &samples[midpoint..];
                let first_rate = first_half
                    .iter()
                    .filter(|sample| sample.predictor_won > 0.0)
                    .count() as f64
                    / first_half.len() as f64;
                let second_rate = if second_half.is_empty() {
                    first_rate
                } else {
                    second_half
                        .iter()
                        .filter(|sample| sample.predictor_won > 0.0)
                        .count() as f64
                        / second_half.len() as f64
                };
                let rate_delta = second_rate - first_rate;
                health.push(serde_json::json!({
                    "entityId": entity_id,
                    "entityName": samples.first().map(|sample| sample.entity_name.as_str()).filter(|name| !name.is_empty()).unwrap_or(&entity_id),
                    "comparisonCount": samples.len(),
                    "winRate": wins as f64 / samples.len() as f64,
                    "avgMargin": avg_margin,
                    "trend": if rate_delta > 0.1 { "improving" } else if rate_delta < -0.1 { "declining" } else { "stable" },
                }));
            }
            health.sort_by(|a, b| {
                let a_win = a["winRate"].as_f64().unwrap_or(0.0);
                let b_win = b["winRate"].as_f64().unwrap_or(0.0);
                b_win
                    .partial_cmp(&a_win)
                    .unwrap_or(std::cmp::Ordering::Equal)
                    .then_with(|| {
                        b["comparisonCount"]
                            .as_u64()
                            .unwrap_or(0)
                            .cmp(&a["comparisonCount"].as_u64().unwrap_or(0))
                    })
            });
            Ok(serde_json::json!(health))
        })
        .await;

    match result {
        Ok(val) => (StatusCode::OK, Json(val)).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e.to_string()})),
        )
            .into_response(),
    }
}

pub async fn hygiene(
    State(state): State<Arc<AppState>>,
    axum::extract::Query(params): axum::extract::Query<HygieneParams>,
) -> axum::response::Response {
    let agent_id = params.agent_id.unwrap_or_else(|| "default".into());
    let limit = params.limit.unwrap_or(50).clamp(1, 500);
    let memory_limit = params.memory_limit.unwrap_or(200).clamp(1, 1000);

    let result = state
        .pool
        .read(move |conn| {
            let entity_scan_limit = std::cmp::max(limit * 4, 100);
            let mut stmt = conn.prepare(
                "SELECT id, name, COALESCE(canonical_name, '') AS canonical_name, entity_type, COALESCE(mentions, 0) AS mentions
                 FROM entities
                 WHERE agent_id = ?1
                 ORDER BY updated_at DESC
                 LIMIT ?2",
            )?;
            let entities = stmt
                .query_map(rusqlite::params![agent_id, entity_scan_limit as i64], |row| {
                    Ok((
                        row.get::<_, String>("id")?,
                        row.get::<_, String>("name")?,
                        row.get::<_, String>("canonical_name")?,
                        row.get::<_, String>("entity_type")?,
                        row.get::<_, i64>("mentions")?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?;

            let suspicious_entities = entities
                .iter()
                .filter_map(|(id, name, canonical_name, entity_type, mentions)| {
                    is_generic_entity(name, canonical_name, *mentions).map(|reason| {
                        serde_json::json!({
                            "id": id,
                            "name": name,
                            "canonicalName": if canonical_name.is_empty() { graph::to_canonical(name) } else { canonical_name.clone() },
                            "entityType": entity_type,
                            "mentions": mentions,
                            "reason": reason,
                        })
                    })
                })
                .take(limit)
                .collect::<Vec<_>>();

            let mut stmt = conn.prepare(
                "SELECT canonical_name, COUNT(*) AS count,
                        GROUP_CONCAT(id, char(31)) AS ids,
                        GROUP_CONCAT(name, char(31)) AS names
                 FROM entities
                 WHERE agent_id = ?1
                   AND canonical_name IS NOT NULL
                   AND TRIM(canonical_name) != ''
                 GROUP BY canonical_name
                 HAVING COUNT(*) > 1
                 ORDER BY count DESC, canonical_name ASC
                 LIMIT ?2",
            )?;
            let duplicate_entities = stmt
                .query_map(rusqlite::params![agent_id, limit as i64], |row| {
                    let ids = row
                        .get::<_, Option<String>>("ids")?
                        .unwrap_or_default()
                        .split('\u{1f}')
                        .filter(|part| !part.is_empty())
                        .map(str::to_string)
                        .collect::<Vec<_>>();
                    let names = row
                        .get::<_, Option<String>>("names")?
                        .unwrap_or_default()
                        .split('\u{1f}')
                        .filter(|part| !part.is_empty())
                        .map(str::to_string)
                        .collect::<Vec<_>>();
                    Ok(serde_json::json!({
                        "canonicalName": row.get::<_, String>("canonical_name")?,
                        "count": row.get::<_, i64>("count")?,
                        "ids": ids,
                        "names": names,
                    }))
                })?
                .collect::<Result<Vec<_>, _>>()?;

            let attribute_summary = conn.query_row(
                "SELECT
                   SUM(CASE WHEN group_key IS NULL OR TRIM(group_key) = '' THEN 1 ELSE 0 END) AS missing_group_key,
                   SUM(CASE WHEN claim_key IS NULL OR TRIM(claim_key) = '' THEN 1 ELSE 0 END) AS missing_claim_key,
                   SUM(CASE WHEN memory_id IS NULL
                             OR NOT EXISTS (SELECT 1 FROM memories m WHERE m.id = entity_attributes.memory_id)
                            THEN 1 ELSE 0 END) AS missing_source_memory
                 FROM entity_attributes
                 WHERE agent_id = ?1
                   AND status = 'active'",
                rusqlite::params![agent_id],
                |row| {
                    Ok(serde_json::json!({
                        "missingGroupKey": row.get::<_, Option<i64>>("missing_group_key")?.unwrap_or(0),
                        "missingClaimKey": row.get::<_, Option<i64>>("missing_claim_key")?.unwrap_or(0),
                        "missingSourceMemory": row.get::<_, Option<i64>>("missing_source_memory")?.unwrap_or(0),
                    }))
                },
            )?;

            let mut stmt = conn.prepare(
                "SELECT id, content
                 FROM memories
                 WHERE agent_id = ?1
                   AND is_deleted = 0
                 ORDER BY created_at DESC
                 LIMIT ?2",
            )?;
            let memories = stmt
                .query_map(rusqlite::params![agent_id, memory_limit as i64], |row| {
                    Ok((row.get::<_, String>("id")?, row.get::<_, String>("content")?))
                })?
                .collect::<Result<Vec<_>, _>>()?;

            let known_entities = entities
                .iter()
                .filter(|(_, name, canonical_name, _, _)| is_generic_entity(name, canonical_name, 1).is_none())
                .collect::<Vec<_>>();
            let mut candidates = Vec::new();
            'outer: for (memory_id, content) in memories {
                for (entity_id, entity_name, _, _, _) in &known_entities {
                    if !has_word_mention(&content, entity_name) {
                        continue;
                    }
                    let exists: Option<i64> = conn
                        .query_row(
                            "SELECT 1 FROM memory_entity_mentions WHERE memory_id = ?1 AND entity_id = ?2 LIMIT 1",
                            rusqlite::params![memory_id, entity_id],
                            |row| row.get(0),
                        )
                        .optional()?;
                    if exists.is_some() {
                        continue;
                    }
                    candidates.push(serde_json::json!({
                        "memoryId": memory_id,
                        "entityId": entity_id,
                        "entityName": entity_name,
                        "mentionText": entity_name,
                        "snippet": mention_snippet(&content, entity_name),
                    }));
                    if candidates.len() >= limit {
                        break 'outer;
                    }
                }
            }

            Ok(serde_json::json!({
                "agentId": agent_id,
                "suspiciousEntities": suspicious_entities,
                "duplicateEntities": duplicate_entities,
                "attributeSummary": attribute_summary,
                "safeMentionCandidates": candidates,
            }))
        })
        .await;

    match result {
        Ok(val) => (StatusCode::OK, Json(val)).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e.to_string()})),
        )
            .into_response(),
    }
}

pub async fn communities(
    State(state): State<Arc<AppState>>,
    axum::extract::Query(params): axum::extract::Query<CommunitiesParams>,
) -> axum::response::Response {
    let agent_id = params.agent_id.unwrap_or_else(|| "default".into());
    let result = state
        .pool
        .read(move |conn| {
            if !table_exists(conn, "entity_communities")? {
                return Ok(serde_json::json!({"items": [], "count": 0}));
            }
            let mut stmt = conn.prepare(
                "SELECT id, name, cohesion, member_count, created_at, updated_at
                 FROM entity_communities
                 WHERE agent_id = ?1
                 ORDER BY member_count DESC",
            )?;
            let items = stmt
                .query_map(rusqlite::params![agent_id], |row| {
                    Ok(serde_json::json!({
                        "id": row.get::<_, String>("id")?,
                        "name": row.get::<_, Option<String>>("name")?,
                        "cohesion": row.get::<_, f64>("cohesion")?,
                        "member_count": row.get::<_, i64>("member_count")?,
                        "created_at": row.get::<_, String>("created_at")?,
                        "updated_at": row.get::<_, String>("updated_at")?,
                    }))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(serde_json::json!({"items": items, "count": items.len()}))
        })
        .await;

    match result {
        Ok(val) => (StatusCode::OK, Json(val)).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e.to_string()})),
        )
            .into_response(),
    }
}

pub async fn traversal_status() -> axum::response::Response {
    (StatusCode::OK, Json(serde_json::json!({"status": null}))).into_response()
}

// ---------------------------------------------------------------------------
// GET /api/knowledge/stats
// ---------------------------------------------------------------------------

pub async fn stats(
    State(state): State<Arc<AppState>>,
    axum::extract::Query(params): axum::extract::Query<AgentIdParam>,
) -> axum::response::Response {
    let agent_id = params.agent_id.unwrap_or_else(|| "default".into());

    let result = state
        .pool
        .read(move |conn| {
            let stats = graph::get_knowledge_stats(conn, &agent_id)?;
            Ok(serde_json::to_value(stats).unwrap_or_default())
        })
        .await;

    match result {
        Ok(val) => (StatusCode::OK, Json(val)).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e.to_string()})),
        )
            .into_response(),
    }
}

fn scoped_agent_or_response(
    state: &AppState,
    peer: SocketAddr,
    headers: &HeaderMap,
    requested: Option<&str>,
) -> Result<String, Response> {
    let is_local = peer.ip().is_loopback();
    let auth_runtime = state.auth_snapshot();
    let auth = authenticate_headers(
        auth_runtime.mode,
        auth_runtime.secret.as_deref(),
        headers,
        is_local,
    )
    .map_err(|resp| *resp)?;
    require_permission_guard(&auth, Permission::Recall, auth_runtime.mode, is_local)
        .map_err(|resp| *resp)?;
    resolve_scoped_agent(&auth, auth_runtime.mode, is_local, requested).map_err(|reason| {
        (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({"error": reason})),
        )
            .into_response()
    })
}

// ---------------------------------------------------------------------------
// POST /api/knowledge/expand
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExpandRequest {
    pub entity: Option<String>,
    pub aspect: Option<String>,
    pub max_tokens: Option<usize>,
    pub agent_id: Option<String>,
}

pub(crate) async fn expand_entity_value(
    state: &Arc<AppState>,
    agent_id: String,
    entity_name: String,
    aspect_filter: Option<String>,
    max_tokens: usize,
) -> Result<serde_json::Value, String> {
    state
        .pool
        .read(move |conn| {
            let entity = conn
                .query_row(
                    "SELECT id, name, entity_type, description FROM entities
                     WHERE agent_id = ?1 AND (name = ?2 OR canonical_name = lower(?2))
                     ORDER BY CASE WHEN name = ?2 THEN 0 ELSE 1 END
                     LIMIT 1",
                    rusqlite::params![agent_id, entity_name],
                    |row| {
                        Ok(serde_json::json!({
                            "id": row.get::<_, String>(0)?,
                            "name": row.get::<_, String>(1)?,
                            "type": row.get::<_, String>(2)?,
                            "description": row.get::<_, Option<String>>(3)?,
                        }))
                    },
                )
                .optional()?;

            let Some(entity) = entity else {
                return Ok(serde_json::json!({
                    "_code": 404,
                    "error": format!("Entity \"{}\" not found", entity_name),
                    "entity": null,
                    "constraints": [],
                    "aspects": [],
                    "dependencies": [],
                    "memoryCount": 0,
                    "memories": []
                }));
            };
            let entity_id = entity["id"].as_str().unwrap_or_default().to_string();

            let aspects = {
                let mut sql = "SELECT id, canonical_name, weight FROM entity_aspects WHERE entity_id = ?1 AND agent_id = ?2".to_string();
                if aspect_filter.is_some() {
                    sql.push_str(" AND canonical_name LIKE ?3 ESCAPE '\\'");
                }
                sql.push_str(" ORDER BY weight DESC LIMIT 10");
                let mut stmt = conn.prepare(&sql)?;
                let rows = if let Some(filter) = aspect_filter.as_ref() {
                    let like = format!("%{}%", escape_like(filter));
                    stmt.query_map(rusqlite::params![entity_id, agent_id, like], |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, f64>(2)?,
                        ))
                    })?
                    .collect::<Result<Vec<_>, _>>()?
                } else {
                    stmt.query_map(rusqlite::params![entity_id, agent_id], |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, f64>(2)?,
                        ))
                    })?
                    .collect::<Result<Vec<_>, _>>()?
                };
                let mut out = Vec::new();
                for (aspect_id, name, weight) in rows {
                    let mut attrs_stmt = conn.prepare(
                        "SELECT content, kind, importance, confidence
                         FROM entity_attributes
                         WHERE aspect_id = ?1 AND agent_id = ?2 AND status = 'active'
                         ORDER BY importance DESC LIMIT 20",
                    )?;
                    let attrs = attrs_stmt
                        .query_map(rusqlite::params![aspect_id, agent_id], |row| {
                            Ok(serde_json::json!({
                                "content": row.get::<_, String>(0)?,
                                "kind": row.get::<_, String>(1)?,
                                "importance": row.get::<_, f64>(2)?,
                                "confidence": row.get::<_, f64>(3)?,
                            }))
                        })?
                        .collect::<Result<Vec<_>, _>>()?;
                    out.push(serde_json::json!({
                        "name": name,
                        "weight": weight,
                        "attributes": attrs
                    }));
                }
                out
            };

            let dependencies = {
                let mut stmt = conn.prepare(
                    "SELECT e.name, ed.dependency_type, ed.strength
                     FROM entity_dependencies ed
                     JOIN entities e ON e.id = ed.target_entity_id
                     WHERE ed.source_entity_id = ?1 AND ed.agent_id = ?2 AND ed.strength >= 0.3
                     ORDER BY ed.strength DESC LIMIT 10",
                )?;
                stmt.query_map(rusqlite::params![entity_id, agent_id], |row| {
                    Ok(serde_json::json!({
                        "target": row.get::<_, String>(0)?,
                        "type": row.get::<_, String>(1)?,
                        "strength": row.get::<_, f64>(2)?,
                    }))
                })?
                .collect::<Result<Vec<_>, _>>()?
            };

            let mut memories = Vec::new();
            let mut token_budget = max_tokens;
            let mut stmt = conn.prepare(
                "SELECT m.id, m.content FROM memory_entity_mentions mem
                 JOIN memories m ON m.id = mem.memory_id
                 WHERE mem.entity_id = ?1
                   AND m.agent_id = ?2
                   AND COALESCE(m.visibility, 'global') != 'archived'
                   AND COALESCE(m.is_deleted, 0) = 0
                 ORDER BY m.importance DESC, m.created_at DESC LIMIT 50",
            )?;
            let rows = stmt
                .query_map(rusqlite::params![entity_id, agent_id], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            let memory_count = rows.len();
            for (id, content) in rows {
                let approx_tokens = content.len().div_ceil(4);
                if approx_tokens > token_budget {
                    continue;
                }
                token_budget = token_budget.saturating_sub(approx_tokens);
                memories.push(serde_json::json!({"id": id, "content": content}));
            }

            Ok(serde_json::json!({
                "entity": entity,
                "constraints": [],
                "aspects": aspects,
                "dependencies": dependencies,
                "memoryCount": memory_count,
                "memories": memories,
            }))
        })
        .await
        .map_err(|error| error.to_string())
}

pub async fn expand(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<ExpandRequest>,
) -> axum::response::Response {
    let entity_name = body.entity.unwrap_or_default().trim().to_string();
    if entity_name.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "entity name is required"})),
        )
            .into_response();
    }
    let agent_id = match scoped_agent_or_response(&state, peer, &headers, body.agent_id.as_deref())
    {
        Ok(id) => id,
        Err(resp) => return resp,
    };
    let aspect_filter = body
        .aspect
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let max_tokens = body.max_tokens.unwrap_or(2000).min(10_000);

    let result =
        expand_entity_value(&state, agent_id, entity_name, aspect_filter, max_tokens).await;

    match result {
        Ok(val) => {
            if val.get("_code").and_then(|c| c.as_u64()) == Some(404) {
                return (StatusCode::NOT_FOUND, Json(val)).into_response();
            }
            (StatusCode::OK, Json(val)).into_response()
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e.to_string()})),
        )
            .into_response(),
    }
}

// ---------------------------------------------------------------------------
// POST /api/knowledge/expand/session
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExpandSessionRequest {
    pub entity_name: Option<String>,
    pub agent_id: Option<String>,
    pub session_id: Option<String>,
    pub max_results: Option<usize>,
}

pub async fn expand_session(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<ExpandSessionRequest>,
) -> axum::response::Response {
    let entity_name = body.entity_name.unwrap_or_default().trim().to_string();
    if entity_name.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "entityName is required"})),
        )
            .into_response();
    }
    let agent_id = match scoped_agent_or_response(&state, peer, &headers, body.agent_id.as_deref())
    {
        Ok(id) => id,
        Err(resp) => return resp,
    };
    let session_id = body.session_id;
    let max_results = body.max_results.unwrap_or(10).clamp(1, 50);

    let result = state
        .pool
        .read(move |conn| {
            let entity_id: Option<String> = conn
                .query_row(
                    "SELECT id FROM entities WHERE agent_id = ?1 AND (name = ?2 OR canonical_name = lower(?2)) LIMIT 1",
                    rusqlite::params![agent_id, entity_name],
                    |row| row.get(0),
                )
                .optional()?;
            let Some(entity_id) = entity_id else {
                return Ok(serde_json::json!({"entityName": entity_name, "summaries": [], "total": 0}));
            };

            let use_text_fallback = entity_name.chars().count() >= 4;
            let fallback_clause = if use_text_fallback {
                " OR ss.content LIKE ? ESCAPE '\\'"
            } else {
                ""
            };
            let mut sql = format!(
                "SELECT DISTINCT ss.id, ss.session_key, ss.content, ss.project, ss.latest_at
                 FROM session_summaries ss
                 WHERE ss.agent_id = ? AND ss.kind = 'session'
                   AND COALESCE(ss.source_type, 'summary') = 'summary'"
            );
            let mut args = vec![rusqlite::types::Value::Text(agent_id)];
            if let Some(session_id) = session_id.as_ref() {
                sql.push_str(" AND ss.session_key = ?");
                args.push(rusqlite::types::Value::Text(session_id.clone()));
            }
            sql.push_str(&format!(
                " AND (
                     EXISTS (
                       SELECT 1
                       FROM session_summary_memories ssm
                       JOIN memory_entity_mentions mem ON mem.memory_id = ssm.memory_id
                       WHERE ssm.summary_id = ss.id AND mem.entity_id = ?
                     ){fallback_clause}
                   )
                   ORDER BY ss.latest_at DESC LIMIT ?"
            ));
            args.push(rusqlite::types::Value::Text(entity_id));
            if use_text_fallback {
                args.push(rusqlite::types::Value::Text(format!(
                    "%{}%",
                    escape_like(&entity_name)
                )));
            }
            args.push(rusqlite::types::Value::Integer(max_results as i64));

            let mut stmt = conn.prepare(&sql)?;
            let summaries = stmt
                .query_map(rusqlite::params_from_iter(args.iter()), |row| {
                    Ok(serde_json::json!({
                        "id": row.get::<_, String>(0)?,
                        "sessionKey": row.get::<_, String>(1)?,
                        "summary": row.get::<_, String>(2)?,
                        "project": row.get::<_, Option<String>>(3)?,
                        "latestAt": row.get::<_, String>(4)?,
                    }))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(serde_json::json!({"entityName": entity_name, "total": summaries.len(), "summaries": summaries}))
        })
        .await;

    match result {
        Ok(val) => (StatusCode::OK, Json(val)).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e.to_string()})),
        )
            .into_response(),
    }
}

// ---------------------------------------------------------------------------
// GET /api/knowledge/constellation
// ---------------------------------------------------------------------------

pub async fn constellation(
    State(state): State<Arc<AppState>>,
    axum::extract::Query(params): axum::extract::Query<AgentIdParam>,
) -> axum::response::Response {
    let agent_id = params.agent_id.unwrap_or_else(|| "default".into());

    let result = state
        .pool
        .read(move |conn| {
            let graph = graph::get_constellation(conn, &agent_id)?;
            Ok(serde_json::to_value(graph).unwrap_or_default())
        })
        .await;

    match result {
        Ok(val) => (StatusCode::OK, Json(val)).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e.to_string()})),
        )
            .into_response(),
    }
}
