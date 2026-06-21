use std::collections::{BTreeSet, HashMap, HashSet};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::UNIX_EPOCH;

use chrono::{TimeZone, Utc};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value as JsonValue, json};
use sha2::{Digest, Sha256};

use crate::memory_lineage::{hash_normalized_body, normalize_markdown_body};

const NATIVE_MEMORY_BRIDGE_SOURCE_NODE_ID: &str = "native-memory-bridge";

static INDEXED: OnceLock<Mutex<HashMap<String, IndexedNativeMemory>>> = OnceLock::new();

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeMemorySource {
    pub harness: String,
    pub display_name: String,
    pub root: PathBuf,
    pub source_id: Option<String>,
    pub files: Vec<NativeMemoryFilePattern>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeMemoryFilePattern {
    pub glob: String,
    pub kind: String,
    pub include_rule: IncludeRule,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IncludeRule {
    Always,
    BasenameNot(String),
}

#[derive(Debug, Clone, Default)]
pub struct NativeMemorySyncState {
    known: HashMap<String, BTreeSet<String>>,
}

#[derive(Debug, Clone)]
pub struct NativeMemorySyncOptions {
    pub source_cleanup_enabled: bool,
}

impl Default for NativeMemorySyncOptions {
    fn default() -> Self {
        Self {
            source_cleanup_enabled: true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeMemoryFileIndexEvent {
    pub harness: String,
    pub file_path: String,
    pub indexed: bool,
    pub scanned: usize,
    pub total: usize,
    pub changed: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeMemorySyncReport {
    pub changed: usize,
    pub events: Vec<NativeMemoryFileIndexEvent>,
}

#[derive(Debug, Clone)]
struct IndexedNativeMemory {
    content_hash: String,
}

#[derive(Debug, Clone)]
struct ExternalArtifactInput {
    agent_id: String,
    source_path: String,
    source_kind: String,
    harness: String,
    content: String,
    source_mtime_ms: f64,
    source_id: Option<String>,
    source_root: Option<String>,
    source_external_id: Option<String>,
    source_parent_path: Option<String>,
    source_meta: Option<JsonValue>,
}

pub fn codex_native_memory_source(root: impl Into<PathBuf>) -> NativeMemorySource {
    let root = root.into();
    NativeMemorySource {
        harness: "codex".to_string(),
        display_name: "Codex".to_string(),
        source_id: Some(source_id_for_codex_root(&root)),
        root,
        files: vec![
            pattern("memories/memory_summary.md", "native_memory_summary"),
            pattern("memories/MEMORY.md", "native_memory_registry"),
            pattern("memories/raw_memories.md", "native_raw_memories"),
            pattern("memories/rollout_summaries/*.md", "native_rollout_summary"),
            pattern(
                "memories/rollout_summaries/*.jsonl",
                "native_rollout_summary",
            ),
            pattern("memories/skills/**/*.md", "native_skill_memory"),
            pattern(
                "memories/extensions/ad_hoc/notes/*.md",
                "native_ad_hoc_note",
            ),
            pattern("automations/*/memory.md", "native_automation_memory"),
        ],
    }
}

pub fn claude_code_native_memory_source(root: impl Into<PathBuf>) -> NativeMemorySource {
    NativeMemorySource {
        harness: "claude-code".to_string(),
        display_name: "Claude Code".to_string(),
        source_id: None,
        root: root.into(),
        files: vec![
            pattern("projects/*/memory/MEMORY.md", "native_claude_memory_index"),
            NativeMemoryFilePattern {
                glob: "projects/*/memory/**/*.md".to_string(),
                kind: "native_claude_memory".to_string(),
                include_rule: IncludeRule::BasenameNot("MEMORY.md".to_string()),
            },
            pattern("session-memory/**/*.md", "native_claude_session_memory"),
            pattern("agent-memory/*/*.md", "native_claude_agent_memory"),
            pattern(
                "agent-memory-local/*/*.md",
                "native_claude_agent_memory_local",
            ),
        ],
    }
}

pub fn codex_native_memory_source_for_home(home: impl AsRef<Path>) -> NativeMemorySource {
    codex_native_memory_source(home.as_ref().join(".codex"))
}

pub fn claude_code_native_memory_source_for_home(home: impl AsRef<Path>) -> NativeMemorySource {
    claude_code_native_memory_source(home.as_ref().join(".claude"))
}

pub fn default_native_memory_sources() -> Vec<NativeMemorySource> {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    vec![
        codex_native_memory_source_for_home(&home),
        claude_code_native_memory_source_for_home(&home),
    ]
}

pub fn source_id_for_codex_root(root: impl AsRef<Path>) -> String {
    let mut hasher = Sha256::new();
    hasher.update(normalized_root(root.as_ref()).as_bytes());
    let hex = hex_lower(&hasher.finalize());
    format!("codex_native_memory:{}", &hex[..16])
}

pub fn safe_relative_path(root: impl AsRef<Path>, file_path: impl AsRef<Path>) -> Option<String> {
    let root_path = normalized_root(root.as_ref());
    let resolved_path = normalized_path(file_path.as_ref());
    if resolved_path != root_path && !resolved_path.starts_with(&format!("{root_path}/")) {
        return None;
    }
    let rel = resolved_path
        .strip_prefix(&format!("{root_path}/"))
        .unwrap_or("")
        .trim_start_matches('/')
        .to_string();
    if rel.is_empty() || rel == ".." || rel.starts_with("../") {
        return None;
    }
    if rel.split('/').any(|part| part == ".git") {
        return None;
    }
    Some(rel)
}

pub fn matches_pattern<'a>(
    source: &'a NativeMemorySource,
    file_path: impl AsRef<Path>,
) -> Option<&'a NativeMemoryFilePattern> {
    let normalized = normalize_slashes(file_path.as_ref());
    let root = normalized_root(&source.root);
    let rel = normalized
        .strip_prefix(&format!("{root}/"))
        .unwrap_or(&normalized)
        .to_string();
    source.files.iter().find(|pattern| {
        pattern.include_rule.includes(&normalized, &rel) && matches_glob(&pattern.glob, &rel)
    })
}

pub fn matches_glob(glob: &str, rel: &str) -> bool {
    let glob_parts = glob.split('/').collect::<Vec<_>>();
    let rel_parts = rel.split('/').collect::<Vec<_>>();
    match_glob_parts(&glob_parts, &rel_parts)
}

pub fn clear_native_memory_fingerprint_cache() {
    indexed().lock().expect("indexed cache lock").clear();
}

pub fn index_native_memory_file(
    conn: &Connection,
    source: &NativeMemorySource,
    file_path: impl AsRef<Path>,
    agent_id: &str,
) -> Result<bool, String> {
    let file_path = file_path.as_ref();
    if safe_relative_path(&source.root, file_path).is_none() {
        return Ok(false);
    }
    let Some(pattern) = matches_pattern(source, file_path) else {
        return Ok(false);
    };

    let metadata = match fs::symlink_metadata(file_path) {
        Ok(metadata) => metadata,
        Err(_) => return Ok(false),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Ok(false);
    }
    let content = match fs::read_to_string(file_path) {
        Ok(content) => content,
        Err(_) => return Ok(false),
    };
    if content.trim().is_empty() {
        return Ok(false);
    }

    let source_path = normalize_slashes(file_path);
    let key = fingerprint_key(source, &source_path, agent_id);
    let hash = hash_normalized_body(&content);
    let persisted_hash = native_artifact_content_hash(conn, &source_path, agent_id)?;

    {
        let mut cache = indexed().lock().expect("indexed cache lock");
        if cache
            .get(&key)
            .is_some_and(|entry| entry.content_hash == hash)
        {
            if persisted_hash.as_deref() == Some(hash.as_str()) {
                return Ok(false);
            }
            cache.remove(&key);
        }
        if persisted_hash.as_deref() == Some(hash.as_str()) {
            cache.insert(key, IndexedNativeMemory { content_hash: hash });
            return Ok(false);
        }
    }

    let source_id = source.source_id.clone();
    let external_id = if source.harness == "codex" {
        Some(source_relative_path(&source.root, file_path))
    } else {
        None
    };
    let parent = external_id.as_deref().and_then(parent_path);
    let source_root = if source.harness == "codex" {
        Some(normalized_root(&source.root))
    } else {
        None
    };
    let source_meta = codex_source_meta(source, file_path, &content);
    let mtime_ms = metadata
        .modified()
        .ok()
        .and_then(|mtime| mtime.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs_f64() * 1000.0)
        .unwrap_or(0.0);

    index_external_memory_artifact(
        conn,
        ExternalArtifactInput {
            agent_id: agent_id.trim().to_string(),
            source_path: source_path.clone(),
            source_kind: pattern.kind.clone(),
            harness: source.harness.clone(),
            content,
            source_mtime_ms: mtime_ms,
            source_id,
            source_root,
            source_external_id: external_id,
            source_parent_path: parent,
            source_meta,
        },
    )?;
    indexed()
        .lock()
        .expect("indexed cache lock")
        .insert(key, IndexedNativeMemory { content_hash: hash });
    Ok(true)
}

pub fn remove_native_memory_file(
    conn: &Connection,
    source: &NativeMemorySource,
    file_path: impl AsRef<Path>,
    agent_id: &str,
) -> Result<usize, String> {
    let source_path = normalize_slashes(file_path.as_ref());
    indexed()
        .lock()
        .expect("indexed cache lock")
        .remove(&fingerprint_key(source, &source_path, agent_id));
    soft_delete_artifact_rows_for_path(conn, &source_path, agent_id)
}

pub fn purge_native_memory_source_artifacts(
    conn: &Connection,
    source: &NativeMemorySource,
    agent_id: Option<&str>,
) -> Result<usize, String> {
    let root_prefix = format!("{}/", normalized_root(&source.root));
    {
        let mut cache = indexed().lock().expect("indexed cache lock");
        cache.retain(|key, _| {
            let mut parts = key.split(':');
            let cached_agent_id = parts.next().unwrap_or_default();
            let cached_harness = parts.next().unwrap_or_default();
            let cached_path = parts.collect::<Vec<_>>().join(":").replace('\\', "/");
            !((agent_id.is_none_or(|id| cached_agent_id == id))
                && cached_harness == source.harness
                && cached_path.starts_with(&root_prefix))
        });
    }

    let kinds = source_kind_set(source);
    let root_upper = prefix_upper_bound(&root_prefix);
    let rows = select_matching_artifact_paths(conn, source, agent_id, &root_prefix, &root_upper)?;
    let mut purged = 0;
    for row in rows {
        if kinds.contains(row.source_kind.as_str()) {
            purged += conn
                .execute(
                    "DELETE FROM memory_artifacts WHERE agent_id = ?1 AND source_path = ?2",
                    params![row.agent_id, row.source_path],
                )
                .map_err(|err| err.to_string())?;
        }
    }
    Ok(purged)
}

pub fn sync_native_memory_sources(
    conn: &Connection,
    sources: &[NativeMemorySource],
    agent_id: &str,
    state: &mut NativeMemorySyncState,
    options: NativeMemorySyncOptions,
) -> Result<NativeMemorySyncReport, String> {
    let mut changed = 0;
    let mut events = Vec::new();
    for source in sources {
        let key = source_state_key(source, agent_id);
        let mut current = BTreeSet::new();
        if source.root.exists() {
            let files = walk_native_memory_files(&source.root)?
                .into_iter()
                .filter(|path| matches_pattern(source, path).is_some())
                .collect::<Vec<_>>();
            let total = files.len();
            let mut changed_for_source = 0;
            for (index, file) in files.iter().enumerate() {
                let indexed = index_native_memory_file(conn, source, file, agent_id)?;
                if indexed {
                    changed += 1;
                    changed_for_source += 1;
                }
                current.insert(normalize_slashes(file));
                events.push(NativeMemoryFileIndexEvent {
                    harness: source.harness.clone(),
                    file_path: normalize_slashes(file),
                    indexed,
                    scanned: index + 1,
                    total,
                    changed: changed_for_source,
                });
            }
            if options.source_cleanup_enabled {
                for file in active_native_artifact_paths(conn, source, agent_id)? {
                    if !current.contains(&file.replace('\\', "/")) {
                        remove_native_memory_file(conn, source, &file, agent_id)?;
                    }
                }
            }
        }
        if options.source_cleanup_enabled
            && let Some(previous) = state.known.get(&key)
        {
            for file in previous {
                if !current.contains(file) {
                    remove_native_memory_file(conn, source, file, agent_id)?;
                }
            }
        }
        state.known.insert(key, current);
    }
    Ok(NativeMemorySyncReport { changed, events })
}

fn pattern(glob: &str, kind: &str) -> NativeMemoryFilePattern {
    NativeMemoryFilePattern {
        glob: glob.to_string(),
        kind: kind.to_string(),
        include_rule: IncludeRule::Always,
    }
}

impl IncludeRule {
    fn includes(&self, path: &str, _rel: &str) -> bool {
        match self {
            Self::Always => true,
            Self::BasenameNot(name) => path.rsplit('/').next() != Some(name.as_str()),
        }
    }
}

fn indexed() -> &'static Mutex<HashMap<String, IndexedNativeMemory>> {
    INDEXED.get_or_init(|| Mutex::new(HashMap::new()))
}

fn fingerprint_key(source: &NativeMemorySource, file_path: &str, agent_id: &str) -> String {
    format!("{}:{}:{}", agent_id, source.harness, file_path)
}

fn source_state_key(source: &NativeMemorySource, agent_id: &str) -> String {
    format!(
        "{}:{}:{}",
        agent_id,
        source.harness,
        normalized_root(&source.root)
    )
}

fn match_glob_parts(glob_parts: &[&str], rel_parts: &[&str]) -> bool {
    if glob_parts.is_empty() {
        return rel_parts.is_empty();
    }
    let glob_head = glob_parts[0];
    let glob_tail = &glob_parts[1..];
    if glob_head == "**" {
        return match_glob_parts(glob_tail, rel_parts)
            || (!rel_parts.is_empty() && match_glob_parts(glob_parts, &rel_parts[1..]));
    }
    if rel_parts.is_empty() {
        return false;
    }
    matches_glob_segment(glob_head, rel_parts[0]) && match_glob_parts(glob_tail, &rel_parts[1..])
}

fn matches_glob_segment(glob: &str, value: &str) -> bool {
    if glob == "*" {
        return !value.is_empty();
    }
    if !glob.contains('*') {
        return glob == value;
    }
    matches_segment_parts(glob.split('*').collect::<Vec<_>>().as_slice(), value, glob)
}

fn matches_segment_parts(parts: &[&str], value: &str, glob: &str) -> bool {
    let mut remaining = value;
    let mut first = true;
    for part in parts {
        if part.is_empty() {
            first = false;
            continue;
        }
        if first && !glob.starts_with('*') {
            let Some(next) = remaining.strip_prefix(part) else {
                return false;
            };
            remaining = next;
        } else if let Some(index) = remaining.find(part) {
            remaining = &remaining[(index + part.len())..];
        } else {
            return false;
        }
        first = false;
    }
    glob.ends_with('*') || remaining.is_empty()
}

fn normalized_root(root: &Path) -> String {
    normalized_path(root).trim_end_matches('/').to_string()
}

fn normalized_path(path: &Path) -> String {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("/"))
            .join(path)
    };
    let mut out = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::Prefix(prefix) => out.push(prefix.as_os_str()),
            Component::RootDir => out.push(component.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            Component::Normal(part) => out.push(part),
        }
    }
    normalize_slashes(&out)
}

fn normalize_slashes(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn source_relative_path(root: &Path, file_path: &Path) -> String {
    safe_relative_path(root, file_path).unwrap_or_else(|| normalize_slashes(file_path))
}

fn parent_path(external_id: &str) -> Option<String> {
    external_id.rsplit_once('/').and_then(|(parent, _)| {
        let parent = parent.trim_matches('/');
        (!parent.is_empty()).then(|| parent.to_string())
    })
}

fn codex_source_meta(
    source: &NativeMemorySource,
    file_path: &Path,
    content: &str,
) -> Option<JsonValue> {
    if source.harness != "codex" {
        return None;
    }
    let rel = source_relative_path(&source.root, file_path);
    let normalized = content.replace("\r\n", "\n").replace('\r', "\n");
    let normalized = normalized.strip_suffix('\n').unwrap_or(&normalized);
    let line_count = if normalized.is_empty() {
        0
    } else {
        normalized.split('\n').count()
    };
    let mut meta = json!({
        "sourceType": "codex_native_memory",
        "provider": "codex",
        "displayName": source.display_name,
        "relativePath": rel,
        "lineStart": if line_count > 0 { 1 } else { 0 },
        "lineEnd": line_count,
    });
    if let Some(rollout_id) = find_uuid(content)
        && let Some(object) = meta.as_object_mut()
    {
        object.insert("rolloutId".to_string(), JsonValue::String(rollout_id));
    }
    Some(meta)
}

fn find_uuid(content: &str) -> Option<String> {
    for start in content
        .char_indices()
        .filter_map(|(index, ch)| ch.is_ascii_hexdigit().then_some(index))
    {
        let candidate = content.get(start..start + 36);
        if let Some(candidate) = candidate
            && is_uuid(candidate)
        {
            return Some(candidate.to_string());
        }
    }
    None
}

fn is_uuid(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    for (index, byte) in bytes.iter().enumerate() {
        if matches!(index, 8 | 13 | 18 | 23) {
            if *byte != b'-' {
                return false;
            }
        } else if !byte.is_ascii_hexdigit() {
            return false;
        }
    }
    true
}

fn native_artifact_content_hash(
    conn: &Connection,
    source_path: &str,
    agent_id: &str,
) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT source_sha256 FROM memory_artifacts
         WHERE agent_id = ?1 AND source_path = ?2 AND COALESCE(is_deleted, 0) = 0
         LIMIT 1",
        params![agent_id, source_path],
        |row| row.get(0),
    )
    .optional()
    .map_err(|err| err.to_string())
}

fn index_external_memory_artifact(
    conn: &Connection,
    input: ExternalArtifactInput,
) -> Result<(), String> {
    let agent_id = if input.agent_id.trim().is_empty() {
        "default".to_string()
    } else {
        input.agent_id.trim().to_string()
    };
    let content_hash = hash_normalized_body(&input.content);
    let captured_at = iso_from_mtime_ms(input.source_mtime_ms);
    let updated_at = Utc::now().to_rfc3339();
    let session_id = format!("native:{}:{}", input.harness, input.source_path);
    let session_key = format!("native:{}", input.harness);
    let session_token = derive_native_session_token(&agent_id, &session_id);
    let basename = input
        .source_path
        .rsplit('/')
        .next()
        .unwrap_or(input.source_path.as_str());
    let memory_sentence = format!("Indexed {} native memory from {}.", input.harness, basename);
    let source_meta_json = input.source_meta.map(|value| value.to_string());

    conn.execute(
        "INSERT INTO memory_artifacts (
            agent_id, source_path, source_sha256, source_kind, session_id,
            session_key, session_token, project, harness, captured_at,
            started_at, ended_at, manifest_path, source_node_id,
            memory_sentence, memory_sentence_quality, content, updated_at,
            source_mtime_ms, source_id, source_root, source_external_id,
            source_parent_path, source_meta_json, is_deleted, deleted_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, ?8, ?9, ?9, ?9, NULL, ?10,
                   ?11, 'fallback', ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, 0, NULL)
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
            updated_at = excluded.updated_at,
            source_mtime_ms = excluded.source_mtime_ms,
            source_id = excluded.source_id,
            source_root = excluded.source_root,
            source_external_id = excluded.source_external_id,
            source_parent_path = excluded.source_parent_path,
            source_meta_json = excluded.source_meta_json,
            is_deleted = 0,
            deleted_at = NULL",
        params![
            agent_id,
            input.source_path,
            content_hash,
            input.source_kind,
            session_id,
            session_key,
            session_token,
            input.harness,
            captured_at,
            NATIVE_MEMORY_BRIDGE_SOURCE_NODE_ID,
            memory_sentence,
            normalize_markdown_body(&input.content),
            updated_at,
            input.source_mtime_ms,
            input.source_id,
            input.source_root,
            input.source_external_id,
            input.source_parent_path,
            source_meta_json,
        ],
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}

fn iso_from_mtime_ms(mtime_ms: f64) -> String {
    let millis = if mtime_ms.is_finite() {
        mtime_ms.trunc() as i64
    } else {
        Utc::now().timestamp_millis()
    };
    Utc.timestamp_millis_opt(millis)
        .single()
        .unwrap_or_else(Utc::now)
        .to_rfc3339()
}

fn derive_native_session_token(agent_id: &str, session_id: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(format!("{}:{}", agent_id, session_id.trim()).as_bytes());
    base32_lower(&hasher.finalize()).chars().take(16).collect()
}

fn base32_lower(bytes: &[u8]) -> String {
    const BASE32: &[u8; 32] = b"abcdefghijklmnopqrstuvwxyz234567";
    let mut bits = 0u32;
    let mut value = 0u32;
    let mut out = String::new();
    for byte in bytes {
        value = (value << 8) | u32::from(*byte);
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

fn soft_delete_artifact_rows_for_path(
    conn: &Connection,
    source_path: &str,
    agent_id: &str,
) -> Result<usize, String> {
    let deleted_at = Utc::now().to_rfc3339();
    let changed = conn
        .execute(
            "UPDATE memory_artifacts
             SET is_deleted = 1, deleted_at = ?1, updated_at = ?1
             WHERE source_path = ?2 AND agent_id = ?3 AND COALESCE(is_deleted, 0) = 0",
            params![deleted_at, source_path, agent_id],
        )
        .map_err(|err| err.to_string())?;
    Ok(changed)
}

#[derive(Debug, Clone)]
struct ArtifactPathRow {
    agent_id: String,
    source_path: String,
    source_kind: String,
}

fn active_native_artifact_paths(
    conn: &Connection,
    source: &NativeMemorySource,
    agent_id: &str,
) -> Result<Vec<String>, String> {
    let root_prefix = format!("{}/", normalized_root(&source.root));
    let root_upper = prefix_upper_bound(&root_prefix);
    Ok(
        select_matching_artifact_paths(conn, source, Some(agent_id), &root_prefix, &root_upper)?
            .into_iter()
            .filter(|row| {
                source
                    .files
                    .iter()
                    .any(|pattern| pattern.kind == row.source_kind)
            })
            .map(|row| row.source_path)
            .collect(),
    )
}

fn select_matching_artifact_paths(
    conn: &Connection,
    source: &NativeMemorySource,
    agent_id: Option<&str>,
    root_prefix: &str,
    root_upper: &str,
) -> Result<Vec<ArtifactPathRow>, String> {
    let source_id = source.source_id.as_deref().unwrap_or("");
    let query = if agent_id.is_some() {
        "SELECT agent_id, source_path, source_kind FROM memory_artifacts
         WHERE agent_id = ?1
           AND harness = ?2
           AND (source_id = ?3 OR (source_id IS NULL AND source_path >= ?4 AND source_path < ?5))
           AND COALESCE(is_deleted, 0) = 0"
    } else {
        "SELECT agent_id, source_path, source_kind FROM memory_artifacts
         WHERE harness = ?1
           AND (source_id = ?2 OR (source_id IS NULL AND source_path >= ?3 AND source_path < ?4))
           AND COALESCE(is_deleted, 0) = 0"
    };
    let mut stmt = conn.prepare(query).map_err(|err| err.to_string())?;
    let rows = if let Some(agent_id) = agent_id {
        stmt.query_map(
            params![agent_id, source.harness, source_id, root_prefix, root_upper],
            |row| {
                Ok(ArtifactPathRow {
                    agent_id: row.get(0)?,
                    source_path: row.get(1)?,
                    source_kind: row.get(2)?,
                })
            },
        )
        .map_err(|err| err.to_string())?
        .collect::<Result<Vec<_>, _>>()
    } else {
        stmt.query_map(
            params![source.harness, source_id, root_prefix, root_upper],
            |row| {
                Ok(ArtifactPathRow {
                    agent_id: row.get(0)?,
                    source_path: row.get(1)?,
                    source_kind: row.get(2)?,
                })
            },
        )
        .map_err(|err| err.to_string())?
        .collect::<Result<Vec<_>, _>>()
    }
    .map_err(|err| err.to_string())?;
    Ok(rows)
}

fn source_kind_set(source: &NativeMemorySource) -> HashSet<&str> {
    source
        .files
        .iter()
        .map(|pattern| pattern.kind.as_str())
        .collect()
}

fn prefix_upper_bound(prefix: &str) -> String {
    format!("{prefix}\u{ffff}")
}

fn walk_native_memory_files(root: &Path) -> Result<Vec<PathBuf>, String> {
    if !root.exists() {
        return Ok(Vec::new());
    }
    let mut files = Vec::new();
    walk_native_memory_files_inner(root, &mut files)?;
    files.sort();
    Ok(files)
}

fn walk_native_memory_files_inner(dir: &Path, files: &mut Vec<PathBuf>) -> Result<(), String> {
    let mut entries = fs::read_dir(dir)
        .map_err(|err| err.to_string())?
        .filter_map(Result::ok)
        .collect::<Vec<_>>();
    entries.sort_by_key(|entry| entry.path());
    for entry in entries {
        if entry.file_name() == ".git" {
            continue;
        }
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_dir() {
            walk_native_memory_files_inner(&path, files)?;
        } else if file_type.is_file()
            && path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.ends_with(".md") || name.ends_with(".jsonl"))
        {
            files.push(path);
        }
    }
    Ok(())
}

fn hex_lower(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}
