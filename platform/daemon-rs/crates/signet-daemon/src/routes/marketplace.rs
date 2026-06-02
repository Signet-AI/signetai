//! MCP marketplace routes.
//!
//! Server management, tool listing/search, scope/policy endpoints.
//! Installed servers and policy stored as JSON in `~/.agents/marketplace/`.

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use axum::{
    Json,
    body::Bytes,
    extract::{Path, Query, State},
    http::StatusCode,
    response::IntoResponse,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

use crate::state::AppState;
use crate::workspace_paths;

const DEFAULT_TIMEOUT_MS: u64 = 20_000;
const MCP_PROTOCOL_VERSION: &str = "2024-11-05";
const CATALOG_PAGE_SIZE: usize = 30;
const CATALOG_MAX_PAGES: usize = 10;
const MAX_README_BYTES: usize = 2 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServer {
    pub id: String,
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub catalog_id: Option<String>,
    pub name: String,
    pub description: String,
    pub category: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub homepage: Option<String>,
    pub official: bool,
    pub enabled: bool,
    pub scope: McpScope,
    pub config: serde_json::Value,
    pub installed_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct McpScope {
    #[serde(default)]
    pub harnesses: Vec<String>,
    #[serde(default)]
    pub workspaces: Vec<String>,
    #[serde(default)]
    pub channels: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExposurePolicy {
    pub mode: String,
    pub max_expanded_tools: u32,
    pub max_search_results: u32,
    pub updated_at: String,
}

fn parse_positive_int(value: Option<&Value>, fallback: u32, min: u32, max: u32) -> u32 {
    let Some(value) = value else {
        return fallback;
    };
    let Some(number) = value.as_f64().filter(|number| number.is_finite()) else {
        return fallback;
    };
    let rounded = number.round().clamp(min as f64, max as f64);
    rounded as u32
}

impl Default for ExposurePolicy {
    fn default() -> Self {
        Self {
            mode: "hybrid".into(),
            max_expanded_tools: 12,
            max_search_results: 8,
            // Sentinel: "never explicitly set" — not process start time, which
            // would be misleading since Default is returned when no policy file exists.
            updated_at: "1970-01-01T00:00:00.000Z".into(),
        }
    }
}

#[allow(dead_code)] // Used when tool discovery is implemented
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpTool {
    pub id: String,
    pub server_id: String,
    pub server_name: String,
    pub tool_name: String,
    pub description: String,
    pub read_only: bool,
    pub input_schema: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogEntry {
    pub id: String,
    pub source: String,
    pub catalog_id: String,
    pub name: String,
    pub description: String,
    pub category: String,
    pub official: bool,
    pub sponsor: bool,
    pub popularity_rank: usize,
    pub source_url: String,
}

#[derive(Debug, Clone)]
struct ParsedCatalogPage {
    total: usize,
    entries: Vec<CatalogEntry>,
}

#[derive(Debug, Clone)]
struct DetailConfig {
    name_hint: Option<String>,
    config: Option<Value>,
    github_url: Option<String>,
    description: String,
}

// ---------------------------------------------------------------------------
// File persistence helpers
// ---------------------------------------------------------------------------

pub(crate) fn load_servers(state: &AppState) -> Vec<McpServer> {
    let Ok(path) = workspace_paths::child_file(
        &state.config.base_path,
        &["marketplace", "mcp-servers.json"],
    ) else {
        return Vec::new();
    };
    match std::fs::read_to_string(&path) {
        Ok(data) => serde_json::from_str(&data).unwrap_or_default(),
        Err(_) => Vec::new(),
    }
}

pub(crate) fn save_servers(state: &AppState, servers: &[McpServer]) -> Result<(), String> {
    let path = workspace_paths::child_file(
        &state.config.base_path,
        &["marketplace", "mcp-servers.json"],
    )
    .map_err(|e| format!("path: {e}"))?;
    let json = serde_json::to_string_pretty(servers).map_err(|e| format!("serialize: {e}"))?;
    std::fs::write(path, json).map_err(|e| format!("write: {e}"))
}

fn to_string_array(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn to_string_record(value: Option<&Value>) -> serde_json::Map<String, Value> {
    let mut out = serde_json::Map::new();
    if let Some(object) = value.and_then(Value::as_object) {
        for (key, value) in object {
            if let Some(text) = value.as_str() {
                out.insert(key.clone(), Value::String(text.to_string()));
            }
        }
    }
    out
}

fn normalize_mcp_config(value: Option<&Value>) -> Option<Value> {
    let object = value?.as_object()?;
    if let Some(url) = object
        .get("url")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return Some(serde_json::json!({
            "transport": "http",
            "url": url,
            "headers": to_string_record(object.get("headers")),
            "timeoutMs": DEFAULT_TIMEOUT_MS,
        }));
    }

    if let Some(command) = object
        .get("command")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return Some(serde_json::json!({
            "transport": "stdio",
            "command": command,
            "args": to_string_array(object.get("args")),
            "env": to_string_record(object.get("env")),
            "cwd": object.get("cwd").and_then(Value::as_str),
            "timeoutMs": DEFAULT_TIMEOUT_MS,
        }));
    }

    let command_parts = to_string_array(object.get("command"));
    let Some((command, args_from_command)) = command_parts.split_first() else {
        return None;
    };
    if command.trim().is_empty() {
        return None;
    }
    let mut args = args_from_command.to_vec();
    args.extend(to_string_array(object.get("args")));
    Some(serde_json::json!({
        "transport": "stdio",
        "command": command,
        "args": args,
        "env": to_string_record(object.get("env")),
        "cwd": object.get("cwd").and_then(Value::as_str),
        "timeoutMs": DEFAULT_TIMEOUT_MS,
    }))
}

pub(crate) fn normalize_scope(value: Option<&Value>) -> McpScope {
    let Some(object) = value.and_then(Value::as_object) else {
        return McpScope::default();
    };
    let normalize_values = |key: &str| {
        let mut seen = std::collections::HashSet::new();
        to_string_array(object.get(key))
            .into_iter()
            .filter_map(|value| {
                let trimmed = value.trim();
                if trimmed.is_empty() {
                    return None;
                }
                let lower = trimmed.to_lowercase();
                if seen.insert(lower) {
                    Some(trimmed.to_string())
                } else {
                    None
                }
            })
            .collect()
    };
    McpScope {
        harnesses: normalize_values("harnesses"),
        workspaces: normalize_values("workspaces"),
        channels: normalize_values("channels"),
    }
}

fn sanitize_server_id(value: &str) -> String {
    let mut out = String::new();
    let mut last_dash = false;
    for ch in value.trim().to_lowercase().chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
            out.push(ch);
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
    }
    let normalized = out.trim_matches('-').to_string();
    if normalized.is_empty() {
        "mcp-server".to_string()
    } else {
        normalized
    }
}

fn unique_server_id(base_id: &str, servers: &[McpServer]) -> String {
    if !servers.iter().any(|server| server.id == base_id) {
        return base_id.to_string();
    }
    let mut suffix = 2;
    loop {
        let candidate = format!("{base_id}-{suffix}");
        if !servers.iter().any(|server| server.id == candidate) {
            return candidate;
        }
        suffix += 1;
    }
}

fn infer_name_from_catalog_id(catalog_id: &str) -> String {
    let repo = catalog_id.rsplit('/').next().unwrap_or(catalog_id);
    let cleaned = repo
        .trim_start_matches("mcp-")
        .trim_start_matches("mcp_")
        .replace(['-', '_'], " ");
    let words = cleaned
        .split_whitespace()
        .map(|word| {
            let mut chars = word.chars();
            match chars.next() {
                Some(first) => format!("{}{}", first.to_uppercase(), chars.as_str()),
                None => String::new(),
            }
        })
        .filter(|word| !word.is_empty())
        .collect::<Vec<_>>();
    if words.is_empty() {
        catalog_id.to_string()
    } else {
        words.join(" ")
    }
}

fn infer_category(text: &str) -> &'static str {
    let source = text.to_lowercase();
    if ["browser", "scrap", "crawl", "web"]
        .iter()
        .any(|term| source.contains(term))
    {
        return "Web";
    }
    if ["slack", "discord", "email", "sms", "message", "chat"]
        .iter()
        .any(|term| source.contains(term))
    {
        return "Communication";
    }
    if [
        "database", "sql", "postgres", "mysql", "sqlite", "d1", "redis", "vector",
    ]
    .iter()
    .any(|term| source.contains(term))
    {
        return "Database";
    }
    if ["github", "git", "ci", "deploy", "build", "code", "dev"]
        .iter()
        .any(|term| source.contains(term))
    {
        return "Development";
    }
    if ["cloud", "aws", "gcp", "azure", "vercel", "cloudflare"]
        .iter()
        .any(|term| source.contains(term))
    {
        return "Cloud";
    }
    if ["finance", "stock", "market", "crypto", "trading"]
        .iter()
        .any(|term| source.contains(term))
    {
        return "Finance";
    }
    if ["memory", "knowledge", "search", "docs", "rag"]
        .iter()
        .any(|term| source.contains(term))
    {
        return "Knowledge";
    }
    if ["file", "storage", "drive", "s3", "bucket"]
        .iter()
        .any(|term| source.contains(term))
    {
        return "Storage";
    }
    "Other"
}

fn parse_catalog_selection(raw_id: &str, raw_source: Option<&str>) -> Option<(String, String)> {
    for source in ["modelcontextprotocol/servers", "mcpservers.org", "github"] {
        let prefix = format!("{source}:");
        if let Some(catalog_id) = raw_id.strip_prefix(&prefix) {
            return Some((source.to_string(), catalog_id.to_string()));
        }
    }
    match raw_source {
        Some("modelcontextprotocol/servers") => Some((
            "modelcontextprotocol/servers".to_string(),
            raw_id.to_string(),
        )),
        Some("github") => Some(("github".to_string(), raw_id.to_string())),
        Some("mcpservers.org") | None => Some(("mcpservers.org".to_string(), raw_id.to_string())),
        Some(_) => None,
    }
}

fn catalog_selection_key(source: &str, catalog_id: &str) -> String {
    format!("{source}:{catalog_id}")
}

fn make_catalog_entry_id(source: &str, catalog_id: &str) -> String {
    catalog_selection_key(source, catalog_id)
}

fn first_number_after_of_servers(markdown: &str) -> usize {
    let lower = markdown.to_lowercase();
    let Some(of_index) = lower.find("of ") else {
        return 0;
    };
    let after = &lower[of_index + 3..];
    let Some(servers_index) = after.find(" servers") else {
        return 0;
    };
    after[..servers_index].trim().parse::<usize>().unwrap_or(0)
}

fn strip_markdown_badges(value: &str) -> (String, bool, bool) {
    let official = value.to_lowercase().contains("official");
    let sponsor = value.to_lowercase().contains("sponsor");
    let cleaned = value
        .replace("Official", "")
        .replace("official", "")
        .replace("Sponsor", "")
        .replace("sponsor", "")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    (cleaned, official, sponsor)
}

fn find_markdown_links(markdown: &str) -> Vec<(String, String)> {
    let mut links = Vec::new();
    let mut rest = markdown;
    while let Some(label_start) = rest.find('[') {
        let after_label_start = &rest[label_start + 1..];
        let Some(label_end) = after_label_start.find(']') else {
            break;
        };
        let label = &after_label_start[..label_end];
        let after_label = &after_label_start[label_end + 1..];
        if !after_label.starts_with('(') {
            rest = after_label;
            continue;
        }
        let Some(url_end) = after_label[1..].find(')') else {
            break;
        };
        links.push((label.to_string(), after_label[1..1 + url_end].to_string()));
        rest = &after_label[1 + url_end + 1..];
    }
    links
}

fn parse_catalog_markdown(markdown: &str, page: usize) -> ParsedCatalogPage {
    let mut seen = std::collections::HashSet::new();
    let entries = find_markdown_links(markdown)
        .into_iter()
        .filter_map(|(raw_text, url)| {
            let marker = "mcpservers.org/";
            let marker_index = url.find(marker)?;
            let path = &url[marker_index + marker.len()..];
            let server_index = path.find("servers/")?;
            let catalog_id = path[server_index + "servers/".len()..]
                .trim_matches('/')
                .to_string();
            if catalog_id.is_empty() || !seen.insert(catalog_id.clone()) {
                return None;
            }
            let (cleaned, official, sponsor) = strip_markdown_badges(&raw_text);
            let name = infer_name_from_catalog_id(&catalog_id);
            let description = if cleaned.is_empty() {
                format!("{name} MCP server")
            } else {
                cleaned
            };
            let popularity_rank = (page.saturating_sub(1)) * CATALOG_PAGE_SIZE + seen.len();
            Some(CatalogEntry {
                id: make_catalog_entry_id("mcpservers.org", &catalog_id),
                source: "mcpservers.org".to_string(),
                catalog_id,
                name: name.clone(),
                category: infer_category(&format!("{name} {description}")).to_string(),
                description,
                official,
                sponsor,
                popularity_rank,
                source_url: url,
            })
        })
        .collect();

    ParsedCatalogPage {
        total: first_number_after_of_servers(markdown),
        entries,
    }
}

fn parse_reference_servers_markdown(markdown: &str) -> Vec<CatalogEntry> {
    let mut entries = Vec::new();
    let mut seen = std::collections::HashSet::new();

    if let Some(start) = markdown.find("Reference Servers") {
        let after = &markdown[start..];
        let archived = after.find("\n### Archived").unwrap_or(after.len());
        let next_section = after[1..]
            .find("\n## ")
            .map(|idx| idx + 1)
            .unwrap_or(after.len());
        let end = archived.min(next_section);
        for line in after[..end].lines() {
            let Some(prefix) = line.find("- **[") else {
                continue;
            };
            let line = &line[prefix + 5..];
            let Some(name_end) = line.find("](src/") else {
                continue;
            };
            let name = line[..name_end].trim();
            let rest = &line[name_end + 6..];
            let Some(path_end) = rest.find(")**") else {
                continue;
            };
            let path = rest[..path_end].trim();
            let Some(desc_index) = rest[path_end + 3..].find(" - ") else {
                continue;
            };
            let desc = rest[path_end + 3 + desc_index + 3..].trim();
            let slug = path.rsplit('/').next().unwrap_or(path);
            let id = make_catalog_entry_id("modelcontextprotocol/servers", slug);
            if name.is_empty() || slug.is_empty() || !seen.insert(id.clone()) {
                continue;
            }
            entries.push(CatalogEntry {
                id,
                source: "modelcontextprotocol/servers".to_string(),
                catalog_id: slug.to_string(),
                name: name.to_string(),
                description: desc.to_string(),
                category: infer_category(&format!("{name} {desc}")).to_string(),
                official: true,
                sponsor: false,
                popularity_rank: entries.len() + 1,
                source_url: format!(
                    "https://github.com/modelcontextprotocol/servers/tree/main/src/{path}"
                ),
            });
        }
    }

    if let Some(start) = markdown.find("Third-Party Servers") {
        let after = &markdown[start..];
        let end = after[1..]
            .find("\n## ")
            .map(|idx| idx + 1)
            .unwrap_or(after.len());
        let mut rank = 0_usize;
        for line in after[..end].lines() {
            let Some(name_start) = line.find("**[") else {
                continue;
            };
            let line = &line[name_start + 3..];
            let Some(name_end) = line.find("](") else {
                continue;
            };
            let name = line[..name_end].trim();
            let rest = &line[name_end + 2..];
            let Some(url_end) = rest.find(")**") else {
                continue;
            };
            let url = rest[..url_end].trim();
            let Some(desc_index) = rest[url_end + 3..].find(" - ") else {
                continue;
            };
            let desc = strip_html_tags(&rest[url_end + 3 + desc_index + 3..]);
            let Some(slug) = github_slug_from_url(url) else {
                continue;
            };
            let id = make_catalog_entry_id("github", &slug);
            if name.is_empty() || !seen.insert(id.clone()) {
                continue;
            }
            rank += 1;
            entries.push(CatalogEntry {
                id,
                source: "github".to_string(),
                catalog_id: slug,
                name: name.to_string(),
                description: desc,
                category: infer_category(name).to_string(),
                official: false,
                sponsor: false,
                popularity_rank: rank,
                source_url: url.to_string(),
            });
        }
    }

    entries
}

fn strip_html_tags(value: &str) -> String {
    let mut out = String::new();
    let mut in_tag = false;
    for ch in value.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(ch),
            _ => {}
        }
    }
    out.trim().to_string()
}

fn github_slug_from_url(url: &str) -> Option<String> {
    let marker = "github.com/";
    let start = url.find(marker)? + marker.len();
    let mut parts = url[start..].trim_end_matches('/').split('/');
    let org = parts.next()?.trim();
    let repo = parts.next()?.trim();
    if org.is_empty() || repo.is_empty() {
        return None;
    }
    let valid = |value: &str| {
        value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-'))
    };
    if valid(org) && valid(repo) {
        Some(format!("{org}/{repo}"))
    } else {
        None
    }
}

fn json_object_entries(value: &Value) -> Vec<(&String, &Value)> {
    value
        .as_object()
        .map(|object| object.iter().collect::<Vec<_>>())
        .unwrap_or_default()
}

fn extract_standard_mcp_config(markdown: &str) -> DetailConfig {
    let title = markdown
        .lines()
        .collect::<Vec<_>>()
        .windows(2)
        .find_map(|pair| {
            let title = pair[0].trim();
            let underline = pair[1].trim();
            (!title.is_empty()
                && underline.len() >= 3
                && underline.chars().all(|ch| ch == '-' || ch == '='))
            .then_some(title)
        });
    let description = title
        .and_then(|title| {
            let marker = format!("{title}\n");
            let rest = markdown.split_once(&marker)?.1;
            rest.lines()
                .skip_while(|line| line.trim().chars().all(|ch| ch == '-' || ch == '='))
                .find(|line| !line.trim().is_empty())
                .map(|line| line.trim().to_string())
        })
        .unwrap_or_default();
    let github_url = find_markdown_links(markdown)
        .into_iter()
        .find_map(|(label, url)| {
            (label.eq_ignore_ascii_case("github") && url.starts_with("https://github.com/"))
                .then_some(url)
        });

    let target = markdown
        .to_lowercase()
        .find("standard config")
        .map(|idx| &markdown[idx..])
        .unwrap_or(markdown);
    let mut rest = target;
    let mut name_hint = None;
    let mut config = None;
    while let Some(start) = rest.find("```") {
        let after_start = &rest[start + 3..];
        let Some(newline) = after_start.find('\n') else {
            break;
        };
        let after_fence = &after_start[newline + 1..];
        let Some(end) = after_fence.find("```") else {
            break;
        };
        let body = after_fence[..end].trim();
        rest = &after_fence[end + 3..];
        if !body.contains("mcpServers") && !body.contains("\"mcp\"") {
            continue;
        }
        let Ok(parsed) = serde_json::from_str::<Value>(body) else {
            continue;
        };
        let servers = parsed
            .get("mcpServers")
            .or_else(|| parsed.get("mcp").and_then(|mcp| mcp.get("servers")));
        let Some((name, raw_config)) =
            servers.and_then(|value| json_object_entries(value).into_iter().next())
        else {
            continue;
        };
        name_hint = Some(name.to_string());
        config = normalize_mcp_config(Some(raw_config));
        if config.is_some() {
            break;
        }
    }

    DetailConfig {
        name_hint,
        config,
        github_url,
        description,
    }
}

fn encode_path_segments(value: &str) -> String {
    value
        .split('/')
        .map(|segment| {
            segment
                .bytes()
                .flat_map(|byte| match byte {
                    b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'.' | b'_' | b'-' => {
                        vec![byte as char]
                    }
                    other => format!("%{other:02X}").chars().collect(),
                })
                .collect::<String>()
        })
        .collect::<Vec<_>>()
        .join("/")
}

fn marketplace_url(template_env: &str, fallback: String, values: &[(&str, String)]) -> String {
    let mut url = std::env::var(template_env).unwrap_or(fallback);
    for (key, value) in values {
        url = url.replace(&format!("{{{key}}}"), value);
    }
    url
}

async fn fetch_capped_text(url: String, timeout_ms: u64) -> Result<String, String> {
    let response = tokio::time::timeout(
        Duration::from_millis(timeout_ms),
        reqwest::Client::new()
            .get(url)
            .header("User-Agent", "signet-daemon-marketplace")
            .send(),
    )
    .await
    .map_err(|_| format!("request timed out after {timeout_ms}ms"))?
    .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!("fetch failed: {}", response.status()));
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_README_BYTES as u64)
    {
        return Err("response too large".to_string());
    }
    let text = response.text().await.map_err(|error| error.to_string())?;
    if text.len() > MAX_README_BYTES {
        return Err("response too large".to_string());
    }
    Ok(text)
}

async fn fetch_reference_catalog_entries() -> Result<Vec<CatalogEntry>, String> {
    let url = marketplace_url(
        "SIGNET_MCP_MARKETPLACE_REFERENCE_CATALOG_URL",
        "https://raw.githubusercontent.com/modelcontextprotocol/servers/main/README.md".to_string(),
        &[],
    );
    fetch_capped_text(url, 20_000)
        .await
        .map(|markdown| parse_reference_servers_markdown(&markdown))
}

async fn fetch_catalog_page(page: usize) -> Result<ParsedCatalogPage, String> {
    let url = marketplace_url(
        "SIGNET_MCP_MARKETPLACE_CATALOG_PAGE_URL",
        "https://r.jina.ai/http://mcpservers.org/en/all?page={page}".to_string(),
        &[("page", page.to_string())],
    );
    fetch_capped_text(url, 20_000)
        .await
        .map(|markdown| parse_catalog_markdown(&markdown, page))
}

async fn fetch_mcpservers_org_detail(catalog_id: &str) -> Result<DetailConfig, String> {
    let encoded = encode_path_segments(catalog_id);
    let url = marketplace_url(
        "SIGNET_MCP_MARKETPLACE_MCPSERVERS_DETAIL_URL",
        "https://r.jina.ai/http://mcpservers.org/en/servers/{catalogId}".to_string(),
        &[
            ("catalogId", catalog_id.to_string()),
            ("encodedCatalogId", encoded),
        ],
    );
    fetch_capped_text(url, 25_000)
        .await
        .map(|markdown| extract_standard_mcp_config(&markdown))
}

async fn fetch_reference_server_detail(catalog_id: &str) -> Result<DetailConfig, String> {
    let encoded = encode_path_segments(catalog_id);
    let url = marketplace_url(
        "SIGNET_MCP_MARKETPLACE_REFERENCE_DETAIL_URL",
        "https://raw.githubusercontent.com/modelcontextprotocol/servers/main/src/{encodedCatalogId}/README.md"
            .to_string(),
        &[
            ("catalogId", catalog_id.to_string()),
            ("encodedCatalogId", encoded),
        ],
    );
    fetch_capped_text(url, 25_000)
        .await
        .map(|markdown| extract_standard_mcp_config(&markdown))
}

async fn fetch_github_server_detail(catalog_id: &str) -> Result<DetailConfig, String> {
    if github_slug_from_url(&format!("https://github.com/{catalog_id}")).is_none() {
        return Err("invalid github catalog id: expected org/repo".to_string());
    }
    let encoded = encode_path_segments(catalog_id);
    let url = marketplace_url(
        "SIGNET_MCP_MARKETPLACE_GITHUB_DETAIL_URL",
        "https://raw.githubusercontent.com/{encodedCatalogId}/main/README.md".to_string(),
        &[
            ("catalogId", catalog_id.to_string()),
            ("encodedCatalogId", encoded),
        ],
    );
    fetch_capped_text(url, 25_000)
        .await
        .map(|markdown| extract_standard_mcp_config(&markdown))
}

async fn fetch_detail_by_source(source: &str, catalog_id: &str) -> Result<DetailConfig, String> {
    match source {
        "modelcontextprotocol/servers" => fetch_reference_server_detail(catalog_id).await,
        "github" => fetch_github_server_detail(catalog_id).await,
        _ => fetch_mcpservers_org_detail(catalog_id).await,
    }
}

pub(crate) async fn mcp_request(
    server: &McpServer,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    let config = server
        .config
        .as_object()
        .ok_or_else(|| "invalid MCP server config".to_string())?;
    let timeout_ms = config
        .get("timeoutMs")
        .and_then(Value::as_u64)
        .unwrap_or(DEFAULT_TIMEOUT_MS)
        .clamp(1_000, 120_000);
    let request = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 2,
        "method": method,
        "params": params,
    });

    match config.get("transport").and_then(Value::as_str) {
        Some("stdio") => {
            let fut = mcp_stdio_request(config, request);
            tokio::time::timeout(Duration::from_millis(timeout_ms), fut)
                .await
                .map_err(|_| format!("MCP server {} timed out after {timeout_ms}ms", server.id))?
        }
        Some("http") => {
            let Some(url) = config.get("url").and_then(Value::as_str) else {
                return Err("HTTP MCP config missing url".to_string());
            };
            let mut builder = reqwest::Client::new()
                .post(url)
                .header("User-Agent", "signet-daemon-marketplace")
                .json(&request);
            if let Some(headers) = config.get("headers").and_then(Value::as_object) {
                for (key, value) in headers {
                    if let Some(value) = value.as_str() {
                        builder = builder.header(key, value);
                    }
                }
            }
            let response = tokio::time::timeout(Duration::from_millis(timeout_ms), builder.send())
                .await
                .map_err(|_| format!("MCP server {} timed out after {timeout_ms}ms", server.id))?
                .map_err(|error| error.to_string())?;
            let body = response
                .json::<Value>()
                .await
                .map_err(|error| error.to_string())?;
            parse_mcp_response(body)
        }
        _ => Err("config must include command/url".to_string()),
    }
}

async fn mcp_stdio_request(
    config: &serde_json::Map<String, Value>,
    request: Value,
) -> Result<Value, String> {
    let command = config
        .get("command")
        .and_then(Value::as_str)
        .ok_or_else(|| "stdio MCP config missing command".to_string())?;
    let mut child = tokio::process::Command::new(command);
    if let Some(args) = config.get("args").and_then(Value::as_array) {
        child.args(args.iter().filter_map(Value::as_str));
    }
    if let Some(env) = config.get("env").and_then(Value::as_object) {
        for (key, value) in env {
            if let Some(value) = value.as_str() {
                child.env(key, value);
            }
        }
    }
    if let Some(cwd) = config.get("cwd").and_then(Value::as_str) {
        child.current_dir(cwd);
    }
    let mut child = child
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| error.to_string())?;

    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "failed to open MCP stdin".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "failed to open MCP stdout".to_string())?;
    let mut lines = BufReader::new(stdout).lines();

    let initialize = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": MCP_PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": {
                "name": "signet-marketplace-router",
                "version": "0.1.0"
            }
        }
    });
    write_json_line(&mut stdin, &initialize).await?;
    let _ = read_jsonrpc_id(&mut lines, 1).await?;
    write_json_line(
        &mut stdin,
        &serde_json::json!({"jsonrpc": "2.0", "method": "notifications/initialized"}),
    )
    .await?;
    write_json_line(&mut stdin, &request).await?;
    let result = read_jsonrpc_id(&mut lines, 2).await;
    let _ = child.kill().await;
    result
}

async fn write_json_line<W>(writer: &mut W, value: &Value) -> Result<(), String>
where
    W: AsyncWriteExt + Unpin,
{
    let line = serde_json::to_string(value).map_err(|error| error.to_string())?;
    writer
        .write_all(line.as_bytes())
        .await
        .map_err(|error| error.to_string())?;
    writer
        .write_all(b"\n")
        .await
        .map_err(|error| error.to_string())
}

async fn read_jsonrpc_id<R>(lines: &mut tokio::io::Lines<R>, id: i64) -> Result<Value, String>
where
    R: tokio::io::AsyncBufRead + Unpin,
{
    while let Some(line) = lines.next_line().await.map_err(|error| error.to_string())? {
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if value.get("id").and_then(Value::as_i64) == Some(id) {
            return parse_mcp_response(value);
        }
    }
    Err("MCP server closed stdout before response".to_string())
}

fn parse_mcp_response(value: Value) -> Result<Value, String> {
    if let Some(error) = value.get("error") {
        return Err(error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("MCP request failed")
            .to_string());
    }
    value
        .get("result")
        .cloned()
        .ok_or_else(|| "MCP response missing result".to_string())
}

pub(crate) async fn discover_server_tools(server: &McpServer) -> (Vec<McpTool>, Value) {
    match mcp_request(server, "tools/list", serde_json::json!({})).await {
        Ok(result) => {
            let tools = result
                .get("tools")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(|tool| {
                            let name = tool.get("name").and_then(Value::as_str)?;
                            Some(McpTool {
                                id: format!("{}:{}", server.id, sanitize_tool_name(name)),
                                server_id: server.id.clone(),
                                server_name: server.name.clone(),
                                tool_name: name.to_string(),
                                description: tool
                                    .get("description")
                                    .and_then(Value::as_str)
                                    .unwrap_or("")
                                    .to_string(),
                                read_only: tool
                                    .get("annotations")
                                    .and_then(|annotations| annotations.get("readOnlyHint"))
                                    .and_then(Value::as_bool)
                                    .unwrap_or(false),
                                input_schema: tool
                                    .get("inputSchema")
                                    .cloned()
                                    .unwrap_or_else(|| serde_json::json!({})),
                            })
                        })
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let status = serde_json::json!({
                "serverId": server.id,
                "serverName": server.name,
                "ok": true,
                "toolCount": tools.len(),
            });
            (tools, status)
        }
        Err(error) => (
            Vec::new(),
            serde_json::json!({
                "serverId": server.id,
                "serverName": server.name,
                "ok": false,
                "toolCount": 0,
                "error": error,
            }),
        ),
    }
}

fn sanitize_tool_name(name: &str) -> String {
    name.chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-' | ':' | '.') {
                ch
            } else {
                '_'
            }
        })
        .collect()
}

pub(crate) fn rank_tools(mut tools: Vec<McpTool>, query: &str, limit: usize) -> Vec<McpTool> {
    let tokens = query
        .to_lowercase()
        .split_whitespace()
        .filter(|token| token.len() > 1)
        .map(str::to_string)
        .collect::<Vec<_>>();
    if tokens.is_empty() {
        tools.truncate(limit);
        return tools;
    }
    let mut scored = tools
        .drain(..)
        .filter_map(|tool| {
            let haystack = format!(
                "{} {} {} {}",
                tool.server_id, tool.server_name, tool.tool_name, tool.description
            )
            .to_lowercase();
            let tool_name = tool.tool_name.to_lowercase();
            let server_name = tool.server_name.to_lowercase();
            let description = tool.description.to_lowercase();
            let mut score = 0_i64;
            for token in &tokens {
                if tool_name == *token {
                    score += 6;
                }
                if tool_name.contains(token) {
                    score += 4;
                }
                if server_name.contains(token) {
                    score += 3;
                }
                if description.contains(token) {
                    score += 2;
                }
                if haystack.contains(token) {
                    score += 1;
                }
            }
            (score > 0).then_some((tool, score))
        })
        .collect::<Vec<_>>();
    scored.sort_by(|(left_tool, left_score), (right_tool, right_score)| {
        right_score
            .cmp(left_score)
            .then_with(|| left_tool.id.cmp(&right_tool.id))
    });
    scored
        .into_iter()
        .take(limit)
        .map(|(tool, _score)| tool)
        .collect()
}

pub(crate) fn load_policy(state: &AppState) -> ExposurePolicy {
    let Ok(path) =
        workspace_paths::child_file(&state.config.base_path, &["marketplace", "mcp-policy.json"])
    else {
        return ExposurePolicy::default();
    };
    let mtime = std::fs::metadata(&path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| {
            let secs = t.duration_since(std::time::UNIX_EPOCH).ok()?.as_secs();
            chrono::DateTime::from_timestamp(secs as i64, 0).map(|dt| dt.to_rfc3339())
        });
    match std::fs::read_to_string(&path) {
        Ok(data) => {
            let mut policy: ExposurePolicy = serde_json::from_str(&data).unwrap_or_default();
            // If the stored JSON lacked updated_at, use file mtime rather
            // than the process-start-time sentinel from Default.
            if policy.updated_at == "1970-01-01T00:00:00.000Z" {
                if let Some(mt) = mtime {
                    policy.updated_at = mt;
                }
            }
            policy
        }
        Err(_) => ExposurePolicy::default(),
    }
}

pub(crate) fn save_policy(state: &AppState, policy: &ExposurePolicy) -> Result<(), String> {
    let path =
        workspace_paths::child_file(&state.config.base_path, &["marketplace", "mcp-policy.json"])
            .map_err(|e| format!("path: {e}"))?;
    let json = serde_json::to_string_pretty(policy).map_err(|e| format!("serialize: {e}"))?;
    std::fs::write(path, json).map_err(|e| format!("write: {e}"))
}

// ---------------------------------------------------------------------------
// Context extraction
// ---------------------------------------------------------------------------

#[derive(Debug, Default, Deserialize)]
pub struct ContextQuery {
    pub harness: Option<String>,
    pub workspace: Option<String>,
    pub channel: Option<String>,
}

fn scope_matches(scope: &McpScope, ctx: &ContextQuery) -> bool {
    let harness_ok = scope.harnesses.is_empty()
        || ctx
            .harness
            .as_ref()
            .map(|h| scope.harnesses.iter().any(|s| s.eq_ignore_ascii_case(h)))
            .unwrap_or(true);
    let workspace_ok = scope.workspaces.is_empty()
        || ctx
            .workspace
            .as_ref()
            .map(|w| {
                let wn = w.replace('\\', "/");
                scope.workspaces.iter().any(|s| {
                    let sn = s.replace('\\', "/");
                    if sn.ends_with('*') {
                        wn.starts_with(sn.trim_end_matches('*'))
                    } else {
                        wn.trim_end_matches('/') == sn.trim_end_matches('/')
                    }
                })
            })
            .unwrap_or(true);
    let channel_ok = scope.channels.is_empty()
        || ctx
            .channel
            .as_ref()
            .map(|c| scope.channels.iter().any(|s| s.eq_ignore_ascii_case(c)))
            .unwrap_or(true);
    harness_ok && workspace_ok && channel_ok
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

/// GET /api/marketplace/mcp — list installed servers
pub async fn list_servers(
    State(state): State<Arc<AppState>>,
    Query(ctx): Query<ContextQuery>,
) -> Json<serde_json::Value> {
    let all = load_servers(&state);
    let filtered: Vec<&McpServer> = all
        .iter()
        .filter(|s| scope_matches(&s.scope, &ctx))
        .collect();
    Json(serde_json::json!({
        "servers": filtered,
        "count": filtered.len(),
        "scoped": ctx.harness.is_some() || ctx.workspace.is_some() || ctx.channel.is_some(),
        "context": {
            "harness": ctx.harness,
            "workspace": ctx.workspace,
            "channel": ctx.channel,
        }
    }))
}

/// GET /api/marketplace/mcp/policy — get exposure policy
pub async fn get_policy(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    let policy = load_policy(&state);
    Json(serde_json::json!({ "policy": policy }))
}

/// PATCH /api/marketplace/mcp/policy — update exposure policy
pub async fn set_policy(State(state): State<Arc<AppState>>, bytes: Bytes) -> impl IntoResponse {
    let body = match serde_json::from_slice::<Value>(&bytes) {
        Ok(body) => body,
        Err(_) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"error": "Invalid JSON body"})),
            );
        }
    };
    let mut policy = load_policy(&state);

    let mode = body
        .get("mode")
        .and_then(|value| value.as_str())
        .unwrap_or(&policy.mode);
    match mode {
        "compact" | "hybrid" | "expanded" => policy.mode = mode.into(),
        _ => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"error": "mode must be compact, hybrid, or expanded"})),
            );
        }
    }
    policy.max_expanded_tools = parse_positive_int(
        body.get("maxExpandedTools"),
        policy.max_expanded_tools,
        0,
        100,
    );
    policy.max_search_results = parse_positive_int(
        body.get("maxSearchResults"),
        policy.max_search_results,
        1,
        50,
    );
    policy.updated_at = chrono::Utc::now().to_rfc3339();

    if let Err(e) = save_policy(&state, &policy) {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e})),
        );
    }

    (
        StatusCode::OK,
        Json(serde_json::json!({ "success": true, "policy": policy })),
    )
}

/// GET /api/marketplace/mcp/tools — list tools from enabled servers
pub async fn list_tools(
    State(state): State<Arc<AppState>>,
    Query(ctx): Query<ContextQuery>,
) -> Json<serde_json::Value> {
    let servers = load_servers(&state);
    let enabled: Vec<&McpServer> = servers
        .iter()
        .filter(|s| s.enabled && scope_matches(&s.scope, &ctx))
        .collect();
    let policy = load_policy(&state);

    let mut tools = Vec::new();
    let mut server_status = Vec::new();
    for server in enabled {
        let (server_tools, status) = discover_server_tools(server).await;
        tools.extend(server_tools);
        server_status.push(status);
    }

    Json(serde_json::json!({
        "tools": tools,
        "servers": server_status,
        "count": tools.len(),
        "context": {
            "harness": ctx.harness,
            "workspace": ctx.workspace,
            "channel": ctx.channel,
        },
        "policy": policy
    }))
}

#[derive(Debug, Deserialize)]
pub struct SearchQuery {
    pub q: Option<String>,
    pub limit: Option<usize>,
}

/// GET /api/marketplace/mcp/search — search tools
pub async fn search_tools(
    State(state): State<Arc<AppState>>,
    Query(params): Query<SearchQuery>,
    Query(ctx): Query<ContextQuery>,
) -> impl IntoResponse {
    let query = params.q.unwrap_or_default().trim().to_string();
    let limit = params
        .limit
        .unwrap_or(load_policy(&state).max_search_results as usize)
        .clamp(1, 50);
    if query.len() < 2 {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "query": query,
                "count": 0,
                "results": [],
                "error": "query must be at least 2 characters"
            })),
        );
    }
    let servers = load_servers(&state);
    let enabled = servers
        .iter()
        .filter(|server| server.enabled && scope_matches(&server.scope, &ctx));
    let mut tools = Vec::new();
    for server in enabled {
        let (server_tools, _status) = discover_server_tools(server).await;
        tools.extend(server_tools);
    }
    let results = rank_tools(tools, &query, limit);

    (
        StatusCode::OK,
        Json(serde_json::json!({
        "query": query,
        "count": results.len(),
        "results": results,
        "context": {
            "harness": ctx.harness,
            "workspace": ctx.workspace,
            "channel": ctx.channel,
        }
        })),
    )
}

/// POST /api/marketplace/mcp/call — execute a tool on a server
pub async fn call_tool(
    State(state): State<Arc<AppState>>,
    Query(ctx): Query<ContextQuery>,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    let server_id = body.get("serverId").and_then(|v| v.as_str());
    let tool_name = body.get("toolName").and_then(|v| v.as_str());

    if server_id.is_none() || tool_name.is_none() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "serverId and toolName are required"})),
        );
    }

    let servers = load_servers(&state);
    if !servers.iter().any(|server| {
        server.id == server_id.unwrap_or_default()
            && server.enabled
            && scope_matches(&server.scope, &ctx)
    }) {
        return (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"error": "Server not found, disabled, or out of scope"})),
        );
    }

    let server = servers
        .iter()
        .find(|server| {
            server.id == server_id.unwrap_or_default()
                && server.enabled
                && scope_matches(&server.scope, &ctx)
        })
        .expect("server was checked above");
    let args = body
        .get("args")
        .filter(|value| value.is_object())
        .cloned()
        .unwrap_or_else(|| serde_json::json!({}));
    match mcp_request(
        server,
        "tools/call",
        serde_json::json!({"name": tool_name.unwrap_or_default(), "arguments": args}),
    )
    .await
    {
        Ok(result) => (
            StatusCode::OK,
            Json(serde_json::json!({"success": true, "result": result})),
        ),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"success": false, "error": error})),
        ),
    }
}

/// POST /api/marketplace/mcp/read-resource — read a resource from an enabled server.
pub async fn read_resource(
    State(state): State<Arc<AppState>>,
    Query(ctx): Query<ContextQuery>,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    let Some(server_id) = body.get("serverId").and_then(|v| v.as_str()) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "serverId and uri are required"})),
        )
            .into_response();
    };
    let Some(uri) = body.get("uri").and_then(|v| v.as_str()) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "serverId and uri are required"})),
        )
            .into_response();
    };

    let servers = load_servers(&state);
    let Some(server) = servers.iter().find(|server| {
        server.id == server_id && server.enabled && scope_matches(&server.scope, &ctx)
    }) else {
        return (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"error": "Server not found, disabled, or out of scope"})),
        )
            .into_response();
    };

    match mcp_request(server, "resources/read", serde_json::json!({"uri": uri})).await {
        Ok(result) => (
            StatusCode::OK,
            Json(serde_json::json!({"success": true, "contents": result})),
        )
            .into_response(),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"success": false, "error": error})),
        )
            .into_response(),
    }
}

/// POST /api/marketplace/mcp/register — manual server registration
pub async fn register_server(
    State(state): State<Arc<AppState>>,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    let name = match body.get("name").and_then(|v| v.as_str()) {
        Some(n) => n.to_string(),
        None => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"error": "missing name"})),
            );
        }
    };

    let config = match normalize_mcp_config(body.get("config")) {
        Some(c) => c,
        None => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"error": "config must include command/url"})),
            );
        }
    };

    let id = unique_server_id(&sanitize_server_id(&name), &load_servers(&state));
    let now = chrono::Utc::now().to_rfc3339();

    let scope = normalize_scope(body.get("scope"));

    let server = McpServer {
        id: id.clone(),
        source: "manual".into(),
        catalog_id: None,
        name,
        description: body
            .get("description")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .into(),
        category: body
            .get("category")
            .and_then(|v| v.as_str())
            .unwrap_or("Other")
            .into(),
        homepage: None,
        official: false,
        enabled: true,
        scope,
        config,
        installed_at: now.clone(),
        updated_at: now,
    };

    let mut servers = load_servers(&state);
    servers.push(server.clone());

    if let Err(e) = save_servers(&state, &servers) {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e})),
        );
    }

    (
        StatusCode::CREATED,
        Json(serde_json::json!({
            "success": true,
            "server": server
        })),
    )
}

/// GET /api/marketplace/mcp/:id — get single server
pub async fn get_server(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let servers = load_servers(&state);
    match servers.iter().find(|s| s.id == id) {
        Some(server) => (
            StatusCode::OK,
            Json(serde_json::json!({ "server": server })),
        ),
        None => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"error": format!("server not found: {id}")})),
        ),
    }
}

/// PATCH /api/marketplace/mcp/:id — update server
pub async fn update_server(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    let mut servers = load_servers(&state);
    let pos = match servers.iter().position(|s| s.id == id) {
        Some(p) => p,
        None => {
            return (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({"error": format!("server not found: {id}")})),
            );
        }
    };

    if let Some(enabled) = body.get("enabled").and_then(|v| v.as_bool()) {
        servers[pos].enabled = enabled;
    }
    if let Some(name) = body.get("name").and_then(|v| v.as_str()) {
        servers[pos].name = name.into();
    }
    if let Some(desc) = body.get("description").and_then(|v| v.as_str()) {
        servers[pos].description = desc.into();
    }
    if let Some(config) = body.get("config") {
        servers[pos].config = config.clone();
    }
    if let Some(scope) = body.get("scope")
        && let Ok(s) = serde_json::from_value::<McpScope>(scope.clone())
    {
        servers[pos].scope = s;
    }
    servers[pos].updated_at = chrono::Utc::now().to_rfc3339();

    let updated = servers[pos].clone();
    if let Err(e) = save_servers(&state, &servers) {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e})),
        );
    }

    (
        StatusCode::OK,
        Json(serde_json::json!({ "server": updated })),
    )
}

/// DELETE /api/marketplace/mcp/:id — remove server
pub async fn delete_server(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let mut servers = load_servers(&state);
    let before = servers.len();
    servers.retain(|s| s.id != id);

    if servers.len() == before {
        return (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"error": format!("server not found: {id}")})),
        );
    }

    if let Err(e) = save_servers(&state, &servers) {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e})),
        );
    }

    (
        StatusCode::OK,
        Json(serde_json::json!({"success": true, "id": id})),
    )
}

#[derive(Debug, Default, Deserialize)]
pub struct BrowseQuery {
    pub pages: Option<usize>,
}

/// GET /api/marketplace/mcp/browse — browse catalog
pub async fn browse_catalog(
    State(state): State<Arc<AppState>>,
    Query(query): Query<BrowseQuery>,
) -> impl IntoResponse {
    let pages = query.pages.unwrap_or(5).clamp(1, CATALOG_MAX_PAGES);
    let installed_keys = load_servers(&state)
        .into_iter()
        .filter_map(|server| {
            let catalog_id = server.catalog_id?;
            (server.source != "manual")
                .then_some(catalog_selection_key(&server.source, &catalog_id))
        })
        .collect::<std::collections::HashSet<_>>();

    let mut reference_entries = match fetch_reference_catalog_entries().await {
        Ok(entries) => entries,
        Err(_) => {
            return (
                StatusCode::OK,
                Json(serde_json::json!({
                    "total": 0,
                    "shown": 0,
                    "pageSize": CATALOG_PAGE_SIZE,
                    "pages": 0,
                    "results": [],
                    "error": "Failed to load catalog",
                })),
            );
        }
    };
    let mut mcp_total = 0_usize;
    let mut mcp_entries = Vec::new();
    for page in 1..=pages {
        let parsed = match fetch_catalog_page(page).await {
            Ok(parsed) => parsed,
            Err(_) => {
                return (
                    StatusCode::OK,
                    Json(serde_json::json!({
                        "total": 0,
                        "shown": 0,
                        "pageSize": CATALOG_PAGE_SIZE,
                        "pages": 0,
                        "results": [],
                        "error": "Failed to load catalog",
                    })),
                );
            }
        };
        if page == 1 {
            mcp_total = parsed.total;
        }
        mcp_entries.extend(parsed.entries);
    }

    let mut seen = std::collections::HashSet::new();
    let mut combined = Vec::new();
    let reference_count = reference_entries.len();
    reference_entries.append(&mut mcp_entries);
    for (index, entry) in reference_entries.into_iter().enumerate() {
        if !seen.insert(entry.id.clone()) {
            continue;
        }
        combined.push(serde_json::json!({
            "id": entry.id,
            "source": entry.source,
            "catalogId": entry.catalog_id,
            "name": entry.name,
            "description": entry.description,
            "category": entry.category,
            "official": entry.official,
            "sponsor": entry.sponsor,
            "popularityRank": index + 1,
            "sourceUrl": entry.source_url,
            "installed": installed_keys.contains(&catalog_selection_key(&entry.source, &entry.catalog_id)),
        }));
    }
    (
        StatusCode::OK,
        Json(serde_json::json!({
            "total": mcp_total + reference_count,
            "shown": combined.len(),
            "pageSize": CATALOG_PAGE_SIZE,
            "pages": pages,
            "results": combined,
        })),
    )
}

/// POST /api/marketplace/mcp/install — install from catalog
pub async fn install_from_catalog(
    State(state): State<Arc<AppState>>,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    let Some(raw_id) = body
        .get("id")
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.trim().is_empty())
    else {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "id is required"})),
        );
    };
    let Some((source, catalog_id)) =
        parse_catalog_selection(raw_id, body.get("source").and_then(Value::as_str))
    else {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "Invalid catalog id"})),
        );
    };
    if catalog_id.contains("..") || catalog_id.starts_with('/') || catalog_id.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "Invalid catalog id"})),
        );
    }
    let mut detail = None;
    let config = if let Some(config) = normalize_mcp_config(body.get("config")) {
        config
    } else {
        match fetch_detail_by_source(&source, &catalog_id).await {
            Ok(fetched) => {
                let fetched_config = fetched.config.clone();
                detail = Some(fetched);
                let Some(config) = fetched_config else {
                    return (
                        StatusCode::UNPROCESSABLE_ENTITY,
                        Json(serde_json::json!({
                            "error": "No standard MCP config found for this server. Use manual registration instead."
                        })),
                    );
                };
                config
            }
            Err(error) => {
                return (
                    StatusCode::BAD_GATEWAY,
                    Json(serde_json::json!({
                        "error": format!("Failed to fetch server detail: {error}")
                    })),
                );
            }
        }
    };
    if config.is_null() {
        return (
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(serde_json::json!({
                "error": "No standard MCP config found for this server. Use manual registration instead."
            })),
        );
    }

    let mut servers = load_servers(&state);
    let now = chrono::Utc::now().to_rfc3339();
    if let Some(pos) = servers.iter().position(|server| {
        server.catalog_id.as_deref() == Some(&catalog_id) && server.source == source
    }) {
        servers[pos].enabled = true;
        servers[pos].scope = body
            .get("scope")
            .map(|scope| normalize_scope(Some(scope)))
            .unwrap_or_else(|| servers[pos].scope.clone());
        servers[pos].config = config;
        servers[pos].updated_at = now;
        let server = servers[pos].clone();
        if let Err(error) = save_servers(&state, &servers) {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": error})),
            );
        }
        return (
            StatusCode::OK,
            Json(serde_json::json!({"success": true, "server": server, "updated": true})),
        );
    }

    let source_name = body
        .get("alias")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| detail.as_ref().and_then(|detail| detail.name_hint.clone()))
        .unwrap_or_else(|| infer_name_from_catalog_id(&catalog_id));
    let id = unique_server_id(&sanitize_server_id(&source_name), &servers);
    let homepage = match source.as_str() {
        "modelcontextprotocol/servers" => {
            format!("https://github.com/modelcontextprotocol/servers/tree/main/src/{catalog_id}")
        }
        "github" => format!("https://github.com/{catalog_id}"),
        _ => format!("https://mcpservers.org/en/servers/{catalog_id}"),
    };
    let server = McpServer {
        id,
        source: source.clone(),
        catalog_id: Some(catalog_id.clone()),
        name: source_name.clone(),
        description: detail
            .as_ref()
            .map(|detail| detail.description.clone())
            .filter(|description| !description.is_empty())
            .unwrap_or_else(|| format!("{source_name} MCP server")),
        category: infer_category(&format!(
            "{} {}",
            source_name,
            detail
                .as_ref()
                .map(|detail| detail.description.as_str())
                .unwrap_or("")
        ))
        .to_string(),
        homepage: Some(homepage),
        official: source == "modelcontextprotocol/servers",
        enabled: true,
        scope: normalize_scope(body.get("scope")),
        config,
        installed_at: now.clone(),
        updated_at: now,
    };
    servers.push(server.clone());
    if let Err(error) = save_servers(&state, &servers) {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": error})),
        );
    }
    (
        StatusCode::OK,
        Json(serde_json::json!({"success": true, "server": server, "updated": false})),
    )
}

/// POST /api/marketplace/mcp/test — test MCP config
pub async fn test_config(
    State(_state): State<Arc<AppState>>,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    let Some(config) = normalize_mcp_config(body.get("config")) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"success": false, "error": "config must include command/url"})),
        );
    };
    let started = std::time::Instant::now();
    let server = McpServer {
        id: "test-server".into(),
        source: "manual".into(),
        catalog_id: None,
        name: "Test Server".into(),
        description: "Temporary config test".into(),
        category: "Other".into(),
        homepage: None,
        official: false,
        enabled: true,
        scope: McpScope::default(),
        config,
        installed_at: chrono::Utc::now().to_rfc3339(),
        updated_at: chrono::Utc::now().to_rfc3339(),
    };
    match mcp_request(&server, "tools/list", serde_json::json!({})).await {
        Ok(result) => {
            let tools = result
                .get("tools")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(|tool| tool.get("name").and_then(Value::as_str))
                        .take(30)
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            (
                StatusCode::OK,
                Json(serde_json::json!({
                    "success": true,
                    "toolCount": tools.len(),
                    "tools": tools,
                    "latencyMs": started.elapsed().as_millis() as u64,
                })),
            )
        }
        Err(error) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "success": false,
                "error": error,
                "latencyMs": started.elapsed().as_millis() as u64,
            })),
        ),
    }
}

/// GET /api/marketplace/mcp/detail — get server installation details
pub async fn catalog_detail(Query(query): Query<HashMap<String, String>>) -> impl IntoResponse {
    let Some(id) = query
        .get("id")
        .map(|value| value.trim())
        .filter(|value| !value.is_empty() && !value.contains("..") && !value.starts_with('/'))
    else {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "Invalid catalog id"})),
        );
    };

    let Some((source, catalog_id)) =
        parse_catalog_selection(id, query.get("source").map(String::as_str))
    else {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "Invalid catalog id"})),
        );
    };

    match fetch_detail_by_source(&source, &catalog_id).await {
        Ok(detail) => (
            StatusCode::OK,
            Json(serde_json::json!({
                "id": catalog_id,
                "source": source,
                "name": detail.name_hint.unwrap_or_else(|| infer_name_from_catalog_id(&catalog_id)),
                "description": detail.description,
                "githubUrl": detail.github_url,
                "defaultConfig": detail.config,
            })),
        ),
        Err(_) => (
            StatusCode::BAD_GATEWAY,
            Json(serde_json::json!({
                "error": "Failed to load MCP detail",
            })),
        ),
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scope_empty_matches_all() {
        let scope = McpScope::default();
        let ctx = ContextQuery {
            harness: Some("claude-code".into()),
            workspace: Some("/home/user/project".into()),
            channel: None,
        };
        assert!(scope_matches(&scope, &ctx));
    }

    #[test]
    fn scope_harness_filter() {
        let scope = McpScope {
            harnesses: vec!["claude-code".into()],
            ..Default::default()
        };
        let matching = ContextQuery {
            harness: Some("claude-code".into()),
            ..Default::default()
        };
        let non_matching = ContextQuery {
            harness: Some("opencode".into()),
            ..Default::default()
        };
        assert!(scope_matches(&scope, &matching));
        assert!(!scope_matches(&scope, &non_matching));
    }

    #[test]
    fn scope_workspace_wildcard() {
        let scope = McpScope {
            workspaces: vec!["src/*".into()],
            ..Default::default()
        };
        let matching = ContextQuery {
            workspace: Some("src/foo/bar".into()),
            ..Default::default()
        };
        let non_matching = ContextQuery {
            workspace: Some("lib/foo".into()),
            ..Default::default()
        };
        assert!(scope_matches(&scope, &matching));
        assert!(!scope_matches(&scope, &non_matching));
    }

    #[test]
    fn default_policy() {
        let policy = ExposurePolicy::default();
        assert_eq!(policy.mode, "hybrid");
        assert_eq!(policy.max_expanded_tools, 12);
        assert_eq!(policy.max_search_results, 8);
    }

    #[test]
    fn scope_case_insensitive_harness() {
        let scope = McpScope {
            harnesses: vec!["Claude-Code".into()],
            ..Default::default()
        };
        let ctx = ContextQuery {
            harness: Some("claude-code".into()),
            ..Default::default()
        };
        assert!(scope_matches(&scope, &ctx));
    }
}
