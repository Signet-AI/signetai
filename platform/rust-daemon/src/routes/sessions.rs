use super::auth;
use crate::{agent, execute, AgentQuery, ApiError, AppState};
use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::get as route_get,
    Json, Router,
};
use serde::Deserialize;
use serde_json::Value;
use signet_core_native::Operation;

#[derive(Deserialize)]
pub struct ListQuery {
    pub limit: Option<usize>,
}

fn normalize_session_key(value: &str) -> String {
    let trimmed = value.trim();
    trimmed
        .strip_prefix("session:")
        .unwrap_or(trimmed)
        .to_owned()
}

fn session_agent(
    headers: &HeaderMap,
    query: &AgentQuery,
    session_key: &str,
) -> Result<String, ApiError> {
    let has_explicit = query
        .agent_id
        .as_deref()
        .is_some_and(|value| !value.trim().is_empty())
        || query
            .agent_id_camel
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty())
        || ["x-signet-agent-id", "x-signet-agent"].iter().any(|name| {
            headers
                .get_all(*name)
                .iter()
                .filter_map(|value| value.to_str().ok())
                .any(|value| !value.trim().is_empty())
        });
    if has_explicit {
        return agent(headers, Some(query), None);
    }
    let session_agent = session_key
        .strip_prefix("agent:")
        .and_then(|value| value.split(':').next())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .or_else(crate::configured_agent)
        .unwrap_or_else(|| "default".to_owned());
    agent(headers, Some(query), Some(&session_agent))
}

pub async fn list(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<ListQuery>,
) -> Result<Json<Value>, ApiError> {
    let agent_id = agent(&headers, None, None)?;
    Ok(Json(
        execute(
            &state,
            Operation::SessionList {
                agent_id,
                limit: q.limit.unwrap_or(50).min(500),
            },
        )
        .await?,
    ))
}

#[derive(Deserialize)]
pub struct SearchQuery {
    pub q: Option<String>,
    pub limit: Option<usize>,
}

pub async fn search(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<SearchQuery>,
) -> Result<Json<Value>, ApiError> {
    let agent_id = agent(&headers, None, None)?;
    let query = q.q.unwrap_or_default().trim().to_owned();
    if query.len() > 256 {
        return Err(ApiError::bad_request("q is too long"));
    }
    let limit = q.limit.unwrap_or(50).min(500);
    let result = execute(&state, Operation::SessionList { agent_id, limit }).await?;
    if query.is_empty() {
        return Ok(Json(result));
    }
    let needle = query.to_lowercase();
    let mut filtered = result.clone();
    if let Some(rows) = filtered.get_mut("sessions").and_then(Value::as_array_mut) {
        rows.retain(|row| row.to_string().to_lowercase().contains(&needle));
    }
    Ok(Json(filtered))
}

pub async fn get_transcript(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(key): Path<String>,
    Query(query): Query<AgentQuery>,
) -> Result<Response, ApiError> {
    let key = normalize_session_key(&key);
    let agent_id = session_agent(&headers, &query, &key)?;
    if let Some(error) = auth::session_agent_scope_error(&state, &headers, &agent_id).await? {
        return Ok((
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({"error":error})),
        )
            .into_response());
    }
    let result = execute(
        &state,
        Operation::TranscriptGet {
            agent_id: agent_id.clone(),
            session_key: key.clone(),
        },
    )
    .await?;
    let Some(content) = result
        .get("content")
        .and_then(Value::as_str)
        .filter(|content| !content.is_empty())
    else {
        return Ok((
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"error":"Transcript not found"})),
        )
            .into_response());
    };
    Ok(
        Json(serde_json::json!({"sessionKey":key,"agentId":agent_id,"content":content}))
            .into_response(),
    )
}

pub async fn get_session(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(key): Path<String>,
    Query(query): Query<AgentQuery>,
) -> Result<Response, ApiError> {
    let key = normalize_session_key(&key);
    let agent_id = session_agent(&headers, &query, &key)?;
    if let Some(error) = auth::session_agent_scope_error(&state, &headers, &agent_id).await? {
        return Ok((
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({"error":error})),
        )
            .into_response());
    }
    if key.is_empty() || key.len() > 512 {
        return Err(ApiError::bad_request("session key must be 1-512 bytes"));
    }
    let result = execute(
        &state,
        Operation::SessionList {
            agent_id: agent_id.clone(),
            limit: 500,
        },
    )
    .await?;
    if let Some(session) = result["sessions"]
        .as_array()
        .and_then(|rows| rows.iter().find(|row| row["key"] == key))
        .cloned()
    {
        return Ok(Json(session).into_response());
    }
    let stored = execute(
        &state,
        Operation::TranscriptInfoGet {
            agent_id,
            session_key: key.clone(),
        },
    )
    .await?;
    if stored.is_null() {
        return Ok((
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"error":"Session not found"})),
        )
            .into_response());
    }
    let last_seen_at = stored
        .get("updatedAt")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .or_else(|| stored.get("createdAt").and_then(Value::as_str))
        .unwrap_or("");
    Ok(Json(serde_json::json!({
        "key": format!("session:{}", stored["sessionKey"].as_str().unwrap_or(&key)),
        "sessionKey": stored["sessionKey"],
        "agentId": stored["agentId"],
        "harness": stored["harness"],
        "project": stored["project"],
        "runtimePath": "transcript",
        "provider": "session_transcripts",
        "startedAt": stored["createdAt"],
        "lastSeenAt": last_seen_at,
        "status": "stored"
    }))
    .into_response())
}

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/api/sessions", route_get(list))
        .route("/api/sessions/search", route_get(search))
        .route("/api/sessions/{key}/transcript", route_get(get_transcript))
        .route("/api/sessions/{key}", route_get(get_session))
}
