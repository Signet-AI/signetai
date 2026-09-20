use crate::{routes::auth, ApiError, AppState};
use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
#[cfg(unix)]
use std::io;
use std::{
    fs,
    io::Read,
    path::{Path as FsPath, PathBuf},
};

const MAX_SKILLS: usize = 100;
const MAX_CONTENT_BYTES: u64 = 1024 * 1024;
const MAX_CATALOG_BYTES: usize = 5 * 1024 * 1024;
const MAX_CATALOG_ITEMS: usize = 500;
const CATALOG_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(1500);

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
            } else if ["user_invocable", "verified"].contains(&key) {
                match value.trim() {
                    "true" => {
                        out.insert(key.into(), Value::Bool(true));
                    }
                    "false" => {
                        out.insert(key.into(), Value::Bool(false));
                    }
                    _ => return Err(ApiError::bad_request("malformed skill frontmatter")),
                }
            } else if key == "permissions" {
                let raw = value.trim();
                let items = raw
                    .strip_prefix('[')
                    .and_then(|v| v.strip_suffix(']'))
                    .ok_or_else(|| ApiError::bad_request("malformed skill frontmatter"))?;
                let values = items
                    .split(',')
                    .filter_map(|item| {
                        let item = item.trim().trim_matches(['"', '\'']);
                        (!item.is_empty()).then(|| Value::String(item.into()))
                    })
                    .collect::<Vec<_>>();
                out.insert(key.into(), Value::Array(values));
            }
        }
    }
    if !closed {
        return Err(ApiError::bad_request("malformed skill frontmatter"));
    }
    Ok(Value::Object(out))
}
#[cfg(unix)]
fn read_skill(root: &FsPath, name: &str) -> Result<Value, ApiError> {
    use std::ffi::CString;
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};

    valid_name(name)?;
    if fs::symlink_metadata(root.join(name))
        .map(|meta| meta.file_type().is_symlink())
        .unwrap_or(false)
    {
        return Err(ApiError::bad_request("invalid skill path"));
    }
    let root_file = fs::File::open(root)
        .map_err(|_| ApiError::unavailable("skills directory is unavailable"))?;
    let cname = CString::new(name).map_err(|_| ApiError::bad_request("invalid skill name"))?;
    let dir_fd = unsafe {
        libc::openat(
            root_file.as_raw_fd(),
            cname.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if dir_fd < 0 {
        let error = io::Error::last_os_error();
        return if error.raw_os_error() == Some(libc::ELOOP) {
            Err(ApiError::bad_request("invalid skill path"))
        } else {
            Err(ApiError::not_found(format!("skill '{name}' not found")))
        };
    }
    let dir = unsafe { OwnedFd::from_raw_fd(dir_fd) };
    let cmd = CString::new("SKILL.md").unwrap();
    let file_fd = unsafe {
        libc::openat(
            dir.as_raw_fd(),
            cmd.as_ptr(),
            libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if file_fd < 0 {
        return Err(ApiError::not_found(format!("skill '{name}' not found")));
    }
    let file = unsafe { fs::File::from_raw_fd(file_fd) };
    let meta = file
        .metadata()
        .map_err(|_| ApiError::unavailable("failed to read skill"))?;
    if !meta.file_type().is_file() || meta.file_type().is_symlink() {
        return Err(ApiError::bad_request("invalid skill path"));
    }
    if meta.len() > MAX_CONTENT_BYTES {
        return Err(ApiError {
            status: StatusCode::PAYLOAD_TOO_LARGE,
            code: "payload_too_large",
            message: "skill content exceeds 1 MiB".into(),
        });
    }
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
        map.insert("path".into(), json!(root.join(name)));
        map.insert("content".into(), json!(content));
    }
    Ok(value)
}
#[cfg(not(unix))]
fn read_skill(_root: &FsPath, _name: &str) -> Result<Value, ApiError> {
    Err(ApiError::not_implemented(
        "skills filesystem operations are unsupported on this platform",
    ))
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
async fn catalog_fetch(base: &str, path: &str) -> Result<Value, String> {
    let client = reqwest::Client::builder()
        .timeout(CATALOG_TIMEOUT)
        .build()
        .map_err(|e| e.to_string())?;
    let response = client
        .get(format!("{}{}", base.trim_end_matches('/'), path))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("catalog HTTP {}", response.status()));
    }
    if response.content_length().unwrap_or(0) > MAX_CATALOG_BYTES as u64 {
        return Err("catalog response too large".into());
    }
    let content_length = response.content_length();
    let mut bytes =
        Vec::with_capacity(content_length.unwrap_or(0).min(MAX_CATALOG_BYTES as u64) as usize);
    let mut response = response;
    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        if chunk.len() > MAX_CATALOG_BYTES.saturating_sub(bytes.len()) {
            return Err("catalog response too large".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|e| format!("malformed catalog response: {e}"))
}

async fn external_catalog_results(root: &FsPath) -> (Vec<Value>, Vec<String>) {
    let installed: std::collections::HashSet<String> = all_skills(root)
        .unwrap_or_default()
        .into_iter()
        .filter_map(|v| v["name"].as_str().map(String::from))
        .collect();
    let mut results = Vec::new();
    let mut degraded = Vec::new();
    for (provider, env, path) in [
        ("skills.sh", "SIGNET_SKILLS_SH_BASE_URL", "/api/skills"),
        ("clawhub", "SIGNET_CLAWHUB_BASE_URL", "/api/v1/skills"),
    ] {
        let base = std::env::var(env).unwrap_or_else(|_| {
            if provider == "skills.sh" {
                "https://skills.sh".into()
            } else {
                "https://clawhub.ai".into()
            }
        });
        match catalog_fetch(&base, path).await {
            Ok(value) => {
                let items = value
                    .get("skills")
                    .or_else(|| value.get("items"))
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                for item in items.into_iter().take(MAX_CATALOG_ITEMS) {
                    let name = item
                        .get("name")
                        .or_else(|| item.get("slug"))
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    if name.is_empty() {
                        continue;
                    }
                    let description = item
                        .get("description")
                        .or_else(|| item.get("summary"))
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    let installs = item
                        .get("installs")
                        .or_else(|| item.get("downloads"))
                        .and_then(Value::as_u64)
                        .unwrap_or(0);
                    results.push(json!({"name":name,"fullName":format!("{}@{}", provider, name),"catalogKey":format!("{}:{}",provider,name),"installsRaw":installs,"installs":installs.to_string(),"popularityScore":installs,"description":description,"installed":installed.contains(name),"provider":provider,"category":"Other"}));
                }
            }
            Err(error) => degraded.push(format!("{provider}: {error}")),
        }
    }
    results.sort_by(|a, b| {
        b["popularityScore"]
            .as_u64()
            .cmp(&a["popularityScore"].as_u64())
            .then_with(|| a["catalogKey"].as_str().cmp(&b["catalogKey"].as_str()))
    });
    results.truncate(MAX_CATALOG_ITEMS);
    (results, degraded)
}

async fn browse(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<ListQuery>,
) -> Result<Json<Value>, ApiError> {
    gate(&state, &headers, "skills:browse", false).await?;
    let max = limit(q.limit)?;
    let root = root_dir(&state)?;
    let local = all_skills(&root)?;
    let local = local
        .into_iter()
        .map(|mut item| {
            let name = item["name"].as_str().unwrap_or("").to_owned();
            if let Value::Object(map) = &mut item {
                map.insert("catalogKey".into(), json!(format!("local:{name}")));
                map.insert("provider".into(), json!("local"));
                map.insert("installed".into(), json!(true));
                map.insert("category".into(), json!("Installed"));
            }
            item
        })
        .collect::<Vec<_>>();
    let (mut external, degraded) = external_catalog_results(&root).await;
    let mut results = local;
    results.append(&mut external);
    results.sort_by(|a, b| {
        a["name"]
            .as_str()
            .cmp(&b["name"].as_str())
            .then_with(|| a["catalogKey"].as_str().cmp(&b["catalogKey"].as_str()))
    });
    let total = results.len();
    results.truncate(max);
    Ok(Json(
        json!({"results":results,"total":total,"truncated":total>results.len(),"degraded":degraded,"complete":degraded.is_empty()}),
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
    let _ = (state, name);
    Err(ApiError::not_implemented(
        "skill deletion is unsupported without an atomic directory-relative delete primitive",
    ))
}
