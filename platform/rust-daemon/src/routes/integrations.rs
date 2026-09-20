//! Bounded routes for the configuration and integration surfaces used by current clients.
//!
//! This module deliberately keeps connector/network work out of the SQLite owner.  A
//! connector is reported as configured/unknown until a real provider-specific probe exists;
//! configuration is never presented as external health.

use axum::{
    extract::State,
    http::StatusCode,
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{fs::OpenOptions, time::Duration};
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
        .route(
            "/api/connectors",
            get(connectors).post(unsupported_connector_registration),
        )
        .route("/api/integrations", get(integrations))
        .route(
            "/api/harnesses/regenerate",
            post(unsupported_harness_regeneration),
        )
        .route("/api/harnesses", get(harnesses))
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
        let metadata = match bounded(fs::symlink_metadata(&path)).await {
            Ok(metadata) if metadata.is_file() => metadata,
            Ok(_) | Err(_) => continue,
        };
        if metadata.len() > MAX_CONFIG_FILE_BYTES {
            return Err(ApiError::internal(format!(
                "configuration file {name} exceeds size limit"
            )));
        }
        let content = bounded(read_utf8_no_follow(path)).await.map_err(|_| {
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
    bounded(write_new_file(&temporary, request.content.as_bytes()))
        .await
        .map_err(|_| ApiError::unavailable("configuration file could not be written"))?;
    if let Err(error) = fs::rename(&temporary, &path).await {
        let _ = fs::remove_file(&temporary).await;
        return Err(ApiError::unavailable(format!(
            "configuration file could not be committed: {error}"
        )));
    }
    bounded(sync_directory(&state.workspace))
        .await
        .map_err(|_| ApiError::unavailable("configuration directory could not be synchronized"))?;
    Ok(Json(
        json!({ "name": request.file, "size": request.content.len() }),
    ))
}

async fn unsupported_connector_registration() -> (StatusCode, Json<Value>) {
    (
        StatusCode::NOT_IMPLEMENTED,
        Json(json!({
            "status": "unsupported",
            "operation": "connector-registration",
            "implemented": false,
            "probed": false,
            "reason": "Native connector registration requires provider-specific storage and authorization"
        })),
    )
}

async fn unsupported_harness_regeneration() -> (StatusCode, Json<Value>) {
    (
        StatusCode::NOT_IMPLEMENTED,
        Json(json!({
            "status": "unsupported",
            "operation": "harness-regeneration",
            "implemented": false,
            "probed": false,
            "reason": "Native harness regeneration cannot execute external scripts"
        })),
    )
}

async fn harnesses() -> Json<Value> {
    Json(json!({
        "harnesses": [],
        "configuredHarnesses": [],
        "status": "unsupported",
        "implemented": false,
        "probed": false,
        "reason": "Native harness discovery requires provider-specific configuration"
    }))
}

async fn connectors() -> Json<Value> {
    Json(json!({
        "connectors": [{
            "name": "native",
            "implemented": false,
            "configured": "unknown",
            "detected": "unknown",
            "probed": false,
            "status": "unsupported",
            "reason": "No native connector provider is implemented at this boundary"
        }],
        "count": 1,
        "status": "unknown",
        "probed": false,
        "note": "Provider health is not asserted without an implemented probe."
    }))
}

async fn integrations() -> Json<Value> {
    Json(json!({
        "integrations": [{
            "name": "external-providers",
            "implemented": false,
            "configured": "unknown",
            "detected": "unknown",
            "probed": false,
            "status": "unsupported",
            "reason": "No external integration probe is implemented at this boundary"
        }],
        "status": "unknown",
        "probed": false,
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
        "connectors": { "status": "unknown", "probed": false, "implemented": false },
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

async fn read_utf8_no_follow(path: std::path::PathBuf) -> std::io::Result<String> {
    tokio::task::spawn_blocking(move || {
        let mut file = open_read_no_follow(&path)?;
        let mut content = String::new();
        std::io::Read::read_to_string(&mut file, &mut content)?;
        Ok(content)
    })
    .await
    .map_err(std::io::Error::other)?
}

async fn write_new_file(path: &std::path::Path, content: &[u8]) -> std::io::Result<()> {
    let path = path.to_owned();
    let content = content.to_owned();
    tokio::task::spawn_blocking(move || {
        use std::io::Write;
        let mut file = open_new_file_no_follow(&path)?;
        file.write_all(&content)?;
        file.sync_all()
    })
    .await
    .map_err(std::io::Error::other)?
}

async fn sync_directory(path: &std::path::Path) -> std::io::Result<()> {
    let path = path.to_owned();
    tokio::task::spawn_blocking(move || std::fs::File::open(path)?.sync_all())
        .await
        .map_err(std::io::Error::other)?
}

#[cfg(unix)]
fn open_read_no_follow(path: &std::path::Path) -> std::io::Result<std::fs::File> {
    use std::os::unix::fs::OpenOptionsExt;

    OpenOptions::new()
        .read(true)
        .custom_flags(0o400000)
        .open(path)
}

#[cfg(not(unix))]
fn open_read_no_follow(_path: &std::path::Path) -> std::io::Result<std::fs::File> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "safe no-follow configuration reads are unavailable on this platform",
    ))
}

#[cfg(unix)]
fn open_new_file_no_follow(path: &std::path::Path) -> std::io::Result<std::fs::File> {
    use std::os::unix::fs::OpenOptionsExt;

    OpenOptions::new()
        .write(true)
        .create_new(true)
        .custom_flags(0o400000)
        .open(path)
}

#[cfg(not(unix))]
fn open_new_file_no_follow(_path: &std::path::Path) -> std::io::Result<std::fs::File> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "safe no-follow configuration writes are unavailable on this platform",
    ))
}

#[cfg(all(test, not(unix)))]
mod platform_contract_tests {
    use super::{open_new_file_no_follow, open_read_no_follow};
    use std::io::ErrorKind;

    #[test]
    fn configuration_io_fails_closed_without_no_follow_support() {
        assert_eq!(
            open_read_no_follow(std::path::Path::new("config.yaml"))
                .unwrap_err()
                .kind(),
            ErrorKind::Unsupported
        );
        assert_eq!(
            open_new_file_no_follow(std::path::Path::new("config.yaml"))
                .unwrap_err()
                .kind(),
            ErrorKind::Unsupported
        );
    }
}
