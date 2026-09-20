use crate::{routes::auth, ApiError, AppState};
use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path as FsPath, PathBuf},
};

const MAX_SKILLS: usize = 100;
const MAX_CONTENT_BYTES: u64 = 1024 * 1024;

#[derive(Deserialize, Default)]
struct ListQuery {
    limit: Option<usize>,
}
#[derive(Deserialize)]
struct SearchQuery {
    q: Option<String>,
    limit: Option<usize>,
}
#[derive(Deserialize)]
struct InstallBody {
    name: Option<String>,
    source: Option<String>,
}

fn skills_root(state: &AppState) -> PathBuf {
    state.workspace.join("skills")
}
fn valid_name(name: &str) -> Result<(), ApiError> {
    if name.is_empty()
        || name.len() > 128
        || name == "."
        || name == ".."
        || name.contains('/')
        || name.contains('\\')
        || name.chars().any(|c| c.is_control())
    {
        return Err(ApiError::bad_request("invalid skill name"));
    }
    Ok(())
}
fn limit(value: Option<usize>) -> Result<usize, ApiError> {
    let value = value.unwrap_or(MAX_SKILLS);
    if value == 0 || value > MAX_SKILLS {
        Err(ApiError::bad_request("limit must be between 1 and 100"))
    } else {
        Ok(value)
    }
}
async fn gate(state: &AppState, headers: &HeaderMap, capability: &str) -> Result<(), ApiError> {
    let claims = auth::gate(state, headers).await?;
    if let Some(perms) = claims.get("permissions").and_then(Value::as_array) {
        if !perms.is_empty() && !perms.iter().any(|p| p.as_str() == Some(capability)) {
            return Err(ApiError {
                status: StatusCode::FORBIDDEN,
                code: "forbidden",
                message: format!("{capability} capability is required"),
            });
        }
    }
    Ok(())
}
fn root_dir(state: &AppState) -> Result<PathBuf, ApiError> {
    let root = skills_root(state);
    fs::create_dir_all(&root)
        .map_err(|_| ApiError::unavailable("skills directory is unavailable"))?;
    Ok(root)
}
fn contained(root: &FsPath, name: &str) -> Result<PathBuf, ApiError> {
    valid_name(name)?;
    let root = root
        .canonicalize()
        .map_err(|_| ApiError::unavailable("skills directory is unavailable"))?;
    let candidate = root.join(name);
    if candidate.exists() {
        let canonical = candidate
            .canonicalize()
            .map_err(|_| ApiError::bad_request("invalid skill path"))?;
        if !canonical.starts_with(&root) {
            return Err(ApiError::bad_request("invalid skill path"));
        }
    }
    Ok(candidate)
}
fn metadata(content: &str) -> Value {
    let mut result = serde_json::Map::new();
    for key in [
        "description",
        "version",
        "author",
        "maintainer",
        "license",
        "arg_hint",
    ] {
        if let Some(line) = content
            .lines()
            .find(|line| line.starts_with(&format!("{key}:")))
        {
            result.insert(
                key.to_owned(),
                Value::String(
                    line[key.len() + 1..]
                        .trim()
                        .trim_matches(['"', '\''])
                        .to_owned(),
                ),
            );
        }
    }
    if content.lines().any(|line| line.trim() == "verified: true") {
        result.insert("verified".into(), Value::Bool(true));
    }
    Value::Object(result)
}
fn read_skill(root: &FsPath, name: &str) -> Result<Option<Value>, ApiError> {
    let dir = contained(root, name)?;
    let md = dir.join("SKILL.md");
    let meta = fs::symlink_metadata(&md).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            ApiError::not_found(format!("skill '{name}' not found"))
        } else {
            ApiError::bad_request("invalid skill path")
        }
    })?;
    if !meta.file_type().is_file() {
        return Err(ApiError::bad_request("invalid skill path"));
    }
    let canonical = md
        .canonicalize()
        .map_err(|_| ApiError::bad_request("invalid skill path"))?;
    let root_c = root
        .canonicalize()
        .map_err(|_| ApiError::unavailable("skills directory is unavailable"))?;
    if !canonical.starts_with(&root_c) {
        return Err(ApiError::bad_request("invalid skill path"));
    }
    let data = fs::read(&canonical).map_err(|_| ApiError::unavailable("failed to read skill"))?;
    if data.len() as u64 > MAX_CONTENT_BYTES {
        return Err(ApiError {
            status: StatusCode::PAYLOAD_TOO_LARGE,
            code: "payload_too_large",
            message: "skill content exceeds 1 MiB".into(),
        });
    }
    let content = String::from_utf8(data)
        .map_err(|_| ApiError::bad_request("skill content must be UTF-8"))?;
    let mut value = metadata(&content);
    if let Value::Object(ref mut map) = value {
        map.insert("name".into(), json!(name));
        map.insert("path".into(), json!(dir));
        map.insert("content".into(), json!(content));
    }
    Ok(Some(value))
}
pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/api/skills", get(list))
        .route("/api/skills/browse", get(browse))
        .route("/api/skills/search", get(search))
        .route("/api/skills/install", post(install))
        .route("/api/skills/{name}", get(detail).delete(remove))
}
async fn list(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<ListQuery>,
) -> Result<Json<Value>, ApiError> {
    gate(&state, &headers, "skills:list").await?;
    let max = limit(q.limit)?;
    let root = root_dir(&state)?;
    let mut skills = Vec::new();
    for entry in
        fs::read_dir(&root).map_err(|_| ApiError::unavailable("skills directory is unavailable"))?
    {
        if skills.len() >= max {
            break;
        }
        let entry = entry.map_err(|_| ApiError::unavailable("failed to list skills"))?;
        if entry
            .file_type()
            .map_err(|_| ApiError::bad_request("invalid skill path"))?
            .is_dir()
        {
            if let Some(name) = entry.file_name().to_str() {
                if let Ok(Some(v)) = read_skill(&root, name) {
                    skills.push(v);
                }
            }
        }
    }
    Ok(Json(json!({"skills": skills, "count": skills.len()})))
}
async fn detail(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(name): Path<String>,
) -> Result<Json<Value>, ApiError> {
    gate(&state, &headers, "skills:read").await?;
    Ok(Json(read_skill(&root_dir(&state)?, &name)?.ok_or_else(
        || ApiError::not_found(format!("skill '{name}' not found")),
    )?))
}
async fn browse(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<ListQuery>,
) -> Result<Json<Value>, ApiError> {
    gate(&state, &headers, "skills:browse").await?;
    let result = list(State(state), headers, Query(q)).await?.0;
    let skills = result.get("skills").cloned().unwrap_or_else(|| json!([]));
    let total = skills.as_array().map_or(0, Vec::len);
    Ok(Json(json!({"results": skills, "total": total})))
}
async fn search(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<SearchQuery>,
) -> Result<Json<Value>, ApiError> {
    gate(&state, &headers, "skills:search").await?;
    let term =
        q.q.ok_or_else(|| ApiError::bad_request("query parameter q is required"))?
            .to_lowercase();
    let result = list(State(state), headers, Query(ListQuery { limit: q.limit }))
        .await?
        .0;
    let results: Vec<Value> = result["skills"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|v| {
            v["name"]
                .as_str()
                .unwrap_or("")
                .to_lowercase()
                .contains(&term)
                || v["description"]
                    .as_str()
                    .unwrap_or("")
                    .to_lowercase()
                    .contains(&term)
        })
        .cloned()
        .collect();
    Ok(Json(json!({"results": results})))
}
async fn install(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<InstallBody>,
) -> Result<Json<Value>, ApiError> {
    gate(&state, &headers, "skills:install").await?;
    let _ = (body.name, body.source);
    Err(ApiError::not_implemented(
        "external skill installation is unsupported",
    ))
}
async fn remove(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(name): Path<String>,
) -> Result<Json<Value>, ApiError> {
    gate(&state, &headers, "skills:delete").await?;
    let root = root_dir(&state)?;
    let dir = contained(&root, &name)?;
    let meta = fs::symlink_metadata(&dir)
        .map_err(|_| ApiError::not_found(format!("skill '{name}' not found")))?;
    if !meta.file_type().is_dir() || meta.file_type().is_symlink() {
        return Err(ApiError::bad_request("invalid skill path"));
    }
    fs::remove_dir_all(&dir).map_err(|_| ApiError::unavailable("failed to remove skill"))?;
    Ok(Json(
        json!({"success": true, "name": name, "message": format!("Removed {name}")}),
    ))
}
