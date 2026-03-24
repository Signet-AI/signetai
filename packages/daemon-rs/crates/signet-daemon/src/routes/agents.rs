//! Agent roster route handlers — parity with TypeScript daemon /api/agents.
//!
//! Added in migration 043 (multi-agent support). Implements GET/POST/DELETE
//! for the agents roster table so shadow divergence logs stay clean.

use std::sync::Arc;

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use rusqlite::OptionalExtension;
use serde::Deserialize;
use serde_json::json;

use crate::state::AppState;

#[derive(Debug, Deserialize)]
pub struct CreateBody {
    name: Option<String>,
    read_policy: Option<String>,
    policy_group: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct DeleteQuery {
    purge: Option<String>,
}

fn row_to_json(row: &rusqlite::Row<'_>) -> rusqlite::Result<serde_json::Value> {
    Ok(json!({
        "id": row.get::<_, String>(0)?,
        "name": row.get::<_, String>(1)?,
        "read_policy": row.get::<_, String>(2)?,
        "policy_group": row.get::<_, Option<String>>(3)?,
        "created_at": row.get::<_, String>(4)?,
        "updated_at": row.get::<_, String>(5)?,
    }))
}

const SELECT: &str =
    "SELECT id, name, read_policy, policy_group, created_at, updated_at FROM agents";

// ---------------------------------------------------------------------------
// GET /api/agents
// ---------------------------------------------------------------------------

pub async fn list(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let result = state
        .pool
        .read(|conn| {
            let mut stmt = conn.prepare_cached(&format!("{SELECT} ORDER BY name"))?;
            let rows = stmt
                .query_map([], row_to_json)?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })
        .await;

    match result {
        Ok(agents) => Json(json!({ "agents": agents })).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e.to_string() }))).into_response(),
    }
}

// ---------------------------------------------------------------------------
// GET /api/agents/:name
// ---------------------------------------------------------------------------

pub async fn get(State(state): State<Arc<AppState>>, Path(name): Path<String>) -> impl IntoResponse {
    let result = state
        .pool
        .read(move |conn| {
            conn.prepare_cached(&format!("{SELECT} WHERE name = ?1"))?
                .query_row(rusqlite::params![name], row_to_json)
                .optional()
                .map_err(|e| e.into())
        })
        .await;

    match result {
        Ok(Some(agent)) => Json(agent).into_response(),
        Ok(None) => (StatusCode::NOT_FOUND, Json(json!({ "error": "Agent not found" }))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e.to_string() }))).into_response(),
    }
}

// ---------------------------------------------------------------------------
// POST /api/agents
// ---------------------------------------------------------------------------

fn validate_name(name: &str) -> Option<&'static str> {
    if name == "default" {
        return Some("Cannot use reserved name 'default'");
    }
    let valid = name
        .chars()
        .enumerate()
        .all(|(i, c)| c.is_ascii_lowercase() || c.is_ascii_digit() || (i > 0 && c == '-'));
    if !valid || name.is_empty() {
        return Some("Name must be lowercase alphanumeric + hyphens only");
    }
    None
}

pub async fn create(
    State(state): State<Arc<AppState>>,
    Json(body): Json<CreateBody>,
) -> impl IntoResponse {
    let name = match body.name.filter(|n| !n.is_empty()) {
        Some(n) => n,
        None => return (StatusCode::BAD_REQUEST, Json(json!({ "error": "name is required" }))).into_response(),
    };
    if let Some(err) = validate_name(&name) {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": err }))).into_response();
    }
    let read_policy = body.read_policy.unwrap_or_else(|| "isolated".to_string());
    let group = body.policy_group;
    let now = chrono::Utc::now().to_rfc3339();

    let result = state
        .pool
        .write(signet_core::db::Priority::High, move |conn| {
            conn.execute(
                "INSERT INTO agents (id, name, read_policy, policy_group, created_at, updated_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                rusqlite::params![name, name, read_policy, group, now, now],
            )?;
            conn.prepare_cached(&format!("{SELECT} WHERE id = ?1"))?
                .query_row(rusqlite::params![name], row_to_json)
                .map_err(|e| e.into())
        })
        .await;

    match result {
        Ok(agent) => (StatusCode::CREATED, Json(agent)).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e.to_string() }))).into_response(),
    }
}

// ---------------------------------------------------------------------------
// DELETE /api/agents/:name
// ---------------------------------------------------------------------------

pub async fn delete(
    State(state): State<Arc<AppState>>,
    Path(name): Path<String>,
    Query(params): Query<DeleteQuery>,
) -> impl IntoResponse {
    if name == "default" {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "Cannot remove the default agent" }))).into_response();
    }
    let purge = params.purge.as_deref() == Some("true");

    let result = state
        .pool
        .write(signet_core::db::Priority::High, move |conn| {
            let exists = conn
                .prepare_cached("SELECT 1 FROM agents WHERE name = ?1")?
                .query_row(rusqlite::params![name], |_| Ok(()))
                .optional()?
                .is_some();
            // Encode not-found vs found as a JSON sentinel so the closure
            // returns a single uniform type (serde_json::Value).
            if !exists {
                return Ok(json!({ "__not_found": true }));
            }
            if purge {
                conn.execute("DELETE FROM memories WHERE agent_id = ?1", rusqlite::params![name])?;
            } else {
                conn.execute(
                    "UPDATE memories SET visibility = 'archived' WHERE agent_id = ?1",
                    rusqlite::params![name],
                )?;
            }
            conn.execute("DELETE FROM agents WHERE name = ?1", rusqlite::params![name])?;
            Ok(json!({ "success": true, "purged": purge }))
        })
        .await;

    match result {
        Ok(v) if v.get("__not_found").is_some() => {
            (StatusCode::NOT_FOUND, Json(json!({ "error": "Agent not found" }))).into_response()
        }
        Ok(v) => Json(v).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e.to_string() }))).into_response(),
    }
}
