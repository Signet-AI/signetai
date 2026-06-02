use std::collections::BTreeSet;
use std::net::SocketAddr;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use axum::{
    Json,
    body::Bytes,
    extract::{ConnectInfo, Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use serde_json::{Map, Value, json};
use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use tokio::time::timeout;

use crate::auth::{
    middleware::{AuthState, authenticate_headers, require_permission_guard, resolve_scoped_agent},
    types::Permission,
};
use crate::state::AppState;

const MAX_EXPLAIN_BYTES: usize = 128 * 1024;
const MAX_EXECUTE_BYTES: usize = 512 * 1024;
const MAX_GATEWAY_BYTES: usize = 512 * 1024;
const MAX_PROMPT_CHARS: usize = 200_000;
const MAX_EXPLICIT_TARGETS: usize = 8;
const MAX_HINT_CHARS: usize = 160;
const MAX_TIMEOUT_MS: u64 = 10 * 60 * 1000;
const MAX_RESPONSE_TOKENS: u64 = 100_000;
const MAX_GATEWAY_MESSAGES: usize = 128;

#[derive(Debug, Clone, Default)]
struct InferenceConfig {
    enabled: bool,
    source: String,
    target_refs: Vec<String>,
    policies: Vec<String>,
    agents: Value,
    raw: Option<serde_yml::Value>,
}

#[derive(Debug)]
struct RouteRequest {
    agent_id: String,
    operation: Option<String>,
    privacy: Option<String>,
    explicit_targets: Vec<String>,
}

fn is_local(peer: SocketAddr) -> bool {
    peer.ip().is_loopback()
}

fn error(status: StatusCode, message: impl Into<String>) -> Response {
    (
        status,
        Json(json!({"error": message.into(), "details": null})),
    )
        .into_response()
}

fn gateway_error(status: StatusCode, message: impl Into<String>) -> Response {
    (
        status,
        Json(json!({"error": {"message": message.into(), "details": null}})),
    )
        .into_response()
}

fn unavailable(message: &str) -> Response {
    error(StatusCode::SERVICE_UNAVAILABLE, message)
}

fn require_access(
    state: &AppState,
    peer: SocketAddr,
    headers: &HeaderMap,
    permission: Permission,
) -> Result<AuthState, Response> {
    let local = is_local(peer);
    let auth_runtime = state.auth_snapshot();
    let auth = authenticate_headers(
        auth_runtime.mode,
        auth_runtime.secret.as_deref(),
        headers,
        local,
    )
    .map_err(|resp| *resp)?;
    require_permission_guard(&auth, permission, auth_runtime.mode, local).map_err(|resp| *resp)?;
    Ok(auth)
}

fn safe_hint(value: &str) -> bool {
    value
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '/' | '-'))
}

fn parse_hint(value: Option<&Value>, field: &str) -> Result<Option<String>, Response> {
    let Some(value) = value else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(None);
    }
    let Some(raw) = value.as_str() else {
        return Err(error(
            StatusCode::BAD_REQUEST,
            format!("{field} must be a string"),
        ));
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    if trimmed.len() > MAX_HINT_CHARS {
        return Err(error(
            StatusCode::PAYLOAD_TOO_LARGE,
            format!("{field} exceeds {MAX_HINT_CHARS} characters"),
        ));
    }
    if !safe_hint(trimmed) {
        return Err(error(
            StatusCode::BAD_REQUEST,
            format!("{field} contains unsupported characters"),
        ));
    }
    Ok(Some(trimmed.to_string()))
}

fn parse_gateway_hint(headers: &HeaderMap, name: &str) -> Result<Option<String>, Response> {
    let Some(raw) = headers.get(name).and_then(|value| value.to_str().ok()) else {
        return Ok(None);
    };
    let value = Value::String(raw.to_string());
    parse_hint(Some(&value), name).map_err(|resp| match resp.into_response().status() {
        StatusCode::BAD_REQUEST => gateway_error(
            StatusCode::BAD_REQUEST,
            format!("{name} contains unsupported characters"),
        ),
        status => gateway_error(status, format!("{name} is invalid")),
    })
}

fn parse_bool(value: Option<&Value>, field: &str) -> Result<Option<bool>, Response> {
    let Some(value) = value else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(None);
    }
    value.as_bool().map(Some).ok_or_else(|| {
        error(
            StatusCode::BAD_REQUEST,
            format!("{field} must be a boolean"),
        )
    })
}

fn parse_bounded_number(
    value: Option<&Value>,
    field: &str,
    max: u64,
) -> Result<Option<u64>, Response> {
    let Some(value) = value else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(None);
    }
    let Some(raw) = value.as_f64() else {
        return Err(error(
            StatusCode::BAD_REQUEST,
            format!("{field} must be a finite number"),
        ));
    };
    if !raw.is_finite() {
        return Err(error(
            StatusCode::BAD_REQUEST,
            format!("{field} must be a finite number"),
        ));
    }
    if raw < 0.0 {
        return Err(error(
            StatusCode::BAD_REQUEST,
            format!("{field} must be non-negative"),
        ));
    }
    Ok(Some((raw.floor() as u64).min(max)))
}

fn parse_explicit_targets(body: &Map<String, Value>) -> Result<Vec<String>, Response> {
    let Some(value) = body.get("explicitTargets") else {
        return Ok(Vec::new());
    };
    if value.is_null() {
        return Ok(Vec::new());
    }
    let Some(items) = value.as_array() else {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "explicitTargets must be an array of target refs",
        ));
    };
    if items.len() > MAX_EXPLICIT_TARGETS {
        return Err(error(
            StatusCode::BAD_REQUEST,
            format!("explicitTargets may contain at most {MAX_EXPLICIT_TARGETS} entries"),
        ));
    }
    let mut refs = Vec::new();
    for item in items {
        let Some(target) = parse_hint(Some(item), "explicitTargets entry")? else {
            continue;
        };
        let parts = target.split('/').collect::<Vec<_>>();
        if parts.len() != 2 || parts.iter().any(|part| part.is_empty()) {
            return Err(error(
                StatusCode::BAD_REQUEST,
                format!("invalid explicit target ref '{target}'"),
            ));
        }
        if !refs.contains(&target) {
            refs.push(target);
        }
    }
    Ok(refs)
}

fn read_yaml_mapping<'a>(value: &'a serde_yml::Value, key: &str) -> Option<&'a serde_yml::Mapping> {
    value
        .as_mapping()?
        .get(serde_yml::Value::String(key.to_string()))?
        .as_mapping()
}

fn yaml_mapping_field<'a>(
    mapping: &'a serde_yml::Mapping,
    key: &str,
) -> Option<&'a serde_yml::Mapping> {
    mapping
        .get(serde_yml::Value::String(key.to_string()))?
        .as_mapping()
}

fn yaml_keys(mapping: Option<&serde_yml::Mapping>) -> Vec<String> {
    let mut keys = mapping
        .into_iter()
        .flat_map(|mapping| mapping.keys())
        .filter_map(serde_yml::Value::as_str)
        .map(str::to_string)
        .collect::<Vec<_>>();
    keys.sort();
    keys
}

fn load_inference_config(state: &AppState) -> Result<InferenceConfig, Response> {
    let path = state.config.base_path.join("agent.yaml");
    let raw = match std::fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return Ok(InferenceConfig {
                source: "implicit".to_string(),
                ..InferenceConfig::default()
            });
        }
        Err(err) => {
            return Err(error(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("failed to read agent.yaml: {err}"),
            ));
        }
    };
    let root: serde_yml::Value = serde_yml::from_str(&raw).map_err(|err| {
        error(
            StatusCode::BAD_REQUEST,
            format!("invalid agent.yaml: {err}"),
        )
    })?;
    let Some(inference) = read_yaml_mapping(&root, "inference") else {
        return Ok(InferenceConfig {
            source: "implicit".to_string(),
            ..InferenceConfig::default()
        });
    };

    let targets = yaml_mapping_field(inference, "targets");
    let target_refs = if let Some(targets) = targets {
        let mut refs = Vec::new();
        for (target, raw) in targets {
            let Some(target) = target.as_str() else {
                continue;
            };
            let Some(models) = read_yaml_mapping(raw, "models") else {
                continue;
            };
            refs.extend(
                models
                    .keys()
                    .filter_map(serde_yml::Value::as_str)
                    .map(|model| format!("{target}/{model}")),
            );
        }
        refs.sort();
        refs
    } else {
        Vec::new()
    };

    let enabled = inference
        .get(serde_yml::Value::String("enabled".to_string()))
        .and_then(serde_yml::Value::as_bool)
        .unwrap_or(!target_refs.is_empty());
    let agents = inference
        .get(serde_yml::Value::String("agents".to_string()))
        .and_then(|value| serde_json::to_value(value).ok())
        .unwrap_or_else(|| json!({}));

    Ok(InferenceConfig {
        enabled,
        source: "explicit".to_string(),
        target_refs,
        policies: yaml_keys(yaml_mapping_field(inference, "policies")),
        agents,
        raw: Some(serde_yml::Value::Mapping(inference.clone())),
    })
}

fn read_json_object(bytes: Bytes, max_bytes: usize) -> Result<Map<String, Value>, Response> {
    if bytes.len() > max_bytes {
        return Err(error(
            StatusCode::PAYLOAD_TOO_LARGE,
            format!("payload exceeds {max_bytes} byte limit"),
        ));
    }
    if bytes.iter().all(|b| b.is_ascii_whitespace()) {
        return Ok(Map::new());
    }
    let value: Value = serde_json::from_slice(&bytes)
        .map_err(|_| error(StatusCode::BAD_REQUEST, "request body must be valid JSON"))?;
    value.as_object().cloned().ok_or_else(|| {
        error(
            StatusCode::BAD_REQUEST,
            "request body must be a JSON object",
        )
    })
}

fn parse_prompt(body: &Map<String, Value>) -> Result<String, Response> {
    let Some(value) = body.get("prompt").and_then(Value::as_str) else {
        return Err(error(StatusCode::BAD_REQUEST, "prompt is required"));
    };
    if value.trim().is_empty() {
        return Err(error(StatusCode::BAD_REQUEST, "prompt is required"));
    }
    if value.chars().count() > MAX_PROMPT_CHARS {
        return Err(error(
            StatusCode::PAYLOAD_TOO_LARGE,
            format!("prompt exceeds {MAX_PROMPT_CHARS} characters"),
        ));
    }
    Ok(value.to_string())
}

fn agent_roster(config: &InferenceConfig, agent_id: &str) -> BTreeSet<String> {
    config
        .agents
        .get(agent_id)
        .and_then(|agent| agent.get("roster"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect()
}

fn validate_route_request(config: &InferenceConfig, req: &RouteRequest) -> Result<(), Response> {
    if req.privacy.as_deref() == Some("local_only")
        && req
            .explicit_targets
            .iter()
            .any(|target| !target.starts_with("local/"))
    {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "Explicit target overrides are not allowed by the active agent roster or policy.",
        ));
    }

    let roster = agent_roster(config, &req.agent_id);
    if !roster.is_empty()
        && req
            .explicit_targets
            .iter()
            .any(|target| !roster.contains(target))
    {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "Explicit target overrides are not allowed by the active agent roster or policy.",
        ));
    }
    Ok(())
}

fn build_route_request(
    state: &AppState,
    peer: SocketAddr,
    auth: &AuthState,
    body: &Map<String, Value>,
    config: &InferenceConfig,
    header_agent_id: Option<&str>,
    header_explicit_target: Option<&str>,
) -> Result<RouteRequest, Response> {
    let auth_runtime = state.auth_snapshot();
    let requested = match header_agent_id {
        Some(agent_id) => Some(agent_id.to_string()),
        None => parse_hint(body.get("agentId"), "agentId")?,
    };
    let agent_id = resolve_scoped_agent(
        auth,
        auth_runtime.mode,
        is_local(peer),
        requested.as_deref(),
    )
    .map_err(|reason| error(StatusCode::FORBIDDEN, reason))?;
    let operation = parse_hint(body.get("operation"), "operation")?;
    let privacy = parse_hint(body.get("privacy"), "privacy")?;
    let mut explicit_targets = parse_explicit_targets(body)?;
    if let Some(target) = header_explicit_target {
        let parts = target.split('/').collect::<Vec<_>>();
        if parts.len() != 2 || parts.iter().any(|part| part.is_empty()) {
            return Err(error(
                StatusCode::BAD_REQUEST,
                format!("invalid explicit target ref '{target}'"),
            ));
        }
        if !explicit_targets.contains(&target.to_string()) {
            explicit_targets.push(target.to_string());
        }
    }
    let req = RouteRequest {
        agent_id,
        operation,
        privacy,
        explicit_targets,
    };
    validate_route_request(config, &req)?;
    Ok(req)
}

fn validate_execute_options(body: &Map<String, Value>) -> Result<(), Response> {
    let _ = parse_bounded_number(body.get("timeoutMs"), "timeoutMs", MAX_TIMEOUT_MS)?;
    let _ = parse_bounded_number(body.get("maxTokens"), "maxTokens", MAX_RESPONSE_TOKENS)?;
    let _ = parse_bool(body.get("refresh"), "refresh")?;
    Ok(())
}

fn yaml_string(mapping: &serde_yml::Mapping, key: &str) -> Option<String> {
    mapping
        .get(serde_yml::Value::String(key.to_string()))?
        .as_str()
        .map(str::to_string)
}

fn yaml_string_array(mapping: &serde_yml::Mapping, key: &str) -> Vec<String> {
    mapping
        .get(serde_yml::Value::String(key.to_string()))
        .and_then(serde_yml::Value::as_sequence)
        .into_iter()
        .flatten()
        .filter_map(serde_yml::Value::as_str)
        .map(str::to_string)
        .collect()
}

fn yaml_string_map(mapping: &serde_yml::Mapping, key: &str) -> Vec<(String, String)> {
    mapping
        .get(serde_yml::Value::String(key.to_string()))
        .and_then(serde_yml::Value::as_mapping)
        .into_iter()
        .flat_map(|mapping| mapping.iter())
        .filter_map(|(key, value)| Some((key.as_str()?.to_string(), value.as_str()?.to_string())))
        .collect()
}

fn raw_mapping(config: &InferenceConfig) -> Option<&serde_yml::Mapping> {
    config.raw.as_ref()?.as_mapping()
}

fn mapping_child<'a>(mapping: &'a serde_yml::Mapping, key: &str) -> Option<&'a serde_yml::Mapping> {
    mapping
        .get(serde_yml::Value::String(key.to_string()))?
        .as_mapping()
}

fn resolve_policy_targets(config: &InferenceConfig, policy_id: &str) -> Vec<String> {
    let Some(inference) = raw_mapping(config) else {
        return Vec::new();
    };
    let Some(policies) = mapping_child(inference, "policies") else {
        return Vec::new();
    };
    let Some(policy) = policies
        .get(serde_yml::Value::String(policy_id.to_string()))
        .and_then(serde_yml::Value::as_mapping)
    else {
        return Vec::new();
    };
    yaml_string_array(policy, "defaultTargets")
}

fn resolve_default_target_ref(config: &InferenceConfig, req: &RouteRequest) -> Option<String> {
    if let Some(target) = req.explicit_targets.first() {
        return Some(target.clone());
    }
    let inference = raw_mapping(config)?;
    let operation = req.operation.as_deref().unwrap_or("default");
    let workload_policy = mapping_child(inference, "workloads")
        .and_then(|workloads| workloads.get(serde_yml::Value::String(operation.to_string())))
        .and_then(serde_yml::Value::as_mapping)
        .and_then(|workload| yaml_string(workload, "policy"));
    let policy = workload_policy.or_else(|| yaml_string(inference, "defaultPolicy"))?;
    resolve_policy_targets(config, &policy).into_iter().next()
}

fn target_mapping<'a>(
    config: &'a InferenceConfig,
    target_ref: &str,
) -> Option<(&'a serde_yml::Mapping, String)> {
    let (target_id, model_id) = target_ref.split_once('/')?;
    let inference = raw_mapping(config)?;
    let targets = mapping_child(inference, "targets")?;
    let target = targets
        .get(serde_yml::Value::String(target_id.to_string()))?
        .as_mapping()?;
    Some((target, model_id.to_string()))
}

fn replace_prompt_tokens(value: &str, prompt: &str) -> String {
    value
        .replace("$PROMPT", prompt)
        .replace("{{prompt}}", prompt)
}

async fn execute_command_target(
    state: &AppState,
    target_ref: &str,
    target: &serde_yml::Mapping,
    prompt: &str,
    timeout_ms: u64,
) -> Result<Response, Response> {
    if yaml_string(target, "executor").as_deref() != Some("command") {
        return Err(unavailable("inference router not initialized"));
    }
    let Some(command) = mapping_child(target, "command") else {
        return Err(error(
            StatusCode::BAD_REQUEST,
            format!("Missing command config for target {target_ref}"),
        ));
    };
    let Some(bin) = yaml_string(command, "bin") else {
        return Err(error(
            StatusCode::BAD_REQUEST,
            format!("Missing command bin for target {target_ref}"),
        ));
    };
    let mut child = Command::new(bin);
    child.args(
        yaml_string_array(command, "args")
            .into_iter()
            .map(|arg| replace_prompt_tokens(&arg, prompt)),
    );
    if let Some(cwd) = yaml_string(command, "cwd") {
        let path = std::path::PathBuf::from(&cwd);
        child.current_dir(if path.is_absolute() {
            path
        } else {
            state.config.base_path.join(path)
        });
    }
    child.env("SIGNET_PROMPT", prompt);
    for (key, value) in yaml_string_map(command, "env") {
        child.env(key, replace_prompt_tokens(&value, prompt));
    }
    child.stdin(Stdio::piped());
    child.stdout(Stdio::piped());
    child.stderr(Stdio::piped());
    child.kill_on_drop(true);

    let mut child = child.spawn().map_err(|err| {
        error(
            StatusCode::BAD_GATEWAY,
            format!("command:{target_ref} failed to start: {err}"),
        )
    })?;
    let output = timeout(Duration::from_millis(timeout_ms), async {
        if let Some(mut stdin) = child.stdin.take() {
            stdin.write_all(prompt.as_bytes()).await.map_err(|err| {
                error(
                    StatusCode::BAD_GATEWAY,
                    format!("command:{target_ref} failed to write prompt: {err}"),
                )
            })?;
        }
        child.wait_with_output().await.map_err(|err| {
            error(
                StatusCode::BAD_GATEWAY,
                format!("command:{target_ref} failed: {err}"),
            )
        })
    })
    .await
    .map_err(|_| {
        error(
            StatusCode::GATEWAY_TIMEOUT,
            format!("command:{target_ref} timeout"),
        )
    })??;
    if !output.status.success() {
        return Err(error(
            StatusCode::BAD_GATEWAY,
            format!(
                "command:{target_ref} exited {:?}: {}",
                output.status.code(),
                String::from_utf8_lossy(&output.stderr)
                    .chars()
                    .take(300)
                    .collect::<String>()
            ),
        ));
    }
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if text.is_empty() {
        return Err(error(
            StatusCode::BAD_GATEWAY,
            format!("command:{target_ref} returned empty response"),
        ));
    }
    Ok(Json(json!({
        "text": text,
        "decision": {"targetRef": target_ref},
    }))
    .into_response())
}

pub async fn status(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Response {
    if let Err(resp) = require_access(&state, peer, &headers, Permission::Diagnostics) {
        return resp;
    }
    let config = match load_inference_config(&state) {
        Ok(config) => config,
        Err(resp) => return resp,
    };
    Json(json!({
        "enabled": config.enabled,
        "source": config.source,
        "targetRefs": config.target_refs,
        "policies": config.policies,
        "concurrency": {
            "active": {"execute": 0, "nativeStream": 0, "gatewayStream": 0, "total": 0},
            "limits": {"execute": 8, "nativeStream": 8, "gatewayStream": 16, "total": 24}
        }
    }))
    .into_response()
}

pub async fn history(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Response {
    if let Err(resp) = require_access(&state, peer, &headers, Permission::Diagnostics) {
        return resp;
    }
    Json(json!({
        "enabled": false,
        "events": [],
        "summary": {"total": 0, "failures": 0, "fallbacks": 0, "cancelled": 0}
    }))
    .into_response()
}

pub async fn explain(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    bytes: Bytes,
) -> Response {
    let auth = match require_access(&state, peer, &headers, Permission::Recall) {
        Ok(auth) => auth,
        Err(resp) => return resp,
    };
    let body = match read_json_object(bytes, MAX_EXPLAIN_BYTES) {
        Ok(body) => body,
        Err(resp) => return resp,
    };
    let config = match load_inference_config(&state) {
        Ok(config) => config,
        Err(resp) => return resp,
    };
    if !config.enabled {
        return unavailable("inference router not initialized");
    }
    if let Err(resp) = build_route_request(&state, peer, &auth, &body, &config, None, None) {
        return resp;
    }
    if let Err(resp) = parse_bool(body.get("refresh"), "refresh") {
        return resp;
    }
    unavailable("inference router not initialized")
}

pub async fn execute(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    bytes: Bytes,
) -> Response {
    let auth = match require_access(&state, peer, &headers, Permission::Admin) {
        Ok(auth) => auth,
        Err(resp) => return resp,
    };
    let body = match read_json_object(bytes, MAX_EXECUTE_BYTES) {
        Ok(body) => body,
        Err(resp) => return resp,
    };
    let prompt = match parse_prompt(&body) {
        Ok(prompt) => prompt,
        Err(resp) => return resp,
    };
    let config = match load_inference_config(&state) {
        Ok(config) => config,
        Err(resp) => return resp,
    };
    if !config.enabled {
        return unavailable("inference router not initialized");
    }
    let req = match build_route_request(&state, peer, &auth, &body, &config, None, None) {
        Ok(req) => req,
        Err(resp) => return resp,
    };
    if let Err(resp) = validate_execute_options(&body) {
        return resp;
    }
    let timeout_ms = match parse_bounded_number(body.get("timeoutMs"), "timeoutMs", MAX_TIMEOUT_MS)
    {
        Ok(value) => value.unwrap_or(60_000),
        Err(resp) => return resp,
    };
    let Some(target_ref) = resolve_default_target_ref(&config, &req) else {
        return unavailable("inference router not initialized");
    };
    let Some((target, _model_id)) = target_mapping(&config, &target_ref) else {
        return unavailable("inference router not initialized");
    };
    match execute_command_target(&state, &target_ref, target, &prompt, timeout_ms).await {
        Ok(resp) => resp,
        Err(resp) => resp,
    }
}

pub async fn stream(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    bytes: Bytes,
) -> Response {
    let auth = match require_access(&state, peer, &headers, Permission::Admin) {
        Ok(auth) => auth,
        Err(resp) => return resp,
    };
    let body = match read_json_object(bytes, MAX_EXECUTE_BYTES) {
        Ok(body) => body,
        Err(resp) => return resp,
    };
    if let Err(resp) = parse_prompt(&body) {
        return resp;
    }
    let config = match load_inference_config(&state) {
        Ok(config) => config,
        Err(resp) => return resp,
    };
    if !config.enabled {
        return unavailable("inference router not initialized");
    }
    if let Err(resp) = build_route_request(&state, peer, &auth, &body, &config, None, None) {
        return resp;
    }
    if let Err(resp) = validate_execute_options(&body) {
        return resp;
    }
    unavailable("inference router not initialized")
}

pub async fn request_delete(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(_id): Path<String>,
) -> Response {
    if let Err(resp) = require_access(&state, peer, &headers, Permission::Admin) {
        return resp;
    }
    error(StatusCode::NOT_FOUND, "inference request not found")
}

pub async fn gateway_models(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Response {
    if let Err(resp) = require_access(&state, peer, &headers, Permission::Admin) {
        return resp;
    }
    let config = match load_inference_config(&state) {
        Ok(config) => config,
        Err(resp) => return resp,
    };
    if !config.enabled {
        return gateway_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "inference router not initialized",
        );
    }
    let mut ids = vec!["signet:auto".to_string()];
    ids.extend(
        config
            .policies
            .iter()
            .map(|policy| format!("policy:{policy}")),
    );
    ids.extend(config.target_refs);
    ids.sort();
    ids.dedup();
    Json(json!({
        "object": "list",
        "data": ids.into_iter().map(|id| json!({"id": id, "object": "model", "owned_by": "signet"})).collect::<Vec<_>>()
    }))
    .into_response()
}

fn parse_gateway_messages(body: &Map<String, Value>) -> Result<(), Response> {
    let Some(messages) = body.get("messages").and_then(Value::as_array) else {
        return Err(gateway_error(
            StatusCode::BAD_REQUEST,
            "messages are required",
        ));
    };
    if messages.is_empty() {
        return Err(gateway_error(
            StatusCode::BAD_REQUEST,
            "messages are required",
        ));
    }
    if messages.len() > MAX_GATEWAY_MESSAGES {
        return Err(gateway_error(
            StatusCode::BAD_REQUEST,
            format!("messages may contain at most {MAX_GATEWAY_MESSAGES} entries"),
        ));
    }
    let mut total = 0usize;
    let mut has_content = false;
    for message in messages {
        if let Some(content) = message.get("content").and_then(Value::as_str) {
            if !content.trim().is_empty() {
                has_content = true;
                total += content.chars().count();
            }
        }
    }
    if total > MAX_PROMPT_CHARS {
        return Err(gateway_error(
            StatusCode::PAYLOAD_TOO_LARGE,
            format!("messages exceed {MAX_PROMPT_CHARS} characters"),
        ));
    }
    if !has_content {
        return Err(gateway_error(
            StatusCode::BAD_REQUEST,
            "messages must contain string content",
        ));
    }
    Ok(())
}

pub async fn gateway_chat_completions(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    bytes: Bytes,
) -> Response {
    let auth = match require_access(&state, peer, &headers, Permission::Admin) {
        Ok(auth) => auth,
        Err(resp) => return resp,
    };
    let config = match load_inference_config(&state) {
        Ok(config) => config,
        Err(resp) => return resp,
    };
    if !config.enabled {
        return gateway_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "inference router not initialized",
        );
    }
    let body = match read_json_object(bytes, MAX_GATEWAY_BYTES) {
        Ok(body) => body,
        Err(resp) => return gateway_error(resp.status(), "request body must be valid JSON"),
    };
    if let Err(resp) = parse_bool(body.get("stream"), "stream") {
        return gateway_error(resp.status(), "stream must be a boolean");
    }
    if let Err(resp) = parse_gateway_messages(&body) {
        return resp;
    }
    let header_agent_id = match parse_gateway_hint(&headers, "x-signet-agent-id") {
        Ok(agent_id) => agent_id,
        Err(resp) => return resp,
    };
    let header_explicit_target = match parse_gateway_hint(&headers, "x-signet-explicit-target") {
        Ok(target) => target,
        Err(resp) => return resp,
    };
    if let Err(resp) = build_route_request(
        &state,
        peer,
        &auth,
        &body,
        &config,
        header_agent_id.as_deref(),
        header_explicit_target.as_deref(),
    ) {
        return gateway_error(resp.status(), "scope violation");
    }
    gateway_error(
        StatusCode::SERVICE_UNAVAILABLE,
        "inference router not initialized",
    )
}
