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
    #[serde(default, alias = "sessionKey")]
    session_key: Option<String>,
    harness: String,
    project: Option<String>,
    content: String,
    idempotency_key: String,
}
fn transcript_input(r: Transcript) -> (String, String, Option<String>, String, String) {
    (
        r.session_key.unwrap_or_default(),
        r.harness,
        r.project,
        r.content,
        r.idempotency_key,
    )
}

async fn create(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<CreateImport>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let agent_id = agent(&headers, None, None)?;
    let result = execute(
        &state,
        Operation::TranscriptImportCreate {
            agent_id,
            schema_id: body.schema_id,
            duplicate_mode: body.duplicate_mode,
            files: Value::Array(body.files),
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
    let (session_key, harness, project, content, idempotency_key) = transcript_input(body);
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
