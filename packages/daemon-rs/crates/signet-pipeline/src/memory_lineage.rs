use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use chrono::Utc;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use serde_yml::Value as YamlValue;
use sha2::{Digest, Sha256};

use crate::provider::{GenerateOpts, LlmProvider, LlmSemaphore};

const HASH_SCOPE: &str = "body-normalized-v1";
const SANITIZER_VERSION: &str = "sanitize_transcript_v1";
const SENTENCE_VERSION: &str = "memory_sentence_v1";
const LEDGER_HEADING: &str = "Session Ledger (Last 30 Days)";
const LOW_SIGNAL_SENTENCES: &[&str] = &["Investigated issue.", "Worked on task.", "Reviewed code."];
const BASE32: &[u8; 32] = b"abcdefghijklmnopqrstuvwxyz234567";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArtifactKind {
    Summary,
    Transcript,
    Compaction,
    Manifest,
}

impl ArtifactKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Summary => "summary",
            Self::Transcript => "transcript",
            Self::Compaction => "compaction",
            Self::Manifest => "manifest",
        }
    }

    fn from_str(value: &str) -> Option<Self> {
        match value {
            "summary" => Some(Self::Summary),
            "transcript" => Some(Self::Transcript),
            "compaction" => Some(Self::Compaction),
            "manifest" => Some(Self::Manifest),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemorySentence {
    pub text: String,
    pub quality: String,
    pub generated_at: String,
}

#[derive(Debug, Clone)]
pub struct ArtifactWrite {
    pub manifest_path: String,
    pub artifact_path: String,
}

#[derive(Debug, Clone)]
pub struct RenderResult {
    pub content: String,
    pub file_count: usize,
    pub index_block: String,
}

#[derive(Debug, Clone)]
pub struct TranscriptArtifactInput {
    pub agent_id: String,
    pub session_id: String,
    pub session_key: Option<String>,
    pub project: Option<String>,
    pub harness: Option<String>,
    pub captured_at: String,
    pub started_at: Option<String>,
    pub ended_at: Option<String>,
    pub transcript: String,
}

#[derive(Debug, Clone)]
pub struct SummaryArtifactInput {
    pub agent_id: String,
    pub session_id: String,
    pub session_key: Option<String>,
    pub project: Option<String>,
    pub harness: Option<String>,
    pub captured_at: String,
    pub started_at: Option<String>,
    pub ended_at: Option<String>,
    pub summary: String,
}

#[derive(Debug, Clone)]
struct ArtifactSeed {
    kind: ArtifactKind,
    agent_id: String,
    session_id: String,
    session_key: Option<String>,
    project: Option<String>,
    harness: Option<String>,
    captured_at: String,
    started_at: Option<String>,
    ended_at: Option<String>,
    session_token: String,
    manifest_path: String,
    source_node_id: Option<String>,
    memory_sentence: MemorySentence,
    body: String,
}

#[derive(Debug, Clone)]
struct ManifestState {
    path: PathBuf,
    revision: i64,
    frontmatter: BTreeMap<String, YamlValue>,
    body: String,
}

#[derive(Debug, Clone)]
struct ArtifactRow {
    source_path: String,
    source_kind: String,
    session_id: String,
    session_key: Option<String>,
    session_token: String,
    project: Option<String>,
    harness: Option<String>,
    captured_at: String,
    ended_at: Option<String>,
    manifest_path: Option<String>,
    memory_sentence: Option<String>,
    content: String,
}

#[derive(Debug, Clone)]
struct LedgerSession {
    session_id: String,
    session_key: Option<String>,
    project: Option<String>,
    membership_ts: String,
    sentence: String,
    summary_path: Option<String>,
    transcript_path: Option<String>,
    compaction_path: Option<String>,
    manifest_path: Option<String>,
}

pub fn normalize_markdown_body(body: &str) -> String {
    let mut lines = body
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .lines()
        .map(|line| line.trim_end_matches([' ', '\t']).to_string())
        .collect::<Vec<_>>();
    while lines.last().is_some_and(|line| line.is_empty()) {
        lines.pop();
    }
    lines.join("\n")
}

pub fn hash_normalized_body(body: &str) -> String {
    let normalized = normalize_markdown_body(body);
    let mut hasher = Sha256::new();
    hasher.update(normalized.as_bytes());
    hex_lower(&hasher.finalize())
}

pub fn sanitize_transcript_v1(raw: &str) -> String {
    normalize_markdown_body(raw)
}

fn hex_lower(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

fn base32_sha256(input: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    let bytes = hasher.finalize();
    let mut bits = 0u32;
    let mut value = 0u32;
    let mut out = String::new();
    for byte in bytes {
        value = (value << 8) | u32::from(byte);
        bits += 8;
        while bits >= 5 {
            let idx = ((value >> (bits - 5)) & 31) as usize;
            out.push(BASE32[idx] as char);
            bits -= 5;
        }
    }
    if bits > 0 {
        let idx = ((value << (5 - bits)) & 31) as usize;
        out.push(BASE32[idx] as char);
    }
    out
}

pub fn derive_session_token(agent_id: &str, session_key: Option<&str>, session_id: &str) -> String {
    let identity = session_key
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| session_id.trim());
    base32_sha256(&format!("{agent_id}:{identity}"))
        .chars()
        .take(16)
        .collect()
}

fn fs_timestamp(iso: &str) -> String {
    iso.replace(':', "-")
}

fn file_name(captured_at: &str, token: &str, kind: ArtifactKind) -> String {
    format!(
        "{}--{}--{}.md",
        fs_timestamp(captured_at),
        token,
        kind.as_str()
    )
}

fn memory_dir(root: &Path) -> PathBuf {
    root.join("memory")
}

fn artifact_path(root: &Path, captured_at: &str, token: &str, kind: ArtifactKind) -> PathBuf {
    memory_dir(root).join(file_name(captured_at, token, kind))
}

fn relative_artifact_path(captured_at: &str, token: &str, kind: ArtifactKind) -> String {
    format!("memory/{}", file_name(captured_at, token, kind))
}

fn wikilink(path: &str, label: Option<&str>) -> String {
    match label {
        Some(label) => format!("[[{path}|{label}]]"),
        None => format!("[[{path}]]"),
    }
}

fn yaml_string(value: &str) -> YamlValue {
    YamlValue::String(value.to_string())
}

fn yaml_opt_string(value: Option<&str>) -> YamlValue {
    value.map_or(YamlValue::Null, yaml_string)
}

fn yaml_i64(value: i64) -> YamlValue {
    YamlValue::Number(value.into())
}

fn yaml_list(items: &[String]) -> YamlValue {
    YamlValue::Sequence(items.iter().map(|item| yaml_string(item)).collect())
}

fn frontmatter_string(map: &BTreeMap<String, YamlValue>) -> Result<String, String> {
    let raw = serde_yml::to_string(map).map_err(|err| err.to_string())?;
    let body = raw.strip_prefix("---\n").unwrap_or(&raw).trim_end();
    Ok(format!("---\n{body}\n---"))
}

fn parse_document(content: &str) -> Result<(BTreeMap<String, YamlValue>, String), String> {
    let text = content.replace("\r\n", "\n").replace('\r', "\n");
    if !text.starts_with("---\n") {
        return Ok((BTreeMap::new(), text));
    }
    let Some(end) = text[4..].find("\n---\n") else {
        return Ok((BTreeMap::new(), text));
    };
    let split = 4 + end;
    let front = &text[4..split];
    let body = text[(split + 5)..].to_string();
    let map = serde_yml::from_str(front).map_err(|err| err.to_string())?;
    Ok((map, body))
}

fn read_string(map: &BTreeMap<String, YamlValue>, key: &str) -> Option<String> {
    map.get(key)
        .and_then(YamlValue::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn read_i64(map: &BTreeMap<String, YamlValue>, key: &str) -> Option<i64> {
    map.get(key).and_then(YamlValue::as_i64)
}

fn read_string_list(map: &BTreeMap<String, YamlValue>, key: &str) -> Vec<String> {
    map.get(key)
        .and_then(YamlValue::as_sequence)
        .map(|items| {
            items
                .iter()
                .filter_map(YamlValue::as_str)
                .map(ToOwned::to_owned)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn relative_path(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn write_atomic(path: &Path, content: &str) -> Result<(), String> {
    let Some(dir) = path.parent() else {
        return Err("artifact path missing parent".to_string());
    };
    fs::create_dir_all(dir).map_err(|err| err.to_string())?;
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_nanos())
        .unwrap_or(0);
    let tmp = path.with_extension(format!("tmp-{}-{nonce}", std::process::id()));
    fs::write(&tmp, content).map_err(|err| err.to_string())?;
    fs::rename(&tmp, path).map_err(|err| err.to_string())?;
    Ok(())
}

fn load_manifest(path: &Path) -> Result<Option<ManifestState>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let content = fs::read_to_string(path).map_err(|err| err.to_string())?;
    let (frontmatter, body) = parse_document(&content)?;
    Ok(Some(ManifestState {
        path: path.to_path_buf(),
        revision: read_i64(&frontmatter, "revision").unwrap_or(0),
        frontmatter,
        body,
    }))
}

fn manifest_value(frontmatter: &BTreeMap<String, YamlValue>, key: &str) -> Option<String> {
    read_string(frontmatter, key)
}

fn ensure_manifest_record(
    conn: &Connection,
    root: &Path,
    agent_id: &str,
    session_id: &str,
    session_key: Option<&str>,
    project: Option<&str>,
    harness: Option<&str>,
    captured_at: &str,
    started_at: Option<&str>,
    ended_at: Option<&str>,
    session_token: &str,
) -> Result<ManifestState, String> {
    let path = artifact_path(root, captured_at, session_token, ArtifactKind::Manifest);
    if let Some(state) = load_manifest(&path)? {
        return Ok(state);
    }
    let mut frontmatter = BTreeMap::new();
    frontmatter.insert("kind".into(), yaml_string("manifest"));
    frontmatter.insert("agent_id".into(), yaml_string(agent_id));
    frontmatter.insert("session_id".into(), yaml_string(session_id));
    frontmatter.insert("session_key".into(), yaml_opt_string(session_key));
    frontmatter.insert("project".into(), yaml_opt_string(project));
    frontmatter.insert("harness".into(), yaml_opt_string(harness));
    frontmatter.insert("captured_at".into(), yaml_string(captured_at));
    frontmatter.insert("started_at".into(), yaml_opt_string(started_at));
    frontmatter.insert("ended_at".into(), yaml_opt_string(ended_at));
    frontmatter.insert(
        "summary_path".into(),
        yaml_string(&relative_artifact_path(
            captured_at,
            session_token,
            ArtifactKind::Summary,
        )),
    );
    frontmatter.insert(
        "transcript_path".into(),
        yaml_string(&relative_artifact_path(
            captured_at,
            session_token,
            ArtifactKind::Transcript,
        )),
    );
    frontmatter.insert("compaction_path".into(), YamlValue::Null);
    frontmatter.insert("memory_md_refs".into(), YamlValue::Sequence(Vec::new()));
    frontmatter.insert("updated_at".into(), yaml_string(captured_at));
    frontmatter.insert("revision".into(), yaml_i64(1));
    frontmatter.insert(
        "content_sha256".into(),
        yaml_string(&hash_normalized_body("")),
    );
    frontmatter.insert("hash_scope".into(), yaml_string(HASH_SCOPE));
    let content = format!("{}\n", frontmatter_string(&frontmatter)?);
    write_atomic(&path, &content)?;
    let state = load_manifest(&path)?.ok_or_else(|| "failed to reload manifest".to_string())?;
    upsert_artifact_row(conn, root, &path, &state.frontmatter, &state.body)?;
    Ok(state)
}

fn find_manifest(
    conn: &Connection,
    root: &Path,
    agent_id: &str,
    session_id: &str,
    session_key: Option<&str>,
) -> Result<Option<ManifestState>, String> {
    let sql = if session_key.is_some() {
        "SELECT source_path FROM memory_artifacts
         WHERE agent_id = ?1 AND source_kind = 'manifest' AND session_key = ?2
         ORDER BY captured_at ASC LIMIT 1"
    } else {
        "SELECT source_path FROM memory_artifacts
         WHERE agent_id = ?1 AND source_kind = 'manifest' AND session_id = ?2
         ORDER BY captured_at ASC LIMIT 1"
    };
    let rel = if let Some(key) = session_key {
        conn.query_row(sql, params![agent_id, key], |row| row.get::<_, String>(0))
            .optional()
            .map_err(|err| err.to_string())?
    } else {
        conn.query_row(sql, params![agent_id, session_id], |row| {
            row.get::<_, String>(0)
        })
        .optional()
        .map_err(|err| err.to_string())?
    };
    match rel {
        Some(rel) => load_manifest(&root.join(rel)),
        None => Ok(None),
    }
}

fn ensure_canonical_manifest(
    conn: &Connection,
    root: &Path,
    agent_id: &str,
    session_id: &str,
    session_key: Option<&str>,
    project: Option<&str>,
    harness: Option<&str>,
    captured_at: &str,
    started_at: Option<&str>,
    ended_at: Option<&str>,
) -> Result<ManifestState, String> {
    if let Some(state) = find_manifest(conn, root, agent_id, session_id, session_key)? {
        return Ok(state);
    }
    let token = derive_session_token(agent_id, session_key, session_id);
    ensure_manifest_record(
        conn,
        root,
        agent_id,
        session_id,
        session_key,
        project,
        harness,
        captured_at,
        started_at,
        ended_at,
        &token,
    )
}

fn save_manifest(
    conn: &Connection,
    root: &Path,
    path: &Path,
    frontmatter: &BTreeMap<String, YamlValue>,
    body: &str,
) -> Result<ManifestState, String> {
    let normalized = normalize_markdown_body(body);
    let content = format!("{}\n{}\n", frontmatter_string(frontmatter)?, normalized);
    write_atomic(path, &content)?;
    let state = load_manifest(path)?.ok_or_else(|| "failed to reload manifest".to_string())?;
    upsert_artifact_row(conn, root, path, &state.frontmatter, &state.body)?;
    Ok(state)
}

fn update_manifest<F>(
    conn: &Connection,
    root: &Path,
    path: &Path,
    mutate: F,
) -> Result<ManifestState, String>
where
    F: FnOnce(&mut BTreeMap<String, YamlValue>, &str),
{
    let current = load_manifest(path)?.ok_or_else(|| "manifest not found".to_string())?;
    let mut next = current.frontmatter.clone();
    mutate(&mut next, &current.body);
    let revision = read_i64(&next, "revision").unwrap_or(current.revision);
    next.insert("revision".into(), yaml_i64(revision + 1));
    next.insert("updated_at".into(), yaml_string(&Utc::now().to_rfc3339()));
    if !next.contains_key("content_sha256") {
        next.insert(
            "content_sha256".into(),
            yaml_string(&hash_normalized_body(&current.body)),
        );
    }
    if !next.contains_key("hash_scope") {
        next.insert("hash_scope".into(), yaml_string(HASH_SCOPE));
    }
    save_manifest(conn, root, path, &next, &current.body)
}

fn pick_anchor(body: &str, project: Option<&str>, harness: Option<&str>) -> String {
    if let Some(project) = project.and_then(|value| {
        Path::new(value)
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
    }) && !project.trim().is_empty()
    {
        return project;
    }
    for token in body.split_whitespace() {
        let clean = token
            .trim_matches(|c: char| matches!(c, ',' | '.' | ':' | ';' | '(' | ')' | '[' | ']'));
        if clean.starts_with("packages/")
            || clean.starts_with("web/")
            || clean.contains(".ts")
            || clean.contains(".tsx")
            || clean.contains(".js")
            || clean.contains(".jsx")
            || clean.contains(".rs")
            || clean.contains(".md")
            || clean.starts_with("PR#")
            || clean.starts_with("issue#")
            || clean.starts_with("task#")
        {
            return clean.to_string();
        }
    }
    harness.unwrap_or("session").trim().to_string()
}

fn fallback_sentence(
    body: &str,
    project: Option<&str>,
    harness: Option<&str>,
    kind: ArtifactKind,
) -> String {
    let anchor = pick_anchor(body, project, harness);
    match kind {
        ArtifactKind::Compaction => format!(
            "Compaction for {anchor} preserved durable context, linked active session state, and captured this summary for later MEMORY.md projection and drill-down."
        ),
        _ => format!(
            "Session {anchor} captured durable {} context, preserved lineage metadata, and recorded this artifact for MEMORY.md projection and later drill-down.",
            kind.as_str()
        ),
    }
}

fn sentence_word_count(text: &str) -> usize {
    text.split_whitespace()
        .filter(|word| !word.is_empty())
        .count()
}

fn has_terminal_punctuation(text: &str) -> bool {
    text.trim_end().ends_with(['.', '!', '?'])
}

fn has_concrete_anchor(text: &str, body: &str, project: Option<&str>) -> bool {
    let anchor = pick_anchor(body, project, None);
    text.contains(&anchor)
        || text.contains("packages/")
        || text.contains("web/")
        || text.contains("PR#")
        || text.contains("issue#")
        || text.contains("task#")
        || text.contains(".ts")
        || text.contains(".tsx")
        || text.contains(".js")
        || text.contains(".jsx")
        || text.contains(".rs")
        || text.contains(".md")
}

pub fn validate_sentence(text: &str, body: &str, project: Option<&str>) -> bool {
    if LOW_SIGNAL_SENTENCES.contains(&text.trim()) {
        return false;
    }
    let count = sentence_word_count(text);
    if !(12..=48).contains(&count) {
        return false;
    }
    if !has_terminal_punctuation(text) {
        return false;
    }
    has_concrete_anchor(text, body, project)
}

fn coerce_sentence(
    text: Option<&str>,
    body: &str,
    project: Option<&str>,
    harness: Option<&str>,
    kind: ArtifactKind,
) -> String {
    if let Some(text) = text
        && validate_sentence(text, body, project)
    {
        return text.to_string();
    }
    fallback_sentence(body, project, harness, kind)
}

fn sentence_prompt(body: &str, project: Option<&str>, kind: ArtifactKind) -> String {
    format!(
        "Write exactly one sentence summarizing this {} artifact for MEMORY.md.\n\nRules:\n- 12 to 48 words\n- must end with punctuation\n- include at least one concrete anchor like a project name, path token, issue id, PR id, or component name\n- no lists, no markdown, no quotes\n- exactly one sentence\n\nProject: {}\n\nArtifact:\n{}",
        kind.as_str(),
        project.unwrap_or("none"),
        body.chars().take(4000).collect::<String>()
    )
}

pub async fn resolve_memory_sentence(
    body: &str,
    project: Option<&str>,
    harness: Option<&str>,
    kind: ArtifactKind,
    provider: Option<&std::sync::Arc<dyn LlmProvider>>,
    semaphore: Option<&std::sync::Arc<LlmSemaphore>>,
) -> MemorySentence {
    let generated_at = Utc::now().to_rfc3339();
    if let (Some(provider), Some(semaphore)) = (provider, semaphore) {
        let prompt = sentence_prompt(body, project, kind);
        let opts = GenerateOpts {
            timeout_ms: Some(10_000),
            max_tokens: Some(120),
        };
        let result = semaphore
            .run(async { provider.generate(&prompt, &opts).await })
            .await;
        if let Ok(raw) = result {
            let cleaned = normalize_markdown_body(&raw.text).replace('\n', " ");
            let line = cleaned
                .split_terminator(['.', '!', '?'])
                .next()
                .map(|value| format!("{}.", value.trim_end_matches(['.', '!', '?']).trim()))
                .unwrap_or_else(|| cleaned.trim().to_string());
            if validate_sentence(&line, body, project) {
                return MemorySentence {
                    text: line,
                    quality: "ok".to_string(),
                    generated_at,
                };
            }
        }
    }
    MemorySentence {
        text: fallback_sentence(body, project, harness, kind),
        quality: "fallback".to_string(),
        generated_at,
    }
}

fn write_immutable_artifact(
    conn: &Connection,
    root: &Path,
    seed: ArtifactSeed,
) -> Result<PathBuf, String> {
    let path = artifact_path(root, &seed.captured_at, &seed.session_token, seed.kind);
    let body = normalize_markdown_body(&seed.body);
    let mut frontmatter = BTreeMap::new();
    frontmatter.insert("kind".into(), yaml_string(seed.kind.as_str()));
    frontmatter.insert("agent_id".into(), yaml_string(&seed.agent_id));
    frontmatter.insert("session_id".into(), yaml_string(&seed.session_id));
    frontmatter.insert(
        "session_key".into(),
        yaml_opt_string(seed.session_key.as_deref()),
    );
    frontmatter.insert("project".into(), yaml_opt_string(seed.project.as_deref()));
    frontmatter.insert("harness".into(), yaml_opt_string(seed.harness.as_deref()));
    frontmatter.insert("captured_at".into(), yaml_string(&seed.captured_at));
    frontmatter.insert(
        "started_at".into(),
        yaml_opt_string(seed.started_at.as_deref()),
    );
    frontmatter.insert("ended_at".into(), yaml_opt_string(seed.ended_at.as_deref()));
    frontmatter.insert("manifest_path".into(), yaml_string(&seed.manifest_path));
    frontmatter.insert(
        "source_node_id".into(),
        yaml_opt_string(seed.source_node_id.as_deref()),
    );
    frontmatter.insert(
        "content_sha256".into(),
        yaml_string(&hash_normalized_body(&body)),
    );
    frontmatter.insert("hash_scope".into(), yaml_string(HASH_SCOPE));
    frontmatter.insert(
        "memory_sentence".into(),
        yaml_string(&seed.memory_sentence.text),
    );
    frontmatter.insert(
        "memory_sentence_version".into(),
        yaml_string(SENTENCE_VERSION),
    );
    frontmatter.insert(
        "memory_sentence_quality".into(),
        yaml_string(&seed.memory_sentence.quality),
    );
    frontmatter.insert(
        "memory_sentence_generated_at".into(),
        yaml_string(&seed.memory_sentence.generated_at),
    );
    if seed.kind == ArtifactKind::Transcript {
        frontmatter.insert("sanitizer_version".into(), yaml_string(SANITIZER_VERSION));
    }
    let content = format!("{}\n{}\n", frontmatter_string(&frontmatter)?, body);
    if path.exists() {
        let existing = fs::read_to_string(&path).map_err(|err| err.to_string())?;
        let (existing_frontmatter, existing_body) = parse_document(&existing)?;
        let current = read_string(&existing_frontmatter, "content_sha256");
        let next = read_string(&frontmatter, "content_sha256");
        if current == next {
            return Ok(path);
        }
        if normalize_markdown_body(&existing_body) != body {
            return Err(format!(
                "refusing to mutate immutable artifact {}",
                path.display()
            ));
        }
    }
    write_atomic(&path, &content)?;
    upsert_artifact_row(conn, root, &path, &frontmatter, &body)?;
    Ok(path)
}

fn is_valid_artifact(
    root: &Path,
    path: &Path,
    frontmatter: &BTreeMap<String, YamlValue>,
    body: &str,
) -> bool {
    let Some(kind_str) = read_string(frontmatter, "kind") else {
        return false;
    };
    let Some(kind) = ArtifactKind::from_str(&kind_str) else {
        return false;
    };
    if read_string(frontmatter, "agent_id").is_none()
        || read_string(frontmatter, "session_id").is_none()
        || read_string(frontmatter, "captured_at").is_none()
        || read_string(frontmatter, "hash_scope").as_deref() != Some(HASH_SCOPE)
        || read_string(frontmatter, "content_sha256").as_deref()
            != Some(hash_normalized_body(body).as_str())
    {
        return false;
    }
    if kind == ArtifactKind::Transcript
        && read_string(frontmatter, "sanitizer_version").as_deref() != Some(SANITIZER_VERSION)
    {
        return false;
    }
    if kind != ArtifactKind::Manifest
        && !read_string(frontmatter, "manifest_path")
            .is_some_and(|value| value.starts_with("memory/"))
    {
        return false;
    }
    let rel = relative_path(root, path);
    rel.starts_with("memory/") && rel.ends_with(&format!("--{}.md", kind.as_str()))
}

fn upsert_artifact_row(
    conn: &Connection,
    root: &Path,
    path: &Path,
    frontmatter: &BTreeMap<String, YamlValue>,
    body: &str,
) -> Result<(), String> {
    let source_path = relative_path(root, path);
    let agent_id = read_string(frontmatter, "agent_id").unwrap_or_else(|| "default".to_string());
    let source_kind = read_string(frontmatter, "kind").unwrap_or_else(|| "manifest".to_string());
    let session_id = read_string(frontmatter, "session_id").unwrap_or_else(|| source_path.clone());
    let session_key = read_string(frontmatter, "session_key");
    let session_token = source_path
        .split("--")
        .nth(1)
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| derive_session_token(&agent_id, session_key.as_deref(), &session_id));
    let project = read_string(frontmatter, "project");
    let harness = read_string(frontmatter, "harness");
    let captured_at =
        read_string(frontmatter, "captured_at").unwrap_or_else(|| Utc::now().to_rfc3339());
    let started_at = read_string(frontmatter, "started_at");
    let ended_at = read_string(frontmatter, "ended_at");
    let manifest_path = read_string(frontmatter, "manifest_path");
    let source_node_id = read_string(frontmatter, "source_node_id");
    let memory_sentence = read_string(frontmatter, "memory_sentence");
    let quality = read_string(frontmatter, "memory_sentence_quality");
    let source_sha =
        read_string(frontmatter, "content_sha256").unwrap_or_else(|| hash_normalized_body(body));
    let updated_at =
        read_string(frontmatter, "updated_at").unwrap_or_else(|| Utc::now().to_rfc3339());
    conn.execute(
        "INSERT INTO memory_artifacts (
            agent_id, source_path, source_sha256, source_kind, session_id,
            session_key, session_token, project, harness, captured_at,
            started_at, ended_at, manifest_path, source_node_id,
            memory_sentence, memory_sentence_quality, content, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)
         ON CONFLICT(agent_id, source_path) DO UPDATE SET
            source_sha256 = excluded.source_sha256,
            source_kind = excluded.source_kind,
            session_id = excluded.session_id,
            session_key = excluded.session_key,
            session_token = excluded.session_token,
            project = excluded.project,
            harness = excluded.harness,
            captured_at = excluded.captured_at,
            started_at = excluded.started_at,
            ended_at = excluded.ended_at,
            manifest_path = excluded.manifest_path,
            source_node_id = excluded.source_node_id,
            memory_sentence = excluded.memory_sentence,
            memory_sentence_quality = excluded.memory_sentence_quality,
            content = excluded.content,
            updated_at = excluded.updated_at",
        params![
            agent_id,
            source_path,
            source_sha,
            source_kind,
            session_id,
            session_key,
            session_token,
            project,
            harness,
            captured_at,
            started_at,
            ended_at,
            manifest_path,
            source_node_id,
            memory_sentence,
            quality,
            normalize_markdown_body(body),
            updated_at,
        ],
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}

fn list_canonical_files(root: &Path) -> Result<Vec<PathBuf>, String> {
    let dir = memory_dir(root);
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut files = fs::read_dir(dir)
        .map_err(|err| err.to_string())?
        .filter_map(|entry| entry.ok().map(|value| value.path()))
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| {
                    name.ends_with("--summary.md")
                        || name.ends_with("--transcript.md")
                        || name.ends_with("--compaction.md")
                        || name.ends_with("--manifest.md")
                })
        })
        .collect::<Vec<_>>();
    files.sort();
    Ok(files)
}

pub fn reindex_memory_artifacts(
    conn: &Connection,
    root: &Path,
    agent_id: Option<&str>,
) -> Result<(), String> {
    if agent_id.is_some() {
        conn.execute(
            "DELETE FROM memory_artifacts WHERE agent_id = ?1",
            params![agent_id],
        )
        .map_err(|err| err.to_string())?;
    } else {
        conn.execute("DELETE FROM memory_artifacts", [])
            .map_err(|err| err.to_string())?;
    }
    let tombstones = {
        let mut stmt = if agent_id.is_some() {
            conn.prepare("SELECT session_token FROM memory_artifact_tombstones WHERE agent_id = ?1")
        } else {
            conn.prepare("SELECT session_token FROM memory_artifact_tombstones")
        }
        .map_err(|err| err.to_string())?;
        if let Some(agent_id) = agent_id {
            let rows = stmt
                .query_map(params![agent_id], |row| row.get::<_, String>(0))
                .map_err(|err| err.to_string())?;
            rows.filter_map(Result::ok).collect::<BTreeSet<_>>()
        } else {
            let rows = stmt
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(|err| err.to_string())?;
            rows.filter_map(Result::ok).collect::<BTreeSet<_>>()
        }
    };
    for path in list_canonical_files(root)? {
        let content = fs::read_to_string(&path).map_err(|err| err.to_string())?;
        let (frontmatter, body) = parse_document(&content)?;
        let next_agent =
            read_string(&frontmatter, "agent_id").unwrap_or_else(|| "default".to_string());
        if agent_id.is_some_and(|value| value != next_agent) {
            continue;
        }
        let rel = relative_path(root, &path);
        let token = rel.split("--").nth(1).map(ToOwned::to_owned);
        if token
            .as_ref()
            .is_some_and(|value| tombstones.contains(value))
        {
            continue;
        }
        let normalized = normalize_markdown_body(&body);
        if !is_valid_artifact(root, &path, &frontmatter, &normalized) {
            continue;
        }
        upsert_artifact_row(conn, root, &path, &frontmatter, &normalized)?;
    }
    Ok(())
}

pub fn write_transcript_artifact(
    conn: &Connection,
    root: &Path,
    input: TranscriptArtifactInput,
) -> Result<ArtifactWrite, String> {
    let manifest = ensure_canonical_manifest(
        conn,
        root,
        &input.agent_id,
        &input.session_id,
        input.session_key.as_deref(),
        input.project.as_deref(),
        input.harness.as_deref(),
        &input.captured_at,
        input.started_at.as_deref(),
        input.ended_at.as_deref(),
    )?;
    let captured_at = manifest_value(&manifest.frontmatter, "captured_at")
        .unwrap_or_else(|| input.captured_at.clone());
    let token = derive_session_token(
        &input.agent_id,
        input.session_key.as_deref(),
        &input.session_id,
    );
    let body = sanitize_transcript_v1(&input.transcript);
    let sentence = MemorySentence {
        text: fallback_sentence(
            &body,
            input.project.as_deref(),
            input.harness.as_deref(),
            ArtifactKind::Transcript,
        ),
        quality: "fallback".to_string(),
        generated_at: Utc::now().to_rfc3339(),
    };
    let full = write_immutable_artifact(
        conn,
        root,
        ArtifactSeed {
            kind: ArtifactKind::Transcript,
            agent_id: input.agent_id,
            session_id: input.session_id,
            session_key: input.session_key,
            project: input.project,
            harness: input.harness,
            captured_at,
            started_at: input.started_at,
            ended_at: input.ended_at,
            session_token: token,
            manifest_path: relative_path(root, &manifest.path),
            source_node_id: None,
            memory_sentence: sentence,
            body,
        },
    )?;
    Ok(ArtifactWrite {
        manifest_path: relative_path(root, &manifest.path),
        artifact_path: relative_path(root, &full),
    })
}

pub fn write_summary_artifact(
    conn: &Connection,
    root: &Path,
    input: SummaryArtifactInput,
    sentence: MemorySentence,
) -> Result<ArtifactWrite, String> {
    let manifest = ensure_canonical_manifest(
        conn,
        root,
        &input.agent_id,
        &input.session_id,
        input.session_key.as_deref(),
        input.project.as_deref(),
        input.harness.as_deref(),
        &input.captured_at,
        input.started_at.as_deref(),
        input.ended_at.as_deref(),
    )?;
    let captured_at = manifest_value(&manifest.frontmatter, "captured_at")
        .unwrap_or_else(|| input.captured_at.clone());
    let token = derive_session_token(
        &input.agent_id,
        input.session_key.as_deref(),
        &input.session_id,
    );
    let full = write_immutable_artifact(
        conn,
        root,
        ArtifactSeed {
            kind: ArtifactKind::Summary,
            agent_id: input.agent_id,
            session_id: input.session_id,
            session_key: input.session_key,
            project: input.project,
            harness: input.harness,
            captured_at,
            started_at: input.started_at,
            ended_at: input.ended_at,
            session_token: token,
            manifest_path: relative_path(root, &manifest.path),
            source_node_id: None,
            memory_sentence: sentence,
            body: input.summary,
        },
    )?;
    Ok(ArtifactWrite {
        manifest_path: relative_path(root, &manifest.path),
        artifact_path: relative_path(root, &full),
    })
}

pub fn write_compaction_artifact(
    conn: &Connection,
    root: &Path,
    input: SummaryArtifactInput,
    sentence: MemorySentence,
) -> Result<ArtifactWrite, String> {
    let manifest = ensure_canonical_manifest(
        conn,
        root,
        &input.agent_id,
        &input.session_id,
        input.session_key.as_deref(),
        input.project.as_deref(),
        input.harness.as_deref(),
        &input.captured_at,
        input.started_at.as_deref(),
        input.ended_at.as_deref(),
    )?;
    let captured_at = manifest_value(&manifest.frontmatter, "captured_at")
        .unwrap_or_else(|| input.captured_at.clone());
    let token = derive_session_token(
        &input.agent_id,
        input.session_key.as_deref(),
        &input.session_id,
    );
    let full = write_immutable_artifact(
        conn,
        root,
        ArtifactSeed {
            kind: ArtifactKind::Compaction,
            agent_id: input.agent_id,
            session_id: input.session_id,
            session_key: input.session_key.clone(),
            project: input.project.clone(),
            harness: input.harness.clone(),
            captured_at,
            started_at: input.started_at.clone(),
            ended_at: input.ended_at.clone(),
            session_token: token,
            manifest_path: relative_path(root, &manifest.path),
            source_node_id: None,
            memory_sentence: sentence,
            body: input.summary,
        },
    )?;
    let rel = relative_path(root, &full);
    update_manifest(conn, root, &manifest.path, |frontmatter, _| {
        frontmatter.insert("compaction_path".into(), yaml_string(&rel));
        frontmatter.insert(
            "ended_at".into(),
            yaml_opt_string(input.ended_at.as_deref()),
        );
    })?;
    Ok(ArtifactWrite {
        manifest_path: relative_path(root, &manifest.path),
        artifact_path: rel,
    })
}

fn build_temporal_index(conn: &Connection, agent_id: &str) -> String {
    let mut stmt = match conn.prepare(
        "SELECT id, kind, COALESCE(source_type, kind), depth, latest_at,
                project, session_key, source_ref, content
         FROM session_summaries
         WHERE agent_id = ?1
         ORDER BY latest_at DESC
         LIMIT 20",
    ) {
        Ok(stmt) => stmt,
        Err(_) => return "## Temporal Index\n\n- no temporal nodes yet.".to_string(),
    };
    let rows = stmt.query_map(params![agent_id], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, i64>(3)?,
            row.get::<_, String>(4)?,
            row.get::<_, Option<String>>(5)?,
            row.get::<_, Option<String>>(6)?,
            row.get::<_, Option<String>>(7)?,
            row.get::<_, String>(8)?,
        ))
    });
    let Ok(rows) = rows else {
        return "## Temporal Index\n\n- no temporal nodes yet.".to_string();
    };
    let lines = rows
        .filter_map(Result::ok)
        .map(|row| {
            let preview = normalize_markdown_body(&row.8)
                .replace('\n', " ")
                .chars()
                .take(120)
                .collect::<String>();
            format!(
                "- id={} kind={} source={} depth={} session={} project={} ref={} latest={}\n  summary: {}",
                row.0,
                row.1,
                row.2,
                row.3,
                row.6.unwrap_or_else(|| "none".to_string()),
                row.5.unwrap_or_else(|| "none".to_string()),
                row.7.unwrap_or_else(|| "none".to_string()),
                row.4,
                preview
            )
        })
        .collect::<Vec<_>>();
    if lines.is_empty() {
        "## Temporal Index\n\n- no temporal nodes yet.".to_string()
    } else {
        format!("## Temporal Index\n\n{}", lines.join("\n"))
    }
}

fn choose_sentence(rows: &[ArtifactRow]) -> Option<&ArtifactRow> {
    rows.iter().max_by(|a, b| {
        let rank = |kind: &str| match kind {
            "summary" => 3,
            "compaction" => 2,
            "transcript" => 1,
            _ => 0,
        };
        rank(&a.source_kind)
            .cmp(&rank(&b.source_kind))
            .then_with(|| {
                (a.ended_at.as_deref().unwrap_or(&a.captured_at))
                    .cmp(b.ended_at.as_deref().unwrap_or(&b.captured_at))
            })
    })
}

fn path_for_kind(rows: &[ArtifactRow], kind: &str) -> Option<String> {
    rows.iter()
        .find(|row| row.source_kind == kind)
        .map(|row| row.source_path.clone())
}

fn membership_ts(rows: &[ArtifactRow]) -> String {
    choose_sentence(rows)
        .map(|row| {
            row.ended_at
                .clone()
                .unwrap_or_else(|| row.captured_at.clone())
        })
        .unwrap_or_else(|| Utc::now().to_rfc3339())
}

fn build_ledger(conn: &Connection, agent_id: &str) -> Result<(String, Vec<String>, usize), String> {
    let now = Utc::now();
    let floor = now - chrono::TimeDelta::days(30);
    let mut stmt = conn
        .prepare(
            "SELECT source_path, source_kind, session_id, session_key, session_token, project,
                    harness, captured_at, ended_at, manifest_path, memory_sentence, content
             FROM memory_artifacts
             WHERE agent_id = ?1
               AND source_kind IN ('summary', 'transcript', 'compaction')
             ORDER BY COALESCE(ended_at, captured_at) DESC, captured_at DESC",
        )
        .map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map(params![agent_id], |row| {
            Ok(ArtifactRow {
                source_path: row.get(0)?,
                source_kind: row.get(1)?,
                session_id: row.get(2)?,
                session_key: row.get(3)?,
                session_token: row.get(4)?,
                project: row.get(5)?,
                harness: row.get(6)?,
                captured_at: row.get(7)?,
                ended_at: row.get(8)?,
                manifest_path: row.get(9)?,
                memory_sentence: row.get(10)?,
                content: row.get(11)?,
            })
        })
        .map_err(|err| err.to_string())?
        .filter_map(Result::ok)
        .collect::<Vec<_>>();
    let mut grouped = HashMap::<String, Vec<ArtifactRow>>::new();
    for row in rows {
        grouped
            .entry(row.session_token.clone())
            .or_default()
            .push(row);
    }
    let mut sessions = grouped
        .into_values()
        .filter_map(|group| {
            let ts = membership_ts(&group);
            let stamp = chrono::DateTime::parse_from_rfc3339(&ts)
                .ok()?
                .with_timezone(&Utc);
            if stamp < floor || stamp > now {
                return None;
            }
            let picked = choose_sentence(&group)?;
            let kind = ArtifactKind::from_str(&picked.source_kind).unwrap_or(ArtifactKind::Summary);
            Some(LedgerSession {
                session_id: group[0].session_id.clone(),
                session_key: picked.session_key.clone(),
                project: group.iter().find_map(|row| row.project.clone()),
                membership_ts: ts,
                sentence: coerce_sentence(
                    picked.memory_sentence.as_deref(),
                    &picked.content,
                    picked.project.as_deref(),
                    picked.harness.as_deref(),
                    kind,
                ),
                summary_path: path_for_kind(&group, "summary"),
                transcript_path: path_for_kind(&group, "transcript"),
                compaction_path: path_for_kind(&group, "compaction"),
                manifest_path: picked.manifest_path.clone(),
            })
        })
        .collect::<Vec<_>>();
    sessions.sort_by(|a, b| b.membership_ts.cmp(&a.membership_ts));
    let refs = sessions
        .iter()
        .filter_map(|session| session.manifest_path.clone())
        .collect::<Vec<_>>();
    let mut lines = vec![
        "## Session Ledger (Last 30 Days)".to_string(),
        String::new(),
    ];
    let mut day = String::new();
    for session in &sessions {
        let utc_day = session.membership_ts.chars().take(10).collect::<String>();
        if utc_day != day {
            day = utc_day;
            lines.push(format!("### {day}"));
            lines.push(String::new());
        }
        let links = [
            session
                .summary_path
                .as_deref()
                .map(|path| wikilink(path, Some("summary"))),
            session
                .transcript_path
                .as_deref()
                .map(|path| wikilink(path, Some("transcript"))),
            session
                .compaction_path
                .as_deref()
                .map(|path| wikilink(path, Some("compaction"))),
            session
                .manifest_path
                .as_deref()
                .map(|path| wikilink(path, Some("manifest"))),
        ]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();
        lines.push(
            format!(
                "- {} | session={} | project={} | {} {}",
                session.membership_ts,
                session
                    .session_key
                    .clone()
                    .unwrap_or_else(|| session.session_id.clone()),
                session
                    .project
                    .clone()
                    .unwrap_or_else(|| "none".to_string()),
                session.sentence,
                links.join(" ")
            )
            .trim()
            .to_string(),
        );
    }
    if sessions.is_empty() {
        lines.push("- no in-window sessions yet.".to_string());
    }
    Ok((lines.join("\n"), refs, sessions.len()))
}

fn sync_manifest_refs(conn: &Connection, root: &Path, refs: &[String]) -> Result<(), String> {
    let wanted = refs.iter().cloned().collect::<BTreeSet<_>>();
    for path in list_canonical_files(root)? {
        if !path.to_string_lossy().ends_with("--manifest.md") {
            continue;
        }
        let Some(state) = load_manifest(&path)? else {
            continue;
        };
        let rel = relative_path(root, &path);
        let next = if wanted.contains(&rel) {
            vec![LEDGER_HEADING.to_string()]
        } else {
            Vec::new()
        };
        let current = read_string_list(&state.frontmatter, "memory_md_refs");
        if current == next {
            continue;
        }
        update_manifest(conn, root, &path, |frontmatter, _| {
            frontmatter.insert("memory_md_refs".into(), yaml_list(&next));
        })?;
    }
    Ok(())
}

pub fn render_memory_projection(
    conn: &Connection,
    root: &Path,
    agent_id: &str,
) -> Result<RenderResult, String> {
    reindex_memory_artifacts(conn, root, Some(agent_id))?;
    let memories = conn
        .prepare(
            "SELECT content, type, importance, project
             FROM memories
             WHERE agent_id = ?1 AND is_deleted = 0
             ORDER BY pinned DESC, importance DESC, created_at DESC
             LIMIT 8",
        )
        .map_err(|err| err.to_string())?
        .query_map(params![agent_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, f64>(2)?,
                row.get::<_, Option<String>>(3)?,
            ))
        })
        .map_err(|err| err.to_string())?
        .filter_map(Result::ok)
        .collect::<Vec<_>>();
    let thread_heads = match conn.prepare(
        "SELECT label, source_type, latest_at, sample, node_id
         FROM memory_thread_heads
         WHERE agent_id = ?1
         ORDER BY latest_at DESC
         LIMIT 12",
    ) {
        Ok(mut stmt) => stmt
            .query_map(params![agent_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                ))
            })
            .ok()
            .map(|rows| rows.filter_map(Result::ok).collect::<Vec<_>>())
            .unwrap_or_default(),
        Err(_) => Vec::new(),
    };
    let (ledger, refs, count) = build_ledger(conn, agent_id)?;
    sync_manifest_refs(conn, root, &refs)?;
    let index_block = build_temporal_index(conn, agent_id);
    let global_lines = if memories.is_empty() {
        vec!["- no durable global head items yet.".to_string()]
    } else {
        memories
            .iter()
            .map(|row| format!("- [{}] {}", row.1, row.0))
            .collect::<Vec<_>>()
    };
    let thread_lines = if thread_heads.is_empty() {
        vec!["- no thread heads yet.".to_string()]
    } else {
        let mut lines = Vec::new();
        for row in &thread_heads {
            lines.push(format!("### {}", row.0));
            lines.push(format!("- {}", row.3));
            lines.push(format!(
                "- latest={} source={} node={}",
                row.2, row.1, row.4
            ));
            lines.push(String::new());
        }
        lines
    };
    let open_lines = if thread_heads.is_empty() {
        vec!["- no open thread heads yet.".to_string()]
    } else {
        thread_heads
            .iter()
            .take(8)
            .map(|row| format!("- {}", row.0))
            .collect::<Vec<_>>()
    };
    let durable_lines = if memories.is_empty() {
        vec!["- no durable notes yet.".to_string()]
    } else {
        memories
            .iter()
            .map(|row| format!("- {}", row.0))
            .collect::<Vec<_>>()
    };
    let mut parts = vec![
        "# Working Memory Summary".to_string(),
        String::new(),
        "## Global Head (Tier 1)".to_string(),
        String::new(),
    ];
    parts.extend(global_lines);
    parts.extend([
        String::new(),
        "## Thread Heads (Tier 2)".to_string(),
        String::new(),
    ]);
    parts.extend(thread_lines);
    parts.push(ledger);
    parts.extend([String::new(), "## Open Threads".to_string(), String::new()]);
    parts.extend(open_lines);
    parts.extend([
        String::new(),
        "## Durable Notes & Constraints".to_string(),
        String::new(),
    ]);
    parts.extend(durable_lines);
    parts.extend([String::new(), index_block.clone()]);
    Ok(RenderResult {
        content: parts.join("\n").trim_end().to_string(),
        file_count: memories.len() + thread_heads.len() + count,
        index_block,
    })
}

pub fn write_memory_projection(
    conn: &Connection,
    root: &Path,
    agent_id: &str,
) -> Result<RenderResult, String> {
    let rendered = render_memory_projection(conn, root, agent_id)?;
    write_atomic(&root.join("MEMORY.md"), &format!("{}\n", rendered.content))?;
    Ok(rendered)
}

pub fn upsert_thread_head(
    conn: &Connection,
    agent_id: &str,
    thread_key: &str,
    label: &str,
    project: Option<&str>,
    session_key: Option<&str>,
    source_type: &str,
    source_ref: Option<&str>,
    harness: Option<&str>,
    node_id: &str,
    latest_at: &str,
    sample: &str,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO memory_thread_heads (
            agent_id, thread_key, label, project, session_key, source_type,
            source_ref, harness, node_id, latest_at, sample, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
         ON CONFLICT(agent_id, thread_key) DO UPDATE SET
            label = excluded.label,
            project = excluded.project,
            session_key = excluded.session_key,
            source_type = excluded.source_type,
            source_ref = excluded.source_ref,
            harness = excluded.harness,
            node_id = excluded.node_id,
            latest_at = excluded.latest_at,
            sample = excluded.sample,
            updated_at = excluded.updated_at
         WHERE excluded.latest_at >= memory_thread_heads.latest_at",
        params![
            agent_id,
            thread_key,
            label,
            project,
            session_key,
            source_type,
            source_ref,
            harness,
            node_id,
            latest_at,
            sample,
            Utc::now().to_rfc3339(),
        ],
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}

fn thread_key(project: Option<&str>, source_ref: Option<&str>) -> String {
    match (
        project.filter(|value| !value.trim().is_empty()),
        source_ref.filter(|value| !value.trim().is_empty()),
    ) {
        (Some(project), Some(source_ref)) => format!("project:{project}|source:{source_ref}"),
        (Some(project), None) => format!("project:{project}"),
        (None, Some(source_ref)) => format!("source:{source_ref}"),
        (None, None) => "summary".to_string(),
    }
}

fn thread_label(project: Option<&str>, source_ref: Option<&str>, summary: &str) -> String {
    if let Some(source_ref) = source_ref
        && !source_ref.trim().is_empty()
    {
        return source_ref.to_string();
    }
    if let Some(project) = project
        && !project.trim().is_empty()
    {
        return format!("project:{project}");
    }
    summary
        .lines()
        .find(|line| line.starts_with("## "))
        .map(|line| line.trim_start_matches("## ").trim().to_string())
        .filter(|line| !line.is_empty())
        .unwrap_or_else(|| "summary".to_string())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SummaryFact {
    pub content: String,
    pub importance: Option<f64>,
    pub tags: Option<String>,
    #[serde(rename = "type")]
    pub kind: Option<String>,
}

pub fn write_summary_to_dag(
    conn: &Connection,
    agent_id: &str,
    session_key: Option<&str>,
    project: Option<&str>,
    harness: Option<&str>,
    created_at: &str,
    latest_at: &str,
    trigger: &str,
    summary: &str,
    leaves: &[String],
) -> Result<String, String> {
    let source_type = if trigger == "checkpoint_extract" {
        "checkpoint"
    } else {
        "summary"
    };
    let existing = if source_type == "summary" {
        session_key
            .map(|key| {
                conn.query_row(
                    "SELECT id FROM session_summaries
                     WHERE agent_id = ?1 AND session_key = ?2 AND depth = 0
                       AND COALESCE(source_type, 'summary') = 'summary'",
                    params![agent_id, key],
                    |row| row.get::<_, String>(0),
                )
                .optional()
            })
            .transpose()
            .map_err(|err| err.to_string())?
            .flatten()
    } else {
        None
    };
    let node_id = existing
        .clone()
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let token_count = ((summary.len() as f64) / 4.0).ceil() as i64;
    let meta = JsonValue::Object(
        [
            (
                "source".to_string(),
                JsonValue::String("summary-worker".to_string()),
            ),
            (
                "trigger".to_string(),
                JsonValue::String(trigger.to_string()),
            ),
        ]
        .into_iter()
        .collect(),
    );
    if existing.is_some() {
        conn.execute(
            "UPDATE session_summaries
             SET content = ?1, token_count = ?2, latest_at = ?3,
                 source_type = ?4, source_ref = ?5, meta_json = ?6
             WHERE id = ?7",
            params![
                summary,
                token_count,
                latest_at,
                source_type,
                session_key,
                meta.to_string(),
                node_id,
            ],
        )
        .map_err(|err| err.to_string())?;
    } else {
        conn.execute(
            "INSERT INTO session_summaries (
                id, project, depth, kind, content, token_count,
                earliest_at, latest_at, session_key, harness,
                agent_id, source_type, source_ref, meta_json, created_at
             ) VALUES (?1, ?2, 0, 'session', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            params![
                node_id,
                project,
                summary,
                token_count,
                created_at,
                latest_at,
                session_key,
                harness,
                agent_id,
                source_type,
                session_key,
                meta.to_string(),
                latest_at,
            ],
        )
        .map_err(|err| err.to_string())?;
    }
    let key = thread_key(project, session_key);
    let label = thread_label(project, session_key, summary);
    let sample = normalize_markdown_body(summary)
        .replace('\n', " ")
        .chars()
        .take(280)
        .collect::<String>();
    let _ = upsert_thread_head(
        conn,
        agent_id,
        &key,
        &label,
        project,
        session_key,
        source_type,
        session_key,
        harness,
        &node_id,
        latest_at,
        &sample,
    );
    if let Some(session_key) = session_key {
        conn.execute(
            "DELETE FROM session_summary_children
             WHERE parent_id = ?1
               AND child_id IN (
                    SELECT id FROM session_summaries
                    WHERE source_type = 'chunk' AND source_ref = ?2 AND agent_id = ?3
               )",
            params![node_id, session_key, agent_id],
        )
        .ok();
        for (idx, leaf) in leaves.iter().enumerate() {
            let child_id = format!("{agent_id}:{session_key}:chunk:{}", idx + 1);
            let meta = JsonValue::Object(
                [
                    ("ordinal".to_string(), JsonValue::from((idx + 1) as i64)),
                    ("total".to_string(), JsonValue::from(leaves.len() as i64)),
                ]
                .into_iter()
                .collect(),
            );
            conn.execute(
                "INSERT OR REPLACE INTO session_summaries (
                    id, project, depth, kind, content, token_count,
                    earliest_at, latest_at, session_key, harness,
                    agent_id, source_type, source_ref, meta_json, created_at
                 ) VALUES (?1, ?2, 0, 'session', ?3, ?4, ?5, ?6, NULL, ?7, ?8, 'chunk', ?9, ?10, ?11)",
                params![
                    child_id,
                    project,
                    leaf,
                    ((leaf.len() as f64) / 4.0).ceil() as i64,
                    created_at,
                    latest_at,
                    harness,
                    agent_id,
                    session_key,
                    meta.to_string(),
                    latest_at,
                ],
            )
            .ok();
            conn.execute(
                "INSERT OR REPLACE INTO session_summary_children (parent_id, child_id, ordinal)
                 VALUES (?1, ?2, ?3)",
                params![node_id, child_id, idx as i64],
            )
            .ok();
        }
        let mut stmt = conn
            .prepare(
                "SELECT id FROM memories
                 WHERE source_id = ?1 AND is_deleted = 0
                 ORDER BY created_at DESC
                 LIMIT 50",
            )
            .map_err(|err| err.to_string())?;
        let rows = stmt
            .query_map(params![session_key], |row| row.get::<_, String>(0))
            .map_err(|err| err.to_string())?;
        for memory_id in rows.filter_map(Result::ok) {
            conn.execute(
                "INSERT OR IGNORE INTO session_summary_memories (summary_id, memory_id)
                 VALUES (?1, ?2)",
                params![node_id, memory_id],
            )
            .ok();
        }
    }
    Ok(node_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(name: &str) -> PathBuf {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!(
            "signet-lineage-{name}-{}-{now}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn setup_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE memories (
                id TEXT PRIMARY KEY,
                content TEXT NOT NULL,
                type TEXT NOT NULL,
                importance REAL NOT NULL DEFAULT 0,
                project TEXT,
                source_id TEXT,
                is_deleted INTEGER NOT NULL DEFAULT 0,
                pinned INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                agent_id TEXT NOT NULL DEFAULT 'default'
            );
            CREATE TABLE summary_jobs (
                id TEXT PRIMARY KEY,
                session_key TEXT,
                session_id TEXT,
                harness TEXT,
                project TEXT,
                agent_id TEXT NOT NULL DEFAULT 'default',
                transcript TEXT NOT NULL,
                trigger TEXT NOT NULL DEFAULT 'session_end',
                captured_at TEXT,
                started_at TEXT,
                ended_at TEXT,
                status TEXT NOT NULL DEFAULT 'pending',
                created_at TEXT NOT NULL,
                completed_at TEXT,
                updated_at TEXT,
                failed_at TEXT,
                leased_at TEXT,
                result TEXT,
                attempts INTEGER DEFAULT 0,
                max_attempts INTEGER DEFAULT 3,
                error TEXT
            );
            CREATE TABLE session_summaries (
                id TEXT PRIMARY KEY,
                project TEXT,
                depth INTEGER NOT NULL DEFAULT 0,
                kind TEXT NOT NULL,
                content TEXT NOT NULL,
                token_count INTEGER,
                earliest_at TEXT NOT NULL,
                latest_at TEXT NOT NULL,
                session_key TEXT,
                harness TEXT,
                agent_id TEXT NOT NULL DEFAULT 'default',
                source_type TEXT,
                source_ref TEXT,
                meta_json TEXT,
                created_at TEXT NOT NULL
            );
            CREATE TABLE session_summary_children (
                parent_id TEXT NOT NULL,
                child_id TEXT NOT NULL,
                ordinal INTEGER NOT NULL,
                PRIMARY KEY (parent_id, child_id)
            );
            CREATE TABLE session_summary_memories (
                summary_id TEXT NOT NULL,
                memory_id TEXT NOT NULL,
                PRIMARY KEY (summary_id, memory_id)
            );
            CREATE TABLE memory_thread_heads (
                agent_id TEXT NOT NULL,
                thread_key TEXT NOT NULL,
                label TEXT NOT NULL,
                project TEXT,
                session_key TEXT,
                source_type TEXT NOT NULL,
                source_ref TEXT,
                harness TEXT,
                node_id TEXT NOT NULL,
                latest_at TEXT NOT NULL,
                sample TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                PRIMARY KEY (agent_id, thread_key)
            );
            CREATE TABLE memory_artifacts (
                agent_id TEXT NOT NULL,
                source_path TEXT NOT NULL,
                source_sha256 TEXT NOT NULL,
                source_kind TEXT NOT NULL,
                session_id TEXT NOT NULL,
                session_key TEXT,
                session_token TEXT NOT NULL,
                project TEXT,
                harness TEXT,
                captured_at TEXT NOT NULL,
                started_at TEXT,
                ended_at TEXT,
                manifest_path TEXT,
                source_node_id TEXT,
                memory_sentence TEXT,
                memory_sentence_quality TEXT,
                content TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                PRIMARY KEY (agent_id, source_path)
            );
            CREATE TABLE memory_artifact_tombstones (
                agent_id TEXT NOT NULL,
                session_token TEXT NOT NULL,
                removed_at TEXT NOT NULL,
                reason TEXT NOT NULL,
                removed_paths TEXT NOT NULL,
                PRIMARY KEY (agent_id, session_token)
            );
            CREATE VIRTUAL TABLE memory_artifacts_fts USING fts5(content, source_path, content='memory_artifacts', content_rowid='rowid');
            CREATE TRIGGER memory_artifacts_fts_ai AFTER INSERT ON memory_artifacts BEGIN
                INSERT INTO memory_artifacts_fts(rowid, content, source_path)
                VALUES (new.rowid, new.content, new.source_path);
            END;
            CREATE TRIGGER memory_artifacts_fts_ad AFTER DELETE ON memory_artifacts BEGIN
                INSERT INTO memory_artifacts_fts(memory_artifacts_fts, rowid, content, source_path)
                VALUES ('delete', old.rowid, old.content, old.source_path);
            END;
            CREATE TRIGGER memory_artifacts_fts_au AFTER UPDATE ON memory_artifacts BEGIN
                INSERT INTO memory_artifacts_fts(memory_artifacts_fts, rowid, content, source_path)
                VALUES ('delete', old.rowid, old.content, old.source_path);
                INSERT INTO memory_artifacts_fts(rowid, content, source_path)
                VALUES (new.rowid, new.content, new.source_path);
            END;",
        )
        .unwrap();
        conn
    }

    #[test]
    fn projection_uses_artifact_frontmatter_and_wikilinks() {
        let conn = setup_conn();
        let root = temp_root("projection");
        let now = Utc::now().to_rfc3339();
        let summary_sentence = MemorySentence {
            text: "Finalized packages/daemon-rs/crates/signet-pipeline/src/memory_lineage.rs parity work, preserved immutable artifact lineage, and documented the rolling ledger projection contract for daemon-rs.".to_string(),
            quality: "ok".to_string(),
            generated_at: now.clone(),
        };
        write_transcript_artifact(
            &conn,
            &root,
            TranscriptArtifactInput {
                agent_id: "default".to_string(),
                session_id: "sess-1".to_string(),
                session_key: Some("sess-1".to_string()),
                project: Some("/tmp/proj".to_string()),
                harness: Some("codex".to_string()),
                captured_at: now.clone(),
                started_at: None,
                ended_at: Some(now.clone()),
                transcript: "User: keep daemon-rs aligned\nAssistant: done".to_string(),
            },
        )
        .unwrap();
        write_summary_artifact(
            &conn,
            &root,
            SummaryArtifactInput {
                agent_id: "default".to_string(),
                session_id: "sess-1".to_string(),
                session_key: Some("sess-1".to_string()),
                project: Some("/tmp/proj".to_string()),
                harness: Some("codex".to_string()),
                captured_at: now.clone(),
                started_at: None,
                ended_at: Some(now.clone()),
                summary: "# Session Notes\n\n## Parity\n\nFinished the daemon-rs parity lane."
                    .to_string(),
            },
            summary_sentence,
        )
        .unwrap();
        let rendered = write_memory_projection(&conn, &root, "default").unwrap();
        assert!(
            rendered
                .content
                .contains("## Session Ledger (Last 30 Days)")
        );
        assert!(rendered.content.contains("[[memory/"));
        assert!(rendered.content.contains("manifest]]") || rendered.content.contains("manifest]]"));
        assert!(
            rendered
                .content
                .contains("packages/daemon-rs/crates/signet-pipeline/src/memory_lineage.rs")
        );
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn reindex_skips_tampered_artifacts() {
        let conn = setup_conn();
        let root = temp_root("tamper");
        let now = Utc::now().to_rfc3339();
        let write = write_summary_artifact(
            &conn,
            &root,
            SummaryArtifactInput {
                agent_id: "default".to_string(),
                session_id: "sess-2".to_string(),
                session_key: Some("sess-2".to_string()),
                project: Some("/tmp/proj".to_string()),
                harness: Some("codex".to_string()),
                captured_at: now.clone(),
                started_at: None,
                ended_at: Some(now.clone()),
                summary: "# Session Notes\n\n## Tamper\n\nOriginal body.".to_string(),
            },
            MemorySentence {
                text: "Finalized packages/daemon-rs parity checks, verified checksum behavior, and preserved the rolling ledger projection contract for daemon-rs lineage artifacts.".to_string(),
                quality: "ok".to_string(),
                generated_at: now.clone(),
            },
        )
        .unwrap();
        let path = root.join(&write.artifact_path);
        let content = fs::read_to_string(&path).unwrap();
        let tampered = content.replace("Original body.", "Tampered body.");
        fs::write(&path, tampered).unwrap();
        reindex_memory_artifacts(&conn, &root, Some("default")).unwrap();
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM memory_artifacts WHERE source_kind = 'summary'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 0);
        fs::remove_dir_all(root).ok();
    }
}
