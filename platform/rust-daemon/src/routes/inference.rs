use crate::{agent, ApiError, AppState};
use axum::{
    extract::State,
    response::IntoResponse,
    routing::{get, post},
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
}

async fn status() -> impl IntoResponse {
    Json(
        json!({"configured": configured(), "provider": if configured() { "openai-compatible" } else { Value::Null }, "available": configured()}),
    )
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
    .map_err(|_| ApiError::bad_request("inference provider request timed out"))?
    .map_err(|message| ApiError::bad_request(message))?;
    Ok(Json(
        json!({"provider":"openai-compatible", "agent_id":identity, "response":response}),
    ))
}

async fn call_openai(base: &str, key: Option<String>, body: Value) -> Result<Value, String> {
    let url = base.trim_end_matches('/').to_owned() + "/v1/chat/completions";
    let parsed = url
        .strip_prefix("http://")
        .ok_or_else(|| "only http:// OpenAI-compatible endpoints are supported".to_owned())?;
    let (host_port, path) = parsed
        .split_once('/')
        .map(|(h, p)| (h, format!("/{p}")))
        .unwrap_or((parsed, "/".to_owned()));
    let mut stream = tokio::net::TcpStream::connect(host_port)
        .await
        .map_err(|e| format!("provider connection failed: {e}"))?;
    let bytes = serde_json::to_vec(&body).map_err(|e| e.to_string())?;
    let auth = key
        .map(|k| format!("Authorization: Bearer {k}\r\n"))
        .unwrap_or_default();
    let request = format!("POST {path} HTTP/1.1\r\nHost: {host_port}\r\nContent-Type: application/json\r\n{auth}Content-Length: {}\r\nConnection: close\r\n\r\n", bytes.len());
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    stream
        .write_all(request.as_bytes())
        .await
        .map_err(|e| e.to_string())?;
    stream.write_all(&bytes).await.map_err(|e| e.to_string())?;
    let mut response = Vec::new();
    stream
        .read_to_end(&mut response)
        .await
        .map_err(|e| e.to_string())?;
    let split = response
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .ok_or_else(|| "provider returned malformed HTTP".to_owned())?;
    let head = String::from_utf8_lossy(&response[..split]);
    let status = head
        .lines()
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .and_then(|v| v.parse::<u16>().ok())
        .unwrap_or(0);
    let body = &response[split + 4..];
    let value: Value =
        serde_json::from_slice(body).map_err(|e| format!("provider returned invalid JSON: {e}"))?;
    if !(200..300).contains(&status) {
        return Err(format!(
            "provider returned HTTP {status}: {}",
            value.get("error").unwrap_or(&value)
        ));
    }
    Ok(value)
}
