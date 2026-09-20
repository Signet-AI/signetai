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
fn workspace(q: &EntityQuery) -> Result<String, ApiError> {
    Ok(q.workspace_id
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .unwrap_or("default")
        .to_owned())
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
        .route(
            "/api/knowledge/entities/{id}",
            get(unsupported_entity_detail),
        )
        .route(
            "/api/knowledge/entities/{id}/aspects",
            get(unsupported_entity_aspects),
        )
        .route(
            "/api/knowledge/entities/{entity_id}/aspects/{aspect_id}/attributes",
            get(unsupported_aspect_attributes),
        )
        .route(
            "/api/knowledge/entities/{id}/dependencies",
            get(unsupported_dependencies),
        )
        .route("/api/knowledge/stats", get(unsupported_stats))
        .route(
            "/api/knowledge/traversal/status",
            get(unsupported_traversal),
        )
        .route(
            "/api/knowledge/constellation",
            get(unsupported_constellation),
        )
}

async fn unsupported_entity_detail() -> Result<Json<Value>, ApiError> {
    Err(ApiError::not_implemented(
        "knowledge entity detail is unsupported by the fresh native operation boundary",
    ))
}
async fn unsupported_entity_aspects() -> Result<Json<Value>, ApiError> {
    Err(ApiError::not_implemented(
        "knowledge aspect listing is unsupported by the fresh native operation boundary",
    ))
}
async fn unsupported_aspect_attributes() -> Result<Json<Value>, ApiError> {
    Err(ApiError::not_implemented(
        "knowledge attribute listing is unsupported by the fresh native operation boundary",
    ))
}
async fn unsupported_dependencies() -> Result<Json<Value>, ApiError> {
    Err(ApiError::not_implemented(
        "knowledge dependencies are unsupported by the fresh native operation boundary",
    ))
}
async fn unsupported_stats() -> Result<Json<Value>, ApiError> {
    Err(ApiError::not_implemented(
        "knowledge stats are unsupported by the fresh native operation boundary",
    ))
}
async fn unsupported_traversal() -> Result<Json<Value>, ApiError> {
    Err(ApiError::not_implemented(
        "knowledge traversal status is unsupported by the fresh native operation boundary",
    ))
}
async fn unsupported_constellation() -> Result<Json<Value>, ApiError> {
    Err(ApiError::not_implemented(
        "knowledge constellation is unsupported by the fresh native operation boundary",
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
                workspace_id: workspace(&q)?,
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
            workspace_id: workspace(&q)?,
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
            workspace_id: workspace(&q)?,
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
                workspace_id: workspace(&q)?,
                entity_id: id,
                limit: limit(q.limit),
            },
        )
        .await?,
    ))
}
