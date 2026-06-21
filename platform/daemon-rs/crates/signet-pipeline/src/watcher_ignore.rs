//! Workspace watcher ignore matcher ported from `platform/daemon/src/watcher-ignore.ts`.

use crate::memory_ingest_filter::{is_artifact_filename, is_memory_backup_filename};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

const SIGNET_IGNORE_FILENAME: &str = ".sigignore";
const DEFAULT_SIGNIGNORE_CONTENT: &str = "# Signet watcher ignore — edit freely, changes take effect without restart.\n\n# Harness runtimes\nagents/*/.fly-*-home/\n";

#[derive(Debug, Clone)]
struct SigignorePattern {
    negated: bool,
    anchored: bool,
    has_slash: bool,
    glob: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum SigignoreStamp {
    Missing,
    Unreadable,
    Present {
        modified: Option<SystemTime>,
        len: u64,
    },
}

#[derive(Debug, Clone)]
struct SigignoreCache {
    stamp: SigignoreStamp,
    patterns: Vec<SigignorePattern>,
}

impl Default for SigignoreCache {
    fn default() -> Self {
        Self {
            stamp: SigignoreStamp::Missing,
            patterns: Vec::new(),
        }
    }
}

#[derive(Debug)]
struct SigignoreMatcher {
    workspace_root: PathBuf,
    sigignore_path: PathBuf,
    cache: Mutex<SigignoreCache>,
}

#[derive(Debug)]
pub struct AgentsWatcherIgnoreMatcher {
    agent_root: PathBuf,
    memories_db_paths: [PathBuf; 4],
    source_repo_root: PathBuf,
    memory_dir: PathBuf,
    workspace_config: SigignoreMatcher,
}

impl AgentsWatcherIgnoreMatcher {
    pub fn new(agents_dir: impl AsRef<Path>) -> Self {
        let agents_dir = resolve_for_comparison(agents_dir.as_ref());
        let sigignore_path = resolve_for_comparison(agents_dir.join(SIGNET_IGNORE_FILENAME));
        let matcher = Self {
            agent_root: resolve_for_comparison(agents_dir.join("agents")),
            memories_db_paths: [
                resolve_for_comparison(agents_dir.join("memory").join("memories.db")),
                resolve_for_comparison(agents_dir.join("memory").join("memories.db-wal")),
                resolve_for_comparison(agents_dir.join("memory").join("memories.db-shm")),
                resolve_for_comparison(agents_dir.join("memory").join("memories.db-journal")),
            ],
            source_repo_root: resolve_for_comparison(resolve_workspace_source_repo_path(
                &agents_dir,
            )),
            memory_dir: resolve_for_comparison(agents_dir.join("memory")),
            workspace_config: SigignoreMatcher::new(&agents_dir, &sigignore_path),
        };
        ensure_default_sigignore(&sigignore_path);
        matcher
    }

    pub fn should_ignore(&self, path: impl AsRef<Path>) -> bool {
        let normalized_path = resolve_for_comparison(path.as_ref());

        if relative_path_within(&self.source_repo_root, &normalized_path).is_some() {
            return true;
        }

        if matches!(relative_path_within(&self.memory_dir, &normalized_path), Some(rel) if !rel.as_os_str().is_empty())
        {
            if let Some(filename) = normalized_path.file_name().and_then(|name| name.to_str()) {
                if is_artifact_filename(filename) || is_memory_backup_filename(filename) {
                    return true;
                }
            }
        }

        let is_generated_workspace_path = relative_path_within(&self.agent_root, &normalized_path)
            .map(|relative| split_path_segments(&relative))
            .is_some_and(|segments| {
                segments.len() == 3 && segments[1] == "workspace" && segments[2] == "AGENTS.md"
            });

        is_generated_workspace_path
            || self
                .memories_db_paths
                .iter()
                .any(|ignored| ignored == &normalized_path)
            || self.workspace_config.matches(&normalized_path)
    }
}

pub fn create_agents_watcher_ignore_matcher(
    agents_dir: impl AsRef<Path>,
) -> AgentsWatcherIgnoreMatcher {
    AgentsWatcherIgnoreMatcher::new(agents_dir)
}

fn resolve_workspace_source_repo_path(workspace_dir: &Path) -> PathBuf {
    workspace_dir.join("signetai")
}

fn resolve_for_comparison(path: impl AsRef<Path>) -> PathBuf {
    let path = path.as_ref();
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(path)
    };
    normalize_lexically(&absolute)
}

fn normalize_lexically(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            Component::Normal(part) => normalized.push(part),
            Component::RootDir | Component::Prefix(_) => normalized.push(component.as_os_str()),
        }
    }
    normalized
}

fn relative_path_within(root: &Path, target: &Path) -> Option<PathBuf> {
    if target == root {
        return Some(PathBuf::new());
    }
    target.strip_prefix(root).ok().map(Path::to_path_buf)
}

fn normalize_relative_path(path: &Path) -> String {
    split_path_segments(path).join("/")
}

fn split_path_segments(path: &Path) -> Vec<String> {
    path.components()
        .filter_map(|component| match component {
            Component::Normal(part) => part.to_str().map(ToOwned::to_owned),
            _ => None,
        })
        .collect()
}

fn ensure_default_sigignore(sigignore_path: &Path) {
    if sigignore_path.exists() {
        return;
    }
    let _ = fs::write(sigignore_path, DEFAULT_SIGNIGNORE_CONTENT);
}

impl SigignoreMatcher {
    fn new(workspace_root: &Path, sigignore_path: &Path) -> Self {
        Self {
            workspace_root: workspace_root.to_path_buf(),
            sigignore_path: sigignore_path.to_path_buf(),
            cache: Mutex::new(SigignoreCache::default()),
        }
    }

    fn matches(&self, normalized_path: &Path) -> bool {
        if normalized_path == self.sigignore_path {
            return false;
        }
        let Some(relative_to_workspace) =
            relative_path_within(&self.workspace_root, normalized_path)
        else {
            return false;
        };
        if relative_to_workspace.as_os_str().is_empty() {
            return false;
        }
        let relative_path = normalize_relative_path(&relative_to_workspace);
        if relative_path == SIGNET_IGNORE_FILENAME {
            return false;
        }
        is_ignored_by_sigignore(&self.load_patterns(), &relative_path)
    }

    fn load_patterns(&self) -> Vec<SigignorePattern> {
        let metadata = match fs::metadata(&self.sigignore_path) {
            Ok(metadata) => metadata,
            Err(error) => {
                let stamp = if error.kind() == std::io::ErrorKind::NotFound {
                    SigignoreStamp::Missing
                } else {
                    SigignoreStamp::Unreadable
                };
                let mut cache = self.cache.lock().expect("sigignore cache lock poisoned");
                if cache.stamp != stamp {
                    *cache = SigignoreCache {
                        stamp,
                        patterns: Vec::new(),
                    };
                }
                return cache.patterns.clone();
            }
        };

        let stamp = SigignoreStamp::Present {
            modified: metadata.modified().ok(),
            len: metadata.len(),
        };
        let mut cache = self.cache.lock().expect("sigignore cache lock poisoned");
        if cache.stamp == stamp {
            return cache.patterns.clone();
        }

        match fs::read_to_string(&self.sigignore_path) {
            Ok(content) => {
                *cache = SigignoreCache {
                    stamp,
                    patterns: parse_sigignore(&content),
                };
            }
            Err(_) => {
                *cache = SigignoreCache {
                    stamp: SigignoreStamp::Unreadable,
                    patterns: Vec::new(),
                };
            }
        }
        cache.patterns.clone()
    }
}

fn parse_sigignore(content: &str) -> Vec<SigignorePattern> {
    content.lines().filter_map(parse_sigignore_line).collect()
}

fn parse_sigignore_line(raw_line: &str) -> Option<SigignorePattern> {
    let mut line = raw_line.trim().to_owned();
    if line.is_empty() || line.starts_with('#') {
        return None;
    }
    if line.starts_with("\\#") || line.starts_with("\\!") {
        line.remove(0);
    }

    let negated = line.starts_with('!');
    if negated {
        line = line[1..].trim().to_owned();
    }
    if line.is_empty() {
        return None;
    }

    line = line.replace('\\', "/");
    if let Some(stripped) = line.strip_prefix("./") {
        line = stripped.to_owned();
    }
    let anchored = line.starts_with('/');
    while line.starts_with('/') {
        line.remove(0);
    }
    while line.ends_with('/') {
        line.pop();
    }
    if line.is_empty() {
        return None;
    }

    Some(SigignorePattern {
        negated,
        anchored,
        has_slash: line.contains('/'),
        glob: line,
    })
}

fn pattern_matches(pattern: &SigignorePattern, relative_path: &str) -> bool {
    let segments: Vec<&str> = relative_path
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect();
    if segments.is_empty() {
        return false;
    }

    if !pattern.has_slash {
        return if pattern.anchored {
            glob_matches(&pattern.glob, segments[0])
        } else {
            segments
                .iter()
                .any(|segment| glob_matches(&pattern.glob, segment))
        };
    }

    (1..=segments.len()).any(|end| glob_matches(&pattern.glob, &segments[..end].join("/")))
}

fn is_ignored_by_sigignore(patterns: &[SigignorePattern], relative_path: &str) -> bool {
    let mut ignored = false;
    for pattern in patterns {
        if pattern_matches(pattern, relative_path) {
            ignored = !pattern.negated;
        }
    }
    ignored
}

fn glob_matches(pattern: &str, text: &str) -> bool {
    glob_matches_at(pattern.as_bytes(), 0, text.as_bytes(), 0)
}

fn glob_matches_at(pattern: &[u8], pattern_index: usize, text: &[u8], text_index: usize) -> bool {
    if pattern_index == pattern.len() {
        return text_index == text.len();
    }

    let current = pattern[pattern_index];
    if current == b'/'
        && pattern.get(pattern_index + 1) == Some(&b'*')
        && pattern.get(pattern_index + 2) == Some(&b'*')
        && pattern.get(pattern_index + 3) == Some(&b'/')
    {
        return slash_double_star_slash_matches(pattern, pattern_index + 4, text, text_index);
    }

    if current == b'*' {
        if pattern.get(pattern_index + 1) == Some(&b'*')
            && pattern.get(pattern_index + 2) == Some(&b'/')
        {
            if glob_matches_at(pattern, pattern_index + 3, text, text_index) {
                return true;
            }
            for index in text_index..text.len() {
                if text[index] == b'/'
                    && glob_matches_at(pattern, pattern_index + 3, text, index + 1)
                {
                    return true;
                }
            }
            return false;
        }
        if pattern.get(pattern_index + 1) == Some(&b'*') {
            for index in text_index..=text.len() {
                if glob_matches_at(pattern, pattern_index + 2, text, index) {
                    return true;
                }
            }
            return false;
        }
        let mut index = text_index;
        loop {
            if glob_matches_at(pattern, pattern_index + 1, text, index) {
                return true;
            }
            if index == text.len() || text[index] == b'/' {
                return false;
            }
            index += 1;
        }
    }

    if current == b'?' {
        return text.get(text_index).is_some_and(|char| *char != b'/')
            && glob_matches_at(pattern, pattern_index + 1, text, text_index + 1);
    }

    text.get(text_index) == Some(&current)
        && glob_matches_at(pattern, pattern_index + 1, text, text_index + 1)
}

fn slash_double_star_slash_matches(
    pattern: &[u8],
    next_pattern_index: usize,
    text: &[u8],
    text_index: usize,
) -> bool {
    for index in text_index..text.len() {
        if text[index] == b'/' && glob_matches_at(pattern, next_pattern_index, text, index + 1) {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    struct TempWorkspace {
        path: PathBuf,
    }

    impl TempWorkspace {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("signet-watcher-ignore-{}", Uuid::new_v4()));
            fs::create_dir_all(&path).expect("create temp workspace");
            Self { path }
        }

        fn join(&self, path: impl AsRef<Path>) -> PathBuf {
            self.path.join(path)
        }
    }

    impl Drop for TempWorkspace {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    #[test]
    fn ignores_daemon_database_and_journals_only() {
        // Covers platform/daemon/src/watcher-ignore.test.ts:25-37.
        let workspace = TempWorkspace::new();
        let should_ignore = AgentsWatcherIgnoreMatcher::new(&workspace.path);

        assert!(should_ignore.should_ignore(workspace.join("memory/memories.db")));
        assert!(should_ignore.should_ignore(workspace.join("memory/memories.db-wal")));
        assert!(should_ignore.should_ignore(workspace.join("memory/memories.db-shm")));
        assert!(should_ignore.should_ignore(workspace.join("memory/memories.db-journal")));
        assert!(!should_ignore.should_ignore(workspace.join("my-project/data.db")));
        assert!(!should_ignore.should_ignore(workspace.join("notes.db")));
    }

    #[test]
    fn ignores_generated_agent_workspace_agents_md_only() {
        // Covers platform/daemon/src/watcher-ignore.test.ts:39-49.
        let workspace = TempWorkspace::new();
        let should_ignore = AgentsWatcherIgnoreMatcher::new(&workspace.path);

        assert!(
            should_ignore.should_ignore(workspace.join("agents/claude-code/workspace/AGENTS.md"))
        );
        assert!(!should_ignore.should_ignore(
            workspace.join("agents/claude-code/workspace/nested-project/AGENTS.md")
        ));
        assert!(
            !should_ignore
                .should_ignore(workspace.join("agents-backup/claude-code/workspace/AGENTS.md"))
        );
        assert!(!should_ignore.should_ignore(workspace.join("agents/claude-code/SOUL.md")));
    }

    #[test]
    fn ignores_managed_source_checkout_and_default_fly_homes() {
        // Covers platform/daemon/src/watcher-ignore.test.ts:51-76.
        let workspace = TempWorkspace::new();
        let should_ignore = AgentsWatcherIgnoreMatcher::new(&workspace.path);
        let repo_root = workspace.join("signetai");

        assert!(should_ignore.should_ignore(&repo_root));
        assert!(should_ignore.should_ignore(repo_root.join("platform/core/src/index.ts")));
        assert!(!should_ignore.should_ignore(workspace.join("signetai-notes.md")));
        assert!(should_ignore.should_ignore(workspace.join("agents/kate/.fly-kate-home")));
        assert!(
            should_ignore
                .should_ignore(workspace.join("agents/kate/.fly-kate-home/.fly/fly-agent.sock"))
        );
        assert!(!should_ignore.should_ignore(workspace.join("agents/kate/TOOLS.md")));
        assert!(!should_ignore.should_ignore(workspace.join("agents/kate/MEMORY.md")));
        assert!(
            fs::read_to_string(workspace.join(SIGNET_IGNORE_FILENAME))
                .expect("default .sigignore")
                .contains("agents/*/.fly-*-home/")
        );
    }

    #[test]
    fn honors_workspace_sigignore_negation_reload_anchoring_and_double_star() {
        // Covers platform/daemon/src/watcher-ignore.test.ts:78-128.
        let workspace = TempWorkspace::new();
        fs::write(
            workspace.join(SIGNET_IGNORE_FILENAME),
            "# Runtime files managed outside Signet\nagents/*/runtime/\n*.sock\n!agents/*/keep.sock\n\n",
        )
        .expect("write .sigignore");
        let should_ignore = AgentsWatcherIgnoreMatcher::new(&workspace.path);

        assert!(should_ignore.should_ignore(workspace.join("agents/kate/runtime")));
        assert!(should_ignore.should_ignore(workspace.join("agents/kate/runtime/state.json")));
        assert!(should_ignore.should_ignore(workspace.join("agents/rose/runtime/state.json")));
        assert!(should_ignore.should_ignore(workspace.join("agents/rose/agent.sock")));
        assert!(!should_ignore.should_ignore(workspace.join("agents/rose/keep.sock")));
        assert!(!should_ignore.should_ignore(workspace.join(SIGNET_IGNORE_FILENAME)));

        fs::write(
            workspace.join(SIGNET_IGNORE_FILENAME),
            "agents/rose/runtime/\n",
        )
        .expect("rewrite .sigignore");
        assert!(should_ignore.should_ignore(workspace.join("agents/rose/runtime/state.json")));

        let workspace = TempWorkspace::new();
        fs::write(workspace.join(SIGNET_IGNORE_FILENAME), "/runtime/\n")
            .expect("write anchored .sigignore");
        let should_ignore = AgentsWatcherIgnoreMatcher::new(&workspace.path);
        assert!(should_ignore.should_ignore(workspace.join("runtime/state.json")));
        assert!(!should_ignore.should_ignore(workspace.join("agents/rose/runtime/state.json")));

        let workspace = TempWorkspace::new();
        fs::write(
            workspace.join(SIGNET_IGNORE_FILENAME),
            "**/*.sock\nfoo/**/bar\n",
        )
        .expect("write glob .sigignore");
        let should_ignore = AgentsWatcherIgnoreMatcher::new(&workspace.path);
        assert!(should_ignore.should_ignore(workspace.join("daemon.sock")));
        assert!(should_ignore.should_ignore(workspace.join("agents/rose/daemon.sock")));
        assert!(should_ignore.should_ignore(workspace.join("foo/bar")));
        assert!(should_ignore.should_ignore(workspace.join("foo/nested/bar")));
    }

    #[test]
    fn ignores_generated_memory_artifacts_only_inside_memory_dir() {
        // Covers platform/daemon/src/watcher-ignore.test.ts:130-173.
        let workspace = TempWorkspace::new();
        let should_ignore = AgentsWatcherIgnoreMatcher::new(&workspace.path);

        for filename in [
            "2026-04-10T12-00-00.000Z--abcdefghijklmnop--summary.md",
            "2026-04-10T12-00-00.000Z--abcdefghijklmnop--transcript.md",
            "2026-04-10T12-00-00.000Z--abcdefghijklmnop--manifest.md",
            "2026-04-10T12-00-00.000Z--abcdefghijklmnop--compaction.md",
            "MEMORY.backup-2026-04-10.md",
            "MEMORY.bak-2026-04-10T12-00-00.md",
            "MEMORY.pre-v1.2.3.md",
        ] {
            assert!(
                should_ignore.should_ignore(workspace.join("memory").join(filename)),
                "memory artifact {filename}"
            );
        }
        assert!(!should_ignore.should_ignore(workspace.join("memory/MEMORY.md")));
        assert!(!should_ignore.should_ignore(
            workspace.join("2026-04-10T12-00-00.000Z--abcdefghijklmnop--summary.md")
        ));
        assert!(!should_ignore.should_ignore(
            workspace.join("archive/2026-04-10T12-00-00.000Z--abcdefghijklmnop--transcript.md")
        ));
        assert!(!should_ignore.should_ignore(workspace.join("MEMORY.backup-2026-04-10.md")));
    }

    #[test]
    fn glob_slash_double_star_matches_zero_or_more_segments() {
        assert!(glob_matches("foo/**/bar", "foo/bar"));
        assert!(glob_matches("foo/**/bar", "foo/nested/bar"));
        assert!(glob_matches("**/*.sock", "daemon.sock"));
        assert!(glob_matches("**/*.sock", "agents/rose/daemon.sock"));
    }
}
