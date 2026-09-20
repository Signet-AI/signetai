use crate::{ApiError, AppState};
use axum::{
    extract::{Path, Query, State},
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
        .route("/api/plugins/:id/diagnostics", get(diagnostics))
        .route("/api/plugins/:id", get(detail).patch(update))
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
fn load(state: &AppState) -> Value {
    let path = registry_path(state);
    fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| json!({"version":1,"plugins":{}}))
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
fn records(state: &AppState) -> Vec<Value> {
    let persisted = load(state);
    ["signet-secrets","signet-graphiq"].into_iter().map(|id| {
        let old=persisted.get("plugins").and_then(|p|p.get(id)); let enabled=old.and_then(|x|x.get("enabled")).and_then(Value::as_bool).unwrap_or(true); let t=old.and_then(|x|x.get("installedAt")).and_then(Value::as_str).unwrap_or("0");
        let caps=manifest(id).get("capabilities").cloned().unwrap_or(json!([]));
        json!({"id":id,"name":manifest(id)["name"],"version":"1.0.0","publisher":manifest(id)["publisher"],"source":"bundled","trustTier":manifest(id)["trustTier"],"enabled":enabled,"state":if enabled{"active"}else{"disabled"},"stateReason":if enabled {Value::Null}else{json!("disabled by host policy")},"declaredCapabilities":caps,"grantedCapabilities":if enabled{caps}else{json!([])},"pendingCapabilities":[],"surfaces":if enabled{surfaces(id)}else{json!({"daemonRoutes":[],"cliCommands":[],"mcpTools":[],"dashboardPanels":[],"sdkClients":[],"connectorCapabilities":[],"promptContributions":[]})},"health":{"status":"healthy","checkedAt":now()},"installedAt":t,"updatedAt":now()})
    }).collect()
}
async fn list(State(s): State<AppState>) -> Result<Json<Value>, ApiError> {
    Ok(Json(json!({"plugins":records(&s)})))
}
async fn detail(
    State(s): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    records(&s)
        .into_iter()
        .find(|x| x["id"] == id)
        .map(|x| Json(x))
        .ok_or_else(|| ApiError::not_found("plugin not found"))
}
async fn diagnostics(
    State(s): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let r = detail(State(s.clone()), Path(id.clone())).await?.0;
    Ok(Json(
        json!({"plugin":{"record":r,"manifest":manifest(&id),"activeSurfaces":surfaces(&id),"plannedSurfaces":surfaces(&id),"promptContributions":[],"promptContributionDiagnostics":[],"validationErrors":[]}}),
    ))
}
async fn prompts(State(s): State<AppState>) -> Result<Json<Value>, ApiError> {
    let contributions=records(&s).into_iter().filter(|x|x["state"]=="active").flat_map(|x| if x["id"]=="signet-graphiq" {vec![json!({"id":"signet.graphiq.code-retrieval-guidance","pluginId":"signet-graphiq","target":"user-prompt-submit","mode":"context","priority":430,"maxTokens":100,"content":"Prefer generic code retrieval tools for indexed code."})]} else {vec![]}).collect::<Vec<_>>();
    Ok(Json(
        json!({"contributions":contributions,"activeCount":contributions.len()}),
    ))
}
async fn audit(
    State(s): State<AppState>,
    Query(q): Query<AuditQuery>,
) -> Result<Json<Value>, ApiError> {
    let mut out = Vec::new();
    if let Ok(text) = fs::read_to_string(audit_path(&s)) {
        for l in text.lines() {
            if let Ok(v) = serde_json::from_str::<Value>(l) {
                if q.plugin_id.as_ref().is_some_and(|x| v["pluginId"] != *x)
                    || q.event.as_ref().is_some_and(|x| v["event"] != *x)
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
    if headers.get("x-signet-admin").and_then(|v| v.to_str().ok()) != Some("true")
        && headers
            .get("x-signet-capabilities")
            .and_then(|v| v.to_str().ok())
            .map(|v| !v.split(',').any(|x| x.trim() == "plugin:admin"))
            .unwrap_or(true)
    {
        return Err(ApiError::unauthorized("plugin admin capability required"));
    }
    let mut st = load(&s);
    if records(&s).iter().all(|x| x["id"] != id) {
        return Err(ApiError::not_found("plugin not found"));
    }
    st["plugins"][&id] = json!({"enabled":u.enabled,"installedAt":"0","updatedAt":now()});
    save(&s, &st)?;
    let r = detail(State(s), Path(id)).await?;
    Ok(r)
}
