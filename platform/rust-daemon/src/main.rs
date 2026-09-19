mod routes;

use axum::{
    extract::{Path, Query, State},
    http::{header, HeaderMap, StatusCode, Uri},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use signet_core_native::{CoreError, Operation, WorkspaceOwner};
use std::{
    collections::HashMap,
    env,
    net::SocketAddr,
    path::{Path as FsPath, PathBuf},
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::signal;

#[derive(Clone)]
pub(crate) struct AppState {
    pub(crate) owner: Arc<WorkspaceOwner>,
    pub(crate) started_at: u64,
    pub(crate) workspace: PathBuf,
    pub(crate) dashboard: Option<PathBuf>,
}

#[derive(Debug, Serialize)]
struct ErrorBody {
    error: String,
    code: String,
}

pub(crate) struct ApiError {
    status: StatusCode,
    code: &'static str,
    message: String,
}

impl ApiError {
    pub(crate) fn bad_request(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            code: "invalid_request",
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

pub(crate) fn agent(
    headers: &HeaderMap,
    query: Option<&AgentQuery>,
    body: Option<&str>,
) -> Result<String, ApiError> {
    headers
        .get("x-signet-agent-id")
        .or_else(|| headers.get("x-signet-agent"))
        .and_then(|value| value.to_str().ok())
        .and_then(non_empty)
        .or_else(|| {
            query
                .and_then(|value| value.agent_id.clone())
                .and_then(|value| non_empty(&value))
        })
        .or_else(|| body.and_then(non_empty))
        .or_else(configured_agent)
        .ok_or_else(|| {
            ApiError::unauthorized("an agent identity is required (x-signet-agent-id or agent_id)")
        })
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
    tokio::time::timeout(
        std::time::Duration::from_secs(10),
        tokio::task::spawn_blocking(move || owner.submit(operation)),
    )
    .await
    .map_err(|_| ApiError::unavailable("database operation deadline exceeded"))?
    .map_err(|error| ApiError::unavailable(format!("database owner task failed: {error}")))?
    .map_err(ApiError::from)
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
    Ok(Json(json!({
        "status": if result.get("ready").and_then(Value::as_bool).unwrap_or(false) { "ready" } else { "not_ready" },
        "runtime": "rust",
        "db": result.get("ready").cloned().unwrap_or(Value::Bool(false)),
        "workspace": state.workspace,
    })))
}

async fn health(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let result = execute(&state, Operation::Health).await?;
    let ready = result
        .get("ready")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    Ok(Json(json!({
        "status": if ready { "healthy" } else { "degraded" },
        "runtime": "rust",
        "implementation": "fresh",
        "db": ready,
        "uptime": elapsed_seconds(state.started_at),
        "pid": std::process::id(),
        "workspace": state.workspace,
    })))
}

async fn status(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let result = execute(&state, Operation::Health).await?;
    Ok(Json(json!({
        "status": if result.get("ready").and_then(Value::as_bool).unwrap_or(false) { "healthy" } else { "degraded" },
        "runtime": "rust",
        "implementation": "fresh",
        "workspace": state.workspace,
    })))
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
    let result = execute(
        &state,
        Operation::Remember {
            agent_id,
            content,
            metadata: memory_metadata,
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
        },
    )
    .await?;
    let memories = result.as_array().cloned().unwrap_or_default();
    Ok(Json(json!({ "memories": memories })))
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
    let result = execute(
        &state,
        Operation::Recall {
            agent_id,
            query: request.query,
        },
    )
    .await?;
    Ok(Json(json!({ "memories": result })))
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
    let result = execute(
        &state,
        Operation::Recall {
            agent_id,
            query: text,
        },
    )
    .await?;
    Ok(Json(json!({ "results": result })))
}

async fn sources(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let agent_id = agent(&headers, None, None)?;
    Ok(Json(
        json!({"sources": execute(&state, Operation::ListSources{agent_id}).await?}),
    ))
}
#[derive(Debug, Deserialize)]
struct SourceRequest {
    kind: String,
    name: String,
    #[serde(default)]
    config: Value,
}
async fn create_source(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<SourceRequest>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let agent_id = agent(&headers, None, None)?;
    Ok((
        StatusCode::CREATED,
        Json(
            execute(
                &state,
                Operation::CreateSource {
                    agent_id,
                    kind: req.kind,
                    name: req.name,
                    config: req.config,
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
}
async fn import_document(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<DocumentRequest>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let agent_id = agent(&headers, None, None)?;
    Ok((
        StatusCode::CREATED,
        Json(
            execute(
                &state,
                Operation::IngestDocument {
                    agent_id,
                    source_id: req.source_id,
                    path: req.path,
                    content: req.content,
                    metadata: req.metadata,
                },
            )
            .await?,
        ),
    ))
}

async fn whoami(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<AgentQuery>,
) -> Result<Json<Value>, ApiError> {
    let agent_id = agent(&headers, Some(&query), None)?;
    Ok(Json(
        json!({ "agentId": agent_id, "workspace": state.workspace }),
    ))
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
    let workspace = workspace_path();
    std::fs::create_dir_all(workspace.join("memory"))?;
    let owner = Arc::new(WorkspaceOwner::open(&database_path(&workspace), 256)?);
    let state = AppState {
        owner,
        started_at: now_seconds(),
        dashboard: resolve_dashboard_path(),
        workspace,
    };
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
        .route("/api/pipeline/status", get(status))
        .route("/api/sources", get(sources).post(create_source))
        .route("/api/import/documents", post(import_document))
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
        .fallback(dashboard)
        .with_state(state);
    let listener = tokio::net::TcpListener::bind(address).await?;
    axum::serve(listener, router)
        .with_graceful_shutdown(shutdown_signal())
        .await?;
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
