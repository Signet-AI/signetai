use crate::{ApiError, AppState};
use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{env, path::PathBuf, time::Duration};
use tokio::fs;

const MAX_BODY: usize = 64 * 1024;
const MAX_CONFIG: usize = 16 * 1024;
const MIN_INTERVAL: u64 = 300;
const MAX_INTERVAL: u64 = 604_800;
const DEFAULT_INTERVAL: u64 = 21_600;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateConfig {
    #[serde(rename = "autoInstall", alias = "auto_install")]
    auto_install: bool,
    #[serde(rename = "checkInterval", alias = "check_interval")]
    check_interval: u64,
    channel: String,
}
impl Default for UpdateConfig {
    fn default() -> Self {
        Self {
            auto_install: false,
            check_interval: DEFAULT_INTERVAL,
            channel: "stable".into(),
        }
    }
}
#[derive(Debug, Deserialize)]
struct ConfigInput {
    #[serde(rename = "autoInstall", alias = "auto_install")]
    auto_install: Option<Value>,
    #[serde(rename = "checkInterval", alias = "check_interval")]
    check_interval: Option<Value>,
    channel: Option<String>,
}
#[derive(Debug, Deserialize, Default)]
struct CheckQuery {
    force: Option<bool>,
}

fn config_path(state: &AppState) -> Result<PathBuf, ApiError> {
    let root =
        std::fs::canonicalize(&state.workspace).map_err(|e| ApiError::internal(e.to_string()))?;
    let dir = root.join(".daemon");
    let path = dir.join("update-config.json");
    if path.parent() != Some(dir.as_path()) || !path.starts_with(&root) {
        return Err(ApiError::internal("invalid update config path"));
    }
    Ok(path)
}
async fn load_config(state: &AppState) -> Result<UpdateConfig, ApiError> {
    let path = config_path(state)?;
    if let Some(dir) = path.parent() {
        if let Ok(meta) = fs::symlink_metadata(dir).await {
            if meta.file_type().is_symlink() || !meta.is_dir() {
                return Err(ApiError::internal(".daemon is not a real directory"));
            }
        }
    }
    match fs::symlink_metadata(&path).await {
        Ok(meta) if !meta.file_type().is_file() || meta.file_type().is_symlink() => {
            return Err(ApiError::internal("update config is not a regular file"))
        }
        Ok(meta) if meta.len() > MAX_CONFIG as u64 => {
            return Err(ApiError::internal("update config is too large"))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(UpdateConfig::default()),
        Err(e) => return Err(ApiError::internal(e.to_string())),
        _ => {}
    }
    let bytes = fs::read(path)
        .await
        .map_err(|e| ApiError::internal(e.to_string()))?;
    serde_json::from_slice(&bytes).map_err(|_| ApiError::bad_request("update config is malformed"))
}
async fn save_config(state: &AppState, config: &UpdateConfig) -> Result<(), ApiError> {
    let path = config_path(state)?;
    let dir = path.parent().unwrap();
    match fs::symlink_metadata(dir).await {
        Ok(meta) if meta.file_type().is_symlink() || !meta.is_dir() => {
            return Err(ApiError::internal(".daemon is not a real directory"))
        }
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir_all(dir)
                .await
                .map_err(|e| ApiError::internal(e.to_string()))?;
        }
        Err(e) => return Err(ApiError::internal(e.to_string())),
    }
    fs::create_dir_all(dir)
        .await
        .map_err(|e| ApiError::internal(e.to_string()))?;
    let bytes = serde_json::to_vec_pretty(config).map_err(|e| ApiError::internal(e.to_string()))?;
    if bytes.len() > MAX_CONFIG {
        return Err(ApiError::bad_request("update config is too large"));
    }
    if let Ok(meta) = fs::symlink_metadata(&path).await {
        if meta.file_type().is_symlink() || !meta.is_file() {
            return Err(ApiError::internal("update config is not a regular file"));
        }
    }
    let tmp = dir.join(format!("update-config.json.tmp-{}", uuid::Uuid::new_v4()));
    let mut file = match fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&tmp)
        .await
    {
        Ok(file) => file,
        Err(e) => return Err(ApiError::internal(e.to_string())),
    };
    use tokio::io::AsyncWriteExt;
    if let Err(e) = file.write_all(&bytes).await {
        let _ = fs::remove_file(&tmp).await;
        return Err(ApiError::internal(e.to_string()));
    }
    drop(file);
    let result = fs::rename(&tmp, &path).await;
    if result.is_err() {
        let _ = fs::remove_file(&tmp).await;
    }
    result.map_err(|e| ApiError::internal(e.to_string()))
}
fn parse_bool(v: Value) -> Option<bool> {
    match v {
        Value::Bool(v) => Some(v),
        Value::String(s) if s == "true" => Some(true),
        Value::String(s) if s == "false" => Some(false),
        _ => None,
    }
}
fn parse_interval(v: Value) -> Option<u64> {
    match v {
        Value::Number(n) => n.as_u64(),
        Value::String(s) => s.parse().ok(),
        _ => None,
    }
    .filter(|v| (*v >= MIN_INTERVAL) && (*v <= MAX_INTERVAL))
}

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/api/update/check", get(check))
        .route("/api/update/config", get(get_config).post(set_config))
        .route("/api/update/run", post(run))
        .layer(axum::extract::DefaultBodyLimit::max(MAX_BODY))
}
async fn get_config(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let config = load_config(&state).await?;
    Ok(Json(
        json!({"autoInstall": config.auto_install, "checkInterval": config.check_interval, "channel": config.channel, "minInterval": MIN_INTERVAL, "maxInterval": MAX_INTERVAL, "pendingRestartVersion": null, "lastAutoUpdateAt": null, "lastAutoUpdateError": null, "updateInProgress": false}),
    ))
}
async fn set_config(
    State(state): State<AppState>,
    Json(input): Json<ConfigInput>,
) -> Result<Json<Value>, ApiError> {
    let mut config = load_config(&state).await?;
    if let Some(v) = input.auto_install {
        config.auto_install = parse_bool(v)
            .ok_or_else(|| ApiError::bad_request("autoInstall must be true or false"))?;
    }
    if let Some(v) = input.check_interval {
        config.check_interval = parse_interval(v).ok_or_else(|| {
            ApiError::bad_request(format!(
                "checkInterval must be between {MIN_INTERVAL} and {MAX_INTERVAL} seconds"
            ))
        })?;
    }
    if let Some(channel) = input.channel {
        config.channel = match channel.trim().to_ascii_lowercase().as_str() {
            "stable" | "latest" => "stable".into(),
            "nightly" | "next" => "nightly".into(),
            _ => {
                return Err(ApiError::bad_request(
                    "channel must be stable, latest, nightly, or next",
                ))
            }
        };
    }
    save_config(&state, &config).await?;
    Ok(Json(
        json!({"success": true, "config": {"autoInstall": config.auto_install, "checkInterval": config.check_interval, "channel": config.channel}, "persisted": true}),
    ))
}
async fn check(
    State(state): State<AppState>,
    Query(query): Query<CheckQuery>,
) -> Result<Json<Value>, ApiError> {
    let _ = query.force;
    let current = env::var("SIGNET_VERSION").unwrap_or_else(|_| env!("CARGO_PKG_VERSION").into());
    let config = load_config(&state).await?;
    let url = env::var("SIGNET_UPDATE_REGISTRY_URL")
        .map_err(|_| ApiError::unavailable("update registry is not configured"))?;
    let parsed = reqwest::Url::parse(&url)
        .map_err(|_| ApiError::bad_request("update registry URL is invalid"))?;
    if parsed.scheme() != "https" {
        return Err(ApiError::bad_request("update registry must use HTTPS"));
    }
    let client = reqwest::Client::builder()
        .use_rustls_tls()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| ApiError::internal(e.to_string()))?;
    let response = client
        .get(parsed)
        .header("accept", "application/json")
        .query(&[("channel", config.channel.as_str())])
        .send()
        .await
        .map_err(|e| ApiError::unavailable(format!("update registry unavailable: {e}")))?;
    if !response.status().is_success() {
        return Err(ApiError::upstream(format!(
            "update registry returned {}",
            response.status()
        )));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|e| ApiError::unavailable(e.to_string()))?;
    if bytes.len() > MAX_BODY {
        return Err(ApiError::upstream("update registry response is too large"));
    }
    let release: Value = serde_json::from_slice(&bytes)
        .map_err(|_| ApiError::upstream("update registry returned malformed JSON"))?;
    let latest = release
        .get("latestVersion")
        .or_else(|| release.get("version"))
        .and_then(Value::as_str);
    Ok(Json(
        json!({"currentVersion": current, "latestVersion": latest, "updateAvailable": latest.is_some_and(|v| v != current), "releaseUrl": release.get("releaseUrl"), "publishedAt": release.get("publishedAt"), "checkError": Value::Null, "restartRequired": false, "pendingVersion": Value::Null, "channel": config.channel}),
    ))
}
async fn run() -> impl IntoResponse {
    (
        StatusCode::NOT_IMPLEMENTED,
        Json(
            json!({"success": false, "message": "native package update is not supported by this installation", "errorCode": "unsupported", "restartRequired": false, "installMethod": Value::Null, "activeExecutableVerified": false}),
        ),
    )
}
