//! Knowledge graph route handlers.

use std::net::SocketAddr;
use std::sync::Arc;

use axum::Json;
use axum::extract::{ConnectInfo, Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use rusqlite::OptionalExtension;
use serde::Deserialize;
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
            let entity = signet_core::queries::entity::get(conn, &id)?;
            let Some(entity) = entity else {
                return Ok(serde_json::json!({"_code": 404}));
            };
            let density = graph::get_structural_density(conn, &id, &agent_id)?;
            let incoming: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM entity_dependencies WHERE target_entity_id = ?1 AND agent_id = ?2",
                    rusqlite::params![id, agent_id],
                    |r| r.get(0),
                )
                .unwrap_or(0);
            let outgoing: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM entity_dependencies WHERE source_entity_id = ?1 AND agent_id = ?2",
                    rusqlite::params![id, agent_id],
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
                    Json(serde_json::json!({"error": "entity not found"})),
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
            let entity = signet_core::queries::entity::get(conn, &id)?;
            if entity.is_none() {
                return Ok(serde_json::json!({"_code": 404}));
            }
            let ts = chrono::Utc::now().to_rfc3339();
            signet_core::queries::entity::pin(conn, &id, &agent_id, &ts)?;
            Ok(serde_json::json!({"pinned": true, "pinnedAt": ts}))
        })
        .await;

    match result {
        Ok(val) => {
            if val.get("_code").and_then(|c| c.as_u64()) == Some(404) {
                return (
                    StatusCode::NOT_FOUND,
                    Json(serde_json::json!({"error": "entity not found"})),
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
    let auth = authenticate_headers(
        state.auth_mode,
        state.auth_secret.as_deref(),
        headers,
        is_local,
    )
    .map_err(|resp| *resp)?;
    require_permission_guard(&auth, Permission::Recall, state.auth_mode, is_local)
        .map_err(|resp| *resp)?;
    resolve_scoped_agent(&auth, state.auth_mode, is_local, requested).map_err(|reason| {
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

    let result = state
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
                        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, f64>(2)?))
                    })?.collect::<Result<Vec<_>, _>>()?
                } else {
                    stmt.query_map(rusqlite::params![entity_id, agent_id], |row| {
                        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, f64>(2)?))
                    })?.collect::<Result<Vec<_>, _>>()?
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
                    out.push(serde_json::json!({"name": name, "weight": weight, "attributes": attrs}));
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
        .await;

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
