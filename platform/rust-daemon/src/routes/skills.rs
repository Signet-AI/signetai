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
    io::Read,
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
        || name.chars().any(char::is_control)
    {
        Err(ApiError::bad_request("invalid skill name"))
    } else {
        Ok(())
    }
}
fn limit(value: Option<usize>) -> Result<usize, ApiError> {
    let n = value.unwrap_or(MAX_SKILLS);
    if (1..=MAX_SKILLS).contains(&n) {
        Ok(n)
    } else {
        Err(ApiError::bad_request("limit must be between 1 and 100"))
    }
}
async fn gate(
    state: &AppState,
    headers: &HeaderMap,
    capability: &str,
    destructive: bool,
) -> Result<(), ApiError> {
    let claims = auth::gate(state, headers).await?;
    let role = claims.get("role").and_then(Value::as_str).unwrap_or("");
    let perms = claims.get("permissions").and_then(Value::as_array);
    if let Some(values) = perms {
        if values.iter().any(|p| {
            p.as_str() == Some(&format!("deny:{capability}")) || p.as_str() == Some("skills:deny")
        }) {
            return Err(ApiError {
                status: StatusCode::FORBIDDEN,
                code: "forbidden",
                message: format!("{capability} capability is denied"),
            });
        }
    }
    if role != "admin" {
        let allowed = perms
            .map(|p| p.iter().any(|v| v.as_str() == Some(capability)))
            .unwrap_or(false);
        if !allowed {
            return Err(ApiError {
                status: StatusCode::FORBIDDEN,
                code: "forbidden",
                message: format!("{capability} capability is required"),
            });
        }
    }
    let _ = destructive;
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
    let canonical_root = root
        .canonicalize()
        .map_err(|_| ApiError::unavailable("skills directory is unavailable"))?;
    let candidate = canonical_root.join(name);
    if let Ok(meta) = fs::symlink_metadata(&candidate) {
        if meta.file_type().is_symlink() {
            return Err(ApiError::bad_request("invalid skill path"));
        }
        if let Ok(canonical) = candidate.canonicalize() {
            if !canonical.starts_with(&canonical_root) {
                return Err(ApiError::bad_request("invalid skill path"));
            }
        }
    }
    Ok(candidate)
}
fn frontmatter(content: &str) -> Result<Value, ApiError> {
    let mut out = serde_json::Map::new();
    let mut lines = content.lines();
    if lines.next() != Some("---") {
        return Ok(Value::Object(out));
    }
    let mut closed = false;
    for line in lines {
        if line == "---" {
            closed = true;
            break;
        }
        if let Some((key, value)) = line.split_once(':') {
            if [
                "description",
                "version",
                "author",
                "maintainer",
                "license",
                "arg_hint",
            ]
            .contains(&key)
            {
                out.insert(
                    key.into(),
                    Value::String(value.trim().trim_matches(['"', '\'']).into()),
                );
            } else if key == "verified" && value.trim() == "true" {
                out.insert("verified".into(), Value::Bool(true));
            }
        }
    }
    if !closed {
        return Err(ApiError::bad_request("malformed skill frontmatter"));
    }
    Ok(Value::Object(out))
}
fn read_skill(root: &FsPath, name: &str) -> Result<Value, ApiError> {
    let dir = contained(root, name)?;
    let dir_meta = fs::symlink_metadata(&dir)
        .map_err(|_| ApiError::not_found(format!("skill '{name}' not found")))?;
    if !dir_meta.file_type().is_dir() || dir_meta.file_type().is_symlink() {
        return Err(ApiError::bad_request("invalid skill path"));
    }
    let md = dir.join("SKILL.md");
    let meta = fs::symlink_metadata(&md)
        .map_err(|_| ApiError::not_found(format!("skill '{name}' not found")))?;
    if !meta.file_type().is_file() || meta.file_type().is_symlink() {
        return Err(ApiError::bad_request("invalid skill path"));
    }
    let canonical_root = root
        .canonicalize()
        .map_err(|_| ApiError::unavailable("skills directory is unavailable"))?;
    let canonical = md
        .canonicalize()
        .map_err(|_| ApiError::bad_request("invalid skill path"))?;
    if !canonical.starts_with(&canonical_root) {
        return Err(ApiError::bad_request("invalid skill path"));
    }
    if meta.len() > MAX_CONTENT_BYTES {
        return Err(ApiError {
            status: StatusCode::PAYLOAD_TOO_LARGE,
            code: "payload_too_large",
            message: "skill content exceeds 1 MiB".into(),
        });
    }
    let file = {
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            fs::OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_NOFOLLOW)
                .open(&md)
        }
        #[cfg(not(unix))]
        {
            fs::File::open(&md)
        }
    }
    .map_err(|_| ApiError::unavailable("failed to read skill"))?;
    let mut data = Vec::with_capacity(meta.len() as usize);
    file.take(MAX_CONTENT_BYTES + 1)
        .read_to_end(&mut data)
        .map_err(|_| ApiError::unavailable("failed to read skill"))?;
    if data.len() as u64 > MAX_CONTENT_BYTES {
        return Err(ApiError {
            status: StatusCode::PAYLOAD_TOO_LARGE,
            code: "payload_too_large",
            message: "skill content exceeds 1 MiB".into(),
        });
    }
    let content = String::from_utf8(data)
        .map_err(|_| ApiError::bad_request("skill content must be UTF-8"))?;
    let mut value = frontmatter(&content)?;
    if let Value::Object(ref mut map) = value {
        map.insert("name".into(), json!(name));
        map.insert("path".into(), json!(dir));
        map.insert("content".into(), json!(content));
    }
    Ok(value)
}
pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/api/skills", get(list))
        .route("/api/skills/browse", get(browse))
        .route("/api/skills/search", get(search))
        .route("/api/skills/install", post(install))
        .route("/api/skills/{name}", get(detail).delete(remove))
}
fn all_skills(root: &FsPath) -> Result<Vec<Value>, ApiError> {
    let mut entries = Vec::new();
    for entry in
        fs::read_dir(root).map_err(|_| ApiError::unavailable("skills directory is unavailable"))?
    {
        let entry = entry.map_err(|_| ApiError::unavailable("failed to list skills"))?;
        let name = match entry.file_name().into_string() {
            Ok(name) => name,
            Err(_) => continue,
        };
        let meta = match fs::symlink_metadata(entry.path()) {
            Ok(meta) => meta,
            Err(_) => continue,
        };
        if meta.file_type().is_symlink() {
            continue;
        }
        if meta.file_type().is_dir() {
            if let Ok(skill) = read_skill(root, &name) {
                entries.push(skill);
            }
        }
    }
    entries.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
    Ok(entries)
}
async fn list(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<ListQuery>,
) -> Result<Json<Value>, ApiError> {
    gate(&state, &headers, "skills:list", false).await?;
    let max = limit(q.limit)?;
    let all = all_skills(&root_dir(&state)?)?;
    let total = all.len();
    let skills: Vec<_> = all.into_iter().take(max).collect();
    Ok(Json(
        json!({"skills": skills, "count": skills.len(), "total": total, "truncated": total > skills.len()}),
    ))
}
async fn detail(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(name): Path<String>,
) -> Result<Json<Value>, ApiError> {
    gate(&state, &headers, "skills:read", false).await?;
    Ok(Json(read_skill(&root_dir(&state)?, &name)?))
}
async fn browse(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<ListQuery>,
) -> Result<Json<Value>, ApiError> {
    gate(&state, &headers, "skills:browse", false).await?;
    let max = limit(q.limit)?;
    let all = all_skills(&root_dir(&state)?)?;
    let total = all.len();
    let results: Vec<_> = all.into_iter().take(max).collect();
    Ok(Json(
        json!({"results":results,"total":total,"truncated":total>results.len()}),
    ))
}
async fn search(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<SearchQuery>,
) -> Result<Json<Value>, ApiError> {
    gate(&state, &headers, "skills:search", false).await?;
    let term =
        q.q.ok_or_else(|| ApiError::bad_request("query parameter q is required"))?
            .to_lowercase();
    let max = limit(q.limit)?;
    let matches: Vec<_> = all_skills(&root_dir(&state)?)?
        .into_iter()
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
        .collect();
    let total = matches.len();
    let results: Vec<_> = matches.into_iter().take(max).collect();
    Ok(Json(
        json!({"results":results,"total":total,"truncated":total>results.len()}),
    ))
}
async fn install(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<InstallBody>,
) -> Result<Json<Value>, ApiError> {
    gate(&state, &headers, "skills:install", true).await?;
    let _ = (body.name, body.source);
    Err(ApiError::not_implemented(
        "external skill installation is unsupported; unsupported_marker=skills_remote_provider",
    ))
}
async fn remove(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(name): Path<String>,
) -> Result<Json<Value>, ApiError> {
    gate(&state, &headers, "skills:delete", true).await?;
    let root = root_dir(&state)?;
    let dir = contained(&root, &name)?;
    let meta = fs::symlink_metadata(&dir)
        .map_err(|_| ApiError::not_found(format!("skill '{name}' not found")))?;
    if !meta.file_type().is_dir() || meta.file_type().is_symlink() {
        return Err(ApiError::bad_request("invalid skill path"));
    }
    fs::remove_dir(&dir).map_err(|_| ApiError::unavailable("failed to remove skill"))?;
    Ok(Json(
        json!({"success":true,"name":name,"message":format!("Removed {name}")}),
    ))
}
