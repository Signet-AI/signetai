use serde::{Deserialize, Serialize};
use std::path::{Component, Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PolicyBlockReason {
    CommandNotAllowlisted,
    CommandHasShellOperators,
    CommandEmpty,
    PathOutsideWorkspace,
    PathOutsideAllowlist,
}

impl PolicyBlockReason {
    pub const fn code(self) -> &'static str {
        match self {
            Self::CommandNotAllowlisted => "command_not_allowlisted",
            Self::CommandHasShellOperators => "shell_operators_disallowed",
            Self::CommandEmpty => "empty_command",
            Self::PathOutsideWorkspace => "outside_workspace",
            Self::PathOutsideAllowlist => "outside_allowed_paths",
        }
    }
}

pub fn classify_command_block_reason(
    command: &str,
    allowed_commands: &[String],
) -> Option<PolicyBlockReason> {
    if allowed_commands.is_empty() {
        return None;
    }
    let cmd = command.trim();
    if cmd.is_empty() {
        return Some(PolicyBlockReason::CommandEmpty);
    }
    if cmd
        .chars()
        .any(|c| matches!(c, ';' | '|' | '&' | '\n' | '\r' | '<' | '>' | '$' | '`'))
    {
        return Some(PolicyBlockReason::CommandHasShellOperators);
    }
    let cmd_lower = cmd.to_lowercase();
    let first = cmd_lower.split_whitespace().next().unwrap_or_default();
    let ok = allowed_commands.iter().any(|allowed| {
        let a = allowed.trim().to_lowercase();
        !a.is_empty()
            && (first == a
                || cmd_lower == a
                || cmd_lower.starts_with(&format!("{a} "))
                || cmd_lower.starts_with(&format!("{a}/")))
    });
    if ok {
        None
    } else {
        Some(PolicyBlockReason::CommandNotAllowlisted)
    }
}

pub fn classify_path_block_reason(
    path: &Path,
    workspace_root: &Path,
    workspace_only: bool,
    allowed_paths: &[PathBuf],
) -> Option<PolicyBlockReason> {
    let in_workspace = path_within(path, workspace_root);
    let in_allowlist = allowed_paths
        .iter()
        .any(|allowed| path_within(path, allowed));

    if workspace_only && !(in_workspace || in_allowlist) {
        return Some(PolicyBlockReason::PathOutsideWorkspace);
    }
    if !allowed_paths.is_empty() && !(in_workspace || in_allowlist) {
        return Some(PolicyBlockReason::PathOutsideAllowlist);
    }
    None
}

pub fn absolutize_path(raw_path: &str, cwd: &Path) -> PathBuf {
    let p = expand_home_path(raw_path);
    if p.is_absolute() {
        p
    } else {
        cwd.join(p)
    }
}

pub fn path_within(path: &Path, root: &Path) -> bool {
    let root = normalize_path(root);
    path.starts_with(&root)
}

pub fn normalize_path(path: &Path) -> PathBuf {
    if let Ok(canon) = std::fs::canonicalize(path) {
        return canon;
    }
    let mut out = PathBuf::new();
    for comp in path.components() {
        match comp {
            Component::CurDir => {}
            Component::ParentDir => {
                let _ = out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

pub fn normalize_with_ancestor_fallback(path: &Path) -> PathBuf {
    if let Ok(canon) = std::fs::canonicalize(path) {
        return canon;
    }
    if let Some(parent) = path.parent() {
        if let Ok(parent_canon) = std::fs::canonicalize(parent) {
            if let Some(name) = path.file_name() {
                return parent_canon.join(name);
            }
            return parent_canon;
        }
    }
    normalize_path(path)
}

pub fn expand_home_path(path: &str) -> PathBuf {
    if path == "~" {
        return dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    }
    if let Some(rest) = path.strip_prefix("~/") {
        return dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(rest);
    }
    PathBuf::from(path)
}
