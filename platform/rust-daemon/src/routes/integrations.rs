//! Bounded routes for the configuration and integration surfaces used by current clients.
//!
//! This module deliberately keeps connector/network work out of the SQLite owner.  A
//! connector is reported as configured/unknown until a real provider-specific probe exists;
//! configuration is never presented as external health.

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
#[cfg(unix)]
use std::{
    ffi::CString,
    io::{self, Read, Write},
    os::fd::{AsRawFd, FromRawFd},
    sync::atomic::{AtomicU64, Ordering},
};
use std::{fs::File, sync::Arc, time::Duration};

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
        .route("/api/connectors", get(connectors).post(register_connector))
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
    let mut files = Vec::new();
    for name in CONFIG_NAMES {
        if let Some((content, size)) = read_config_file(&state, name).await? {
            files.push(json!({ "name": name, "content": content, "size": size }));
        }
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
    let root = config_root(&state)?;
    let name = request.file;
    let content = request.content;
    let size = content.len();
    let (name, size) = blocking_config(move || {
        write_config_at(&root, &name, &content)?;
        Ok((name, size))
    })
    .await?;
    Ok(Json(json!({ "name": name, "size": size })))
}

#[derive(Debug, Deserialize)]
struct ConnectorRegistration {
    provider: Option<String>,
    #[serde(default, rename = "displayName")]
    display_name: Option<String>,
    #[serde(default)]
    settings: Value,
}

async fn register_connector(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Result<Json<ConnectorRegistration>, axum::extract::rejection::JsonRejection>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let claims = crate::routes::auth::gate(&state, &headers).await?;
    if claims.get("role").and_then(Value::as_str) != Some("admin")
        || claims.get("permissions").is_some_and(|permissions| {
            !permissions.as_array().is_some_and(|permissions| {
                permissions
                    .iter()
                    .any(|permission| permission.as_str() == Some("admin"))
            })
        })
    {
        return Err(ApiError::forbidden("admin authority is required"));
    }
    let Json(request) = body.map_err(|_| ApiError::bad_request("Invalid JSON body"))?;
    let provider = request.provider.ok_or_else(|| {
        ApiError::bad_request("provider must be filesystem, github-docs, or gdrive")
    })?;
    if !["filesystem", "github-docs", "gdrive"].contains(&provider.as_str()) {
        return Err(ApiError::bad_request(
            "provider must be filesystem, github-docs, or gdrive",
        ));
    }
    let agent_id = crate::agent(&headers, None, None)?;
    let workspace_id = crate::source_workspace(&headers, None)?;
    let value = execute(
        &state,
        Operation::ConnectorUpsert {
            agent_id,
            workspace_id,
            provider: provider.clone(),
            display_name: request.display_name.unwrap_or(provider),
            settings: request.settings,
        },
    )
    .await?;
    Ok((StatusCode::CREATED, Json(value)))
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

async fn harnesses(State(state): State<AppState>) -> Json<Value> {
    let configured = match read_config_file(&state, "agent.yaml").await {
        Ok(Some((content, _))) => parse_harnesses(&content),
        _ => Vec::new(),
    };
    let connectors: Vec<Value> = configured
        .iter()
        .map(|name| {
            json!({
                "id": name,
                "displayName": name,
                "icon": Value::Null,
                "configPath": Value::Null,
                "detected": false,
                "lastSeen": Value::Null,
                "available": false,
                "health": { "status": "unavailable", "message": "Harness probing is unavailable in the native boundary" },
                "capabilities": { "connect": false, "repair": false, "reinitialize": false }
            })
        })
        .collect();
    let harnesses: Vec<Value> = connectors
        .iter()
        .map(|connector| {
            json!({
                "name": connector.get("displayName").and_then(Value::as_str).unwrap_or_default(),
                "id": connector.get("id").cloned().unwrap_or(Value::Null),
                "icon": connector.get("icon").cloned().unwrap_or(Value::Null),
                "path": connector.get("configPath").and_then(Value::as_str).unwrap_or_default(),
                "exists": connector.get("detected").and_then(Value::as_bool).unwrap_or(false),
                "lastSeen": connector.get("lastSeen").cloned().unwrap_or(Value::Null)
            })
        })
        .collect();
    Json(
        json!({ "harnesses": harnesses, "connectors": connectors, "configuredHarnesses": configured }),
    )
}

fn parse_harnesses(content: &str) -> Vec<String> {
    let mut values = Vec::new();
    let mut in_list = false;
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed == "harnesses:" {
            in_list = true;
            continue;
        }
        if !in_list {
            continue;
        }
        if let Some(value) = trimmed.strip_prefix("- ") {
            let value = value.trim();
            if !value.is_empty() && value.len() <= 256 {
                values.push(value.to_owned());
            }
        } else if !trimmed.is_empty() && !line.starts_with(' ') && !line.starts_with('\t') {
            break;
        }
    }
    values
}

async fn connectors(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let agent_id = crate::agent(&headers, None, None)?;
    let workspace_id = crate::source_workspace(&headers, None)?;
    let value = execute(
        &state,
        Operation::ConnectorList {
            agent_id,
            workspace_id,
        },
    )
    .await?;
    Ok(Json(value))
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

fn config_root(state: &AppState) -> Result<Arc<File>, ApiError> {
    state
        .config_dir
        .as_ref()
        .map(Arc::clone)
        .map_err(|_| ApiError::unavailable("safe configuration directory is unavailable"))
}

async fn read_config_file(
    state: &AppState,
    name: &'static str,
) -> Result<Option<(String, u64)>, ApiError> {
    let root = config_root(state)?;
    blocking_config(move || read_config_at(&root, name)).await
}

async fn blocking_config<T, F>(operation: F) -> Result<T, ApiError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, ApiError> + Send + 'static,
{
    match tokio::time::timeout(IO_TIMEOUT, tokio::task::spawn_blocking(operation)).await {
        Err(_) => Err(ApiError::unavailable(
            "configuration file operation timed out",
        )),
        Ok(Err(_)) => Err(ApiError::unavailable("configuration file operation failed")),
        Ok(Ok(result)) => result,
    }
}

#[cfg(unix)]
fn read_config_at(root: &File, name: &str) -> Result<Option<(String, u64)>, ApiError> {
    let name = CString::new(name)
        .map_err(|_| ApiError::bad_request("configuration filename is invalid"))?;
    let mut file = match open_config_at(root, &name, libc::O_RDONLY | libc::O_NONBLOCK, 0) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error)
            if matches!(
                error.raw_os_error(),
                Some(libc::ELOOP) | Some(libc::ENOTDIR)
            ) =>
        {
            return Ok(None);
        }
        Err(_) => {
            return Err(ApiError::unavailable(
                "configuration file could not be read",
            ))
        }
    };
    let metadata = file
        .metadata()
        .map_err(|_| ApiError::unavailable("configuration file could not be read"))?;
    if !metadata.is_file() {
        return Ok(None);
    }
    if metadata.len() > MAX_CONFIG_FILE_BYTES {
        return Err(ApiError::internal("configuration file exceeds size limit"));
    }
    let mut content = String::new();
    (&mut file)
        .take(MAX_CONFIG_FILE_BYTES + 1)
        .read_to_string(&mut content)
        .map_err(|_| ApiError::unavailable("configuration file could not be read"))?;
    let size = u64::try_from(content.len())
        .map_err(|_| ApiError::internal("configuration file size is not representable"))?;
    if size > MAX_CONFIG_FILE_BYTES {
        return Err(ApiError::internal("configuration file exceeds size limit"));
    }
    Ok(Some((content, size)))
}

#[cfg(not(unix))]
fn read_config_at(_root: &File, _name: &str) -> Result<Option<(String, u64)>, ApiError> {
    Err(ApiError::not_implemented(
        "descriptor-anchored configuration reads are unsupported on this platform",
    ))
}

#[cfg(unix)]
fn write_config_at(root: &File, name: &str, content: &str) -> Result<(), ApiError> {
    let target = CString::new(name)
        .map_err(|_| ApiError::bad_request("configuration filename is invalid"))?;
    let mut metadata = std::mem::MaybeUninit::<libc::stat>::uninit();
    let inspection = unsafe {
        libc::fstatat(
            root.as_raw_fd(),
            target.as_ptr(),
            metadata.as_mut_ptr(),
            libc::AT_SYMLINK_NOFOLLOW,
        )
    };
    if inspection == 0 {
        let metadata = unsafe { metadata.assume_init() };
        if metadata.st_mode & libc::S_IFMT != libc::S_IFREG {
            return Err(ApiError::bad_request(
                "configuration target is not a regular file",
            ));
        }
    } else {
        let error = io::Error::last_os_error();
        if error.kind() != io::ErrorKind::NotFound {
            return Err(
                if matches!(
                    error.raw_os_error(),
                    Some(libc::ELOOP) | Some(libc::ENOTDIR)
                ) {
                    ApiError::bad_request("configuration target is not a regular file")
                } else {
                    ApiError::unavailable("configuration target could not be inspected")
                },
            );
        }
    }

    static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);
    let mut temporary = None;
    for _ in 0..16 {
        let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let name = CString::new(format!(".{name}.tmp-{}-{sequence}", std::process::id()))
            .map_err(|_| ApiError::internal("configuration temporary filename is invalid"))?;
        match open_config_at(
            root,
            &name,
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NONBLOCK,
            0o666,
        ) {
            Ok(file) => {
                temporary = Some((name, file));
                break;
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(_) => {
                return Err(ApiError::unavailable(
                    "configuration file could not be written",
                ))
            }
        }
    }
    let Some((temporary_name, mut file)) = temporary else {
        return Err(ApiError::unavailable(
            "configuration temporary file could not be created",
        ));
    };
    if file
        .write_all(content.as_bytes())
        .and_then(|()| file.sync_all())
        .is_err()
    {
        let _ = unsafe { libc::unlinkat(root.as_raw_fd(), temporary_name.as_ptr(), 0) };
        return Err(ApiError::unavailable(
            "configuration file could not be written",
        ));
    }
    drop(file);
    if unsafe {
        libc::renameat(
            root.as_raw_fd(),
            temporary_name.as_ptr(),
            root.as_raw_fd(),
            target.as_ptr(),
        )
    } != 0
    {
        let _ = unsafe { libc::unlinkat(root.as_raw_fd(), temporary_name.as_ptr(), 0) };
        return Err(ApiError::unavailable(
            "configuration file could not be committed",
        ));
    }
    if unsafe { libc::fsync(root.as_raw_fd()) } != 0 {
        return Err(ApiError::unavailable(
            "configuration directory could not be synchronized",
        ));
    }
    Ok(())
}

#[cfg(not(unix))]
fn write_config_at(_root: &File, _name: &str, _content: &str) -> Result<(), ApiError> {
    Err(ApiError::not_implemented(
        "descriptor-anchored configuration writes are unsupported on this platform",
    ))
}

#[cfg(unix)]
fn open_config_at(
    root: &File,
    name: &CString,
    flags: libc::c_int,
    mode: libc::mode_t,
) -> io::Result<File> {
    let descriptor = unsafe {
        libc::openat(
            root.as_raw_fd(),
            name.as_ptr(),
            flags | libc::O_CLOEXEC | libc::O_NOFOLLOW,
            mode,
        )
    };
    if descriptor < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(unsafe { File::from_raw_fd(descriptor) })
    }
}
