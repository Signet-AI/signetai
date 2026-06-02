//! Skill invocation analytics routes.

use std::net::SocketAddr;
use std::sync::Arc;

use axum::{
    Json,
    extract::{ConnectInfo, Query, State},
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
};
use serde::Deserialize;

use crate::auth::middleware::{
    authenticate_headers, require_permission_guard, resolve_scoped_agent,
};
use crate::auth::types::Permission;
use crate::state::AppState;

#[derive(Debug, Deserialize)]
pub struct SkillAnalyticsQuery {
    pub agent_id: Option<String>,
    pub since: Option<String>,
    pub limit: Option<usize>,
}

fn pct(sorted: &[i64], p: usize) -> i64 {
    if sorted.is_empty() {
        return 0;
    }
    let idx = ((p * sorted.len()).div_ceil(100)).saturating_sub(1);
    *sorted.get(idx).unwrap_or(&0)
}

fn is_iso_instant(value: &str) -> bool {
    value.ends_with('Z') && chrono::DateTime::parse_from_rfc3339(value).is_ok()
}

/// GET /api/skills/analytics
pub async fn summary(
    State(state): State<Arc<AppState>>,
    Query(params): Query<SkillAnalyticsQuery>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> impl IntoResponse {
    let is_local = peer.ip().is_loopback();
    let auth_runtime = state.auth_snapshot();
    let auth = match authenticate_headers(
        auth_runtime.mode,
        auth_runtime.secret.as_deref(),
        &headers,
        is_local,
    ) {
        Ok(a) => a,
        Err(e) => return *e,
    };
    if let Err(e) =
        require_permission_guard(&auth, Permission::Analytics, auth_runtime.mode, is_local)
    {
        return *e;
    }
    let agent_id = match resolve_scoped_agent(
        &auth,
        auth_runtime.mode,
        is_local,
        params.agent_id.as_deref(),
    ) {
        Ok(id) => id,
        Err(reason) => {
            return (
                StatusCode::FORBIDDEN,
                Json(serde_json::json!({"error": reason})),
            )
                .into_response();
        }
    };
    let since = params.since;
    let limit = params.limit.unwrap_or(10).clamp(1, 100);

    if let Some(ref since) = since {
        if !is_iso_instant(since) {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"error": "since must be an ISO 8601 UTC timestamp"})),
            )
                .into_response();
        }
    }

    let result = state
        .pool
        .read(move |conn| {
            let (total_calls, successes): (i64, i64) = if let Some(ref since) = since {
                conn.query_row(
                    "SELECT COUNT(*), COALESCE(SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END), 0)
                     FROM skill_invocations WHERE agent_id = ?1 AND created_at >= datetime(?2)",
                    rusqlite::params![agent_id, since],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )?
            } else {
                conn.query_row(
                    "SELECT COUNT(*), COALESCE(SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END), 0)
                     FROM skill_invocations WHERE agent_id = ?1",
                    rusqlite::params![agent_id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )?
            };

            let top_skills = if let Some(ref since) = since {
                let mut stmt = conn.prepare_cached(
                    "SELECT skill_name, COUNT(*) AS count,
                            SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) AS success_count,
                            CAST(AVG(latency_ms) AS INTEGER) AS avg_latency_ms
                     FROM skill_invocations
                     WHERE agent_id = ?1 AND created_at >= datetime(?2)
                     GROUP BY skill_name
                     ORDER BY count DESC, skill_name ASC
                     LIMIT ?3",
                )?;
                stmt.query_map(rusqlite::params![agent_id, since, limit], |r| {
                    Ok(serde_json::json!({
                        "skillName": r.get::<_, String>(0)?,
                        "count": r.get::<_, i64>(1)?,
                        "successCount": r.get::<_, i64>(2)?,
                        "avgLatencyMs": r.get::<_, i64>(3)?,
                    }))
                })?
                .filter_map(|r| r.ok())
                .collect::<Vec<_>>()
            } else {
                let mut stmt = conn.prepare_cached(
                    "SELECT skill_name, COUNT(*) AS count,
                            SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) AS success_count,
                            CAST(AVG(latency_ms) AS INTEGER) AS avg_latency_ms
                     FROM skill_invocations
                     WHERE agent_id = ?1
                     GROUP BY skill_name
                     ORDER BY count DESC, skill_name ASC
                     LIMIT ?2",
                )?;
                stmt.query_map(rusqlite::params![agent_id, limit], |r| {
                    Ok(serde_json::json!({
                        "skillName": r.get::<_, String>(0)?,
                        "count": r.get::<_, i64>(1)?,
                        "successCount": r.get::<_, i64>(2)?,
                        "avgLatencyMs": r.get::<_, i64>(3)?,
                    }))
                })?
                .filter_map(|r| r.ok())
                .collect::<Vec<_>>()
            };

            let latencies = if let Some(ref since) = since {
                let mut stmt = conn.prepare_cached(
                    "SELECT latency_ms FROM skill_invocations
                     WHERE agent_id = ?1 AND created_at >= datetime(?2)
                     ORDER BY latency_ms",
                )?;
                stmt.query_map(rusqlite::params![agent_id, since], |r| r.get::<_, i64>(0))?
                    .filter_map(|r| r.ok())
                    .collect::<Vec<_>>()
            } else {
                let mut stmt = conn.prepare_cached(
                    "SELECT latency_ms FROM skill_invocations
                     WHERE agent_id = ?1
                     ORDER BY latency_ms",
                )?;
                stmt.query_map(rusqlite::params![agent_id], |r| r.get::<_, i64>(0))?
                    .filter_map(|r| r.ok())
                    .collect::<Vec<_>>()
            };

            let success_rate = if total_calls > 0 {
                ((successes as f64 / total_calls as f64) * 1000.0).round() / 1000.0
            } else {
                0.0
            };

            Ok(serde_json::json!({
                "totalCalls": total_calls,
                "successRate": success_rate,
                "topSkills": top_skills,
                "latency": {
                    "p50": pct(&latencies, 50),
                    "p95": pct(&latencies, 95),
                }
            }))
        })
        .await;

    match result {
        Ok(val) => (StatusCode::OK, Json(val)).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": format!("{e}")})),
        )
            .into_response(),
    }
}
