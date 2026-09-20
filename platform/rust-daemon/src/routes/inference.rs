use crate::{agent, ApiError, AppState};
use axum::{
    extract::{Path, State},
    response::IntoResponse,
    routing::{delete, get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{env, path::PathBuf, time::Duration};
use tokio::sync::Mutex;
use tokio::{fs, io::AsyncWriteExt};
use uuid::Uuid;

const MAX_HISTORY_BYTES: usize = 512 * 1024;
static HISTORY_LOCK: Mutex<()> = Mutex::const_new(());

const DEFAULT_TIMEOUT_MS: u64 = 30_000;

fn setting(name: &str) -> Option<String> {
    env::var(name).ok().and_then(|v| crate::non_empty(&v))
}
fn configured() -> bool {
    setting("SIGNET_OPENAI_BASE_URL").is_some() && setting("SIGNET_OPENAI_MODEL").is_some()
}

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/api/inference/status", get(status))
        .route("/api/inference/catalog", get(catalog))
        .route("/api/inference/execute", post(execute))
        .route("/api/inference/explain", post(explain))
        .route("/api/inference/stream", post(stream))
        .route("/api/inference/history", get(history))
        .route("/api/inference/requests/{id}", delete(cancel))
}

#[derive(Debug, Serialize, Deserialize)]
struct HistoryEvent {
    id: String,
    agent_id: String,
    operation: String,
    status: String,
    request_id: Option<String>,
    error: Option<String>,
}

async fn history_path(state: &AppState) -> Result<PathBuf, ApiError> {
    let path = state.workspace.join("inference").join("history.jsonl");
    fs::create_dir_all(path.parent().unwrap())
        .await
        .map_err(|e| ApiError::unavailable(format!("inference history unavailable: {e}")))?;
    Ok(path)
}
async fn append_history(state: &AppState, event: HistoryEvent) -> Result<(), ApiError> {
    let _guard = HISTORY_LOCK.lock().await;
    let path = history_path(state).await?;
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .await
        .map_err(|e| ApiError::unavailable(format!("inference history unavailable: {e}")))?;
    file.write_all(serde_json::to_string(&event).unwrap().as_bytes())
        .await
        .map_err(|e| ApiError::unavailable(format!("inference history write failed: {e}")))?;
    file.write_all(b"\n")
        .await
        .map_err(|e| ApiError::unavailable(format!("inference history write failed: {e}")))
}
async fn read_history(state: &AppState) -> Result<Vec<HistoryEvent>, ApiError> {
    let _guard = HISTORY_LOCK.lock().await;
    let path = history_path(state).await?;
    let bytes = fs::read(path).await.unwrap_or_default();
    if bytes.len() > MAX_HISTORY_BYTES {
        return Err(ApiError::unavailable("inference history exceeds 512 KiB"));
    }
    Ok(bytes
        .split(|b| *b == b'\n')
        .filter_map(|line| serde_json::from_slice(line).ok())
        .collect())
}

async fn explain(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Json(mut request): Json<ExecuteRequest>,
) -> Result<Json<Value>, ApiError> {
    request.prompt = Some(format!(
        "Explain the routing and provider result for this request: {}",
        request.prompt.unwrap_or_default()
    ));
    let result = execute(State(state), headers, Json(request)).await?;
    Ok(result)
}

async fn stream(
    State(_state): State<AppState>,
    headers: axum::http::HeaderMap,
    Json(_request): Json<ExecuteRequest>,
) -> Result<Json<Value>, ApiError> {
    let _ = agent(&headers, None, None)?;
    Err(ApiError::bad_request(
        "streaming is unsupported; use execute",
    ))
}

async fn history(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let identity = agent(&headers, None, None)?;
    let events: Vec<_> = read_history(&state)
        .await?
        .into_iter()
        .filter(|event| event.agent_id == identity)
        .collect();
    Ok(Json(
        json!({"enabled":true,"events":events,"summary":{"total":events.len()}}),
    ))
}
async fn cancel(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let identity = agent(&headers, None, None)?;
    let events = read_history(&state).await?;
    if !events
        .iter()
        .any(|event| event.request_id.as_deref() == Some(id.as_str()) && event.agent_id == identity)
    {
        return Err(ApiError::not_found("inference request not found"));
    }
    append_history(
        &state,
        HistoryEvent {
            id: Uuid::new_v4().to_string(),
            agent_id: identity,
            operation: "cancel".into(),
            status: "cancel_requested".into(),
            request_id: Some(id.clone()),
            error: Some("cancellation recorded durably; provider request is cooperative".into()),
        },
    )
    .await?;
    Ok(Json(
        json!({"ok":true,"requestId":id,"status":"cancel_requested"}),
    ))
}

async fn status() -> impl IntoResponse {
    let provider = configured().then_some("openai-compatible");
    Json(json!({"configured": configured(), "provider": provider, "available": configured()}))
}

async fn catalog() -> impl IntoResponse {
    let model = setting("SIGNET_OPENAI_MODEL");
    Json(json!({
        "providers": if configured() { json!(["openai-compatible"]) } else { json!([]) },
        "models": model.map(|m| json!({"openai-compatible": [{"id": m, "name": m, "input": ["text"], "reasoning": false}]})).unwrap_or_else(|| json!({})),
        "modelErrors": {}, "recommendedModels": {}, "oauthProviders": [], "acpxAgents": []
    }))
}

#[derive(Debug, Deserialize)]
struct ExecuteRequest {
    #[serde(default)]
    provider: Option<String>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    prompt: Option<String>,
    #[serde(default)]
    messages: Option<Value>,
    #[serde(default, alias = "timeoutMs")]
    timeout_ms: Option<u64>,
    #[serde(default, alias = "agentId")]
    agent_id: Option<String>,
}

async fn execute(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Json(request): Json<ExecuteRequest>,
) -> Result<Json<Value>, ApiError> {
    let identity = agent(&headers, None, request.agent_id.as_deref())?;
    if request
        .prompt
        .as_deref()
        .map(str::trim)
        .is_none_or(str::is_empty)
    {
        return Err(ApiError::bad_request("prompt is required"));
    }
    let request_id = Uuid::new_v4().to_string();
    append_history(
        &state,
        HistoryEvent {
            id: request_id.clone(),
            agent_id: identity.clone(),
            operation: "execute".into(),
            status: "started".into(),
            request_id: Some(request_id.clone()),
            error: None,
        },
    )
    .await?;
    if let Some(provider) = request.provider.as_deref() {
        if provider != "openai-compatible" {
            return Err(ApiError::bad_request("unsupported inference provider"));
        }
    }
    if !configured() {
        return Err(ApiError {
            status: axum::http::StatusCode::NOT_IMPLEMENTED,
            code: "unsupported",
            message: "inference provider is not configured".into(),
        });
    }
    let base = setting("SIGNET_OPENAI_BASE_URL").unwrap();
    let model = request
        .model
        .or_else(|| setting("SIGNET_OPENAI_MODEL"))
        .unwrap();
    if let Some(prompt) = request.prompt.as_ref() {
        if prompt.len() > 64 * 1024 {
            return Err(ApiError::bad_request("prompt exceeds 64 KiB"));
        }
    }
    let messages = request
        .messages
        .unwrap_or_else(|| json!([{"role":"user","content":request.prompt.unwrap_or_default()}]));
    if !messages.is_array() {
        return Err(ApiError::bad_request("messages must be an array"));
    }
    if serde_json::to_vec(&messages)
        .map(|bytes| bytes.len())
        .unwrap_or(usize::MAX)
        > 256 * 1024
    {
        return Err(ApiError::bad_request("messages exceed 256 KiB"));
    }
    let body = json!({"model": model, "messages": messages});
    let timeout = Duration::from_millis(
        request
            .timeout_ms
            .unwrap_or(DEFAULT_TIMEOUT_MS)
            .clamp(1, 120_000),
    );
    let response = tokio::time::timeout(
        timeout,
        call_openai(&base, setting("SIGNET_OPENAI_API_KEY"), body),
    )
    .await
    .map_err(|_| ApiError::unavailable("inference provider request timed out"))?
    .map_err(|error| match error {
        ProviderError::Transport(message) => ApiError::unavailable(message),
        ProviderError::Upstream { status, message } => {
            ApiError::upstream(format!("provider returned HTTP {status}: {message}"))
        }
        ProviderError::InvalidResponse(message) => ApiError::upstream(message),
    })?;
    Ok(Json(
        json!({"provider":"openai-compatible", "agent_id":identity, "response":response}),
    ))
}

#[derive(Debug)]
enum ProviderError {
    Transport(String),
    Upstream { status: u16, message: String },
    InvalidResponse(String),
}

async fn call_openai(base: &str, key: Option<String>, body: Value) -> Result<Value, ProviderError> {
    let base = base.trim_end_matches('/');
    let url = if base.ends_with("/v1") {
        format!("{base}/chat/completions")
    } else {
        format!("{base}/v1/chat/completions")
    };
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err(ProviderError::Transport(
            "provider URL must use http:// or https://".to_owned(),
        ));
    }
    let client = reqwest::Client::builder()
        .build()
        .map_err(|error| ProviderError::Transport(format!("provider client failed: {error}")))?;
    let mut request = client.post(url).json(&body);
    if let Some(key) = key {
        request = request.bearer_auth(key);
    }
    let mut response = request
        .send()
        .await
        .map_err(|error| ProviderError::Transport(format!("provider request failed: {error}")))?;
    let status = response.status().as_u16();
    if let Some(length) = response.content_length() {
        if length > 1_048_576 {
            return Err(ProviderError::InvalidResponse(
                "provider response exceeds 1 MiB".to_owned(),
            ));
        }
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|error| {
        ProviderError::InvalidResponse(format!("provider response read failed: {error}"))
    })? {
        if bytes.len().saturating_add(chunk.len()) > 1_048_576 {
            return Err(ProviderError::InvalidResponse(
                "provider response exceeds 1 MiB".to_owned(),
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    if bytes.len() > 1_048_576 {
        return Err(ProviderError::InvalidResponse(
            "provider response exceeds 1 MiB".to_owned(),
        ));
    }
    let value: Value = serde_json::from_slice(&bytes).map_err(|error| {
        ProviderError::InvalidResponse(format!("provider returned invalid JSON: {error}"))
    })?;
    if !(200..300).contains(&status) {
        let message = value
            .get("error")
            .map(Value::to_string)
            .unwrap_or_else(|| value.to_string());
        return Err(ProviderError::Upstream { status, message });
    }
    Ok(value)
}
