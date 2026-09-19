use axum::{extract::{Path, State}, http::{header, HeaderMap, StatusCode}, routing::{delete, get, post}, body::Bytes, Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::HashMap, sync::{Mutex, OnceLock}, time::{SystemTime, UNIX_EPOCH}};
use crate::{ApiError, AppState};

const MAX_BODY: usize = 64 * 1024;
static KEYS: OnceLock<Mutex<HashMap<String, KeyRecord>>> = OnceLock::new();
fn keys() -> &'static Mutex<HashMap<String, KeyRecord>> { KEYS.get_or_init(|| Mutex::new(HashMap::new())) }
pub(crate) fn router() -> Router<AppState> { routes() }
#[derive(Clone, Serialize)]
struct KeyRecord { id: String, prefix: String, name: String, role: String, agent_id: Option<String>, created_at: String, revoked_at: Option<String>, expires_at: Option<String>, #[serde(skip)] digest: String }
#[derive(Deserialize)] struct KeyRequest { name: String, #[serde(default)] role: Option<String>, #[serde(default, alias="agentId")] agent_id: Option<String>, #[serde(default)] expires_at: Option<String> }
#[derive(Deserialize)] struct TokenRequest { role: String, #[serde(default)] scope: Value, #[serde(default)] ttl_seconds: Option<u64> }

pub(crate) fn routes() -> Router<AppState> { Router::new()
 .route("/api/auth/methods", get(methods))
 .route("/api/auth/token", post(token)).route("/api/auth/api-keys", get(list).post(create))
 .route("/api/auth/api-keys/{id}", delete(revoke)) }
fn now() -> String { SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs().to_string() }
fn configured() -> Option<String> { std::env::var("SIGNET_API_KEY").ok().filter(|v| !v.trim().is_empty()).or_else(|| std::env::var("SIGNET_TOKEN").ok().filter(|v| !v.trim().is_empty())) }
fn credential(headers: &HeaderMap) -> Option<String> { headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()).and_then(|v| v.strip_prefix("Bearer ")).map(str::to_owned).or_else(|| headers.get("x-signet-api-key").and_then(|v| v.to_str().ok()).map(str::to_owned)) }
fn authorized(headers: &HeaderMap) -> bool { let Some(given)=credential(headers) else { return false }; if configured().as_deref()==Some(given.as_str()) { return true }; let digest=format!("{:x}", simple_digest(&given)); keys().lock().ok().map(|m| m.values().any(|k| k.revoked_at.is_none() && k.digest==digest)).unwrap_or(false) }
fn simple_digest(s: &str) -> u64 { s.bytes().fold(1469598103934665603u64, |h,b| (h ^ b as u64).wrapping_mul(1099511628211)) }
fn gate(headers: &HeaderMap) -> Result<(), ApiError> { if authorized(headers) { Ok(()) } else { Err(ApiError::unauthorized("valid Bearer token or x-signet-api-key is required")) } }
async fn whoami(headers: HeaderMap) -> Result<Json<Value>, ApiError> { let auth=authorized(&headers); Ok(Json(json!({"authenticated":auth,"trustedLocal":false,"effectiveAccess":auth,"claims":null,"mode":"api-key","providers":[{"id":"api-key","type":"api-key","enabled":configured().is_some()}]}))) }
async fn methods() -> Json<Value> { Json(json!({"mode":"api-key","providers":[{"id":"api-key","type":"api-key","enabled":configured().is_some()},{"id":"password","type":"password","enabled":false}]})) }
async fn token(headers: HeaderMap, State(_state): State<AppState>, body: Bytes) -> Result<(StatusCode, Json<Value>), ApiError> { gate(&headers)?; if body.len()>MAX_BODY{return Err(ApiError::bad_request("request body exceeds limit"))}; let req:TokenRequest=serde_json::from_slice(&body).map_err(|_|ApiError::bad_request("invalid request body"))?; if !["admin","operator","agent","readonly"].contains(&req.role.as_str()){return Err(ApiError::bad_request("invalid role"))}; let secret=format!("sig_tok_{}_{}", now(), uuid::Uuid::new_v4()); let ttl=req.ttl_seconds.unwrap_or(3600).min(86400); Ok((StatusCode::OK,Json(json!({"token":secret,"expiresAt":(SystemTime::now()+std::time::Duration::from_secs(ttl)).duration_since(UNIX_EPOCH).unwrap_or_default().as_secs().to_string(),"role":req.role,"scope":req.scope})))) }
async fn list(headers: HeaderMap) -> Result<Json<Value>, ApiError> { gate(&headers)?; let m=keys().lock().map_err(|_|ApiError::internal("auth store unavailable"))?; Ok(Json(json!({"apiKeys":m.values().cloned().collect::<Vec<_>>()}))) }
async fn create(headers: HeaderMap, body: Bytes) -> Result<(StatusCode,Json<Value>),ApiError> { gate(&headers)?; if body.len()>MAX_BODY{return Err(ApiError::bad_request("request body exceeds limit"))}; let req:KeyRequest=serde_json::from_slice(&body).map_err(|_|ApiError::bad_request("invalid request body"))?; let name=req.name.trim(); if name.is_empty(){return Err(ApiError::bad_request("name is required"))}; let role=req.role.unwrap_or_else(||"agent".into()); if !["admin","operator","agent","readonly"].contains(&role.as_str()){return Err(ApiError::bad_request("invalid role"))}; let id=format!("key_{}",uuid::Uuid::new_v4()); let prefix=&uuid::Uuid::new_v4().to_string()[..8]; let secret=format!("sig_sk_{}_{}",prefix,uuid::Uuid::new_v4()); let record=KeyRecord{id:id.clone(),prefix:prefix.into(),name:name.into(),role,agent_id:req.agent_id,created_at:now(),revoked_at:None,expires_at:req.expires_at,digest:format!("{:x}",simple_digest(&secret))}; let public=record.clone(); keys().lock().map_err(|_|ApiError::internal("auth store unavailable"))?.insert(id,record); Ok((StatusCode::CREATED,Json(json!({"apiKey":json!({"id":public.id,"prefix":public.prefix,"name":public.name,"role":public.role,"agentId":public.agent_id,"createdAt":public.created_at,"revokedAt":public.revoked_at,"expiresAt":public.expires_at,"key":secret})})))) }
async fn revoke(headers: HeaderMap, Path(id): Path<String>) -> Result<Json<Value>,ApiError> { gate(&headers)?; let mut m=keys().lock().map_err(|_|ApiError::internal("auth store unavailable"))?; let Some(k)=m.get_mut(&id) else{return Err(ApiError::not_found("API key not found"))}; k.revoked_at=Some(now()); let p=k.clone(); Ok(Json(json!({"apiKey":{"id":p.id,"prefix":p.prefix,"name":p.name,"role":p.role,"revokedAt":p.revoked_at}}))) }
