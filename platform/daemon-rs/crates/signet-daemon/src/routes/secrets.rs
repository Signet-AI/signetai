//! Secret management routes.
//!
//! Encrypted secret storage using XSalsa20-Poly1305. Secrets stored
//! in `~/.agents/.secrets/secrets.enc` with a master key derived from
//! machine identity.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use axum::{
    Json,
    body::Bytes,
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
};
use serde::{Deserialize, Serialize};

use crate::state::AppState;
use crate::workspace_paths;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SecretEntry {
    ciphertext: String,
    created: String,
    updated: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SecretsStore {
    version: u32,
    secrets: std::collections::HashMap<String, SecretEntry>,
}

const BITWARDEN_SESSION_SECRET: &str = "BITWARDEN_SESSION";
const BITWARDEN_ACTIVE_PROVIDER_SECRET: &str = "SIGNET_SECRETS_ACTIVE_PROVIDER";
const BITWARDEN_MANAGED_FOLDER_SECRET: &str = "BITWARDEN_MANAGED_FOLDER_ID";
const ONEPASSWORD_SERVICE_ACCOUNT_SECRET: &str = "OP_SERVICE_ACCOUNT_TOKEN";
const BITWARDEN_DELETED_NAMES_SECRET: &str = "BITWARDEN_DELETED_SECRET_NAMES";

impl Default for SecretsStore {
    fn default() -> Self {
        Self {
            version: 1,
            secrets: std::collections::HashMap::new(),
        }
    }
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

fn load_store(state: &AppState) -> SecretsStore {
    let Ok(path) =
        workspace_paths::child_file(&state.config.base_path, &[".secrets", "secrets.enc"])
    else {
        return SecretsStore::default();
    };
    match std::fs::read_to_string(&path) {
        Ok(data) => serde_json::from_str(&data).unwrap_or_default(),
        Err(_) => SecretsStore::default(),
    }
}

fn save_store(state: &AppState, store: &SecretsStore) -> Result<(), String> {
    let path = workspace_paths::child_file(&state.config.base_path, &[".secrets", "secrets.enc"])
        .map_err(|e| format!("path: {e}"))?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir: {e}"))?;
    }
    let json = serde_json::to_string_pretty(store).map_err(|e| format!("serialize: {e}"))?;
    std::fs::write(&path, json).map_err(|e| format!("write: {e}"))?;

    // Set restrictive permissions on Unix
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let perms = std::fs::Permissions::from_mode(0o600);
        let _ = std::fs::set_permissions(&path, perms);
    }

    Ok(())
}

fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .chars()
            .next()
            .map(|c| c.is_ascii_alphabetic() || c == '_')
            .unwrap_or(false)
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

pub(crate) fn secret_names(state: &AppState) -> Vec<String> {
    let store = load_store(state);
    let mut names = store
        .secrets
        .keys()
        .filter(|name| !is_internal_secret_name(name))
        .cloned()
        .collect::<Vec<_>>();
    names.sort();
    names
}

fn is_internal_secret_name(name: &str) -> bool {
    matches!(
        name,
        BITWARDEN_SESSION_SECRET
            | BITWARDEN_ACTIVE_PROVIDER_SECRET
            | BITWARDEN_MANAGED_FOLDER_SECRET
            | BITWARDEN_DELETED_NAMES_SECRET
            | ONEPASSWORD_SERVICE_ACCOUNT_SECRET
    )
}

fn decode_secret(entry: &SecretEntry) -> Result<String, String> {
    use base64::Engine;
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(&entry.ciphertext)
        .map_err(|e| format!("decode: {e}"))?;
    String::from_utf8(decoded).map_err(|e| format!("utf8: {e}"))
}

fn put_local_secret(state: &AppState, name: &str, value: &str) -> Result<(), String> {
    let mut store = load_store(state);
    put_secret_in_store(&mut store, name, value);
    save_store(state, &store)
}

fn put_secret_in_store(store: &mut SecretsStore, name: &str, value: &str) {
    let now = chrono::Utc::now().to_rfc3339();
    use base64::Engine;
    let encoded = base64::engine::general_purpose::STANDARD.encode(value.as_bytes());
    let entry = store
        .secrets
        .entry(name.to_string())
        .or_insert(SecretEntry {
            ciphertext: String::new(),
            created: now.clone(),
            updated: now.clone(),
        });
    entry.ciphertext = encoded;
    entry.updated = now;
}

fn get_local_secret(state: &AppState, name: &str) -> Result<String, String> {
    load_store(state)
        .secrets
        .get(name)
        .ok_or_else(|| format!("Secret '{name}' not found"))
        .and_then(decode_secret)
}

fn active_secret_provider(state: &AppState) -> String {
    get_local_secret(state, BITWARDEN_ACTIVE_PROVIDER_SECRET)
        .ok()
        .filter(|value| value.trim().eq_ignore_ascii_case("bitwarden"))
        .map(|_| "bitwarden".to_string())
        .unwrap_or_else(|| "local".to_string())
}

fn parse_bool(value: Option<&serde_json::Value>) -> Option<bool> {
    match value {
        Some(serde_json::Value::Bool(value)) => Some(*value),
        Some(serde_json::Value::Number(value)) if value.as_i64() == Some(1) => Some(true),
        Some(serde_json::Value::Number(value)) if value.as_i64() == Some(0) => Some(false),
        Some(serde_json::Value::String(value)) => {
            match value.trim().to_ascii_lowercase().as_str() {
                "1" | "true" => Some(true),
                "0" | "false" => Some(false),
                _ => None,
            }
        }
        _ => None,
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BitwardenFolder {
    id: String,
    name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BitwardenStatusPayload {
    configured: bool,
    connected: bool,
    active_provider: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    user_email: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    server_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    folders: Option<Vec<BitwardenFolder>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OnePasswordVault {
    id: String,
    name: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OnePasswordItemSummary {
    id: String,
    title: String,
}

#[derive(Debug, Clone, Deserialize)]
struct OnePasswordItemDetails {
    id: String,
    title: String,
    fields: Option<Vec<OnePasswordField>>,
}

#[derive(Debug, Clone, Deserialize)]
struct OnePasswordField {
    id: Option<String>,
    label: Option<String>,
    value: Option<String>,
    #[serde(rename = "type")]
    field_type: Option<String>,
    purpose: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BitwardenItemSummary {
    id: String,
    name: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct BitwardenItemDetails {
    id: String,
    name: String,
    folder_id: Option<String>,
    login: Option<BitwardenLogin>,
    notes: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct BitwardenLogin {
    username: Option<String>,
    password: Option<String>,
}

fn command_from_env(env_name: &str, default_command: &str) -> PathBuf {
    std::env::var_os(env_name)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(default_command))
}

async fn run_command_json(
    command: PathBuf,
    args: &[&str],
    envs: &[(&str, &str)],
    input: Option<&str>,
    timeout_ms: u64,
) -> Result<String, String> {
    let mut cmd = tokio::process::Command::new(command);
    cmd.args(args)
        .stdin(if input.is_some() {
            std::process::Stdio::piped()
        } else {
            std::process::Stdio::null()
        })
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    for (key, value) in envs {
        cmd.env(key, value);
    }
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    if let Some(input) = input
        && let Some(mut stdin) = child.stdin.take()
    {
        use tokio::io::AsyncWriteExt;
        stdin
            .write_all(input.as_bytes())
            .await
            .map_err(|e| e.to_string())?;
    }
    let output = tokio::time::timeout(Duration::from_millis(timeout_ms), child.wait_with_output())
        .await
        .map_err(|_| format!("command timed out after {timeout_ms}ms"))?
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "command failed".to_string()
        } else {
            stderr
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

async fn run_bw(args: &[&str], session: &str, input: Option<&str>) -> Result<String, String> {
    run_command_json(
        command_from_env("SIGNET_BW_BIN", "bw"),
        args,
        &[("BW_SESSION", session)],
        input,
        30_000,
    )
    .await
}

async fn bitwarden_status_for_session(
    configured: bool,
    active_provider: bool,
    session: Option<&str>,
) -> BitwardenStatusPayload {
    let Some(session) = session.filter(|value| !value.trim().is_empty()) else {
        return BitwardenStatusPayload {
            configured: false,
            connected: false,
            active_provider,
            user_email: None,
            server_url: None,
            folders: None,
            error: None,
        };
    };
    if !configured {
        return BitwardenStatusPayload {
            configured: false,
            connected: false,
            active_provider,
            user_email: None,
            server_url: None,
            folders: None,
            error: None,
        };
    }
    let status = run_bw(&["status"], session, None).await;
    let folders = run_bw(&["list", "folders"], session, None).await;
    match (status, folders) {
        (Ok(status), Ok(folders)) => {
            let status_json: serde_json::Value = match serde_json::from_str(&status) {
                Ok(value) => value,
                Err(error) => {
                    return BitwardenStatusPayload {
                        configured: true,
                        connected: false,
                        active_provider,
                        user_email: None,
                        server_url: None,
                        folders: None,
                        error: Some(format!("Bitwarden CLI returned invalid JSON: {error}")),
                    };
                }
            };
            let folders_json =
                serde_json::from_str::<Vec<BitwardenFolder>>(&folders).unwrap_or_default();
            BitwardenStatusPayload {
                configured: true,
                connected: status_json
                    .get("status")
                    .and_then(serde_json::Value::as_str)
                    == Some("unlocked"),
                active_provider,
                user_email: status_json
                    .get("userEmail")
                    .and_then(serde_json::Value::as_str)
                    .map(ToOwned::to_owned),
                server_url: status_json
                    .get("serverUrl")
                    .and_then(serde_json::Value::as_str)
                    .map(ToOwned::to_owned),
                folders: Some(folders_json),
                error: None,
            }
        }
        (Err(error), _) | (_, Err(error)) => BitwardenStatusPayload {
            configured: true,
            connected: false,
            active_provider,
            user_email: None,
            server_url: None,
            folders: None,
            error: Some(error),
        },
    }
}

async fn list_bitwarden_folders(session: &str) -> Result<Vec<BitwardenFolder>, String> {
    serde_json::from_str(&run_bw(&["list", "folders"], session, None).await?)
        .map_err(|e| format!("Bitwarden CLI returned invalid JSON: {e}"))
}

async fn list_bitwarden_items(session: &str) -> Result<Vec<BitwardenItemSummary>, String> {
    serde_json::from_str(&run_bw(&["list", "items"], session, None).await?)
        .map_err(|e| format!("Bitwarden CLI returned invalid JSON: {e}"))
}

async fn get_bitwarden_item(session: &str, id: &str) -> Result<BitwardenItemDetails, String> {
    serde_json::from_str(&run_bw(&["get", "item", id], session, None).await?)
        .map_err(|e| format!("Bitwarden CLI returned invalid JSON: {e}"))
}

fn build_bitwarden_managed_secret_name(name: &str) -> String {
    if valid_name(name) {
        return name.to_string();
    }
    let candidate = name
        .trim()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect::<String>()
        .trim_matches('_')
        .to_ascii_uppercase();
    if valid_name(&candidate) {
        candidate
    } else {
        format!(
            "SECRET_{}",
            if candidate.is_empty() {
                "VALUE"
            } else {
                &candidate
            }
        )
    }
}

async fn put_bitwarden_secret(
    session: &str,
    name: &str,
    value: &str,
    folder_id: Option<&str>,
    overwrite: bool,
) -> Result<String, String> {
    let managed_name = build_bitwarden_managed_secret_name(name);
    let existing = list_bitwarden_items(session)
        .await?
        .into_iter()
        .find(|item| item.name == managed_name);
    if existing.is_some() && !overwrite {
        return Err(format!(
            "Bitwarden item '{managed_name}' already exists; pass overwrite to replace it"
        ));
    }
    let mut item = if let Some(existing) = existing {
        get_bitwarden_item(session, &existing.id).await?
    } else {
        BitwardenItemDetails {
            id: String::new(),
            name: managed_name.clone(),
            folder_id: folder_id.map(ToOwned::to_owned),
            login: Some(BitwardenLogin {
                username: Some("signet".to_string()),
                password: Some(String::new()),
            }),
            notes: Some("Managed by Signet secrets".to_string()),
        }
    };
    item.name = managed_name;
    item.folder_id = folder_id.map(ToOwned::to_owned).or(item.folder_id);
    let mut login = item.login.unwrap_or(BitwardenLogin {
        username: Some("signet".to_string()),
        password: None,
    });
    login.password = Some(value.to_string());
    item.login = Some(login);
    if item.notes.is_none() {
        item.notes = Some("Managed by Signet secrets".to_string());
    }
    let payload = serde_json::to_string(&item).map_err(|e| e.to_string())?;
    let encoded = run_bw(&["encode"], session, Some(&payload)).await?;
    let output = if item.id.is_empty() {
        run_bw(&["create", "item"], session, Some(encoded.trim())).await?
    } else {
        run_bw(&["edit", "item", &item.id], session, Some(encoded.trim())).await?
    };
    let saved: BitwardenItemDetails = serde_json::from_str(&output)
        .map_err(|e| format!("Bitwarden CLI returned invalid JSON: {e}"))?;
    Ok(saved.id)
}

async fn list_onepassword_vaults(token: &str) -> Result<Vec<OnePasswordVault>, String> {
    let output = run_command_json(
        command_from_env("SIGNET_OP_BIN", "op"),
        &["vault", "list", "--format", "json"],
        &[("OP_SERVICE_ACCOUNT_TOKEN", token)],
        None,
        30_000,
    )
    .await?;
    serde_json::from_str(&output).map_err(|e| format!("1Password CLI returned invalid JSON: {e}"))
}

async fn list_onepassword_items(
    token: &str,
    vault_id: &str,
) -> Result<Vec<OnePasswordItemSummary>, String> {
    let output = run_command_json(
        command_from_env("SIGNET_OP_BIN", "op"),
        &["item", "list", "--vault", vault_id, "--format", "json"],
        &[("OP_SERVICE_ACCOUNT_TOKEN", token)],
        None,
        30_000,
    )
    .await?;
    serde_json::from_str(&output).map_err(|e| format!("1Password CLI returned invalid JSON: {e}"))
}

async fn get_onepassword_item(
    token: &str,
    vault_id: &str,
    item_id: &str,
) -> Result<OnePasswordItemDetails, String> {
    let output = run_command_json(
        command_from_env("SIGNET_OP_BIN", "op"),
        &[
            "item", "get", item_id, "--vault", vault_id, "--format", "json",
        ],
        &[("OP_SERVICE_ACCOUNT_TOKEN", token)],
        None,
        30_000,
    )
    .await?;
    serde_json::from_str(&output).map_err(|e| format!("1Password CLI returned invalid JSON: {e}"))
}

fn sanitize_import_segment(value: &str) -> String {
    value
        .trim()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' {
                c.to_ascii_uppercase()
            } else {
                '_'
            }
        })
        .collect::<String>()
        .trim_matches('_')
        .to_string()
}

fn build_imported_secret_name(prefix: &str, vault: &str, item: &str, field: &str) -> String {
    let candidate = [
        sanitize_import_segment(prefix)
            .is_empty()
            .then_some("OP".to_string())
            .unwrap_or_else(|| sanitize_import_segment(prefix)),
        sanitize_import_segment(vault)
            .is_empty()
            .then_some("VAULT".to_string())
            .unwrap_or_else(|| sanitize_import_segment(vault)),
        sanitize_import_segment(item)
            .is_empty()
            .then_some("ITEM".to_string())
            .unwrap_or_else(|| sanitize_import_segment(item)),
        sanitize_import_segment(field)
            .is_empty()
            .then_some("PASSWORD".to_string())
            .unwrap_or_else(|| sanitize_import_segment(field)),
    ]
    .join("_");
    if valid_name(&candidate) {
        candidate
    } else {
        format!("_{candidate}")
    }
}

fn onepassword_field_score(field: &OnePasswordField) -> i32 {
    let label = field.label.as_deref().unwrap_or("").to_ascii_lowercase();
    let kind = field
        .field_type
        .as_deref()
        .unwrap_or("")
        .to_ascii_lowercase();
    let purpose = field.purpose.as_deref().unwrap_or("").to_ascii_lowercase();
    let mut score = 0;
    if purpose.contains("password") {
        score += 100;
    }
    if label.contains("password") || label.contains("token") || label.contains("secret") {
        score += 60;
    }
    if kind.contains("concealed") || kind.contains("password") {
        score += 30;
    }
    if field
        .value
        .as_deref()
        .map(|value| !value.is_empty())
        .unwrap_or(false)
    {
        score += 1;
    }
    score
}

fn selected_onepassword_vaults(
    all: &[OnePasswordVault],
    selected: Option<&serde_json::Value>,
) -> Vec<OnePasswordVault> {
    let Some(values) = selected.and_then(serde_json::Value::as_array) else {
        return all.to_vec();
    };
    let wanted = values
        .iter()
        .filter_map(serde_json::Value::as_str)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>();
    if wanted.is_empty() {
        return all.to_vec();
    }
    all.iter()
        .filter(|vault| {
            wanted
                .iter()
                .any(|value| value == &vault.id || value == &vault.name)
        })
        .cloned()
        .collect()
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

/// GET /api/secrets — list secret names
pub async fn list(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "secrets": secret_names(&state),
        "provider": active_secret_provider(&state),
    }))
}

/// GET /api/secrets/1password/status — 1Password provider status.
///
/// The TypeScript daemon exposes this compatibility endpoint even when no
/// service-account token is configured. Rust currently has no native
/// 1Password client, but it can still preserve the client contract: report an
/// unconfigured provider instead of letting the dynamic secret-name route catch
/// the path or returning 404.
pub async fn onepassword_status(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    match get_local_secret(&state, ONEPASSWORD_SERVICE_ACCOUNT_SECRET) {
        Ok(token) => match list_onepassword_vaults(&token).await {
            Ok(vaults) => Json(serde_json::json!({
                "configured": true,
                "connected": true,
                "vaultCount": vaults.len(),
                "vaults": vaults,
            })),
            Err(error) => Json(serde_json::json!({
                "configured": true,
                "connected": false,
                "error": error,
                "vaults": [],
            })),
        },
        Err(_) => Json(serde_json::json!({
            "configured": false,
            "connected": false,
            "vaults": [],
        })),
    }
}

/// GET /api/secrets/bitwarden/status — Bitwarden provider status.
pub async fn bitwarden_status(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    let session = get_local_secret(&state, BITWARDEN_SESSION_SECRET).ok();
    let active_provider = active_secret_provider(&state) == "bitwarden";
    Json(serde_json::to_value(
        bitwarden_status_for_session(session.is_some(), active_provider, session.as_deref()).await,
    )
    .unwrap_or_else(|_| serde_json::json!({"configured": false, "connected": false, "activeProvider": active_provider})))
}

/// POST /api/secrets/bitwarden/connect — configure Bitwarden session.
pub async fn bitwarden_connect(
    State(state): State<Arc<AppState>>,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    let session = body
        .get("session")
        .or_else(|| body.get("token"))
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if session.is_none() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "session is required"})),
        );
    }
    let session = session.unwrap();
    let activate = parse_bool(body.get("activate")).unwrap_or(false);
    let folder_id = body
        .get("folderId")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let current_active = active_secret_provider(&state) == "bitwarden";
    let status = bitwarden_status_for_session(true, current_active, Some(session)).await;
    if !status.connected {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "success": false,
                "error": status.error.unwrap_or_else(|| "Bitwarden session is not connected".to_string()),
                "configured": true,
                "connected": false,
                "activeProvider": current_active,
            })),
        );
    }
    let mut store = load_store(&state);
    put_secret_in_store(&mut store, BITWARDEN_SESSION_SECRET, session);
    if let Some(folder_id) = folder_id {
        put_secret_in_store(&mut store, BITWARDEN_MANAGED_FOLDER_SECRET, folder_id);
    } else {
        store.secrets.remove(BITWARDEN_MANAGED_FOLDER_SECRET);
    }
    if activate {
        put_secret_in_store(&mut store, BITWARDEN_ACTIVE_PROVIDER_SECRET, "bitwarden");
    }
    if let Err(error) = save_store(&state, &store) {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": error})),
        );
    }
    let active_provider = activate || current_active;
    (
        StatusCode::OK,
        Json(serde_json::json!({
            "success": true,
            "configured": true,
            "connected": true,
            "activeProvider": active_provider,
            "userEmail": status.user_email,
            "serverUrl": status.server_url,
            "folders": status.folders.unwrap_or_default(),
        })),
    )
}

/// DELETE /api/secrets/bitwarden/connect — disconnect Bitwarden provider.
pub async fn bitwarden_disconnect(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let mut store = load_store(&state);
    let session_deleted = store.secrets.remove(BITWARDEN_SESSION_SECRET).is_some();
    let folder_deleted = store
        .secrets
        .remove(BITWARDEN_MANAGED_FOLDER_SECRET)
        .is_some();
    store.secrets.remove(BITWARDEN_ACTIVE_PROVIDER_SECRET);
    if let Err(err) = save_store(&state, &store) {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": err})),
        );
    }
    (
        StatusCode::OK,
        Json(serde_json::json!({
            "success": true,
            "disconnected": true,
            "existed": session_deleted || folder_deleted,
            "activeProvider": false,
        })),
    )
}

/// POST /api/secrets/bitwarden/provider — select local or Bitwarden provider.
pub async fn bitwarden_provider(
    State(state): State<Arc<AppState>>,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    let provider = body
        .get("provider")
        .and_then(|value| value.as_str())
        .map(str::trim);
    match provider {
        Some("local") => {
            let mut store = load_store(&state);
            store.secrets.remove(BITWARDEN_ACTIVE_PROVIDER_SECRET);
            let status = save_store(&state, &store)
                .map(|_| StatusCode::OK)
                .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
            (
                status,
                Json(serde_json::json!({"success": status == StatusCode::OK, "provider": "local"})),
            )
        }
        Some("bitwarden") => {
            let Ok(session) = get_local_secret(&state, BITWARDEN_SESSION_SECRET) else {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({"error": "Bitwarden is not connected"})),
                );
            };
            let provider_status = bitwarden_status_for_session(true, true, Some(&session)).await;
            if !provider_status.connected {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({
                        "success": false,
                        "error": provider_status.error.unwrap_or_else(|| "Bitwarden session is not connected".to_string()),
                        "configured": true,
                        "connected": false,
                        "activeProvider": true,
                    })),
                );
            }
            match put_local_secret(&state, BITWARDEN_ACTIVE_PROVIDER_SECRET, "bitwarden") {
                Ok(()) => (
                    StatusCode::OK,
                    Json(serde_json::json!({"success": true, "provider": "bitwarden"})),
                ),
                Err(error) => (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(serde_json::json!({"error": error})),
                ),
            }
        }
        _ => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "provider must be local or bitwarden"})),
        ),
    }
}

/// GET /api/secrets/bitwarden/folders — list Bitwarden folders.
pub async fn bitwarden_folders(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let Ok(session) = get_local_secret(&state, BITWARDEN_SESSION_SECRET) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "Bitwarden is not connected"})),
        );
    };
    match list_bitwarden_folders(&session).await {
        Ok(folders) => {
            let count = folders.len();
            (
                StatusCode::OK,
                Json(serde_json::json!({"folders": folders, "count": count})),
            )
        }
        Err(error) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": error})),
        ),
    }
}

/// POST /api/secrets/bitwarden/migrate — migrate local secrets to Bitwarden.
pub async fn bitwarden_migrate(
    State(state): State<Arc<AppState>>,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    if !body.is_object() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "Invalid JSON body"})),
        );
    }
    let Ok(session) = get_local_secret(&state, BITWARDEN_SESSION_SECRET) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "Bitwarden is not connected"})),
        );
    };
    let folder_id = body
        .get("folderId")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let overwrite = parse_bool(body.get("overwrite")).unwrap_or(false);
    let dry_run = parse_bool(body.get("dryRun")).unwrap_or(true);
    let delete_local = parse_bool(body.get("deleteLocal")).unwrap_or(false);

    let mut store = load_store(&state);
    let local_names = store
        .secrets
        .keys()
        .filter(|name| !is_internal_secret_name(name))
        .cloned()
        .collect::<Vec<_>>();
    let mut results = Vec::new();
    let mut migrated_count = 0;
    let mut skipped_count = 0;
    let mut deleted_local_count = 0;
    let mut error_count = 0;

    for local_name in local_names {
        let managed_name = build_bitwarden_managed_secret_name(&local_name);
        if dry_run {
            skipped_count += 1;
            results.push(serde_json::json!({"name": managed_name, "action": "skipped"}));
            continue;
        }
        let value = match store
            .secrets
            .get(&local_name)
            .and_then(|entry| decode_secret(entry).ok())
        {
            Some(value) => value,
            None => {
                error_count += 1;
                results.push(serde_json::json!({
                    "name": managed_name,
                    "action": "skipped",
                    "error": "local secret could not be decoded",
                }));
                continue;
            }
        };
        match put_bitwarden_secret(&session, &local_name, &value, folder_id, overwrite).await {
            Ok(item_id) => {
                migrated_count += 1;
                results.push(serde_json::json!({
                    "name": managed_name,
                    "action": "migrated",
                    "itemId": item_id,
                }));
                if delete_local && store.secrets.remove(&local_name).is_some() {
                    deleted_local_count += 1;
                    results.push(serde_json::json!({
                        "name": local_name,
                        "action": "deleted-local",
                    }));
                }
            }
            Err(error) => {
                error_count += 1;
                results.push(serde_json::json!({
                    "name": managed_name,
                    "action": "skipped",
                    "error": error,
                }));
            }
        }
    }
    if !dry_run
        && delete_local
        && let Err(error) = save_store(&state, &store)
    {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": error})),
        );
    }
    (
        StatusCode::OK,
        Json(serde_json::json!({
            "success": true,
            "dryRun": dry_run,
            "deleteLocal": delete_local,
            "migratedCount": migrated_count,
            "skippedCount": skipped_count,
            "deletedLocalCount": deleted_local_count,
            "errorCount": error_count,
            "results": results,
        })),
    )
}

/// POST /api/secrets/1password/connect — configure 1Password token.
pub async fn onepassword_connect(
    State(state): State<Arc<AppState>>,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    let token = body
        .get("token")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if token.is_none() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "token is required"})),
        );
    }
    let token = token.unwrap();
    match list_onepassword_vaults(token).await {
        Ok(vaults) => match put_local_secret(&state, ONEPASSWORD_SERVICE_ACCOUNT_SECRET, token) {
            Ok(()) => {
                let count = vaults.len();
                (
                    StatusCode::OK,
                    Json(serde_json::json!({
                        "success": true,
                        "connected": true,
                        "vaultCount": count,
                        "vaults": vaults,
                    })),
                )
            }
            Err(error) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": error})),
            ),
        },
        Err(error) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": error})),
        ),
    }
}

/// DELETE /api/secrets/1password/connect — disconnect 1Password provider.
pub async fn onepassword_disconnect(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let mut store = load_store(&state);
    let existed = store
        .secrets
        .remove(ONEPASSWORD_SERVICE_ACCOUNT_SECRET)
        .is_some();
    if let Err(err) = save_store(&state, &store) {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": err})),
        );
    }
    (
        StatusCode::OK,
        Json(serde_json::json!({
            "success": true,
            "disconnected": true,
            "existed": existed,
        })),
    )
}

/// GET /api/secrets/1password/vaults — list 1Password vaults.
pub async fn onepassword_vaults(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let Ok(token) = get_local_secret(&state, ONEPASSWORD_SERVICE_ACCOUNT_SECRET) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "1Password service account token not configured"})),
        );
    };
    match list_onepassword_vaults(&token).await {
        Ok(vaults) => {
            let count = vaults.len();
            (
                StatusCode::OK,
                Json(serde_json::json!({"vaults": vaults, "count": count})),
            )
        }
        Err(error) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": error})),
        ),
    }
}

/// POST /api/secrets/1password/import — import 1Password items.
pub async fn onepassword_import(
    State(state): State<Arc<AppState>>,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    if !body.is_object() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "Invalid JSON body"})),
        );
    }
    let token = match body
        .get("token")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .or_else(|| get_local_secret(&state, ONEPASSWORD_SERVICE_ACCOUNT_SECRET).ok())
    {
        Some(token) => token,
        None => {
            return (
                StatusCode::BAD_REQUEST,
                Json(
                    serde_json::json!({"error": "1Password service account token not configured"}),
                ),
            );
        }
    };
    let prefix = body
        .get("prefix")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("OP");
    let overwrite = parse_bool(body.get("overwrite")).unwrap_or(false);
    let all_vaults = match list_onepassword_vaults(&token).await {
        Ok(vaults) => vaults,
        Err(error) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"error": error})),
            );
        }
    };
    let selected_vaults = selected_onepassword_vaults(&all_vaults, body.get("vaults"));
    let mut store = load_store(&state);
    let mut imported = Vec::new();
    let mut skipped = Vec::new();
    let mut errors = Vec::new();
    let mut used_names = std::collections::HashSet::new();
    let mut items_scanned = 0;

    for vault in &selected_vaults {
        let items = match list_onepassword_items(&token, &vault.id).await {
            Ok(items) => items,
            Err(error) => {
                errors.push(serde_json::json!({
                    "vaultId": vault.id,
                    "vaultName": vault.name,
                    "itemId": "",
                    "itemTitle": "",
                    "error": error,
                }));
                continue;
            }
        };
        for item in items {
            items_scanned += 1;
            let details = match get_onepassword_item(&token, &vault.id, &item.id).await {
                Ok(details) => details,
                Err(error) => {
                    errors.push(serde_json::json!({
                        "vaultId": vault.id,
                        "vaultName": vault.name,
                        "itemId": item.id,
                        "itemTitle": item.title,
                        "error": error,
                    }));
                    continue;
                }
            };
            let mut fields = details
                .fields
                .unwrap_or_default()
                .into_iter()
                .filter(|field| onepassword_field_score(field) > 0)
                .collect::<Vec<_>>();
            fields.sort_by_key(|field| -onepassword_field_score(field));
            if fields.is_empty() {
                skipped.push(serde_json::json!({
                    "vaultId": vault.id,
                    "vaultName": vault.name,
                    "itemId": details.id,
                    "itemTitle": details.title,
                    "reason": "No password-like fields found",
                }));
                continue;
            }
            for field in fields {
                let field_label = field
                    .label
                    .clone()
                    .or(field.id.clone())
                    .unwrap_or_else(|| "password".to_string());
                let base_name =
                    build_imported_secret_name(prefix, &vault.name, &details.title, &field_label);
                let mut secret_name = base_name.clone();
                if !overwrite {
                    let mut suffix = 2;
                    while store.secrets.contains_key(&secret_name)
                        || used_names.contains(&secret_name)
                    {
                        secret_name = format!("{base_name}_{suffix}");
                        suffix += 1;
                    }
                }
                let Some(value) = field.value.as_deref().filter(|value| !value.is_empty()) else {
                    skipped.push(serde_json::json!({
                        "vaultId": vault.id,
                        "vaultName": vault.name,
                        "itemId": details.id,
                        "itemTitle": details.title,
                        "reason": "Secret field had no value",
                    }));
                    continue;
                };
                put_secret_in_store(&mut store, &secret_name, value);
                used_names.insert(secret_name.clone());
                imported.push(serde_json::json!({
                    "secretName": secret_name,
                    "baseSecretName": base_name,
                    "vaultId": vault.id,
                    "vaultName": vault.name,
                    "itemId": details.id,
                    "itemTitle": details.title,
                    "fieldId": field.id.unwrap_or_else(|| "field".to_string()),
                    "fieldLabel": field_label,
                    "renamed": secret_name != base_name,
                }));
            }
        }
    }
    if let Err(error) = save_store(&state, &store) {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": error})),
        );
    }
    (
        StatusCode::OK,
        Json(serde_json::json!({
            "success": true,
            "vaultsScanned": selected_vaults.len(),
            "itemsScanned": items_scanned,
            "importedCount": imported.len(),
            "skippedCount": skipped.len(),
            "errorCount": errors.len(),
            "imported": imported,
            "skipped": skipped,
            "errors": errors,
        })),
    )
}

/// POST /api/secrets/:name — store a secret
pub async fn put(
    State(state): State<Arc<AppState>>,
    Path(name): Path<String>,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    if !valid_name(&name) {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "invalid secret name"})),
        );
    }

    let value = match body.get("value").and_then(|v| v.as_str()) {
        Some(v) => v,
        None => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"error": "missing value"})),
            );
        }
    };

    let mut store = load_store(&state);
    let now = chrono::Utc::now().to_rfc3339();

    // In production, value would be encrypted with XSalsa20-Poly1305.
    // For now, store base64-encoded (encryption integration in Phase 8).
    use base64::Engine;
    let encoded = base64::engine::general_purpose::STANDARD.encode(value.as_bytes());

    let entry = store.secrets.entry(name.clone()).or_insert(SecretEntry {
        ciphertext: String::new(),
        created: now.clone(),
        updated: now.clone(),
    });
    entry.ciphertext = encoded;
    entry.updated = now;

    if let Err(e) = save_store(&state, &store) {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e})),
        );
    }

    (
        StatusCode::OK,
        Json(serde_json::json!({"success": true, "name": name})),
    )
}

/// DELETE /api/secrets/:name — delete a secret
pub async fn delete(
    State(state): State<Arc<AppState>>,
    Path(name): Path<String>,
) -> impl IntoResponse {
    let mut store = load_store(&state);
    let existed = store.secrets.remove(&name).is_some();

    if let Err(e) = save_store(&state, &store) {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e})),
        );
    }

    (
        StatusCode::OK,
        Json(serde_json::json!({
            "success": true,
            "name": name,
            "existed": existed,
        })),
    )
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecBody {
    pub command: String,
    pub secrets: std::collections::HashMap<String, String>,
    pub cwd: Option<String>,
    pub timeout_ms: Option<u64>,
}

fn normalize_secret_exec_timeout_ms(timeout_ms: Option<u64>) -> u64 {
    timeout_ms.unwrap_or(300_000).clamp(1_000, 1_800_000)
}

fn parse_secret_exec_timeout_ms(value: Option<&serde_json::Value>) -> Option<u64> {
    let number = value.and_then(serde_json::Value::as_f64)?;
    if !number.is_finite() {
        return None;
    }
    let truncated = number.trunc().clamp(1_000.0, 1_800_000.0);
    Some(truncated as u64)
}

fn parse_exec_body(value: serde_json::Value) -> Result<ExecBody, (StatusCode, serde_json::Value)> {
    let command = value
        .get("command")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
        .unwrap_or_default();
    if command.trim().is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            serde_json::json!({"error": "command is required"}),
        ));
    }

    let Some(secret_values) = value.get("secrets").and_then(serde_json::Value::as_object) else {
        return Err((
            StatusCode::BAD_REQUEST,
            serde_json::json!({"error": "non-empty secrets map is required"}),
        ));
    };
    if secret_values.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            serde_json::json!({"error": "non-empty secrets map is required"}),
        ));
    }

    let mut secrets = std::collections::HashMap::new();
    for (name, secret) in secret_values {
        let Some(secret) = secret.as_str().filter(|value| !value.trim().is_empty()) else {
            return Err((
                StatusCode::BAD_REQUEST,
                serde_json::json!({"error": "non-empty secrets map is required"}),
            ));
        };
        secrets.insert(name.clone(), secret.to_string());
    }

    Ok(ExecBody {
        command,
        secrets,
        cwd: value
            .get("cwd")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string),
        timeout_ms: parse_secret_exec_timeout_ms(value.get("timeoutMs")),
    })
}

fn redact_output(text: &str, secret_values: &[String]) -> String {
    let mut redacted = text.to_string();
    for value in secret_values.iter().filter(|value| value.len() > 3) {
        redacted = redacted.replace(value, "[REDACTED]");
    }
    redacted
}

async fn run_secret_command(
    state: Arc<AppState>,
    body: ExecBody,
    timeout_ms: u64,
) -> Result<serde_json::Value, String> {
    let store = load_store(&state);

    // Resolve secrets to env vars
    let mut env: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    for (env_name, secret_name) in &body.secrets {
        match store.secrets.get(secret_name) {
            Some(entry) => {
                // Decode base64 (in production: decrypt)
                use base64::Engine;
                let decoded = base64::engine::general_purpose::STANDARD
                    .decode(&entry.ciphertext)
                    .ok()
                    .and_then(|b| String::from_utf8(b).ok())
                    .unwrap_or_default();
                env.insert(env_name.clone(), decoded);
            }
            None => {
                return Err(format!("secret not found: {secret_name}"));
            }
        }
    }
    let secret_values = env.values().cloned().collect::<Vec<_>>();

    // Run command with secrets as env vars. Uses execFile-style
    // argument passing to avoid shell expansion of secret values.
    let cwd = body.cwd.as_deref().unwrap_or(".");
    #[cfg(unix)]
    let mut cmd = tokio::process::Command::new("sh");
    #[cfg(unix)]
    cmd.args(["-c", &body.command]);
    #[cfg(windows)]
    let mut cmd = tokio::process::Command::new("cmd");
    #[cfg(windows)]
    cmd.args(["/C", &body.command]);
    let output = tokio::time::timeout(
        Duration::from_millis(timeout_ms),
        cmd.current_dir(cwd)
            .envs(&env)
            .env("SIGNET_NO_HOOKS", "1")
            .output(),
    )
    .await;

    match output {
        Ok(Ok(out)) => {
            let stdout = redact_output(&String::from_utf8_lossy(&out.stdout), &secret_values);
            let stderr = redact_output(&String::from_utf8_lossy(&out.stderr), &secret_values);
            let code = out.status.code().unwrap_or(-1);
            Ok(serde_json::json!({
                "stdout": stdout,
                "stderr": stderr,
                "code": code,
            }))
        }
        Ok(Err(e)) => Err(format!("subprocess failed: {e}")),
        Err(_) => Ok(serde_json::json!({
            "stdout": "",
            "stderr": format!("\n[signet secret exec: timed out after {timeout_ms}ms]\n"),
            "code": 124,
            "timedOut": true,
        })),
    }
}

async fn set_secret_exec_job(state: &AppState, job_id: &str, fields: serde_json::Value) {
    let mut jobs = state.secret_exec_jobs.write().await;
    let Some(job) = jobs.get_mut(job_id).and_then(|value| value.as_object_mut()) else {
        return;
    };
    if let Some(fields) = fields.as_object() {
        for (key, value) in fields {
            job.insert(key.clone(), value.clone());
        }
    }
}

pub(crate) async fn queue_secret_exec(
    state: Arc<AppState>,
    body: ExecBody,
) -> Result<serde_json::Value, (StatusCode, serde_json::Value)> {
    if body.command.trim().is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            serde_json::json!({"error": "command is required"}),
        ));
    }
    if body.secrets.is_empty() || body.secrets.values().any(|value| value.trim().is_empty()) {
        return Err((
            StatusCode::BAD_REQUEST,
            serde_json::json!({"error": "non-empty secrets map is required"}),
        ));
    }

    let id = uuid::Uuid::new_v4().to_string();
    let timeout_ms = normalize_secret_exec_timeout_ms(body.timeout_ms);
    let job = serde_json::json!({
        "id": id,
        "status": "queued",
        "createdAt": chrono::Utc::now().to_rfc3339(),
        "timeoutMs": timeout_ms,
    });
    state
        .secret_exec_jobs
        .write()
        .await
        .insert(id.clone(), job.clone());

    let worker_state = state.clone();
    tokio::spawn(async move {
        set_secret_exec_job(
            &worker_state,
            &id,
            serde_json::json!({
                "status": "running",
                "startedAt": chrono::Utc::now().to_rfc3339(),
            }),
        )
        .await;
        match run_secret_command(worker_state.clone(), body, timeout_ms).await {
            Ok(result) => {
                set_secret_exec_job(
                    &worker_state,
                    &id,
                    serde_json::json!({
                        "status": "completed",
                        "completedAt": chrono::Utc::now().to_rfc3339(),
                        "result": result,
                    }),
                )
                .await;
            }
            Err(error) => {
                set_secret_exec_job(
                    &worker_state,
                    &id,
                    serde_json::json!({
                        "status": "failed",
                        "completedAt": chrono::Utc::now().to_rfc3339(),
                        "error": error,
                    }),
                )
                .await;
            }
        }
    });

    Ok(job)
}

pub(crate) async fn secret_exec_status_value(
    state: &AppState,
    job_id: &str,
) -> Option<serde_json::Value> {
    state.secret_exec_jobs.read().await.get(job_id).cloned()
}

/// POST /api/secrets/exec — queue a command with secrets injected as env vars.
pub async fn run_with_secrets(
    State(state): State<Arc<AppState>>,
    bytes: Bytes,
) -> impl IntoResponse {
    let value = match serde_json::from_slice::<serde_json::Value>(&bytes) {
        Ok(value) => value,
        Err(error) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": error.to_string()})),
            );
        }
    };
    let body = match parse_exec_body(value) {
        Ok(body) => body,
        Err((status, body)) => return (status, Json(body)),
    };
    match queue_secret_exec(state, body).await {
        Ok(job) => (StatusCode::ACCEPTED, Json(job)),
        Err((status, body)) => (status, Json(body)),
    }
}

/// GET /api/secrets/exec/:jobId — inspect queued secret exec job status.
pub async fn exec_status(
    State(state): State<Arc<AppState>>,
    Path(job_id): Path<String>,
) -> impl IntoResponse {
    match secret_exec_status_value(&state, &job_id).await {
        Some(job) => (StatusCode::OK, Json(job)),
        None => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({
                "error": "secret exec job not found",
                "id": job_id,
            })),
        ),
    }
}

/// POST /api/secrets/:name/exec — queue command using a default secret mapping.
pub async fn run_named_secret(
    State(state): State<Arc<AppState>>,
    Path(name): Path<String>,
    Json(body): Json<serde_json::Value>,
) -> axum::response::Response {
    let command = body
        .get("command")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let Some(command) = command else {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "command is required"})),
        )
            .into_response();
    };
    let secrets = match body.get("secrets") {
        None => std::collections::HashMap::from([(name.clone(), name)]),
        Some(value) if value.is_object() => value
            .as_object()
            .unwrap()
            .iter()
            .filter_map(|(key, value)| {
                value
                    .as_str()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(|value| (key.clone(), value.to_string()))
            })
            .collect::<std::collections::HashMap<_, _>>(),
        _ => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"error": "non-empty secrets map is required"})),
            )
                .into_response();
        }
    };

    match queue_secret_exec(
        state,
        ExecBody {
            command: command.to_string(),
            secrets,
            cwd: body
                .get("cwd")
                .and_then(|value| value.as_str())
                .map(ToOwned::to_owned),
            timeout_ms: body.get("timeoutMs").and_then(|value| value.as_u64()),
        },
    )
    .await
    {
        Ok(job) => (StatusCode::ACCEPTED, Json(job)).into_response(),
        Err((status, body)) => (status, Json(body)).into_response(),
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn valid_secret_names() {
        assert!(valid_name("MY_SECRET"));
        assert!(valid_name("_private"));
        assert!(valid_name("key123"));
        assert!(!valid_name(""));
        assert!(!valid_name("123abc"));
        assert!(!valid_name("has-dash"));
        assert!(!valid_name("has.dot"));
    }

    #[test]
    fn default_store() {
        let store = SecretsStore::default();
        assert_eq!(store.version, 1);
        assert!(store.secrets.is_empty());
    }
}
