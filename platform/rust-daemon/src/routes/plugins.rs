use crate::{routes::auth, ApiError, AppState};
use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    routing::get,
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    fs,
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
fn load(state: &AppState) -> Result<Value, ApiError> {
    let path = registry_path(state);
    match fs::read_to_string(path) {
        Ok(s) => serde_json::from_str(&s).map_err(|_| ApiError {
            status: StatusCode::CONFLICT,
            code: "invalid_registry",
            message: "plugin registry is malformed".into(),
        }),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(json!({"version":1,"plugins":{}})),
        Err(e) => Err(ApiError::internal(e.to_string())),
    }
}
fn save(state: &AppState, value: &Value) -> Result<(), ApiError> {
    let path = registry_path(state);
    fs::create_dir_all(path.parent().unwrap()).map_err(|e| ApiError::internal(e.to_string()))?;
    fs::write(path, serde_json::to_vec_pretty(value).unwrap())
        .map_err(|e| ApiError::internal(e.to_string()))
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
    let mut out = Vec::new();
    if let Ok(text) = fs::read_to_string(audit_path(&s)) {
        for l in text.lines() {
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
                out.push(v)
            }
        }
    }
    out.reverse();
    out.truncate(q.limit.unwrap_or(100).clamp(1, 500));
    let n = out.len();
    Ok(Json(json!({"events":out,"count":n})))
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
    let p = audit_path(&s);
    fs::create_dir_all(p.parent().unwrap()).map_err(|e| ApiError::internal(e.to_string()))?;
    use std::io::Write;
    let mut f = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(p)
        .map_err(|e| ApiError::internal(e.to_string()))?;
    writeln!(f,"{}",json!({"timestamp":now(),"pluginId":id,"event":if u.enabled{"plugin.enabled"}else{"plugin.disabled"}})).map_err(|e| ApiError::internal(e.to_string()))?;
    Ok(Json(
        records(&s)?.into_iter().find(|x| x["id"] == id).unwrap(),
    ))
}
