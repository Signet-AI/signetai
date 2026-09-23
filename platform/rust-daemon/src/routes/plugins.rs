use crate::{routes::auth, ApiError, AppState};
use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    routing::{get, patch, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    fs::OpenOptions,
    io::{Read, Seek, SeekFrom, Write},
    path::PathBuf,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

#[derive(Deserialize, Default)]
struct AuditQuery {
    plugin_id: Option<String>,
    event: Option<String>,
    since: Option<String>,
    until: Option<String>,
    limit: Option<usize>,
}
#[derive(Deserialize)]
struct Update {
    enabled: bool,
}

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/api/plugins", get(list))
        .route("/api/plugins/prompt-contributions", get(prompts))
        .route("/api/plugins/audit", get(audit))
        .route("/api/plugins/{id}/diagnostics", get(diagnostics))
        .route("/api/plugins/{id}", get(detail).patch(update))
        .route("/api/marketplace/mcp", get(list_marketplace))
        .route(
            "/api/marketplace/mcp/policy",
            get(get_policy).patch(patch_policy),
        )
        .route("/api/marketplace/mcp/browse", get(unsupported_marketplace))
        .route("/api/marketplace/mcp/detail", get(unsupported_marketplace))
        .route("/api/marketplace/mcp/test", post(unsupported_marketplace))
        .route("/api/marketplace/mcp/install", post(install_marketplace))
        .route(
            "/api/marketplace/mcp/register",
            post(unsupported_marketplace),
        )
        .route("/api/marketplace/mcp/tools", get(unsupported_marketplace))
        .route("/api/marketplace/mcp/search", get(unsupported_marketplace))
        .route("/api/marketplace/mcp/call", post(unsupported_marketplace))
        .route(
            "/api/marketplace/mcp/read-resource",
            post(unsupported_marketplace),
        )
        .route(
            "/api/marketplace/mcp/{id}",
            get(unsupported_marketplace)
                .patch(unsupported_marketplace)
                .delete(unsupported_marketplace),
        )
        .route(
            "/api/marketplace/reviews",
            get(unsupported_marketplace).post(unsupported_marketplace),
        )
        .route(
            "/api/marketplace/reviews/config",
            get(unsupported_marketplace).patch(unsupported_marketplace),
        )
        .route(
            "/api/marketplace/reviews/sync",
            post(unsupported_marketplace),
        )
        .route(
            "/api/marketplace/reviews/{id}",
            patch(unsupported_marketplace).delete(unsupported_marketplace),
        )
}

fn now() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
        .to_string()
}
fn iso_now() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".into())
}
fn registry_path(state: &AppState) -> PathBuf {
    state.workspace.join(".daemon/plugins/registry-v1.json")
}
fn audit_path(state: &AppState) -> PathBuf {
    state.workspace.join(".daemon/plugins/audit-v1.ndjson")
}
fn valid_semver(version: &str) -> bool {
    let (without_build, build) = match version.split_once('+') {
        Some((core, build)) => (core, Some(build)),
        None => (version, None),
    };
    let (core, prerelease) = match without_build.split_once('-') {
        Some((core, prerelease)) => (core, Some(prerelease)),
        None => (without_build, None),
    };
    let core_parts: Vec<&str> = core.split('.').collect();
    if core_parts.len() != 3
        || core_parts.iter().any(|part| {
            part.is_empty()
                || (part.len() > 1 && part.starts_with('0'))
                || !part.bytes().all(|b| b.is_ascii_digit())
        })
    {
        return false;
    }
    let valid_identifiers = |value: &str, prerelease: bool| {
        !value.is_empty()
            && value.split('.').all(|identifier| {
                !identifier.is_empty()
                    && identifier
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'-')
                    && (!prerelease
                        || !identifier.bytes().all(|b| b.is_ascii_digit())
                        || identifier.len() == 1
                        || !identifier.starts_with('0'))
            })
    };
    prerelease.is_none_or(|value| valid_identifiers(value, true))
        && build.is_none_or(|value| valid_identifiers(value, false))
}

fn valid_prompt_budget(value: &Value, minimum: f64) -> bool {
    value
        .as_f64()
        .is_some_and(|number| number.is_finite() && number >= minimum)
}

fn valid_record(id: &str, value: &Value) -> bool {
    if !matches!(id, "signet-secrets" | "signet-graphiq") || !value.is_object() {
        return false;
    }
    let object = value.as_object().unwrap();
    let allowed = [
        "id",
        "name",
        "version",
        "publisher",
        "description",
        "runtime",
        "compatibility",
        "trustTier",
        "capabilities",
        "surfaces",
        "docs",
        "promptContributions",
        "source",
        "enabled",
        "state",
        "stateReason",
        "declaredCapabilities",
        "grantedCapabilities",
        "pendingCapabilities",
        "health",
        "installedAt",
        "updatedAt",
    ];
    if object.keys().any(|key| !allowed.contains(&key.as_str())) {
        return false;
    }
    for key in ["enabled", "installedAt", "updatedAt"] {
        let Some(v) = object.get(key) else {
            return false;
        };
        let valid = match key {
            "enabled" => v.is_boolean(),
            _ => v.is_string(),
        };
        if !valid {
            return false;
        }
    }
    let manifest_keys = [
        "id",
        "name",
        "version",
        "publisher",
        "description",
        "runtime",
        "compatibility",
        "trustTier",
        "capabilities",
        "surfaces",
        "docs",
        "promptContributions",
    ];
    let has_manifest = object
        .keys()
        .any(|key| manifest_keys.contains(&key.as_str()));
    if has_manifest {
        if manifest_keys.iter().any(|key| !object.contains_key(*key)) || object["id"] != id {
            return false;
        }
        if !object["id"].is_string()
            || !object["name"].is_string()
            || !object["version"].is_string()
            || !valid_semver(object["version"].as_str().unwrap_or(""))
            || !object["publisher"].is_string()
            || !object["description"].is_string()
            || !object["runtime"].is_object()
            || !object["compatibility"].is_object()
            || !object["trustTier"].is_string()
            || !object["capabilities"].is_array()
            || !object["surfaces"].is_object()
            || !object["docs"].is_object()
            || !object["promptContributions"].is_array()
        {
            return false;
        }
        if object["promptContributions"]
            .as_array()
            .is_some_and(|items| {
                items.iter().any(|item| {
                    !item.is_object()
                        || !valid_prompt_budget(item.get("maxTokens").unwrap_or(&Value::Null), 1.0)
                        || !valid_prompt_budget(item.get("priority").unwrap_or(&Value::Null), 0.0)
                })
            })
        {
            return false;
        }
    }
    true
}
fn load(state: &AppState) -> Result<Value, ApiError> {
    let path = registry_path(state);
    match fs::read_to_string(path) {
        Ok(s) => {
            let value: Value = serde_json::from_str(&s).map_err(|_| ApiError {
                status: StatusCode::CONFLICT,
                code: "invalid_registry",
                message: "plugin registry is malformed".into(),
            })?;
            let valid = value.get("version").and_then(Value::as_u64) == Some(1)
                && value
                    .get("plugins")
                    .and_then(Value::as_object)
                    .is_some_and(|plugins| {
                        plugins.iter().all(|(id, plugin)| valid_record(id, plugin))
                    });
            if valid {
                Ok(value)
            } else {
                Err(ApiError {
                    status: StatusCode::CONFLICT,
                    code: "invalid_registry",
                    message: "plugin registry shape is invalid".into(),
                })
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(json!({"version":1,"plugins":{}})),
        Err(e) => Err(ApiError::internal(e.to_string())),
    }
}
fn save(state: &AppState, value: &Value) -> Result<(), ApiError> {
    let path = registry_path(state);
    let parent = path.parent().unwrap();
    fs::create_dir_all(parent).map_err(|e| ApiError::internal(e.to_string()))?;
    let bytes = serde_json::to_vec_pretty(value).map_err(|e| ApiError::internal(e.to_string()))?;
    let mut tmp = None;
    for n in 0..16u32 {
        let candidate = parent.join(format!(
            ".registry-v1.json.tmp-{}-{}",
            std::process::id(),
            n
        ));
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(mut f) => {
                f.write_all(&bytes)
                    .and_then(|_| f.sync_all())
                    .map_err(|e| {
                        let _ = fs::remove_file(&candidate);
                        ApiError::internal(e.to_string())
                    })?;
                tmp = Some(candidate);
                break;
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(ApiError::internal(e.to_string())),
        }
    }
    let tmp =
        tmp.ok_or_else(|| ApiError::internal("could not allocate registry temporary file"))?;
    fs::rename(&tmp, &path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        ApiError::internal(e.to_string())
    })?;
    #[cfg(unix)]
    {
        fs::File::open(parent)
            .and_then(|f| f.sync_all())
            .map_err(|e| ApiError::internal(e.to_string()))?;
    }
    Ok(())
}
fn surfaces(id: &str) -> Value {
    if id == "signet-secrets" {
        json!({"daemonRoutes":[{"method":"GET","path":"/api/secrets","summary":"List stored local secret names","requiredCapabilities":["secrets:list"]}],"cliCommands":[],"mcpTools":[],"dashboardPanels":[],"sdkClients":[],"connectorCapabilities":[],"promptContributions":[]})
    } else {
        json!({"daemonRoutes":[],"cliCommands":[{"path":["graphiq","status"],"summary":"Show GraphIQ status","requiredCapabilities":["cli:command","code:status"]}],"mcpTools":[{"name":"signet_code_search","title":"Search Code","summary":"Search indexed code","requiredCapabilities":["mcp:tool","code:search"]}],"dashboardPanels":[],"sdkClients":[],"connectorCapabilities":[],"promptContributions":[{"id":"signet.graphiq.code-retrieval-guidance","target":"user-prompt-submit","mode":"context","priority":430,"maxTokens":100,"summary":"Advise agents to use GraphIQ","requiredCapabilities":["prompt:contribute:user-prompt-submit"]}]})
    }
}
fn manifest(id: &str) -> Value {
    let (name, publisher, version, capabilities) = if id == "signet-secrets" {
        (
            "Signet Secrets",
            "signet",
            "1.0.0",
            json!([
                "secrets:list",
                "secrets:write",
                "secrets:delete",
                "secrets:exec",
                "prompt:contribute:user-prompt-submit"
            ]),
        )
    } else {
        (
            "GraphIQ Code Retrieval",
            "aaf2tbz",
            "1.0.0",
            json!([
                "code:search",
                "code:status",
                "cli:command",
                "mcp:tool",
                "prompt:contribute:user-prompt-submit"
            ]),
        )
    };
    json!({"id":id,"name":name,"version":version,"publisher":publisher,"description":"Bundled native registry manifest","runtime":{"language":"typescript","kind":"host-managed"},"compatibility":{"signet":">=0.103.0 <1.0.0","pluginApi":"1.x"},"trustTier":if id=="signet-secrets"{"core"}else{"verified"},"capabilities":capabilities,"surfaces":surfaces(id),"docs":{"capabilities":{}},"promptContributions":[]})
}
fn records(state: &AppState) -> Result<Vec<Value>, ApiError> {
    let persisted = load(state)?;
    Ok(["signet-secrets", "signet-graphiq"].into_iter().map(|id| {
        let old = persisted.get("plugins").and_then(|p| p.get(id)); let enabled = old.and_then(|x| x.get("enabled")).and_then(Value::as_bool).unwrap_or(true); let t = old.and_then(|x| x.get("installedAt")).and_then(Value::as_str).unwrap_or("0"); let caps = manifest(id).get("capabilities").cloned().unwrap_or(json!([]));
        json!({"id":id,"name":manifest(id)["name"],"version":"1.0.0","publisher":manifest(id)["publisher"],"source":"bundled","trustTier":manifest(id)["trustTier"],"enabled":enabled,"state":if enabled{"active"}else{"disabled"},"stateReason":if enabled {Value::Null}else{json!("disabled by host policy")},"declaredCapabilities":caps,"grantedCapabilities":if enabled{caps}else{json!([])},"pendingCapabilities":[],"surfaces":if enabled{surfaces(id)}else{json!({})},"health":{"status":"healthy","checkedAt":now()},"installedAt":t,"updatedAt":now()})
    }).collect())
}
async fn gate(s: &AppState, h: &HeaderMap) -> Result<(), ApiError> {
    let c = auth::gate(s, h).await?;
    if c.get("role").and_then(Value::as_str) == Some("admin")
        || c.get("permissions")
            .and_then(Value::as_array)
            .is_some_and(|p| p.iter().any(|x| x.as_str() == Some("plugin:admin")))
    {
        Ok(())
    } else {
        Err(ApiError {
            status: StatusCode::FORBIDDEN,
            code: "forbidden",
            message: "plugin admin authority required".into(),
        })
    }
}
#[derive(Deserialize)]
struct MarketplaceInstallRequest {
    id: String,
    source: Option<String>,
    alias: Option<String>,
    config: Option<Value>,
    scope: Option<Value>,
}

fn marketplace_state_path(state: &AppState) -> PathBuf {
    state.workspace.join("marketplace/mcp-servers.json")
}
fn marketplace_lock_path(state: &AppState) -> PathBuf {
    state.workspace.join("marketplace/mcp-servers.lock")
}

struct MarketplaceFileLock(PathBuf);
impl Drop for MarketplaceFileLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}
fn acquire_marketplace_lock(state: &AppState) -> Result<MarketplaceFileLock, ApiError> {
    let path = marketplace_lock_path(state);
    fs::create_dir_all(path.parent().unwrap()).map_err(|e| ApiError::internal(e.to_string()))?;
    for _ in 0..200 {
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(_) => return Ok(MarketplaceFileLock(path)),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                std::thread::sleep(Duration::from_millis(5))
            }
            Err(e) => return Err(ApiError::internal(e.to_string())),
        }
    }
    Err(ApiError {
        status: StatusCode::CONFLICT,
        code: "marketplace_busy",
        message: "marketplace state is locked".into(),
    })
}
fn atomic_write_json(path: &std::path::Path, value: &Value) -> Result<(), ApiError> {
    let parent = path.parent().unwrap();
    fs::create_dir_all(parent).map_err(|e| ApiError::internal(e.to_string()))?;
    let tmp = parent.join(format!(
        ".{}.tmp-{}",
        path.file_name().unwrap().to_string_lossy(),
        uuid::Uuid::new_v4()
    ));
    let bytes = serde_json::to_vec_pretty(value).map_err(|e| ApiError::internal(e.to_string()))?;
    let mut f = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&tmp)
        .map_err(|e| ApiError::internal(e.to_string()))?;
    f.write_all(&bytes)
        .and_then(|_| f.sync_all())
        .map_err(|e| ApiError::internal(e.to_string()))?;
    replace_file(&tmp, path).map_err(|e| ApiError::internal(e.to_string()))
}
fn valid_catalog_source(source: &str) -> bool {
    matches!(
        source,
        "mcpservers.org" | "modelcontextprotocol/servers" | "github"
    )
}
fn idempotency_matches(v: &Value, key: &str, fingerprint: &str) -> bool {
    v.get("key").and_then(Value::as_str) == Some(key)
        && v.get("fingerprint").and_then(Value::as_str) == Some(fingerprint)
}
fn idempotency_path(state: &AppState) -> PathBuf {
    state.workspace.join("marketplace/mcp-idempotency-v1.json")
}
fn load_idempotency(state: &AppState) -> Result<Vec<Value>, ApiError> {
    match bounded_json(&idempotency_path(state))? {
        None => Ok(Vec::new()),
        Some(v) => v.as_array().cloned().ok_or_else(|| ApiError {
            status: StatusCode::CONFLICT,
            code: "invalid_marketplace_idempotency",
            message: "marketplace idempotency state is malformed".into(),
        }),
    }
}
fn remember_idempotency(
    state: &AppState,
    key: &str,
    fingerprint: &str,
    response: &Value,
) -> Result<(), ApiError> {
    let mut entries = load_idempotency(state)?;
    entries.retain(|v| {
        v.get("createdAt").and_then(Value::as_u64).unwrap_or(0) + 86400
            > SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs()
    });
    entries.retain(|v| v.get("key").and_then(Value::as_str) != Some(key));
    entries.push(json!({"key":key,"fingerprint":fingerprint,"response":response,"createdAt":SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs()}));
    if entries.len() > 256 {
        entries.drain(..entries.len() - 256);
    }
    atomic_write_json(&idempotency_path(state), &json!(entries))
}

fn replace_file(tmp: &std::path::Path, path: &std::path::Path) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{
            MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
        };
        let from: Vec<u16> = tmp.as_os_str().encode_wide().chain(Some(0)).collect();
        let to: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        if unsafe {
            MoveFileExW(
                from.as_ptr(),
                to.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        } == 0
        {
            return Err(std::io::Error::last_os_error());
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        fs::rename(tmp, path)
    }
}

fn install_fingerprint(request: &MarketplaceInstallRequest) -> String {
    let value = json!({"id":request.id,"source":request.source,"alias":request.alias,"config":request.config,"scope":request.scope});
    let mut hasher = Sha256::new();
    hasher.update(serde_json::to_vec(&value).expect("fingerprint serialization cannot fail"));
    format!("{:x}", hasher.finalize())
}

fn install_deadline(headers: &HeaderMap) -> Result<(), ApiError> {
    if let Some(raw) = headers
        .get("x-signet-deadline-ms")
        .and_then(|v| v.to_str().ok())
    {
        let deadline = raw.parse::<u128>().map_err(|_| ApiError {
            status: StatusCode::BAD_REQUEST,
            code: "invalid_deadline",
            message: "x-signet-deadline-ms must be epoch milliseconds".into(),
        })?;
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        if deadline <= now {
            return Err(ApiError {
                status: StatusCode::REQUEST_TIMEOUT,
                code: "deadline_exceeded",
                message: "marketplace install deadline exceeded before mutation".into(),
            });
        }
    }
    Ok(())
}

fn normalize_scope(value: Option<&Value>) -> Value {
    fn dim(value: Option<&Value>, workspace: bool) -> Value {
        let mut out = Vec::<String>::new();
        let mut seen = std::collections::HashSet::new();
        if let Some(Value::Array(items)) = value {
            for item in items {
                let Some(raw) = item.as_str() else { continue };
                let mut s = raw.trim().replace('\\', "/");
                if workspace {
                    while s.ends_with('/') {
                        s.pop();
                    }
                }
                if s.is_empty() {
                    continue;
                }
                let key = s.to_ascii_lowercase();
                if seen.insert(key) {
                    out.push(s);
                }
            }
        }
        json!(out)
    }
    json!({"harnesses":dim(value.and_then(|v|v.get("harnesses")), false), "workspaces":dim(value.and_then(|v|v.get("workspaces")), true), "channels":dim(value.and_then(|v|v.get("channels")), false)})
}

fn valid_install_config(config: &Value) -> bool {
    let Some(o) = config.as_object() else {
        return false;
    };
    if o.keys().any(|k| {
        ![
            "transport",
            "command",
            "args",
            "env",
            "cwd",
            "timeoutMs",
            "url",
            "headers",
        ]
        .contains(&k.as_str())
    }) {
        return false;
    }
    let timeout = o
        .get("timeoutMs")
        .and_then(Value::as_u64)
        .is_some_and(|n| n > 0 && n <= 300_000);
    match o.get("transport").and_then(Value::as_str) {
        Some("stdio") => {
            o.get("command")
                .and_then(Value::as_str)
                .is_some_and(|s| !s.trim().is_empty())
                && o.get("args").is_some_and(Value::is_array)
                && o.get("env").is_some_and(Value::is_object)
                && timeout
        }
        Some("http") => {
            o.get("url")
                .and_then(Value::as_str)
                .is_some_and(|s| s.starts_with("http://") || s.starts_with("https://"))
                && o.get("headers").is_some_and(Value::is_object)
                && timeout
        }
        _ => false,
    }
}

async fn install_marketplace(
    State(s): State<AppState>,
    h: HeaderMap,
    Json(request): Json<MarketplaceInstallRequest>,
) -> Result<Json<Value>, ApiError> {
    gate(&s, &h).await?;
    install_deadline(&h)?;
    if request.id.trim().is_empty() || request.id.contains("..") || request.id.starts_with('/') {
        return Err(ApiError {
            status: StatusCode::BAD_REQUEST,
            code: "invalid_catalog_id",
            message: "id must be a non-empty scoped catalog identifier".into(),
        });
    }
    let config = request.config.clone().ok_or_else(|| ApiError { status: StatusCode::UNPROCESSABLE_ENTITY, code: "config_required", message: "fresh native marketplace install requires a direct MCP config; catalog provider is unavailable".into() })?;
    if !valid_install_config(&config) {
        return Err(ApiError {
            status: StatusCode::BAD_REQUEST,
            code: "invalid_config",
            message: "config must include command or http(s) url".into(),
        });
    }
    let key = h
        .get("idempotency-key")
        .or_else(|| h.get("x-signet-operation-id"))
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .trim()
        .to_owned();
    let _lock = acquire_marketplace_lock(&s)?;
    let path = marketplace_state_path(&s);
    let mut state: Vec<Value> = match fs::read_to_string(&path) {
        Ok(raw) => serde_json::from_str(&raw).map_err(|_| ApiError {
            status: StatusCode::CONFLICT,
            code: "invalid_marketplace_state",
            message: "marketplace state is malformed".into(),
        })?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(e) => return Err(ApiError::internal(e.to_string())),
    };
    if state.len() > 10_000 || state.iter().any(|v| !valid_installed_server(v)) {
        return Err(ApiError {
            status: StatusCode::CONFLICT,
            code: "invalid_marketplace_state",
            message: "marketplace state shape is invalid".into(),
        });
    }
    let fingerprint = install_fingerprint(&request);
    if !key.is_empty() {
        for prior in load_idempotency(&s)? {
            if prior.get("key").and_then(Value::as_str) == Some(&key) {
                if idempotency_matches(&prior, &key, &fingerprint) {
                    return Ok(Json(
                        prior
                            .get("response")
                            .cloned()
                            .unwrap_or(json!({"success":true})),
                    ));
                }
                return Err(ApiError {
                    status: StatusCode::CONFLICT,
                    code: "idempotency_conflict",
                    message: "idempotency key was already used for a different request".into(),
                });
            }
        }
    }
    let server_id = request
        .alias
        .as_deref()
        .unwrap_or(request.id.rsplit('/').next().unwrap_or(&request.id))
        .trim()
        .to_ascii_lowercase()
        .replace(
            |c: char| !c.is_ascii_alphanumeric() && c != '-' && c != '_',
            "-",
        );
    let updated = state
        .iter()
        .any(|v| v.get("id").and_then(Value::as_str) == Some(&server_id));

    let now = now();
    let source = request
        .source
        .clone()
        .unwrap_or_else(|| "mcpservers.org".into());
    if !valid_catalog_source(&source) {
        return Err(ApiError {
            status: StatusCode::BAD_REQUEST,
            code: "invalid_source",
            message: "source must be mcpservers.org, modelcontextprotocol/servers, or github"
                .into(),
        });
    }
    let server = json!({"id":server_id,"catalogId":request.id,"source":source,"name":server_id,"description":"Installed MCP server","category":"Other","official":false,"enabled":true,"scope":normalize_scope(request.scope.as_ref()),"config":config,"installedAt":now,"updatedAt":now});
    state.retain(|v| v.get("id").and_then(Value::as_str) != Some(&server_id));
    state.push(server.clone());
    atomic_write_json(&path, &json!(state))?;
    let response = json!({"success":true,"updated":updated,"server":server});
    if !key.is_empty() {
        remember_idempotency(&s, &key, &fingerprint, &response)?;
    }
    Ok(Json(response))
}

#[derive(Deserialize, Default)]
struct McpQuery {
    harness: Option<String>,
    workspace: Option<String>,
    channel: Option<String>,
    scoped: Option<String>,
}
fn marketplace_relative_path(raw: &str) -> Option<PathBuf> {
    let p = std::path::Path::new(raw);
    if p.is_absolute()
        || p.components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        None
    } else {
        Some(p.to_path_buf())
    }
}
fn valid_installed_server(v: &Value) -> bool {
    let Some(o) = v.as_object() else { return false };
    let source = o.get("source").and_then(Value::as_str);
    source.is_some_and(|s| {
        matches!(
            s,
            "mcpservers.org" | "modelcontextprotocol/servers" | "github" | "manual"
        )
    }) && o
        .get("id")
        .and_then(Value::as_str)
        .is_some_and(|s| !s.is_empty() && s.len() <= 256)
        && [
            "name",
            "description",
            "category",
            "installedAt",
            "updatedAt",
        ]
        .iter()
        .all(|k| o.get(*k).and_then(Value::as_str).is_some())
        && o.get("official").is_some_and(Value::is_boolean)
        && o.get("enabled").is_some_and(Value::is_boolean)
        && valid_install_config(o.get("config").unwrap_or(&Value::Null))
        && o.get("scope").is_some_and(Value::is_object)
}
fn bounded_json(path: &std::path::Path) -> Result<Option<Value>, ApiError> {
    const MAX: u64 = 2 * 1024 * 1024;
    let meta = match fs::metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(ApiError::internal(e.to_string())),
    };
    if meta.len() > MAX {
        return Err(ApiError::internal("marketplace state exceeds 2 MiB"));
    }
    let text = fs::read_to_string(path).map_err(|e| ApiError::internal(e.to_string()))?;
    serde_json::from_str(&text).map(Some).map_err(|_| ApiError {
        status: StatusCode::CONFLICT,
        code: "invalid_marketplace_state",
        message: "marketplace state is malformed".into(),
    })
}
fn scope_matches(scope: &Value, harness: &str, workspace: &str, channel: Option<&str>) -> bool {
    fn dim(v: Option<&Value>, current: &str, workspace: bool) -> bool {
        let Some(v) = v else {
            return true;
        };
        let Some(a) = v.as_array() else {
            return false;
        };
        if a.is_empty() {
            return true;
        }
        a.iter().filter_map(Value::as_str).any(|x| {
            let x = x.to_ascii_lowercase().replace('\\', "/");
            let c = current.to_ascii_lowercase().replace('\\', "/");
            if workspace {
                let x = x.trim_end_matches('/').to_string();
                let wildcard = x.strip_suffix('*').unwrap_or(&x).trim_end_matches('/');
                c == wildcard || c.starts_with(&(wildcard.to_string() + "/"))
            } else {
                c == x
            }
        })
    }
    dim(scope.get("harnesses"), harness, false)
        && dim(scope.get("workspaces"), workspace, true)
        && dim(scope.get("channels"), channel.unwrap_or(""), false)
}
fn parse_policy(v: &Value) -> Option<Value> {
    let mode = v.get("mode")?.as_str()?;
    if !matches!(mode, "compact" | "hybrid" | "expanded") {
        return None;
    }
    let clamp = |key: &str, default: u64, min: u64, max: u64| {
        if v.get(key).is_some_and(|x| !x.is_number()) {
            return None;
        }
        Some(
            v.get(key)
                .and_then(Value::as_f64)
                .filter(|n| n.is_finite())
                .map(|n| n.round().max(min as f64).min(max as f64) as u64)
                .unwrap_or(default),
        )
    };
    Some(
        json!({"mode":mode,"maxExpandedTools":clamp("maxExpandedTools",12,0,100)?,"maxSearchResults":clamp("maxSearchResults",8,1,50)?,"updatedAt":v.get("updatedAt").and_then(Value::as_str).unwrap_or("1970-01-01T00:00:00.000Z")}),
    )
}
fn policy_path(s: &AppState) -> PathBuf {
    s.workspace.join("marketplace/mcp-policy.json")
}
fn read_policy(s: &AppState) -> Result<Value, ApiError> {
    match bounded_json(&policy_path(s))? {
        None => Ok(
            json!({"mode":"hybrid","maxExpandedTools":12,"maxSearchResults":8,"updatedAt":"1970-01-01T00:00:00.000Z"}),
        ),
        Some(v) => parse_policy(&v).ok_or_else(|| ApiError {
            status: StatusCode::CONFLICT,
            code: "invalid_marketplace_policy",
            message: "marketplace policy is malformed".into(),
        }),
    }
}
async fn list_marketplace(
    State(s): State<AppState>,
    Query(q): Query<McpQuery>,
    h: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    gate(&s, &h).await?;
    let raw = bounded_json(&marketplace_state_path(&s))?.unwrap_or(json!([]));
    let mut servers = Vec::new();
    let header_value = |name: &str| {
        h.get(name)
            .and_then(|v| v.to_str().ok())
            .map(str::trim)
            .filter(|v| !v.is_empty())
    };
    let choose =
        |query: Option<&String>, header: Option<&str>| -> Result<Option<String>, ApiError> {
            match (query.map(|v| v.trim()).filter(|v| !v.is_empty()), header) {
                (Some(q), _) => Ok(Some(q.to_owned())),
                (None, Some(h)) => Ok(Some(h.to_owned())),
                _ => Ok(None),
            }
        };
    let harness = choose(q.harness.as_ref(), header_value("x-signet-harness"))?;
    let workspace = choose(q.workspace.as_ref(), header_value("x-signet-workspace"))?;
    let channel = choose(q.channel.as_ref(), header_value("x-signet-channel"))?;
    let scoped = match q.scoped.as_deref() {
        Some("1") => true,
        Some("0") => false,
        Some(_) => return Err(ApiError::bad_request("scoped must be 0 or 1")),
        None => harness.is_some() || workspace.is_some() || channel.is_some(),
    };
    let Some(items) = raw.as_array() else {
        return Err(ApiError {
            status: StatusCode::CONFLICT,
            code: "invalid_marketplace_state",
            message: "marketplace state shape is invalid".into(),
        });
    };
    for v in items {
        if !valid_installed_server(v) {
            continue;
        }
        if !scoped
            || scope_matches(
                v.get("scope").unwrap_or(&json!({})),
                harness.as_deref().unwrap_or(""),
                workspace.as_deref().unwrap_or(""),
                channel.as_deref(),
            )
        {
            servers.push(v.clone())
        }
    }
    Ok(Json(
        json!({"servers":servers,"count":servers.len(),"scoped":scoped,"context":{"harness":harness,"workspace":workspace,"channel":channel},"runtime":{"runtime":"rust","implementation":"fresh","supported":false,"supportedOperations":["installed-list","policy-get","policy-patch"]}}),
    ))
}
async fn get_policy(State(s): State<AppState>, h: HeaderMap) -> Result<Json<Value>, ApiError> {
    gate(&s, &h).await?;
    Ok(Json(json!({"policy":read_policy(&s)?})))
}
async fn patch_policy(
    State(s): State<AppState>,
    h: HeaderMap,
    body: Json<Value>,
) -> Result<Json<Value>, ApiError> {
    gate(&s, &h).await?;
    let _lock = acquire_marketplace_lock(&s)?;
    let Json(v) = body;
    let cur = read_policy(&s)?;
    let mut next = cur.clone();
    let o = v.as_object().ok_or_else(|| ApiError {
        status: StatusCode::BAD_REQUEST,
        code: "invalid_json",
        message: "Invalid JSON body".into(),
    })?;
    for k in ["mode", "maxExpandedTools", "maxSearchResults"] {
        if let Some(x) = o.get(k) {
            next[k] = x.clone()
        }
    }
    let mode = next
        .get("mode")
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError {
            status: StatusCode::BAD_REQUEST,
            code: "invalid_mode",
            message: "mode must be compact, hybrid, or expanded".into(),
        })?;
    if !matches!(mode, "compact" | "hybrid" | "expanded") {
        return Err(ApiError {
            status: StatusCode::BAD_REQUEST,
            code: "invalid_mode",
            message: "mode must be compact, hybrid, or expanded".into(),
        });
    }
    next["updatedAt"] = json!(iso_now());
    let next = parse_policy(&next).unwrap();
    atomic_write_json(&policy_path(&s), &next)?;
    let read = read_policy(&s)?;
    Ok(Json(json!({"success":true,"policy":read})))
}

#[cfg(test)]
mod marketplace_contract_tests {
    use super::*;

    #[test]
    fn scope_matching_supports_workspace_descendants_and_dimensions() {
        let scope = json!({"harnesses":["desktop"],"workspaces":["/work/team"],"channels":[]});
        assert!(scope_matches(&scope, "desktop", "/work/team/project", None));
        assert!(!scope_matches(&scope, "cli", "/work/team/project", None));
        assert!(!scope_matches(&scope, "desktop", "/work/other", None));
    }

    #[test]
    fn exposure_policy_clamps_limits_and_rejects_invalid_mode() {
        assert_eq!(
            parse_policy(&json!({"mode":"expanded","maxExpandedTools":999,"maxSearchResults":0}))
                .unwrap()["maxExpandedTools"],
            100
        );
        assert_eq!(
            parse_policy(&json!({"mode":"compact"})).unwrap()["maxSearchResults"],
            8
        );
        assert!(parse_policy(&json!({"mode":"invalid"})).is_none());
    }

    #[test]
    fn installed_read_is_bounded_and_workspace_local() {
        assert!(marketplace_relative_path(".daemon/plugins/marketplace-v1.json").is_some());
        assert!(marketplace_relative_path("../outside.json").is_none());
    }

    #[test]
    fn install_accepts_only_typescript_catalog_sources() {
        assert!(valid_catalog_source("mcpservers.org"));
        assert!(valid_catalog_source("modelcontextprotocol/servers"));
        assert!(valid_catalog_source("github"));
        assert!(!valid_catalog_source("evil"));
    }

    #[test]
    fn malformed_policy_is_an_explicit_error_not_a_default() {
        assert!(parse_policy(&json!({"mode":"wat"})).is_none());
        assert!(parse_policy(&json!({"mode":"hybrid","maxExpandedTools":"12"})).is_none());
    }

    #[test]
    fn idempotency_conflict_is_detectable_without_request_secrets() {
        let a = json!({"key":"k","fingerprint":"a","response":{"success":true}});
        assert!(idempotency_matches(&a, "k", "a"));
        assert!(!idempotency_matches(&a, "k", "b"));
    }
}

async fn unsupported_marketplace(
    State(s): State<AppState>,
    h: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    gate(&s, &h).await?;
    Err(ApiError::not_implemented(
        "marketplace operation is unsupported by the fresh native boundary",
    ))
}

async fn list(State(s): State<AppState>, h: HeaderMap) -> Result<Json<Value>, ApiError> {
    gate(&s, &h).await?;
    Ok(Json(json!({"plugins":records(&s)?})))
}
async fn detail(
    State(s): State<AppState>,
    Path(id): Path<String>,
    h: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    gate(&s, &h).await?;
    records(&s)?
        .into_iter()
        .find(|x| x["id"] == id)
        .map(|x| Json(x))
        .ok_or_else(|| ApiError::not_found("plugin not found"))
}
async fn diagnostics(
    State(s): State<AppState>,
    Path(id): Path<String>,
    h: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    gate(&s, &h).await?;
    let r = records(&s)?
        .into_iter()
        .find(|x| x["id"] == id)
        .ok_or_else(|| ApiError::not_found("plugin not found"))?;
    Ok(Json(
        json!({"plugin":{"record":r,"manifest":manifest(&id),"activeSurfaces":surfaces(&id),"plannedSurfaces":surfaces(&id),"promptContributions":[],"promptContributionDiagnostics":[],"validationErrors":[]}}),
    ))
}
async fn prompts(State(s): State<AppState>, h: HeaderMap) -> Result<Json<Value>, ApiError> {
    gate(&s, &h).await?;
    let contributions=records(&s)?.into_iter().filter(|x|x["state"]=="active").flat_map(|x| if x["id"]=="signet-graphiq" {vec![json!({"id":"signet.graphiq.code-retrieval-guidance","pluginId":"signet-graphiq","target":"user-prompt-submit","mode":"context","priority":430,"maxTokens":100,"content":"Prefer generic code retrieval tools for indexed code."})]} else {vec![]}).collect::<Vec<_>>();
    Ok(Json(
        json!({"contributions":contributions,"activeCount":contributions.len()}),
    ))
}
async fn audit(
    State(s): State<AppState>,
    Query(q): Query<AuditQuery>,
    h: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    gate(&s, &h).await?;
    const MAX_AUDIT_BYTES: u64 = 2 * 1024 * 1024;
    let mut out = Vec::new();
    let mut truncated = false;
    let mut bytes_scanned = 0u64;
    if let Ok(mut f) = fs::File::open(audit_path(&s)) {
        let len = f
            .metadata()
            .map_err(|e| ApiError::internal(e.to_string()))?
            .len();
        let start = len.saturating_sub(MAX_AUDIT_BYTES);
        truncated = start > 0;
        f.seek(SeekFrom::Start(start))
            .map_err(|e| ApiError::internal(e.to_string()))?;
        let mut text = String::new();
        f.take(MAX_AUDIT_BYTES)
            .read_to_string(&mut text)
            .map_err(|e| ApiError::internal(e.to_string()))?;
        bytes_scanned = text.len() as u64;
        for l in text.lines().skip(if truncated && !text.starts_with('\n') {
            1
        } else {
            0
        }) {
            if let Ok(v) = serde_json::from_str::<Value>(l) {
                if q.plugin_id.as_ref().is_some_and(|x| v["pluginId"] != *x)
                    || q.event.as_ref().is_some_and(|x| v["event"] != *x)
                    || q.since
                        .as_ref()
                        .is_some_and(|x| v["timestamp"].as_str().unwrap_or("") < x.as_str())
                    || q.until
                        .as_ref()
                        .is_some_and(|x| v["timestamp"].as_str().unwrap_or("") > x.as_str())
                {
                    continue;
                }
                out.push(v);
            }
        }
    }
    out.reverse();
    out.truncate(q.limit.unwrap_or(100).clamp(1, 500));
    let n = out.len();
    Ok(Json(
        json!({"events":out,"count":n,"truncated":truncated,"bytesScanned":bytes_scanned}),
    ))
}
async fn update(
    State(s): State<AppState>,
    Path(id): Path<String>,
    headers: axum::http::HeaderMap,
    Json(u): Json<Update>,
) -> Result<Json<Value>, ApiError> {
    gate(&s, &headers).await?;
    let mut st = load(&s)?;
    if records(&s)?.iter().all(|x| x["id"] != id) {
        return Err(ApiError::not_found("plugin not found"));
    }
    let installed = st["plugins"][&id]
        .get("installedAt")
        .and_then(Value::as_str)
        .unwrap_or("0")
        .to_string();
    st["plugins"][&id] = json!({"enabled":u.enabled,"installedAt":installed,"updatedAt":now()});
    save(&s, &st)?;
    let audit_result = (|| -> Result<(), String> {
        let p = audit_path(&s);
        fs::create_dir_all(p.parent().unwrap()).map_err(|e| e.to_string())?;
        let mut f = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(p)
            .map_err(|e| e.to_string())?;
        writeln!(f, "{}", json!({"timestamp":now(),"pluginId":id,"event":if u.enabled{"plugin.enabled"}else{"plugin.disabled"}})).map_err(|e| e.to_string())?;
        f.sync_all().map_err(|e| e.to_string())
    })();
    let committed = records(&s)?.into_iter().find(|x| x["id"] == id).unwrap();
    let mut response = committed;
    response["auditDegraded"] = Value::Bool(audit_result.is_err());
    if let Err(e) = audit_result {
        response["auditError"] = Value::String(e);
    }
    Ok(Json(response))
}
