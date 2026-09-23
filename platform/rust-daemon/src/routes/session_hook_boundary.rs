//! Fresh session/hook/event boundary.
use crate::{agent, execute, ApiError, AppState};
use axum::{
    extract::{DefaultBodyLimit, Query, State},
    http::HeaderMap,
    routing::{get, post},
    Json, Router,
};

use serde::Deserialize;
use serde_json::{json, Value};
use signet_core_native::Operation;

const MAX_BODY_BYTES: usize = 256 * 1024;
const MAX_PAYLOAD_BYTES: usize = 128 * 1024;
const MAX_ID_BYTES: usize = 256;
const MAX_HOOK_BYTES: usize = 128;
const MAX_LIMIT: usize = 100;

#[derive(Deserialize)]
pub struct SessionReq {
    #[serde(alias = "sessionKey", alias = "session_id")]
    pub session_key: String,
    pub harness: Option<String>,
    pub runtime_path: Option<String>,
    pub project: Option<String>,
}
#[derive(Deserialize)]
pub struct EndReq {
    #[serde(alias = "sessionKey", alias = "session_id")]
    pub session_key: String,
}
#[derive(Deserialize)]
pub struct ReceiptReq {
    pub receipt_id: String,
    pub checkpoint: Option<String>,
    pub hook: String,
    pub session_key: Option<String>,
    #[serde(default)]
    pub payload: Value,
}
#[derive(Deserialize)]
pub struct MessageReq {
    pub workspace_id: String,
    pub recipient_agent_id: String,
    pub kind: String,
    #[serde(default)]
    pub payload: Value,
}
#[derive(Deserialize)]
pub struct Poll {
    pub after_id: Option<i64>,
    pub limit: Option<usize>,
    pub workspace_id: Option<String>,
    pub session_key: Option<String>,
}

fn bounded(value: &str, max: usize, name: &str) -> Result<String, ApiError> {
    let value = value.trim();
    if value.is_empty() || value.len() > max {
        return Err(ApiError::bad_request(format!(
            "{name} must be 1-{max} bytes"
        )));
    }
    Ok(value.to_owned())
}

fn bounded_optional(
    value: Option<String>,
    max: usize,
    name: &str,
) -> Result<Option<String>, ApiError> {
    value.map(|value| bounded(&value, max, name)).transpose()
}

fn bounded_payload(payload: &Value) -> Result<(), ApiError> {
    let size = serde_json::to_vec(payload)
        .map_err(|_| ApiError::bad_request("payload must be valid JSON"))?
        .len();
    if size > MAX_PAYLOAD_BYTES {
        return Err(ApiError::bad_request("payload too large"));
    }
    Ok(())
}

fn limit(value: Option<usize>) -> Result<usize, ApiError> {
    match value.unwrap_or(100) {
        1..=MAX_LIMIT => Ok(value.unwrap_or(100)),
        _ => Err(ApiError::bad_request(
            "limit must be an integer from 1 to 100",
        )),
    }
}

fn after_id(value: Option<i64>) -> Result<i64, ApiError> {
    match value.unwrap_or(0) {
        value if value >= 0 => Ok(value),
        _ => Err(ApiError::bad_request("after_id must be non-negative")),
    }
}

fn workspace_header(headers: &HeaderMap, workspace: &str) -> Result<(), ApiError> {
    if let Some(value) = headers.get("x-workspace-id") {
        let supplied = value
            .to_str()
            .map_err(|_| ApiError::bad_request("invalid workspace identity"))?;
        if supplied.trim() != workspace {
            return Err(ApiError::not_found("workspace is outside the caller scope"));
        }
    }
    Ok(())
}

pub async fn start(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<SessionReq>,
) -> Result<Json<Value>, ApiError> {
    let agent_id = agent(&headers, None, None)?;
    let key = bounded(&body.session_key, 512, "session_key")?;
    let harness = bounded(body.harness.as_deref().unwrap_or("unknown"), 128, "harness")?;
    let runtime_path = bounded_optional(body.runtime_path, MAX_ID_BYTES, "runtime_path")?;
    let project = bounded_optional(body.project, MAX_ID_BYTES, "project")?;
    Ok(Json(
        execute(
            &state,
            Operation::SessionStart {
                agent_id,
                key,
                harness,
                runtime_path,
                project,
            },
        )
        .await?,
    ))
}

pub async fn end(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<EndReq>,
) -> Result<Json<Value>, ApiError> {
    let agent_id = agent(&headers, None, None)?;
    let key = bounded(&body.session_key, 512, "session_key")?;
    // Make end idempotent at the HTTP boundary; the core operation remains strict.
    let sessions = execute(
        &state,
        Operation::SessionList {
            agent_id: agent_id.clone(),
            limit: MAX_LIMIT,
        },
    )
    .await?;
    if let Some(session) = sessions["sessions"]
        .as_array()
        .and_then(|rows| rows.iter().find(|row| row["key"] == key))
    {
        if session["status"] == "ended" {
            return Ok(Json(
                json!({"key": key, "status": "ended", "idempotent": true}),
            ));
        }
    }
    Ok(Json(
        execute(&state, Operation::SessionEnd { agent_id, key }).await?,
    ))
}

pub async fn receipt(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<ReceiptReq>,
) -> Result<Json<Value>, ApiError> {
    let agent_id = agent(&headers, None, None)?;
    bounded_payload(&body.payload)?;
    let receipt_id = bounded(&body.receipt_id, MAX_ID_BYTES, "receipt_id")?;
    let hook = bounded(&body.hook, MAX_HOOK_BYTES, "hook")?;
    let session_key = bounded_optional(body.session_key, 512, "session_key")?;
    let checkpoint = bounded_optional(body.checkpoint, MAX_ID_BYTES, "checkpoint")?;
    Ok(Json(
        execute(
            &state,
            Operation::HookReceipt {
                agent_id,
                receipt_id,
                checkpoint,
                hook,
                session_key,
                payload: body.payload,
            },
        )
        .await?,
    ))
}

pub async fn messages(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<MessageReq>,
) -> Result<Json<Value>, ApiError> {
    let agent_id = agent(&headers, None, None)?;
    let workspace_id = bounded(&body.workspace_id, MAX_ID_BYTES, "workspace_id")?;
    workspace_header(&headers, &workspace_id)?;
    bounded_payload(&body.payload)?;
    let recipient_agent_id = bounded(&body.recipient_agent_id, MAX_ID_BYTES, "recipient_agent_id")?;
    let kind = bounded(&body.kind, MAX_HOOK_BYTES, "kind")?;
    Ok(Json(
        execute(
            &state,
            Operation::CrossAgentSend {
                agent_id,
                workspace_id,
                recipient_agent_id,
                kind,
                payload: body.payload,
            },
        )
        .await?,
    ))
}

pub async fn poll(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<Poll>,
) -> Result<Json<Value>, ApiError> {
    let agent_id = agent(&headers, None, None)?;
    let after_id = after_id(query.after_id)?;
    let page_limit = limit(query.limit)?;
    let (data, cursor) = if let Some(workspace) = query.workspace_id {
        let workspace = bounded(&workspace, MAX_ID_BYTES, "workspace_id")?;
        workspace_header(&headers, &workspace)?;
        let data = execute(
            &state,
            Operation::CrossAgentList {
                agent_id,
                workspace_id: workspace,
                after_id,
                limit: page_limit,
            },
        )
        .await?;
        let cursor = data["messages"]
            .as_array()
            .and_then(|items| items.last())
            .and_then(|item| item["id"].as_i64())
            .unwrap_or(after_id)
            .max(after_id);
        (data, cursor)
    } else {
        let session_key = bounded_optional(query.session_key, 512, "session_key")?;
        let data = execute(
            &state,
            Operation::HookReceipts {
                agent_id,
                session_key,
                after_id,
                limit: page_limit,
            },
        )
        .await?;
        let cursor = data["receipts"]
            .as_array()
            .and_then(|items| items.last())
            .and_then(|item| item["id"].as_i64())
            .unwrap_or(after_id)
            .max(after_id);
        (data, cursor)
    };
    Ok(Json(
        json!({"mode":"snapshot", "complete":true, "streaming":false, "cursor":cursor, "nextAfterId":cursor, "data":data}),
    ))
}

pub async fn live(
    State(_state): State<AppState>,
    _headers: HeaderMap,
    Query(_query): Query<Poll>,
) -> Result<axum::response::Response, ApiError> {
    Err(ApiError::not_implemented(
        "live event streaming is unsupported; use snapshot polling",
    ))
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/boundary/sessions/start", post(start))
        .route("/api/boundary/sessions/end", post(end))
        .route("/api/sessions/start", post(start))
        .route("/api/sessions/end", post(end))
        .route("/api/boundary/hooks/receipt", post(receipt))
        .route("/api/boundary/messages", post(messages))
        .route("/api/boundary/poll", get(poll))
        .route("/api/boundary/events", get(live))
        .layer(DefaultBodyLimit::max(MAX_BODY_BYTES))
}
