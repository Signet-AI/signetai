use crate::{agent, execute, AgentQuery, ApiError, AppState};
use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::Value;
use signet_core_native::Operation;

#[derive(Debug, Deserialize, Default)]
struct EntityQuery {
    #[serde(flatten)]
    agent: AgentQuery,
    limit: Option<usize>,
    offset: Option<usize>,
    workspace_id: Option<String>,
    direction: Option<String>,
    name: Option<String>,
}
#[derive(Debug, Deserialize)]
struct EntityBody {
    name: String,
    #[serde(rename = "type")]
    entity_type: String,
    #[serde(default)]
    metadata: Value,
}
#[derive(Debug, Deserialize)]
struct RelationBody {
    from_id: String,
    to_id: String,
    relation: String,
    #[serde(default)]
    metadata: Value,
}

fn limit(value: Option<usize>) -> usize {
    value.unwrap_or(50).clamp(1, 200)
}
fn workspace(headers: &HeaderMap, q: &EntityQuery) -> Result<String, ApiError> {
    let aliases = ["x-workspace-id", "x-signet-workspace-id"];
    let values = aliases
        .iter()
        .filter_map(|name| headers.get(*name))
        .map(|v| v.to_str().map(str::trim))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| ApiError::bad_request("workspace header must be valid UTF-8"))?;
    if values.windows(2).any(|pair| pair[0] != pair[1]) {
        return Err(ApiError::bad_request("conflicting workspace aliases"));
    }
    let header = values.first().copied();
    let query = q
        .workspace_id
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty());
    if header.is_some() && query.is_some() && header != query {
        return Err(ApiError::bad_request("conflicting workspace scope"));
    }
    Ok(header.or(query).unwrap_or("default").to_owned())
}
fn valid_metadata(v: &Value) -> Result<Value, ApiError> {
    if v.is_null() {
        return Ok(Value::Object(Default::default()));
    }
    if !v.is_object() {
        return Err(ApiError::bad_request("metadata must be an object"));
    }
    Ok(v.clone())
}

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/knowledge/entities",
            get(list_entities).post(create_entity),
        )
        .route(
            "/api/knowledge/entities/{id}/relations",
            get(list_relations),
        )
        .route("/api/knowledge/relations", post(create_relation))
        .route("/api/knowledge/navigation/entities", get(list_entities))
        .route("/api/knowledge/navigation/entity", get(navigation_entity))
        .route("/api/knowledge/entities/{id}", get(entity_detail))
        .route("/api/knowledge/entities/{id}/aspects", get(entity_aspects))
        .route(
            "/api/knowledge/entities/{entity_id}/aspects/{aspect_id}/attributes",
            get(aspect_attributes),
        )
        .route(
            "/api/knowledge/entities/{id}/dependencies",
            get(entity_dependencies),
        )
        .route("/api/knowledge/stats", get(stats))
        .route(
            "/api/knowledge/traversal/status",
            get(unsupported_traversal),
        )
        .route("/api/knowledge/constellation", get(constellation))
}

async fn navigation_entity(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<EntityQuery>,
) -> Result<Json<Value>, ApiError> {
    let name = q.name.as_deref().map(str::trim).filter(|v| !v.is_empty())
        .ok_or_else(|| ApiError::bad_request("name is required"))?;
    Ok(Json(execute(&state, Operation::KnowledgeNavigationEntity {
        agent_id: agent(&headers, Some(&q.agent), None)?,
        workspace_id: workspace(&headers, &q)?,
        name: name.to_owned(),
    }).await?))
}

async fn entity_detail(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Query(q): Query<EntityQuery>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(
        execute(
            &state,
            Operation::KnowledgeEntityDetail {
                agent_id: agent(&headers, Some(&q.agent), None)?,
                workspace_id: workspace(&headers, &q)?,
                entity_id: id,
            },
        )
        .await?,
    ))
}
async fn entity_aspects(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Query(q): Query<EntityQuery>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(
        execute(
            &state,
            Operation::KnowledgeAspects {
                agent_id: agent(&headers, Some(&q.agent), None)?,
                workspace_id: workspace(&headers, &q)?,
                entity_id: id,
            },
        )
        .await?,
    ))
}
async fn aspect_attributes(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((entity_id, aspect_id)): Path<(String, String)>,
    Query(q): Query<EntityQuery>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(
        execute(
            &state,
            Operation::KnowledgeAttributes {
                agent_id: agent(&headers, Some(&q.agent), None)?,
                workspace_id: workspace(&headers, &q)?,
                entity_id,
                aspect_id,
                limit: limit(q.limit),
                offset: q.offset.unwrap_or(0),
                kind: None,
                status: None,
            },
        )
        .await?,
    ))
}

async fn entity_dependencies(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Query(q): Query<EntityQuery>,
) -> Result<Json<Value>, ApiError> {
    let direction = q.direction.as_deref().unwrap_or("both");
    Ok(Json(
        execute(
            &state,
            Operation::KnowledgeDependencies {
                agent_id: agent(&headers, Some(&q.agent), None)?,
                workspace_id: workspace(&headers, &q)?,
                entity_id: id,
                limit: limit(q.limit),
                direction: direction.to_owned(),
            },
        )
        .await?,
    ))
}
async fn stats(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<EntityQuery>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(
        execute(
            &state,
            Operation::KnowledgeStats {
                agent_id: agent(&headers, Some(&q.agent), None)?,
                workspace_id: workspace(&headers, &q)?,
            },
        )
        .await?,
    ))
}
async fn unsupported_traversal() -> Result<Json<Value>, ApiError> {
    Err(ApiError::not_implemented(
        "knowledge traversal status is unsupported by the fresh native operation boundary",
    ))
}
async fn constellation(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<EntityQuery>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(
        execute(
            &state,
            Operation::KnowledgeConstellation {
                agent_id: agent(&headers, Some(&q.agent), None)?,
                workspace_id: workspace(&headers, &q)?,
                limit: limit(q.limit),
            },
        )
        .await?,
    ))
}

async fn list_entities(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<EntityQuery>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(
        execute(
            &state,
            Operation::KnowledgeEntityList {
                agent_id: agent(&headers, Some(&q.agent), None)?,
                workspace_id: workspace(&headers, &q)?,
                limit: limit(q.limit),
                offset: q.offset.unwrap_or(0),
            },
        )
        .await?,
    ))
}
async fn create_entity(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<EntityQuery>,
    Json(body): Json<EntityBody>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let result = execute(
        &state,
        Operation::KnowledgeEntityCreate {
            agent_id: agent(&headers, Some(&q.agent), None)?,
            workspace_id: workspace(&headers, &q)?,
            name: body.name,
            entity_type: body.entity_type,
            metadata: valid_metadata(&body.metadata)?,
        },
    )
    .await?;
    Ok((StatusCode::CREATED, Json(result)))
}
async fn create_relation(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<EntityQuery>,
    Json(body): Json<RelationBody>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let result = execute(
        &state,
        Operation::KnowledgeRelationCreate {
            agent_id: agent(&headers, Some(&q.agent), None)?,
            workspace_id: workspace(&headers, &q)?,
            from_id: body.from_id,
            to_id: body.to_id,
            relation: body.relation,
            metadata: valid_metadata(&body.metadata)?,
        },
    )
    .await?;
    Ok((StatusCode::CREATED, Json(result)))
}
async fn list_relations(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Query(q): Query<EntityQuery>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(
        execute(
            &state,
            Operation::KnowledgeRelations {
                agent_id: agent(&headers, Some(&q.agent), None)?,
                workspace_id: workspace(&headers, &q)?,
                entity_id: id,
                limit: limit(q.limit),
            },
        )
        .await?,
    ))
}
