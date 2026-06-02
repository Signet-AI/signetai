use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use notify::{RecursiveMode, Watcher};
use sha2::{Digest, Sha256};
use signet_core::db::Priority;
use signet_services::transactions;
use tokio::sync::{mpsc, oneshot};
use tracing::{debug, error, info, warn};

use crate::state::AppState;

const SYNC_DEBOUNCE_MS: u64 = 2_000;
const COMMIT_DEBOUNCE_MS: u64 = 5_000;
const GIT_AUTOCOMMIT_TIMEOUT_MS: u64 = 30_000;
const MEMORY_IMPORT_POLL_MS: u64 = 30_000;
const CONFIG_FILES: [&str; 3] = ["agent.yaml", "AGENT.yaml", "config.yaml"];
const SYNC_TRIGGER_FILES: [&str; 8] = [
    "agent.yaml",
    "AGENT.yaml",
    "config.yaml",
    "AGENTS.md",
    "SOUL.md",
    "IDENTITY.md",
    "USER.md",
    "MEMORY.md",
];
const WATCHED_ROOT_FILES: [&str; 9] = [
    "agent.yaml",
    "AGENT.yaml",
    "config.yaml",
    "AGENTS.md",
    "SOUL.md",
    "IDENTITY.md",
    "USER.md",
    "MEMORY.md",
    "SIGNET-ARCHITECTURE.md",
];
const SIGNET_GIT_PROTECTED_PATHS: [&str; 5] = [
    "memory/memories.db",
    "memory/memories.db-wal",
    "memory/memories.db-shm",
    "memory/memories.db-journal",
    "signetai/",
];
const SIGNET_BLOCK_START: &str = "<!-- SIGNET:START -->";
const SIGNET_BLOCK_END: &str = "<!-- SIGNET:END -->";
const MEMORY_BACKUP_PREFIXES: [&str; 3] = ["MEMORY.backup-", "MEMORY.bak-", "MEMORY.pre-"];
const MEMORY_ARTIFACT_SUFFIXES: [&str; 4] = [
    "--summary.md",
    "--transcript.md",
    "--compaction.md",
    "--manifest.md",
];

pub(crate) struct FileWatcherHandle {
    shutdown: oneshot::Sender<()>,
    task: tokio::task::JoinHandle<()>,
    watcher: notify::RecommendedWatcher,
}

impl FileWatcherHandle {
    pub(crate) async fn stop(self) {
        let Self {
            shutdown,
            task,
            watcher,
        } = self;
        let _ = shutdown.send(());
        let _ = task.await;
        drop(watcher);
    }
}

pub(crate) async fn sync_harness_configs(base: &Path) -> std::io::Result<SyncSummary> {
    let mut summary = SyncSummary::default();
    sync_harness_configs_inner(base, &mut summary).await?;
    ensure_architecture_doc(base, &mut summary)?;
    Ok(summary)
}

pub(crate) fn start_file_watcher(state: Arc<AppState>) -> anyhow::Result<FileWatcherHandle> {
    let base = state.config.base_path.clone();
    let (event_tx, event_rx) = mpsc::unbounded_channel::<PathBuf>();
    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
    let mut watcher =
        notify::recommended_watcher(move |result: notify::Result<notify::Event>| match result {
            Ok(event) => {
                if matches!(event.kind, notify::EventKind::Access(_)) {
                    return;
                }
                for path in event.paths {
                    let _ = event_tx.send(path);
                }
            }
            Err(err) => warn!(error = %err, "file watcher event failed"),
        })?;

    watcher.watch(&base, RecursiveMode::NonRecursive)?;
    let agents_root = base.join("agents");
    if agents_root.exists() {
        watcher.watch(&agents_root, RecursiveMode::Recursive)?;
    }

    let task = tokio::spawn(file_watcher_loop(state, event_rx, shutdown_rx));
    Ok(FileWatcherHandle {
        shutdown: shutdown_tx,
        task,
        watcher,
    })
}

async fn file_watcher_loop(
    state: Arc<AppState>,
    mut event_rx: mpsc::UnboundedReceiver<PathBuf>,
    mut shutdown_rx: oneshot::Receiver<()>,
) {
    let base = state.config.base_path.clone();
    let mut pending = false;
    let mut pending_git_changes: Vec<PathBuf> = Vec::new();
    let mut observed_files = snapshot_watched_files(&base);
    let mut ingested_memory_files: HashMap<PathBuf, String> = HashMap::new();
    let mut reconcile_interval = tokio::time::interval(Duration::from_millis(SYNC_DEBOUNCE_MS));
    reconcile_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    reconcile_interval.tick().await;
    let mut memory_import_interval =
        tokio::time::interval(Duration::from_millis(memory_import_poll_ms()));
    memory_import_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut sleep = Box::pin(tokio::time::sleep(Duration::from_secs(24 * 60 * 60)));
    sleep
        .as_mut()
        .reset(tokio::time::Instant::now() + Duration::from_secs(24 * 60 * 60));
    let mut git_sleep = Box::pin(tokio::time::sleep(Duration::from_secs(24 * 60 * 60)));
    git_sleep
        .as_mut()
        .reset(tokio::time::Instant::now() + Duration::from_secs(24 * 60 * 60));

    loop {
        tokio::select! {
            _ = &mut shutdown_rx => break,
            Some(path) = event_rx.recv() => {
                info!(path = %path.display(), "file watcher observed workspace change");
                if is_config_file(&base, &path) {
                    reload_auth_runtime(&state, &path);
                }
                if is_auto_commit_trigger(&base, &path) && should_auto_commit(&state).await {
                    pending_git_changes.push(path.clone());
                    git_sleep
                        .as_mut()
                        .reset(tokio::time::Instant::now() + Duration::from_millis(COMMIT_DEBOUNCE_MS));
                }
                if is_sync_trigger(&base, &path) {
                    pending = true;
                    sleep
                        .as_mut()
                        .reset(tokio::time::Instant::now() + Duration::from_millis(SYNC_DEBOUNCE_MS));
                }
                if path.file_name().and_then(|name| name.to_str()) == Some("SIGNET-ARCHITECTURE.md") && !path.exists() {
                    pending = true;
                    sleep
                        .as_mut()
                        .reset(tokio::time::Instant::now() + Duration::from_millis(SYNC_DEBOUNCE_MS));
                }
            }
            _ = &mut sleep, if pending => {
                pending = false;
                run_workspace_sync(&base).await;
                sleep
                    .as_mut()
                    .reset(tokio::time::Instant::now() + Duration::from_secs(24 * 60 * 60));
            }
            _ = &mut git_sleep, if !pending_git_changes.is_empty() => {
                let changes = std::mem::take(&mut pending_git_changes);
                run_git_auto_commit(state.clone(), changes).await;
                git_sleep
                    .as_mut()
                    .reset(tokio::time::Instant::now() + Duration::from_secs(24 * 60 * 60));
            }
            _ = reconcile_interval.tick() => {
                let changed = diff_watched_files(&base, &mut observed_files);
                for path in changed.iter().filter(|path| is_config_file(&base, path)) {
                    reload_auth_runtime(&state, path);
                }
                if !changed.is_empty() && should_auto_commit(&state).await {
                    pending_git_changes.extend(changed);
                    git_sleep
                        .as_mut()
                        .reset(tokio::time::Instant::now() + Duration::from_millis(COMMIT_DEBOUNCE_MS));
                }
                run_workspace_sync(&base).await;
            }
            _ = memory_import_interval.tick() => {
                import_existing_memory_files(&state, &base, &mut ingested_memory_files).await;
            }
            else => break,
        }
    }
}

fn memory_import_poll_ms() -> u64 {
    std::env::var("SIGNET_MEMORY_IMPORT_POLL_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(MEMORY_IMPORT_POLL_MS)
}

async fn import_existing_memory_files(
    state: &AppState,
    base: &Path,
    ingested: &mut HashMap<PathBuf, String>,
) {
    if mutations_frozen(state) {
        debug!("legacy memory markdown import skipped because mutations are frozen");
        return;
    }

    let memory_dir = base.join("memory");
    let entries = match std::fs::read_dir(&memory_dir) {
        Ok(entries) => entries,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            debug!("memory directory does not exist, skipping initial import");
            return;
        }
        Err(err) => {
            error!(error = %err, "failed to read memory directory");
            return;
        }
    };

    let mut files = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| is_memory_import_candidate(&memory_dir, path))
        .collect::<Vec<_>>();
    files.sort();
    if files.is_empty() {
        debug!("legacy memory markdown import found no importable files");
        return;
    }

    let mut total = 0usize;
    for path in files {
        total += ingest_memory_markdown(state, &path, ingested).await;
    }
    if total > 0 {
        info!(
            chunks = total,
            "imported existing legacy memory markdown files"
        );
    }
}

fn mutations_frozen(state: &AppState) -> bool {
    state
        .config
        .manifest
        .memory
        .as_ref()
        .and_then(|memory| memory.pipeline_v2.as_ref())
        .map(|pipeline| pipeline.mutations_frozen)
        .unwrap_or(false)
}

fn is_memory_import_candidate(memory_dir: &Path, path: &Path) -> bool {
    if !path.starts_with(memory_dir) || !path.is_file() {
        return false;
    }
    if path.extension().and_then(|ext| ext.to_str()) != Some("md") {
        return false;
    }
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    name != "MEMORY.md" && !is_memory_backup_filename(name) && !is_memory_artifact_filename(name)
}

fn is_memory_backup_filename(name: &str) -> bool {
    MEMORY_BACKUP_PREFIXES
        .iter()
        .any(|prefix| name.starts_with(prefix) && name.ends_with(".md"))
}

fn is_memory_artifact_filename(name: &str) -> bool {
    MEMORY_ARTIFACT_SUFFIXES
        .iter()
        .any(|suffix| name.ends_with(suffix))
}

async fn ingest_memory_markdown(
    state: &AppState,
    path: &Path,
    ingested: &mut HashMap<PathBuf, String>,
) -> usize {
    if path.file_name().and_then(|name| name.to_str()) == Some("MEMORY.md") {
        return 0;
    }
    let content = match std::fs::read_to_string(path) {
        Ok(content) => content,
        Err(err) => {
            error!(
                path = %path.display(),
                error = %err,
                "failed to read legacy memory markdown file"
            );
            return 0;
        }
    };
    if content.trim().is_empty() {
        return 0;
    }

    let content_hash = sha256_hex_prefix(&content, 16);
    if ingested.get(path) == Some(&content_hash) {
        debug!(path = %path.display(), "legacy memory markdown file unchanged, skipping");
        return 0;
    }
    ingested.insert(path.to_path_buf(), content_hash);

    let filename = path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("memory");
    let date = filename.get(..10).filter(|value| is_iso_date_prefix(value));
    let plans = chunk_markdown_hierarchically(&content, 512)
        .into_iter()
        .filter_map(|chunk| {
            let body = if !chunk.header.is_empty() && chunk.text.starts_with(&chunk.header) {
                chunk.text[chunk.header.len()..].trim()
            } else {
                chunk.text.trim()
            };
            if body.len() < 80 {
                return None;
            }
            let chunk_key = format!("openclaw:{filename}:{}", sha256_hex_prefix(&chunk.text, 16));
            let level_tag = match chunk.level {
                MemoryMarkdownChunkLevel::Section => "hierarchical-section",
                MemoryMarkdownChunkLevel::Paragraph => "hierarchical-paragraph",
            };
            Some(MemoryImportPlan {
                content: chunk.text,
                importance: match chunk.level {
                    MemoryMarkdownChunkLevel::Section => 0.65,
                    MemoryMarkdownChunkLevel::Paragraph => 0.55,
                },
                source_id: chunk_key,
                tags: vec![
                    "openclaw".to_string(),
                    "memory-log".to_string(),
                    date.unwrap_or("named").to_string(),
                    filename.to_string(),
                    level_tag.to_string(),
                ],
            })
        })
        .collect::<Vec<_>>();

    if plans.is_empty() {
        return 0;
    }

    let result = state
        .pool
        .write_tx(Priority::High, move |conn| {
            let mut imported = 0usize;
            for plan in &plans {
                transactions::ingest(
                    conn,
                    &transactions::IngestInput {
                        content: &plan.content,
                        memory_type: "fact",
                        tags: plan.tags.clone(),
                        who: Some("openclaw-memory"),
                        why: None,
                        project: None,
                        importance: plan.importance,
                        pinned: false,
                        source_type: Some("openclaw-memory-log"),
                        source_id: Some(&plan.source_id),
                        source_path: None,
                        idempotency_key: Some(&plan.source_id),
                        runtime_path: None,
                        actor: "api",
                        agent_id: "default",
                        visibility: "global",
                        scope: None,
                    },
                )?;
                imported += 1;
            }
            Ok(serde_json::json!({ "imported": imported }))
        })
        .await;

    match result {
        Ok(value) => {
            let imported = value
                .get("imported")
                .and_then(serde_json::Value::as_u64)
                .and_then(|count| usize::try_from(count).ok())
                .unwrap_or(0);
            if imported > 0 {
                info!(
                    path = %path.display(),
                    chunks = imported,
                    filename,
                    "ingested legacy memory markdown file"
                );
            }
            imported
        }
        Err(err) => {
            error!(
                path = %path.display(),
                error = %err,
                "failed to ingest legacy memory markdown file"
            );
            0
        }
    }
}

#[derive(Clone)]
struct MemoryImportPlan {
    content: String,
    importance: f64,
    source_id: String,
    tags: Vec<String>,
}

#[derive(Clone, Copy)]
enum MemoryMarkdownChunkLevel {
    Section,
    Paragraph,
}

struct MemoryMarkdownChunk {
    text: String,
    header: String,
    level: MemoryMarkdownChunkLevel,
}

fn chunk_markdown_hierarchically(content: &str, max_tokens: usize) -> Vec<MemoryMarkdownChunk> {
    let mut chunks = Vec::new();
    let mut current_header = String::new();
    let mut current_content: Vec<String> = Vec::new();

    for line in content.split('\n') {
        if is_markdown_heading(line) {
            flush_memory_markdown_section(
                &mut chunks,
                &current_header,
                &current_content,
                max_tokens,
            );
            current_header = line.to_string();
            current_content.clear();
        } else {
            current_content.push(line.to_string());
        }
    }
    flush_memory_markdown_section(&mut chunks, &current_header, &current_content, max_tokens);

    if chunks.is_empty() && !content.trim().is_empty() {
        chunks.push(MemoryMarkdownChunk {
            text: content.trim().to_string(),
            header: String::new(),
            level: MemoryMarkdownChunkLevel::Section,
        });
    }
    chunks
}

fn flush_memory_markdown_section(
    chunks: &mut Vec<MemoryMarkdownChunk>,
    header: &str,
    content: &[String],
    max_tokens: usize,
) {
    if content.is_empty() {
        return;
    }
    let section = content.join("\n").trim().to_string();
    if section.is_empty() {
        return;
    }
    if estimate_tokens(&section) <= max_tokens {
        chunks.push(MemoryMarkdownChunk {
            text: if header.is_empty() {
                section
            } else {
                format!("{header}\n\n{section}")
            },
            header: header.to_string(),
            level: MemoryMarkdownChunkLevel::Section,
        });
        return;
    }

    let mut chunk_paragraphs: Vec<String> = Vec::new();
    let mut chunk_tokens = if header.is_empty() {
        0
    } else {
        estimate_tokens(header)
    };
    for paragraph in section.split("\n\n") {
        let paragraph = paragraph.trim();
        if paragraph.is_empty() {
            continue;
        }
        let paragraph_tokens = estimate_tokens(paragraph);
        if paragraph_tokens > max_tokens {
            flush_memory_markdown_paragraph_chunk(
                chunks,
                header,
                &mut chunk_paragraphs,
                &mut chunk_tokens,
            );
            chunks.push(MemoryMarkdownChunk {
                text: if header.is_empty() {
                    paragraph.to_string()
                } else {
                    format!("{header}\n\n{paragraph}")
                },
                header: header.to_string(),
                level: MemoryMarkdownChunkLevel::Paragraph,
            });
            continue;
        }
        if chunk_tokens + paragraph_tokens + 2 > max_tokens && !chunk_paragraphs.is_empty() {
            flush_memory_markdown_paragraph_chunk(
                chunks,
                header,
                &mut chunk_paragraphs,
                &mut chunk_tokens,
            );
        }
        chunk_paragraphs.push(paragraph.to_string());
        chunk_tokens += paragraph_tokens + 2;
    }
    flush_memory_markdown_paragraph_chunk(chunks, header, &mut chunk_paragraphs, &mut chunk_tokens);
}

fn flush_memory_markdown_paragraph_chunk(
    chunks: &mut Vec<MemoryMarkdownChunk>,
    header: &str,
    paragraphs: &mut Vec<String>,
    tokens: &mut usize,
) {
    if paragraphs.is_empty() {
        return;
    }
    chunks.push(MemoryMarkdownChunk {
        text: if header.is_empty() {
            paragraphs.join("\n\n")
        } else {
            format!("{header}\n\n{}", paragraphs.join("\n\n"))
        },
        header: header.to_string(),
        level: MemoryMarkdownChunkLevel::Paragraph,
    });
    paragraphs.clear();
    *tokens = if header.is_empty() {
        0
    } else {
        estimate_tokens(header)
    };
}

fn is_markdown_heading(line: &str) -> bool {
    let trimmed = line.trim_start();
    let hashes = trimmed.chars().take_while(|ch| *ch == '#').count();
    (1..=3).contains(&hashes) && trimmed.chars().nth(hashes).is_some_and(char::is_whitespace)
}

fn estimate_tokens(text: &str) -> usize {
    text.len().div_ceil(4)
}

fn is_iso_date_prefix(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes[..4].iter().all(u8::is_ascii_digit)
        && bytes[5..7].iter().all(u8::is_ascii_digit)
        && bytes[8..10].iter().all(u8::is_ascii_digit)
}

fn sha256_hex_prefix(value: &str, len: usize) -> String {
    let digest = Sha256::digest(value.as_bytes());
    digest
        .iter()
        .flat_map(|byte| {
            let hi = byte >> 4;
            let lo = byte & 0x0f;
            [hex_char(hi), hex_char(lo)]
        })
        .take(len)
        .collect()
}

fn hex_char(nibble: u8) -> char {
    match nibble {
        0..=9 => (b'0' + nibble) as char,
        _ => (b'a' + (nibble - 10)) as char,
    }
}

async fn should_auto_commit(state: &AppState) -> bool {
    state.git_config.read().await.auto_commit
}

async fn run_workspace_sync(base: &Path) {
    match sync_harness_configs(base).await {
        Ok(summary) => debug!(?summary, "workspace sync completed"),
        Err(err) => error!(error = %err, "workspace sync failed"),
    }
}

fn reload_auth_runtime(state: &AppState, path: &Path) {
    match state.reload_auth_runtime() {
        Ok(auth) => info!(
            path = %path.display(),
            mode = ?auth.mode,
            "file watcher reloaded auth runtime"
        ),
        Err(err) => error!(
            path = %path.display(),
            error = %err,
            "file watcher failed to reload auth runtime"
        ),
    }
}

fn is_config_file(base: &Path, path: &Path) -> bool {
    path.strip_prefix(base).ok().is_some_and(|relative| {
        relative
            .to_str()
            .is_some_and(|name| CONFIG_FILES.contains(&name))
    })
}

fn is_sync_trigger(base: &Path, path: &Path) -> bool {
    let filename = path.file_name().and_then(|name| name.to_str());
    if filename.is_some_and(|name| SYNC_TRIGGER_FILES.contains(&name)) {
        return true;
    }
    path.starts_with(base.join("agents"))
}

fn is_auto_commit_trigger(base: &Path, path: &Path) -> bool {
    let filename = path.file_name().and_then(|name| name.to_str());
    filename.is_some_and(|name| WATCHED_ROOT_FILES.contains(&name))
        || path.starts_with(base.join("agents"))
}

fn collect_watched_files(base: &Path, out: &mut BTreeMap<PathBuf, SystemTime>) {
    for name in WATCHED_ROOT_FILES {
        let path = base.join(name);
        if let Ok(metadata) = std::fs::metadata(&path)
            && metadata.is_file()
        {
            out.insert(path, metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH));
        }
    }
    collect_agent_files(&base.join("agents"), out);
}

fn collect_agent_files(path: &Path, out: &mut BTreeMap<PathBuf, SystemTime>) {
    let Ok(entries) = std::fs::read_dir(path) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if metadata.is_dir() {
            collect_agent_files(&path, out);
        } else if metadata.is_file() {
            out.insert(path, metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH));
        }
    }
}

fn snapshot_watched_files(base: &Path) -> BTreeMap<PathBuf, SystemTime> {
    let mut snapshot = BTreeMap::new();
    collect_watched_files(base, &mut snapshot);
    snapshot
}

fn diff_watched_files(base: &Path, previous: &mut BTreeMap<PathBuf, SystemTime>) -> Vec<PathBuf> {
    let current = snapshot_watched_files(base);
    let mut changed = Vec::new();
    for (path, modified) in &current {
        if previous.get(path) != Some(modified) {
            changed.push(path.clone());
        }
    }
    for path in previous.keys() {
        if !current.contains_key(path) {
            changed.push(path.clone());
        }
    }
    *previous = current;
    changed
}

#[derive(Debug)]
struct GitCommandResult {
    stdout: String,
    stderr: String,
    code: i32,
    timed_out: bool,
}

async fn run_git_command(base: &Path, args: &[String]) -> std::io::Result<GitCommandResult> {
    let output = tokio::time::timeout(
        Duration::from_millis(GIT_AUTOCOMMIT_TIMEOUT_MS),
        tokio::process::Command::new("git")
            .args(args)
            .current_dir(base)
            .output(),
    )
    .await;

    match output {
        Ok(Ok(output)) => Ok(GitCommandResult {
            stdout: String::from_utf8_lossy(&output.stdout).trim().to_string(),
            stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
            code: output.status.code().unwrap_or(1),
            timed_out: false,
        }),
        Ok(Err(err)) => Err(err),
        Err(_) => Ok(GitCommandResult {
            stdout: String::new(),
            stderr: format!("Command timed out after {GIT_AUTOCOMMIT_TIMEOUT_MS}ms"),
            code: 124,
            timed_out: true,
        }),
    }
}

fn git_result_message(operation: &str, result: &GitCommandResult) -> String {
    let detail = if result.stderr.is_empty() {
        result.stdout.as_str()
    } else {
        result.stderr.as_str()
    };
    if result.timed_out {
        format!("{operation} timed out: {detail}")
    } else if detail.is_empty() {
        format!("{operation} failed with code {}", result.code)
    } else {
        format!("{operation} failed with code {}: {detail}", result.code)
    }
}

fn is_git_repo(base: &Path) -> bool {
    base.join(".git").exists()
}

fn merge_signet_gitignore_entries(existing: &str) -> String {
    let normalized = existing.replace("\r\n", "\n");
    let mut lines = if normalized.is_empty() {
        Vec::new()
    } else {
        normalized
            .split('\n')
            .map(ToOwned::to_owned)
            .collect::<Vec<_>>()
    };
    if lines.last().is_some_and(|line| line.is_empty()) {
        lines.pop();
    }

    let existing_entries = lines
        .iter()
        .filter(|line| !line.trim().is_empty())
        .map(String::as_str)
        .collect::<std::collections::HashSet<_>>();
    let missing = SIGNET_GIT_PROTECTED_PATHS
        .iter()
        .filter(|entry| !existing_entries.contains(**entry))
        .copied()
        .collect::<Vec<_>>();
    if missing.is_empty() {
        return existing.to_string();
    }

    if !lines.is_empty() {
        lines.push(String::new());
    }
    lines.push("# Signet generated data".to_string());
    lines.extend(missing.into_iter().map(ToOwned::to_owned));
    format!("{}\n", lines.join("\n"))
}

fn ensure_protected_gitignore(base: &Path) -> std::io::Result<()> {
    let path = base.join(".gitignore");
    let existing = std::fs::read_to_string(&path).unwrap_or_default();
    let next = merge_signet_gitignore_entries(&existing);
    if next != existing {
        std::fs::write(path, next)?;
    }
    Ok(())
}

async fn git_untrack_protected_files(base: &Path) {
    let mut args = vec![
        "rm".to_string(),
        "--cached".to_string(),
        "--ignore-unmatch".to_string(),
        "--quiet".to_string(),
        "--".to_string(),
    ];
    args.extend(
        SIGNET_GIT_PROTECTED_PATHS
            .iter()
            .map(|path| path.to_string()),
    );
    if let Ok(result) = run_git_command(base, &args).await
        && result.code != 0
    {
        warn!(
            error = %git_result_message("Auto-commit protected untrack", &result),
            "git auto-commit protected untrack failed"
        );
    }
}

fn canonical_path_for_containment(path: &Path) -> PathBuf {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(path)
    };
    if let Ok(canonical) = std::fs::canonicalize(&absolute) {
        return canonical;
    }
    if let (Some(parent), Some(name)) = (absolute.parent(), absolute.file_name())
        && let Ok(parent) = std::fs::canonicalize(parent)
    {
        return parent.join(name);
    }
    absolute
}

fn to_relative_git_path(base: &Path, path: &Path) -> Option<String> {
    let canonical_base = canonical_path_for_containment(base);
    let candidate = if path.is_absolute() {
        path.to_path_buf()
    } else {
        base.join(path)
    };
    let canonical_candidate = canonical_path_for_containment(&candidate);
    let relative = canonical_candidate.strip_prefix(&canonical_base).ok()?;
    if relative.as_os_str().is_empty() {
        return None;
    }
    Some(relative.to_string_lossy().replace('\\', "/"))
}

async fn run_git_auto_commit(state: Arc<AppState>, changed_files: Vec<PathBuf>) {
    let base = state.config.base_path.clone();
    if !is_git_repo(&base) {
        return;
    }
    if let Err(err) = ensure_protected_gitignore(&base) {
        warn!(error = %err, "git auto-commit failed to update protected gitignore entries");
    }
    git_untrack_protected_files(&base).await;

    let relative_files = changed_files
        .iter()
        .filter_map(|path| to_relative_git_path(&base, path))
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    let dropped = changed_files.len().saturating_sub(relative_files.len());
    if dropped > 0 {
        warn!(
            dropped,
            "dropped git auto-commit paths outside the git workspace"
        );
    }
    if relative_files.is_empty() {
        return;
    }

    let mut add_args = vec!["add".to_string(), "--".to_string()];
    add_args.extend(relative_files.iter().cloned());
    match run_git_command(&base, &add_args).await {
        Ok(result) if result.code == 0 => {}
        Ok(result) => {
            warn!(
                error = %git_result_message("Auto-commit add", &result),
                "git auto-commit add failed"
            );
            return;
        }
        Err(err) => {
            warn!(error = %err, "git auto-commit add failed");
            return;
        }
    }

    let mut status_args = vec![
        "status".to_string(),
        "--porcelain".to_string(),
        "--".to_string(),
    ];
    status_args.extend(relative_files.iter().cloned());
    let status = match run_git_command(&base, &status_args).await {
        Ok(result) if result.code == 0 => result,
        Ok(result) => {
            warn!(
                error = %git_result_message("Auto-commit status", &result),
                "git auto-commit status failed"
            );
            return;
        }
        Err(err) => {
            warn!(error = %err, "git auto-commit status failed");
            return;
        }
    };
    if status.stdout.trim().is_empty() {
        return;
    }

    let file_list = relative_files.join(", ");
    let timestamp = chrono::Utc::now().format("%Y-%m-%dT%H-%M-%S");
    let preview = file_list.chars().take(50).collect::<String>();
    let message = format!("{timestamp}_auto_{preview}");
    let mut commit_args = vec![
        "commit".to_string(),
        "-m".to_string(),
        message.clone(),
        "--".to_string(),
    ];
    commit_args.extend(relative_files.iter().cloned());
    match run_git_command(&base, &commit_args).await {
        Ok(result) if result.code == 0 => {
            info!(
                message,
                file_count = relative_files.len(),
                "git auto-commit completed"
            );
        }
        Ok(result) => {
            warn!(
                error = %git_result_message("Auto-commit", &result),
                "git auto-commit failed"
            );
        }
        Err(err) => warn!(error = %err, "git auto-commit failed"),
    }
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub(crate) struct SyncSummary {
    pub opencode_written: bool,
    pub agent_workspaces_written: usize,
    pub architecture_written: bool,
}

async fn sync_harness_configs_inner(base: &Path, summary: &mut SyncSummary) -> std::io::Result<()> {
    let agents_md_path = base.join("AGENTS.md");
    let raw = match std::fs::read_to_string(&agents_md_path) {
        Ok(raw) => raw,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(err) => return Err(err),
    };
    let content = strip_signet_block(&raw);
    let identity_extras = compose_identity_sections(
        &["SOUL.md", "IDENTITY.md", "USER.md", "MEMORY.md"].map(|name| base.join(name)),
    );
    let composed = format!("{content}{identity_extras}");
    let active_harnesses = load_configured_harnesses(base);

    if active_harnesses.iter().any(|harness| harness == "opencode") {
        let opencode_dir = home_dir().join(".config").join("opencode");
        if opencode_dir.exists() {
            let target = opencode_dir.join("AGENTS.md");
            summary.opencode_written =
                write_file_if_changed(&target, &(build_header(base, "AGENTS.md") + &composed))?;
        }
    }

    summary.agent_workspaces_written = sync_agent_workspaces(base, &content)?;
    Ok(())
}

fn sync_agent_workspaces(base: &Path, root_agents_md: &str) -> std::io::Result<usize> {
    let agents_root = base.join("agents");
    if !agents_root.exists() {
        return Ok(0);
    }

    let shared_identity =
        compose_identity_sections(&[base.join("USER.md"), base.join("MEMORY.md")]);
    let mut written = 0;
    for entry in std::fs::read_dir(agents_root)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let agent_dir = entry.path();
        let workspace_dir = agent_dir.join("workspace");
        let soul_path = if agent_dir.join("SOUL.md").exists() {
            agent_dir.join("SOUL.md")
        } else {
            base.join("SOUL.md")
        };
        let identity_path = if agent_dir.join("IDENTITY.md").exists() {
            agent_dir.join("IDENTITY.md")
        } else {
            base.join("IDENTITY.md")
        };
        let agent_identity = compose_identity_sections(&[soul_path, identity_path]);
        let composed = format!("{root_agents_md}{agent_identity}{shared_identity}");
        std::fs::create_dir_all(&workspace_dir)?;
        if write_file_if_changed(&workspace_dir.join("AGENTS.md"), &composed)? {
            written += 1;
        }
    }
    Ok(written)
}

fn ensure_architecture_doc(base: &Path, summary: &mut SyncSummary) -> std::io::Result<()> {
    summary.architecture_written = write_file_if_changed(
        &base.join("SIGNET-ARCHITECTURE.md"),
        &build_architecture_doc(&base.to_string_lossy()),
    )?;
    Ok(())
}

fn write_file_if_changed(path: &Path, content: &str) -> std::io::Result<bool> {
    if let Ok(existing) = std::fs::read_to_string(path)
        && existing == content
    {
        return Ok(false);
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, content)?;
    Ok(true)
}

fn compose_identity_sections<const N: usize>(paths: &[PathBuf; N]) -> String {
    paths
        .iter()
        .filter_map(|path| {
            let content = std::fs::read_to_string(path).ok()?;
            let trimmed = content.trim();
            if trimmed.is_empty() {
                return None;
            }
            let filename = path.file_stem()?.to_str()?;
            Some(format!("\n## {filename}\n\n{trimmed}"))
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn load_configured_harnesses(base: &Path) -> Vec<String> {
    for name in CONFIG_FILES {
        let path = base.join(name);
        let Ok(content) = std::fs::read_to_string(path) else {
            continue;
        };
        let Ok(value) = serde_yml::from_str::<serde_yml::Value>(&content) else {
            return Vec::new();
        };
        let Some(harnesses) = value
            .as_mapping()
            .and_then(|map| map.get(serde_yml::Value::String("harnesses".to_string())))
        else {
            return Vec::new();
        };
        return parse_harness_list(harnesses);
    }
    Vec::new()
}

fn parse_harness_list(value: &serde_yml::Value) -> Vec<String> {
    if let Some(items) = value.as_sequence() {
        return items
            .iter()
            .filter_map(|item| item.as_str())
            .map(str::trim)
            .filter(|item| !item.is_empty())
            .map(ToOwned::to_owned)
            .collect();
    }
    if let Some(raw) = value.as_str() {
        return raw
            .split(',')
            .map(str::trim)
            .filter(|item| !item.is_empty())
            .map(ToOwned::to_owned)
            .collect();
    }
    Vec::new()
}

fn strip_signet_block(content: &str) -> String {
    let mut out = content.to_string();
    while let Some(start) = out.find(SIGNET_BLOCK_START) {
        let Some(end_rel) = out[start..].find(SIGNET_BLOCK_END) else {
            break;
        };
        let mut end = start + end_rel + SIGNET_BLOCK_END.len();
        if out[end..].starts_with("\r\n") {
            end += 2;
        } else if out[end..].starts_with('\n') {
            end += 1;
        }
        out.replace_range(start..end, "");
    }
    out
}

fn build_header(base: &Path, target_name: &str) -> String {
    let agents_md_path = base.join("AGENTS.md");
    let files = [
        ("SOUL.md", "Personality & tone"),
        ("IDENTITY.md", "Agent identity"),
        ("USER.md", "User profile & preferences"),
        ("MEMORY.md", "Working memory context"),
        ("agent.yaml", "Configuration & settings"),
    ];
    let file_list = files
        .iter()
        .filter_map(|(name, desc)| {
            let path = base.join(name);
            path.exists()
                .then(|| format!("#   - {} ({desc})", sanitize_path(&path)))
        })
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        "# {target_name}\n# ============================================================================\n# AUTO-GENERATED from {} by Signet\n# Generated: {}\n#\n# DO NOT EDIT THIS FILE - changes will be overwritten\n# Edit the source file instead: {}\n#\n# Signet Agent Home: {}\n# Dashboard: http://localhost:3850\n# CLI: signet --help\n#\n# Related documents:\n{file_list}\n#\n# Memory commands: /remember <content> | /recall <query>\n# ============================================================================\n\n",
        sanitize_path(&agents_md_path),
        chrono::Utc::now().to_rfc3339(),
        sanitize_path(&agents_md_path),
        sanitize_path(base),
    )
}

fn sanitize_path(path: &Path) -> String {
    path.to_string_lossy().replace(['\n', '\r'], "")
}

fn home_dir() -> PathBuf {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."))
}

fn build_architecture_doc(workspace: &str) -> String {
    let root = normalize_workspace(workspace);
    format!(
        r#"# How Signet Works (for the agent reading this)

You are operating inside a system you cannot fully observe. The markdown
files in your context are prompt surfaces over deeper runtime state. Do
not make architectural claims based solely on what appears in your
context window - you are seeing rendered summaries and projections, not
the entire system.

## What happens on every session

### Session start
When your session begins, Signet fires a hook that:
1. Loads your identity files (AGENTS.md, SOUL.md, IDENTITY.md, USER.md)
2. Loads your rendered working-memory head (MEMORY.md)
3. Injects relevant context for continuity before generation starts
4. Preserves agent and session scoping on the state it loads

### Every user message
On each prompt from the user, Signet:
1. May retrieve context through hybrid recall before generation
2. Prefers structured distillation surfaces when available
3. Can also use thread heads and temporal summaries
4. Falls back to transcript retrieval when structured state has not
   caught up yet or transcript-specific lookup is needed

Prompt-time context is layered. `MEMORY.md` is only one visible surface.
Not every important state appears directly inside it.

### Session end
When the session closes, Signet:
1. Persists transcript and session state with agent and session scoping
2. Produces temporal artifacts such as summaries, and compaction artifacts
   when the harness supports them
3. Distills durable structure into deeper memory state
4. Refreshes rendered working-memory surfaces from that state

You never see this happen - it runs after you're gone.

## Your role in the memory system

Auto-capture handles most episodic and operational memory work. Your job
is to actively maintain the durable identity substrate:

- `{root}/AGENTS.md`
- `{root}/SOUL.md`
- `{root}/IDENTITY.md`
- `{root}/USER.md`

Update those files when you learn stable truths about how you operate,
who you are, who the user is, or how you should relate to the world.

Use `signet remember` (or `/remember`) for exceptionally important
things the system might otherwise underweight or miss. Use
`signet recall` (or `/recall`) when you need specific context that
was not automatically surfaced.

## Identity files are your durable substrate

You should maintain:

- `{root}/AGENTS.md`
- `{root}/SOUL.md`
- `{root}/IDENTITY.md`
- `{root}/USER.md`

Use them for durable truths about how you operate, who you are, who the
user is, and how you should relate to the world. Prefer additive,
intentional refinements over full rewrites unless the user asks for a
deeper identity change.

Do not edit `{root}/MEMORY.md` manually. It is a derived operational
summary and rendered temporal head regenerated by Signet from the memory
system.

## When users ask about your memory

You can explain truthfully:

"I have a persistent memory and identity system called Signet. It keeps
durable identity files, renders a working-memory head for continuity,
and can surface deeper context through hybrid retrieval across
structured memory, temporal summaries, and transcript fallback when
needed."

Do not speculate about implementation details beyond what's described
here. If pressed for specifics, suggest the user check the Signet
dashboard at http://localhost:3850.
"#
    )
}

fn normalize_workspace(workspace: &str) -> String {
    let root = workspace.trim().replace(['`', '\n', '\r'], "");
    if root.is_empty() {
        "$SIGNET_WORKSPACE".to_string()
    } else {
        root.trim_end_matches('/').to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_signet_block_removes_multiple_blocks() {
        let input = format!(
            "a\n{SIGNET_BLOCK_START}\nb\n{SIGNET_BLOCK_END}\nc\n{SIGNET_BLOCK_START}\nd\n{SIGNET_BLOCK_END}\ne"
        );
        assert_eq!(strip_signet_block(&input), "a\nc\ne");
    }

    #[test]
    fn parse_harness_list_normalizes_array_and_comma_string() {
        let array = serde_yml::from_str::<serde_yml::Value>("[pi, ' codex ', '', 42]").unwrap();
        assert_eq!(parse_harness_list(&array), vec!["pi", "codex"]);
        let string = serde_yml::Value::String("pi, codex,,opencode".to_string());
        assert_eq!(parse_harness_list(&string), vec!["pi", "codex", "opencode"]);
    }

    #[tokio::test]
    async fn sync_agent_workspaces_writes_overrides_and_shared_identity() {
        let tmp = tempfile::tempdir().unwrap();
        let base = tmp.path();
        std::fs::create_dir_all(base.join("agents/writer/workspace")).unwrap();
        std::fs::write(base.join("AGENTS.md"), "# Root Agent\n").unwrap();
        std::fs::write(base.join("SOUL.md"), "root soul").unwrap();
        std::fs::write(base.join("IDENTITY.md"), "root identity").unwrap();
        std::fs::write(base.join("USER.md"), "root user").unwrap();
        std::fs::write(base.join("MEMORY.md"), "root memory").unwrap();
        std::fs::write(base.join("agents/writer/SOUL.md"), "agent soul").unwrap();

        let summary = sync_harness_configs(base).await.unwrap();
        assert_eq!(summary.agent_workspaces_written, 1);
        assert!(summary.architecture_written);

        let output =
            std::fs::read_to_string(base.join("agents/writer/workspace/AGENTS.md")).unwrap();
        assert!(output.contains("# Root Agent"));
        assert!(output.contains("## SOUL\n\nagent soul"));
        assert!(output.contains("## IDENTITY\n\nroot identity"));
        assert!(output.contains("## USER\n\nroot user"));
        assert!(output.contains("## MEMORY\n\nroot memory"));
        assert!(
            std::fs::read_to_string(base.join("SIGNET-ARCHITECTURE.md"))
                .unwrap()
                .contains("Do not edit")
        );
    }
}
