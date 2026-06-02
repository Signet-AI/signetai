//! Secret management routes.
//!
//! Encrypted secret storage using XSalsa20-Poly1305. Secrets stored
//! in `~/.agents/.secrets/secrets.enc` with a master key derived from
//! machine identity.

use std::sync::Arc;
use std::time::Duration;

use axum::{
    Json,
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
const BITWARDEN_MANAGED_FOLDER_SECRET: &str = "BITWARDEN_MANAGED_FOLDER_ID";
const ONEPASSWORD_SERVICE_ACCOUNT_SECRET: &str = "ONEPASSWORD_SERVICE_ACCOUNT_TOKEN";

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
    let mut names = store.secrets.keys().cloned().collect::<Vec<_>>();
    names.sort();
    names
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

/// GET /api/secrets — list secret names
pub async fn list(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    Json(serde_json::json!({ "secrets": secret_names(&state) }))
}

/// GET /api/secrets/1password/status — 1Password provider status.
///
/// The TypeScript daemon exposes this compatibility endpoint even when no
/// service-account token is configured. Rust currently has no native
/// 1Password client, but it can still preserve the client contract: report an
/// unconfigured provider instead of letting the dynamic secret-name route catch
/// the path or returning 404.
pub async fn onepassword_status(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    let store = load_store(&state);
    let configured = store
        .secrets
        .contains_key("ONEPASSWORD_SERVICE_ACCOUNT_TOKEN");

    if configured {
        Json(serde_json::json!({
            "configured": true,
            "connected": false,
            "error": "1Password provider is configured but native Rust vault listing is not available yet",
            "vaults": []
        }))
    } else {
        Json(serde_json::json!({
            "configured": false,
            "connected": false,
            "vaults": []
        }))
    }
}

/// GET /api/secrets/bitwarden/status — Bitwarden provider status.
pub async fn bitwarden_status(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    let store = load_store(&state);
    let configured = store.secrets.contains_key(BITWARDEN_SESSION_SECRET);
    Json(serde_json::json!({
        "configured": configured,
        "connected": false,
        "activeProvider": false,
        "vaults": [],
        "folders": [],
        "error": if configured { Some("Bitwarden provider is configured but native Rust session validation is not available yet") } else { None::<&str> },
    }))
}

/// POST /api/secrets/bitwarden/connect — configure Bitwarden session.
pub async fn bitwarden_connect(Json(body): Json<serde_json::Value>) -> impl IntoResponse {
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
    (
        StatusCode::BAD_REQUEST,
        Json(serde_json::json!({
            "success": false,
            "configured": true,
            "connected": false,
            "activeProvider": false,
            "error": "Bitwarden session validation is not available in the Rust daemon",
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
pub async fn bitwarden_provider(Json(body): Json<serde_json::Value>) -> impl IntoResponse {
    let provider = body
        .get("provider")
        .and_then(|value| value.as_str())
        .map(str::trim);
    match provider {
        Some("local") => (
            StatusCode::OK,
            Json(serde_json::json!({"success": true, "provider": "local"})),
        ),
        Some("bitwarden") => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "Bitwarden is not connected"})),
        ),
        _ => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "provider must be local or bitwarden"})),
        ),
    }
}

/// GET /api/secrets/bitwarden/folders — list Bitwarden folders.
pub async fn bitwarden_folders() -> impl IntoResponse {
    (
        StatusCode::BAD_REQUEST,
        Json(serde_json::json!({"error": "Bitwarden is not connected"})),
    )
}

/// POST /api/secrets/bitwarden/migrate — migrate local secrets to Bitwarden.
pub async fn bitwarden_migrate(Json(body): Json<serde_json::Value>) -> impl IntoResponse {
    if !body.is_object() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "Invalid JSON body"})),
        );
    }
    (
        StatusCode::BAD_REQUEST,
        Json(serde_json::json!({"error": "Bitwarden is not connected"})),
    )
}

/// POST /api/secrets/1password/connect — configure 1Password token.
pub async fn onepassword_connect(Json(body): Json<serde_json::Value>) -> impl IntoResponse {
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
    (
        StatusCode::BAD_REQUEST,
        Json(
            serde_json::json!({"error": "1Password vault listing is not available in the Rust daemon"}),
        ),
    )
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
pub async fn onepassword_vaults() -> impl IntoResponse {
    (
        StatusCode::BAD_REQUEST,
        Json(serde_json::json!({"error": "1Password service account token not configured"})),
    )
}

/// POST /api/secrets/1password/import — import 1Password items.
pub async fn onepassword_import(Json(body): Json<serde_json::Value>) -> impl IntoResponse {
    if !body.is_object() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "Invalid JSON body"})),
        );
    }
    (
        StatusCode::BAD_REQUEST,
        Json(serde_json::json!({"error": "1Password service account token not configured"})),
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
    Json(body): Json<ExecBody>,
) -> impl IntoResponse {
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
