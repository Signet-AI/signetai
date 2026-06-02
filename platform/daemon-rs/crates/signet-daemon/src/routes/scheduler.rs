//! Scheduler routes.
//!
//! Cron-based task CRUD, run history, manual trigger, and SSE streaming.

use std::net::SocketAddr;
use std::sync::Arc;

use axum::{
    Json,
    body::Bytes,
    extract::{ConnectInfo, Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
};
use serde::Deserialize;

use crate::auth::middleware::{authenticate_headers, resolve_scoped_agent};
use crate::state::AppState;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VALID_HARNESSES: &[&str] = &["claude-code", "opencode", "codex"];

const CRON_PRESETS: &[(&str, &str)] = &[
    ("Every 15 min", "*/15 * * * *"),
    ("Hourly", "0 * * * *"),
    ("Daily 9am", "0 9 * * *"),
    ("Weekly Mon 9am", "0 9 * * 1"),
];

fn normalize_skill_name(value: &str) -> String {
    value.trim().to_lowercase()
}

fn record_skill_invocation(
    conn: &rusqlite::Connection,
    skill_name: &str,
    agent_id: &str,
    source: &str,
    latency_ms: i64,
    success: bool,
    error_text: Option<&str>,
    now: &str,
) -> rusqlite::Result<()> {
    let skill = normalize_skill_name(skill_name);
    if skill.is_empty() || agent_id.trim().is_empty() {
        return Ok(());
    }

    let id = uuid::Uuid::new_v4().to_string();
    let latency = latency_ms.max(0);

    conn.execute(
        "INSERT INTO skill_invocations
         (id, skill_name, agent_id, source, latency_ms, success, error_text, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        rusqlite::params![
            id, skill, agent_id, source, latency, success, error_text, now
        ],
    )?;

    conn.execute(
        "UPDATE skill_meta
         SET use_count = COALESCE(use_count, 0) + 1,
             last_used_at = ?1,
             updated_at = ?1
         WHERE agent_id = ?2
           AND entity_id IN (
               SELECT id FROM entities
               WHERE agent_id = ?2 AND lower(name) = ?3
           )",
        rusqlite::params![now, agent_id, skill],
    )?;

    Ok(())
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

/// GET /api/tasks — list all scheduled tasks
pub async fn list(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let result = state
        .pool
        .read(|conn| {
            let mut stmt = conn.prepare_cached(
                "SELECT id, name, prompt, cron_expression, harness, working_directory,
                        enabled, last_run_at, next_run_at, created_at, updated_at,
                        skill_name, skill_mode
                 FROM scheduled_tasks ORDER BY created_at DESC",
            )?;
            let tasks: Vec<serde_json::Value> = stmt
                .query_map([], |r| {
                    Ok(serde_json::json!({
                        "id": r.get::<_, String>(0)?,
                        "name": r.get::<_, String>(1)?,
                        "prompt": r.get::<_, String>(2)?,
                        "cronExpression": r.get::<_, String>(3)?,
                        "harness": r.get::<_, String>(4)?,
                        "workingDirectory": r.get::<_, Option<String>>(5)?,
                        "enabled": r.get::<_, bool>(6)?,
                        "lastRunAt": r.get::<_, Option<String>>(7)?,
                        "nextRunAt": r.get::<_, Option<String>>(8)?,
                        "createdAt": r.get::<_, String>(9)?,
                        "updatedAt": r.get::<_, String>(10)?,
                        "skillName": r.get::<_, Option<String>>(11)?,
                        "skillMode": r.get::<_, Option<String>>(12)?,
                    }))
                })?
                .filter_map(|r| r.ok())
                .collect();
            Ok(tasks)
        })
        .await;

    match result {
        Ok(tasks) => {
            let presets: Vec<serde_json::Value> = CRON_PRESETS
                .iter()
                .map(|(label, expr)| serde_json::json!({"label": label, "expression": expr}))
                .collect();
            (
                StatusCode::OK,
                Json(serde_json::json!({"tasks": tasks, "presets": presets})),
            )
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": format!("{e}")})),
        ),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTask {
    pub name: String,
    pub prompt: String,
    pub cron_expression: String,
    pub harness: String,
    pub working_directory: Option<String>,
    pub skill_name: Option<String>,
    pub skill_mode: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct AgentScopeParams {
    pub agent_id: Option<String>,
}

fn string_field(value: &serde_json::Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn optional_string_field(value: &serde_json::Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
}

fn parse_cron_number(value: &str, min: u32, max: u32) -> bool {
    value
        .parse::<u32>()
        .map(|number| number >= min && number <= max)
        .unwrap_or(false)
}

fn validate_cron_part(part: &str, min: u32, max: u32) -> bool {
    if part == "*" {
        return true;
    }
    part.split(',').all(|segment| {
        let Some((base, step)) = segment.split_once('/') else {
            return segment
                .split_once('-')
                .map(|(start, end)| {
                    parse_cron_number(start, min, max)
                        && parse_cron_number(end, min, max)
                        && start.parse::<u32>().ok() <= end.parse::<u32>().ok()
                })
                .unwrap_or_else(|| parse_cron_number(segment, min, max));
        };
        !step.is_empty()
            && step.parse::<u32>().map(|value| value > 0).unwrap_or(false)
            && (base == "*" || validate_cron_part(base, min, max))
    })
}

fn validate_cron_expression(expression: &str) -> bool {
    let fields = expression.split_whitespace().collect::<Vec<_>>();
    fields.len() == 5
        && validate_cron_part(fields[0], 0, 59)
        && validate_cron_part(fields[1], 0, 23)
        && validate_cron_part(fields[2], 1, 31)
        && validate_cron_part(fields[3], 1, 12)
        && validate_cron_part(fields[4], 0, 7)
}

fn parse_create_task(
    value: serde_json::Value,
) -> Result<CreateTask, (StatusCode, serde_json::Value)> {
    let Some(name) = string_field(&value, "name") else {
        return Err((
            StatusCode::BAD_REQUEST,
            serde_json::json!({"error": "name, prompt, cronExpression, and harness are required"}),
        ));
    };
    let Some(prompt) = string_field(&value, "prompt") else {
        return Err((
            StatusCode::BAD_REQUEST,
            serde_json::json!({"error": "name, prompt, cronExpression, and harness are required"}),
        ));
    };
    let Some(cron_expression) = string_field(&value, "cronExpression") else {
        return Err((
            StatusCode::BAD_REQUEST,
            serde_json::json!({"error": "name, prompt, cronExpression, and harness are required"}),
        ));
    };
    let Some(harness) = string_field(&value, "harness") else {
        return Err((
            StatusCode::BAD_REQUEST,
            serde_json::json!({"error": "name, prompt, cronExpression, and harness are required"}),
        ));
    };

    if !validate_cron_expression(&cron_expression) {
        return Err((
            StatusCode::BAD_REQUEST,
            serde_json::json!({"error": "Invalid cron expression"}),
        ));
    }
    if !VALID_HARNESSES.contains(&harness.as_str()) {
        return Err((
            StatusCode::BAD_REQUEST,
            serde_json::json!({"error": "harness must be 'claude-code', 'codex', or 'opencode'"}),
        ));
    }

    let skill_name = optional_string_field(&value, "skillName").filter(|value| !value.is_empty());
    let skill_mode = optional_string_field(&value, "skillMode").filter(|value| !value.is_empty());
    if let Some(skill) = &skill_name
        && (skill.contains('/') || skill.contains(".."))
    {
        return Err((
            StatusCode::BAD_REQUEST,
            serde_json::json!({"error": "Invalid skill name"}),
        ));
    }
    if skill_name.is_some() && !matches!(skill_mode.as_deref(), Some("inject" | "slash")) {
        return Err((
            StatusCode::BAD_REQUEST,
            serde_json::json!({"error": "skillMode must be 'inject' or 'slash' when skillName is set"}),
        ));
    }

    Ok(CreateTask {
        name,
        prompt,
        cron_expression,
        harness,
        working_directory: optional_string_field(&value, "workingDirectory"),
        skill_name,
        skill_mode,
    })
}

/// POST /api/tasks — create a scheduled task
pub async fn create(
    State(state): State<Arc<AppState>>,
    Query(params): Query<AgentScopeParams>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    bytes: Bytes,
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
    let body = match serde_json::from_slice::<serde_json::Value>(&bytes)
        .map_err(|error| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                serde_json::json!({"error": error.to_string()}),
            )
        })
        .and_then(parse_create_task)
    {
        Ok(body) => body,
        Err((status, body)) => return (status, Json(body)).into_response(),
    };

    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();

    let result = state
        .pool
        .write(
            signet_core::db::Priority::High,
            {
                let id = id.clone();
                let now = now.clone();
                move |conn| {
                    conn.execute(
                        "INSERT INTO scheduled_tasks (id, name, prompt, cron_expression, harness, working_directory, enabled, next_run_at, created_at, updated_at, skill_name, skill_mode)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7, ?8, ?8, ?9, ?10)",
                        rusqlite::params![
                            id,
                            body.name,
                            body.prompt,
                            body.cron_expression,
                            body.harness,
                            body.working_directory,
                            now,
                            now,
                            body.skill_name,
                            body.skill_mode,
                        ],
                    )?;
                    conn.execute(
                        "INSERT INTO task_scope_hints (task_id, agent_id, created_at, updated_at)
                         VALUES (?1, ?2, ?3, ?3)
                         ON CONFLICT(task_id) DO UPDATE SET agent_id = excluded.agent_id, updated_at = excluded.updated_at",
                        rusqlite::params![id, agent_id, now],
                    )?;
                    Ok(serde_json::json!({"id": id, "nextRunAt": now}))
                }
            },
        )
        .await;

    match result {
        Ok(val) => (StatusCode::CREATED, Json(val)).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": format!("{e}")})),
        )
            .into_response(),
    }
}

/// GET /api/tasks/:id — get task with recent runs
pub async fn get(State(state): State<Arc<AppState>>, Path(id): Path<String>) -> impl IntoResponse {
    let result = state
        .pool
        .read(move |conn| {
            let task: Option<serde_json::Value> = conn
                .query_row(
                    "SELECT id, name, prompt, cron_expression, harness, working_directory,
                            enabled, last_run_at, next_run_at, created_at, updated_at,
                            skill_name, skill_mode
                     FROM scheduled_tasks WHERE id = ?1",
                    [&id],
                    |r| {
                        Ok(serde_json::json!({
                            "id": r.get::<_, String>(0)?,
                            "name": r.get::<_, String>(1)?,
                            "prompt": r.get::<_, String>(2)?,
                            "cronExpression": r.get::<_, String>(3)?,
                            "harness": r.get::<_, String>(4)?,
                            "workingDirectory": r.get::<_, Option<String>>(5)?,
                            "enabled": r.get::<_, bool>(6)?,
                            "lastRunAt": r.get::<_, Option<String>>(7)?,
                            "nextRunAt": r.get::<_, Option<String>>(8)?,
                            "createdAt": r.get::<_, String>(9)?,
                            "updatedAt": r.get::<_, String>(10)?,
                            "skillName": r.get::<_, Option<String>>(11)?,
                            "skillMode": r.get::<_, Option<String>>(12)?,
                        }))
                    },
                )
                .ok();

            let runs = if task.is_some() {
                let mut stmt = conn.prepare_cached(
                    "SELECT id, status, started_at, completed_at, exit_code, error
                     FROM task_runs WHERE task_id = ?1 ORDER BY started_at DESC LIMIT 20",
                )?;
                stmt.query_map([&id], |r| {
                    Ok(serde_json::json!({
                        "id": r.get::<_, String>(0)?,
                        "status": r.get::<_, String>(1)?,
                        "startedAt": r.get::<_, String>(2)?,
                        "completedAt": r.get::<_, Option<String>>(3)?,
                        "exitCode": r.get::<_, Option<i32>>(4)?,
                        "error": r.get::<_, Option<String>>(5)?,
                    }))
                })?
                .filter_map(|r| r.ok())
                .collect::<Vec<_>>()
            } else {
                Vec::new()
            };

            Ok((task, runs))
        })
        .await;

    match result {
        Ok((Some(task), runs)) => (
            StatusCode::OK,
            Json(serde_json::json!({"task": task, "runs": runs})),
        ),
        Ok((None, _)) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"error": "Task not found"})),
        ),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": format!("{e}")})),
        ),
    }
}

/// PATCH /api/tasks/:id — update task
pub async fn update(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    let now = chrono::Utc::now().to_rfc3339();

    let result = state
        .pool
        .write(signet_core::db::Priority::High, move |conn| {
            // Check exists
            let exists: bool = conn
                .query_row(
                    "SELECT COUNT(*) FROM scheduled_tasks WHERE id = ?1",
                    [&id],
                    |r| r.get::<_, i64>(0),
                )
                .map(|c| c > 0)
                .unwrap_or(false);

            if !exists {
                return Ok(serde_json::json!({"error": "Task not found"}));
            }

            // Build dynamic update
            let mut sets = vec!["updated_at = ?".to_string()];
            let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = vec![Box::new(now)];

            if let Some(name) = body.get("name").and_then(|v| v.as_str()) {
                sets.push("name = ?".to_string());
                params.push(Box::new(name.to_string()));
            }
            if let Some(prompt) = body.get("prompt").and_then(|v| v.as_str()) {
                sets.push("prompt = ?".to_string());
                params.push(Box::new(prompt.to_string()));
            }
            if let Some(cron) = body.get("cronExpression").and_then(|v| v.as_str()) {
                sets.push("cron_expression = ?".to_string());
                params.push(Box::new(cron.to_string()));
            }
            if let Some(harness) = body.get("harness").and_then(|v| v.as_str()) {
                sets.push("harness = ?".to_string());
                params.push(Box::new(harness.to_string()));
            }
            if let Some(wd) = body.get("workingDirectory").and_then(|v| v.as_str()) {
                sets.push("working_directory = ?".to_string());
                params.push(Box::new(wd.to_string()));
            }
            if let Some(enabled) = body.get("enabled").and_then(|v| v.as_bool()) {
                sets.push("enabled = ?".to_string());
                params.push(Box::new(enabled));
            }

            params.push(Box::new(id));
            let sql = format!(
                "UPDATE scheduled_tasks SET {} WHERE id = ?",
                sets.join(", ")
            );
            let refs: Vec<&dyn rusqlite::types::ToSql> =
                params.iter().map(|p| p.as_ref()).collect();
            conn.execute(&sql, refs.as_slice())?;

            Ok(serde_json::json!({"success": true}))
        })
        .await;

    match result {
        Ok(val) if val.get("error").is_some() => (StatusCode::NOT_FOUND, Json(val)),
        Ok(val) => (StatusCode::OK, Json(val)),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": format!("{e}")})),
        ),
    }
}

/// DELETE /api/tasks/:id — delete task (cascades runs)
pub async fn delete(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let result = state
        .pool
        .write(signet_core::db::Priority::High, move |conn| {
            conn.execute("DELETE FROM scheduled_tasks WHERE id = ?1", [&id])?;
            Ok(serde_json::json!({"success": true}))
        })
        .await;

    match result {
        Ok(val) => (StatusCode::OK, Json(val)),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": format!("{e}")})),
        ),
    }
}

/// POST /api/tasks/:id/run — trigger immediate run
pub async fn trigger(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Query(params): Query<AgentScopeParams>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> impl IntoResponse {
    let run_id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();
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
    let scoped_agent = match resolve_scoped_agent(
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
    let enforce_scope = auth_runtime.mode != crate::auth::types::AuthMode::Local
        && !(auth_runtime.mode == crate::auth::types::AuthMode::Hybrid
            && is_local
            && !auth.result.authenticated);

    let result = state
        .pool
        .write(signet_core::db::Priority::High, {
            let run_id = run_id.clone();
            let id = id.clone();
            let now = now.clone();
            let scoped_agent = scoped_agent.clone();
            move |conn| {
                let sql = "SELECT t.skill_name, COALESCE(h.agent_id, 'default') AS agent_id
                           FROM scheduled_tasks t
                           LEFT JOIN task_scope_hints h ON h.task_id = t.id
                           WHERE t.id = ?1";
                let task = if enforce_scope {
                    conn.query_row(
                        &format!("{sql} AND COALESCE(h.agent_id, 'default') = ?2"),
                        rusqlite::params![id, scoped_agent],
                        |r| Ok((r.get::<_, Option<String>>(0)?, r.get::<_, String>(1)?)),
                    )
                    .ok()
                } else {
                    conn.query_row(sql, [&id], |r| {
                        Ok((r.get::<_, Option<String>>(0)?, r.get::<_, String>(1)?))
                    })
                    .ok()
                };

                let Some((skill_name, task_agent)) = task else {
                    return Ok(serde_json::json!({"error": "Task not found"}));
                };

                conn.execute(
                    "INSERT INTO task_runs (id, task_id, status, started_at) VALUES (?1, ?2, 'pending', ?3)",
                    rusqlite::params![run_id, id, now],
                )?;

                conn.execute(
                    "UPDATE scheduled_tasks SET last_run_at = ?1, updated_at = ?1 WHERE id = ?2",
                    rusqlite::params![now, id],
                )?;

                if let Some(skill_name) = skill_name.filter(|value| !value.trim().is_empty()) {
                    record_skill_invocation(conn, &skill_name, &task_agent, "api", 0, true, None, &now)?;
                }

                Ok(serde_json::json!({"runId": run_id, "status": "pending"}))
            }
        })
        .await;

    match result {
        Ok(val) if val.get("error").is_some() => (StatusCode::NOT_FOUND, Json(val)).into_response(),
        Ok(val) => (StatusCode::ACCEPTED, Json(val)).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": format!("{e}")})),
        )
            .into_response(),
    }
}

#[derive(Debug, Deserialize)]
pub struct RunsQuery {
    pub limit: Option<usize>,
    pub offset: Option<usize>,
}

/// GET /api/tasks/:id/runs — paginated run history
pub async fn runs(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Query(params): Query<RunsQuery>,
) -> impl IntoResponse {
    let limit = params.limit.unwrap_or(20);
    let offset = params.offset.unwrap_or(0);

    let result = state
        .pool
        .read(move |conn| {
            let total: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM task_runs WHERE task_id = ?1",
                    [&id],
                    |r| r.get(0),
                )
                .unwrap_or(0);

            let mut stmt = conn.prepare_cached(
                "SELECT id, status, started_at, completed_at, exit_code, error
                 FROM task_runs WHERE task_id = ?1 ORDER BY started_at DESC LIMIT ?2 OFFSET ?3",
            )?;
            let rows: Vec<serde_json::Value> = stmt
                .query_map(rusqlite::params![id, limit, offset], |r| {
                    Ok(serde_json::json!({
                        "id": r.get::<_, String>(0)?,
                        "status": r.get::<_, String>(1)?,
                        "startedAt": r.get::<_, String>(2)?,
                        "completedAt": r.get::<_, Option<String>>(3)?,
                        "exitCode": r.get::<_, Option<i32>>(4)?,
                        "error": r.get::<_, Option<String>>(5)?,
                    }))
                })?
                .filter_map(|r| r.ok())
                .collect();

            Ok(serde_json::json!({
                "runs": rows,
                "total": total,
                "hasMore": (offset as i64 + limit as i64) < total,
            }))
        })
        .await;

    match result {
        Ok(val) => (StatusCode::OK, Json(val)),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": format!("{e}")})),
        ),
    }
}

/// GET /api/tasks/:id/stream — SSE stream for task run events.
pub async fn stream(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let exists = state
        .pool
        .read(move |conn| {
            Ok(conn
                .prepare_cached("SELECT 1 FROM scheduled_tasks WHERE id = ?1")?
                .exists(rusqlite::params![id])?)
        })
        .await
        .unwrap_or(false);
    if !exists {
        return (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"error": "Task not found"})),
        )
            .into_response();
    }

    (
        [
            ("content-type", "text/event-stream"),
            ("cache-control", "no-cache"),
            ("connection", "keep-alive"),
        ],
        "data: {\"type\":\"connected\"}\n\n",
    )
        .into_response()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn valid_harnesses() {
        assert!(VALID_HARNESSES.contains(&"claude-code"));
        assert!(VALID_HARNESSES.contains(&"opencode"));
        assert!(VALID_HARNESSES.contains(&"codex"));
        assert!(!VALID_HARNESSES.contains(&"unknown"));
    }

    #[test]
    fn cron_presets_all_valid() {
        for (label, expr) in CRON_PRESETS {
            assert!(!label.is_empty());
            assert!(!expr.is_empty());
            // All cron expressions should have 5 fields
            assert_eq!(expr.split_whitespace().count(), 5, "preset: {label}");
        }
    }
}
