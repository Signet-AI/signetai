use crate::{agent, execute, AgentQuery, ApiError, AppState};
use axum::{
    extract::{Path, Query, State},
    http::HeaderMap,
    routing::get,
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use signet_core_native::Operation;

#[derive(Debug, Deserialize, Default)]
pub(crate) struct OntologyQuery {
    #[serde(flatten)]
    pub agent: AgentQuery,
    pub workspace_id: Option<String>,
    pub limit: Option<usize>,
    pub cursor: Option<String>,
}

fn workspace(q: &OntologyQuery) -> Result<String, ApiError> {
    q.workspace_id
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| ApiError::bad_request("workspace_id is required"))
}
fn validated_kind(kind: &str) -> Result<String, ApiError> {
    let value = kind.trim();
    (!value.is_empty() && value.len() <= 64)
        .then(|| value.to_owned())
        .ok_or_else(|| ApiError::bad_request("ontology kind is required"))
}

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/api/ontology/{kind}", get(list).post(upsert))
        .route("/api/ontology/{kind}/{id}", get(get_one).delete(remove))
        .route("/api/claims", get(list_claims).post(create_claim))
        .route(
            "/api/constraints",
            get(list_constraints).post(create_constraint),
        )
}

async fn list(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(kind): Path<String>,
    Query(q): Query<OntologyQuery>,
) -> Result<Json<Value>, ApiError> {
    let agent_id = agent(&headers, Some(&q.agent), None)?;
    let workspace_id = workspace(&q)?;
    let result = execute(
        &state,
        Operation::OntologyList {
            agent_id,
            workspace_id,
            kind: validated_kind(&kind)?,
            limit: q.limit,
            cursor: q.cursor,
        },
    )
    .await?;
    Ok(Json(
        json!({"items":result.get("items").cloned().unwrap_or_else(|| json!([])), "nextCursor": result.get("nextCursor").cloned().unwrap_or(Value::Null), "complete": result.get("complete").and_then(Value::as_bool).unwrap_or(true)}),
    ))
}
async fn get_one(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((kind, id)): Path<(String, String)>,
    Query(q): Query<OntologyQuery>,
) -> Result<Json<Value>, ApiError> {
    let result = execute(
        &state,
        Operation::OntologyGet {
            agent_id: agent(&headers, Some(&q.agent), None)?,
            workspace_id: workspace(&q)?,
            kind: validated_kind(&kind)?,
            id,
        },
    )
    .await?;
    if result.is_null() {
        return Err(ApiError::not_found("ontology record not found"));
    }
    Ok(Json(result))
}
async fn upsert(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(kind): Path<String>,
    Query(q): Query<OntologyQuery>,
    Json(value): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let result = execute(
        &state,
        Operation::OntologyUpsert {
            agent_id: agent(&headers, Some(&q.agent), None)?,
            workspace_id: workspace(&q)?,
            kind: validated_kind(&kind)?,
            id: value.get("id").and_then(Value::as_str).map(str::to_owned),
            value,
        },
    )
    .await?;
    Ok(Json(result))
}
async fn remove(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((kind, id)): Path<(String, String)>,
    Query(q): Query<OntologyQuery>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(
        execute(
            &state,
            Operation::OntologyDelete {
                agent_id: agent(&headers, Some(&q.agent), None)?,
                workspace_id: workspace(&q)?,
                kind: validated_kind(&kind)?,
                id,
            },
        )
        .await?,
    ))
}
async fn list_claims(
    state: State<AppState>,
    headers: HeaderMap,
    q: Query<OntologyQuery>,
) -> Result<Json<Value>, ApiError> {
    list(state, headers, Path("claim".into()), q).await
}
async fn list_constraints(
    state: State<AppState>,
    headers: HeaderMap,
    q: Query<OntologyQuery>,
) -> Result<Json<Value>, ApiError> {
    list(state, headers, Path("constraint".into()), q).await
}
async fn create_claim(
    state: State<AppState>,
    headers: HeaderMap,
    q: Query<OntologyQuery>,
    body: Json<Value>,
) -> Result<Json<Value>, ApiError> {
    upsert(state, headers, Path("claim".into()), q, body).await
}
async fn create_constraint(
    state: State<AppState>,
    headers: HeaderMap,
    q: Query<OntologyQuery>,
    body: Json<Value>,
) -> Result<Json<Value>, ApiError> {
    upsert(state, headers, Path("constraint".into()), q, body).await
}
