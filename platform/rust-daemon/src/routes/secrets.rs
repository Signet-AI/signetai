use crate::{execute, routes::auth, ApiError, AppState};
use axum::{
    extract::{rejection::JsonRejection, Path, Query, State},
    http::{HeaderMap, StatusCode},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::Value;
#[cfg(unix)]
use std::os::unix::process::CommandExt;
use std::{
    collections::HashMap,
    io::Read,
    process::{Child, Command, Stdio},
    sync::{Mutex, OnceLock},
    thread,
    time::{Duration, Instant},
};
use time::OffsetDateTime;
use uuid::Uuid;

const MAX_QUEUE: usize = 64;
const MAX_RUNNING: usize = 4;
const MAX_OUTPUT: usize = 1_048_576;
const RETENTION: Duration = Duration::from_secs(60 * 60);
const DEFAULT_TIMEOUT: u64 = 300_000;
const MIN_TIMEOUT: u64 = 1_000;
const MAX_TIMEOUT: u64 = 1_800_000;
const STDOUT_MARKER: &str = "[signet secret exec: stdout truncated]";
const STDERR_MARKER: &str = "[signet secret exec: stderr truncated]";
const TIMEOUT_MARKER_PREFIX: &str = "[signet secret exec: timed out after ";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExecBody {
    command: String,
    secrets: HashMap<String, String>,
    timeout_ms: Option<u64>,
    max_output_bytes: Option<usize>,
}
#[derive(Deserialize, Default)]
struct ListQuery {
    limit: Option<usize>,
}
#[derive(Deserialize)]
struct SecretBody {
    name: String,
    value: String,
}
struct JobEntry {
    json: Value,
    created: Instant,
    agent_id: String,
    workspace_id: String,
}
struct JobStore {
    jobs: HashMap<String, JobEntry>,
    running: usize,
}
static JOBS: OnceLock<Mutex<JobStore>> = OnceLock::new();
fn jobs() -> &'static Mutex<JobStore> {
    JOBS.get_or_init(|| {
        Mutex::new(JobStore {
            jobs: HashMap::new(),
            running: 0,
        })
    })
}
fn now() -> String {
    OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".into())
}
fn bounded(v: &str, label: &str, max: usize) -> Result<String, ApiError> {
    if v.trim().is_empty() || v.len() > max {
        Err(ApiError::bad_request(format!(
            "{label} must be 1-{max} UTF-8 bytes"
        )))
    } else {
        Ok(v.to_owned())
    }
}
fn header_alias(h: &HeaderMap, names: &[&str], label: &str) -> Result<Option<String>, ApiError> {
    let mut out = None;
    for n in names {
        for v in h.get_all(*n).iter() {
            let v = v
                .to_str()
                .map_err(|_| ApiError::bad_request(format!("{label} header must be valid UTF-8")))?
                .trim();
            if v.is_empty() {
                continue;
            }
            if out.as_deref().is_some_and(|x| x != v) {
                return Err(ApiError::bad_request(format!(
                    "conflicting {label} aliases"
                )));
            }
            out = Some(v.to_owned());
        }
    }
    Ok(out)
}
async fn authority(
    state: &AppState,
    h: &HeaderMap,
    cap: &str,
) -> Result<(String, String), ApiError> {
    let c = auth::gate(state, h).await?;
    if c.get("role").and_then(Value::as_str) != Some("admin") {
        return Err(ApiError {
            status: StatusCode::FORBIDDEN,
            code: "forbidden",
            message: "admin authority is required".into(),
        });
    }
    let p = c
        .get("permissions")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if !p.is_empty() && !p.iter().any(|v| v.as_str() == Some(cap)) {
        return Err(ApiError {
            status: StatusCode::FORBIDDEN,
            code: "forbidden",
            message: format!("{cap} capability is required"),
        });
    }
    let a = header_alias(h, &["x-signet-agent-id", "x-signet-agent"], "agent")?
        .or_else(|| c.get("agentId").and_then(Value::as_str).map(str::to_owned))
        .ok_or_else(|| ApiError::unauthorized("agent identity is required"))?;
    let w = header_alias(
        h,
        &[
            "x-signet-workspace-id",
            "x-signet-workspace",
            "x-workspace-id",
        ],
        "workspace",
    )?
    .unwrap_or_else(|| "default".into());
    if let Some(s) = c.get("scope").and_then(Value::as_object) {
        if s.get("agent")
            .and_then(Value::as_str)
            .is_some_and(|x| x != a)
            || s.get("workspace")
                .and_then(Value::as_str)
                .is_some_and(|x| x != w)
        {
            return Err(ApiError {
                status: StatusCode::FORBIDDEN,
                code: "forbidden",
                message: "requested scope exceeds authenticated authority".into(),
            });
        }
    }
    Ok((
        bounded(&a, "agent id", 256)?,
        bounded(&w, "workspace id", 256)?,
    ))
}

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/api/secrets", get(list).post(upsert))
        .route("/api/secrets/{name}", post(upsert_named).delete(remove))
        .route("/api/secrets/exec", post(exec))
        .route("/api/secrets/exec/{job_id}", get(exec_status))
        .route("/api/secrets/{name}/exec", post(unsupported_exec))
        .route(
            "/api/secrets/1password/{*rest}",
            get(unsupported_provider).post(unsupported_provider),
        )
        .route(
            "/api/secrets/bitwarden/{*rest}",
            get(unsupported_provider).post(unsupported_provider),
        )
}
async fn list(
    State(s): State<AppState>,
    h: HeaderMap,
    Query(q): Query<ListQuery>,
) -> Result<Json<Value>, ApiError> {
    let (a, w) = authority(&s, &h, "secrets:list").await?;
    let l = q.limit.unwrap_or(100);
    if l == 0 || l > 100 {
        return Err(ApiError::bad_request("limit must be between 1 and 100"));
    }
    let r = execute(
        &s,
        signet_core_native::Operation::SecretList {
            agent_id: a,
            workspace_id: w,
            limit: l,
        },
    )
    .await?;
    Ok(Json(
        serde_json::json!({"secrets":r.get("items").cloned().unwrap_or(Value::Array(vec![])),"provider":"local"}),
    ))
}
async fn upsert(
    State(s): State<AppState>,
    h: HeaderMap,
    Json(b): Json<SecretBody>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    upsert_inner(s, h, b.name, b.value).await
}
async fn upsert_named(
    State(s): State<AppState>,
    h: HeaderMap,
    Path(n): Path<String>,
    Json(b): Json<Value>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    upsert_inner(
        s,
        h,
        n,
        b.get("value")
            .and_then(Value::as_str)
            .ok_or_else(|| ApiError::bad_request("value is required"))?
            .into(),
    )
    .await
}
async fn upsert_inner(
    s: AppState,
    h: HeaderMap,
    n: String,
    v: String,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let (a, w) = authority(&s, &h, "secrets:write").await?;
    let n = bounded(&n, "secret name", 256)?;
    let v = bounded(&v, "secret value", 64 * 1024)?;
    execute(
        &s,
        signet_core_native::Operation::SecretUpsert {
            agent_id: a,
            workspace_id: w,
            name: n.clone(),
            value: v,
        },
    )
    .await?;
    Ok((
        StatusCode::CREATED,
        Json(serde_json::json!({"success":true,"name":n})),
    ))
}
async fn remove(
    State(s): State<AppState>,
    h: HeaderMap,
    Path(n): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let (a, w) = authority(&s, &h, "secrets:delete").await?;
    execute(
        &s,
        signet_core_native::Operation::SecretDelete {
            agent_id: a,
            workspace_id: w,
            name: bounded(&n, "secret name", 256)?,
        },
    )
    .await?;
    Ok(Json(serde_json::json!({"success":true,"name":n})))
}

fn argv(command: &str) -> Result<Vec<String>, ApiError> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut quote = None;
    let mut esc = false;
    for c in command.chars() {
        if esc {
            cur.push(c);
            esc = false;
            continue;
        }
        if c == '\\' {
            esc = true;
            continue;
        }
        if let Some(q) = quote {
            if c == q {
                quote = None;
            } else {
                cur.push(c);
            }
            continue;
        }
        if c == '\'' || c == '"' {
            quote = Some(c);
            continue;
        }
        if ";|&`$(){}[]<>!".contains(c) {
            return Err(ApiError::bad_request("command is invalid"));
        }
        if c.is_whitespace() {
            if !cur.is_empty() {
                out.push(std::mem::take(&mut cur));
            }
        } else {
            cur.push(c);
        }
    }
    if esc || quote.is_some() {
        return Err(ApiError::bad_request("command is invalid"));
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    if out.is_empty() {
        Err(ApiError::bad_request("command is invalid"))
    } else {
        Ok(out)
    }
}
fn valid_identifier(v: &str) -> bool {
    let mut it = v.chars();
    matches!(it.next(), Some(c) if c == '_' || c.is_ascii_alphabetic())
        && it.all(|c| c == '_' || c.is_ascii_alphanumeric())
}
fn validate_identifier(v: &str, label: &str) -> Result<(), ApiError> {
    if valid_identifier(v) {
        Ok(())
    } else {
        Err(ApiError::bad_request(format!(
            "{label} must be a valid identifier"
        )))
    }
}
fn redact(mut s: String, vals: &[String]) -> String {
    for v in vals {
        if !v.is_empty() {
            s = s.replace(v, "[REDACTED]");
        }
    }
    s
}
fn collect(mut r: impl Read, cap: usize) -> (Vec<u8>, bool) {
    let mut out = Vec::new();
    let mut buf = [0u8; 8192];
    let mut truncated = false;
    loop {
        match r.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                let keep = (cap.saturating_sub(out.len())).min(n);
                out.extend_from_slice(&buf[..keep]);
                if keep < n {
                    truncated = true;
                }
            }
            Err(_) => break,
        }
    }
    (out, truncated)
}
fn run(argv: Vec<String>, env: HashMap<String, String>, timeout: u64, cap: usize) -> Value {
    let capture_cap = cap.saturating_add(env.values().map(|v| v.len()).max().unwrap_or(0));
    let mut c = Command::new(&argv[0]);
    c.args(&argv[1..])
        .envs(&env)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    unsafe {
        c.pre_exec(|| {
            if libc::setpgid(0, 0) != 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut child: Child = match c.spawn() {
        Ok(c) => c,
        Err(_) => return serde_json::json!({"status":"failed","error":"process failed"}),
    };
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");
    let out_thread = thread::spawn(move || collect(stdout, capture_cap));
    let err_thread = thread::spawn(move || collect(stderr, capture_cap));
    let start = Instant::now();
    let mut timed_out = false;
    let code;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                code = status.code().unwrap_or(1);
                break;
            }
            Ok(None) if start.elapsed() >= Duration::from_millis(timeout) => {
                timed_out = true;
                #[cfg(unix)]
                unsafe {
                    let _ = libc::kill(-(child.id() as i32), libc::SIGTERM);
                }
                #[cfg(windows)]
                {
                    let _ = child.kill();
                }
                let _ = child.wait();
                code = 124;
                break;
            }
            Ok(None) => thread::sleep(Duration::from_millis(10)),
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return serde_json::json!({"status":"failed","error":"process failed"});
            }
        }
    }
    let (out, out_truncated) = out_thread.join().unwrap_or_default();
    let (err, err_truncated) = err_thread.join().unwrap_or_default();
    let vals = env.values().cloned().collect::<Vec<_>>();
    let mut stdout = redact(String::from_utf8_lossy(&out).into_owned(), &vals);
    let mut stderr = redact(String::from_utf8_lossy(&err).into_owned(), &vals);
    let out_truncated = out_truncated || stdout.len() > cap;
    let err_truncated = err_truncated || stderr.len() > cap;
    if stdout.len() > cap {
        stdout.truncate(cap);
    }
    if stderr.len() > cap {
        stderr.truncate(cap);
    }
    if out_truncated {
        stdout.push_str("\n");
        stdout.push_str(STDOUT_MARKER);
    }
    if err_truncated {
        stderr.push_str("\n");
        stderr.push_str(STDERR_MARKER);
    }
    if timed_out {
        stderr.push_str("\n");
        stderr.push_str(TIMEOUT_MARKER_PREFIX);
        stderr.push_str(&timeout.to_string());
        stderr.push_str("ms]");
    }
    serde_json::json!({"stdout":stdout,"stderr":stderr,"code":code,"timedOut":timed_out,"truncated":out_truncated || err_truncated,"status":if timed_out || code != 0 {"failed"} else {"completed"}})
}

async fn exec(
    State(s): State<AppState>,
    h: HeaderMap,
    body: Result<Json<ExecBody>, JsonRejection>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let (a, w) = authority(&s, &h, "secrets:exec").await?;
    let Json(b) = body.map_err(|_| ApiError::bad_request("invalid JSON request body"))?;
    let av = argv(&b.command)?;
    if b.secrets.is_empty() {
        return Err(ApiError::bad_request(
            "secrets must be a non-empty string map",
        ));
    }
    for (key, name) in &b.secrets {
        validate_identifier(key, "environment key")?;
        validate_identifier(name.strip_prefix("local://").unwrap_or(name), "secret name")?;
    }
    let timeout = b
        .timeout_ms
        .unwrap_or(DEFAULT_TIMEOUT)
        .clamp(MIN_TIMEOUT, MAX_TIMEOUT);
    let cap = b
        .max_output_bytes
        .unwrap_or(MAX_OUTPUT)
        .clamp(1, MAX_OUTPUT);
    let id = Uuid::new_v4().to_string();
    let created = now();
    {
        let mut store = jobs().lock().unwrap();
        store.jobs.retain(|_, e| {
            e.created.elapsed() < RETENTION
                || matches!(
                    e.json.get("status").and_then(Value::as_str),
                    Some("queued" | "running")
                )
        });
        let queued = store
            .jobs
            .values()
            .filter(|e| e.json.get("status").and_then(Value::as_str) == Some("queued"))
            .count();
        if queued >= MAX_QUEUE {
            return Err(ApiError {
                status: StatusCode::TOO_MANY_REQUESTS,
                code: "queue_full",
                message: "execution queue is full".into(),
            });
        }
        store.jobs.insert(id.clone(), JobEntry { json: serde_json::json!({"id":id,"status":"queued","createdAt":created,"startedAt":Value::Null,"completedAt":Value::Null,"timeoutMs":timeout,"result":Value::Null,"error":Value::Null}), created: Instant::now(), agent_id: a.clone(), workspace_id: w.clone() });
    }
    let refs = b.secrets;
    let jid = id.clone();
    tokio::spawn(async move {
        loop {
            let acquired = {
                let mut store = jobs().lock().unwrap();
                if store.running < MAX_RUNNING {
                    store.running += 1;
                    if let Some(e) = store.jobs.get_mut(&jid) {
                        e.json["status"] = Value::String("running".into());
                        e.json["startedAt"] = Value::String(now());
                    }
                    true
                } else {
                    false
                }
            };
            if acquired {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let mut env = HashMap::new();
        let mut resolve_failed = false;
        for (key, name) in refs {
            match execute(
                &s,
                signet_core_native::Operation::SecretGet {
                    agent_id: a.clone(),
                    workspace_id: w.clone(),
                    name,
                },
            )
            .await
            {
                Ok(v) => {
                    if let Some(value) = v.get("value").and_then(Value::as_str) {
                        env.insert(key, value.to_owned());
                    } else {
                        resolve_failed = true;
                        break;
                    }
                }
                Err(_) => {
                    resolve_failed = true;
                    break;
                }
            }
        }
        let result = if resolve_failed {
            None
        } else {
            Some(
                tokio::task::spawn_blocking(move || run(av, env, timeout, cap))
                    .await
                    .unwrap_or_else(
                        |_| serde_json::json!({"status":"failed","error":"process failed"}),
                    ),
            )
        };
        let mut store = jobs().lock().unwrap();
        store.running = store.running.saturating_sub(1);
        if let Some(e) = store.jobs.get_mut(&jid) {
            e.json["status"] = Value::String(
                if result
                    .as_ref()
                    .and_then(|r| r.get("status"))
                    .and_then(Value::as_str)
                    == Some("completed")
                {
                    "completed"
                } else {
                    "failed"
                }
                .into(),
            );
            e.json["completedAt"] = Value::String(now());
            if let Some(r) = result {
                e.json["result"] = r;
            } else {
                e.json["error"] = Value::String("secret resolution failed".into());
            }
        }
    });
    Ok((
        StatusCode::ACCEPTED,
        Json(
            serde_json::json!({"id":id,"status":"queued","createdAt":created,"timeoutMs":timeout}),
        ),
    ))
}
async fn exec_status(
    State(s): State<AppState>,
    h: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let (a, w) = authority(&s, &h, "secrets:exec").await?;
    let mut store = jobs().lock().unwrap();
    store.jobs.retain(|_, e| {
        e.created.elapsed() < RETENTION
            || matches!(
                e.json.get("status").and_then(Value::as_str),
                Some("queued" | "running")
            )
    });
    store
        .jobs
        .get(&id)
        .ok_or_else(|| ApiError::not_found("job not found"))
        .and_then(|e| {
            if e.agent_id == a && e.workspace_id == w {
                Ok(Json(e.json.clone()))
            } else {
                Err(ApiError {
                    status: StatusCode::FORBIDDEN,
                    code: "forbidden",
                    message: "job is outside authenticated scope".into(),
                })
            }
        })
}
async fn unsupported_exec(
    State(s): State<AppState>,
    h: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let _ = authority(&s, &h, "secrets:exec").await?;
    Err(ApiError {
        status: StatusCode::NOT_IMPLEMENTED,
        code: "unsupported",
        message: "secret execution is unsupported".into(),
    })
}
async fn unsupported_provider(
    State(s): State<AppState>,
    h: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let _ = authority(&s, &h, "secrets:providers:list").await?;
    Err(ApiError {
        status: StatusCode::NOT_IMPLEMENTED,
        code: "unsupported",
        message: "external secret providers are unsupported".into(),
    })
}
