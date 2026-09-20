use crate::{agent, execute, AgentQuery, ApiError, AppState};
use axum::{
    body::{to_bytes, Body},
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::Response,
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use signet_core_native::Operation;

const MAX: usize = 8 * 1024 * 1024;
fn bounded(value: String, max: usize, field: &str) -> Result<String, ApiError> {
    let v = value.trim().to_owned();
    if v.is_empty() || v.len() > max {
        Err(ApiError::bad_request(format!(
            "{field} must be 1-{max} bytes"
        )))
    } else {
        Ok(v)
    }
}
#[derive(Deserialize)]
struct CreateImport {
    #[serde(default = "default_schema", alias = "schemaId")]
    schema_id: String,
    #[serde(default = "default_mode", alias = "duplicateMode")]
    duplicate_mode: String,
    files: Vec<Value>,
}
fn default_schema() -> String {
    "signet-export".into()
}
fn workspace(headers: &HeaderMap) -> String {
    headers
        .get("x-signet-workspace-id")
        .or_else(|| headers.get("x-workspace-id"))
        .or_else(|| headers.get("x-signet-workspace"))
        .and_then(|v| v.to_str().ok())
        .filter(|v| !v.trim().is_empty())
        .unwrap_or("default")
        .to_owned()
}
fn default_mode() -> String {
    "skip".into()
}
#[derive(Deserialize)]
struct Transcript {
    #[serde(default, alias = "sessionKey", alias = "session_id")]
    session_key: Option<String>,
    harness: String,
    project: Option<String>,
    content: String,
    #[serde(alias = "idempotencyKey")]
    idempotency_key: String,
}
async fn create(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<CreateImport>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let agent_id = agent(&headers, None, None)?;
    let schema_id = bounded(body.schema_id, 128, "schemaId")?;
    let duplicate_mode = bounded(body.duplicate_mode, 32, "duplicateMode")?;
    if schema_id != "signet-export"
        || !matches!(duplicate_mode.as_str(), "skip" | "replace" | "reimport")
    {
        return Err(ApiError::bad_request(
            "unsupported schema or duplicate mode",
        ));
    }
    if body.files.is_empty() || body.files.len() > 25 {
        return Err(ApiError::bad_request("files must contain 1-25 entries"));
    }
    for f in &body.files {
        if f.get("name").and_then(Value::as_str).is_none() {
            return Err(ApiError::bad_request("each file must have a name"));
        }
    }
    Ok((
        StatusCode::CREATED,
        Json(
            execute(
                &state,
                Operation::TranscriptImportCreate {
                    agent_id,
                    workspace_id: workspace(&headers),
                    schema_id,
                    duplicate_mode,
                    files: Value::Array(body.files),
                },
            )
            .await?,
        ),
    ))
}
async fn get_job(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(
        execute(
            &state,
            Operation::TranscriptImportGet {
                agent_id: agent(&headers, None, None)?,
                workspace_id: workspace(&headers),
                id,
            },
        )
        .await?,
    ))
}
async fn list_transcripts(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<AgentQuery>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(json!({
        "transcripts": execute(
            &state,
            Operation::TranscriptList {
                agent_id: agent(&headers, Some(&q), None)?,
                limit: 100,
            },
        )
        .await?,
    })))
}
async fn list_imports(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<AgentQuery>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(json!({
        "imports": execute(
            &state,
            Operation::TranscriptList {
                agent_id: agent(&headers, Some(&q), None)?,
                limit: 100,
            },
        )
        .await?,
    })))
}
async fn file_action(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((job_id, file_id)): Path<(String, String)>,
    body: Body,
    action: &str,
) -> Result<Json<Value>, ApiError> {
    let generation = headers
        .get("upload-generation")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("0")
        .parse()
        .map_err(|_| ApiError::bad_request("invalid upload generation"))?;
    let bytes = to_bytes(body, MAX + 1)
        .await
        .map_err(|_| ApiError::bad_request("invalid body"))?;
    if bytes.len() > MAX {
        return Err(ApiError::bad_request("upload exceeds 8 MiB"));
    }
    let offset = headers
        .get("upload-offset")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse().ok());
    let length = headers
        .get("upload-length")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse().ok());
    Ok(Json(
        execute(
            &state,
            Operation::TranscriptImportFile {
                agent_id: agent(&headers, None, None)?,
                workspace_id: workspace(&headers),
                job_id,
                file_id,
                generation,
                action: action.into(),
                offset,
                length,
                checksum: headers
                    .get("upload-checksum")
                    .and_then(|v| v.to_str().ok())
                    .map(str::to_owned),
                content: bytes.to_vec(),
            },
        )
        .await?,
    ))
}
async fn put(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((job_id, file_id)): Path<(String, String)>,
    body: Body,
) -> Result<Json<Value>, ApiError> {
    file_action(
        State(state),
        headers,
        Path((job_id, file_id)),
        body,
        "begin",
    )
    .await
}
async fn patch(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((job_id, file_id)): Path<(String, String)>,
    body: Body,
) -> Result<Json<Value>, ApiError> {
    file_action(
        State(state),
        headers,
        Path((job_id, file_id)),
        body,
        "append",
    )
    .await
}
async fn finalize(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((job_id, file_id)): Path<(String, String)>,
) -> Result<Json<Value>, ApiError> {
    file_action(
        State(state),
        headers,
        Path((job_id, file_id)),
        Body::empty(),
        "finalize",
    )
    .await
}
async fn reset(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((job_id, file_id)): Path<(String, String)>,
) -> Result<Json<Value>, ApiError> {
    file_action(
        State(state),
        headers,
        Path((job_id, file_id)),
        Body::empty(),
        "reset",
    )
    .await
}
async fn content(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((job_id, file_id)): Path<(String, String)>,
) -> Result<Response, ApiError> {
    let v = file_action(
        State(state),
        headers,
        Path((job_id, file_id)),
        Body::empty(),
        "content",
    )
    .await?
    .0;
    let bytes: Vec<u8> = serde_json::from_value(
        v.get("contentBytes")
            .cloned()
            .unwrap_or(Value::Array(vec![])),
    )
    .map_err(|_| ApiError::internal("invalid stored content"))?;
    Ok(Response::builder()
        .status(StatusCode::OK)
        .header(
            "content-type",
            v.get("contentType")
                .and_then(Value::as_str)
                .unwrap_or("application/octet-stream"),
        )
        .body(bytes.into())
        .unwrap())
}
async fn upsert(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(r): Json<Transcript>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let agent_id = agent(&headers, None, None)?;
    let session_key = bounded(r.session_key.unwrap_or_default(), 256, "sessionKey")?;
    if r.content.is_empty() || r.content.len() > MAX {
        return Err(ApiError::bad_request("invalid or oversized transcript"));
    }
    Ok((
        StatusCode::OK,
        Json(
            execute(
                &state,
                Operation::TranscriptUpsert {
                    agent_id,
                    session_key,
                    harness: bounded(r.harness, 256, "harness")?,
                    project: r.project,
                    idempotency_key: bounded(r.idempotency_key, 256, "idempotencyKey")?,
                    content: r.content,
                },
            )
            .await?,
        ),
    ))
}
async fn control(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(job_id): Path<String>,
    action: &str,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(
        execute(
            &state,
            Operation::TranscriptImportControl {
                agent_id: agent(&headers, None, None)?,
                workspace_id: workspace(&headers),
                job_id,
                action: action.into(),
            },
        )
        .await?,
    ))
}
async fn start(
    State(s): State<AppState>,
    h: HeaderMap,
    p: Path<String>,
) -> Result<Json<Value>, ApiError> {
    control(State(s), h, p, "start").await
}
async fn pause(
    State(s): State<AppState>,
    h: HeaderMap,
    p: Path<String>,
) -> Result<Json<Value>, ApiError> {
    control(State(s), h, p, "pause").await
}
async fn resume(
    State(s): State<AppState>,
    h: HeaderMap,
    p: Path<String>,
) -> Result<Json<Value>, ApiError> {
    control(State(s), h, p, "resume").await
}
async fn retry(
    State(s): State<AppState>,
    h: HeaderMap,
    p: Path<String>,
) -> Result<Json<Value>, ApiError> {
    control(State(s), h, p, "retry").await
}
async fn cancel(
    State(s): State<AppState>,
    h: HeaderMap,
    p: Path<String>,
) -> Result<Json<Value>, ApiError> {
    control(State(s), h, p, "cancel").await
}

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/api/sources/imports", post(create).get(list_imports))
        .route("/api/sources/imports/{id}", get(get_job))
        .route(
            "/api/sources/imports/{job_id}/files/{file_id}",
            axum::routing::put(put).patch(patch),
        )
        .route(
            "/api/sources/imports/{job_id}/files/{file_id}/finalize",
            post(finalize),
        )
        .route(
            "/api/sources/imports/{job_id}/files/{file_id}/reset",
            post(reset),
        )
        .route(
            "/api/sources/imports/{job_id}/files/{file_id}/content",
            get(content),
        )
        .route("/api/sources/imports/{job_id}/start", post(start))
        .route("/api/sources/imports/{job_id}/pause", post(pause))
        .route("/api/sources/imports/{job_id}/resume", post(resume))
        .route("/api/sources/imports/{job_id}/retry", post(retry))
        .route("/api/sources/imports/{job_id}/cancel", post(cancel))
        .route("/api/transcripts", post(upsert).get(list_transcripts))
}
