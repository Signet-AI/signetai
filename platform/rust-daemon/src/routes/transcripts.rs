use crate::{agent, execute, AgentQuery, ApiError, AppState};
use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use signet_core_native::Operation;

const MAX_ID_BYTES: usize = 256;
const MAX_SCHEMA_BYTES: usize = 128;
const MAX_MODE_BYTES: usize = 32;
const MAX_FILE_NAME_BYTES: usize = 512;
const MAX_FILE_BYTES: usize = 8 * 1024 * 1024;
const MAX_TRANSCRIPT_BYTES: usize = 8 * 1024 * 1024;

fn bounded(value: String, max: usize, field: &str) -> Result<String, ApiError> {
    let value = value.trim().to_owned();
    if value.is_empty() || value.len() > max {
        return Err(ApiError::bad_request(format!(
            "{field} must be 1-{max} bytes"
        )));
    }
    Ok(value)
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
fn transcript_input(
    r: Transcript,
) -> Result<(String, String, Option<String>, String, String), ApiError> {
    let session_key = bounded(
        r.session_key.unwrap_or_default(),
        MAX_ID_BYTES,
        "sessionKey",
    )?;
    let harness = bounded(r.harness, MAX_ID_BYTES, "harness")?;
    let project = r
        .project
        .map(|v| bounded(v, MAX_ID_BYTES, "project"))
        .transpose()?;
    if r.content.as_bytes().len() > MAX_TRANSCRIPT_BYTES {
        return Err(ApiError::bad_request("content exceeds 8 MiB"));
    }
    if r.content.is_empty() {
        return Err(ApiError::bad_request("content is required"));
    }
    let idempotency_key = bounded(r.idempotency_key, MAX_ID_BYTES, "idempotencyKey")?;
    Ok((session_key, harness, project, r.content, idempotency_key))
}

async fn create(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<CreateImport>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let agent_id = agent(&headers, None, None)?;
    let schema_id = bounded(body.schema_id, MAX_SCHEMA_BYTES, "schemaId")?;
    let duplicate_mode = bounded(body.duplicate_mode, MAX_MODE_BYTES, "duplicateMode")?;
    if !matches!(duplicate_mode.as_str(), "skip" | "replace" | "reimport") {
        return Err(ApiError::bad_request(
            "duplicateMode must be skip, replace, or reimport",
        ));
    }
    if body.files.is_empty() || body.files.len() > 25 {
        return Err(ApiError::bad_request("files must contain 1-25 entries"));
    }
    let files = Value::Array(body.files);
    let encoded = serde_json::to_vec(&files)
        .map_err(|_| ApiError::bad_request("files must be valid JSON"))?;
    if encoded.len() > MAX_FILE_BYTES {
        return Err(ApiError::bad_request("files exceed 8 MiB"));
    }
    if let Some(items) = files.as_array() {
        for item in items {
            if let Some(name) = item.get("name").and_then(Value::as_str) {
                bounded(name.to_owned(), MAX_FILE_NAME_BYTES, "file name")?;
            }
        }
    }
    let result = execute(
        &state,
        Operation::TranscriptImportCreate {
            agent_id,
            schema_id,
            duplicate_mode,
            files,
        },
    )
    .await?;
    Ok((StatusCode::CREATED, Json(result)))
}
async fn get_job(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let agent_id = agent(&headers, None, None)?;
    Ok(Json(
        execute(&state, Operation::TranscriptImportGet { agent_id, id }).await?,
    ))
}
async fn list(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<AgentQuery>,
) -> Result<Json<Value>, ApiError> {
    let agent_id = agent(&headers, Some(&q), None)?;
    Ok(Json(
        json!({"transcripts":execute(&state,Operation::TranscriptList{agent_id,limit:100}).await?}),
    ))
}
async fn upsert(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Transcript>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let agent_id = agent(&headers, None, None)?;
    let (session_key, harness, project, content, idempotency_key) = transcript_input(body)?;
    let result = execute(
        &state,
        Operation::TranscriptUpsert {
            agent_id,
            session_key,
            harness,
            project,
            content,
            idempotency_key,
        },
    )
    .await?;
    Ok((StatusCode::OK, Json(result)))
}
pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/api/sources/imports", post(create).get(list))
        .route("/api/sources/imports/{id}", get(get_job))
        .route("/api/transcripts", post(upsert).get(list))
}
