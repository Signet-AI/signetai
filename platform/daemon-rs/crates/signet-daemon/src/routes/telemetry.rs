//! Telemetry routes backed by the Rust daemon database.
//!
//! This module implements the TypeScript daemon's local-only memory-search QA
//! ledger API. It intentionally reads `memory_search_telemetry` from SQLite and
//! returns the same item/export shapes used by the TS daemon.

use std::{net::SocketAddr, sync::Arc};

use axum::{
    Json,
    extract::{ConnectInfo, Query, State},
    http::{HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
};
use rusqlite::{ToSql, types::Value};
use serde::Deserialize;

use crate::{
    auth::{
        middleware::{AuthState, authenticate_headers, require_permission_guard},
        types::{AuthMode, Permission},
    },
    routes::pipeline::is_loopback,
    state::AppState,
};

#[derive(Debug, Deserialize)]
pub struct MemorySearchQuery {
    agent_id: Option<String>,
    #[serde(rename = "agentId")]
    agent_id_camel: Option<String>,
    session_key: Option<String>,
    #[serde(rename = "sessionKey")]
    session_key_camel: Option<String>,
    project: Option<String>,
    route: Option<String>,
    since: Option<String>,
    until: Option<String>,
    no_hits: Option<String>,
    limit: Option<String>,
    offset: Option<String>,
}

#[derive(Debug)]
struct TelemetryRow {
    id: String,
    created_at: String,
    route: String,
    agent_id: String,
    session_key: Option<String>,
    project: Option<String>,
    query: String,
    keyword_query: Option<String>,
    filters_json: String,
    method: String,
    result_count: i64,
    top_score: Option<f64>,
    no_hits: i64,
    duration_ms: f64,
    timings_json: String,
    results_json: String,
    sources_json: Option<String>,
}

fn optional_text(value: Option<String>) -> Option<String> {
    value
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn parse_limit(raw: Option<&str>, default: i64, max: i64) -> i64 {
    raw.and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(default)
        .clamp(1, max)
}

fn parse_offset(raw: Option<&str>) -> i64 {
    raw.and_then(|v| v.parse::<i64>().ok()).unwrap_or(0).max(0)
}

fn parse_no_hits(raw: Option<&str>) -> Option<bool> {
    match raw {
        Some("1") | Some("true") => Some(true),
        Some("0") | Some("false") => Some(false),
        _ => None,
    }
}

fn require_telemetry_access(
    state: &AppState,
    headers: &HeaderMap,
    peer: &SocketAddr,
) -> Result<AuthState, Box<Response>> {
    let is_local = is_loopback(peer);
    let auth = authenticate_headers(
        state.auth_mode,
        state.auth_secret.as_deref(),
        headers,
        is_local,
    )?;
    require_permission_guard(&auth, Permission::Analytics, state.auth_mode, is_local)?;
    Ok(auth)
}

fn apply_auth_scope(
    query: &mut MemorySearchQuery,
    auth: &AuthState,
    mode: AuthMode,
    is_local: bool,
) {
    if mode == AuthMode::Local
        || (mode == AuthMode::Hybrid && is_local && !auth.result.authenticated)
    {
        return;
    }
    if let Some(claims) = auth.result.claims.as_ref() {
        if let Some(agent) = claims.scope.agent.as_ref() {
            query.agent_id = Some(agent.clone());
            query.agent_id_camel = None;
        }
        if let Some(project) = claims.scope.project.as_ref() {
            query.project = Some(project.clone());
        }
    }
}

fn parse_json(raw: &str, fallback: serde_json::Value) -> serde_json::Value {
    serde_json::from_str(raw).unwrap_or(fallback)
}

fn row_to_value(row: TelemetryRow) -> serde_json::Value {
    serde_json::json!({
        "id": row.id,
        "created_at": row.created_at,
        "route": row.route,
        "agent_id": row.agent_id,
        "session_key": row.session_key,
        "project": row.project,
        "query": row.query,
        "keyword_query": row.keyword_query,
        "filters": parse_json(&row.filters_json, serde_json::json!({})),
        "method": if row.method == "keyword" { "keyword" } else { "hybrid" },
        "result_count": row.result_count,
        "top_score": row.top_score,
        "no_hits": row.no_hits == 1,
        "duration_ms": row.duration_ms,
        "timings": parse_json(&row.timings_json, serde_json::json!({"totalMs": 0, "stages": []})),
        "results": parse_json(&row.results_json, serde_json::json!([])),
        "sources": row.sources_json.as_deref().and_then(|raw| serde_json::from_str::<serde_json::Value>(raw).ok()),
    })
}

fn build_query(query: &MemorySearchQuery, export: bool) -> (String, Vec<Value>, i64, i64) {
    let mut conditions = Vec::new();
    let mut args: Vec<Value> = Vec::new();

    let agent_id = optional_text(query.agent_id.clone())
        .or_else(|| optional_text(query.agent_id_camel.clone()));
    let session_key = optional_text(query.session_key.clone())
        .or_else(|| optional_text(query.session_key_camel.clone()));
    let project = optional_text(query.project.clone());
    let route = optional_text(query.route.clone());
    let since = optional_text(query.since.clone());
    let until = optional_text(query.until.clone());

    if let Some(agent_id) = agent_id {
        conditions.push("agent_id = ?");
        args.push(Value::Text(agent_id));
    }
    if let Some(session_key) = session_key {
        conditions.push("session_key = ?");
        args.push(Value::Text(session_key));
    }
    if let Some(project) = project {
        conditions.push("project = ?");
        args.push(Value::Text(project));
    }
    if let Some(route) = route {
        conditions.push("route = ?");
        args.push(Value::Text(route));
    }
    if let Some(since) = since {
        conditions.push("created_at >= ?");
        args.push(Value::Text(since));
    }
    if let Some(until) = until {
        conditions.push("created_at <= ?");
        args.push(Value::Text(until));
    }
    if let Some(no_hits) = parse_no_hits(query.no_hits.as_deref()) {
        conditions.push("no_hits = ?");
        args.push(Value::Integer(if no_hits { 1 } else { 0 }));
    }

    let where_clause = if conditions.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", conditions.join(" AND "))
    };
    let limit = parse_limit(
        query.limit.as_deref(),
        if export { 10_000 } else { 100 },
        if export { 10_000 } else { 500 },
    );
    let offset = if export {
        0
    } else {
        parse_offset(query.offset.as_deref())
    };

    let sql = format!(
        "SELECT id, created_at, route, agent_id, session_key, project, query,
                keyword_query, filters_json, method, result_count, top_score,
                no_hits, duration_ms, timings_json, results_json, sources_json
         FROM memory_search_telemetry
         {where_clause}
         ORDER BY created_at DESC
         LIMIT ? OFFSET ?"
    );
    (sql, args, limit, offset)
}

async fn load_items(
    state: Arc<AppState>,
    query: MemorySearchQuery,
    export: bool,
) -> Result<Vec<serde_json::Value>, String> {
    state
        .pool
        .read(move |conn| {
            let (sql, mut args, limit, offset) = build_query(&query, export);
            args.push(Value::Integer(limit));
            args.push(Value::Integer(offset));

            let params: Vec<&dyn ToSql> = args.iter().map(|v| v as &dyn ToSql).collect();
            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt.query_map(params.as_slice(), |row| {
                Ok(TelemetryRow {
                    id: row.get(0)?,
                    created_at: row.get(1)?,
                    route: row.get(2)?,
                    agent_id: row.get(3)?,
                    session_key: row.get(4)?,
                    project: row.get(5)?,
                    query: row.get(6)?,
                    keyword_query: row.get(7)?,
                    filters_json: row.get(8)?,
                    method: row.get(9)?,
                    result_count: row.get(10)?,
                    top_score: row.get(11)?,
                    no_hits: row.get(12)?,
                    duration_ms: row.get(13)?,
                    timings_json: row.get(14)?,
                    results_json: row.get(15)?,
                    sources_json: row.get(16)?,
                })
            })?;

            let mut out = Vec::new();
            for row in rows {
                out.push(row_to_value(row?));
            }
            Ok(out)
        })
        .await
        .map_err(|e| e.to_string())
}

/// GET /api/telemetry/memory-search
pub async fn memory_search(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Query(mut query): Query<MemorySearchQuery>,
) -> impl IntoResponse {
    let is_local = is_loopback(&peer);
    let auth = match require_telemetry_access(&state, &headers, &peer) {
        Ok(auth) => auth,
        Err(resp) => return *resp,
    };
    apply_auth_scope(&mut query, &auth, state.auth_mode, is_local);
    match load_items(state, query, false).await {
        Ok(items) => (
            StatusCode::OK,
            Json(serde_json::json!({"count": items.len(), "items": items})),
        )
            .into_response(),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": error})),
        )
            .into_response(),
    }
}

/// GET /api/telemetry/memory-search/export
pub async fn memory_search_export(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Query(mut query): Query<MemorySearchQuery>,
) -> Response {
    let is_local = is_loopback(&peer);
    let auth = match require_telemetry_access(&state, &headers, &peer) {
        Ok(auth) => auth,
        Err(resp) => return *resp,
    };
    apply_auth_scope(&mut query, &auth, state.auth_mode, is_local);
    match load_items(state, query, true).await {
        Ok(items) => {
            let mut headers = HeaderMap::new();
            headers.insert(
                "content-type",
                HeaderValue::from_static("application/x-ndjson"),
            );
            let body = items
                .into_iter()
                .map(|item| item.to_string())
                .collect::<Vec<_>>()
                .join("\n");
            (StatusCode::OK, headers, body).into_response()
        }
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": error})),
        )
            .into_response(),
    }
}
