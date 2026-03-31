use std::path::{Component, Path, PathBuf};

/// Workspace policy derived from Forge runtime env vars.
#[derive(Debug, Clone, Default)]
pub struct WorkspacePolicy {
    pub workspace_only: bool,
    pub workspace_root: PathBuf,
    pub allowed_paths: Vec<PathBuf>,
    pub allowed_commands: Vec<String>,
}

impl WorkspacePolicy {
    pub fn from_env() -> Self {
        let workspace_only = std::env::var("FORGE_WORKSPACE_ONLY")
            .ok()
            .map(|v| matches!(v.as_str(), "1" | "true" | "TRUE" | "yes" | "YES"))
            .unwrap_or(true);

        let workspace_root = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));

        let allowed_paths = std::env::var("FORGE_ALLOWED_PATHS")
            .ok()
            .map(|raw| {
                raw.split(':')
                    .filter(|s| !s.trim().is_empty())
                    .map(expand_home)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();

        let allowed_commands = std::env::var("FORGE_ALLOWED_COMMANDS")
            .ok()
            .map(|raw| {
                raw.split(',')
                    .filter_map(|s| {
                        let t = s.trim().to_lowercase();
                        if t.is_empty() { None } else { Some(t) }
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();

        Self {
            workspace_only,
            workspace_root,
            allowed_paths,
            allowed_commands,
        }
    }

    pub fn is_command_allowed(&self, command: &str) -> Result<(), String> {
        if self.allowed_commands.is_empty() {
            return Ok(());
        }

        // Disallow shell control operators in allowlist mode to prevent bypass.
        if command.chars().any(|c| matches!(c, ';' | '|' | '&' | '\n' | '\r' | '<' | '>' | '$' | '`')) {
            return Err("Command rejected by policy: shell operators are not allowed in restricted mode".to_string());
        }

        let first = command
            .split_whitespace()
            .next()
            .map(|s| s.to_lowercase())
            .ok_or_else(|| "Command rejected by policy: empty command".to_string())?;

        if self.allowed_commands.contains(&first) {
            Ok(())
        } else {
            Err(format!(
                "Command '{}' rejected by policy. Allowed commands: {}",
                first,
                self.allowed_commands.join(", ")
            ))
        }
    }

    pub fn ensure_path_allowed(&self, raw_path: &str) -> Result<PathBuf, String> {
        let abs = absolutize(raw_path, &self.workspace_root)?;
        let normalized = normalize_path(&abs);

        let in_workspace = path_within(&normalized, &self.workspace_root);
        let in_allowlist = self
            .allowed_paths
            .iter()
            .map(|p| normalize_path(p.as_path()))
            .any(|allowed| path_within(&normalized, &allowed));

        if self.workspace_only && !(in_workspace || in_allowlist) {
            return Err(format!(
                "Path '{}' rejected by workspace policy (workspace_root='{}')",
                normalized.display(),
                self.workspace_root.display()
            ));
        }

        if !self.allowed_paths.is_empty() && !(in_workspace || in_allowlist) {
            return Err(format!(
                "Path '{}' rejected by allowlist policy",
                normalized.display()
            ));
        }

        Ok(normalized)
    }
}

fn absolutize(raw_path: &str, cwd: &Path) -> Result<PathBuf, String> {
    let p = expand_home(raw_path);
    if p.is_absolute() {
        return Ok(p);
    }
    Ok(cwd.join(p))
}

fn path_within(path: &Path, root: &Path) -> bool {
    let root = normalize_path(root);
    path.starts_with(&root)
}

fn normalize_path(path: &Path) -> PathBuf {
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

fn expand_home(path: &str) -> PathBuf {
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

#[cfg(test)]
mod tests {
    use super::WorkspacePolicy;
    use std::path::PathBuf;

    #[test]
    fn command_allowlist_blocks_unknown_commands() {
        let policy = WorkspacePolicy {
            allowed_commands: vec!["git".into(), "ls".into()],
            ..Default::default()
        };
        assert!(policy.is_command_allowed("git status").is_ok());
        assert!(policy.is_command_allowed("rm -rf /").is_err());
    }

    #[test]
    fn workspace_policy_blocks_outside_paths() {
        let policy = WorkspacePolicy {
            workspace_only: true,
            workspace_root: PathBuf::from("/tmp/work"),
            allowed_paths: vec![],
            allowed_commands: vec![],
        };
        assert!(policy.ensure_path_allowed("/tmp/work/a.txt").is_ok());
        assert!(policy.ensure_path_allowed("/etc/passwd").is_err());
    }
}
