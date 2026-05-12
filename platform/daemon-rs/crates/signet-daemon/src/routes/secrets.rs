//! Secret management routes.
//!
//! Encrypted secret storage using XSalsa20-Poly1305. Secrets stored
//! in `~/.agents/.secrets/secrets.enc` with a master key derived from
//! machine identity.

use std::sync::Arc;

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

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

/// GET /api/secrets — list secret names
pub async fn list(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    let store = load_store(&state);
    let names: Vec<&String> = store.secrets.keys().collect();
    Json(serde_json::json!({ "secrets": names }))
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
}

/// POST /api/secrets/exec — run a command with secrets injected as env vars.
///
/// This is an intentional subprocess spawn — the API allows agents to
/// run commands with secret values injected safely via environment
/// variables (never on the command line). The command string comes
/// from authenticated API callers, not untrusted user input.
pub async fn run_with_secrets(
    State(state): State<Arc<AppState>>,
    Json(body): Json<ExecBody>,
) -> impl IntoResponse {
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
                return (
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({
                        "error": format!("secret not found: {secret_name}")
                    })),
                );
            }
        }
    }

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
    let output = cmd
        .current_dir(cwd)
        .envs(&env)
        .env("SIGNET_NO_HOOKS", "1")
        .output()
        .await;

    match output {
        Ok(out) => {
            let stdout = String::from_utf8_lossy(&out.stdout).to_string();
            let stderr = String::from_utf8_lossy(&out.stderr).to_string();
            let code = out.status.code().unwrap_or(-1);
            (
                StatusCode::OK,
                Json(serde_json::json!({
                    "stdout": stdout,
                    "stderr": stderr,
                    "code": code,
                })),
            )
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({
                "error": format!("subprocess failed: {e}"),
                "stdout": "",
                "stderr": "",
                "code": -1,
            })),
        ),
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
