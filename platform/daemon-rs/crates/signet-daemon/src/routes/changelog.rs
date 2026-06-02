//! Changelog, roadmap, and README overview routes.

use std::path::{Path, PathBuf};

use axum::{Json, http::StatusCode};
use serde_json::json;

const CHANGELOG_MAX_RELEASES: usize = 30;

type DocResult = Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)>;

#[derive(Debug, Clone, Copy)]
enum DocFile {
    Changelog,
    Roadmap,
    Readme,
}

impl DocFile {
    fn filename(self) -> &'static str {
        match self {
            Self::Changelog => "CHANGELOG.md",
            Self::Roadmap => "ROADMAP.md",
            Self::Readme => "README.md",
        }
    }

    fn unavailable_message(self) -> &'static str {
        match self {
            Self::Changelog => "Changelog unavailable",
            Self::Roadmap => "Roadmap unavailable",
            Self::Readme => "README unavailable",
        }
    }
}

fn repo_root_candidates() -> Vec<PathBuf> {
    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let mut candidates = vec![
        manifest_dir.join("../../../.."),
        manifest_dir.join("../../.."),
    ];
    if let Ok(current_dir) = std::env::current_dir() {
        candidates.push(current_dir.clone());
        candidates.push(current_dir.join("../.."));
    }
    if let Ok(exe) = std::env::current_exe()
        && let Some(dir) = exe.parent()
    {
        candidates.push(dir.join("../.."));
        candidates.push(dir.join("../../.."));
    }
    candidates
}

fn read_local_doc(filename: &str) -> Option<String> {
    repo_root_candidates()
        .into_iter()
        .map(|root| root.join(filename))
        .find(|path| path.is_file())
        .and_then(|path| std::fs::read_to_string(path).ok())
}

fn escape_html(raw: &str) -> String {
    raw.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn inline_format(raw: &str) -> String {
    let mut out = String::new();
    let bytes = raw.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i..].starts_with(b"**")
            && let Some(end) = raw[i + 2..].find("**")
        {
            out.push_str("<strong>");
            out.push_str(&raw[i + 2..i + 2 + end]);
            out.push_str("</strong>");
            i += end + 4;
            continue;
        }
        if bytes[i] == b'`'
            && let Some(end) = raw[i + 1..].find('`')
        {
            out.push_str("<code>");
            out.push_str(&raw[i + 1..i + 1 + end]);
            out.push_str("</code>");
            i += end + 2;
            continue;
        }
        out.push(bytes[i] as char);
        i += 1;
    }
    out
}

fn render_markdown(md: &str) -> String {
    let lines: Vec<&str> = md.lines().collect();
    let mut out = Vec::new();
    let mut in_ul = false;
    let flush_list = |out: &mut Vec<String>, in_ul: &mut bool| {
        if *in_ul {
            out.push("</ul>".to_string());
            *in_ul = false;
        }
    };

    let mut i = 0;
    while i < lines.len() {
        let raw = lines[i];
        let trimmed = raw.trim();
        let next = lines.get(i + 1).map(|line| line.trim()).unwrap_or("");
        if !trimmed.is_empty() && next.chars().all(|ch| ch == '=') && !next.is_empty() {
            flush_list(&mut out, &mut in_ul);
            out.push(format!("<h1>{}</h1>", escape_html(trimmed)));
            i += 2;
            continue;
        }
        if !trimmed.is_empty()
            && !raw.starts_with('-')
            && next.len() >= 2
            && next.chars().all(|ch| ch == '-')
        {
            flush_list(&mut out, &mut in_ul);
            out.push(format!("<h2>{}</h2>", escape_html(trimmed)));
            i += 2;
            continue;
        }
        if let Some(text) = raw.strip_prefix("### ") {
            flush_list(&mut out, &mut in_ul);
            out.push(format!("<h3>{}</h3>", escape_html(text.trim())));
        } else if let Some(text) = raw.strip_prefix("## ") {
            flush_list(&mut out, &mut in_ul);
            out.push(format!("<h2>{}</h2>", escape_html(text.trim())));
        } else if let Some(text) = raw.strip_prefix("# ") {
            flush_list(&mut out, &mut in_ul);
            out.push(format!("<h1>{}</h1>", escape_html(text.trim())));
        } else if trimmed.len() >= 3 && trimmed.chars().all(|ch| ch == '-') {
            flush_list(&mut out, &mut in_ul);
            out.push("<hr>".to_string());
        } else if let Some(text) = raw.strip_prefix("- ") {
            if !in_ul {
                out.push("<ul>".to_string());
                in_ul = true;
            }
            out.push(format!("<li>{}</li>", inline_format(&escape_html(text))));
        } else if trimmed.is_empty() {
            flush_list(&mut out, &mut in_ul);
        } else {
            flush_list(&mut out, &mut in_ul);
            out.push(format!("<p>{}</p>", inline_format(&escape_html(raw))));
        }
        i += 1;
    }
    flush_list(&mut out, &mut in_ul);
    out.join("\n")
}

fn truncate_changelog(content: &str) -> String {
    let mut out = String::new();
    let mut releases = 0;
    for segment in content.split_inclusive('\n') {
        if segment.starts_with("## [") {
            releases += 1;
            if releases > CHANGELOG_MAX_RELEASES {
                break;
            }
        }
        out.push_str(segment);
    }
    out
}

fn normalize_paragraph(text: &str) -> String {
    text.replace(['<', '>'], " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn extract_between<'a>(content: &'a str, start: &str, end: &str) -> Option<&'a str> {
    let start_index = content.find(start)?;
    let tail = &content[start_index..];
    let end_index = tail.find(end)?;
    Some(&tail[..end_index + end.len()])
}

fn is_shield_badge(line: &str) -> bool {
    line.contains("https://img.shields.io/")
}

fn extract_readme_overview(content: &str) -> String {
    let local_first = extract_between(
        content,
        "Signet is a local-first",
        "without ever reading their values.",
    );
    let why = extract_between(
        content,
        "Most AI tools build memory silos.",
        "unless you configure it to.",
    );

    if let (Some(local_first), Some(why)) = (local_first, why) {
        return [
            "# Signet".to_string(),
            "## Own your agent. Bring it anywhere.".to_string(),
            normalize_paragraph(local_first),
            "## Why Signet".to_string(),
            normalize_paragraph(why),
        ]
        .join("\n\n");
    }

    let fallback = content
        .lines()
        .map(str::trim)
        .filter(|line| {
            !line.is_empty() && !line.starts_with("![") && !is_shield_badge(line) && *line != "---"
        })
        .take(18)
        .collect::<Vec<_>>()
        .join("\n");
    if fallback.is_empty() {
        "# Signet\n\nSignet overview unavailable.".to_string()
    } else {
        fallback
    }
}

fn render_doc(file: DocFile) -> Option<serde_json::Value> {
    let raw = read_local_doc(file.filename())?;
    let content = match file {
        DocFile::Changelog => truncate_changelog(&raw),
        DocFile::Readme => extract_readme_overview(&raw),
        DocFile::Roadmap => raw,
    };
    Some(json!({
        "html": render_markdown(&content),
        "source": "local",
        "cachedAt": chrono::Utc::now().timestamp_millis(),
    }))
}

fn serve_doc(file: DocFile) -> DocResult {
    render_doc(file).map(Json).ok_or_else(|| {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"error": file.unavailable_message()})),
        )
    })
}

/// GET /api/changelog
pub async fn changelog() -> DocResult {
    serve_doc(DocFile::Changelog)
}

/// GET /api/roadmap
pub async fn roadmap() -> DocResult {
    serve_doc(DocFile::Roadmap)
}

/// GET /api/readme
pub async fn readme() -> DocResult {
    serve_doc(DocFile::Readme)
}
