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
use std::{
    collections::VecDeque,
    env,
    path::PathBuf,
    time::{Duration, Instant},
};
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
        .filter(|model| !model.trim().is_empty())
        .ok_or_else(|| {
            ApiError::bad_request("model is required when no default model is configured")
        })?;
    let timeout_ms = request.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS);
    if timeout_ms == 0 || timeout_ms > 120_000 {
        return Err(ApiError::bad_request("timeoutMs exceeds limit"));
    }
    let timeout = Duration::from_millis(timeout_ms);
    let request_id = Uuid::new_v4().to_string();
    append_history(
        &state,
        HistoryEvent {
            id: request_id.clone(),
            agent_id: identity.clone(),
            operation: "stream".into(),
            status: "started".into(),
            request_id: Some(request_id.clone()),
            error: None,
        },
    )
    .await?;
    let body =
        json!({"model": model, "messages": messages, "stream": true, "max_tokens": max_tokens});
    let (status, stream_body) = match call_openai_stream(
        &setting("SIGNET_OPENAI_BASE_URL").unwrap(),
        setting("SIGNET_OPENAI_API_KEY"),
        body,
        timeout,
        state.clone(),
        identity.clone(),
        request_id.clone(),
    )
    .await
    {
        Ok(result) => result,
        Err(error) => {
            let (status, message) = match error {
                ProviderError::Transport(message) => ("transport", message),
                ProviderError::Upstream { status, .. } => {
                    ("upstream_error", format!("provider returned HTTP {status}"))
                }
                ProviderError::InvalidResponse(message) => ("invalid", message),
            };
            record_stream_terminal(
                &state,
                &identity,
                &request_id,
                status,
                Some(message.clone()),
            )
            .await;
            return Err(if status == "upstream_error" {
                ApiError::upstream(message)
            } else {
                ApiError::unavailable(message)
            });
        }
    };
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

async fn record_stream_terminal(
    state: &AppState,
    agent_id: &str,
    request_id: &str,
    status: &str,
    error: Option<String>,
) {
    let _ = append_history(
        state,
        HistoryEvent {
            id: Uuid::new_v4().to_string(),
            agent_id: agent_id.to_owned(),
            operation: "stream".into(),
            status: status.into(),
            request_id: Some(request_id.to_owned()),
            error,
        },
    )
    .await;
}

fn stream_error_frame(message: &str) -> Vec<u8> {
    format!("event: error\ndata: {}\n\n", json!({"error": message})).into_bytes()
}

fn split_sse_event(bytes: &[u8]) -> Option<(usize, usize)> {
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'\n' && i + 1 < bytes.len() && bytes[i + 1] == b'\n' {
            return Some((i, 2));
        }
        if bytes[i] == b'\r'
            && i + 3 < bytes.len()
            && bytes[i + 1] == b'\n'
            && bytes[i + 2] == b'\r'
            && bytes[i + 3] == b'\n'
        {
            return Some((i, 4));
        }
        i += 1;
    }
    None
}

fn validate_sse_event(event: &[u8]) -> Result<bool, &'static str> {
    let text = std::str::from_utf8(event).map_err(|_| "provider stream contains invalid UTF-8")?;
    let mut saw_data = false;
    for line in text.lines().filter(|line| line.starts_with("data:")) {
        saw_data = true;
        let data = line[5..].trim();
        if data != "[DONE]" && serde_json::from_str::<Value>(data).is_err() {
            return Err("provider stream contains invalid JSON");
        }
        if data == "[DONE]" {
            return Ok(true);
        }
    }
    if !saw_data {
        return Err("provider stream contains no data event");
    }
    Ok(false)
}

async fn call_openai_stream(
    base: &str,
    key: Option<String>,
    body: Value,
    timeout: Duration,
    state: AppState,
    agent_id: String,
    request_id: String,
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
    let deadline = Instant::now() + timeout;
    let client = reqwest::Client::new();
    let mut request = client
        .post(url)
        .header(reqwest::header::ACCEPT, "text/event-stream")
        .json(&body);
    if let Some(key) = key {
        request = request.bearer_auth(key);
    }
    let response = tokio::time::timeout_at(deadline.into(), request.send())
        .await
        .map_err(|_| ProviderError::InvalidResponse("provider request timed out".into()))?
        .map_err(|e| ProviderError::Transport(format!("provider request failed: {e}")))?;
    let status = response.status().as_u16();
    if !(200..300).contains(&status) {
        return Err(ProviderError::Upstream {
            status,
            message: "provider rejected the request".into(),
        });
    }
    let mut response = response;
    let mut total = 0usize;
    let mut pending = Vec::new();
    let mut initial = VecDeque::new();
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(ProviderError::InvalidResponse(
                "provider stream request timed out".into(),
            ));
        }
        let chunk = tokio::time::timeout(remaining, response.chunk())
            .await
            .map_err(|_| ProviderError::InvalidResponse("provider stream read timed out".into()))?
            .map_err(|e| {
                ProviderError::InvalidResponse(format!("provider response read failed: {e}"))
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
        if let Some((end, delim)) = split_sse_event(&pending) {
            let event: Vec<u8> = pending.drain(..end + delim).collect();
            validate_sse_event(&event).map_err(|e| ProviderError::InvalidResponse(e.into()))?;
            break;
        }
    }
    let history_state = state.clone();
    let history_agent = agent_id.clone();
    let history_request = request_id.clone();
    let stream = futures_util::stream::unfold(
        (response, total, pending, false, initial, deadline, false),
        move |(mut response, mut total, mut pending, mut done, mut initial, deadline, terminal)| {
            let state = history_state.clone();
            let agent = history_agent.clone();
            let request = history_request.clone();
            async move {
                if done {
                    return None;
                }
                if let Some(chunk) = initial.pop_front() {
                    return Some((
                        Ok::<Vec<u8>, std::io::Error>(chunk),
                        (response, total, pending, done, initial, deadline, terminal),
                    ));
                }
                let fail = |message: &'static str,
                            status: &'static str,
                            state: AppState,
                            agent: String,
                            request: String,
                            response,
                            total,
                            pending,
                            initial,
                            deadline| async move {
                    record_stream_terminal(&state, &agent, &request, status, Some(message.into()))
                        .await;
                    Some((
                        Ok(stream_error_frame(message)),
                        (response, total, pending, false, initial, deadline, true),
                    ))
                };
                let remaining = deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() && !terminal {
                    return fail(
                        "provider stream timed out",
                        "timeout",
                        state,
                        agent,
                        request,
                        response,
                        total,
                        pending,
                        initial,
                        deadline,
                    )
                    .await;
                }
                let next = match tokio::time::timeout(remaining, response.chunk()).await {
                    Ok(Ok(Some(chunk))) => chunk,
                    Ok(Ok(None)) => {
                        if pending.iter().any(|b| !b.is_ascii_whitespace()) && !terminal {
                            return fail(
                                "provider stream ended with incomplete SSE",
                                "invalid",
                                state,
                                agent,
                                request,
                                response,
                                total,
                                pending,
                                initial,
                                deadline,
                            )
                            .await;
                        }
                        if !terminal {
                            record_stream_terminal(&state, &agent, &request, "succeeded", None)
                                .await;
                        }
                        return None;
                    }
                    Ok(Err(_)) => {
                        return fail(
                            "provider response read failed",
                            "read_failed",
                            state,
                            agent,
                            request,
                            response,
                            total,
                            pending,
                            initial,
                            deadline,
                        )
                        .await;
                    }
                    Err(_) => {
                        return fail(
                            "provider stream timed out",
                            "timeout",
                            state,
                            agent,
                            request,
                            response,
                            total,
                            pending,
                            initial,
                            deadline,
                        )
                        .await;
                    }
                };
                total = total.saturating_add(next.len());
                if total > 1_048_576 {
                    return fail(
                        "provider stream exceeds 1 MiB",
                        "overflow",
                        state,
                        agent,
                        request,
                        response,
                        total,
                        pending,
                        initial,
                        deadline,
                    )
                    .await;
                }
                pending.extend_from_slice(&next);
                while let Some((end, delim)) = split_sse_event(&pending) {
                    let event: Vec<u8> = pending.drain(..end + delim).collect();
                    match validate_sse_event(&event) {
                        Ok(true) => {
                            done = true;
                            record_stream_terminal(&state, &agent, &request, "succeeded", None)
                                .await;
                        }
                        Ok(false) => {}
                        Err(message) => {
                            return fail(
                                message, "invalid", state, agent, request, response, total,
                                pending, initial, deadline,
                            )
                            .await;
                        }
                    }
                }
                Some((
                    Ok(next.to_vec()),
                    (response, total, pending, done, initial, deadline, terminal),
                ))
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
