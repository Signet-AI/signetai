use crate::{agent, ApiError, AppState};
use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{delete, get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{env, time::Duration};

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
        .route("/api/inference/explain", post(unsupported))
        .route("/api/inference/stream", post(unsupported))
        .route("/api/inference/history", get(unsupported))
        .route("/api/inference/requests/{id}", delete(unsupported))
}

async fn unsupported() -> Response {
    (
        StatusCode::NOT_IMPLEMENTED,
        Json(json!({"error":"unsupported inference operation","code":"unsupported"})),
    )
        .into_response()
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
    #[serde(default)]
    timeout_ms: Option<u64>,
    #[serde(default, alias = "agentId")]
    agent_id: Option<String>,
}

async fn execute(
    State(_state): State<AppState>,
    headers: axum::http::HeaderMap,
    Json(request): Json<ExecuteRequest>,
) -> Result<Json<Value>, ApiError> {
    let identity = agent(&headers, None, request.agent_id.as_deref())?;
    if let Some(provider) = request.provider.as_deref() {
        if provider != "openai-compatible" {
            return Err(ApiError::bad_request("unsupported inference provider"));
        }
    }
    if !configured() {
        return Err(ApiError::bad_request(
            "inference provider is not configured",
        ));
    }
    let base = setting("SIGNET_OPENAI_BASE_URL").unwrap();
    let model = request
        .model
        .or_else(|| setting("SIGNET_OPENAI_MODEL"))
        .unwrap();
    let messages = request
        .messages
        .unwrap_or_else(|| json!([{"role":"user","content":request.prompt.unwrap_or_default()}]));
    if !messages.is_array() {
        return Err(ApiError::bad_request("messages must be an array"));
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
    let response = request
        .send()
        .await
        .map_err(|error| ProviderError::Transport(format!("provider request failed: {error}")))?;
    let status = response.status().as_u16();
    let bytes = response.bytes().await.map_err(|error| {
        ProviderError::InvalidResponse(format!("provider response read failed: {error}"))
    })?;
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
