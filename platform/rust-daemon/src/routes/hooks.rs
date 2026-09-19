use crate::{agent, execute, ApiError, AppState};
use axum::{extract::{Path, State}, http::HeaderMap, routing::{get, post}, Json, Router};
use serde::Deserialize;
use serde_json::Value;
use signet_core_native::Operation;

#[derive(Deserialize)] pub struct SessionStart { pub session_key: Option<String>, pub sessionId: Option<String>, pub harness: Option<String>, pub runtime_path: Option<String>, pub project: Option<String> }
#[derive(Deserialize)] pub struct SessionEnd { pub session_key: Option<String>, pub sessionId: Option<String> }
#[derive(Deserialize)] pub struct HookBody { pub hook: Option<String>, pub session_key: Option<String>, pub sessionId: Option<String>, #[serde(default)] pub payload: Value }
fn key(start: Option<String>, id: Option<String>) -> Result<String, ApiError> { start.or(id).map(|v| v.trim().to_owned()).filter(|v| !v.is_empty()).ok_or_else(|| ApiError::bad_request("sessionKey is required")) }
pub async fn session_start(State(state): State<AppState>, headers: HeaderMap, Json(body): Json<SessionStart>) -> Result<Json<Value>, ApiError> { let agent_id=agent(&headers,None,None)?; let key=key(body.session_key,body.sessionId)?; let harness=body.harness.ok_or_else(||ApiError::bad_request("harness is required"))?; Ok(Json(execute(&state,Operation::SessionStart{agent_id,key,harness,runtime_path:body.runtime_path,project:body.project}).await?)) }
pub async fn session_end(State(state): State<AppState>, headers: HeaderMap, Json(body): Json<SessionEnd>) -> Result<Json<Value>, ApiError> { let agent_id=agent(&headers,None,None)?; let key=key(body.session_key,body.sessionId)?; Ok(Json(execute(&state,Operation::SessionEnd{agent_id,key}).await?)) }
pub async fn deliver(State(state): State<AppState>, headers: HeaderMap, Json(body): Json<HookBody>) -> Result<Json<Value>, ApiError> { let agent_id=agent(&headers,None,None)?; let hook=body.hook.ok_or_else(||ApiError::bad_request("hook is required"))?; Ok(Json(execute(&state,Operation::HookDeliver{agent_id,key:body.session_key.or(body.sessionId),hook,payload:body.payload}).await?)) }
pub async fn events(State(state): State<AppState>, headers: HeaderMap, Path(key): Path<String>) -> Result<Json<Value>, ApiError> { let agent_id=agent(&headers,None,None)?; Ok(Json(execute(&state,Operation::EventList{agent_id,key:Some(key),limit:500}).await?)) }
pub(crate) fn router() -> Router<AppState> { Router::new().route("/api/hooks/session-start",post(session_start)).route("/api/hooks/session-end",post(session_end)).route("/api/hooks/deliver",post(deliver)).route("/api/hooks/events/{key}",get(events)) }
