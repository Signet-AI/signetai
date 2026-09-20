use crate::{routes::auth, ApiError, AppState};
use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    routing::{get, patch, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    fs,
    io::{Read, Seek, SeekFrom, Write},
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
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
        .route("/api/marketplace/mcp", get(unsupported_marketplace))
        .route(
            "/api/marketplace/mcp/policy",
            get(unsupported_marketplace).patch(unsupported_marketplace),
        )
        .route("/api/marketplace/mcp/browse", get(unsupported_marketplace))
        .route("/api/marketplace/mcp/detail", get(unsupported_marketplace))
        .route("/api/marketplace/mcp/test", post(unsupported_marketplace))
        .route(
            "/api/marketplace/mcp/install",
            post(unsupported_marketplace),
        )
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
fn registry_path(state: &AppState) -> PathBuf {
    state.workspace.join(".daemon/plugins/registry-v1.json")
}
fn audit_path(state: &AppState) -> PathBuf {
    state.workspace.join(".daemon/plugins/audit-v1.ndjson")
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
