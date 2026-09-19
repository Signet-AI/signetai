//! Fresh session/hook/event boundary. Register with `routes::router()` as documented in README.
use crate::{agent, execute, ApiError, AppState};
use axum::{extract::{Query, State}, http::HeaderMap, response::sse::{Event, Sse}, routing::{get, post}, Json, Router};
use futures_util::stream::{self, Stream};
use serde::Deserialize;
use serde_json::{json, Value};
use signet_core_native::Operation;
use std::{convert::Infallible, time::Duration};

const MAX_BODY_BYTES: usize = 256 * 1024;
#[derive(Deserialize)] pub struct SessionReq { #[serde(alias="sessionKey", alias="session_id")] pub session_key: String, pub harness: Option<String>, pub runtime_path: Option<String>, pub project: Option<String> }
#[derive(Deserialize)] pub struct EndReq { #[serde(alias="sessionKey", alias="session_id")] pub session_key: String }
#[derive(Deserialize)] pub struct ReceiptReq { pub receipt_id: String, pub checkpoint: Option<String>, pub hook: String, pub session_key: Option<String>, #[serde(default)] pub payload: Value }
#[derive(Deserialize)] pub struct MessageReq { pub workspace_id: String, pub recipient_agent_id: String, pub kind: String, #[serde(default)] pub payload: Value }
#[derive(Deserialize)] pub struct Poll { pub after_id: Option<i64>, pub limit: Option<usize>, pub workspace_id: Option<String>, pub session_key: Option<String> }
fn bounded(s: &str, max: usize, name: &str) -> Result<String, ApiError> { let v=s.trim(); if v.is_empty() || v.len()>max { return Err(ApiError::bad_request(format!("{name} is empty or too large"))); } Ok(v.to_owned()) }
fn limit(v: Option<usize>) -> usize { v.unwrap_or(100).clamp(1, 500) }
pub async fn start(State(s): State<AppState>, h: HeaderMap, Json(b): Json<SessionReq>) -> Result<Json<Value>,ApiError> { let a=agent(&h,None,None)?; let k=bounded(&b.session_key,512,"session_key")?; let harness=bounded(b.harness.as_deref().unwrap_or("unknown"),128,"harness")?; Ok(Json(execute(&s,Operation::SessionStart{agent_id:a,key:k,harness,runtime_path:b.runtime_path,project:b.project}).await?)) }
pub async fn end(State(s): State<AppState>, h: HeaderMap, Json(b): Json<EndReq>) -> Result<Json<Value>,ApiError> { let a=agent(&h,None,None)?; let k=bounded(&b.session_key,512,"session_key")?; Ok(Json(execute(&s,Operation::SessionEnd{agent_id:a,key:k}).await?)) }
pub async fn receipt(State(s): State<AppState>, h: HeaderMap, Json(b): Json<ReceiptReq>) -> Result<Json<Value>,ApiError> { let a=agent(&h,None,None)?; if serde_json::to_vec(&b.payload).map_err(|_|ApiError::bad_request("invalid payload"))?.len()>MAX_BODY_BYTES { return Err(ApiError::bad_request("payload too large")); } Ok(Json(execute(&s,Operation::HookReceipt{agent_id:a,receipt_id:bounded(&b.receipt_id,128,"receipt_id")?,checkpoint:b.checkpoint,hook:bounded(&b.hook,128,"hook")?,session_key:b.session_key,payload:b.payload}).await?)) }
pub async fn messages(State(s): State<AppState>, h: HeaderMap, Json(b): Json<MessageReq>) -> Result<Json<Value>,ApiError> { let a=agent(&h,None,None)?; Ok(Json(execute(&s,Operation::CrossAgentSend{agent_id:a,workspace_id:bounded(&b.workspace_id,256,"workspace_id")?,recipient_agent_id:bounded(&b.recipient_agent_id,256,"recipient_agent_id")?,kind:bounded(&b.kind,128,"kind")?,payload:b.payload}).await?)) }
pub async fn poll(State(s): State<AppState>, h: HeaderMap, Query(q): Query<Poll>) -> Result<Json<Value>,ApiError> { let a=agent(&h,None,None)?; let r=if let Some(w)=q.workspace_id { execute(&s,Operation::CrossAgentList{agent_id:a,workspace_id:bounded(&w,256,"workspace_id")?,after_id:q.after_id.unwrap_or(0),limit:limit(q.limit)}).await? } else { execute(&s,Operation::HookReceipts{agent_id:a,session_key:q.session_key,after_id:q.after_id.unwrap_or(0),limit:limit(q.limit)}).await? }; Ok(Json(json!({"mode":"snapshot","nextAfterId":r.get("messages").or_else(||r.get("receipts")).and_then(|v|v.as_array()).and_then(|a|a.last()).and_then(|v|v.get("id")).and_then(|v|v.as_i64()).unwrap_or(q.after_id.unwrap_or(0)),"data":r}))) }
pub async fn live(State(s): State<AppState>, h: HeaderMap, Query(q): Query<Poll>) -> Result<Sse<impl Stream<Item=Result<Event,Infallible>>>,ApiError> { let snapshot=poll(State(s),h,q).await?.0; let event=Event::default().event("snapshot").json_data(snapshot).map_err(|_|ApiError::internal("sse encoding failed"))?; Ok(Sse::new(stream::once(async move { Ok(event) })).keep_alive(axum::response::sse::KeepAlive::new().interval(Duration::from_secs(15)))) }
pub fn router() -> Router<AppState> { Router::new().route("/api/boundary/sessions/start",post(start)).route("/api/boundary/sessions/end",post(end)).route("/api/boundary/hooks/receipt",post(receipt)).route("/api/boundary/messages",post(messages)).route("/api/boundary/poll",get(poll)).route("/api/boundary/events",get(live)) }
