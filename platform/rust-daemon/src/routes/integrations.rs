//! Bounded routes for the configuration and integration surfaces used by current clients.
//!
//! This module deliberately keeps connector/network work out of the SQLite owner.  A
//! connector is reported as configured/unknown until a real provider-specific probe exists;
//! configuration is never presented as external health.

use axum::{extract::State, routing::get, Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::Duration;
use tokio::fs;

use crate::{execute, ApiError, AppState};
use signet_core_native::Operation;

const IO_TIMEOUT: Duration = Duration::from_secs(2);
const MAX_CONFIG_FILE_BYTES: u64 = 1_048_576;
const CONFIG_NAMES: &[&str] = &[
    "agent.yaml",
    "config.yaml",
    "AGENTS.md",
    "SOUL.md",
    "IDENTITY.md",
    "USER.md",
    "HEARTBEAT.md",
    "TOOLS.md",
    "BOOTSTRAP.md",
    "DREAMING.md",
];

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/features", get(features))
        .route("/api/config", get(config).post(write_config))
        .route("/api/connectors", get(connectors))
        .route("/api/integrations", get(integrations))
        .route("/health/integrations", get(integration_health))
}

async fn features() -> Json<Value> {
    Json(json!({
        "features": {
            "memory": true,
            "sources": true,
            "connectors": true,
            "configuration": true,
            "providerProbes": false
        },
        "runtime": "rust",
        "implementation": "fresh"
    }))
}

#[derive(Debug, Deserialize)]
struct ConfigWriteRequest {
    file: String,
    content: String,
}

async fn config(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let directory = state.workspace.clone();
    let mut files = Vec::new();
    for name in CONFIG_NAMES {
        let path = directory.join(name);
        let metadata = match bounded(fs::metadata(&path)).await {
            Ok(metadata) if metadata.is_file() => metadata,
            Ok(_) | Err(_) => continue,
        };
        if metadata.len() > MAX_CONFIG_FILE_BYTES {
            return Err(ApiError::internal(format!(
                "configuration file {name} exceeds size limit"
            )));
        }
        let content = bounded(fs::read_to_string(&path)).await.map_err(|_| {
            ApiError::unavailable(format!("configuration file {name} could not be read"))
        })?;
        files.push(json!({ "name": name, "content": content, "size": metadata.len() }));
    }
    Ok(Json(json!({ "files": files })))
}

async fn write_config(
    State(state): State<AppState>,
    Json(request): Json<ConfigWriteRequest>,
) -> Result<Json<Value>, ApiError> {
    if request.content.len() > MAX_CONFIG_FILE_BYTES as usize {
        return Err(ApiError::bad_request(
            "configuration content exceeds the size limit",
        ));
    }
    if !CONFIG_NAMES.contains(&request.file.as_str()) {
        return Err(ApiError::bad_request("configuration file is not writable"));
    }
    let path = state.workspace.join(&request.file);
    if let Ok(metadata) = fs::symlink_metadata(&path).await {
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(ApiError::bad_request(
                "configuration target is not a regular file",
            ));
        }
    }
    let temporary = state
        .workspace
        .join(format!(".{}.tmp-{}", request.file, std::process::id()));
    bounded(fs::write(&temporary, request.content.as_bytes()))
        .await
        .map_err(|_| ApiError::unavailable("configuration file could not be written"))?;
    if let Err(error) = fs::rename(&temporary, &path).await {
        let _ = fs::remove_file(&temporary).await;
        return Err(ApiError::unavailable(format!(
            "configuration file could not be committed: {error}"
        )));
    }
    Ok(Json(
        json!({ "name": request.file, "size": request.content.len() }),
    ))
}

async fn connectors() -> Json<Value> {
    Json(json!({
        "connectors": [],
        "count": 0,
        "status": "unknown",
        "note": "No connector registry is available in the native route surface; external health is not asserted."
    }))
}

async fn integrations() -> Json<Value> {
    Json(json!({
        "integrations": [],
        "status": "unknown",
        "note": "No external integration probe was requested or performed."
    }))
}

async fn integration_health(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let database = execute(&state, Operation::Health).await?;
    let ready = database
        .get("ready")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    Ok(Json(json!({
        "status": if ready { "degraded" } else { "unavailable" },
        "database": { "status": if ready { "healthy" } else { "unavailable" }, "ready": ready },
        "connectors": { "status": "unknown", "probed": false },
        "external": { "status": "unknown", "probed": false },
        "note": "External connector health requires a real provider probe."
    })))
}

async fn bounded<F, T>(operation: F) -> Result<T, String>
where
    F: std::future::Future<Output = std::io::Result<T>>,
{
    tokio::time::timeout(IO_TIMEOUT, operation)
        .await
        .map_err(|_| "operation timed out".to_owned())?
        .map_err(|error| error.to_string())
}
