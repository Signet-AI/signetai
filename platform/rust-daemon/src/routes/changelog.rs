use crate::AppState;
use axum::{extract::State, http::StatusCode, response::IntoResponse, routing::get, Json, Router};

use reqwest::Client;
use serde::Serialize;
use serde_json::json;
use std::{
    collections::HashMap,
    env,
    path::PathBuf,
    sync::{Mutex, OnceLock},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

#[cfg(test)]
mod tests {
    use super::MAX_BYTES;

    #[test]
    fn rejects_chunked_response_when_accumulated_bytes_exceed_limit() {
        let mut accumulated = Vec::new();
        assert!(super::append_bounded(&mut accumulated, vec![0; MAX_BYTES - 1]).is_ok());
        assert!(super::append_bounded(&mut accumulated, vec![0; 2]).is_err());
    }
}

const BASE: &str = "https://raw.githubusercontent.com/Signet-AI/signetai/main";
const TTL_MS: u64 = 5 * 60 * 1000;
const MAX_BYTES: usize = 2 * 1024 * 1024;
const MAX_RELEASES: usize = 30;

fn append_bounded(accumulated: &mut Vec<u8>, chunk: Vec<u8>) -> Result<(), ()> {
    if chunk.len() > MAX_BYTES.saturating_sub(accumulated.len()) {
        return Err(());
    }
    accumulated.extend_from_slice(&chunk);
    Ok(())
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct Entry {
    html: String,
    source: &'static str,
    #[serde(rename = "cachedAt")]
    cached_at: u64,
}

fn cache() -> &'static Mutex<HashMap<&'static str, Entry>> {
    static CACHE_STORE: OnceLock<Mutex<HashMap<&'static str, Entry>>> = OnceLock::new();
    CACHE_STORE.get_or_init(|| Mutex::new(HashMap::new()))
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}
fn inline(s: &str) -> String {
    let mut out = s.to_owned();
    for (a, b) in [("**", "<strong>"), ("`", "<code>")] {
        let _ = (a, b);
    }
    out = regex_replace_pairs(&out, "**", "<strong>", "</strong>");
    out = regex_replace_pairs(&out, "`", "<code>", "</code>");
    out = regex_replace_pairs(&out, "*", "<em>", "</em>");
    out
}
fn regex_replace_pairs(input: &str, marker: &str, open: &str, close: &str) -> String {
    let mut out = String::new();
    let mut rest = input;
    let mut open_now = true;
    while let Some(i) = rest.find(marker) {
        out.push_str(&rest[..i]);
        out.push_str(if open_now { open } else { close });
        rest = &rest[i + marker.len()..];
        open_now = !open_now;
    }
    out.push_str(rest);
    out
}
fn flush_list(out: &mut Vec<String>, list: &mut bool) {
    if *list {
        *list = false;
        out.push("</ul>".into());
    }
}
fn render(md: &str) -> String {
    let mut out = Vec::new();
    let mut list = false;
    let lines: Vec<&str> = md.lines().collect();
    for (i, raw) in lines.iter().enumerate() {
        let next = lines.get(i + 1).copied().unwrap_or("");
        if !next.is_empty()
            && raw.trim() == *raw
            && (next.trim().chars().all(|c| c == '=') || next.trim().chars().all(|c| c == '-'))
        {
            flush_list(&mut out, &mut list);
            out.push(format!(
                "<h{}>{}</h{}>",
                if next.trim().starts_with('=') { 1 } else { 2 },
                escape(raw.trim()),
                if next.trim().starts_with('=') { 1 } else { 2 }
            ));
            continue;
        }
        if let Some(v) = raw.strip_prefix("### ") {
            flush_list(&mut out, &mut list);
            out.push(format!("<h3>{}</h3>", escape(v)));
            continue;
        }
        if let Some(v) = raw.strip_prefix("## ") {
            flush_list(&mut out, &mut list);
            out.push(format!("<h2>{}</h2>", escape(v)));
            continue;
        }
        if let Some(v) = raw.strip_prefix("# ") {
            flush_list(&mut out, &mut list);
            out.push(format!("<h1>{}</h1>", escape(v)));
            continue;
        }
        if raw.trim().starts_with("---") {
            flush_list(&mut out, &mut list);
            out.push("<hr>".into());
            continue;
        }
        if let Some(v) = raw.strip_prefix("- ") {
            if !list {
                out.push("<ul>".into());
                list = true;
            }
            out.push(format!("<li>{}</li>", inline(&escape(v))));
            continue;
        }
        if raw.trim().is_empty() {
            flush_list(&mut out, &mut list);
        } else {
            flush_list(&mut out, &mut list);
            out.push(format!("<p>{}</p>", inline(&escape(raw))));
        }
    }
    flush_list(&mut out, &mut list);
    out.join("\n")
}
fn truncate(s: &str) -> String {
    let parts: Vec<&str> = s.split("\n## [").collect();
    if parts.len() <= MAX_RELEASES + 1 {
        return s.into();
    }
    format!(
        "{}{}",
        parts[0],
        parts[1..=MAX_RELEASES]
            .iter()
            .map(|p| format!("\n## [{}", p))
            .collect::<String>()
    )
}
fn readme(s: &str) -> String {
    let clean: Vec<&str> = s
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with("![") && *l != "---")
        .take(18)
        .collect();
    if clean.is_empty() {
        "# Signet\n\nSignet overview unavailable.".into()
    } else {
        clean.join("\n")
    }
}
async fn source(state: &AppState, name: &'static str) -> Option<Entry> {
    let timestamp = now();
    if let Some(e) = cache()
        .lock()
        .ok()?
        .get(name)
        .filter(|e| timestamp.saturating_sub(e.cached_at) < TTL_MS)
        .cloned()
    {
        return Some(e);
    }
    let client = Client::builder()
        .timeout(Duration::from_secs(8))
        .build()
        .ok()?;
    let mut raw = None;
    let mut kind = "github";
    if let Ok(response) = client
        .get(format!("{BASE}/{name}"))
        .header("User-Agent", "signet-daemon")
        .send()
        .await
    {
        if response.status().is_success()
            && response.content_length().unwrap_or(0) <= MAX_BYTES as u64
        {
            let mut response = response;
            let mut bytes = Vec::new();
            let mut within_limit = true;
            loop {
                match response.chunk().await {
                    Ok(Some(chunk)) if append_bounded(&mut bytes, chunk.to_vec()).is_ok() => {}
                    Ok(None) => break,
                    _ => {
                        within_limit = false;
                        break;
                    }
                }
            }
            if within_limit {
                raw = String::from_utf8(bytes).ok();
            }
        }
    }
    if raw.is_none() && env::var("SIGNET_DEV_REPO_ROOT").is_ok() {
        let root = PathBuf::from(env::var("SIGNET_DEV_REPO_ROOT").ok()?);
        let path = root.join(name);
        if let Ok(bytes) = std::fs::read(path) {
            if bytes.len() <= MAX_BYTES {
                raw = String::from_utf8(bytes).ok();
                kind = "local";
            }
        }
    }
    let raw = raw?;
    let content = match name {
        "CHANGELOG.md" => truncate(&raw),
        "README.md" => readme(&raw),
        _ => raw,
    };
    let entry = Entry {
        html: render(&content),
        source: kind,
        cached_at: timestamp,
    };
    cache().lock().ok()?.insert(name, entry.clone());
    let _ = state;
    Some(entry)
}
async fn serve(
    State(state): State<AppState>,
    name: &'static str,
    unavailable: &'static str,
) -> impl IntoResponse {
    match source(&state, name).await {
        Some(e) => (StatusCode::OK, Json(e)).into_response(),
        None => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"error": unavailable})),
        )
            .into_response(),
    }
}
pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/changelog",
            get(|s| serve(s, "CHANGELOG.md", "Changelog unavailable")),
        )
        .route(
            "/api/roadmap",
            get(|s| serve(s, "ROADMAP.md", "Roadmap unavailable")),
        )
        .route(
            "/api/readme",
            get(|s| serve(s, "README.md", "README unavailable")),
        )
}
