mod routes;
mod worker;

use axum::{
    body::Body,
    extract::{Path, Query, State},
    http::{header, HeaderMap, Request, StatusCode, Uri},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use signet_core_native::{CoreError, Operation, WorkspaceOwner};
#[cfg(unix)]
use std::os::fd::AsRawFd;
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
#[cfg(windows)]
use std::os::windows::ffi::OsStrExt;
use std::{
    collections::HashMap,
    env,
    fs::{File, OpenOptions},
    io::{BufRead, BufReader, Read, Seek, SeekFrom, Write},
    net::SocketAddr,
    path::{Path as FsPath, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::signal;
use tokio::sync::Semaphore;
use uuid::Uuid;
#[cfg(windows)]
#[cfg(windows)]
use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, ERROR_ALREADY_EXISTS, HANDLE};
#[cfg(windows)]
use windows_sys::Win32::System::Threading::CreateMutexW;

#[derive(Clone)]
pub(crate) struct ExternalOwner {
    inner: Arc<OwnerPipe>,
}
struct OwnerSession {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<std::process::ChildStdout>,
    generation: String,
}
struct OwnerPipe {
    workspace: PathBuf,
    session: Mutex<OwnerSession>,
    admission: Arc<Semaphore>,
}

impl Drop for OwnerPipe {
    fn drop(&mut self) {
        if let Ok(mut session) = self.session.lock() {
            let generation = session.generation.clone();
            let _ = writeln!(
                session.stdin,
                "{{\"id\":null,\"generation\":\"{}\",\"op\":\"shutdown\"}}",
                generation
            );
            let _ = session.stdin.flush();
            let _ = session.child.wait();
        }
        let daemon_dir = self.workspace.join(".daemon");
        let _ = std::fs::remove_file(daemon_dir.join("db-owner.json"));
    }
}

impl ExternalOwner {
    fn start_session(workspace: &FsPath) -> Result<OwnerSession, CoreError> {
        let exe = env::var_os("SIGNET_DAEMON_BIN")
            .map(PathBuf::from)
            .or_else(|| env::current_exe().ok())
            .ok_or(CoreError::OwnerStopped)?;
        let mut child = Command::new(exe)
            .arg("--db-owner")
            .env("SIGNET_PATH", workspace)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| CoreError::OwnerStopped)?;
        let stdin = child.stdin.take().ok_or(CoreError::OwnerStopped)?;
        let stdout = child.stdout.take().ok_or(CoreError::OwnerStopped)?;
        let mut stdout = BufReader::new(stdout);
        let mut line = String::new();
        stdout
            .read_line(&mut line)
            .map_err(|_| CoreError::OwnerStopped)?;
        let ready: Value = serde_json::from_str(&line).map_err(|_| CoreError::OwnerStopped)?;
        let generation = ready
            .get("generation")
            .and_then(Value::as_str)
            .ok_or(CoreError::OwnerStopped)?
            .to_owned();
        Ok(OwnerSession {
            child,
            stdin,
            stdout,
            generation,
        })
    }
    fn spawn(workspace: &FsPath) -> Result<Self, CoreError> {
        let session = Self::start_session(workspace)?;
        Ok(Self {
            inner: Arc::new(OwnerPipe {
                workspace: workspace.to_path_buf(),
                session: Mutex::new(session),
                admission: Arc::new(Semaphore::new(32)),
            }),
        })
    }
    fn submit(&self, operation: Operation) -> Result<Value, CoreError> {
        let _permit = self
            .inner
            .admission
            .try_acquire()
            .map_err(|_| CoreError::InvalidInput("owner IPC capacity exhausted".into()))?;
        let mut session = self
            .inner
            .session
            .lock()
            .map_err(|_| CoreError::OwnerStopped)?;
        let id = Uuid::new_v4().to_string();
        let generation = session.generation.clone();
        let request = json!({"id":id,"generation":generation,"operation":operation.clone()});
        let failed = serde_json::to_writer(&mut session.stdin, &request)
            .and_then(|_| {
                session
                    .stdin
                    .write_all(b"\n")
                    .map_err(serde_json::Error::io)
            })
            .and_then(|_| session.stdin.flush().map_err(serde_json::Error::io))
            .is_err();
        if failed {
            if matches!(operation, Operation::Health) {
                let replacement = Self::start_session(&self.inner.workspace)?;
                *session = replacement;
                drop(session);
                return self.submit(Operation::Health);
            }
            return Err(CoreError::OwnerStopped);
        }
        let mut line = String::new();
        let read = session.stdout.read_line(&mut line);
        if !matches!(read, Ok(size) if size > 0) {
            if matches!(operation, Operation::Health) {
                *session = Self::start_session(&self.inner.workspace)?;
                drop(session);
                return self.submit(Operation::Health);
            }
            return Err(CoreError::OwnerStopped);
        }
        let response: Value = serde_json::from_str(&line).map_err(|_| CoreError::OwnerStopped)?;
        if response.get("id").and_then(Value::as_str) != Some(id.as_str())
            || response.get("generation").and_then(Value::as_str) != Some(generation.as_str())
        {
            return Err(CoreError::InvalidInput(
                "stale owner response rejected".into(),
            ));
        }
        if response.get("ok").and_then(Value::as_bool) == Some(true) {
            response
                .get("result")
                .cloned()
                .ok_or(CoreError::OwnerStopped)
        } else {
            Err(CoreError::InvalidInput(
                response
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("owner error")
                    .to_owned(),
            ))
        }
    }
    async fn submit_async(&self, operation: Operation) -> Result<Value, CoreError> {
        let owner = self.clone();
        tokio::task::spawn_blocking(move || owner.submit(operation))
            .await
            .map_err(|_| CoreError::OwnerStopped)?
    }
    fn database_sample(
        &self,
        _table: String,
        _limit: usize,
        _offset: usize,
        _agent: Option<String>,
        _workspace: Option<String>,
    ) -> Result<Value, CoreError> {
        Err(CoreError::InvalidInput(
            "database sampling is unavailable through the owner boundary".into(),
        ))
    }
    fn database_schema(&self) -> Result<Value, CoreError> {
        self.submit(Operation::Health)
    }
}

#[derive(Clone)]
pub(crate) struct AppState {
    pub(crate) owner: Arc<ExternalOwner>,
    pub(crate) started_at: u64,
    pub(crate) workspace: PathBuf,
    pub(crate) dashboard: Option<PathBuf>,
    pub(crate) auth_secret: Option<Vec<u8>>,
    pub(crate) cancellation: Arc<CancellationRuntime>,
}

#[derive(Default)]
pub(crate) struct CancellationRuntime {
    operations: Mutex<HashMap<String, CancellationState>>,
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum CancellationState {
    Queued,
    InFlight,
    Cancelled,
    Finished,
}

#[derive(Debug, Serialize)]
struct ErrorBody {
    error: String,
    code: String,
}

pub(crate) struct ApiError {
    pub(crate) status: StatusCode,
    pub(crate) code: &'static str,
    pub(crate) message: String,
}

fn configured_api_key() -> Option<String> {
    env::var("SIGNET_API_KEY")
        .ok()
        .and_then(|value| non_empty(&value))
        .or_else(|| {
            env::var("SIGNET_TOKEN")
                .ok()
                .and_then(|value| non_empty(&value))
        })
}

async fn authenticate_api(
    State(state): State<AppState>,
    request: Request<Body>,
    next: Next,
) -> Response {
    let expected = configured_api_key();
    let explicitly_open = env::var("SIGNET_MODE")
        .map(|mode| mode.eq_ignore_ascii_case("local"))
        .unwrap_or(false);
    if explicitly_open && expected.is_none() {
        return next.run(request).await;
    }
    let path = request.uri().path();
    let protected = (path.starts_with("/api/")
        && path != "/api/mode"
        && path != "/api/features"
        && path != "/api/auth/whoami")
        || path == "/memory/search";
    if !protected {
        return next.run(request).await;
    }
    let supplied = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .or_else(|| {
            request
                .headers()
                .get("x-signet-api-key")
                .and_then(|value| value.to_str().ok())
        })
        .map(str::to_owned);
    let configured = expected
        .as_deref()
        .is_some_and(|value| Some(value) == supplied.as_deref());
    let durable = if configured {
        true
    } else if let Some(token) = supplied.as_deref() {
        routes::auth::verify_token(&state, token).is_some()
            || match state
                .owner
                .submit_async(Operation::AuthKeyVerify {
                    token: token.to_owned(),
                })
                .await
            {
                Ok(result) => result.get("authenticated").and_then(Value::as_bool) == Some(true),
                Err(_) => false,
            }
    } else {
        false
    };
    if durable {
        return next.run(request).await;
    }
    (
        StatusCode::UNAUTHORIZED,
        [(header::WWW_AUTHENTICATE, "Bearer")],
        Json(ErrorBody {
            error: "valid Bearer token or x-signet-api-key is required".to_owned(),
            code: "unauthorized".to_owned(),
        }),
    )
        .into_response()
}

impl ApiError {
    pub(crate) fn bad_request(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            code: "invalid_request",
            message: message.into(),
        }
    }

    pub(crate) fn forbidden(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::FORBIDDEN,
            code: "forbidden",
            message: message.into(),
        }
    }

    pub(crate) fn unauthorized(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::UNAUTHORIZED,
            code: "missing_identity",
            message: message.into(),
        }
    }

    pub(crate) fn not_found(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            code: "not_found",
            message: message.into(),
        }
    }

    pub(crate) fn unavailable(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::SERVICE_UNAVAILABLE,
            code: "database_unavailable",
            message: message.into(),
        }
    }

    pub(crate) fn upstream(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_GATEWAY,
            code: "upstream_error",
            message: message.into(),
        }
    }

    pub(crate) fn not_implemented(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::NOT_IMPLEMENTED,
            code: "unsupported",
            message: message.into(),
        }
    }

    pub(crate) fn internal(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "internal_error",
            message: message.into(),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(ErrorBody {
                error: self.message,
                code: self.code.into(),
            }),
        )
            .into_response()
    }
}

impl From<CoreError> for ApiError {
    fn from(error: CoreError) -> Self {
        match error {
            CoreError::NotFound => Self::not_found("record not found"),
            CoreError::InvalidInput(message) => Self::bad_request(message),
            CoreError::QueueFull { capacity } => Self::unavailable(format!(
                "database owner queue is saturated (capacity {capacity})"
            )),
            CoreError::OwnerStopped => Self::unavailable("database owner is unavailable"),
            other => Self::internal(other.to_string()),
        }
    }
}

#[derive(Debug, Deserialize, Default)]
pub(crate) struct AgentQuery {
    #[serde(alias = "agent_id")]
    agent_id: Option<String>,
    #[serde(rename = "agentId")]
    agent_id_camel: Option<String>,
    limit: Option<usize>,
    cursor: Option<String>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct RememberRequest {
    content: String,
    #[serde(default, alias = "agentId")]
    agent_id: Option<String>,
    #[serde(default)]
    metadata: Option<Value>,
    #[serde(flatten)]
    extra: HashMap<String, Value>,
}

#[derive(Debug, Deserialize)]
struct UpdateRequest {
    #[serde(default)]
    content: Option<String>,
    #[serde(default, alias = "agentId")]
    agent_id: Option<String>,
    #[serde(default)]
    metadata: Option<Value>,
}

#[derive(Debug, Deserialize)]
struct RecallRequest {
    query: String,
    #[serde(default, alias = "agentId")]
    agent_id: Option<String>,
    #[serde(default)]
    limit: Option<Value>,
}

pub(crate) fn configured_agent() -> Option<String> {
    env::var("SIGNET_AGENT_ID")
        .ok()
        .and_then(|value| non_empty(&value))
}

pub(crate) fn non_empty(value: &str) -> Option<String> {
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_owned())
}

fn parse_limit_value(value: Option<&Value>) -> Result<usize, ApiError> {
    let Some(value) = value else {
        return Ok(10);
    };
    let Some(raw) = value.as_u64() else {
        return Err(ApiError::bad_request(
            "limit must be an integer from 1 to 100",
        ));
    };
    if !(1..=100).contains(&raw) {
        return Err(ApiError::bad_request(
            "limit must be an integer from 1 to 100",
        ));
    }
    Ok(raw as usize)
}

fn parse_limit_text(raw: Option<&str>) -> Result<usize, ApiError> {
    let Some(raw) = raw else {
        return Ok(10);
    };
    let value = raw
        .parse::<u64>()
        .map_err(|_| ApiError::bad_request("limit must be an integer from 1 to 100"))?;
    if !(1..=100).contains(&value) {
        return Err(ApiError::bad_request(
            "limit must be an integer from 1 to 100",
        ));
    }
    Ok(value as usize)
}

pub(crate) fn agent(
    headers: &HeaderMap,
    query: Option<&AgentQuery>,
    body: Option<&str>,
) -> Result<String, ApiError> {
    let mut identities = Vec::new();
    for name in ["x-signet-agent-id", "x-signet-agent"] {
        for value in headers.get_all(name).iter() {
            let value = value
                .to_str()
                .map_err(|_| ApiError::bad_request("agent identity header must be valid UTF-8"))?;
            if let Some(value) = non_empty(value) {
                identities.push(value);
            }
        }
    }
    if let Some(query) = query {
        if let Some(value) = query.agent_id.as_deref().and_then(non_empty) {
            identities.push(value);
        }
        if let Some(value) = query.agent_id_camel.as_deref().and_then(non_empty) {
            identities.push(value);
        }
    }
    if let Some(value) = body.and_then(non_empty) {
        identities.push(value);
    }
    if identities.is_empty() {
        if let Some(value) = configured_agent() {
            identities.push(value);
        }
    }
    identities.dedup();
    match identities.as_slice() {
        [] => Err(ApiError::unauthorized(
            "an agent identity is required (x-signet-agent-id or agent_id)",
        )),
        [identity] => Ok(identity.clone()),
        _ => Err(ApiError::bad_request("conflicting agent identities")),
    }
}

pub(crate) fn metadata(request: &RememberRequest) -> Value {
    let mut metadata = request.metadata.clone().unwrap_or_else(|| json!({}));
    if let Value::Object(ref mut object) = metadata {
        for (key, value) in &request.extra {
            if key != "agent_id" && key != "agentId" && key != "content" && key != "metadata" {
                object.entry(key.clone()).or_insert_with(|| value.clone());
            }
        }
    }
    metadata
}

pub(crate) async fn execute(state: &AppState, operation: Operation) -> Result<Value, ApiError> {
    let owner = state.owner.clone();
    tokio::task::spawn_blocking(move || owner.submit(operation))
        .await
        .map_err(|error| ApiError::unavailable(format!("database owner task failed: {error}")))?
        .map_err(ApiError::from)
}

#[derive(Debug, Deserialize)]
struct CancellationRequest {
    action: String,
    #[serde(rename = "operationId")]
    operation_id: String,
    content: Option<String>,
    fault: Option<String>,
}

async fn cancellation(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<CancellationRequest>,
) -> Result<Json<Value>, ApiError> {
    if !env::var("SIGNET_MODE")
        .map(|v| v.eq_ignore_ascii_case("local"))
        .unwrap_or(false)
    {
        return Err(ApiError::not_found("not found"));
    }
    let agent_id = agent(&headers, None, None)?;
    let key = format!("{agent_id}:{}", request.operation_id);
    if request.action == "begin" && request.fault.as_deref() == Some("delay") {
        let mut operations = state.cancellation.operations.lock().unwrap();
        if operations.contains_key(&key) {
            return Ok(Json(
                json!({"operationId":request.operation_id,"outcome":"queued"}),
            ));
        }
        operations.insert(key.clone(), CancellationState::Queued);
        drop(operations);
        let runtime = state.cancellation.clone();
        let owner = state.owner.clone();
        let operation_id = request.operation_id.clone();
        let content = request.content.clone();
        let agent_for_task = agent_id.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
            let cancelled = {
                let mut ops = runtime.operations.lock().unwrap();
                match ops.get_mut(&key) {
                    Some(state @ CancellationState::Queued) => {
                        *state = CancellationState::InFlight;
                        false
                    }
                    Some(CancellationState::Cancelled) => true,
                    _ => true,
                }
            };
            let _ = owner.submit(Operation::Cancellation {
                agent_id: agent_for_task,
                action: if cancelled {
                    "cancel".into()
                } else {
                    "begin".into()
                },
                operation_id,
                content: if cancelled { None } else { content },
                fault: None,
            });
            if let Some(state) = runtime.operations.lock().unwrap().get_mut(&key) {
                *state = if cancelled {
                    CancellationState::Cancelled
                } else {
                    CancellationState::Finished
                };
            }
        });
        return Ok(Json(
            json!({"operationId":request.operation_id,"outcome":"queued"}),
        ));
    }
    if request.action == "cancel" {
        let mut operations = state.cancellation.operations.lock().unwrap();
        if let Some(operation) = operations.get_mut(&key) {
            if *operation == CancellationState::Queued {
                *operation = CancellationState::Cancelled;
                return Ok(Json(
                    json!({"operationId":request.operation_id,"outcome":"cancelled"}),
                ));
            }
            return Ok(Json(
                json!({"operationId":request.operation_id,"outcome":"unknown"}),
            ));
        }
    }
    let result = execute(
        &state,
        Operation::Cancellation {
            agent_id,
            action: request.action,
            operation_id: request.operation_id,
            content: request.content,
            fault: request.fault,
        },
    )
    .await?;
    Ok(Json(result))
}

async fn live(State(state): State<AppState>) -> impl IntoResponse {
    Json(json!({
        "status": "healthy",
        "runtime": "rust",
        "implementation": "fresh",
        "uptime": elapsed_seconds(state.started_at),
        "pid": std::process::id(),
    }))
}

async fn ready(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let result = execute(&state, Operation::Health).await?;
    if !result
        .get("ready")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return Err(ApiError::unavailable(
            "database migrations or owner are not ready",
        ));
    }
    Ok(Json(json!({
        "status": if result.get("ready").and_then(Value::as_bool).unwrap_or(false) { "ready" } else { "not_ready" },
        "runtime": "rust",
        "db": result.get("ready").cloned().unwrap_or(Value::Bool(false)),
        "database": result.get("database").cloned().unwrap_or_else(|| json!("unknown")),
        "migrations": result.get("migrations").cloned().unwrap_or_else(|| json!({"status":"unknown"})),
        "owner": result.get("owner").cloned().unwrap_or_else(|| json!({"status":"unknown"})),
        "workspace": state.workspace,
    })))
}

async fn health(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let result = execute(&state, Operation::Health).await?;
    let ready = result
        .get("ready")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if !ready {
        return Err(ApiError::unavailable(
            "database migrations or owner are not ready",
        ));
    }
    Ok(Json(json!({
        "status": if ready { "healthy" } else { "degraded" },
        "runtime": "rust",
        "implementation": "fresh",
        "db": ready,
        "database": result.get("database").cloned().unwrap_or_else(|| json!("unknown")),
        "migrations": result.get("migrations").cloned().unwrap_or_else(|| json!({"status":"unknown"})),
        "owner": result.get("owner").cloned().unwrap_or_else(|| json!({"status":"unknown"})),
        "uptime": elapsed_seconds(state.started_at),
        "pid": std::process::id(),
        "workspace": state.workspace,
    })))
}

async fn status(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let result = execute(&state, Operation::Health).await?;
    let ready = result
        .get("ready")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    Ok(Json(json!({
        "status": if ready { "healthy" } else { "degraded" },
        "runtime": "rust",
        "implementation": "fresh",
        "ready": ready,
        "complete": true,
        "degraded": !ready,
        "database": result.get("database").cloned().unwrap_or_else(|| json!("unknown")),
        "migrations": result.get("migrations").cloned().unwrap_or_else(|| json!({"status":"unknown"})),
        "owner": result.get("owner").cloned().unwrap_or_else(|| json!({"status":"unknown"})),
        "unsupported": { "embedding": "unprobed", "inference": "unsupported", "connectors": "unprobed", "providerProbes": "unprobed", "update": "unsupported", "resource": "unprobed", "eventLoop": "unprobed" },
        "workspace": state.workspace,
    })))
}

async fn mode() -> Json<Value> {
    Json(
        json!({ "mode": "native", "runtime": "rust", "implementation": "fresh", "supported": true, "complete": true }),
    )
}

async fn remember(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<RememberRequest>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let requested = request.agent_id.clone();
    let agent_id = agent(&headers, None, requested.as_deref())?;
    if request.content.trim().is_empty() {
        return Err(ApiError::bad_request("content must not be empty"));
    }
    let memory_metadata = metadata(&request);
    let content = request.content;
    let telemetry_agent = agent_id.clone();
    let result = execute(
        &state,
        Operation::Remember {
            agent_id,
            content,
            metadata: memory_metadata,
        },
    )
    .await?;
    execute(
        &state,
        Operation::TelemetryRecord {
            agent_id: telemetry_agent,
            workspace_id: workspace_id(&headers, None),
            event: "memory.remembered".to_owned(),
            payload: json!({"source":"native-memory-route"}),
        },
    )
    .await?;
    Ok((StatusCode::CREATED, Json(result)))
}

async fn list(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<AgentQuery>,
) -> Result<Json<Value>, ApiError> {
    let agent_id = agent(&headers, Some(&query), None)?;
    let result = execute(
        &state,
        Operation::List {
            agent_id,
            include_deleted: false,
            limit: query.limit,
            cursor: query.cursor,
        },
    )
    .await?;
    let page = result.as_object().cloned().unwrap_or_default();
    Ok(Json(
        json!({ "memories": page.get("items").cloned().unwrap_or_else(|| json!([])), "nextCursor": page.get("nextCursor").cloned().unwrap_or(Value::Null), "complete": page.get("complete").and_then(Value::as_bool).unwrap_or(true) }),
    ))
}

async fn get_one(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<AgentQuery>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let agent_id = agent(&headers, Some(&query), None)?;
    let result = execute(&state, Operation::Get { agent_id, id }).await?;
    if result.is_null() {
        return Err(ApiError::not_found("memory not found"));
    }
    Ok(Json(result))
}

async fn patch_one(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<AgentQuery>,
    Path(id): Path<String>,
    Json(request): Json<UpdateRequest>,
) -> Result<Json<Value>, ApiError> {
    let requested = request.agent_id.clone();
    let agent_id = agent(&headers, Some(&query), requested.as_deref())?;
    let current = execute(
        &state,
        Operation::Get {
            agent_id: agent_id.clone(),
            id: id.clone(),
        },
    )
    .await?;
    if current.is_null() {
        return Err(ApiError::not_found("memory not found"));
    }
    let content = request
        .content
        .or_else(|| {
            current
                .get("content")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .ok_or_else(|| ApiError::bad_request("content must not be empty"))?;
    if content.trim().is_empty() {
        return Err(ApiError::bad_request("content must not be empty"));
    }
    let memory_metadata = request
        .metadata
        .or_else(|| current.get("metadata").cloned())
        .unwrap_or_else(|| json!({}));
    let result = execute(
        &state,
        Operation::Update {
            agent_id,
            id,
            content,
            metadata: memory_metadata,
        },
    )
    .await?;
    Ok(Json(result))
}

async fn delete_one(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<AgentQuery>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let agent_id = agent(&headers, Some(&query), None)?;
    let result = execute(&state, Operation::SoftDelete { agent_id, id }).await?;
    Ok(Json(result))
}

async fn history(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<AgentQuery>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let agent_id = agent(&headers, Some(&query), None)?;
    let result = execute(&state, Operation::History { agent_id, id }).await?;
    Ok(Json(json!({ "history": result })))
}

async fn recover(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<AgentQuery>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let agent_id = agent(&headers, Some(&query), None)?;
    let result = execute(&state, Operation::Recover { agent_id, id }).await?;
    Ok(Json(result))
}

async fn recall(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<RecallRequest>,
) -> Result<Json<Value>, ApiError> {
    let requested = request.agent_id.clone();
    let agent_id = agent(&headers, None, requested.as_deref())?;
    if request.query.trim().is_empty() {
        return Err(ApiError::bad_request("query must not be empty"));
    }
    let limit = parse_limit_value(request.limit.as_ref())?;
    let result = execute(
        &state,
        Operation::MemorySearch {
            agent_id,
            query: request.query,
            limit,
        },
    )
    .await?;
    Ok(Json(result))
}

async fn search(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(mut query): Query<HashMap<String, String>>,
) -> Result<Json<Value>, ApiError> {
    let requested = query.remove("agent_id").or_else(|| query.remove("agentId"));
    let agent_id = agent(&headers, None, requested.as_deref())?;
    let text = query
        .remove("q")
        .or_else(|| query.remove("query"))
        .unwrap_or_default();
    if text.trim().is_empty() {
        return Err(ApiError::bad_request("q or query is required"));
    }
    let limit = parse_limit_text(query.get("limit").map(String::as_str))?;
    let result = execute(
        &state,
        Operation::MemorySearch {
            agent_id,
            query: text,
            limit,
        },
    )
    .await?;
    Ok(Json(result))
}

async fn sources(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let agent_id = agent(&headers, None, None)?;
    let workspace_id = source_workspace(&headers, None)?;
    Ok(Json(
        json!({"sources": execute(&state, Operation::ListSources{agent_id, workspace_id}).await?}),
    ))
}
#[derive(Debug, Deserialize)]
struct SourceRequest {
    #[serde(default, alias = "sourceId")]
    source_id: Option<String>,
    kind: String,
    name: String,
    #[serde(default)]
    config: Value,
    #[serde(default, alias = "workspaceId")]
    workspace_id: Option<String>,
}
async fn create_source(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<SourceRequest>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let agent_id = agent(&headers, None, None)?;
    let workspace_id = source_workspace(&headers, req.workspace_id.as_deref())?;
    Ok((
        StatusCode::CREATED,
        Json(
            execute(
                &state,
                Operation::CreateSource {
                    agent_id,
                    workspace_id,
                    kind: req.kind,
                    name: req.name,
                    config: req.config,
                    source_id: req.source_id,
                },
            )
            .await?,
        ),
    ))
}
#[derive(Debug, Deserialize)]
struct DocumentRequest {
    source_id: String,
    path: String,
    content: String,
    #[serde(default)]
    metadata: Value,
    #[serde(default, alias = "duplicateMode")]
    duplicate_mode: String,
    #[serde(default)]
    generation: Option<i64>,
    #[serde(default, alias = "workspaceId")]
    workspace_id: Option<String>,
}

fn source_workspace(headers: &HeaderMap, requested: Option<&str>) -> Result<String, ApiError> {
    let header_values = ["x-signet-workspace-id", "x-workspace-id"]
        .iter()
        .filter_map(|name| {
            headers
                .get(*name)
                .and_then(|v| v.to_str().ok())
                .and_then(non_empty)
        })
        .collect::<Vec<_>>();
    let body = requested.and_then(non_empty);
    let mut values = header_values.iter().map(|v| v.as_str()).collect::<Vec<_>>();
    if let Some(body) = body.as_deref() {
        values.push(body);
    }
    let environment = env::var("SIGNET_WORKSPACE_ID")
        .ok()
        .and_then(|value| non_empty(&value));
    if let Some(environment) = environment.as_deref() {
        values.push(environment);
    }
    if values.is_empty() {
        values.push("default");
    }
    if values.iter().any(|value| *value != values[0]) {
        return Err(ApiError::bad_request("conflicting workspace identities"));
    }
    if values[0].len() > 256 {
        return Err(ApiError::bad_request("workspace identity is too long"));
    }
    Ok(values[0].to_owned())
}

pub(crate) fn workspace_id(headers: &HeaderMap, requested: Option<&str>) -> String {
    headers
        .get("x-signet-workspace-id")
        .or_else(|| headers.get("x-workspace-id"))
        .and_then(|value| value.to_str().ok())
        .and_then(non_empty)
        .or_else(|| requested.and_then(non_empty))
        .or_else(|| {
            env::var("SIGNET_WORKSPACE_ID")
                .ok()
                .and_then(|value| non_empty(&value))
        })
        .unwrap_or_else(|| "default".to_owned())
}

fn document_workspace(headers: &HeaderMap, requested: Option<&str>) -> String {
    workspace_id(headers, requested)
}

async fn import_document(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<DocumentRequest>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let agent_id = agent(&headers, None, None)?;
    let workspace_id = document_workspace(&headers, req.workspace_id.as_deref());
    Ok((
        StatusCode::CREATED,
        Json(
            execute(
                &state,
                Operation::IngestDocument {
                    agent_id,
                    workspace_id: workspace_id.clone(),
                    source_id: req.source_id,
                    path: req.path,
                    content: req.content,
                    metadata: {
                        let mut m = if req.metadata.is_null() {
                            json!({})
                        } else {
                            req.metadata
                        };
                        if let Value::Object(ref mut o) = m {
                            o.insert("_workspaceId".into(), json!(workspace_id));
                            if let Some(g) = req.generation {
                                o.insert("_generation".into(), json!(g));
                            }
                            o.insert("_duplicateMode".into(), json!(req.duplicate_mode));
                        }
                        m
                    },
                },
            )
            .await?,
        ),
    ))
}

async fn document_list(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<AgentQuery>,
) -> Result<Json<Value>, ApiError> {
    let agent_id = agent(&headers, Some(&query), None)?;
    let workspace_id = document_workspace(&headers, None);
    Ok(Json(
        execute(
            &state,
            Operation::DocumentList {
                agent_id,
                workspace_id,
                limit: query.limit.unwrap_or(100).min(100),
            },
        )
        .await?,
    ))
}
async fn document_get(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<AgentQuery>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let agent_id = agent(&headers, Some(&query), None)?;
    let workspace_id = document_workspace(&headers, None);
    let value = execute(
        &state,
        Operation::DocumentGet {
            agent_id,
            workspace_id,
            id,
        },
    )
    .await?;
    if value.is_null() {
        return Err(ApiError::not_found("document not found"));
    }
    Ok(Json(value))
}
async fn document_chunks(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<AgentQuery>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let agent_id = agent(&headers, Some(&query), None)?;
    let workspace_id = document_workspace(&headers, None);
    Ok(Json(
        execute(
            &state,
            Operation::DocumentChunks {
                agent_id,
                workspace_id,
                id,
                limit: query.limit.unwrap_or(100).min(100),
            },
        )
        .await?,
    ))
}
async fn document_delete(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<AgentQuery>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let agent_id = agent(&headers, Some(&query), None)?;
    let workspace_id = document_workspace(&headers, None);
    Ok(Json(
        execute(
            &state,
            Operation::DocumentDelete {
                agent_id,
                workspace_id,
                id,
            },
        )
        .await?,
    ))
}

async fn whoami(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    // This route is deliberately public: the auth middleware excludes it so the
    // dashboard can discover whether another login is required.
    let mode = env::var("SIGNET_AUTH_MODE")
        .ok()
        .filter(|value| matches!(value.as_str(), "local" | "hybrid" | "remote"))
        .unwrap_or_else(|| "hybrid".to_owned());
    let credential = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .or_else(|| {
            headers
                .get("x-signet-api-key")
                .and_then(|value| value.to_str().ok())
        });
    let claims = credential.and_then(|token| {
        if configured_api_key().as_deref() == Some(token) {
            Some(json!({"sub":"token:admin","role":"admin","scope":{}}))
        } else {
            routes::auth::verify_token(&state, token)
        }
    });
    let authenticated = claims.is_some();
    let trusted_local = false;
    let providers = json!([
        {"id":"password","type":"password","enabled":env::var("SIGNET_ADMIN_PASSWORD").is_ok() || env::var("SIGNET_ADMIN_PASSWORD_HASH").is_ok(),"username":env::var("SIGNET_ADMIN_USERNAME").unwrap_or_else(|_| "admin".to_owned())},
        {"id":"sso","type":"oidc","enabled":false,"startPath":"/api/auth/sso/start"},
        {"id":"saml","type":"saml","enabled":false,"startPath":"/api/auth/saml/start"}
    ]);
    Ok(Json(json!({
        "authenticated": authenticated,
        "trustedLocal": trusted_local,
        "effectiveAccess": mode == "local" || authenticated || trusted_local,
        "claims": claims,
        "mode": mode,
        "providers": providers,
    })))
}

fn elapsed_seconds(started_at: u64) -> u64 {
    now_seconds().saturating_sub(started_at)
}

fn now_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn workspace_path() -> PathBuf {
    env::var_os("SIGNET_PATH")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(".signet"))
}

fn database_path(workspace: &FsPath) -> PathBuf {
    workspace.join("memory").join("memories.db")
}

fn resolve_dashboard_path() -> Option<PathBuf> {
    let candidates = [
        env::var_os("SIGNET_DASHBOARD_DIR").map(PathBuf::from),
        env::var_os("SIGNET_DIR")
            .map(|root| PathBuf::from(root).join("runtime/rust-daemon/dashboard")),
        env::current_exe().ok().and_then(|path| {
            path.parent()
                .and_then(FsPath::parent)
                .map(|root| root.join("dashboard"))
        }),
    ];
    candidates
        .into_iter()
        .flatten()
        .find(|path| path.join("index.html").is_file())
}

fn content_type(path: &FsPath) -> &'static str {
    match path.extension().and_then(|extension| extension.to_str()) {
        Some("css") => "text/css; charset=utf-8",
        Some("html") => "text/html; charset=utf-8",
        Some("js") => "text/javascript; charset=utf-8",
        Some("json") => "application/json; charset=utf-8",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("woff") => "font/woff",
        Some("woff2") => "font/woff2",
        _ => "application/octet-stream",
    }
}

async fn dashboard(State(state): State<AppState>, uri: Uri) -> Response {
    if uri.path().starts_with("/api/") || uri.path().starts_with("/health") || uri.path() == "/sse"
    {
        return StatusCode::NOT_FOUND.into_response();
    }
    let Some(root) = state.dashboard else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "dashboard_unavailable" })),
        )
            .into_response();
    };
    let raw_path = uri.path().trim_start_matches('/');
    if raw_path.split('/').any(|part| part == "..") {
        return StatusCode::NOT_FOUND.into_response();
    }
    let relative = if raw_path.is_empty() || !raw_path.contains('.') {
        "index.html"
    } else {
        raw_path
    };
    let path = root.join(relative);
    let body = match tokio::fs::read(&path).await {
        Ok(body) => body,
        Err(_) if relative != "index.html" => {
            let fallback = root.join("index.html");
            match tokio::fs::read(&fallback).await {
                Ok(body) => body,
                Err(_) => return StatusCode::NOT_FOUND.into_response(),
            }
        }
        Err(_) => return StatusCode::NOT_FOUND.into_response(),
    };
    let mime_path = if path.is_file() {
        path.as_path()
    } else {
        FsPath::new("index.html")
    };
    let mut response = body.into_response();
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        content_type(mime_path).parse().unwrap(),
    );
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        if relative == "index.html" {
            "no-cache"
        } else {
            "public, max-age=31536000, immutable"
        }
        .parse()
        .unwrap(),
    );
    response
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    if env::args().any(|arg| arg == "--db-owner") {
        return db_owner_process();
    }
    let workspace = workspace_path();
    std::fs::create_dir_all(workspace.join("memory"))?;
    let daemon_dir = workspace.join(".daemon");
    std::fs::create_dir_all(&daemon_dir)?;
    let auth_path = daemon_dir.join("auth-secret");
    if !auth_path.exists() {
        let mut secret = Vec::with_capacity(32);
        secret.extend_from_slice(Uuid::new_v4().as_bytes());
        secret.extend_from_slice(Uuid::new_v4().as_bytes());
        std::fs::write(auth_path, secret)?;
    }
    let owner = Arc::new(
        ExternalOwner::spawn(&workspace)
            .map_err(|error| format!("database owner startup: {error}"))?,
    );
    let state = AppState {
        owner,
        started_at: now_seconds(),
        dashboard: resolve_dashboard_path(),
        auth_secret: routes::auth::load_secret(&workspace),
        workspace,
        cancellation: Arc::new(CancellationRuntime::default()),
    };
    let worker_owner = state.owner.clone();
    let _worker = worker::start(worker_owner);
    let host = env::var("SIGNET_BIND").unwrap_or_else(|_| "127.0.0.1".to_owned());
    let port = env::var("SIGNET_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(3850);
    let address: SocketAddr = format!("{host}:{port}").parse()?;
    let router = Router::new()
        .route("/health/live", get(live))
        .route("/health/ready", get(ready))
        .route("/health", get(health))
        .route("/api/status", get(status))
        .route("/api/mode", get(mode))
        .route("/api/testing/cancellation", post(cancellation))
        .route("/api/sources", get(sources).post(create_source))
        .route("/api/import/documents", post(import_document))
        .route("/api/documents", get(document_list).post(import_document))
        .route("/api/documents/{id}/chunks", get(document_chunks))
        .route(
            "/api/documents/{id}",
            get(document_get).delete(document_delete),
        )
        .route("/api/sources/documents", post(import_document))
        .route("/api/auth/whoami", get(whoami))
        .route("/api/memory/remember", post(remember))
        .route("/api/memory/save", post(remember))
        .route("/api/memory/recall", post(recall))
        .route("/api/memory/search", get(search))
        .route("/memory/search", get(search))
        .route("/api/memories", get(list))
        .route("/api/memory/{id}/history", get(history))
        .route("/api/memory/{id}/recover", post(recover))
        .route(
            "/api/memory/{id}",
            get(get_one).patch(patch_one).delete(delete_one),
        )
        .merge(routes::router())
        .merge(routes::plugins::router())
        .fallback(dashboard)
        .layer(middleware::from_fn_with_state(
            state.clone(),
            authenticate_api,
        ))
        .with_state(state);
    let listener = tokio::net::TcpListener::bind(address).await?;
    axum::serve(listener, router)
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
}

/// Dedicated database-owner process protocol. The HTTP process never enters this mode;
/// it is launched as a child and communicates with bounded newline-delimited JSON.
struct OwnerLock {
    _file: File,
    path: PathBuf,
    #[cfg(unix)]
    _directory: File,
    #[cfg(windows)]
    _mutex: HANDLE,
}

impl Drop for OwnerLock {
    fn drop(&mut self) {
        // The path is durable metadata, not the ownership primitive. Recreate it
        // if a concurrent rename replaced it while the kernel lock was held.
        if !self.path.exists() {
            let _ = OpenOptions::new().write(true).create(true).open(&self.path);
        }
        #[cfg(windows)]
        unsafe { CloseHandle(self._mutex); }
    }
}

#[cfg(unix)]
fn legacy_owner_is_live(metadata: &str) -> bool {
    let Some(pid) = metadata
        .split_whitespace()
        .next()
        .and_then(|value| value.parse::<libc::pid_t>().ok())
    else {
        return false;
    };
    if pid <= 0 || pid == 1 || pid == std::process::id() as libc::pid_t {
        return false;
    }
    let result = unsafe { libc::kill(pid, 0) };
    result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

fn acquire_owner_lock(path: &FsPath) -> Result<OwnerLock, Box<dyn std::error::Error>> {
    #[cfg(unix)]
    {
        let parent = path
            .parent()
            .ok_or_else(|| "database owner lock has no parent directory".to_owned())?;
        std::fs::create_dir_all(parent)?;
        let canonical_parent = std::fs::canonicalize(parent)?;
        let directory = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW)
            .open(&canonical_parent)?;
        if unsafe { libc::flock(directory.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            return Err("database owner already running".into());
        }
        let mut file = match OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .custom_flags(libc::O_NOFOLLOW)
            .open(path)
        {
            Ok(file) => file,
            Err(error) => {
                let _ = unsafe { libc::flock(directory.as_raw_fd(), libc::LOCK_UN) };
                return Err(error.into());
            }
        };
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            let _ = unsafe { libc::flock(directory.as_raw_fd(), libc::LOCK_UN) };
            return Err("database owner already running".into());
        }
        let mut metadata = String::new();
        file.read_to_string(&mut metadata)?;
        if !metadata.contains("signet-kernel-lock-v1") && legacy_owner_is_live(&metadata) {
            let _ = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_UN) };
            let _ = unsafe { libc::flock(directory.as_raw_fd(), libc::LOCK_UN) };
            return Err("database owner already running".into());
        }
        file.set_len(0)?;
        file.seek(SeekFrom::Start(0))?;
        write!(
            file,
            "{}\\n{}\\nsignet-kernel-lock-v1\\n",
            std::process::id(),
            now_seconds()
        )?;
        file.flush()?;
        return Ok(OwnerLock {
            _file: file,
            path: path.to_path_buf(),
            _directory: directory,
        });
    }
    #[cfg(windows)]
    {
        let parent = path.parent().ok_or("database owner lock has no parent")?;
        std::fs::create_dir_all(parent)?;
        let canonical_parent = std::fs::canonicalize(parent)?;
        if std::fs::symlink_metadata(path).map(|m| m.file_type().is_symlink()).unwrap_or(false) { return Err("database owner lock path is a symlink".into()); }
        let identity = format!("{}\\{}", canonical_parent.display(), path.display());
        use sha2::Digest;
        let digest = sha2::Sha256::digest(identity.as_bytes());
        let name = format!("Global\\SignetDbOwner-{}", digest.iter().map(|b| format!("{b:02x}")).collect::<String>());
        let wide: Vec<u16> = std::ffi::OsStr::new(&name).encode_wide().chain(std::iter::once(0)).collect();
        let mutex = unsafe { CreateMutexW(std::ptr::null(), 1, wide.as_ptr()) };
        if mutex.is_null() { return Err(std::io::Error::last_os_error().into()); }
        if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS { unsafe { CloseHandle(mutex); } return Err("database owner already running".into()); }
        let mut file = OpenOptions::new().read(true).write(true).create(true).open(path)?;
        file.set_len(0)?;
        write!(file, "{}\\n{}\\nsignet-kernel-lock-v1\\n", std::process::id(), now_seconds())?;
        file.flush()?;
        return Ok(OwnerLock { _file: file, path: path.to_path_buf(), _mutex: mutex });
    }
    #[cfg(not(any(unix, windows)))]
    {
        let mut file = OpenOptions::new().write(true).create_new(true).open(path)?;
        write!(
            file,
            "{}\\n{}\\nsignet-kernel-lock-v1\\n",
            std::process::id(),
            now_seconds()
        )?;
        file.flush()?;
        Ok(OwnerLock { _file: file })
    }
}

fn db_owner_process() -> Result<(), Box<dyn std::error::Error>> {
    let workspace = workspace_path();
    let path = database_path(&workspace);
    let lock_path = workspace.join(".daemon").join("db-owner.lock");
    let _lock = acquire_owner_lock(&lock_path)?;
    let owner = WorkspaceOwner::open(&path, 256)?;
    owner.initialize()?;
    let generation = Uuid::new_v4().to_string();
    let marker_path = workspace.join(".daemon").join("db-owner.json");
    std::fs::write(
        &marker_path,
        serde_json::to_vec(&serde_json::json!({
            "pid": std::process::id(),
            "generation": generation,
            "database": path,
        }))?,
    )?;
    let mut out = std::io::BufWriter::new(std::io::stdout().lock());
    writeln!(
        out,
        "{{\"ready\":true,\"pid\":{},\"generation\":\"{}\"}}",
        std::process::id(),
        generation
    )?;
    out.flush()?;
    let stdin = std::io::stdin();
    for line in BufReader::new(stdin.lock()).lines() {
        let line = line?;
        if line.len() > 1_048_576 {
            break;
        }
        let request: serde_json::Value = serde_json::from_str(&line)?;
        let id = request.get("id").cloned().unwrap_or(Value::Null);
        let request_generation = request.get("generation").and_then(Value::as_str);
        if request_generation != Some(generation.as_str()) {
            writeln!(out, "{{\"id\":{},\"error\":\"stale_generation\"}}", id)?;
            out.flush()?;
            continue;
        }
        if request.get("op").and_then(Value::as_str) == Some("shutdown") {
            break;
        }
        let operation: Operation =
            serde_json::from_value(request.get("operation").cloned().unwrap_or(Value::Null))?;
        let response = match owner.submit(operation) {
            Ok(value) => {
                serde_json::json!({"id":id,"generation":generation,"ok":true,"result":value})
            }
            Err(error) => {
                serde_json::json!({"id":id,"generation":generation,"ok":false,"error":error.to_string()})
            }
        };
        serde_json::to_writer(&mut out, &response)?;
        writeln!(out)?;
        out.flush()?;
    }
    if !lock_path.exists() {
        let _ = OpenOptions::new().write(true).create(true).open(&lock_path);
    }
    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = async {
        signal::ctrl_c()
            .await
            .expect("failed to install Ctrl+C handler");
    };
    #[cfg(unix)]
    let terminate = async {
        signal::unix::signal(signal::unix::SignalKind::terminate())
            .expect("failed to install SIGTERM handler")
            .recv()
            .await;
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! { _ = ctrl_c => {}, _ = terminate => {} }
}
