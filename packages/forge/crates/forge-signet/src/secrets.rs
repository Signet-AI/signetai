use crate::client::SignetClient;
use forge_core::ForgeError;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use tokio::process::Command;
use tracing::debug;

/// API providers Forge supports directly.
const API_PROVIDERS: &[&str] = &["anthropic", "openai", "gemini", "groq", "openrouter", "xai"];

/// Local Forge credential file. This is separate from Signet secrets.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct LocalCredentials {
    #[serde(default)]
    api_keys: HashMap<String, String>,
    #[serde(default)]
    cli_env: HashMap<String, HashMap<String, String>>,
}

/// Where an API key / provider was found
#[derive(Debug, Clone, PartialEq)]
pub enum KeySource {
    /// Forge local credential file (platform config dir, e.g. ~/.config/forge or ~/Library/Application Support/forge)
    LocalStore,
    /// Signet daemon encrypted secret store
    Daemon,
    /// Process environment variable
    Environment,
    /// Installed CLI tool (no API key needed — CLI handles auth)
    Cli { path: String },
}

impl std::fmt::Display for KeySource {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            KeySource::LocalStore => write!(f, "forge"),
            KeySource::Daemon => write!(f, "daemon"),
            KeySource::Environment => write!(f, "env"),
            KeySource::Cli { .. } => write!(f, "cli"),
        }
    }
}

/// A provider that has an available API key or CLI tool
#[derive(Debug, Clone)]
pub struct DiscoveredProvider {
    pub provider: String,
    pub secret_name: String,
    pub source: KeySource,
}

/// Path to Forge's local credentials store.
pub fn credentials_path() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("forge")
        .join("credentials.json")
}

fn canonical_provider(provider: &str) -> &str {
    match provider {
        "google" => "gemini",
        _ => provider,
    }
}

fn provider_env_keys(provider: &str) -> &'static [&'static str] {
    match canonical_provider(provider) {
        "anthropic" => &["ANTHROPIC_API_KEY"],
        "openai" => &["OPENAI_API_KEY"],
        // Support both names for Google/Gemini APIs.
        "gemini" => &["GEMINI_API_KEY", "GOOGLE_API_KEY"],
        "groq" => &["GROQ_API_KEY"],
        "openrouter" => &["OPENROUTER_API_KEY"],
        "xai" => &["XAI_API_KEY"],
        _ => &[],
    }
}

fn cli_env_keys(provider: &str) -> &'static [&'static str] {
    match provider {
        "claude-cli" => &["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"],
        "codex-cli" => &[
            "CODEX_API_KEY",
            "OPENAI_API_KEY",
            "CODEX_AUTH_MODE",
            "CODEX_ACCESS_TOKEN",
            "CODEX_ID_TOKEN",
            "CODEX_REFRESH_TOKEN",
            "CODEX_ACCOUNT_ID",
        ],
        "gemini-cli" => &["GEMINI_API_KEY", "GOOGLE_API_KEY"],
        _ => &[],
    }
}

fn load_local_credentials() -> LocalCredentials {
    let path = credentials_path();
    if !path.exists() {
        return LocalCredentials::default();
    }
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_local_credentials(creds: &LocalCredentials) -> Result<(), ForgeError> {
    let path = credentials_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_string_pretty(creds)?;
    std::fs::write(&path, json)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

/// Store/update a provider API key in Forge's local credentials file.
pub fn store_local_api_key(provider: &str, api_key: &str) -> Result<(), ForgeError> {
    let provider = canonical_provider(provider);
    let key = api_key.trim();
    if key.is_empty() {
        return Err(ForgeError::config("API key cannot be empty"));
    }

    let mut creds = load_local_credentials();
    creds.api_keys.insert(provider.to_string(), key.to_string());
    save_local_credentials(&creds)
}

/// Remove a provider API key from Forge's local credentials file.
pub fn clear_local_api_key(provider: &str) -> Result<(), ForgeError> {
    let provider = canonical_provider(provider);
    let mut creds = load_local_credentials();
    creds.api_keys.remove(provider);
    save_local_credentials(&creds)
}

/// Store CLI auth environment variables for a provider in Forge local credentials.
pub fn store_local_cli_auth_env(
    provider: &str,
    env_vars: &HashMap<String, String>,
) -> Result<(), ForgeError> {
    let provider = canonical_provider(provider);
    let cleaned: HashMap<String, String> = env_vars
        .iter()
        .filter_map(|(k, v)| {
            let val = v.trim();
            if val.is_empty() {
                None
            } else {
                Some((k.clone(), val.to_string()))
            }
        })
        .collect();

    if cleaned.is_empty() {
        return Err(ForgeError::config("CLI auth token cannot be empty"));
    }

    let mut creds = load_local_credentials();
    creds.cli_env.insert(provider.to_string(), cleaned);
    save_local_credentials(&creds)
}

/// Remove locally stored CLI auth variables for a provider.
pub fn clear_local_cli_auth(provider: &str) -> Result<(), ForgeError> {
    let provider = canonical_provider(provider);
    let mut creds = load_local_credentials();
    creds.cli_env.remove(provider);
    save_local_credentials(&creds)
}

fn local_api_key(provider: &str) -> Option<String> {
    let provider = canonical_provider(provider);
    let creds = load_local_credentials();
    creds
        .api_keys
        .get(provider)
        .cloned()
        .filter(|v| !v.trim().is_empty())
}

fn local_cli_auth_env(provider: &str) -> Option<HashMap<String, String>> {
    let provider = canonical_provider(provider);
    let creds = load_local_credentials();
    creds.cli_env.get(provider).cloned().filter(|m| !m.is_empty())
}

/// Read provider API key from Forge local credentials, if present.
pub fn local_api_key_for_provider(provider: &str) -> Option<String> {
    local_api_key(provider)
}

/// Read CLI auth environment map from Forge local credentials, if present.
pub fn local_cli_auth_vars_for_provider(provider: &str) -> Option<HashMap<String, String>> {
    local_cli_auth_env(provider)
}

/// Apply stored CLI auth variables into this process environment.
/// Returns the number of env vars injected.
pub fn apply_local_cli_auth_env(provider: &str) -> usize {
    let provider = canonical_provider(provider);

    let Some(env_map) = local_cli_auth_env(provider) else {
        return 0;
    };

    // Clear known keys first to avoid stale values when switching token types.
    for key in cli_env_keys(provider) {
        std::env::remove_var(key);
    }

    let mut applied = 0usize;
    for (k, v) in env_map {
        if v.trim().is_empty() {
            continue;
        }
        std::env::set_var(&k, &v);
        applied += 1;
    }

    if provider == "codex-cli" {
        let _ = sync_codex_auth_file_from_env();
    }

    applied
}

fn codex_auth_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".codex")
        .join("auth.json")
}

fn codex_auth_file_has_tokens() -> bool {
    let path = codex_auth_path();
    let Ok(raw) = std::fs::read_to_string(path) else {
        return false;
    };
    let Ok(json) = serde_json::from_str::<Value>(&raw) else {
        return false;
    };
    let Some(tokens) = json.get("tokens").and_then(|v| v.as_object()) else {
        return false;
    };

    for key in ["access_token", "id_token", "refresh_token", "account_id"] {
        if tokens
            .get(key)
            .and_then(|v| v.as_str())
            .map(|v| !v.trim().is_empty())
            .unwrap_or(false)
        {
            return true;
        }
    }

    false
}

fn gemini_persisted_auth_exists() -> bool {
    let Some(home) = dirs::home_dir() else {
        return false;
    };

    let candidates = [
        home.join(".gemini").join("antigravity").join("installation_id"),
        home.join(".gemini")
            .join("antigravity-browser-profile")
            .join("Default")
            .join("Login Data"),
        home.join(".gemini")
            .join("antigravity-browser-profile")
            .join("Default")
            .join("Cookies"),
    ];

    candidates.iter().any(|path| path.exists())
}

fn sync_codex_auth_file_from_env() -> Result<(), ForgeError> {
    let auth_mode = std::env::var("CODEX_AUTH_MODE").ok();
    let access_token = std::env::var("CODEX_ACCESS_TOKEN").ok();
    let id_token = std::env::var("CODEX_ID_TOKEN").ok();
    let refresh_token = std::env::var("CODEX_REFRESH_TOKEN").ok();
    let account_id = std::env::var("CODEX_ACCOUNT_ID").ok();

    if auth_mode.as_deref().unwrap_or("").trim().is_empty()
        && access_token.as_deref().unwrap_or("").trim().is_empty()
        && id_token.as_deref().unwrap_or("").trim().is_empty()
        && refresh_token.as_deref().unwrap_or("").trim().is_empty()
        && account_id.as_deref().unwrap_or("").trim().is_empty()
    {
        return Ok(());
    }

    let mut tokens = Map::new();
    if let Some(value) = id_token.filter(|v| !v.trim().is_empty()) {
        tokens.insert("id_token".to_string(), Value::String(value));
    }
    if let Some(value) = access_token.filter(|v| !v.trim().is_empty()) {
        tokens.insert("access_token".to_string(), Value::String(value));
    }
    if let Some(value) = refresh_token.filter(|v| !v.trim().is_empty()) {
        tokens.insert("refresh_token".to_string(), Value::String(value));
    }
    if let Some(value) = account_id.filter(|v| !v.trim().is_empty()) {
        tokens.insert("account_id".to_string(), Value::String(value));
    }

    let mut root = Map::new();
    root.insert(
        "auth_mode".to_string(),
        Value::String(
            auth_mode
                .filter(|v| !v.trim().is_empty())
                .unwrap_or_else(|| "chatgpt".to_string()),
        ),
    );
    root.insert("OPENAI_API_KEY".to_string(), Value::Null);
    root.insert("tokens".to_string(), Value::Object(tokens));

    let path = codex_auth_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&path, serde_json::to_string_pretty(&Value::Object(root))?)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

/// List all secret names stored in the Signet daemon
pub async fn list_daemon_secrets(client: &SignetClient) -> Result<Vec<String>, ForgeError> {
    let resp = client.get("/api/secrets").await?;
    let secrets = resp
        .get("secrets")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    Ok(secrets)
}

async fn resolve_daemon_secret_value(
    client: &SignetClient,
    secret_name: &str,
) -> Result<Option<String>, ForgeError> {
    let body = serde_json::json!({
        "command": format!("printenv {secret_name}"),
        "secrets": {
            secret_name: secret_name,
        }
    });

    let result = client.post("/api/secrets/exec", &body).await?;
    let code = result.get("code").and_then(|v| v.as_i64()).unwrap_or(-1);
    let stdout = result
        .get("stdout")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();

    if code == 0 && !stdout.is_empty() {
        Ok(Some(stdout))
    } else {
        Ok(None)
    }
}

/// Import API keys from Signet secrets into Forge's local credential store.
/// Existing local Forge keys are preserved.
pub async fn sync_local_api_keys_from_daemon(
    client: &SignetClient,
) -> Result<Vec<DiscoveredProvider>, ForgeError> {
    let daemon_secrets = list_daemon_secrets(client).await?;
    let mut imported = Vec::new();

    for provider in API_PROVIDERS {
        if local_api_key(provider).is_some() {
            continue;
        }

        let matched = provider_env_keys(provider)
            .iter()
            .find(|key| daemon_secrets.iter().any(|s| s == **key));

        let Some(secret_name) = matched else {
            continue;
        };

        let Some(secret_value) = resolve_daemon_secret_value(client, secret_name).await? else {
            continue;
        };

        store_local_api_key(provider, &secret_value)?;
        imported.push(DiscoveredProvider {
            provider: (*provider).to_string(),
            secret_name: (*secret_name).to_string(),
            source: KeySource::Daemon,
        });
    }

    Ok(imported)
}

/// Ask the Signet daemon to refresh its model registry.
pub async fn refresh_daemon_model_registry(client: &SignetClient) -> Result<(), ForgeError> {
    let _ = client
        .post("/api/pipeline/models/refresh", &serde_json::json!({}))
        .await?;
    Ok(())
}

async fn detect_cli_auth(provider_name: &str, binary: &str) -> Option<String> {
    if local_cli_auth_env(provider_name).is_some() {
        return Some("token saved".to_string());
    }

    match provider_name {
        "claude-cli" => {
            let output = Command::new(binary)
                .args(["auth", "status", "--json"])
                .output()
                .await
                .ok()?;
            if !output.status.success() {
                return None;
            }
            let status = serde_json::from_slice::<Value>(&output.stdout).ok()?;
            if status
                .get("loggedIn")
                .and_then(|v| v.as_bool())
                .unwrap_or(false)
            {
                Some("logged in".to_string())
            } else {
                None
            }
        }
        "codex-cli" => {
            if codex_auth_file_has_tokens() {
                return Some("logged in".to_string());
            }

            let output = Command::new(binary)
                .args(["login", "status"])
                .output()
                .await
                .ok()?;
            if !output.status.success() {
                return None;
            }
            let stdout = String::from_utf8_lossy(&output.stdout).to_lowercase();
            if stdout.contains("logged in") {
                Some("logged in".to_string())
            } else {
                None
            }
        }
        "gemini-cli" => {
            if gemini_persisted_auth_exists() {
                return Some("logged in".to_string());
            }

            for env_name in cli_env_keys(provider_name) {
                if std::env::var(env_name)
                    .ok()
                    .filter(|v| !v.trim().is_empty())
                    .is_some()
                {
                    return Some("env key".to_string());
                }
            }
            None
        }
        _ => None,
    }
}

/// Discover all providers available — daemon secrets, env vars, and installed CLI tools.
pub async fn discover_available_providers(
    client: Option<&SignetClient>,
) -> Vec<DiscoveredProvider> {
    let mut found = Vec::new();
    let mut seen = HashSet::new();

    // 1. Environment variables (highest precedence; easy to override per shell)
    for provider in API_PROVIDERS {
        for env_name in provider_env_keys(provider) {
            if let Ok(val) = std::env::var(env_name) {
                if !val.trim().is_empty() {
                    debug!("Found {env_name} in environment for {provider}");
                    found.push(DiscoveredProvider {
                        provider: provider.to_string(),
                        secret_name: env_name.to_string(),
                        source: KeySource::Environment,
                    });
                    seen.insert(provider.to_string());
                    break;
                }
            }
        }
    }

    // 2. Forge local credential store (provider -> api key)
    for provider in API_PROVIDERS {
        if seen.contains(*provider) {
            continue;
        }
        if local_api_key(provider).is_some() {
            found.push(DiscoveredProvider {
                provider: provider.to_string(),
                secret_name: provider_to_secret_name(provider),
                source: KeySource::LocalStore,
            });
            seen.insert(provider.to_string());
        }
    }

    // 3. Signet daemon secret store (optional fallback)
    if let Some(client) = client {
        match list_daemon_secrets(client).await {
            Ok(daemon_secrets) => {
                for provider in API_PROVIDERS {
                    if seen.contains(*provider) {
                        continue;
                    }
                    let matched = provider_env_keys(provider)
                        .iter()
                        .find(|key| daemon_secrets.iter().any(|s| s == **key));
                    if let Some(secret_name) = matched {
                        debug!("Found {secret_name} in daemon for {provider}");
                        found.push(DiscoveredProvider {
                            provider: provider.to_string(),
                            secret_name: (*secret_name).to_string(),
                            source: KeySource::Daemon,
                        });
                        seen.insert(provider.to_string());
                    }
                }
            }
            Err(e) => {
                debug!("Could not list daemon secrets: {e}");
            }
        }
    }

    // 4. Detect installed + authenticated CLI tools
    let cli_checks: &[(&str, &str)] = &[
        ("claude-cli", "claude"),
        ("codex-cli", "codex"),
        ("gemini-cli", "gemini"),
    ];

    for (provider_name, binary) in cli_checks {
        if let Ok(output) = tokio::process::Command::new("which")
            .arg(binary)
            .output()
            .await
        {
            if output.status.success() {
                let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if !path.is_empty() {
                    if let Some(auth_tag) = detect_cli_auth(provider_name, binary).await {
                        debug!("Found authenticated CLI tool: {binary} at {path}");
                        found.push(DiscoveredProvider {
                            provider: provider_name.to_string(),
                            secret_name: format!("{binary} ({auth_tag})"),
                            source: KeySource::Cli { path },
                        });
                    }
                }
            }
        }
    }

    // 5. Ollama is always available (local, no key)
    if !seen.contains("ollama") {
        found.push(DiscoveredProvider {
            provider: "ollama".to_string(),
            secret_name: String::new(),
            source: KeySource::Environment,
        });
    }

    found
}

/// Resolve the actual API key value for a provider.
/// Checks environment first (fastest), then daemon secret store.
pub async fn resolve_api_key(
    client: Option<&SignetClient>,
    provider: &str,
) -> Result<String, ForgeError> {
    let provider = canonical_provider(provider);

    if provider == "ollama" {
        return Ok(String::new());
    }

    // CLI providers don't need API keys
    if provider.ends_with("-cli") {
        return Ok(String::new());
    }

    // 1) Environment variables
    for env_name in provider_env_keys(provider) {
        if let Ok(key) = std::env::var(env_name) {
            if !key.trim().is_empty() {
                debug!("Resolved {env_name} from environment");
                return Ok(key);
            }
        }
    }

    // 2) Forge local credential store
    if let Some(key) = local_api_key(provider) {
        debug!("Resolved {} from local Forge credentials", provider);
        return Ok(key);
    }

    // 3) Signet daemon secret store — optional fallback
    if let Some(client) = client {
        for env_name in provider_env_keys(provider) {
            let env_name = *env_name;
            match resolve_daemon_secret_value(client, env_name).await {
                Ok(Some(secret)) => {
                    debug!("Resolved {env_name} from daemon secret store");
                    return Ok(secret);
                }
                Ok(None) => {
                    debug!("Daemon secret empty or unavailable for {env_name}");
                }
                Err(e) => {
                    debug!("Daemon secret exec failed for {env_name}: {e}");
                }
            }
        }
    }

    Err(ForgeError::ApiKeyMissing(format!(
        "No API key found for {provider} ({})",
        provider_to_secret_name(provider)
    )))
}

/// Map provider name to its expected secret/env var name
pub fn provider_to_secret_name(provider: &str) -> String {
    if let Some(name) = provider_env_keys(provider).first() {
        return (*name).to_string();
    }
    format!("{}_API_KEY", provider.to_uppercase())
}

/// Default model for each provider
pub fn default_model_for_provider(provider: &str) -> &'static str {
    match provider {
        "anthropic" | "claude-cli" => "claude-sonnet-4-6",
        "openai" => "gpt-4o",
        "codex-cli" => "gpt-5.4",
        "gemini" | "google" | "gemini-cli" => "gemini-2.5-flash",
        "groq" => "llama-3.3-70b-versatile",
        "ollama" => "qwen3:4b",
        "openrouter" => "anthropic/claude-sonnet-4-6",
        "xai" => "grok-3",
        _ => "claude-sonnet-4-6",
    }
}
