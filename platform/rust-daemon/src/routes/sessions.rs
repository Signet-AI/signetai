use crate::{agent, execute, AgentQuery, ApiError, AppState};
use axum::{
    extract::{Path, Query, State},
    http::HeaderMap,
    response::{IntoResponse, Response},
    routing::get as route_get,
    Json, Router,
};
use serde::Deserialize;
use serde_json::Value;
use signet_core_native::{canonicalize_transcript_lookup, Operation};

#[derive(Deserialize)]
pub struct ListQuery {
    pub limit: Option<usize>,
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
    let key = canonicalize_transcript_lookup(&key);
    let agent_id = agent(&headers, Some(&query), None)?;
    let result = execute(
        &state,
        Operation::TranscriptGet {
            agent_id,
            session_key: key,
        },
    )
    .await?;
    if result.is_null() || result["content"].as_str().is_none() {
        return Ok((
            axum::http::StatusCode::NOT_FOUND,
            Json(serde_json::json!({"error":"Transcript not found"})),
        )
            .into_response());
    }
    Ok(Json(result).into_response())
}

pub async fn get_session(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(key): Path<String>,
    Query(query): Query<AgentQuery>,
) -> Result<Json<Value>, ApiError> {
    let agent_id = agent(&headers, Some(&query), None)?;
    let key = key.trim();
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
        return Ok(Json(session));
    }
    let lookup = key.strip_prefix("session:").unwrap_or(key);
    let stored = execute(
        &state,
        Operation::TranscriptInfoGet {
            agent_id,
            session_key: lookup.to_owned(),
        },
    )
    .await?;
    if stored.is_null() {
        return Err(ApiError::not_found("Session not found"));
    }
    Ok(Json(serde_json::json!({
        "key": format!("session:{}", stored["sessionKey"].as_str().unwrap_or(lookup)),
        "sessionKey": stored["sessionKey"],
        "agentId": stored["agentId"],
        "harness": stored["harness"],
        "project": stored["project"],
        "runtimePath": "transcript",
        "provider": "session_transcripts",
        "startedAt": stored["createdAt"],
        "lastSeenAt": stored["updatedAt"],
        "status": "stored"
    })))
}

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/api/sessions", route_get(list))
        .route("/api/sessions/search", route_get(search))
        .route("/api/sessions/{key}/transcript", route_get(get_transcript))
        .route("/api/sessions/{key}", route_get(get_session))
}
