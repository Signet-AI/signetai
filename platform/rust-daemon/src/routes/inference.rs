use crate::{agent, ApiError, AppState};
use axum::{
    body::Body,
    extract::{Path, State},
    http::{header, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::{delete, get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::VecDeque, env, path::PathBuf, time::Duration};
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
    setting("SIGNET_OPENAI_BASE_URL").is_some()
}
const MAX_TOKENS: u64 = 16_384;

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
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Json(request): Json<ExecuteRequest>,
) -> Result<Response, ApiError> {
    let identity = agent(&headers, None, request.agent_id.as_deref())?;
    if request
        .prompt
        .as_deref()
        .map(str::trim)
        .is_none_or(str::is_empty)
    {
        return Err(ApiError::bad_request("prompt is required"));
    }
    if request
        .provider
        .as_deref()
        .is_some_and(|p| p != "openai-compatible")
    {
        return Err(ApiError::bad_request("unsupported inference provider"));
    }
    if !configured() {
        return Err(ApiError {
            status: StatusCode::NOT_IMPLEMENTED,
            code: "unsupported",
            message: "inference provider is not configured".into(),
        });
    }
    let prompt = request.prompt.unwrap_or_default();
    if prompt.len() > 64 * 1024 {
        return Err(ApiError::bad_request("prompt exceeds 64 KiB"));
    }
    let messages = request
        .messages
        .unwrap_or_else(|| json!([{"role":"user","content":prompt}]));
    if !messages.is_array() {
        return Err(ApiError::bad_request("messages must be an array"));
    }
    if serde_json::to_vec(&messages)
        .map(|b| b.len())
        .unwrap_or(usize::MAX)
        > 256 * 1024
    {
        return Err(ApiError::bad_request("messages exceed 256 KiB"));
    }
    let request_id = Uuid::new_v4().to_string();
    append_history(
        &state,
        HistoryEvent {
            id: request_id.clone(),
            agent_id: identity,
            operation: "stream".into(),
            status: "started".into(),
            request_id: Some(request_id),
            error: None,
        },
    )
    .await?;
    let max_tokens = request
        .max_tokens
        .or_else(|| request.max_tokens_camel)
        .map(|v| {
            if v == 0 || v > MAX_TOKENS {
                Err(ApiError::bad_request("maxTokens exceeds limit"))
            } else {
                Ok(v)
            }
        })
        .transpose()?;
    let model = request
        .model
        .or_else(|| setting("SIGNET_OPENAI_MODEL"))
        .ok_or_else(|| {
            ApiError::bad_request("model is required when no default model is configured")
        })?;
    let body =
        json!({"model": model, "messages": messages, "stream": true, "max_tokens": max_tokens});
    let timeout = Duration::from_millis(
        request
            .timeout_ms
            .unwrap_or(DEFAULT_TIMEOUT_MS)
            .clamp(1, 120_000),
    );
    let (status, stream_body) = tokio::time::timeout(
        timeout,
        call_openai_stream(
            &setting("SIGNET_OPENAI_BASE_URL").unwrap(),
            setting("SIGNET_OPENAI_API_KEY"),
            body,
        ),
    )
    .await
    .map_err(|_| ApiError::unavailable("inference provider request timed out"))?
    .map_err(|e| match e {
        ProviderError::Transport(m) => ApiError::unavailable(m),
        ProviderError::Upstream { status, message } => {
            ApiError::upstream(format!("provider returned HTTP {status}: {message}"))
        }
        ProviderError::InvalidResponse(m) => ApiError::upstream(m),
    })?;
    if !(200..300).contains(&status) {
        return Err(ApiError::upstream(format!(
            "provider returned HTTP {status}"
        )));
    }
    let mut response = Response::new(stream_body);
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/event-stream"),
    );
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    Ok(response)
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
    #[serde(default, alias = "maxTokens", alias = "max_tokens")]
    max_tokens: Option<u64>,
    #[serde(default, skip_deserializing)]
    max_tokens_camel: Option<u64>,
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

async fn call_openai_stream(
    base: &str,
    key: Option<String>,
    body: Value,
) -> Result<(u16, Body), ProviderError> {
    let url = format!(
        "{}/v1/chat/completions",
        base.trim_end_matches('/').trim_end_matches("/v1")
    );
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err(ProviderError::Transport(
            "provider URL must use http:// or https://".into(),
        ));
    }
    let client = reqwest::Client::new();
    let mut request = client
        .post(url)
        .header(reqwest::header::ACCEPT, "text/event-stream")
        .json(&body);
    if let Some(key) = key {
        request = request.bearer_auth(key);
    }
    let response = request
        .send()
        .await
        .map_err(|e| ProviderError::Transport(format!("provider request failed: {e}")))?;
    let status = response.status().as_u16();
    if !(200..300).contains(&status) {
        let message = response.text().await.unwrap_or_default();
        return Err(ProviderError::Upstream {
            status,
            message: message.chars().take(512).collect(),
        });
    }
    let mut response = response;
    let mut total = 0usize;
    let mut pending = Vec::new();
    let mut initial = VecDeque::new();
    let first_event = loop {
        let chunk = response
            .chunk()
            .await
            .map_err(|error| {
                ProviderError::InvalidResponse(format!("provider response read failed: {error}"))
            })?
            .ok_or_else(|| {
                ProviderError::InvalidResponse(
                    "provider stream ended before first SSE event".into(),
                )
            })?;
        total = total.saturating_add(chunk.len());
        if total > 1_048_576 {
            return Err(ProviderError::InvalidResponse(
                "provider stream exceeds 1 MiB".into(),
            ));
        }
        initial.push_back(chunk.to_vec());
        pending.extend_from_slice(&chunk);
        if let Some(end) = pending.windows(2).position(|w| w == b"\n\n") {
            break pending.drain(..end + 2).collect::<Vec<_>>();
        }
    };
    pending.clear();
    let text = String::from_utf8(first_event).map_err(|_| {
        ProviderError::InvalidResponse("provider stream contains invalid UTF-8".into())
    })?;
    let mut saw_data = false;
    for line in text.lines().filter(|line| line.starts_with("data:")) {
        saw_data = true;
        let data = line[5..].trim();
        if data != "[DONE]" {
            serde_json::from_str::<Value>(data).map_err(|_| {
                ProviderError::InvalidResponse("provider stream contains invalid JSON".into())
            })?;
        }
    }
    if !saw_data {
        return Err(ProviderError::InvalidResponse(
            "provider stream contains no data event".into(),
        ));
    }
    let stream = futures_util::stream::unfold(
        (response, total, pending, false, initial),
        |(mut response, total, mut pending, mut done, mut initial)| async move {
            if done {
                return None;
            }
            if let Some(chunk) = initial.pop_front() {
                return Some((Ok(chunk), (response, total, pending, done, initial)));
            }
            if done {
                return None;
            }
            match response.chunk().await {
                Ok(Some(chunk)) => {
                    let next = total.saturating_add(chunk.len());
                    if next > 1_048_576 {
                        return Some((
                            Err(std::io::Error::other("provider stream exceeds 1 MiB")),
                            (response, next, pending, true, initial),
                        ));
                    }
                    pending.extend_from_slice(&chunk);
                    while let Some(end) = pending.windows(2).position(|w| w == b"\n\n") {
                        let event = pending.drain(..end + 2).collect::<Vec<_>>();
                        let text = match String::from_utf8(event.clone()) {
                            Ok(text) => text,
                            Err(_) => {
                                return Some((
                                    Err(std::io::Error::other(
                                        "provider stream contains invalid UTF-8",
                                    )),
                                    (response, next, pending, true, initial),
                                ))
                            }
                        };
                        for line in text.lines().filter(|line| line.starts_with("data:")) {
                            let data = line[5..].trim();
                            if data != "[DONE]" && serde_json::from_str::<Value>(data).is_err() {
                                return Some((
                                    Err(std::io::Error::other(
                                        "provider stream contains invalid JSON",
                                    )),
                                    (response, next, pending, true, initial),
                                ));
                            }
                            if data == "[DONE]" {
                                done = true;
                            }
                        }
                    }
                    Some((Ok(chunk.to_vec()), (response, next, pending, done, initial)))
                }
                Ok(None) => {
                    if pending.iter().any(|b| !b.is_ascii_whitespace()) {
                        Some((
                            Err(std::io::Error::other(
                                "provider stream ended with incomplete SSE",
                            )),
                            (response, total, pending, true, initial),
                        ))
                    } else {
                        None
                    }
                }
                Err(error) => Some((
                    Err(std::io::Error::other(format!(
                        "provider response read failed: {error}"
                    ))),
                    (response, total, pending, true, initial),
                )),
            }
        },
    );
    Ok((status, Body::from_stream(stream)))
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
