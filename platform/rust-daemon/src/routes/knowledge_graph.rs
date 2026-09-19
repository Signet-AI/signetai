use crate::{agent, execute, AgentQuery, ApiError, AppState};
use axum::{extract::{Query, State}, http::{HeaderMap, StatusCode}, routing::{get, post}, Json, Router};
use serde::Deserialize;
use serde_json::Value;
use signet_core_native::Operation;

#[derive(Debug, Deserialize, Default)] struct Scope { #[serde(flatten)] agent: AgentQuery, workspace_id: Option<String> }
#[derive(Debug, Deserialize)] struct Aspect { entity_id: String, name: String, weight: Option<f64> }
#[derive(Debug, Deserialize)] struct Attribute { aspect_id: String, kind: String, content: String, claim_key: Option<String>, group_key: Option<String>, confidence: Option<f64>, importance: Option<f64>, memory_id: Option<String> }
#[derive(Debug, Deserialize)] struct Tree { #[serde(flatten)] scope: Scope, entity_id: String, depth: Option<usize>, max_aspects: Option<usize>, max_attributes: Option<usize> }
fn ws(q: &Scope) -> Result<String, ApiError> { q.workspace_id.clone().filter(|v| !v.trim().is_empty()).ok_or_else(|| ApiError::bad_request("workspace_id is required")) }
pub(crate) fn router() -> Router<AppState> { Router::new().route("/api/knowledge/aspects", post(create_aspect)).route("/api/knowledge/attributes", post(create_attribute)).route("/api/knowledge/navigation/tree", get(tree)) }
async fn create_aspect(State(s): State<AppState>, h: HeaderMap, Query(q): Query<Scope>, Json(b): Json<Aspect>) -> Result<(StatusCode, Json<Value>), ApiError> { let r=execute(&s,Operation::KnowledgeAspectCreate{agent_id:agent(&h,Some(&q.agent),None)?,workspace_id:ws(&q)?,entity_id:b.entity_id,name:b.name,weight:b.weight.unwrap_or(0.5)}).await?; Ok((StatusCode::CREATED,Json(r))) }
async fn create_attribute(State(s): State<AppState>, h: HeaderMap, Query(q): Query<Scope>, Json(b): Json<Attribute>) -> Result<(StatusCode, Json<Value>), ApiError> { let r=execute(&s,Operation::KnowledgeAttributeCreate{agent_id:agent(&h,Some(&q.agent),None)?,workspace_id:ws(&q)?,aspect_id:b.aspect_id,kind:b.kind,content:b.content,claim_key:b.claim_key,group_key:b.group_key,confidence:b.confidence.unwrap_or(0.0),importance:b.importance.unwrap_or(0.5),memory_id:b.memory_id}).await?; Ok((StatusCode::CREATED,Json(r))) }
async fn tree(State(s): State<AppState>, h: HeaderMap, Query(q): Query<Tree>) -> Result<Json<Value>, ApiError> { Ok(Json(execute(&s,Operation::KnowledgeTree{agent_id:agent(&h,Some(&q.scope.agent),None)?,workspace_id:ws(&q.scope)?,entity_id:q.entity_id,depth:q.depth.unwrap_or(3),max_aspects:q.max_aspects.unwrap_or(20),max_attributes:q.max_attributes.unwrap_or(50)}).await?)) }
