//! Telemetry routes backed by the Rust daemon database.
//!
//! This module implements the TypeScript daemon's local-only memory-search QA
//! ledger API. It intentionally reads `memory_search_telemetry` from SQLite and
//! returns the same item/export shapes used by the TS daemon.

use std::{collections::BTreeMap, net::SocketAddr, sync::Arc};

use axum::{
    Json,
    extract::{ConnectInfo, Path, Query, State},
    http::{HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
};
use chrono::{Duration, Utc};
use rusqlite::{ToSql, types::Value};
use serde::Deserialize;

use crate::{
    auth::{
        middleware::{
            AuthState, authenticate_headers, require_permission_guard, resolve_scoped_agent,
        },
        types::{AuthMode, Permission},
    },
    routes::pipeline::is_loopback,
    state::AppState,
};

#[derive(Debug, Deserialize)]
pub struct ContinuityQuery {
    project: Option<String>,
    limit: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct AnalyticsErrorsQuery {
    stage: Option<String>,
    since: Option<String>,
    limit: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct AnalyticsLogsQuery {
    limit: Option<String>,
    level: Option<String>,
    category: Option<String>,
    since: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct McpAnalyticsQuery {
    agent_id: Option<String>,
    #[serde(rename = "agentId")]
    agent_id_camel: Option<String>,
    server: Option<String>,
    since: Option<String>,
    limit: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CheckpointProjectQuery {
    project: Option<String>,
    limit: Option<String>,
}

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

#[derive(Debug, Deserialize)]
pub struct TelemetryEventsQuery {
    event: Option<String>,
    since: Option<String>,
    until: Option<String>,
    limit: Option<String>,
}

fn redact_secrets(text: &str) -> String {
    text.split_whitespace()
        .map(|word| {
            let lower = word.to_ascii_lowercase();
            if word.starts_with("Bearer ")
                || lower.starts_with("sk-")
                || lower.starts_with("pk-")
                || lower.contains("api_key=")
                || lower.contains("api-key=")
                || lower.contains("token=")
                || lower.contains("secret=")
                || lower.contains("password=")
                || lower.contains("credential=")
                || lower.starts_with("openai_api_key=")
                || lower.starts_with("anthropic_api_key=")
                || lower.starts_with("github_token=")
                || lower.starts_with("npm_token=")
                || lower.starts_with("aws_secret=")
            {
                "[REDACTED]"
            } else {
                word
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn redact_recent_remembers(raw: Option<String>) -> Option<String> {
    let raw = raw?;
    let parsed = serde_json::from_str::<Vec<String>>(&raw).ok()?;
    serde_json::to_string(
        &parsed
            .into_iter()
            .map(|value| redact_secrets(&value))
            .collect::<Vec<_>>(),
    )
    .ok()
}

fn percentile(sorted: &[i64], p: i64) -> i64 {
    if sorted.is_empty() {
        return 0;
    }
    let idx = (((p as f64 / 100.0) * sorted.len() as f64).ceil() as isize - 1).max(0) as usize;
    sorted[idx.min(sorted.len() - 1)]
}

fn rounded_rate(successes: i64, total: i64) -> f64 {
    if total <= 0 {
        return 0.0;
    }
    ((successes as f64 / total as f64) * 1000.0).round() / 1000.0
}

fn resolve_mcp_analytics_agent(
    state: &AppState,
    headers: &HeaderMap,
    peer: &SocketAddr,
    requested: Option<String>,
) -> Result<String, Box<Response>> {
    let auth = require_telemetry_access(state, headers, peer)?;
    let is_local = is_loopback(peer);
    let auth_runtime = state.auth_snapshot();
    resolve_scoped_agent(&auth, auth_runtime.mode, is_local, requested.as_deref()).map_err(
        |error| {
            Box::new(
                (
                    StatusCode::FORBIDDEN,
                    Json(serde_json::json!({ "error": error })),
                )
                    .into_response(),
            )
        },
    )
}

fn telemetry_event_rows(
    conn: &rusqlite::Connection,
    event: Option<String>,
    since: Option<String>,
    until: Option<String>,
    limit: i64,
) -> Result<Vec<serde_json::Value>, signet_core::error::CoreError> {
    let mut conditions = Vec::<String>::new();
    let mut args = Vec::<Value>::new();
    if let Some(event) = event {
        conditions.push("event = ?".to_string());
        args.push(Value::Text(event));
    }
    if let Some(since) = since {
        conditions.push("timestamp >= ?".to_string());
        args.push(Value::Text(since));
    }
    if let Some(until) = until {
        conditions.push("timestamp <= ?".to_string());
        args.push(Value::Text(until));
    }
    args.push(Value::Integer(limit));
    let where_sql = if conditions.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", conditions.join(" AND "))
    };
    let sql = format!(
        "SELECT id, event, timestamp, properties, sent_to_posthog
         FROM telemetry_events
         {where_sql}
         ORDER BY timestamp DESC
         LIMIT ?"
    );
    let refs = args
        .iter()
        .map(|value| value as &dyn ToSql)
        .collect::<Vec<_>>();
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(refs.as_slice(), |row| {
        let properties = row.get::<_, String>(3)?;
        Ok(serde_json::json!({
            "id": row.get::<_, String>(0)?,
            "event": row.get::<_, String>(1)?,
            "timestamp": row.get::<_, String>(2)?,
            "properties": serde_json::from_str::<serde_json::Value>(&properties)
                .unwrap_or_else(|_| serde_json::json!({})),
            "sentToPosthog": row.get::<_, i64>(4)? != 0,
        }))
    })?;
    Ok(rows.filter_map(Result::ok).collect())
}

/// GET /api/telemetry/events
pub async fn events(
    State(state): State<Arc<AppState>>,
    Query(query): Query<TelemetryEventsQuery>,
) -> impl IntoResponse {
    let event = optional_text(query.event);
    let since = optional_text(query.since);
    let until = optional_text(query.until);
    let limit = parse_limit(query.limit.as_deref(), 100, 10_000);
    match state
        .pool
        .read(move |conn| telemetry_event_rows(conn, event, since, until, limit))
        .await
    {
        Ok(events) => {
            Json(serde_json::json!({ "events": events, "enabled": true })).into_response()
        }
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": error.to_string() })),
        )
            .into_response(),
    }
}

/// GET /api/telemetry/stats
pub async fn stats(
    State(state): State<Arc<AppState>>,
    Query(query): Query<TelemetryEventsQuery>,
) -> impl IntoResponse {
    let since = optional_text(query.since);
    match state
        .pool
        .read(move |conn| telemetry_event_rows(conn, None, since, None, 10_000))
        .await
    {
        Ok(events) => {
            let mut total_input_tokens = 0i64;
            let mut total_output_tokens = 0i64;
            let mut total_cost = 0.0f64;
            let mut llm_calls = 0i64;
            let mut llm_errors = 0i64;
            let mut pipeline_errors = 0i64;
            let mut latencies = Vec::<i64>::new();
            for event in &events {
                if event["event"] == "llm.generate" {
                    llm_calls += 1;
                    let properties = &event["properties"];
                    total_input_tokens += properties["inputTokens"].as_i64().unwrap_or(0);
                    total_output_tokens += properties["outputTokens"].as_i64().unwrap_or(0);
                    total_cost += properties["totalCost"].as_f64().unwrap_or(0.0);
                    if properties["success"].as_bool() == Some(false) {
                        llm_errors += 1;
                    }
                    if let Some(duration) = properties["durationMs"].as_i64() {
                        latencies.push(duration);
                    }
                }
                if event["event"] == "pipeline.error" {
                    pipeline_errors += 1;
                }
            }
            latencies.sort_unstable();
            let p50 = percentile(&latencies, 50);
            let p95 = percentile(&latencies, 95);
            Json(serde_json::json!({
                "enabled": true,
                "totalEvents": events.len(),
                "llm": {
                    "calls": llm_calls,
                    "errors": llm_errors,
                    "totalInputTokens": total_input_tokens,
                    "totalOutputTokens": total_output_tokens,
                    "totalCost": total_cost,
                    "p50": p50,
                    "p95": p95,
                },
                "pipelineErrors": pipeline_errors,
            }))
            .into_response()
        }
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": error.to_string() })),
        )
            .into_response(),
    }
}

/// GET /api/telemetry/export
pub async fn export(
    State(state): State<Arc<AppState>>,
    Query(query): Query<TelemetryEventsQuery>,
) -> impl IntoResponse {
    let since = optional_text(query.since);
    let limit = parse_limit(query.limit.as_deref(), 10_000, 50_000);
    match state
        .pool
        .read(move |conn| telemetry_event_rows(conn, None, since, None, limit))
        .await
    {
        Ok(events) => {
            let body = events
                .into_iter()
                .map(|event| event.to_string())
                .collect::<Vec<_>>()
                .join("\n");
            let mut response = (StatusCode::OK, body).into_response();
            response.headers_mut().insert(
                axum::http::header::CONTENT_TYPE,
                HeaderValue::from_static("application/x-ndjson"),
            );
            response
        }
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": error.to_string() })),
        )
            .into_response(),
    }
}

/// GET /api/analytics/usage
pub async fn usage(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> impl IntoResponse {
    if let Err(resp) = require_telemetry_access(&state, &headers, &peer) {
        return *resp;
    }
    (StatusCode::OK, Json(state.analytics.usage())).into_response()
}

/// GET /api/analytics/errors
pub async fn errors(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Query(query): Query<AnalyticsErrorsQuery>,
) -> impl IntoResponse {
    if let Err(resp) = require_telemetry_access(&state, &headers, &peer) {
        return *resp;
    }
    let stage = optional_text(query.stage);
    let since = optional_text(query.since);
    let limit = parse_limit(query.limit.as_deref(), 50, 500) as usize;
    (
        StatusCode::OK,
        Json(serde_json::json!({
            "errors": state.analytics.errors(stage.as_deref(), since.as_deref(), limit),
            "summary": state.analytics.error_summary(),
        })),
    )
        .into_response()
}

/// GET /api/analytics/latency
pub async fn latency(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> impl IntoResponse {
    if let Err(resp) = require_telemetry_access(&state, &headers, &peer) {
        return *resp;
    }
    (StatusCode::OK, Json(state.analytics.latency())).into_response()
}

/// GET /api/mcp/analytics
pub async fn mcp_analytics(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Query(query): Query<McpAnalyticsQuery>,
) -> impl IntoResponse {
    let requested_agent =
        optional_text(query.agent_id).or_else(|| optional_text(query.agent_id_camel));
    let agent_id = match resolve_mcp_analytics_agent(&state, &headers, &peer, requested_agent) {
        Ok(agent_id) => agent_id,
        Err(resp) => return *resp,
    };
    let server = optional_text(query.server);
    let since = optional_text(query.since);
    let limit = parse_limit(query.limit.as_deref(), 10, 100);

    let result = state
        .pool
        .read(move |conn| {
            let mut conditions = vec!["agent_id = ?".to_string()];
            let mut args = vec![Value::Text(agent_id)];
            if let Some(server) = server {
                conditions.push("server_id = ?".to_string());
                args.push(Value::Text(server));
            }
            if let Some(since) = since {
                conditions.push("created_at >= datetime(?)".to_string());
                args.push(Value::Text(since));
            }
            let where_sql = conditions.join(" AND ");

            let totals_sql = format!(
                "SELECT COUNT(*) as total,
                        COALESCE(SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END), 0) as successes
                 FROM mcp_invocations WHERE {where_sql}"
            );
            let (total_calls, successes): (i64, i64) = conn.query_row(
                &totals_sql,
                rusqlite::params_from_iter(args.iter()),
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;

            let mut limited_args = args.clone();
            limited_args.push(Value::Integer(limit));
            let top_servers_sql = format!(
                "SELECT server_id, COUNT(*) as count,
                        COALESCE(SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END), 0) as success_count,
                        COALESCE(CAST(AVG(latency_ms) AS INTEGER), 0) as avg_latency_ms
                 FROM mcp_invocations WHERE {where_sql}
                 GROUP BY server_id ORDER BY count DESC LIMIT ?"
            );
            let top_servers = conn
                .prepare_cached(&top_servers_sql)?
                .query_map(rusqlite::params_from_iter(limited_args.iter()), |row| {
                    Ok(serde_json::json!({
                        "serverId": row.get::<_, String>(0)?,
                        "count": row.get::<_, i64>(1)?,
                        "successCount": row.get::<_, i64>(2)?,
                        "avgLatencyMs": row.get::<_, i64>(3)?,
                    }))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;

            let top_tools_sql = format!(
                "SELECT tool_name, COUNT(*) as count,
                        COALESCE(SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END), 0) as success_count,
                        COALESCE(CAST(AVG(latency_ms) AS INTEGER), 0) as avg_latency_ms
                 FROM mcp_invocations WHERE {where_sql}
                 GROUP BY tool_name ORDER BY count DESC LIMIT ?"
            );
            let top_tools = conn
                .prepare_cached(&top_tools_sql)?
                .query_map(rusqlite::params_from_iter(limited_args.iter()), |row| {
                    Ok(serde_json::json!({
                        "toolName": row.get::<_, String>(0)?,
                        "count": row.get::<_, i64>(1)?,
                        "successCount": row.get::<_, i64>(2)?,
                        "avgLatencyMs": row.get::<_, i64>(3)?,
                    }))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;

            let latency_sql = format!(
                "SELECT latency_ms FROM mcp_invocations WHERE {where_sql} ORDER BY latency_ms"
            );
            let latencies = conn
                .prepare_cached(&latency_sql)?
                .query_map(rusqlite::params_from_iter(args.iter()), |row| {
                    row.get::<_, i64>(0)
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;

            Ok(serde_json::json!({
                "totalCalls": total_calls,
                "successRate": rounded_rate(successes, total_calls),
                "topServers": top_servers,
                "topTools": top_tools,
                "latency": {
                    "p50": percentile(&latencies, 50),
                    "p95": percentile(&latencies, 95),
                },
            }))
        })
        .await;

    match result {
        Ok(body) => (StatusCode::OK, Json(body)).into_response(),
        Err(err) => {
            tracing::warn!(err = %err, "failed to query MCP analytics");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": "Failed to query analytics"})),
            )
                .into_response()
        }
    }
}

/// GET /api/mcp/analytics/:server
pub async fn mcp_server_analytics(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(server_id): Path<String>,
    Query(query): Query<McpAnalyticsQuery>,
) -> impl IntoResponse {
    let requested_agent =
        optional_text(query.agent_id).or_else(|| optional_text(query.agent_id_camel));
    let agent_id = match resolve_mcp_analytics_agent(&state, &headers, &peer, requested_agent) {
        Ok(agent_id) => agent_id,
        Err(resp) => return *resp,
    };
    let since = optional_text(query.since);

    let result = state
        .pool
        .read({
            let server_id = server_id.clone();
            move |conn| {
                let mut conditions = vec!["agent_id = ?".to_string(), "server_id = ?".to_string()];
                let mut args = vec![Value::Text(agent_id), Value::Text(server_id.clone())];
                if let Some(since) = since.clone() {
                    conditions.push("created_at >= datetime(?)".to_string());
                    args.push(Value::Text(since));
                }
                let where_sql = conditions.join(" AND ");

                let totals_sql = format!(
                    "SELECT COUNT(*) as total,
                            COALESCE(SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END), 0) as successes
                     FROM mcp_invocations WHERE {where_sql}"
                );
                let (total_calls, successes): (i64, i64) = conn.query_row(
                    &totals_sql,
                    rusqlite::params_from_iter(args.iter()),
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )?;

                let tools_sql = format!(
                    "SELECT tool_name, COUNT(*) as count,
                            COALESCE(SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END), 0) as success_count,
                            COALESCE(CAST(AVG(latency_ms) AS INTEGER), 0) as avg_latency_ms
                     FROM mcp_invocations WHERE {where_sql}
                     GROUP BY tool_name ORDER BY count DESC"
                );
                let tools = conn
                    .prepare_cached(&tools_sql)?
                    .query_map(rusqlite::params_from_iter(args.iter()), |row| {
                        Ok(serde_json::json!({
                            "toolName": row.get::<_, String>(0)?,
                            "count": row.get::<_, i64>(1)?,
                            "successCount": row.get::<_, i64>(2)?,
                            "avgLatencyMs": row.get::<_, i64>(3)?,
                        }))
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()?;

                let timeline_sql = if since.is_some() {
                    format!(
                        "SELECT DATE(created_at) as date, COUNT(*) as count
                         FROM mcp_invocations WHERE {where_sql} AND created_at >= datetime(?)
                         GROUP BY DATE(created_at) ORDER BY date"
                    )
                } else {
                    format!(
                        "SELECT DATE(created_at) as date, COUNT(*) as count
                         FROM mcp_invocations WHERE {where_sql} AND created_at >= datetime('now', '-7 days')
                         GROUP BY DATE(created_at) ORDER BY date"
                    )
                };
                let mut timeline_args = args.clone();
                if let Some(since) = since.clone() {
                    timeline_args.push(Value::Text(since));
                }
                let sparse = conn
                    .prepare_cached(&timeline_sql)?
                    .query_map(rusqlite::params_from_iter(timeline_args.iter()), |row| {
                        Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
                    })?
                    .collect::<rusqlite::Result<BTreeMap<_, _>>>()?;

                let start = since
                    .as_deref()
                    .and_then(|value| {
                        chrono::DateTime::parse_from_rfc3339(value)
                            .ok()
                            .map(|dt| dt.date_naive())
                            .or_else(|| chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d").ok())
                    })
                    .unwrap_or_else(|| (Utc::now() - Duration::days(6)).date_naive());
                let today = Utc::now().date_naive();
                let mut timeline = Vec::new();
                let mut day = start;
                while day <= today {
                    let key = day.format("%Y-%m-%d").to_string();
                    timeline.push(serde_json::json!({
                        "date": key,
                        "count": sparse.get(&key).copied().unwrap_or(0),
                    }));
                    let Some(next) = day.succ_opt() else {
                        break;
                    };
                    day = next;
                }

                Ok(serde_json::json!({
                    "serverId": server_id,
                    "totalCalls": total_calls,
                    "successRate": rounded_rate(successes, total_calls),
                    "tools": tools,
                    "timeline": timeline,
                }))
            }
        })
        .await;

    match result {
        Ok(body) => (StatusCode::OK, Json(body)).into_response(),
        Err(err) => {
            tracing::warn!(err = %err, "failed to query MCP server analytics");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": "Failed to query server analytics"})),
            )
                .into_response()
        }
    }
}

/// GET /api/analytics/logs
pub async fn logs(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Query(query): Query<AnalyticsLogsQuery>,
) -> impl IntoResponse {
    if let Err(resp) = require_telemetry_access(&state, &headers, &peer) {
        return *resp;
    }
    let limit = parse_limit(query.limit.as_deref(), 100, 500) as usize;
    let level = optional_text(query.level).map(|value| value.to_ascii_lowercase());
    let category = optional_text(query.category).map(|value| value.to_ascii_lowercase());
    let since = optional_text(query.since).and_then(|value| {
        chrono::DateTime::parse_from_rfc3339(&value)
            .ok()
            .map(|dt| dt.with_timezone(&Utc))
    });
    let log_dir = state.config.logs_dir();
    let logs = tokio::task::spawn_blocking(move || {
        analytics_log_entries(
            &log_dir,
            limit,
            level.as_deref(),
            category.as_deref(),
            since,
        )
    })
    .await
    .unwrap_or_default();
    let count = logs.len();
    (
        StatusCode::OK,
        Json(serde_json::json!({ "logs": logs, "count": count })),
    )
        .into_response()
}

/// GET /api/analytics/memory-safety
pub async fn memory_safety(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> impl IntoResponse {
    if let Err(resp) = require_telemetry_access(&state, &headers, &peer) {
        return *resp;
    }
    let since = (Utc::now() - Duration::days(7)).to_rfc3339();
    let mutation = state
        .pool
        .read(move |conn| {
            let (recent_recovers, recent_deletes): (Option<i64>, Option<i64>) = conn.query_row(
                "SELECT
                    SUM(CASE WHEN event = 'recovered' THEN 1 ELSE 0 END),
                    SUM(CASE WHEN event = 'deleted' THEN 1 ELSE 0 END)
                 FROM memory_history
                 WHERE created_at >= ?1",
                [since],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            let recent_recovers = recent_recovers.unwrap_or(0);
            let recent_deletes = recent_deletes.unwrap_or(0);
            let score = if recent_recovers > 5 { 0.7 } else { 1.0 };
            let status = if score >= 0.8 {
                "healthy"
            } else if score >= 0.5 {
                "degraded"
            } else {
                "unhealthy"
            };
            Ok(serde_json::json!({
                "score": score,
                "status": status,
                "recentRecovers": recent_recovers,
                "recentDeletes": recent_deletes,
            }))
        })
        .await
        .unwrap_or_else(|err| {
            tracing::warn!(err = %err, "failed to query mutation health");
            serde_json::json!({
                "score": 1.0,
                "status": "healthy",
                "recentRecovers": 0,
                "recentDeletes": 0,
            })
        });
    (
        StatusCode::OK,
        Json(serde_json::json!({
            "mutation": mutation,
            "recentErrors": state.analytics.errors(Some("mutation"), None, 50),
            "errorSummary": state.analytics.error_summary(),
        })),
    )
        .into_response()
}

/// GET /api/analytics/continuity
pub async fn continuity(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Query(query): Query<ContinuityQuery>,
) -> impl IntoResponse {
    if let Err(resp) = require_telemetry_access(&state, &headers, &peer) {
        return *resp;
    }
    let limit = parse_limit(query.limit.as_deref(), 50, 500);
    let project = optional_text(query.project);
    let result = state
        .pool
        .read(move |conn| {
            let rows = if let Some(project) = project {
                let mut stmt = conn.prepare(
                    "SELECT id, session_key, project, harness, score,
                            memories_recalled, memories_used, novel_context_count,
                            reasoning, created_at
                     FROM session_scores
                     WHERE project = ?
                     ORDER BY created_at DESC
                     LIMIT ?",
                )?;
                stmt.query_map(rusqlite::params![project, limit], |row| {
                    Ok(serde_json::json!({
                        "id": row.get::<_, String>(0)?,
                        "session_key": row.get::<_, String>(1)?,
                        "project": row.get::<_, Option<String>>(2)?,
                        "harness": row.get::<_, Option<String>>(3)?,
                        "score": row.get::<_, f64>(4)?,
                        "memories_recalled": row.get::<_, Option<i64>>(5)?,
                        "memories_used": row.get::<_, Option<i64>>(6)?,
                        "novel_context_count": row.get::<_, Option<i64>>(7)?,
                        "reasoning": row.get::<_, Option<String>>(8)?,
                        "created_at": row.get::<_, String>(9)?,
                    }))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?
            } else {
                let mut stmt = conn.prepare(
                    "SELECT id, session_key, project, harness, score,
                            memories_recalled, memories_used, novel_context_count,
                            reasoning, created_at
                     FROM session_scores
                     ORDER BY created_at DESC
                     LIMIT ?",
                )?;
                stmt.query_map([limit], |row| {
                    Ok(serde_json::json!({
                        "id": row.get::<_, String>(0)?,
                        "session_key": row.get::<_, String>(1)?,
                        "project": row.get::<_, Option<String>>(2)?,
                        "harness": row.get::<_, Option<String>>(3)?,
                        "score": row.get::<_, f64>(4)?,
                        "memories_recalled": row.get::<_, Option<i64>>(5)?,
                        "memories_used": row.get::<_, Option<i64>>(6)?,
                        "novel_context_count": row.get::<_, Option<i64>>(7)?,
                        "reasoning": row.get::<_, Option<String>>(8)?,
                        "created_at": row.get::<_, String>(9)?,
                    }))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?
            };
            let mut scores = rows
                .iter()
                .filter_map(|row| row.get("score").and_then(|value| value.as_f64()))
                .collect::<Vec<_>>();
            scores.reverse();
            let trend = match (scores.first(), scores.last()) {
                (Some(first), Some(last)) if scores.len() >= 2 => last - first,
                _ => 0.0,
            };
            let average = if scores.is_empty() {
                0.0
            } else {
                scores.iter().sum::<f64>() / scores.len() as f64
            };
            let round2 = |value: f64| (value * 100.0).round() / 100.0;
            let latest = rows
                .first()
                .and_then(|row| row.get("score"))
                .cloned()
                .unwrap_or(serde_json::Value::Null);
            Ok(serde_json::json!({
                "scores": rows,
                "summary": {
                    "count": scores.len(),
                    "average": round2(average),
                    "trend": round2(trend),
                    "latest": latest,
                },
            }))
        })
        .await;
    match result {
        Ok(value) => (StatusCode::OK, Json(value)).into_response(),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": error.to_string()})),
        )
            .into_response(),
    }
}

/// GET /api/analytics/continuity/latest
pub async fn continuity_latest(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> impl IntoResponse {
    if let Err(resp) = require_telemetry_access(&state, &headers, &peer) {
        return *resp;
    }
    let result = state
        .pool
        .read(|conn| {
            let mut stmt = conn.prepare(
                "SELECT project, score, created_at
                 FROM session_scores
                 WHERE id IN (
                   SELECT id FROM session_scores s2
                   WHERE s2.project = session_scores.project
                   ORDER BY s2.created_at DESC
                   LIMIT 1
                 )
                 ORDER BY created_at DESC",
            )?;
            Ok(stmt
                .query_map([], |row| {
                    Ok(serde_json::json!({
                        "project": row.get::<_, Option<String>>(0)?,
                        "score": row.get::<_, f64>(1)?,
                        "created_at": row.get::<_, String>(2)?,
                    }))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?)
        })
        .await;
    match result {
        Ok(scores) => (StatusCode::OK, Json(serde_json::json!({"scores": scores}))).into_response(),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": error.to_string()})),
        )
            .into_response(),
    }
}

fn checkpoint_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<serde_json::Value> {
    let recent_remembers = redact_recent_remembers(row.get::<_, Option<String>>(9)?);
    Ok(serde_json::json!({
        "id": row.get::<_, String>(0)?,
        "session_key": row.get::<_, String>(1)?,
        "harness": row.get::<_, String>(2)?,
        "project": row.get::<_, Option<String>>(3)?,
        "project_normalized": row.get::<_, Option<String>>(4)?,
        "trigger": row.get::<_, String>(5)?,
        "digest": redact_secrets(&row.get::<_, String>(6)?),
        "prompt_count": row.get::<_, i64>(7)?,
        "memory_queries": row.get::<_, Option<String>>(8)?,
        "recent_remembers": recent_remembers,
        "focal_entity_ids": row.get::<_, Option<String>>(10)?,
        "focal_entity_names": row.get::<_, Option<String>>(11)?,
        "active_aspect_ids": row.get::<_, Option<String>>(12)?,
        "surfaced_constraint_count": row.get::<_, Option<i64>>(13)?,
        "traversal_memory_count": row.get::<_, Option<i64>>(14)?,
        "created_at": row.get::<_, String>(15)?,
    }))
}

/// GET /api/checkpoints
pub async fn checkpoints_by_project(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Query(query): Query<CheckpointProjectQuery>,
) -> impl IntoResponse {
    if let Err(resp) = require_telemetry_access(&state, &headers, &peer) {
        return *resp;
    }
    let Some(project) = optional_text(query.project) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "project query parameter required"})),
        )
            .into_response();
    };
    let project = std::fs::canonicalize(&project)
        .ok()
        .map(|path| path.to_string_lossy().to_string())
        .unwrap_or(project);
    let limit = parse_limit(query.limit.as_deref(), 10, 100);
    let result = state
        .pool
        .read(move |conn| {
            let mut stmt = conn.prepare(
                "SELECT id, session_key, harness, project, project_normalized,
                        trigger, digest, prompt_count, memory_queries, recent_remembers,
                        focal_entity_ids, focal_entity_names, active_aspect_ids,
                        surfaced_constraint_count, traversal_memory_count, created_at
                 FROM session_checkpoints
                 WHERE project_normalized = ?
                 ORDER BY created_at DESC, rowid DESC
                 LIMIT ?",
            )?;
            Ok(stmt
                .query_map(rusqlite::params![project, limit], checkpoint_row)?
                .collect::<rusqlite::Result<Vec<_>>>()?)
        })
        .await;
    match result {
        Ok(checkpoints) => (
            StatusCode::OK,
            Json(serde_json::json!({"count": checkpoints.len(), "checkpoints": checkpoints})),
        )
            .into_response(),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": error.to_string()})),
        )
            .into_response(),
    }
}

/// GET /api/checkpoints/:sessionKey
pub async fn checkpoints_by_session(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(session_key): Path<String>,
) -> impl IntoResponse {
    if let Err(resp) = require_telemetry_access(&state, &headers, &peer) {
        return *resp;
    }
    let result = state
        .pool
        .read(move |conn| {
            let mut stmt = conn.prepare(
                "SELECT id, session_key, harness, project, project_normalized,
                        trigger, digest, prompt_count, memory_queries, recent_remembers,
                        focal_entity_ids, focal_entity_names, active_aspect_ids,
                        surfaced_constraint_count, traversal_memory_count, created_at
                 FROM session_checkpoints
                 WHERE session_key = ?
                 ORDER BY created_at DESC, rowid DESC",
            )?;
            Ok(stmt
                .query_map([session_key], checkpoint_row)?
                .collect::<rusqlite::Result<Vec<_>>>()?)
        })
        .await;
    match result {
        Ok(checkpoints) => (
            StatusCode::OK,
            Json(serde_json::json!({"count": checkpoints.len(), "checkpoints": checkpoints})),
        )
            .into_response(),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": error.to_string()})),
        )
            .into_response(),
    }
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

fn analytics_log_entries(
    log_dir: &std::path::Path,
    limit: usize,
    level: Option<&str>,
    category: Option<&str>,
    since: Option<chrono::DateTime<Utc>>,
) -> Vec<serde_json::Value> {
    let mut files = std::fs::read_dir(log_dir)
        .ok()
        .into_iter()
        .flat_map(|entries| entries.filter_map(Result::ok))
        .filter(|entry| {
            entry
                .path()
                .extension()
                .and_then(|ext| ext.to_str())
                .is_some_and(|ext| {
                    ext.eq_ignore_ascii_case("log") || ext.eq_ignore_ascii_case("jsonl")
                })
        })
        .collect::<Vec<_>>();
    files.sort_by(|a, b| {
        b.metadata()
            .and_then(|m| m.modified())
            .unwrap_or(std::time::SystemTime::UNIX_EPOCH)
            .cmp(
                &a.metadata()
                    .and_then(|m| m.modified())
                    .unwrap_or(std::time::SystemTime::UNIX_EPOCH),
            )
    });

    let mut logs = Vec::new();
    for file in files {
        let Ok(content) = std::fs::read_to_string(file.path()) else {
            continue;
        };
        for line in content.lines().rev() {
            let Ok(entry) = serde_json::from_str::<serde_json::Value>(line) else {
                continue;
            };
            if !log_entry_matches(&entry, level, category, since) {
                continue;
            }
            logs.push(entry);
            if logs.len() >= limit {
                return logs;
            }
        }
    }
    logs
}

fn log_entry_matches(
    entry: &serde_json::Value,
    level: Option<&str>,
    category: Option<&str>,
    since: Option<chrono::DateTime<Utc>>,
) -> bool {
    if let Some(level) = level
        && entry
            .get("level")
            .and_then(serde_json::Value::as_str)
            .map(|entry_level| !entry_level.eq_ignore_ascii_case(level))
            .unwrap_or(true)
    {
        return false;
    }
    if let Some(category) = category
        && entry
            .get("category")
            .and_then(serde_json::Value::as_str)
            .map(|entry_category| !entry_category.eq_ignore_ascii_case(category))
            .unwrap_or(true)
    {
        return false;
    }
    if let Some(since) = since {
        let Some(timestamp) = entry
            .get("timestamp")
            .and_then(serde_json::Value::as_str)
            .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
            .map(|dt| dt.with_timezone(&Utc))
        else {
            return false;
        };
        if timestamp < since {
            return false;
        }
    }
    true
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
    let auth_runtime = state.auth_snapshot();
    let auth = authenticate_headers(
        auth_runtime.mode,
        auth_runtime.secret.as_deref(),
        headers,
        is_local,
    )?;
    require_permission_guard(&auth, Permission::Analytics, auth_runtime.mode, is_local)?;
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
    let auth_runtime = state.auth_snapshot();
    apply_auth_scope(&mut query, &auth, auth_runtime.mode, is_local);
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
    let auth_runtime = state.auth_snapshot();
    apply_auth_scope(&mut query, &auth, auth_runtime.mode, is_local);
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
