//! Current git configuration boundary. Git mutation is intentionally unsupported here.
use crate::{routes::auth, ApiError, AppState};
use axum::{extract::State, http::HeaderMap, routing::get, Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::Value;
#[cfg(unix)]
use std::os::unix::{
    fs::OpenOptionsExt,
    io::{AsRawFd, FromRawFd},
};
use std::{
    fs::{File, OpenOptions},
    io::Read,
    path::Path,
};

pub(crate) const MAX_CONFIG_BYTES: u64 = 64 * 1024;

#[derive(Debug, Serialize)]
pub(crate) struct GitConfigResponse {
    pub enabled: bool,
    #[serde(rename = "autoCommit")]
    pub auto_commit: bool,
    #[serde(rename = "autoSync")]
    pub auto_sync: bool,
    #[serde(rename = "syncInterval")]
    pub sync_interval: u64,
    pub remote: String,
    pub branch: String,
}

#[derive(Debug, Deserialize)]
struct GitConfigPatch {
    enabled: Option<bool>,
    #[serde(rename = "autoCommit")]
    auto_commit: Option<bool>,
    #[serde(rename = "autoSync")]
    auto_sync: Option<bool>,
    #[serde(rename = "syncInterval")]
    sync_interval: Option<u64>,
    remote: Option<String>,
    branch: Option<String>,
}

pub(crate) fn router() -> Router<AppState> {
    Router::new().route("/api/git/config", get(config).post(update_config))
}

/// Admit the workspace once, before the router is made available. Every request
/// then reads relative to this retained descriptor rather than a replaceable path.
pub(crate) fn admit_config_dir(workspace: &Path) -> Result<std::sync::Arc<File>, String> {
    let root = std::fs::canonicalize(workspace)
        .map_err(|_| "workspace is not a safe directory".to_owned())?;
    open_config_dir(&root).map(std::sync::Arc::new)
}

async fn authorize(state: &AppState, headers: &HeaderMap) -> Result<(), ApiError> {
    let claims = auth::gate(state, headers).await?;
    let admin = claims.get("role").and_then(Value::as_str) == Some("admin");
    let permitted = claims
        .get("permissions")
        .and_then(Value::as_array)
        .is_some_and(|items| {
            items.iter().any(|item| {
                matches!(
                    item.as_str(),
                    Some("admin") | Some("git:read") | Some("git:write")
                )
            })
        });
    if !admin && !permitted {
        return Err(ApiError {
            status: axum::http::StatusCode::FORBIDDEN,
            code: "forbidden",
            message: "git administration capability is required".into(),
        });
    }
    Ok(())
}

async fn config(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<GitConfigResponse>, ApiError> {
    authorize(&state, &headers).await?;
    let mut result = GitConfigResponse {
        enabled: true,
        auto_commit: false,
        auto_sync: false,
        sync_interval: 300,
        remote: "origin".into(),
        branch: "main".into(),
    };
    let dir = state.config_dir.as_ref().map_err(|_| {
        ApiError::unavailable("git configuration workspace cannot be safely opened")
    })?;
    if let Some(content) = read_config_file(dir)? {
        parse_config(&content, &mut result);
    }
    Ok(Json(result))
}

#[cfg(unix)]
fn open_config_dir(root: &Path) -> Result<File, String> {
    let mut options = OpenOptions::new();
    options
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC);
    options
        .open(root)
        .map_err(|_| "workspace is not a safe directory".into())
}

#[cfg(not(unix))]
fn open_config_dir(_root: &Path) -> Result<File, String> {
    Err("safe descriptor-anchored workspace reads are unsupported on this platform".into())
}

#[cfg(unix)]
fn read_config_file(dir: &File) -> Result<Option<String>, ApiError> {
    let name = std::ffi::CString::new("agent.yaml").unwrap();
    let fd = unsafe {
        libc::openat(
            dir.as_raw_fd(),
            name.as_ptr(),
            libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return match std::io::Error::last_os_error().kind() {
            std::io::ErrorKind::NotFound => Ok(None),
            _ => Err(ApiError::bad_request(
                "git configuration path must be a regular file",
            )),
        };
    }
    let file = unsafe { File::from_raw_fd(fd) };
    read_open_config_file(file)
}

#[cfg(not(unix))]
fn read_config_file(_dir: &File) -> Result<Option<String>, ApiError> {
    Err(ApiError::unavailable(
        "safe descriptor-anchored config reads are unsupported on this platform",
    ))
}

#[cfg(unix)]
fn read_open_config_file(mut file: File) -> Result<Option<String>, ApiError> {
    let meta = file
        .metadata()
        .map_err(|_| ApiError::unavailable("git configuration could not be read"))?;
    if !meta.is_file() {
        return Err(ApiError::bad_request(
            "git configuration path must be a regular file",
        ));
    }
    if meta.len() > MAX_CONFIG_BYTES {
        return Err(ApiError::bad_request(
            "git configuration exceeds the size limit",
        ));
    }
    let capacity = meta.len().min(MAX_CONFIG_BYTES) as usize;
    let mut content = String::with_capacity(capacity);
    file.by_ref()
        .take(MAX_CONFIG_BYTES)
        .read_to_string(&mut content)
        .map_err(|_| ApiError::unavailable("git configuration could not be read"))?;
    let mut extra = [0u8; 1];
    if file
        .read(&mut extra)
        .map_err(|_| ApiError::unavailable("git configuration could not be read"))?
        != 0
    {
        return Err(ApiError::bad_request(
            "git configuration exceeds the size limit",
        ));
    }
    Ok(Some(content))
}

async fn update_config(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(patch): Json<GitConfigPatch>,
) -> Result<Json<Value>, ApiError> {
    authorize(&state, &headers).await?;
    let GitConfigPatch {
        enabled,
        auto_commit,
        auto_sync,
        sync_interval,
        remote,
        branch,
    } = patch;
    let _ = (
        state,
        enabled,
        auto_commit,
        auto_sync,
        sync_interval,
        remote,
        branch,
    );
    Err(ApiError::not_implemented("git-config-update: runtime git configuration persistence and timer lifecycle are not implemented natively"))
}

fn parse_config(content: &str, result: &mut GitConfigResponse) {
    let mut in_git = false;
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed == "git:" {
            in_git = true;
            continue;
        }
        if in_git && !line.starts_with(' ') && !line.starts_with('\t') {
            in_git = false;
        }
        if !in_git {
            continue;
        }
        let Some((key, raw)) = trimmed.split_once(':') else {
            continue;
        };
        let value = raw.trim().trim_matches(['"', '\'']);
        match key {
            "enabled" => result.enabled = value == "true",
            "autoCommit" => result.auto_commit = value == "true",
            "autoSync" => result.auto_sync = value == "true",
            "syncInterval" => {
                if let Ok(v) = value.parse::<u64>() {
                    result.sync_interval = v.clamp(60, 86400);
                }
            }
            "remote" if !value.is_empty() => result.remote = value.into(),
            "branch" if !value.is_empty() => result.branch = value.into(),
            _ => {}
        }
    }
}

#[allow(dead_code)]
fn _path_is_workspace_relative(workspace: &Path, path: &Path) -> bool {
    path.strip_prefix(workspace).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use std::{
        fs,
        time::{SystemTime, UNIX_EPOCH},
    };
    #[test]
    fn config_parser_clamps_interval_and_keeps_defaults() {
        let mut c = GitConfigResponse {
            enabled: true,
            auto_commit: false,
            auto_sync: false,
            sync_interval: 300,
            remote: "origin".into(),
            branch: "main".into(),
        };
        parse_config("git:\n  syncInterval: 1\n  autoSync: true\n", &mut c);
        assert_eq!(c.sync_interval, 60);
        assert!(c.auto_sync);
    }

    #[cfg(unix)]
    fn temp_dir(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "signet-git-sync-{name}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    #[cfg(unix)]
    #[test]
    fn admitted_directory_survives_workspace_replacement() {
        let original = temp_dir("replacement");
        let replacement = temp_dir("replacement-new");
        fs::create_dir(&original).unwrap();
        fs::create_dir(&replacement).unwrap();
        let dir = admit_config_dir(&original).unwrap();
        fs::remove_dir(&original).unwrap();
        fs::write(
            replacement.join("agent.yaml"),
            "git:\n  remote: replacement\n",
        )
        .unwrap();
        assert!(matches!(read_config_file(&dir), Ok(None)));
        fs::remove_dir_all(replacement).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn oversized_config_is_rejected() {
        let root = temp_dir("oversize");
        fs::create_dir(&root).unwrap();
        fs::write(
            root.join("agent.yaml"),
            vec![b'x'; MAX_CONFIG_BYTES as usize + 1],
        )
        .unwrap();
        let dir = admit_config_dir(&root).unwrap();
        let error = read_config_file(&dir).unwrap_err();
        assert_eq!(error.status, axum::http::StatusCode::BAD_REQUEST);
        fs::remove_dir_all(root).unwrap();
    }
}
