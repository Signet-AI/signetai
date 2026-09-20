use crate::{routes::auth, AppState};
use axum::{
    extract::{Json, State},
    http::HeaderMap,
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
    Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    fs::{rename, File, OpenOptions},
    io::{Read, Write},
    os::unix::{
        fs::{MetadataExt, OpenOptionsExt},
        io::AsRawFd,
    },
    path::Path,
};

const MAX_BODY: usize = 64 * 1024;
const MIN_INTERVAL: u64 = 300;
const MAX_INTERVAL: u64 = 604800;
const DEFAULT_INTERVAL: u64 = 21600;

#[derive(Clone, Debug, Deserialize)]
struct ConfigRequest {
    #[serde(alias = "autoInstall", alias = "auto_install")]
    auto_install: Option<Value>,
    #[serde(alias = "checkInterval", alias = "check_interval")]
    check_interval: Option<Value>,
    channel: Option<String>,
}

#[derive(Clone, Debug)]
struct Config {
    auto_install: bool,
    check_interval: u64,
    channel: &'static str,
}

fn open_workspace(workspace: &Path) -> Option<File> {
    let mut options = OpenOptions::new();
    options
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC);
    let file = options.open(workspace).ok()?;
    file.metadata().ok()?.file_type().is_dir().then_some(file)
}

fn open_config(workspace: &Path) -> Option<File> {
    let _dir = open_workspace(workspace)?;
    let mut options = OpenOptions::new();
    options
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    let file = options.open(workspace.join("agent.yaml")).ok()?;
    let metadata = file.metadata().ok()?;
    (metadata.file_type().is_file() && metadata.len() <= MAX_BODY as u64).then_some(file)
}

fn read_config(workspace: &Path) -> Option<String> {
    let mut file = open_config(workspace)?;
    let metadata = file.metadata().ok()?;
    let mut text = String::with_capacity(metadata.len() as usize);
    (&mut file)
        .take(MAX_BODY as u64 + 1)
        .read_to_string(&mut text)
        .ok()?;
    let after = file.metadata().ok()?;
    ((metadata.dev(), metadata.ino()) == (after.dev(), after.ino()) && text.len() <= MAX_BODY)
        .then_some(text)
}

fn parse_config(workspace: &Path) -> Config {
    let mut config = Config {
        auto_install: false,
        check_interval: DEFAULT_INTERVAL,
        channel: "stable",
    };
    let Some(text) = read_config(workspace) else {
        return config;
    };
    let mut in_section = false;
    for line in text.lines() {
        let indent = line.len() - line.trim_start().len();
        let trimmed = line.trim();
        if indent == 0 && (trimmed == "updates:" || trimmed == "update:") {
            in_section = true;
            continue;
        }
        if in_section && (trimmed.is_empty() || indent == 0) {
            in_section = false;
        }
        if !in_section || !(indent == 2 || trimmed.is_empty()) {
            continue;
        }
        let Some((key, value)) = trimmed.split_once(':') else {
            continue;
        };
        let value = value.split_once('#').map_or(value, |(v, _)| v).trim();
        match key {
            "auto_install" | "autoInstall" if value == "true" || value == "false" => {
                config.auto_install = value == "true"
            }
            "check_interval" | "checkInterval" => {
                if let Ok(v) = value.parse() {
                    if (MIN_INTERVAL..=MAX_INTERVAL).contains(&v) {
                        config.check_interval = v;
                    }
                }
            }
            "channel" if value == "stable" || value == "latest" => config.channel = "stable",
            "channel" if value == "nightly" || value == "next" => config.channel = "nightly",
            _ => {}
        }
    }
    config
}

fn replace_section(current: &str, section: &str) -> Option<String> {
    let mut lines = Vec::new();
    let mut skipping = false;
    for line in current.lines() {
        let indent = line.len() - line.trim_start().len();
        let trimmed = line.trim();
        if trimmed == "updates:" || trimmed == "update:" {
            if indent != 0 {
                return None;
            }
            skipping = true;
            continue;
        }
        if skipping && !trimmed.is_empty() && indent == 0 {
            skipping = false;
        }
        if skipping && !trimmed.is_empty() && indent != 2 {
            return None;
        }
        if !skipping {
            lines.push(line);
        }
    }
    let base = lines.join("\n");
    Some(if base.trim().is_empty() {
        section.to_owned()
    } else {
        format!("{}\n\n{}", base.trim_end(), section)
    })
}

fn persist(workspace: &Path, config: &Config) -> bool {
    let dir = match open_workspace(workspace) {
        Some(v) => v,
        None => return false,
    };
    let path = workspace.join("agent.yaml");
    let current_file = match open_config(workspace) {
        Some(v) => Some(v),
        None if std::fs::symlink_metadata(&path).is_err() => None,
        None => return false,
    };
    let metadata = current_file.as_ref().and_then(|f| f.metadata().ok());
    let mut current = String::new();
    if let Some(mut current_file) = current_file {
        if (&mut current_file)
            .take(MAX_BODY as u64 + 1)
            .read_to_string(&mut current)
            .is_err()
            || current.len() > MAX_BODY
        {
            return false;
        }
        let after = match current_file.metadata() {
            Ok(v) => v,
            Err(_) => return false,
        };
        if metadata
            .as_ref()
            .map(|m| (m.dev(), m.ino()) != (after.dev(), after.ino()))
            .unwrap_or(true)
        {
            return false;
        }
    }
    let section = format!(
        "updates:\n  auto_install: {}\n  check_interval: {}\n  channel: {}\n",
        config.auto_install, config.check_interval, config.channel
    );
    let Some(output) = replace_section(&current, &section) else {
        return false;
    };
    if output.len() > MAX_BODY {
        return false;
    }
    let mut temp = None;
    for n in 0..32u32 {
        let candidate = workspace.join(format!(".agent.yaml.tmp.{}.{}", std::process::id(), n));
        let mut options = OpenOptions::new();
        options
            .write(true)
            .create_new(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
        if let Ok(file) = options.open(&candidate) {
            temp = Some((candidate, file));
            break;
        }
    }
    let Some((tmp_path, mut file)) = temp else {
        return false;
    };
    let ok = file.write_all(output.as_bytes()).is_ok()
        && file.sync_all().is_ok()
        && {
            let latest = open_config(workspace).and_then(|f| f.metadata().ok());
            match (metadata.as_ref(), latest) {
                (None, None) | (None, Some(_)) => true,
                (Some(old), Some(new)) => (old.dev(), old.ino()) == (new.dev(), new.ino()),
                _ => false,
            }
        }
        && rename(&tmp_path, &path).is_ok()
        && unsafe { libc::fsync(dir.as_raw_fd()) == 0 };
    if !ok {
        let _ = std::fs::remove_file(&tmp_path);
    }
    ok
}

fn config_json(config: &Config) -> Value {
    json!({ "autoInstall": config.auto_install, "checkInterval": config.check_interval, "channel": config.channel, "minInterval": MIN_INTERVAL, "maxInterval": MAX_INTERVAL, "pendingRestartVersion": null, "lastAutoUpdateAt": null, "lastAutoUpdateError": null, "updateInProgress": false })
}

/// Update lifecycle is intentionally bounded until fresh Rust core operations
/// own durable configuration, release discovery, and installation.
fn unsupported(operation: &'static str) -> impl IntoResponse {
    (
        StatusCode::NOT_IMPLEMENTED,
        Json(json!({
            "success": false,
            "error": "unsupported",
            "errorCode": "unsupported",
            "message": format!("native {operation} is not supported by this installation"),
            "operation": operation,
            "supported": false,
            "restartRequired": false,
            "pendingVersion": Value::Null,
            "installMethod": Value::Null,
            "activeExecutableVerified": false,
        })),
    )
}

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/api/update/check", get(check))
        .route("/api/update/config", get(get_config).post(set_config))
        .route("/api/update/run", post(run))
        .layer(axum::extract::DefaultBodyLimit::max(MAX_BODY))
}

async fn check(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if let Err(error) = auth::gate(&state, &headers).await {
        return error.into_response();
    }
    unsupported("update check").into_response()
}

async fn get_config(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if let Err(error) = auth::gate(&state, &headers).await {
        return error.into_response();
    }
    (
        StatusCode::OK,
        Json(config_json(&parse_config(&state.workspace))),
    )
        .into_response()
}

async fn set_config(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Result<Json<ConfigRequest>, axum::extract::rejection::JsonRejection>,
) -> impl IntoResponse {
    if let Err(error) = auth::gate(&state, &headers).await {
        return (
            error.status,
            Json(json!({"success": false, "error": error.message})),
        );
    }
    let Ok(Json(body)) = body else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"success": false, "error": "invalid JSON body"})),
        );
    };
    let mut config = parse_config(&state.workspace);
    if let Some(value) = body.auto_install {
        match value {
            Value::Bool(v) => config.auto_install = v,
            Value::String(v) if v == "true" || v == "false" => config.auto_install = v == "true",
            _ => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(json!({"success": false, "error": "autoInstall must be true or false"})),
                )
            }
        }
    }
    if let Some(value) = body.check_interval {
        let Some(v) = value
            .as_u64()
            .or_else(|| value.as_str().and_then(|s| s.parse().ok()))
        else {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({"success": false, "error": "checkInterval must be a number"})),
            );
        };
        if !(MIN_INTERVAL..=MAX_INTERVAL).contains(&v) {
            return (
                StatusCode::BAD_REQUEST,
                Json(
                    json!({"success": false, "error": "checkInterval must be between 300 and 604800 seconds"}),
                ),
            );
        }
        config.check_interval = v;
    }
    if let Some(channel) = body.channel {
        config.channel = match channel.trim().to_ascii_lowercase().as_str() {
            "stable" | "latest" => "stable",
            "nightly" | "next" => "nightly",
            _ => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(json!({"success": false, "error": "channel must be stable or nightly"})),
                )
            }
        };
    }
    let persisted = persist(&state.workspace, &config);
    (
        StatusCode::OK,
        Json(json!({"success": true, "config": config_json(&config), "persisted": persisted})),
    )
}

async fn run(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if let Err(error) = auth::gate(&state, &headers).await {
        return error.into_response();
    }
    unsupported("package update").into_response()
}
